"""Fail-closed session calendar gate (doc 09 sec. 9.4, stdlib only).

Missing or corrupt calendar -> CalendarMissing -> harvest yields ZERO
session-gated records and marks the source stale. This is the R9
fail-closed rule; "no calendar" is never "assume open".

Explicit scope: this is a configuration-PRESENCE gate only. It does not
evaluate whether a session is open/closed for a timestamp (holidays,
early closes, overnight windows) — that evaluation lives in the ctx
session logic downstream, which consumes this calendar. Do not describe
this module as a complete session implementation.
"""


class CalendarMissing(Exception):
    pass


def load_calendar(path):
    """Returns the calendar dict or raises CalendarMissing (never a
    default-open assumption)."""
    import json
    try:
        with open(path, encoding="utf-8") as fh:
            cal = json.load(fh)
    except (OSError, ValueError) as e:
        raise CalendarMissing("unreadable: %s" % e)
    if not isinstance(cal, dict) or not cal.get("stocks_window"):
        raise CalendarMissing("shape")
    return cal


def session_gated_ok(calendar_or_path, kind):
    """True if kind may be harvested. Forex/macro kinds are never gated
    by the equity calendar; equity kinds require a loaded calendar."""
    if kind in ("macro_release", "calendar_ahead"):
        return True
    if isinstance(calendar_or_path, dict):
        return bool(calendar_or_path.get("stocks_window"))
    load_calendar(calendar_or_path)  # raises when missing
    return True
