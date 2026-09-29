// Execution router (doc 06 6.1, doc 04 4.2.5): a pure state machine that walks
// one authorized OrderIntent through journal -> protected send -> ack/query ->
// fill/partial/cancel/unknown, or the EXIT equivalents. RouteStep returns the
// next action; the caller performs the broker/journal operation and feeds the
// observation back. Same state + same observation -> same action (no clock,
// no allocation). Authorization and sizing belong to the risk path; scalars
// arrive validated and are only checked against the frozen vocabulary.
//
// Rules enforced here:
//   journal-before-order for normal entries, with the emergency-exit
//     exception (execute first, then buffer the row);
//   one intent, one stable identity (client ID computed once);
//   one send + one status query + one retry, reconciling by the same
//     identity after ambiguity; exhaustion -> UNKNOWN + symbol freeze;
//   ignored observations (foreign/untagged, intent mismatch, stale or
//     conflicting sequence) return the machine byte-identical;
//   entries forbidden under kill / stale feed / closed stage / frozen symbol,
//     exits never gated by them;
//   partials protect filled qty only; cancel-failed -> UNKNOWN_EXECUTION
//     (never "filled") + symbol freeze.
#pragma once
#include <cstddef>
#include <cstdint>

#include "../broker/adapter.hpp"
#include "../risk/veto.hpp"  // IntentKind + KillLevel (single authority)

namespace jev {
namespace exec {

// Upstream-authorized intent; the router drives lifecycle only.
struct OrderIntent {
    char intent_id[65];
    char symbol[16];
    broker::OrderSide side = broker::OrderSide::BUY;
    std::int64_t qty_shares = 0;  // verified > 0, never computed here
    std::int64_t stop_cents = 0;  // verified > 0 (doc 05 sec. 5.2)
    std::int64_t tp_cents = 0;    // verified > 0
    risk::IntentKind kind = risk::IntentKind::ENTRY;
    // Protection shape of the entry: bracket (stop + take-profit) or OTO
    // stop-only (tp_cents is then unused). Set from the exit profile.
    broker::Protection protection = broker::Protection::BRACKET;
    bool gtc = false;  // entry and stop good-till-cancelled
    // Risk-path scalars: scale is (1,1) or (1,2); stage mult is (1,1), (1,4)
    // or (1,2).
    int scale_num = 1;
    int scale_den = 1;
    int stage_num = 1;
    int stage_den = 1;
};

// Venue identity for the client-ID recipe (doc 06 6.1).
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
    EXIT_EMERGENCY = 10,  // journal failed on EXIT: executed first, then the
                          // same accounting/reconcile machinery
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
    bool cancel_confirmed = false;  // final broker-canceled observed (status
                                    // query or trade event, never a bare 204)
    bool cancel_accepted = false;  // cancel request accepted (204): keep
                                   // confirming, not terminal
    bool cancel_failed = false;  // explicit broker rejection; silence means
                                 // re-check, never UNKNOWN
    std::int64_t cancel_filled_qty = -1;  // authoritative final fill on
                                 // cancel_confirmed (-1 = absent: coverage
                                 // unproven, repair rather than trust machine qty)
    bool executed = false;  // exit order confirmed executed
    bool exit_responded = false;  // close attempt resolved (else wait)
    broker::CloseResult exit_ack;  // ambiguous exit reconciles by ID
    bool repair_ok = false;  // EstablishProtection attempt confirmed
    // Identity tag (P1-5): observations carry the client ID they report on.
    // An established machine accepts only matching tagged observations;
    // foreign and untagged ones are ignored. IDLE has no identity yet.
    char client_id[65]{};
    // Event identity, verbatim from the broker: the Alpaca stream event id
    // (ULID, 26 chars) or a 32-hex poll tag; bounded token [A-Za-z0-9_-], max
    // 32 chars, persisted verbatim. Ordering authority (doc 13 13.7) is
    // domain-separated:
    //   ULID vs ULID: venue stream order (timestamp, then full-string
    //     tiebreak). Older-after-newer is stale; exact redelivery collapses.
    //     This orders publication on the stream, not business-event times.
    //   non-ULID vs non-ULID: caller-seq rules (single-source poll ordering,
    //     not broker authority).
    //   cross-family and no-event REST snapshots never regress stream state:
    //     fills are monotonic, protection never unsets, terminals never
    //     un-terminal. A no-event REST snapshot may add fill knowledge but
    //     cannot originate a terminal transition (cancel/dead/absent) against
    //     ULID-established live state; it reconciles (re-query within budget,
    //     else freeze) until stream confirmation or S2/human resolution.
    char event_id[33]{};
    std::uint64_t event_seq = 0;
    risk::KillLevel kill = risk::KillLevel::NONE;
    bool feed_stale = false;     // feed stale > 30 s
    bool stage_entry_ok = false;  // verified stage permits entries
    bool symbol_frozen = false;   // caller-owned UNKNOWN freeze set
    // Crash seam (runner-owned): the journal already holds this intent's row
    // (snapshot lost before the first persist); skip the WRITE.
    bool intent_rowed = false;
};

struct RouteMachine {
    RouteState state = RouteState::IDLE;
    risk::IntentKind kind = risk::IntentKind::ENTRY;
    char client_id[65]{};
    char broker_id[64]{};  // broker UUID from the single query lookup
    // Original-intent binding (P0-4): every non-IDLE step verifies the
    // caller's intent matches (intent_id, symbol, side, kind); a mismatch is
    // ignored. Persisted with the machine.
    char intent_id[65]{};
    char symbol[16]{};
    broker::OrderSide side = broker::OrderSide::BUY;
    // Last applied event (sequence authority, persisted).
    char last_event_id[33]{};
    std::uint64_t last_event_seq = 0;
    // Exit sub-order counter (P0-2): after a definitive death (DEAD ack or
    // cancelled-found) the burned client ID is never resubmitted; recovery mints
    // a deterministic sub-identity (attempt N). A 404-absent re-issue keeps the
    // same id. Persisted.
    std::uint8_t exit_attempt = 0;
    // Cumulative exit accounting (P0-2): exit_closed = shares confirmed closed
    // under this intent (monotonic); exit_counted = amount already counted for
    // the current sub-order (reset on sub-ID rotation). Recovery order size =
    // intent.qty - exit_closed (RouteOut.exit_qty); flat iff exit_closed >=
    // intent.qty. Persisted, so a restart never re-closes closed shares.
    std::int64_t exit_closed_qty = 0;
    std::int64_t exit_counted_qty = 0;
    std::int64_t filled_qty = 0;
    bool emergency = false;
    bool protection_ok = false;  // positively confirmed; PROTECTED requires it
    std::uint8_t query_attempts = 0;  // retry-once budget (P0-1): 2 QUERY_ONCE
                                      // emissions max, then UNKNOWN + freeze;
                                      // persisted
};

// One send + one status query (doc 06): 1 initial + 1 retry, then
// UNKNOWN + freeze, never a resend.
inline constexpr int kQueryMaxAttempts = 2;

struct RouteOut {
    RouteAction action = RouteAction::NONE;
    RouteMachine next;
    // EXECUTE_EXIT / EXECUTE_EMERGENCY carry the exact order size
    // (intent.qty - exit_closed_qty); the caller submits MarketClose with this
    // qty and next.client_id, never a recomputed size.
    std::int64_t exit_qty = 0;
    bool freeze_symbol = false;  // caller adds symbol to its freeze set
    const char* journal_kind = "intent";  // row for WRITE_*/JOURNAL_* actions
    const char* reason = "none";          // frozen code
};

RouteOut RouteStep(const RouteMachine& m, const OrderIntent& intent,
                   const VenueCtx& venue, const RouteObs& obs);

// Restart seam: the caller persists the machine after every step (fixed
// "H1:<...>" record into a caller buffer) and restores it after death.
// RestoreMachine validates strictly (unknown tags, out-of-range enums,
// overlong fields, trailing garbage) and returns false with *out untouched.
// A restored SENT_UNACKED/QUERY_SENT machine reconciles via query before any
// new send.
// REST observation tie-break (doc 13 13.7): the Alpaca REST lookup returns
// state snapshots with no usable per-event sequence, so the rule is receipt
// order over identity-matched observations; the same tagged observation
// twice cannot fork the machine. Broker sequence numbers are reserved for a
// streaming class.
bool SnapshotMachine(const RouteMachine& m, char* out,
                     std::size_t n);
bool RestoreMachine(const char* s, RouteMachine* out);

}  // namespace exec
}  // namespace jev
