"""T1 trend_etf_v1 signal. `make_target_fn` returns a stateful target function
for portfolio.run (one instance per run): on the last session of each month
it holds an asset iff it is in an uptrend and parks the slot in BIL
otherwise. Equal weight per slot; no data past `date` is read."""
MA_MONTHS = 10
MOM_MONTHS = 12
VARIANTS = ("ma10", "mom12_vs_tbill")
CASH_LEG = "BIL"


class TrendError(ValueError):
    pass


def month_end_flags(sessions):
    """Sessions followed by a session in a later month. The final session is
    never flagged: without the next date it cannot be known to be a month end."""
    return {sessions[i]: True for i in range(len(sessions) - 1)
            if sessions[i][:7] != sessions[i + 1][:7]}


def make_target_fn(sessions, universe, variant="ma10", park=True):
    if variant not in VARIANTS:
        raise TrendError("variant")
    if not universe or len(set(universe)) != len(universe):
        raise TrendError("universe")
    if CASH_LEG in universe:
        raise TrendError("cash-leg-in-universe")
    flags = month_end_flags(sessions)
    hist = {s: [] for s in universe}
    tb = []
    need_cash = park or variant == "mom12_vs_tbill"
    w = 1.0 / len(universe)

    def fn(date, closes):
        if date not in flags:
            return None
        last = {s: (closes.get(s) or [None])[-1] for s in universe}
        b = (closes.get(CASH_LEG) or [None])[-1]
        if any(not (c and c > 0) for c in last.values()) or \
                (need_cash and not (b and b > 0)):
            return None  # data hole: skip this rebalance, never guess
        for s in universe:
            hist[s].append(last[s])
        if need_cash:
            tb.append(b)
        out = {}
        for s in universe:
            h = hist[s]
            if variant == "ma10":
                if len(h) < MA_MONTHS:
                    continue
                if h[-1] > sum(h[-MA_MONTHS:]) / MA_MONTHS:
                    out[s] = w
            else:
                if len(h) <= MOM_MONTHS or len(tb) <= MOM_MONTHS:
                    continue
                if h[-1] / h[-1 - MOM_MONTHS] - 1.0 > \
                        tb[-1] / tb[-1 - MOM_MONTHS] - 1.0:
                    out[s] = w
        if park and sum(out.values()) < 1.0 - 1e-12:
            out[CASH_LEG] = 1.0 - sum(out.values())
        return out

    return fn
