"""Phase 2.5 plane tests: R15/ledger, cadence, attribution, scanner,
workers boundary, digest, retention, emit concurrency, graph.

Graph tests run the REAL production publish path (plane/publish.py)
against scratch canonical.db + pinned map file, and round-trip through
the FROZEN ctx reader. Run under the plane venv for graph tests
(langgraph); stdlib-only parts also pass on system python (graph
tests skip).
"""
import hashlib
import json
import multiprocessing
import os
import sqlite3
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root: collector/

from collector import ctx_read
from plane import attribution, budgets, cadence, digest, emit as emit_mod
from plane import locks, r15, retention, timeout as timeout_mod
from plane import publish, workers

OBS_S = 1767625200  # Monday 2026-01-05 15:00 UTC (in session)
OBS_NS = OBS_S * 10 ** 9
NOW_S = OBS_S + 100
HEXA = "a" * 64
MAP = {"map_version": "entity-v1-test",
       "cik_to_ticker": {"0000320193": "AAPL"},
       "macro_release_to_symbols": {"FOMC": ["EURUSD"]}}
SANDBOX = {"image_digest": "repo@sha256:" + "b" * 64,
           "proxy_network": "rp-egress",
           "seccomp_profile": "/etc/rp/seccomp.json",
           "apparmor_profile": "rp-worker"}


def _emit_same(args):
    outdir, epoch, feats, wm, hist = args
    return emit_mod.emit_bundle(outdir, epoch, feats, wm, hist)


def _mark_cadence(args):
    path, epoch, symbols = args
    cadence.CadenceState(persist_path=path).mark_run(epoch, symbols)
    return True


def _append_span(args):
    log, span_id = args
    attribution.append_span(log, 1, "hypothesize", "m", cycle_id="c",
                            symbol="AAPL", prompt_tokens=10,
                            completion_tokens=5, span_id=span_id)
    return True


def _sleepy(secs):
    time.sleep(secs)
    return "woke"


class R15Test(unittest.TestCase):
    def test_looping_tool_caught(self):
        b = r15.CycleBudget("AAPL", now=1000.0)
        with self.assertRaises(r15.AbortCycle):
            for _ in range(200):
                b.charge_tool()
        self.assertLessEqual(b.tools, r15.TOOL_CALLS + 1)

    def test_check_guards_without_charging(self):
        b = r15.CycleBudget("AAPL", now=0.0)
        b.check()
        self.assertEqual(b.llm, 0)  # guard increments nothing
        b.llm = r15.LLM_CALLS
        with self.assertRaises(r15.AbortCycle):
            b.check()

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
        r = h.record("C", False, now_s=5000.0)
        self.assertFalse(r["degraded"])
        self.assertEqual(r["paused"], [])

    def test_pause_clears_on_success(self):
        h = r15.PlaneHealth(["A"], now_s=0.0)
        for _ in range(3):
            h.record("A", True, now_s=5.0)
        self.assertIn("A", h.record("A", True, now_s=5.0)["paused"])
        self.assertNotIn("A", h.record("A", False, now_s=6.0)["paused"])


class LedgerTest(unittest.TestCase):
    def test_crash_resume_reconstructs(self):
        d = tempfile.mkdtemp()
        led = budgets.BudgetLedger(os.path.join(d, "ledger.json"))
        b1 = budgets.DurableBudget(led, "cycle-9", "AAPL")
        for _ in range(20):
            b1.charge_llm(tokens=100)
        # "Crash": brand-new handle, same (cycle, symbol).
        b2 = budgets.DurableBudget(led, "cycle-9", "AAPL")
        self.assertEqual(b2.llm, 20)
        self.assertEqual(b2.tokens, 20 * 100)
        # The resumed handle keeps counting from 20, and the frozen
        # depth cap (25) trips the 26th attempt — enforcement survived
        # the crash, not just the counters.
        for _ in range(5):
            b2.charge_llm(tokens=100)
        with self.assertRaises(r15.AbortCycle):
            b2.charge_llm(tokens=100)
        # The llm-count branch itself: a ledger row already at 40
        # refuses the next reservation before executing anything.
        import json as _json
        row = {"llm": 40, "tools": 0, "tokens": 0, "depth": 0,
               "start_wall": 1000.0}
        with open(os.path.join(d, "ledger.json"), "w") as fh:
            _json.dump({"c\x00A": row}, fh)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_llm("c", "A", now_wall=1000.0)

    def test_token_reservation_enforced(self):
        d = tempfile.mkdtemp()
        led = budgets.BudgetLedger(os.path.join(d, "ledger.json"))
        # One reservation consumes the derived per-call chunk (6250).
        lease = led.reserve_llm("c", "A", now_wall=1000.0)
        self.assertEqual(lease["reserved"], budgets.TOKENS_PER_CALL)
        led.settle_llm("c", "A", lease, 120)  # reconcile down to actual
        self.assertEqual(led.snapshot("c", "A")["tokens"], 120)
        # Pre-call reservation that would breach the cap aborts first.
        led2 = budgets.BudgetLedger(os.path.join(d, "l2.json"))
        with self.assertRaises(r15.AbortCycle):
            led2.reserve_llm("c", "A", reserve_tokens=r15.TOKENS + 1,
                             now_wall=1000.0)

    def test_wall_clock_binds_resume(self):
        d = tempfile.mkdtemp()
        led = budgets.BudgetLedger(os.path.join(d, "ledger.json"))
        led.reserve_llm("c", "A", now_wall=1000.0)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_llm("c", "A", now_wall=1000.0 + r15.WALL_S + 1)


class TimeoutTest(unittest.TestCase):
    def test_thread_timeout_accounts_promptly(self):
        t0 = time.monotonic()
        with self.assertRaises(timeout_mod.CallTimeout):
            timeout_mod.run_with_timeout(time.sleep, 0.2, 30.0)
        self.assertLess(time.monotonic() - t0, 10.0)

    def test_process_timeout_kills(self):
        t0 = time.monotonic()
        with self.assertRaises(timeout_mod.CallTimeout):
            timeout_mod.run_in_process(_sleepy, 2.0, 60.0)
        self.assertLess(time.monotonic() - t0, 30.0)
        self.assertEqual(timeout_mod.run_in_process(_sleepy, 10.0, 0.01),
                         "woke")


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

    def test_oversized_state_starts_empty(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "cadence.json")
        with open(p, "w") as fh:
            fh.write(json.dumps({"S%04d" % i: i for i in range(500)}))
        c = cadence.CadenceState(persist_path=p)
        self.assertEqual(c.last_thesis_epoch, {})
        p2 = os.path.join(d, "huge.json")
        with open(p2, "w") as fh:
            fh.write("{" + "\"k\":0," * 20000 + "\"z\":0}")
        c2 = cadence.CadenceState(persist_path=p2)
        self.assertEqual(c2.last_thesis_epoch, {})

    def test_concurrent_writes_converge(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "cadence.json")
        ctx = multiprocessing.get_context("spawn")
        with ctx.Pool(4) as pool:
            pool.map(_mark_cadence,
                     [(p, 7, ["S%d" % i]) for i in range(8)])
        data = locks.load_json_bounded(p)
        self.assertEqual(len(data), 8)  # all writers serialized, none lost

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
    def test_day_summary_splits_tokens(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(log, 1, "hypothesize", "m1", cycle_id="c",
                                symbol="AAPL", prompt_tokens=200,
                                completion_tokens=500, span_id="s1")
        attribution.append_span(log, 1, "critique", "m1", cycle_id="c",
                                symbol="AAPL", prompt_tokens=700,
                                completion_tokens=0, span_id="s2")
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 2)
        self.assertEqual(s["tokens"], 1400)
        self.assertEqual(s["prompt_tokens"], 900)
        self.assertEqual(s["completion_tokens"], 500)
        self.assertEqual(s["by_node"], {"hypothesize": 1, "critique": 1})

    def test_retry_dedupe(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        for _ in range(2):
            attribution.append_span(log, 9, "hypothesize", "m1",
                                    cycle_id="c", symbol="A", span_id="r1")
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)
        # Mirror repair keeps the tail consistent with the ledger.
        attribution.sync_mirror(log)
        rows = open(log).read().strip().splitlines()
        self.assertEqual(len(rows), 1)

    def test_concurrent_dedupe(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        ctx = multiprocessing.get_context("spawn")
        with ctx.Pool(4) as pool:
            pool.map(_append_span, [(log, "same-span")] * 8)
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)  # UNIQUE(span_id) held


class FakeUsage:
    def __init__(self, i, o):
        self.input_tokens = i
        self.output_tokens = o


class FakeMsg:
    def __init__(self, i=100, o=50):
        self.token_usage = FakeUsage(i, o)

    def __str__(self):
        return json.dumps({"kind": "filing_event", "symbols": ["AAPL"],
                           "value": {"type": "enum", "v": "x"}})


class FakeModel:
    """Stand-in multi-step model: generate() is the real boundary the
    production CodeAgent calls once per ReAct step."""

    def __init__(self, usage=(100, 50), hang=False):
        self.calls = []
        self.usage = usage
        self.hang = hang

    def generate(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        if self.hang:
            time.sleep(60)
        return FakeMsg(*self.usage)


class WorkerBoundaryTest(unittest.TestCase):
    def _budget(self, d, cycle="c9"):
        led = budgets.BudgetLedger(os.path.join(d, "ledger.json"))
        return budgets.DurableBudget(led, cycle, "AAPL")

    def test_multistep_agent_charges_every_call(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        b = self._budget(d)
        model = FakeModel()
        gated = workers.GatedModel(model, b, "hypothesize", "m-test",
                                   "c9", "AAPL", 10.0, log)
        ex = workers.PrescanningExecutor(lambda c: "ok-" + c, b, 10.0,
                                         log, "c9", "AAPL", "extract")
        for _ in range(3):  # three ReAct steps, like a real CodeAgent
            gated.generate([{"role": "user", "content": "go"}])
        for _ in range(2):
            ex("import json\nx = 1")
        self.assertEqual(b.llm, 3)
        self.assertEqual(b.tools, 2)
        # 2500 reserved per call... check token reconciliation:
        self.assertEqual(b.tokens, 3 * 150)
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 5)  # one span per actual attempt
        self.assertEqual(s["tokens"], 3 * 150)

    def test_token_cap_trips_mid_agent(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        b = self._budget(d)
        gated = workers.GatedModel(FakeModel(usage=(10 ** 9, 0)),
                                   b, "hypothesize", "m", "c9", "AAPL",
                                   10.0, log)
        gated.generate([{"role": "user", "content": "big"}])
        # Reservation was 6250, actual blew past the 250k cap: the next
        # attempt aborts BEFORE executing.
        with self.assertRaises(r15.AbortCycle):
            gated.generate([{"role": "user", "content": "again"}])

    def test_hung_call_aborts_and_stays_charged(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        b = self._budget(d)
        gated = workers.GatedModel(FakeModel(hang=True), b,
                                   "hypothesize", "m", "c9", "AAPL",
                                   0.2, log)
        t0 = time.monotonic()
        with self.assertRaises(r15.AbortCycle):
            gated.generate([{"role": "user", "content": "hang"}])
        self.assertLess(time.monotonic() - t0, 10.0)
        self.assertEqual(b.llm, 1)  # ambiguous attempt counts as spent
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)

    def test_scan_runs_before_execution(self):
        d = tempfile.mkdtemp()
        b = self._budget(d)
        ran = []
        ex = workers.PrescanningExecutor(lambda c: ran.append(c), b, 10.0)
        with self.assertRaises(workers.ConfigBlocked):
            ex("import subprocess\n")
        self.assertEqual(ran, [])  # delegate never ran
        self.assertEqual(b.tools, 0)  # nothing executed, nothing charged

    def test_sandbox_spec_locked(self):
        with self.assertRaises(workers.ConfigBlocked):
            workers._sandbox_kwargs({})  # no proxy, no digest
        kw = workers._sandbox_kwargs(SANDBOX)
        self.assertEqual(kw["pids_limit"], 64)
        self.assertTrue(any(a.startswith("seccomp=") for a in
                            kw["security_opt"]))
        self.assertTrue(any(a.startswith("apparmor=") for a in
                            kw["security_opt"]))
        self.assertEqual(kw["network_mode"], "cont:rp-egress")
        bad = dict(SANDBOX, image_digest="unpinned-tag")
        with self.assertRaises(workers.ConfigBlocked):
            workers._sandbox_kwargs(bad)

    def test_no_config_blocks(self):
        w = workers.make_extract_worker(None)
        with self.assertRaises(workers.ConfigBlocked):
            w({}, r15.CycleBudget("X", now=0.0))
        w2 = workers.make_extract_worker({"model_id": "m"})  # no sandbox
        with self.assertRaises(workers.ConfigBlocked):
            w2({}, r15.CycleBudget("X", now=0.0))

    def test_configured_returns_runner(self):
        w = workers.make_extract_worker({"model_id": "m"}, SANDBOX,
                                        budget=self._budget(tempfile.mkdtemp()),
                                        log_path=os.path.join(
                                            tempfile.mkdtemp(), "s.jsonl"))
        self.assertTrue(callable(w))

    def test_candidate_mapping(self):
        out = workers._to_candidates(
            json.dumps({"kind": "filing_event", "symbols": ["AAPL"],
                        "value": {"type": "enum", "v": "x"}}),
            {"kind": "filing_event", "symbols": ["AAPL"]})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["effect"], "unknown")
        # Model output never assigns feature identity (publish does).
        self.assertNotIn("feature_id", out[0])
        self.assertEqual(workers._to_candidates("not json", {}), [])


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
        ok, bad = workers.scan_imports(
            'import importlib\nimportlib.import_module("socket")\n')
        self.assertFalse(ok)
        self.assertEqual(bad, "importlib")
        ok, _ = workers.scan_imports('x = __import__("json")\n')
        self.assertTrue(ok)
        ok, bad = workers.scan_imports('mod.import_module("os")\n')
        self.assertFalse(ok)
        self.assertEqual(bad, "import_module")

    def test_unparseable_fails_closed(self):
        ok, _ = workers.scan_imports("def broken(:\n")
        self.assertFalse(ok)


class DigestTest(unittest.TestCase):
    def test_roundtrip_and_idempotent(self):
        d = tempfile.mkdtemp()
        ok, _ = digest.append_digest(d, 3, "AAPL", "hypothesize",
                                     "short thesis")
        self.assertTrue(ok)
        ok, reason = digest.append_digest(d, 3, "AAPL", "hypothesize",
                                          "short thesis")
        self.assertTrue(ok)
        self.assertEqual(reason, "duplicate")
        rows = open(os.path.join(d, "research_digest.jsonl")).read(
        ).strip().splitlines()
        self.assertEqual(len(rows), 1)

    def test_overlong_rejected_not_truncated(self):
        d = tempfile.mkdtemp()
        ok, reason = digest.append_digest(d, 3, "AAPL", "hypothesize",
                                          "x" * 501)
        self.assertFalse(ok)
        self.assertEqual(reason, "digest-too-long")


class RetentionTest(unittest.TestCase):
    def _saver(self, d):
        import sqlite3 as _sq
        from langgraph.checkpoint.sqlite import SqliteSaver
        try:
            from plane import graph as _g
            has_lg = _g._LANGGRAPH
        except ImportError:
            has_lg = False
        self.assertTrue(has_lg)
        con = _sq.connect(os.path.join(d, "ckpt.sqlite3"),
                          check_same_thread=False)
        return SqliteSaver(con)

    def test_prune_old_threads(self):
        d = tempfile.mkdtemp()
        s = self._saver(d)
        cfg = {"configurable": {"thread_id": "old",
                                "checkpoint_ns": ""}}
        old_ts = "2020-01-01T00:00:00+00:00"
        s.put(cfg, {"v": 1, "ts": old_ts, "id": "i",
                    "channel_values": {}, "channel_versions": {},
                    "versions_seen": {}}, {}, [])
        # 31 days after the checkpoint ts: the thread is gone.
        import datetime as _dt
        ref = _dt.datetime.fromisoformat(old_ts).timestamp()
        gone = retention.prune_checkpoints(s, now=ref + 31 * 86400)
        self.assertEqual(gone, ["old"])
        s.put(cfg, {"v": 1, "ts": old_ts, "id": "i",
                    "channel_values": {}, "channel_versions": {},
                    "versions_seen": {}}, {}, [])
        kept = retention.prune_checkpoints(s, now=ref + 29 * 86400)
        self.assertEqual(kept, [])


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


def _canon(**kw):
    c = {"source_id": "edgar_8k", "kind": "filing_event",
         "content_hash": HEXA, "published_ns": OBS_NS,
         "ingested_ns": OBS_NS, "symbols": ["AAPL"],
         "value": {"type": "enum", "v": "8-K:item-2.02"},
         "effect": "bullish", "corroborated": True,
         "parser_confidence": "high"}
    c.update(kw)
    return c


@unittest.skipUnless(_HAS_LG, "langgraph not installed")
class GraphTest(unittest.TestCase):
    def _app(self, d, fail=None, budgets=None, prefill=0, history=None,
             digest_dir=None, hooks=None, hypo_text=None):
        import sqlite3 as _sq
        mapp = os.path.join(d, "entity_map.json")

        def harvest(watchlist, epoch):
            recs = [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish",
                     "provenance_url": "https://example.invalid/x",
                     "llm_touched": False}]
            hist = ({"edgar_8k": [{"h": HEXA, "ts": OBS_S}]}
                    if history else None)
            return (recs * prefill if prefill else recs, {}, hist)

        calls = {"extract": 0}

        def extract(rec, budget):
            calls["extract"] += 1
            if fail == "extract-abort":
                raise r15.AbortCycle("AAPL", {})
            budget.charge_tool()
            return [dict(r, llm_touched=False) for r in [rec]]

        if fail == "hypothesize-abort":
            def hypo(sym, st):
                raise r15.AbortCycle(sym, {})
        else:
            def hypo(sym, st):
                return hypo_text if hypo_text is not None else \
                    "thesis-%s" % sym

        def crit(sym, text, st):
            if fail == "critique-block":
                raise workers.ConfigBlocked("no key")
            return {"text": "c", "disagreement": False}

        def resolve_emit(state):
            return publish.resolve_emit({
                "outdir": os.path.join(d, "out"),
                "map_path": mapp,
                "canonical_for": lambda c: _canon(),
                "source_watermarks": lambda st: {
                    "edgar_8k": {"last_observation_at": OBS_S,
                                 "cursor": "g"}}},
                state)

        deps = {
            "harvest": harvest,
            "extract_workers": extract,
            "fuse": lambda cands: cands,
            "hypothesize": hypo,
            "critique": crit,
            "resolve_emit": resolve_emit,
            "cadence_state": cadence.CadenceState(
                persist_path=os.path.join(d, "cadence.json")),
            "budgets": budgets if budgets is not None else {
                "AAPL": r15.CycleBudget("AAPL", now=0.0),
                None: r15.CycleBudget("t", now=0.0)},
            "checkpointer_conn": _sq.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
        }
        if digest_dir is not None:
            deps["digest_dir"] = digest_dir
        if hooks is not None:
            deps["health_hook"] = hooks.append
        app = graph_mod.build_graph(deps)
        return app, calls

    def test_full_cycle_publishes_via_reader(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "t1")
        self.assertFalse(out.get("aborted"))
        self.assertIsNotNone(out.get("emitted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertIsNotNone(res)
        # extract test double carries effect bullish == canonical and
        # llm_touched False: deterministic parser path earns source.
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_history_roundtrip(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d, history=True)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "th")
        self.assertFalse(out.get("aborted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_trigger_immediate(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d)
        # Epoch 1 thesis succeeds; epoch 2 without trigger is TTL-cold.
        graph_mod.run_cycle(app, ["AAPL"], 1, "g1")
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "g2")
        self.assertNotIn("AAPL", out.get("thesis", {}))
        out2 = graph_mod.run_cycle(app, ["AAPL"], 2, "g3",
                                   trigger_symbols=["AAPL"])
        self.assertIn("AAPL", out2.get("thesis", {}))

    def test_aborted_cycle_publishes_nothing(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, fail="hypothesize-abort")
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "t2")
        self.assertTrue(out.get("aborted"))
        self.assertIsNone(out.get("emitted"))
        self.assertIsNone(emit_mod.latest_complete(os.path.join(d, "out")))
        # Failed thesis never advances cadence freshness.
        c = cadence.CadenceState(
            persist_path=os.path.join(d, "cadence.json"))
        self.assertTrue(c.should_refresh("AAPL", 3, ()))

    def test_abort_short_circuits_extract(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, calls = self._app(d, fail="extract-abort", prefill=5)
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "t9")
        self.assertTrue(out.get("aborted"))
        self.assertEqual(calls["extract"], 1)  # stopped, not 5

    def test_blocked_worker_drops_and_counts(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, fail="critique-block")
        out = graph_mod.run_cycle(app, ["AAPL"], 3, "t3")
        self.assertTrue(any(b.startswith("critique:") for b in
                            out.get("blocked", [])))
        self.assertIn("AAPL", out.get("critique", {}))

    def test_r15_enforced_on_hypothesize(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        b = r15.CycleBudget("AAPL", now=0.0)
        b.llm = r15.LLM_CALLS  # next guard trips the cap, no call made
        app, _ = self._app(d, budgets={
            "AAPL": b, None: r15.CycleBudget("t", now=0.0)})
        out = graph_mod.run_cycle(app, ["AAPL"], 4, "t4")
        self.assertTrue(out.get("aborted"))  # cap hit -> no publication
        # The trip fires at the first guarded boundary (extract here:
        # short-circuit means hypothesize never runs for the symbol).
        self.assertEqual(out.get("thesis", {}).get("AAPL", ""), "")
        self.assertIsNone(out.get("emitted"))

    def test_checkpoint_caps(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, prefill=600)
        out = graph_mod.run_cycle(app, ["AAPL"], 5, "t5")
        self.assertEqual(len(out.get("raw", [])), graph_mod.RAW_MAX)
        self.assertEqual(out.get("dropped_raw"), 600 - graph_mod.RAW_MAX)

    def test_oversized_generator_capped_before_materialize(self):
        d = tempfile.mkdtemp()
        _fixtures(d)

        def big_harvest(watchlist, epoch):
            def _gen():
                for i in range(100000):
                    yield {"kind": "filing_event", "symbols": ["AAPL"],
                           "value": {"type": "enum", "v": "e%d" % i}}
            return _gen(), {}, None

        import sqlite3 as _sq
        deps = {
            "harvest": big_harvest,
            "extract_workers": lambda rec, b: [],
            "fuse": lambda cands: cands,
            "hypothesize": lambda sym, st: "t",
            "critique": lambda sym, text, st: {"text": "c",
                                              "disagreement": False},
            "resolve_emit": lambda state: {"emitted": None, "empty": True,
                                           "aborted": False},
            "cadence_state": cadence.CadenceState(),
            "budgets": {"AAPL": r15.CycleBudget("AAPL", now=0.0),
                        None: r15.CycleBudget("t", now=0.0)},
            "checkpointer_conn": _sq.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
        }
        app = graph_mod.build_graph(deps)
        out = graph_mod.run_cycle(app, ["AAPL"], 5, "tbig")
        self.assertEqual(len(out.get("raw", [])), graph_mod.RAW_MAX)
        self.assertEqual(out.get("dropped_raw"),
                         100000 - graph_mod.RAW_MAX)

    def test_oversized_watchlist_and_thesis(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        wl = ["S%03d" % i for i in range(200)]
        big_budgets = {s: r15.CycleBudget(s, now=0.0) for s in wl[:64]}
        big_budgets[None] = r15.CycleBudget("t", now=0.0)
        app, _ = self._app(d, hypo_text="y" * 5000,
                            budgets=big_budgets,
                            digest_dir=os.path.join(d, "digest"))
        out = graph_mod.run_cycle(app, wl, 6, "tbig2",
                                  trigger_symbols=wl)
        self.assertEqual(len(out.get("watchlist", [])), 64)
        self.assertEqual(out.get("dropped_watchlist"), 200 - 64)
        # Checkpointed thesis capped; digest rejects the over-long one.
        capped = [v for v in out.get("thesis", {}).values() if v]
        self.assertTrue(capped)
        for v in capped:
            self.assertLessEqual(len(v), graph_mod.THESIS_CHARS_MAX)
        self.assertTrue(any(b.startswith("digest:") for b in
                            out.get("blocked", [])))

    def test_digest_written_and_health_reported(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        hooks = []
        dd = os.path.join(d, "digest")
        app, _ = self._app(d, digest_dir=dd, hooks=hooks)
        out = graph_mod.run_cycle(app, ["AAPL"], 7, "t7")
        self.assertFalse(out.get("aborted"))
        rows = open(os.path.join(dd, "research_digest.jsonl")).read(
        ).strip().splitlines()
        kinds = sorted(json.loads(r)["node"] for r in rows)
        self.assertEqual(kinds, ["critique", "hypothesize"])
        self.assertTrue(any(h["aborted"] is False for h in hooks))

    def test_feature_cap_and_lineage_dedupe(self):
        import hashlib as _hl
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        hashes = [_hl.sha256(("c%d" % i).encode()).hexdigest()
                  for i in range(70)]
        con = sqlite3.connect(dbp)
        con.executemany("INSERT INTO records VALUES (?, ?)",
                        [(h, "edgar_8k") for h in hashes])
        con.commit()
        con.close()
        order = list(range(70)) + [0]  # 71st duplicates the 1st lineage
        it = iter(order)

        def dup_canon(c):
            return _canon(content_hash=hashes[next(it)])

        fused = []
        for _ in range(71):
            fused.append({"kind": "filing_event", "symbols": ["AAPL"],
                          "value": {"type": "enum",
                                    "v": "8-K:item-2.02"},
                          "effect": "bullish", "llm_touched": False})
        res = publish.resolve_emit({
            "outdir": os.path.join(d, "out"), "map_path": mapp,
            "canonical_for": dup_canon,
            "source_watermarks": lambda st: {
                "edgar_8k": {"last_observation_at": OBS_S,
                             "cursor": "g"}}},
            {"epoch": 9, "fused": fused})
        self.assertFalse(res["empty"])
        # 70 unique lineages (1 dupe collapsed) -> 70 - 64 over cap.
        self.assertEqual(res["dropped_resolve"], 1)
        self.assertEqual(res["dropped_over_cap"], 70 - 64)
        got = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertIsNotNone(got)
        self.assertEqual(len(got["accepted"]), 64)

    def test_map_error_fails_closed(self):
        d = tempfile.mkdtemp()
        bad = os.path.join(d, "badmap.json")
        open(bad, "w").write("{not json")
        res = publish.resolve_emit({
            "outdir": os.path.join(d, "out"), "map_path": bad,
            "canonical_for": lambda c: _canon(),
            "source_watermarks": lambda st: {}},
            {"epoch": 1, "fused": []})
        self.assertIsNone(res["emitted"])
        self.assertIn("map_error", res)

    def test_crash_resume_no_dupes(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d)
        out = graph_mod.run_cycle(app, ["AAPL"], 6, "t6")
        out2 = graph_mod.run_cycle(app, ["AAPL"], 6, "t6")
        self.assertEqual(out.get("emitted"), out2.get("emitted"))
        man = os.path.join(d, "out", "manifest.jsonl")
        rows = open(man).read().strip().splitlines()
        self.assertEqual(len(rows), 1)


class ResolverHardeningTest(unittest.TestCase):
    def test_malformed_canonical_rejects(self):
        for bad in [{}, {"source_id": "edgar_8k"},
                    _canon(content_hash="xyz"),
                    _canon(parser_confidence="bogus"),
                    _canon(symbols="AAPL"),
                    _canon(published_ns="soon")]:
            from plane import resolver
            ok, reason = resolver.resolve(
                {"kind": "filing_event", "symbols": ["AAPL"],
                 "value": {"type": "enum", "v": "8-K:item-2.02"},
                 "effect": "bullish"},
                bad, MAP)
            self.assertFalse(ok)
            self.assertIn(reason, ("canonical-shape", "kind-no-emitter",
                                   "symbols-type", "value-shape",
                                   "entity-unmapped:AAPL"))

    def test_parser_confidence_downgrades(self):
        from plane import resolver
        cand = {"kind": "filing_event", "symbols": ["AAPL"],
                "value": {"type": "enum", "v": "8-K:item-2.02"},
                "effect": "bullish"}
        ok, (feat, _) = resolver.resolve(cand, _canon(), MAP,
                                         llm_touched=False)
        self.assertTrue(ok)
        self.assertEqual(feat["evidence"], "source")
        self.assertEqual(feat["confidence_bucket"], "high")
        ok, (feat2, _) = resolver.resolve(
            cand, _canon(parser_confidence="low"), MAP, llm_touched=False)
        self.assertTrue(ok)
        # High tier, low parser confidence: two drops -> low. A weak
        # parse can never ride a high tier to high confidence.
        self.assertEqual(feat2["confidence_bucket"], "low")

    def test_unknown_cik_rejects_in_resolver(self):
        from plane import resolver
        cand = {"kind": "filing_event", "symbols": ["AAPL"],
                "value": {"type": "enum", "v": "8-K:item-2.02"},
                "effect": "bullish", "entity_ref": {"cik": "9999999999"}}
        ok, reason = resolver.resolve(cand, _canon(), MAP,
                                      llm_touched=False)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("entity-unmapped"))


if __name__ == "__main__":
    unittest.main()
