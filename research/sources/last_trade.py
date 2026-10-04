"""Last-trading-day resolver for delisted firms (plan/data.md Survivorship).

A delisting return rests on a dated SEC event: the last bar is confirmed only
when an end event follows it within MAX_LAG_DAYS. Pure functions over bar dates
and event records; no network.
"""
import datetime

MAX_LAG_DAYS = 10

DELISTING_FORMS = ("25", "25-NSE")
DEREGISTRATION_FORMS = ("15-12B", "15-12G", "15-15D")
ACQUISITION_ITEMS = ("3.01", "2.01")
COMMON = "common"


def event_type(event):
    """'delisting', 'deregistration' or 'acquisition' for an event that can end
    the common stock, else None. A Form 25 counts only when its security class
    is stated as common: a bond or preferred Form 25 leaves the common listed,
    and an unstated class fails closed."""
    form = event["form"]
    if form in DELISTING_FORMS:
        return "delisting" if event.get("security_class") == COMMON else None
    if form in DEREGISTRATION_FORMS:
        return "deregistration"
    if form == "8-K" and set(event.get("items") or ()) & set(ACQUISITION_ITEMS):
        return "acquisition"
    return None


def resolve(bar_dates, events, data_end):
    """Record for one symbol: last_bar_date, event and status.

    bar_dates: dates with a daily bar. events: dicts with form, date,
    accession, plus security_class (Form 25) or items (8-K). data_end: the last
    date the bar data covers.
    status: 'active' when the bars reach data_end; 'confirmed' when an end event
    dated from the last bar to MAX_LAG_DAYS after it exists (the earliest is
    returned); else 'unverified' with no event. An event before the last bar
    does not end the symbol."""
    if not bar_dates:
        raise ValueError("no bar dates")
    last = max(bar_dates)
    if last >= data_end:
        return {"last_bar_date": last, "event": None, "status": "active"}
    window = datetime.timedelta(days=MAX_LAG_DAYS)
    hits = sorted((e["date"], e["accession"], event_type(e)) for e in events
                  if event_type(e) and last <= e["date"] <= last + window)
    if not hits:
        return {"last_bar_date": last, "event": None, "status": "unverified"}
    when, accession, kind = hits[0]
    return {"last_bar_date": last, "status": "confirmed",
            "event": {"type": kind, "date": when, "accession": accession}}
