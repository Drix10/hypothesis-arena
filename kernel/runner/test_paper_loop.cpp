// PaperLoop against a real G0Runner in a temp directory with injected
// REST/data. STAGE here is a test artifact; the real one is human-created.
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include <sys/stat.h>

#include "../jev_wire.hpp"
#include "bars.hpp"
#include "calendar.hpp"
#include "paper_loop.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

using namespace jev;
using namespace jev::runner;

static std::string g_fix;                 // fixtures dir
static std::string g_account, g_bracket;  // fixture bodies
static bool g_account_up = true;
static bool g_data_up = true;
static std::string g_positions = "[]";
static std::string g_orders = "[]";
static int g_orders_posted = 0;
static int64_t NOW_S = 0;

static std::string Slurp(const std::string& p) {
    std::ifstream f(p);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}
static void Write(const std::string& p, const std::string& b) {
    FILE* f = std::fopen(p.c_str(), "wb");
    std::fwrite(b.data(), 1, b.size(), f);
    std::fclose(f);
}

static long long Now(void*) { return NOW_S * 1000000000LL; }
static int NoStream(void*, char*, int) { return 0; }
static void NoKill(void*, kill::KillInputs* o) { *o = kill::KillInputs(); }
static broker::HttpResult Venue(const broker::HttpRequest& r) {
    broker::HttpResult out;
    out.status = 200;
    if (std::strcmp(r.method, "POST") == 0) ++g_orders_posted;
    std::snprintf(out.body, sizeof(out.body), "%s", g_bracket.c_str());
    return out;
}

// Hourly bars for `sym` ending at the last completed regular bar before now.
static std::string BarsJson(const std::string& sym, int n, double vol) {
    std::set<int64_t> none;
    auto starts = ExpectedStarts(NOW_S, n, none);
    std::string out = "{\"bars\":{\"" + sym + "\":[";
    double p = 100.0;
    for (size_t i = 0; i < starts.size(); ++i) {
        p *= std::exp(vol * std::sin(i * 12.9898));
        char b[96];
        std::snprintf(b, sizeof(b), "%s{\"t\":\"%s\",\"c\":%.4f}", i ? "," : "",
                      FormatIsoZ(starts[i]).c_str(), p);
        out += b;
    }
    return out + "]},\"next_page_token\":null}";
}

static const char* K[12] = {"strategy_version", "symbol", "snapshot_ts_ns",
    "proposed_side", "proposed_family", "entry_px", "stop_px", "tp_px",
    "time_exit_ns", "exit_profile_version", "cost_model_version",
    "feature_revision"};
static std::string Cand(const std::string& sleeve, int64_t age_s = 60,
                        const std::string& side = "BUY") {
    bool sell = side == "SELL";
    std::string f[12] = {sleeve, "VTI",
                         std::to_string(NOW_S * 1000000000LL - age_s * 1000000000LL),
                         side, "trend", "250.50", sell ? "999.00" : "230.00",
                         sell ? "100.00" : "999.00", "0",
                         "exit_trend_v1", "cost_v2", "f1"};
    std::string joined, c;
    for (int i = 0; i < 12; ++i) {
        if (i) joined += "|";
        joined += f[i];
        c += std::string("\"") + K[i] + "\":\"" + f[i] + "\",";
    }
    return "{\"schema\":\"c1\",\"created_ns\":\"5\",\"candidate\":{" + c +
           "\"cid\":\"" + Sha256Hex(joined) + "\"}}\n";
}

static void Append(const std::string& p, const std::string& s) {
    FILE* f = std::fopen(p.c_str(), "ab");
    std::fwrite(s.data(), 1, s.size(), f);
    std::fclose(f);
}

struct Env {
    std::string dir = "plp_tmp";
    Env() {
        (void)!std::system(("rm -rf " + dir).c_str());
        mkdir(dir.c_str(), 0755);
        std::string body = "G0_PAPER|human|2026-09-25T00:00:00Z|0|GENESIS";
        Write(dir + "/STAGE",
              "stage: G0_PAPER\napproved_by: human\napproved_at: "
              "2026-09-25T00:00:00Z\ncapital_usd: 0\nattest_hash: " +
                  Sha256Hex(body) + "\n");
    }
    ~Env() { (void)!std::system(("rm -rf " + dir).c_str()); }
};

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    g_fix = argv[1];
    g_account = Slurp(g_fix + "/alpaca_account.json");
    g_bracket = Slurp(g_fix + "/alpaca_bracket_reply.json");
    // Monday 2026-09-28 20:30Z = 16:30 ET, after the close.
    NOW_S = DaysFromCivil(2026, 9, 28) * 86400 + 20 * 3600 + 30 * 60;

    Env env;
    RunnerConfig cfg;
    cfg.dir = env.dir;
    std::strncpy(cfg.venue.broker, "alpaca-paper", 31);
    std::strncpy(cfg.venue.account, "test", 31);
    std::string ch(64, 'a');
    std::strncpy(cfg.venue.context_hash, ch.c_str(), 64);
    cfg.venue.context_hash[64] = 0;
    RunnerDeps deps;
    deps.transport = Venue;
    deps.stream_read = NoStream;
    deps.now_ns = Now;
    deps.kill_inputs = NoKill;
    deps.restart_flag = true;
    G0Runner runner(cfg, deps);
    const char* why = nullptr;
    CHECK("runner-recovers", runner.Recover(&why));

    LoopIO io;
    io.rest = [](const char*, const std::string& path, int* st,
                 std::string* body) {
        *st = 200;
        if (path == "/v2/clock") *body = "{\"is_open\":true}";
        else if (path == "/v2/account") {
            if (!g_account_up) return false;
            *body = g_account;
        } else if (path == "/v2/positions") *body = g_positions;
        else if (path.rfind("/v2/orders?status=open", 0) == 0) *body = g_orders;
        else return false;
        return true;
    };
    io.data = [](const std::string& path, std::string* body) {
        if (!g_data_up) return false;
        // Two pages: the first carries a token whose base64 characters must
        // come back percent-encoded.
        bool second = path.find("page_token=") != std::string::npos;
        if (second && path.find("page_token=AB%2BC%2F%3D%3D") ==
                          std::string::npos)
            return false;
        std::string all = BarsJson("VTI", 560, 0.002);
        size_t cut = all.find("\"t\":", all.size() / 2);
        cut = all.rfind("{", cut);
        std::string head = all.substr(0, cut - 1);   // drop the comma
        std::string tail = all.substr(cut);
        if (!second) {
            *body = head + "]},\"next_page_token\":\"AB+C/==\"}";
        } else {
            *body = "{\"bars\":{\"VTI\":[" + tail;
        }
        return true;
    };
    LoopConfig lc;
    lc.dir = env.dir;
    lc.tables.sleeves.push_back({"trend_etf_v1", 3600});
    lc.tables.allowlist = {"VTI", "IEF"};
    lc.holidays = {DaysFromCivil(2026, 12, 25)};
    PaperLoop loop(runner, io, lc);

    // 1. account outage: nothing is consumed.
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1"));
    g_account_up = false;
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("outage-consumes-nothing", loop.stats().seen == 0 &&
                                         !loop.stats().account_ok);
    g_account_up = true;

    // 2. clean candidate: sized, vetoed clean, submitted.
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("proceeds-and-submits", loop.stats().seen == 1 &&
                                      loop.stats().proceeded == 1);
    CHECK("one-slot", runner.slots() == 1);
    std::string dec = Slurp(env.dir + "/decisions.jsonl");
    if (loop.stats().proceeded != 1) std::printf("DECISIONS: %s\n", dec.c_str());
    CHECK("decision-logged", dec.find("\"proceed\":true") != std::string::npos &&
                                 dec.find("\"submit\":\"submitted\"") !=
                                     std::string::npos &&
                                 dec.find("\"qty\":12") != std::string::npos);

    // 3. offsets: the same line is never processed twice.
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("no-reprocessing", loop.stats().seen == 0);

    // 4. holds are logged, not silent.
    Append(env.dir + "/candidates.jsonl", Cand("rogue_v9"));
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 7200));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("unapproved-held", loop.stats().held == 2 &&
                                 dec.find("cand-sleeve-unapproved") !=
                                     std::string::npos &&
                                 dec.find("cand-stale-or-future") !=
                                     std::string::npos);

    // 5. no market data: R6/R7 unavailable, entry held.
    g_data_up = false;
    Append(env.dir + "/candidates.jsonl",
           Cand("trend_etf_v1", 30));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("no-data-holds", loop.stats().held == 1 &&
                               dec.find("r6-unavailable") != std::string::npos);
    g_data_up = true;

    // 6. garbage lines are rejected as shape errors and skipped.
    Append(env.dir + "/candidates.jsonl", "not json\n");
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("garbage-held", loop.stats().held == 1);
    // 7. HALT file: entries hold with the frozen reason.
    Write(env.dir + "/HALT", "halt");
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 20));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("halt-holds-entries", dec.find("entry-halt") != std::string::npos);
    std::remove((env.dir + "/HALT").c_str());

    // 8. exit: closes the held position and books unsettled proceeds.
    g_positions = "[{\"symbol\":\"VTI\",\"qty\":\"40\",\"side\":\"long\","
                  "\"market_value\":\"10020.00\"}]";
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 10, "SELL"));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    if (loop.stats().proceeded != 1) std::printf("EXIT: %s\n", dec.substr(dec.size() > 400 ? dec.size() - 400 : 0).c_str());
    CHECK("exit-submitted", loop.stats().proceeded == 1);
    std::string sl = Slurp(env.dir + "/settle.log");
    CHECK("exit-books-proceeds", sl.find("1012020") != std::string::npos);
    CHECK("proceeds-settle-next-session", sl.find("20725 ") == 0);

    // 9. a restart reloads the book from settle.log.
    PaperLoop again(runner, io, lc);
    CHECK("book-reloads", again.stats().seen == 0);

    // 9b. working orders from earlier ticks are respected.
    g_orders = "[{\"symbol\":\"ZZZ\",\"side\":\"buy\",\"qty\":\"5\","
               "\"filled_qty\":\"0\"}]";
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 30));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("unexplained-order-halts-entries",
          dec.rfind("entry-halt") > dec.rfind("exit-in-flight") ||
              dec.find("entry-halt") != std::string::npos);
    g_orders = "[{\"symbol\":\"VTI\",\"side\":\"sell\",\"qty\":\"40\","
               "\"filled_qty\":\"0\"}]";
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 40, "SELL"));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("exit-in-flight-held", dec.find("exit-in-flight") != std::string::npos);
    g_orders = "[]";
    CHECK("unprotected-long-alerts",
          Slurp(env.dir + "/alerts.jsonl").find("unprotected-position") !=
              std::string::npos);

    // 10. an unterminated oversize line does not stall the queue.
    Append(env.dir + "/candidates.jsonl", std::string(1100000, 'x'));
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("oversize-skipped", loop.stats().skipped_long == 1);
    Append(env.dir + "/candidates.jsonl", "\n" + Cand("rogue_v9"));
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("queue-resumes", loop.stats().seen == 2);

    // 11. a rotated (shorter) candidates file is replayed, not lost.
    std::remove((env.dir + "/candidates.jsonl").c_str());
    Append(env.dir + "/candidates.jsonl", Cand("rogue_v9"));
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("rotation-replays", loop.stats().seen == 1);

    // 11b. account-level daily loss (> 3% of last_equity): entries hold for
    // the day with a named reason; exits proceed; missing data never clears.
    const std::string acct_ok = g_account;
    auto Acct = [&](const char* eq, const char* last) {
        std::string a = acct_ok;
        size_t i = a.find("\"equity\":\"100000\"");
        a.replace(i, 17, std::string("\"equity\":\"") + eq + "\"");
        i = a.find("\"last_equity\":\"100000\"");
        a.replace(i, 22, std::string("\"last_equity\":\"") + last + "\"");
        return a;
    };
    g_positions = "[]";
    g_account = Acct("97000", "100000");  // exactly -3%: not a breach
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 51));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("loss-3pct-exact-no-hold",
          dec.find("daily-loss-3pct") == std::string::npos &&
              Slurp(env.dir + "/daily-loss.day").empty());
    g_account = Acct("96900", "100000");  // -3.1%
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 52));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("daily-loss-holds-entry",
          loop.stats().held == 1 && loop.stats().proceeded == 0 &&
              dec.rfind("daily-loss-3pct") != std::string::npos);
    CHECK("daily-loss-not-a-kill",
          Slurp(env.dir + "/dd-kill.latch").empty());
    g_positions = "[{\"symbol\":\"VTI\",\"qty\":\"40\",\"side\":\"long\","
                  "\"market_value\":\"10020.00\"}]";
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 53, "SELL"));
    loop.Tick(NOW_S * 1000000000LL);
    CHECK("daily-loss-exit-proceeds", loop.stats().proceeded == 1);
    g_positions = "[]";
    g_account = acct_ok;  // equity recovered: the day stays held
    std::remove((env.dir + "/submitted.log").c_str());  // clear r3 counters
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 54));
    loop.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("daily-loss-latched-for-day",
          loop.stats().proceeded == 0 &&
              dec.rfind("daily-loss-3pct") > dec.rfind("\"proceed\":true"));
    g_account_up = false;  // outage: still held, nothing consumed
    loop.Tick(NOW_S * 1000000000LL);
    g_account_up = true;
    CHECK("daily-loss-survives-outage", !loop.stats().account_ok);
    PaperLoop restarted(runner, io, lc);  // latch reloads from disk
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 55));
    restarted.Tick(NOW_S * 1000000000LL);
    CHECK("daily-loss-survives-restart", restarted.stats().proceeded == 0);
    // Missing last_equity falls back to equity: no breach.
    std::string nolast = acct_ok;
    nolast.replace(nolast.find("\"last_equity\":\"100000\","), 23, "");
    AccountView nav;
    CHECK("missing-last-equity-no-breach",
          ParseAccount(nolast, &nav) &&
              nav.last_equity_cents == nav.equity_cents);

    // 11c. -15% drawdown from hwm.txt raises the kill input (latched).
    KillFeed feed;
    LoopConfig lc2 = lc;
    lc2.kill_feed = &feed;
    PaperLoop dd(runner, io, lc2);
    kill::KillInputs ki;
    KillFeedInputs(&feed, &ki);
    CHECK("dd-feed-quiet-at-start", !ki.drawdown_r5);
    g_account = Acct("86000", "86000");  // -14%: below the line
    dd.Tick(NOW_S * 1000000000LL);
    KillFeedInputs(&feed, &ki);
    CHECK("dd-14pct-no-kill", !ki.drawdown_r5 && !feed.drawdown_r5);
    g_account = Acct("85000", "85000");  // exactly -15%
    dd.Tick(NOW_S * 1000000000LL);
    ki = kill::KillInputs();
    KillFeedInputs(&feed, &ki);
    kill::LevelResult lr = kill::EvaluateLevel(ki);
    CHECK("dd-15pct-kills", ki.drawdown_r5 &&
                                lr.level == risk::KillLevel::MEDIUM &&
                                std::strcmp(lr.reason, "kill:drawdown-r5") == 0);
    CHECK("dd-latch-persisted", !Slurp(env.dir + "/dd-kill.latch").empty());
    g_account = acct_ok;  // recovery does not clear the latch
    dd.Tick(NOW_S * 1000000000LL);
    g_account_up = false;  // nor does missing data
    dd.Tick(NOW_S * 1000000000LL);
    g_account_up = true;
    ki = kill::KillInputs();
    KillFeedInputs(&feed, &ki);
    CHECK("dd-latch-holds", ki.drawdown_r5);
    KillFeed feed2;  // a restart reads the latch file
    lc2.kill_feed = &feed2;
    PaperLoop dd2(runner, io, lc2);
    CHECK("dd-latch-restart", feed2.drawdown_r5);
    CHECK("dd-hwm-untouched", Slurp(env.dir + "/hwm.txt") == "10000000");
    std::remove((env.dir + "/submitted.log").c_str());  // clear r3 counters
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 56));
    dd.Tick(NOW_S * 1000000000LL);
    dec = Slurp(env.dir + "/decisions.jsonl");
    CHECK("dd-holds-entry-named", dd.stats().proceeded == 0 &&
              dec.rfind("drawdown-15pct-kill") != std::string::npos);
    g_positions = "[{\"symbol\":\"VTI\",\"qty\":\"40\",\"side\":\"long\","
                  "\"market_value\":\"10020.00\"}]";
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1", 57, "SELL"));
    dd.Tick(NOW_S * 1000000000LL);
    CHECK("dd-exit-proceeds", dd.stats().proceeded == 1);
    g_positions = "[]";
    KillFeedInputs(nullptr, &ki);  // null-safe
    std::remove((env.dir + "/dd-kill.latch").c_str());
    std::remove((env.dir + "/daily-loss.day").c_str());

    // 12. a calendar with no holiday in the traded year fails closed.
    Append(env.dir + "/candidates.jsonl", Cand("trend_etf_v1"));
    loop.Tick((NOW_S + 400LL * 86400) * 1000000000LL);
    CHECK("calendar-year-uncovered", !loop.stats().account_ok);

    CHECK("offset-persisted", Slurp(env.dir + "/candidates.offset").size() > 0);
    CHECK("hwm-persisted", Slurp(env.dir + "/hwm.txt") == "10000000");
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
