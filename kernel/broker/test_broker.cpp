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
        g_status = 200;
        g_reply =
            "{\"id\":\"6d7c5cb4-2682-4a53-a742-5df876a2d1aa\","
            "\"status\":\"accepted\",\"symbol\":\"SPY\",\"qty\":\"10\","
            "\"side\":\"buy\",\"type\":\"market\",\"order_class\":\"bracket\","
            "\"take_profit\":{\"limit_price\":\"240.00\"},"
            "\"stop_loss\":{\"stop_price\":\"220.00\"},\"legs\":["
            "{\"id\":\"11111111-2222-3333-4444-555555555555\","
            "\"side\":\"sell\",\"type\":\"limit\"},"
            "{\"id\":\"66666666-7777-8888-9999-000000000000\","
            "\"side\":\"sell\",\"type\":\"stop\"}]}";
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
        // P0-3: the accepted POST UUID is captured on the ack.
        Check(Has(ack.broker_order_id,
                  "6d7c5cb4-2682-4a53-a742-5df876a2d1aa"),
              "post-uuid-captured");
        // Legs missing from the reply -> protection NOT accepted.
        // (Markers outside a legs array prove nothing: this body
        // carries both markers with NO legs and must still refuse.)
        g_reply = "{\"id\":\"o2\",\"take_profit\":{},\"stop_loss\":{}}";
        auto ack2 = ad.SubmitProtected(o);
        Check(ack2.accepted && !ack2.protection_accepted,
              "naked-leg-detected");
        // One leg only -> refused. Unbalanced legs -> refused.
        g_reply =
            "{\"id\":\"o3\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"l-tp\",\"type\":\"limit\"}]}";
        auto ack3 = ad.SubmitProtected(o);
        Check(ack3.accepted && !ack3.protection_accepted,
              "one-leg-refused");
        g_reply = "{\"id\":\"o4\",\"legs\":[{\"id\":\"l\"";
        auto ack4 = ad.SubmitProtected(o);
        Check(ack4.accepted && !ack4.protection_accepted,
              "unbalanced-refused");
        // Duplicate leg ids -> refused.
        g_reply =
            "{\"id\":\"o5\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"same\",\"type\":\"limit\"},"
            "{\"id\":\"same\",\"type\":\"stop\"}]}";
        auto ack5 = ad.SubmitProtected(o);
        Check(ack5.accepted && !ack5.protection_accepted,
              "duplicate-leg-id-refused");
        // Duplicate roles (two limits) -> refused.
        g_reply =
            "{\"id\":\"o6\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"a\",\"type\":\"limit\"},"
            "{\"id\":\"b\",\"type\":\"limit\"}]}";
        auto ack6 = ad.SubmitProtected(o);
        Check(ack6.accepted && !ack6.protection_accepted,
              "duplicate-role-refused");
        // Three legs -> refused (not the bracket/OCO pair).
        g_reply =
            "{\"id\":\"o7\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"a\",\"type\":\"limit\"},"
            "{\"id\":\"b\",\"type\":\"stop\"},"
            "{\"id\":\"c\",\"type\":\"limit\"}]}";
        auto ack7 = ad.SubmitProtected(o);
        Check(ack7.accepted && !ack7.protection_accepted,
              "three-legs-refused");
        // Untyped leg -> refused.
        g_reply =
            "{\"id\":\"o8\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"a\",\"type\":\"limit\"},"
            "{\"id\":\"b\"}]}";
        auto ack8 = ad.SubmitProtected(o);
        Check(ack8.accepted && !ack8.protection_accepted,
              "untyped-leg-refused");
        // P1-7 send outcomes: 400/422 permanent; 401/403 auth;
        // 429 throttled; other-4xx/500/malformed-200 ambiguous
        // (reconcile, never terminal here).
        g_status = 422;
        g_reply = "{\"code\":40010001,\"message\":\"bad\"}";
        auto r422 = ad.SubmitProtected(o);
        Check(!r422.accepted && r422.authoritative_reject &&
                  !r422.transport_ok && !r422.auth_failure &&
                  !r422.rate_limited,
              "send-422-authoritative");
        g_status = 400;
        auto r400 = ad.SubmitProtected(o);
        Check(!r400.accepted && r400.authoritative_reject,
              "send-400-authoritative");
        g_status = 401;
        auto r401 = ad.SubmitProtected(o);
        Check(!r401.accepted && !r401.authoritative_reject &&
                  r401.auth_failure && !r401.transport_ok,
              "send-401-auth");
        // 403 on create-order = forbidden/buying-power (the ORDER
        // is dead): terminal, never an auth-outage classification.
        g_status = 403;
        auto r403 = ad.SubmitProtected(o);
        Check(!r403.accepted && r403.authoritative_reject &&
                  !r403.auth_failure && Has(r403.reason, "buying"),
              "send-403-buying-power");
        g_status = 429;
        auto r429 = ad.SubmitProtected(o);
        Check(!r429.accepted && !r429.authoritative_reject &&
                  !r429.auth_failure && r429.rate_limited,
              "send-429-rate");
        g_status = 409;
        auto r409 = ad.SubmitProtected(o);
        Check(!r409.accepted && !r409.authoritative_reject &&
                  !r409.auth_failure && !r409.rate_limited &&
                  !r409.transport_ok,
              "send-409-ambiguous");
        g_status = 500;
        auto r500 = ad.SubmitProtected(o);
        Check(!r500.accepted && !r500.authoritative_reject &&
                  !r500.transport_ok,
              "send-500-ambiguous");
        g_status = 200;
        g_reply = "{\"ok\":true}";
        auto rmal = ad.SubmitProtected(o);
        Check(!rmal.accepted && !rmal.authoritative_reject &&
                  !rmal.transport_ok,
              "send-malformed-ambiguous");
        g_status = 200;
        // Bad spec never touches the transport.
        ProtectedOrder bad = o;
        bad.qty_shares = 0;
        int before = g_calls;
        auto ack9 = ad.SubmitProtected(bad);
        Check(!ack9.accepted && g_calls == before, "bad-spec-blocked");
        // No transport -> closed with a reason.
        AlpacaPaperAdapter dead(nullptr);
        auto ack10 = dead.SubmitProtected(o);
        Check(!ack10.accepted && ack10.reason[0] != '\0',
              "unwired-closed");
    }
    // 4. query uses GET by-client-id; cancel uses DELETE by UUID.
    {
        AlpacaPaperAdapter ad(Fake);
        g_status = 200;
        g_reply =
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\",\"filled_qty\":\"10\","
            "\"order_class\":\"bracket\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"l1\",\"type\":\"limit\"},"
            "{\"id\":\"l2\",\"type\":\"stop\"}]}";
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
        const char* want = "0193abcd-1234-5678-9abc-def012345678";
        for (int i = 0; want[i]; ++i)
            if (q.broker_order_id[i] != want[i]) uuid_ok = false;
        Check(uuid_ok && q.broker_order_id[36] == '\0', "query-uuid");
        // Cancel goes to DELETE /v2/orders/{uuid}: no hidden lookup.
        g_reply = "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\"}";
        g_calls = 0;
        auto c = ad.Cancel(q.broker_order_id);
        Check(g_calls == 1, "cancel-single-call");
        Check(g_last_method[0] == 'D', "cancel-delete");
        Check(Has(g_last_path, "/v2/orders/0193abcd-1234-5678-9abc-def012345678"),
              "cancel-uuid-path");
        Check(c.accepted && !c.failed, "cancel-2xx-accepted");
        g_status = 500;
        auto c2 = ad.Cancel(q.broker_order_id);
        Check(!c2.accepted && !c2.failed, "cancel-fail-open-never");
        g_status = 200;
        // Real Alpaca success: 204 No Content, empty body = request
        // ACCEPTED, never final cancellation by itself.
        g_status = 204;
        g_reply = "";
        auto c3 = ad.Cancel(q.broker_order_id);
        Check(c3.accepted && !c3.failed, "cancel-204-accepted");
        // Explicit 422 = cancel refused.
        g_status = 422;
        auto c4 = ad.Cancel(q.broker_order_id);
        Check(!c4.accepted && c4.failed, "cancel-422-failed");
        g_status = 200;
        // Lookup with no id marker on 200: MALFORMED, not absent.
        g_reply = "{}";
        auto qmal = ad.QueryOnce(id);
        Check(!qmal.found && !qmal.transport_ok, "query-malformed");
        // Real 404: authoritative absent (no UUID to DELETE; the
        // router journals a terminal cancel, never CANCEL_SENT).
        g_status = 404;
        auto q404 = ad.QueryOnce(id);
        Check(!q404.found && q404.transport_ok, "query-404-absent");
        // 500: unknown, never absent.
        g_status = 500;
        auto q500 = ad.QueryOnce(id);
        Check(!q500.found && !q500.transport_ok, "query-500-unknown");
        // 401: auth failure, never "absent". 429: throttled.
        // Status is recorded for evidence, not control flow.
        g_status = 401;
        auto q401 = ad.QueryOnce(id);
        Check(!q401.found && !q401.transport_ok && q401.auth_failure &&
                  q401.broker_status == 401,
              "query-401-auth");
        g_status = 429;
        auto q429 = ad.QueryOnce(id);
        Check(!q429.found && !q429.transport_ok && q429.rate_limited &&
                  q429.broker_status == 429,
              "query-429-rate");
        // P0-3 query UUID grammar: short/upper/bad-hyphen/slash/
        // overlong ids are malformed (unknown), never found, never
        // reach DELETE.
        g_status = 200;
        const char* bad_ids[5] = {
            "{\"id\":\"0193abcd\",\"filled_qty\":\"10\"}",
            "{\"id\":\"0193ABCD-1234-5678-9ABC-DEF012345678\","
            "\"filled_qty\":\"10\"}",
            "{\"id\":\"0193abcd_1234_5678_9abc_def012345678\","
            "\"filled_qty\":\"10\"}",
            "{\"id\":\"orders/0193abcd-1234-5678-9abc-"
            "def012345678\",\"filled_qty\":\"10\"}",
            "{\"id\":\"0193abcd-1234-5678-9abc-def0123456789\","
            "\"filled_qty\":\"10\"}"};
        const char* bad_names[5] = {
            "query-id-short", "query-id-upper", "query-id-hyphen",
            "query-id-slash", "query-id-long"};
        for (int bi = 0; bi < 5; ++bi) {
            g_reply = bad_ids[bi];
            auto qb = ad.QueryOnce(id);
            Check(!qb.found && !qb.transport_ok, bad_names[bi]);
        }
        // P1-6 filled_qty strict: missing/non-numeric/negative/
        // overlong qty is unknown, never silent zero.
        const char* bad_qty[4] = {
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\"}",
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\","
            "\"filled_qty\":\"ten\"}",
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\","
            "\"filled_qty\":\"-3\"}",
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\","
            "\"filled_qty\":\"12345678901234567890\"}"};
        const char* qty_names[4] = {"query-qty-missing",
                                    "query-qty-nonnumeric",
                                    "query-qty-negative",
                                    "query-qty-overflow"};
        for (int qi = 0; qi < 4; ++qi) {
            g_reply = bad_qty[qi];
            auto qq = ad.QueryOnce(id);
            Check(!qq.found && !qq.transport_ok, qty_names[qi]);
        }
        // P0-1 by-client-ID shape: bracket held as a unit with legs
        // null (unexpanded) -> bracket_class, NOT protection-absent.
        g_reply =
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\","
            "\"client_order_id\":\"qqqq\",\"status\":\"filled\","
            "\"symbol\":\"SPY\",\"qty\":\"10\",\"filled_qty\":\"10\","
            "\"side\":\"buy\",\"type\":\"market\","
            "\"order_class\":\"bracket\","
            "\"take_profit\":{\"limit_price\":\"240.00\"},"
            "\"stop_loss\":{\"stop_price\":\"220.00\"},"
            "\"legs\":null}";
        auto qnull = ad.QueryOnce(id);
        Check(qnull.found && qnull.transport_ok &&
                  !qnull.protection_active && qnull.bracket_class &&
                  qnull.filled_qty == 10,
              "query-legs-null-bracket-held");
        // Same shape, simple order class -> genuinely no bracket:
        // neither confirmed nor constructive (repair legitimate).
        g_reply =
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\","
            "\"status\":\"filled\",\"symbol\":\"SPY\","
            "\"qty\":\"10\",\"filled_qty\":\"10\",\"side\":\"buy\","
            "\"type\":\"market\",\"legs\":null}";
        auto qsmp = ad.QueryOnce(id);
        Check(qsmp.found && !qsmp.protection_active &&
                  !qsmp.bracket_class,
              "query-simple-no-bracket");
        g_status = 200;
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
            "{\"id\":\"o9\",\"order_class\":\"oco\",\"take_profit\":{},\"stop_loss\":{},"
            "\"legs\":[{\"id\":\"r1\",\"type\":\"limit\"},"
            "{\"id\":\"r2\",\"type\":\"stop\"}]}";
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
        // MarketClose posts a plain market order carrying the exit's
        // stable client ID; the UUID + transport-ok ride the ack.
        g_calls = 0;
        g_status = 200;
        g_reply =
            "{\"id\":\"0193abcd-1234-5678-9abc-def012345678\","
            "\"status\":\"filled\",\"filled_qty\":\"10\"}";
        char xid[65];
        for (int i = 0; i < 64; ++i) xid[i] = 'x';
        xid[64] = '\0';
        auto mc = ad.MarketClose("AAPL", 10, OrderSide::SELL, xid);
        Check(mc.executed && mc.transport_ok && g_last_method[0] == 'P' &&
                  Has(g_last_path, "/v2/orders") &&
                  Has(g_last_body, "\"side\":\"sell\"") &&
                  Has(g_last_body, "\"client_order_id\":\"xxxx") &&
                  !Has(g_last_body, "order_class") &&
                  Has(mc.broker_order_id,
                      "0193abcd-1234-5678-9abc-def012345678"),
              "close-market-plain");
        // Ambiguous close (response lost): not executed, no UUID —
        // the caller reconciles by client ID, never re-sends blind.
        g_status = 500;
        auto mc2 = ad.MarketClose("AAPL", 10, OrderSide::SELL, xid);
        Check(!mc2.executed && !mc2.transport_ok &&
                  mc2.broker_order_id[0] == '\0',
              "close-ambiguous-reconciles");
        g_status = 200;
        g_reply = "{\"ok\":true}";
        auto mc3 = ad.MarketClose("AAPL", 10, OrderSide::SELL, xid);
        Check(!mc3.executed && !mc3.transport_ok,
              "close-malformed-reconciles");
    }
    if (g_fail == 0) std::printf("BROKER SUITE: ALL PASS (%d checks)\n",
                                 g_count);
    return g_fail ? 1 : 0;
}
