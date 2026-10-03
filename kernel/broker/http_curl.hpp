// Live HTTPS transport for the Alpaca paper venue: libcurl over the system
// TLS stack. Paper host only; credentials come from ALPACA_KEY_ID and
// ALPACA_SECRET in the process environment and are never logged.
#pragma once
#include <string>

#include "alpaca_paper.hpp"

namespace kernel {
namespace broker {

// Fails closed: any refusal or transport error returns status 0 and an empty
// body (the adapter treats that as ambiguous and reconciles).
HttpResult CurlTransport(const HttpRequest& req);

// Larger-body variants for the paper loop: trading REST (256 KiB cap) and
// the market-data host (GET only, 4 MiB cap, /v2/stocks/ paths).
bool CurlRest(const char* method, const std::string& path,
              const std::string& body, int* status, std::string* out);
bool CurlData(const std::string& path, std::string* out);

}  // namespace broker
}  // namespace kernel
