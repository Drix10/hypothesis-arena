"""Seam->real-graph production wiring tests: the tracked production
composition (Runner) drives a real run_cycle into the owned seam, then
the real publisher emits into frozen ctx_read — ONE true end-to-end.

Runs in the plane job (pinned venv, langgraph) — NOT the stdlib
evidence job. Run locally with the research-plane .venv python.
"""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.abspath(os.path.join(ROOT, "..")))

try:
    import test_plane as T
    import test_source_seam as SEAM_T
except ImportError:  # unittest module-style invocation
    from tests import test_plane as T
    from tests import test_source_seam as SEAM_T
from collector import ctx_read
from plane import runner

MAP_PATH = SEAM_T.MAP_PATH
NOW = SEAM_T.NOW


def parser_candidate(canon):
    c = {"kind": canon["kind"], "value": dict(canon["value"]),
         "symbols": list(canon["symbols"]), "effect": canon["effect"],
         "canonical_hash": canon["content_hash"], "origin": "parser"}
    if canon.get("entity_ref") is not None:
        c["entity_ref"] = dict(canon["entity_ref"])
    if canon.get("provenance_url"):
        c["provenance_url"] = canon["provenance_url"]
    return c


def production_runner(d, clock=None):
    """The TRACKED production composition (not a test helper): real
    Runner owning a real Seam + real graph app, stub LLM deps only."""
    clock = clock or SEAM_T.FakeClock()
    lineage_db = os.path.join(tempfile.mkdtemp(), "lineage.db")
    hbdir = tempfile.mkdtemp()
    gt = T.GraphTest()
    deps, _c, _log, _led, _gov = gt._deps(d)
    deps.pop("harvest", None)
    env = {"MIRO_CONTACT": "seam-graph-test@example.invalid",
           "FRED_API_KEY": "K-TEST", "BEA_USER_ID": "B-TEST"}
    return runner.build_production_runner(
        deps, env=env, paths={"heartbeat_dir": hbdir},
        seam_extra={"clock": clock.now, "sleeper": clock.sleep,
                    "mono": clock.mono,
                    "transports": SEAM_T.make_transports(),
                    "lineage_db_path": lineage_db}), clock


class TestSeamGraph(unittest.TestCase):
    def test_one_true_end_to_end(self):
        # production runner -> graph.run_cycle -> owned seam.harvest
        # -> canonical lineage lookup -> publish.resolve_emit ->
        # emit_bundle -> frozen ctx_read. One cycle, one proof.
        import sqlite3 as _sq
        d = tempfile.mkdtemp()
        r, _clock = production_runner(d)
        out = r.run(["AAPL", "SPY"], 3, "seame2e")
        self.assertFalse(out.get("aborted"), out.get("blocked"))
        raw = out.get("raw") or []
        self.assertTrue(len(raw) > 0)
        # Fused parser candidates straight from the owned store.
        fused = [parser_candidate(canon)
                 for _h, canon in r.seam.store.items()]
        self.assertTrue(len(fused) > 0)
        # History reached graph state from the seam (not fabricated).
        hist = out.get("history") or {}
        self.assertIn("treasury_auctions", hist)
        tmp = tempfile.mkdtemp()

        def watermarks(state):
            cov = {r.seam.store.canonical_for(c)["source_id"]
                   for c in fused}
            return {sid: {"last_observation_at": int(NOW) - 300,
                           "cursor": "seam-e2e"} for sid in cov} | \
                {sid: {"last_observation_at": int(NOW) - 300,
                        "cursor": "seam-e2e"} for sid in hist}

        from plane import publish
        res = publish.resolve_emit(
            {"outdir": tmp, "map_path": MAP_PATH,
             "canonical_for": r.seam.store.canonical_for,
             "source_watermarks": watermarks},
            {"epoch": 3, "fused": fused, "history": hist})
        self.assertFalse(res.get("aborted"), res)
        self.assertIsNotNone(res.get("emitted"), res)
        final = ctx_read.read_bundle(res["bundle_path"],
                                     r.seam.store.db_path, MAP_PATH,
                                     now_ts=NOW)
        self.assertGreater(final["stats"]["accepted"], 0,
                           final["stats"])
        # Every emitted feature resolves in the AUTHORITATIVE
        # lineage DB harvest itself wrote.
        with open(res["bundle_path"], encoding="utf-8") as fh:
            emitted = json.load(fh)["features"]
        self.assertTrue(len(emitted) > 0)
        con = _sq.connect(r.seam.store.db_path)
        try:
            for feat in emitted:
                row = con.execute(
                    "SELECT 1 FROM records WHERE content_hash=? "
                    "AND source=?",
                    (feat["canonical_hash"],
                     feat["source_id"])).fetchone()
                self.assertIsNotNone(
                    row, (feat["source_id"], feat["canonical_hash"]))
        finally:
            con.close()

    def test_runner_shares_seam_across_cycles(self):
        d = tempfile.mkdtemp()
        r, _clock = production_runner(d)
        before = [id(s.adapter) for s in r.seam.sources]
        out1 = r.run(["AAPL"], 3, "seamg2a")
        self.assertFalse(out1.get("aborted"))
        polls1 = [s.adapter.polls for s in r.seam.sources]
        self.assertTrue(all(p >= 1 for p in polls1))
        out2 = r.run(["AAPL"], 4, "seamg2b")
        self.assertFalse(out2.get("aborted"))
        # Same Runner/Seam/adapter identities across real cycles; each
        # adapter polls exactly once more (no reconstruction).
        self.assertEqual([id(s.adapter) for s in r.seam.sources],
                         before)
        polls2 = [s.adapter.polls for s in r.seam.sources]
        self.assertEqual(polls2, [p + 1 for p in polls1])

    def test_heartbeat_sink_required(self):
        d = tempfile.mkdtemp()
        gt = T.GraphTest()
        deps, _c, _log, _led, _gov = gt._deps(d)
        deps.pop("harvest", None)
        # No heartbeat sink anywhere: production composition refuses.
        with self.assertRaises(runner.ConfigError):
            runner.build_runner(deps, {})
        with self.assertRaises(runner.ConfigError):
            runner.build_production_runner(
                deps, env={}, paths={"heartbeat_dir": ""})
        # Default layout establishes a deterministic sink path.
        paths = runner.default_paths(env={})
        self.assertTrue(paths["heartbeat_dir"].endswith(
            os.path.join("data", "heartbeats")))


if __name__ == "__main__":
    unittest.main()
