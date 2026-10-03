#include <cstdio>
#include <cstring>

#include "sizing.hpp"

static int fails = 0, count = 0;
#define CHECK(name, expr)              \
    do {                               \
        ++count;                       \
        if (!(expr)) {                 \
            std::printf("FAIL %s\n", name); \
            ++fails;                   \
        }                              \
    } while (0)

using namespace kernel::risk;

static SizingInput Base() {
    SizingInput s;
    s.equity_cents = 10000000;   // $100,000
    s.entry_cents = 25000;       // $250.00
    s.stop_cents = 23000;        // $230.00: $20 risk per share
    s.settled_cash_cents = 10000000;
    s.r2_headroom_cents = 7500000;
    return s;
}

int main() {
    Sizing z = ComputeSize(Base());
    // 25 bp of $100,000 = $250 budget / $20 = 12 shares
    CHECK("base-12", z.qty == 12 && !std::strcmp(z.limiter, "risk-budget"));

    SizingInput s = Base();
    s.scale_num = 1; s.scale_den = 2;
    CHECK("r6-halves", ComputeSize(s).qty == 6);
    s.stage_num = 1; s.stage_den = 4;
    CHECK("stage-quarter", ComputeSize(s).qty == 1);  // 250/8 = $31.25 -> 1 share
    s.scale_num = s.scale_den = 1;
    CHECK("stage-quarter-alone", ComputeSize(s).qty == 3);  // 12.5/4

    s = Base();
    s.risk_bp = 50;
    CHECK("elevated-2x", ComputeSize(s).qty == 25);

    s = Base();
    s.settled_cash_cents = 50000;  // $500 = 2 shares
    z = ComputeSize(s);
    CHECK("cash-limits", z.qty == 2 && !std::strcmp(z.limiter, "settled-cash"));

    s = Base();
    s.r2_headroom_cents = 75000;   // 3 shares
    z = ComputeSize(s);
    CHECK("r2-limits", z.qty == 3 && !std::strcmp(z.limiter, "r2-headroom"));

    s = Base();
    s.liquidity_cap_shares = 5;
    z = ComputeSize(s);
    CHECK("liquidity-limits", z.qty == 5 && !std::strcmp(z.limiter, "liquidity"));

    s = Base();
    s.stop_cents = 24990;          // $0.10 stop distance: budget allows 2500
    s.settled_cash_cents = 10000000;
    CHECK("tight-stop-r2-caps", ComputeSize(s).qty == 300);

    s = Base();
    s.equity_cents = 100;          // budget below one share
    z = ComputeSize(s);
    CHECK("below-one", z.qty == 0 && !std::strcmp(z.limiter, "size-below-one-share"));

    for (int k = 0; k < 8; ++k) {
        s = Base();
        if (k == 0) s.equity_cents = 0;
        if (k == 1) s.stop_cents = s.entry_cents;
        if (k == 2) s.stop_cents = 0;
        if (k == 3) s.scale_den = 0;
        if (k == 4) s.risk_bp = -1;
        if (k == 5) s.settled_cash_cents = -1;
        if (k == 6) s.r2_headroom_cents = -1;
        if (k == 7) s.entry_cents = -5;
        Sizing b = ComputeSize(s);
        CHECK("bad-input-zero", b.qty == 0 && !std::strcmp(b.limiter, "bad-inputs"));
    }

    s = Base();
    s.equity_cents = INT64_MAX;
    s.settled_cash_cents = INT64_MAX;
    s.r2_headroom_cents = INT64_MAX;
    z = ComputeSize(s);
    CHECK("no-overflow", z.qty > 0);

    std::printf("CHECKS: %d/%d PASS\n", count - fails, count);
    return fails ? 1 : 0;
}
