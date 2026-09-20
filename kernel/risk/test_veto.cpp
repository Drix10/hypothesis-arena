// P3.5 Slice B — veto unit suite (cases derived from doc 05 rules +
// doc 03 §3.2/§3.3 boundaries). Pure structs only; the two composed rows
// use the frozen P3.3 table as a tool (modifies nothing) to prove
// veto+table agreement end to end.
#include <cmath>
#include <cstdio>
#include <cstring>
#include <string>

#include "../decision_table.hpp"
#include "../jev_validate.hpp"
#include "../kernel_state.hpp"
#include "veto.hpp"

static int fails = 0;
static int count = 0;
#define CHECK(name, expr)                                     \
    do {                                                      \
        count++;                                              \
        if (!(expr)) {                                        \
            printf("FAIL %s\n", name);                        \
            fails++;                                          \
        }                                                     \
    } while (0)

static const int64_t NOW = 1800000000000000LL;
static const int64_t HOUR = 3600LL * 1000000LL;
static const int64_t DAY = 24LL * HOUR;

using namespace jev;
using namespace jev::risk;

// A clean G0 snapshot that must PROCEED ($100k equity, all gates open).
static RiskSnapshot Clean() {
    RiskSnapshot s;
    s.equity_cents = 10000000LL;  // $100,000.00
    s.daily_close_hwm_cents = 10000000LL;
    s.intraday_hwm_cents = 10000000LL;
    s.intent.kind = IntentKind::ENTRY;
    s.intent.symbol = "EURUSD";
    s.intent.side = Side::LONG;
    s.intent.notional_cents = 1000000LL;  // $10k = 10% equity
    s.intent.has_stop = true;
    s.now_us = NOW;
    s.day_number = NOW / DAY;
    s.hour_bucket = NOW / HOUR;
    s.session_open = true;
    s.r6_available = true;
    s.r7_available = true;
    return s;
}
static void AddOpen(RiskSnapshot& s, const std::string& sym, Side side,
                    int64_t cents) {
    Position p;
    p.symbol = sym;
    p.side = side;
    p.notional_cents = cents;
    s.open.push_back(p);
}
static void AddPending(RiskSnapshot& s, const std::string& sym, Side side,
                       int64_t cents) {
    PendingOrder p;
    p.symbol = sym;
    p.side = side;
    p.notional_cents = cents;
    s.pending.push_back(p);
}
static std::string read_all(const char* path) {
    std::string out;
    char buf[4096];
    FILE* f = fopen(path, "rb");
    if (!f) return out;
    size_t n;
    while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
    fclose(f);
    return out;
}

int main(int argc, char** argv) {
    // ---- Stage table + parsing ----
    CHECK("g0-mult", ScaleFor(Stage::G0_PAPER).mult_num == 1 &&
                         ScaleFor(Stage::G0_PAPER).mult_den == 1 &&
                         ScaleFor(Stage::G0_PAPER).symbols == 5);
    CHECK("g1-mult", ScaleFor(Stage::G1_TINY).mult_num == 1 &&
                         ScaleFor(Stage::G1_TINY).mult_den == 4 &&
                         ScaleFor(Stage::G1_TINY).symbols == 1);
    CHECK("g2-mult", ScaleFor(Stage::G2_SCALED).mult_num == 1 &&
                         ScaleFor(Stage::G2_SCALED).mult_den == 2 &&
                         ScaleFor(Stage::G2_SCALED).symbols == 3);
    CHECK("g3-mult", ScaleFor(Stage::G3_FULL).mult_num == 1 &&
                         ScaleFor(Stage::G3_FULL).mult_den == 1);
    CHECK("parse-stages", ParseStage("G0_PAPER") == Stage::G0_PAPER &&
                              ParseStage("G1_TINY") == Stage::G1_TINY &&
                              ParseStage("G2_SCALED") == Stage::G2_SCALED &&
                              ParseStage("G3_FULL") == Stage::G3_FULL &&
                              ParseStage("G9") == Stage::UNKNOWN &&
                              ParseStage("") == Stage::UNKNOWN);

    // ---- K6 formulas ----
    {
        RiskSnapshot s = Clean();
        AddPending(s, "EURUSD", Side::LONG, 2000000LL);   // $20k
        AddPending(s, "GBPUSD", Side::SHORT, 1000000LL);  // $10k
        CHECK("k6-pending", PendingNotional(s) == 3000000LL);
        // reserved = ceil(30000.00 * 25 / 10000) = ceil(75.00) = $75.00
        CHECK("k6-reserved", ReservedRisk(s) == 7500LL);
        s.margin_used_cents = 500000LL;
        s.pending[0].margin_cents = 100000LL;
        CHECK("k6-margin", MarginRequirement(s) == 600000LL);
        CHECK("k6-power", BuyingPower(s) == 10000000LL - 600000LL);
        RiskSnapshot e = Clean();
        e.open.clear();
        e.pending.clear();
        CHECK("k6-empty", PendingNotional(e) == 0 && ReservedRisk(e) == 0 &&
                              BuyingPower(e) == 10000000LL);
    }

    // ---- Clean proceeds ----
    {
        VetoVerdict v = EvaluateVeto(Clean());
        CHECK("clean-proceed", v.proceed && std::string(v.reason) == "proceed");
        CHECK("clean-scale", v.size_scale == 1.0);
        CHECK("clean-stage", v.stage_num == 1 && v.stage_den == 1);
        CHECK("clean-all-empty", v.n_reasons == 0);
    }
    // ---- Exit bypass (even under HARD kill + R5 trip) ----
    {
        RiskSnapshot s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.kill = KillLevel::HARD;
        s.equity_cents = 1000000LL;  // 90% drawdown, would trip R5
        VetoVerdict v = EvaluateVeto(s);
        CHECK("exit-bypass",
              v.proceed && std::string(v.reason) == "exit-bypass");
        EngineInputs in = BuildEngineInputs(s, v);
        CHECK("exit-no-veto", !in.deterministic_veto);
    }
    // ---- bad-inputs ----
    {
        RiskSnapshot s = Clean();
        s.equity_cents = 0;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("zero-equity", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.stage = Stage::UNKNOWN;
        v = EvaluateVeto(s);
        CHECK("unknown-stage",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.intent.notional_cents = -1;
        v = EvaluateVeto(s);
        CHECK("neg-intent", !v.proceed);
    }

    // ---- R5 drawdown (strictly > 10%) ----
    {
        CHECK("r5-exact10", !R5Trips(9000000LL, 10000000LL));  // == 10%: free
        CHECK("r5-over10", R5Trips(8999999LL, 10000000LL));
        CHECK("r5-peakmax", R5Trips(8900000LL, 10000000LL) &&
                                !R5Trips(9100000LL, 10000000LL));
        CHECK("r5-badpeak", R5Trips(100LL, 0));
        RiskSnapshot s = Clean();
        s.equity_cents = 8999999LL;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r5-verdict", !v.proceed && std::string(v.reason) == "r5-loss-cap");
        EngineInputs in = BuildEngineInputs(s, v);
        CHECK("r5-enum",
              in.deterministic_veto &&
                  in.veto_reason == VetoReason::LOSS_CAP_R5);
    }
    // ---- §5.2 stop + leverage ----
    {
        RiskSnapshot s = Clean();
        s.intent.has_stop = false;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("no-stop", !v.proceed && std::string(v.reason) == "no-stop");
        // Leverage can only arm past R2 (R2's 25% always binds first at
        // these scales): the boundary proof is that exact-cap leverage
        // does NOT add a hold, and over-cap DOES arm (before r2 in order).
        s = Clean();
        s.intent.notional_cents = 50000000LL;  // exactly 5x forex
        v = EvaluateVeto(s);
        CHECK("lev5x-exact",
              !v.proceed && v.n_reasons == 1 &&
                  std::string(v.reason) == "r2-single");
        s.intent.notional_cents = 50000001LL;  // over 5x
        v = EvaluateVeto(s);
        // leverage precedes r2 in the frozen order; both preserved
        CHECK("lev5x-over",
              !v.proceed && v.n_reasons >= 2 &&
                  std::string(v.reasons_all[0]) == "leverage-cap" &&
                  std::string(v.reasons_all[1]) == "r2-single");
        s = Clean();
        s.intent.asset = AssetClass::STOCK;
        s.intent.account = AccountType::CASH;
        s.intent.notional_cents = 10000000LL;  // exactly 1x: leverage clean
        v = EvaluateVeto(s);
        CHECK("lev-cash1x",
              !v.proceed && std::string(v.reason) == "r2-single" &&
                  v.n_reasons == 1);
        s.intent.notional_cents = 10000001LL;  // over 1x: leverage arms
        v = EvaluateVeto(s);
        CHECK("lev-cash-over",
              !v.proceed && std::string(v.reasons_all[0]) == "leverage-cap");
    }
    // ---- R9 session / short / corp ----
    {
        RiskSnapshot s = Clean();
        s.session_open = false;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("session", !v.proceed && std::string(v.reason) == "session-closed");
        EngineInputs in = BuildEngineInputs(s, v);
        CHECK("session-enum", in.veto_reason == VetoReason::SESSION_CLOSED);
        s = Clean();
        s.intent.asset = AssetClass::STOCK;
        s.intent.side = Side::SHORT;
        s.short_ok = false;
        v = EvaluateVeto(s);
        CHECK("short", !v.proceed && std::string(v.reason) == "short-block");
        s = Clean();
        s.corp_block = true;
        v = EvaluateVeto(s);
        CHECK("corp", !v.proceed && std::string(v.reason) == "corp-action-block");
        // forex SHORT needs no locate: short_ok=false is ignored for forex
        s = Clean();
        s.intent.side = Side::SHORT;
        s.short_ok = false;
        v = EvaluateVeto(s);
        CHECK("forex-short-free", v.proceed);
    }
    // ---- Events: blackout flag vs MEDIUM hold ----
    {
        CHECK("ev-binary-pre", EventBlackout(Impact::BINARY, Phase::PRE));
        CHECK("ev-binary-none", !EventBlackout(Impact::BINARY, Phase::NONE));
        CHECK("ev-high-post", EventBlackout(Impact::HIGH, Phase::POST));
        CHECK("ev-high-pre", !EventBlackout(Impact::HIGH, Phase::PRE));
        CHECK("ev-low-free", !EventBlackout(Impact::LOW, Phase::BLACKOUT));
        CHECK("ev-medium", EventMediumActive(Impact::MEDIUM, Phase::PRE) &&
                               !EventMediumActive(Impact::MEDIUM, Phase::NONE));
        RiskSnapshot s = Clean();
        s.impact = Impact::MEDIUM;
        s.phase = Phase::PRE;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("ev-medium-hold",
              !v.proceed && std::string(v.reason) == "event-medium");
    }
    // ---- R6/R7 availability ----
    {
        RiskSnapshot s = Clean();
        s.r6_available = false;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r6-unavail", !v.proceed && std::string(v.reason) == "r6-unavailable");
        EngineInputs in = BuildEngineInputs(s, v);
        CHECK("r6-enum", in.veto_reason == VetoReason::VOL_TRIP_R6);
        s = Clean();
        s.r6_trip = true;  // trip halves, never holds
        v = EvaluateVeto(s);
        CHECK("r6-trip-scale", v.proceed && v.size_scale == 0.5);
        in = BuildEngineInputs(s, v);
        CHECK("r6-trip-flag", in.r6_vol_trip && !in.deterministic_veto);
        s = Clean();
        s.r7_available = false;
        v = EvaluateVeto(s);
        CHECK("r7-unavail", !v.proceed && std::string(v.reason) == "r7-unavailable");
        s = Clean();
        s.r7_entry_breach = true;
        v = EvaluateVeto(s);
        CHECK("r7-corr", !v.proceed && std::string(v.reason) == "r7-correlation");
    }
    // ---- R1 counts (G0: cap 3; direction 2) ----
    {
        // 3rd position allowed (opens are SHORT so the direction cap —
        // 2 same-side — stays out of the way of the LONG intent).
        RiskSnapshot s = Clean();
        AddOpen(s, "A", Side::SHORT, 100000LL);
        AddOpen(s, "B", Side::SHORT, 100000LL);
        VetoVerdict v = EvaluateVeto(s);  // 3rd position: allowed
        CHECK("r1-third", v.proceed);
        AddOpen(s, "C", Side::SHORT, 100000LL);
        v = EvaluateVeto(s);  // 4th: held on count
        CHECK("r1-fourth",
              !v.proceed && std::string(v.reason) == "r1-count");
        s = Clean();
        s.intent.symbol = "A";
        AddOpen(s, "A", Side::SHORT, 100000LL);  // held symbol: opposite side
        v = EvaluateVeto(s);
        CHECK("r1-symbol", !v.proceed && std::string(v.reason) == "r1-symbol");
        s = Clean();
        AddPending(s, "EURUSD", Side::LONG, 100000LL);  // pending on symbol
        v = EvaluateVeto(s);
        CHECK("r1-pend-symbol",
              !v.proceed && std::string(v.reason) == "r1-symbol");
        // direction: 2 same-side + intent = breach
        s = Clean();
        AddOpen(s, "A", Side::LONG, 100000LL);
        AddOpen(s, "B", Side::LONG, 100000LL);
        v = EvaluateVeto(s);
        CHECK("r1-direction",
              !v.proceed && std::string(v.reason) == "r1-direction");
        // pending-attributed count breach => pending-risk (filled alone fits)
        s = Clean();
        AddOpen(s, "A", Side::SHORT, 100000LL);
        AddOpen(s, "B", Side::SHORT, 100000LL);
        AddPending(s, "C", Side::SHORT, 100000LL);
        v = EvaluateVeto(s);
        CHECK("r1-pend-risk",
              !v.proceed && std::string(v.reason) == "pending-risk");
        EngineInputs in = BuildEngineInputs(s, v);
        CHECK("r1-pend-enum",
              in.deterministic_veto &&
                  in.veto_reason == VetoReason::PENDING_RISK &&
                  in.pending_risk_breach);
        // G1: exactly 1 slot (intent sized to the G1 6.25% single cap)
        s = Clean();
        s.stage = Stage::G1_TINY;
        s.intent.notional_cents = 625000LL;
        v = EvaluateVeto(s);
        CHECK("g1-first", v.proceed);
        AddOpen(s, "X", Side::LONG, 100000LL);
        v = EvaluateVeto(s);
        CHECK("g1-second", !v.proceed);
    }
    // ---- R2 exposure (exact integer boundaries, pending counts) ----
    {
        RiskSnapshot s = Clean();
        s.intent.notional_cents = 2500000LL;  // exactly 25%: allowed
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r2-single-exact", v.proceed);
        s.intent.notional_cents = 2500001LL;
        v = EvaluateVeto(s);
        CHECK("r2-single-over",
              !v.proceed && std::string(v.reason) == "r2-single");
        // total exactly 75%: 10k intent + 65k open = 75k of 100k
        // (B is SHORT so the direction cap stays out of the way).
        s = Clean();
        AddOpen(s, "A", Side::LONG, 6500000LL);
        s.intent.notional_cents = 1000000LL;
        v = EvaluateVeto(s);
        CHECK("r2-total-exact", v.proceed);
        AddOpen(s, "B", Side::SHORT, 1LL);
        v = EvaluateVeto(s);
        CHECK("r2-total-over",
              !v.proceed && std::string(v.reason) == "r2-total");
        // pending-attributed total breach => pending-risk
        s = Clean();
        s.intent.notional_cents = 1000000LL;
        AddPending(s, "Z", Side::LONG, 7000000LL);  // 10+70 = 80% > 75%
        v = EvaluateVeto(s);
        CHECK("r2-pend-risk",
              !v.proceed && std::string(v.reason) == "pending-risk");
        // G1 scaled single: 100k * 1/16 = $6,250.00 exactly
        s = Clean();
        s.stage = Stage::G1_TINY;
        s.intent.notional_cents = 625000LL;
        v = EvaluateVeto(s);
        CHECK("g1-r2-exact", v.proceed);
        s.intent.notional_cents = 625001LL;
        v = EvaluateVeto(s);
        CHECK("g1-r2-over", !v.proceed);
    }
    // ---- R3 churn (acked only; stale buckets reset) ----
    {
        RiskSnapshot s = Clean();
        s.day_count = 19;  // 20th allowed
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r3-day20", v.proceed);
        s.day_count = 20;  // 21st held
        v = EvaluateVeto(s);
        CHECK("r3-day21", !v.proceed && std::string(v.reason) == "r3-day");
        s = Clean();
        s.hour_count = 2;  // 3rd in hour allowed
        v = EvaluateVeto(s);
        CHECK("r3-hour3", v.proceed);
        s.hour_count = 3;  // 4th held
        v = EvaluateVeto(s);
        CHECK("r3-hour4", !v.proceed && std::string(v.reason) == "r3-hour");
        s = Clean();
        s.day_count = 99;
        s.day_number = -5;  // stale day => reset to 0
        s.hour_count = 99;
        s.hour_bucket = -5;
        v = EvaluateVeto(s);
        CHECK("r3-stale-reset", v.proceed);
        // G1 day cap is 5 (intent sized to the G1 single cap)
        s = Clean();
        s.stage = Stage::G1_TINY;
        s.intent.notional_cents = 625000LL;
        s.day_count = 4;
        v = EvaluateVeto(s);
        CHECK("g1-day5", v.proceed);
        s.day_count = 5;
        v = EvaluateVeto(s);
        CHECK("g1-day6", !v.proceed);
    }
    // ---- R4 flip-lock ----
    {
        RiskSnapshot s = Clean();
        s.flip_armed = true;
        s.flip_symbol = "EURUSD";
        s.flip_t1_us = NOW - 40 * 60 * 1000000LL;
        s.flip_t2_us = NOW - 10 * 60 * 1000000LL;  // 30m apart, 10m ago
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r4-locked", !v.proceed && std::string(v.reason) == "r4-flip-lock");
        s.flip_t1_us = NOW - 40 * 60 * 1000000LL;
        s.flip_t2_us = NOW - 151 * 60 * 1000000LL;  // lock expired (>2h)
        s.flip_t1_us = s.flip_t2_us - 30 * 60 * 1000000LL;  // 30m completion
        v = EvaluateVeto(s);
        CHECK("r4-expired", v.proceed);
        // completion interval exactly 1h still counts as "within"
        s.flip_t1_us = NOW - 130 * 60 * 1000000LL;
        s.flip_t2_us = NOW - 70 * 60 * 1000000LL;
        v = EvaluateVeto(s);
        CHECK("r4-boundary", !v.proceed);
        // different symbol: free
        s.flip_symbol = "GBPUSD";
        v = EvaluateVeto(s);
        CHECK("r4-symbol", v.proceed);
        // corrupt history (t2 < t1) is malformed input, not an
        // expired lock: bad-inputs (structural validation, correction).
        s.flip_symbol = "EURUSD";
        s.flip_t1_us = NOW;
        s.flip_t2_us = NOW - 1000LL;
        v = EvaluateVeto(s);
        CHECK("r4-corrupt",
              !v.proceed && std::string(v.reason) == "bad-inputs" &&
                  v.n_reasons == 1);
    }
    // ---- R7 drift selection ----
    {
        RiskSnapshot s = Clean();
        DriftCandidate a{"AAA", 500000LL, 200000LL, 1000LL};
        DriftCandidate b{"BBB", 500000LL, 200000LL, 2000LL};
        s.drift.push_back(b);
        s.drift.push_back(a);  // insertion order must not matter
        CHECK("drift-older", DriftSelection(s) == 1);
        // equal ratio, equal age: lexicographic symbol
        s.drift[0].opened_us = 1000LL;
        CHECK("drift-symbol", DriftSelection(s) == 1);  // AAA < BBB
        // zero-denominator guard: PnL 0 ranks by VaR_reduction alone
        RiskSnapshot s2 = Clean();
        DriftCandidate c{"CCC", 900000LL, 0LL, 5000LL};
        DriftCandidate d{"DDD", 100000LL, 100000LL, 1000LL};
        s2.drift.push_back(d);
        s2.drift.push_back(c);
        CHECK("drift-epsilon", DriftSelection(s2) == 1);  // 9k/1 >> 1k/1k
        // negative-PnL positions are eligible
        RiskSnapshot s3 = Clean();
        DriftCandidate e{"EEE", 400000LL, -5000000LL, 1000LL};
        s3.drift.push_back(e);
        CHECK("drift-negpnl", DriftSelection(s3) == 0);
        // no VaR reduction anywhere => -1 => HOLD + escalate
        RiskSnapshot s4 = Clean();
        DriftCandidate f{"FFF", 0LL, 100000LL, 1000LL};
        DriftCandidate g{"GGG", -5000LL, 100000LL, 1000LL};
        s4.drift.push_back(f);
        s4.drift.push_back(g);
        AddOpen(s4, "FFF", Side::SHORT, 100000LL);
        AddOpen(s4, "GGG", Side::SHORT, 100000LL);
        s4.r7_drift_breach = true;
        CHECK("drift-none", DriftSelection(s4) == -1);
        VetoVerdict v = EvaluateVeto(s4);
        CHECK("drift-hold",
              !v.proceed &&
                  std::string(v.reason) == "r7-drift-no-removal" && v.escalate);
        // found removal => directive attached, evaluation continues
        RiskSnapshot s5 = Clean();
        s5.drift.push_back(e);
        AddOpen(s5, "EEE", Side::LONG, 500000LL);
        s5.r7_drift_breach = true;
        v = EvaluateVeto(s5);
        CHECK("drift-directive",
              v.proceed && v.drift_idx == 0 &&
                  s5.drift[(size_t)v.drift_idx].symbol == "EEE" &&
                  !v.escalate);
        // ...and a later hold (R14) still fires with the directive attached
        s5.disagreement = true;
        v = EvaluateVeto(s5);
        CHECK("drift-then-r14",
              !v.proceed && std::string(v.reason) == "disagreement" &&
                  v.drift_idx == 0 &&
                  s5.drift[(size_t)v.drift_idx].symbol == "EEE");
    }
    // ---- R14 / R13 / halt / kill + precedence ----
    {
        RiskSnapshot s = Clean();
        s.disagreement = true;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r14", !v.proceed && std::string(v.reason) == "disagreement");
        EngineInputs in = BuildEngineInputs(s, v);
        CHECK("r14-passthrough", in.disagreement);
        // R13: exactly 0.02 over with 19 outcomes => free (both margins)
        s = Clean();
        s.brier_delta = 0.02;
        s.realized_outcomes = 19;
        CHECK("r13-free", EvaluateVeto(s).proceed);
        CHECK("r13-floor-false", !R13FloorTrips(0.02, 19));
        s.realized_outcomes = 20;
        s.brier_delta = 0.0200001;
        v = EvaluateVeto(s);
        CHECK("r13-trip", !v.proceed && std::string(v.reason) == "r13-calibration");
        in = BuildEngineInputs(s, v);
        CHECK("r13-gatemap",
              in.calibration_gate == CalibrationGate::BREACH);
        s = Clean();
        s.brier_delta = std::numeric_limits<double>::quiet_NaN();
        s.realized_outcomes = 200;
        v = EvaluateVeto(s);
        CHECK("r13-nan", !v.proceed);
        // entry halt + kills
        s = Clean();
        s.entry_halt = true;
        v = EvaluateVeto(s);
        CHECK("halt", !v.proceed && std::string(v.reason) == "entry-halt");
        s = Clean();
        s.kill = KillLevel::SOFT;
        v = EvaluateVeto(s);
        CHECK("kill-soft", !v.proceed && std::string(v.reason) == "kill-soft");
        s.kill = KillLevel::MEDIUM;
        v = EvaluateVeto(s);
        CHECK("kill-medium",
              !v.proceed && std::string(v.reason) == "kill-medium");
        s.kill = KillLevel::HARD;
        v = EvaluateVeto(s);
        CHECK("kill-hard", !v.proceed && std::string(v.reason) == "kill-hard");
        // precedence: specific cause wins the log over an armed kill...
        // (intent sized so R2 stays out of the way at $10k equity).
        s = Clean();
        s.equity_cents = 1000000LL;
        s.intent.notional_cents = 100000LL;
        s.kill = KillLevel::MEDIUM;
        v = EvaluateVeto(s);
        CHECK("prec-kill-r5",
              !v.proceed && std::string(v.reason) == "r5-loss-cap" &&
                  v.n_reasons == 2 &&
                  std::strcmp(v.reasons_all[1], "kill-medium") == 0);
        // ...R1 precedes R2, all co-causes preserved in order
        s = Clean();
        AddOpen(s, "A", Side::LONG, 100000LL);
        AddOpen(s, "B", Side::LONG, 100000LL);
        AddOpen(s, "C", Side::LONG, 100000LL);  // count breach...
        s.intent.notional_cents = 30000000LL;  // R2 breach, leverage clean
        v = EvaluateVeto(s);
        CHECK("prec-r1-r2",
              !v.proceed && std::string(v.reason) == "r1-count" &&
                  v.n_reasons >= 3 &&
                  std::strcmp(v.reasons_all[1], "r1-direction") == 0 &&
                  std::strcmp(v.reasons_all[2], "r2-single") == 0);
        EngineInputs in2 = BuildEngineInputs(s, v);
        CHECK("prec-enum", in2.veto_reason == VetoReason::OTHER_BREACH);
    }
    // ---- stage-aware leverage (doc 10 stage table, correction) ----
    {
        // G1 forex: exactly 1x is clean, anything over arms (R2 also
        // armed at these scales; leverage must come FIRST in the order).
        RiskSnapshot s = Clean();
        s.stage = Stage::G1_TINY;
        s.intent.notional_cents = 10000000LL;  // exactly 1x of $100k
        VetoVerdict v = EvaluateVeto(s);
        CHECK("g1-lev1x",
              !v.proceed && v.n_reasons == 1 &&
                  std::string(v.reason) == "r2-single");
        s.intent.notional_cents = 10000001LL;  // over 1x
        v = EvaluateVeto(s);
        CHECK("g1-lev-over",
              !v.proceed && v.n_reasons >= 2 &&
                  std::string(v.reasons_all[0]) == "leverage-cap" &&
                  std::string(v.reasons_all[1]) == "r2-single");
        // G1 non-forex never gets more: stock capped at 1x too.
        s.intent.asset = AssetClass::STOCK;
        s.intent.notional_cents = 10000001LL;
        v = EvaluateVeto(s);
        CHECK("g1-stock-lev",
              !v.proceed &&
                  std::string(v.reasons_all[0]) == "leverage-cap");
        // G2 forex 2x exact is clean; over arms.
        s = Clean();
        s.stage = Stage::G2_SCALED;
        s.intent.notional_cents = 20000000LL;  // exactly 2x
        v = EvaluateVeto(s);
        CHECK("g2-lev2x",
              !v.proceed && v.n_reasons == 1 &&
                  std::string(v.reason) == "r2-single");
        s.intent.notional_cents = 20000001LL;
        v = EvaluateVeto(s);
        CHECK("g2-lev-over",
              !v.proceed &&
                  std::string(v.reasons_all[0]) == "leverage-cap");
        // G2 stock 1x: over arms.
        s.intent.asset = AssetClass::STOCK;
        s.intent.notional_cents = 10000001LL;
        v = EvaluateVeto(s);
        CHECK("g2-stock-lev",
              !v.proceed &&
                  std::string(v.reasons_all[0]) == "leverage-cap");
        // G0/G3 keep §5.2 (forex 5x exact clean — proven in lev5x-exact).
        s = Clean();
        s.stage = Stage::G3_FULL;
        s.intent.notional_cents = 50000000LL;
        v = EvaluateVeto(s);
        CHECK("g3-lev5x",
              !v.proceed && v.n_reasons == 1 &&
                  std::string(v.reason) == "r2-single");
    }
    // ---- invalid enums fail closed (correction: no exit-bypass) ----
    {
        RiskSnapshot s = Clean();
        s.intent.kind = (IntentKind)99;  // corrupted kind is NOT an exit
        VetoVerdict v = EvaluateVeto(s);
        CHECK("bad-kind", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.intent.side = (Side)99;
        v = EvaluateVeto(s);
        CHECK("bad-side", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.intent.asset = (AssetClass)99;
        v = EvaluateVeto(s);
        CHECK("bad-asset", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.intent.account = (AccountType)99;
        v = EvaluateVeto(s);
        CHECK("bad-account",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.impact = (Impact)99;
        v = EvaluateVeto(s);
        CHECK("bad-impact", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.phase = (Phase)99;
        v = EvaluateVeto(s);
        CHECK("bad-phase", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.calib = (CalibState)99;
        v = EvaluateVeto(s);
        CHECK("bad-calib", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.kill = (KillLevel)99;  // corrupted kill is NOT kill-soft
        v = EvaluateVeto(s);
        CHECK("bad-kill", !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        AddOpen(s, "A", (Side)99, 100000LL);  // corrupt bookkeeping side
        v = EvaluateVeto(s);
        CHECK("bad-pos-side",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        // A valid EXIT still bypasses (regression guard for the fix).
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        v = EvaluateVeto(s);
        CHECK("exit-still-bypass",
              v.proceed && std::string(v.reason) == "exit-bypass");
    }
    // ---- structural validation before EXIT bypass (correction) ----
    {
        // A valid EXIT on a corrupt snapshot is not executable: H1 needs
        // intact symbol/side/asset to construct the order. All HOLD.
        RiskSnapshot s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.intent.side = (Side)99;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("exit-bad-side",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.intent.asset = (AssetClass)99;
        v = EvaluateVeto(s);
        CHECK("exit-bad-asset",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        // Risk STATE never blocks a structurally valid exit: kill,
        // equity, clock, and flip history are entry-risk concerns.
        // (These three encoded the old wrong policy; they now prove
        // the corrected liveness boundary.)
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.kill = (KillLevel)99;
        v = EvaluateVeto(s);
        CHECK("exit-ignores-kill",
              v.proceed && std::string(v.reason) == "exit-bypass");
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.equity_cents = 0;
        v = EvaluateVeto(s);
        CHECK("exit-ignores-equity",
              v.proceed && std::string(v.reason) == "exit-bypass");
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.now_us = -1;
        v = EvaluateVeto(s);
        CHECK("exit-ignores-clock",
              v.proceed && std::string(v.reason) == "exit-bypass");
        // ...even a corrupt flip record cannot strand an exit.
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.flip_armed = true;
        s.flip_symbol = "";
        v = EvaluateVeto(s);
        CHECK("exit-ignores-flip",
              v.proceed && std::string(v.reason) == "exit-bypass");
        // But exit INTENT structure still fails closed: identity and
        // non-negative size are what H1 builds the order from.
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.intent.symbol = "";
        v = EvaluateVeto(s);
        CHECK("exit-empty-symbol",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        s.intent.kind = IntentKind::EXIT;
        s.intent.notional_cents = -1;
        v = EvaluateVeto(s);
        CHECK("exit-neg-notional",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        // Negative clock fails closed on ENTRY too.
        s = Clean();
        s.now_us = -1;
        v = EvaluateVeto(s);
        CHECK("bad-clock", !v.proceed && std::string(v.reason) == "bad-inputs");
    }
    // ---- realized_outcomes sign (correction: the fail-open edge) ----
    {
        // Reviewer's exact edge: positive delta with -1 outcomes must NOT
        // leave the gate at PASS for the max-gate to use.
        RiskSnapshot s = Clean();
        s.calib = CalibState::PASS;
        s.brier_delta = 0.03;
        s.realized_outcomes = -1;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r13-neg-outcomes",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        // INT64_MAX outcomes: trip when delta says so, no overflow.
        s = Clean();
        s.brier_delta = 0.03;
        s.realized_outcomes = std::numeric_limits<int64_t>::max();
        v = EvaluateVeto(s);
        CHECK("r13-max-trip",
              !v.proceed && std::string(v.reason) == "r13-calibration");
        s.brier_delta = 0.0;
        v = EvaluateVeto(s);
        CHECK("r13-max-free", v.proceed);
    }
    // ---- flip record validation (correction) ----
    {
        RiskSnapshot s = Clean();
        s.flip_armed = true;
        s.flip_symbol = "";  // missing symbol: not an expired lock
        s.flip_t1_us = NOW - 30 * 60 * 1000000LL;
        s.flip_t2_us = NOW - 10 * 1000000LL;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("flip-empty-sym",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s.flip_symbol = "EURUSD";
        s.flip_t1_us = -5;
        v = EvaluateVeto(s);
        CHECK("flip-neg-t1",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s.flip_t1_us = NOW - 30 * 60 * 1000000LL;
        s.flip_t2_us = -5;
        v = EvaluateVeto(s);
        CHECK("flip-neg-t2",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s.flip_t2_us = NOW + 3600LL * 1000000LL;  // future fill
        v = EvaluateVeto(s);
        CHECK("flip-future",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        // Lock expires EXACTLY at +2h: now - t2 == 2h is free.
        s.flip_t1_us = NOW - 150 * 60 * 1000000LL;
        s.flip_t2_us = NOW - 120 * 60 * 1000000LL;
        v = EvaluateVeto(s);
        CHECK("flip-exact-2h", v.proceed);
    }
    // ---- Stage enum validation (correction) ----
    {
        RiskSnapshot s = Clean();
        s.stage = (Stage)99;  // unknown underlying, not UNKNOWN
        VetoVerdict v = EvaluateVeto(s);
        CHECK("bad-stage-enum",
              !v.proceed && std::string(v.reason) == "bad-inputs");
    }
    // ---- ENTRY bookkeeping identity + margin account (correction) ----
    {
        // Empty identity silently bypasses symbol logic: reject.
        RiskSnapshot s = Clean();
        s.intent.symbol = "";
        VetoVerdict v = EvaluateVeto(s);
        CHECK("entry-empty-symbol",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        AddOpen(s, "", Side::LONG, 100000LL);
        v = EvaluateVeto(s);
        CHECK("open-empty-symbol",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        AddPending(s, "", Side::LONG, 100000LL);
        v = EvaluateVeto(s);
        CHECK("pending-empty-symbol",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        // Negative used-margin makes BuyingPower exceed equity: nonsense.
        s = Clean();
        s.margin_used_cents = -1;
        v = EvaluateVeto(s);
        CHECK("margin-used-neg",
              !v.proceed && std::string(v.reason) == "bad-inputs");
    }
    // ---- drift-candidate integrity (correction: no phantom removal) ----
    {
        // A claimed breach whose candidates name no open position is
        // corrupt input — H1 must never "resolve" against thin air.
        RiskSnapshot s = Clean();
        DriftCandidate p{"ZZZ", 500000LL, 100000LL, 1000LL};
        s.drift.push_back(p);
        s.r7_drift_breach = true;
        VetoVerdict v = EvaluateVeto(s);
        CHECK("drift-phantom",
              !v.proceed && std::string(v.reason) == "bad-inputs");
        s = Clean();
        DriftCandidate q{"", 500000LL, 100000LL, 1000LL};
        s.drift.push_back(q);
        AddOpen(s, "QQQ", Side::LONG, 100000LL);
        s.r7_drift_breach = true;
        v = EvaluateVeto(s);
        CHECK("drift-empty-candidate",
              !v.proceed && std::string(v.reason) == "bad-inputs");
    }
    // ---- R3 overflow-free counters (correction) ----
    {
        RiskSnapshot s = Clean();
        s.day_count = std::numeric_limits<int64_t>::max();
        VetoVerdict v = EvaluateVeto(s);
        CHECK("r3-day-max",
              !v.proceed && std::string(v.reason) == "r3-day");
        s = Clean();
        s.hour_count = std::numeric_limits<int64_t>::max();
        v = EvaluateVeto(s);
        CHECK("r3-hour-max",
              !v.proceed && std::string(v.reason) == "r3-hour");
    }
    // ---- headroom + gate mapping on the clean path ----
    {
        EngineInputs in = BuildEngineInputs(Clean(), EvaluateVeto(Clean()));
        CHECK("headroom", in.exposure_headroom_r2 && !in.pending_risk_breach &&
                              !in.deterministic_veto &&
                              in.veto_reason == VetoReason::NONE &&
                              !in.event_blackout && !in.r6_vol_trip &&
                              in.calibration_gate ==
                                  CalibrationGate::INSUFFICIENT);
        RiskSnapshot s = Clean();
        s.calib = CalibState::PASS;
        in = BuildEngineInputs(s, EvaluateVeto(s));
        CHECK("gate-pass", in.calibration_gate == CalibrationGate::PASS);
        s.calib = CalibState::BREACH;
        in = BuildEngineInputs(s, EvaluateVeto(s));
        // floor sees delta 0 (no trip) but the state gate is BREACH:
        // the table still holds on the breach (defense in depth).
        CHECK("gate-breach-hold",
              in.calibration_gate == CalibrationGate::BREACH &&
                  !in.deterministic_veto);
    }

    // ---- composed rows: frozen table as a tool (argv: p33dir fxdir) ----
    if (argc == 3) {
        std::string dir = argv[1];
        std::string fxdir = argv[2];
        std::string kh = read_all((fxdir + "/trusted_key.txt").c_str());
        std::array<uint8_t, 32> key{};
        {
            std::string hex;
            for (char c : kh)
                if (c != '\n' && c != '\r' && c != ' ' && c != '\t') hex += c;
            if (hex.size() != 64) {
                printf("FAIL key-load\n");
                return 1;
            }
            for (size_t i = 0; i < 32; i++)
                key[i] = (uint8_t)strtoul(hex.substr(i * 2, 2).c_str(),
                                          nullptr, 16);
        }
        // validation_bytes: strip the embedded "state" (top-level keys).
        auto validation_bytes = [](const std::string& raw) {
            JVal art;
            std::string err;
            if (!ParseJson(raw, art, err)) return std::string();
            for (auto it = art.o.begin(); it != art.o.end(); ++it)
                if (U32ToUtf8(it->first) == "state") {
                    art.o.erase(it);
                    break;
                }
            return CanonJson(art);
        };
        std::string raw = read_all((dir + "/t_veto.json").c_str());
        JVal art;
        std::string err;
        CHECK("c-parses", ParseJson(raw, art, err));
        const JVal* state = ObjGet(art, "state");
        JEVStateV3 st;
        std::string dwhy;
        CHECK("c-state", state && state->t == JVal::T::OBJ &&
                             JEVStateV3::FromJVal(*state, st, dwhy));
        KernelState kern;
        std::string kwhy;
        CHECK("c-kernel",
              KernelState::Create({"EURUSD"}, kwhy, kern));
        ValidationRequest q =
            kern.request_for(validation_bytes(raw), key, st.Serialize(),
                             "EURUSD", 0.0, Mode::REPLAY);
        ValidationResult r = validate_jev(q);
        CHECK("c-valid", r.ok());
        if (r.ok()) {
            // enter 0.9 / latent 0.1 / strong / momentum + clean snapshot
            // with calib PASS => BASE base-1R (strong nominates nothing).
            RiskSnapshot s = Clean();
            s.calib = CalibState::PASS;
            VetoVerdict v = EvaluateVeto(s);
            CHECK("c-veto-proceed", v.proceed);
            EngineInputs in = BuildEngineInputs(s, v);
            Decision d = EvaluateDecision(*r.get(), in);
            CHECK("c-table-base",
                  d.budget == Decision::Budget::BASE_1R &&
                      d.action == "BASE" && d.reason == "base-1R");
            // same answers, R1-count breach => engine-veto:other-breach.
            RiskSnapshot s2 = Clean();
            s2.calib = CalibState::PASS;
            AddOpen(s2, "A", Side::LONG, 100000LL);
            AddOpen(s2, "B", Side::LONG, 100000LL);
            AddOpen(s2, "C", Side::LONG, 100000LL);
            VetoVerdict v2 = EvaluateVeto(s2);
            CHECK("c-veto-hold", !v2.proceed);
            EngineInputs in2 = BuildEngineInputs(s2, v2);
            Decision d2 = EvaluateDecision(*r.get(), in2);
            CHECK("c-table-veto",
                  d2.budget == Decision::Budget::HOLD &&
                      d2.reason == "engine-veto:other-breach");
            // MEDIUM impact + active phase HOLDs at the veto even for
            // this strong-conviction artifact: the documented fail-closed
            // over-approximation of "entries need strong" (the frozen
            // table cannot express it; refining needs a table amendment).
            RiskSnapshot s3 = Clean();
            s3.calib = CalibState::PASS;
            s3.impact = Impact::MEDIUM;
            s3.phase = Phase::PRE;
            VetoVerdict v3 = EvaluateVeto(s3);
            CHECK("c-medium-hold",
                  !v3.proceed &&
                      std::string(v3.reason) == "event-medium");
            // Case 29 (doc 03 §3.7): joint JEV error, end to end.
            // t_max_elevated is the adversarial optimistic answer proxy
            // (E .93 / macro / max / L .1, calib pass — NOT a claim that
            // the recorded answer was empirically wrong). The independent
            // RiskSnapshot supplies a real R2 pending-risk breach: intent
            // 10% + pending 66% on another symbol = 76% > 75% cap, with
            // no R1 count/direction trip, no symbol collision, no
            // leverage trip. The four optimistic answers must not
            // authorize around the independently detected breach.
            std::string raw29 = read_all((dir + "/t_max_elevated.json").c_str());
            JVal art29;
            std::string err29;
            CHECK("c29-parses", ParseJson(raw29, art29, err29));
            const JVal* state29 = nullptr;
            if (art29.t == JVal::T::OBJ) state29 = ObjGet(art29, "state");
            JEVStateV3 st29;
            std::string why29;
            bool ok29 = state29 && state29->t == JVal::T::OBJ &&
                        JEVStateV3::FromJVal(*state29, st29, why29);
            CHECK("c29-state", ok29);
            if (ok29) {
                KernelState kern29;
                std::string kwhy29;
                CHECK("c29-kernel", KernelState::Create(
                                          {"EURUSD"}, kwhy29, kern29));
                ValidationRequest q29 = kern29.request_for(
                    validation_bytes(raw29), key, st29.Serialize(),
                    "EURUSD", 0.0, Mode::REPLAY);
                ValidationResult r29 = validate_jev(q29);
                CHECK("c29-valid", r29.ok());
                if (r29.ok()) {
                    RiskSnapshot s29 = Clean();
                    s29.calib = CalibState::PASS;
                    AddPending(s29, "GBPUSD", Side::SHORT, 6600000LL);
                    VetoVerdict v29 = EvaluateVeto(s29);
                    CHECK("c29-veto-hold",
                          !v29.proceed &&
                              std::string(v29.reason) == "pending-risk");
                    EngineInputs in29 = BuildEngineInputs(s29, v29);
                    CHECK("c29-inputs",
                          in29.deterministic_veto &&
                              in29.veto_reason ==
                                  VetoReason::PENDING_RISK);
                    Decision d29 = EvaluateDecision(*r29.get(), in29);
                    CHECK("c29-table-hold",
                          d29.budget == Decision::Budget::HOLD &&
                              d29.action == "HOLD" &&
                              d29.reason == "engine-veto:pending-risk");
                }
            }
        }
    } else {
        printf("FAIL need-argv\n");
        return 1;
    }

    printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
