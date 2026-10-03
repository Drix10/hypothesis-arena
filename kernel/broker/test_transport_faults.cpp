// Driver for the fault-injection suite: one operation against the mock venue
// named by TEST_BASE, result printed as a single line for the Python
// harness (kernel/tests/transport_faults.py). Built only with TEST_BASE.
#include <cstdio>
#include <cstring>
#include <string>

#include "alpaca_paper.hpp"
#include "http_curl.hpp"

using namespace kernel::broker;

int main(int argc, char** argv) {
    if (argc < 2) return 2;
    std::string op = argv[1];
    AlpacaPaperAdapter ad(CurlTransport);
    ProtectedOrder o;
    std::strcpy(o.symbol, "SPY");
    o.side = OrderSide::BUY;
    o.qty_shares = 1;
    o.stop_cents = 100;
    o.tp_cents = 99999900;
    std::memset(o.client_order_id, 'c', 64);
    o.client_order_id[64] = '\0';
    std::strcpy(o.intent_id, "i");
    if (op == "submit") {
        OrderAck a = ad.SubmitProtected(o);
        std::printf("submit transport_ok=%d accepted=%d protected=%d reject=%d "
                    "auth=%d rate=%d reason=%s\n",
                    a.transport_ok, a.accepted, a.protection_accepted,
                    a.authoritative_reject, a.auth_failure, a.rate_limited,
                    a.reason);
    } else if (op == "query") {
        OrderQuery q = ad.QueryOnce(o.client_order_id);
        std::printf("query found=%d protected=%d cancelled=%d\n", q.found,
                    q.protection_active, q.cancelled);
    } else if (op == "cancel") {
        CancelResult c = ad.Cancel("11111111-2222-3333-4444-555555555555");
        std::printf("cancel accepted=%d failed=%d\n", c.accepted, c.failed);
    } else if (op == "rest") {
        int st = -1;
        std::string body;
        bool ok = CurlRest("GET", "/v2/account", "", &st, &body);
        std::printf("rest ok=%d status=%d len=%zu\n", ok, st, body.size());
    } else {
        return 2;
    }
    return 0;
}
