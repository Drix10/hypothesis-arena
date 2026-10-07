"""Daily portfolio engine. A target decided at the close of session t executes
at the open of t+1 at cost_v2 prices, whole shares. Cash account (default):
long only, sells first, buys from settled cash only, idle cash earns nothing.
With `margin` terms: signed positions on a margin ledger. Equity is marked at
each close. No trading on the last session."""
import math
from datetime import date as _date

from research.strategy import costs as C
from research.strategy import delisting
from research.strategy.margin import MarginLedger
from research.strategy.settlement import CashLedger


class PortfolioError(ValueError):
    pass


def run(sessions, prices, target_fn, cash0=100000.0, spread_bps=2.0,
        cost_mult=1.0, median_volume=None, min_trade_usd=50.0,
        min_trade_pct=0.005, cash_returns=None, margin=None, dividends=None,
        ends=None, long_return=delisting.LONG_RETURN):
    """prices[sym][date] = (open, close). target_fn(date, closes) returns
    {sym: weight} (weights >= 0, sum <= 1) or None to hold, where
    closes[sym] lists closes through `date`. An unfinished target is retried
    on later sessions. `cash_returns[i]` (optional) is the daily yield idle
    cash earns in session i. Returns dict(returns, equity, trades, cost_usd,
    weights). With `margin` (a MarginTerms) weights are signed with gross at
    most terms.gross_max, `dividends[sym][date]` is the per-share amount paid
    on that session, and the result adds carry_usd and breaches (see
    _run_margin). `ends` (delisting.session_ends) closes a position on the
    first session after its series ends, at the last close times one plus the
    delisting return (`long_return` for a long)."""
    if margin is not None:
        return _run_margin(sessions, prices, target_fn, cash0, spread_bps,
                           cost_mult, median_volume, min_trade_usd,
                           min_trade_pct, cash_returns, margin, dividends,
                           ends, long_return)
    if dividends is not None:
        raise PortfolioError("dividends-need-margin")
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
                led.accrue(led.total_cash() * cash_returns[i])
            for sym, _, cash in delisting.closeouts(led.shares, prices, ends,
                                                    d, long_return):
                led.close_out(sym, cash)
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
            f = C.fill("SELL", bid, ask, qty, mult,
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
            f = C.fill("BUY", bid, ask, qty, mult, (vol or {}).get(s))
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


def _run_margin(sessions, prices, target_fn, cash0, spread_bps, mult, vol,
                min_usd, min_pct, cash_returns, terms, dividends, ends,
                long_return):
    """Margin-account run. Idle credit cash earns nothing (no short rebate), so
    `cash_returns` is refused. A close with equity below the maintenance
    requirement is a breach: the book is flattened at the next open and the
    strategy is not consulted again. A close at or below the buffer multiple
    of maintenance cuts the book to half the last target at the next open; the
    strategy is not consulted and no entry is made until equity is back above
    the buffer."""
    if cash_returns is not None:
        raise PortfolioError("cash-returns-need-cash-account")
    if len(sessions) < 2 or list(sessions) != sorted(set(sessions)):
        raise PortfolioError("sessions-must-be-sorted-unique")
    led = MarginLedger(cash0, terms)
    hist = {s: [] for s in prices}
    equity, rets, trades, wlog, breaches, cuts = [], [], [], [], [], []
    cost_total = carry_total = 0.0
    prev_eq = float(cash0)
    pending = None
    halted = held_down = False
    last_w = {}
    for i, d in enumerate(sessions):
        if i > 0:
            prev = {s: _last(prices[s], sessions, i - 1) for s in led.shares}
            days = (_date.fromisoformat(d)
                    - _date.fromisoformat(sessions[i - 1])).days
            carry_total += led.accrue_carry(prev, days)
            for s in list(led.shares):
                led.dividend(s, (dividends or {}).get(s, {}).get(d, 0.0))
            for sym, qty, cash in delisting.closeouts(led.shares, prices, ends,
                                                      d, long_return):
                led.trade(sym, -qty, cash)
        if pending is not None and i < len(sessions) - 1:
            cost, unfinished = _rebalance_margin(
                led, prices, d, pending, spread_bps, mult, vol, min_usd,
                min_pct, trades, held_down)
            cost_total += cost
            if not unfinished:
                pending = None
        for s in prices:
            if d in prices[s]:
                hist[s].append(prices[s][d][1])
        px = {s: _last(prices[s], sessions, i) for s in led.shares}
        eq = led.equity(px)
        equity.append(eq)
        rets.append(eq / prev_eq - 1.0)
        prev_eq = eq
        if led.shares and not halted and eq < led.maintenance_requirement(px):
            breaches.append(d)
            halted = True
            pending = {"w": {}, "want": None}
        if halted:
            continue
        was_down, held_down = held_down, led.below_buffer(px)
        if held_down:
            if not was_down:
                cuts.append(d)
            pending = {"w": {s: x / 2.0 for s, x in last_w.items()},
                       "want": None}
            continue
        w = target_fn(d, {s: list(v) for s, v in hist.items()})
        if w is None:  # hold; an unfinished earlier target stays pending
            continue
        _check_signed_weights(w, prices, terms.gross_max)
        pending = {"w": w, "want": None}
        last_w = w
        wlog.append((d, dict(w)))
    return {"returns": rets, "equity": equity, "trades": trades,
            "cost_usd": cost_total, "weights": wlog,
            "carry_usd": carry_total, "breaches": breaches,
            "buffer_cuts": cuts}


def _check_signed_weights(w, prices, gross_max):
    if not isinstance(w, dict):
        raise PortfolioError("weights-not-dict")
    gross = 0.0
    for s, x in w.items():
        if s not in prices:
            raise PortfolioError("unknown-symbol:" + s)
        if not (isinstance(x, (int, float)) and math.isfinite(x)):
            raise PortfolioError("bad-weight:" + s)
        gross += abs(x)
    if gross > gross_max + 1e-9:
        raise PortfolioError("leverage-violation")


def _rebalance_margin(led, prices, d, pending, spread_bps, mult, vol, min_usd,
                      min_pct, trades, reduce_only):
    """Execute one session of the signed target; returns (cost, unfinished).
    Orders that cut exposure run first; an order that would leave equity below
    the Reg T initial requirement or at or below the maintenance buffer is
    shrunk, and the target is retried. `reduce_only` drops every order that
    adds exposure."""
    total = 0.0
    unfinished = False
    px_open = {s: prices[s][d][0] for s in prices if d in prices[s]}
    eq = led.equity({s: px_open.get(s, 0.0) for s in led.shares})
    half = spread_bps / 2.0 / 1e4
    target = pending["w"]
    if pending["want"] is None:  # dollar targets fixed at first execution
        pending["want"] = {s: target.get(s, 0.0) * eq for s in prices}
    want = pending["want"]
    min_usd = max(min_usd, min_pct * eq)
    orders = []
    for s in sorted(set(led.shares) | set(target)):
        if s not in px_open:
            continue
        q = led.shares.get(s, 0)
        diff = want.get(s, 0.0) - q * px_open[s]
        if target.get(s, 0.0) == 0:
            dq = -q
        elif abs(diff) < min_usd:
            continue
        else:
            dq = int(abs(diff) / px_open[s]) * (1 if diff > 0 else -1)
        if dq != 0 and not (reduce_only and abs(q + dq) > abs(q)):
            orders.append((abs(q + dq) >= abs(q), s, dq))
    for _, s, dq in sorted(orders):
        o = px_open[s]
        bid, ask = o * (1 - half), o * (1 + half)
        side = "BUY" if dq > 0 else "SELL"
        sgn = 1 if dq > 0 else -1
        qty = abs(dq)
        while qty > 0:
            f = C.fill(side, bid, ask, qty, mult, (vol or {}).get(s))
            if f["filled"] == 0:
                unfinished = True
                break
            unfinished |= f["filled"] < abs(dq)
            cash = -sgn * f["px"] * f["filled"] - f["fee_usd"]
            if _initial_ok(led, px_open, s, sgn * f["filled"], cash):
                led.trade(s, sgn * f["filled"], cash)
                total += f["cost_usd"]
                trades.append((d, s, side, f["filled"], f["px"]))
                break
            unfinished = True
            qty -= max(1, qty // 100)
    return total, unfinished


def _initial_ok(led, px, sym, dq, cash_delta):
    """True when the trade cuts gross or leaves equity at or above the Reg T
    initial requirement and above the maintenance buffer."""
    q = led.shares.get(sym, 0)
    if abs(q + dq) < abs(q):
        return True
    held = {s: px.get(s, 0.0) for s in led.shares}
    held[sym] = px[sym]
    gross = led.gross(held) + (abs(q + dq) - abs(q)) * px[sym]
    eq = led.equity(held) + cash_delta + dq * px[sym]
    after = {s: n for s, n in {**led.shares, sym: q + dq}.items() if n}
    maint = led.maintenance_requirement(held, after)
    return (eq >= led.terms.initial * gross - 1e-9
            and eq > led.terms.buffer * maint)
