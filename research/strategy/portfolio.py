"""Daily long-only cash-account portfolio engine. A target decided at the
close of session t executes at the open of t+1 at cost_v2 prices: sells
first, buys from settled cash only, whole shares. Equity is marked at each
close and idle cash earns nothing. No trading on the last session."""
import math

from research.strategy import costs_v2 as C
from research.strategy.settlement import CashLedger


class PortfolioError(ValueError):
    pass


def run(sessions, prices, target_fn, cash0=100000.0, spread_bps=2.0,
        cost_mult=1.0, median_volume=None, min_trade_usd=50.0,
        min_trade_pct=0.005, cash_returns=None):
    """prices[sym][date] = (open, close). target_fn(date, closes) returns
    {sym: weight} (weights >= 0, sum <= 1) or None to hold, where
    closes[sym] lists closes through `date`. An unfinished target is retried
    on later sessions. `cash_returns[i]` (optional) is the daily yield idle
    cash earns in session i. Returns dict(returns, equity, trades, cost_usd,
    weights)."""
    if cash_returns is not None and len(cash_returns) != len(sessions):
        raise PortfolioError("cash-returns-length")
    led = CashLedger(sessions, cash0)
    hist = {s: [] for s in prices}
    equity, rets, trades, cost_total, wlog = [], [], [], 0.0, []
    prev_eq = float(cash0)
    pending = None  # target weights decided at previous close
    for i, d in enumerate(sessions):
        if i > 0:
            led.advance(d)
            if cash_returns is not None:
                led.credit(led.total_cash() * cash_returns[i])
        if pending is not None and i < len(sessions) - 1:
            cost, unfinished = _rebalance(led, prices, d, pending,
                                          spread_bps, cost_mult,
                                          median_volume, min_trade_usd,
                                          min_trade_pct, trades)
            cost_total += cost
            if not unfinished:
                pending = None
        for s in prices:
            if d in prices[s]:
                hist[s].append(prices[s][d][1])
        eq = led.total_cash() + sum(
            q * _last(prices[s], sessions, i) for s, q in led.shares.items())
        equity.append(eq)
        rets.append(eq / prev_eq - 1.0)
        prev_eq = eq
        w = target_fn(d, {s: list(v) for s, v in hist.items()})
        if w is None:  # hold; an unfinished earlier target stays pending
            continue
        _check_weights(w, prices)
        pending = {"w": w, "want": None}
        wlog.append((d, dict(w)))
    return {"returns": rets, "equity": equity, "trades": trades,
            "cost_usd": cost_total, "weights": wlog}


def _last(px, sessions, i):
    for j in range(i, -1, -1):
        if sessions[j] in px:
            return px[sessions[j]][1]
    raise PortfolioError("no-price")


def _check_weights(w, prices):
    if not isinstance(w, dict):
        raise PortfolioError("weights-not-dict")
    tot = 0.0
    for s, x in w.items():
        if s not in prices:
            raise PortfolioError("unknown-symbol:" + s)
        if not (isinstance(x, (int, float)) and math.isfinite(x) and x >= 0):
            raise PortfolioError("long-only-violation:" + s)
        tot += x
    if tot > 1.0 + 1e-9:
        raise PortfolioError("leverage-violation")


def _rebalance(led, prices, d, pending, spread_bps, mult, vol, min_usd,
               min_pct, trades):
    """Execute one session of `target`; returns (cost, unfinished).

    `unfinished` is True when a leg was cut short by unsettled cash or the
    participation cap, so the target is retried next session."""
    total = 0.0
    unfinished = False
    px_open = {s: prices[s][d][0] for s in prices if d in prices[s]}
    eq = led.total_cash() + sum(q * px_open.get(s, 0.0)
                                for s, q in led.shares.items())
    half = spread_bps / 2.0 / 1e4

    def quote(s):
        o = px_open[s]
        return o * (1 - half), o * (1 + half)

    target = pending["w"]
    if pending["want"] is None:  # dollar targets fixed at first execution
        pending["want"] = {s: target.get(s, 0.0) * eq for s in prices}
    want = pending["want"]
    min_usd = max(min_usd, min_pct * eq)
    for s in sorted(set(led.shares) | set(target)):
        if s not in px_open:
            continue
        cur = led.shares.get(s, 0) * px_open[s]
        diff = want.get(s, 0.0) - cur
        if diff < -min_usd or (target.get(s, 0.0) == 0 and s in led.shares):
            qty = led.shares[s] if target.get(s, 0.0) == 0 else min(
                led.shares[s], int(-diff / px_open[s]))
            if qty <= 0:
                continue
            bid, ask = quote(s)
            f = C.fill_v2("SELL", bid, ask, qty, mult,
                          (vol or {}).get(s))
            unfinished |= f["filled"] < qty
            if f["filled"] > 0:
                led.sell(s, f["filled"], f["px"] * f["filled"] - f["fee_usd"])
                total += f["cost_usd"]
                trades.append((d, s, "SELL", f["filled"], f["px"]))
    for s in sorted(target):
        if s not in px_open:
            continue
        diff = want[s] - led.shares.get(s, 0) * px_open[s]
        if diff <= min_usd:
            continue
        bid, ask = quote(s)
        est = ask * (1 + max(spread_bps * mult, 1.0) / 1e4)
        desired = int(diff / est)
        qty = int(min(diff, led.settled) / est)
        unfinished |= qty < desired
        while qty > 0:
            f = C.fill_v2("BUY", bid, ask, qty, mult, (vol or {}).get(s))
            if f["filled"] == 0:
                unfinished = True
                break
            unfinished |= f["filled"] < desired
            cost = f["px"] * f["filled"] + f["fee_usd"]
            if led.can_buy(cost):
                led.buy(s, f["filled"], cost)
                total += f["cost_usd"]
                trades.append((d, s, "BUY", f["filled"], f["px"]))
                break
            qty -= max(1, qty // 100)
    return total, unfinished
