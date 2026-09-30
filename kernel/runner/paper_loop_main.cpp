// Paper loop entry (needs a G0_WITH_CURL build). The operator supplies, in
// <dir>: STAGE (human-signed), approved.json (sleeves + allowlist) and the
// exchange calendar path. Runs against the Alpaca paper host only.
//
//   g0_paper_loop <dir> <calendar.json> [--ticks N] [--interval-s S]
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
        std::printf("usage: g0_paper_loop <dir> <calendar.json> [--ticks N] "
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
    jev::runner::KillFeed kill_feed;
    deps.kill_inputs = jev::runner::KillFeedInputs;
    deps.kill_ctx = &kill_feed;
    lc.kill_feed = &kill_feed;
    deps.transport = jev::broker::CurlTransport;
    deps.now_ns = WallNs;
    deps.mono_ns = MonoNs;
    deps.restart_flag = true;
    jev::broker::TradeStream stream;
    deps.stream_read = jev::broker::TradeStream::Thunk;
    deps.stream_ctx = &stream;
    deps.stream_endpoint = "alpaca-paper-trade-updates";
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
    {   // Advisory credential probe. Never fatal: an outage or bad key must
        // leave the loop running fail-safe (account_ok=0 -> no orders, alerts).
        int st = 0;
        std::string body;
        if (!io.rest("GET", "/v2/account", &st, &body) || st != 200)
            std::printf("g0_paper_loop: warning: GET /v2/account status %d; "
                        "no orders until the account is readable (check the "
                        "Alpaca paper keys)\n", st);
    }
    jev::runner::PaperLoop loop(runner, io, lc);
    int bad_ticks = 0;
    std::signal(SIGPIPE, SIG_IGN);
    std::signal(SIGTERM, OnStop);
    std::signal(SIGINT, OnStop);
    std::signal(SIGHUP, OnStop);
    for (long long i = 0; !g_stop && (ticks == 0 || i < ticks); ++i) {
        if (!loop.Tick(WallNs(nullptr))) {
            std::printf("g0_paper_loop: HARD stop\n");
            return 3;
        }
        const auto& st = loop.stats();
        std::printf("tick account_ok=%d seen=%d proceeded=%d held=%d\n",
                    st.account_ok, st.seen, st.proceeded, st.held);
        std::fflush(stdout);
        if (st.account_ok) {
            bad_ticks = 0;
        } else if (++bad_ticks == 5) {
            jev::runner::Alert((lc.dir + "/alerts.jsonl").c_str(), "MEDIUM",
                               "account-unavailable",
                               "5 consecutive ticks without account data",
                               WallNs(nullptr));
        }
        for (long long s = 0; !g_stop && s < interval; ++s) {
            if (ticks != 0 && i + 1 >= ticks) break;
            sleep(1);
        }
    }
    if (g_stop) std::printf("g0_paper_loop: stopped by signal\n");
    return 0;
}
