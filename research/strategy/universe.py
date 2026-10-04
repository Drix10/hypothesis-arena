"""Point-in-time universe builder (plan/data.md, plan/strategies.md).

Composes the ticker map, cover-page public float and last-trade resolver as of
one date: only observations known, facts filed and events dated by as_of count.
Pure functions over passed-in data; no network.
"""
import datetime

# Same module objects as research/sources tests get from research.sources.*;
# a bare "sources" import would load a second copy.
from research.sources import last_trade, shares_outstanding, ticker_map

ELIGIBLE = "eligible"
BELOW_FLOOR = "below_floor"
UNRESOLVED = "unresolved"
NO_BARS = "no_bars"
DELISTED_BEFORE = "delisted_before"
CLASSES = (ELIGIBLE, BELOW_FLOOR, UNRESOLVED, NO_BARS, DELISTED_BEFORE)


def _float_at(facts, as_of):
    """Public float known at as_of, or None when no filing by then has one."""
    try:
        return shares_outstanding.public_float(
            facts, as_of.isoformat())["value"]
    except shares_outstanding.SharesError:
        return None


def _bars(dates, events, as_of, data_end):
    """(has_bars, last-trade record or None) for one symbol at as_of."""
    if not dates:
        return False, None
    known = [e for e in events if e["date"] <= as_of]
    trade = last_trade.resolve(dates, known, data_end)
    return min(dates) <= as_of <= trade["last_bar_date"], trade


def _record(as_of, cik, observations, facts_by_cik, bars_by_symbol,
            events_by_symbol, data_end, min_float):
    symbol = ticker_map.ticker(observations, cik, as_of)
    pub_float = (_float_at(facts_by_cik[cik], as_of)
                 if cik in facts_by_cik else None)
    rec = {"cik": cik, "symbol": symbol, "public_float": pub_float,
           "has_bars": False, "last_trade": None}
    if symbol is None or pub_float is None:
        rec["class"] = UNRESOLVED
        return rec
    rec["has_bars"], rec["last_trade"] = _bars(
        bars_by_symbol.get(symbol), events_by_symbol.get(symbol, ()), as_of,
        data_end)
    trade = rec["last_trade"]
    if pub_float < min_float:
        rec["class"] = BELOW_FLOOR
    elif rec["has_bars"]:
        rec["class"] = ELIGIBLE
    elif (trade and trade["status"] == "confirmed"
          and trade["last_bar_date"] < as_of):
        rec["class"] = DELISTED_BEFORE
    else:
        rec["class"] = NO_BARS
    return rec


def universe(as_of, ciks, observations, facts_by_cik, bars_by_symbol,
             events_by_symbol, data_end, *, min_float=500e6):
    """The eligible CIKs at as_of with the full classification.

    bars_by_symbol: symbol to bar dates; events_by_symbol: symbol to end
    events (see last_trade.resolve); facts_by_cik: CIK to companyfacts JSON.
    Returns universe (eligible records), records (all), counts per class,
    excluded_share (unresolved + no_bars over candidates not below the floor)
    and void, true when that share breaks the 5% rule."""
    if not isinstance(as_of, datetime.date):
        raise ValueError("bad as_of %r" % (as_of,))
    records = [_record(as_of, int(c), observations, facts_by_cik,
                       bars_by_symbol, events_by_symbol, data_end, min_float)
               for c in ciks]
    counts = {c: 0 for c in CLASSES}
    for r in records:
        counts[r["class"]] += 1
    candidates = len(records) - counts[BELOW_FLOOR]
    excluded = counts[UNRESOLVED] + counts[NO_BARS]
    return {"as_of": as_of,
            "universe": [r for r in records if r["class"] == ELIGIBLE],
            "records": records, "counts": counts,
            "excluded_share": excluded / candidates if candidates else 0.0,
            "void": ticker_map.exceeds_exclusion_limit(excluded, candidates)}
