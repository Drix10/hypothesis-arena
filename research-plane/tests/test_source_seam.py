"""Production source->graph seam tests: harvest -> frozen collector
authority -> resolver -> publisher leg -> frozen ctx_read, with fake
transports, stepped clocks, and the REAL lineage DB harvest writes
(never hand-seeded rows).

The one true end-to-end (production runner -> run_cycle -> seam ->
resolve_emit -> bundle -> ctx_read) lives in test_seam_graph.py
(plane job); this file proves every seam leg deterministically in
the stdlib evidence job.
"""
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

from collector import classify, ctx_read
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
    """Stepped mono (pacing waits advance it); wall time frozen.

    Splitting the two is deliberate: adapter pacing runs on mono,
    while poll/record timestamps read the frozen wall clock — so a
    repeat poll provably reuses the same instant (history test)."""

    def __init__(self, t=NOW):
        self.t = t
        self.m = t
        self.sleeps = []

    def now(self):
        return self.t

    def mono(self):
        return self.m

    def sleep(self, d):
        self.sleeps.append(d)
        self.m += d


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


def make_transports(routes=None):
    routes = routes or routes_all()
    return {k: FakeTransport(routes)
            for k in ("edgar", "fred", "treasury", "bls", "bea")}


def make_seam(clock=None, routes=None, heartbeat_dir=None,
              lineage_db=None):
    clock = clock or FakeClock()
    if lineage_db is None:
        lineage_db = os.path.join(tempfile.mkdtemp(), "lineage.db")
    seam = source_seam.build_seam(
        env={}, clock=clock.now, sleeper=clock.sleep, mono=clock.mono,
        transports=make_transports(routes),
        contact="seam-test@example.invalid", fred_key="K-TEST",
        bea_id="B-TEST", heartbeat_dir=heartbeat_dir,
        lineage_db_path=lineage_db)
    return seam, lineage_db


def parser_candidate(canon):
    c = {"kind": canon["kind"], "value": dict(canon["value"]),
         "symbols": list(canon["symbols"]), "effect": canon["effect"],
         "canonical_hash": canon["content_hash"], "origin": "parser"}
    if canon.get("entity_ref") is not None:
        c["entity_ref"] = dict(canon["entity_ref"])
    if canon.get("provenance_url"):
        c["provenance_url"] = canon["provenance_url"]
    return c


def _entity_map():
    with open(MAP_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def ctx_accept(feats, hist, lineage_db):
    with open(MAP_PATH, "rb") as fh:
        map_sha = hashlib.sha256(fh.read()).hexdigest()
    srcs = {f["source_id"] for f in feats} | set(hist or {})
    wm = {"entity_map_version": "entity-v1",
          "entity_map_sha256": map_sha,
          "sources": {s: {"last_observation_at": int(NOW) - 300,
                           "cursor": "seam-test"} for s in srcs}}
    bundle = schema.build_bundle(3, "seam", feats, wm, hist or None)
    tmp = tempfile.mkdtemp()
    bpath = os.path.join(tmp, "b.json")
    with open(bpath, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(bundle))
    return ctx_read.read_bundle(bpath, lineage_db, MAP_PATH, now_ts=NOW)


def resolve_all(testcase, seam, recs):
    feats = []
    for r in recs:
        h = seam.store.note(r, ING_NS)
        testcase.assertIsNotNone(h)
        canon = seam.store.canonical_for({"canonical_hash": h})
        cand = parser_candidate(canon)
        ok, out = resolver.resolve(cand, canon, _entity_map(),
                                   origin="parser")
        testcase.assertTrue(ok, out)
        feats.append(out[0])
    return feats


class TestSourceSeam(unittest.TestCase):
    def test_chain_edgar(self):
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["AAPL"], 3)
        mine = [r for r in recs if r["source_id"] == "edgar_8k"]
        self.assertTrue(stamps["edgar_8k"]["ok"], stamps)
        self.assertTrue(len(mine) >= 1)
        self.assertIn("edgar_8k", hist)
        feats = resolve_all(self, seam, mine)
        res = ctx_accept(feats, hist, seam.store.db_path)
        self.assertEqual(res["stats"]["accepted"], 1, res["stats"])
        canon = seam.store.canonical_for(
            {"canonical_hash": feats[0]["canonical_hash"]})
        self.assertEqual(canon["published_ns"], 1790256600 * 1000000000)
        self.assertEqual(feats[0]["evidence"], "inference")
        self.assertEqual(feats[0]["confidence_bucket"], "high")
        self.assertFalse(ctx_read.trigger_eligible(
            {"evidence": feats[0]["evidence"]}))

    def test_chain_fred(self):
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["SPY"], 3)
        mine = [r for r in recs if r["source_id"] == "fred_macro"]
        self.assertTrue(stamps["fred_macro"]["ok"], stamps)
        self.assertTrue(len(mine) >= 1)
        feats = resolve_all(self, seam, mine[:1])
        res = ctx_accept(feats, hist, seam.store.db_path)
        self.assertEqual(res["stats"]["accepted"], 1, res["stats"])
        canon = seam.store.canonical_for(
            {"canonical_hash": feats[0]["canonical_hash"]})
        self.assertIsNone(canon["published_ns"])

    def test_chain_treasury(self):
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["SPY"], 3)
        mine = [r for r in recs if r["source_id"] == "treasury_auctions"]
        self.assertTrue(stamps["treasury_auctions"]["ok"], stamps)
        feats = resolve_all(self, seam, mine)
        res = ctx_accept(feats, hist, seam.store.db_path)
        self.assertEqual(res["stats"]["accepted"], 1, res["stats"])

    def test_chain_bls(self):
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["SPY"], 3)
        mine = [r for r in recs if r["source_id"] == "bls_empsit"]
        self.assertTrue(stamps["bls_empsit"]["ok"], stamps)
        feats = resolve_all(self, seam, mine)
        res = ctx_accept(feats, hist, seam.store.db_path)
        self.assertEqual(res["stats"]["accepted"], 1, res["stats"])

    def test_chain_bea(self):
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["SPY"], 3)
        mine = [r for r in recs if r["source_id"] == "bea_nipa_gdp"]
        self.assertTrue(stamps["bea_nipa_gdp"]["ok"], stamps)
        feats = resolve_all(self, seam, mine)
        res = ctx_accept(feats, hist, seam.store.db_path)
        self.assertEqual(res["stats"]["accepted"], 1, res["stats"])
        self.assertEqual(feats[0]["ttl_s"], 64800)

    def test_hash_is_authority_hash(self):
        # The emitted canonical_hash is EXACTLY the frozen authority's
        # stored hash for that row (same table ctx_read checks) — not
        # a seam-local digest of adapter JSON.
        seam, _db = make_seam()
        recs, _st, _h = seam.harvest(["SPY"], 3)
        rec = [r for r in recs
               if r["source_id"] == "treasury_auctions"][0]
        h = seam.store.note(rec, ING_NS)
        con = sqlite3.connect(seam.store.db_path)
        try:
            rows = con.execute(
                "SELECT source_id, content_hash, raw_json, verdict,"
                " parser_version FROM records").fetchall()
        finally:
            con.close()
        match = [r for r in rows if r[1] == h]
        self.assertEqual(len(match), 1)
        self.assertEqual(match[0][1],
                         classify.content_hash(json.loads(match[0][2])))

    def test_publisher_leg_unit(self):
        # Publisher-leg unit (NOT the full chain): fused candidates
        # through the real publish.resolve_emit into frozen ctx_read.
        # The one true end-to-end lives in test_seam_graph.py.
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["AAPL", "SPY"], 3)
        treas = [r for r in recs
                 if r["source_id"] == "treasury_auctions"][:1]
        self.assertEqual(len(treas), 1)
        h = seam.store.note(treas[0], ING_NS)
        canon = seam.store.canonical_for({"canonical_hash": h})
        fused = [parser_candidate(canon)]
        tmp = tempfile.mkdtemp()

        def watermarks(state):
            out = {}
            for c in fused:
                hit = seam.store.canonical_for(c)
                if hit is not None:
                    out[hit["source_id"]] = {
                        "last_observation_at": int(NOW) - 300,
                        "cursor": "seam-test"}
            for sid in (hist or {}):
                out.setdefault(sid, {
                    "last_observation_at": int(NOW) - 300,
                    "cursor": "seam-test"})
            return out

        out = publish.resolve_emit(
            {"outdir": tmp, "map_path": MAP_PATH,
             "canonical_for": seam.store.canonical_for,
             "source_watermarks": watermarks},
            {"epoch": 3, "fused": fused, "history": hist})
        self.assertFalse(out.get("aborted"), out)
        self.assertIsNotNone(out.get("emitted"), out)
        res = ctx_read.read_bundle(out["bundle_path"],
                                   seam.store.db_path, MAP_PATH,
                                   now_ts=NOW)
        self.assertEqual(res["stats"]["accepted"], 1, res["stats"])

    def test_estimated_stays_context_capped(self):
        seam, _db = make_seam()
        recs, _st, _h = seam.harvest(["SPY"], 3)
        rec = [r for r in recs
               if r["source_id"] == "treasury_auctions"][0]
        self.assertTrue(rec["observed_at_estimated"])
        h = seam.store.note(rec, ING_NS)
        self.assertIsNotNone(h)
        canon = seam.store.canonical_for({"canonical_hash": h})
        cand = parser_candidate(canon)
        ok, out = resolver.resolve(cand, canon, _entity_map(),
                                   origin="parser")
        self.assertTrue(ok)
        feat, capped = out
        self.assertTrue(capped)
        self.assertEqual(feat["evidence"], "inference")
        self.assertFalse(ctx_read.trigger_eligible(
            {"evidence": feat["evidence"]}))

    def test_estimated_flag_strict_bool(self):
        seam, _db = make_seam()
        recs, _st, _h = seam.harvest(["SPY"], 3)
        rec = [r for r in recs
               if r["source_id"] == "treasury_auctions"][0]
        base = dict(rec)
        del base["observed_at_estimated"]  # missing: conservative
        self.assertIsNotNone(to_canonical(base, ING_NS))
        for bad in ("false", "true", 0, 1, None, 0.0, []):
            mutated = dict(rec, observed_at_estimated=bad)
            self.assertIsNone(to_canonical(mutated, ING_NS), repr(bad))
        # note() inherits the same strictness (fail-closed persist).
        h = seam.store.note(dict(rec, observed_at_estimated="false"),
                            ING_NS)
        self.assertIsNone(h)

    def test_malformed_unknown_rejected(self):
        self.assertIsNone(to_canonical(None, ING_NS))
        self.assertIsNone(to_canonical({"source_id": "nope",
                                        "kind": "macro_release",
                                        "symbols": ["SPY"],
                                        "observed_at_ns": 1}, ING_NS))
        self.assertIsNone(to_canonical(
            {"source_id": "bea_nipa_gdp", "kind": "filing_event",
             "symbols": ["SPY"], "observed_at_ns": 1,
             "observed_at_estimated": True}, ING_NS))
        canon = {"source_id": "bea_nipa_gdp", "kind": "macro_release",
                 "content_hash": "a" * 64, "published_ns": None,
                 "ingested_ns": ING_NS, "symbols": ["SPY"],
                 "value": {"type": "count", "v": 1}, "effect": None,
                 "parser_confidence": "high", "corroborated": False}
        ok, _o = resolver.resolve(
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
            seam, _db = make_seam(routes=routes, heartbeat_dir=hbdir)
            recs, stamps, hist = seam.harvest(["AAPL", "SPY"], 3)
            self.assertEqual(recs, [])
            self.assertEqual(hist, {})
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
        seam, _db = make_seam(clock=clock)
        before = [id(s.adapter) for s in seam.sources]
        r1, s1, _h1 = seam.harvest(["AAPL"], 3)
        self.assertTrue(all(s1[s]["ok"] for s in s1))
        self.assertTrue(len(r1) > 0)
        polls1 = [s.adapter.polls for s in seam.sources]
        r2, s2, _h2 = seam.harvest(["AAPL"], 4)
        self.assertEqual([id(s.adapter) for s in seam.sources], before)
        self.assertTrue(all(s2[s]["ok"] for s in s2))
        polls2 = [s.adapter.polls for s in seam.sources]
        self.assertEqual(polls2, [p + 1 for p in polls1])

    def test_pacing_is_real(self):
        # Stepped mono advances ONLY via the wired sleeper: if the
        # seam passed a no-op sleeper (or wall-clock pacing), the
        # second harvest would never wait. It must.
        clock = FakeClock()
        seam, _db = make_seam(clock=clock)
        for src in seam.sources:
            self.assertEqual(src.adapter.mono, clock.mono)
        seam.harvest(["AAPL"], 3)
        clock.sleeps.clear()
        seam.harvest(["AAPL"], 4)
        self.assertTrue(clock.sleeps, "no pacing wait on 2nd harvest")
        self.assertGreaterEqual(sum(clock.sleeps), 1.0)

    def test_missing_keys_fail_closed(self):
        routes = {"auctions_query": (200, {}, auctions_body()),
                  "empsit.rss": (200, {}, rss_body())}
        seam = source_seam.build_seam(
            env={}, clock=FakeClock().now, sleeper=lambda d: None,
            mono=FakeClock().mono,
            transports={"treasury": FakeTransport(routes),
                        "bls": FakeTransport(routes)},
            contact="", fred_key="", bea_id="",
            lineage_db_path=os.path.join(tempfile.mkdtemp(), "l.db"))
        recs, stamps, hist = seam.harvest(["AAPL", "SPY"], 3)
        for sid in ("edgar_8k", "fred_macro", "bea_nipa_gdp"):
            self.assertIn(sid, stamps)
            self.assertFalse(stamps[sid]["ok"], sid)
        self.assertTrue(stamps["treasury_auctions"]["ok"])
        self.assertTrue(stamps["bls_empsit"]["ok"])

    def test_edgar_skipped_forex_only(self):
        seam, _db = make_seam()
        recs, stamps, hist = seam.harvest(["EURUSD"], 5)
        self.assertNotIn("edgar_8k", stamps)
        self.assertIn("treasury_auctions", stamps)

    def test_heartbeat_failure_visible(self):
        with tempfile.TemporaryDirectory() as tmp:
            block = os.path.join(tmp, "is-a-file")
            with open(block, "w") as fh:
                fh.write("x")
            seam, _db = make_seam(heartbeat_dir=block)
            recs, stamps, hist = seam.harvest(["AAPL"], 3)
            self.assertTrue(len(recs) > 0)
            errs = [s for s in stamps.values()
                    if "heartbeat_error" in s]
            self.assertEqual(len(errs), len(stamps))
            # Poll health still describes the poll, not the disk.
            self.assertTrue(all(s["ok"] for s in stamps.values()))

    def test_lineage_failure_fails_closed(self):
        # A lineage DB that cannot be written (a directory): the
        # record must NOT become publishable, and the drop must be
        # visible per source.
        with tempfile.TemporaryDirectory() as tmp:
            seam, _db = make_seam(lineage_db=os.path.join(tmp, "sub"))
            os.makedirs(os.path.join(tmp, "sub"))
            recs, stamps, hist = seam.harvest(["SPY"], 3)
            self.assertEqual(recs, [])
            self.assertEqual(hist, {})
            dropped = [s for s in stamps.values()
                       if s.get("lineage_dropped", 0) > 0]
            self.assertTrue(len(dropped) > 0)
            self.assertGreater(seam.store.lineage_errors, 0)
            # Nothing in the store: no downstream publication possible.
            self.assertEqual(seam.store._by_hash, {})

    def test_history_never_fabricates(self):
        # Fixed wall clock, two identical polls: the second adds NO
        # new dated observation (same instant is not new coverage),
        # the tail keeps a single honest entry, sources stay healthy.
        # (Pacing still waits on the stepped mono clock.)
        clock = FakeClock()
        seam, _db = make_seam(clock=clock)
        _r1, s1, h1 = seam.harvest(["SPY"], 3)
        self.assertTrue(all(s1[s]["ok"] for s in s1))
        before = {k: list(v) for k, v in h1.items()}
        self.assertTrue(before)
        _r2, s2, h2 = seam.harvest(["SPY"], 4)
        self.assertTrue(all(s2[s]["ok"] for s in s2))
        self.assertEqual(h2, before)
        for entries in h2.values():
            self.assertEqual(len(entries), 1)

    def test_parser_extract_binds_lineage(self):
        # Seam-owned parser extract: adapter rec -> candidate with
        # the AUTHORITY hash; lineage-less input yields nothing.
        seam, _db = make_seam()
        recs, _st, _h = seam.harvest(["SPY"], 3)
        rec = [r for r in recs
               if r["source_id"] == "treasury_auctions"][0]
        self.assertIn("canonical_hash", rec)

        class Budget:
            charged = 0

            def charge_tool(self):
                self.charged += 1

        got = seam.parser_extract(rec, Budget())
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["origin"], "parser")
        self.assertEqual(got[0]["canonical_hash"],
                         rec["canonical_hash"])
        self.assertEqual(got[0]["value"], {"type": "count", "v": 1})
        self.assertEqual(seam.parser_extract({"source_id": "x"},
                                             Budget()), [])
        self.assertEqual(seam.parser_extract(
            {"canonical_hash": "0" * 64}, Budget()), [])

    def test_canonical_lookup_survives_restart(self):
        # Memory wiped (new-process equivalent): the same hash still
        # resolves from the durable projection of the same authority.
        seam, _db = make_seam()
        recs, _st, _h = seam.harvest(["SPY"], 3)
        rec = [r for r in recs
               if r["source_id"] == "treasury_auctions"][0]
        h = rec["canonical_hash"]
        before = seam.store.canonical_for({"canonical_hash": h})
        self.assertIsNotNone(before)
        seam.store._by_hash.clear()
        after = seam.store.canonical_for({"canonical_hash": h})
        self.assertEqual(after, before)
        self.assertIsNone(seam.store.canonical_for(
            {"canonical_hash": "f" * 64}))

    def test_watermarks_vouch_healthy_only(self):
        routes = {"auctions_query": (200, {}, auctions_body()),
                  "empsit.rss": (200, {}, rss_body())}
        seam = source_seam.build_seam(
            env={}, clock=FakeClock().now, sleeper=lambda d: None,
            mono=FakeClock().mono,
            transports={"treasury": FakeTransport(routes),
                        "bls": FakeTransport(routes)},
            contact="", fred_key="", bea_id="",
            lineage_db_path=os.path.join(tempfile.mkdtemp(), "l.db"))
        seam.harvest(["AAPL", "SPY"], 3)
        wm = seam.watermarks(None)
        self.assertIn("treasury_auctions", wm)
        self.assertIn("bls_empsit", wm)
        self.assertNotIn("edgar_8k", wm)  # failed poll vouches nothing
        entry = wm["treasury_auctions"]
        self.assertEqual(set(entry), {"last_observation_at", "cursor"})
        self.assertEqual(entry["last_observation_at"], int(NOW))

    def test_merge_hist_honest_suffix(self):
        # Malformed/nonmonotonic persisted entries never corrupt the
        # tail: only shape-valid strictly-newer observations kept.
        seam, _db = make_seam()
        # Note: only lowercase-hex h values are valid persisted
        # observations ("g"*64 is correctly rejected).
        n = seam._merge_hist("treasury_auctions", [
            {"h": "g" * 64, "ts": 100},
            {"h": "bad", "ts": 200},
            {"h": "a" * 64, "ts": -5},
            {"h": "a" * 64, "ts": 50},
            {"h": "b" * 64, "ts": 100},
            {"nope": 1}])
        self.assertEqual(n, 2)
        dq = seam._hist["treasury_auctions"]
        self.assertEqual(list(dq), [{"h": "a" * 64, "ts": 50},
                                    {"h": "b" * 64, "ts": 100}])
        # Unknown source: nothing to merge into.
        self.assertEqual(seam._merge_hist("nope_src", []), 0)

    def test_miro_canonical_db_honored(self):
        import os as _os
        scratch = os.path.join(tempfile.mkdtemp(), "canon.db")
        seam = source_seam.build_seam(
            env={"MIRO_CANONICAL_DB": scratch,
                 "MIRO_CONTACT": "x@example.invalid",
                 "FRED_API_KEY": "k", "BEA_USER_ID": "b"},
            clock=FakeClock().now, sleeper=lambda d: None,
            mono=FakeClock().mono, transports=make_transports(),
            lineage_db_path=None)
        self.assertEqual(seam.store.db_path, scratch)
        recs, stamps, hist = seam.harvest(["SPY"], 3)
        self.assertTrue(len(recs) > 0)
        con = sqlite3.connect(scratch)
        try:
            n = con.execute("SELECT COUNT(*) FROM records").fetchone()
        finally:
            con.close()
        self.assertGreater(n[0], 0)
        # Default resolution matches the frozen collector's own rule.
        self.assertEqual(
            source_seam.default_lineage_db_path({}),
            os.path.join(source_seam._repo_root(), "data",
                         "canonical.db"))


if __name__ == "__main__":
    unittest.main()
