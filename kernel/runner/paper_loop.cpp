#include "paper_loop.hpp"

#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

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

void WriteInt(const std::string& path, int64_t v) {
    std::string tmp = path + ".tmp";
    FILE* f = std::fopen(tmp.c_str(), "wb");
    if (!f) return;
    std::fprintf(f, "%lld", (long long)v);
    std::fflush(f);
    std::fclose(f);
    std::rename(tmp.c_str(), path.c_str());
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

void LogDecision(const std::string& dir, int64_t now_ns,
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
    AppendLine((dir + "/decisions.jsonl").c_str(), ln);
}

}  // namespace

bool PaperLoop::Tick(int64_t now_ns) {
    stats_ = LoopStats();
    std::string clock, acct, pos;
    AccountView av;
    std::vector<PositionView> held;
    bool have = Http(io_, "GET", "/v2/clock", &clock) &&
                Http(io_, "GET", "/v2/account", &acct) &&
                Http(io_, "GET", "/v2/positions", &pos) &&
                ParseAccount(acct, &av) && ParsePositions(pos, &held);
    stats_.account_ok = have && !av.blocked;
    int64_t now_s = now_ns / 1000000000LL;

    // Without account information nothing is consumed: the lines wait, and
    // the freshness window retires them if the outage outlasts it.
    std::string opath = cfg_.dir + "/candidates.offset";
    int64_t base = stats_.account_ok ? ReadInt(opath) : 0;
    std::string chunk =
        stats_.account_ok ? ReadFrom(cfg_.dir + "/candidates.jsonl", base) : "";
    size_t at = 0;
    for (;;) {
        size_t nl = chunk.find('\n', at);
        if (nl == std::string::npos) break;
        std::string line = chunk.substr(at, nl - at);
        at = nl + 1;
        ++stats_.seen;
        exec::EntryDecision d;
        const char* submit = "none";
        JVal rec;
        std::string err;
        if (line.size() > kMaxLine) {
            ++stats_.skipped_long;
            d.reason = "line-too-long";
        } else if (!ParseJson(line, rec, err)) {
            d.reason = "cand-shape";
        } else {
            exec::DecideInput in;
            in.record = &rec;
            in.tables = cfg_.tables;
            in.now_ns = now_ns;
            in.risk_bp = cfg_.risk_bp;
            for (const auto& p : held)
                if (p.is_long && p.qty > 0) in.held_qty[p.symbol] = p.qty;
            risk::RiskSnapshot& s = in.state;
            s.equity_cents = av.equity_cents;
            int64_t hwm = ReadInt(cfg_.dir + "/hwm.txt");
            if (av.equity_cents > hwm) {
                hwm = av.equity_cents;
                WriteInt(cfg_.dir + "/hwm.txt", hwm);
            }
            s.daily_close_hwm_cents = s.intraday_hwm_cents = hwm;
            s.settled_cash_cents = av.settled_cash_cents;
            for (const auto& p : held) {
                risk::Position rp;
                rp.symbol = p.symbol;
                rp.side = p.is_long ? risk::Side::LONG : risk::Side::SHORT;
                rp.notional_cents = p.market_value_cents < 0
                                        ? -p.market_value_cents
                                        : p.market_value_cents;
                s.open.push_back(rp);
            }
            s.session_open = SessionOpen(clock);
            s.day_number = now_ns / 1000 / (86400LL * 1000000LL);
            s.hour_bucket = now_ns / 1000 / (3600LL * 1000000LL);
            s.stage = risk::Stage::G0_PAPER;
            ingest::CandOutcome pre =
                ingest::ValidateCandidate(rec, cfg_.tables, now_ns);
            if (pre.accepted)
                MeasureRisk(io_, cfg_, pre.symbol, held, now_s, &s);
            d = exec::Decide(in);
            if (d.proceed) {
                const char* why = nullptr;
                if (runner_.SubmitIntent(d.intent, &why)) {
                    submit = "submitted";
                } else {
                    submit = why ? why : "refused";
                    d.proceed = false;
                    d.reason = "runner-refused";
                }
            }
        }
        d.proceed ? ++stats_.proceeded : ++stats_.held;
        LogDecision(cfg_.dir, now_ns, d, submit);
        WriteInt(opath, base + (int64_t)at);
    }
    return runner_.Cycle(now_ns);
}

}  // namespace runner
}  // namespace jev
