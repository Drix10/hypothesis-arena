"""Calendar fail-closed gate tests (doc 09 sec. 9.4)."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import calendars


class CalendarTest(unittest.TestCase):
    def test_missing_is_fail_closed(self):
        with self.assertRaises(calendars.CalendarMissing):
            calendars.load_calendar("/nonexistent/calendar.json")
        with self.assertRaises(calendars.CalendarMissing):
            calendars.session_gated_ok("/nonexistent/calendar.json",
                                       "filing_event")

    def test_macro_never_gated(self):
        self.assertTrue(calendars.session_gated_ok(
            "/nonexistent/calendar.json", "macro_release"))

    def test_seed_loads(self):
        cal = calendars.load_calendar(
            os.path.join(ROOT, "..", "collector",
                         "session_calendar.json"))
        self.assertTrue(cal["fail_closed"])


if __name__ == "__main__":
    unittest.main()
