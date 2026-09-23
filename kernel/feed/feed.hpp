// Slice F — feed state machines (doc 04 sec. 4.2.2). Pure logic, no
// I/O, no network, no clock reads: every function takes explicit
// inputs. This slice is machinery ONLY and never a second authority:
// it records ticks, flags gaps, schedules reconnects, and marks
// sessions. Veto/staleness decisions belong to risk/ctx downstream.
// All money integers (micro-dollars, micros-UTC); no floats anywhere.
#pragma once
#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace feed {

// One normalized tick. venue_seq = 0 means the venue supplies no
// sequence metadata (poll path); gap detection then uses cadence.
struct Tick {
    int64_t micros = 0;       // UTC epoch micros, must be > 0
    int64_t price_ud = 0;     // last price, micro-dollars, > 0
    int64_t bid_ud = 0;       // > 0
    int64_t ask_ud = 0;       // >= bid_ud
    uint64_t venue_seq = 0;   // 0 = absent
    uint32_t flags = 0;
};

// Fixed lock-free-shaped ring (single-threaded core; the lock-free
// claim for the threaded driver is integration scope). Capacity frozen
// at 65536 per doc 04. Overwrite-oldest; a monotonic write counter
// survives overwrite so readers can detect loss.
class TickRing {
public:
    static constexpr size_t kCap = 65536;
    TickRing();
    // Push returns false (tick dropped, counter still advances) only
    // for a structurally invalid tick; valid ticks always land.
    bool Push(const Tick& t);
    size_t Size() const;        // <= kCap
    uint64_t Writes() const;    // monotonic, never decreases
    const Tick& At(size_t i) const;  // 0 = oldest retained
    bool GapLatched() const;
    void SetGap();
    void ClearGap();

private:
    // Heap-once at construction (never on the tick path): a 65536
    // member array would blow the typical 1MB thread stack.
    std::unique_ptr<Tick[]> buf_;
    size_t head_ = 0;   // next write slot
    size_t size_ = 0;
    uint64_t writes_ = 0;
    bool gap_ = false;
};

// Venue-sequence gap detector. First observed seq initializes; a seq
// <= last is a duplicate/reorder (counts, latches gap); a forward jump
// latches gap. Pure compare-and-advance.
struct SeqGap {
    bool have_seq = false;
    uint64_t next_expected = 0;
    uint64_t dups = 0;
    // Returns true when this observation latches a gap.
    bool Note(uint64_t seq);
};

// Poll-cadence gap detector for venues without sequence metadata
// (Alpaca REST poll path): gap when micros jump more than max_gap
// since the previous tick. First tick initializes, never gaps.
struct PollGap {
    bool have_tick = false;
    int64_t last_micros = 0;
    // Returns true when this observation latches a gap.
    bool Note(int64_t micros, int64_t max_gap_micros);
};

// Deterministic reconnect backoff: 1s << attempt capped at 60s.
// No jitter (determinism beats thundering-herd here: one venue, one
// client). attempt saturates instead of overflowing.
int64_t BackoffDelayMs(int attempt);
void BackoffReset(int* attempt);

// US-equities session marking (Alpaca paper venue). ET offset from
// pure date math (second Sunday March -> first Sunday November);
// regular session 09:30-16:00 ET. Early closes and holidays come from
// caller-supplied day lists (YYYYMMDD ints; early map day -> close
// minute-of-day ET, default 13:00 via entry value 780). An unlisted day
// reads OPEN-advisory: session marking is advisory only — feed
// staleness (gap latch + 30s veto downstream) is the real authority,
// so a missed holiday can never authorize risk, only admit ticks.
enum class Session { kOpen, kClosed, kHoliday, kEarlyClose };

struct SessionCalendar {
    std::vector<int> holidays;       // YYYYMMDD, sorted not required
    std::vector<int> early_days;     // YYYYMMDD parallel to early_close_min
    std::vector<int> early_close_min;  // minute-of-day ET
};

int64_t EtOffsetSeconds(int64_t micros_utc);  // -18000 or -14400
Session MarkSession(int64_t micros_utc, const SessionCalendar& cal);

}  // namespace feed
