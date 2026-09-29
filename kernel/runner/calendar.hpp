// US equity session calendar for the hourly data-age gate (R6/R7).
// Regular-session hourly bars start at 09:00..15:00 America/New_York
// (hour-aligned, the first covers 09:30-10:00). Early closes are not modeled;
// they make the gate stricter, never looser.
#pragma once
#include <cstdint>
#include <set>

namespace jev {
namespace runner {

// UTC offset of America/New_York at `utc_s`, in seconds (-14400 or -18000).
int64_t EtOffsetSeconds(int64_t utc_s);

bool IsSessionDay(int64_t day, const std::set<int64_t>& holidays);

// Days since 1970-01-01 of a civil date.
int64_t DaysFromCivil(int y, unsigned m, unsigned d);

// Regular-session hourly bars that have completed in (last_bar_start_utc_s,
// now_utc_s] and are therefore expected but not seen.
int ExpectedBarsBetween(int64_t last_bar_start_utc_s, int64_t now_utc_s,
                        const std::set<int64_t>& holidays);

}  // namespace runner
}  // namespace jev
