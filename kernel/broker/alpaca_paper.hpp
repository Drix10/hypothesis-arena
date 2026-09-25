// H1 — Alpaca paper adapter (stocks-only G0 venue).
//
// Declared semantics (frozen interface proof surface): units are whole
// shares; partial fills are reported with exact filled qty; price
// precision is cents; the protected entry is a single bracket order
// (entry + TP leg + SL leg) whose broker acknowledgement covers all
// three legs — the adapter refuses to report protection_accepted unless
// the transport confirms every leg. Transport is injected: unit tests
// prove the request shape and ack mapping against a fake; the live
// HTTPS wiring belongs to Phase 4 (no live credentials in H1).
//
// Authoritative response shapes (single query, no hidden lookup):
//   submit ack = POST /v2/orders bracket response (created bracket
//     with legs populated; the UUID + legs proof ride this reply);
//   reconcile  = GET /v2/orders:by_client_order_id?client_order_id=
//     (Order entity; no nested param is documented there, so legs
//     are trusted ONLY when strictly proven — absence routes to the
//     repair path, never to assumed protection).
// Outcome classes: 400/422 permanent refusal; 401/403 auth failure;
// 429 throttled; anything else non-2xx/ambiguous (reconcile first).
#include "adapter.hpp"

namespace jev {
namespace broker {

// Minimal transport surface: the FULL HTTP verb surface the venue
// needs (lookup is GET, cancel is DELETE, submits are POST).
// POST-only cannot express the real Trading API contract, so the
// injected transport takes the method explicitly. Bodies are small
// bounded JSON assembled by the adapter (cycle path).
struct HttpResult {
    int status = 0;
    char body[2048];
};
struct HttpRequest {
    const char* method;  // "GET", "POST", "DELETE"
    const char* path;
    const char* body;  // "" when none
};
typedef HttpResult (*HttpTransport)(const HttpRequest& req);

class AlpacaPaperAdapter : public IAdapter {
   public:
    explicit AlpacaPaperAdapter(HttpTransport transport = nullptr)
        : transport_(transport) {}
    Venue venue() const override { return Venue::ALPACA_PAPER; }
    OrderAck SubmitProtected(const ProtectedOrder& o) override;
    OrderQuery QueryOnce(const char client_order_id[65]) override;
    CancelResult Cancel(const char broker_order_id[64]) override;
    CloseResult MarketClose(const char* symbol, std::int64_t qty_shares,
                            OrderSide side) override;
    bool EstablishProtection(const ProtectedOrder& o) override;

   private:
    HttpTransport transport_;
};

}  // namespace broker
}  // namespace jev
