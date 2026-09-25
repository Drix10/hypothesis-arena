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
    fs.conditions_allow = true;
    jev::kill::HardStep hs;
    hs.protection_present = hs.protection_confirmed = true;
    jev::kill::Persisted ps;
    char buf[16];
    g_allocs = 0;  // static init above this line is not the path
    for (int i = 0; i < 20000; ++i) {
        volatile auto r = jev::kill::EvaluateLevel(in);
        volatile auto e =
            jev::kill::EntriesAllowed(r.level, true, true);
        volatile auto f = jev::kill::StepFlatten(
            FlattenState::MEDIUM_ACTIVE, fs);
        volatile auto h =
            jev::kill::StepHard(HardPhase::IDLE, hs);
        volatile auto s = jev::kill::SerializeKill(ps, buf, sizeof(buf));
        (void)e;
        (void)f;
        (void)h;
        (void)s;
        if (i == 0 && r.level == jev::risk::KillLevel::NONE) return 1;
    }
    if (g_allocs != 0) {
        std::printf("NOALLOC-KILL FAIL: %d allocs\n", g_allocs);
        return 1;
    }
    std::printf("NOALLOC-KILL: ALL PASS (0 allocs)\n");
    return 0;
}
