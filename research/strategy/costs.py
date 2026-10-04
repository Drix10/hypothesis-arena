"""Cost model.

A fill prices off an NBBO quote at one full spread adverse (minimum 1 bp), plus
Section 31 and TAF fees on sells, a participation cap and, optionally,
square-root market impact. The margin-account carry of the US set (borrow, margin
interest, short dividends) accrues on an actual/360 day count and credits no
rebate on short proceeds. Fee rates are the conservative historical maxima, so a
backtest can only understate edge. Stress multiplies spread, fees and impact.
"""
import math

MIN_COST_BPS = 1.0
SEC31_USD_PER_MILLION = 27.80
TAF_USD_PER_SHARE = 0.000166
TAF_MAX_USD = 8.30
PARTICIPATION_MAX = 0.01  # of 20-day median daily volume
STRESS_LEGS = (1.0, 1.5, 2.0, 3.0)
DAY_COUNT = 360
IMPACT_ETA = 1.0  # square-root law coefficient
ETB_BORROW_RATE = 0.0  # Alpaca: easy-to-borrow names carry no fee
BORROW_STRESS_GRID = {"low": 0.005, "mid": 0.02, "high": 0.05}  # a year


class CostError(ValueError):
    pass


def borrow_stress_rate(name):
    """Annual borrow rate of a named stress grid point."""
    if name not in BORROW_STRESS_GRID:
        raise CostError("borrow-stress-name")
    return BORROW_STRESS_GRID[name]


def fill_px(side: str, mid: float, spread_bps: float, mult: float = 1.0) -> float:
    bps = max(spread_bps * mult, MIN_COST_BPS)
    if side == "BUY":
        return mid * (1.0 + bps / 10000.0)
    if side == "SELL":
        return mid * (1.0 - bps / 10000.0)
    raise ValueError("side must be BUY/SELL")


def quote_mid_spread_bps(bid, ask):
    """(mid, spread_bps) from an NBBO quote; crossed or non-finite is an error."""
    for v in (bid, ask):
        if not isinstance(v, (int, float)) or isinstance(v, bool) \
                or not math.isfinite(v) or not v > 0:
            raise CostError("bad-quote")
    if ask < bid:
        raise CostError("crossed-quote")
    mid = (bid + ask) / 2.0
    return mid, (ask - bid) / mid * 10000.0


def regulatory_fees(side, shares, price, mult=1.0):
    """Section 31 plus TAF in USD; only SELL pays."""
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
    """Participation cap: at most 1% of 20-day median volume and the touch size."""
    if not median_daily_volume_20d > 0:
        raise CostError("no-volume-history")
    cap = int(median_daily_volume_20d * PARTICIPATION_MAX)
    if displayed_size is not None:
        cap = min(cap, int(displayed_size))
    return max(cap, 0)


def fill(side, bid, ask, shares, mult=1.0, median_daily_volume_20d=None,
         displayed_size=None):
    """Model one fill. Returns dict(px, filled, deferred, fee_usd, cost_usd).

    Orders above the participation cap fill only up to the cap; the rest is
    `deferred` (split across sessions or not placed). cost_usd is the total
    adverse cost against the arrival mid (spread leg plus fees), the baseline for
    implementation shortfall.
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


def impact_usd(shares, price, daily_vol, adv, mult=1.0):
    """Square-root impact: shares * price * eta * sigma_d * sqrt(shares / adv).
    daily_vol is the daily return standard deviation; adv is the 20-day median
    volume in shares."""
    if shares <= 0 or price <= 0 or daily_vol < 0 or adv <= 0:
        raise CostError("impact-input")
    return shares * price * IMPACT_ETA * daily_vol * math.sqrt(shares / adv) * mult


def fill_with_impact(side, bid, ask, shares, daily_vol, adv, mult=1.0,
                     displayed_size=None):
    """`fill` plus impact on the filled quantity, stressed by the same
    multiplier. Same keys as `fill` plus impact_usd; cost_usd includes it."""
    out = fill(side, bid, ask, shares, mult, adv, displayed_size)
    if out["filled"] <= 0:
        return dict(out, impact_usd=0.0)
    imp = impact_usd(out["filled"], out["px"], daily_vol, adv, mult)
    return dict(out, impact_usd=imp, cost_usd=out["cost_usd"] + imp)


def dividend_credit(shares_held, dividend_per_share):
    if shares_held < 0 or dividend_per_share < 0:
        raise CostError("dividend-input")
    return shares_held * dividend_per_share


def borrow_fee_usd(short_value, days, annual_rate):
    """Borrow fee on the absolute short market value for `days` calendar days."""
    if days < 0 or annual_rate < 0:
        raise CostError("borrow-input")
    return abs(short_value) * annual_rate * days / DAY_COUNT


def margin_interest_usd(debit_balance, days, annual_rate):
    """Interest on a debit (borrowed cash) balance; a credit balance earns
    nothing."""
    if days < 0 or annual_rate < 0:
        raise CostError("margin-input")
    return max(0.0, debit_balance) * annual_rate * days / DAY_COUNT


def short_dividend_usd(shares_short, dividend_per_share):
    """Dividend the short seller pays on the ex-date."""
    if shares_short < 0 or dividend_per_share < 0:
        raise CostError("dividend-input")
    return shares_short * dividend_per_share
