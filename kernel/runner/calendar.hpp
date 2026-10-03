// US equity session calendar for the hourly data-age gate (R6/R7). Regular
// session hourly bars start at 09:00..15:00 America/New_York (the first covers
// 09:30-10:00). Early closes (13:00 ET) are modeled when the calendar lists them;
// unlisted ones only make the gate stricter.
#pragma once
#include <cstdint>
#include <set>

namespace kernel {
namespace runner {

// UTC offset of America/New_York at `utc_s`, in seconds (-14400 or -18000).
int64_t EtOffsetSeconds(int64_t utc_s);

bool IsSessionDay(int64_t day, const std::set<int64_t>& holidays);

// Days since 1970-01-01 of a civil date.
int64_t DaysFromCivil(int y, unsigned m, unsigned d);

// Regular-session hourly bars that have completed in (last_bar_start_utc_s,
// now_utc_s] and are therefore expected but not seen.
// `early` (optional) lists early-close days (13:00 ET): last bar starts 12:00.
int ExpectedBarsBetween(int64_t last_bar_start_utc_s, int64_t now_utc_s,
                        const std::set<int64_t>& holidays,
                        const std::set<int64_t>* early = nullptr);

// Last regular-session hourly bar start hour (ET): 15, or 12 on early closes.
int LastBarHour(int64_t day, const std::set<int64_t>* early);

}  // namespace runner
}  // namespace kernel
