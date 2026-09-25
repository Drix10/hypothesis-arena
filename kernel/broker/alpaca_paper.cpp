// H1 — Alpaca paper adapter over the injected transport. Every method
// fails closed without a transport (Phase 4 wires live HTTPS; H1 proves
// request shape + ack mapping against fakes). Bodies are bounded and
// hand-assembled (no JSON library in the kernel); parsing is
// needle-in-haystack over bounded buffers, never a general parser.
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
    char body[1024];
    // One bracket order: entry + take-profit leg + stop-loss leg. The
    // ack must confirm ALL legs (see below) or protection is missing.
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"market\",\"time_in_force\":\"day\","
        "\"client_order_id\":\"%.64s\",\"order_class\":\"bracket\","
        "\"take_profit\":{\"limit_price\":\"%lld.%02lld\"},"
        "\"stop_loss\":{\"stop_price\":\"%lld.%02lld\"}}",
        o.symbol, (long long)o.qty_shares,
        o.side == OrderSide::BUY ? "buy" : "sell", o.client_order_id,
        (long long)(o.tp_cents / 100), (long long)(o.tp_cents % 100),
        (long long)(o.stop_cents / 100),
        (long long)(o.stop_cents % 100));
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) {
        CopyField("body-overflow", ack.reason, sizeof(ack.reason));
        return ack;
    }
    HttpResult r = transport_("/v2/orders", body);
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
    if (!transport_ || !client_order_id || !client_order_id[0])
        return q;
    char path[128];
    int w = std::snprintf(path, sizeof(path),
                          "/v2/orders:client_order_id:%.64s",
                          client_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(path))) return q;
    HttpResult r = transport_(path, "");
    if (r.status < 200 || r.status >= 300) return q;
    q.found = Contains(r.body, "\"id\"");
    if (!q.found) return q;
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
    const char client_order_id[65]) {
    CancelResult c;
    if (!transport_ || !client_order_id || !client_order_id[0])
        return c;
    char path[160];
    int w = std::snprintf(path, sizeof(path),
                          "/v2/orders:client_order_id:%.64s/cancel",
                          client_order_id);
    if (w <= 0 || w >= static_cast<int>(sizeof(path))) return c;
    HttpResult r = transport_(path, "");
    c.confirmed =
        (r.status >= 200 && r.status < 300) && Contains(r.body, "\"id\"");
    return c;
}

bool AlpacaPaperAdapter::EstablishProtection(
    const ProtectedOrder& o) {
    // Recovery-only repair (never the normal entry path): attach an
    // OCO protection pair to an already-acknowledged position. True =
    // transport acked both legs.
    if (!transport_ || o.qty_shares <= 0 || o.stop_cents <= 0 ||
        o.tp_cents <= 0)
        return false;
    char body[768];
    int w = std::snprintf(
        body, sizeof(body),
        "{\"symbol\":\"%.15s\",\"qty\":\"%lld\",\"side\":\"%s\","
        "\"type\":\"market\",\"time_in_force\":\"day\","
        "\"order_class\":\"oco\","
        "\"take_profit\":{\"limit_price\":\"%lld.%02lld\"},"
        "\"stop_loss\":{\"stop_price\":\"%lld.%02lld\"}}",
        o.symbol, (long long)o.qty_shares,
        o.side == OrderSide::BUY ? "sell" : "buy",  // protection opposes
        (long long)(o.tp_cents / 100), (long long)(o.tp_cents % 100),
        (long long)(o.stop_cents / 100),
        (long long)(o.stop_cents % 100));
    if (w <= 0 || w >= static_cast<int>(sizeof(body))) return false;
    HttpResult r = transport_("/v2/orders", body);
    return (r.status >= 200 && r.status < 300) &&
           Contains(r.body, "take_profit") &&
           Contains(r.body, "stop_loss");
}

}  // namespace broker
}  // namespace jev
