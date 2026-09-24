"""Production BLS Employment Situation adapter tests: fake transport."""
import calendar
import io
import json
import os
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import bls

TODAY = "2026-09-24"


def rss_body(items):
    parts = ['<?xml version="1.0"?><rss version="2.0"><channel>']
    for guid, title, pub in items:
        parts.append("<item><guid>%s</guid><title>%s</title>"
                     "<link>https://www.bls.gov/x</link>"
                     "<pubDate>%s</pubDate></item>" % (guid, title, pub))
    parts.append("</channel></rss>")
    return "".join(parts).encode()


PUB = "Mon, 21 Sep 2026 08:30:00 EDT"
PUB2 = "Fri, 18 Sep 2026 08:30:00 EDT"


def day_ns(y, m, d):
    return int(calendar.timegm(time.strptime(
        "%04d-%02d-%02d" % (y, m, d), "%Y-%m-%d")) * 1000000000)


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
    return bls.Adapter(transport=FakeTransport(routes),
                       clock=c.now, sleeper=c.sleep, **kw)


def ok_routes(items):
    return {"empsit.rss": (200, rss_body(items))}


class TestBLS(unittest.TestCase):
    def test_success_shape(self):
        a = adapter(ok_routes([("g1", "Employment Situation", PUB),
                               ("g2", "Employment Situation", PUB2)]))
        recs, info = a.poll(today=TODAY)
        self.assertTrue(info["ok"])
        self.assertFalse(info["stale"])
        self.assertEqual(len(recs), 2)
        r = recs[0]
        self.assertEqual(r["source_id"], "bls_empsit")
        self.assertEqual(r["kind"], "macro_release")
        self.assertEqual(r["guid"], "g1")
        self.assertEqual(r["observed_at_ns"], day_ns(2026, 9, 21))
        self.assertTrue(r["observed_at_estimated"])
        self.assertTrue(r["values_pending"])
        self.assertEqual(r["symbols"], ["EURUSD", "USDJPY", "SPY"])
        self.assertEqual(r["provenance_url"],
                         "https://www.bls.gov/news.release/empsit.htm")

    def test_bad_rows_dropped(self):
        a = adapter({"empsit.rss": (200,
                     b'<?xml version="1.0"?><rss><channel>'
                     b'<item><title>no guid</title></item>'
                     b'<item><guid></guid><title>empty</title></item>'
                     b'<item><guid>g9</guid><title>bad date</title>'
                     b'<pubDate>not-a-date</pubDate></item>'
                     b'<item><guid>g8</guid><title>future</title>'
                     b'<pubDate>Mon, 28 Sep 2026 08:30:00 EDT</pubDate>'
                     b'</item></channel></rss>')})
        recs, info = a.poll(today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertEqual(info["dropped"], 4)
        self.assertIn("no-usable-records", info["errors"])

    def test_failures(self):
        cases = [({"empsit.rss": TimeoutError("t")}, "TimeoutError"),
                 ({"empsit.rss": (500, b"e")}, "500"),
                 ({"empsit.rss": (200, b"<not xml")}, "malformed"),
                 ({"empsit.rss": (200, b"")}, "malformed"),
                 ({"empsit.rss": (200, b"<html></html>")},
                  "bad-envelope"),
                 ({"empsit.rss": (200,
                    b'<?xml version="1.0"?><rss><channel/>'
                    b'</rss>')}, "empty-data"),
                 ({"empsit.rss":
                   (200, b"x" * (bls.MAX_BODY_BYTES + 1))}, "oversized")]
        for routes, needle in cases:
            a = adapter(routes)
            recs, info = a.poll(today=TODAY)
            self.assertEqual(recs, [])
            self.assertIn(needle, " ".join(info["errors"]), needle)

    def test_exact_url_and_ua(self):
        a = adapter(ok_routes([]))
        a.poll(today=TODAY)
        urls = [c[0] for c in a.transport.calls]
        self.assertEqual(urls, [bls.URL])
        for _, h, _ in a.transport.calls:
            self.assertTrue(
                h["User-Agent"].startswith("MiroHedge/phase0 contact="))

    def test_429_episode_recovery(self):
        clock = FakeClock()
        a = bls.Adapter(
            transport=FakeTransport({"empsit.rss": (429, b"s")}),
            clock=clock.now, sleeper=clock.sleep,
            jitter=lambda x, y: 0.0, backoff_base_s=0.0)
        a.poll(today=TODAY)
        self.assertEqual(a.interval, bls.MIN_INTERVAL_S * 2)
        first = a.throttle_until
        clock.t = first + 1
        a.transport.routes["empsit.rss"] = \
            (200, rss_body([("g1", "T", PUB)]))
        recs, info = a.poll(today=TODAY)
        self.assertEqual(a.interval, bls.MIN_INTERVAL_S)
        self.assertTrue(info["ok"])

    def test_pacing(self):
        clock = FakeClock()
        starts = []

        def stamping(headers):
            starts.append(clock.t)
            return 200, {}, rss_body([])

        a = bls.Adapter(
            transport=FakeTransport({"empsit.rss": stamping}),
            clock=clock.now, sleeper=clock.sleep,
            jitter=lambda x, y: 0.0, backoff_base_s=0.0)
        a.poll(today=TODAY)
        a.poll(today=TODAY)
        self.assertGreaterEqual(starts[1] - starts[0],
                                bls.MIN_INTERVAL_S - 1e-6)

    def test_stale_and_replay(self):
        clock = FakeClock()
        a = adapter(ok_routes([("g1", "T", PUB)]), clock)
        r1, info = a.poll(today=TODAY)
        self.assertFalse(info["stale"])
        r2, info2 = a.poll(today=TODAY)
        self.assertEqual(len(r1), 1)
        self.assertEqual(r2, [])
        self.assertEqual(info2["duplicates"], 1)
        self.assertTrue(info2["ok"])  # usable duplicate stays healthy
        clock.t += bls.TTL_S + 1
        a.transport.routes = {"empsit.rss": TimeoutError("x")}
        _r3, info3 = a.poll(today=TODAY)
        self.assertTrue(info3["stale"])

    def test_truncated_eligible_next_poll(self):
        items = [("g%04d" % i, "T", PUB) for i in range(70)]
        a = adapter(ok_routes(items))
        r1, i1 = a.poll(today=TODAY)
        self.assertEqual(len(r1), bls.MAX_RECORDS)
        self.assertEqual(i1["truncated"], 70 - bls.MAX_RECORDS)
        r2, i2 = a.poll(today=TODAY)
        self.assertEqual(len(r2), 70 - bls.MAX_RECORDS)
        self.assertEqual(i2["truncated"], 0)

    def test_harvest_envelope(self):
        a = adapter(ok_routes([("g1", "T", PUB)]))
        recs, stamps = a.harvest(["SPY"], 3)
        self.assertEqual(len(recs), 1)
        self.assertTrue(stamps["bls_empsit"]["ok"])
        self.assertEqual(stamps["bls_empsit"]["epoch"], 3)

    def test_heartbeat(self):
        a = adapter(ok_routes([("g1", "T", PUB)]))
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
            st, _h, _b = bls._default_transport("https://x", {}, 30)
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
        a = adapter(ok_routes([("g1", "T", PUB)]), clock)
        _r, info = a.poll(today=TODAY)
        t0 = info["completed_at"]
        clock.t += bls.TTL_S + 1
        hb = a.heartbeat(info)
        self.assertEqual(hb["ts"], t0)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")

    def test_all_invalid_carries_explicit_reason(self):
        clock = FakeClock()
        a = adapter(ok_routes([("g1", "T", PUB)]), clock)
        _r, _i = a.poll(today=TODAY)
        t_ok = a.last_ok_ts
        a.transport.routes = {"empsit.rss": (200, rss_body(
            [("", "no guid", PUB)]))}
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
        a = adapter(ok_routes([("g1", "T", PUB)]), clock)
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
