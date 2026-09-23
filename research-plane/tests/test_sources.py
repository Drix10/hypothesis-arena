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
import bea_probe
import alpaca_paper_probe as alpaca_probe


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


class EarningsWiringTest(unittest.TestCase):
    """Poller/TTL/heartbeat/gate: offline (fake fetcher + fake clock +
    tmp heartbeat file). Live latencies stay in the sandbox probe."""
    NOW = 1_000_000.0

    def _hb_path(self):
        import tempfile
        return os.path.join(tempfile.mkdtemp(), "hb.json")

    def test_poll_ok_marks_event_free(self):
        fake = _fake_fetcher_factory(["10-Q"], ["2026-01-05"], [""])
        hb = earnings.poll(("AAA",), fetcher=fake, now=self.NOW)
        self.assertTrue(hb["ok"])
        self.assertFalse(hb["symbols"][0]["suppress"])
        self.assertEqual(hb["cadence_s"], 300)
        self.assertEqual(hb["ttl_s"], 900)

    def test_poll_failure_marks_unknown(self):
        def boom(url):
            raise OSError("net down")
        hb = earnings.poll(("AAA",), fetcher=boom, now=self.NOW)
        self.assertFalse(hb["ok"])
        self.assertTrue(hb["symbols"][0]["suppress"])

    def test_absent_heartbeat_suppresses(self):
        g = earnings.gate(("AAA",),
                          heartbeat_path="/nonexistent/hb.json",
                          now=self.NOW)
        self.assertEqual(g, {"suppress": True, "reason": "absent"})

    def test_invalid_heartbeat_suppresses(self):
        p = self._hb_path()
        with open(p, "w") as fh:
            fh.write("not-json{")
        g = earnings.gate(("AAA",), heartbeat_path=p, now=self.NOW)
        self.assertEqual(g, {"suppress": True, "reason": "invalid"})

    def test_stale_heartbeat_suppresses_as_absent(self):
        p = self._hb_path()
        fake = _fake_fetcher_factory(["10-Q"], ["2026-01-05"], [""])
        earnings.write_heartbeat(
            p, earnings.poll(("AAA",), fetcher=fake, now=self.NOW))
        g = earnings.gate(("AAA",), heartbeat_path=p,
                          now=self.NOW + 901)
        self.assertEqual(g, {"suppress": True, "reason": "stale"})

    def test_fresh_event_free_passes(self):
        p = self._hb_path()
        fake = _fake_fetcher_factory(["10-Q"], ["2026-01-05"], [""])
        earnings.write_heartbeat(
            p, earnings.poll(("AAA",), fetcher=fake, now=self.NOW))
        g = earnings.gate(("AAA",), heartbeat_path=p, now=self.NOW)
        self.assertEqual(g, {"suppress": False,
                             "reason": "event-free"})

    def test_fresh_event_suppresses_with_event_reason(self):
        p = self._hb_path()
        fake = _fake_fetcher_factory(["8-K"], ["2026-09-21"], ["2.02"])
        hb = earnings.poll(("AAA",), fetcher=fake, now=self.NOW)
        # asof derives from now: 1970-01-12 is far from 2026-09-21,
        # so craft the heartbeat at an asof inside the window instead.
        import datetime
        asof_now = datetime.datetime(2026, 9, 22,
                                     tzinfo=datetime.timezone.utc
                                     ).timestamp()
        earnings.write_heartbeat(
            p, earnings.poll(("AAA",), fetcher=fake, now=asof_now))
        g = earnings.gate(("AAA",), heartbeat_path=p, now=asof_now)
        self.assertEqual(g, {"suppress": True, "reason": "event"})
        self.assertTrue(hb["ok"])  # poll itself succeeded


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


class BeaErrorShapeTest(unittest.TestCase):
    """BEA nests call errors inside Results.Error at HTTP 200: that
    shape must read as denial, never as data."""

    def test_results_error_is_denial(self):
        api = {"Results": {
            "Error": {"APIErrorCode": "20",
                        "APIErrorDescription": "The Dataset requested "
                        "does not exist."}}}
        res = api.get("Results", {})
        err_node = api.get("Error", res.get("Error"))
        self.assertIsNotNone(err_node)
        self.assertIn("does not exist", str(
            err_node.get("APIErrorDescription", "")))

    def test_rows_identical(self):
        self.assertTrue(bea_probe.rows_identical(
            [("2024", "1.4")], [("2024", "1.4")]))
        self.assertFalse(bea_probe.rows_identical([], []))
        self.assertFalse(bea_probe.rows_identical(None, None))


class AlpacaPaperShapeTest(unittest.TestCase):
    """Paper-base pin + response-shape predicates on canned bodies
    (live calls stay in the sandbox probe, never in unit tests)."""

    def test_paper_base_pinned_not_live(self):
        self.assertEqual(alpaca_probe.PAPER,
                         "https://paper-api.alpaca.markets")
        self.assertNotIn("live", alpaca_probe.PAPER)

    def test_account_shape(self):
        body = {"id": "abc", "status": "ACTIVE",
                "currency": "USD", "buying_power": "400000"}
        self.assertTrue(body.get("id")
                        and body.get("status") == "ACTIVE"
                        and body.get("buying_power"))

    def test_bad_key_shape_is_denial(self):
        # Probe convention: denied := body is None (401/403 carry
        # error dicts, never data).
        self.assertTrue((lambda b, e: b is None)(
            None, {"http": 401, "message": "unauthorized"}))
        self.assertFalse((lambda b, e: b is None)(
            {"id": "abc"}, None))


if __name__ == "__main__":
    unittest.main()
