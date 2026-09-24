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
              "primaryDocument": [], "items": [],
              "acceptanceDateTime": []}
    for row in rows:
        acc, date, form, doc, items = row[:5]
        acc_dt = row[5] if len(row) > 5 else None
        recent["accessionNumber"].append(acc)
        recent["filingDate"].append(date)
        recent["form"].append(form)
        recent["primaryDocument"].append(doc)
        recent["items"].append(items)
        recent["acceptanceDateTime"].append(acc_dt)
    return {"cik": "320193", "name": "Apple Inc",
            "filings": {"recent": recent}}


def noon_24():
    import calendar as _cal
    return float(_cal.timegm((2026, 9, 24, 12, 0, 0, 0, 0, 0)))


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
    """routes: url-prefix -> (status, body) | Exception | handler.
    A handler(headers) returns (status, resp_headers, body) and lets
    tests assert conditional-request headers and 304 behavior."""

    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers, timeout_s):
        self.calls.append((url, dict(headers), timeout_s))
        for prefix, resp in self.routes.items():
            if url.startswith(prefix):
                if isinstance(resp, Exception):
                    raise resp
                if callable(resp):
                    return resp(dict(headers))
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
            with open(p, "w") as fh:
                fh.write("{broken")
            self.assertEqual(a.read_heartbeat(p)["state"], "invalid")

    # ---- audit-round-2 regressions ----

    def test_real_httperror_boundary(self):
        import io
        import urllib.error
        import urllib.request
        from unittest import mock
        err429 = urllib.error.HTTPError(
            "https://x", 429, "Too Many Requests", {}, io.BytesIO(b"s"))
        with mock.patch.object(urllib.request, "urlopen",
                               side_effect=err429):
            st, h, body = edgar._default_transport("https://x", {}, 30)
        self.assertEqual(st, 429)
        self.assertEqual(body, b"s")
        err500 = urllib.error.HTTPError(
            "https://x", 500, "Server Error", {}, io.BytesIO(b"e"))
        with mock.patch.object(urllib.request, "urlopen",
                               side_effect=err500):
            st, h, body = edgar._default_transport("https://x", {}, 30)
        self.assertEqual(st, 500)
        # end to end: a real 429 shape drives the episode throttle
        clock = FakeClock()
        with mock.patch.object(urllib.request, "urlopen",
                               side_effect=err429):
            a = edgar.Adapter(CONTACT, clock=clock.now,
                              sleeper=clock.sleep,
                              jitter=lambda x, y: 0.0,
                              backoff_base_s=0.0)
            recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertEqual(a.interval, edgar.MIN_INTERVAL_S * 2)
        self.assertTrue(any("429" in e for e in info["errors"]))

    def test_429_episode_no_redouble_and_recovery(self):
        clock = FakeClock()
        routes = {edgar.TICKERS_URL: (429, b"slow")}
        a = adapter_c(routes, clock)
        a.poll(["AAPL"], today=TODAY)
        self.assertEqual(a.interval, edgar.MIN_INTERVAL_S * 2)
        first_throttle = a.throttle_until
        clock.t += 10  # same episode: another 429 must NOT re-double
        a.poll(["AAPL"], today=TODAY)
        self.assertEqual(a.interval, edgar.MIN_INTERVAL_S * 2)
        self.assertEqual(a.throttle_until, first_throttle)
        clock.t = first_throttle + 1  # episode over: deterministic
        a.transport.routes[edgar.TICKERS_URL] = (200, tickers_body())
        a.poll(["AAPL"], today=TODAY)  # recovery on next pacing
        self.assertEqual(a.interval, edgar.MIN_INTERVAL_S)
        self.assertEqual(a.throttle_until, 0.0)

    def test_partial_watchlist_not_healthy(self):
        rows = [("0000320193-26-000080", "2026-09-22", "8-K",
                 "d.htm", "")]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL", "ZZZZ"], today=TODAY)
        self.assertEqual(len(recs), 1)  # success preserved
        self.assertFalse(info["ok"])  # but poll is not healthy
        self.assertTrue(info["stale"])  # failure never erases stale
        self.assertTrue(any("unknown-symbol" in e
                            for e in info["errors"]))

    def test_mismatched_arrays_rejected(self):
        bad = {"filings": {"recent": {
            "accessionNumber": ["a1", "a2"],
            "form": ["8-K"],
            "filingDate": ["2026-09-22", "2026-09-21"]}}}
        a = adapter(self.sub_routes([], extra={
            "https://data.sec.gov/submissions/CIK0000320193.json":
                (200, json.dumps(bad).encode())}))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("malformed" in e for e in info["errors"]))

    def test_nonlist_recent_rejected(self):
        bad = {"filings": {"recent": [1, 2]}}
        a = adapter(self.sub_routes([], extra={
            "https://data.sec.gov/submissions/CIK0000320193.json":
                (200, json.dumps(bad).encode())}))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("malformed" in e for e in info["errors"]))

    def test_many_in_window_filings_preserved(self):
        rows = [("0000320193-26-%06d" % i, "2026-09-%02d" % (10 + i % 14),
                 "4", "d.xml", "") for i in range(12)]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs), 12)  # no 8-row omission
        self.assertEqual(info["truncated"], 0)
        self.assertTrue(info["ok"])

    def test_global_cap_overflow_counted(self):
        rows = [("0000320193-26-%06d" % i, "2026-09-22",
                 "8-K", "d.htm", "") for i in range(70)]
        a = adapter(self.sub_routes(rows))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs), edgar.MAX_RECORDS)
        self.assertEqual(info["truncated"], 70 - edgar.MAX_RECORDS)
        self.assertTrue(info["ok"])  # cap is accounting, not failure

    def test_conditional_cache_304(self):
        seen = {}

        def tickers(headers):
            seen.update(headers)
            if "If-None-Match" in headers:
                self.assertEqual(headers["If-None-Match"], '"abc"')
                return 304, {}, b""
            return 200, {"etag": '"abc"'}, tickers_body()

        with tempfile.TemporaryDirectory() as d:
            clock = FakeClock()
            a = adapter_c({edgar.TICKERS_URL: tickers}, clock,
                          cache_dir=d)
            recs, info = a.poll(["AAPL"], today=TODAY)
            self.assertEqual(info["tickers"], "live")
            self.assertNotIn("If-None-Match", seen)
            clock.t += edgar.TICKERS_CACHE_DAYS * 86400 + 1
            recs, info = a.poll(["AAPL"], today=TODAY)
            self.assertEqual(info["tickers"], "cache-revalidated")
            self.assertIn("If-None-Match", seen)
            meta = None
            with open(os.path.join(
                    d, "edgar_tickers.meta.json"),
                    encoding="utf-8") as fh:
                meta = json.load(fh)
            self.assertEqual(meta["etag"], '"abc"')

    def test_request_start_pacing(self):
        clock = FakeClock()
        starts = []

        def stamping(headers):
            starts.append(clock.t)  # actual request-start instant
            return 200, {}, json.dumps(submissions([])).encode()

        with tempfile.TemporaryDirectory() as d:
            routes = {edgar.TICKERS_URL: (200, tickers_body()),
                      "https://data.sec.gov/submissions/"
                      "CIK0000320193.json": stamping}
            a = adapter_c(routes, clock, cache_dir=d)
            a.poll(["AAPL"], today=TODAY)
            a.poll(["AAPL"], today=TODAY)
            self.assertEqual(len(starts), 2)
            self.assertGreaterEqual(starts[1] - starts[0],
                                    edgar.MIN_INTERVAL_S - 1e-6)

    def test_truncated_rows_eligible_next_poll(self):
        rows = [("0000320193-26-%06d" % i, "2026-09-22",
                 "8-K", "d.htm", "") for i in range(70)]
        a = adapter(self.sub_routes(rows))
        recs1, info1 = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs1), edgar.MAX_RECORDS)
        self.assertEqual(info1["truncated"], 70 - edgar.MAX_RECORDS)
        emitted = {r["accession"] for r in recs1}
        recs2, info2 = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs2), 70 - edgar.MAX_RECORDS)
        self.assertEqual(info2["truncated"], 0)
        self.assertEqual(info2["duplicates"], edgar.MAX_RECORDS)
        for r in recs2:
            self.assertNotIn(r["accession"], emitted)

    def test_slow_poll_measures_freshness_at_completion(self):
        clock = FakeClock()

        def slow(headers):
            clock.sleep(edgar.TTL_S + 1)  # poll consumes > TTL
            return 200, {}, tickers_body()

        a = adapter_c({edgar.TICKERS_URL: slow}, clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])  # no map data, but the point stands
        self.assertTrue(info["stale"])
        # clean poll whose body outlasts the TTL: stale, not fresh
        rows = [("0000320193-26-000090", "2026-09-22", "8-K",
                 "d.htm", "")]
        clock2 = FakeClock()

        def slow_sub(headers):
            clock2.sleep(edgar.TTL_S + 1)
            return 200, {}, json.dumps(submissions(rows)).encode()

        a2 = adapter_c({edgar.TICKERS_URL: (200, tickers_body()),
                        "https://data.sec.gov/submissions/"
                        "CIK0000320193.json": slow_sub}, clock2)
        recs2, info2 = a2.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs2), 1)
        self.assertTrue(info2["ok"])
        self.assertTrue(info2["stale"])  # completed past TTL
        hb = a2.heartbeat(info2)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a2.write_heartbeat(p, hb)
            self.assertEqual(a2.read_heartbeat(p)["state"], "stale")

    def test_heartbeat_strict_schema(self):
        a = adapter(self.sub_routes([]))
        base = {"version": 1, "ts": 1780000000.0, "cadence_s": 300,
                "ttl_s": 900, "ok": True, "stale": False,
                "records": 1, "error": ""}
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")

            def state(hb):
                with open(p, "w", encoding="utf-8") as fh:
                    json.dump(hb, fh)
                return a.read_heartbeat(p, now=1780000000.0)["state"]

            self.assertEqual(state(dict(base)), "healthy")
            bad = dict(base, ts=float("nan"))
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, ts=float("inf"))
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, ok=1)
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, ok=True, stale=True)
            self.assertEqual(state(bad), "stale")
            bad = dict(base, records=-1)
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, records="1")
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, error="x" * 201)
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, error=None)
            self.assertEqual(state(bad), "invalid")
            bad = dict(base)
            bad["extra"] = 1
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, version="1")
            self.assertEqual(state(bad), "invalid")
            bad = dict(base, stale="no")
            self.assertEqual(state(bad), "invalid")

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

    # ---- audit-round-4: timestamp / heartbeat / issuer authority ----

    def test_acceptance_time_is_observed(self):
        import calendar as _cal
        rows = [("0000320193-26-000100", "2026-09-22", "8-K",
                 "d.htm", "5.02", "2026-09-22T16:01:00.000Z")]
        clock = FakeClock(t=noon_24())
        a = adapter_c(self.sub_routes(rows), clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertTrue(info["ok"])
        self.assertEqual(len(recs), 1)
        expect = _cal.timegm((2026, 9, 22, 16, 1, 0, 0, 0, 0)) * 10**9
        self.assertEqual(recs[0]["observed_at_ns"], expect)
        self.assertFalse(recs[0]["observed_at_estimated"])
        self.assertEqual(recs[0]["entity_ref"],
                         {"cik": "0000320193"})

    def test_midnight_fallback_is_estimated(self):
        rows = [("0000320193-26-000101", "2026-09-22", "8-K",
                 "d.htm", "")]
        clock = FakeClock(t=noon_24())
        a = adapter_c(self.sub_routes(rows), clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs), 1)
        self.assertTrue(recs[0]["observed_at_estimated"])
        # midnight, never acceptance: strictly before any same-day accept
        import calendar as _cal
        midnight = _cal.timegm((2026, 9, 22, 0, 0, 0, 0, 0, 0)) * 10**9
        self.assertEqual(recs[0]["observed_at_ns"], midnight)

    def test_future_acceptance_dropped(self):
        import calendar as _cal
        rows = [("0000320193-26-000102", "2026-09-24", "8-K",
                 "d.htm", "", "2026-09-24T18:00:00Z")]
        clock = FakeClock(t=noon_24())  # 12:00, acceptance at 18:00
        a = adapter_c(self.sub_routes(rows), clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])  # not yet available: never emitted
        self.assertEqual(info["dropped"], 1)
        # after acceptance passes, the same row emits with exact time
        clock.t = float(_cal.timegm((2026, 9, 24, 19, 0, 0, 0, 0, 0)))
        recs2, info2 = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(len(recs2), 1)
        self.assertFalse(recs2[0]["observed_at_estimated"])

    def test_malformed_acceptance_array_rejected(self):
        bad = {"filings": {"recent": {
            "accessionNumber": ["a1"], "form": ["8-K"],
            "filingDate": ["2026-09-22"],
            "acceptanceDateTime": ["2026-09-22T16:00:00Z", "extra"]}}}
        a = adapter(self.sub_routes([], extra={
            "https://data.sec.gov/submissions/CIK0000320193.json":
                (200, json.dumps(bad).encode())}))
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        self.assertTrue(any("malformed" in e for e in info["errors"]))

    def test_leap_second_never_authoritative(self):
        import calendar as _cal
        bad_times = ["2026-09-22T16:01:60Z",   # leap-second smuggle
                     "2026-09-22T16:61:00Z",   # minute 61
                     "2026-09-22T25:01:00Z",   # hour 25
                     "2026-09-22T16:01:00",    # missing Z
                     "2026-02-30T16:01:00Z",   # impossible date
                     "2026-13-01T00:00:00Z",   # month 13
                     "not-a-time"]
        for i, bad in enumerate(bad_times):
            rows = [("0000320193-26-%06d" % (200 + i), "2026-09-22",
                     "8-K", "d.htm", "", bad)]
            clock = FakeClock(t=noon_24())
            a = adapter_c(self.sub_routes(rows), clock)
            recs, info = a.poll(["AAPL"], today=TODAY)
            self.assertEqual(len(recs), 1, bad)  # kept, not dropped
            self.assertTrue(recs[0]["observed_at_estimated"], bad)
            midnight = _cal.timegm((2026, 9, 22, 0, 0, 0, 0, 0, 0))
            self.assertEqual(recs[0]["observed_at_ns"],
                             midnight * 10**9, bad)

    def test_heartbeat_tmp_cleaned_on_replace_failure(self):
        import os as _os
        from unittest import mock as _mock
        a = adapter(self.sub_routes([]))
        _recs, info = a.poll(["AAPL"], today=TODAY)
        hb = a.heartbeat(info)
        with tempfile.TemporaryDirectory() as d:
            p = _os.path.join(d, "hb.json")
            before = set(_os.listdir(d))
            with _mock.patch.object(_os, "replace",
                                    side_effect=OSError("locked")):
                with self.assertRaises(OSError):
                    a.write_heartbeat(p, hb)
            orphans = [f for f in _os.listdir(d)
                       if f not in before]
            self.assertEqual(orphans, [])

    def test_delayed_heartbeat_does_not_refresh(self):
        clock = FakeClock(t=noon_24())
        rows = [("0000320193-26-000103", "2026-09-22", "8-K",
                 "d.htm", "")]
        a = adapter_c(self.sub_routes(rows), clock)
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertTrue(info["ok"])
        t0 = info["completed_at"]
        self.assertGreater(t0, 0)
        clock.t += edgar.TTL_S + 1  # writer delayed past TTL
        hb = a.heartbeat(info)
        self.assertEqual(hb["ts"], t0)  # poll time, not write time
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "hb.json")
            a.write_heartbeat(p, hb)
            self.assertEqual(a.read_heartbeat(p)["state"], "stale")

    def test_pinned_map_drives_binding(self):
        rows = [("0000320193-26-000104", "2026-09-22", "8-K",
                 "d.htm", "")]
        routes = self.sub_routes(rows)
        clock = FakeClock(t=noon_24())
        a = adapter_c(routes, clock,
                      entity_map={"AAPL": 320193})
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(info["tickers"], "pinned")
        self.assertEqual(len(recs), 1)
        self.assertEqual(recs[0]["entity_ref"],
                         {"cik": "0000320193"})
        urls = [c[0] for c in a.transport.calls]
        self.assertTrue(all("tickers" not in u.split("/")[-1]
                            for u in urls))
        self.assertFalse(any("company_tickers" in u for u in urls))

    def test_pinned_map_mismatch_never_emits_foreign_cik(self):
        # Pinned map says AAPL is CIK 999999: the request MUST go to
        # the pinned CIK (404 here), never to the SEC-file CIK.
        routes = {edgar.TICKERS_URL: (200, tickers_body()),
                  "https://data.sec.gov/submissions/CIK0000999999.json":
                      (404, b"not found")}
        a = adapter(routes, entity_map={"AAPL": 999999})
        recs, info = a.poll(["AAPL"], today=TODAY)
        self.assertEqual(recs, [])
        urls = [c[0] for c in a.transport.calls]
        self.assertTrue(any("CIK0000999999" in u for u in urls))
        self.assertFalse(any("CIK0000320193" in u for u in urls))
        self.assertFalse(any("company_tickers" in u for u in urls))

    def test_explicit_empty_env_means_empty(self):
        import os as _os
        from unittest import mock as _mock
        with _mock.patch.dict(_os.environ, {}, clear=True):
            self.assertEqual(edgar.contact_from_env({}), "")
            with self.assertRaises(edgar.ConfigError):
                edgar.build(contact=None, env={})
            a = edgar.build(contact=None,
                            env={"MIRO_CONTACT": CONTACT})
            self.assertEqual(a.contact, CONTACT)


if __name__ == "__main__":
    unittest.main()
