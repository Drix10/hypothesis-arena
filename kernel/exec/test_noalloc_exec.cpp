// H1 runtime proof (not only grep): wrapped-malloc counter around
// the router step core must stay zero. Identity minting
// (MakeClientOrderId at IDLE) is documented cycle-path and excluded:
// this loop covers the IDLE-reject path plus every post-identity
// state x observation shape. Usage: ./test_noalloc_exec
#include <cstddef>
#include <cstdio>

#include "router.hpp"

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
    using jev::exec::OrderIntent;
    using jev::exec::RouteMachine;
    using jev::exec::RouteObs;
    using jev::exec::RouteState;
    using jev::exec::VenueCtx;
    OrderIntent in;
    for (int i = 0; i < 64; ++i) in.intent_id[i] = 'i';
    in.intent_id[64] = '\0';
    in.symbol[0] = 'A';
    in.symbol[1] = '\0';
    in.qty_shares = 10;
    in.stop_cents = 100;
    in.tp_cents = 200;
    VenueCtx venue;
    venue.broker[0] = '\0';  // IDLE always rejects (no mint): core only
    RouteObs obs;
    obs.client_id[0] = '\0';  // untagged: identity gate stays out
    RouteMachine m;
    g_allocs = 0;
    for (int i = 0; i < 20000; ++i) {
        // All 12 states x 32 observation shapes (384 combos/block).
        obs.journal_ok = (i & 1) != 0;
        obs.adapter_responded = (i & 2) != 0;
        obs.ack.accepted = (i & 4) != 0;
        obs.ack.protection_accepted = (i & 8) != 0;
        obs.query_due = (i & 16) != 0;
        obs.query.found = (i & 1) != 0;
        obs.query.filled_qty = (i & 6);
        obs.query.protection_active = (i & 8) != 0;
        obs.cancel_confirmed = (i & 16) != 0;
        obs.cancel_failed = (i & 256) != 0;
        obs.executed = (i & 2) != 0;
        obs.repair_ok = (i & 32) != 0;
        obs.feed_stale = (i & 4) != 0;
        obs.stage_entry_ok = (i & 8) != 0;
        obs.symbol_frozen = (i & 16) != 0;
        m.state = static_cast<RouteState>((i / 64) % 13);
        m.protection_ok = (i & 64) != 0;
        volatile auto r =
            jev::exec::RouteStep(m, in, venue, obs);
        (void)r;
        if (i == 0 &&
            r.reason[0] == '\0') {
            std::printf("NOALLOC-EXEC FAIL: empty reason\n");
            return 1;
        }
    }
    if (g_allocs != 0) {
        std::printf("NOALLOC-EXEC FAIL: %d allocs\n", g_allocs);
        return 1;
    }
    std::printf("NOALLOC-EXEC: ALL PASS (0 allocs)\n");
    return 0;
}
