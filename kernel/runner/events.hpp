// Venue event seam.
//
// Two authorities meet here:
//   stream = SSE trade events (ULID publication order; fills apply
//     monotonically under the router's domain rules);
//   REST   = Order-entity snapshots (no ordering authority; the router's
//     StreamLive rule gates terminal claims).
// trade_bust / trade_correct are never ordinary fills: they force
// authoritative REST reconciliation.
//
// This module owns framing and mapping so the Phase 4 socket swap changes
// bytes-in only. Endpoint/prefix config is caller-owned strings.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "../broker/adapter.hpp"
#include "../exec/router.hpp"

namespace kernel {
namespace runner {

// ---- SSE framing (bounded, incremental) ----
// Feed raw bytes; Next() yields one event per blank-line terminator. Lines:
// "id:" (ULID), "event:" (type), "data:"; ":..." comments are ignored.
// Overlong (>4KiB) events resync at the next blank line and count errors.
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

// ---- trade-event mapping ----
// Maps one SSE trade event onto attributable facts. Fills carry the
// cumulative order quantity (order.filled_qty, never the per-event qty);
// lifecycle words carry identity only (the runner funnels state through
// forced REST); bust and correct always force REST reconciliation. Unknown
// types or events without a client order id -> kind NONE (ignored). The
// runner shapes these per machine state; this module never routes.
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
    // FILL only: cumulative order filled_qty (what the router floors on). The
    // per-event qty is deliberately not extracted: treating it as cumulative
    // understates fills (40+30 would read 30, not 70).
    std::int64_t filled_qty = 0;
};
StreamObs MapTradeEvent(const SseEvent& ev);

// ---- REST funnel ----
// Maps an Order-entity lookup onto a close observation for an in-flight EXIT
// (same stable client ID; reconcile, never a second send). 404/unknown ->
// transport_ok + UNKNOWN; cancelled -> DEAD; otherwise the normalized status.
broker::CloseResult QueryToClose(const broker::OrderQuery& q);

// ---- fill shaping ----
// Shapes a stamped stream fill for a waiting machine (pure): QUERY_SENT ->
// query-shaped obs (found + cumulative qty; router floor and StreamLive
// still apply); EXIT_SENT/EXIT_EMERGENCY -> close-shaped obs (flat iff
// cumulative >= remaining, else PARTIAL); any other state -> no obs.
// ULIDs ride the separate stamp step, not the shaped obs (no double-apply).
struct ShapedFill {
    bool feed_query = false;
    broker::OrderQuery q;
    bool feed_close = false;
    broker::CloseResult c;
};
ShapedFill ShapeStreamFill(exec::RouteState st, long long remaining,
                           long long qty);

}  // namespace runner
}  // namespace kernel
