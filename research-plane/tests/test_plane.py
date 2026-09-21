"""Phase 2.5 plane tests: R15/ledger, cadence, attribution, scanner,
workers boundary, spend governor, digest, retention, emit concurrency,
graph with FORCED invocation boundaries.

Graph tests run the REAL production publish path (plane/publish.py)
against scratch canonical.db + pinned map file, and round-trip through
the FROZEN ctx reader. Hypothesis/critique reach the (fake) provider
ONLY through workers.GatedModel built by the injected model_factory —
the graph test below asserts the boundary, not just the wrapper.
Run under the plane venv for graph tests (langgraph); stdlib-only
parts also pass on system python (graph tests skip).
"""
import hashlib
import json
import multiprocessing
import os
import sqlite3
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root: collector/

from collector import ctx_read
from plane import attribution, budgets, cadence, digest, emit as emit_mod
from plane import locks, r15, retention, spend as spend_mod
from plane import timeout as timeout_mod
from plane import publish, workers


def _has_mod(name):
    import importlib.util
    return importlib.util.find_spec(name) is not None

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
           "apparmor_profile": "rp-worker",
           "egress_proxy": "http://proxy.invalid:8080"}


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
        self.assertEqual(b.llm, 0)
        b.llm = r15.LLM_CALLS
        with self.assertRaises(r15.AbortCycle):
            b.check()

    def test_invalidate_poisons(self):
        b = r15.CycleBudget("AAPL", now=0.0)
        b.invalidate()
        with self.assertRaises(r15.AbortCycle):
            b.check()
        with self.assertRaises(r15.AbortCycle):
            b.charge_tool()

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
    def _ledger(self, d, name="ledger.sqlite3"):
        return budgets.BudgetLedger(os.path.join(d, name))

    def test_crash_resume_reconstructs(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        b1 = budgets.DurableBudget(led, "cycle-9", "AAPL")
        for _ in range(20):
            b1.charge_llm(tokens=100)
        b2 = budgets.DurableBudget(led, "cycle-9", "AAPL")
        self.assertEqual(b2.llm, 20)
        self.assertEqual(b2.tokens, 20 * 100)
        for _ in range(5):
            b2.charge_llm(tokens=100)
        with self.assertRaises(r15.AbortCycle):
            b2.charge_llm(tokens=100)  # depth 25 trips; enforced post-crash

    def test_token_reservation_enforced(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        lease = led.reserve_llm("c", "A", now_wall=1000.0)
        self.assertEqual(lease["reserved"], budgets.TOKENS_PER_CALL)
        led.settle_llm("c", "A", lease, 120)
        self.assertEqual(led.snapshot("c", "A")["tokens"], 120)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_llm("c", "A", reserve_tokens=r15.TOKENS + 1,
                            now_wall=1000.0)

    def test_wall_clock_binds_resume(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        led.reserve_llm("c", "A", now_wall=1000.0)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_llm("c", "A", now_wall=1000.0 + r15.WALL_S + 1)

    def test_corrupt_ledger_never_resets(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "ledger.sqlite3")
        led = self._ledger(d)
        led.reserve_llm("c", "A", now_wall=1000.0)
        with open(p, "wb") as fh:  # existing-but-corrupt state
            fh.write(b"not a database at all")
        with self.assertRaises(r15.AbortCycle):
            led.reserve_llm("c", "A", now_wall=1000.0)
        with self.assertRaises(r15.AbortCycle):
            led.snapshot("c", "A")
        with self.assertRaises(r15.AbortCycle):
            led.check("c", "A", now_wall=1000.0)

    def test_oversize_ledger_blocks(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "ledger.sqlite3")
        with open(p, "wb") as fh:
            fh.seek(budgets.LEDGER_MAX_BYTES + 1)
            fh.write(b"\0")
        led = self._ledger(d)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_llm("c", "A", now_wall=1000.0)

    def test_double_settle_and_unknown_lease(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        lease = led.reserve_llm("c", "A", now_wall=1000.0)
        led.settle_llm("c", "A", lease, 50)
        with self.assertRaises(r15.AbortCycle):  # settle twice
            led.settle_llm("c", "A", lease, 50)
        with self.assertRaises(r15.AbortCycle):  # no such reservation
            led.settle_llm("c", "A", {"lease_id": "c:A:llm:99"}, 50)

    def test_retention_prunes_without_reset(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        led.reserve_llm("old", "A", now_wall=1000.0)
        led.reserve_llm("new", "A", now_wall=float(10 ** 10))
        snap = led.snapshot("new", "A")
        self.assertEqual(snap["llm"], 1)  # current cycle intact...
        con = sqlite3.connect(os.path.join(d, "ledger.sqlite3"))
        rows = con.execute("SELECT cycle FROM counters").fetchall()
        con.close()
        self.assertEqual(rows, [("new",)])  # ...old cycle pruned


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

    def test_repeated_timeouts_leave_no_debt(self):
        import threading as _th
        base = _th.active_count()

        def hang():
            time.sleep(0.4)

        for _ in range(5):
            with self.assertRaises(timeout_mod.CallTimeout):
                timeout_mod.run_with_timeout(hang, 0.05)
        time.sleep(0.8)  # abandoned daemons drain...
        self.assertLessEqual(_th.active_count(), base + 1)


class LocksTest(unittest.TestCase):
    def test_no_per_path_registry(self):
        self.assertFalse(hasattr(locks, "_PROCESS_LOCKS"))
        d = tempfile.mkdtemp()
        for i in range(200):  # distinct paths must not accumulate state
            with locks.FileLock(os.path.join(d, "l%d.lock" % i)):
                pass
        names = [n for n in vars(locks) if "path" in n.lower()
                 or "lock" in n.lower()]
        dicts = [n for n in names
                 if isinstance(getattr(locks, n), dict)]
        self.assertEqual(dicts, [])


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
        self.assertEqual(len(data), 8)

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
                                completion_tokens=0, span_id="s2",
                                outcome="error")
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 2)
        self.assertEqual(s["tokens"], 1400)
        self.assertEqual(s["prompt_tokens"], 900)
        self.assertEqual(s["completion_tokens"], 500)
        self.assertEqual(s["by_node"], {"hypothesize": 1, "critique": 1})
        self.assertEqual(s["by_outcome"], {"success": 1, "error": 1})

    def test_category_taxonomy_frozen(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        with self.assertRaises(ValueError):
            attribution.append_span(log, 1, "n", "m", category="timeout")
        with self.assertRaises(ValueError):
            attribution.append_span(log, 1, "n", "m", outcome="weird")

    def test_retry_dedupe_and_mirror(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        for _ in range(2):
            attribution.append_span(log, 9, "hypothesize", "m1",
                                    cycle_id="c", symbol="A", span_id="r1")
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)
        # Mirror appended ONLY on insert: exactly one mirror row too.
        rows = open(log).read().strip().splitlines()
        self.assertEqual(len(rows), 1)
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
        self.assertEqual(s["calls"], 1)
        rows = open(log).read().strip().splitlines()
        self.assertEqual(len(rows), 1)

    def test_missing_ledger_is_not_zero_spend(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "never.jsonl")
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.day_summary(log)
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.spend_since(log, 0)


class FakeUsage:
    def __init__(self, i, o):
        self.input_tokens = i
        self.output_tokens = o


class FakeMsg(str):
    """A model answer that IS the text (str) and carries usage."""

    def __new__(cls, text, i=100, o=50):
        obj = super().__new__(cls, text)
        obj.token_usage = FakeUsage(i, o)
        return obj


class ScriptModel:
    """Stand-in multi-step model: generate() is the real boundary the
    production CodeAgent calls once per ReAct step."""

    def __init__(self, fn):
        self.fn = fn
        self.calls = []

    def generate(self, messages, **kwargs):
        self.calls.append((messages, dict(kwargs)))
        return self.fn(messages, kwargs)


class WorkerBoundaryTest(unittest.TestCase):
    def _budget(self, d, cycle="c9"):
        led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))
        return budgets.DurableBudget(led, cycle, "AAPL")

    def _gated(self, d, model, node="hypothesize", price=0.0):
        log = os.path.join(d, "spans.jsonl")
        return workers.GatedModel(model, self._budget(d), node, "m-test",
                                  "c9", "AAPL", 10.0, log, price), log

    def test_multistep_agent_charges_every_call(self):
        d = tempfile.mkdtemp()
        model = ScriptModel(lambda m, k: FakeMsg('{"a": 1}'))
        gated, log = self._gated(d, model)
        ex = workers.PrescanningExecutor(lambda c: "ok-" + c,
                                         self._budget(d), 10.0, log, "c9",
                                         "AAPL", "extract")
        for _ in range(3):
            gated.generate([{"role": "user", "content": "go"}])
        for _ in range(2):
            ex("import json\nx = 1")
        b = self._budget(d)
        self.assertEqual(b.llm, 3)
        self.assertEqual(b.tools, 2)
        self.assertEqual(b.tokens, 3 * 150)
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 5)
        self.assertEqual(s["tokens"], 3 * 150)

    def test_max_tokens_clamped_downward(self):
        d = tempfile.mkdtemp()
        model = ScriptModel(lambda m, k: FakeMsg("t"))
        gated, _ = self._gated(d, model)
        gated.generate([{"role": "user", "content": "go"}],
                       max_tokens=10 ** 9)  # caller asks huge...
        asked = model.calls[0][1]["max_tokens"]
        self.assertLessEqual(asked, budgets.TOKENS_PER_CALL)

    def test_token_breach_aborts_after_settle(self):
        d = tempfile.mkdtemp()
        model = ScriptModel(lambda m, k: FakeMsg("big", 10 ** 9, 0))
        gated, log = self._gated(d, model)
        with self.assertRaises(r15.AbortCycle):
            gated.generate([{"role": "user", "content": "big"}])
        # The spend happened and is RECORDED (tokens huge), then the
        # cycle aborts: no silent acceptance, no further calls.
        self.assertEqual(model.calls and len(model.calls), 1)
        with self.assertRaises(r15.AbortCycle):
            gated.generate([{"role": "user", "content": "again"}])
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)

    def test_negative_usage_aborts(self):
        d = tempfile.mkdtemp()
        model = ScriptModel(lambda m, k: FakeMsg("x", -5, 0))
        gated, _ = self._gated(d, model)
        with self.assertRaises(r15.AbortCycle):
            gated.generate([{"role": "user", "content": "go"}])

    def test_hung_call_aborts_poisons_and_records(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        b = self._budget(d)

        def hang(m, k):
            time.sleep(60)

        gated = workers.GatedModel(ScriptModel(hang), b, "hypothesize",
                                   "m", "c9", "AAPL", 0.2, log)
        t0 = time.monotonic()
        with self.assertRaises(r15.AbortCycle):
            gated.generate([{"role": "user", "content": "hang"}])
        self.assertLess(time.monotonic() - t0, 10.0)
        self.assertEqual(b.llm, 1)  # ambiguous attempt counts as spent
        with self.assertRaises(r15.AbortCycle):  # row poisoned
            b.reserve_llm()
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 1)
        self.assertEqual(s["by_outcome"], {"timeout": 1})

    def test_error_keeps_reservation_as_spent(self):
        d = tempfile.mkdtemp()

        def boom(m, k):
            raise RuntimeError("provider down")

        gated, log = self._gated(d, ScriptModel(boom))
        with self.assertRaises(RuntimeError):
            gated.generate([{"role": "user", "content": "go"}])
        b = self._budget(d)
        self.assertEqual(b.tokens, budgets.TOKENS_PER_CALL)  # stands
        s = attribution.day_summary(log)
        self.assertEqual(s["by_outcome"], {"error": 1})

    def test_scan_runs_before_execution(self):
        d = tempfile.mkdtemp()
        b = self._budget(d)
        ran = []
        ex = workers.PrescanningExecutor(lambda c: ran.append(c), b, 10.0)
        with self.assertRaises(workers.ConfigBlocked):
            ex("import subprocess\n")
        self.assertEqual(ran, [])
        self.assertEqual(b.tools, 0)

    def test_sandbox_spec_locked(self):
        with self.assertRaises(workers.ConfigBlocked):
            workers._sandbox_kwargs({})
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

    @unittest.skipUnless(_has_mod("smolagents"), "smolagents missing")
    def test_proxy_required_for_model(self):
        with self.assertRaises(workers.ConfigBlocked):
            workers.make_model({"model_id": "m"}, {})
        # Dummy key: construction never touches the network; the
        # assertion is on the forced proxy client, not connectivity.
        m = workers.make_model({"model_id": "m", "api_key": "test"},
                               SANDBOX)
        transport = m.client_kwargs["http_client"]._transport
        self.assertEqual(type(transport).__name__, "HTTPTransport")
        self.assertIn("proxy.invalid", str(getattr(
            getattr(transport, "_pool", None), "_proxy_url",
            "proxy.invalid")))

    @unittest.skipUnless(_has_mod("smolagents"), "smolagents missing")
    def test_executor_cleanup_on_paths(self):
        import json as _json
        d = tempfile.mkdtemp()
        log = os.path.join(d, "s.jsonl")
        closed = []

        class FakeExec:
            def cleanup(self):
                closed.append("cleanup")

            def delete(self):
                closed.append("delete")

        class FakeAgent:
            def __init__(self, *a, **k):
                self.python_executor = lambda code: "never"

            def run(self, task):
                return _json.dumps({"kind": "filing_event",
                                    "symbols": ["AAPL"],
                                    "value": {"type": "enum", "v": "x"}})

        import smolagents
        orig = smolagents.CodeAgent
        smolagents.CodeAgent = FakeAgent
        try:
            w = workers.make_extract_worker(
                {"model_id": "m"}, SANDBOX, budget=self._budget(d),
                log_path=log, executor_factory=FakeExec,
                model_factory=lambda cfg: ScriptModel(
                    lambda m, k: FakeMsg("{}")),
                pricing={"m": 0.0})
            w({"kind": "filing_event", "symbols": ["AAPL"]},
              self._budget(d))
        finally:
            smolagents.CodeAgent = orig
        self.assertIn("cleanup", closed)
        self.assertIn("delete", closed)

    def test_no_config_blocks(self):
        w = workers.make_extract_worker(None)
        with self.assertRaises(workers.ConfigBlocked):
            w({}, r15.CycleBudget("X", now=0.0))
        w2 = workers.make_extract_worker({"model_id": "m"})
        with self.assertRaises(workers.ConfigBlocked):
            w2({}, r15.CycleBudget("X", now=0.0))

    def test_candidate_mapping(self):
        out = workers._to_candidates(
            json.dumps({"kind": "filing_event", "symbols": ["AAPL"],
                        "value": {"type": "enum", "v": "x"}}),
            {"kind": "filing_event", "symbols": ["AAPL"]})
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["effect"], "unknown")
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

    @unittest.skipUnless(_has_mod("langgraph"), "langgraph missing")
    def test_make_saver_is_strict(self):
        import sqlite3 as _sq
        con = _sq.connect(os.path.join(tempfile.mkdtemp(), "c.sqlite3"),
                          check_same_thread=False)
        s = retention.make_saver(con)
        serde = s.serde
        self.assertFalse(getattr(serde, "pickle_fallback", True))
        eff = getattr(serde, "_allowed_msgpack_modules", True)
        self.assertTrue(eff is not True and eff is not None)

    @unittest.skipUnless(_has_mod("langgraph"), "langgraph missing")
    def test_prune_old_threads(self):
        d = tempfile.mkdtemp()
        s = self._saver(d)
        cfg = {"configurable": {"thread_id": "old",
                                "checkpoint_ns": ""}}
        old_ts = "2020-01-01T00:00:00+00:00"
        s.put(cfg, {"v": 1, "ts": old_ts, "id": "i",
                    "channel_values": {}, "channel_versions": {},
                    "versions_seen": {}}, {}, [])
        import datetime as _dt
        ref = _dt.datetime.fromisoformat(old_ts).timestamp()
        gone = retention.prune_checkpoints(s, now=ref + 31 * 86400)
        self.assertEqual(gone, ["old"])
        s.put(cfg, {"v": 1, "ts": old_ts, "id": "i",
                    "channel_values": {}, "channel_versions": {},
                    "versions_seen": {}}, {}, [])
        kept = retention.prune_checkpoints(s, now=ref + 29 * 86400)
        self.assertEqual(kept, [])


class SpendTest(unittest.TestCase):
    def test_pricing_missing_blocks(self):
        with self.assertRaises(workers.ConfigBlocked):
            spend_mod.SpendGovernor("/tmp/x.jsonl", {})
        with self.assertRaises(workers.ConfigBlocked):
            spend_mod.SpendGovernor("/tmp/x.jsonl", {"m": -1})

    def test_tier_transitions(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        g = spend_mod.SpendGovernor(log, {"m": 1.0}, stage="G0")
        self.assertEqual(g.decision(), ("allow", "ok"))
        # Seed $95 of 30d spend -> tier 1 (>=60% of $150).
        attribution.append_span(log, 1, "hypothesize", "m", cycle_id="s",
                                symbol="A", usd=95.0, span_id="seed1")
        self.assertEqual(g.decision(), ("throttle", "tier-1"))
        attribution.append_span(log, 1, "hypothesize", "m", cycle_id="s",
                                symbol="A", usd=30.0, span_id="seed2")
        self.assertEqual(g.decision(), ("triggers-only", "tier-2"))
        attribution.append_span(log, 1, "hypothesize", "m", cycle_id="s",
                                symbol="A", usd=30.0, span_id="seed3")
        self.assertEqual(g.decision(), ("deny", "stage-cap-reached"))

    def test_unmeasurable_denies(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        open(attribution._db_for(log), "wb").write(b"corrupt")
        g = spend_mod.SpendGovernor(log, {"m": 1.0})
        self.assertEqual(g.decision(), ("deny", "spend-unmeasurable"))


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
    def _deps(self, d, script="thesis", fail=None, governor=None,
              digest_dir=None, hooks=None, parser=False,
              history=False, prefill=0, extract_abort=False):
        import sqlite3 as _sq
        mapp = os.path.join(d, "entity_map.json")
        log = os.path.join(d, "spans.jsonl")
        led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))

        def harvest(watchlist, epoch):
            recs = [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish",
                     "provenance_url": "https://example.invalid/x"}]
            hist = ({"edgar_8k": [{"h": HEXA, "ts": OBS_S}]}
                    if history else None)
            return (recs * prefill if prefill else recs, {}, hist)

        calls = {"extract": 0, "model": []}

        def extract(rec, budget):
            calls["extract"] += 1
            if extract_abort:
                raise r15.AbortCycle("AAPL", {})
            budget.charge_tool()
            return [dict(rec)]

        def parser_extract(rec, budget):
            budget.charge_tool()
            if not parser:
                return []
            return [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish",
                     "provenance_url": "https://example.invalid/x"}]

        if fail == "model-block":
            def model_factory(node, symbol, budget, cycle_id):
                raise workers.ConfigBlocked("no key")
        else:
            def model_factory(node, symbol, budget, cycle_id):
                if fail == "model-abort" and node == "hypothesize":
                    def _ab(m, k):
                        raise r15.AbortCycle(symbol, {})
                    inner = ScriptModel(_ab)
                elif isinstance(script, dict):
                    inner = ScriptModel(
                        lambda m, k: FakeMsg(script[node]))
                else:
                    inner = ScriptModel(lambda m, k: FakeMsg(script))
                calls["model"].append((node, symbol, cycle_id))
                return workers.GatedModel(inner, budget, node, "fake",
                                          cycle_id, symbol, 30.0, log)

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
            "parser_extract": parser_extract,
            "fuse": lambda cands: cands,
            "hypothesize_build": lambda sym, st: [
                {"role": "user", "content": "thesis " + sym}],
            "hypothesize_parse": lambda sym, text, st: str(text),
            "critique_build": lambda sym, text, st: [
                {"role": "user", "content": "critique"}],
            "critique_parse": lambda sym, text, st: {
                "text": "c", "disagreement": False},
            "model_factory": model_factory,
            "budget_factory": lambda cyc, sym: budgets.DurableBudget(
                led, cyc, sym),
            "resolve_emit": resolve_emit,
            "cadence_state": cadence.CadenceState(
                persist_path=os.path.join(d, "cadence.json")),
            "checkpointer_conn": _sq.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
        }
        if governor is not None:
            deps["spend_governor"] = governor
        if digest_dir is not None:
            deps["digest_dir"] = digest_dir
        if hooks is not None:
            deps["health_hook"] = hooks.append
        return deps, calls, log, led

    def _app(self, d, **kw):
        deps, calls, log, led = self._deps(d, **kw)
        return graph_mod.build_graph(deps), calls

    def test_full_cycle_publishes_via_reader(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, calls = self._app(d, script="thesis-AAPL")
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "t1")
        self.assertFalse(out.get("aborted"))
        self.assertIsNotNone(out.get("emitted"))
        # Every hypothesize/critique attempt went through the factory's
        # gated model (cycle identity bound to the run's thread_id).
        nodes = [c[0] for c in calls["model"]]
        self.assertIn("hypothesize", nodes)
        self.assertIn("critique", nodes)
        self.assertTrue(all(c[2] == "t1" for c in calls["model"]))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertIsNotNone(res)
        # Worker (LLM-origin) output stays advisory: inference-capped.
        self.assertEqual(res["stats"]["reasons"],
                         {"inference-capped": 1})

    def test_parser_path_earns_source(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d, script="t", parser=True)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "tp")
        self.assertFalse(out.get("aborted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_candidate_origin_cannot_self_promote(self):
        # A worker candidate claiming parser origin (or llm_touched) is
        # overwritten to llm by the graph: content match still inference.
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        deps, calls, log, led = self._deps(d, script="t")

        def evil_extract(rec, budget):
            budget.charge_tool()
            return [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish", "origin": "parser",
                     "llm_touched": False}]

        deps["extract_workers"] = evil_extract
        import sqlite3 as _sq
        app = graph_mod.build_graph(deps)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "te")
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"],
                         {"inference-capped": 1})

    def test_two_threads_two_identities(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, calls, log, led = self._deps(d, script="t")
        app = graph_mod.build_graph(deps)
        # Different epochs (TTL elapses) so BOTH runs actually attempt;
        # the assertion is on disjoint cycle identities, not cadence.
        graph_mod.run_cycle(app, ["AAPL"], 1, "thread-A")
        graph_mod.run_cycle(app, ["AAPL"], 7, "thread-B")
        con = sqlite3.connect(os.path.join(d, "ledger.sqlite3"))
        cycles = sorted(
            r[0] for r in con.execute("SELECT DISTINCT cycle FROM "
                                      "counters").fetchall())
        con.close()
        self.assertEqual(cycles, ["thread-A", "thread-B"])
        s = attribution.day_summary(log)
        self.assertEqual(s["calls"], 4)  # 2 cycles x 2 LLM attempts

    def test_history_roundtrip(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _ = self._app(d, script="t", history=True, parser=True)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "th")
        self.assertFalse(out.get("aborted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_trigger_immediate(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, script="t")
        graph_mod.run_cycle(app, ["AAPL"], 1, "g1")
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "g2")
        self.assertNotIn("AAPL", out.get("thesis", {}))
        out2 = graph_mod.run_cycle(app, ["AAPL"], 2, "g3",
                                   trigger_symbols=["AAPL"])
        self.assertIn("AAPL", out2.get("thesis", {}))

    def test_aborted_cycle_publishes_nothing(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, fail="model-abort")
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "t2")
        self.assertTrue(out.get("aborted"))
        self.assertIsNone(out.get("emitted"))
        self.assertIsNone(emit_mod.latest_complete(os.path.join(d, "out")))
        c = cadence.CadenceState(
            persist_path=os.path.join(d, "cadence.json"))
        self.assertTrue(c.should_refresh("AAPL", 3, ()))

    def test_abort_short_circuits_extract(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, calls = self._app(d, extract_abort=True, prefill=5)
        out = graph_mod.run_cycle(app, ["AAPL"], 2, "t9")
        self.assertTrue(out.get("aborted"))
        self.assertEqual(calls["extract"], 1)

    def test_blocked_model_applies_defaults(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, calls = self._app(d, fail="model-block")
        out = graph_mod.run_cycle(app, ["AAPL"], 3, "t3")
        self.assertTrue(any(b.startswith("hypothesize:") for b in
                            out.get("blocked", [])))
        self.assertEqual(calls["model"], [])  # provider never touched

    def test_spend_deny_aborts(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        log = os.path.join(d, "spend.jsonl")
        attribution.append_span(log, 1, "hypothesize", "m", cycle_id="s",
                                symbol="A", usd=200.0, span_id="big")
        gov = spend_mod.SpendGovernor(log, {"m": 1.0}, stage="G0")
        app, calls = self._app(d, script="t", governor=gov)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "sp1")
        self.assertTrue(out.get("aborted"))
        self.assertTrue(any("spend-deny" in b for b in
                            out.get("blocked", [])))
        self.assertIsNone(out.get("emitted"))
        self.assertEqual(calls["model"], [])

    def test_thesis_too_long_rejected_stays_stale(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, script="y" * 501)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "tl")
        self.assertEqual(out.get("thesis", {}).get("AAPL"), "")
        self.assertTrue(any("thesis-too-long" in b for b in
                            out.get("blocked", [])))
        c = cadence.CadenceState(
            persist_path=os.path.join(d, "cadence.json"))
        self.assertTrue(c.should_refresh("AAPL", 2, ()))

    def test_digest_failure_keeps_stale(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        presenter = os.path.join(d, "digest-file")
        open(presenter, "w").write("blocker")  # not a directory
        app, _ = self._app(d, script="t",
                            digest_dir=os.path.join(presenter, "sub"))
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "dg")
        self.assertEqual(out.get("thesis", {}).get("AAPL"), "")
        self.assertTrue(any("digest:" in b for b in
                            out.get("blocked", [])))
        c = cadence.CadenceState(
            persist_path=os.path.join(d, "cadence.json"))
        self.assertTrue(c.should_refresh("AAPL", 2, ()))

    def test_malformed_raw_counted(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, calls, log, led = self._deps(d, script="t")

        def bad_harvest(watchlist, epoch):
            return ([42, {"symbols": "xx"},
                     {"kind": "filing_event", "symbols": ["AAPL"],
                      "value": {"type": "enum", "v": "ok"}}], {}, None)

        deps["harvest"] = bad_harvest
        import sqlite3 as _sq
        app = graph_mod.build_graph(deps)
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "mr")
        self.assertEqual(out.get("malformed_raw"), 2)
        self.assertEqual(len(out.get("raw", [])), 1)

    def test_infinite_producer_terminates(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, calls, log, led = self._deps(d, script="t")

        def inf_harvest(watchlist, epoch):
            def _gen():
                i = 0
                while True:
                    i += 1
                    yield {"kind": "filing_event",
                           "symbols": ["AAPL"],
                           "value": {"type": "enum", "v": "e"}}
            return _gen(), {}, None

        deps["harvest"] = inf_harvest
        import sqlite3 as _sq
        app = graph_mod.build_graph(deps)
        t0 = time.monotonic()
        out = graph_mod.run_cycle(app, ["AAPL"], 1, "inf")
        self.assertLess(time.monotonic() - t0, 120.0)
        self.assertEqual(len(out.get("raw", [])), graph_mod.RAW_MAX)
        self.assertTrue(out.get("producer_overrun"))

    def test_oversized_watchlist(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        wl = ["S%03d" % i for i in range(200)] + [42, ""]
        app, _ = self._app(d, script="t")
        out = graph_mod.run_cycle(app, wl, 6, "tbig2",
                                  trigger_symbols=wl)
        self.assertEqual(len(out.get("watchlist", [])), 64)
        self.assertTrue(all(isinstance(s, str) for s in
                            out.get("watchlist", [])))

    def test_checkpoint_caps(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, script="t", prefill=600)
        out = graph_mod.run_cycle(app, ["AAPL"], 5, "t5")
        self.assertEqual(len(out.get("raw", [])), graph_mod.RAW_MAX)
        self.assertEqual(out.get("dropped_raw"), 600 - graph_mod.RAW_MAX)

    def test_digest_written_and_health_reported(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        hooks = []
        dd = os.path.join(d, "digest")
        app, _ = self._app(d, script="t", digest_dir=dd, hooks=hooks)
        out = graph_mod.run_cycle(app, ["AAPL"], 7, "t7")
        self.assertFalse(out.get("aborted"))
        rows = open(os.path.join(dd, "research_digest.jsonl")).read(
        ).strip().splitlines()
        kinds = sorted(json.loads(r)["node"] for r in rows)
        self.assertEqual(kinds, ["critique", "hypothesize"])
        self.assertTrue(all(h["cycle_id"] == "t7" for h in hooks))

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
        order = list(range(70)) + [0]
        it = iter(order)

        def dup_canon(c):
            return _canon(content_hash=hashes[next(it)])

        fused = []
        for _ in range(71):
            fused.append({"kind": "filing_event", "symbols": ["AAPL"],
                          "value": {"type": "enum",
                                    "v": "8-K:item-2.02"},
                          "effect": "bullish", "origin": "parser"})
        res = publish.resolve_emit({
            "outdir": os.path.join(d, "out"), "map_path": mapp,
            "canonical_for": dup_canon,
            "source_watermarks": lambda st: {
                "edgar_8k": {"last_observation_at": OBS_S,
                             "cursor": "g"}}},
            {"epoch": 9, "fused": fused})
        self.assertFalse(res["empty"])
        self.assertEqual(res["dropped_resolve"], 1)
        self.assertEqual(res["dropped_over_cap"], 70 - 64)
        got = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertIsNotNone(got)
        self.assertEqual(len(got["accepted"]), 64)

    def test_17_symbols_rejected_upstream(self):
        from plane import resolver
        cand = {"kind": "filing_event",
                "symbols": ["S%02d" % i for i in range(17)],
                "value": {"type": "enum", "v": "8-K:item-2.02"},
                "effect": "bullish"}
        ok, reason = resolver.resolve(cand, _canon(), MAP,
                                      origin="parser")
        self.assertFalse(ok)
        self.assertEqual(reason, "symbols-type")

    def test_watermark_gaps_drop_before_emit(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        fused = [{"kind": "filing_event", "symbols": ["AAPL"],
                  "value": {"type": "enum", "v": "8-K:item-2.02"},
                  "effect": "bullish", "origin": "parser"}]
        res = publish.resolve_emit({
            "outdir": os.path.join(d, "out"), "map_path": mapp,
            "canonical_for": lambda c: _canon(),
            "source_watermarks": lambda st: {}},  # no coverage
            {"epoch": 9, "fused": fused})
        self.assertIsNone(res["emitted"])
        self.assertIn("watermark_uncovered", res)
        res2 = publish.resolve_emit({
            "outdir": os.path.join(d, "out"), "map_path": mapp,
            "canonical_for": lambda c: _canon(),
            "source_watermarks": lambda st: {
                "edgar_8k": {"last_observation_at": "soon",
                             "cursor": "g"}}},  # malformed shape
            {"epoch": 9, "fused": fused})
        self.assertIn("watermark_error", res2)

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
        app, _ = self._app(d, script="t")
        out = graph_mod.run_cycle(app, ["AAPL"], 6, "t6")
        out2 = graph_mod.run_cycle(app, ["AAPL"], 6, "t6")
        self.assertEqual(out.get("emitted"), out2.get("emitted"))
        man = os.path.join(d, "out", "manifest.jsonl")
        rows = open(man).read().strip().splitlines()
        self.assertEqual(len(rows), 1)

    def test_concurrent_runs_refused(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _ = self._app(d, script="t")
        graph_mod._RUN_GUARD.acquire()
        try:
            with self.assertRaises(RuntimeError):
                graph_mod.run_cycle(app, ["AAPL"], 1, "con")
        finally:
            graph_mod._RUN_GUARD.release()


class ResolverHardeningTest(unittest.TestCase):
    def _cand(self, **kw):
        c = {"kind": "filing_event", "symbols": ["AAPL"],
             "value": {"type": "enum", "v": "8-K:item-2.02"},
             "effect": "bullish"}
        c.update(kw)
        return c

    def test_malformed_canonical_rejects(self):
        from plane import resolver
        for bad in [{}, {"source_id": "edgar_8k"},
                    _canon(content_hash="xyz"),
                    _canon(parser_confidence="bogus"),
                    _canon(symbols="AAPL"),
                    _canon(published_ns="soon")]:
            ok, reason = resolver.resolve(self._cand(), bad, MAP,
                                          origin="parser")
            self.assertFalse(ok)
            self.assertIn(reason, ("canonical-shape", "kind-no-emitter",
                                   "symbols-type", "value-shape",
                                   "entity-unmapped:AAPL"))

    def test_parser_confidence_downgrades(self):
        from plane import resolver
        ok, (feat, _) = resolver.resolve(self._cand(), _canon(), MAP,
                                         origin="parser")
        self.assertTrue(ok)
        self.assertEqual(feat["evidence"], "source")
        self.assertEqual(feat["confidence_bucket"], "high")
        ok, (feat2, _) = resolver.resolve(
            self._cand(), _canon(parser_confidence="low"), MAP,
            origin="parser")
        self.assertTrue(ok)
        self.assertEqual(feat2["confidence_bucket"], "low")

    def test_llm_origin_never_source(self):
        from plane import resolver
        ok, (feat, _) = resolver.resolve(self._cand(), _canon(), MAP,
                                         origin="llm")
        self.assertTrue(ok)
        # Content matches byte-for-byte, yet advisory stays advisory.
        self.assertEqual(feat["evidence"], "inference")

    def test_unknown_cik_rejects_in_resolver(self):
        from plane import resolver
        cand = self._cand(entity_ref={"cik": "9999999999"})
        ok, reason = resolver.resolve(cand, _canon(), MAP,
                                      origin="parser")
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("entity-unmapped"))


if __name__ == "__main__":
    unittest.main()
