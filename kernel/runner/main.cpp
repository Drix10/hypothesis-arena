// Paper runner production entry. Wires real dirs and the wall clock; the
// transport stays null here (paper_loop wires the live one), so every adapter call refuses (transport-unwired) and the binary
// reconciles but never sends.
//
// Deployment: the operator starts exactly one instance per dir with a
// human-created STAGE file (human-signed PAPER, capital 0, chained attest
// per plan/stages.md). A supervisor owns the continuous window (restarts, the
// 30-day paper record) and must not auto-restart after a HARD stop (exit 3; forensics
// first). Resuming after a HALT-less restart needs --resume: without it the binary reconciles and manages exits but submits
// nothing new. cycles=0 runs until HARD/refused;
// 1..1000000 runs bounded. Intents arrive from the risk path (not yet wired),
// so this entry idles, reconciles and guards. A HALT file or HARD kill stops
// the loop (exit 0 clean idle, 2 refused, 3 HARD).
#include <chrono>
#include <cstdio>
#include <cstring>
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#endif

#include "runner.hpp"
#ifdef WITH_CURL
#include "../broker/http_curl.hpp"
#endif

namespace {
long long WallNs(void*) {
    return (long long)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
// Monotonic clock for reconcile cadence and timeouts, so wall jumps (NTP, operator)
// do not distort the reconcile rhythm. Audit timestamps, epochs and day
// accounting stay on WallNs.
long long MonoNs(void*) {
    return (long long)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 2 || argc > 5) {
        std::printf("usage: kernel_runner <dir> [cycles] [--resume] [--paper]\n");
        return 2;
    }
    long long cycles = 1;
    bool resume = false;
    bool paper = false;
    for (int a = 2; a < argc; ++a) {
        const char* p = argv[a];
        if (p[0] == '-' && p[1] == '-' && p[2] != '\0') {
            if (std::strcmp(p, "--resume") == 0) {
                resume = true;
                continue;
            }
            if (std::strcmp(p, "--paper") == 0) {
                paper = true;
                continue;
            }
            return 2;
        }
        if (cycles != 1) return 2;  // one count at most
        long long parsed = 0;
        if (!kernel::runner::ParseCycles(p, &parsed)) return 2;
        cycles = parsed;
        // 0 = unbounded (supervisor-owned window); 1..1000000
        // bounded. Unbounded still stops on HARD/refused.
        if (cycles < 0 || cycles > 1000000) return 2;
    }
    kernel::runner::RunnerConfig cfg;
    cfg.dir = argv[1];
    std::strncpy(cfg.venue.broker, "alpaca-paper", 31);
    std::strncpy(cfg.venue.account, "g0-paper", 31);
    std::strncpy(cfg.venue.context_hash,
                 "GENESIS-NO-SNAPSHOT-CONTEXT", 64);
    cfg.venue.context_hash[64] = '\0';
    kernel::runner::RunnerDeps deps;
    deps.transport = nullptr;  // fail closed unless --paper on a curl build
    if (paper) {
#ifdef WITH_CURL
        deps.transport = kernel::broker::CurlTransport;
#else
        std::printf("kernel_runner: --paper needs a WITH_CURL build\n");
        return 2;
#endif
    }
    deps.now_ns = WallNs;
    deps.mono_ns = MonoNs;
    deps.restart_flag = resume;  // friction: flagless
                                 // starts reconcile + manage exits
                                 // but submit nothing new
    kernel::runner::PaperRunner r(cfg, deps);
    const char* reason = nullptr;
    if (!r.Recover(&reason)) {
        std::printf("kernel_runner: refused: %s\n", reason ? reason : "?");
        return 2;
    }
    for (long long i = 0; cycles == 0 || i < cycles; ++i) {
        if (!r.Cycle(WallNs(nullptr))) {
            std::printf("kernel_runner: HARD stop\n");
            return 3;
        }
#ifdef _WIN32
        Sleep(1000);
#else
        sleep(1);
#endif
    }
    kernel::runner::Summary s;
    if (r.Summarize(&s)) {
        char buf[256];
        if (kernel::runner::FormatSummary(s, buf, sizeof(buf)))
            std::printf("kernel_runner: %s\n", buf);
    }
    return 0;
}
