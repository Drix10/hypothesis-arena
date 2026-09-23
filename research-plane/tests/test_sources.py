"""Calendar fail-closed gate tests (doc 09 sec. 9.4)."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "sandbox"))  # evidence probes

from sources import calendars
from sources import earnings
import fred_vintage_probe as fred_probe


def _fake_fetcher_factory(forms, dates, items):
    def fake(url):
        if "company_tickers" in url:
            return {"0": {"ticker": "AAA", "cik_str": "1"}}
        return {"filings": {"recent": {
            "form": forms, "filingDate": dates, "items": items}}}
    return fake


class EarningsVetoTest(unittest.TestCase):
    def test_unknown_symbol_is_event_present(self):
        fake = _fake_fetcher_factory([], [], [])
        self.assertTrue(earnings.has_event("NOPE", "2026-09-22",
                                           fetcher=fake))

    def test_fetch_failure_is_event_present(self):
        def boom(url):
            raise OSError("net down")
        self.assertTrue(earnings.has_event("AAA", "2026-09-22",
                                           fetcher=boom))

    def test_empty_filings_is_event_present(self):
        fake = _fake_fetcher_factory([], [], [])
        self.assertTrue(earnings.has_event("AAA", "2026-09-22",
                                           fetcher=fake))

    def test_8k_item202_in_window_suppresses(self):
        fake = _fake_fetcher_factory(["8-K"], ["2026-09-21"],
                                      ["2.02"])
        self.assertTrue(earnings.has_event("AAA", "2026-09-22",
                                           fetcher=fake))

    def test_old_filing_is_event_free(self):
        fake = _fake_fetcher_factory(["10-Q"], ["2026-01-05"], [""])
        self.assertFalse(earnings.has_event("AAA", "2026-09-22",
                                            fetcher=fake))

    def test_non_earnings_8k_is_event_free(self):
        fake = _fake_fetcher_factory(["8-K"], ["2026-09-21"],
                                      ["5.02"])
        self.assertTrue(earnings.has_event("AAA", "2026-09-22",
                                           fetcher=fake))  # no usable
        # earnings data -> unknown -> suppress (fail closed)


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


class FredReplayTest(unittest.TestCase):
    def test_identical_rows_prove_replay(self):
        rows = [("2019-01-01", "21098.827")]
        self.assertTrue(fred_probe.rows_identical(rows, list(rows)))

    def test_divergent_rows_do_not_prove(self):
        self.assertFalse(fred_probe.rows_identical(
            [("2019-01-01", "21098.827")],
            [("2019-01-01", "99999.999")]))

    def test_empty_or_missing_is_not_a_proof(self):
        self.assertFalse(fred_probe.rows_identical([], []))
        self.assertFalse(fred_probe.rows_identical(None, None))
        self.assertFalse(fred_probe.rows_identical(
            [("2019-01-01", "1")], None))

    def test_pct_bounds(self):
        self.assertEqual(fred_probe.pct([3.0, 1.0, 2.0], 0.5), 2.0)
        self.assertEqual(fred_probe.pct([5.0], 0.99), 5.0)


if __name__ == "__main__":
    unittest.main()
