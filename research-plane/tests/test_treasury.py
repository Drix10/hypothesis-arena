"""Production Treasury FiscalData adapter tests: fake transport + clock."""
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

from sources import treasury

TODAY = "2026-09-24"


def auctions_body(rows):
    return json.dumps({"data": [
        {"cusip": c, "record_date": r, "auction_date": a,
         "security_type": "Bill"} for c, r, a in rows],
        "meta": {}, "links": {}}).encode()


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
    return treasury.Adapter(transport=FakeTransport(routes),
                            clock=c.now, sleeper=c.sleep, **kw)


def ok_routes(rows):
    return {"auctions_query": (200, auctions_body(rows))}


class TestTreasury(unittest.TestCase):
    def test_success_shape(self):
        rows = [("912797AB1", "2026-09-20", "2026-09-18"),
                ("912797AB2", "2026-09-21", "2026-09-19")]
        a = adapter(ok_routes(rows))
        recs, info = a.poll(today=TODAY)
        self.assertTrue(info["ok"])
        self.assertFalse(info["stale"])
        self.assertEqual(len(recs), 2)
        r = recs[0]
        self.assertEqual(r["source_id"], "treasury_auctions")
        self.assertEqual(r["kind"], "macro_release")
        self.assertEqual(r["cusip"], "912797AB1")
        self.assertTrue(r["observed_at_estimated"])
        self.assertIn("fiscaldata.treasury.gov", r["provenance_url"])

    def test_bad_rows_dropped(self):
        a = adapter({"auctions_query": (200, json.dumps({"data": [
            {"cusip": "", "record_date": "2026-09-20"},
            {"record_date": "2026-09-20"},
            {"cusip": "912797AAX", "record_date": "2099-01-01"},
            "not-a-dict"]}).encode())})
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertEqual(info["dropped"], 4)
        self.assertFalse(info["ok"])  # zero usable: never healthy

    def test_timeout_500_malformed_empty_oversized(self):
        cases = ({"auctions_query": TimeoutError("t")}, "TimeoutError",
                 {"auctions_query": (500, b"e")}, "500",
                 {"auctions_query": (200, b"{no")}, "malformed",
                 {"auctions_query": (200, b"")}, "malformed",
                 {"auctions_query": (200, b'{"x": 1}')}, "missing-data",
                 {"auctions_query":
                  (200, b"x" * (treasury.MAX_BODY_BYTES + 1))},
                 "oversized")
        for routes, needle in zip(
                [cases[i] for i in range(0, len(cases), 2)],
                [cases[i] for i in range(1, len(cases), 2)]):
            a = adapter(routes)
            recs, info = a.poll(today=TODAY)
            self.assertEqual(recs, [])
            self.assertIn(needle, " ".join(info["errors"]), needle)

    def test_ua(self):
        a = adapter(ok_routes([]))
        a.poll(today=TODAY)
        for _, h, _ in a.transport.calls:
            self.assertTrue(
                h["User-Agent"].startswith("MiroHedge/phase0 contact="))

    def test_429_episode_recovery(self):
        clock = FakeClock()
        a = treasury.Adapter(
            transport=FakeTransport({"auctions_query": (429, b"s")}),
            clock=clock.now, sleeper=clock.sleep,
            jitter=lambda x, y: 0.0, backoff_base_s=0.0)
        a.poll(today=TODAY)
        self.assertEqual(a.interval, treasury.MIN_INTERVAL_S * 2)
        first = a.throttle_until
        clock.t = first + 1
        a.transport.routes["auctions_query"] = \
            (200, auctions_body([("912797AA1", "2026-09-20", "2026-09-18")]))
        recs, info = a.poll(today=TODAY)
        self.assertEqual(a.interval, treasury.MIN_INTERVAL_S)
        self.assertTrue(info["ok"])

    def test_pacing(self):
        clock = FakeClock()
        starts = []

        def stamping(headers):
            starts.append(clock.t)
            return 200, {}, auctions_body([])

        a = treasury.Adapter(
            transport=FakeTransport({"auctions_query": stamping}),
            clock=clock.now, sleeper=clock.sleep,
            jitter=lambda x, y: 0.0, backoff_base_s=0.0)
        a.poll(today=TODAY)
        a.poll(today=TODAY)
        self.assertGreaterEqual(starts[1] - starts[0],
                                treasury.MIN_INTERVAL_S - 1e-6)

    def test_stale_and_replay(self):
        clock = FakeClock()
        rows = [("912797AA9", "2026-09-20", "2026-09-18")]
        a = adapter(ok_routes(rows), clock)
        r1, info = a.poll(today=TODAY)
        self.assertFalse(info["stale"])
        r2, info2 = a.poll(today=TODAY)
        self.assertEqual(len(r1), 1)
        self.assertEqual(r2, [])
        self.assertEqual(info2["duplicates"], 1)
        clock.t += treasury.TTL_S + 1
        a.transport.routes = {"auctions_query": TimeoutError("x")}
        _r3, info3 = a.poll(today=TODAY)
        self.assertTrue(info3["stale"])

    def test_truncated_eligible_next_poll(self):
        rows = [("91279%04d" % i, "2026-09-20", "2026-09-18")
                for i in range(70)]
        a = adapter(ok_routes(rows))
        r1, i1 = a.poll(today=TODAY)
        self.assertEqual(len(r1), treasury.MAX_RECORDS)
        self.assertEqual(i1["truncated"], 70 - treasury.MAX_RECORDS)
        r2, i2 = a.poll(today=TODAY)
        self.assertEqual(len(r2), 70 - treasury.MAX_RECORDS)
        self.assertEqual(i2["truncated"], 0)

    def test_harvest_envelope(self):
        a = adapter(ok_routes([("912797AA1", "2026-09-20", "2026-09-18")]))
        recs, stamps = a.harvest(["SPY"], 3)
        self.assertEqual(len(recs), 1)
        self.assertTrue(stamps["treasury_auctions"]["ok"])
        self.assertEqual(stamps["treasury_auctions"]["epoch"], 3)

    def test_heartbeat(self):
        a = adapter(ok_routes([("912797AA1", "2026-09-20", "2026-09-18")]))
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
            st, _h, _b = treasury._default_transport("https://x", {}, 30)
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
        a = adapter(ok_routes([("912797AA1", "2026-09-20", "2026-09-18")]),
                    clock)
        _r, info = a.poll(today=TODAY)
        t0 = info["completed_at"]
        clock.t += treasury.TTL_S + 1
        hb = a.heartbeat(info)
        self.assertEqual(hb["ts"], t0)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")

    def test_empty_data_not_healthy(self):
        clock = FakeClock()
        a = adapter(ok_routes([("912797AA1", "2026-09-20",
                                "2026-09-18")]), clock)
        _r, info = a.poll(today=TODAY)
        self.assertTrue(info["ok"])
        t_ok = a.last_ok_ts
        self.assertGreater(t_ok, 0)
        a.transport.routes = {"auctions_query":
                              (200, auctions_body([]))}
        recs, info2 = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info2["ok"])
        self.assertEqual(a.last_ok_ts, t_ok)  # never advances
        self.assertTrue(any("empty-data" in e
                            for e in info2["errors"]))

    def test_all_invalid_not_healthy(self):
        clock = FakeClock()
        a = adapter(ok_routes([("912797AA1", "2026-09-20",
                                "2026-09-18")]), clock)
        _r, _i = a.poll(today=TODAY)
        t_ok = a.last_ok_ts
        bad = {"data": [{"cusip": "BAD!!",  # not 9-alnum
                            "record_date": "2026-09-20",
                            "auction_date": "2026-09-18"},
                           {"cusip": "912797AA2",
                            "record_date": "2026-13-99",  # bad date
                            "auction_date": "2026-09-18"},
                           {"cusip": "912797AA3",
                            "record_date": "2026-09-20",
                            "auction_date": "not-a-date"}]}
        a.transport.routes = {"auctions_query":
                              (200, json.dumps(bad).encode())}
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertEqual(a.last_ok_ts, t_ok)
        self.assertEqual(info["dropped"], 3)

    def test_mixed_valid_invalid_stays_healthy(self):
        a = adapter({"auctions_query": (200, json.dumps({"data": [
            {"cusip": "912797AA1", "record_date": "2026-09-20",
             "auction_date": "2026-09-18", "security_type": "Bill"},
            {"cusip": "short", "record_date": "2026-09-20",
             "auction_date": "2026-09-18"}]}).encode())})
        recs, info = a.poll(today=TODAY)
        self.assertEqual(len(recs), 1)
        self.assertTrue(info["ok"])
        self.assertEqual(info["dropped"], 1)
        self.assertEqual(recs[0]["cusip"], "912797AA1")

    def test_page_size_matches_cap_and_exact_url(self):
        a = adapter(ok_routes([]))
        a.poll(today=TODAY)
        urls = [c[0] for c in a.transport.calls]
        self.assertEqual(len(urls), 1)
        self.assertIn("page%5Bsize%5D=64", urls[0])
        self.assertIn("sort=-record_date", urls[0])

    def test_exact_provenance_url(self):
        a = adapter(ok_routes([("912797AA1", "2026-09-20",
                                "2026-09-18")]))
        recs, _info = a.poll(today=TODAY)
        self.assertEqual(recs[0]["provenance_url"],
                         "https://fiscaldata.treasury.gov/datasets/"
                         "treasury-securities-auctions-data/")

    def test_future_auction_is_published_info(self):
        # record_date=today (published), auction_date=tomorrow
        # (announced): MUST emit, timestamp from record_date.
        a = adapter(ok_routes([("912797AA1", "2026-09-24",
                                "2026-09-25")]))
        recs, info = a.poll(today=TODAY)
        self.assertTrue(info["ok"])
        self.assertEqual(len(recs), 1)
        import calendar as _cal
        import time as _t
        expect = int(_cal.timegm(
            _t.strptime("2026-09-24", "%Y-%m-%d")) * 1000000000)
        self.assertEqual(recs[0]["observed_at_ns"], expect)
        self.assertEqual(recs[0]["auction_date"], "2026-09-25")
        self.assertTrue(recs[0]["observed_at_estimated"])

    def test_future_record_date_dropped(self):
        a = adapter(ok_routes([("912797AA1", "2026-09-25",
                                "2026-09-26")]))
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertEqual(info["dropped"], 1)

    def test_auction_date_never_synthesized(self):
        rows = [{"cusip": "912797AA1", "record_date": "2026-09-20"},
                {"cusip": "912797AA2", "record_date": "2026-09-20",
                 "auction_date": ""},
                {"cusip": "912797AA3", "record_date": "2026-09-20",
                 "auction_date": "09/18/2026"},
                {"cusip": "912797AA4", "record_date": "2026-09-20",
                 "auction_date": "2026-09-18",
                 "security_type": "Bill"}]
        a = adapter({"auctions_query":
                     (200, json.dumps({"data": rows}).encode())})
        recs, info = a.poll(today=TODAY)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["auction_date"], "2026-09-18")
        self.assertEqual(info["dropped"], 3)
        self.assertTrue(info["ok"])

    def test_steady_state_duplicates_stay_healthy(self):
        clock = FakeClock()
        a = adapter(ok_routes([("912797AA1", "2026-09-20",
                                "2026-09-18")]), clock)
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
