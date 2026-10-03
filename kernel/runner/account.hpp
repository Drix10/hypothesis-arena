// Broker account and position views parsed from Alpaca REST replies. Pure:
// callers fetch the bodies; every parse is strict and fails closed.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace kernel {
namespace runner {

// Decimal string -> cents, rounded toward zero (conservative for both
// equity and cash). Accepts an optional '-'; rejects anything else.
bool ParseMoneyCents(const std::string& s, int64_t* out);

struct AccountView {
    int64_t equity_cents = 0;
    int64_t last_equity_cents = 0;
    int64_t cash_cents = 0;
    // Settled funds proxy: the smaller of cash and the venue's
    // non-marginable buying power.
    int64_t settled_cash_cents = 0;
    bool blocked = true;  // account or trading blocked, or not ACTIVE
};

struct PositionView {
    std::string symbol;
    int64_t qty = 0;
    int64_t market_value_cents = 0;
    bool is_long = true;
    bool fractional = false;  // holds a share fraction (dust; never traded)
};

// A working parent order (bracket legs are nested inside it, not listed).
struct OrderView {
    std::string symbol;
    bool is_buy = true;
    int64_t remaining_qty = 0;  // whole shares not yet filled
};

bool ParseAccount(const std::string& body, AccountView* out);
bool ParsePositions(const std::string& body, std::vector<PositionView>* out);
// GET /v2/orders?status=open&nested=true
bool ParseOpenOrders(const std::string& body, std::vector<OrderView>* out);

}  // namespace runner
}  // namespace kernel
