// Decide(): candidate -> intent or a reasoned HOLD, on hand-built records
// (same CID recipe as research/strategy/candidate.py).
#include <cstdio>
#include <cstring>
#include <string>

#include "decide.hpp"

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
using namespace jev::exec;

static const int64_t NOW = 1800000000000000000LL;
static const char* K[12] = {"strategy_version", "symbol", "snapshot_ts_ns",
    "proposed_side", "proposed_family", "entry_px", "stop_px", "tp_px",
    "time_exit_ns", "exit_profile_version", "cost_model_version",
    "feature_revision"};

static std::string Rec(const std::string& side = "BUY",
                       const std::string& sym = "VTI",
                       const std::string& sleeve = "trend_etf_v1",
                       int64_t age_s = 60) {
    std::string f[12] = {sleeve, sym, std::to_string(NOW - age_s * 1000000000LL),
                         side, "trend", "250.50",
                         side == "SELL" ? "999.00" : "230.00",
                         side == "SELL" ? "100.00" : "999.00", "0",
                         "exit_trend_v1", "cost_v2", "f1"};
    std::string joined, cand;
    for (int i = 0; i < 12; i++) {
        if (i) joined += "|";
        joined += f[i];
        cand += std::string("\"") + K[i] + "\":\"" + f[i] + "\",";
    }
    return "{\"schema\":\"c1\",\"created_ns\":\"5\",\"candidate\":{" + cand +
           "\"cid\":\"" + Sha256Hex(joined) + "\"}}";
}

static risk::RiskSnapshot Clean() {
    risk::RiskSnapshot s;
    s.equity_cents = 10000000;
    s.daily_close_hwm_cents = s.intraday_hwm_cents = 10000000;
    s.settled_cash_cents = 10000000;
    s.session_open = true;
    s.r6_available = s.r7_available = true;
    s.now_us = NOW / 1000;
    s.day_number = s.now_us / (86400LL * 1000000LL);
    s.hour_bucket = s.now_us / (3600LL * 1000000LL);
    return s;
}

static std::map<std::string, int64_t> g_held;
static EntryDecision Go(const std::string& rec, const risk::RiskSnapshot& st,
                   ingest::CandidateTables t = ingest::CandidateTables()) {
    JVal v;
    std::string err;
    if (!ParseJson(rec, v, err)) return EntryDecision();
    if (t.sleeves.empty()) t.sleeves.push_back({"trend_etf_v1", 3600});
    if (t.allowlist.empty()) t.allowlist = {"VTI", "VEU", "IEF"};
    DecideInput in;
    in.record = &v;
    in.tables = t;
    in.now_ns = NOW;
    in.state = st;
    in.held_qty = g_held;
    return Decide(in);
}

int main() {
    EntryDecision d = Go(Rec(), Clean());
    // $250 risk budget / $20.50 stop distance = 12 shares
    CHECK("proceeds", d.proceed && d.reason == "proceed");
    CHECK("qty-12", d.intent.qty_shares == 12);
    CHECK("intent-fields", std::string(d.intent.symbol) == "VTI" &&
                               d.intent.stop_cents == 23000 &&
                               d.intent.tp_cents == 99900 &&
                               d.intent.side == broker::OrderSide::BUY &&
                               d.intent.kind == risk::IntentKind::ENTRY);
    CHECK("intent-id-is-cid", d.cid.size() == 64 &&
                                  d.cid == std::string(d.intent.intent_id));
    CHECK("idempotent", Go(Rec(), Clean()).cid == d.cid);

    CHECK("unapproved-sleeve",
          Go(Rec("BUY", "VTI", "rogue"), Clean()).reason ==
              "cand-sleeve-unapproved");
    CHECK("not-allowlisted", Go(Rec("BUY", "TSLA"), Clean()).reason ==
                                 "cand-not-allowlisted");
    CHECK("stale", Go(Rec("BUY", "VTI", "trend_etf_v1", 7200), Clean()).reason ==
                       "cand-stale-or-future");
    ingest::CandidateTables held;
    held.held = {"VTI"};
    CHECK("sell-without-position-holds", Go(Rec("SELL"), Clean(), held).reason ==
                                             "exit-no-position");

    g_held["VTI"] = 40;
    EntryDecision ex = Go(Rec("SELL"), Clean(), held);
    CHECK("exit-closes-whole-position",
          ex.proceed && ex.intent.kind == risk::IntentKind::EXIT &&
              ex.intent.qty_shares == 40 &&
              ex.intent.side == broker::OrderSide::SELL);
    risk::RiskSnapshot dead = Clean();
    dead.kill = risk::KillLevel::HARD;
    dead.session_open = false;
    dead.equity_cents = 8000000;  // deep drawdown: exits still go
    CHECK("exit-bypasses-risk-limits", Go(Rec("SELL"), dead, held).proceed);
    g_held.clear();

    risk::RiskSnapshot s = Clean();
    s.session_open = false;
    CHECK("session-closed", Go(Rec(), s).reason == "session-closed");
    s = Clean();
    s.kill = risk::KillLevel::HARD;
    CHECK("kill-hard", Go(Rec(), s).reason == "kill-hard");
    s = Clean();
    s.entry_halt = true;
    CHECK("entry-halt", Go(Rec(), s).reason == "entry-halt");
    s = Clean();
    s.equity_cents = 8900000;  // >10% below the peak: R5
    CHECK("r5-loss-cap", Go(Rec(), s).reason == "r5-loss-cap");

    s = Clean();
    s.r6_trip = true;
    EntryDecision h = Go(Rec(), s);
    CHECK("r6-halves-size", h.proceed && h.intent.qty_shares == 6 &&
                                h.intent.scale_den == 2);

    s = Clean();
    s.stage = risk::Stage::G1_TINY;  // quarter risk
    EntryDecision g1 = Go(Rec(), s);
    CHECK("stage-scales-size", g1.proceed && g1.intent.qty_shares == 3 &&
                                   g1.intent.stage_den == 4);

    s = Clean();
    s.settled_cash_cents = 30000;  // $300: one share
    EntryDecision c1 = Go(Rec(), s);
    CHECK("cash-limits", c1.proceed && c1.intent.qty_shares == 1 &&
                             c1.limiter == "settled-cash");
    s = Clean();
    s.settled_cash_cents = 10000;  // $100: cannot buy one share
    CHECK("cash-too-small", Go(Rec(), s).reason == "size-below-one-share");
    s = Clean();
    risk::PendingOrder po;
    po.symbol = "VEU";
    po.notional_cents = 9990000;   // pending buys eat the settled cash
    s.pending.push_back(po);
    CHECK("pending-buys-reduce-cash", !Go(Rec(), s).proceed);

    s = Clean();
    s.equity_cents = 0;
    CHECK("bad-equity", !Go(Rec(), s).proceed);
    DecideInput none;
    CHECK("no-record", Decide(none).reason == "bad-inputs");

    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
