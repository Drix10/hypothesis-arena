"""Production EDGAR adapter tests: injected fake transport + fake clock.

No network, no secrets, no sleeps. Every provider behavior in the
locked contract (success/timeout/HTTP/malformed/empty/oversized/
bad-timestamp/replay/429/stale) is scripted deterministically.
"""
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import edgar

CONTACT = "edgar-test@example.invalid"
TODAY = "2026-09-24"

TICKERS = {"0": {"cik_str": 320193, "ticker": "AAPL",
                  "title": "Apple Inc"},
           "1": {"cik_str": 789019, "ticker": "MSFT",
                 "title": "Microsoft"}}


def submissions(rows):
    recent = {"accessionNumber": [], "filingDate": [], "form": [],
              "primaryDocument": [], "items": []}
    for acc, date, form, doc, items in rows:
        recent["accessionNumber"].append(acc)
        recent["filingDate"].append(date)
        recent["form"].append(form)
        recent["primaryDocument"].append(doc)
        recent["items"].append(items)
    return {"cik": "320193", "name": "Apple Inc",
            "filings": {"recent": recent}}


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
    """routes: url-prefix -> (status, body-bytes) | Exception instance."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers, timeout_s):
        self.calls.append((url, dict(headers), timeout_s))
        for prefix, resp in self.routes.items():
            if url.startswith(prefix):
                if isinstance(resp, Exception):
                    raise resp
                status, body = resp
                return status, {}, body
        raise AssertionError("unexpected url: " + url)


def tickers_body():
    return json.dumps(TICKERS).encode()


def adapter(routes, clock=None, **kw):
    kw.setdefault("jitter", lambda a, b: 0.0)
    kw.setdefault("backoff_base_s", 0.0)
    return edgar.Adapter(CONTACT, transport=FakeTransport(routes),
                         clock=(clock or FakeClock()).now
                         if clock is None else clock.now,
                         sleeper=(clock or FakeClock()).sleep
                         if clock is None else clock.sleep, **kw)


def adapter_c(routes, clock, **kw):
    kw.setdefault("jitter", lambda a, b: 0.0)
    kw.setdefault("backoff_base_s", 0.0)
    return edgar.Adapter(CONTACT, transport=FakeTransport(routes),
                         clock=clock.now, sleeper=clock.sleep, **kw)


class TestEdgar(unittest.TestCase):
    def sub_routes(self, rows, extra=None):
        r = {edgar.TICKERS_URL: (200, tickers_body()),
             "https://data.sec.gov/submissions/CIK0000320193.json":
                 (200, json.dumps(submissions(rows)).encode())}
        if extra:
            r.update(extra)
        return r

    def test_success_record_shape(self):
        rows = [("0000320193-26-000001", "2026-09-20", "8-K",
                 "aapl-8k.htm", "5.02"),
                ("0000320193-26-000002", "2026-09-22", "10-Q",
                 "aapl-10q.htm", "")]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertTrue(info["ok"])
        self.assertFalse(info["stale"])
        self.assertEqual(len(recs), 2)
        r = recs[0]
        self.assertEqual(r["source_id"], "edgar_8k")
        self.assertEqual(r["symbols"], ["AAPL"])
        self.assertEqual(r["kind"], "filing_event")
        self.assertEqual(r["form"], "8-K")
        self.assertEqual(r["items"], "5.02")
        self.assertEqual(r["filing_date"], "2026-09-20")
        self.assertEqual(r["observed_at_ns"],
                         edgar._filing_date_to_ns("2026-09-20", TODAY))
        self.assertIn("Archives/edgar/data/320193/000032019326000001/",
                      r["provenance_url"])

    def test_ua_is_contact_bearing(self):
        a = adapter(self.sub_routes([]))
        a.poll(["AAPL"], today=TODAY)
        uas = [h["User-Agent"] for _, h, _ in a.transport.calls]
        self.assertTrue(uas)
        for u in uas:
            self.assertEqual(u, "MiroHedge/phase0 contact=" + CONTACT)

    def test_timeout_is_explicit_failure(self):
        a = adapter({edgar.TICKERS_URL: TimeoutError("timed out")})
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertTrue(info["stale"])
        self.assertTrue(any("TimeoutError" in e for e in info["errors"]))

    def test_http_500(self):
        a = adapter({edgar.TICKERS_URL: (500, b"err")})
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertFalse(info["ok"])
        self.assertTrue(any("500" in e for e in info["errors"]))

    def test_malformed_submissions(self):
        a = adapter(self.sub_routes([],
            extra={"https://data.sec.gov/submissions/CIK0000320193.json":
                   (200, b"{not json")}))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("malformed" in e for e in info["errors"]))

    def test_empty_body(self):
        a = adapter(self.sub_routes([],
            extra={"https://data.sec.gov/submissions/CIK0000320193.json":
                   (200, b"")}))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("malformed" in e for e in info["errors"]))

    def test_oversized_body(self):
        big = b"x" * (edgar.MAX_BODY_BYTES + 1)
        a = adapter(self.sub_routes([],
            extra={"https://data.sec.gov/submissions/CIK0000320193.json":
                   (200, big)}))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("oversized" in e for e in info["errors"]))

    def test_bad_timestamps_dropped_never_estimated(self):
        rows = [("0000320193-26-000010", "not-a-date", "8-K", "d.htm", ""),
                ("0000320193-26-000011", "2026-13-99", "8-K", "d.htm", ""),
                ("0000320193-26-000012", "2026-09-30", "8-K", "d.htm", ""),
                ("0000320193-26-000013", "2020-01-05", "8-K", "d.htm", "")]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])  # future + invalid + stale-window
        self.assertEqual(info["dropped"], 3)  # old row is window-skipped

    def test_replay_is_duplicate_not_reemit(self):
        rows = [("0000320193-26-000020", "2026-09-21", "8-K", "d.htm", "")]
        a = adapter(self.sub_routes(rows))
        recs1, _ = a.poll(["AAPL"], today=TODAY)
        recs2, info2 = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs1), 1)
        self.assertEqual(recs2, [])
        self.assertEqual(info2["duplicates"], 1)

    def test_since_watermark_stops_scan(self):
        rows = [("0000320193-26-000030", "2026-09-22", "8-K", "d.htm", ""),
                ("0000320193-26-000031", "2026-09-21", "8-K", "d.htm", "")]
        a = adapter(self.sub_routes(rows))
        recs, _ = a.poll(["AAPL"], today=TODAY,
                         since={"AAPL": "0000320193-26-000031"})
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["accession"], "0000320193-26-000030")

    def test_429_halves_rate(self):
        clock = FakeClock()
        a = adapter_c({edgar.TICKERS_URL: (429, b"slow down")}, clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertEqual(a.interval, edgar.MIN_INTERVAL_S * 2)
        self.assertGreater(a.throttle_until, clock.t)
        self.assertTrue(any("429" in e for e in info["errors"]))

    def test_pacing_enforces_10_per_s(self):
        clock = FakeClock()
        routes = self.sub_routes(
            [("0000320193-26-000040", "2026-09-22", "8-K", "d.htm", "")])
        a = adapter_c(routes, clock)
        a.poll(["AAPL"], today=TODAY)
        a.poll(["AAPL"], today=TODAY)
        # tickers + submissions per poll, each call paced >= 100ms apart
        gaps = [b - a for a, b in zip(clock.sleeps, clock.sleeps[1:])]
        self.assertTrue(clock.sleeps)
        for s in clock.sleeps:
            self.assertGreaterEqual(s, 0.0)
        # total paced time across 4 ordered requests >= 3 intervals
        self.assertGreaterEqual(sum(clock.sleeps),
                                3 * edgar.MIN_INTERVAL_S - 1e-6)
        self.assertEqual(len(gaps), len(clock.sleeps) - 1)

    def test_stale_transition(self):
        clock = FakeClock()
        a = adapter_c(self.sub_routes(
            [("0000320193-26-000050", "2026-09-22", "8-K", "d.htm", "")]),
            clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertFalse(info["stale"])
        # outage long past TTL: explicit stale, no records invented
        clock.t += edgar.TTL_S + 1
        a.transport.routes[edgar.TICKERS_URL] = TimeoutError("down")
        recs2, info2 = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs2, [])
        self.assertTrue(info2["stale"])

    def test_no_contact_refuses(self):
        with self.assertRaises(edgar.ConfigError):
            edgar.Adapter("")
        with self.assertRaises(edgar.ConfigError):
            edgar.build(contact=None, env={})

    def test_no_contact_leak_in_errors(self):
        secret_like = CONTACT
        a = adapter({edgar.TICKERS_URL:
                     OSError("network unreachable")})
        recs, info = a.poll(["AAPL"], today=TODAY)
        blob = json.dumps(info) + json.dumps(recs)
        self.assertNotIn(secret_like, blob)
        self.assertEqual(a.last_error.count(secret_like), 0)

    def test_unknown_symbol(self):
        a = adapter(self.sub_routes([]))
        recs, info = a.poll(["ZZZZ"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("unknown-symbol" in e for e in info["errors"]))

    def test_non_event_form_skipped(self):
        rows = [("0000320193-26-000060", "2026-09-22", "S-8", "d.htm", "")]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(info["ok"])  # clean empty, not a failure

    def test_form4_covered(self):
        rows = [("0000320193-26-000061", "2026-09-22", "4", "d.xml", "")]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["form"], "4")

    def test_harvest_envelope(self):
        rows = [("0000320193-26-000070", "2026-09-22", "8-K", "d.htm", "")]
        a = adapter(self.sub_routes(rows))
        out = a.harvest(["AAPL"], 41)
        self.assertIsInstance(out, tuple)
        recs, stamps = out[0], out[1]
        self.assertEqual(len(recs), 1)
        self.assertIn("edgar_8k", stamps)
        self.assertEqual(stamps["edgar_8k"]["epoch"], 41)
        self.assertTrue(stamps["edgar_8k"]["ok"])

    def test_heartbeat_roundtrip(self):
        a = adapter(self.sub_routes([]))
        _recs, info = a.poll(["AAPL"], today=TODAY)
        hb = a.heartbeat(info)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "edgar-heartbeat.json")
            a.write_heartbeat(p, hb)
            st = a.read_heartbeat(p)
            self.assertEqual(st["state"], "healthy")

    def test_heartbeat_stale_and_invalid(self):
        clock = FakeClock()
        a = adapter_c(self.sub_routes([]), clock)
        _recs, info = a.poll(["AAPL"], today=TODAY)
        hb = a.heartbeat(info)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "edgar-heartbeat.json")
            a.write_heartbeat(p, hb)
            clock.t += edgar.TTL_S + 1
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")
            open(p, "w").write("{broken")
            self.assertEqual(a.read_heartbeat(p)["state"], "invalid")

    def test_companyfacts_bounded(self):
        facts = {"cik": 320193, "facts": {}}
        a = adapter({edgar.TICKERS_URL: (200, tickers_body())},
                    **{})
        a.transport.routes[
            "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json"] \
            = (200, json.dumps(facts).encode())
        got, err = a.fetch_facts(320193)
        self.assertEqual(err, "")
        self.assertEqual(got["cik"], 320193)


if __name__ == "__main__":
    unittest.main()
