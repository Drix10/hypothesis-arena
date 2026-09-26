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

// Close-order lifecycle (Alpaca order states): a 2xx + UUID only
// proves the close order EXISTS. FILLED = status "filled" (full
// completion, the only terminal); PARTIAL = "partially_filled"
// (reconcile remainder, never CLOSED); PENDING =
// accepted/pending_new/new/calculated (wait/reconcile, NOT executed);
// DEAD = canceled/rejected/expired (definitive non-execution);
// UNKNOWN = unrecognized/missing status or malformed qty (reconcile).
// Bare "fill" / "partial_fill" are TRADE-EVENT names, never order
// statuses (-> UNKNOWN). Partial fill is never flat: CLOSED requires
// filled >= close size.
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
    bool transport_ok = false;  // submit executed authoritatively;
                                // false = transport failure/unknown
                                // (NOT a rejection — reconcile)
    bool authoritative_reject = false;  // permanent broker input
                                        // refusal (400/422 with a
                                        // shaped error): terminal
    bool auth_failure = false;  // 401: credentials dead — never
                                // a trade rejection (reconcile,
                                // budget-bounded, then freeze)
    bool rate_limited = false;  // 429: throttled — wait/retry via
                                // reconcile, never terminal
    std::int64_t filled_qty = 0;  // filled at ack time (STRICT:
                                  // missing/malformed qty makes the
                                  // ack ambiguous, never silent zero)
    char broker_order_id[64]{};  // broker UUID from the accepted POST
                                 // (persisted before any cancel;
                                 // zero-init: garbage never rides
                                 // the crash path)
    char reason[64];                   // frozen adapter code on reject
};

struct OrderQuery {
    bool found = false;
    std::int64_t filled_qty = 0;
    bool cancelled = false;
    CloseState close_state = CloseState::UNKNOWN;  // normalized
                            // broker order status (exits reconcile
                            // on this, not just filled/cancelled:
                            // replaced/done_for_day/suspended etc.
                            // are never silently collapsed)
    char status_raw[32]{};  // verbatim venue status word (zero-
                             // filled when absent/unparseable). The
                             // runner quarantines done_for_day /
                             // calculated / replaced off this (doc
                             // 06 locked) — the normalized state
                             // alone cannot carry that distinction.
    bool protection_active = false;  // legs strictly proven (nested)
    bool bracket_class = false;  // order_class bracket + TP/SL params
                                 // held as a unit, legs unexpanded
                                 // (by-client-ID has no nested
                                 // param: null legs = not expanded,
                                 // never "protection absent")
    int broker_status = 0;  // last lookup HTTP status (evidence,
                            // not control flow)
    bool auth_failure = false;  // 401 on lookup (reconcile,
                                // then freeze — never "absent")
    bool rate_limited = false;  // 429 on lookup (reconcile, never
                                // terminal)
    bool transport_ok = false;  // lookup executed authoritatively;
                                // false = transport failure/unknown
                                // (NOT "order absent" — an empty
                                // answer on a dead transport must wait,
                                // never cancel)
    char broker_order_id[64]{};  // broker UUID from lookup (empty: none);
                                 // zero-init: garbage must never ride
                                 // the crash path
};

struct CancelResult {
    bool accepted = false;  // 204/2xx+id: cancel REQUEST accepted —
                            // NOT final cancellation (the order may
                            // still be pending_cancel; terminal needs
                            // an explicit final-canceled observation)
    bool failed = false;    // explicit broker cancel refusal (422)
};

struct CloseResult {
    CloseState state = CloseState::UNKNOWN;
    bool transport_ok = false;  // close resolved authoritatively;
                                // false = ambiguous (response lost/
                                // malformed — reconcile, never
                                // "not executed")
    std::int64_t filled_qty = 0;  // authoritative close filled qty
                                  // (STRICT on FILLED/PARTIAL;
                                  // malformed -> UNKNOWN)
    char broker_order_id[64]{};  // close-order UUID when available
    bool executed = false;  // == (state == FILLED): full completion
                            // only; a partial fill never sets this
};

// CancelResult.accepted stays "request accepted" (204/2xx+id),
// never final cancellation. PRODUCTION SEAM (G0 runner owns it):
// cancel_confirmed is produced ONLY from an authoritative final
// observation — QueryOnce found+cancelled (REST) or the trade-update
// stream's terminal canceled event — mapped to cancel_confirmed=true
// plus cancel_filled_qty from that same observation. A bare 204 (or
// any accepted-without-final sequence) must NEVER reach CANCELLED;
// the router enforces this (accepted stays confirming), the tests
// prove it (cancel-accepted-never-terminals, cancel-seam-rests).
// Abstract adapter: the router drives these and ONLY these. Recovery
// repair (re-establish protection on an acknowledged position) rides
// EstablishProtection; it is never the normal entry path. Cancel and
// MarketClose take the broker UUID / explicit symbol+qty (never a
// second status query hidden inside a cancel).
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

// Strict broker-UUID grammar (8-4-4-4-12 lowercase hex + hyphens):
// shared by the adapter query path and the router crash-path gates.
// False on null/empty/short/uppercase/bad-hyphen/path-like/overlong.
bool IsBrokerUuid(const char* s);

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
