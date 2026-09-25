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
// Strict legs proof (P0-3): protection is active ONLY when the reply
// carries a "legs" ARRAY with >= 2 top-level leg objects, >= 2 leg
// ids, and both take_profit and stop_loss markers INSIDE that array.
// Bare substrings elsewhere in the body prove nothing (echoed request
// fields, error text). String-aware bracket matching; unbalanced or
// non-array legs -> false (unknown, never active).
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
    int legs = 0;
    int ids = 0;
    bool tp = false;
    bool sl = false;
    int d = 0;
    in_str = false;
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
            if (d == 1) ++legs;
            ++d;
        } else if (*p == '}') {
            --d;
        } else if (*p == '[') {
            ++d;
        } else if (*p == ']') {
            --d;
        }
    }
    if (in_str) return false;
    for (const char* p = arr; p < q; ++p) {
        if (p[0] == '"' && p[1] == 'i' && p[2] == 'd' && p[3] == '"' &&
            p[4] == ':')
            ++ids;
        if (!tp && p[0] == 't') {
            const char* w = "take_profit";
            const char* a = p;
            while (a < q && *w && *a == *w) {
                ++a;
                ++w;
            }
            if (!*w) tp = true;
        }
        if (!sl && p[0] == 's') {
            const char* w = "stop_loss";
            const char* a = p;
            while (a < q && *w && *a == *w) {
                ++a;
                ++w;
            }
            if (!*w) sl = true;
        }
    }
    return legs >= 2 && ids >= 2 && tp && sl;
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
    // Three outcomes, never collapsed (P0-2):
    //   4xx shaped refusal -> authoritative_reject (terminal upstream)
    //   2xx + order id   -> accepted (protection per legs, below)
    //   anything else (5xx, transport failure, malformed 2xx) ->
    //     ambiguous: accepted=false WITHOUT authoritative_reject
    //     (the router reconciles under the same ID).
    if (r.status >= 400 && r.status < 500) {
        ack.authoritative_reject = true;
        CopyField("broker-reject", ack.reason, sizeof(ack.reason));
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
    // Three outcomes (P0-1):
    //   404              -> authoritative absent (cancel path needs no
    //                         UUID; the router journals a terminal cancel)
    //   2xx + order id   -> found (UUID required for DELETE)
    //   2xx malformed / 5xx / transport failure -> unknown (reconcile,
    //     never "absent": a malformed 200 is not proof of absence).
    if (r.status == 404) {
        q.transport_ok = true;
        return q;
    }
    if (r.status < 200 || r.status >= 300) return q;
    // Only an id-bearing 2xx reply is a found order (the UUID is
    // REQUIRED for the real DELETE cancel path). A 2xx without an id
    // is malformed -> unknown, never "absent".
    if (!ExtractQuoted(r.body, "id", q.broker_order_id,
                       sizeof(q.broker_order_id)))
        return q;
    q.transport_ok = true;
    q.found = true;
    q.cancelled = Contains(r.body, "\"canceled\"") ||
                  Contains(r.body, "\"cancelled\"");
    q.protection_active = LegsProtected(r.body);
    // filled_qty extraction: needle "\"filled_qty\":\"" + digits.
    const char* needle = "\"filled_qty\":\"";
    for (const char* p = r.body; *p; ++p) {
        const char* a = p;
        const char* b = needle;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*b) continue;
        long long v = 0;
        int digits = 0;
        while (*a >= '0' && *a <= '9' && digits < 18) {
            v = v * 10 + (*a - '0');
            ++a;
            ++digits;
        }
        if (digits > 0) q.filled_qty = (std::int64_t)v;
        break;
    }
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
    // Successful DELETE is 204 No Content (empty body): the status
    // alone confirms. Other 2xx require the id marker (never trust a
    // bare 200 with no body); 4xx/5xx always fail.
    if (r.status == 204) {
        c.confirmed = true;
        return c;
    }
    c.confirmed =
        (r.status >= 200 && r.status < 300) && Contains(r.body, "\"id\"");
    return c;
}

CloseResult AlpacaPaperAdapter::MarketClose(const char* symbol,
                                            std::int64_t qty_shares,
                                            OrderSide side) {
    CloseResult c;
    if (!transport_ || !symbol || !symbol[0] || qty_shares <= 0)
        return c;
    char body[512];
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"market\",\"time_in_force\":\"day\"}",
        symbol, (long long)qty_shares,
        side == OrderSide::BUY ? "buy" : "sell");
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return c;
    HttpRequest req;
    req.method = "POST";
    req.path = "/v2/orders";
    req.body = body;
    HttpResult r = transport_(req);
    c.executed =
        (r.status >= 200 && r.status < 300) && Contains(r.body, "\"id\"");
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
    return (r.status >= 200 && r.status < 300) &&
           Contains(r.body, "take_profit") &&
           Contains(r.body, "stop_loss");
}

}  // namespace broker
}  // namespace jev
