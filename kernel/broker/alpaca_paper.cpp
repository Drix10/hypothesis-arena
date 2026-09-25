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
    if (r.status < 200 || r.status >= 300) {
        CopyField("broker-reject", ack.reason, sizeof(ack.reason));
        return ack;
    }
    // Protection is accepted ONLY when the transport confirms every
    // leg of the bracket (entry + TP + SL markers in the reply).
    ack.accepted = Contains(r.body, "\"id\"");
    ack.protection_accepted =
        ack.accepted && Contains(r.body, "take_profit") &&
        Contains(r.body, "stop_loss");
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
    if (r.status < 200 || r.status >= 300) return q;
    // Distinguish not-found (no id marker) from a broken reply: only
    // an id-bearing reply is a found order. The UUID is REQUIRED for
    // the real DELETE cancel path (no second lookup hidden anywhere).
    if (!ExtractQuoted(r.body, "id", q.broker_order_id,
                       sizeof(q.broker_order_id)))
        return q;
    q.found = true;
    q.cancelled = Contains(r.body, "\"canceled\"") ||
                  Contains(r.body, "\"cancelled\"");
    q.protection_active = Contains(r.body, "take_profit") &&
                          Contains(r.body, "stop_loss");
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
