// P3.5 Slice D — kill switch (doc 10 sec. 10.3, R16).
//
// Two explicit paths (packet v2 sec. 2A):
//   evaluation/predicate path: pure deterministic C++, no network, no
//     LLM, no research plane, no features.jsonl, no clock reads. The
//     owning modules produce trigger booleans; this file only combines
//     them with frozen precedence. Same inputs -> same level.
//   actuation path: MAY invoke the frozen broker adapter (H1-owned) for
//     protection verification / re-establish / flatten-cancel /
//     confirmation, plus the journal-append interface. Until H1 exists,
//     Slice D tests drive the machines directly (stub-sink contract).
// Network is NEVER required to decide that a kill level is active.
//
// File I/O is the caller's job (same rule as Slice E): persistence is
// string-in/string-out through a caller-owned buffer. No allocation on
// the evaluation path (grep-gated in build.sh, runtime-proven by
// test_noalloc_kill); Serialize uses only a caller buffer + snprintf.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>

#include "../risk/veto.hpp"

namespace jev {
namespace kill {

// Frozen trigger bundle. Each field is produced by its owning module
// (spend governor, feed, JEV streak counter, calibration, journal
// verifier, reconciler, broker adapter, determinism monitor,
// sandbox supervisor, operator HALT file watch). Kill evaluation reads
// these booleans/levels only — never raw feeds, answers, or features.
struct KillInputs {
    bool halt_file = false;
    bool jev_streak_s5 = false;
    bool feed_stale_gt30s = false;
    int spend_tier = 0;  // 0..3; out-of-range clamps (never a level)
    bool research_paused_past_ttl = false;
    bool drawdown_r5 = false;
    bool daily_loss_breach = false;
    bool rule_violation = false;
    bool calib_breach = false;
    bool journal_chain_break = false;
    bool drift_unresolvable = false;
    bool broker_auth_fail = false;
    bool determinism_fail = false;
    bool sandbox_compromise = false;
};

struct LevelResult {
    risk::KillLevel level = risk::KillLevel::NONE;
    const char* reason = "none";  // frozen code, static storage
};

// Frozen precedence: HARD > MEDIUM > SOFT. First armed tier wins the
// logged reason; behavior is identical either way (every road out of
// here except NONE stops entries).
LevelResult EvaluateLevel(const KillInputs& in);

// Entry gate with deliberate resume friction (doc 06 sec. 6.4): a
// removed HALT file alone never resumes. Entries are allowed only at
// level NONE, with no HALT file present, AND a deliberate restart flag
// (the operator restarts with the flag; normal deployment starts carry
// it). Any kill level, any present HALT file, or a flagless (re)start
// after a kill state -> false.
bool EntriesAllowed(risk::KillLevel level, bool halt_present,
                    bool restarted_with_flag);

// MEDIUM flatten FSM (frozen doc 10 sec. 10.3). Exactly one state is
// persisted per cycle; restart reloads it and reconciles with the
// broker BEFORE acting (never re-sends the dead process's sends).
enum class FlattenState : std::uint8_t {
    MEDIUM_ACTIVE = 0,   // entries stopped, flatten not yet achieved
    FLATTEN_PENDING = 1,  // flatten ordered, awaiting broker ack
    FLATTENED = 2,        // broker confirms flat
    PROTECTION_ONLY = 3   // flatten never possible; stops/TP own risk
};

enum class Closer : std::uint8_t {
    NONE = 0,
    SWITCH_FLATTEN = 1,  // this machine's flatten closed the position
    STOP_TP = 2          // hard stop/TP closed it first (true closer)
};

struct FlattenStep {
    bool conditions_allow = false;     // venue open + normal spread +
                                       // no in-flight flatten
    bool broker_confirms_flat = false;
    bool closed_externally = false;    // stop/TP closed the position
    bool venue_closed_terminal = false;  // no flatten possible anymore
    // Broker-confirmed terminal failure of the outstanding flatten
    // attempt (rejected / cancelled / definitively not in flight)
    // with the position still open. The ONLY input that permits a
    // re-attempt from FLATTEN_PENDING: one new issuance per observed
    // terminal failure (the caller clears it once the fresh order is
    // in flight, so issuance is deterministic and bounded — never a
    // per-cycle retry loop). False means in-flight-or-unknown.
    bool prior_attempt_failed = false;
};

struct FlattenOut {
    FlattenState state = FlattenState::MEDIUM_ACTIVE;
    bool issue_flatten = false;  // exactly one issuance per observed
                                 // order state: entry into PENDING from
                                 // ACTIVE, or one re-attempt per observed
                                 // terminal failure while PENDING. Never
                                 // a per-cycle re-issue.
    Closer closer = Closer::NONE;
    const char* reason = "none";
};

FlattenOut StepFlatten(FlattenState s, const FlattenStep& in);

// HARD ordered sequence (frozen sec. 10.3). The machine returns the
// NEXT action; the caller performs the broker/journal operation and
// feeds the observation back. Phase order is the safety property:
// nothing revokes credentials before protection is verified+confirmed.
enum class HardPhase : std::uint8_t {
    IDLE = 0,
    VERIFY_PROTECTION = 1,
    REESTABLISH = 2,
    ATTEMPT_FLATTEN = 3,
    CONFIRM_PROTECTION = 4,
    REVOKE_AND_EXIT = 5,
    DONE = 6
};

enum class HardAction : std::uint8_t {
    NONE = 0,
    QUERY_PROTECTION = 1,
    ESTABLISH_PROTECTION = 2,
    SEND_FLATTEN_CANCEL = 3,
    CONFIRM_ACTIVE = 4,
    REVOKE_CREDENTIALS = 5,
    EXIT_NONZERO = 6
};

struct HardStep {
    bool protection_present = false;
    bool reestablished = false;  // recorded, never gates progress:
                                 // an impossible re-establish must not
                                 // stall the sequence (flatten is still
                                 // attempted; protection stays missing
                                 // and visible)
    bool flatten_acked = false;  // recorded, same non-gating rule
    bool protection_confirmed = false;
};

struct HardOut {
    HardPhase phase = HardPhase::IDLE;
    HardAction action = HardAction::NONE;
    const char* reason = "none";
};

HardOut StepHard(HardPhase p, const HardStep& in);

// Durable state (exactly one record per cycle; caller owns the file).
struct Persisted {
    FlattenState flatten = FlattenState::MEDIUM_ACTIVE;
    Closer closer = Closer::NONE;
    HardPhase hard = HardPhase::IDLE;
};

// Fixed format "D1:<flatten>:<closer>:<hard>" (single digits). Returns
// false (buffer untouched) when out is null or n is too small.
bool SerializeKill(const Persisted& p, char* out, std::size_t n);
// Strict parse: exact shape, single digits, in-range values, NUL
// terminated within the buffer. Anything else -> false, *p untouched.
bool ParseKill(const char* s, Persisted* p);

}  // namespace kill
}  // namespace jev
