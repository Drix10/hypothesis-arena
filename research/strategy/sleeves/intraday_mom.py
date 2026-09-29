"""I1 intraday_mom_v1: long SPY over the last half hour when the first half hour
of the session (previous close to 10:00) was up. Cash account, long only,
whole shares, funded from settled cash: the sale of day t settles by the buy
of day t+1, so the full book is tradable every session.

`simulate` takes regular-session 30-minute bars per day and returns the daily
return in excess of nothing (the caller adds the cash leg): `pnl[i]` is the
trade profit net of cost as a fraction of start-of-day equity. No bar after the
decision time is read by the signal."""
import math

from research.strategy import costs_v2 as C

VARIANTS = ("pos", "top_tercile")
BARS_PER_DAY = 13          # 09:30 .. 15:30 starts
MIN_HISTORY = 60           # sessions of r1 before the tercile rule trades
LOOKBACK = 250
SPREAD_BPS = 2.0           # conservative for SPY; stress multiplies it


class IntradayError(ValueError):
    pass


def first_half_hour_returns(days, order):
    """r1[d] = close of the 09:30 bar / previous session's last close - 1.
    A day without a full set of bars, or following one, has no r1."""
    out, prev_close = {}, None
    for d in order:
        bars = days.get(d)
        if not bars or len(bars) != BARS_PER_DAY:
            prev_close = None
            continue
        if prev_close:
            out[d] = bars[0][1] / prev_close - 1.0
        prev_close = bars[-1][1]
    return out


def _tercile_cut(history):
    s = sorted(history)
    return s[(2 * len(s)) // 3]


def decisions(days, order, variant):
    """Set of dates on which the rule buys at 15:30. Uses r1 of the same day
    and, for top_tercile, r1 of strictly earlier days only."""
    if variant not in VARIANTS:
        raise IntradayError("variant")
    r1 = first_half_hour_returns(days, order)
    hist, out = [], set()
    for d in order:
        if d not in r1:
            continue
        if variant == "pos":
            if r1[d] > 0:
                out.add(d)
        elif len(hist) >= MIN_HISTORY and r1[d] > _tercile_cut(hist[-LOOKBACK:]):
            out.add(d)
        hist.append(r1[d])
    return out


def simulate(days, order, variant, cash0=100000.0, mult=1.0):
    """Returns dict(pnl, trades, cost_usd, equity). `pnl[i]` aligns with
    `order`; trades are (date, "SPY", side, qty, price)."""
    buys = decisions(days, order, variant)
    eq, pnl, trades, cost = cash0, [], [], 0.0
    half = SPREAD_BPS / 2e4
    for d in order:
        p = 0.0
        if d in buys:
            bars = days[d]
            px_in, px_out = bars[-1][0], bars[-1][1]
            if not (px_in > 0 and px_out > 0):
                raise IntradayError("bad-bar:" + d)
            ask = px_in * (1 + half)
            qty = int(eq // ask)
            if qty > 0:
                b = C.fill_v2("BUY", px_in * (1 - half), ask, qty, mult)
                s = C.fill_v2("SELL", px_out * (1 - half), px_out * (1 + half),
                              b["filled"], mult)
                if b["filled"] > 0 and s["filled"] > 0:
                    net = s["filled"] * s["px"] - b["filled"] * b["px"] \
                        - s["fee_usd"] - b["fee_usd"]
                    if not math.isfinite(net):
                        raise IntradayError("non-finite:" + d)
                    p = net / eq
                    cost += b["cost_usd"] + s["cost_usd"]
                    trades.append((d, "SPY", "BUY", b["filled"], b["px"]))
                    trades.append((d, "SPY", "SELL", s["filled"], s["px"]))
        pnl.append(p)
        eq *= 1 + p
    return {"pnl": pnl, "trades": trades, "cost_usd": cost, "equity": eq}
