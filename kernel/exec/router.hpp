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
//   one send attempt + one query; after ambiguity, reconcile-first via
//     broker query with the SAME identity (a missing ack never mints a
//     fresh entry on its own);
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
    EXIT_EMERGENCY = 10,  // journal failed on EXIT: executed first
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
    bool cancel_confirmed = false;
    bool cancel_failed = false;  // explicit broker cancel rejection;
                                 // silence (neither flag) means re-check,
                                 // never UNKNOWN
    bool executed = false;  // exit order confirmed executed
    bool repair_ok = false;  // EstablishProtection attempt confirmed
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
    std::int64_t filled_qty = 0;
    bool emergency = false;
    bool protection_ok = false;  // positively confirmed protection;
                                 // PROTECTED requires this (P0 rule)
};

struct RouteOut {
    RouteAction action = RouteAction::NONE;
    RouteMachine next;
    bool freeze_symbol = false;  // caller adds symbol to its freeze set
    const char* journal_kind = "intent";  // row the caller writes on
                                          // WRITE_*/JOURNAL_* actions
    const char* reason = "none";          // frozen code
};

RouteOut RouteStep(const RouteMachine& m, const OrderIntent& intent,
                   const VenueCtx& venue, const RouteObs& obs);

// Durable restart seam (P1-1): the caller persists the machine after
// every step (fixed "H1:<...>" record into a caller buffer) and
// restores it after death. RestoreMachine validates strictly:
// unknown tags, out-of-range enums, overlong fields, or trailing
// garbage -> false with *out untouched (fail closed). A restored
// SENT_UNACKED/QUERY_SENT machine reconciles via query before any new
// send (RouteStep has no send from non-IDLE states).
bool SnapshotMachine(const RouteMachine& m, char* out,
                     std::size_t n);
bool RestoreMachine(const char* s, RouteMachine* out);

}  // namespace exec
}  // namespace jev
