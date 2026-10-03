"""cost_v3 (plan/14 section 14.10): cost_v2 plus square-root market impact,
and the margin-account carry of the US set: borrow fees on shorts, margin
interest on a debit balance and dividends owed on shorts. Rates accrue on an
actual/360 day count, as brokers charge them. No rebate is credited on short
proceeds."""
import math

from research.strategy.costs_v2 import CostError, fill_v2

COST_MODEL_VERSION = "cost_v3"
DAY_COUNT = 360
IMPACT_ETA = 1.0                 # square-root law coefficient
ETB_BORROW_RATE = 0.0            # Alpaca: easy-to-borrow names carry no fee
STRESS_BORROW_RATE = 0.005       # charged in the stress test (plan/14 14.10)


def impact_usd(shares, price, daily_vol, adv, mult=1.0):
    """Square-root impact: shares * price * eta * sigma_d * sqrt(shares / adv).
    daily_vol is the daily return standard deviation; adv is the 20-day
    median volume in shares."""
    if shares <= 0 or price <= 0 or daily_vol < 0 or adv <= 0:
        raise CostError("impact-input")
    return shares * price * IMPACT_ETA * daily_vol * math.sqrt(shares / adv) * mult


def fill_v3(side, bid, ask, shares, daily_vol, adv, mult=1.0,
            displayed_size=None):
    """fill_v2 (spread, fees, participation cap) plus impact on the filled
    quantity, stressed by the same multiplier. Same keys as fill_v2 plus
    impact_usd; cost_usd includes the impact."""
    out = fill_v2(side, bid, ask, shares, mult, adv, displayed_size)
    if out["filled"] <= 0:
        return dict(out, impact_usd=0.0)
    imp = impact_usd(out["filled"], out["px"], daily_vol, adv, mult)
    return dict(out, impact_usd=imp, cost_usd=out["cost_usd"] + imp)


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
