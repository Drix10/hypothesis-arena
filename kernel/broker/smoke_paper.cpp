// Paper-venue smoke: account, protected bracket submit, query, cancel,
// cancel confirmation, bad-credential class. Needs ALPACA_KEY_ID/ALPACA_SECRET.
// Places one 1-share SPY bracket and cancels it; never run against a live
// account (the transport only ever talks to the paper host).
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>

#include <unistd.h>

#include "../jev_validate.hpp"
#include "alpaca_paper.hpp"
#include "http_curl.hpp"

using namespace jev::broker;

static int fails = 0;
static void Step(const char* name, bool ok) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", name);
    if (!ok) ++fails;
}

int main() {
    HttpRequest acct{"GET", "/v2/account", ""};
    HttpResult a = CurlTransport(acct);
    Step("account-200-active",
         a.status == 200 && std::strstr(a.body, "\"ACTIVE\"") != nullptr);
    if (a.status != 200) return 1;

    AlpacaPaperAdapter ad(CurlTransport);
    std::string seed = "smoke|" + std::to_string(std::time(nullptr)) + "|" +
                       std::to_string(getpid());
    std::string cid = jev::Sha256Hex(seed);
    std::string iid = jev::Sha256Hex(seed + "|intent");
    ProtectedOrder o{};
    std::strcpy(o.symbol, "SPY");
    o.side = OrderSide::BUY;
    o.qty_shares = 1;
    o.stop_cents = 100;      // far below any SPY price: never triggers
    o.tp_cents = 99999900;   // far above: never triggers
    std::strcpy(o.client_order_id, cid.c_str());
    std::strcpy(o.intent_id, iid.c_str());

    OrderAck ack = ad.SubmitProtected(o);
    Step("submit-accepted-with-legs",
         ack.transport_ok && ack.accepted && ack.protection_accepted);
    OrderQuery q = ad.QueryOnce(o.client_order_id);
    Step("query-finds-order", q.found && q.protection_active);
    CancelResult c = ad.Cancel(ack.broker_order_id);
    Step("cancel-request-accepted", c.accepted && !c.failed);
    bool cancelled = false;
    for (int i = 0; i < 10 && !cancelled; ++i) {
        sleep(1);
        cancelled = ad.QueryOnce(o.client_order_id).cancelled;
    }
    Step("cancel-observed", cancelled);

    setenv("ALPACA_SECRET", "not-a-real-secret", 1);
    HttpResult bad = CurlTransport(acct);
    Step("bad-credentials-401", bad.status == 401);
    std::printf(fails ? "SMOKE FAIL\n" : "SMOKE PASS\n");
    return fails ? 1 : 0;
}
