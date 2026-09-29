"""Benchmark set (doc 12 §12.6). Same calendar, same cost_v2, daily returns.

Pure functions over the portfolio engine and plain return lists. The
caller supplies the sleeve's own returns; the "same sleeve without its AI
component" and `baseline_v1` reproduction are paired runs the caller
registers in the trial ledger (they are not synthesized here).
"""
from research.strategy import portfolio, stats


class BenchmarkError(ValueError):
    pass


def cash_returns(n, annual_rate=0.0, periods=252):
    """T-bill leg as a constant daily return (BIL total-return series may
    be substituted by the caller for a dated version)."""
    if n < 1 or annual_rate < 0:
        raise BenchmarkError("cash-input")
    d = (1.0 + annual_rate) ** (1.0 / periods) - 1.0
    return [d] * n


def buy_and_hold(sessions, prices, symbols, **kw):
    """Equal-weight buy-and-hold of `symbols` (bought at the 1st open)."""
    w = {s: 1.0 / len(symbols) for s in symbols}
    first = sessions[0]

    def fn(d, _hist):
        return w if d == first else None
    return portfolio.run(sessions, prices, fn, **kw)


def sixty_forty(sessions, prices, equity="SPY", bond="IEF", **kw):
    """60/40 rebalanced on the first session of each month."""
    last = {"m": None}

    def fn(d, _hist):
        m = d[:7]
        if m != last["m"]:
            last["m"] = m
            return {equity: 0.6, bond: 0.4}
        return None
    return portfolio.run(sessions, prices, fn, **kw)


def vol_match(sleeve, passive):
    """De-risk whichever series is riskier (no leverage; scale <= 1) so
    both have the same realized volatility; the remainder sits in cash at
    0 return. Returns (sleeve_scaled, passive_scaled)."""
    if len(sleeve) != len(passive):
        raise BenchmarkError("calendar-mismatch")
    a, b = stats.stdev(sleeve), stats.stdev(passive)
    if a == 0.0 or b == 0.0:
        raise BenchmarkError("zero-volatility")
    if a >= b:
        k = b / a
        return [x * k for x in sleeve], list(passive)
    k = a / b
    return list(sleeve), [x * k for x in passive]


def compare(sleeve, benches, ann=252):
    """Net Sharpe of the sleeve and of each benchmark + excess per bench."""
    out = {"sleeve_sharpe": stats.sharpe(sleeve, ann)}
    for name, r in benches.items():
        if len(r) != len(sleeve):
            raise BenchmarkError("calendar-mismatch:" + name)
        out[name] = {"sharpe": stats.sharpe(r, ann),
                     "mean_daily_excess": stats.mean(
                         [x - y for x, y in zip(sleeve, r)])}
    return out
