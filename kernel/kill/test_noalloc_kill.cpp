// Runtime proof (not only grep): wrapped-malloc counter
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
    using kernel::kill::FlattenState;
    using kernel::kill::HardPhase;
    using kernel::kill::KillInputs;
    KillInputs in;
    in.halt_file = in.feed_stale_gt30s = true;
    in.spend_tier = 2;
    kernel::kill::FlattenStep fs;
    kernel::kill::HardStep hs;
    kernel::kill::Persisted ps;
    char buf[16];
    g_allocs = 0;  // static init above this line is not the path
    for (int i = 0; i < 20000; ++i) {
        // Cycle the exercised surface: all flatten states x
        // observation shapes, all hard phases, serialize + parse
        // (valid and malformed), evaluation + entry gate.
        // Decoupled indices: flatten state advances once per 32
        // observation shapes ((i / 32) % 4), so every state sees every
        // shape (all 4 x 32 = 128 combos per 128-iteration block).
        // HARD phase uses i % 7: 7 is coprime to 32 and 128, so all
        // 7 x 32 phase/observation combos occur too.
        fs.conditions_allow = (i & 1) != 0;
        fs.broker_confirms_flat = (i & 2) != 0;
        fs.closed_externally = (i & 4) != 0;
        fs.venue_closed_terminal = (i & 8) != 0;
        fs.prior_attempt_failed = (i & 16) != 0;
        hs.protection_present = (i & 1) != 0;
        hs.reestablished = (i & 2) != 0;
        hs.flatten_acked = (i & 4) != 0;
        hs.protection_confirmed = (i & 8) != 0;
        volatile auto r = kernel::kill::EvaluateLevel(in);
        volatile auto e =
            kernel::kill::EntriesAllowed(r.level, true, true);
        volatile auto f = kernel::kill::StepFlatten(
            static_cast<kernel::kill::FlattenState>((i / 32) % 4), fs);
        volatile auto h = kernel::kill::StepHard(
            static_cast<kernel::kill::HardPhase>(i % 7), hs);
        volatile auto s = kernel::kill::SerializeKill(ps, buf, sizeof(buf));
        kernel::kill::Persisted q;
        volatile auto pk = kernel::kill::ParseKill(
            (i & 1) ? buf : "KF:9:0:0", &q);
        (void)e;
        (void)f;
        (void)h;
        (void)s;
        (void)pk;
        if (i == 0 && r.level == kernel::risk::KillLevel::NONE) return 1;
    }
    if (g_allocs != 0) {
        std::printf("NOALLOC-KILL FAIL: %d allocs\n", g_allocs);
        return 1;
    }
    std::printf("NOALLOC-KILL: ALL PASS (0 allocs)\n");
    return 0;
}
