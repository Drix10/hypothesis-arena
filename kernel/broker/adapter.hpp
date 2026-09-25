// H1 — broker adapter interface (doc 04 sec. 4.2.5a, doc 06 sec. 6.1).
//
// E1 protected-entry rule (frozen): a normal entry is ONE broker-native
// protected operation whose acknowledgement covers the entry<->protection
// relationship. A separate protection operation exists ONLY for
// recovery/repair of an already-acknowledged position — never as the
// ordinary second step after an unprotected send. Adapters prove the
// semantics (entry ack, protection ack, partials, cancel/replace,
// double-trigger incl. fast-market edges); the core never assumes one
// broker's behavior. Transport is injected (tests supply fakes;
// production wiring is Phase 4) so the kernel stays deterministic.
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>

namespace jev {
namespace broker {

enum class Venue : std::uint8_t {
    ALPACA_PAPER = 0  // stocks-only G0 venue; no FX adapter in H1
};

enum class OrderSide : std::uint8_t { BUY = 0, SELL = 1 };

// Protected-entry specification. Stop+TP are MANDATORY (doc 05 sec. 5.2:
// every intent carries a stop or the veto rejects it upstream; the
// adapter refuses a spec with non-positive stop/tp all the same).
// Fixed-size: the order core is allocation-free; transport formatting
// is the adapter's own (cycle-path) concern.
struct ProtectedOrder {
    char symbol[16];
    OrderSide side = OrderSide::BUY;
    std::int64_t qty_shares = 0;  // integer shares; <= 0 refused
    std::int64_t stop_cents = 0;  // broker-unit cents; <= 0 refused
    std::int64_t tp_cents = 0;    // <= 0 refused
    char client_order_id[65];     // hex64 per doc 06 sec. 6.1 recipe
    char intent_id[65];
};

struct OrderAck {
    bool accepted = false;
    bool protection_accepted = false;  // broker ack covers protection
    std::int64_t filled_qty = 0;       // filled at ack time (often 0)
    char reason[64];                   // frozen adapter code on reject
};

struct OrderQuery {
    bool found = false;
    std::int64_t filled_qty = 0;
    bool cancelled = false;
    bool protection_active = false;
    int broker_status = 0;  // adapter-declared code; 0 = ok/unknown-none
};

struct CancelResult {
    bool confirmed = false;
};

// Abstract adapter: the router drives these and ONLY these. Recovery
// repair (re-establish protection on an acknowledged position) rides
// EstablishProtection; it is never the normal entry path.
class IAdapter {
   public:
    virtual ~IAdapter() {}
    virtual OrderAck SubmitProtected(const ProtectedOrder& o) = 0;
    virtual OrderQuery QueryOnce(const char client_order_id[65]) = 0;
    virtual CancelResult Cancel(const char client_order_id[65]) = 0;
    virtual bool EstablishProtection(const ProtectedOrder& o) = 0;
    virtual Venue venue() const = 0;
};

// Client order ID (frozen doc 06 sec. 6.1 recipe): one intent, one ID,
// no attempt field (an attempt field would mint a fresh ID per retry
// and double-fill). hex(sha256(broker|account|context|symbol|side|
// intent)) with 0x1F unit separators (no delimiter ambiguity, no
// cross-account collision via the broker+account namespace). Returns
// false (out untouched) on empty fields or a short buffer.
bool MakeClientOrderId(const char* broker, const char* account,
                       const char* context_hash_hex,
                       const char* symbol, OrderSide side,
                       const char* intent_id, char* out65);

// Frozen paper fill model (doc 06 Locked decisions, 2026-09-18): BUY at
// mid + one full spread adverse, SELL at mid - one full spread adverse
// (minimum 1bp adverse move), full size, flagged simulated, NO partials
// in paper. Pure quote math; P&L comparison against this model is G1->G2
// evidence (doc 10 sec. 10.2). All inputs/outputs integer cents.
struct Quote {
    std::int64_t mid_cents = 0;
    std::int64_t spread_cents = 0;  // full spread, >= 0
};
std::int64_t PaperFillPrice(OrderSide side, const Quote& q);

}  // namespace broker
}  // namespace jev
