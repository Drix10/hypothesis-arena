"""Production FRED/ALFRED adapter tests: injected fake transport + clock.

No network. Sentinel key asserts the credential never leaks into
errors, records, or heartbeats.
"""
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import fred

KEY = "fred-sentinel-key-000"
TODAY = "2026-09-24"


def obs_body(rows):
    return json.dumps({"observations": [
        {"date": d, "value": v, "realtime_start": "2026-09-01",
         "realtime_end": "2026-09-24"} for d, v in rows]}).encode()


class FakeClock:
    def __init__(self, t=1780000000.0):
        self.t = t
        self.sleeps = []

    def now(self):
        return self.t

    def sleep(self, d):
        self.sleeps.append(d)
        self.t += d


class FakeTransport:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers, timeout_s):
        self.calls.append((url, dict(headers), timeout_s))
        for prefix, resp in self.routes.items():
            if prefix in url:
                if isinstance(resp, Exception):
                    raise resp
                if callable(resp):
                    return resp(dict(headers))
                status, body = resp
                return status, {}, body
        raise AssertionError("unexpected url: " + url)


def adapter(routes, clock=None, **kw):
    kw.setdefault("jitter", lambda a, b: 0.0)
    kw.setdefault("backoff_base_s", 0.0)
    c = clock or FakeClock()
    return fred.Adapter(KEY, transport=FakeTransport(routes),
                        clock=c.now, sleeper=c.sleep, **kw)


def one_series(value="32486.066", date="2026-04-01"):
    return {"https://api.stlouisfed.org/fred/series/observations"
            "?series_id=GDP": (200, obs_body([(date, value)]))}


class TestFred(unittest.TestCase):
    def test_success_record_shape(self):
        a = adapter(one_series())
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertTrue(info["ok"])
        self.assertFalse(info["stale"])
        self.assertEqual(len(recs), 1)
        r = recs[0]
        self.assertEqual(r["source_id"], "fred_macro")
        self.assertEqual(r["kind"], "macro_release")
        self.assertEqual(r["series_id"], "GDP")
        self.assertEqual(r["value"], "32486.066")
        self.assertTrue(r["observed_at_estimated"])
        self.assertEqual(r["realtime_start"], "2026-09-01")
        self.assertIn("fred.stlouisfed.org/series/GDP",
                      r["provenance_url"])

    def test_missing_value_dropped(self):
        a = adapter(one_series(value="."))
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(recs, [])
        self.assertEqual(info["dropped"], 1)

    def test_timeout_explicit(self):
        a = adapter({"observations": TimeoutError("t")})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertTrue(any("TimeoutError" in e for e in info["errors"]))

    def test_http_500(self):
        a = adapter({"observations": (500, b"err")})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("500" in e for e in info["errors"]))

    def test_bad_key_denied(self):
        a = adapter({"observations": (401, b'{"error": "bad key"}')})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("denied" in e for e in info["errors"]))

    def test_400_generic_not_key_denied(self):
        a = adapter({"observations": (400, json.dumps(
            {"error_code": 400,
             "error_message": "Bad Request - missing series_id"}).encode())})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(recs, [])
        blob = " ".join(info["errors"])
        self.assertIn("HTTP 400", blob)
        self.assertNotIn("denied", blob)

    def test_400_key_denied_on_key_evidence(self):
        a = adapter({"observations": (400, json.dumps(
            {"error_code": 400,
             "error_message": "Invalid API key provided"}).encode())})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("denied" in e for e in info["errors"]))
        # classification only: message body never enters records
        self.assertNotIn(KEY, json.dumps(info))

    def test_malformed_empty_oversized(self):
        for body, needle in ((b"{no", "malformed"),
                             (b"", "malformed"),
                             (b'{"observations": "x"}', "missing"),
                             (b"x" * (fred.MAX_BODY_BYTES + 1),
                              "oversized")):
            a = adapter({"observations": (200, body)})
            recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
            self.assertEqual(recs, [])
            blob = " ".join(info["errors"])
            self.assertIn(needle, blob, needle)

    def test_no_key_refuses(self):
        with self.assertRaises(fred.ConfigError):
            fred.Adapter("")
        with self.assertRaises(fred.ConfigError):
            fred.build(api_key=None, env={})

    def test_key_never_leaks(self):
        a = adapter({"observations": OSError("down")})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        hb = a.heartbeat(info)
        blob = json.dumps(info) + json.dumps(recs) + json.dumps(hb)
        self.assertNotIn(KEY, blob)
        # key travels only in the URL query, never headers/errors
        for _u, h, _t in a.transport.calls:
            self.assertNotIn(KEY, json.dumps(h))

    def test_ua_contact(self):
        a = adapter(one_series())
        a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        uas = [h["User-Agent"] for _, h, _ in a.transport.calls]
        self.assertTrue(uas)
        for u in uas:
            self.assertTrue(u.startswith("MiroHedge/phase0 contact="))

    def test_429_episode_and_recovery(self):
        clock = FakeClock()
        c = clock
        a = fred.Adapter(KEY, transport=FakeTransport(
            {"observations": (429, b"s")}), clock=c.now,
            sleeper=c.sleep, jitter=lambda x, y: 0.0,
            backoff_base_s=0.0)
        a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(a.interval, fred.MIN_INTERVAL_S * 2)
        first = a.throttle_until
        clock.t += 10
        a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(a.interval, fred.MIN_INTERVAL_S * 2)
        self.assertEqual(a.throttle_until, first)
        clock.t = first + 1
        a.transport.routes["observations"] = one_series()[
            "https://api.stlouisfed.org/fred/series/observations"
            "?series_id=GDP"]
        a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(a.interval, fred.MIN_INTERVAL_S)

    def test_pacing(self):
        clock = FakeClock()
        starts = []

        def stamping(headers):
            starts.append(clock.t)
            return 200, {}, obs_body([("2026-04-01", "1.0")])

        a = fred.Adapter(KEY, transport=FakeTransport(
            {"observations": stamping}), clock=clock.now,
            sleeper=clock.sleep, jitter=lambda x, y: 0.0,
            backoff_base_s=0.0)
        a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertGreaterEqual(starts[1] - starts[0],
                                fred.MIN_INTERVAL_S - 1e-6)

    def test_stale_transition(self):
        clock = FakeClock()
        a = adapter(one_series(), clock)
        _r, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertFalse(info["stale"])
        clock.t += fred.TTL_S + 1
        a.transport.routes = {"observations": TimeoutError("down")}
        _r2, info2 = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertTrue(info2["stale"])

    def test_partial_not_healthy(self):
        routes = dict(one_series())
        routes["https://api.stlouisfed.org/fred/series/observations"
               "?series_id=BAD"] = (400, b"bad")
        a = adapter(routes)
        recs, info = a.poll({"GDP": ("GDP", ["SPY"]),
                             "BAD": ("CPI", ["SPY"])}, today=TODAY)
        self.assertEqual(len(recs), 1)
        self.assertFalse(info["ok"])

    def test_replay_dedupe(self):
        a = adapter(one_series())
        r1, _ = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        r2, info2 = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertEqual(len(r1), 1)
        self.assertEqual(r2, [])
        self.assertEqual(info2["duplicates"], 1)

    def test_vintage_params_and_replay(self):
        seen = []

        def vintage(headers):
            return 200, {}, obs_body([("2019-04-01", "100.0"),
                                      ("2019-07-01", "101.0")])

        a = adapter({"observations": vintage})
        rows1, err1 = a.fetch_vintage("GDP", "2020-01-01", "2020-01-01",
                                      "2019-01-01", "2019-10-01")
        rows2, err2 = a.fetch_vintage("GDP", "2020-01-01", "2020-01-01",
                                      "2019-01-01", "2019-10-01")
        self.assertEqual(err1, "")
        self.assertTrue(len(rows1) > 0 and rows1 == rows2)
        urls = [c[0] for c in a.transport.calls]
        self.assertTrue(all("realtime_start=2020-01-01" in u
                            for u in urls))
        self.assertTrue(all("realtime_end=2020-01-01" in u for u in urls))

    def test_vintage_bad_row(self):
        a = adapter({"observations":
                     (200, b'{"observations": [{"date": 1}]}')})
        rows, err = a.fetch_vintage("GDP", "2020-01-01", "2020-01-01")
        self.assertIsNone(rows)
        self.assertTrue(err)

    def test_vintage_realtime_never_synthesized(self):
        # missing start
        bad = {"observations": [{"date": "2019-04-01",
                                   "value": "100.0",
                                   "realtime_end": "2020-01-01"}]}
        a = adapter({"observations": (200, json.dumps(bad).encode())})
        rows, err = a.fetch_vintage("GDP", "2020-01-01", "2020-01-01")
        self.assertIsNone(rows)
        self.assertIn("realtime", err)
        # malformed date
        bad = {"observations": [{"date": "2019-04-01",
                                   "value": "100.0",
                                   "realtime_start": "2020-13-01",
                                   "realtime_end": "2020-01-01"}]}
        a = adapter({"observations": (200, json.dumps(bad).encode())})
        rows, err = a.fetch_vintage("GDP", "2020-01-01", "2020-01-01")
        self.assertIsNone(rows)
        # mismatched window: response values carried, never requested
        got = {"observations": [{"date": "2019-04-01",
                                   "value": "100.0",
                                   "realtime_start": "2019-06-01",
                                   "realtime_end": "2019-06-01"}]}
        a = adapter({"observations": (200, json.dumps(got).encode())})
        rows, err = a.fetch_vintage("GDP", "2020-01-01", "2020-01-01")
        self.assertEqual(err, "")
        self.assertEqual(rows[0][2], "2019-06-01")
        self.assertEqual(rows[0][3], "2019-06-01")

    def test_latest_is_max_date_not_last_row(self):
        body = json.dumps({"observations": [
            {"date": "2026-04-01", "value": "32486.066"},
            {"date": "2026-01-01", "value": "32000.0"},
            {"date": "2025-10-01", "value": "."}]}).encode()
        a = adapter({"observations": (200, body)})
        recs, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        self.assertTrue(info["ok"])
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["date"], "2026-04-01")
        self.assertEqual(recs[0]["value"], "32486.066")
        urls = [c[0] for c in a.transport.calls]
        self.assertTrue(all("sort_order=asc" in u for u in urls))

    def test_harvest_envelope(self):
        routes = {}
        for sid in fred.SERIES_CORE:
            routes["series_id=" + sid] = \
                (200, obs_body([("2026-04-01", "1.0")]))
        a = adapter(routes)
        recs, stamps = a.harvest(["SPY"], 7)
        self.assertEqual(len(recs), len(fred.SERIES_CORE))
        self.assertTrue(stamps["fred_macro"]["ok"])
        self.assertEqual(stamps["fred_macro"]["epoch"], 7)

    def test_heartbeat_roundtrip_and_strict(self):
        a = adapter(one_series())
        _r, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        hb = a.heartbeat(info)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "fred-hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "healthy")
            bad = dict(hb, ts=float("nan"))
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(bad, fh)
            self.assertEqual(a.read_heartbeat(p)["state"], "invalid")
            bad = dict(hb, ok=True, stale=True)
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(bad, fh)
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")

    def test_httperror_closed(self):
        closed = []

        class Tracked(io.BytesIO):
            def close(self):
                closed.append(True)
                super().close()

        err429 = urllib.error.HTTPError(
            "https://x", 429, "Slow", {}, Tracked(b"s"))
        with mock.patch.object(urllib.request, "urlopen",
                               side_effect=err429):
            st, _h, body = fred._default_transport("https://x", {}, 30)
        self.assertEqual(st, 429)
        self.assertEqual(closed, [True])

    def test_delayed_heartbeat_stale(self):
        clock = FakeClock()
        a = adapter(one_series(), clock)
        _r, info = a.poll({"GDP": ("GDP", ["SPY"])}, today=TODAY)
        t0 = info["completed_at"]
        clock.t += fred.TTL_S + 1
        hb = a.heartbeat(info)
        self.assertEqual(hb["ts"], t0)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")


if __name__ == "__main__":
    unittest.main()
