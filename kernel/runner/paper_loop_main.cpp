// Paper loop entry (needs a G0_WITH_CURL build). The operator supplies, in
// <dir>: STAGE (human-signed), approved.json (sleeves + allowlist) and the
// exchange calendar path. Runs against the Alpaca paper host only.
//
//   g0_paper_loop <dir> <calendar.json> [--ticks N] [--interval-s S]
//
// Exit: 0 clean, 2 refused to start, 3 HARD stop.
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <unistd.h>

#include "../broker/http_curl.hpp"
#include "approved.hpp"
#include "paper_loop.hpp"

namespace {
long long WallNs(void*) {
    return (long long)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::system_clock::now().time_since_epoch())
        .count();
}
long long MonoNs(void*) {
    return (long long)std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 3) {
        std::printf("usage: g0_paper_loop <dir> <calendar.json> [--ticks N] "
                    "[--interval-s S]\n");
        return 2;
    }
    long long ticks = 1, interval = 60;
    for (int a = 3; a + 1 < argc; a += 2) {
        if (std::strcmp(argv[a], "--ticks") == 0) ticks = std::atoll(argv[a + 1]);
        else if (std::strcmp(argv[a], "--interval-s") == 0)
            interval = std::atoll(argv[a + 1]);
        else return 2;
    }
    if (ticks < 0 || interval < 1) return 2;

    jev::runner::LoopConfig lc;
    lc.dir = argv[1];
    std::string text;
    if (!jev::runner::ReadFile(lc.dir + "/approved.json", &text) ||
        !jev::runner::ParseApproved(text, &lc.tables)) {
        std::printf("g0_paper_loop: refused: approved.json missing or invalid\n");
        return 2;
    }
    if (!jev::runner::ReadFile(argv[2], &text) ||
        !jev::runner::ParseCalendar(text, &lc.holidays)) {
        std::printf("g0_paper_loop: refused: calendar missing or invalid\n");
        return 2;
    }

    jev::runner::RunnerConfig cfg;
    cfg.dir = lc.dir;
    std::strncpy(cfg.venue.broker, "alpaca-paper", 31);
    std::strncpy(cfg.venue.account, "g0-paper", 31);
    std::strncpy(cfg.venue.context_hash, "GENESIS-NO-SNAPSHOT-CONTEXT", 64);
    cfg.venue.context_hash[64] = '\0';
    jev::runner::RunnerDeps deps;
    deps.transport = jev::broker::CurlTransport;
    deps.now_ns = WallNs;
    deps.mono_ns = MonoNs;
    deps.restart_flag = true;
    jev::runner::G0Runner runner(cfg, deps);
    const char* why = nullptr;
    if (!runner.Recover(&why)) {
        std::printf("g0_paper_loop: refused: %s\n", why ? why : "?");
        return 2;
    }

    jev::runner::LoopIO io;
    io.rest = [](const char* m, const std::string& path, int* status,
                 std::string* body) {
        return jev::broker::CurlRest(m, path, "", status, body);
    };
    io.data = [](const std::string& path, std::string* body) {
        return jev::broker::CurlData(path, body);
    };
    jev::runner::PaperLoop loop(runner, io, lc);
    for (long long i = 0; ticks == 0 || i < ticks; ++i) {
        if (!loop.Tick(WallNs(nullptr))) {
            std::printf("g0_paper_loop: HARD stop\n");
            return 3;
        }
        const auto& st = loop.stats();
        std::printf("tick account_ok=%d seen=%d proceeded=%d held=%d\n",
                    st.account_ok, st.seen, st.proceeded, st.held);
        std::fflush(stdout);
        if (ticks == 0 || i + 1 < ticks) sleep((unsigned)interval);
    }
    return 0;
}
