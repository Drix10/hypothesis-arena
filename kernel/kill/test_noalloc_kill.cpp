// Slice D runtime proof (not only grep): wrapped-malloc counter
// around the kill evaluation + FSM + persistence path must stay zero.
// Usage: ./test_noalloc_kill
#include <cstddef>
#include <cstdio>

#include "switch.hpp"

extern "C" {
static int g_allocs = 0;
void* __real_malloc(std::size_t);
void* __real_calloc(std::size_t, std::size_t);
void* __real_realloc(void*, std::size_t);
void* __wrap_malloc(std::size_t n) {
    ++g_allocs;
    return __real_malloc(n);
}
void* __wrap_calloc(std::size_t n, std::size_t s) {
    ++g_allocs;
    return __real_calloc(n, s);
}
void* __wrap_realloc(void* p, std::size_t n) {
    ++g_allocs;
    return __real_realloc(p, n);
}
}

int main() {
    using jev::kill::FlattenState;
    using jev::kill::HardPhase;
    using jev::kill::KillInputs;
    KillInputs in;
    in.halt_file = in.feed_stale_gt30s = true;
    in.spend_tier = 2;
    jev::kill::FlattenStep fs;
    jev::kill::HardStep hs;
    jev::kill::Persisted ps;
    char buf[16];
    g_allocs = 0;  // static init above this line is not the path
    for (int i = 0; i < 20000; ++i) {
        // Cycle the exercised surface: all flatten states x
        // observation shapes, all hard phases, serialize + parse
        // (valid and malformed), evaluation + entry gate.
        fs.conditions_allow = (i & 1) != 0;
        fs.broker_confirms_flat = (i & 2) != 0;
        fs.closed_externally = (i & 4) != 0;
        fs.venue_closed_terminal = (i & 8) != 0;
        fs.prior_attempt_failed = (i & 16) != 0;
        hs.protection_present = (i & 1) != 0;
        hs.reestablished = (i & 2) != 0;
        hs.flatten_acked = (i & 4) != 0;
        hs.protection_confirmed = (i & 8) != 0;
        volatile auto r = jev::kill::EvaluateLevel(in);
        volatile auto e =
            jev::kill::EntriesAllowed(r.level, true, true);
        volatile auto f = jev::kill::StepFlatten(
            static_cast<jev::kill::FlattenState>(i % 4), fs);
        volatile auto h = jev::kill::StepHard(
            static_cast<jev::kill::HardPhase>(i % 7), hs);
        volatile auto s = jev::kill::SerializeKill(ps, buf, sizeof(buf));
        jev::kill::Persisted q;
        volatile auto pk = jev::kill::ParseKill(
            (i & 1) ? buf : "D1:9:0:0", &q);
        (void)e;
        (void)f;
        (void)h;
        (void)s;
        (void)pk;
        if (i == 0 && r.level == jev::risk::KillLevel::NONE) return 1;
    }
    if (g_allocs != 0) {
        std::printf("NOALLOC-KILL FAIL: %d allocs\n", g_allocs);
        return 1;
    }
    std::printf("NOALLOC-KILL: ALL PASS (0 allocs)\n");
    return 0;
}
