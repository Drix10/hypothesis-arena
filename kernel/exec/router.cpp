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
                // Rejected entry: journal the cancel, terminal.
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:entry-rejected";
                return o;
            }
            if (obs.adapter_responded && obs.ack.accepted &&
                !obs.ack.protection_accepted) {
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
            if (!q.transport_ok) {
                // Lookup itself failed (not "order absent"): re-issue
                // the lookup under the same identity. This is query
                // reconcile, not a second send — the send happened
                // once upstream and no entry path exists from here.
                o.action = RouteAction::QUERY_ONCE;
                o.reason = "exec:query-retry";
                return o;
            }
            if (q.found) Copy64(o.next.broker_id, q.broker_order_id);
            if (q.found && q.cancelled && q.filled_qty == 0) {
                // Already dead, nothing filled: straight to terminal.
                o.next.filled_qty = 0;
                o.action = RouteAction::JOURNAL_CANCEL;
                o.next.state = RouteState::CANCELLED;
                o.journal_kind = "cancel";
                o.reason = "exec:already-cancelled";
                return o;
            }
            if (!q.found || q.filled_qty == 0) {
                // Nothing (that we can see) filled: cancel, confirm,
                // journal. Reconcile-first: the query already happened;
                // a second send from this state is unrepresentable.
                o.next.filled_qty = 0;
                o.action = RouteAction::CANCEL_REMAINDER;
                o.next.state = RouteState::CANCEL_SENT;
                o.reason = "exec:nothing-filled";
                return o;
            }
            if (q.protection_active) o.next.protection_ok = true;
            o.next.filled_qty = q.filled_qty;
            if (q.protection_active) {
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
            // "filled"). Silence (responded, neither flag) means the
            // confirmation is not yet observed -> re-check, never
            // UNKNOWN (UNKNOWN needs a positive failure). Freeze new
            // orders for the symbol; reconcile per S2 with protection
            // first. The freeze is caller-owned state.
            if (!obs.cancel_failed) {
                o.action = RouteAction::CONFIRM_CANCELLED;
                o.reason = "exec:confirm-cancel";
                return o;
            }
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
// Fixed snapshot: "H1:<state>:<kind>:<filled>:<emg>:<pok>:<cid>:<bid>"
// client id is lowercase-hex-or-empty; broker id is the venue UUID
// grammar (or empty); both bounded and validated.
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
// Broker UUID grammar (the venue's actual identifier shape): exactly
// 8-4-4-4-12 lowercase hex with hyphens (36 chars), or empty (no UUID
// observed yet). Anything else fails closed. A hex-only validator
// would reject every real broker ID on the crash path (UUIDs contain
// hyphens); a loose validator would admit garbage.
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
    if (s[36] != '\0' && s[36] != ':') return false;  // trailing garbage
    dst[36] = '\0';
    return true;
}
}  // namespace

bool SnapshotMachine(const RouteMachine& m, char* out, std::size_t n) {
    if (!out || n < 16) return false;
    int st = static_cast<int>(m.state);
    int kd = (m.kind == risk::IntentKind::EXIT) ? 1 : 0;
    if (st < 0 || st > 12 || m.filled_qty < 0 || m.filled_qty > 999999999)
        return false;
    // Writer-side strictness: refuse to persist a machine whose ids
    // cannot be restored (garbage in storage is a crash-path lie).
    char cid[65], bid[64];
    if (!IsHexEmpty(m.client_id, 64, cid, sizeof(cid))) return false;
    if (!IsUuidField(m.broker_id, bid, sizeof(bid))) return false;
    int w = std::snprintf(out, n, "H1:%d:%d:%lld:%d:%d:%s:%s", st, kd,
                          (long long)m.filled_qty,
                          m.emergency ? 1 : 0,
                          m.protection_ok ? 1 : 0, m.client_id,
                          m.broker_id);
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
    p += 4;
    RouteMachine m;
    m.state = static_cast<RouteState>(st);
    m.kind = (kd == 1) ? risk::IntentKind::EXIT : risk::IntentKind::ENTRY;
    m.filled_qty = (std::int64_t)fq;
    m.emergency = (emg == 1);
    m.protection_ok = (pok == 1);
    if (!IsHexEmpty(p, 64, m.client_id, sizeof(m.client_id)))
        return false;
    while (*p != '\0' && *p != ':') ++p;
    if (*p != ':') return false;
    ++p;
    if (!IsUuidField(p, m.broker_id, sizeof(m.broker_id)))
        return false;
    // IsUuidField stops at ':' or NUL; anything after the field must
    // be the terminal NUL (no trailing garbage).
    const char* e = p;
    while (*e != '\0' && *e != ':') ++e;
    if (*e != '\0') return false;
    *out = m;
    return true;
}

}  // namespace exec
}  // namespace jev
