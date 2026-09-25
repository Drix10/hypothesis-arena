// H1 — execution router (doc 06 sec. 6.1, doc 04 sec. 4.2.5).
//
// Lifecycle mechanics ONLY. The risk path owns authorization and all
// size computation (veto verdict + scalars arrive validated; the router
// verifies them against frozen vocabulary and never computes them).
// The router consumes one authorized OrderIntent and walks it through
// journal -> protected send -> ack/query -> fill/partial/cancel/unknown,
// or the EXIT equivalents, as a pure state machine: RouteStep returns
// the NEXT action, the caller performs the broker/journal operation and
// feeds the observation back. Same state + same observation -> same
// action (deterministic, no clock reads, no allocation on this path).
//
// Frozen rules enforced here (mechanically, from inputs owned upstream):
//   journal-before-order for NORMAL entries (no row = no send, no
//     exceptions) + the frozen emergency-exit exception (execute first,
//     then buffer the row — a delayed exit beats a delayed row);
//   one intent one stable identity (client ID computed once, reused);
//   one send attempt + one status query + one retry (retry-once);
//     after ambiguity, reconcile-first via broker query with the SAME
//     identity (a missing ack never mints a fresh entry on its own);
//     exhaustion fails closed to UNKNOWN + symbol freeze;
//   ignored observations (foreign/untagged tag, intent mismatch,
//     stale/conflicting sequence) return the machine byte-identical
//     (callers may assign next unconditionally);
//   entries forbidden under kill / stale feed / closed stage / frozen
//     symbol; exits never gated by kill, feed, or stage;
//   partials protect filled qty only; cancel-failed means
//     UNKNOWN_EXECUTION (never "filled") + symbol freeze.
#pragma once
#include <cstddef>
#include <cstdint>

#include "../broker/adapter.hpp"
#include "../risk/veto.hpp"  // IntentKind + KillLevel (single authority)

namespace jev {
namespace exec {

// Upstream-authorized intent. Qty and scalars arrive computed; the
// router verifies shape/vocabulary and drives lifecycle only.
struct OrderIntent {
    char intent_id[65];
    char symbol[16];
    broker::OrderSide side = broker::OrderSide::BUY;
    std::int64_t qty_shares = 0;  // verified > 0, never computed here
    std::int64_t stop_cents = 0;  // verified > 0 (doc 05 sec. 5.2)
    std::int64_t tp_cents = 0;    // verified > 0
    risk::IntentKind kind = risk::IntentKind::ENTRY;
    // Risk-path scalars, verified against frozen vocabulary only:
    // scale is (1,1) or (1,2); stage mult is (1,1), (1,4) or (1,2).
    int scale_num = 1;
    int scale_den = 1;
    int stage_num = 1;
    int stage_den = 1;
};

// Venue identity for the frozen ID recipe (doc 06 sec. 6.1).
struct VenueCtx {
    char broker[32];          // e.g. "alpaca-paper"
    char account[32];         // paper account namespace
    char context_hash[65];    // frozen Snapshot context_hash hex
};

enum class RouteState : std::uint8_t {
    IDLE = 0,
    JOURNAL_PENDING = 1,  // row must land before anything else
    SENT_UNACKED = 2,
    QUERY_SENT = 3,       // the one status query is in flight
    PROTECTED = 4,        // terminal success (position under protection)
    PARTIAL_AWAIT = 5,    // partial journaled; remainder must cancel
    CANCEL_SENT = 6,
    CANCELLED = 7,        // terminal: nothing filled, order dead
    UNKNOWN_FROZEN = 8,   // terminal: cancel failed; symbol must freeze
    EXIT_SENT = 9,        // normal exit order in flight
    EXIT_EMERGENCY = 10,  // journal failed on EXIT: executed first,
                          // then the SAME exit accounting/reconcile
                          // machinery (terminal buffers the row)
    CLOSED = 11,          // terminal (exits; emergency flag records path)
    REPAIR_SENT = 12      // protection repair in flight (recovery-only)
};

enum class RouteAction : std::uint8_t {
    NONE = 0,
    WRITE_JOURNAL = 1,    // caller writes journal_kind row, feeds journal_ok
    SEND_PROTECTED = 2,   // caller submits ProtectedOrder via adapter
    QUERY_ONCE = 3,       // caller performs the single status query
    JOURNAL_FILL = 4,
    JOURNAL_PARTIAL = 5,
    CANCEL_REMAINDER = 6,
    CONFIRM_CANCELLED = 7,  // caller confirms, feeds cancel_confirmed
    JOURNAL_CANCEL = 8,
    JOURNAL_UNKNOWN = 9,  // + freeze_symbol output (never "filled")
    EXECUTE_EXIT = 10,    // normal exit (journal already landed)
    EXECUTE_EMERGENCY = 11,  // journal failed on EXIT: act now
    BUFFER_EMERGENCY = 12,   // caller buffers the row durably, then appends
    JOURNAL_EXIT = 13,
    REJECT = 14,  // HOLD with frozen reason; terminal for this intent
    ESTABLISH_PROTECTION = 15,  // recovery-only repair (never normal)
    FLATTEN_NOW = 16,           // repair failed: flatten immediately
    JOURNAL_REPAIR = 17         // repair confirmed -> PROTECTED
};

// Caller-performed observations since the last step.
struct RouteObs {
    bool journal_ok = false;
    bool adapter_responded = false;
    broker::OrderAck ack;
    bool query_due = false;  // caller: send resolved, one query now due
    broker::OrderQuery query;
    bool cancel_confirmed = false;  // FINAL broker-canceled observed
                                    // (status query/trade event —
                                    // never a bare 204)
    bool cancel_accepted = false;  // cancel REQUEST accepted (204):
                                   // stay confirming, never terminal
    bool cancel_failed = false;  // explicit broker cancel rejection;
                                 // silence (none of the three) means
                                 // re-check, never UNKNOWN
    std::int64_t cancel_filled_qty = -1;  // authoritative final fill
                                 // on cancel_confirmed (-1 = absent:
                                 // coverage unproven -> repair, never
                                 // assume the stale machine qty)
    bool executed = false;  // exit order confirmed executed
    bool exit_responded = false;  // close attempt resolved (else wait)
    broker::CloseResult exit_ack;  // ambiguous exit reconciles by ID
    bool repair_ok = false;  // EstablishProtection attempt confirmed
    // Identity tag (P1-5): observations carry the client ID they
    // report on. A machine with an established identity accepts ONLY
    // matching tagged observations; foreign AND untagged observations
    // are ignored (fail closed — an established machine never acts
    // on an event it cannot attribute). IDLE has no identity yet.
    char client_id[65]{};
    // Event identity (verbatim broker identity, never transformed):
    // the Alpaca streaming event id (ULID, 26 chars) passes through
    // unchanged; 32-hex poll tags are also accepted. Bounded token
    // [A-Za-z0-9_-], max 32 chars, snapshot-persisted verbatim.
    // Ordering authority (doc 13 sec. 13.7) is DOMAIN-SEPARATED:
    //   ULID-vs-ULID: broker-time compare (timestamp, then full
    //     string). Older-after-newer is stale even when it arrived
    //     later; exact redelivery collapses.
    //   non-ULID-vs-non-ULID: caller-seq rules (single-source poll
    //     ordering only — explicitly NOT broker authority).
    //   cross-family / no-event REST snapshots: NEVER regress
    //     broker-stream state. REST is reconciliation, not a
    //     competing sequence: fills are monotonic (a snapshot below
    //     the established floor is stale), protection never unsets,
    //     terminals never un-terminal. Lifecycle authority: a
    //     no-event REST snapshot may add monotonic fill knowledge
    //     but can NEVER originate a terminal transition
    //     (cancel/dead/absent-terminal) against ULID-established
    //     live stream state — such an observation reconciles
    //     (re-query within budget, else freeze) until stream
    //     confirmation or S2/human resolution. No fake cross-family
    //     comparison is ever invented.
    char event_id[33]{};
    std::uint64_t event_seq = 0;
    risk::KillLevel kill = risk::KillLevel::NONE;
    bool feed_stale = false;     // feed stale > 30 s (Slice F flag)
    bool stage_entry_ok = false;  // verified stage permits entries
    bool symbol_frozen = false;   // caller-owned UNKNOWN freeze set
};

struct RouteMachine {
    RouteState state = RouteState::IDLE;
    risk::IntentKind kind = risk::IntentKind::ENTRY;
    char client_id[65]{};
    char broker_id[64]{};  // broker UUID from the single query lookup
                         // (cancel path uses this, never a re-query)
    // Original-intent binding (P0-4): every non-IDLE step verifies
    // the caller's intent matches what established the machine
    // (intent_id + symbol + side + kind). Mismatch -> step ignored
    // (never silent operation on another intent). Persisted across
    // restart with the rest of the machine.
    char intent_id[65]{};
    char symbol[16]{};
    broker::OrderSide side = broker::OrderSide::BUY;
    // Last applied event (sequence authority, persisted).
    char last_event_id[33]{};
    std::uint64_t last_event_seq = 0;
    // Exit sub-order counter (P0-2): after a DEFINITIVE death
    // (DEAD ack / cancelled-found), the burned client ID is never
    // resubmitted — recovery mints a deterministic sub-identity
    // (attempt N) attributable to the original bound intent.
    // 404-absent re-issues keep the SAME id (nothing exists to
    // collide with). Persisted across restart: no double-mint.
    std::uint8_t exit_attempt = 0;
    // Cumulative exit accounting (P0-2 partial-DEAD): exit_closed =
    // total shares confirmed closed under this intent (monotonic,
    // never regresses); exit_counted = amount already counted for
    // the CURRENT sub-order (reset on every sub-ID rotation).
    // Recovery order size = intent.qty - exit_closed (carried on
    // RouteOut.exit_qty); flat ⟺ exit_closed >= intent.qty.
    // Persisted: restart never re-closes closed shares (overshoot
    // is impossible by construction).
    std::int64_t exit_closed_qty = 0;
    std::int64_t exit_counted_qty = 0;
    std::int64_t filled_qty = 0;
    bool emergency = false;
    bool protection_ok = false;  // positively confirmed protection;
                                 // PROTECTED requires this (P0 rule)
    std::uint8_t query_attempts = 0;  // retry-once budget (P0-1):
                                      // 2 QUERY_ONCE emissions max
                                      // (1 initial + 1 retry), then
                                      // UNKNOWN+freeze; persisted
                                      // across restart
};

inline constexpr int kQueryMaxAttempts = 2;  // frozen one-query /
                                             // retry-once (doc 06:
                                             // one send + one status
                                             // query): 1 initial + 1
                                             // retry, then UNKNOWN+freeze
                                             // (never a resend)

struct RouteOut {
    RouteAction action = RouteAction::NONE;
    RouteMachine next;
    // EXECUTE_EXIT / EXECUTE_EMERGENCY carry the exact order size
    // here (intent.qty - exit_closed_qty): the caller submits
    // MarketClose with THIS qty and next.client_id, never a
    // recomputed size (recovery orders target the remainder only).
    std::int64_t exit_qty = 0;
    bool freeze_symbol = false;  // caller adds symbol to its freeze set
    const char* journal_kind = "intent";  // row the caller writes on
                                          // WRITE_*/JOURNAL_* actions
    const char* reason = "none";          // frozen code
};

RouteOut RouteStep(const RouteMachine& m, const OrderIntent& intent,
                   const VenueCtx& venue, const RouteObs& obs);

// Restart seam (caller-owned persistence): the caller persists the machine after
// every step (fixed "H1:<...>" record into a caller buffer) and
// restores it after death. RestoreMachine validates strictly:
// unknown tags, out-of-range enums, overlong fields, or trailing
// garbage -> false with *out untouched (fail closed). A restored
// SENT_UNACKED/QUERY_SENT machine reconciles via query before any new
// send (RouteStep has no send from non-IDLE states).
// Frozen tie-break (doc 13 sec. 13.7, REST observation class): the
// Alpaca REST lookup path returns state snapshots, not an event
// stream — the venue supplies no usable per-event sequence metadata
// on this path. The frozen deterministic rule is therefore receipt
// order over identity-matched observations (foreign/untagged events
// never apply, duplicates are idempotent by construction: same
// tagged observation twice cannot fork the machine). Broker sequence
// numbers are reserved for a future streaming class, never invented
// here.
bool SnapshotMachine(const RouteMachine& m, char* out,
                     std::size_t n);
bool RestoreMachine(const char* s, RouteMachine* out);

}  // namespace exec
}  // namespace jev
