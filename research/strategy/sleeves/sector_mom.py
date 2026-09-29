"""T2 sector_mom_v1 signal. `make_target_fn` returns a stateful target function
for portfolio.run (one instance per run): on the last session of each month it
ranks the universe by trailing return, holds the top K equal weight and parks a
slot in BIL when that asset does not beat T-bills over the same lookback. No
data past `date` is read."""
from research.strategy.sleeves.trend import CASH_LEG, month_end_flags

TOP_K = 3
# (lookback months, skipped most-recent months)
VARIANTS = {"mom12_1": (12, 1), "mom6_0": (6, 0)}


class SectorError(ValueError):
    pass


def make_target_fn(sessions, universe, variant="mom12_1", top_k=TOP_K):
    if variant not in VARIANTS:
        raise SectorError("variant")
    if len(set(universe)) != len(universe) or len(universe) <= top_k:
        raise SectorError("universe")
    if CASH_LEG in universe:
        raise SectorError("cash-leg-in-universe")
    look, skip = VARIANTS[variant]
    flags = month_end_flags(sessions)
    hist = {s: [] for s in universe}
    tb = []
    w = 1.0 / top_k

    def ret(h, i=None):
        # trailing return over `look` months ending `skip` months ago
        end = -1 - skip
        return h[end] / h[end - look] - 1.0

    def fn(date, closes):
        if date not in flags:
            return None
        last = {s: (closes.get(s) or [None])[-1] for s in universe}
        b = (closes.get(CASH_LEG) or [None])[-1]
        if any(not (c and c > 0) for c in last.values()) or not (b and b > 0):
            return None  # data hole: skip this rebalance, never guess
        for s in universe:
            hist[s].append(last[s])
        tb.append(b)
        if len(tb) <= look + skip:
            return None
        scores = sorted(((ret(hist[s]), s) for s in universe),
                        key=lambda t: (-t[0], t[1]))[:top_k]
        floor = ret(tb)
        out = {s: w for r, s in scores if r > floor}
        if sum(out.values()) < 1.0 - 1e-12:
            out[CASH_LEG] = 1.0 - sum(out.values())
        return out

    return fn
