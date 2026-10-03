#include "sizing.hpp"

namespace kernel {
namespace risk {

Sizing ComputeSize(const SizingInput& in) {
    Sizing out;
    if (in.equity_cents <= 0 || in.risk_bp <= 0 || in.entry_cents <= 0 ||
        in.stop_cents <= 0 || in.stop_cents >= in.entry_cents ||
        in.scale_num <= 0 || in.scale_den <= 0 || in.stage_num <= 0 ||
        in.stage_den <= 0 || in.settled_cash_cents < 0 ||
        in.r2_headroom_cents < 0)
        return out;
    __int128 budget = (__int128)in.equity_cents * in.risk_bp / 10000;
    __int128 dist = in.entry_cents - in.stop_cents;
    __int128 risk_qty = budget * in.scale_num * in.stage_num /
                        (dist * in.scale_den * in.stage_den);

    __int128 best = risk_qty;
    const char* why = "risk-budget";
    if (in.liquidity_cap_shares > 0 && in.liquidity_cap_shares < best) {
        best = in.liquidity_cap_shares;
        why = "liquidity";
    }
    __int128 r2 = in.r2_headroom_cents / in.entry_cents;
    if (r2 < best) {
        best = r2;
        why = "r2-headroom";
    }
    __int128 cash = in.settled_cash_cents / in.entry_cents;
    if (cash < best) {
        best = cash;
        why = "settled-cash";
    }
    out.qty = best > INT64_MAX ? INT64_MAX : (int64_t)best;
    out.limiter = out.qty > 0 ? why : "size-below-one-share";
    return out;
}

}  // namespace risk
}  // namespace kernel
