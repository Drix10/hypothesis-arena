// Paper loop entry (needs a WITH_CURL build). The operator supplies, in
// <dir>: STAGE (human-signed), approved.json (strategies + allowlist) and the
// exchange calendar path. Runs against the Alpaca paper host only.
//
//   paper_loop <dir> <calendar.json> [--ticks N] [--interval-s S]
//
// Exit: 0 clean, 2 refused to start, 3 HARD stop.
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include <unistd.h>

#include "../broker/http_curl.hpp"
#include "../broker/ws_stream.hpp"
#include "approved.hpp"
#include "paper_loop.hpp"
#include "store.hpp"

namespace {
// SIGTERM/SIGINT/SIGHUP ask for a clean stop between ticks (the destructor
// then releases the directory lock). SIGPIPE is ignored: a write to a reset
// TLS socket must fail the request, not kill the process.
volatile std::sig_atomic_t g_stop = 0;
void OnStop(int) { g_stop = 1; }

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
        std::printf("usage: paper_loop <dir> <calendar.json> [--ticks N] "
                    "[--interval-s S]\n");
        return 2;
    }
    long long ticks = 1, interval = 60;
    for (int a = 3; a < argc; a += 2) {
        if (a + 1 >= argc) return 2;
        char* end = nullptr;
        long long v = std::strtoll(argv[a + 1], &end, 10);
        if (end == argv[a + 1] || *end) return 2;
        if (std::strcmp(argv[a], "--ticks") == 0) ticks = v;
        else if (std::strcmp(argv[a], "--interval-s") == 0) interval = v;
        else return 2;
    }
    if (ticks < 0 || interval < 1) return 2;

    kernel::runner::LoopConfig lc;
    lc.dir = argv[1];
    std::string text;
    if (!kernel::runner::ReadFile(lc.dir + "/approved.json", &text) ||
        !kernel::runner::ParseApproved(text, &lc.tables)) {
        std::printf("paper_loop: refused: approved.json missing or invalid\n");
        return 2;
    }
    if (!kernel::runner::ReadFile(argv[2], &text) ||
        !kernel::runner::ParseCalendar(text, &lc.holidays)) {
        std::printf("paper_loop: refused: calendar missing or invalid\n");
        return 2;
    }
    if (!kernel::runner::ParseEarlyCloses(text, &lc.early_closes)) {
        std::printf("paper_loop: refused: calendar early_close invalid\n");
        return 2;
    }

    kernel::runner::RunnerConfig cfg;
    cfg.dir = lc.dir;
    std::strncpy(cfg.venue.broker, "alpaca-paper", 31);
    std::strncpy(cfg.venue.account, "g0-paper", 31);
    std::strncpy(cfg.venue.context_hash, "GENESIS-NO-SNAPSHOT-CONTEXT", 64);
    cfg.venue.context_hash[64] = '\0';
    kernel::runner::RunnerDeps deps;
    kernel::runner::KillFeed kill_feed;
    deps.kill_inputs = kernel::runner::KillFeedInputs;
    deps.kill_ctx = &kill_feed;
    lc.kill_feed = &kill_feed;
    deps.transport = kernel::broker::CurlTransport;
    deps.now_ns = WallNs;
    deps.mono_ns = MonoNs;
    deps.sleep_ms = [](void*, int ms) { usleep((useconds_t)ms * 1000); };
    deps.restart_flag = true;
    kernel::broker::TradeStream stream;
    deps.stream_read = kernel::broker::TradeStream::Thunk;
    deps.stream_ctx = &stream;
    deps.stream_endpoint = "alpaca-paper-trade-updates";
    kernel::runner::PaperRunner runner(cfg, deps);
    const char* why = nullptr;
    if (!runner.Recover(&why)) {
        std::printf("paper_loop: refused: %s\n", why ? why : "?");
        return 2;
    }

    kernel::runner::LoopIO io;
    io.rest = [](const char* m, const std::string& path, int* status,
                 std::string* body) {
        return kernel::broker::CurlRest(m, path, "", status, body);
    };
    io.data = [](const std::string& path, std::string* body) {
        return kernel::broker::CurlData(path, body);
    };
    {   // Advisory credential probe. Never fatal: an outage or bad key must
        // leave the loop running fail-safe (account_ok=0 -> no orders, alerts).
        int st = 0;
        std::string body;
        if (!io.rest("GET", "/v2/account", &st, &body) || st != 200)
            std::printf("paper_loop: warning: GET /v2/account status %d; "
                        "no orders until the account is readable (check the "
                        "Alpaca paper keys)\n", st);
    }
    kernel::runner::PaperLoop loop(runner, io, lc);
    int bad_ticks = 0;
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGTERM, OnStop);
    std::signal(SIGINT, OnStop);
    std::signal(SIGHUP, OnStop);
    for (long long i = 0; !g_stop && (ticks == 0 || i < ticks); ++i) {
        if (!loop.Tick(WallNs(nullptr))) {
            std::printf("paper_loop: HARD stop\n");
            return 3;
        }
        const auto& st = loop.stats();
        std::printf("tick account_ok=%d seen=%d proceeded=%d held=%d\n",
                    st.account_ok, st.seen, st.proceeded, st.held);
        std::fflush(stdout);
        if (st.account_ok) {
            bad_ticks = 0;
        } else if (++bad_ticks == 5) {
            kernel::runner::Alert((lc.dir + "/alerts.jsonl").c_str(), "MEDIUM",
                               "account-unavailable",
                               "5 consecutive ticks without account data",
                               WallNs(nullptr));
        }
        for (long long s = 0; !g_stop && s < interval; ++s) {
            if (ticks != 0 && i + 1 >= ticks) break;
            sleep(1);
        }
    }
    if (g_stop) std::printf("paper_loop: stopped by signal\n");
    return 0;
}
