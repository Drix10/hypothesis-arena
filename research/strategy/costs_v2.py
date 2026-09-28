"""cost_v2 (doc 06 §6.0a, freeze v3 A0.3). Stdlib only.

paper_fill_v1 (costs.fill_px, unchanged) priced from an NBBO quote, plus
SEC Section 31 + FINRA TAF on SELLS, a participation cap, and dividends.
Fee rates are held at CONSERVATIVE flat historical maxima for backtests:
the Section 31 rate was $27.80/M for long stretches and is $20.60/M since
2026-04-04 (it was $0.00 for part of 2025-26); using the maximum can only
under-state edge, and fees are ~0.3 bps against spreads of 1-10 bps.
TAF: $0.000166/share, max $8.30/trade. Stress multiplies spread AND fee.
"""
from research.strategy.costs import fill_px

COST_MODEL_VERSION = "cost_v2"
SEC31_USD_PER_MILLION = 27.80
TAF_USD_PER_SHARE = 0.000166
TAF_MAX_USD = 8.30
PARTICIPATION_MAX = 0.01  # of 20-day median daily volume
STRESS_LEGS = (1.0, 1.5, 2.0, 3.0)


class CostError(ValueError):
    pass


def quote_mid_spread_bps(bid, ask):
    """(mid, spread_bps) from an NBBO quote; crossed/locked/absent = error."""
    for v in (bid, ask):
        if not isinstance(v, (int, float)) or isinstance(v, bool) \
                or not v > 0:
            raise CostError("bad-quote")
    if ask < bid:
        raise CostError("crossed-quote")
    mid = (bid + ask) / 2.0
    return mid, (ask - bid) / mid * 10000.0


def regulatory_fees(side, shares, price, mult=1.0):
    """Section 31 + TAF in USD; only SELL pays."""
    if side not in ("BUY", "SELL"):
        raise CostError("side")
    if shares <= 0 or price <= 0 or mult < 1.0:
        raise CostError("bad-fee-input")
    if side == "BUY":
        return 0.0
    s31 = shares * price / 1e6 * SEC31_USD_PER_MILLION
    taf = min(shares * TAF_USD_PER_SHARE, TAF_MAX_USD)
    return (s31 + taf) * mult


def max_fillable_shares(median_daily_volume_20d, displayed_size=None):
    """Participation cap: <= 1% of 20d median volume and <= touch size."""
    if not median_daily_volume_20d > 0:
        raise CostError("no-volume-history")
    cap = int(median_daily_volume_20d * PARTICIPATION_MAX)
    if displayed_size is not None:
        cap = min(cap, int(displayed_size))
    return max(cap, 0)


def fill_v2(side, bid, ask, shares, mult=1.0, median_daily_volume_20d=None,
            displayed_size=None):
    """Model one fill. Returns dict(px, filled, deferred, fee_usd, cost_usd).

    Orders above the participation cap fill only up to the cap; the rest
    is `deferred` (split across sessions or not placed). cost_usd is the
    total adverse cost vs arrival mid (spread leg + fees), the TCA
    implementation-shortfall baseline.
    """
    if mult < 1.0:
        raise CostError("stress-multiplier-below-1")
    if shares <= 0:
        raise CostError("shares")
    mid, spread = quote_mid_spread_bps(bid, ask)
    filled = shares
    if median_daily_volume_20d is not None:
        filled = min(shares, max_fillable_shares(median_daily_volume_20d,
                                                 displayed_size))
    elif displayed_size is not None:
        filled = min(shares, int(displayed_size))
    if filled <= 0:
        return {"px": None, "filled": 0, "deferred": shares,
                "fee_usd": 0.0, "cost_usd": 0.0}
    px = fill_px(side, mid, spread, mult)
    fee = regulatory_fees(side, filled, px, mult)
    slip = abs(px - mid) * filled
    return {"px": px, "filled": filled, "deferred": shares - filled,
            "fee_usd": fee, "cost_usd": slip + fee}


def dividend_credit(shares_held, dividend_per_share):
    if shares_held < 0 or dividend_per_share < 0:
        raise CostError("dividend-input")
    return shares_held * dividend_per_share
