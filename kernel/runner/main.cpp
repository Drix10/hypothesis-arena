// H1 integration — G0 runner production entry (doc 06, doc 10,
// doc 13 sec. 13.5). Wires real dirs + wall clock; transport stays
// INJECTED-null until Phase 4 wires live HTTPS, so this binary
// CANNOT order by construction today (every adapter call refuses
// transport-unwired; the machine reconciles, never sends).
//
// The operator: creates <dir>/STAGE (human-signed G0_PAPER, capital
// 0, chained attest per plan/10 sec. 10.5), starts exactly one
// instance per dir. Intents arrive from the risk path (not yet
// wired — this entry idles, reconciles, and guards until then).
// HALT file or HARD kill stops the loop (exit status: 0 clean idle,
// 2 refused, 3 HARD).
#include <chrono>
#include <cstdio>
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "runner.hpp"

namespace {
long long WallNs(void*) {
    return (long long)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 2 || argc > 3) {
        std::printf("usage: g0_runner <dir> [cycles]\n");
        return 2;
    }
    long long cycles = 1;
    if (argc == 3) {
        cycles = 0;
        for (const char* p = argv[2]; *p; ++p) {
            if (*p < '0' || *p > '9') return 2;
            cycles = cycles * 10 + (*p - '0');
        }
        if (cycles <= 0 || cycles > 1000000) return 2;
    }
    jev::runner::RunnerConfig cfg;
    cfg.dir = argv[1];
    std::strncpy(cfg.venue.broker, "alpaca-paper", 31);
    std::strncpy(cfg.venue.account, "g0-paper", 31);
    std::strncpy(cfg.venue.context_hash,
                 "GENESIS-NO-SNAPSHOT-CONTEXT", 64);
    jev::runner::RunnerDeps deps;
    deps.transport = nullptr;  // Phase 4 wires live HTTPS (fail closed)
    deps.now_ns = WallNs;
    deps.restart_flag = true;  // operator-started (sec. 6.4 friction:
                               // flagless auto-restarts stay gated)
    jev::runner::G0Runner r(cfg, deps);
    const char* reason = nullptr;
    if (!r.Recover(&reason)) {
        std::printf("g0_runner: refused: %s\n", reason ? reason : "?");
        return 2;
    }
    for (long long i = 0; i < cycles; ++i) {
        if (!r.Cycle(WallNs(nullptr))) {
            std::printf("g0_runner: HARD stop\n");
            return 3;
        }
#ifdef _WIN32
        Sleep(1000);
#else
        sleep(1);
#endif
    }
    jev::runner::Summary s;
    if (r.Summarize(&s)) {
        char buf[256];
        if (jev::runner::FormatSummary(s, buf, sizeof(buf)))
            std::printf("g0_runner: %s\n", buf);
    }
    return 0;
}
