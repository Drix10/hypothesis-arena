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
#include "adapter.hpp"

namespace jev {
namespace broker {

// Minimal transport surface: POST a path+body, get status+body back.
// Bodies are small bounded JSON assembled by the adapter (cycle path).
struct HttpResult {
    int status = 0;
    char body[2048];
};
typedef HttpResult (*HttpPost)(const char* path, const char* body);

class AlpacaPaperAdapter : public IAdapter {
   public:
    explicit AlpacaPaperAdapter(HttpPost transport = nullptr)
        : transport_(transport) {}
    Venue venue() const override { return Venue::ALPACA_PAPER; }
    OrderAck SubmitProtected(const ProtectedOrder& o) override;
    OrderQuery QueryOnce(const char client_order_id[65]) override;
    CancelResult Cancel(const char client_order_id[65]) override;
    bool EstablishProtection(const ProtectedOrder& o) override;

   private:
    HttpPost transport_;
};

}  // namespace broker
}  // namespace jev
