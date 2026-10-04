"""Last-trading-day resolver for delisted firms (plan/data.md Survivorship).

A delisting return rests on a dated SEC event: the last bar is confirmed only
when an end event falls in its window around the bar. Pure functions over bar
dates and event records; no network.
"""
import datetime

DELISTING_FORMS = ("25", "25-NSE")
DEREGISTRATION_FORMS = ("15-12B", "15-12G", "15-15D")
ACQUISITION_ITEMS = ("3.01", "2.01")
COMMON = "common"

# Days before and after the last bar an event may be dated. Form 25 takes
# effect 10 days after filing (Exchange Act Rule 12d2-2(d)(1)), so it precedes
# the last bar; Item 2.01 is filed within 4 business days after closing.
EARLY_WINDOW = (20, 5)
LATE_WINDOW = (5, 10)
WINDOWS = {"25": EARLY_WINDOW, "25-NSE": EARLY_WINDOW, "3.01": EARLY_WINDOW,
           "2.01": LATE_WINDOW, "15-12B": LATE_WINDOW, "15-12G": LATE_WINDOW,
           "15-15D": LATE_WINDOW}


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


def in_window(event, last):
    """True when the event is dated inside the window of any form or item it
    carries."""
    keys = [event["form"]]
    if event["form"] == "8-K":
        keys = [i for i in event.get("items") or () if i in ACQUISITION_ITEMS]
    for key in keys:
        before, after = WINDOWS[key]
        if (last - datetime.timedelta(days=before) <= event["date"]
                <= last + datetime.timedelta(days=after)):
            return True
    return False


def resolve(bar_dates, events, data_end):
    """Record for one symbol: last_bar_date, event and status.

    bar_dates: dates with a daily bar. events: dicts with form, date,
    accession, plus security_class (Form 25) or items (8-K). data_end: the last
    date the bar data covers.
    status: 'active' when the bars reach data_end; 'confirmed' when an end event
    dated inside its window around the last bar exists (the earliest is
    returned); else 'unverified' with no event."""
    if not bar_dates:
        raise ValueError("no bar dates")
    last = max(bar_dates)
    if last >= data_end:
        return {"last_bar_date": last, "event": None, "status": "active"}
    hits = sorted((e["date"], e["accession"], event_type(e)) for e in events
                  if event_type(e) and in_window(e, last))
    if not hits:
        return {"last_bar_date": last, "event": None, "status": "unverified"}
    when, accession, kind = hits[0]
    return {"last_bar_date": last, "status": "confirmed",
            "event": {"type": kind, "date": when, "accession": accession}}
