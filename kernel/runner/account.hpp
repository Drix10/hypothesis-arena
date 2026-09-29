// Broker account and position views parsed from Alpaca REST replies. Pure:
// callers fetch the bodies; every parse is strict and fails closed.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace jev {
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
};

bool ParseAccount(const std::string& body, AccountView* out);
bool ParsePositions(const std::string& body, std::vector<PositionView>* out);

}  // namespace runner
}  // namespace jev
