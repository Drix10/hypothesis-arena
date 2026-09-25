// H1 — router implementation. Pure step function; the caller owns
// all I/O (broker adapter, journal file, freeze set, emergency
// buffer). See the header for the frozen rules enforced here.
//
// Protection invariant (frozen doc 06 sec. 6.1): PROTECTED is entered
// ONLY with positively confirmed broker-native protection. Any filled
// position lacking protection routes to ESTABLISH_PROTECTION
// (recovery-only repair) and, if repair fails, to immediate flatten —
// never to a cancel of a nonexistent remainder, never to PROTECTED.
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
void Copy65(char (&dst)[65], const char (&src)[65]) {
    for (int i = 0; i < 65; ++i) dst[i] = src[i];
}
void Copy64(char (&dst)[64], const char (&src)[64]) {
    for (int i = 0; i < 64; ++i) dst[i] = src[i];
}
void Copy33(char (&dst)[33], const char (&src)[33]) {
    for (int i = 0; i < 33; ++i) dst[i] = src[i];
}
// Original-intent match (P0-4): intent_id + symbol + side + kind.
// Fixed compares, no allocation; empty machine fields never match
// a populated intent (a half-restored machine binds nothing).
bool IntentMatches(const RouteMachine& m, const OrderIntent& in) {
    if (!m.intent_id[0] || !in.intent_id[0]) return false;
    for (int i = 0; i < 65; ++i) {
        if (m.intent_id[i] != in.intent_id[i]) return false;
        if (m.intent_id[i] == '\0') break;
    }
    for (int i = 0; i < 16; ++i) {
        if (m.symbol[i] != in.symbol[i]) return false;
        if (m.symbol[i] == '\0') break;
    }
    if (m.side != in.side) return false;
    return m.kind == in.kind;
}
// Broker UUID grammar (the venue's actual identifier shape): exactly
// 8-4-4-4-12 lowercase hex with hyphens (36 chars), or empty (no UUID
// observed yet). Anything else fails closed. Shared by the snapshot
// reader/writer and the POST-UUID persistence gate below.
bool IsUuidField(const char* s, char* dst, std::size_t dn) {
    if (dn < 37) return false;
    if (s[0] == '\0') {
        dst[0] = '\0';
        return true;
    }
    for (int i = 0; i < 36; ++i) {
        char c = s[i];
        if (c == '\0') return false;  // short
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return false;
        } else {
            bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!ok) return false;
        }
        dst[i] = c;
    }
    if (s[36] != '\0' && s[36] != ':') return false;
    dst[36] = '\0';
    return true;
}
RouteOut Reject(RouteOut& o, const char* reason) {
    o.action = RouteAction::REJECT;
    o.next.state = RouteState::CANCELLED;
    o.reason = reason;
    return o;
}
}  // namespace

RouteOut RouteStep(const RouteMachine& m, const OrderIntent& intent,
                   const VenueCtx& venue, const RouteObs& obs) {
    RouteOut o;
    o.next = m;
    o.next.kind = intent.kind;
    const bool is_exit = (intent.kind == risk::IntentKind::EXIT);
    // Identity gate (P1-5): a machine with an established identity
    // accepts ONLY matching tagged observations. Foreign tags are
    // ignored, and untagged observations are ignored too (an
    // established machine never acts on an unattributable event).
    if (m.state != RouteState::IDLE && m.client_id[0] != '\0') {
        bool same = true;
        if (obs.client_id[0] == '\0') {
            o.action = RouteAction::NONE;
            o.reason = "exec:untagged-observation";
            return o;
        }
        for (int i = 0; i < 65; ++i) {
            if (m.client_id[i] != obs.client_id[i]) same = false;
            if (m.client_id[i] == '\0') break;
        }
        if (!same) {
            o.action = RouteAction::NONE;
            o.reason = "exec:foreign-observation";
            return o;
        }
    }
    // Intent binding (P0-4): a machine with an established intent
    // rejects steps driven under a DIFFERENT intent (restored
    // machines cannot be steered onto another order by caller
    // mistake). Mismatch is ignored, never terminal (no mutation).
    if (m.state != RouteState::IDLE && m.intent_id[0] != '\0' &&
        !IntentMatches(m, intent)) {
        o.action = RouteAction::NONE;
        o.reason = "exec:intent-mismatch";
        return o;
    }
    // Duplicate-event collapse (P1-9): an already-applied event
    // (same id+seq) applies nothing twice.
    if (m.state != RouteState::IDLE && obs.event_id[0] != '\0' &&
        m.last_event_id[0] != '\0' &&
        obs.event_seq == m.last_event_seq) {
        bool same_ev = true;
        for (int i = 0; i < 33; ++i) {
            if (m.last_event_id[i] != obs.event_id[i]) same_ev = false;
            if (m.last_event_id[i] == '\0') break;
        }
        if (same_ev) {
            o.action = RouteAction::NONE;
            o.reason = "exec:duplicate-event";
            return o;
        }
    }
    // Stamp the applied event (P1-9): a redelivery of this exact
    // event collapses above. Stamping precedes the branch: every
    // non-ignored observation counts as seen exactly once.
    if (obs.event_id[0] != '\0') {
        Copy33(o.next.last_event_id, obs.event_id);
        o.next.last_event_seq = obs.event_seq;
    }
    switch (m.state) {
        case RouteState::IDLE: {
            if (!IntentShapeOk(intent)) return Reject(o, "exec:bad-intent");
            if (!is_exit) {
                // Entry gate: kill, stale feed, closed stage, frozen
                // symbol each forbid new risk (veto owns the rest).
                if (obs.kill != risk::KillLevel::NONE)
                    return Reject(o, "exec:kill");
                if (obs.feed_stale) return Reject(o, "exec:feed-stale");
                if (!obs.stage_entry_ok) return Reject(o, "exec:stage");
                if (obs.symbol_frozen)
                    return Reject(o, "exec:frozen-symbol");
            }
            // One stable identity per intent, computed once here and
            // carried in machine state (retries reuse it; a missing ack
            // never mints a fresh one — there is no other mint site).
            char id[65];
            bool ok = broker::MakeClientOrderId(
                venue.broker, venue.account, venue.context_hash,
                intent.symbol, intent.side, intent.intent_id, id);
            if (!ok) return Reject(o, "exec:bad-identity");
            Copy65(o.next.client_id, id);
            o.next.broker_id[0] = '\0';
            // Bind the original intent (P0-4): id + symbol + side;
            // kind is carried in o.next.kind above.
            for (int i = 0; i < 65; ++i)
                o.next.intent_id[i] = intent.intent_id[i];
            for (int i = 0; i < 16; ++i)
                o.next.symbol[i] = intent.symbol[i];
            o.next.side = intent.side;
            o.next.last_event_id[0] = '\0';
            o.next.last_event_seq = 0;
            o.next.protection_ok = false;
            o.next.filled_qty = 0;
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
                if (!is_exit) return Reject(o, "exec:no-row-no-send");
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
                if (obs.ack.authoritative_reject) {
                    // Broker refused (400/422 shaped): terminal, journaled.
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::CANCELLED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:entry-rejected";
                    return o;
                }
                // Non-terminal send outcome (transport failure, 429,
                // 401/403, malformed 2xx): reconcile under the SAME
                // client ID — never a terminal rejection, never a
                // fresh send (no send exists from any non-IDLE
                // state). Consumes the retry-once budget.
                const char* why = "exec:ambiguous-reconcile";
                if (obs.ack.auth_failure)
                    why = "exec:auth-reconcile";
                else if (obs.ack.rate_limited)
                    why = "exec:rate-reconcile";
                if (o.next.query_attempts < kQueryMaxAttempts) {
                    ++o.next.query_attempts;
                    o.action = RouteAction::QUERY_ONCE;
                    o.next.state = RouteState::QUERY_SENT;
                    o.reason = why;
                    return o;
                }
                o.action = RouteAction::JOURNAL_UNKNOWN;
                o.next.state = RouteState::UNKNOWN_FROZEN;
                o.journal_kind = "unknown";
                o.freeze_symbol = true;
                o.reason = "exec:reconcile-exhausted";
                return o;
            }
            if (obs.adapter_responded && obs.ack.accepted &&
                !obs.ack.protection_accepted) {
                // P0-3: persist the POST UUID BEFORE any cancel path —
                // CANCEL_REMAINDER needs a broker ID for DELETE, and
                // no hidden lookup may mint one later. An unparseable
                // id reconciles (the query resolves identity), never
                // cancels blind.
                char bid[64];
                if (!IsUuidField(obs.ack.broker_order_id, bid,
                                 sizeof(bid))) {
                    if (o.next.query_attempts < kQueryMaxAttempts) {
                        ++o.next.query_attempts;
                        o.action = RouteAction::QUERY_ONCE;
                        o.next.state = RouteState::QUERY_SENT;
                        o.reason = "exec:bad-ack-id";
                        return o;
                    }
                    o.action = RouteAction::JOURNAL_UNKNOWN;
                    o.next.state = RouteState::UNKNOWN_FROZEN;
                    o.journal_kind = "unknown";
                    o.freeze_symbol = true;
                    o.reason = "exec:reconcile-exhausted";
                    return o;
                }
                Copy64(o.next.broker_id, bid);
                o.next.filled_qty = obs.ack.filled_qty;
                if (obs.ack.filled_qty == 0) {
                    // Nothing filled: cancel the naked order.
                    o.action = RouteAction::CANCEL_REMAINDER;
                    o.next.state = RouteState::CANCEL_SENT;
                    o.reason = "exec:naked-empty-cancel";
                    return o;
                }
                // Filled without protection: repair now (recovery-only
                // path), never hold naked, never fake a cancel.
                o.action = RouteAction::ESTABLISH_PROTECTION;
                o.next.state = RouteState::REPAIR_SENT;
                o.reason = "exec:repair-now";
                return o;
            }
            // Accepted (or timed out): persist the POST UUID when the
            // ack carries one (same P0-3 rule: validated, else
            // reconcile — the remainder-cancel path needs it).
            if (obs.adapter_responded && obs.ack.accepted &&
                obs.ack.broker_order_id[0] != '\0' &&
                o.next.broker_id[0] == '\0') {
                char bid[64];
                if (!IsUuidField(obs.ack.broker_order_id, bid,
                                 sizeof(bid))) {
                    if (o.next.query_attempts < kQueryMaxAttempts) {
                        ++o.next.query_attempts;
                        o.action = RouteAction::QUERY_ONCE;
                        o.next.state = RouteState::QUERY_SENT;
                        o.reason = "exec:bad-ack-id";
                        return o;
                    }
                    o.action = RouteAction::JOURNAL_UNKNOWN;
                    o.next.state = RouteState::UNKNOWN_FROZEN;
                    o.journal_kind = "unknown";
                    o.freeze_symbol = true;
                    o.reason = "exec:reconcile-exhausted";
                    return o;
                }
                Copy64(o.next.broker_id, bid);
            }
            // The status query, within the retry-once budget.
            if (o.next.query_attempts < kQueryMaxAttempts) {
                ++o.next.query_attempts;
                o.action = RouteAction::QUERY_ONCE;
                o.next.state = RouteState::QUERY_SENT;
                o.reason = "exec:query-once";
                return o;
            }
            o.action = RouteAction::JOURNAL_UNKNOWN;
            o.next.state = RouteState::UNKNOWN_FROZEN;
            o.journal_kind = "unknown";
            o.freeze_symbol = true;
            o.reason = "exec:reconcile-exhausted";
            return o;
        }
        case RouteState::QUERY_SENT: {
            if (!obs.adapter_responded) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-query";
                return o;
            }
            const broker::OrderQuery& q = obs.query;
            if (!q.transport_ok) {
                // Lookup itself failed (not "order absent"): re-issue
                // the lookup under the same identity while the
                // retry-once budget remains; on exhaustion freeze for
                // S2/human rather than looping or assuming absence.
                // Auth/rate failures are classified, never silent.
                const char* why = "exec:query-retry";
                if (q.auth_failure)
                    why = "exec:query-auth";
                else if (q.rate_limited)
                    why = "exec:query-rate";
                if (o.next.query_attempts < kQueryMaxAttempts) {
                    ++o.next.query_attempts;
                    o.action = RouteAction::QUERY_ONCE;
                    o.reason = why;
                    return o;
                }
                o.action = RouteAction::JOURNAL_UNKNOWN;
                o.next.state = RouteState::UNKNOWN_FROZEN;
                o.journal_kind = "unknown";
                o.freeze_symbol = true;
                o.reason = "exec:reconcile-exhausted";
                return o;
            }
            if (q.found) Copy64(o.next.broker_id, q.broker_order_id);
            if (is_exit) {
                // Exit reconcile (P0-5): the close order resolved.
                // Filled -> the close executed: terminal. Anything
                // else (absent 404 included — the close never
                // landed) -> back to EXIT_SENT for re-issue (exits
                // must complete; reconcile-first, never blind).
                if (q.found && q.filled_qty > 0) {
                    o.next.filled_qty = q.filled_qty;
                    o.action = RouteAction::JOURNAL_EXIT;
                    o.next.state = RouteState::CLOSED;
                    o.journal_kind = "exit";
                    o.reason = "exec:exit-reconciled";
                    return o;
                }
                o.next.filled_qty = 0;
                o.action = RouteAction::EXECUTE_EXIT;
                o.next.state = RouteState::EXIT_SENT;
                o.reason = "exec:exit-reissue";
                return o;
            }
            if (!q.found) {
                // transport_ok + !found happens ONLY on 404 (P0-2):
                // authoritative absence — no UUID exists, no DELETE
                // is necessary. Journal the terminal cancellation
                // DIRECTLY; never enter CANCEL_SENT for a
                // nonexistent order, never request a confirmation.
                o.next.filled_qty = 0;
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:absent-direct";
                return o;
            }
            if (q.cancelled && q.filled_qty == 0) {
                // Already dead, nothing filled: straight to terminal.
                o.next.filled_qty = 0;
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:already-cancelled";
                return o;
            }
            if (q.filled_qty == 0) {
                // Nothing (that we can see) filled: cancel, confirm,
                // journal. Reconcile-first: the query already happened;
                // a second send from this state is unrepresentable.
                o.next.filled_qty = 0;
                o.action = RouteAction::CANCEL_REMAINDER;
                o.next.state = RouteState::CANCEL_SENT;
                o.reason = "exec:nothing-filled";
                return o;
            }
            // Protection verdict, three states (P0-1): legs strictly
            // proven -> confirmed; bracket held as a unit with legs
            // unexpanded -> constructive (the venue holds the bracket;
            // null legs = not expanded, never "absent"); otherwise
            // genuinely absent -> repair path (legitimate: no bracket
            // exists to duplicate).
            if (q.protection_active || q.bracket_class)
                o.next.protection_ok = true;
            o.next.filled_qty = q.filled_qty;
            if (o.next.protection_ok) {
                if (q.filled_qty >= intent.qty_shares) {
                    o.action = RouteAction::JOURNAL_FILL;
                    o.next.state = RouteState::PROTECTED;
                    o.journal_kind = "fill";
                    o.reason = "exec:protected";
                    return o;
                }
                // Partial with protection: journal the filled qty;
                // protection covers filled ONLY; the remainder must
                // cancel (never PROTECTED on the full intended size).
                o.action = RouteAction::JOURNAL_PARTIAL;
                o.next.state = RouteState::PARTIAL_AWAIT;
                o.journal_kind = "partial";
                o.reason = "exec:partial";
                return o;
            }
            // Filled (partial or full) WITHOUT protection: repair now.
            // CANCEL_REMAINDER is not a substitute for protection.
            o.action = RouteAction::ESTABLISH_PROTECTION;
            o.next.state = RouteState::REPAIR_SENT;
            o.reason = "exec:repair-now";
            return o;
        }
        case RouteState::REPAIR_SENT: {
            if (!obs.adapter_responded) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-repair";
                return o;
            }
            if (obs.repair_ok) {
                o.next.protection_ok = true;
                o.action = RouteAction::JOURNAL_REPAIR;
                o.next.state = RouteState::PROTECTED;
                // Frozen recovery vocabulary: the nine journal kinds
                // are closed, so a successful repair journals as
                // "reconcile" (never a tenth kind). JOURNAL_REPAIR
                // names the router action; "reconcile" is the row.
                o.journal_kind = "reconcile";
                o.reason = "exec:repaired";
                return o;
            }
            // Repair failed: flatten immediately (never hold naked).
            o.action = RouteAction::FLATTEN_NOW;
            o.next.state = RouteState::EXIT_SENT;
            o.reason = "exec:repair-failed-flatten";
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
            // Explicit final-canceled observation first: only this
            // terminals (204/request-accepted never does — P1-8).
            if (obs.cancel_confirmed) {
                if (o.next.filled_qty == 0) {
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::CANCELLED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:cancelled";
                    return o;
                }
                if (o.next.protection_ok) {
                    // Remainder cancelled; the filled qty rests under
                    // positively confirmed entry protection.
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::PROTECTED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:partial-protected";
                    return o;
                }
                // Filled but protection never confirmed: repair before
                // any claim of PROTECTED (the P0 invariant).
                o.action = RouteAction::ESTABLISH_PROTECTION;
                o.next.state = RouteState::REPAIR_SENT;
                o.reason = "exec:repair-now";
                return o;
            }
            // Cancel explicitly FAILED: UNKNOWN_EXECUTION (never
            // "filled"). A merely ACCEPTED request (204) is not
            // final: stay confirming (the caller re-observes until
            // the broker reports canceled). Silence (responded, no
            // flag at all) means the confirmation is not yet
            // observed -> re-check, never UNKNOWN (UNKNOWN needs a
            // positive failure). Freeze new orders for the symbol;
            // reconcile per S2 with protection first.
            if (obs.cancel_failed) {
                o.action = RouteAction::JOURNAL_UNKNOWN;
                o.next.state = RouteState::UNKNOWN_FROZEN;
                o.journal_kind = "unknown";
                o.freeze_symbol = true;
                o.reason = "exec:unknown-execution";
                return o;
            }
            o.action = RouteAction::CONFIRM_CANCELLED;
            o.reason = obs.cancel_accepted ? "exec:cancel-accepted"
                                           : "exec:confirm-cancel";
            return o;
        }
        case RouteState::EXIT_SENT: {
            // Exit execution identity (P0-5): the close rides the
            // machine's stable client ID (caller submits MarketClose
            // with it). No observation yet -> wait. Definitive
            // non-execution -> re-issue (exits must complete).
            // Ambiguous (response lost) -> reconcile by ID under the
            // retry-once budget (never a blind second send, never a
            // double-close). Restart reconciles the same way: no
            // send exists from any non-IDLE state.
            if (!obs.exit_responded) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-exit";
                return o;
            }
            if (obs.exit_ack.executed && obs.exit_ack.transport_ok) {
                o.next.filled_qty = intent.qty_shares;
                if (obs.exit_ack.broker_order_id[0] != '\0' &&
                    o.next.broker_id[0] == '\0' &&
                    broker::IsBrokerUuid(obs.exit_ack.broker_order_id)) {
                    for (int i = 0; i < 64; ++i)
                        o.next.broker_id[i] =
                            obs.exit_ack.broker_order_id[i];
                }
                o.action = RouteAction::JOURNAL_EXIT;
                o.next.state = RouteState::CLOSED;
                o.journal_kind = "exit";
                o.reason = "exec:exited";
                return o;
            }
            if (obs.exit_responded && !obs.exit_ack.transport_ok) {
                if (o.next.query_attempts < kQueryMaxAttempts) {
                    ++o.next.query_attempts;
                    o.action = RouteAction::QUERY_ONCE;
                    o.next.state = RouteState::QUERY_SENT;
                    o.reason = "exec:exit-reconcile";
                    return o;
                }
                o.action = RouteAction::JOURNAL_UNKNOWN;
                o.next.state = RouteState::UNKNOWN_FROZEN;
                o.journal_kind = "unknown";
                o.freeze_symbol = true;
                o.reason = "exec:reconcile-exhausted";
                return o;
            }
            o.action = RouteAction::EXECUTE_EXIT;
            o.reason = "exec:exit-retry";
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
            // A success claim without confirmed protection is a
            // corrupted machine (every legitimate entry sets the
            // flag): fail closed, never rest terminal on it.
            if (!m.protection_ok) return Reject(o, "exec:bad-state");
            o.action = RouteAction::NONE;
            o.reason = "exec:terminal";
            return o;
        case RouteState::CANCELLED:
        case RouteState::UNKNOWN_FROZEN:
        case RouteState::CLOSED:
            o.action = RouteAction::NONE;
            o.reason = "exec:terminal";
            return o;
    }
    // Invalid state value (e.g. corrupted restore): fail closed, never
    // act. RestoreMachine validates first; this is the backstop.
    return Reject(o, "exec:bad-state");
}

}  // namespace exec
}  // namespace jev

namespace jev {
namespace exec {

namespace {
// Fixed snapshot:
// "H1:<st>:<kd>:<filled>:<emg>:<pok>:<att>:<cid>:<bid>:
//     <intent>:<sym>:<side>:<evid>:<evseq>"
// client id lowercase-hex-or-empty; broker id venue UUID or empty;
// attempts persisted retry budget (0..9); intent = original intent_id
// ([A-Za-z0-9_.-], 1..64) + symbol ([A-Z0-9.], 1..15) + side (0/1);
// evid = last event id (32 hex or empty) + evseq digits. All bounded
// and validated; writer refuses un-restorable machines.
bool IsHexEmpty(const char* s, std::size_t maxlen, char* dst,
                std::size_t dn) {
    std::size_t i = 0;
    while (s[i] != '\0' && s[i] != ':') {
        if (i + 1 >= dn || i >= maxlen) return false;
        char c = s[i];
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!ok) return false;
        dst[i] = c;
        ++i;
    }
    dst[i] = '\0';
    return true;
}
bool IsTokenField(const char* s, std::size_t maxlen, bool sym_shape,
                  char* dst, std::size_t dn) {
    std::size_t i = 0;
    while (s[i] != '\0' && s[i] != ':') {
        if (i + 1 >= dn || i >= maxlen) return false;
        char c = s[i];
        bool ok;
        if (sym_shape)
            ok = (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                 c == '.';
        else
            ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                 (c >= '0' && c <= '9') || c == '_' || c == '.' ||
                 c == '-';
        if (!ok) return false;
        dst[i] = c;
        ++i;
    }
    if (i == 0) return false;  // binding fields never empty
    dst[i] = '\0';
    return true;
}
bool IsEvId(const char* s, char* dst, std::size_t dn) {
    if (dn < 33) return false;
    std::size_t i = 0;
    while (s[i] != '\0' && s[i] != ':') {
        if (i >= 32) return false;
        char c = s[i];
        bool ok = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
        if (!ok) return false;
        dst[i] = c;
        ++i;
    }
    dst[i] = '\0';
    return true;  // empty allowed (no event yet)
}
// (IsUuidField lives in the anonymous block above, shared with the
// POST-UUID gate.)
}  // namespace

bool SnapshotMachine(const RouteMachine& m, char* out, std::size_t n) {
    if (!out || n < 32) return false;
    int st = static_cast<int>(m.state);
    int kd = (m.kind == risk::IntentKind::EXIT) ? 1 : 0;
    if (st < 0 || st > 12 || m.filled_qty < 0 || m.filled_qty > 999999999)
        return false;
    if (m.query_attempts > 9) return false;
    // Writer-side strictness: refuse to persist a machine whose ids
    // cannot be restored (garbage in storage is a crash-path lie).
    // IDLE machines carry no binding yet (fields empty by
    // construction); any non-IDLE machine must carry the full
    // original-intent binding.
    char cid[65], bid[64];
    if (!IsHexEmpty(m.client_id, 64, cid, sizeof(cid))) return false;
    if (!IsUuidField(m.broker_id, bid, sizeof(bid))) return false;
    char iid[65] = {0};
    char sym[16] = {0};
    char evid[33] = {0};
    bool bound = (m.state != RouteState::IDLE);
    if (bound) {
        if (!IsTokenField(m.intent_id, 64, false, iid, sizeof(iid)))
            return false;
        if (!IsTokenField(m.symbol, 15, true, sym, sizeof(sym)))
            return false;
    }
    if (!IsEvId(m.last_event_id, evid, sizeof(evid))) return false;
    int w = std::snprintf(
        out, n, "H1:%d:%d:%lld:%d:%d:%d:%s:%s:%s:%s:%d:%s:%llu", st,
        kd, (long long)m.filled_qty, m.emergency ? 1 : 0,
        m.protection_ok ? 1 : 0, m.query_attempts, cid, bid, iid, sym,
        (m.side == broker::OrderSide::SELL) ? 1 : 0, evid,
        (unsigned long long)m.last_event_seq);
    return w > 0 && static_cast<std::size_t>(w) < n;
}

bool RestoreMachine(const char* s, RouteMachine* out) {
    if (!s || !out) return false;
    if (s[0] != 'H' || s[1] != '1' || s[2] != ':') return false;
    const char* p = s + 3;
    // state
    long st = 0;
    int nd = 0;
    while (*p >= '0' && *p <= '9' && nd < 3) {
        st = st * 10 + (*p - '0');
        ++p;
        ++nd;
    }
    if (nd == 0 || nd > 2 || *p != ':' || st < 0 || st > 12) return false;
    ++p;
    // kind
    if ((p[0] != '0' && p[0] != '1') || p[1] != ':') return false;
    int kd = p[0] - '0';
    p += 2;
    // filled
    long long fq = 0;
    nd = 0;
    while (*p >= '0' && *p <= '9' && nd < 9) {
        fq = fq * 10 + (*p - '0');
        ++p;
        ++nd;
    }
    if (nd == 0 || *p != ':') return false;
    ++p;
    // emergency + protection flags
    if ((p[0] != '0' && p[0] != '1') || p[1] != ':' ||
        (p[2] != '0' && p[2] != '1') || p[3] != ':')
        return false;
    int emg = p[0] - '0';
    int pok = p[2] - '0';
    if (p[4] < '0' || p[4] > '9' || p[5] != ':') return false;
    int att = p[4] - '0';
    p += 6;
    RouteMachine m;
    m.state = static_cast<RouteState>(st);
    m.kind = (kd == 1) ? risk::IntentKind::EXIT : risk::IntentKind::ENTRY;
    m.filled_qty = (std::int64_t)fq;
    m.emergency = (emg == 1);
    m.protection_ok = (pok == 1);
    m.query_attempts = (std::uint8_t)att;
    if (!IsHexEmpty(p, 64, m.client_id, sizeof(m.client_id)))
        return false;
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    // Empty bid (leading separator) restores as no-UUID; otherwise
    // the strict venue grammar applies.
    if (p[0] == ':') {
        m.broker_id[0] = '\0';
    } else if (!IsUuidField(p, m.broker_id, sizeof(m.broker_id))) {
        return false;
    }
    // Advance past the field to the next separator.
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    // Original-intent binding: intent_id may be empty ONLY on IDLE
    // (nothing established yet); symbol+side ride the same rule.
    // Non-empty intent requires a valid symbol and side digit.
    bool has_iid = (*p != ':');
    if (has_iid) {
        if (!IsTokenField(p, 64, false, m.intent_id,
                          sizeof(m.intent_id)))
            return false;
    } else {
        m.intent_id[0] = '\0';
    }
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    bool has_sym = (*p != ':');
    if (has_sym) {
        if (!IsTokenField(p, 15, true, m.symbol, sizeof(m.symbol)))
            return false;
    } else {
        m.symbol[0] = '\0';
    }
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    if ((p[0] != '0' && p[0] != '1') || p[1] != ':') return false;
    m.side = (p[0] == '1') ? broker::OrderSide::SELL
                           : broker::OrderSide::BUY;
    p += 2;
    if (!IsEvId(p, m.last_event_id, sizeof(m.last_event_id)))
        return false;
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    unsigned long long es = 0;
    int nd2 = 0;
    while (*p >= '0' && *p <= '9' && nd2 < 20) {
        es = es * 10 + (unsigned)(*p - '0');
        ++p;
        ++nd2;
    }
    if (nd2 == 0 || *p != '\0') return false;
    m.last_event_seq = (std::uint64_t)es;
    // Binding coherence: non-IDLE requires the full binding;
    // IDLE requires none of it.
    bool idle = (m.state == RouteState::IDLE);
    if (!idle && (!has_iid || !has_sym)) return false;
    if (idle && (has_iid || has_sym)) return false;
    *out = m;
    return true;
}

}  // namespace exec
}  // namespace jev
