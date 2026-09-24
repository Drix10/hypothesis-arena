"""Production source->graph seam tests: harvest -> canonical -> resolver
-> publish -> frozen ctx_read, with fake transports and fixed clocks."""
import calendar
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.abspath(os.path.join(ROOT, "..")))

from collector import ctx_read
from plane import publish, resolver, schema
from plane import source_seam
from plane.source_seam import to_canonical

TODAY = "2026-09-24"
NOW = float(calendar.timegm((2026, 9, 24, 14, 0, 0, 0, 0, 0)))
ING_NS = int(NOW * 1000000000)
MAP_PATH = os.path.join(ROOT, "..", "collector", "entity_map.json")

PUB_EDGAR = "2026-09-24T13:30:00Z"  # 30m before NOW, in-session
PUB_FRED = "2026-08-01"
PUB_TREAS = ("912797AA1", "2026-09-20", "2026-09-18")
PUB_BLS = "Mon, 21 Sep 2026 08:30:00 EDT"  # Monday, matches calendar


def submissions_body():
    recent = {"accessionNumber": ["0000320193-26-000001"],
              "filingDate": ["2026-09-24"], "form": ["8-K"],
              "primaryDocument": ["doc.htm"], "items": ["2.02"],
              "acceptanceDateTime": [PUB_EDGAR]}
    return json.dumps({"filings": {"recent": recent}}).encode()


def obs_body():
    return json.dumps({"observations": [
        {"date": PUB_FRED, "value": "1.0",
         "realtime_start": "2026-08-01",
         "realtime_end": "2026-09-24"}]}).encode()


def auctions_body():
    c, r, a = PUB_TREAS
    return json.dumps({"data": [
        {"cusip": c, "record_date": r, "auction_date": a,
         "security_type": "Bill"}], "meta": {}, "links": {}}).encode()


def rss_body():
    return ("<?xml version=\"1.0\"?><rss version=\"2.0\"><channel>"
            "<item><guid>g1</guid><title>Employment Situation</title>"
            "<link>https://www.bls.gov/x</link><pubDate>" + PUB_BLS +
            "</pubDate></item></channel></rss>").encode()


def bea_body():
    return json.dumps({"BEAAPI": {"Results": {"Data": [
        {"SeriesCode": "A191RX", "TimePeriod": "2024",
         "DataValue": "29,720.9"}]}}}).encode()


class FakeClock:
    def __init__(self, t=NOW):
        self.t = t

    def now(self):
        return self.t

    def sleep(self, d):
        self.t += d


class FakeTransport:
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def __call__(self, url, headers, timeout_s):
        self.calls.append(url)
        for prefix, resp in self.routes.items():
            if prefix in url:
                if isinstance(resp, Exception):
                    raise resp
                return resp
        raise AssertionError("unexpected url: " + url)


def routes_all():
    return {"CIK0000320193": (200, {}, submissions_body()),
            "fred/series/observations": (200, {}, obs_body()),
            "auctions_query": (200, {}, auctions_body()),
            "empsit.rss": (200, {}, rss_body()),
            "apps.bea.gov": (200, {}, bea_body())}


def make_seam(clock=None, routes=None, heartbeat_dir=None):
    clock = clock or FakeClock()
    transports = {"edgar": FakeTransport(routes or routes_all()),
                  "fred": FakeTransport(routes or routes_all()),
                  "treasury": FakeTransport(routes or routes_all()),
                  "bls": FakeTransport(routes or routes_all()),
                  "bea": FakeTransport(routes or routes_all())}
    seam = source_seam.build_seam(
        env={}, clock=clock.now, transports=transports,
        contact="seam-test@example.invalid", fred_key="K-TEST",
        bea_id="B-TEST", heartbeat_dir=heartbeat_dir)
    # build_seam has no sleeper param; adapters default sleep is unused
    # because pacing never triggers on an unpaused fake clock... except
    # repeated polls DO pace. Patch sleepers to advance the fake clock.
    for src in seam.sources:
        if src.adapter is not None:
            src.adapter.sleep = clock.sleep
            src.adapter.mono = clock.now
    return seam, transports


def parser_candidate(canon):
    c = {"kind": canon["kind"], "value": dict(canon["value"]),
         "symbols": list(canon["symbols"]), "effect": canon["effect"],
         "canonical_hash": canon["content_hash"], "origin": "parser"}
    if canon.get("entity_ref") is not None:
        c["entity_ref"] = dict(canon["entity_ref"])
    if canon.get("provenance_url"):
        c["provenance_url"] = canon["provenance_url"]
    return c


def ctx_accept(feat, content_hash):
    with open(MAP_PATH, "rb") as fh:
        map_sha = hashlib.sha256(fh.read()).hexdigest()
    sid = feat["source_id"]
    wm = {"entity_map_version": "entity-v1",
          "entity_map_sha256": map_sha,
          "sources": {sid: {"last_observation_at": int(NOW) - 300,
                             "cursor": "seam-test"}}}
    hist = {sid: [{"h": content_hash, "ts": int(NOW) - 600},
                  {"h": content_hash, "ts": int(NOW) - 300}]}
    bundle = schema.build_bundle(3, "seam-%s" % sid, [feat], wm, hist)
    tmp = tempfile.mkdtemp()
    bpath = os.path.join(tmp, "b.json")
    with open(bpath, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(bundle))
    db = os.path.join(tmp, "c.db")
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE records (source, source_id, content_hash)")
    con.execute("INSERT INTO records VALUES (?,?,?)",
                (sid, "seam", content_hash))
    con.commit()
    con.close()
    return ctx_read.read_bundle(bpath, db, MAP_PATH, now_ts=NOW)


def full_chain(testcase, seam, source_id, watchlist):
    recs, stamps = seam.harvest(watchlist, 3)
    mine = [r for r in recs if r["source_id"] == source_id]
    testcase.assertTrue(stamps[source_id]["ok"], stamps)
    testcase.assertTrue(len(mine) >= 1)
    canon = seam.store.canonical_for(
        {"canonical_hash": source_seam._content_hash(mine[0])})
    testcase.assertIsNotNone(canon)
    cand = parser_candidate(canon)
    ok, out = resolver.resolve(cand, canon, _entity_map(),
                               origin="parser")
    testcase.assertTrue(ok, out)
    feat, capped = out
    res = ctx_accept(feat, canon["content_hash"])
    testcase.assertEqual(res["stats"]["accepted"], 1, res["stats"])
    return canon, feat, capped


def _entity_map():
    with open(MAP_PATH, encoding="utf-8") as fh:
        return json.load(fh)


class TestSourceSeam(unittest.TestCase):
    def test_chain_edgar(self):
        seam, _t = make_seam()
        canon, feat, capped = full_chain(self, seam, "edgar_8k",
                                         ["AAPL"])
        # Authoritative acceptance: published, high confidence — but
        # evidence stays inference: the seam assigns no directional
        # effect (promotion gate owns that), and source evidence
        # additionally requires a real effect. No invention here.
        self.assertEqual(canon["published_ns"], 1790256600 * 1000000000)
        self.assertFalse(capped)
        self.assertEqual(feat["evidence"], "inference")
        self.assertEqual(feat["confidence_bucket"], "high")
        self.assertFalse(ctx_read.trigger_eligible(
            {"evidence": feat["evidence"]}))

    def test_chain_fred(self):
        seam, _t = make_seam()
        canon, feat, capped = full_chain(self, seam, "fred_macro",
                                         ["SPY"])
        self.assertIsNone(canon["published_ns"])  # day granularity
        self.assertTrue(capped)
        self.assertEqual(feat["evidence"], "inference")

    def test_chain_treasury(self):
        seam, _t = make_seam()
        canon, feat, capped = full_chain(self, seam,
                                         "treasury_auctions", ["SPY"])
        self.assertIsNone(canon["published_ns"])
        self.assertTrue(capped)
        self.assertEqual(feat["evidence"], "inference")

    def test_chain_bls(self):
        seam, _t = make_seam()
        canon, feat, capped = full_chain(self, seam, "bls_empsit",
                                         ["SPY"])
        self.assertIsNone(canon["published_ns"])
        self.assertTrue(capped)

    def test_chain_bea(self):
        seam, _t = make_seam()
        canon, feat, capped = full_chain(self, seam, "bea_nipa_gdp",
                                         ["SPY"])
        self.assertIsNone(canon["published_ns"])
        self.assertTrue(capped)
        self.assertEqual(feat["ttl_s"], 64800)

    def test_estimated_stays_context_capped(self):
        seam, _t = make_seam()
        recs, _st = seam.harvest(["SPY"], 3)
        rec = [r for r in recs
               if r["source_id"] == "treasury_auctions"][0]
        self.assertTrue(rec["observed_at_estimated"])
        canon = to_canonical(rec, ING_NS)
        cand = parser_candidate(canon)
        ok, out = resolver.resolve(cand, canon, _entity_map(),
                                   origin="parser")
        self.assertTrue(ok)
        feat, capped = out
        self.assertTrue(capped)
        self.assertEqual(feat["evidence"], "inference")
        self.assertFalse(ctx_read.trigger_eligible(
            {"evidence": feat["evidence"]}))

    def test_malformed_unknown_rejected(self):
        self.assertIsNone(to_canonical(None, ING_NS))
        self.assertIsNone(to_canonical({"source_id": "nope",
                                        "kind": "macro_release",
                                        "symbols": ["SPY"],
                                        "observed_at_ns": 1}, ING_NS))
        self.assertIsNone(to_canonical(
            {"source_id": "bea_nipa_gdp", "kind": "filing_event",
             "symbols": ["SPY"], "observed_at_ns": 1}, ING_NS))
        canon = {"source_id": "bea_nipa_gdp", "kind": "macro_release",
                 "content_hash": "a" * 64, "published_ns": None,
                 "ingested_ns": ING_NS, "symbols": ["SPY"],
                 "value": {"type": "count", "v": 1}, "effect": None,
                 "parser_confidence": "high", "corroborated": False}
        ok, why = resolver.resolve(
            parser_candidate(canon), canon, _entity_map(),
            origin="parser")
        self.assertTrue(ok)
        bad = dict(canon, source_id="nope_src")
        ok2, why2 = resolver.resolve(
            parser_candidate(bad), bad, _entity_map(), origin="parser")
        self.assertFalse(ok2)
        self.assertEqual(why2, "kind-no-emitter")

    def test_outage_is_absence(self):
        routes = {"CIK0000320193": TimeoutError("d"),
                  "fred/series/observations": TimeoutError("d"),
                  "auctions_query": TimeoutError("d"),
                  "empsit.rss": TimeoutError("d"),
                  "apps.bea.gov": TimeoutError("d")}
        with tempfile.TemporaryDirectory() as hbdir:
            seam, _t = make_seam(routes=routes, heartbeat_dir=hbdir)
            recs, stamps = seam.harvest(["AAPL", "SPY"], 3)
            self.assertEqual(recs, [])
            for sid in source_seam.SOURCES:
                self.assertFalse(stamps[sid]["ok"], sid)
            self.assertEqual(seam.store.canonical_for({"canonical_hash":
                                                       "a" * 64}), None)
            for sid in source_seam.SOURCES:
                with open(os.path.join(hbdir, sid + ".json"),
                          encoding="utf-8") as fh:
                    hb = json.load(fh)
                self.assertFalse(hb["ok"])
                self.assertTrue(hb["stale"] or hb["error"])

    def test_singleton_no_double_poll(self):
        clock = FakeClock()
        seam, transports = make_seam(clock=clock)
        r1, s1 = seam.harvest(["AAPL"], 3)
        self.assertTrue(all(s1[s]["ok"] for s in s1))
        self.assertTrue(len(r1) > 0)
        polls1 = [src.adapter.polls for src in seam.sources]
        r2, s2 = seam.harvest(["AAPL"], 4)
        # Same owned instances serve both cycles: each adapter polls
        # exactly once more (no duplicate seam, no rebuild), second
        # cycle stays healthy on duplicate-only content.
        self.assertTrue(all(s2[s]["ok"] for s in s2))
        polls2 = [src.adapter.polls for src in seam.sources]
        self.assertEqual(polls2, [p + 1 for p in polls1])

    def test_missing_keys_fail_closed(self):
        routes = {"auctions_query": (200, {}, auctions_body()),
                  "empsit.rss": (200, {}, rss_body())}
        seam = source_seam.build_seam(
            env={}, clock=FakeClock().now,
            transports={"treasury": FakeTransport(routes),
                        "bls": FakeTransport(routes)},
            contact="", fred_key="", bea_id="")
        for src in seam.sources:
            if src.adapter is not None:
                src.adapter.sleep = lambda d: None
        recs, stamps = seam.harvest(["AAPL", "SPY"], 3)
        for sid in ("edgar_8k", "fred_macro", "bea_nipa_gdp"):
            self.assertIn(sid, stamps)
            self.assertFalse(stamps[sid]["ok"], sid)
        self.assertTrue(stamps["treasury_auctions"]["ok"])
        self.assertTrue(stamps["bls_empsit"]["ok"])

    def test_edgar_skipped_forex_only(self):
        seam, _t = make_seam()
        recs, stamps = seam.harvest(["EURUSD"], 5)
        self.assertNotIn("edgar_8k", stamps)
        self.assertIn("treasury_auctions", stamps)


if __name__ == "__main__":
    unittest.main()
