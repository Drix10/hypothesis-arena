// P3.5 Slice B — pure risk veto implementation. See veto.hpp for the
// frozen precedence, scaling rule, and JEV-isolation boundary.
#include "veto.hpp"

#include <cmath>
#include <limits>

namespace jev {
namespace risk {
namespace {

// Window constants (microseconds; flip lock is doc-10 fixed, unscaled).
constexpr int64_t kHourUs = 3600LL * 1000000LL;
constexpr int64_t kDayUs = 24LL * 3600LL * 1000000LL;
constexpr int64_t kFlipWindowUs = kHourUs;      // completion within 1 h
constexpr int64_t kFlipLockUs = 2 * kHourUs;    // HOLD 2 h after completion
constexpr int64_t kR13MinOutcomes = 20;
constexpr int64_t kDriftEpsilonCents = 100;  // $1 zero-denominator guard

int64_t CeilMul(int64_t base, int num, int den) {
    return (base * num + den - 1) / den;  // base, num, den > 0
}

struct Caps {
    int pos_cap;    // min(ceil(3m), stage symbols)
    int dir_cap;    // ceil(2m)
    int64_t day_cap;   // 20m exact
    int hour_cap;   // ceil(3m)
    int64_t expo_scale;  // S: single n*S>E, total T*S>3E (4/16/8/4)
};
Caps BuildCaps(const StageScale& sc) {
    Caps c;
    int pos = (int)CeilMul(3, sc.mult_num, sc.mult_den);
    c.pos_cap = pos < sc.symbols ? pos : sc.symbols;
    c.dir_cap = (int)CeilMul(2, sc.mult_num, sc.mult_den);
    c.day_cap = (20LL * sc.mult_num) / sc.mult_den;  // exact: 20/5/10/20
    c.hour_cap = (int)CeilMul(3, sc.mult_num, sc.mult_den);
    c.expo_scale = (4LL * sc.mult_den) / sc.mult_num;  // 4/16/8/4 exact
    return c;
}

int64_t SumOpen(const RiskSnapshot& s) {
    __int128 t = 0;
    for (auto& p : s.open) t += p.notional_cents;
    return t > std::numeric_limits<int64_t>::max()
               ? std::numeric_limits<int64_t>::max()
               : (int64_t)t;
}
int64_t SumPending(const RiskSnapshot& s) {
    __int128 t = 0;
    for (auto& p : s.pending) t += p.notional_cents;
    return t > std::numeric_limits<int64_t>::max()
               ? std::numeric_limits<int64_t>::max()
               : (int64_t)t;
}
int SameSideOpen(const RiskSnapshot& s, Side side, bool include_pending) {
    int n = 0;
    for (auto& p : s.open)
        if (p.side == side) n++;
    if (include_pending)
        for (auto& p : s.pending)
            if (p.side == side) n++;
    return n;
}
bool SymbolCollision(const RiskSnapshot& s, bool include_pending) {
    for (auto& p : s.open)
        if (p.symbol == s.intent.symbol) return true;
    if (include_pending)
        for (auto& p : s.pending)
            if (p.symbol == s.intent.symbol) return true;
    return false;
}
// R1 count breach with / without pending (attribution for pending-risk).
bool R1CountBreaches(const RiskSnapshot& s, int cap, bool include_pending) {
    size_t n = s.open.size() + 1;  // + intent
    if (include_pending) n += s.pending.size();
    return n > (size_t)cap;
}
bool R1DirBreaches(const RiskSnapshot& s, int cap, bool include_pending) {
    return SameSideOpen(s, s.intent.side, include_pending) + 1 > cap;
}
// Stage-aware leverage cap (doc 10 stage table + doc 05 §5.2):
//   G1: forex 1x (the single G1 symbol is forex; non-forex capped at 1x
//       too — a stage-violating symbol never gets MORE leverage).
//   G2: forex 2x, stocks 1x.  G0/G3: §5.2 (forex 5x, stock margin 2x,
//       stock cash 1x).
int MaxLeverage(Stage stage, AssetClass asset, AccountType account) {
    if (stage == Stage::G1_TINY) return 1;
    if (stage == Stage::G2_SCALED)
        return (asset == AssetClass::FOREX) ? 2 : 1;
    if (asset == AssetClass::STOCK)
        return (account == AccountType::CASH) ? 1 : 2;
    return 5;
}
// Enum boundary validation: every enum field in the snapshot must hold a
// defined value. A corrupted/underlying-out-of-range field is malformed
// input (bad-inputs), never silently neutral — and never an exit bypass.
bool ValidSide(Side side) {
    return side == Side::LONG || side == Side::SHORT;
}
bool ValidEnums(const RiskSnapshot& s) {
    if (s.intent.kind != IntentKind::ENTRY &&
        s.intent.kind != IntentKind::EXIT)
        return false;
    if (!ValidSide(s.intent.side)) return false;
    if (s.intent.asset != AssetClass::FOREX &&
        s.intent.asset != AssetClass::STOCK)
        return false;
    if (s.intent.account != AccountType::MARGIN &&
        s.intent.account != AccountType::CASH)
        return false;
    if (s.impact != Impact::NONE && s.impact != Impact::LOW &&
        s.impact != Impact::MEDIUM && s.impact != Impact::HIGH &&
        s.impact != Impact::BINARY)
        return false;
    if (s.phase != Phase::NONE && s.phase != Phase::PRE &&
        s.phase != Phase::BLACKOUT && s.phase != Phase::POST)
        return false;
    if (s.calib != CalibState::PASS && s.calib != CalibState::INSUFFICIENT &&
        s.calib != CalibState::BREACH)
        return false;
    if (s.kill != KillLevel::NONE && s.kill != KillLevel::SOFT &&
        s.kill != KillLevel::MEDIUM && s.kill != KillLevel::HARD)
        return false;
    return true;
}
bool StrEq(const char* a, const char* b) {
    if (!a || !b) return a == b;
    while (*a && *a == *b) {
        a++;
        b++;
    }
    return *a == *b;
}
// R2 exposure breach with / without pending (scaled caps, exact ints).
bool R2Breaches(const RiskSnapshot& s, int64_t S, bool include_pending,
                const char*& which) {
    __int128 filled = SumOpen(s);
    __int128 pend = include_pending ? SumPending(s) : 0;
    __int128 intent = s.intent.notional_cents;
    __int128 E = s.equity_cents;
    if (intent * S > E) {
        which = "r2-single";
        return true;
    }
    if ((filled + pend + intent) * S > (__int128)3 * E) {
        which = "r2-total";
        return true;
    }
    which = nullptr;
    return false;
}

}  // namespace

int64_t PendingNotional(const RiskSnapshot& s) { return SumPending(s); }
int64_t ReservedRisk(const RiskSnapshot& s) {
    __int128 p = SumPending(s);
    __int128 r = (p * s.risk_fraction_bp + 9999) / 10000;  // round UP
    return r > std::numeric_limits<int64_t>::max()
               ? std::numeric_limits<int64_t>::max()
               : (int64_t)r;
}
int64_t MarginRequirement(const RiskSnapshot& s) {
    __int128 t = (__int128)s.margin_used_cents;
    for (auto& p : s.pending) t += p.margin_cents;
    if (t > std::numeric_limits<int64_t>::max())
        return std::numeric_limits<int64_t>::max();
    if (t < std::numeric_limits<int64_t>::min())
        return std::numeric_limits<int64_t>::min();
    return (int64_t)t;
}
int64_t BuyingPower(const RiskSnapshot& s) {
    __int128 t = (__int128)s.equity_cents - s.margin_used_cents;
    for (auto& p : s.pending) t -= p.margin_cents;
    if (t > std::numeric_limits<int64_t>::max())
        return std::numeric_limits<int64_t>::max();
    if (t < std::numeric_limits<int64_t>::min())
        return std::numeric_limits<int64_t>::min();
    return (int64_t)t;
}

bool R13FloorTrips(double brier_delta, int64_t realized_outcomes) {
    if (!std::isfinite(brier_delta)) return true;  // unknown => trip
    return brier_delta > 0.02 && realized_outcomes >= kR13MinOutcomes;
}

bool R5Trips(int64_t equity_cents, int64_t peak_cents) {
    if (peak_cents <= 0) return true;  // unevaluable peak => halt
    __int128 drop = (__int128)peak_cents - equity_cents;
    return drop * 10 > (__int128)peak_cents;  // STRICTLY greater than 10%
}

int DriftSelection(const RiskSnapshot& s) {
    int best = -1;
    for (size_t i = 0; i < s.drift.size(); i++) {
        const DriftCandidate& c = s.drift[i];
        if (c.var_reduction_cents <= 0) continue;  // must reduce VaR
        if (best < 0) {
            best = (int)i;
            continue;
        }
        const DriftCandidate& b = s.drift[best];
        __int128 bd = b.unrealized_pnl_cents > kDriftEpsilonCents
                          ? b.unrealized_pnl_cents
                          : kDriftEpsilonCents;
        __int128 cd = c.unrealized_pnl_cents > kDriftEpsilonCents
                          ? c.unrealized_pnl_cents
                          : kDriftEpsilonCents;
        __int128 lhs = (__int128)c.var_reduction_cents * bd;
        __int128 rhs = (__int128)b.var_reduction_cents * cd;
        if (lhs > rhs) {
            best = (int)i;
        } else if (lhs == rhs) {
            if (c.opened_us < b.opened_us) best = (int)i;
            // Exact opened_us tie (incl. both zero): lexicographic symbol.
            else if (c.opened_us == b.opened_us && c.symbol < b.symbol)
                best = (int)i;
        }
    }
    return best;
}

bool EventBlackout(Impact impact, Phase phase) {
    if (impact == Impact::BINARY &&
        (phase == Phase::PRE || phase == Phase::BLACKOUT))
        return true;
    if (impact == Impact::HIGH &&
        (phase == Phase::BLACKOUT || phase == Phase::POST))
        return true;
    return false;
}
bool EventMediumActive(Impact impact, Phase phase) {
    return impact == Impact::MEDIUM && phase != Phase::NONE;
}

VetoVerdict EvaluateVeto(const RiskSnapshot& s) {
    VetoVerdict v;
    StageScale sc = ScaleFor(s.stage);
    v.stage_num = sc.mult_num;
    v.stage_den = sc.mult_den;
    v.size_scale = s.r6_trip ? 0.5 : 1.0;
    // Exits bypass everything (doc 10 §10.3): the veto gates new risk
    // only. EXACT match: any other (including corrupted) kind falls
    // through to enum validation below, which fails it closed.
    if (s.intent.kind == IntentKind::EXIT) {
        v.proceed = true;
        v.reason = "exit-bypass";
        return v;
    }
    // Collect EVERY armed condition in frozen precedence order; the first
    // one wins the logged reason, none are dropped from reasons_all.
    // Fixed array (fixed-storage contract): 23 arm sites < 32 slots, the
    // guard below is unreachable-by-construction defense in depth.
    const char* armed[VetoVerdict::kMaxArmed];
    int n_armed = 0;
    auto arm = [&](const char* code) {
        if (n_armed < VetoVerdict::kMaxArmed) armed[n_armed++] = code;
    };
    // bad-inputs: unevaluable snapshot cannot authorize risk. Invalid
    // enums join this code (never neutral, never a bypass).
    bool bad = !ValidEnums(s) || s.intent.kind != IntentKind::ENTRY ||
               (s.stage == Stage::UNKNOWN || s.equity_cents <= 0 ||
                s.daily_close_hwm_cents < 0 || s.intraday_hwm_cents < 0 ||
                s.intent.notional_cents < 0 || s.risk_fraction_bp < 0 ||
                s.day_count < 0 || s.hour_count < 0);
    int64_t peak =
        s.daily_close_hwm_cents > s.intraday_hwm_cents
            ? s.daily_close_hwm_cents
            : s.intraday_hwm_cents;
    if (peak <= 0) bad = true;
    // Corrupt sides in bookkeeping must not read as neutral (an invalid
    // side would otherwise be silently ignored by the == comparisons).
    if (!bad) {
        for (auto& p : s.open)
            if (p.notional_cents < 0 || !ValidSide(p.side)) {
                bad = true;
                break;
            }
        for (auto& p : s.pending)
            if (p.notional_cents < 0 || p.margin_cents < 0 ||
                !ValidSide(p.side)) {
                bad = true;
                break;
            }
    }
    if (bad) arm("bad-inputs");
    if (R5Trips(s.equity_cents, peak)) arm("r5-loss-cap");
    if (!s.intent.has_stop) arm("no-stop");
    {
        // Stage-aware cap (MaxLeverage): G1 FX 1x, G2 FX 2x / stock 1x,
        // G0/G3 §5.2. R2 usually binds first; this is the hard ceiling.
        int maxlev =
            MaxLeverage(s.stage, s.intent.asset, s.intent.account);
        if ((__int128)s.intent.notional_cents >
            (__int128)maxlev * s.equity_cents)
            arm("leverage-cap");
    }
    if (!s.session_open) arm("session-closed");
    if (s.intent.asset == AssetClass::STOCK && s.intent.side == Side::SHORT &&
        !s.short_ok)
        arm("short-block");
    if (s.corp_block) arm("corp-action-block");
    if (EventMediumActive(s.impact, s.phase))
        arm("event-medium");
    if (!s.r6_available) arm("r6-unavailable");
    if (!s.r7_available) arm("r7-unavailable");
    Caps caps = BuildCaps(sc);
    // R1 with pending-risk attribution (count + direction only; a pure
    // same-symbol collision is a collision, not an exposure breach).
    if (R1CountBreaches(s, caps.pos_cap, true)) {
        arm(R1CountBreaches(s, caps.pos_cap, false)
                            ? "r1-count"
                            : "pending-risk");
    }
    if (SymbolCollision(s, true)) arm("r1-symbol");
    if (R1DirBreaches(s, caps.dir_cap, true)) {
        arm(R1DirBreaches(s, caps.dir_cap, false) ? "r1-direction"
                                                              : "pending-risk");
    }
    {
        const char* which = nullptr;
        if (R2Breaches(s, caps.expo_scale, true, which)) {
            const char* bare = nullptr;
            R2Breaches(s, caps.expo_scale, false, bare);
            arm(bare ? which : "pending-risk");
        }
    }
    {
        int64_t day = s.day_count;
        if (s.day_number != s.now_us / kDayUs) day = 0;  // stale => reset
        // Overflow-free: day >= cap asks whether the NEXT trade exceeds
        // it (day + 1 > cap) without ever computing day + 1.
        if (day >= caps.day_cap) arm("r3-day");
        int64_t hour = s.hour_count;
        if (s.hour_bucket != s.now_us / kHourUs) hour = 0;
        if (hour >= caps.hour_cap) arm("r3-hour");
    }
    if (s.flip_armed) {
        bool locked = true;
        if (s.flip_t2_us < s.flip_t1_us || s.now_us < s.flip_t2_us)
            locked = true;  // corrupt history => assume locked (fail-closed)
        else if (s.flip_symbol != s.intent.symbol)
            locked = false;  // per-symbol lock
        else
            locked = (s.flip_t2_us - s.flip_t1_us <= kFlipWindowUs &&
                      s.now_us - s.flip_t2_us < kFlipLockUs);
        if (locked) arm("r4-flip-lock");
    }
    if (s.r7_entry_breach) arm("r7-correlation");
    // R7 drift: a found removal is a management directive, not a hold —
    // attach it and keep evaluating (later holds still fire). No removal
    // that reduces VaR => HOLD new entries + escalate.
    if (s.r7_drift_breach) {
        int idx = DriftSelection(s);
        if (idx < 0) {
            arm("r7-drift-no-removal");
            v.escalate = true;
        } else {
            v.drift_idx = idx;  // index, never a copied string
        }
    }
    if (s.disagreement) arm("disagreement");
    if (R13FloorTrips(s.brier_delta, s.realized_outcomes))
        arm("r13-calibration");
    if (s.entry_halt) arm("entry-halt");
    if (s.kill != KillLevel::NONE) {
        arm(s.kill == KillLevel::HARD    ? "kill-hard"
                        : s.kill == KillLevel::MEDIUM ? "kill-medium"
                                                     : "kill-soft");
    }
    for (int i = 0; i < n_armed; i++) v.reasons_all[i] = armed[i];
    v.n_reasons = n_armed;
    if (n_armed == 0) {
        v.proceed = true;
        v.reason = "proceed";
    } else {
        v.proceed = false;
        v.reason = armed[0];
    }
    return v;
}

EngineInputs BuildEngineInputs(const RiskSnapshot& s, const VetoVerdict& v) {
    EngineInputs in;
    in.disagreement = s.disagreement;
    in.event_blackout = EventBlackout(s.impact, s.phase);
    if (R13FloorTrips(s.brier_delta, s.realized_outcomes))
        in.calibration_gate = CalibrationGate::BREACH;
    else if (s.calib == CalibState::PASS)
        in.calibration_gate = CalibrationGate::PASS;
    else if (s.calib == CalibState::BREACH)
        in.calibration_gate = CalibrationGate::BREACH;
    else
        in.calibration_gate = CalibrationGate::INSUFFICIENT;
    in.r6_vol_trip = s.r6_trip;
    {
        const char* which = nullptr;
        Caps caps = BuildCaps(ScaleFor(s.stage));
        in.exposure_headroom_r2 =
            !R2Breaches(s, caps.expo_scale, true, which);
    }
    in.pending_risk_breach = StrEq(v.reason, "pending-risk");
    if (!v.proceed) {
        in.deterministic_veto = true;
        const char* r = v.reason ? v.reason : "";
        if (StrEq(r, "r5-loss-cap"))
            in.veto_reason = VetoReason::LOSS_CAP_R5;
        else if (StrEq(r, "session-closed"))
            in.veto_reason = VetoReason::SESSION_CLOSED;
        else if (StrEq(r, "short-block"))
            in.veto_reason = VetoReason::SHORT_BLOCK;
        else if (StrEq(r, "corp-action-block"))
            in.veto_reason = VetoReason::CORP_ACTION_BLOCK;
        else if (StrEq(r, "pending-risk"))
            in.veto_reason = VetoReason::PENDING_RISK;
        else if (StrEq(r, "r6-unavailable"))
            in.veto_reason = VetoReason::VOL_TRIP_R6;
        else
            in.veto_reason = VetoReason::OTHER_BREACH;
    }
    return in;
}

}  // namespace risk
}  // namespace jev
