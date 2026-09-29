// Live HTTPS transport for the Alpaca paper venue: libcurl over the system
// TLS stack. Paper host only; credentials come from ALPACA_KEY_ID and
// ALPACA_SECRET in the process environment and are never logged.
#pragma once
#include "alpaca_paper.hpp"

namespace jev {
namespace broker {

// Fails closed: any refusal or transport error returns status 0 and an empty
// body (the adapter treats that as ambiguous and reconciles).
HttpResult CurlTransport(const HttpRequest& req);

}  // namespace broker
}  // namespace jev
