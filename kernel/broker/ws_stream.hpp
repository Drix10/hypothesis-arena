// Alpaca paper trade_updates over WebSocket (libcurl transport, own RFC 6455
// framing: the system libcurl has no ws support), presented to the runner
// as SSE-framed bytes: the runner's stream seam (events.hpp) stays unchanged.
// Every failure degrades to "no bytes": the runner reconciles over REST, so a
// dead stream costs latency, never correctness.
#pragma once
#include <chrono>
#include <string>

typedef void CURL;

namespace jev {
namespace broker {

class TradeStream {
   public:
    TradeStream();
    ~TradeStream();
    TradeStream(const TradeStream&) = delete;
    TradeStream& operator=(const TradeStream&) = delete;

    // Runner stream_read contract: bytes read (> 0), 0 = none available.
    // Connects, authenticates and reconnects on its own with backoff.
    int Read(char* buf, int n);
    static int Thunk(void* self, char* buf, int n);

    bool live() const { return state_ == kLive; }
    long reconnects() const { return reconnects_; }
    long dropped() const { return dropped_; }

    // One WebSocket message -> zero or one SSE event (pure, testable).
    // Only the fields the router consumes survive: event name, client order
    // id, cumulative filled qty. False = not a usable trade update.
    static bool ToSse(const std::string& message, std::string* sse);

   private:
    enum State { kDown, kAwaitUpgrade, kAwaitAuth, kAwaitListen, kLive };
    bool Connect();
    void Close(int backoff_s);
    bool SendRaw(const std::string& bytes);
    bool Send(int opcode, const std::string& payload);
    bool Parse();
    void OnMessage(const std::string& msg);

    CURL* h_ = nullptr;
    State state_ = kDown;
    std::string pending_;  // SSE bytes not yet handed to the runner
    std::string frag_;     // partial WebSocket message
    std::string rbuf_;     // received bytes not yet framed
    unsigned long long skip_ = 0;  // payload bytes of an oversize frame to drop
    bool oversize_ = false;        // dropping the rest of a fragmented message
    std::chrono::steady_clock::time_point next_try_{};
    std::chrono::steady_clock::time_point hs_start_{};
    int backoff_s_ = 2;
    long reconnects_ = 0;
    long dropped_ = 0;
};

}  // namespace broker
}  // namespace jev
