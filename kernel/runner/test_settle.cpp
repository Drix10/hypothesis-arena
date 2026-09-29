#include <cstdio>

#include "settle.hpp"

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

// 2026-09-28 (Monday) = day 20359 since 1970-01-01.
static const int64_t MON = 20724;

int main() {
    std::set<int64_t> none;
    CHECK("mon-to-tue", NextSessionDay(MON, none) == MON + 1);
    CHECK("fri-to-mon", NextSessionDay(MON + 4, none) == MON + 7);
    CHECK("sat-to-mon", NextSessionDay(MON + 5, none) == MON + 7);
    std::set<int64_t> hol = {MON + 1};
    CHECK("holiday-skipped", NextSessionDay(MON, hol) == MON + 2);
    std::set<int64_t> long_wknd = {MON + 7};  // Monday holiday after Friday
    CHECK("friday-before-monday-holiday",
          NextSessionDay(MON + 4, long_wknd) == MON + 8);

    SettleBook b;
    b.Record(MON, 500000, none);   // sold Monday: usable Tuesday
    CHECK("unsettled-same-day", b.UnsettledCents(MON) == 500000);
    CHECK("settled-next-session", b.UnsettledCents(MON + 1) == 0);
    CHECK("settled-cash-nets", b.SettledCents(1000000, MON) == 500000);
    CHECK("settled-cash-floors-at-zero", b.SettledCents(100, MON) == 0);
    b.Record(MON + 4, 200000, none);  // Friday sale settles Monday
    CHECK("friday-sale-open-over-weekend", b.UnsettledCents(MON + 5) == 200000);
    CHECK("friday-sale-settles-monday", b.UnsettledCents(MON + 7) == 0);
    b.Record(MON, 0, none);
    b.Record(MON, -5, none);
    CHECK("nonpositive-ignored", b.size() == 2);
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
