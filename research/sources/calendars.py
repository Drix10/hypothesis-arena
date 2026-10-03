"""Fail-closed session calendar gate.

A missing or corrupt calendar raises CalendarMissing: harvest yields no
session-gated records and marks the source stale (R9). This only checks that
the calendar is present; session open/closed evaluation lives in the ctx
session logic downstream.
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
    """True if kind may be harvested. Macro kinds are never gated
    by the equity calendar; equity kinds require a loaded calendar."""
    if kind in ("macro_release", "calendar_ahead"):
        return True
    if isinstance(calendar_or_path, dict):
        return bool(calendar_or_path.get("stocks_window"))
    load_calendar(calendar_or_path)  # raises when missing
    return True
