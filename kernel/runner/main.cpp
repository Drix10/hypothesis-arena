// H1 integration — G0 runner production entry (doc 06, doc 10,
// doc 13 sec. 13.5). Wires real dirs + wall clock; transport stays
// INJECTED-null until Phase 4 wires live HTTPS, so this binary
// CANNOT order by construction today (every adapter call refuses
// transport-unwired; the machine reconciles, never sends).
//
// DEPLOYMENT CONTRACT (who owns what — the binary never supervises
// itself): the operator starts exactly one instance per dir with a
// human-created STAGE file; a SUPERVISOR owns the continuous window
// (restarts, 30-day H2 coverage) and MUST NEVER auto-restart after
// a HARD stop (exit 3 — forensics first, doc 10 sec. 10.3); resume
// after a HALT-less restart needs the explicit --resume flag (doc 06
// sec. 6.4 friction: without it the binary reconciles + manages
// exits but submits nothing new). cycles=0 runs until HARD/refused
// (the H2 unbounded mode); 1..1000000 runs bounded.
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
    if (argc < 2 || argc > 4) {
        std::printf("usage: g0_runner <dir> [cycles] [--resume]\n");
        return 2;
    }
    long long cycles = 1;
    bool resume = false;
    for (int a = 2; a < argc; ++a) {
        const char* p = argv[a];
        if (p[0] == '-' && p[1] == '-' && p[2] != '\0') {
            if (std::strcmp(p, "--resume") == 0) {
                resume = true;
                continue;
            }
            return 2;
        }
        if (cycles != 1) return 2;  // one count at most
        cycles = 0;
        for (; *p; ++p) {
            if (*p < '0' || *p > '9') return 2;
            cycles = cycles * 10 + (*p - '0');
        }
        // 0 = unbounded (supervisor-owned window); 1..1000000
        // bounded. Unbounded still stops on HARD/refused.
        if (cycles < 0 || cycles > 1000000) return 2;
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
    deps.restart_flag = resume;  // sec. 6.4 friction: flagless
                                 // starts reconcile + manage exits
                                 // but submit nothing new
    jev::runner::G0Runner r(cfg, deps);
    const char* reason = nullptr;
    if (!r.Recover(&reason)) {
        std::printf("g0_runner: refused: %s\n", reason ? reason : "?");
        return 2;
    }
    for (long long i = 0; cycles == 0 || i < cycles; ++i) {
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
