// Adapter against a verbatim live-venue reply (sanitized ids): the fakes in
// test_broker.cpp are hand-written, this pins the real shape.
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>

#include "alpaca_paper.hpp"

using namespace kernel::broker;

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
static std::string g_last_req;
static size_t g_cap = 8191;

static HttpResult Fake(const HttpRequest& r) {
    HttpResult out;
    g_last_req = r.body ? r.body : "";
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

    g_cap = 2048;  // a small body cap cuts off the legs: protection unproven
    OrderAck t = ad.SubmitProtected(o);
    CHECK("truncated-reply-not-protected", !t.protection_accepted);

    // OTO stop-only: one stop leg proves protection; a limit leg, two legs or
    // a bracket reply does not.
    const char* oto_ok =
        "{\"id\":\"11111111-2222-3333-4444-555555555555\",\"qty\":\"1\","
        "\"filled_qty\":\"0\",\"status\":\"accepted\",\"order_class\":\"oto\","
        "\"legs\":[{\"id\":\"66666666-2222-3333-4444-555555555555\","
        "\"type\":\"stop\",\"side\":\"sell\"}]}";
    ProtectedOrder t1 = o;
    t1.protection = Protection::OTO_STOP;
    t1.tp_cents = 0;
    t1.gtc = true;
    g_body = oto_ok;
    OrderAck oa = ad.SubmitProtected(t1);
    CHECK("oto-accepted-protected", oa.accepted && oa.protection_accepted);
    CHECK("oto-body-shape",
          g_last_req.find("\"order_class\":\"oto\"") != std::string::npos &&
              g_last_req.find("\"time_in_force\":\"gtc\"") !=
                  std::string::npos &&
              g_last_req.find("take_profit") == std::string::npos &&
              g_last_req.find("\"stop_price\":\"1.00\"") != std::string::npos);
    CHECK("oto-query-protected",
          ad.QueryOnce(t1.client_order_id).protection_active);
    ProtectedOrder t2 = o;
    t2.tp_cents = 0;  // bracket without a target is refused before the wire
    g_last_req.clear();
    CHECK("bracket-needs-tp",
          !ad.SubmitProtected(t2).accepted && g_last_req.empty());
    std::string two_legs = oto_ok;
    two_legs.replace(two_legs.find("]}"), 2,
                     ",{\"id\":\"77777777-2222-3333-4444-555555555555\","
                     "\"type\":\"stop\"}]}");
    g_body = two_legs;
    CHECK("oto-two-legs-unproven", !ad.SubmitProtected(t1).protection_accepted);
    std::string limit_leg = oto_ok;
    limit_leg.replace(limit_leg.find("\"type\":\"stop\""), 14,
                      "\"type\":\"limit\"");
    g_body = limit_leg;
    CHECK("oto-limit-leg-unproven",
          !ad.SubmitProtected(t1).protection_accepted);
    std::string no_legs = oto_ok;
    no_legs.replace(no_legs.find("[{"), no_legs.find("]}") - no_legs.find("[{") + 1,
                    "null");
    g_body = no_legs;
    CHECK("oto-null-legs-unproven",
          !ad.SubmitProtected(t1).protection_accepted);
    // Repair for the stop-only shape places a plain stop order.
    g_body = "{\"id\":\"88888888-2222-3333-4444-555555555555\","
             "\"type\":\"stop\",\"status\":\"accepted\"}";
    CHECK("oto-repair-stop-only", ad.EstablishProtection(t1) &&
          g_last_req.find("\"type\":\"stop\"") != std::string::npos &&
          g_last_req.find("\"side\":\"sell\"") != std::string::npos);
    // A bracket's filled quantity is re-protected as an OCO pair that keeps
    // the entry's lifetime: GTC when the entry was GTC, else day.
    ProtectedOrder t3 = o;
    t3.protection = Protection::BRACKET;
    t3.gtc = true;
    ad.EstablishProtection(t3);
    CHECK("oco-repair-gtc",
          g_last_req.find("\"order_class\":\"oco\"") != std::string::npos &&
              g_last_req.find("\"time_in_force\":\"gtc\"") !=
                  std::string::npos);
    CHECK("oco-stop-limit-past-stop",
          g_last_req.find("\"stop_price\":\"1.00\",\"limit_price\":\"0.98\"") !=
              std::string::npos);
    t3.gtc = false;
    ad.EstablishProtection(t3);
    CHECK("oco-repair-day",
          g_last_req.find("\"time_in_force\":\"day\"") != std::string::npos);
    // MOC rides time_in_force cls on the same close lifecycle.
    g_body = "{\"id\":\"99999999-2222-3333-4444-555555555555\","
             "\"status\":\"accepted\",\"qty\":\"1\",\"filled_qty\":\"0\"}";
    CloseResult cr = ad.CloseAtClose("SPY", 1, OrderSide::SELL, o.client_order_id);
    CHECK("moc-cls-tif",
          g_last_req.find("\"time_in_force\":\"cls\"") != std::string::npos &&
              g_last_req.find("\"side\":\"sell\"") != std::string::npos);
    CHECK("moc-pending-not-executed", cr.state == CloseState::PENDING && !cr.executed);
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
