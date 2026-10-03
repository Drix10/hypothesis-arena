#include "calendar.hpp"

namespace kernel {
namespace runner {
namespace {

void CivilFromDays(int64_t z, int* y, unsigned* m, unsigned* d) {
    z += 719468;
    int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097);
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t yy = (int64_t)yoe + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned mp = (5 * doy + 2) / 153;
    *d = doy - (153 * mp + 2) / 5 + 1;
    *m = mp < 10 ? mp + 3 : mp - 9;
    *y = (int)(yy + (*m <= 2));
}

int Weekday(int64_t day) { return (int)(((day % 7) + 7 + 4) % 7); }  // 0=Sun

int64_t NthSunday(int y, unsigned m, int n) {
    int64_t first = DaysFromCivil(y, m, 1);
    int64_t off = (7 - Weekday(first)) % 7;
    return first + off + 7 * (n - 1);
}

}  // namespace

int64_t DaysFromCivil(int y, unsigned m, unsigned d) {
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

int64_t EtOffsetSeconds(int64_t utc_s) {
    int64_t day = utc_s >= 0 ? utc_s / 86400 : -((-utc_s + 86399) / 86400);
    int y;
    unsigned m, d;
    CivilFromDays(day, &y, &m, &d);
    // DST: 02:00 EST on the second Sunday of March (07:00 UTC) to 02:00 EDT
    // on the first Sunday of November (06:00 UTC).
    int64_t start = NthSunday(y, 3, 2) * 86400 + 7 * 3600;
    int64_t end = NthSunday(y, 11, 1) * 86400 + 6 * 3600;
    return (utc_s >= start && utc_s < end) ? -4 * 3600 : -5 * 3600;
}

bool IsSessionDay(int64_t day, const std::set<int64_t>& holidays) {
    int w = Weekday(day);
    return w != 0 && w != 6 && holidays.count(day) == 0;
}

int LastBarHour(int64_t day, const std::set<int64_t>* early) {
    return (early && early->count(day)) ? 12 : 15;
}

int ExpectedBarsBetween(int64_t last_bar_start_utc_s, int64_t now_utc_s,
                        const std::set<int64_t>& holidays,
                        const std::set<int64_t>* early) {
    if (now_utc_s <= last_bar_start_utc_s) return 0;
    int64_t first_day = (last_bar_start_utc_s +
                         EtOffsetSeconds(last_bar_start_utc_s)) / 86400;
    int64_t last_day = (now_utc_s + EtOffsetSeconds(now_utc_s)) / 86400;
    if (last_day - first_day > 60) return 1000;  // absurd gap: maximally stale
    int n = 0;
    for (int64_t day = first_day; day <= last_day; ++day) {
        if (!IsSessionDay(day, holidays)) continue;
        for (int hour = 9; hour <= LastBarHour(day, early); ++hour) {
            int64_t local_start = day * 86400 + hour * 3600;
            // The offset at the bar's own instant (DST boundaries fall
            // overnight, never inside the session).
            int64_t start_utc = local_start - EtOffsetSeconds(local_start + 18000);
            if (start_utc > last_bar_start_utc_s &&
                start_utc + 3600 <= now_utc_s)
                ++n;
        }
    }
    return n;
}

}  // namespace runner
}  // namespace kernel
