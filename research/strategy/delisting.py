"""Delisting returns for the backtest (plan/math.md, Point-in-time discipline).

A held name whose price series ends is closed at its last close plus a delisting
return: -30% for a long, 0% for a short, 0% when a confirmed acquisition ended
it (the last price is the deal price). Pure functions; no I/O.
"""
import datetime

from research.sources import last_trade

LONG_RETURN = -0.30
SHORT_RETURN = 0.0
# plan/data.md Survivorship: more unverified ends than this voids the run.
MAX_UNVERIFIED_SHARE = 0.05


class DelistingError(ValueError):
    pass


def _day(text):
    return datetime.date.fromisoformat(text)


def session_ends(prices, events, data_end):
    """({symbol: {"date": iso last bar, "type": event type or None}}, unverified
    symbols) for every series that stops before data_end.

    events: {symbol: [event dicts with ISO date strings]}. An ended series with
    no confirming event is still closed at the rule and is listed as
    unverified; a series without bars is skipped."""
    end = _day(data_end)
    ends, unverified = {}, []
    for sym in sorted(prices):
        days = [_day(d) for d in prices[sym]]
        if not days:
            continue
        evs = [dict(e, date=_day(e["date"])) for e in events.get(sym, ())]
        rec = last_trade.resolve(days, evs, end)
        if rec["status"] == "active":
            continue
        kind = rec["event"]["type"] if rec["event"] else None
        if rec["status"] == "unverified":
            unverified.append(sym)
        ends[sym] = {"date": rec["last_bar_date"].isoformat(), "type": kind}
    return ends, unverified


def require_verified(unverified, total):
    if total > 0 and len(unverified) / total > MAX_UNVERIFIED_SHARE:
        raise DelistingError("unverified-ends:%d/%d" % (len(unverified), total))


def closeouts(shares, prices, ends, day, long_return=LONG_RETURN):
    """[(symbol, signed quantity, cash)] for positions whose series ended before
    `day`; cash is the signed cash change of closing the position at the last
    close times one plus the delisting return."""
    out = []
    for sym in sorted(shares):
        end = (ends or {}).get(sym)
        if end is None or not end["date"] < day:
            continue
        qty = shares[sym]
        if qty > 0:
            ret = 0.0 if end["type"] == "acquisition" else long_return
        else:
            ret = SHORT_RETURN
        out.append((sym, qty, qty * prices[sym][end["date"]][1] * (1 + ret)))
    return out
