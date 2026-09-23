// Slice F implementation. See feed.hpp for authority boundaries.
#include "feed.hpp"

namespace feed {
namespace {

// Howard Hinnant days-from-civil (pure int math, no tz database).
int64_t DaysFromCivil(int y, int m, int d) {
    y -= (m <= 2);
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

// Weekday from days-since-epoch: 1970-01-01 was Thursday (4; Sun=0).
int Weekday(int64_t days) {
    int w = static_cast<int>((days + 4) % 7);
    return w < 0 ? w + 7 : w;
}

// Nth Sunday of (year, month), 1-indexed, as days-since-epoch.
int64_t NthSunday(int y, int m, int n) {
    int64_t first = DaysFromCivil(y, m, 1);
    int off = (7 - Weekday(first)) % 7;
    return first + off + 7 * (n - 1);
}

void CivilFromDays(int64_t z, int* y, int* m, int* d) {
    z += 719468;
    int64_t era = (z >= 0 ? z : z - 146096) / 146097;
    int64_t doe = z - era * 146097;
    int64_t yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    int64_t yy = yoe + era * 400;
    int64_t doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    int64_t mp = (5 * doy + 2) / 153;
    *d = static_cast<int>(doy - (153 * mp + 2) / 5 + 1);
    *m = static_cast<int>(mp + (mp < 10 ? 3 : -9));
    *y = static_cast<int>(yy + (*m <= 2));
}

}  // namespace

TickRing::TickRing() : buf_(new Tick[kCap]) {}

static bool ValidTick(const Tick& t) {
    return t.micros > 0 && t.price_ud > 0 && t.bid_ud > 0 &&
           t.ask_ud >= t.bid_ud;
}

bool TickRing::Push(const Tick& t) {
    ++writes_;
    if (!ValidTick(t)) return false;
    buf_[head_] = t;
    head_ = (head_ + 1) % kCap;
    if (size_ < kCap) ++size_;
    return true;
}

size_t TickRing::Size() const { return size_; }
uint64_t TickRing::Writes() const { return writes_; }

const Tick& TickRing::At(size_t i) const {
    size_t oldest = (head_ + kCap - size_) % kCap;
    return buf_[(oldest + i) % kCap];
}

bool TickRing::GapLatched() const { return gap_; }
void TickRing::SetGap() { gap_ = true; }
void TickRing::ClearGap() { gap_ = false; }

bool SeqGap::Note(uint64_t seq) {
    if (seq == 0) return false;  // absent metadata: poll path owns it
    if (!have_seq) {
        have_seq = true;
        next_expected = seq + 1;
        return false;
    }
    if (seq == next_expected) {
        ++next_expected;
        return false;
    }
    if (seq < next_expected) {
        ++dups;
        return true;  // duplicate/reorder: gap latch, count it
    }
    next_expected = seq + 1;  // forward jump: resync + latch
    return true;
}

bool PollGap::Note(int64_t micros, int64_t max_gap_micros) {
    if (micros <= 0 || max_gap_micros <= 0) return true;
    if (!have_tick) {
        have_tick = true;
        last_micros = micros;
        return false;
    }
    bool gap = (micros - last_micros) > max_gap_micros;
    last_micros = micros;
    return gap;
}

int64_t BackoffDelayMs(int attempt) {
    if (attempt < 0) attempt = 0;
    if (attempt > 16) attempt = 16;  // saturate: 1<<16 already >= cap
    int64_t ms = int64_t{1000} << attempt;
    return ms > 60000 ? 60000 : ms;
}

void BackoffReset(int* attempt) {
    if (attempt) *attempt = 0;
}

int64_t EtOffsetSeconds(int64_t micros_utc) {
    int64_t days = micros_utc / 86400000000LL;
    int y, m, d;
    CivilFromDays(days, &y, &m, &d);
    // DST: second Sunday March 02:00 local -> first Sunday November
    // 02:00 local. Boundaries evaluated at day granularity with the
    // 02:00 hour rule folded in via UTC comparison below.
    int64_t dst_start_day = NthSunday(y, 3, 2);
    int64_t dst_end_day = NthSunday(y, 11, 1);
    int64_t secs_day =
        (micros_utc - days * 86400000000LL) / 1000000LL;
    if (days < dst_start_day || days > dst_end_day) return -18000;
    if (days > dst_start_day && days < dst_end_day) return -14400;
    if (days == dst_start_day) {
        // 02:00 EST = 07:00 UTC.
        return (secs_day >= 7 * 3600) ? -14400 : -18000;
    }
    // days == dst_end_day: 02:00 EDT = 06:00 UTC.
    return (secs_day >= 6 * 3600) ? -18000 : -14400;
}

Session MarkSession(int64_t micros_utc, const SessionCalendar& cal) {
    if (micros_utc <= 0) return Session::kClosed;  // no time, no session
    int64_t et = micros_utc + EtOffsetSeconds(micros_utc) * 1000000LL;
    int64_t days = et / 86400000000LL;
    int y, m, d;
    CivilFromDays(days, &y, &m, &d);
    int wd = Weekday(days);
    if (wd == 0 || wd == 6) return Session::kClosed;
    int stamp = y * 10000 + m * 100 + d;
    for (int h : cal.holidays)
        if (h == stamp) return Session::kHoliday;
    int64_t secs = (et - days * 86400000000LL) / 1000000LL;
    int minute = static_cast<int>(secs / 60);
    for (size_t i = 0; i < cal.early_days.size() &&
                       i < cal.early_close_min.size();
         ++i) {
        if (cal.early_days[i] == stamp) {
            int close_min = cal.early_close_min[i];
            if (minute < 9 * 60 + 30 || minute >= close_min)
                return Session::kClosed;
            return Session::kEarlyClose;
        }
    }
    if (minute < 9 * 60 + 30 || minute >= 16 * 60)
        return Session::kClosed;
    return Session::kOpen;
}

}  // namespace feed
