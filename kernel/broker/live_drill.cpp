// Live paper drill (needs an open session and ALPACA_KEY_ID / ALPACA_SECRET):
// one SPY share bought with an OTO stop, then the exit orders K5 needs to know
// about are tried against the resting stop, and the account is flattened.
// Paper host only; never run against anything else. Prints one line per
// finding; exits 1 if it could not restore a flat SPY position.
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

static bool Rest(const char* m, const std::string& path, int* st, std::string* body) {
    return CurlRest(m, path, "", st, body);
}

static bool Pump(TradeStream& ts, std::string& seen, const std::string& needle,
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

static std::string Field(const std::string& j, const char* key) {
    std::string k = std::string("\"") + key + "\":\"";
    size_t p = j.find(k);
    if (p == std::string::npos) return "";
    p += k.size();
    return j.substr(p, j.find('"', p) - p);
}

static int PositionQty(bool* ok) {
    int st = 0;
    std::string b;
    *ok = Rest("GET", "/v2/positions/SPY", &st, &b);
    if (!*ok) return 0;
    if (st == 404) return 0;
    if (st != 200) {
        *ok = false;
        return 0;
    }
    return std::atoi(Field(b, "qty").c_str());
}

int main() {
    int st = 0;
    std::string body;
    if (!Rest("GET", "/v2/clock", &st, &body) || st != 200 ||
        body.find("\"is_open\":true") == std::string::npos) {
        std::printf("drill: market closed, nothing done\n");
        return 0;
    }
    bool ok = false;
    if (PositionQty(&ok) != 0 || !ok) {
        std::printf("drill: SPY position exists or unreadable, refusing\n");
        return 2;
    }
    TradeStream ts;
    std::string seen;
    for (int i = 0; i < 100 && !ts.live(); ++i) {
        char b[256];
        ts.Read(b, sizeof(b));
        usleep(100000);
    }
    std::printf("stream_live=%d\n", ts.live());

    AlpacaPaperAdapter ad(CurlTransport);
    std::string seed = "drill|" + std::to_string(std::time(nullptr)) + "|" +
                       std::to_string(getpid());
    std::string cid = jev::Sha256Hex(seed);
    ProtectedOrder o{};
    std::strcpy(o.symbol, "SPY");
    o.side = OrderSide::BUY;
    o.qty_shares = 1;
    o.stop_cents = 10000;  // far below any SPY price: rests, never triggers
    o.protection = Protection::OTO_STOP;
    std::strcpy(o.client_order_id, cid.c_str());
    std::strcpy(o.intent_id, "drill");
    OrderAck ack = ad.SubmitProtected(o);
    std::printf("oto_submit accepted=%d protected=%d\n", ack.accepted,
                ack.protection_accepted);
    bool filled = Pump(ts, seen, "event: fill\ndata: {\"order\":{\"client_order_id\":\"" + cid, 30);
    std::printf("stream_fill_event=%d\n", filled);
    int qty = 0;
    for (int i = 0; i < 20 && qty == 0; ++i) {
        qty = PositionQty(&ok);
        if (qty == 0) sleep(1);
    }
    std::printf("position_after_buy=%d\n", qty);

    if (qty == 1) {
        // Does the venue accept exit orders while the stop leg reserves the share?
        std::string c2 = jev::Sha256Hex(seed + "|moc");
        CloseResult moc = ad.CloseAtClose("SPY", 1, OrderSide::SELL, c2.c_str());
        std::printf("moc_sell_with_live_stop transport_ok=%d state=%d id=%d\n",
                    moc.transport_ok, (int)moc.state, moc.broker_order_id[0] != 0);
        if (moc.broker_order_id[0]) ad.Cancel(moc.broker_order_id);
        std::string c3 = jev::Sha256Hex(seed + "|mkt");
        CloseResult mk = ad.MarketClose("SPY", 1, OrderSide::SELL, c3.c_str());
        std::printf("market_sell_with_live_stop transport_ok=%d state=%d id=%d\n",
                    mk.transport_ok, (int)mk.state, mk.broker_order_id[0] != 0);
        sleep(2);
        std::printf("position_after_sell_attempts=%d\n", PositionQty(&ok));
        Rest("GET", "/v2/orders?status=open&nested=true", &st, &body);
        std::printf("open_orders_after_sell_attempts_len=%zu\n", body.size());
    }

    // Restore flat: cancel every open order, then close what is left.
    Rest("DELETE", "/v2/orders", &st, &body);
    sleep(2);
    Rest("DELETE", "/v2/positions/SPY", &st, &body);
    for (int i = 0; i < 20; ++i) {
        if (PositionQty(&ok) == 0 && ok) break;
        sleep(1);
    }
    int final_qty = PositionQty(&ok);
    Rest("GET", "/v2/orders?status=open&nested=true", &st, &body);
    std::printf("final_position=%d open_orders_body=%s\n", final_qty,
                body == "[]" ? "[]" : "not-empty");
    return (final_qty == 0 && ok && body == "[]") ? 0 : 1;
}
