// Broker adapter interface (doc 04 4.2.5a, doc 06 6.1).
//
// A normal entry is one broker-native protected operation whose ack covers
// the entry<->protection relationship. A separate protection operation exists
// only for recovery/repair of an already-acknowledged position. Adapters
// prove the semantics (entry ack, protection ack, partials, cancel/replace,
// double-trigger); the core assumes nothing about one broker. Transport is
// injected so the kernel stays deterministic.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

namespace jev {
namespace broker {

enum class Venue : std::uint8_t {
    ALPACA_PAPER = 0  // stocks-only G0 venue
};

enum class OrderSide : std::uint8_t { BUY = 0, SELL = 1 };

// Protected-entry specification. Stop and TP are mandatory (doc 05 5.2: the
// veto rejects an intent without a stop upstream; the adapter also refuses
// non-positive stop/tp). Fixed-size: the order core is allocation-free.
struct ProtectedOrder {
    char symbol[16];
    OrderSide side = OrderSide::BUY;
    std::int64_t qty_shares = 0;  // integer shares; <= 0 refused
    std::int64_t stop_cents = 0;  // broker-unit cents; <= 0 refused
    std::int64_t tp_cents = 0;    // <= 0 refused
    char client_order_id[65];     // hex64, doc 06 6.1 recipe
    char intent_id[65];
};

// Close-order lifecycle (Alpaca order states); a 2xx + UUID only proves the
// close order exists. FILLED = "filled" (full completion, the only terminal);
// PARTIAL = "partially_filled" (reconcile remainder, never CLOSED); PENDING =
// accepted/pending_new/new/calculated (not executed); DEAD =
// canceled/rejected/expired; UNKNOWN = unrecognized/missing status or
// malformed qty. Bare "fill"/"partial_fill" are trade-event names, not order
// statuses (-> UNKNOWN). CLOSED requires filled >= close size.
enum class CloseState : std::uint8_t {
    UNKNOWN = 0,
    PENDING = 1,
    PARTIAL = 2,
    FILLED = 3,
    DEAD = 4
};

struct OrderAck {
    bool accepted = false;
    bool protection_accepted = false;  // broker ack covers protection
    bool transport_ok = false;  // submit executed authoritatively; false =
                                // transport failure/unknown (reconcile)
    bool authoritative_reject = false;  // permanent refusal (400/422 with a
                                        // shaped error): terminal
    bool auth_failure = false;  // 401: credentials dead, not a trade
                                // rejection (reconcile within budget, freeze)
    bool rate_limited = false;  // 429: reconcile, never terminal
    std::int64_t filled_qty = 0;  // filled at ack time; missing/malformed qty
                                  // makes the ack ambiguous, never zero
    char broker_order_id[64]{};  // UUID from the accepted POST (persisted
                                 // before any cancel); zero-init
    char reason[64];                   // adapter code on reject
};

struct OrderQuery {
    bool found = false;
    std::int64_t filled_qty = 0;
    bool cancelled = false;
    CloseState close_state = CloseState::UNKNOWN;  // normalized order status;
                            // replaced/done_for_day/suspended etc. are not
                            // collapsed
    char status_raw[32]{};  // verbatim venue status word (zero-filled when
                             // absent). The runner quarantines done_for_day /
                             // calculated / replaced off this (doc 06); the
                             // normalized state cannot carry that distinction.
    bool protection_active = false;  // legs strictly proven (nested)
    bool bracket_class = false;  // bracket + TP/SL held as a unit, legs
                                 // unexpanded (null legs = not expanded, not
                                 // "protection absent")
    int broker_status = 0;  // last lookup HTTP status (evidence only)
    bool auth_failure = false;  // 401 on lookup (reconcile, then freeze)
    bool rate_limited = false;  // 429 on lookup (reconcile, never terminal)
    bool transport_ok = false;  // lookup executed authoritatively; false =
                                // transport failure (not "order absent": an
                                // empty answer on a dead transport must wait)
    char broker_order_id[64]{};  // UUID from lookup (empty: none); zero-init
};

struct CancelResult {
    bool accepted = false;  // 204/2xx+id: cancel request accepted, not final
                            // (may be pending_cancel; terminal needs an
                            // explicit final-canceled observation)
    bool failed = false;    // explicit broker cancel refusal (422)
};

struct CloseResult {
    CloseState state = CloseState::UNKNOWN;
    bool transport_ok = false;  // close resolved authoritatively; false =
                                // ambiguous (reconcile, never "not executed")
    std::int64_t filled_qty = 0;  // authoritative close filled qty (strict on
                                  // FILLED/PARTIAL; malformed -> UNKNOWN)
    char broker_order_id[64]{};  // close-order UUID when available
    bool executed = false;  // state == FILLED (full completion only)
};

// CancelResult.accepted means "request accepted", never final cancellation.
// The G0 runner owns the production seam: cancel_confirmed comes only from an
// authoritative final observation (QueryOnce found+cancelled, or the
// trade-update stream's terminal canceled event), with cancel_filled_qty from
// that same observation. A bare 204 never reaches CANCELLED; the router
// enforces it and the tests prove it (cancel-accepted-never-terminals,
// cancel-seam-rests).
// Abstract adapter: the router drives these calls only. Recovery repair rides
// EstablishProtection, never the normal entry path. Cancel and MarketClose
// take the broker UUID / explicit symbol+qty, with no hidden status query.
class IAdapter {
   public:
    virtual ~IAdapter() {}
    virtual OrderAck SubmitProtected(const ProtectedOrder& o) = 0;
    virtual OrderQuery QueryOnce(const char client_order_id[65]) = 0;
    virtual CancelResult Cancel(const char broker_order_id[64]) = 0;
    virtual CloseResult MarketClose(const char* symbol,
                                    std::int64_t qty_shares,
                                    OrderSide side,
                                    const char client_order_id[65]) = 0;
    virtual bool EstablishProtection(const ProtectedOrder& o) = 0;
    virtual Venue venue() const = 0;
};

// Strict broker-UUID grammar (8-4-4-4-12 lowercase hex + hyphens), shared by
// the adapter query path and the router crash-path gates. False on
// null/empty/short/uppercase/bad-hyphen/path-like/overlong.
bool IsBrokerUuid(const char* s);

// Client order ID (doc 06 6.1 recipe): one intent, one ID, no attempt field
// (it would mint a fresh ID per retry and double-fill).
// hex(sha256(broker|account|context|symbol|side|intent)) with 0x1F
// separators. Returns false (out untouched) on empty fields or a short
// buffer.
bool MakeClientOrderId(const char* broker, const char* account,
                       const char* context_hash_hex,
                       const char* symbol, OrderSide side,
                       const char* intent_id, char* out65);

// Paper fill model (doc 06 locked decisions, 2026-09-18): BUY at mid + one
// full spread adverse, SELL at mid - one full spread adverse (minimum 1bp),
// full size, flagged simulated, no partials. P&L against this model is
// G1->G2 evidence (doc 10 10.2). Integer cents.
struct Quote {
    std::int64_t mid_cents = 0;
    std::int64_t spread_cents = 0;  // full spread, >= 0
};
std::int64_t PaperFillPrice(OrderSide side, const Quote& q);

}  // namespace broker
}  // namespace jev
