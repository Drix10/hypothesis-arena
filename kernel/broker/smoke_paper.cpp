// Paper-venue smoke: account, protected bracket submit, query, cancel,
// cancel confirmation, OTO stop-only, MOC order, bad-credential class. Needs ALPACA_KEY_ID/ALPACA_SECRET.
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
#include "ws_stream.hpp"

using namespace jev::broker;

static int fails = 0;
static void Step(const char* name, bool ok) {
    std::printf("%s %s\n", ok ? "ok  " : "FAIL", name);
    if (!ok) ++fails;
}

// Reads the stream until `needle` shows up in what was received, or `secs`.
static bool StreamHas(TradeStream& ts, std::string& seen, const std::string& needle,
                      int secs) {
    for (int i = 0; i < secs * 20; ++i) {
        char b[4096];
        int n = ts.Read(b, sizeof(b));
        if (n > 0) seen.append(b, (size_t)n);
        if (seen.find(needle) != std::string::npos) return true;
        usleep(50000);
    }
    return false;
}

int main() {
    HttpRequest acct{"GET", "/v2/account", ""};
    HttpResult a = CurlTransport(acct);
    Step("account-200-active",
         a.status == 200 && std::strstr(a.body, "\"ACTIVE\"") != nullptr);
    if (a.status != 200) return 1;

    TradeStream ts;
    std::string seen;
    for (int i = 0; i < 100 && !ts.live(); ++i) {
        char b[256];
        ts.Read(b, sizeof(b));
        usleep(100000);
    }
    Step("stream-authorized-and-listening", ts.live());

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
    Step("stream-delivers-order-event",
         StreamHas(ts, seen, "\"client_order_id\":\"" + cid + "\"", 10));
    CancelResult c = ad.Cancel(ack.broker_order_id);
    Step("cancel-request-accepted", c.accepted && !c.failed);
    Step("stream-delivers-canceled",
         StreamHas(ts, seen, "event: canceled\ndata: {\"order\":{\"client_order_id\":\"" + cid + "\"", 10));
    bool cancelled = false;
    for (int i = 0; i < 10 && !cancelled; ++i) {
        sleep(1);
        cancelled = ad.QueryOnce(o.client_order_id).cancelled;
    }
    Step("cancel-observed", cancelled);

    // OTO stop-only entry: one stop leg proves protection.
    std::string cid2 = jev::Sha256Hex(seed + "|oto");
    ProtectedOrder t = o;
    t.protection = Protection::OTO_STOP;
    t.tp_cents = 0;
    t.gtc = false;
    std::strcpy(t.client_order_id, cid2.c_str());
    OrderAck oa = ad.SubmitProtected(t);
    Step("oto-accepted-with-stop-leg",
         oa.transport_ok && oa.accepted && oa.protection_accepted);
    Step("oto-query-protected", ad.QueryOnce(t.client_order_id).protection_active);
    CancelResult oc = ad.Cancel(oa.broker_order_id);
    Step("oto-cancel-accepted", oc.accepted && !oc.failed);
    bool ocancelled = false;
    for (int i = 0; i < 10 && !ocancelled; ++i) {
        sleep(1);
        ocancelled = ad.QueryOnce(t.client_order_id).cancelled;
    }
    Step("oto-cancel-observed", ocancelled);

    // MOC order shape (a buy: nothing is held to sell), then cancelled.
    std::string cid3 = jev::Sha256Hex(seed + "|moc");
    CloseResult mc = ad.CloseAtClose("SPY", 1, OrderSide::BUY, cid3.c_str());
    Step("moc-accepted-pending",
         mc.transport_ok && mc.state == CloseState::PENDING && mc.broker_order_id[0]);
    if (mc.broker_order_id[0]) {
        CancelResult mcc = ad.Cancel(mc.broker_order_id);
        Step("moc-cancel-accepted", mcc.accepted && !mcc.failed);
    }

    setenv("ALPACA_SECRET", "not-a-real-secret", 1);
    HttpResult bad = CurlTransport(acct);
    Step("bad-credentials-401", bad.status == 401);
    std::printf(fails ? "SMOKE FAIL\n" : "SMOKE PASS\n");
    return fails ? 1 : 0;
}
