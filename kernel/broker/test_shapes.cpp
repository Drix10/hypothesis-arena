// Adapter against a verbatim live-venue reply (sanitized ids): the fakes in
// test_broker.cpp are hand-written, this pins the real shape.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "alpaca_paper.hpp"

using namespace jev::broker;

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

static std::string g_body;
static size_t g_cap = 8191;

static HttpResult Fake(const HttpRequest& r) {
    HttpResult out;
    out.status = std::strcmp(r.method, "DELETE") == 0 ? 204 : 200;
    std::string b = std::strcmp(r.method, "DELETE") == 0 ? "" : g_body;
    if (b.size() > g_cap) b.resize(g_cap);
    std::snprintf(out.body, sizeof(out.body), "%s", b.c_str());
    return out;
}

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    std::ifstream f(std::string(argv[1]) + "/alpaca_bracket_reply.json");
    std::stringstream ss;
    ss << f.rdbuf();
    g_body = ss.str();
    CHECK("fixture-loaded", g_body.size() > 2048 && g_body.size() < 8192);

    AlpacaPaperAdapter ad(Fake);
    ProtectedOrder o;
    std::strcpy(o.symbol, "SPY");
    o.side = OrderSide::BUY;
    o.qty_shares = 1;
    o.stop_cents = 100;
    o.tp_cents = 99999900;
    std::memset(o.client_order_id, 'c', 64);
    o.client_order_id[64] = '\0';
    std::strcpy(o.intent_id, "i");

    OrderAck a = ad.SubmitProtected(o);
    CHECK("real-submit-accepted", a.transport_ok && a.accepted);
    CHECK("real-submit-protected", a.protection_accepted);
    CHECK("real-submit-unfilled", a.filled_qty == 0);

    OrderQuery q = ad.QueryOnce(o.client_order_id);
    CHECK("real-query-found", q.found && q.protection_active);

    g_cap = 2048;  // the old body cap: legs cut off, protection unproven
    OrderAck t = ad.SubmitProtected(o);
    CHECK("truncated-reply-not-protected", !t.protection_accepted);

    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
