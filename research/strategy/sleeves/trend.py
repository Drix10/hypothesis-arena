"""T1 trend_etf_v1 signal (doc 02 §2.3). Pure, stdlib only, no lookahead.

`make_target_fn(sessions, universe, variant)` returns a stateful target_fn
for portfolio.run: it only sees closes up to `date`, acts on the last
session of each calendar month, and returns None (hold) on other days.
Slots that are off-trend (and every slot during warm-up) are parked in the
cash leg (BIL), so the sleeve earns the T-bill return it is benchmarked
against. Equal weight 1/len(universe) per slot.
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
