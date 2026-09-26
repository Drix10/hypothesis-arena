// H1 integration — event seam implementation. See events.hpp.
#include "events.hpp"

#include <cstring>

namespace jev {
namespace runner {

namespace {
// Bounded needle extract: first "key":"value" (charset + max len
// enforced). False = absent/malformed/overlong.
bool NeedleStrAt(const char* from, const char* key, char* out,
                 std::size_t n, bool digits_only) {
    if (!from || !key || !out || n == 0) return false;
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
    for (const char* p = from; *p; ++p) {
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
            char c = a[i];
            if (digits_only && (c < '0' || c > '9')) return false;
            if (!digits_only &&
                !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') ||
                  (c >= 'a' && c <= 'z') || c == '_' || c == '-' ||
                  c == '.' || c == '#'))
                return false;
            out[i] = c;
            ++i;
        }
        if (a[i] != '"' || i == 0) return false;
        out[i] = '\0';
        return true;
    }
    return false;
}
bool NeedleStr(const char* body, const char* key, char* out,
               std::size_t n, bool digits_only) {
    if (!body) return false;
    return NeedleStrAt(body, key, out, n, digits_only);
}
// Anchored extract: the FIRST key occurrence at/after the anchor
// substring (for nested objects — e.g. inside "order"). False
// when the anchor is absent (strict: never fall back to an outer
// scope that could carry a same-named field).
bool NeedleStrAfter(const char* body, const char* anchor,
                    const char* key, char* out, std::size_t n,
                    bool digits_only) {
    if (!body || !anchor) return false;
    for (const char* p = body; *p; ++p) {
        const char* a = p;
        const char* b = anchor;
        while (*a && *b && *a == *b) {
            ++a;
            ++b;
        }
        if (*b) continue;
        return NeedleStrAt(a, key, out, n, digits_only);
    }
    return false;
}
bool IsFillWord(const char* t) {
    return std::strcmp(t, "fill") == 0 ||
           std::strcmp(t, "partial_fill") == 0;
}
bool IsLifeWord(const char* t) {
    const char* const ws[] = {"new",
                              "pending_new",
                              "accepted",
                              "calculated",
                              "canceled",
                              "rejected",
                              "expired",
                              "done_for_day",
                              "replaced",
                              "suspended",
                              "pending_cancel",
                              "pending_replace",
                              "order_replace_rejected",
                              "order_cancel_rejected",
                              "restated"};
    for (std::size_t i = 0; i < sizeof(ws) / sizeof(ws[0]); ++i) {
        if (std::strcmp(t, ws[i]) == 0) return true;
    }
    return false;
}
bool IsBustWord(const char* t) {
    return std::strcmp(t, "trade_bust") == 0 ||
           std::strcmp(t, "trade_correct") == 0;
}
void CopyId65(char (&dst)[65], const char* src) {
    std::size_t i = 0;
    while (src[i] != '\0' && i < 64) {
        dst[i] = src[i];
        ++i;
    }
    dst[i] = '\0';
}
void CopyEv33(char (&dst)[33], const char* src) {
    std::size_t i = 0;
    while (src[i] != '\0' && i < 32) {
        dst[i] = src[i];
        ++i;
    }
    dst[i] = '\0';
}
}  // namespace

void SseParser::Feed(const char* bytes, std::size_t n) {
    if (!bytes) return;
    for (std::size_t i = 0; i < n; ++i) {
        char c = bytes[i];
        if (c == '\n') {
            if (!buf_.empty() && buf_.back() == '\r') buf_.pop_back();
            CommitLine(buf_);
            buf_.clear();
        } else {
            if (buf_.size() >= 4096) {
                dropped_ = true;  // overlong: resync at blank line
            } else {
                buf_.push_back(c);
            }
        }
    }
}

void SseParser::CommitLine(const std::string& ln) {
    if (ln.empty()) {
        // Blank line dispatches the pending triple (when it carries
        // an event); overlong/malformed triples count an error and
        // arm nothing. Either way the accumulator resets. Ready
        // events QUEUE (a chunk routinely holds many); overflow
        // drops the newest and counts (bounded memory, fail closed).
        if (dropped_) {
            ++errors_;
        } else if (have_data_ || !type_.empty()) {
            if (ready_.size() >= 64) {
                ++errors_;
            } else {
                SseEvent e;
                e.id = id_;
                e.type = type_;
                e.data = data_;
                ready_.push_back(e);
            }
        }
        id_.clear();
        type_.clear();
        data_.clear();
        have_data_ = false;
        dropped_ = false;
        return;
    }
    if (dropped_) return;
    if (ln[0] == ':') return;
    if (ln.compare(0, 3, "id:") == 0) {
        std::string v = ln.substr(3);
        std::size_t a = 0;
        while (a < v.size() && v[a] == ' ') ++a;
        id_ = v.substr(a);
    } else if (ln.compare(0, 6, "event:") == 0) {
        std::string v = ln.substr(6);
        std::size_t a = 0;
        while (a < v.size() && v[a] == ' ') ++a;
        type_ = v.substr(a);
    } else if (ln.compare(0, 5, "data:") == 0) {
        std::string v = ln.substr(5);
        if (!v.empty() && v[0] == ' ') v = v.substr(1);
        if (have_data_) data_ += "\n";
        data_ += v;
        have_data_ = true;
    }
}

bool SseParser::Next(SseEvent* out) {
    if (!out || ready_.empty()) return false;
    *out = ready_.front();
    ready_.erase(ready_.begin());
    return true;
}

StreamObs MapTradeEvent(const SseEvent& ev) {
    StreamObs so;
    if (ev.type.empty() || ev.data.size() >= 2048) return so;
    const char* t = ev.type.c_str();
    const char* d = ev.data.c_str();
    bool fill = IsFillWord(t);
    bool life = IsLifeWord(t);
    bool bust = IsBustWord(t);
    if (!fill && !life && !bust) return so;  // unknown: ignored
    // Identity first: without the client order id the event is
    // unattributable (the router would ignore it untagged anyway).
    char cid[65] = {0};
    if (!NeedleStr(d, "client_order_id", cid, sizeof(cid), false))
        return so;
    CopyId65(so.client_id, cid);
    if (!ev.id.empty() && ev.id.size() <= 32)
        CopyEv33(so.event_id, ev.id.c_str());
    if (bust) {
        // Busted/corrected fills must not linger as monotonic
        // truth: authoritative REST reconciliation. The ULID still
        // rides along (stream position advances on apply).
        so.kind = StreamKind::BUST;
        return so;
    }
    if (life) {
        // Lifecycle words carry NO router verdict here: identity +
        // ULID only. The runner funnels actual state through forced
        // REST (QueryOnce by the same stable id) — never invent a
        // terminal from a stream word.
        so.kind = StreamKind::LIFE;
        return so;
    }
    // Fill words carry the CUMULATIVE order quantity
    // (order.filled_qty) — NEVER the per-event qty. Alpaca's
    // partial_fill.qty is the shares filled by THAT event; only
    // order.filled_qty is the order-level cumulative the router
    // floors on. Absent/unparseable cumulative -> NONE (reconcile
    // instead, never silent zero, never event-qty-as-cumulative).
    char qbuf[20] = {0};
    if (!NeedleStrAfter(d, "\"order\"", "filled_qty", qbuf,
                        sizeof(qbuf), true))
        return so;
    long long q = 0;
    for (int i = 0; qbuf[i]; ++i) q = q * 10 + (qbuf[i] - '0');
    if (q <= 0 || q > 999999999) return so;
    so.kind = StreamKind::FILL;
    so.filled_qty = (std::int64_t)q;
    return so;
}

broker::CloseResult QueryToClose(const broker::OrderQuery& q) {    broker::CloseResult c;
    if (!q.transport_ok) return c;  // lookup failed: ambiguous
    if (!q.found) {
        // 404-absent: the close never landed. transport_ok marks
        // the lookup itself authoritative; UNKNOWN state reconciles
        // (never a blind second send, never terminal).
        c.transport_ok = true;
        return c;
    }
    if (q.filled_qty < 0 || q.filled_qty > 999999999) return c;
    if (q.broker_order_id[0] != '\0') {
        for (int i = 0; q.broker_order_id[i] && i < 64; ++i)
            c.broker_order_id[i] = q.broker_order_id[i];
    }
    c.transport_ok = true;
    c.filled_qty = q.filled_qty;
    if (q.cancelled) {
        c.state = broker::CloseState::DEAD;
        return c;
    }
    c.state = q.close_state;  // FILLED/PARTIAL/PENDING/UNKNOWN
    if (c.state == broker::CloseState::FILLED) c.executed = true;
    return c;
}

ShapedFill ShapeStreamFill(exec::RouteState st, long long remaining,
                           long long qty) {
    ShapedFill f;
    if (qty <= 0 || qty > 999999999 || remaining <= 0) return f;
    if (st == exec::RouteState::QUERY_SENT) {
        f.feed_query = true;
        f.q.transport_ok = true;
        f.q.found = true;
        f.q.filled_qty = qty;
        return f;
    }
    if (st == exec::RouteState::EXIT_SENT ||
        st == exec::RouteState::EXIT_EMERGENCY) {
        f.feed_close = true;
        f.c.transport_ok = true;
        f.c.filled_qty = qty;
        f.c.state = (qty >= remaining) ? broker::CloseState::FILLED
                                       : broker::CloseState::PARTIAL;
        f.c.executed = (f.c.state == broker::CloseState::FILLED);
        return f;
    }
    return f;  // any other state: hold
}

}  // namespace runner
}  // namespace jev
