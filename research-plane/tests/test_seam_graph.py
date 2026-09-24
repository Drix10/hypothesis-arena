"""Seam->real-graph production wiring tests: the tracked production
composition (Runner) drives real run_cycles into the owned seam, and
the GRAPH'S OWN emit node publishes through the seam-bound
publisher — the test never invokes publish.resolve_emit itself.

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
from collector import classify, ctx_read
from plane import runner

MAP_PATH = SEAM_T.MAP_PATH
NOW = SEAM_T.NOW
STEP_S = 5 * 3600  # 5h simulated-time steps between restarts


def production_graph_deps(d):
    """The DOCUMENTED caller side: every graph dep EXCEPT the three
    seam-owned ones (harvest/parser_extract/resolve_emit). If the
    composition ever stops binding one, the cycle fails loudly —
    there is no fake to fall back to."""
    gt = T.GraphTest()
    deps, _c, _log, _led, _gov = gt._deps(d)
    for owned in ("harvest", "parser_extract", "resolve_emit"):
        deps.pop(owned, None)
    assert not any(k in deps for k in
                   ("harvest", "parser_extract", "resolve_emit"))
    return deps


def production_runner(d, clock, lineage_db, outdir, hbdir=None,
                      extra_deps=None):
    """The TRACKED production composition (not a test helper): real
    Runner owning a real Seam + real graph app, stub LLM deps only.
    A fresh call = a new-process equivalent (fresh memory, same
    durable DB + bundle dir)."""
    deps = production_graph_deps(d)
    if extra_deps:
        deps.update(extra_deps)
    env = {"MIRO_CONTACT": "seam-graph-test@example.invalid",
           "FRED_API_KEY": "K-TEST", "BEA_USER_ID": "B-TEST"}
    return runner.build_production_runner(
        deps, env=env,
        paths={"heartbeat_dir": hbdir or tempfile.mkdtemp(),
               "outdir": outdir, "map_path": MAP_PATH},
        seam_extra={"clock": clock.now, "sleeper": clock.sleep,
                    "mono": clock.mono,
                    "transports": SEAM_T.make_transports(),
                    "lineage_db_path": lineage_db}), clock


def read_production_bundle(testcase, out, lineage_db, now_ts, outdir):
    """The graph's OWN emit output -> frozen ctx_read. No manual
    publisher invocation anywhere on this path. The cycle output
    carries the emitted bundle id; the bundle file is resolved from
    the production outdir (the same dir a fresh process recovers
    history from)."""
    testcase.assertFalse(out.get("aborted"), out.get("blocked"))
    bid = out.get("emitted")
    testcase.assertTrue(isinstance(bid, str) and bid, out)
    matches = [n for n in sorted(os.listdir(outdir))
               if n.startswith("features-") and bid in n
               and n.endswith(".json")]
    testcase.assertEqual(len(matches), 1, matches)
    bundle_path = os.path.join(outdir, matches[0])
    return (ctx_read.read_bundle(bundle_path, lineage_db, MAP_PATH,
                                 now_ts=now_ts), bundle_path)


class TestSeamGraph(unittest.TestCase):
    def test_no_test_double_in_production_path(self):
        # Sentinel: this module must never BIND a fake canonical
        # provider or publisher callback — the composition owns both,
        # and the real cycle has nothing to fall back to. AST-level
        # (a substring scan would trip on its own assertion text): no
        # dict key / keyword argument / assignment target / function
        # named canonical_for, source_watermarks, or _canon.
        import ast as _ast
        with open(os.path.abspath(__file__), encoding="utf-8") as fh:
            tree = _ast.parse(fh.read())
        bound = set()
        roots = [n for n in tree.body
                 if not (isinstance(n, (_ast.FunctionDef,
                                        _ast.AsyncFunctionDef)) and
                         n.name == "test_no_test_double_in_production_path")
                 and not (isinstance(n, _ast.ClassDef))]
        # (Methods live under TestSeamGraph: walk them except the
        # sentinel itself.)
        for node in tree.body:
            if isinstance(node, _ast.ClassDef):
                roots.extend(
                    n for n in node.body
                    if getattr(n, "name", "") !=
                    "test_no_test_double_in_production_path")
        for root in roots:
            for node in _ast.walk(root):
                if isinstance(node, _ast.Dict):
                    for k in node.keys:
                        if isinstance(k, _ast.Constant) and \
                                k.value in ("canonical_for",
                                            "source_watermarks"):
                            bound.add("key:" + k.value)
                elif isinstance(node, _ast.Name) and node.id in (
                        "canonical_for", "source_watermarks", "_canon"):
                    bound.add("name:" + node.id)
                elif isinstance(node, (_ast.FunctionDef,
                                       _ast.AsyncFunctionDef)) and \
                        node.name in ("canonical_for",
                                      "source_watermarks", "_canon"):
                    bound.add("def:" + node.name)
                elif isinstance(node, _ast.Attribute) and \
                        isinstance(node.ctx, _ast.Store) and \
                        node.attr in ("canonical_for",
                                      "source_watermarks"):
                    bound.add("store-attr:" + node.attr)
        self.assertEqual(bound, set(), bound)

    def test_seam_owned_callbacks_cannot_be_overridden(self):
        # Composition owns harvest/parser_extract/resolve_emit: any
        # caller-supplied one (e.g. a test fake) is refused loudly.
        d = tempfile.mkdtemp()
        clock = SEAM_T.FakeClock()
        base = {"lineage_db": os.path.join(tempfile.mkdtemp(), "l.db"),
                "outdir": tempfile.mkdtemp()}

        def boom(*a, **k):
            raise AssertionError("fake callback reached")

        for owned in ("harvest", "parser_extract", "resolve_emit"):
            with self.assertRaises(runner.ConfigError, msg=owned):
                production_runner(
                    d, clock, base["lineage_db"], base["outdir"],
                    extra_deps={owned: boom})

    def test_one_true_end_to_end(self):
        # build_production_runner -> Runner.run -> graph.run_cycle ->
        # seam.harvest -> graph nodes (seam parser_extract) ->
        # graph emit -> real publish.resolve_emit -> real emit_bundle
        # -> frozen ctx_read. The bundle comes from Runner.run
        # itself; this test never touches the publisher.
        d = tempfile.mkdtemp()
        clock = SEAM_T.FakeClock()
        outdir = tempfile.mkdtemp()
        r, _clock = production_runner(
            d, clock, os.path.join(tempfile.mkdtemp(), "l.db"), outdir)
        out = r.run(["AAPL", "SPY"], 3, "seame2e")
        res, bundle_path = read_production_bundle(
            self, out, r.seam.store.db_path, NOW, outdir)
        self.assertGreater(res["stats"]["accepted"], 0, res["stats"])
        hist = out.get("history") or {}
        self.assertIn("treasury_auctions", hist)
        # Authority re-verified on a GRAPH-PRODUCED feature (not a
        # manufactured publisher fixture): the emitted hash equals
        # the frozen hash of the stored authoritative row.
        with open(bundle_path, encoding="utf-8") as fh:
            feats = json.load(fh)["features"]
        self.assertTrue(len(feats) > 0)
        con = sqlite3.connect(r.seam.store.db_path)
        try:
            for feat in feats:
                row = con.execute(
                    "SELECT raw_json FROM records WHERE "
                    "content_hash=? AND source=?",
                    (feat["canonical_hash"],
                     feat["source_id"])).fetchone()
                self.assertIsNotNone(
                    row, (feat["source_id"], feat["canonical_hash"]))
                self.assertEqual(
                    feat["canonical_hash"],
                    classify.content_hash(json.loads(row[0])))
        finally:
            con.close()

    def test_runner_shares_seam_across_cycles(self):
        d = tempfile.mkdtemp()
        clock = SEAM_T.FakeClock()
        r, _clock = production_runner(
            d, clock, os.path.join(tempfile.mkdtemp(), "l.db"),
            tempfile.mkdtemp())
        before = [id(s.adapter) for s in r.seam.sources]  # noqa
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
        deps = production_graph_deps(d)
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

    def test_restart_recovers_lineage_and_history(self):
        # Three fresh Runners (new-process equivalents) over the SAME
        # lineage DB + bundle dir at +5h steps: canonical lookup
        # survives memory loss via the durable projection, history
        # tails recover from durable bundles, and the recovered tail
        # still exercises the frozen-feed predicate (span 10h >= 9h
        # cover/2 for the 1080-cover sources).
        d = tempfile.mkdtemp()
        clock = SEAM_T.FakeClock()
        lineage_db = os.path.join(tempfile.mkdtemp(), "l.db")
        outdir = tempfile.mkdtemp()
        r1, _c = production_runner(d, clock, lineage_db, outdir)
        out1 = r1.run(["AAPL", "SPY"], 3, "rs1")
        res1, _b1p = read_production_bundle(
            self, out1, lineage_db, clock.t, outdir)
        self.assertGreater(res1["stats"]["accepted"], 0, res1["stats"])
        with open(_b1p, encoding="utf-8") as fh:
            b1 = json.load(fh)
        treas_h = [f["canonical_hash"] for f in b1["features"]
                   if f["source_id"] == "treasury_auctions"][0]
        ts0 = b1["history"]["treasury_auctions"][0]["ts"]

        # New process: memory empty, same durable state.
        clock.t += STEP_S
        r2, _c = production_runner(d, clock, lineage_db, outdir)
        self.assertEqual(r2.seam.store._by_hash, {})
        canon = r2.seam.store.canonical_for(
            {"canonical_hash": treas_h})
        self.assertIsNotNone(canon)
        self.assertEqual(canon["content_hash"], treas_h)
        out2 = r2.run(["AAPL", "SPY"], 4, "rs2")
        res2, _b2p = read_production_bundle(
            self, out2, lineage_db, clock.t, outdir)
        self.assertGreater(res2["stats"]["accepted"], 0, res2["stats"])

        clock.t += STEP_S
        r3, _c = production_runner(d, clock, lineage_db, outdir)
        out3 = r3.run(["AAPL", "SPY"], 5, "rs3")
        res3, _b3p = read_production_bundle(
            self, out3, lineage_db, clock.t, outdir)
        with open(_b3p, encoding="utf-8") as fh:
            b3 = json.load(fh)
        tail = b3["history"]["treasury_auctions"]
        self.assertEqual(len(tail), 3)
        self.assertEqual([e["ts"] for e in tail],
                         [ts0, ts0 + STEP_S, ts0 + 2 * STEP_S])
        self.assertTrue(all(e["h"] == treas_h for e in tail))
        self.assertEqual(len(b3["history"]["edgar_8k"]), 3)
        # Recovered tails exercise the frozen-feed predicate: the 4
        # same-hash sources (treasury/bls/bea/DGS10-fred, span 10h >=
        # 9h cover/2) trip it; the 5 other fred series stay accepted;
        # the 10.5h-old filing outlives its 45min TTL (layered,
        # honest: ttl-expired, not frozen-feed).
        self.assertEqual(res3["stats"]["accepted"], 5, res3["stats"])
        self.assertEqual(res3["stats"]["rejected"], 5, res3["stats"])
        self.assertEqual(res3["stats"]["reasons"],
                         {"frozen-feed": 4, "ttl-expired": 1,
                          "inference-capped": 5},
                         res3["stats"])


if __name__ == "__main__":
    unittest.main()
