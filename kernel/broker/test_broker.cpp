// H1 gate [correctness]: broker recipe + Alpaca semantics proof.
// The fake transport asserts the protected-request shape (single
// bracket: entry + TP + SL) and scripts acks; no live network exists
// in H1. Usage: ./test_broker
#include <cstdio>

#include "adapter.hpp"
#include "alpaca_paper.hpp"

static int g_fail = 0;
static int g_count = 0;

static void Check(bool cond, const char* name) {
    ++g_count;
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

using jev::broker::AlpacaPaperAdapter;
using jev::broker::HttpRequest;
using jev::broker::HttpResult;
using jev::broker::OrderSide;
using jev::broker::PaperFillPrice;
using jev::broker::ProtectedOrder;
using jev::broker::Quote;

static char g_last_method[16];
static char g_last_path[256];
static char g_last_body[2048];
static int g_calls = 0;
static int g_status = 200;
static const char* g_reply = "{\"id\":\"x\"}";

static HttpResult Fake(const HttpRequest& req) {
    ++g_calls;
    int i = 0;
    while (req.method[i] && i < 15) {
        g_last_method[i] = req.method[i];
        ++i;
    }
    g_last_method[i] = '\0';
    i = 0;
    while (req.path[i] && i < 255) {
        g_last_path[i] = req.path[i];
        ++i;
    }
    g_last_path[i] = '\0';
    i = 0;
    const char* body = req.body ? req.body : "";
    while (body[i] && i < 2047) {
        g_last_body[i] = body[i];
        ++i;
    }
    g_last_body[i] = '\0';
    HttpResult r;
    r.status = g_status;
    i = 0;
    while (g_reply[i] && i < 2047) {
        r.body[i] = g_reply[i];
        ++i;
    }
    r.body[i] = '\0';
    return r;
}

static bool Has(const char* body, const char* needle) {
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

int main() {
    using jev::broker::MakeClientOrderId;
    // 1. ID recipe: deterministic, namespaced, no attempt field
    {
        char a[65], b[65], c[65];
        bool ok = MakeClientOrderId("alpaca-paper", "acct-7",
                                    "abcdef0123456789abcdef0123456789"
                                    "abcdef0123456789abcdef0123456789",
                                    "AAPL", OrderSide::BUY, "i-1", a);
        bool ok2 = MakeClientOrderId("alpaca-paper", "acct-7",
                                     "abcdef0123456789abcdef0123456789"
                                     "abcdef0123456789abcdef0123456789",
                                     "AAPL", OrderSide::BUY, "i-1", b);
        bool same = ok && ok2;
        for (int i = 0; i < 65 && same; ++i)
            if (a[i] != b[i]) same = false;
        Check(same, "id-deterministic");
        MakeClientOrderId("alpaca-paper", "acct-7",
                          "abcdef0123456789abcdef0123456789"
                          "abcdef0123456789abcdef0123456789",
                          "AAPL", OrderSide::BUY, "i-2", c);
        bool diff = false;
        for (int i = 0; i < 64; ++i)
            if (a[i] != c[i]) diff = true;
        Check(diff, "id-per-intent");
        char d[65];
        MakeClientOrderId("oanda-x", "acct-7",
                          "abcdef0123456789abcdef0123456789"
                          "abcdef0123456789abcdef0123456789",
                          "AAPL", OrderSide::BUY, "i-1", d);
        bool ndiff = false;
        for (int i = 0; i < 64; ++i)
            if (a[i] != d[i]) ndiff = true;
        Check(ndiff, "id-namespaced");
        char e[65];
        MakeClientOrderId("alpaca-paper", "acct-7",
                          "abcdef0123456789abcdef0123456789"
                          "abcdef0123456789abcdef0123456789",
                          "AAPL", OrderSide::SELL, "i-1", e);
        bool sdiff = false;
        for (int i = 0; i < 64; ++i)
            if (a[i] != e[i]) sdiff = true;
        Check(sdiff, "id-side-matters");
        char f[65];
        Check(!MakeClientOrderId("", "acct-7",
                                 "abcdef0123456789abcdef0123456789"
                                 "abcdef0123456789abcdef0123456789",
                                 "AAPL", OrderSide::BUY, "i-1", f),
              "id-rejects-empty");
        Check(!MakeClientOrderId("b", "a", "c", "s", OrderSide::BUY,
                                 "i", nullptr),
              "id-rejects-null");
    }
    // 2. paper fill model (frozen): adverse full spread, min 1bp
    {
        Quote q;
        q.mid_cents = 23110;
        q.spread_cents = 4;
        Check(PaperFillPrice(OrderSide::BUY, q) == 23114, "fill-buy");
        Check(PaperFillPrice(OrderSide::SELL, q) == 23106, "fill-sell");
        Quote z;
        z.mid_cents = 23110;
        z.spread_cents = 0;
        // 1bp of 23110 = 2 (integer division) -> min adverse 2.
        Check(PaperFillPrice(OrderSide::BUY, z) == 23112, "fill-minbp");
        Quote tiny;
        tiny.mid_cents = 50;
        tiny.spread_cents = 0;
        // 1bp of 50 = 0 -> floor 1 cent.
        Check(PaperFillPrice(OrderSide::SELL, tiny) == 49,
              "fill-mincent");
        Quote bad;
        bad.mid_cents = 0;
        Check(PaperFillPrice(OrderSide::BUY, bad) == -1, "fill-bad-mid");
        bad.mid_cents = 100;
        bad.spread_cents = -3;
        Check(PaperFillPrice(OrderSide::BUY, bad) == -1,
              "fill-bad-spread");
    }
    // 3. Alpaca protected submit: single bracket, all legs, ack mapping
    {
        ProtectedOrder o;
        o.symbol[0] = 'A';
        o.symbol[1] = 'A';
        o.symbol[2] = 'P';
        o.symbol[3] = 'L';
        o.symbol[4] = '\0';
        o.side = OrderSide::BUY;
        o.qty_shares = 10;
        o.stop_cents = 22000;
        o.tp_cents = 24000;
        for (int i = 0; i < 64; ++i) {
            o.client_order_id[i] = 'c';
            o.intent_id[i] = 'i';
        }
        o.client_order_id[64] = '\0';
        o.intent_id[64] = '\0';
        AlpacaPaperAdapter ad(Fake);
        g_calls = 0;
        g_status = 200;g_reply =
            "{\"id\":\"o1\",\"take_profit\":{\"limit_price\":\"240.00\"},"
            "\"stop_loss\":{\"stop_price\":\"220.00\"}}";
        auto ack = ad.SubmitProtected(o);
        Check(g_calls == 1, "bracket-single-call");
        Check(g_last_method[0] == 'P' && g_last_method[1] == 'O' &&
                  g_last_method[2] == 'S' && g_last_method[3] == 'T' &&
                  g_last_method[4] == '\0',
              "bracket-post");
        Check(Has(g_last_body, "\"order_class\":\"bracket\""),
              "bracket-class");
        Check(Has(g_last_body, "\"side\":\"buy\""), "bracket-side");
        Check(Has(g_last_body, "\"qty\":\"10\""), "bracket-qty");
        Check(Has(g_last_body, "take_profit"), "bracket-tp");
        Check(Has(g_last_body, "stop_loss"), "bracket-sl");
        Check(ack.accepted && ack.protection_accepted, "bracket-acked");
        // Legs missing from the reply -> protection NOT accepted.
        g_reply = "{\"id\":\"o2\"}";
        auto ack2 = ad.SubmitProtected(o);
        Check(ack2.accepted && !ack2.protection_accepted,
              "naked-leg-detected");
        // Broker reject -> refused.
        g_status = 422;
        auto ack3 = ad.SubmitProtected(o);
        Check(!ack3.accepted, "broker-reject");
        g_status = 200;
        // Bad spec never touches the transport.
        ProtectedOrder bad = o;
        bad.qty_shares = 0;
        int before = g_calls;
        auto ack4 = ad.SubmitProtected(bad);
        Check(!ack4.accepted && g_calls == before, "bad-spec-blocked");
        // No transport -> closed with a reason.
        AlpacaPaperAdapter dead(nullptr);
        auto ack5 = dead.SubmitProtected(o);
        Check(!ack5.accepted && ack5.reason[0] != '\0',
              "unwired-closed");
    }
    // 4. query uses GET by-client-id; cancel uses DELETE by UUID.
    {
        AlpacaPaperAdapter ad(Fake);
        g_status = 200;
        g_reply =
            "{\"id\":\"0193abcd-uuid\",\"filled_qty\":\"10\","
            "take_profit\":{},\"stop_loss\":{}}";
        char id[65];
        for (int i = 0; i < 64; ++i) id[i] = 'q';
        id[64] = '\0';
        g_calls = 0;
        auto q = ad.QueryOnce(id);
        Check(g_calls == 1, "query-single-call");
        Check(g_last_method[0] == 'G' && g_last_method[1] == 'E' &&
                  g_last_method[2] == 'T' && g_last_method[3] == '\0',
              "query-get");
        Check(Has(g_last_path,
                  "/v2/orders:by_client_order_id?client_order_id="),
              "query-path");
        Check(q.found && q.filled_qty == 10 && q.protection_active,
              "query-maps");
        bool uuid_ok = true;
        const char* want = "0193abcd-uuid";
        for (int i = 0; want[i]; ++i)
            if (q.broker_order_id[i] != want[i]) uuid_ok = false;
        Check(uuid_ok && q.broker_order_id[13] == '\0', "query-uuid");
        // Cancel goes to DELETE /v2/orders/{uuid}: no hidden lookup.
        g_reply = "{\"id\":\"0193abcd-uuid\"}";
        g_calls = 0;
        auto c = ad.Cancel(q.broker_order_id);
        Check(g_calls == 1, "cancel-single-call");
        Check(g_last_method[0] == 'D', "cancel-delete");
        Check(Has(g_last_path, "/v2/orders/0193abcd-uuid"),
              "cancel-uuid-path");
        Check(c.confirmed, "cancel-confirms");
        g_status = 500;
        auto c2 = ad.Cancel(q.broker_order_id);
        Check(!c2.confirmed, "cancel-fail-open-never");
        g_status = 200;
        // Lookup with no id marker: not found (never a phantom).
        g_reply = "{}";
        auto q404 = ad.QueryOnce(id);
        Check(!q404.found, "query-not-found");
        // Repair is a LIMIT OCO with opposing side + sane prices.
        ProtectedOrder o;
        o.symbol[0] = 'S';
        o.symbol[1] = 'P';
        o.symbol[2] = 'Y';
        o.symbol[3] = '\0';
        o.side = OrderSide::BUY;  // long position -> protection sells
        o.qty_shares = 5;
        o.stop_cents = 50000;
        o.tp_cents = 52000;
        for (int i = 0; i < 64; ++i) {
            o.client_order_id[i] = 'c';
            o.intent_id[i] = 'i';
        }
        o.client_order_id[64] = '\0';
        o.intent_id[64] = '\0';
        g_reply =
            "{\"id\":\"o9\",\"take_profit\":{},\"stop_loss\":{}}";
        bool rep = ad.EstablishProtection(o);
        Check(rep && Has(g_last_body, "\"order_class\":\"oco\"") &&
                  Has(g_last_body, "\"type\":\"limit\"") &&
                  Has(g_last_body, "\"side\":\"sell\""),
              "repair-oco-limit-opposing");
        // Short recovery buys with stop above TP.
        o.side = OrderSide::SELL;
        o.stop_cents = 52000;
        o.tp_cents = 50000;
        Check(ad.EstablishProtection(o) &&
                  Has(g_last_body, "\"side\":\"buy\""),
              "repair-short-buys");
        // Inverted prices refused without transport touch.
        o.stop_cents = 50000;
        o.tp_cents = 52000;  // tp above stop on a short = nonsense
        int before = g_calls;
        Check(!ad.EstablishProtection(o) && g_calls == before,
              "repair-price-guard");
        // MarketClose posts a plain market order for exits.
        g_calls = 0;
        auto mc = ad.MarketClose("AAPL", 10, OrderSide::SELL);
        Check(mc.executed && g_last_method[0] == 'P' &&
                  Has(g_last_path, "/v2/orders") &&
                  Has(g_last_body, "\"side\":\"sell\"") &&
                  !Has(g_last_body, "order_class"),
              "close-market-plain");
    }
    if (g_fail == 0) std::printf("BROKER SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
