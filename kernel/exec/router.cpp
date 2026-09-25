// H1 — router implementation. Pure step function; the caller owns
// all I/O (broker adapter, journal file, freeze set, emergency
// buffer). See the header for the frozen rules enforced here.
#include "router.hpp"

namespace jev {
namespace exec {

namespace {
// Frozen vocabulary checks on risk-path scalars (verify, never compute).
bool ScalarsOk(const OrderIntent& in) {
    bool scale = (in.scale_num == 1 && in.scale_den == 1) ||
                 (in.scale_num == 1 && in.scale_den == 2);
    bool stage = (in.stage_num == 1 && in.stage_den == 1) ||
                 (in.stage_num == 1 && in.stage_den == 4) ||
                 (in.stage_num == 1 && in.stage_den == 2);
    return scale && stage;
}
bool IntentShapeOk(const OrderIntent& in) {
    if (in.qty_shares <= 0 || in.stop_cents <= 0 || in.tp_cents <= 0)
        return false;
    if (!in.intent_id[0] || !in.symbol[0]) return false;
    return ScalarsOk(in);
}
void CopyId(char (&dst)[65], const char (&src)[65]) {
    for (int i = 0; i < 65; ++i) dst[i] = src[i];
}
}  // namespace

RouteOut RouteStep(const RouteMachine& m, const OrderIntent& intent,
                   const VenueCtx& venue, const RouteObs& obs) {
    RouteOut o;
    o.next = m;
    o.next.kind = intent.kind;
    const bool is_exit = (intent.kind == risk::IntentKind::EXIT);
    switch (m.state) {
        case RouteState::IDLE: {
            if (!IntentShapeOk(intent)) {
                o.action = RouteAction::REJECT;
                o.next.state = RouteState::CANCELLED;
                o.reason = "exec:bad-intent";
                return o;
            }
            if (!is_exit) {
                // Entry gate: kill, stale feed, closed stage, frozen
                // symbol each forbid new risk (veto owns the rest).
                if (obs.kill != risk::KillLevel::NONE) {
                    o.action = RouteAction::REJECT;
                    o.next.state = RouteState::CANCELLED;
                    o.reason = "exec:kill";
                    return o;
                }
                if (obs.feed_stale) {
                    o.action = RouteAction::REJECT;
                    o.next.state = RouteState::CANCELLED;
                    o.reason = "exec:feed-stale";
                    return o;
                }
                if (!obs.stage_entry_ok) {
                    o.action = RouteAction::REJECT;
                    o.next.state = RouteState::CANCELLED;
                    o.reason = "exec:stage";
                    return o;
                }
                if (obs.symbol_frozen) {
                    o.action = RouteAction::REJECT;
                    o.next.state = RouteState::CANCELLED;
                    o.reason = "exec:frozen-symbol";
                    return o;
                }
            }
            // One stable identity per intent, computed once here and
            // carried in machine state (retries reuse it; a missing ack
            // never mints a fresh one — there is no other mint site).
            char id[65];
            bool ok = broker::MakeClientOrderId(
                venue.broker, venue.account, venue.context_hash,
                intent.symbol, intent.side, intent.intent_id, id);
            if (!ok) {
                o.action = RouteAction::REJECT;
                o.next.state = RouteState::CANCELLED;
                o.reason = "exec:bad-identity";
                return o;
            }
            CopyId(o.next.client_id, id);
            o.action = RouteAction::WRITE_JOURNAL;
            o.next.state = RouteState::JOURNAL_PENDING;
            o.journal_kind = "intent";
            o.reason = "exec:journal-first";
            return o;
        }
        case RouteState::JOURNAL_PENDING: {
            if (!obs.journal_ok) {
                // No row = no send for NORMAL entries (absolute). EXIT
                // intents take the frozen emergency exception: act
                // first, buffer the row durably, append after.
                if (!is_exit) {
                    o.action = RouteAction::REJECT;
                    o.next.state = RouteState::CANCELLED;
                    o.reason = "exec:no-row-no-send";
                    return o;
                }
                o.action = RouteAction::EXECUTE_EMERGENCY;
                o.next.state = RouteState::EXIT_EMERGENCY;
                o.next.emergency = true;
                o.reason = "exec:emergency-exit";
                return o;
            }
            if (!is_exit) {
                o.action = RouteAction::SEND_PROTECTED;
                o.next.state = RouteState::SENT_UNACKED;
                o.reason = "exec:send-protected";
                return o;
            }
            o.action = RouteAction::EXECUTE_EXIT;
            o.next.state = RouteState::EXIT_SENT;
            o.reason = "exec:exit";
            return o;
        }
        case RouteState::SENT_UNACKED: {
            if (!obs.adapter_responded && !obs.query_due) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-ack";
                return o;
            }
            if (obs.adapter_responded && !obs.ack.accepted) {
                // Rejected entry: journal the cancel, terminal.
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:entry-rejected";
                return o;
            }
            if (obs.adapter_responded && obs.ack.accepted &&
                !obs.ack.protection_accepted) {
                // Naked ack: protection missing -> establish now or
                // flatten immediately (doc 06 sec. 6.1). The machine
                // routes to cancel-remainder/confirm path with zero
                // filled so far; the caller establishes protection or
                // flattens before any new risk. Never hold naked
                // awaiting a retry loop.
                o.next.filled_qty = obs.ack.filled_qty;
                o.action = RouteAction::CANCEL_REMAINDER;
                o.next.state = RouteState::CANCEL_SENT;
                o.reason = "exec:protection-missing";
                return o;
            }
            // Accepted (or timed out): exactly one status query.
            o.action = RouteAction::QUERY_ONCE;
            o.next.state = RouteState::QUERY_SENT;
            o.reason = "exec:query-once";
            return o;
        }
        case RouteState::QUERY_SENT: {
            if (!obs.adapter_responded) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-query";
                return o;
            }
            const broker::OrderQuery& q = obs.query;
            if (!q.found || (q.found && q.filled_qty == 0 &&
                             !q.cancelled)) {
                // Nothing (that we can see) filled: cancel, confirm,
                // journal. Reconcile-first: the query already happened;
                // a second send from this state is unrepresentable.
                o.next.filled_qty = 0;
                o.action = RouteAction::CANCEL_REMAINDER;
                o.next.state = RouteState::CANCEL_SENT;
                o.reason = "exec:nothing-filled";
                return o;
            }
            if (q.filled_qty > 0 && q.filled_qty < intent.qty_shares) {
                // Partial: journal the filled qty; protection covers
                // filled ONLY; the remainder must cancel (never becomes
                // PROTECTED on the full intended size).
                o.next.filled_qty = q.filled_qty;
                o.action = RouteAction::JOURNAL_PARTIAL;
                o.next.state = RouteState::PARTIAL_AWAIT;
                o.journal_kind = "partial";
                o.reason = "exec:partial";
                return o;
            }
            if (q.filled_qty >= intent.qty_shares && q.protection_active) {
                o.next.filled_qty = q.filled_qty;
                o.action = RouteAction::JOURNAL_FILL;
                o.next.state = RouteState::PROTECTED;
                o.journal_kind = "fill";
                o.reason = "exec:protected";
                return o;
            }
            // Filled but protection not active: same as naked ack.
            o.next.filled_qty = q.filled_qty;
            o.action = RouteAction::CANCEL_REMAINDER;
            o.next.state = RouteState::CANCEL_SENT;
            o.reason = "exec:protection-missing";
            return o;
        }
        case RouteState::PARTIAL_AWAIT: {
            // Journal row for the partial must have landed (caller
            // feeds journal_ok); then cancel the remainder.
            if (!obs.journal_ok) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-partial-row";
                return o;
            }
            o.action = RouteAction::CANCEL_REMAINDER;
            o.next.state = RouteState::CANCEL_SENT;
            o.reason = "exec:cancel-remainder";
            return o;
        }
        case RouteState::CANCEL_SENT: {
            if (!obs.adapter_responded) {
                o.action = RouteAction::CONFIRM_CANCELLED;
                o.reason = "exec:confirm-cancel";
                return o;
            }
            if (obs.cancel_confirmed) {
                if (o.next.filled_qty == 0) {
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::CANCELLED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:cancelled";
                    return o;
                }
                // Partial remainder cancelled: position = filled qty
                // under entry protection (bracket covered it).
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::PROTECTED;
                o.journal_kind = "cancel";
                o.reason = "exec:partial-protected";
                return o;
            }
            // Cancel FAILED: UNKNOWN_EXECUTION (never "filled").
            // Freeze new orders for the symbol; reconcile per S2 with
            // protection first. The freeze is caller-owned state.
            o.action = RouteAction::JOURNAL_UNKNOWN;
            o.next.state = RouteState::UNKNOWN_FROZEN;
            o.journal_kind = "unknown";
            o.freeze_symbol = true;
            o.reason = "exec:unknown-execution";
            return o;
        }
        case RouteState::EXIT_SENT: {
            if (!obs.executed) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-exit";
                return o;
            }
            o.action = RouteAction::JOURNAL_EXIT;
            o.next.state = RouteState::CLOSED;
            o.journal_kind = "exit";
            o.reason = "exec:exited";
            return o;
        }
        case RouteState::EXIT_EMERGENCY: {
            if (!obs.executed) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-emergency";
                return o;
            }
            // Row still lands: caller buffers it durably now (then
            // appends at the first safe moment).
            o.action = RouteAction::BUFFER_EMERGENCY;
            o.next.state = RouteState::CLOSED;
            o.next.emergency = true;
            o.journal_kind = "exit";
            o.reason = "exec:emergency-buffered";
            return o;
        }
        case RouteState::PROTECTED:
        case RouteState::CANCELLED:
        case RouteState::UNKNOWN_FROZEN:
        case RouteState::CLOSED:
            o.action = RouteAction::NONE;
            o.reason = "exec:terminal";
            return o;
    }
    o.action = RouteAction::NONE;
    o.reason = "exec:terminal";
    return o;
}

}  // namespace exec
}  // namespace jev
