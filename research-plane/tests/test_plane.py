"""Phase 2.5 plane tests: R15, cadence, attribution, scanner, graph.

Graph tests run the REAL production publish path (plane/publish.py)
against scratch canonical.db + pinned map, and round-trip through the
FROZEN ctx reader. Run under the plane venv for graph tests (langgraph);
stdlib-only parts also pass on system python (graph tests skip).
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
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root: collector/

from collector import ctx_read
from plane import attribution, cadence, r15
from plane import emit as emit_mod
from plane import publish, workers

OBS_S = 1767625200  # Monday 2026-01-05 15:00 UTC (in session)
OBS_NS = OBS_S * 10 ** 9
NOW_S = OBS_S + 100
HEXA = "a" * 64
MAP = {"map_version": "entity-v1-test",
       "cik_to_ticker": {"0000320193": "AAPL"},
       "macro_release_to_symbols": {"FOMC": ["EURUSD"]}}


class R15Test(unittest.TestCase):
    def test_looping_tool_caught(self):
        b = r15.CycleBudget("AAPL", now=1000.0)
        with self.assertRaises(r15.AbortCycle):
            for _ in range(200):
                b.charge_tool()
        self.assertLessEqual(b.tools, r15.TOOL_CALLS + 1)

    def test_llm_cap_snapshot(self):
        b = r15.CycleBudget("AAPL", now=0.0)
        try:
            for _ in range(41):
                b.charge_llm(tokens=100)
            self.fail("no abort")
        except r15.AbortCycle as e:
            # depth cap (25) trips before the LLM cap (40): either way
            # the cycle aborts with an exact snapshot.
            self.assertEqual(e.snapshot["symbol"], "AAPL")
            self.assertLessEqual(e.snapshot["llm"], 41)

    def test_symbol_pause_and_degrade(self):
        h = r15.PlaneHealth(["A", "B", "C"], now_s=0.0)
        for _ in range(3):
            h.record("A", True, now_s=10.0)
        r = h.record("A", True, now_s=10.0)
        self.assertIn("A", r["paused"])
        h2 = r15.PlaneHealth(["A", "B", "C"], now_s=0.0)
        h2.record("A", True, now_s=10.0)
        r2 = h2.record("B", True, now_s=20.0)
        self.assertTrue(r2["degraded"])

    def test_degraded_recovers(self):
        h = r15.PlaneHealth(["A", "B", "C"], now_s=0.0)
        h.record("A", True, now_s=10.0)
        self.assertTrue(h.record("B", True, now_s=20.0)["degraded"])
        # Window (1h) expires with no new aborts: healthy again.
        r = h.record("C", False, now_s=5000.0)
        self.assertFalse(r["degraded"])
        self.assertEqual(r["paused"], [])

    def test_pause_clears_on_success(self):
        h = r15.PlaneHealth(["A"], now_s=0.0)
        for _ in range(3):
            h.record("A", True, now_s=5.0)
        self.assertIn("A", h.record("A", True, now_s=5.0)["paused"])
        self.assertNotIn("A", h.record("A", False, now_s=6.0)["paused"])


class CadenceTest(unittest.TestCase):
    def test_trigger_immediate_and_ttl(self):
        c = cadence.CadenceState()
        self.assertTrue(c.should_refresh("AAPL", 0, ()))
        c.mark_run(0, ["AAPL"])
        self.assertFalse(c.should_refresh("AAPL", 1, ()))
        self.assertTrue(c.should_refresh("AAPL", 0, ("AAPL",)))
        self.assertFalse(c.should_refresh("AAPL", 5, ()))
        self.assertTrue(c.should_refresh("AAPL", 6, ()))

    def test_throttle_doubles(self):
        c = cadence.CadenceState(throttled=True)
        c.mark_run(0, ["AAPL"])
        # throttled: 60-min TTL at 10-min cadence = 6 epochs
        self.assertFalse(c.should_refresh("AAPL", 5, ()))
        self.assertTrue(c.should_refresh("AAPL", 6, ()))

    def test_persisted_across_restart(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "cadence.json")
        c = cadence.CadenceState(persist_path=p)
        c.mark_run(3, ["AAPL"])
        c2 = cadence.CadenceState(persist_path=p)
        self.assertFalse(c2.should_refresh("AAPL", 4, ()))
        self.assertTrue(c2.should_refresh("AAPL", 9, ()))

    def test_rate_within_estimate(self):
        c = cadence.CadenceState()
        for _ in range(6):
            c.record_cycle(0)
        self.assertTrue(c.within_estimate())
        c2 = cadence.CadenceState()
        for _ in range(6):
            c2.record_cycle(20)
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

    def test_retry_dedupe(self):
        # Crash after attribution but before checkpoint: node reruns the
        # same logical call (same span_id) -> exactly one row.
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(log, 9, "hypothesize", "m1", 1, 100, 0.002,
                                span_id="9:hypothesize:0")
        attribution.append_span(log, 9, "hypothesize", "m1", 1, 100, 0.002,
                                span_id="9:hypothesize:0")
        rows = open(log).read().strip().splitlines()
        self.assertEqual(len(rows), 1)
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)


class WorkerScanTest(unittest.TestCase):
    def test_allowlist(self):
        ok, _ = workers.scan_imports("import json\nimport pandas as pd\n")
        self.assertTrue(ok)
        ok, bad = workers.scan_imports("import json\nimport subprocess\n")
        self.assertFalse(ok)
        self.assertEqual(bad, "subprocess")

    def test_dynamic_imports_caught(self):
        ok, bad = workers.scan_imports('x = __import__("os")\n')
        self.assertFalse(ok)
        self.assertEqual(bad, "__import__")
        # importlib itself is not allowlisted: blocked at the import.
        ok, bad = workers.scan_imports(
            'import importlib\nimportlib.import_module("socket")\n')
        self.assertFalse(ok)
        self.assertEqual(bad, "importlib")
        ok, _ = workers.scan_imports('x = __import__("json")\n')
        self.assertTrue(ok)
        # bare attribute-form dynamic load, no import statement at all.
        ok, bad = workers.scan_imports('mod.import_module("os")\n')
        self.assertFalse(ok)
        self.assertEqual(bad, "import_module")

    def test_unparseable_fails_closed(self):
        ok, _ = workers.scan_imports("def broken(:\n")
        self.assertFalse(ok)

    def test_no_config_blocks(self):
        w = workers.make_extract_worker(None)
        with self.assertRaises(workers.ConfigBlocked):
            w({}, r15.CycleBudget("X", now=0.0))
        w2 = workers.make_extract_worker({"model_id": "m"})
        with self.assertRaises(workers.ConfigBlocked):
            w2({}, r15.CycleBudget("X", now=0.0))

    def test_configured_returns_runner(self):
        w = workers.make_extract_worker({"model_id": "m"}, "img@sha256:x")
        self.assertTrue(callable(w))

    def test_candidate_mapping(self):
        out = workers._to_candidates(
            json.dumps({"kind": "filing_event", "symbols": ["AAPL"],
                        "value": {"type": "enum", "v": "x"}}),
            {"kind": "filing_event", "symbols": ["AAPL"]})
        self.assertEqual(len(out), 1)
        # The model never assigns effect: always unknown for the resolver.
        self.assertEqual(out[0]["effect"], "unknown")
        self.assertEqual(workers._to_candidates("not json", {}), [])


try:
    from plane import graph as graph_mod
    _HAS_LG = graph_mod._LANGGRAPH
except ImportError:
    _HAS_LG = False


def _fixtures(d):
    raw = json.dumps(MAP, sort_keys=True).encode()
    mapp = os.path.join(d, "entity_map.json")
    open(mapp, "wb").write(raw)
    dbp = os.path.join(d, "canonical.db")
    con = sqlite3.connect(dbp)
    con.execute("CREATE TABLE records (content_hash TEXT, source TEXT)")
    con.execute("INSERT INTO records VALUES (?, ?)", (HEXA, "edgar_8k"))
    con.commit()
    con.close()
    return mapp, dbp, hashlib.sha256(raw).hexdigest()


def _canon():
    return {"source_id": "edgar_8k", "kind": "filing_event",
            "content_hash": HEXA, "published_ns": OBS_NS,
            "ingested_ns": OBS_NS, "symbols": ["AAPL"],
            "value": {"type": "enum", "v": "8-K:item-2.02"},
            "effect": "bullish", "corroborated": True}


@unittest.skipUnless(_HAS_LG, "langgraph not installed")
class GraphTest(unittest.TestCase):
    def _app(self, d, msha, fail=None, budgets=None, prefill=0):
        import sqlite3 as _sq

        def harvest(watchlist, epoch):
            recs = [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish", "feature_id": "g1",
                     "provenance_url": "https://example.invalid/x",
                     "llm_touched": False}]
            return (recs * prefill if prefill else recs, {})

        if fail == "hypothesize-abort":
            def hypo(sym, st):
                raise r15.AbortCycle(sym, {})
        else:
            def hypo(sym, st):
                return "thesis-%s" % sym

        def crit(sym, text, st):
            if fail == "critique-block":
                raise workers.ConfigBlocked("no key")
            return {"text": "c", "disagreement": False}

        def resolve_emit(state):
            return publish.resolve_emit({
                "outdir": os.path.join(d, "out"),
                "entity_map": MAP,
                "canonical_for": lambda c: _canon(),
                "watermarks": lambda st: {
                    "entity_map_version": MAP["map_version"],
                    "entity_map_sha256": msha,
                    "sources": {"edgar_8k": {
                        "last_observation_at": OBS_S,
                        "cursor": "g"}}},
            }, state)

        deps = {
            "harvest": harvest,
            "extract_workers": workers.stub_advisory,
            "fuse": lambda cands: [
                dict(c, llm_touched=False) for c in cands],
            "hypothesize": hypo,
            "critique": crit,
            "resolve_emit": resolve_emit,
            "cadence_state": cadence.CadenceState(),
            "budgets": budgets if budgets is not None else {
                "AAPL": r15.CycleBudget("AAPL", now=0.0),
                None: r15.CycleBudget("t", now=0.0)},
            "checkpointer_conn": _sq.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
        }
        return graph_mod.build_graph(deps), None

    def test_full_cycle_publishes_via_reader(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d, msha)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "t1")
        self.assertFalse(out.get("aborted"))
        self.assertIsNotNone(out.get("emitted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertIsNotNone(res)
        # stub advisory carries effect=unknown != canonical bullish:
        # evidence is inference, capped downstream — never TRIGGER.
        self.assertEqual(res["stats"]["reasons"],
                         {"inference-capped": 1})

    def test_parser_path_earns_source(self):
        # Deterministic parser output (llm_touched=False, effect matches
        # the canonical record): evidence=source through the full path.
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)

        def parser_extract(rec, budget):
            budget.charge_tool()
            return [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish", "feature_id": "p1",
                     "provenance_url": "https://example.invalid/x",
                     "llm_touched": False}]

        import sqlite3 as _sq

        def harvest(watchlist, epoch):
            return ([{"kind": "filing_event", "symbols": ["AAPL"]}],
                    {})

        def resolve_emit(state):
            return publish.resolve_emit({
                "outdir": os.path.join(d, "out"),
                "entity_map": MAP,
                "canonical_for": lambda c: _canon(),
                "watermarks": lambda st: {
                    "entity_map_version": MAP["map_version"],
                    "entity_map_sha256": msha,
                    "sources": {"edgar_8k": {
                        "last_observation_at": OBS_S,
                        "cursor": "g"}}},
            }, state)

        deps = {
            "harvest": harvest, "extract_workers": parser_extract,
            "fuse": lambda cands: cands,
            "hypothesize": lambda sym, st: "t",
            "critique": lambda sym, text, st: {"text": "c",
                                                "disagreement": False},
            "resolve_emit": resolve_emit,
            "cadence_state": cadence.CadenceState(),
            "budgets": {"AAPL": r15.CycleBudget("AAPL", now=0.0),
                          None: r15.CycleBudget("t", now=0.0)},
            "checkpointer_conn": _sq.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
        }
        app = graph_mod.build_graph(deps)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "tp")
        self.assertFalse(out.get("aborted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_aborted_cycle_publishes_nothing(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, "x", fail="hypothesize-abort")
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "t2")
        self.assertTrue(out.get("aborted"))
        self.assertIsNone(out.get("emitted"))
        self.assertIsNone(emit_mod.latest_complete(os.path.join(d, "out")))

    def test_blocked_worker_drops_and_counts(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, "x", fail="critique-block")
        out = graph_mod.run_cycle(app, ["AAPL"], 3, "t3")
        self.assertTrue(any(b.startswith("critique:") for b in
                            out.get("blocked", [])))
        # critique default on blocked: disagreement=true, still completes.
        self.assertIn("AAPL", out.get("critique", {}))

    def test_r15_enforced_on_hypothesize(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        b = r15.CycleBudget("AAPL", now=0.0)
        b.llm = r15.LLM_CALLS  # next charge trips the cap
        app, _ = self._app(d, "x", budgets={
            "AAPL": b, None: r15.CycleBudget("t", now=0.0)})
        out = graph_mod.run_cycle(app, ["AAPL"], 4, "t4")
        self.assertTrue(out.get("aborted"))  # cap hit -> no publication
        self.assertEqual(out.get("thesis", {}).get("AAPL"), "")

    def test_checkpoint_caps(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, "x", prefill=600)
        out = graph_mod.run_cycle(app, ["AAPL"], 5, "t5")
        self.assertEqual(len(out.get("raw", [])), graph_mod.RAW_MAX)
        self.assertEqual(out.get("dropped_raw"), 600 - graph_mod.RAW_MAX)

    def test_crash_resume_no_dupes(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d, msha)
        out = graph_mod.run_cycle(app, ["AAPL"], 6, "t6")
        out2 = graph_mod.run_cycle(app, ["AAPL"], 6, "t6")
        self.assertEqual(out.get("emitted"), out2.get("emitted"))
        man = os.path.join(d, "out", "manifest.jsonl")
        rows = open(man).read().strip().splitlines()
        self.assertEqual(len(rows), 1)


if __name__ == "__main__":
    unittest.main()
