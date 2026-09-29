// Alpaca paper adapter (stocks-only G0 venue).
#pragma once
//
// Units are whole shares; partial fills report exact filled qty; prices are
// cents. The protected entry is one bracket order (entry + TP + SL) whose
// acknowledgement covers all three legs; protection_accepted is reported
// only when the transport confirms every leg. Transport is injected; unit
// tests prove the request shape and ack mapping against a fake.
//
// Response shapes (single query, no hidden lookup):
//   submit ack = POST /v2/orders bracket response (UUID + legs proof);
//   reconcile  = GET /v2/orders:by_client_order_id?client_order_id=
//     (Order entity; no nested param is documented, so legs are trusted only
//     when strictly proven and absence routes to repair).
// Outcome classes: 400/422 permanent refusal; 401 auth failure; 403
// forbidden order request (buying-power class: the order is dead, not an
// auth outage); 429 throttled; anything else non-2xx/ambiguous reconciles
// first. DELETE 204 = cancel request accepted (final cancel needs a
// canceled observation). MarketClose rides a stable client ID and reports
// the full close lifecycle (FILLED/PARTIAL/PENDING/DEAD/UNKNOWN) with a
// strict quantity; a 2xx + UUID alone never means executed. The order status
// is "filled"; bare "fill" is a trade-event type.
#include "adapter.hpp"

namespace jev {
namespace broker {

// Transport surface: GET for lookup, DELETE for cancel, POST for submits, so
// the method is explicit. Bodies are small bounded JSON built by the
// adapter.
struct HttpResult {
    int status = 0;
    char body[8192];  // a bracket order reply is ~2.6 KB on the live venue
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
                            OrderSide side,
                            const char client_order_id[65]) override;
    bool EstablishProtection(const ProtectedOrder& o) override;
    // Market-on-close order (time_in_force cls); same lifecycle result as
    // MarketClose. Submitted before the venue's MOC cutoff by the caller.
    CloseResult CloseAtClose(const char* symbol, std::int64_t qty_shares,
                             OrderSide side, const char client_order_id[65]);

   private:
    CloseResult PostClose(const char* symbol, std::int64_t qty_shares,
                          OrderSide side, const char client_order_id[65],
                          const char* tif);
    HttpTransport transport_;
};

}  // namespace broker
}  // namespace jev
