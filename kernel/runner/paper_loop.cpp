#include "paper_loop.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <unistd.h>

#include "../exec/decide.hpp"
#include "../jev_validate.hpp"
#include "../risk/measure.hpp"
#include "account.hpp"
#include "bars.hpp"
#include "calendar.hpp"
#include "settle.hpp"

namespace jev {
namespace runner {
namespace {

const size_t kMaxLine = 4096;
const size_t kMaxRead = 1 << 20;
const int kMaxPages = 40;

std::string ReadFrom(const std::string& path, int64_t off) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return "";
    std::fseek(f, (long)off, SEEK_SET);
    std::string out(kMaxRead, '\0');
    size_t n = std::fread(&out[0], 1, kMaxRead, f);
    std::fclose(f);
    out.resize(n);
    return out;
}

int64_t ReadInt(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return 0;
    char b[32] = {0};
    size_t n = std::fread(b, 1, sizeof(b) - 1, f);
    std::fclose(f);
    if (n == 0) return 0;
    char* end = nullptr;
    long long v = std::strtoll(b, &end, 10);
    return v > 0 ? v : 0;
}

int64_t FileSize(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return 0;
    std::fseek(f, 0, SEEK_END);
    long n = std::ftell(f);
    std::fclose(f);
    return n < 0 ? 0 : n;
}

bool WriteInt(const std::string& path, int64_t v) {
    std::string tmp = path + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return false;
    std::fprintf(f, "%lld", (long long)v);
    std::fflush(f);
    ::fsync(fileno(f));
    if (std::fclose(f) != 0) return false;
    return std::rename(tmp.c_str(), path.c_str()) == 0;
}

// The calendar must list at least one holiday in the year being traded;
// otherwise holidays would read as sessions and settlement as early.
bool CalendarCovers(const std::set<int64_t>& hol, int64_t day) {
    int y = 1970 + (int)(day / 365);
    while (DaysFromCivil(y, 1, 1) > day) --y;
    while (DaysFromCivil(y + 1, 1, 1) <= day) ++y;
    int64_t lo = DaysFromCivil(y, 1, 1), hi = DaysFromCivil(y + 1, 1, 1);
    auto it = hol.lower_bound(lo);
    return it != hol.end() && *it < hi;
}

bool Http(const LoopIO& io, const char* method, const std::string& path,
          std::string* body) {
    int status = 0;
    if (!io.rest || !io.rest(method, path, &status, body)) return false;
    return status >= 200 && status < 300;
}

bool SessionOpen(const std::string& body) {
    JVal v;
    std::string err;
    if (!ParseJson(body, v, err) || v.t != JVal::T::OBJ) return false;
    std::u32string k = U8("is_open");
    const JVal* o = v.find(k);
    return o && o->t == JVal::T::BOOL && o->b;
}

// R6/R7 for the entry symbol against the held longs; fail closed on any gap.
void MeasureRisk(const LoopIO& io, const LoopConfig& cfg,
                 const std::string& sym,
                 const std::vector<PositionView>& held, int64_t now_s,
                 risk::RiskSnapshot* s) {
    s->r6_available = s->r7_available = false;
    if (!io.data) return;
    std::string syms = sym;
    for (const auto& p : held)
        if (p.symbol != sym) syms += "," + p.symbol;
    std::string base = "/v2/stocks/bars?symbols=" + syms +
                       "&timeframe=1Hour&adjustment=raw&limit=10000&feed=" +
                       cfg.feed + "&start=" + FormatIsoZ(now_s - 120 * 86400);
    BarMap m;
    std::string token;
    for (int page = 0;; ++page) {
        std::string body;
        std::string path = token.empty() ? base : base + "&page_token=" + UrlEncode(token);
        BarMap one;
        bool more = false;
        std::string next;
        if (page >= kMaxPages || !io.data(path, &body) ||
            !ParseBars(body, &one, &more, &next))
            return;  // unavailable: fail closed
        for (auto& kv : one) {
            std::vector<Bar>& dst = m[kv.first];
            dst.insert(dst.end(), kv.second.begin(), kv.second.end());
        }
        if (!more) break;
        token = next;
    }
    if (!m.count(sym)) return;
    for (auto& kv : m) KeepRegularSession(&kv.second, cfg.holidays);
    const std::vector<Bar>& eb = m[sym];
    if (eb.empty()) return;
    int stale = ExpectedBarsBetween(eb.back().start_s, now_s, cfg.holidays);
    std::vector<double> closes;
    for (const Bar& b : eb) closes.push_back(b.close);
    risk::VolResult v = risk::MeasureVol(closes.data(), (int)closes.size(),
                                         stale);
    s->r6_available = v.available;
    s->r6_trip = v.trip;

    auto starts = ExpectedStarts(now_s, risk::kCorrWindow, cfg.holidays);
    if ((int)starts.size() != risk::kCorrWindow) return;
    double a[risk::kCorrWindow], b[risk::kCorrWindow];
    AlignCloses(eb, starts, a);
    bool ok = true;
    s->r7_entry_breach = false;
    for (const auto& p : held) {
        if (!p.is_long || p.symbol == sym) continue;
        auto it = m.find(p.symbol);
        if (it == m.end() || it->second.empty()) { ok = false; break; }
        AlignCloses(it->second, starts, b);
        int st2 = ExpectedBarsBetween(it->second.back().start_s, now_s,
                                      cfg.holidays);
        risk::CorrResult c = risk::MeasureCorr(a, b, risk::kCorrWindow,
                                               st2 > stale ? st2 : stale);
        if (!c.available) { ok = false; break; }
        if (c.breach) s->r7_entry_breach = true;
    }
    s->r7_available = ok;
}

// Orders submitted in the current UTC day and hour, from submitted.log
// (one ts_ns per line; the last 1 MiB covers far more than a day of orders).
void CountSubmitted(const std::string& dir, int64_t now_ns, int64_t* day,
                    int64_t* hour) {
    *day = *hour = 0;
    std::string path = dir + "/submitted.log";
    int64_t size = FileSize(path);
    int64_t from = size > (int64_t)kMaxRead ? size - (int64_t)kMaxRead : 0;
    std::string log = ReadFrom(path, from);
    const int64_t d_ns = 86400LL * 1000000000LL, h_ns = 3600LL * 1000000000LL;
    size_t at = 0;
    if (from > 0) {
        size_t nl = log.find('\n');
        at = nl == std::string::npos ? log.size() : nl + 1;
    }
    while (at < log.size()) {
        size_t nl = log.find('\n', at);
        if (nl == std::string::npos) break;
        long long ts = std::strtoll(log.c_str() + at, nullptr, 10);
        at = nl + 1;
        if (ts / d_ns == now_ns / d_ns) ++*day;
        if (ts / h_ns == now_ns / h_ns) ++*hour;
    }
}

void AppendSubmitted(const std::string& dir, int64_t now_ns) {
    char ln[32];
    std::snprintf(ln, sizeof(ln), "%lld", (long long)now_ns);
    AppendLine((dir + "/submitted.log").c_str(), ln);
}

bool FileExists(const std::string& path) {
    FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return false;
    std::fclose(f);
    return true;
}

bool LogDecision(const std::string& dir, int64_t now_ns,
                 const exec::EntryDecision& d, const char* submit) {
    char ln[512];
    std::snprintf(ln, sizeof(ln),
                  "{\"ts_ns\":%lld,\"cid\":\"%.64s\",\"symbol\":\"%.15s\","
                  "\"proceed\":%s,\"reason\":\"%.63s\",\"qty\":%lld,"
                  "\"limiter\":\"%.31s\",\"submit\":\"%.31s\"}",
                  (long long)now_ns, d.cid.c_str(), d.symbol.c_str(),
                  d.proceed ? "true" : "false", d.reason.c_str(),
                  (long long)(d.proceed ? d.intent.qty_shares : 0),
                  d.limiter.c_str(), submit);
    return AppendLine((dir + "/decisions.jsonl").c_str(), ln);
}

}  // namespace

// Sale proceeds stay unsettled until the next session. The estimate is the
// larger of the candidate reference and the live mark, plus 1%, so it errs
// toward holding cash back. The line lands before the order is sent and is
// keyed by cid: a crash between the two cannot lose it, a replay cannot
// double it.
void PaperLoop::RecordProceeds(const exec::EntryDecision& d,
                               int64_t entry_cents,
                               const std::vector<PositionView>& held,
                               int64_t now_s) {
    if (booked_.count(d.cid)) return;
    int64_t mark = 0;
    for (const auto& p : held)
        if (p.symbol == d.symbol) mark = p.market_value_cents;
    int64_t ref = entry_cents * d.intent.qty_shares;
    int64_t proceeds = (ref > mark ? ref : mark) * 101 / 100;
    int64_t today = (now_s + EtOffsetSeconds(now_s)) / 86400;
    book_.Record(today, proceeds, cfg_.holidays);
    char rec[128];
    std::snprintf(rec, sizeof(rec), "%lld %lld %.64s",
                  (long long)NextSessionDay(today, cfg_.holidays),
                  (long long)proceeds, d.cid.c_str());
    if (AppendLine((cfg_.dir + "/settle.log").c_str(), rec))
        booked_.insert(d.cid);
}

void PaperLoop::RecordInflight(const std::string& sym, int64_t entry_cents) {
    inflight_[sym] = entry_cents;
    char rec[64];
    std::snprintf(rec, sizeof(rec), "%.15s %lld", sym.c_str(),
                  (long long)entry_cents);
    AppendLine((cfg_.dir + "/inflight.log").c_str(), rec);
}

PaperLoop::PaperLoop(G0Runner& runner, LoopIO io, LoopConfig cfg)
    : runner_(runner), io_(io), cfg_(cfg) {
    // settle.log: "<settle_day> <proceeds_cents>" per line, append-only.
    std::string log = ReadFrom(cfg_.dir + "/settle.log", 0);
    size_t at = 0;
    while (at < log.size()) {
        size_t nl = log.find('\n', at);
        if (nl == std::string::npos) break;
        long long day = 0, cents = 0;
        char cid[80] = {0};
        int n = std::sscanf(log.c_str() + at, "%lld %lld %79s", &day, &cents,
                            cid);
        if (n >= 2) book_.Add(day, cents);
        if (n == 3) booked_.insert(cid);
        at = nl + 1;
    }
    // inflight.log: "<symbol> <entry_cents>", the reference price of the
    // latest entry order per symbol.
    std::string fl = ReadFrom(cfg_.dir + "/inflight.log", 0);
    at = 0;
    while (at < fl.size()) {
        size_t nl = fl.find('\n', at);
        if (nl == std::string::npos) break;
        char sym[32] = {0};
        long long cents = 0;
        if (std::sscanf(fl.c_str() + at, "%31s %lld", sym, &cents) == 2 &&
            cents > 0)
            inflight_[sym] = cents;
        at = nl + 1;
    }
}

bool PaperLoop::Tick(int64_t now_ns) {
    stats_ = LoopStats();
    std::string clock, acct, pos;
    AccountView av;
    std::vector<PositionView> held;
    std::vector<OrderView> orders;
    std::string ord;
    bool have = Http(io_, "GET", "/v2/clock", &clock) &&
                Http(io_, "GET", "/v2/account", &acct) &&
                Http(io_, "GET", "/v2/positions", &pos) &&
                Http(io_, "GET", "/v2/orders?status=open&nested=true&limit=500",
                     &ord) &&
                ParseAccount(acct, &av) && ParsePositions(pos, &held) &&
                ParseOpenOrders(ord, &orders);
    int64_t now_s = now_ns / 1000000000LL;
    stats_.account_ok = have && !av.blocked &&
                        CalendarCovers(cfg_.holidays,
                                       (now_s + EtOffsetSeconds(now_s)) / 86400);
    if (stats_.account_ok) {
        std::string hp = cfg_.dir + "/hwm.txt";
        if (av.equity_cents > ReadInt(hp)) WriteInt(hp, av.equity_cents);
    }

    // Without account information nothing is consumed: the lines wait, and
    // the freshness window retires them if the outage outlasts it.
    std::string opath = cfg_.dir + "/candidates.offset";
    int64_t base = stats_.account_ok ? ReadInt(opath) : 0;
    std::string cpath = cfg_.dir + "/candidates.jsonl";
    if (base > FileSize(cpath)) base = 0;  // rotated or truncated: replay, the runner dedups on cid
    std::string chunk = stats_.account_ok ? ReadFrom(cpath, base) : "";
    if (chunk.size() >= kMaxRead && chunk.find('\n') == std::string::npos) {
        // One unterminated oversize line: skip it so the loop cannot stall.
        ++stats_.seen;
        ++stats_.skipped_long;
        exec::EntryDecision d;
        d.reason = "line-too-long";
        ++stats_.held;
        if (LogDecision(cfg_.dir, now_ns, d, "none"))
            WriteInt(opath, base + (int64_t)chunk.size());
        chunk.clear();
    }
    size_t at = 0;
    // Orders already sent this tick are invisible to the account snapshot.
    std::vector<risk::Position> sent;
    int64_t spent_cents = 0;
    // Working orders from earlier ticks. A buy is exposure that has not yet
    // reached the position list; an unexplained order halts entries; a
    // working sell means an exit is already on its way.
    bool unexplained = false;
    std::set<std::string> exiting;
    for (const auto& o : orders) {
        if (!o.is_buy) {
            exiting.insert(o.symbol);
            continue;
        }
        auto it = inflight_.find(o.symbol);
        if (it == inflight_.end()) {
            unexplained = true;
            continue;
        }
        risk::Position rp;
        rp.symbol = o.symbol;
        rp.side = risk::Side::LONG;
        rp.notional_cents = it->second * o.remaining_qty;
        sent.push_back(rp);
        spent_cents += rp.notional_cents;
    }
    for (;;) {
        size_t nl = chunk.find('\n', at);
        if (nl == std::string::npos) break;
        std::string line = chunk.substr(at, nl - at);
        at = nl + 1;
        ++stats_.seen;
        exec::EntryDecision d;
        const char* submit = "none";
        JVal cand;
        std::string err;
        if (line.size() > kMaxLine) {
            ++stats_.skipped_long;
            d.reason = "line-too-long";
        } else if (!ParseJson(line, cand, err)) {
            d.reason = "cand-shape";
        } else {
            exec::DecideInput in;
            in.record = &cand;
            in.tables = cfg_.tables;
            in.tables.held.clear();
            for (const auto& p : held)
                if (p.is_long && (p.qty > 0 || p.fractional))
                    in.tables.held.push_back(p.symbol);
            for (const auto& p : sent) in.tables.held.push_back(p.symbol);
            in.now_ns = now_ns;
            in.risk_bp = cfg_.risk_bp;
            for (const auto& p : held)
                if (p.is_long && p.qty > 0) in.held_qty[p.symbol] = p.qty;
            risk::RiskSnapshot& s = in.state;
            s.equity_cents = av.equity_cents;
            int64_t hwm = ReadInt(cfg_.dir + "/hwm.txt");
            if (av.equity_cents > hwm) hwm = av.equity_cents;
            s.daily_close_hwm_cents = s.intraday_hwm_cents = hwm;
            int64_t session_day = (now_s + EtOffsetSeconds(now_s)) / 86400;
            s.settled_cash_cents =
                book_.SettledCents(av.settled_cash_cents, session_day) - spent_cents;
            CountSubmitted(cfg_.dir, now_ns, &s.day_count, &s.hour_count);
            s.entry_halt = unexplained || FileExists(cfg_.dir + "/HALT");
            for (const auto& p : held) {
                risk::Position rp;
                rp.symbol = p.symbol;
                rp.side = p.is_long ? risk::Side::LONG : risk::Side::SHORT;
                rp.notional_cents = p.market_value_cents < 0
                                        ? -p.market_value_cents
                                        : p.market_value_cents;
                s.open.push_back(rp);
            }
            for (const auto& rp : sent) s.open.push_back(rp);
            s.session_open = SessionOpen(clock);
            s.day_number = now_ns / 1000 / (86400LL * 1000000LL);
            s.hour_bucket = now_ns / 1000 / (3600LL * 1000000LL);
            s.stage = risk::Stage::G0_PAPER;
            ingest::CandOutcome pre =
                ingest::ValidateCandidate(cand, in.tables, now_ns);
            if (pre.accepted)
                MeasureRisk(io_, cfg_, pre.symbol, held, now_s, &s);
            d = exec::Decide(in);
            if (d.proceed && d.intent.kind == risk::IntentKind::EXIT &&
                exiting.count(d.symbol)) {
                d.proceed = false;
                d.reason = "exit-in-flight";
            }
            if (d.proceed) {
                const char* why = nullptr;
                if (d.intent.kind == risk::IntentKind::EXIT)
                    RecordProceeds(d, pre.entry_cents, held, now_s);
                if (runner_.SubmitIntent(d.intent, &why)) {
                    submit = "submitted";
                    AppendSubmitted(cfg_.dir, now_ns);
                    if (d.intent.kind == risk::IntentKind::ENTRY) {
                        risk::Position rp;
                        rp.symbol = d.symbol;
                        rp.side = risk::Side::LONG;
                        rp.notional_cents = pre.entry_cents * d.intent.qty_shares;
                        sent.push_back(rp);
                        spent_cents += rp.notional_cents;
                        RecordInflight(d.symbol, pre.entry_cents);
                    }
                } else {
                    submit = why ? why : "refused";
                    d.proceed = false;
                    d.reason = "runner-refused";
                }
            }
        }
        d.proceed ? ++stats_.proceeded : ++stats_.held;
        // A lost audit line or offset is replayed next tick, never skipped.
        if (!LogDecision(cfg_.dir, now_ns, d, submit)) break;
        if (!WriteInt(opath, base + (int64_t)at)) break;
    }
    return runner_.Cycle(now_ns);
}

}  // namespace runner
}  // namespace jev
