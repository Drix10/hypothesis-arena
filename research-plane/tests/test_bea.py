"""Production BEA NIPA adapter tests: fake transport + clock."""
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

from sources import bea

TODAY = "2026-09-24"
KEY = "TESTKEY-UNIT-ONLY"


def envelope(data=None, error=None):
    res = {}
    if data is not None:
        res["Data"] = data
    if error is not None:
        res["Error"] = error
    return json.dumps({"BEAAPI": {"Results": res}}).encode()


def row(tp="2024", series="A191RX", val="29,720.9"):
    return {"SeriesCode": series, "TimePeriod": tp, "DataValue": val}


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
    kw.setdefault("user_id", KEY)
    c = clock or FakeClock()
    return bea.Adapter(transport=FakeTransport(routes),
                       clock=c.now, sleeper=c.sleep, **kw)


def ok_routes(rows):
    return {"apps.bea.gov": (200, envelope(data=rows))}


class TestBEA(unittest.TestCase):
    def test_success_shape(self):
        a = adapter(ok_routes([row(), row("2023", "A191RX", "27,720.9")]))
        recs, info = a.poll(today=TODAY)
        self.assertTrue(info["ok"])
        self.assertFalse(info["stale"])
        self.assertEqual(len(recs), 2)
        r = recs[0]
        self.assertEqual(r["source_id"], "bea_nipa_gdp")
        self.assertEqual(r["kind"], "macro_release")
        self.assertEqual(r["table"], "T10101")
        self.assertEqual(r["series"], "A191RX")
        self.assertEqual(r["time_period"], "2024")
        self.assertEqual(r["data_value"], "29,720.9")
        self.assertTrue(r["observed_at_estimated"])
        self.assertIn("bea.gov", r["provenance_url"])

    def test_bad_rows_dropped(self):
        a = adapter(ok_routes([
            {"TimePeriod": "2024", "DataValue": "1.0"},  # no series
            {"SeriesCode": "A", "TimePeriod": "24",
             "DataValue": "1.0"},  # bad year shape
            {"SeriesCode": "A", "TimePeriod": "2027",
             "DataValue": "1.0"},  # future year
            {"SeriesCode": "A", "TimePeriod": "2024",
             "DataValue": "(NA)"},  # non-numeric
            {"SeriesCode": "A", "TimePeriod": "2024",
             "DataValue": "inf"},  # non-finite
            "not-a-dict"]))
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertEqual(info["dropped"], 6)
        self.assertIn("no-usable-records", info["errors"])

    def test_failures(self):
        cases = [({"apps.bea.gov": TimeoutError("t")}, "TimeoutError"),
                 ({"apps.bea.gov": (500, b"e")}, "500"),
                 ({"apps.bea.gov": (200, b"{no")}, "malformed-json"),
                 ({"apps.bea.gov": (200, b"[]")}, "malformed-envelope"),
                 ({"apps.bea.gov": (200, b'{"x": 1}')},
                  "malformed-envelope"),
                 ({"apps.bea.gov": (200, envelope(data=[]))},
                  "empty-data"),
                 ({"apps.bea.gov": (200, envelope(
                     error={"APIErrorDescription": "bad key"}))},
                  "denied: bad key"),
                 ({"apps.bea.gov":
                   (200, b"x" * (bea.MAX_BODY_BYTES + 1))}, "oversized")]
        for routes, needle in cases:
            a = adapter(routes)
            recs, info = a.poll(today=TODAY)
            self.assertEqual(recs, [])
            self.assertIn(needle, " ".join(info["errors"]), needle)

    def test_denied_error_bounded(self):
        long_desc = "D" * 500
        a = adapter({"apps.bea.gov": (200, envelope(
            error={"APIErrorDescription": long_desc}))})
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        hb = a.heartbeat(info)
        self.assertLessEqual(len(hb["error"]), 200)
        self.assertTrue(hb["error"].startswith("denied:"))

    def test_key_never_leaks(self):
        def fail(url, headers, timeout_s):
            raise TimeoutError("down")

        a = adapter({"apps.bea.gov": fail})
        recs, info = a.poll(today=TODAY)
        blob = repr(info) + a.last_error + repr(a.heartbeat(info))
        self.assertNotIn(KEY, blob)
        self.assertIn("UserID=" + KEY, a.transport.calls[0][0])

    def test_key_in_exception_message_never_leaks(self):
        def fail_loud(headers):
            raise TimeoutError("conn failed for UserID=%s" % KEY)

        a = adapter({"apps.bea.gov": fail_loud})
        recs, info = a.poll(today=TODAY)
        blob = repr(info) + a.last_error + repr(a.heartbeat(info))
        self.assertNotIn(KEY, blob)
        self.assertIn("TimeoutError", " ".join(info["errors"]))

    def test_denied_description_redacted(self):
        desc = "Invalid UserID %s rejected" % KEY
        a = adapter({"apps.bea.gov": (200, envelope(
            error={"APIErrorDescription": desc}))})
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        blob = (" ".join(info["errors"]) + a.last_error +
                a.heartbeat(info)["error"])
        self.assertNotIn(KEY, blob)
        self.assertIn("[REDACTED]", blob)
        self.assertTrue(
            info["errors"][0].startswith("denied: Invalid UserID "))

    def test_strict_numeric_grammar(self):
        good = ["29,720.9", "-123.4", "+0.5", "1.2E+03",
                "1E10", "1,234,567", "0", "-0.25"]
        bad = ["1,2,3", "12,34.5", "1_000", "1__2", "(NA)",
               "nan", "NaN", "inf", "-Infinity", "1E", "E10",
               ".5", "5.", "1,2345", ",123", "12,", "--1",
               "1.2.3", "", " ", "0x10", "1e9999"]
        for v in good:
            self.assertTrue(bea._value_ok(v), v)
        for v in bad:
            self.assertFalse(bea._value_ok(v), v)
        a = adapter(ok_routes([row("2024", "S1", "1,2,3"),
                               row("2024", "S2", "29,720.9")]))
        recs, info = a.poll(today=TODAY)
        self.assertEqual([r["series"] for r in recs], ["S2"])
        self.assertEqual(recs[0]["data_value"], "29,720.9")
        self.assertEqual(info["dropped"], 1)
        self.assertTrue(info["ok"])

    def test_build_fail_closed(self):
        with self.assertRaises(bea.ConfigError):
            bea.build(env={})
        with self.assertRaises(bea.ConfigError):
            bea.build(env={"BEA_USER_ID": "  "})
        good = bea.build(env={"BEA_USER_ID": "K1"},
                         transport=FakeTransport({}))
        self.assertEqual(good.user_id, "K1")

    def test_query_locked_and_year_derived(self):
        a = adapter(ok_routes([]))
        a.poll(today=TODAY)
        url = a.transport.calls[0][0]
        for needle in ("method=GETDATA", "datasetname=NIPA",
                       "TableName=T10101", "Frequency=A",
                       "Year=2025%2C2026"):
            self.assertIn(needle, url)

    def test_ua(self):
        a = adapter(ok_routes([]))
        a.poll(today=TODAY)
        for _, h, _ in a.transport.calls:
            self.assertTrue(
                h["User-Agent"].startswith("MiroHedge/phase0 contact="))

    def test_429_episode_recovery(self):
        clock = FakeClock()
        a = bea.Adapter(
            user_id=KEY,
            transport=FakeTransport({"apps.bea.gov": (429, b"s")}),
            clock=clock.now, sleeper=clock.sleep,
            jitter=lambda x, y: 0.0, backoff_base_s=0.0)
        a.poll(today=TODAY)
        self.assertEqual(a.interval, bea.MIN_INTERVAL_S * 2)
        first = a.throttle_until
        clock.t = first + 1
        a.transport.routes["apps.bea.gov"] = \
            (200, envelope(data=[row()]))
        recs, info = a.poll(today=TODAY)
        self.assertEqual(a.interval, bea.MIN_INTERVAL_S)
        self.assertTrue(info["ok"])

    def test_pacing(self):
        clock = FakeClock()
        starts = []

        def stamping(headers):
            starts.append(clock.t)
            return 200, {}, envelope(data=[])

        a = bea.Adapter(
            user_id=KEY,
            transport=FakeTransport({"apps.bea.gov": stamping}),
            clock=clock.now, sleeper=clock.sleep,
            jitter=lambda x, y: 0.0, backoff_base_s=0.0)
        a.poll(today=TODAY)
        a.poll(today=TODAY)
        self.assertGreaterEqual(starts[1] - starts[0],
                                bea.MIN_INTERVAL_S - 1e-6)

    def test_stale_and_replay(self):
        clock = FakeClock()
        a = adapter(ok_routes([row()]), clock)
        r1, info = a.poll(today=TODAY)
        self.assertFalse(info["stale"])
        r2, info2 = a.poll(today=TODAY)
        self.assertEqual(len(r1), 1)
        self.assertEqual(r2, [])
        self.assertEqual(info2["duplicates"], 1)
        self.assertTrue(info2["ok"])
        clock.t += bea.TTL_S + 1
        a.transport.routes = {"apps.bea.gov": TimeoutError("x")}
        _r3, info3 = a.poll(today=TODAY)
        self.assertTrue(info3["stale"])

    def test_truncated_eligible_next_poll(self):
        rows = [row("2024", "S%04d" % i, "1.0") for i in range(70)]
        a = adapter(ok_routes(rows))
        r1, i1 = a.poll(today=TODAY)
        self.assertEqual(len(r1), bea.MAX_RECORDS)
        self.assertEqual(i1["truncated"], 70 - bea.MAX_RECORDS)
        r2, i2 = a.poll(today=TODAY)
        self.assertEqual(len(r2), 70 - bea.MAX_RECORDS)
        self.assertEqual(i2["truncated"], 0)

    def test_harvest_envelope(self):
        a = adapter(ok_routes([row()]))
        recs, stamps = a.harvest(["SPY"], 3)
        self.assertEqual(len(recs), 1)
        self.assertTrue(stamps["bea_nipa_gdp"]["ok"])
        self.assertEqual(stamps["bea_nipa_gdp"]["epoch"], 3)

    def test_heartbeat(self):
        a = adapter(ok_routes([row()]))
        _r, info = a.poll(today=TODAY)
        hb = a.heartbeat(info)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "healthy")
            bad = dict(hb, ts=float("nan"))
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(bad, fh)
            self.assertEqual(a.read_heartbeat(p)["state"], "invalid")

    def test_httperror_closed(self):
        closed = []

        class Tracked(io.BytesIO):
            def close(self):
                closed.append(True)
                super().close()

        err = urllib.error.HTTPError(
            "https://x", 503, "Busy", {}, Tracked(b"s"))
        with mock.patch.object(urllib.request, "urlopen",
                               side_effect=err):
            st, _h, _b = bea._default_transport("https://x", {}, 30)
        self.assertEqual(st, 503)
        self.assertEqual(closed, [True])

    def test_tmp_cleaned(self):
        import os as _os
        from unittest import mock as _mock
        a = adapter(ok_routes([]))
        _r, info = a.poll(today=TODAY)
        with tempfile.TemporaryDirectory() as d:
            p = _os.path.join(d, "hb.json")
            before = set(_os.listdir(d))
            with _mock.patch.object(_os, "replace",
                                    side_effect=OSError("locked")):
                with self.assertRaises(OSError):
                    a.write_heartbeat(p, a.heartbeat(info))
            self.assertEqual(
                [f for f in _os.listdir(d) if f not in before], [])

    def test_delayed_heartbeat_stale(self):
        clock = FakeClock()
        a = adapter(ok_routes([row()]), clock)
        _r, info = a.poll(today=TODAY)
        t0 = info["completed_at"]
        clock.t += bea.TTL_S + 1
        hb = a.heartbeat(info)
        self.assertEqual(hb["ts"], t0)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")

    def test_all_invalid_carries_explicit_reason(self):
        clock = FakeClock()
        a = adapter(ok_routes([row()]), clock)
        _r, _i = a.poll(today=TODAY)
        t_ok = a.last_ok_ts
        a.transport.routes = {"apps.bea.gov": (200, envelope(data=[
            {"SeriesCode": "", "TimePeriod": "2024",
             "DataValue": "1.0"}]))}
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertEqual(a.last_ok_ts, t_ok)
        self.assertIn("no-usable-records", info["errors"])
        hb = a.heartbeat(info)
        self.assertIn("no-usable-records", hb["error"])
        self.assertLessEqual(len(hb["error"]), 200)

    def test_steady_state_duplicates_stay_healthy(self):
        clock = FakeClock()
        a = adapter(ok_routes([row()]), clock)
        r1, i1 = a.poll(today=TODAY)
        self.assertEqual(len(r1), 1)
        self.assertTrue(i1["ok"])
        t1 = a.last_ok_ts
        for _ in range(5):
            clock.t += 60
            r, info = a.poll(today=TODAY)
            self.assertEqual(r, [])
            self.assertEqual(info["duplicates"], 1)
            self.assertTrue(info["ok"])
            self.assertGreater(a.last_ok_ts, t1)
            t1 = a.last_ok_ts
            self.assertFalse(info["stale"])


if __name__ == "__main__":
    unittest.main()
