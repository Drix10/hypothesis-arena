// Slice F/G resource proof: the TICK path (ring Push, gap Notes,
// backoff, session marking) allocates zero heap. Context assembly +
// hashing is CYCLE path (bounded output, asserted <= 4KiB in
// test_context); it is not tick-hot and never claimed zero-alloc.
//
// Link: -static-libstdc++ -static-libgcc so operator new resolves to
// the wrapped malloc. Ring construction news once with counting OFF.
#include <cstdio>

#include "feed.hpp"

extern "C" {
void* __real_malloc(size_t n);
void* __real_calloc(size_t a, size_t b);
void* __real_realloc(void* p, size_t n);
}
static bool g_counting = false;
static unsigned long g_allocs = 0;
extern "C" {
void* __wrap_malloc(size_t n) {
    if (g_counting) g_allocs++;
    return __real_malloc(n);
}
void* __wrap_calloc(size_t a, size_t b) {
    if (g_counting) g_allocs++;
    return __real_calloc(a, b);
}
void* __wrap_realloc(void* p, size_t n) {
    if (g_counting) g_allocs++;
    return __real_realloc(p, n);
}
}

int main() {
    feed::TickRing ring;
    feed::SeqGap seq;
    feed::PollGap poll;
    feed::SessionCalendar cal;
    g_counting = true;
    for (int i = 1; i <= 70000; ++i) {
        feed::Tick t;
        t.micros = (long long)i * 1000LL;
        t.price_ud = 337220000LL;
        t.bid_ud = 337120000LL;
        t.ask_ud = 337220000LL;
        t.venue_seq = (unsigned long long)i;
        if (!ring.Push(t)) {
            std::printf("FAIL push-rejected\n");
            return 1;
        }
        if (seq.Note((unsigned long long)i)) {
            std::printf("FAIL seq-gap\n");
            return 1;
        }
        if (poll.Note((long long)i * 1000LL, 30000000LL)) {
            std::printf("FAIL poll-gap\n");
            return 1;
        }
        if (feed::BackoffDelayMs(i % 8) <= 0) {
            std::printf("FAIL backoff\n");
            return 1;
        }
        // Wednesday 2026-09-23 14:30 UTC + i seconds: session marks.
        if (feed::MarkSession(1758637800000000LL + (long long)i * 1000000LL,
                              cal) != feed::Session::kOpen &&
            i < 3600) {
            std::printf("FAIL session\n");
            return 1;
        }
    }
    g_counting = false;
    std::printf("allocs-during-tick-path: %lu\n", g_allocs);
    if (g_allocs != 0) {
        std::printf("FAIL tick-path-allocated\n");
        return 1;
    }
    if (ring.Size() != feed::TickRing::kCap ||
        ring.Writes() != 70000u) {
        std::printf("FAIL ring-state\n");
        return 1;
    }
    std::printf("FEED-NOALLOC: PASS\n");
    return 0;
}
