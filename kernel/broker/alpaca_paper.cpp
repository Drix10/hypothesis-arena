// H1 — Alpaca paper adapter over the injected transport. Every method
// fails closed without a transport (Phase 4 wires live HTTPS; H1 proves
// request shape + ack mapping against fakes). Endpoint shapes follow the
// current paper Trading API: POST /v2/orders (bracket/OCO/market),
// GET /v2/orders:by_client_order_id?client_order_id= (lookup),
// DELETE /v2/orders/{order_id} (cancel by broker UUID). Bodies are
// bounded and hand-assembled (no JSON library in the kernel); parsing
// is needle-in-haystack over bounded buffers, never a general parser.
#include "alpaca_paper.hpp"

namespace jev {
namespace broker {

namespace {
// Copies a NUL-terminated field into a fixed buffer; false when the
// source is missing or would overflow (fail-closed input shaping).
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
// True when the bounded body contains the needle (exact substring).
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
// Extracts the first quoted string value for "key":"..." into out.
// False when absent, unterminated, or overflowing (never partial).
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
// Strict filled-qty: the field is REQUIRED for an authoritative
// order observation, exactly "filled_qty":"<digits>" (1-18 digits,
// closing quote). Missing/non-numeric/negative/overlong -> -1
// (malformed: unknown/reconcile, never silent zero).
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
// Bracket-held-as-unit (P0-1 constructive proof): order_class
// bracket + TP/SL object fields + legs null-or-absent (unexpanded,
// never "protection absent"). Legs expanded -> the strict legs rule
// decides instead (protection_active).
bool BracketHeld(const char* body) {
    if (!body) return false;
    if (!Contains(body, "\"order_class\":\"bracket\""))
        return false;
    if (!Contains(body, "\"take_profit\":{") ||
        !Contains(body, "\"stop_loss\":{"))
        return false;
    // Legs expanded -> strict proof owns the verdict, not this.
    if (Contains(body, "\"legs\":[")) return false;
    return true;
}
// Strict legs proof (P1-4): protection is active ONLY when the reply
// carries a "legs" ARRAY of EXACTLY 2 top-level leg objects where
// each leg carries its own distinct non-empty "id", exactly one leg
// is TP-shaped ("type":"limit") and exactly one is SL-shaped
// ("type":"stop" or "type":"stop_limit"), and the order declares
// both take_profit and stop_loss. Roles bind to legs by venue type,
// never by co-located markers: duplicate ids, duplicate roles,
// 1-leg or 3-leg arrays, unbalanced or non-array legs -> false
// (unknown, never active). String-aware bracket matching; bounded
// and allocation-free (two fixed id buffers).
//
// Authoritative shapes (P0-2, single query, no hidden second lookup):
//   submit ack  = POST /v2/orders bracket response (the venue returns
//                 the created bracket with its legs populated);
//   reconcile   = GET /v2/orders:by_client_order_id Order entity
//                 (?client_order_id only — no nested param is
//                 documented there, so legs are trusted ONLY when
//                 strictly proven; absence routes to the repair path,
//                 never to an assumed-protected state).
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
    // Split the array into its top-level leg objects; each leg gets
    // its own region [start, end). More than 3 legs refuses early
    // (bracket/OCO means exactly 2; anything else is not our shape).
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
    int roles = 0;  // bit0 = leg0 TP, bit1 = leg0 SL,
                    // bit2 = leg1 TP, bit3 = leg1 SL
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
    // Exactly one TP leg and one SL leg, plus the order-level
    // declared protections as real FIELDS (order_class bracket/oco +
    // take_profit/stop_loss objects — never bare substrings).
    if (roles != (1 | 8) && roles != (2 | 4)) return false;
    bool bracket =
        Contains(body, "\"order_class\":\"bracket\"") ||
        Contains(body, "\"order_class\":\"oco\"");
    return bracket && Contains(body, "\"take_profit\":{") &&
           Contains(body, "\"stop_loss\":{");
}
}  // namespace

OrderAck AlpacaPaperAdapter::SubmitProtected(
    const ProtectedOrder& o) {
    OrderAck ack;
    ack.reason[0] = '\0';
    // Adapter-side refusal precedes any transport touch: non-positive
    // size/stop/tp never reaches the broker (defense in depth behind
    // the veto; the router also refuses these).
    if (o.qty_shares <= 0 || o.stop_cents <= 0 || o.tp_cents <= 0 ||
        !transport_) {
        const char* r =
            !transport_ ? "transport-unwired" : "bad-spec";
        CopyField(r, ack.reason, sizeof(ack.reason));
        return ack;
    }
    char tp[32], sl[32];
    FormatCents(tp, sizeof(tp), o.tp_cents);
    FormatCents(sl, sizeof(sl), o.stop_cents);
    char body[1024];
    // One bracket order: entry + take-profit leg + stop-loss leg. The
    // ack must confirm ALL legs (see below) or protection is missing.
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"market\",\"time_in_force\":\"day\","
        "\"client_order_id\":\"%.64s\",\"order_class\":\"bracket\","
        "\"take_profit\":{\"limit_price\":\"%s\"},"
        "\"stop_loss\":{\"stop_price\":\"%s\"}}",
        o.symbol, (long long)o.qty_shares,
        o.side == OrderSide::BUY ? "buy" : "sell", o.client_order_id,
        tp, sl);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) {
        CopyField("body-overflow", ack.reason, sizeof(ack.reason));
        return ack;
    }
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    // Classified outcomes, never collapsed (P1-7):
    //   400/422 shaped refusal -> authoritative_reject (permanent
    //     input refusal: terminal upstream)
    //   401                -> auth_failure (credentials dead: never
    //     a trade rejection; reconcile, then freeze)
    //   403                -> authoritative_reject (buying-power/
    //     forbidden order request per the order API: the ORDER is
    //     dead, never an auth-outage classification)
    //   429                -> rate_limited (throttled: reconcile via
    //     the same query path, never terminal)
    //   2xx + order id    -> accepted (UUID captured below;
    //     protection per legs)
    //   anything else (other 4xx, 5xx, transport failure, malformed
    //     2xx) -> ambiguous: accepted=false with no authority flag
    //     (the router reconciles under the same ID).
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
    // The accepted POST returns the broker UUID (P0-3): the router
    // persists it before any cancel path. No id -> ambiguous (the
    // query by client ID resolves it; never cancel blind).
    if (!ExtractQuoted(r.body, "id", ack.broker_order_id,
                       sizeof(ack.broker_order_id))) {
        ack.transport_ok = false;
        ack.accepted = false;
        CopyField("transport-unknown", ack.reason,
                  sizeof(ack.reason));
        return ack;
    }
    // Protection is accepted ONLY when the reply proves every leg of
    // the bracket via the strict legs rule (P0-3).
    ack.protection_accepted = ack.accepted && LegsProtected(r.body);
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
    // Outcomes (P0-1/P0-3/P1-6/P1-7):
    //   404              -> authoritative absent (no UUID, no DELETE;
    //                         the router terminals directly)
    //   2xx + valid UUID + strict qty -> found (protection per the
    //     legs rule, or bracket-held-as-unit when legs unexpanded)
    //   2xx malformed (bad id / bad qty) -> unknown (reconcile)
    //   401              -> auth_failure (never "absent")
    //   429              -> rate_limited (reconcile, never terminal)
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
    // UUID grammar enforced on QUERY too (P0-3): an unvalidated id
    // must never reach DELETE. Bad id -> unknown, never "absent".
    char oid[64];
    if (!ExtractQuoted(r.body, "id", oid, sizeof(oid)) ||
        !IsBrokerUuid(oid))
        return q;
    // filled_qty is REQUIRED and strict (P1-6): malformed qty is
    // unknown/reconcile, never silent zero.
    std::int64_t fq = StrictQty(r.body);
    if (fq < 0) return q;
    CopyField(oid, q.broker_order_id, sizeof(q.broker_order_id));
    q.transport_ok = true;
    q.found = true;
    q.filled_qty = fq;
    q.cancelled = Contains(r.body, "\"canceled\"") ||
                  Contains(r.body, "\"cancelled\"");
    q.protection_active = LegsProtected(r.body);
    q.bracket_class = BracketHeld(r.body);
    return q;
}

CancelResult AlpacaPaperAdapter::Cancel(
    const char broker_order_id[64]) {
    CancelResult c;
    if (!transport_ || !broker_order_id || !broker_order_id[0])
        return c;
    // Real cancel path: DELETE by broker UUID (resolved by the single
    // QueryOnce lookup; the adapter keeps no hidden lookup state, so
    // restart determinism is preserved).
    char path[160];
    int w = std::snprintf(path, sizeof(path), "/v2/orders/%.63s",
                          broker_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(path))) return c;
    HttpRequest req;
    req.method = "DELETE";
    req.path = path;
    req.body = "";
    HttpResult r = transport_(req);
    // 204 = cancel REQUEST accepted (P1-8): the order may still be
    // pending_cancel — terminal needs an explicit final-canceled
    // observation (never a bare 204). Other 2xx need the id marker.
    // Explicit 422 = cancel refused (failed). Anything else:
    // neither (caller re-checks).
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
    CloseResult c;
    if (!transport_ || !symbol || !symbol[0] || qty_shares <= 0 ||
        !client_order_id || !client_order_id[0])
        return c;
    // Exit carries the machine's stable client identity (P0-5): one
    // intent, one ID — an ambiguous close reconciles by this ID,
    // never re-sends blind, never double-closes.
    char body[640];
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"market\",\"time_in_force\":\"day\","
        "\"client_order_id\":\"%.64s\"}",
        symbol, (long long)qty_shares,
        side == OrderSide::BUY ? "buy" : "sell", client_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return c;
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    // Ambiguous (non-2xx / id-less 2xx) stays transport_not_ok:
    // the caller reconciles by client ID before any second send.
    if (r.status < 200 || r.status >= 300) return c;
    char oid[64];
    if (!ExtractQuoted(r.body, "id", oid, sizeof(oid)) ||
        !IsBrokerUuid(oid))
        return c;
    CopyField(oid, c.broker_order_id, sizeof(c.broker_order_id));
    c.transport_ok = true;
    c.executed = true;
    // executed-without-fill-quantity is STILL executed (a market
    // close fills immediately or not at all; the reconcile query
    // confirms fills, and 404/absent routes back to re-issue).
    return c;
}

bool AlpacaPaperAdapter::EstablishProtection(
    const ProtectedOrder& o) {
    // Recovery-only repair (never the normal entry path): attach an
    // OCO protection pair to an already-acknowledged position. The OCO
    // legs are LIMIT orders per the venue contract (market OCO is not
    // valid): TP limit at tp, stop leg as stop-limit with limit == stop
    // (integer-cents, no slippage allowance invented). Price/side
    // relationship is validated: a long's protection sells with
    // tp > stop; a short's protection buys with stop > tp. True =
    // transport acked both legs.
    if (!transport_ || o.qty_shares <= 0 || o.stop_cents <= 0 ||
        o.tp_cents <= 0)
        return false;
    bool is_long = (o.side == OrderSide::BUY);
    if (is_long && !(o.tp_cents > o.stop_cents)) return false;
    if (!is_long && !(o.stop_cents > o.tp_cents)) return false;
    char tp[32], sl[32];
    FormatCents(tp, sizeof(tp), o.tp_cents);
    FormatCents(sl, sizeof(sl), o.stop_cents);
    char body[768];
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"limit\",\"time_in_force\":\"day\","
        "\"order_class\":\"oco\","
        "\"take_profit\":{\"limit_price\":\"%s\"},"
        "\"stop_loss\":{\"stop_price\":\"%s\",\"limit_price\":\"%s\"}}",
        o.symbol, (long long)o.qty_shares,
        is_long ? "sell" : "buy",  // protection opposes the position
        tp, sl, sl);
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return false;
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    // The OCO repair reply proves both legs via the same strict
    // legs rule (a bare 2xx never counts as protected).
    return (r.status >= 200 && r.status < 300) &&
           LegsProtected(r.body);
}

}  // namespace broker
}  // namespace jev
