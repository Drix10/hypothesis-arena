// Kill switch (doc 10 10.3, R16). Two paths:
//   evaluation: pure deterministic C++ (no network, LLM, research plane,
//     features.jsonl or clock). Owning modules produce trigger booleans; this
//     file combines them with fixed precedence. Same inputs -> same level.
//     Network is never needed to decide that a level is active.
//   actuation: may invoke the H1-owned broker adapter (protection
//     verification, re-establish, flatten/cancel, confirmation) and the
//     journal-append interface; Slice D tests drive the machines directly.
//
// File I/O is the caller's job: persistence is string-in/string-out through a
// caller-owned buffer. No allocation on the evaluation path (grep-gated in
// build.sh, runtime-proven by test_noalloc_kill); Serialize uses only a
// caller buffer + snprintf.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>

#include "../risk/veto.hpp"

namespace jev {
namespace kill {

// Trigger bundle. Each field is produced by its owning module (spend
// governor, feed, JEV streak counter, calibration, journal verifier,
// reconciler, broker adapter, determinism monitor, sandbox supervisor,
// operator HALT file watch). Kill evaluation reads these only.
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

// Precedence: HARD > MEDIUM > SOFT. The first armed tier wins the logged
// reason; every road out except NONE stops entries.
LevelResult EvaluateLevel(const KillInputs& in);

// Entry gate with resume friction (doc 06 6.4): a removed HALT file alone
// never resumes. Entries are allowed only at level NONE, with no HALT file,
// and a deliberate restart flag. Any kill level, present HALT file, or
// flagless (re)start after a kill state -> false.
bool EntriesAllowed(risk::KillLevel level, bool halt_present,
                    bool restarted_with_flag);

// MEDIUM flatten FSM (doc 10 10.3). One state is persisted per cycle; restart
// reloads it and reconciles with the broker before acting.
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
    bool conditions_allow = false;     // venue open + normal spread + no
                                       // in-flight flatten
    bool broker_confirms_flat = false;
    bool closed_externally = false;    // stop/TP closed the position
    bool venue_closed_terminal = false;  // no flatten possible anymore
    // Broker-confirmed terminal failure of the outstanding flatten attempt
    // (rejected / cancelled / not in flight) with the position still open.
    // The only input that permits a re-attempt from FLATTEN_PENDING: one new
    // issuance per observed failure (the caller clears it once the fresh order
    // is in flight), never a per-cycle retry. False = in-flight or unknown.
    bool prior_attempt_failed = false;
};

struct FlattenOut {
    FlattenState state = FlattenState::MEDIUM_ACTIVE;
    bool issue_flatten = false;  // one issuance per observed order state: entry
                                 // into PENDING from ACTIVE, or one re-attempt
                                 // per observed terminal failure while PENDING
    Closer closer = Closer::NONE;
    const char* reason = "none";
};

FlattenOut StepFlatten(FlattenState s, const FlattenStep& in);

// HARD ordered sequence (doc 10 10.3). The machine returns the next action;
// the caller performs the broker/journal operation and feeds the observation
// back. Phase order is the safety property: nothing revokes credentials
// before protection is verified and confirmed.
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
    bool reestablished = false;  // recorded, never gates progress: an
                                 // impossible re-establish must not stall the
                                 // sequence (flatten is still attempted)
    bool flatten_acked = false;  // recorded, same non-gating rule
    bool protection_confirmed = false;
};

struct HardOut {
    HardPhase phase = HardPhase::IDLE;
    HardAction action = HardAction::NONE;
    const char* reason = "none";
};

HardOut StepHard(HardPhase p, const HardStep& in);

// Durable state: one record per cycle; the caller owns the file.
struct Persisted {
    FlattenState flatten = FlattenState::MEDIUM_ACTIVE;
    Closer closer = Closer::NONE;
    HardPhase hard = HardPhase::IDLE;
};

// Fixed format "D1:<flatten>:<closer>:<hard>" (single digits). Returns
// false (buffer untouched) when out is null or n is too small.
bool SerializeKill(const Persisted& p, char* out, std::size_t n);
// Strict parse: exact shape, single digits, in-range values, NUL-terminated
// within the buffer. Anything else -> false, *p untouched.
bool ParseKill(const char* s, Persisted* p);

}  // namespace kill
}  // namespace jev
