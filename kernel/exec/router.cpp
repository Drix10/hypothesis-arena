// Router implementation: a pure step function; the caller owns all I/O
// (broker adapter, journal file, freeze set, emergency buffer). See
// router.hpp for the rules enforced here.
//
// Protection invariant (doc 06 6.1): PROTECTED is entered only with
// positively confirmed broker-native protection. A filled position lacking
// protection routes to ESTABLISH_PROTECTION (recovery-only repair) and, if
// repair fails, to immediate flatten; never to a cancel of a nonexistent
// remainder, never to PROTECTED.
#include "router.hpp"

namespace jev {
namespace exec {

namespace {
// Vocabulary checks on risk-path scalars (verify, never compute).
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
// ULID utilities (broker event identity): 26 chars Crockford base32; the
// first 10 chars are a 48-bit ms timestamp (top 2 bits zero). Decodes venue
// stream order from the preserved identity; this is publication order, not
// a business-event timestamp.
int CrockVal(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'A' && c <= 'H') return c - 'A' + 10;
    if (c == 'J') return 18;
    if (c == 'K') return 19;
    if (c == 'M') return 20;
    if (c == 'N') return 21;
    if (c >= 'P' && c <= 'T') return c - 'P' + 22;
    if (c >= 'V' && c <= 'Z') return c - 'V' + 28;
    return -1;  // I, L, O, U, lowercase, symbols all invalid
}
bool IsUlid(const char* s) {
    if (!s) return false;
    for (int i = 0; i < 26; ++i) {
        if (s[i] == '\0' || CrockVal(s[i]) < 0) return false;
    }
    return s[26] == '\0';
}
bool UlidTimeMs(const char* s, std::uint64_t* out) {
    std::uint64_t v = 0;
    for (int i = 0; i < 10; ++i) {
        int d = CrockVal(s[i]);
        if (d < 0) return false;
        v = v * 32 + (unsigned)d;
    }
    if (v >= (1ULL << 48)) return false;
    *out = v;
    return true;
}
// Venue stream order: older publication first; same-ms ties break by
// full-string compare. Returns -1/0/+1; both inputs must be valid ULIDs.
int CmpUlid(const char* a, const char* b) {
    std::uint64_t ta = 0;
    std::uint64_t tb = 0;
    if (!UlidTimeMs(a, &ta) || !UlidTimeMs(b, &tb)) return 0;
    if (ta != tb) return (ta < tb) ? -1 : 1;
    for (int i = 0; i < 26; ++i) {
        if (a[i] != b[i]) return (a[i] < b[i]) ? -1 : 1;
    }
    return 0;
}
// Exit sub-identity (P0-2): deterministic client ID for attempt N>=1,
// derived from the original intent but distinct from every burned ID
// (Alpaca uniqueness). Attempt 0 is the base recipe; sub-ids hash intent#eN.
bool MintExitSubId(const OrderIntent& in, const VenueCtx& venue,
                   std::uint8_t attempt, char (&out)[65]) {
    if (attempt == 0 || attempt > 9) return false;
    char sub[72];
    int i = 0;
    while (in.intent_id[i] != '\0' && i < 64) {
        sub[i] = in.intent_id[i];
        ++i;
    }
    if (i + 4 >= (int)sizeof(sub)) return false;
    sub[i++] = '#';
    sub[i++] = 'e';
    sub[i++] = (char)('0' + attempt);
    sub[i] = '\0';
    return broker::MakeClientOrderId(venue.broker, venue.account,
                                     venue.context_hash, in.symbol,
                                     in.side, sub, out);
}
// Original-intent match: intent_id + symbol + side + kind. Fixed compares,
// no allocation; empty machine fields never match a populated intent.
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
// Broker UUID grammar: 8-4-4-4-12 lowercase hex with hyphens (36 chars), or
// empty (none observed yet). Shared by the snapshot reader/writer and the
// POST-UUID persistence gate.
bool IsUuidField(const char* s, char* dst, std::size_t dn) {
    if (dn < 37) return false;
    if (s[0] == '\0') {
        // Empty restores as no-UUID; zero the whole buffer so the result is
        // byte-deterministic past the NUL (callers copy the full buffer).
        for (std::size_t i = 0; i < dn; ++i) dst[i] = '\0';
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
    // Zero the tail: callers copy the full fixed buffer (Copy64).
    for (std::size_t i = 37; i < dn; ++i) dst[i] = '\0';
    return true;
}
RouteOut Reject(RouteOut& o, const char* reason) {
    o.action = RouteAction::REJECT;
    o.next.state = RouteState::CANCELLED;
    o.reason = reason;
    return o;
}
// Exit accounting (P0-2): fold a current-order cumulative fill C into the
// persisted totals. exit_counted tracks the current sub-order (reset on
// sub-ID rotation); exit_closed is the monotonic cumulative total. False =
// contradictory totals (overfill): the caller freezes for S2/human.
bool FoldExitFill(RouteMachine& nx, const OrderIntent& in,
                  std::int64_t cur) {
    if (cur < 0 || cur > 999999999) return false;
    std::int64_t counted = nx.exit_counted_qty;
    std::int64_t closed = nx.exit_closed_qty;
    if (cur > counted) {
        if (closed + (cur - counted) > 999999999) return false;
        closed += cur - counted;
        counted = cur;
    }
    if (closed < 0 || closed > in.qty_shares) return false;
    nx.exit_closed_qty = closed;
    nx.exit_counted_qty = counted;
    return true;
}
// Terminal freeze helper.
RouteOut FreezeUnknown(RouteOut& o, const char* reason) {
    o.action = RouteAction::JOURNAL_UNKNOWN;
    o.next.state = RouteState::UNKNOWN_FROZEN;
    o.journal_kind = "unknown";
    o.freeze_symbol = true;
    o.reason = reason;
    return o;
}
// Stream-live authority (cross-family lifecycle rule): the last applied
// event is a broker-stream ULID. A no-event REST snapshot carries no broker
// time, so it can add monotonic fill knowledge but cannot originate a
// terminal transition (cancel/dead/absent-terminal) against this state; it
// reconciles (re-query within budget, else freeze) until stream confirmation
// or S2/human resolution. Deaths the machine itself requested (CANCEL_SENT
// confirmations) are unaffected.
bool StreamLive(const RouteMachine& m) { return IsUlid(m.last_event_id); }
// Exit terminal honoring the emergency ordering exception: the emergency
// path never landed its intent row via WRITE_JOURNAL, so it closes through
// the durable buffer. Callers set filled_qty + broker UUID first.
RouteOut ExitClosed(RouteOut& o, const char* reason) {
    if (o.next.emergency) {
        o.action = RouteAction::BUFFER_EMERGENCY;
    } else {
        o.action = RouteAction::JOURNAL_EXIT;
    }
    o.next.state = RouteState::CLOSED;
    o.journal_kind = "exit";
    o.reason = reason;
    return o;
}
// Uncertain-terminal reconcile: a no-event REST terminal claim against
// stream-live state. The caller already folded; this chooses reconcile vs
// freeze, never mint/terminal.
RouteOut RestTerminalReconcile(RouteOut& o, const char* reason) {
    if (o.next.query_attempts < kQueryMaxAttempts) {
        ++o.next.query_attempts;
        o.action = RouteAction::QUERY_ONCE;
        o.reason = reason;
        return o;
    }
    return FreezeUnknown(o, "exec:reconcile-exhausted");
}
// Shared exit-ack machinery (EXIT_SENT + EXIT_EMERGENCY): fold the
// authoritative cumulative qty; flat -> terminal (BUFFER under the emergency
// exception, JOURNAL otherwise); DEAD-short -> mint the remainder under a new
// sub-ID; short-FILLED (contradictory) -> reconcile; PARTIAL/PENDING/
// ambiguous -> reconcile by ID under budget. Never CLOSED on a partial,
// never a blind second send. Overfill -> freeze for S2/human.
RouteOut ExitAckStep(RouteOut& o, const RouteMachine& m,
                     const OrderIntent& intent, const VenueCtx& venue,
                     const broker::CloseResult& ca) {
    if (ca.transport_ok &&
        (ca.state == broker::CloseState::FILLED ||
         ca.state == broker::CloseState::DEAD)) {
        if (!FoldExitFill(o.next, intent, ca.filled_qty)) {
            return FreezeUnknown(o, "exec:exit-overfill");
        }
        if (o.next.exit_closed_qty == intent.qty_shares) {
            o.next.filled_qty = o.next.exit_closed_qty;
            if (ca.broker_order_id[0] != '\0' &&
                broker::IsBrokerUuid(ca.broker_order_id)) {
                Copy64(o.next.broker_id, ca.broker_order_id);
            }
            return ExitClosed(o, "exec:exited");
        }
        if (ca.state == broker::CloseState::DEAD) {
            // Burned ID, remainder open: mint next identity.
            if (m.exit_attempt >= 9) {
                return FreezeUnknown(
                    o, "exec:exit-attempts-exhausted");
            }
            char nid[65];
            std::uint8_t natt =
                (std::uint8_t)(m.exit_attempt + 1);
            if (!MintExitSubId(intent, venue, natt, nid)) {
                return FreezeUnknown(
                    o, "exec:exit-identity-failed");
            }
            o.next.exit_attempt = natt;
            Copy65(o.next.client_id, nid);
            o.next.broker_id[0] = '\0';
            o.next.exit_counted_qty = 0;
            o.next.filled_qty = o.next.exit_closed_qty;
            o.exit_qty =
                intent.qty_shares - o.next.exit_closed_qty;
            o.action = RouteAction::EXECUTE_EXIT;
            o.reason = "exec:exit-new-identity";
            return o;
        }
        // Short FILLED (contradictory): reconcile the remainder.
        o.next.filled_qty = o.next.exit_closed_qty;
        if (o.next.query_attempts < kQueryMaxAttempts) {
            ++o.next.query_attempts;
            o.action = RouteAction::QUERY_ONCE;
            o.next.state = RouteState::QUERY_SENT;
            o.reason = "exec:exit-short-fill";
            return o;
        }
        return FreezeUnknown(o, "exec:reconcile-exhausted");
    }
    if (o.next.query_attempts < kQueryMaxAttempts) {
        ++o.next.query_attempts;
        o.action = RouteAction::QUERY_ONCE;
        o.next.state = RouteState::QUERY_SENT;
        o.reason = "exec:exit-reconcile";
        return o;
    }
    return FreezeUnknown(o, "exec:reconcile-exhausted");
}
}  // namespace

RouteOut RouteStep(const RouteMachine& m, const OrderIntent& intent,
                   const VenueCtx& venue, const RouteObs& obs) {
    RouteOut o;
    // o.next starts as an exact copy of m; the identity/binding checks below
    // return it unchanged on ignore (P0-3), so callers may assign next
    // unconditionally. The IDLE branch is the only mint site.
    o.next = m;
    const bool is_exit = (intent.kind == risk::IntentKind::EXIT);
    // Identity gate (P1-5): an established machine accepts only matching
    // tagged observations; foreign and untagged ones are ignored.
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
    // Intent binding (P0-4): an established machine ignores steps driven under
    // a different intent (never terminal), so a restored machine cannot be
    // steered onto another order.
    if (m.state != RouteState::IDLE && m.intent_id[0] != '\0' &&
        !IntentMatches(m, intent)) {
        o.action = RouteAction::NONE;
        o.reason = "exec:intent-mismatch";
        return o;
    }
    // Sequence authority (doc 13 13.7): ULID vs ULID compares by venue stream
    // order (timestamp, then full-string tiebreak), not business-event time.
    // Non-ULID ids use the caller-assigned monotonic seq per machine: exact
    // redelivery collapses, older seq is stale, same-seq different-id is a
    // conflict (first applied wins), only newer seq applies. Cross-family
    // (one ULID, one not) cannot be compared and applies (full-state
    // convergence covers it). All ignores return the machine byte-identical.
    if (m.state != RouteState::IDLE && obs.event_id[0] != '\0' &&
        m.last_event_id[0] != '\0') {
        bool oU = IsUlid(obs.event_id);
        bool mU = IsUlid(m.last_event_id);
        if (oU && mU) {
            int c = CmpUlid(obs.event_id, m.last_event_id);
            if (c <= 0) {
                o.action = RouteAction::NONE;
                o.reason = (c == 0) ? "exec:duplicate-event"
                                    : "exec:stale-event";
                return o;
            }
        } else if (!oU && !mU) {
            if (obs.event_seq == m.last_event_seq) {
                bool same_ev = true;
                for (int i = 0; i < 33; ++i) {
                    if (m.last_event_id[i] != obs.event_id[i])
                        same_ev = false;
                    if (m.last_event_id[i] == '\0') break;
                }
                o.action = RouteAction::NONE;
                o.reason = same_ev ? "exec:duplicate-event"
                                   : "exec:seq-conflict";
                return o;
            }
            if (obs.event_seq < m.last_event_seq) {
                o.action = RouteAction::NONE;
                o.reason = "exec:stale-event";
                return o;
            }
        }
    }
    // Stamp the applied event (P1-9) before the branch, so every non-ignored
    // observation counts as seen exactly once.
    if (obs.event_id[0] != '\0') {
        Copy33(o.next.last_event_id, obs.event_id);
        o.next.last_event_seq = obs.event_seq;
    }
    switch (m.state) {
        case RouteState::IDLE: {
            if (!IntentShapeOk(intent)) return Reject(o, "exec:bad-intent");
            if (!is_exit) {
                // Entry gate: kill, stale feed, closed stage and frozen symbol
                // each forbid new risk (veto owns the rest).
                if (obs.kill != risk::KillLevel::NONE)
                    return Reject(o, "exec:kill");
                if (obs.feed_stale) return Reject(o, "exec:feed-stale");
                if (!obs.stage_entry_ok) return Reject(o, "exec:stage");
                if (obs.symbol_frozen)
                    return Reject(o, "exec:frozen-symbol");
            }
            // One stable identity per intent, computed once and carried in
            // machine state; there is no other mint site.
            char id[65];
            bool ok = broker::MakeClientOrderId(
                venue.broker, venue.account, venue.context_hash,
                intent.symbol, intent.side, intent.intent_id, id);
            if (!ok) return Reject(o, "exec:bad-identity");
            Copy65(o.next.client_id, id);
            o.next.broker_id[0] = '\0';
            // Bind the original intent (sole mint site); every later step
            // verifies it.
            o.next.kind = intent.kind;
            for (int i = 0; i < 65; ++i)
                o.next.intent_id[i] = intent.intent_id[i];
            for (int i = 0; i < 16; ++i)
                o.next.symbol[i] = intent.symbol[i];
            o.next.side = intent.side;
            o.next.last_event_id[0] = '\0';
            o.next.last_event_seq = 0;
            o.next.exit_attempt = 0;
            o.next.protection_ok = false;
            o.next.filled_qty = 0;
            if (obs.intent_rowed) {
                // The row predates the crash (nothing was sent under any id, so
                // the fresh mint is safe and pre-flight dedupes it). Skip WRITE:
                // a second intent row would fork the journal.
                o.next.state = RouteState::JOURNAL_PENDING;
                o.reason = "exec:journal-recovered";
                return o;
            }
            o.action = RouteAction::WRITE_JOURNAL;
            o.next.state = RouteState::JOURNAL_PENDING;
            o.journal_kind = "intent";
            o.reason = "exec:journal-first";
            return o;
        }
        case RouteState::JOURNAL_PENDING: {
            if (!obs.journal_ok) {
                // No row, no send for normal entries. EXIT intents take the
                // emergency exception: act first, buffer the row, append after.
                if (!is_exit) return Reject(o, "exec:no-row-no-send");
                o.exit_qty = intent.qty_shares - o.next.exit_closed_qty;
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
            o.exit_qty = intent.qty_shares;  // exit_closed == 0 here
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
                    // Broker refused (400/422): terminal, journaled.
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::CANCELLED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:entry-rejected";
                    return o;
                }
                // Non-terminal send outcome (transport failure, 429, 401/403,
                // malformed 2xx): reconcile under the same client ID, never a
                // terminal rejection or a fresh send. Consumes the retry budget.
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
                // P0-3: persist the POST UUID before any cancel path (DELETE
                // needs a broker ID and no hidden lookup may mint one). An
                // unparseable id reconciles, never cancels blind.
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
                // Filled without protection: repair now, never hold naked.
                o.action = RouteAction::ESTABLISH_PROTECTION;
                o.next.state = RouteState::REPAIR_SENT;
                o.reason = "exec:repair-now";
                return o;
            }
            // Accepted (or timed out): persist the POST UUID when the ack
            // carries one (P0-3: validated, else reconcile).
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
                // Lookup itself failed (not "order absent"): re-issue under the
                // same identity while budget remains, then freeze for S2/human.
                // Auth/rate failures are classified.
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
            // Cross-family stale guard (P0/P1-3): fills are monotonic per order.
            // A found snapshot below the established floor (entries: machine
            // filled; exits: current-order counted) is stale regardless of
            // family; REST never regresses stream state.
            if (q.found) {
                std::int64_t floor = is_exit ? o.next.exit_counted_qty
                                             : o.next.filled_qty;
                if (q.filled_qty < floor) {
                    o.action = RouteAction::NONE;
                    o.reason = "exec:stale-snapshot";
                    return o;
                }
            }
            if (q.found) Copy64(o.next.broker_id, q.broker_order_id);
            if (is_exit) {
                // Exit reconcile: the close order resolved. 404 absent -> back to
                // EXIT_SENT for same-ID re-issue. Cancelled-unfilled or DEAD ->
                // the ID is burned: mint the next sub-identity (P0-2). Filled at
                // or above the close size -> flat: terminal with the
                // authoritative quantity. Below size -> query again within
                // budget, else freeze for S2/human.
                if (!q.found) {
                    o.next.filled_qty = o.next.exit_closed_qty;
                    o.exit_qty =
                        intent.qty_shares - o.next.exit_closed_qty;
                    o.action = RouteAction::EXECUTE_EXIT;
                    o.next.state = RouteState::EXIT_SENT;
                    o.reason = "exec:exit-reissue";
                    return o;
                }
                // A canceled/DEAD close order never fills further: fold its
                // cumulative qty, then mint the remainder under a new ID (P0-2).
                // Flat -> terminal first.
                bool x_dead =
                    q.cancelled ||
                    q.close_state == broker::CloseState::DEAD;
                if (x_dead) {
                    if (!FoldExitFill(o.next, intent, q.filled_qty)) {
                        return FreezeUnknown(o, "exec:exit-overfill");
                    }
                    if (o.next.exit_closed_qty == intent.qty_shares) {
                        o.next.filled_qty = o.next.exit_closed_qty;
                        return ExitClosed(o, "exec:exit-reconciled");
                    }
                    // No-event REST death against stream-live state is an
                    // uncertain terminal (no broker time to prove it postdates
                    // the stream): the fold stands, but reconcile within budget,
                    // else freeze. Event-carrying terminals already passed the
                    // ordering above.
                    if (obs.event_id[0] == '\0' &&
                        StreamLive(o.next)) {
                        return RestTerminalReconcile(
                            o, "exec:rest-terminal-unconfirmed");
                    }
                    if (m.exit_attempt >= 9) {
                        o.action = RouteAction::JOURNAL_UNKNOWN;
                        o.next.state = RouteState::UNKNOWN_FROZEN;
                        o.journal_kind = "unknown";
                        o.freeze_symbol = true;
                        o.reason = "exec:exit-attempts-exhausted";
                        return o;
                    }
                    char nid[65];
                    std::uint8_t natt =
                        (std::uint8_t)(m.exit_attempt + 1);
                    if (!MintExitSubId(intent, venue, natt, nid)) {
                        o.action = RouteAction::JOURNAL_UNKNOWN;
                        o.next.state = RouteState::UNKNOWN_FROZEN;
                        o.journal_kind = "unknown";
                        o.freeze_symbol = true;
                        o.reason = "exec:exit-identity-failed";
                        return o;
                    }
                    o.next.exit_attempt = natt;
                    Copy65(o.next.client_id, nid);
                    o.next.broker_id[0] = '\0';  // X dies with X
                    o.next.exit_counted_qty = 0;  // new order counts
                    o.next.filled_qty = o.next.exit_closed_qty;
                    o.exit_qty =
                        intent.qty_shares - o.next.exit_closed_qty;
                    o.action = RouteAction::EXECUTE_EXIT;
                    o.next.state = RouteState::EXIT_SENT;
                    o.reason = "exec:exit-new-identity";
                    return o;
                }
                // Fold the authoritative cumulative fill (P0-2): flat -> terminal
                // with that total; below size -> query again within budget, else
                // freeze. Overfill -> freeze.
                if (!FoldExitFill(o.next, intent, q.filled_qty)) {
                    return FreezeUnknown(o, "exec:exit-overfill");
                }
                if (o.next.exit_closed_qty == intent.qty_shares) {
                    o.next.filled_qty = o.next.exit_closed_qty;
                    return ExitClosed(o, "exec:exit-reconciled");
                }
                o.next.filled_qty = o.next.exit_closed_qty;
                if (o.next.query_attempts < kQueryMaxAttempts) {
                    ++o.next.query_attempts;
                    o.action = RouteAction::QUERY_ONCE;
                    o.reason = "exec:exit-partial-reconcile";
                    return o;
                }
                return FreezeUnknown(o, "exec:reconcile-exhausted");
            }
            if (!q.found) {
                // transport_ok + !found happens only on 404 (P0-2): authoritative
                // absence, no UUID and no DELETE. Journal the cancellation
                // directly. Exception: a no-event 404 against stream-live state
                // is uncertain (stale lookup): reconcile, never terminalize.
                if (obs.event_id[0] == '\0' && StreamLive(o.next)) {
                    return RestTerminalReconcile(
                        o, "exec:rest-terminal-unconfirmed");
                }
                o.next.filled_qty = 0;
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:absent-direct";
                return o;
            }
            // Stream-live lifecycle authority, general entry rule: a no-event
            // REST terminal claim (canceled / DEAD / full FILLED, any qty) never
            // establishes an entry transition against ULID-established live
            // state. Fill knowledge was folded above; the verdict reconciles
            // first (budget, else freeze). Subsumes the canceled+0 case below.
            if (obs.event_id[0] == '\0' && StreamLive(o.next) &&
                (q.cancelled ||
                 q.close_state == broker::CloseState::DEAD ||
                 q.close_state == broker::CloseState::FILLED)) {
                return RestTerminalReconcile(
                    o, "exec:rest-terminal-unconfirmed");
            }
            if (q.cancelled && q.filled_qty == 0) {
                // Already dead, nothing filled: terminal, with the same
                // uncertain-terminal exception as 404 above.
                if (obs.event_id[0] == '\0' && StreamLive(o.next)) {
                    return RestTerminalReconcile(
                        o, "exec:rest-terminal-unconfirmed");
                }
                o.next.filled_qty = 0;
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:already-cancelled";
                return o;
            }
            if (q.filled_qty == 0) {
                // Nothing filled: cancel, confirm, journal. The query already
                // happened; no second send exists from this state.
                o.next.filled_qty = 0;
                o.action = RouteAction::CANCEL_REMAINDER;
                o.next.state = RouteState::CANCEL_SENT;
                o.reason = "exec:nothing-filled";
                return o;
            }
            // Protection verdict (P0-1): legs strictly proven -> confirmed;
            // bracket held as a unit with legs unexpanded -> constructive (null
            // legs = not expanded, not "absent"); otherwise absent -> repair
            // (no bracket exists to duplicate).
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
                // Partial with protection: journal the filled qty; protection
                // covers filled only, so the remainder must cancel.
                o.action = RouteAction::JOURNAL_PARTIAL;
                o.next.state = RouteState::PARTIAL_AWAIT;
                o.journal_kind = "partial";
                o.reason = "exec:partial";
                return o;
            }
            // Filled without protection: repair now; CANCEL_REMAINDER is no
            // substitute.
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
                // The nine journal kinds are closed, so a successful repair
                // journals as "reconcile"; JOURNAL_REPAIR names the action only.
                o.journal_kind = "reconcile";
                o.reason = "exec:repaired";
                return o;
            }
            // Repair failed: flatten immediately.
            o.action = RouteAction::FLATTEN_NOW;
            o.next.state = RouteState::EXIT_SENT;
            o.reason = "exec:repair-failed-flatten";
            return o;
        }
        case RouteState::PARTIAL_AWAIT: {
            // The partial row must have landed (caller feeds journal_ok);
            // then cancel the remainder.
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
            // Explicit final-canceled observation first; a 204 or
            // request-accepted never terminals (P1-8). Coverage uses the
            // authoritative final quantity (P1-4), since fills may have grown
            // past the stale machine qty. No authoritative qty -> unproven ->
            // repair.
            if (obs.cancel_confirmed) {
                std::int64_t fq = -1;
                if (obs.cancel_filled_qty >= 0 &&
                    obs.cancel_filled_qty <= 999999999)
                    fq = obs.cancel_filled_qty;
                // Contradictory-lower final (below the fresher floor):
                // unattributed, never regress.
                if (fq >= 0 && fq < o.next.filled_qty) fq = -1;
                if (o.next.filled_qty == 0 && fq <= 0) {
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::CANCELLED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:cancelled";
                    return o;
                }
                if (fq >= 0) o.next.filled_qty = fq;
                if (o.next.protection_ok && fq >= intent.qty_shares) {
                    // Fully filled: the entry protection still rests. A partial
                    // never takes this branch: cancelling the entry order also
                    // cancels its bracket/OTO legs at the venue, so the filled
                    // quantity is re-protected below under its own identity.
                    o.action = RouteAction::JOURNAL_CANCEL;
                    o.next.state = RouteState::PROTECTED;
                    o.journal_kind = "cancel";
                    o.reason = "exec:partial-protected";
                    return o;
                }
                // Filled but protection never confirmed (or final qty
                // unattributed): repair before any claim of PROTECTED.
                o.action = RouteAction::ESTABLISH_PROTECTION;
                o.next.state = RouteState::REPAIR_SENT;
                o.reason = "exec:repair-now";
                return o;
            }
            // Cancel explicitly failed: UNKNOWN_EXECUTION (never "filled"). A
            // merely accepted request (204) is not final: keep confirming.
            // Silence (responded, no flag) means not yet observed: re-check,
            // since UNKNOWN needs a positive failure. Freeze new orders for the
            // symbol; reconcile per S2 with protection first.
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
            // The close rides the machine's stable client ID at o.exit_qty.
            // ExitAckStep folds the authoritative cumulative qty and is terminal
            // only on full completion.
            if (!obs.exit_responded) {
                o.action = RouteAction::NONE;
                o.reason = "exec:awaiting-exit";
                return o;
            }
            return ExitAckStep(o, m, intent, venue, obs.exit_ack);
        }
        case RouteState::EXIT_EMERGENCY: {
            // Emergency exception (doc 06 6.1): the journal write failed, so
            // execution came first. Only the ordering changes: the exit runs the
            // same accounting/reconcile machinery as EXIT_SENT (a partial/dead
            // emergency close keeps cumulative closed qty and manages the
            // remainder), and the terminal buffers the row instead of
            // journaling. Never CLOSED without authoritative full completion:
            // an executed flag without ack detail reconciles by ID.
            if (!obs.exit_responded) {
                // A query answer belongs to the reconcile path: adopt QUERY_SENT
                // so the caller re-feeds this observation there (the emergency
                // flag persists, so the terminal still buffers).
                if (obs.adapter_responded && obs.query.transport_ok) {
                    o.action = RouteAction::NONE;
                    o.next.state = RouteState::QUERY_SENT;
                    o.reason = "exec:emergency-to-query";
                    return o;
                }
                if (!obs.executed) {
                    o.action = RouteAction::NONE;
                    o.reason = "exec:awaiting-emergency";
                    return o;
                }
                return RestTerminalReconcile(
                    o, "exec:emergency-reconcile");
            }
            return ExitAckStep(o, m, intent, venue, obs.exit_ack);
        }
        case RouteState::PROTECTED:
            // A success claim without confirmed protection is a corrupted
            // machine (every legitimate entry sets the flag).
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
    // Invalid state value (e.g. corrupted restore): never act. RestoreMachine
    // validates first; this is the backstop.
    return Reject(o, "exec:bad-state");
}

}  // namespace exec
}  // namespace jev

namespace jev {
namespace exec {

namespace {
// Fixed snapshot:
// "H1:<st>:<kd>:<filled>:<emg>:<pok>:<att>:<cid>:<bid>:
//     <intent>:<sym>:<side>:<evid>:<evseq>:<xatt>:<eclosed>:<ecounted>"
// client id lowercase-hex-or-empty; broker id venue UUID or empty; att =
// persisted retry budget (0..kQueryMaxAttempts); intent = original intent_id
// ([A-Za-z0-9_.-], 1..64) + symbol ([A-Z0-9.], 1..15) + side (0/1); evid =
// last event id (verbatim token or empty) + evseq digits; xatt = exit
// sub-identity counter 0..9. All bounded and validated; the writer refuses
// un-restorable machines.
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
    // Verbatim broker identity (ULID) or hex32 poll tag: bounded token
    // [A-Za-z0-9_-], max 32 chars, persisted unchanged.
    if (dn < 33) return false;
    std::size_t i = 0;
    while (s[i] != '\0' && s[i] != ':') {
        if (i >= 32) return false;
        char c = s[i];
        bool ok = (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
                  (c >= 'a' && c <= 'z') || c == '_' || c == '-';
        if (!ok) return false;
        dst[i] = c;
        ++i;
    }
    dst[i] = '\0';
    return true;  // empty allowed (no event yet)
}
}  // namespace

bool SnapshotMachine(const RouteMachine& m, char* out, std::size_t n) {
    if (!out || n < 32) return false;
    int st = static_cast<int>(m.state);
    int kd = (m.kind == risk::IntentKind::EXIT) ? 1 : 0;
    if (st < 0 || st > 12 || m.filled_qty < 0 || m.filled_qty > 999999999)
        return false;
    // The persisted budget matches the runtime bound: a crash image must not
    // authorize a third lookup.
    if (m.query_attempts > (std::uint8_t)kQueryMaxAttempts) return false;
    // Writer-side strictness: refuse to persist a machine whose ids cannot be
    // restored. IDLE carries no binding; any non-IDLE machine must carry the
    // full original-intent binding.
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
    if (m.exit_attempt > 9) return false;
    if (m.exit_closed_qty < 0 || m.exit_closed_qty > 999999999 ||
        m.exit_counted_qty < 0 || m.exit_counted_qty > 999999999)
        return false;
    int w = std::snprintf(
        out, n, "H1:%d:%d:%lld:%d:%d:%d:%s:%s:%s:%s:%d:%s:%llu:%d:%lld:%lld",
        st, kd, (long long)m.filled_qty, m.emergency ? 1 : 0,
        m.protection_ok ? 1 : 0, m.query_attempts, cid, bid, iid, sym,
        (m.side == broker::OrderSide::SELL) ? 1 : 0, evid,
        (unsigned long long)m.last_event_seq, m.exit_attempt,
        (long long)m.exit_closed_qty, (long long)m.exit_counted_qty);
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
    if (p[4] < '0' || p[4] > ('0' + kQueryMaxAttempts) || p[5] != ':')
        return false;
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
    // Empty bid restores as no-UUID; otherwise the strict venue grammar.
    if (p[0] == ':') {
        m.broker_id[0] = '\0';
    } else if (!IsUuidField(p, m.broker_id, sizeof(m.broker_id))) {
        return false;
    }
    // Advance past the field to the next separator.
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    // Original-intent binding: intent_id may be empty only on IDLE; symbol
    // and side follow. A non-empty intent requires a valid symbol and side.
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
    if (nd2 == 0 || *p != ':') return false;
    ++p;
    m.last_event_seq = (std::uint64_t)es;
    // Exit sub-identity counter: single digit 0..9, then ':'.
    if (p[0] < '0' || p[0] > '9' || p[1] != ':') return false;
    m.exit_attempt = (std::uint8_t)(p[0] - '0');
    p += 2;
    // Cumulative exit totals: two bounded ints, then NUL.
    long long ec = 0;
    int nd3 = 0;
    while (*p >= '0' && *p <= '9' && nd3 < 9) {
        ec = ec * 10 + (*p - '0');
        ++p;
        ++nd3;
    }
    if (nd3 == 0 || *p != ':') return false;
    ++p;
    long long en = 0;
    int nd4 = 0;
    while (*p >= '0' && *p <= '9' && nd4 < 9) {
        en = en * 10 + (*p - '0');
        ++p;
        ++nd4;
    }
    if (nd4 == 0 || *p != '\0') return false;
    m.exit_closed_qty = (std::int64_t)ec;
    m.exit_counted_qty = (std::int64_t)en;
    // Binding coherence: non-IDLE requires the full binding, IDLE none.
    bool idle = (m.state == RouteState::IDLE);
    if (!idle && (!has_iid || !has_sym)) return false;
    if (idle && (has_iid || has_sym)) return false;
    *out = m;
    return true;
}

}  // namespace exec
}  // namespace jev
