#include <cstdio>
#include <fstream>
#include <sstream>
#include <string>

#include "account.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

using namespace jev::runner;

int main(int argc, char** argv) {
    if (argc != 2) return 2;
    int64_t c = 0;
    CHECK("money-plain", ParseMoneyCents("100000", &c) && c == 10000000);
    CHECK("money-2dp", ParseMoneyCents("99999.87", &c) && c == 9999987);
    CHECK("money-truncates", ParseMoneyCents("1.999", &c) && c == 199);
    CHECK("money-negative", ParseMoneyCents("-12.5", &c) && c == -1250);
    for (const char* bad : {"", ".5", "5.", "1e3", "12a", "--1", "1.2.3",
                            " 1", "9999999999999999"})
        CHECK("money-bad", !ParseMoneyCents(bad, &c));

    std::ifstream f(std::string(argv[1]) + "/alpaca_account.json");
    std::stringstream ss;
    ss << f.rdbuf();
    AccountView a;
    CHECK("real-account-parses", ParseAccount(ss.str(), &a));
    CHECK("real-account-values", a.equity_cents == 10000000 &&
                                     a.cash_cents == 10000000 &&
                                     a.settled_cash_cents == 10000000 &&
                                     !a.blocked);
    std::string s = ss.str();
    size_t p = s.find("\"trading_blocked\":false");
    std::string blocked = s;
    blocked.replace(p, 23, "\"trading_blocked\":true");
    AccountView b;
    CHECK("blocked-flag", ParseAccount(blocked, &b) && b.blocked);
    std::string inactive = s;
    size_t q = inactive.find("\"ACTIVE\"");
    inactive.replace(q, 8, "\"ONBOARDING\"");
    CHECK("inactive-blocks", ParseAccount(inactive, &b) && b.blocked);
    CHECK("missing-field-fails", !ParseAccount("{\"equity\":\"1\"}", &b));
    CHECK("not-object-fails", !ParseAccount("[]", &b));

    std::vector<PositionView> ps;
    CHECK("no-positions", ParsePositions("[]", &ps) && ps.empty());
    CHECK("positions", ParsePositions(
        "[{\"symbol\":\"VTI\",\"qty\":\"12\",\"side\":\"long\","
        "\"market_value\":\"3012.40\"}]", &ps) && ps.size() == 1 &&
                           ps[0].symbol == "VTI" && ps[0].qty == 12 &&
                           ps[0].market_value_cents == 301240 && ps[0].is_long);
    CHECK("short-position-flagged", ParsePositions(
        "[{\"symbol\":\"X\",\"qty\":\"-3\",\"side\":\"short\","
        "\"market_value\":\"-90\"}]", &ps) && !ps[0].is_long);
    CHECK("fractional-flagged", ParsePositions(
        "[{\"symbol\":\"VTI\",\"qty\":\"0.000001\",\"side\":\"long\","
        "\"market_value\":\"0.03\"}]", &ps) && ps.size() == 1 &&
                                   ps[0].fractional && ps[0].qty == 0);
    std::vector<OrderView> os;
    CHECK("orders-parse", ParseOpenOrders(
        "[{\"symbol\":\"VTI\",\"side\":\"buy\",\"qty\":\"12\","
        "\"filled_qty\":\"5\"},{\"symbol\":\"IEF\",\"side\":\"sell\","
        "\"qty\":\"3\",\"filled_qty\":\"3\"}]", &os) &&
                              os.size() == 1 && os[0].remaining_qty == 7 &&
                              os[0].is_buy);
    CHECK("orders-bad", !ParseOpenOrders("[{\"symbol\":\"VTI\"}]", &os) &&
                            !ParseOpenOrders("{}", &os) &&
                            !ParseOpenOrders(
        "[{\"symbol\":\"V\",\"side\":\"buy\",\"qty\":\"1\","
        "\"filled_qty\":\"2\"}]", &os));
    // Bracket legs rest under the parent; a notional (qty-less) order still counts.
    CHECK("nested-legs-seen", ParseOpenOrders(
        "[{\"symbol\":\"VTI\",\"side\":\"buy\",\"qty\":\"5\",\"filled_qty\":\"5\","
        "\"legs\":[{\"symbol\":\"VTI\",\"side\":\"sell\",\"qty\":\"5\","
        "\"filled_qty\":\"0\"},{\"symbol\":\"VTI\",\"side\":\"sell\","
        "\"qty\":\"5\",\"filled_qty\":\"0\"}]}]", &os) &&
                              os.size() == 2 && !os[0].is_buy);
    CHECK("null-qty-order-tolerated", ParseOpenOrders(
        "[{\"symbol\":\"VTI\",\"side\":\"buy\",\"qty\":null,"
        "\"filled_qty\":\"0\",\"legs\":null}]", &os) &&
                              os.size() == 1 && os[0].remaining_qty == 1);
    CHECK("bad-position", !ParsePositions("[{\"symbol\":\"X\"}]", &ps));
    CHECK("bad-side", !ParsePositions(
        "[{\"symbol\":\"X\",\"qty\":\"1\",\"side\":\"flat\","
        "\"market_value\":\"1\"}]", &ps));
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
