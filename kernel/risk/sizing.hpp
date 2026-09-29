// Position sizing (doc 03 3.3): risk budget first, then every cap, take the
// minimum. Pure integer arithmetic; conviction never enters.
#pragma once
#include <cstdint>

namespace jev {
namespace risk {

struct SizingInput {
    int64_t equity_cents = 0;
    int64_t risk_bp = 25;        // base risk budget per trade
    int64_t entry_cents = 0;     // long entries only: stop < entry
    int64_t stop_cents = 0;
    int scale_num = 1, scale_den = 1;  // R6 trip halves the budget
    int stage_num = 1, stage_den = 1;  // stage multiplier, applied last
    int64_t settled_cash_cents = 0;    // R18: settled, net of pending buys
    int64_t r2_headroom_cents = 0;     // remaining notional under R2
    int64_t liquidity_cap_shares = 0;  // <= 0: no liquidity cap declared
};

struct Sizing {
    int64_t qty = 0;
    const char* limiter = "bad-inputs";  // which term set the size
};

Sizing ComputeSize(const SizingInput& in);

}  // namespace risk
}  // namespace jev
