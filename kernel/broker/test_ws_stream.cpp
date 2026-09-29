// TradeStream checks. `unit`: pure message conversion. `live <seconds>`: run
// the client against G0_TEST_WS_BASE and print the SSE bytes and counters for
// kernel/tests/ws_faults.py.
#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

#include "ws_stream.hpp"

using jev::broker::TradeStream;

static int fails = 0, count = 0;
#define CHECK(name, expr)                   \
    do {                                    \
        ++count;                            \
        if (!(expr)) {                      \
            std::printf("FAIL %s\n", name); \
            ++fails;                        \
        }                                   \
    } while (0)

static std::string Msg(const char* ev, const char* cid, const char* filled) {
    return std::string("{\"stream\":\"trade_updates\",\"data\":{\"event\":\"") +
           ev + "\",\"execution_id\":\"11111111-2222-3333-4444-555555555555\","
           "\"order\":{\"id\":\"a\",\"client_order_id\":\"" + cid +
           "\",\"symbol\":\"SPY\",\"qty\":\"5\",\"filled_qty\":\"" + filled +
           "\",\"legs\":[{\"id\":\"b\"}],\"status\":\"x\"},\"qty\":\"2\"}}";
}

static int Unit() {
    std::string sse;
    CHECK("fill", TradeStream::ToSse(Msg("partial_fill", "abc-123", "3"), &sse) &&
                      sse == "event: partial_fill\ndata: {\"order\":{"
                             "\"client_order_id\":\"abc-123\","
                             "\"filled_qty\":\"3\"}}\n\n");
    CHECK("new-no-fill-qty-kept", TradeStream::ToSse(Msg("new", "c1", "0"), &sse) &&
                                      sse.find("\"filled_qty\":\"0\"") !=
                                          std::string::npos);
    CHECK("fractional-qty-dropped", TradeStream::ToSse(Msg("fill", "c1", "1.5"), &sse) &&
                                        sse.find("filled_qty") == std::string::npos);
    CHECK("whole-decimal-ok", TradeStream::ToSse(Msg("fill", "c1", "2.000"), &sse) &&
                                  sse.find("\"filled_qty\":\"2\"") != std::string::npos);
    CHECK("not-trade-update", !TradeStream::ToSse(
        "{\"stream\":\"listening\",\"data\":{}}", &sse));
    CHECK("no-order", !TradeStream::ToSse(
        "{\"stream\":\"trade_updates\",\"data\":{\"event\":\"fill\"}}", &sse));
    CHECK("bad-event-word", !TradeStream::ToSse(Msg("Fill;x", "c1", "1"), &sse));
    CHECK("bad-cid-quote", !TradeStream::ToSse(Msg("fill", "c\\\"1", "1"), &sse));
    CHECK("bad-cid-newline", !TradeStream::ToSse(Msg("fill", "c\\n1", "1"), &sse));
    CHECK("empty-cid", !TradeStream::ToSse(Msg("fill", "", "1"), &sse));
    CHECK("long-cid", !TradeStream::ToSse(Msg("fill", std::string(65, 'a').c_str(), "1"), &sse));
    CHECK("garbage", !TradeStream::ToSse("not json", &sse) &&
                         !TradeStream::ToSse("", &sse) &&
                         !TradeStream::ToSse("[1,2]", &sse));
    CHECK("oversize", !TradeStream::ToSse(std::string(70000, ' ') + Msg("fill", "c", "1"), &sse));
    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}

static int Live(int seconds) {
    TradeStream ts;
    auto end = std::chrono::steady_clock::now() + std::chrono::seconds(seconds);
    std::string all;
    bool was_live = false;
    long changes = 0;
    while (std::chrono::steady_clock::now() < end) {
        char buf[4096];
        int n = ts.Read(buf, sizeof(buf));
        if (n > 0) all.append(buf, (size_t)n);
        if (ts.live() != was_live) {
            was_live = ts.live();
            ++changes;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    std::string flat;
    for (char c : all) flat += c == '\n' ? '|' : c;
    std::printf("live=%d reconnects=%ld dropped=%ld changes=%ld sse=%s\n",
                ts.live(), ts.reconnects(), ts.dropped(), changes, flat.c_str());
    return 0;
}

int main(int argc, char** argv) {
    if (argc >= 2 && !std::strcmp(argv[1], "unit")) return Unit();
    if (argc >= 3 && !std::strcmp(argv[1], "live")) return Live(std::atoi(argv[2]));
    return 2;
}
