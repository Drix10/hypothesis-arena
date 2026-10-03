// Deterministic risk veto.
//
// Pure snapshot -> HOLD/PROCEED + reason. No I/O, no RNG, no model reads.
// Same snapshot -> bit-identical verdict.
//
// Money is int64 cents with exact integer comparisons (__int128 products);
// no float accounting. Every scaled cap is an exact small rational (stage
// multipliers 1, 1/4, 1/2, 1; R2 caps 1/4 single and 3/4 total), see
// StageScale.
//
// Precedence: the first armed condition wins the logged reason, and all
// armed reasons are kept in order in reasons_all for the journal:
//   exit-bypass > bad-inputs > r5 > no-stop > leverage > session/short/
//   corp > event-medium > r6/r7-unavailable > r1 > r2 > r3 > r4 >
//   r7-corr/drift > disagreement > entry-halt > kill > proceed.
// Kill is the backstop: when a specific condition is armed alongside a kill
// level the log names the cause. Every road out except PROCEED is HOLD.
//
// Count scaling (one uniform rule): every count limit scales by
// ceil(base * R-mult); the stage symbol cap also upper-bounds total
// positions. Per-symbol/hour churn scales; flip windows stay fixed (the
// 2-hour lock).
#pragma once
#include <cstdint>
#include <string>
#include <type_traits>
#include <vector>

namespace kernel {
namespace risk {

// Stages carry exact rational multipliers.
enum class Stage { PAPER, TINY, SCALED, FULL, UNKNOWN };
enum class KillLevel { NONE, SOFT, MEDIUM, HARD };
enum class IntentKind { ENTRY, EXIT };  // exits bypass the veto
enum class AssetClass { FOREX, STOCK };
enum class AccountType { MARGIN, CASH };
enum class Impact { NONE, LOW, MEDIUM, HIGH, BINARY };
enum class Phase { NONE, PRE, BLACKOUT, POST };
enum class Side { LONG, SHORT };

// Exact stage parameters: mult_num/mult_den is the R-multiplier,
// symbols is the stage symbol cap.
struct StageScale {
    int mult_num = 1;
    int mult_den = 1;
    int symbols = 5;
};
inline StageScale ScaleFor(Stage s) {
    switch (s) {
        case Stage::PAPER:
            return {1, 1, 5};
        case Stage::TINY:
            return {1, 4, 1};
        case Stage::SCALED:
            return {1, 2, 3};
        case Stage::FULL:
            return {1, 1, 5};
        default:
            return {1, 1, 0};  // UNKNOWN: zero symbols => cannot proceed
    }
}
inline Stage ParseStage(const std::string& s) {
    if (s == "PAPER") return Stage::PAPER;
    if (s == "TINY") return Stage::TINY;
    if (s == "SCALED") return Stage::SCALED;
    if (s == "FULL") return Stage::FULL;
    return Stage::UNKNOWN;
}

struct Position {
    std::string symbol;
    Side side = Side::LONG;
    int64_t notional_cents = 0;  // account currency, converted upstream
};
struct PendingOrder {
    std::string symbol;
    Side side = Side::LONG;
    int64_t notional_cents = 0;  // entry + unacked, converted upstream
    int64_t margin_cents = 0;    // pending margin at the adapter's rate
};
struct Intent {
    IntentKind kind = IntentKind::ENTRY;
    std::string symbol;
    Side side = Side::LONG;
    int64_t notional_cents = 0;
    bool has_stop = false;  //: no stop => rejected, no exceptions
    AssetClass asset = AssetClass::FOREX;
    AccountType account = AccountType::MARGIN;
};
// R7 drift-removal candidate (all account-currency cents, snapshot-frozen).
struct DriftCandidate {
    std::string symbol;
    int64_t var_reduction_cents = 0;  // must be > 0 to be eligible
    int64_t unrealized_pnl_cents = 0;
    int64_t opened_us = 0;  // tie-break: older first, then symbol
};

// The validated-snapshot input. Zero-initialized HOLDs: every gate flag
// defaults to closed/unavailable and every money field to 0 (equity 0 =>
// bad-inputs). Upstream slices own measurement; the veto enforces. Flags
// marked (/F/G) arrive validated, never inferred.
struct RiskSnapshot {
    // Portfolio.
    int64_t equity_cents = 0;
    int64_t margin_used_cents = 0;
    std::vector<Position> open;
    std::vector<PendingOrder> pending;
    Intent intent;
    int64_t now_us = 0;
    // R3 churn (acked fills only — unacked orders never consume churn).
    int64_t day_count = 0;     // UTC-day acked fills
    int64_t day_number = -1;   // now_us day; mismatch => stale, not counted
    int64_t hour_count = 0;    // acked fills on intent symbol, current hour
    int64_t hour_bucket = -1;  // hour bucket of hour_count; mismatch => 0
    // R4 flip-lock (last two direction-changing FILLS on flip_symbol).
    bool flip_armed = false;
    std::string flip_symbol;
    int64_t flip_t1_us = 0;
    int64_t flip_t2_us = 0;
    // R5 peak (both persisted upstream; veto takes the max).
    int64_t daily_close_hwm_cents = 0;
    int64_t intraday_hwm_cents = 0;
    // R6/R7 availability + trip state (measurement upstream incl. the R6
    // data-age gate and R7 freshness/coverage gates; veto enforces).
    bool r6_available = false;
    bool r6_trip = false;  // trip => halve (scale 0.5), never HOLD
    bool r7_available = false;
    bool r7_entry_breach = false;  // entry would create a >0.9 pair
    bool r7_drift_breach = false;  // an open pair drifted past 0.9
    std::vector<DriftCandidate> drift;
    // R9 blocks + session (calendars/jurisdiction upstream, /G).
    bool session_open = false;
    bool short_ok = true;  // false => SHORT intent HOLDs (R9 short rule)
    bool corp_block = false;
    // Event state (raw tier; veto maps tier table).
    Impact impact = Impact::NONE;
    Phase phase = Phase::NONE;
    // R14 input from validated state (never inferred here).
    bool disagreement = false;  // opposite TRIGGER effects on one symbol
    // Halt/kill plane (owns levels; veto consumes + enforces).
    bool entry_halt = false;  // model, broker or clock outage, or required research down
    KillLevel kill = KillLevel::NONE;
    Stage stage = Stage::PAPER;
    int64_t risk_fraction_bp = 25;  // reserved_risk fraction (25bp base)
    // v3 live constraint set. Opt-in so pre-v3 verdicts stay
    // bit-identical; the stage manifest sets it for any stage that trades
    // (paper trading onward). When true, fail-closed defaults hold.
    bool v3_constraints = false;
    int64_t settled_cash_cents = 0;    // R18: settled cash before pending buys
    bool r18_unsettled_dependency = false;  // ledger: good-faith/free-riding
    bool instrument_allowed = false;   // R19: on the signed allowlist
};

// Verdict: PROCEED or HOLD with a fixed reason code. reasons_all keeps every
// armed condition in precedence order, so first-wins never drops a co-cause.
//
// Zero-malloc: the verdict is trivially copyable fixed storage (32 reason
// slots: 22 battery arm sites plus the bad-inputs early return; the cap is
// unreachable) and a drift candidate index. Proven by the static_assert
// below and the build.sh allocation grep gate.
struct VetoVerdict {
    bool proceed = false;
    const char* reason = "bad-inputs";
    static constexpr int kMaxArmed = 32;
    const char* reasons_all[kMaxArmed];
    int n_reasons = 0;
    double size_scale = 1.0;  // R6 trip => 0.5
    int stage_num = 1;        // R-multiplier for the router (veto never sizes)
    int stage_den = 1;
    int drift_idx = -1;  // R7 drift directive: index into snapshot drift
                         // (-1 = none). the router contract: on breach with idx >= 0,
                         // the router journals the directive, executes and reconciles
                         // the removal, re-checks the snapshot/caps, and only
                         // then permits the new entry; PROCEED is conditional
                         // on that ordering. Phantom candidates are rejected
                         // (bad-inputs) so the directive names a real position.
    bool escalate = false;  // drift breach with no VaR-reducing removal
};
static_assert(std::is_trivially_copyable<VetoVerdict>::value,
              "verdict must stay allocation-free fixed storage");

// Pure entry points (veto.cpp). No I/O, no clock reads, no RNG.
VetoVerdict EvaluateVeto(const RiskSnapshot& s);
// snapshot formulas.
int64_t PendingNotional(const RiskSnapshot& s);
int64_t ReservedRisk(const RiskSnapshot& s);  // ceil(p * bp / 10000)
int64_t MarginRequirement(const RiskSnapshot& s);
int64_t BuyingPower(const RiskSnapshot& s);  // may be negative (reported raw)
// R5 drawdown halt: strictly > 10% of peak.
bool R5Trips(int64_t equity_cents, int64_t peak_cents);
// R7 drift-removal selection: index into s.drift, or -1 when no removal
// reduces VaR. Total deterministic order: ratio, older first, symbol.
int DriftSelection(const RiskSnapshot& s);
// Event mapping: (impact, phase) -> blackout flag.
// MEDIUM+active is not expressible as a flag, so the veto HOLDs it directly
// (an over-approximation of "entries need strong"; see EvaluateVeto).
bool EventBlackout(Impact impact, Phase phase);
bool EventMediumActive(Impact impact, Phase phase);

}  // namespace risk
}  // namespace kernel
