// P3.5 Slice D — kill switch implementation. Evaluation is pure
// predicate combination (no I/O, no clock, no allocation); actuation
// machines return next-actions for the caller to perform. See header
// for the evaluation/actuation boundary.
#include "switch.hpp"

namespace jev {
namespace kill {

LevelResult EvaluateLevel(const KillInputs& in) {
    // HARD tier (doc 10 sec. 10.3): integrity and resolvability
    // failures. Each returns its frozen reason; order within the tier
    // is documentation only (tier precedence is what matters).
    if (in.journal_chain_break)
        return {risk::KillLevel::HARD, "kill:journal-chain-break"};
    if (in.drift_unresolvable)
        return {risk::KillLevel::HARD, "kill:drift-unresolvable"};
    if (in.broker_auth_fail)
        return {risk::KillLevel::HARD, "kill:broker-auth-fail"};
    if (in.determinism_fail)
        return {risk::KillLevel::HARD, "kill:determinism-fail"};
    if (in.sandbox_compromise)
        return {risk::KillLevel::HARD, "kill:sandbox-compromise"};
    // MEDIUM tier: risk-limit and calibration breaches. Stage demotion
    // is immediate on entry (actuation side); evaluation only names it.
    if (in.drawdown_r5)
        return {risk::KillLevel::MEDIUM, "kill:drawdown-r5"};
    if (in.daily_loss_breach)
        return {risk::KillLevel::MEDIUM, "kill:daily-loss"};
    if (in.rule_violation)
        return {risk::KillLevel::MEDIUM, "kill:rule-violation"};
    if (in.calib_breach)
        return {risk::KillLevel::MEDIUM, "kill:calib-breach"};
    if (in.spend_tier == 3)
        return {risk::KillLevel::MEDIUM, "kill:spend-tier-3"};
    // SOFT tier: entries stop within 1 cycle, management continues.
    // spend tiers 0-1 never kill (trim only); out-of-range tier values
    // clamp to no-kill rather than escalating.
    if (in.halt_file) return {risk::KillLevel::SOFT, "kill:halt-file"};
    if (in.jev_streak_s5)
        return {risk::KillLevel::SOFT, "kill:jev-streak-s5"};
    if (in.feed_stale_gt30s)
        return {risk::KillLevel::SOFT, "kill:feed-stale"};
    if (in.spend_tier == 2)
        return {risk::KillLevel::SOFT, "kill:spend-tier-2"};
    if (in.research_paused_past_ttl)
        return {risk::KillLevel::SOFT, "kill:research-paused"};
    return {risk::KillLevel::NONE, "none"};
}

bool EntriesAllowed(risk::KillLevel level, bool halt_present,
                    bool restarted_with_flag) {
    if (level != risk::KillLevel::NONE) return false;
    if (halt_present) return false;
    if (!restarted_with_flag) return false;
    return true;
}

FlattenOut StepFlatten(FlattenState s, const FlattenStep& in) {
    switch (s) {
        case FlattenState::MEDIUM_ACTIVE: {
            // An externally closed position is recorded with its true
            // closer (never "flattened by the switch").
            if (in.closed_externally)
                return {FlattenState::FLATTENED, false, Closer::STOP_TP,
                        "flatten:stop-tp-closed"};
            // Terminal venue close with the position still open: no
            // flatten will ever be possible; stops/TP own the risk.
            if (in.venue_closed_terminal)
                return {FlattenState::PROTECTION_ONLY, false,
                        Closer::NONE, "flatten:protection-only"};
            if (in.conditions_allow)
                return {FlattenState::FLATTEN_PENDING, true,
                        Closer::NONE, "flatten:ordered"};
            return {FlattenState::MEDIUM_ACTIVE, false, Closer::NONE,
                    "flatten:waiting-conditions"};
        }
        case FlattenState::FLATTEN_PENDING: {
            if (in.closed_externally)
                return {FlattenState::FLATTENED, false, Closer::STOP_TP,
                        "flatten:stop-tp-closed"};
            if (in.broker_confirms_flat)
                return {FlattenState::FLATTENED, false,
                        Closer::SWITCH_FLATTEN, "flatten:flattened"};
            // Staying in PENDING never re-issues: the single issuance
            // happened on entry. The caller re-queries; a fresh order
            // requires an explicit operator-level reset, not a cycle
            // tick (no blind re-send loops, frozen).
            return {FlattenState::FLATTEN_PENDING, false, Closer::NONE,
                    "flatten:awaiting-ack"};
        }
        case FlattenState::FLATTENED:
            return {FlattenState::FLATTENED, false, Closer::SWITCH_FLATTEN,
                    "flatten:terminal"};
        case FlattenState::PROTECTION_ONLY:
            return {FlattenState::PROTECTION_ONLY, false, Closer::NONE,
                    "flatten:terminal"};
    }
    // Unreachable (all enumerators covered); fail stationary, silent.
    return {FlattenState::MEDIUM_ACTIVE, false, Closer::NONE,
            "flatten:waiting-conditions"};
}

HardOut StepHard(HardPhase p, const HardStep& in) {
    switch (p) {
        case HardPhase::IDLE:
            return {HardPhase::VERIFY_PROTECTION,
                    HardAction::QUERY_PROTECTION, "hard:verify"};
        case HardPhase::VERIFY_PROTECTION:
            if (in.protection_present)
                return {HardPhase::ATTEMPT_FLATTEN,
                        HardAction::SEND_FLATTEN_CANCEL, "hard:protected"};
            return {HardPhase::REESTABLISH,
                    HardAction::ESTABLISH_PROTECTION, "hard:missing"};
        case HardPhase::REESTABLISH:
            // Non-gating: an impossible re-establish is recorded by the
            // caller and stays visible; the sequence still attempts the
            // flatten rather than stalling with risk unmanaged.
            return {HardPhase::ATTEMPT_FLATTEN,
                    HardAction::SEND_FLATTEN_CANCEL, "hard:flatten"};
        case HardPhase::ATTEMPT_FLATTEN:
            return {HardPhase::CONFIRM_PROTECTION,
                    HardAction::CONFIRM_ACTIVE, "hard:confirm"};
        case HardPhase::CONFIRM_PROTECTION:
            if (in.protection_confirmed)
                return {HardPhase::REVOKE_AND_EXIT,
                        HardAction::REVOKE_CREDENTIALS, "hard:revoke"};
            // Unconfirmed protection NEVER advances to revocation on
            // its own: re-query (idempotent) and let the caller bound
            // the attempts. Revocation without verification is the
            // catastrophic ordering (frozen sec. 10.3).
            return {HardPhase::CONFIRM_PROTECTION,
                    HardAction::CONFIRM_ACTIVE, "hard:unconfirmed"};
        case HardPhase::REVOKE_AND_EXIT:
            return {HardPhase::DONE, HardAction::EXIT_NONZERO,
                    "hard:exit"};
        case HardPhase::DONE:
            return {HardPhase::DONE, HardAction::NONE, "hard:terminal"};
    }
    return {HardPhase::IDLE, HardAction::NONE, "hard:verify"};
}

bool SerializeKill(const Persisted& p, char* out, std::size_t n) {
    if (out == nullptr || n < 9) return false;
    int f = static_cast<int>(p.flatten);
    int c = static_cast<int>(p.closer);
    int h = static_cast<int>(p.hard);
    if (f < 0 || f > 3 || c < 0 || c > 2 || h < 0 || h > 6) return false;
    int w = std::snprintf(out, n, "D1:%d:%d:%d", f, c, h);
    return w == 8;
}

bool ParseKill(const char* s, Persisted* p) {
    if (s == nullptr || p == nullptr) return false;
    // Exact shape "D1:d:d:d" + NUL: 8 chars, no more, no less
    // (colons at 2/4/6, digits at 3/5/7, NUL at 8).
    for (int i = 0; i < 8; ++i) {
        char ch = s[i];
        if (ch == '\0') return false;  // short
        if (i == 0 && ch != 'D') return false;
        if (i == 1 && ch != '1') return false;
        if ((i == 2 || i == 4 || i == 6) && ch != ':') return false;
        if (i == 3 && (ch < '0' || ch > '3')) return false;
        if (i == 5 && (ch < '0' || ch > '2')) return false;
        if (i == 7 && (ch < '0' || ch > '6')) return false;
    }
    if (s[8] != '\0') return false;  // long / trailing garbage
    Persisted q;
    q.flatten = static_cast<FlattenState>(s[3] - '0');
    q.closer = static_cast<Closer>(s[5] - '0');
    q.hard = static_cast<HardPhase>(s[7] - '0');
    *p = q;
    return true;
}

}  // namespace kill
}  // namespace jev
