"""Phase 2.5 plane tests: R15 caps, cadence gating, graph resume,
attribution. Run under the plane venv (langgraph) — or system python
for the stdlib-only parts (r15/cadence/attribution are stdlib-only)."""
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from plane import attribution, cadence, r15
from plane.cadence import CadenceState
from plane import emit as emit_mod
from plane import workers


class R15Test(unittest.TestCase):
    def test_looping_tool_caught(self):
        b = r15.CycleBudget("AAPL", now=1000.0)
        with self.assertRaises(r15.AbortCycle):
            for _ in range(200):
                b.charge_tool()
        self.assertLessEqual(b.tools, r15.TOOL_CALLS + 1)

    def test_llm_cap(self):
        b = r15.CycleBudget("AAPL", now=0.0)
        with self.assertRaises(r15.AbortCycle):
            for _ in range(41):
                b.charge_llm(tokens=100)
        snap = None
        try:
            for _ in range(41):
                b.charge_llm(tokens=100)
        except r15.AbortCycle as e:
            snap = e.snapshot
        self.assertEqual(snap["symbol"], "AAPL")

    def test_symbol_pause_and_degrade(self):
        h = r15.PlaneHealth(["A", "B", "C"])
        for _ in range(3):
            h.record("A", True)
        r = h.record("A", True)
        self.assertIn("A", r["paused"])
        h2 = r15.PlaneHealth(["A", "B", "C"])
        h2.record("A", True)
        r2 = h2.record("B", True)
        self.assertTrue(r2["degraded"])
        r3 = h2.record("A", False)
        self.assertNotIn("A", r3["paused"])


class CadenceTest(unittest.TestCase):
    def test_trigger_immediate_and_ttl(self):
        c = cadence.CadenceState()
        self.assertTrue(c.should_refresh("AAPL", 0, ()))
        c.mark_run(0, ["AAPL"])
        self.assertFalse(c.should_refresh("AAPL", 1, ()))
        self.assertTrue(c.should_refresh("AAPL", 0, ("AAPL",)))
        # 30-min TTL at 5-min cadence = 6 epochs
        self.assertFalse(c.should_refresh("AAPL", 5, ()))
        self.assertTrue(c.should_refresh("AAPL", 6, ()))

    def test_throttle_doubles(self):
        c = cadence.CadenceState(throttled=True)
        c.mark_run(0, ["AAPL"])
        # throttled: 60-min TTL at 10-min cadence = 6 epochs
        self.assertFalse(c.should_refresh("AAPL", 5, ()))
        self.assertTrue(c.should_refresh("AAPL", 6, ()))

    def test_rate_within_estimate(self):
        c = cadence.CadenceState()
        for _ in range(6):  # 6 cycles, quiet: 0 LLM calls
            c.record_cycle(0)
        self.assertTrue(c.within_estimate())
        c2 = cadence.CadenceState()
        for _ in range(6):
            c2.record_cycle(20)  # 20/cycle = 240/h >> 40 bound
        self.assertFalse(c2.within_estimate())


class AttributionTest(unittest.TestCase):
    def test_day_summary(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(log, 1, "hypothesize", "m1", 2, 500, 0.01)
        attribution.append_span(log, 1, "critique", "m1", 2, 700, 0.014)
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 4)
        self.assertEqual(s["tokens"], 1200)
        self.assertAlmostEqual(s["dollars"], 0.024)
        self.assertAlmostEqual(s["spend_30d"], 0.72)
        self.assertEqual(s["by_node"], {"hypothesize": 2, "critique": 2})


class WorkerScanTest(unittest.TestCase):
    def test_allowlist(self):
        ok, _ = workers.scan_imports("import json\nimport pandas as pd\n")
        self.assertTrue(ok)
        ok, bad = workers.scan_imports("import json\nimport subprocess\n")
        self.assertFalse(ok)
        self.assertEqual(bad, "subprocess")

    def test_no_key_blocks(self):
        w = workers.make_extract_worker(None)
        with self.assertRaises(workers.ConfigBlocked):
            w({}, r15.CycleBudget("X", now=0.0))


try:
    from plane import graph as graph_mod
    _HAS_LG = graph_mod._LANGGRAPH
except ImportError:
    _HAS_LG = False


@unittest.skipUnless(_HAS_LG, "langgraph not installed")
class GraphResumeTest(unittest.TestCase):
    def _app(self, d, fail_at=None):
        calls = {"emit": 0}

        def harvest(watchlist, epoch):
            return ([{"kind": "filing_event", "symbols": ["AAPL"],
                      "value": {"type": "enum", "v": "x"}}], {})

        def resolve_emit(state):
            calls["emit"] += 1
            feats = [{"schema_version": "f2", "kind": "filing_event",
                      "symbols": ["AAPL"],
                      "value": {"type": "enum", "v": "x"},
                      "effect": "unknown", "evidence": "inference",
                      "confidence_bucket": "low", "source_id": "edgar_8k",
                      "canonical_hash": "a" * 64,
                      "observed_at_ns": 1, "ingested_at_ns": 1,
                      "ttl_s": 60, "feature_id": "t1",
                      "canonical_hashes": ["a" * 64]}]
            wm = {"entity_map_version": "v", "entity_map_sha256": "s",
                  "sources": {}}
            bid, _ = emit_mod.emit_bundle(os.path.join(d, "out"),
                                          state["epoch"], feats, wm)
            return {"bundle_id": bid}

        deps = {
            "harvest": harvest,
            "extract_workers": workers.stub_advisory,
            "fuse": lambda cands: cands,
            "hypothesize": lambda sym, st: "thesis-%s" % sym,
            "critique": lambda sym, text, st: {"text": "c",
                                               "disagreement": False},
            "resolve_emit": resolve_emit,
            "budgets": {None: r15.CycleBudget("t", now=0.0)},
            "cadence_state": CadenceState(),
            "checkpointer_conn": sqlite3.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
        }
        if fail_at == "critique":
            def boom(sym, text, st):
                raise RuntimeError("killed mid-critique")
            deps["critique"] = boom
        app = graph_mod.build_graph(deps)
        return app, calls

    def test_full_cycle_and_idempotent_reemit(self):
        d = tempfile.mkdtemp()
        app, calls = self._app(d)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "t1")
        self.assertIn("bundle_id", out)
        self.assertEqual(calls["emit"], 1)
        # Same thread re-invoke converges (no duplicate bundle rows).
        out2 = graph_mod.run_cycle(app, ["AAPL"], 1, "t1")
        self.assertEqual(out["bundle_id"], out2["bundle_id"])

    def test_crash_resume_no_dupes(self):
        d = tempfile.mkdtemp()
        app, calls = self._app(d, fail_at="critique")
        with self.assertRaises(RuntimeError):
            graph_mod.run_cycle(app, ["AAPL"], 2, "t2")
        # Rebuild (new process) on the same checkpoint file and resume.
        app2, calls2 = self._app(d)
        out = graph_mod.run_cycle(app2, ["AAPL"], 2, "t2")
        self.assertIn("bundle_id", out)
        man = os.path.join(d, "out", "manifest.jsonl")
        rows = open(man).read().strip().splitlines()
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
