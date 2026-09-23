// Slice F gate [correctness]: ring/gap/backoff/session. Usage: ./test_feed
#include <cstdio>
#include <string>

#include "feed.hpp"

static int g_fail = 0;

static void Check(bool cond, const char* name) {
    if (!cond) {
        ++g_fail;
        std::printf("FAIL %s\n", name);
    }
}

// 2026-09-23 14:30:00 UTC = 10:30 ET (EDT) Wednesday. micros helper.
static int64_t U(int y, int mo, int d, int h, int mi, int s = 0) {
    // days-from-civil in test (independent copy of the formula).
    int yy = y - (mo <= 2);
    long long era = (yy >= 0 ? yy : yy - 399) / 400;
    long long yoe = yy - era * 400;
    long long doy = (153 * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    long long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    long long days = era * 146097 + doe - 719468;
    return (days * 86400LL + h * 3600LL + mi * 60LL + s) * 1000000LL;
}

static feed::Tick Mk(int64_t micros, uint64_t seq = 0) {
    feed::Tick t;
    t.micros = micros;
    t.price_ud = 337220000LL;
    t.bid_ud = 337120000LL;
    t.ask_ud = 337220000LL;
    t.venue_seq = seq;
    return t;
}

int main() {
    using namespace feed;
    // 1. ring basic order + size
    {
        TickRing r;
        for (int i = 1; i <= 3; ++i) r.Push(Mk(i * 1000LL));
        Check(r.Size() == 3 && r.Writes() == 3, "ring-basic");
        Check(r.At(0).micros == 1000LL && r.At(2).micros == 3000LL,
              "ring-order");
    }
    // 2. overwrite-oldest at capacity: push kCap+5, oldest is #6
    {
        TickRing r;
        for (uint64_t i = 1; i <= TickRing::kCap + 5; ++i)
            r.Push(Mk(static_cast<int64_t>(i * 1000LL)));
        Check(r.Size() == TickRing::kCap, "ring-cap");
        Check(r.Writes() == TickRing::kCap + 5, "ring-writes-mono");
        Check(r.At(0).micros == 6000LL, "ring-overwrite-oldest");
        Check(r.At(r.Size() - 1).micros ==
                  static_cast<int64_t>((TickRing::kCap + 5) * 1000LL),
              "ring-newest");
    }
    // 3. invalid ticks dropped, counter still advances
    {
        TickRing r;
        Tick bad = Mk(1000LL);
        bad.ask_ud = bad.bid_ud - 1;  // crossed
        Check(!r.Push(bad), "ring-reject-crossed");
        Tick bad2 = Mk(-5LL);
        Check(!r.Push(bad2), "ring-reject-time");
        Check(r.Size() == 0 && r.Writes() == 2, "ring-drop-counts");
    }
    // 4. gap latch set/clear
    {
        TickRing r;
        Check(!r.GapLatched(), "gap-clear-init");
        r.SetGap();
        Check(r.GapLatched(), "gap-set");
        r.ClearGap();
        Check(!r.GapLatched(), "gap-clear");
    }
    // 5. venue-seq gaps: init, steady, dup, reorder, jump, zero-ignored
    {
        SeqGap g;
        Check(!g.Note(100), "seq-init");
        Check(!g.Note(101), "seq-steady");
        Check(g.Note(101), "seq-dup-latch");
        Check(g.dups == 1, "seq-dup-count");
        Check(g.Note(99), "seq-reorder-latch");
        Check(g.Note(105), "seq-jump-latch-resync");
        Check(!g.Note(106), "seq-steady-after-resync");
        Check(!g.Note(0), "seq-zero-ignored");
    }
    // 6. poll gaps: init never gaps; jump > max gaps; steady fine
    {
        PollGap p;
        Check(!p.Note(1000000LL, 30000000LL), "poll-init");
        Check(!p.Note(2000000LL, 30000000LL), "poll-steady");
        Check(p.Note(100000000LL, 30000000LL), "poll-jump-latch");
        Check(!p.Note(100001000LL, 30000000LL), "poll-steady-after");
        Check(p.Note(-1LL, 30000000LL), "poll-bad-time-latch");
    }
    // 7. backoff table + saturation
    {
        Check(BackoffDelayMs(0) == 1000, "bo-0");
        Check(BackoffDelayMs(1) == 2000, "bo-1");
        Check(BackoffDelayMs(5) == 32000, "bo-5");
        Check(BackoffDelayMs(6) == 60000, "bo-cap");
        Check(BackoffDelayMs(100) == 60000, "bo-saturate");
        Check(BackoffDelayMs(-3) == 1000, "bo-negative");
        int a = 7;
        BackoffReset(&a);
        Check(a == 0, "bo-reset");
        BackoffReset(nullptr);
        Check(true, "bo-reset-null");
    }
    // 8. ET offset: winter EST, summer EDT, transition hours 2026
    {
        Check(EtOffsetSeconds(U(2026, 1, 15, 12, 0)) == -18000,
              "et-est");
        Check(EtOffsetSeconds(U(2026, 7, 15, 12, 0)) == -14400,
              "et-edt");
        // DST starts 2026-03-08 02:00 EST = 07:00 UTC.
        Check(EtOffsetSeconds(U(2026, 3, 8, 6, 59)) == -18000,
              "et-pre-spring");
        Check(EtOffsetSeconds(U(2026, 3, 8, 7, 0)) == -14400,
              "et-post-spring");
        // DST ends 2026-11-01 02:00 EDT = 06:00 UTC.
        Check(EtOffsetSeconds(U(2026, 11, 1, 5, 59)) == -14400,
              "et-pre-fall");
        Check(EtOffsetSeconds(U(2026, 11, 1, 6, 0)) == -18000,
              "et-post-fall");
    }
    // 9. session: open, pre-open, post-close, weekend, holiday,
    //    early close, bad time
    {
        SessionCalendar cal;
        Check(MarkSession(U(2026, 9, 23, 14, 30), cal) ==
                  Session::kOpen,
              "sess-open");
        Check(MarkSession(U(2026, 9, 23, 13, 29), cal) ==
                  Session::kClosed,
              "sess-preopen");
        Check(MarkSession(U(2026, 9, 23, 20, 1), cal) ==
                  Session::kClosed,
              "sess-postclose");
        Check(MarkSession(U(2026, 9, 26, 14, 30), cal) ==
                  Session::kClosed,
              "sess-saturday");
        Check(MarkSession(0, cal) == Session::kClosed, "sess-badtime");
        SessionCalendar cal2;
        cal2.holidays.push_back(20260923);
        Check(MarkSession(U(2026, 9, 23, 14, 30), cal2) ==
                  Session::kHoliday,
              "sess-holiday");
        SessionCalendar cal3;
        cal3.early_days.push_back(20260923);
        cal3.early_close_min.push_back(780);
        Check(MarkSession(U(2026, 9, 23, 14, 30), cal3) ==
                  Session::kEarlyClose,
              "sess-early-open");
        Check(MarkSession(U(2026, 9, 23, 17, 30), cal3) ==
                  Session::kClosed,
              "sess-early-after");
    }
    if (g_fail == 0) std::printf("FEED SUITE: ALL PASS\n");
    return g_fail ? 1 : 0;
}
