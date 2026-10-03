#include <cstdio>

#include "calendar.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

using namespace kernel::runner;

static int64_t Utc(int y, unsigned m, unsigned d, int h, int mi = 0) {
    return DaysFromCivil(y, m, d) * 86400 + h * 3600 + mi * 60;
}

int main() {
    CHECK("civil-epoch", DaysFromCivil(1970, 1, 1) == 0);
    CHECK("civil-2026-09-28", DaysFromCivil(2026, 9, 28) == 20724);

    CHECK("edt-summer", EtOffsetSeconds(Utc(2026, 9, 28, 12)) == -4 * 3600);
    CHECK("est-winter", EtOffsetSeconds(Utc(2026, 1, 5, 12)) == -5 * 3600);
    // 2026 DST: starts Sun 2026-03-08 07:00 UTC, ends Sun 2026-11-01 06:00 UTC.
    CHECK("before-spring-forward", EtOffsetSeconds(Utc(2026, 3, 8, 6, 59)) == -5 * 3600);
    CHECK("after-spring-forward", EtOffsetSeconds(Utc(2026, 3, 8, 7, 0)) == -4 * 3600);
    CHECK("before-fall-back", EtOffsetSeconds(Utc(2026, 11, 1, 5, 59)) == -4 * 3600);
    CHECK("after-fall-back", EtOffsetSeconds(Utc(2026, 11, 1, 6, 0)) == -5 * 3600);

    std::set<int64_t> none;
    // Friday 2026-09-25 15:00 ET (19:00Z) is the last bar; Monday 09:59 ET.
    int64_t last = Utc(2026, 9, 25, 19);
    CHECK("weekend-not-stale", ExpectedBarsBetween(last, Utc(2026, 9, 28, 13, 59), none) == 0);
    CHECK("first-bar-completes", ExpectedBarsBetween(last, Utc(2026, 9, 28, 14, 0), none) == 1);
    CHECK("two-bars", ExpectedBarsBetween(last, Utc(2026, 9, 28, 15, 0), none) == 2);
    CHECK("same-hour-none", ExpectedBarsBetween(last, last + 1800, none) == 0);
    CHECK("full-day-missing", ExpectedBarsBetween(Utc(2026, 9, 28, 19), Utc(2026, 9, 29, 20), none) == 7);
    std::set<int64_t> hol = {DaysFromCivil(2026, 9, 28)};
    CHECK("holiday-not-expected", ExpectedBarsBetween(last, Utc(2026, 9, 28, 23), hol) == 0);
    // Winter: Friday 2026-01-02 last bar 15:00 ET = 20:00Z; Monday bars start 14:00Z.
    int64_t wlast = Utc(2026, 1, 2, 20);
    CHECK("winter-first-bar", ExpectedBarsBetween(wlast, Utc(2026, 1, 5, 15, 0), none) == 1);
    CHECK("winter-before", ExpectedBarsBetween(wlast, Utc(2026, 1, 5, 14, 59), none) == 0);
    CHECK("absurd-gap", ExpectedBarsBetween(0, Utc(2026, 9, 28, 13), none) >= 1000);
    CHECK("now-before-last", ExpectedBarsBetween(last, last - 5, none) == 0);
    // Early close Fri 2026-11-27 (13:00 ET): last bar starts 12:00 ET = 17:00Z.
    std::set<int64_t> early = {DaysFromCivil(2026, 11, 27)};
    int64_t elast = Utc(2026, 11, 27, 17);
    CHECK("early-close-no-phantom-bars",
          ExpectedBarsBetween(elast, Utc(2026, 11, 30, 14, 59), none, &early) == 0);
    CHECK("unlisted-early-close-stricter",
          ExpectedBarsBetween(elast, Utc(2026, 11, 30, 14, 59), none) == 3);
    CHECK("early-close-last-hour", LastBarHour(DaysFromCivil(2026, 11, 27), &early) == 12);
    CHECK("normal-last-hour", LastBarHour(DaysFromCivil(2026, 11, 30), &early) == 15);
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
