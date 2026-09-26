// H1 integration — venue event seam (doc 01: WS + 15-min REST
// reconcile; Alpaca trade-event stream + Order-entity REST).
//
// Two authorities meet here and must not be confused:
//   stream = SSE trade events (ULID publication order; fills apply
//     monotonically under the router's domain rules);
//   REST   = Order-entity snapshots (no ordering authority; the
//     router's StreamLive rule gates terminal claims).
// trade_bust / trade_correct are NEVER ordinary fills: they force
// authoritative REST reconciliation (a busted fill must not linger
// as monotonic truth).
//
// The live socket is Phase 4; this module owns framing + mapping so
// the transport swap changes bytes-in only. Endpoint/prefix config
// (e.g. the trade-events path) is caller-owned strings, never
// baked-in venue truth.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../broker/adapter.hpp"
#include "../exec/router.hpp"

namespace jev {
namespace runner {

// ---- SSE framing (bounded, incremental) ---------------------------
// Feed raw bytes; Next() yields one event per blank-line terminator.
// Lines: "id:" (ULID last-event-id), "event:" (type), "data:",
// ":..." comments ignored. Overlong (>4KiB) events resync at the
// next blank line and count errors (fail closed, never partial).
struct SseEvent {
    std::string id;     // SSE id line (venue ULID when present)
    std::string type;   // event line ("" when absent)
    std::string data;   // joined data lines ("\n" between)
};
class SseParser {
   public:
    void Feed(const char* bytes, std::size_t n);
    bool Next(SseEvent* out);  // false = no complete event buffered
    long long errors() const { return errors_; }

   private:
    std::string buf_;
    std::string id_, type_, data_;
    std::vector<SseEvent> ready_;  // queued (a chunk holds many)
    bool have_data_ = false;
    bool dropped_ = false;
    long long errors_ = 0;
    void CommitLine(const std::string& ln);
};

// ---- trade-event mapping -------------------------------------------
// Maps one SSE trade event onto neutral, attributable facts. Fills
// carry the CUMULATIVE order quantity (order.filled_qty — never the
// per-event qty); lifecycle words carry identity only (NO router
// verdict — the runner funnels actual state through forced REST);
// bust and correct ALWAYS force authoritative REST reconciliation
// (a busted fill must not linger as monotonic truth). Unknown types
// or unattributable events (no client order id) -> kind NONE
// (ignored). The RUNNER shapes these per machine state
// (query-shaped obs for QUERY_SENT, close-shaped obs for EXIT_SENT);
// this module never decides routing.
enum class StreamKind : std::uint8_t {
    NONE = 0,  // unknown/unattributable: ignore
    FILL = 1,  // fill / partial_fill + strict qty
    LIFE = 2,  // lifecycle word: reconcile, never a verdict
    BUST = 3   // trade_bust / trade_correct: reconcile, never a fill
};
struct StreamObs {
    StreamKind kind = StreamKind::NONE;
    char client_id[65]{};
    char event_id[33]{};  // SSE id (venue ULID when present)
    // FILL only: CUMULATIVE order filled_qty (order-level, what
    // the router floors on). The per-event qty is DELIBERATELY
    // not extracted — treating event qty as cumulative understates
    // fills (40+30 would read as 30, not 70).
    std::int64_t filled_qty = 0;
};
StreamObs MapTradeEvent(const SseEvent& ev);

// ---- REST funnel ----------------------------------------------------
// Maps an Order-entity lookup onto a close observation for an EXIT
// in flight (same stable client ID — reconcile, never a second
// send). 404/unknown -> transport_ok + UNKNOWN (reconcile, never
// terminal); cancelled -> DEAD; otherwise the normalized status.
broker::CloseResult QueryToClose(const broker::OrderQuery& q);

// ---- fill shaping ----------------------------------------------------
// Shapes a stamped stream fill for a waiting machine (pure):
// QUERY_SENT -> query-shaped obs (found + cumulative qty; the
// router's floor + StreamLive rules still apply at feed time);
// EXIT_SENT/EXIT_EMERGENCY -> close-shaped obs (flat iff cumulative
// >= remaining, else PARTIAL — never a blind terminal); any other
// state -> no obs (hold). ULIDs ride the separate stamp step, never
// on the shaped obs (no double-apply).
struct ShapedFill {
    bool feed_query = false;
    broker::OrderQuery q;
    bool feed_close = false;
    broker::CloseResult c;
};
ShapedFill ShapeStreamFill(exec::RouteState st, long long remaining,
                           long long qty);

}  // namespace runner
}  // namespace jev
