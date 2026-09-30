// Alpaca paper adapter over the injected transport; every method fails
// closed without one. Endpoints (paper Trading API): POST /v2/orders
// (bracket/OCO/market), GET /v2/orders:by_client_order_id?client_order_id=
// (lookup), DELETE /v2/orders/{order_id} (cancel by broker UUID). Bodies are
// hand-assembled and parsing is needle-in-haystack over bounded buffers (no
// JSON library in the kernel).
#include "alpaca_paper.hpp"

#include <cstring>

namespace jev {
namespace broker {

namespace {
// Copies a NUL-terminated field into a fixed buffer; false when the source is
// missing or would overflow.
bool CopyField(const char* src, char* dst, std::size_t n) {
    if (!src || !dst || n == 0) return false;
    std::size_t i = 0;
    while (src[i] != '\0') {
        if (i + 1 >= n) return false;
        dst[i] = src[i];
        ++i;
    }
    dst[i] = '\0';
    return i > 0;
}
// True when the bounded body contains the needle.
bool Contains(const char* body, const char* needle) {
    if (!body || !needle || !needle[0]) return false;
    for (const char* p = body; *p; ++p) {
        const char* a = p;
        const char* b = needle;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (!*b) return true;
    }
    return false;
}
// Extracts the first quoted string value for "key":"..." into out; false when
// absent, unterminated or overflowing.
bool ExtractQuoted(const char* body, const char* key, char* out,
                   std::size_t n) {
    if (!body || !key || !out || n == 0) return false;
    char needle[64];
    std::size_t k = 0;
    needle[k++] = '"';
    while (key[k - 1] != '\0' && k < 60) {
        needle[k] = key[k - 1];
        ++k;
    }
    if (key[k - 1] != '\0') return false;
    needle[k++] = '"';
    needle[k++] = ':';
    needle[k++] = '"';
    needle[k] = '\0';
    for (const char* p = body; *p; ++p) {
        const char* a = p;
        const char* b = needle;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*b) continue;
        std::size_t i = 0;
        while (a[i] != '\0' && a[i] != '"') {
            if (i + 1 >= n) return false;
            out[i] = a[i];
            ++i;
        }
        if (a[i] != '"') return false;
        out[i] = '\0';
        return i > 0;
    }
    return false;
}
void FormatCents(char* dst, std::size_t n, std::int64_t cents) {
    std::snprintf(dst, n, "%lld.%02lld", (long long)(cents / 100),
                  (long long)(cents % 100));
}
// Strict filled-qty: required for an authoritative order observation,
// exactly "filled_qty":"<digits>" (1-18 digits, closing quote). Missing,
// non-numeric, negative or overlong -> -1 (malformed: reconcile, never zero).
std::int64_t StrictQty(const char* body) {
    if (!body) return -1;
    const char* needle = "\"filled_qty\":\"";
    for (const char* p = body; *p; ++p) {
        const char* a = p;
        const char* b = needle;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*b) continue;
        long long v = 0;
        int digits = 0;
        while (*a >= '0' && *a <= '9') {
            if (digits >= 18) return -1;  // overflow/truncation
            v = v * 10 + (*a - '0');
            ++a;
            ++digits;
        }
        if (digits == 0 || *a != '"') return -1;
        return (std::int64_t)v;
    }
    return -1;  // field absent
}
// Normalized order-status classifier (P1-1): maps the venue status onto the
// close lifecycle for EXIT reconciliation (replaced/done_for_day/suspended
// etc. are not collapsed into generic found+qty). Order statuses are
// "filled" / "partially_filled"; bare "fill" and "partial_fill" are
// trade-event names -> UNKNOWN.
CloseState ClassifyStatus(const char* st) {
    if (!st || !st[0]) return CloseState::UNKNOWN;
    // Quarantine override first (doc 06): these words never route as their
    // table state, in either direction: not DEAD (a resumed order or a live
    // replacement id would meet a duplicate close) and not PENDING-forever
    // (calculated is done-for-today). UNKNOWN waits: reconcile, never mint.
    // Manual loop to match file style (no <cstring here).
    const char* const quar[] = {"done_for_day", "calculated",
                                "replaced"};
    for (int w = 0; w < 3; ++w) {
        const char* b = quar[w];
        const char* a = st;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*a == '\0' && *b == '\0')
            return CloseState::UNKNOWN;
    }
    // Lifecycle policy (Alpaca order status + trade-event vocabulary):
    // PENDING = alive or unknown-live (wait/reconcile; the stable-id
    // pre-flight dedupes); DEAD = terminally non-executing under this id;
    // UNKNOWN = event-only names or unrecognized.
    //   held, pending_replace, pending_cancel, restated, suspended, stopped,
    //   accepted_for_bidding -> PENDING (live or may resume; never re-issue
    //   blind, the pre-flight finds the order under our id);
    //   order_replace_rejected / order_cancel_rejected -> PENDING (the order
    //   survives the rejected request);
    //   done_for_day / calculated / replaced -> UNKNOWN (the quarantine set,
    //   doc 06: may resume tomorrow / unknown replacement id may be live; the
    //   runner freezes the symbol off status_raw on first sighting);
    //   canceled / expired / rejected -> DEAD (nothing live can duplicate
    //   them; the burned-id remainder path applies).
    const char* const pending[] = {
        "accepted",      "pending_new",  "new",
        "held",         "pending_replace",
        "pending_cancel", "suspended",    "restated",
        "order_replace_rejected", "order_cancel_rejected",
        "stopped", "accepted_for_bidding"};
    const char* const dead[] = {"canceled", "rejected", "expired"};
    for (int w = 0; w < 12; ++w) {
        const char* b = pending[w];
        const char* a = st;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*a == '\0' && *b == '\0')
            return CloseState::PENDING;
    }
    // exact terminal words (manual loop: no <cstring here).
    const char* const term[] = {"filled", "partially_filled"};
    for (int w = 0; w < 2; ++w) {
        const char* b = term[w];
        const char* a = st;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*a == '\0' && *b == '\0')
            return (w == 0) ? CloseState::FILLED
                            : CloseState::PARTIAL;
    }
    for (int w = 0; w < 3; ++w) {
        const char* b = dead[w];
        const char* a = st;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*a == '\0' && *b == '\0')
            return CloseState::DEAD;
    }
    return CloseState::UNKNOWN;
}
// Bracket held as a unit: order_class bracket + TP/SL object fields + the
// exact unexpanded representation ("legs":null). Expanded legs defer to the
// strict legs rule (protection_active). Omitted or malformed legs ({},
// string, bool, [], ...) are neither: only the documented nullable shape
// evidences held-as-unit.
bool BracketHeld(const char* body) {
    if (!body) return false;
    if (!Contains(body, "\"order_class\":\"bracket\""))
        return false;
    if (!Contains(body, "\"take_profit\":{") ||
        !Contains(body, "\"stop_loss\":{"))
        return false;
    return Contains(body, "\"legs\":null");
}
// Strict legs proof (P1-4): protection is active only when the reply carries
// a "legs" array of exactly 2 top-level leg objects, each with its own
// distinct non-empty "id", exactly one TP-shaped ("type":"limit") and
// exactly one SL-shaped ("type":"stop" or "stop_limit"), and the order
// declares both take_profit and stop_loss. Roles bind by venue type, not by
// co-located markers; duplicate ids or roles, 1- or 3-leg arrays and
// unbalanced or non-array legs give false. String-aware bracket matching;
// bounded and allocation-free.
//
// Shapes (single query, no hidden second lookup): submit ack = POST
// /v2/orders bracket response with legs populated; reconcile = GET
// /v2/orders:by_client_order_id (no nested param is documented, so legs are
// trusted only when strictly proven; absence routes to repair).
bool LegsProtected(const char* body) {
    if (!body) return false;
    const char* key = "\"legs\":";
    const char* arr = nullptr;
    for (const char* p = body; *p; ++p) {
        const char* a = p;
        const char* b = key;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (!*b) {
            arr = a;
            break;
        }
    }
    if (!arr) return false;
    while (*arr == ' ' || *arr == '\t' || *arr == '\n' ||
           *arr == '\r')
        ++arr;
    if (*arr != '[') return false;
    const char* q = arr + 1;
    int depth = 1;
    bool in_str = false;
    while (*q && depth > 0) {
        if (in_str) {
            if (*q == '\\' && q[1])
                ++q;
            else if (*q == '"')
                in_str = false;
        } else {
            if (*q == '"')
                in_str = true;
            else if (*q == '[' || *q == '{')
                ++depth;
            else if (*q == ']' || *q == '}')
                --depth;
        }
        ++q;
    }
    if (depth != 0) return false;
    // Split the array into top-level leg objects, each with its own region
    // [start, end). More than 3 legs refuses early (bracket/OCO means 2).
    const char* start[4] = {nullptr, nullptr, nullptr, nullptr};
    const char* stop[4] = {nullptr, nullptr, nullptr, nullptr};
    int nlegs = 0;
    int d = 0;
    in_str = false;
    const char* cur = nullptr;
    for (const char* p = arr; p < q; ++p) {
        if (in_str) {
            if (*p == '\\' && (p + 1) < q)
                ++p;
            else if (*p == '"')
                in_str = false;
            continue;
        }
        if (*p == '"') {
            in_str = true;
            continue;
        }
        if (*p == '{') {
            if (d == 1) {
                if (nlegs >= 4) return false;
                start[nlegs] = p;
                cur = p;
            }
            ++d;
        } else if (*p == '}') {
            --d;
            if (d == 1 && cur) {
                stop[nlegs] = p + 1;
                ++nlegs;
                cur = nullptr;
            }
        } else if (*p == '[') {
            ++d;
        } else if (*p == ']') {
            --d;
        }
    }
    if (in_str || cur) return false;
    if (nlegs != 2) return false;  // exactly the bracket/OCO pair
    // Per-leg roles (bound by venue leg type) + distinct ids.
    char id0[64] = {0};
    char id1[64] = {0};
    int roles = 0;  // bit0 = leg0 TP, bit1 = leg0 SL, bit2 = leg1 TP,
                    // bit3 = leg1 SL
    for (int L = 0; L < 2; ++L) {
        char* idb = (L == 0) ? id0 : id1;
        // First quoted "id":"..." fully inside this leg.
        bool got_id = false;
        for (const char* p = start[L]; p < stop[L] && !got_id; ++p) {
            if (p[0] != '"' || p[1] != 'i' || p[2] != 'd' ||
                p[3] != '"' || p[4] != ':')
                continue;
            const char* v = p + 5;
            while (v < stop[L] && (*v == ' ' || *v == '\t')) ++v;
            if (v >= stop[L] || *v != '"') continue;
            ++v;
            std::size_t n = 0;
            while (v < stop[L] && *v != '"' && n + 1 < sizeof(id0)) {
                idb[n++] = *v++;
            }
            if (v >= stop[L] || *v != '"' || n == 0) continue;
            idb[n] = '\0';
            got_id = true;
        }
        if (!got_id) return false;
        // Role by venue leg type, scanned inside this leg only.
        bool tp = false;
        bool sl = false;
        for (const char* p = start[L]; p < stop[L]; ++p) {
            if (p[0] != '"' || p[1] != 't' || p[2] != 'y' ||
                p[3] != 'p' || p[4] != 'e' || p[5] != '"' ||
                p[6] != ':')
                continue;
            const char* v = p + 7;
            while (v < stop[L] && (*v == ' ' || *v == '\t')) ++v;
            if (v >= stop[L] || *v != '"') continue;
            ++v;
            // TP leg: "limit". SL leg: "stop" or "stop_limit".
            if (v[0] == 'l' && v[1] == 'i' && v[2] == 'm' &&
                v[3] == 'i' && v[4] == 't' && v[5] == '"')
                tp = true;
            else if (v[0] == 's' && v[1] == 't' && v[2] == 'o' &&
                     v[3] == 'p' &&
                     (v[4] == '"' ||
                      (v[4] == '_' && v[5] == 'l' && v[6] == 'i' &&
                       v[7] == 'm' && v[8] == 'i' && v[9] == 't' &&
                       v[10] == '"')))
                sl = true;
        }
        if (tp && !sl)
            roles |= (L == 0) ? 1 : 4;
        else if (sl && !tp)
            roles |= (L == 0) ? 2 : 8;
        else
            return false;  // untyped leg, or a both/neither leg
    }
    if (id0[0] == '\0' || id1[0] == '\0') return false;
    bool same = true;
    for (int i = 0; id0[i] || id1[i]; ++i)
        if (id0[i] != id1[i]) same = false;
    if (same) return false;  // duplicate leg ids
    // Exactly one TP leg and one SL leg. The venue reply carries no
    // order-level take_profit/stop_loss objects (verified against the live
    // paper API); the two typed legs are the proof.
    if (roles != (1 | 8) && roles != (2 | 4)) return false;
    return Contains(body, "\"order_class\":\"bracket\"") ||
           Contains(body, "\"order_class\":\"oco\"");
}

// OTO stop-only proof: order_class oto and a legs array holding exactly one
// leg object, stop-shaped ("stop" or "stop_limit", never a limit leg) with
// its own id. String-aware, bounded.
bool OtoStopProtected(const char* body) {
    if (!body || !Contains(body, "\"order_class\":\"oto\"")) return false;
    const char* key = "\"legs\":";
    const char* arr = nullptr;
    for (const char* p = body; *p && !arr; ++p) {
        const char* a = p;
        const char* b = key;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (!*b) arr = a;
    }
    if (!arr) return false;
    while (*arr == ' ' || *arr == '\t' || *arr == '\n' || *arr == '\r') ++arr;
    if (*arr != '[') return false;
    int depth = 0, legs = 0;
    bool in_str = false;
    const char* leg = nullptr;
    const char* end = nullptr;
    for (const char* p = arr; *p; ++p) {
        if (in_str) {
            if (*p == '\\' && p[1]) ++p;
            else if (*p == '"') in_str = false;
            continue;
        }
        if (*p == '"') in_str = true;
        else if (*p == '[' || *p == '{') {
            if (*p == '{' && depth == 1) {
                if (++legs > 1) return false;
                leg = p;
            }
            ++depth;
        } else if (*p == ']' || *p == '}') {
            --depth;
            if (depth == 0) {
                end = p;
                break;
            }
        }
    }
    if (!end || legs != 1 || !leg) return false;
    bool has_id = false, stop = false, lim = false;
    for (const char* p = leg; p < end; ++p) {
        if (p[0] != '"') continue;
        if (!std::strncmp(p, "\"id\":\"", 6) && p[6] != '"') has_id = true;
        if (!std::strncmp(p, "\"type\":\"stop\"", 13) ||
            !std::strncmp(p, "\"type\":\"stop_limit\"", 19))
            stop = true;
        if (!std::strncmp(p, "\"type\":\"limit\"", 14)) lim = true;
    }
    return has_id && stop && !lim;
}

bool ShapeProtected(const char* body) {
    return LegsProtected(body) || OtoStopProtected(body);
}
}  // namespace

OrderAck AlpacaPaperAdapter::SubmitProtected(
    const ProtectedOrder& o) {
    OrderAck ack;
    ack.reason[0] = '\0';
    // Adapter-side refusal precedes any transport touch: non-positive
    // size/stop/tp never reaches the broker (behind the veto and router).
    bool oto = o.protection == Protection::OTO_STOP;
    if (o.qty_shares <= 0 || o.stop_cents <= 0 ||
        (!oto && o.tp_cents <= 0) || !transport_) {
        const char* r =
            !transport_ ? "transport-unwired" : "bad-spec";
        CopyField(r, ack.reason, sizeof(ack.reason));
        return ack;
    }
    char tp[32], sl[32];
    FormatCents(tp, sizeof(tp), o.tp_cents);
    FormatCents(sl, sizeof(sl), o.stop_cents);
    char body[1024];
    // One bracket order (entry + TP leg + SL leg) or one OTO order (entry +
    // stop leg). The ack must prove every leg or protection is missing.
    int w = oto
        ? std::snprintf(
              body, sizeof(body),
              "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
              "\"type\":\"market\",\"time_in_force\":\"%s\","
              "\"client_order_id\":\"%.64s\",\"order_class\":\"oto\","
              "\"stop_loss\":{\"stop_price\":\"%s\"}}",
              o.symbol, (long long)o.qty_shares,
              o.side == OrderSide::BUY ? "buy" : "sell",
              o.gtc ? "gtc" : "day", o.client_order_id, sl)
        : std::snprintf(
              body, sizeof(body),
              "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
              "\"type\":\"market\",\"time_in_force\":\"%s\","
              "\"client_order_id\":\"%.64s\",\"order_class\":\"bracket\","
              "\"take_profit\":{\"limit_price\":\"%s\"},"
              "\"stop_loss\":{\"stop_price\":\"%s\"}}",
              o.symbol, (long long)o.qty_shares,
              o.side == OrderSide::BUY ? "buy" : "sell",
              o.gtc ? "gtc" : "day", o.client_order_id, tp, sl);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) {
        CopyField("body-overflow", ack.reason, sizeof(ack.reason));
        return ack;
    }
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    // Classified outcomes (P1-7), never collapsed:
    //   400/422 shaped refusal -> authoritative_reject (terminal upstream)
    //   401 -> auth_failure (not a trade rejection; reconcile, then freeze)
    //   403 -> authoritative_reject (buying-power/forbidden: the order is
    //     dead, not an auth outage)
    //   429 -> rate_limited (reconcile via the same query path)
    //   2xx + order id -> accepted (UUID captured below; protection per legs)
    //   anything else (other 4xx, 5xx, transport failure, malformed 2xx) ->
    //     ambiguous: the router reconciles under the same ID.
    if (r.status == 401) {
        ack.auth_failure = true;
        CopyField("auth-failure", ack.reason, sizeof(ack.reason));
        return ack;
    }
    if (r.status == 429) {
        ack.rate_limited = true;
        CopyField("rate-limited", ack.reason, sizeof(ack.reason));
        return ack;
    }
    if (r.status == 400 || r.status == 422 || r.status == 403) {
        ack.authoritative_reject = true;
        const char* why =
            (r.status == 403) ? "buying-power" : "broker-reject";
        CopyField(why, ack.reason, sizeof(ack.reason));
        return ack;
    }
    if (r.status < 200 || r.status >= 300 ||
        !Contains(r.body, "\"id\"")) {
        CopyField("transport-unknown", ack.reason,
                  sizeof(ack.reason));
        return ack;
    }
    ack.transport_ok = true;
    ack.accepted = true;
    // The accepted POST returns the broker UUID (P0-3), which the router
    // persists before any cancel path. No id -> ambiguous (the query by
    // client ID resolves it).
    if (!ExtractQuoted(r.body, "id", ack.broker_order_id,
                       sizeof(ack.broker_order_id))) {
        ack.transport_ok = false;
        ack.accepted = false;
        CopyField("transport-unknown", ack.reason,
                  sizeof(ack.reason));
        return ack;
    }
    // POST filled quantity is strict (P0-1), same grammar as the query path.
    // Missing/malformed -> ambiguous (the reconcile query establishes fills;
    // a silent zero would route a filled order down the cancel path).
    std::int64_t pfq = StrictQty(r.body);
    if (pfq < 0) {
        ack.transport_ok = false;
        ack.accepted = false;
        ack.broker_order_id[0] = '\0';
        CopyField("transport-unknown", ack.reason,
                  sizeof(ack.reason));
        return ack;
    }
    ack.filled_qty = pfq;
    // Protection is accepted only when the reply proves every leg via the
    // strict legs rule (P0-3).
    ack.protection_accepted = ack.accepted && ShapeProtected(r.body);
    if (ack.accepted && !ack.protection_accepted)
        CopyField("protection-missing", ack.reason,
                  sizeof(ack.reason));
    return ack;
}

OrderQuery AlpacaPaperAdapter::QueryOnce(
    const char client_order_id[65]) {
    OrderQuery q;
    q.broker_order_id[0] = '\0';
    if (!transport_ || !client_order_id || !client_order_id[0])
        return q;
    char path[160];
    int w = std::snprintf(
        path, sizeof(path),
        "/v2/orders:by_client_order_id?client_order_id=%.64s",
        client_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(path))) return q;
    HttpRequest req;
    req.method = "GET";
    req.path = path;
    req.body = "";
    HttpResult r = transport_(req);
    q.broker_status = r.status;
    // Outcomes:
    //   404 -> authoritative absent (no UUID, no DELETE; router terminals)
    //   2xx + valid UUID + strict qty -> found (protection per the legs rule,
    //     or held-as-unit when legs are unexpanded)
    //   2xx malformed (bad id / bad qty) -> unknown (reconcile)
    //   401 -> auth_failure (never "absent")
    //   429 -> rate_limited (reconcile, never terminal)
    //   other 4xx / 5xx / transport failure -> unknown.
    if (r.status == 404) {
        q.transport_ok = true;
        return q;
    }
    if (r.status == 401) {
        q.auth_failure = true;
        return q;
    }
    if (r.status == 429) {
        q.rate_limited = true;
        return q;
    }
    if (r.status < 200 || r.status >= 300) return q;
    // UUID grammar is enforced on query too (P0-3): an unvalidated id never
    // reaches DELETE. Bad id -> unknown, not "absent".
    char oid[64] = {};
    if (!ExtractQuoted(r.body, "id", oid, sizeof(oid)) ||
        !IsBrokerUuid(oid))
        return q;
    // filled_qty is required and strict (P1-6).
    std::int64_t fq = StrictQty(r.body);
    if (fq < 0) return q;
    CopyField(oid, q.broker_order_id, sizeof(q.broker_order_id));
    q.transport_ok = true;
    q.found = true;
    q.filled_qty = fq;
    q.cancelled = Contains(r.body, "\"canceled\"") ||
                  Contains(r.body, "\"cancelled\"");
    // Normalized status for exit reconciliation (P1-1). Zero-init: fixed-offset
    // reads below must not touch indeterminate bytes on short statuses.
    char qs[32] = {};
    if (ExtractQuoted(r.body, "status", qs, sizeof(qs))) {
        // Verbatim word for the runner quarantine (doc 06): the normalized
        // state cannot tell done_for_day / calculated / replaced from DEAD.
        CopyField(qs, q.status_raw, sizeof(q.status_raw));
        q.close_state = ClassifyStatus(qs);
    }
    q.protection_active = ShapeProtected(r.body);
    q.bracket_class = BracketHeld(r.body);
    return q;
}

CancelResult AlpacaPaperAdapter::Cancel(
    const char broker_order_id[64]) {
    CancelResult c;
    if (!transport_ || !broker_order_id || !broker_order_id[0])
        return c;
    // Boundary validation (P1-2): malformed or path-like IDs never touch the
    // transport.
    if (!IsBrokerUuid(broker_order_id)) return c;
    // Cancel: DELETE by broker UUID (from the single QueryOnce lookup; the
    // adapter keeps no hidden lookup state).
    char path[160];
    int w = std::snprintf(path, sizeof(path), "/v2/orders/%.63s",
                          broker_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(path))) return c;
    HttpRequest req;
    req.method = "DELETE";
    req.path = path;
    req.body = "";
    HttpResult r = transport_(req);
    // 204 = cancel request accepted (P1-8); terminal needs an explicit
    // final-canceled observation. Other 2xx need the id marker. Explicit 422 =
    // refused (failed). Anything else: neither (caller re-checks).
    if (r.status == 204) {
        c.accepted = true;
        return c;
    }
    if (r.status == 422) {
        c.failed = true;
        return c;
    }
    c.accepted =
        (r.status >= 200 && r.status < 300) && Contains(r.body, "\"id\"");
    return c;
}

CloseResult AlpacaPaperAdapter::MarketClose(const char* symbol,
                                            std::int64_t qty_shares,
                                            OrderSide side,
                                            const char client_order_id[65]) {
    return PostClose(symbol, qty_shares, side, client_order_id, "day");
}

CloseResult AlpacaPaperAdapter::CloseAtClose(const char* symbol,
                                             std::int64_t qty_shares,
                                             OrderSide side,
                                             const char client_order_id[65]) {
    return PostClose(symbol, qty_shares, side, client_order_id, "cls");
}

CloseResult AlpacaPaperAdapter::PostClose(const char* symbol,
                                          std::int64_t qty_shares,
                                          OrderSide side,
                                          const char client_order_id[65],
                                          const char* tif) {
    CloseResult c;
    if (!transport_ || !symbol || !symbol[0] || qty_shares <= 0 ||
        !client_order_id || !client_order_id[0])
        return c;
    // Exit carries the machine's stable client identity (P0-5): an ambiguous
    // close reconciles by this ID, never re-sends blind.
    char body[640];
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"market\",\"time_in_force\":\"%s\","
        "\"client_order_id\":\"%.64s\"}",
        symbol, (long long)qty_shares,
        side == OrderSide::BUY ? "buy" : "sell", tif, client_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return c;
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    // Close lifecycle (P0-2): 2xx + UUID only proves the close order exists.
    // fill -> executed (full); partial -> reconcile remainder; pending ->
    // wait (never CLOSED); dead -> definitive non-execution; anything else or
    // malformed qty -> unknown.
    if (r.status < 200 || r.status >= 300) return c;
    char oid[64] = {};
    if (!ExtractQuoted(r.body, "id", oid, sizeof(oid)) ||
        !IsBrokerUuid(oid))
        return c;
    // Zero-init: fixed-offset reads below (st[6]/st[16]/...) must be defined
    // for short statuses like "new"; every compare is length-checked against
    // its literal.
    char st[32] = {};
    if (!ExtractQuoted(r.body, "status", st, sizeof(st))) return c;
    bool fill = true;
    const char* want = "filled";
    for (int i = 0; want[i]; ++i)
        if (st[i] != want[i]) fill = false;
    if (st[6] != '\0') fill = false;
    // Order-status truth: only "partially_filled" is PARTIAL; "partial_fill"
    // is a trade-event name -> unknown.
    bool partial = false;
    if (!fill) {
        const char* p2 = "partially_filled";
        bool m2 = true;
        for (int i = 0; p2[i]; ++i)
            if (st[i] != p2[i]) m2 = false;
        if (st[16] != '\0') m2 = false;
        partial = m2;
    }
    bool pending = false;
    bool dead = false;
    if (!fill && !partial) {
        // ClassifyStatus owns the lifecycle vocabulary: PENDING = alive,
        // DEAD = terminal under this id; anything else stays unknown.
        CloseState cs = ClassifyStatus(st);
        pending = (cs == CloseState::PENDING);
        dead = (cs == CloseState::DEAD);
    }
    if (!fill && !partial && !pending && !dead) return c;  // unknown
    CopyField(oid, c.broker_order_id, sizeof(c.broker_order_id));
    c.transport_ok = true;
    if (dead) {
        // DEAD keeps the authoritative cumulative quantity (a canceled close
        // may have partially filled). Missing/malformed -> UNKNOWN; assuming
        // zero would overshoot recovery.
        std::int64_t dq = StrictQty(r.body);
        if (dq < 0) {
            c.transport_ok = false;
            c.broker_order_id[0] = '\0';
            return c;
        }
        c.filled_qty = dq;
        c.state = CloseState::DEAD;
        return c;
    }
    if (pending) {
        c.state = CloseState::PENDING;
        return c;
    }
    // FILLED/PARTIAL carry an authoritative quantity (strict).
    std::int64_t cfq = StrictQty(r.body);
    if (cfq < 0) {
        c.transport_ok = false;
        c.broker_order_id[0] = '\0';
        return c;
    }
    c.filled_qty = cfq;
    if (partial) {
        c.state = CloseState::PARTIAL;
        return c;
    }
    c.state = CloseState::FILLED;
    c.executed = true;
    return c;
}

bool AlpacaPaperAdapter::EstablishProtection(
    const ProtectedOrder& o) {
    // Recovery-only repair: attach an OCO protection pair to an
    // already-acknowledged position. OCO legs are LIMIT orders (market OCO is
    // invalid): TP limit at tp, stop leg as stop-limit with the limit 2%
    // past the stop (integer cents). A long's protection sells with
    // tp > stop; a short's buys with stop > tp. True = both legs acked.
    if (!transport_ || o.qty_shares <= 0 || o.stop_cents <= 0) return false;
    bool is_long = (o.side == OrderSide::BUY);
    if (o.protection == Protection::OTO_STOP) {
        // Stop-only shape: a plain stop order opposing the position.
        char sl1[32];
        FormatCents(sl1, sizeof(sl1), o.stop_cents);
        char b1[512];
        int w1 = std::snprintf(
            b1, sizeof(b1),
            "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
            "\"type\":\"stop\",\"time_in_force\":\"%s\","
            "\"client_order_id\":\"%.64s\",\"stop_price\":\"%s\"}",
            o.symbol, (long long)o.qty_shares, is_long ? "sell" : "buy",
            o.gtc ? "gtc" : "day", o.client_order_id, sl1);
        if (w1 <= 0 || w1 >= static_cast<int>(sizeof(b1))) return false;
        HttpRequest rq;
        rq.method = "POST";
        rq.path = "/v2/orders";
        rq.body = b1;
        HttpResult rr = transport_(rq);
        return rr.status >= 200 && rr.status < 300 &&
               Contains(rr.body, "\"type\":\"stop\"") &&
               Contains(rr.body, "\"id\"");
    }
    if (o.tp_cents <= 0) return false;
    if (is_long && !(o.tp_cents > o.stop_cents)) return false;
    if (!is_long && !(o.stop_cents > o.tp_cents)) return false;
    char tp[32], sl[32], sll[32];
    FormatCents(tp, sizeof(tp), o.tp_cents);
    FormatCents(sl, sizeof(sl), o.stop_cents);
    // The stop leg is a stop-limit. A limit equal to the stop never fills on
    // a gap through the stop, so allow 2% of slippage past it (for a long the
    // limit sits below the stop, for a short above).
    std::int64_t slip = o.stop_cents / 50;
    if (slip < 1) slip = 1;
    std::int64_t lim = is_long ? o.stop_cents - slip : o.stop_cents + slip;
    if (lim < 1) lim = 1;
    FormatCents(sll, sizeof(sll), lim);
    char body[768];
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"limit\",\"time_in_force\":\"%s\","
        "\"client_order_id\":\"%.64s\",\"order_class\":\"oco\","
        "\"take_profit\":{\"limit_price\":\"%s\"},"
        "\"stop_loss\":{\"stop_price\":\"%s\",\"limit_price\":\"%s\"}}",
        o.symbol, (long long)o.qty_shares,
        is_long ? "sell" : "buy",  // protection opposes the position
        o.gtc ? "gtc" : "day", o.client_order_id, tp, sl, sll);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return false;
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    // The OCO reply proves both legs via the same strict legs rule.
    return (r.status >= 200 && r.status < 300) &&
           LegsProtected(r.body);
}

}  // namespace broker
}  // namespace jev
