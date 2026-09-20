// P3.5 Slice B — deterministic risk veto (doc 05 R1-R17 + doc 03 §3.2/§3.3).
//
// Pure Snapshot -> HOLD/PROCEED + frozen reason. No I/O, no RNG, no model
// reads: this file NEVER touches a JEV AnswerSet (isolation is grep-gated
// in build.sh — the frozen §3.2 table in decision_table.hpp is the ONLY
// path by which bounded model answers influence size). Same snapshot ->
// bit-identical verdict.
//
// Money is int64 cents with exact integer comparisons (__int128 products);
// no float accounting anywhere. Percentages never appear as doubles:
// every scaled cap is an exact small rational (stage multipliers are
// 1, 1/4, 1/2, 1 and R2 caps are 1/4 single, 3/4 total, so every bound is
// an exact integer inequality — see StageScale).
//
// Precedence (frozen — first armed condition wins the logged reason; ALL
// armed reasons are preserved in order in reasons_all for the journal):
//   exit-bypass > bad-inputs > r5 > no-stop > leverage > session/short/
//   corp > event-medium > r6/r7-unavailable > r1 > r2 > r3 > r4 >
//   r7-corr/drift > disagreement > r13 > entry-halt > kill > proceed.
// Kill is the backstop, not the headline: when a specific condition is
// armed alongside a kill level, the log names the cause (the kill plane
// owns cause-logging for kill-only holds). Behavior is identical either
// way — every road out of here except PROCEED is HOLD.
//
// Count scaling (frozen — one uniform rule, flagged §13.5 audit item):
// every count limit scales by ceil(base * R-mult); the stage symbol cap
// additionally upper-bounds total positions. Per-symbol/hour churn scales
// (it is a trade-count limit, not in the doc 10 fixed list); flip windows
// stay fixed (doc 10 names the 2-hour lock explicitly).
#pragma once
#include <cstdint>
#include <string>
#include <type_traits>
#include <vector>
#include "../decision_table.hpp"

namespace jev {
namespace risk {

// Stages carry exact rational multipliers (doc 10 §10.2, locked).
enum class Stage { G0_PAPER, G1_TINY, G2_SCALED, G3_FULL, UNKNOWN };
enum class KillLevel { NONE, SOFT, MEDIUM, HARD };
enum class IntentKind { ENTRY, EXIT };  // exits bypass the veto (doc 10 §10.3)
enum class AssetClass { FOREX, STOCK };
enum class AccountType { MARGIN, CASH };
enum class CalibState { PASS, INSUFFICIENT, BREACH };
enum class Impact { NONE, LOW, MEDIUM, HIGH, BINARY };
enum class Phase { NONE, PRE, BLACKOUT, POST };
enum class Side { LONG, SHORT };

// Exact stage parameters: mult_num/mult_den is the R-multiplier,
// symbols is the stage symbol cap (doc 10 stage table).
struct StageScale {
    int mult_num = 1;
    int mult_den = 1;
    int symbols = 5;
};
inline StageScale ScaleFor(Stage s) {
    switch (s) {
        case Stage::G0_PAPER:
            return {1, 1, 5};
        case Stage::G1_TINY:
            return {1, 4, 1};
        case Stage::G2_SCALED:
            return {1, 2, 3};
        case Stage::G3_FULL:
            return {1, 1, 5};
        default:
            return {1, 1, 0};  // UNKNOWN: zero symbols => cannot proceed
    }
}
inline Stage ParseStage(const std::string& s) {
    if (s == "G0_PAPER") return Stage::G0_PAPER;
    if (s == "G1_TINY") return Stage::G1_TINY;
    if (s == "G2_SCALED") return Stage::G2_SCALED;
    if (s == "G3_FULL") return Stage::G3_FULL;
    return Stage::UNKNOWN;
}

struct Position {
    std::string symbol;
    Side side = Side::LONG;
    int64_t notional_cents = 0;  // account currency, converted upstream (K6)
};
struct PendingOrder {
    std::string symbol;
    Side side = Side::LONG;
    int64_t notional_cents = 0;  // entry + unacked, converted upstream (K6)
    int64_t margin_cents = 0;    // pending margin at the adapter's rate (K6)
};
struct Intent {
    IntentKind kind = IntentKind::ENTRY;
    std::string symbol;
    Side side = Side::LONG;
    int64_t notional_cents = 0;
    bool has_stop = false;  // §5.2: no stop => rejected, no exceptions
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

// The full validated-snapshot input. Zero-initialized HOLDs: every gate
// flag defaults to closed/unavailable and every money field to 0
// (equity 0 => bad-inputs). Upstream slices own measurement; veto owns
// enforcement. Flags marked (Slice D/F/G) arrive validated, never inferred.
struct RiskSnapshot {
    // Portfolio (K6, account currency, snapshot-frozen, D4).
    int64_t equity_cents = 0;
    int64_t margin_used_cents = 0;
    std::vector<Position> open;
    std::vector<PendingOrder> pending;
    Intent intent;
    int64_t now_us = 0;
    // R3 churn (acked fills ONLY — unacked orders never consume churn).
    int64_t day_count = 0;     // UTC-day acked fills
    int64_t day_number = -1;   // now_us day; mismatch => stale, not counted
    int64_t hour_count = 0;    // acked fills on intent symbol, current hour
    int64_t hour_bucket = -1;  // hour bucket of hour_count; mismatch => 0
    // R4 flip-lock (last two direction-changing FILLS on flip_symbol).
    bool flip_armed = false;
    std::string flip_symbol;
    int64_t flip_t1_us = 0;
    int64_t flip_t2_us = 0;
    // R5 peak (both persisted upstream; veto takes the max, doc 05 §5.1a).
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
    // R9 blocks + session (calendars/jurisdiction upstream, Slice F/G).
    bool session_open = false;
    bool short_ok = true;  // false => SHORT intent HOLDs (R9 short rule)
    bool corp_block = false;
    // Event state (raw tier; veto maps per doc 03 §3.4 tier table).
    Impact impact = Impact::NONE;
    Phase phase = Phase::NONE;
    // R13/R14 inputs from validated state (§13.5: never inferred here).
    CalibState calib = CalibState::INSUFFICIENT;
    double brier_delta = 0.0;  // trailing Brier minus baseline (>0 = worse)
    int64_t realized_outcomes = 0;
    bool disagreement = false;  // R14 opposite TRIGGER effects
    // Halt/kill plane (Slice D owns levels; veto consumes + enforces).
    bool entry_halt = false;  // S5/S9/S11/JEV-down/research-required-down
    KillLevel kill = KillLevel::NONE;
    Stage stage = Stage::G0_PAPER;
    int64_t risk_fraction_bp = 25;  // K6 reserved_risk fraction (25bp base)
};

// Verdict: PROCEED or HOLD with a FROZEN reason code (countable paper
// analysis). reasons_all preserves every armed condition in precedence
// order — first-wins never silently drops a co-cause from the journal.
//
// ZERO-MALLOC CONTRACT (core tick-path requirement): the verdict is
// trivially copyable fixed storage — 32 reason slots (22 battery arm
// sites plus the bad-inputs early return; the cap is unreachable), and a drift CANDIDATE INDEX, never allocated
// strings or vectors. EvaluateVeto allocates nothing; proven by the
// static_assert below plus the build.sh allocation grep gate.
struct VetoVerdict {
    bool proceed = false;
    const char* reason = "bad-inputs";
    static constexpr int kMaxArmed = 32;
    const char* reasons_all[kMaxArmed];
    int n_reasons = 0;
    double size_scale = 1.0;  // R6 trip => 0.5 (H1 applies; veto never sizes)
    int stage_num = 1;        // R-multiplier for H1 (veto never sizes)
    int stage_den = 1;
    int drift_idx = -1;  // R7 drift directive: index into snapshot drift
                         // (-1 = none). H1 CONTRACT (frozen): on breach
                         // with idx >= 0, H1 must journal the directive,
                         // execute + reconcile the removal, re-check the
                         // snapshot/caps, and only then permit the new
                         // entry. The PROCEED verdict authorizes the entry
                         // CONDITIONAL on that ordering — never alongside
                         // an unresolved breach. Slice B additionally
                         // rejects phantom candidates (bad-inputs) so the
                         // directive always names a real open position.
    bool escalate = false;  // drift breach with no VaR-reducing removal
};
static_assert(std::is_trivially_copyable<VetoVerdict>::value,
              "verdict must stay allocation-free fixed storage");

// Pure entry points (veto.cpp). No I/O, no clock reads, no RNG.
VetoVerdict EvaluateVeto(const RiskSnapshot& s);
// Maps a verdict + snapshot onto the frozen P3.3 table inputs (P3.3
// untouched: this only FILLS EngineInputs, never alters the table).
EngineInputs BuildEngineInputs(const RiskSnapshot& s, const VetoVerdict& v);
// K6 snapshot formulas (doc 05 §5.1, exact integer math).
int64_t PendingNotional(const RiskSnapshot& s);
int64_t ReservedRisk(const RiskSnapshot& s);  // ceil(p * bp / 10000)
int64_t MarginRequirement(const RiskSnapshot& s);
int64_t BuyingPower(const RiskSnapshot& s);  // may be negative (reported raw)
// R13 noise-gated floor (doc 05: worse by STRICTLY > 0.02 AND >= 20
// realized outcomes; non-finite delta => unknown => trip, fail-closed).
bool R13FloorTrips(double brier_delta, int64_t realized_outcomes);
// R5 drawdown halt (doc 05: STRICTLY > 10% of peak).
bool R5Trips(int64_t equity_cents, int64_t peak_cents);
// R7 drift-removal selection: index into s.drift, or -1 when no removal
// reduces VaR. Total deterministic order: ratio, older first, symbol.
int DriftSelection(const RiskSnapshot& s);
// Event mapping (doc 03 §3.4 tier table): (impact, phase) -> blackout flag.
// MEDIUM+active is NOT expressible as a flag — veto HOLDs it directly
// (fail-closed over-approximation of "entries need strong", which needs a
// table amendment to refine; see EvaluateVeto).
bool EventBlackout(Impact impact, Phase phase);
bool EventMediumActive(Impact impact, Phase phase);

}  // namespace risk
}  // namespace jev
