"""T1 trend_etf_v1 signal (doc 02 §2.3). Pure, stdlib only, no lookahead.

`make_target_fn(sessions, universe, variant)` returns a stateful target_fn
for portfolio.run: it only sees closes up to `date`, acts on the last
session of each calendar month, and returns None (hold) on other days.
Cash slots are simply unallocated weight (equal weight 1/len(universe)).
"""
MA_MONTHS = 10
MOM_MONTHS = 12
VARIANTS = ("ma10", "mom12_vs_tbill")
CASH_LEG = "BIL"


class TrendError(ValueError):
    pass


def month_end_flags(sessions):
    """{date: True} for the last session of each calendar month in-sample.

    The final session is NOT flagged unless the next session is unknown
    to be in the same month: with no future info we cannot call it a
    month end, so it is left unflagged (fail closed, no lookahead).
    """
    flags = {}
    for i in range(len(sessions) - 1):
        if sessions[i][:7] != sessions[i + 1][:7]:
            flags[sessions[i]] = True
    return flags


def make_target_fn(sessions, universe, variant="ma10"):
    if variant not in VARIANTS:
        raise TrendError("variant")
    if not universe or len(set(universe)) != len(universe):
        raise TrendError("universe")
    if variant == "mom12_vs_tbill" and CASH_LEG in universe:
        raise TrendError("cash-leg-in-universe")
    flags = month_end_flags(sessions)
    hist = {s: [] for s in universe}
    tb = []
    w = 1.0 / len(universe)

    def fn(date, closes):
        if date not in flags:
            return None
        for s in universe:
            c = closes.get(s)
            if c is None or not c > 0:
                return {}
            hist[s].append(c)
        if variant == "mom12_vs_tbill":
            b = closes.get(CASH_LEG)
            if b is None or not b > 0:
                return {}
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
        return out

    return fn
