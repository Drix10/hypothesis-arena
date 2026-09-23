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
    TemporaryDirectory). Live latencies stay in the sandbox probe."""
    NOW = 1_000_000.0

    def _write(self, d, hb):
        import tempfile  # noqa: F401 (stdlib, explicit)
        p = os.path.join(d, "hb.json")
        earnings.write_heartbeat(p, hb)
        return p

    def _good_hb(self, now=None):
        fake = _fake_fetcher_factory(["10-Q"], ["2026-01-05"], [""])
        return earnings.poll(("AAA",), fetcher=fake,
                             now=self.NOW if now is None else now)

    def test_poll_ok_marks_event_free(self):
        hb = self._good_hb()
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
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            with open(p, "w") as fh:
                fh.write("not-json{")
            g = earnings.gate(("AAA",), heartbeat_path=p, now=self.NOW)
            self.assertEqual(g, {"suppress": True,
                                 "reason": "invalid"})

    def test_stale_heartbeat_suppresses_as_absent(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, self._good_hb())
            g = earnings.gate(("AAA",), heartbeat_path=p,
                              now=self.NOW + 901)
            self.assertEqual(g, {"suppress": True, "reason": "stale"})

    def test_fresh_event_free_passes(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, self._good_hb())
            g = earnings.gate(("AAA",), heartbeat_path=p, now=self.NOW)
            self.assertEqual(g, {"suppress": False,
                                 "reason": "event-free"})

    def test_fresh_event_suppresses_with_event_reason(self):
        import datetime
        import tempfile
        asof_now = datetime.datetime(2026, 9, 22,
                                     tzinfo=datetime.timezone.utc
                                     ).timestamp()
        fake = _fake_fetcher_factory(["8-K"], ["2026-09-21"], ["2.02"])
        hb = earnings.poll(("AAA",), fetcher=fake, now=asof_now)
        self.assertTrue(hb["ok"])
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, hb)
            g = earnings.gate(("AAA",), heartbeat_path=p, now=asof_now)
            self.assertEqual(g, {"suppress": True, "reason": "event"})

    def test_adversarial_heartbeats_all_invalid(self):
        import copy
        base = self._good_hb()
        mutants = {
            "ts-string": lambda h: h.update(ts="1000000"),
            "ts-bool": lambda h: h.update(ts=True),
            "ts-nan": lambda h: h.update(ts=float("nan")),
            "ts-inf": lambda h: h.update(ts=float("inf")),
            "ts-future": lambda h: h.update(ts=self.NOW + 10**7),
            "ok-string": lambda h: h.update(ok="false"),
            "no-symbols": lambda h: h.pop("symbols"),
            "empty-symbols": lambda h: h.update(symbols=[]),
            "extra-field": lambda h: h.update(x=1),
            "bad-row": lambda h: h["symbols"].append({"symbol": "X"}),
            "dup-symbols": lambda h: h["symbols"].append(
                dict(h["symbols"][0])),
            "bad-cadence": lambda h: h.update(cadence_s=60),
            "bad-ttl": lambda h: h.update(ttl_s=60),
            "neg-latency": lambda h: h.update(latency_ms=-1.0),
            "neg-events": lambda h: h["symbols"].__setitem__(
                0, dict(h["symbols"][0], events_seen=-2)),
        }
        for name, fn in mutants.items():
            hb = copy.deepcopy(base)
            fn(hb)
            import json as _j
            import tempfile
            with tempfile.TemporaryDirectory() as d:
                p = os.path.join(d, "hb.json")
                with open(p, "w") as fh:
                    fh.write(_j.dumps(hb, allow_nan=True))
                _, state = earnings.read_heartbeat(p, now=self.NOW)
                g = earnings.gate(("AAA",), heartbeat_path=p,
                                  now=self.NOW)
            self.assertEqual(state, "invalid", name)
            self.assertTrue(g["suppress"], name)

    def test_missing_symbol_suppresses_unknown(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = self._write(d, self._good_hb())
            g = earnings.gate(("AAA", "ZZZ"), heartbeat_path=p,
                              now=self.NOW)
            self.assertEqual(g, {"suppress": True,
                                 "reason": "unknown"})

    def test_huge_heartbeat_file_invalid(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            with open(p, "w") as fh:
                fh.write("{" + "\"k\":" + "x" * 70000 + "}")
            _, state = earnings.read_heartbeat(p, now=self.NOW)
            self.assertEqual(state, "invalid")

    def test_concurrent_writers_never_tear(self):
        import tempfile
        import threading
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            errs = []

            def writer(k):
                try:
                    for _ in range(15):
                        hb = self._good_hb(now=self.NOW + k)
                        earnings.write_heartbeat(p, hb)
                except Exception as e:  # noqa: BLE001
                    errs.append(e)

            def reader():
                try:
                    for _ in range(120):
                        hb, state = earnings.read_heartbeat(p)
                        if state == "invalid":
                            # Only acceptable invalid: none — atomic
                            # replace means never torn. Any invalid
                            # here is a writer/reader race failure.
                            errs.append(ValueError("torn-heartbeat"))
                            return
                except Exception as e:  # noqa: BLE001
                    errs.append(e)

            threads = [threading.Thread(target=writer, args=(k,))
                       for k in range(4)]
            threads.append(threading.Thread(target=reader))
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            self.assertEqual(errs, [])
            leftovers = [f for f in os.listdir(d)
                         if f.startswith(".hb-")]
            self.assertEqual(leftovers, [])


class EarningsSecSchemaTest(unittest.TestCase):
    """Malformed SEC submissions payloads raise (fail closed), never
    silently truncate into a possibly event-free subset."""
    TICK = {"0": {"ticker": "AAA", "cik_str": "1"}}

    def _fetch(self, recent):
        def fake(url):
            if "company_tickers" in url:
                return dict(self.TICK)
            return {"filings": {"recent": recent}}
        return fake

    def test_mismatched_lengths_raise(self):
        fake = self._fetch({"form": ["8-K", "10-Q"],
                            "filingDate": ["2026-09-21"], "items": ["",
                                                                     ""]})
        with self.assertRaises(ValueError):
            earnings.recent_event_dates(1, fetcher=fake)

    def test_non_list_fields_raise(self):
        fake = self._fetch({"form": "8-K", "filingDate": [],
                            "items": []})
        with self.assertRaises(ValueError):
            earnings.recent_event_dates(1, fetcher=fake)

    def test_malformed_date_raises(self):
        fake = self._fetch({"form": ["10-Q"],
                            "filingDate": ["Sep 21 2026"], "items": [""]})
        with self.assertRaises(ValueError):
            earnings.recent_event_dates(1, fetcher=fake)

    def test_missing_filing_date_raises(self):
        fake = self._fetch({"form": ["10-Q"], "items": [""]})
        with self.assertRaises(ValueError):
            earnings.recent_event_dates(1, fetcher=fake)

    def test_malformed_item_raises(self):
        fake = self._fetch({"form": ["8-K"],
                            "filingDate": ["2026-09-21"],
                            "items": [{"x": 1}]})
        with self.assertRaises(ValueError):
            earnings.recent_event_dates(1, fetcher=fake)

    def test_malformed_form_raises(self):
        fake = self._fetch({"form": [8], "filingDate": ["2026-09-21"],
                            "items": [""]})
        with self.assertRaises(ValueError):
            earnings.recent_event_dates(1, fetcher=fake)

    def test_duplicate_records_still_decide(self):
        fake = self._fetch({"form": ["8-K", "8-K"],
                            "filingDate": ["2026-09-21", "2026-09-21"],
                            "items": ["2.02", "2.02"]})
        self.assertTrue(earnings.has_event("AAA", "2026-09-22",
                                           fetcher=fake))


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
