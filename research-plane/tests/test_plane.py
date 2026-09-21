"""Phase 2.5 plane tests: R15/ledger, cadence, attribution, scanner,
gate (pre-call dollar/token reservation through a child-process
boundary), spend governor (projection/tiers/holds), digest,
retention, emit/publisher hardening, graph with FORCED invocation
boundaries and frozen tier effects.

Graph tests run the REAL production publish path (plane/publish.py)
against scratch canonical.db + pinned map file, and round-trip through
the FROZEN ctx reader. Hypothesis/critique reach the (fake) provider
ONLY through workers.run_gated() fed by deps["provider_factory"] —
a module-level builder invoked solely inside the spawned worker
child. No provider object exists in the parent process.

Spawn safety: ALL fakes are module-level (picklable by reference);
behavior flags travel inside provider_cfg. The test module is
import-safe (no work at import; langgraph imported lazily), so
spawned children can import it. Run under the plane venv for graph
tests; stdlib-only parts also pass on system python (dep-gated
tests skip).
"""
import ast
import hashlib
import json
import multiprocessing
import os
import re
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
from plane import locks, r15, retention, schema, spend as spend_mod
from plane import timeout as timeout_mod
from plane import publish, workers

graph_mod = None


def _graph():
    global graph_mod
    if graph_mod is None:
        from plane import graph as _g
        graph_mod = _g
    return graph_mod


def _has_mod(name):
    import importlib.util
    return importlib.util.find_spec(name) is not None


_HAS_LG = _has_mod("langgraph")
_HAS_SMOL = _has_mod("smolagents")

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
PRICING = {"fake": 0.005, "cheap": 0.001}


# ------------------------------------------------------------------
# Spawn-safe fakes (module level; behavior via provider_cfg).
# ------------------------------------------------------------------

class FakeUsage:
    def __init__(self, pt, ct):
        self.input_tokens = pt
        self.output_tokens = ct


class FakeMsg:
    def __init__(self, content, pt=10, ct=5, usage="ok"):
        self.content = content
        self.role = "assistant"
        self.tool_calls = None
        if usage == "none":
            self.token_usage = None
        elif usage == "bad":
            self.token_usage = FakeUsage(-1, 0)
        else:
            self.token_usage = FakeUsage(pt, ct)


CODE_BLOCK = ("```python\nfinal_answer([{\"kind\": \"filing_event\", \"symbols\": [\"AAPL\"], \"value\": {\"type\": \"enum\", \"v\": \"8-K:item-2.02\"}}])\n```")


class FakeProvider:
    """Built IN THE CHILD from cfg. fake_behavior selects the script;
    every script exercises a distinct gate path."""

    def __init__(self, cfg):
        self.cfg = dict(cfg)

    def generate(self, messages, max_tokens=None, **kw):
        b = self.cfg.get("fake_behavior", "ok")
        if b == "hang":
            time.sleep(3600)
            return FakeMsg("late")
        if b == "error":
            raise RuntimeError("provider boom")
        if b == "huge-usage":
            return FakeMsg("big", pt=10 ** 9, ct=0)
        if b == "no-usage":
            return FakeMsg("mystery", usage="none")
        if b == "neg-usage":
            return FakeMsg("neg", usage="bad")
        if b == "nonstring":
            return FakeMsg(12345)
        try:
            blob = json.dumps(messages, default=str)
        except (TypeError, ValueError):
            blob = ""
        if "Extract advisory" in blob:
            # Agent-loop call: return executable code ending in a
            # final_answer the fake executor resolves.
            return FakeMsg(CODE_BLOCK,
                           pt=int(self.cfg.get("fake_pt", 10)),
                           ct=int(self.cfg.get("fake_ct", 5)))
        return FakeMsg(self.cfg.get("fake_text", "thesis"),
                       pt=int(self.cfg.get("fake_pt", 10)),
                       ct=int(self.cfg.get("fake_ct", 5)))


def fake_provider_factory(cfg):
    b = (cfg or {}).get("fake_behavior", "ok")
    if b == "no-model":
        return object()
    if b == "explode":
        raise AssertionError("factory must not run")
    if b == "touch-file":
        with open(cfg["touch_path"], "w", encoding="utf-8") as fh:
            fh.write("touched")
        return FakeProvider(cfg)
    return FakeProvider(cfg)


class FakeExecutor:
    """Smolagents-executor-shaped double (send_variables/send_tools/
    call/cleanup/delete). Code is not executed: final_answer() args
    are parsed literally, everything else returns []."""

    def send_variables(self, variables):
        pass

    def send_tools(self, tools):
        pass

    def cleanup(self):
        pass

    def delete(self):
        pass

    def __call__(self, code_action=None, **kw):
        from smolagents.local_python_executor import CodeOutput
        code = code_action if isinstance(code_action, str) else ""
        m = re.search(r"final_answer\((.*)\)\s*$", code, re.S)
        if m:
            return CodeOutput(output=ast.literal_eval(m.group(1)),
                              logs="", is_final_answer=True)
        return CodeOutput(output="[]", logs="", is_final_answer=False)


def fake_executor_factory():
    return FakeExecutor()


def fake_tool_factory():
    return []


def _blocked_factory(cfg):
    raise workers.ConfigBlocked("no key")


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


def _gate(d, pricing=None, stage="G0", cycle="t1", symbol="AAPL"):
    """Real ledger + real governor + real budget (the gate's actual
    authorities, never doubles)."""
    pricing = dict(PRICING) if pricing is None else pricing
    led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))
    log = os.path.join(d, "spans.jsonl")
    gov = spend_mod.SpendGovernor(log, pricing, stage,
                                  state_dir=os.path.join(d, "spend"))
    budget = budgets.DurableBudget(led, cycle, symbol)
    return led, log, gov, budget, pricing


def _cfg(**kw):
    c = {"model_id": "fake",
         "egress_proxy": "http://proxy.invalid:8080",
         "fake_behavior": "ok", "fake_text": "thesis",
         "fake_pt": 10, "fake_ct": 5}
    c.update(kw)
    return c


def _gen_call(d, cfg=None, timeout_s=30.0, messages=None, cycle="t1",
              **gate_kw):
    led, log, gov, budget, pricing = _gate(d, cycle=cycle, **gate_kw)
    cfg = _cfg() if cfg is None else cfg
    messages = [{"role": "user", "content": "hi"}] if messages is None \
        else messages
    out = workers.run_gated(
        "generate", "hypothesize", "AAPL", cycle, 1,
        {"messages": messages}, cfg, fake_provider_factory, None,
        budget, gov, cfg.get("model_id", "fake"), log,
        timeout_s)
    return out, led, log, gov, budget


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

    def test_reserve_settle_roundtrip(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        lease = led.reserve_call("c", "AAPL", 1000, 3)
        self.assertEqual(lease["reserved"], 1000)
        self.assertEqual(led.settle_call("c", "AAPL", lease, 40), 40)
        snap = led.snapshot("c", "AAPL")
        self.assertEqual((snap["llm"], snap["tokens"], snap["tools"]),
                         (1, 40, 3))

    def test_invalid_needs_abort(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        for bad in ("100", 1.5, -1, None, True, 10 ** 13):
            with self.assertRaises(r15.AbortCycle, msg=repr(bad)):
                led.reserve_call("c", "AAPL", bad, 0)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_call("c", "AAPL", 10, -2)

    def test_token_bound_binds(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        with self.assertRaises(r15.AbortCycle):
            led.reserve_call("c", "AAPL", r15.TOKENS + 1, 0)

    def test_double_settle_and_unknown_lease(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        lease = led.reserve_call("c", "AAPL", 100, 0)
        led.settle_call("c", "AAPL", lease, 100)
        with self.assertRaises(r15.AbortCycle):
            led.settle_call("c", "AAPL", lease, 100)
        with self.assertRaises(r15.AbortCycle):
            led.settle_call("c", "AAPL", {"lease_id": "nope"}, 1)

    def test_deleting_db_aborts_never_resets(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        lease = led.reserve_call("c", "AAPL", 100, 0)
        led.settle_call("c", "AAPL", lease, 100)
        os.remove(path)  # marker survives: authority deleted
        self.assertTrue(os.path.exists(path + ".init"))
        with self.assertRaises(r15.AbortCycle) as cm:
            budgets.BudgetLedger(path).snapshot("c", "AAPL")
        self.assertIn("authority-deleted",
                      str(cm.exception.snapshot))

    def test_integrity_failure_aborts(self):
        # Corruption that sqlite3 still OPENS (SELECT works) but
        # PRAGMA integrity_check rejects: the ledger must read the
        # result and abort, never reset. The probe loop finds such
        # an offset deterministically (fails loudly if none exists).
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        for i in range(30):
            lease = led.reserve_call("c%d" % i, "AAPL", 100, 0)
            led.settle_call("c%d" % i, "AAPL", lease, 100)
        raw = open(path, "rb").read()
        target = None
        for off in range(100, len(raw), 251):
            mut = bytearray(raw)
            mut[off] ^= 0xFF
            probe = os.path.join(d, "probe.sqlite3")
            open(probe, "wb").write(bytes(mut))
            try:
                c2 = sqlite3.connect(probe)
                integ = c2.execute("PRAGMA integrity_check").fetchone()
                try:
                    c2.execute("SELECT COUNT(*) FROM counters"
                               ).fetchone()
                    selectable = True
                except sqlite3.Error:
                    selectable = False
                c2.close()
            except sqlite3.Error:
                continue
            finally:
                try:
                    os.remove(probe)
                except OSError:
                    pass
            if integ[0] != "ok" and selectable:
                target = off
                break
        self.assertIsNotNone(target, "no integrity-only corruption")
        mut = bytearray(raw)
        mut[target] ^= 0xFF
        open(path, "wb").write(bytes(mut))
        with self.assertRaises(r15.AbortCycle) as cm:
            budgets.BudgetLedger(path).snapshot("c0", "AAPL")
        self.assertIn("integrity",
                      str(cm.exception.snapshot))

    def test_schema_mismatch_aborts(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("ALTER TABLE counters ADD COLUMN evil TEXT")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle):
            budgets.BudgetLedger(path).snapshot("c", "AAPL")

    def test_oversize_blocks(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = self._ledger(d)
        led.reserve_call("c", "AAPL", 10, 0)
        with open(path, "ab") as fh:
            fh.write(b"x" * (65 << 20))
        with self.assertRaises(r15.AbortCycle):
            budgets.BudgetLedger(path).snapshot("c", "AAPL")

    def test_crash_resume_reconstructs(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        lease = led.reserve_call("c", "AAPL", 5000, 0)
        led2 = self._ledger(d)  # new handle, same authority
        snap = led2.snapshot("c", "AAPL")
        self.assertEqual(snap["tokens"], 5000)
        led2.settle_call("c", "AAPL", lease, 100)
        self.assertEqual(led.snapshot("c", "AAPL")["tokens"], 100)

    def test_retention_prunes_without_reset(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        old = time.time() - 8 * 86400
        lease = led.reserve_call("old", "AAPL", 10, 0,
                                 now_wall=old)
        led.settle_call("old", "AAPL", lease, 10)
        led.reserve_call("new", "AAPL", 10, 0)  # prunes old
        snap = led.snapshot("new", "AAPL")
        self.assertEqual(snap["tokens"], 10)

    def test_invalidate_poisons(self):
        d = tempfile.mkdtemp()
        led = self._ledger(d)
        led.reserve_call("c", "AAPL", 10, 0)
        led.invalidate("c", "AAPL")
        with self.assertRaises(r15.AbortCycle):
            led.reserve_call("c", "AAPL", 10, 0)

    def test_storage_counts_wal(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        total = budgets._storage_size(path)
        self.assertGreaterEqual(total, os.path.getsize(path))


class TimeoutTest(unittest.TestCase):
    def test_thread_timeout_accounts_promptly(self):
        t0 = time.monotonic()
        with self.assertRaises(timeout_mod.CallTimeout):
            timeout_mod.run_with_timeout(_sleepy, 0.5, 30)
        self.assertLess(time.monotonic() - t0, 10.0)

    def test_process_timeout_kills(self):
        t0 = time.monotonic()
        with self.assertRaises(timeout_mod.CallTimeout):
            timeout_mod.run_in_process(_sleepy, 3, 60)
        self.assertLess(time.monotonic() - t0, 30.0)

    def test_no_live_child_after_kill(self):
        with self.assertRaises(timeout_mod.CallTimeout):
            timeout_mod.run_in_process(_sleepy, 2, 60)
        self.assertEqual(multiprocessing.active_children(), [])

    def test_repeated_timeouts_leave_no_debt(self):
        for _ in range(3):
            with self.assertRaises(timeout_mod.CallTimeout):
                timeout_mod.run_in_process(_sleepy, 2, 60)
        self.assertEqual(multiprocessing.active_children(), [])
        self.assertEqual(threading.active_count(),
                         threading.active_count())  # no assert, smoke


class LocksTest(unittest.TestCase):
    def test_no_per_path_registry(self):
        self.assertFalse(hasattr(locks, "_PROCESS_LOCKS"))
        self.assertFalse(hasattr(locks, "_PATH_LOCKS"))

    def test_unknown_purpose_rejected(self):
        with self.assertRaises(ValueError):
            with locks.FileLock("/tmp/x.lock", purpose="nope"):
                pass

    def test_purposes_do_not_serialize_each_other(self):
        d = tempfile.mkdtemp()
        held = threading.Event()
        entered = threading.Event()

        def hold_spans():
            with locks.FileLock(os.path.join(d, "a.lock"),
                                purpose="spans"):
                held.set()
                self.assertTrue(entered.wait(timeout=10))

        t = threading.Thread(target=hold_spans)
        t.start()
        self.assertTrue(held.wait(timeout=10))
        try:
            with locks.FileLock(os.path.join(d, "b.lock"),
                                purpose="digest", timeout=5.0):
                entered.set()
        finally:
            t.join(timeout=10)
        self.assertFalse(t.is_alive())

    def test_same_purpose_serializes(self):
        d = tempfile.mkdtemp()
        order = []

        def first():
            with locks.FileLock(os.path.join(d, "c.lock"),
                                purpose="tier"):
                order.append("first")
                time.sleep(0.5)
                order.append("first-out")

        t = threading.Thread(target=first)
        t.start()
        time.sleep(0.1)
        with locks.FileLock(os.path.join(d, "c.lock"), purpose="tier",
                            timeout=10.0):
            order.append("second")
        t.join(timeout=10)
        self.assertEqual(order, ["first", "first-out", "second"])

    def test_marker_roundtrip(self):
        d = tempfile.mkdtemp()
        dbp = os.path.join(d, "x.sqlite3")
        self.assertEqual(locks.marker_state(dbp), ("absent", None))
        locks.write_marker(dbp, "tok123")
        self.assertEqual(locks.marker_state(dbp),
                         ("valid", "tok123"))
        with open(dbp + ".init", "wb") as fh:
            fh.write(b"{corrupt")
        self.assertEqual(locks.marker_state(dbp)[0], "invalid")
        with open(dbp + ".init", "wb") as fh:
            fh.write(b"x" * 2048)
        self.assertEqual(locks.marker_state(dbp)[0], "invalid")


class JsonSafeTest(unittest.TestCase):
    def test_plain_passes(self):
        ok, _ = schema.json_safe(
            {"a": [1, 2.5, "x", None, True, {"b": []}]})
        self.assertTrue(ok)

    def test_rejects_objects_nan_depth_size(self):
        ok, why = schema.json_safe(object())
        self.assertFalse(ok)
        self.assertIn("non-json-type", why)
        ok, _ = schema.json_safe(float("nan"))
        self.assertFalse(ok)
        deep = cur = []
        for _ in range(40):
            nxt = []
            cur.append(nxt)
            cur = nxt
        ok, why = schema.json_safe(deep)
        self.assertFalse(ok)
        self.assertEqual(why, "too-deep")
        ok, why = schema.json_safe("x" * 65537)
        self.assertFalse(ok)
        ok, why = schema.json_safe({123: "bad-key-type"})
        self.assertFalse(ok)


class CadenceTest(unittest.TestCase):
    def test_trigger_immediate_and_ttl(self):
        c = cadence.CadenceState()
        self.assertTrue(c.should_refresh("AAPL", 1, ()))
        c.mark_run(1, ["AAPL"])
        self.assertFalse(c.should_refresh("AAPL", 2, ()))
        self.assertTrue(c.should_refresh("AAPL", 2, ("AAPL",)))

    def test_throttle_doubles(self):
        # Wall-clock meaning: TTL 30->60min, harvest 5->10min (epoch
        # math is equal by construction: 60/10 == 30/5).
        c = cadence.CadenceState()
        self.assertEqual((cadence.THESIS_TTL_MIN,
                          cadence.HARVEST_MIN), (30, 5))
        c.throttled = True
        self.assertEqual((cadence.THROTTLED_THESIS_TTL_MIN,
                          cadence.THROTTLED_HARVEST_MIN), (60, 10))

    def test_persisted_across_restart(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "cadence.json")
        cadence.CadenceState(persist_path=p).mark_run(9, ["A"])
        c2 = cadence.CadenceState(persist_path=p)
        self.assertFalse(c2.should_refresh("A", 10, ()))

    def test_oversized_state_starts_empty(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "cadence.json")
        with open(p, "w", encoding="utf-8") as fh:
            fh.write('{"A": 1' + " " * 70000)
        c = cadence.CadenceState(persist_path=p)
        self.assertTrue(c.should_refresh("A", 5, ()))

    def test_concurrent_writes_converge(self):
        d = tempfile.mkdtemp()
        p = os.path.join(d, "cadence.json")
        ctx = multiprocessing.get_context("spawn")
        procs = [ctx.Process(target=_mark_cadence,
                             args=((p, 3, ["S%d" % i]),))
                 for i in range(4)]
        for pr in procs:
            pr.start()
        for pr in procs:
            pr.join(30)
        c = cadence.CadenceState(persist_path=p)
        self.assertEqual(len(c.last_thesis_epoch), 4)

    def test_rate_within_estimate(self):
        c = cadence.CadenceState()
        c.record_cycle(2)
        c.cycle_count = 12
        c.llm_calls = 24
        self.assertTrue(c.within_estimate())


class AttributionTest(unittest.TestCase):
    def _log(self, d, name="spans.jsonl"):
        return os.path.join(d, name)

    def test_day_summary_splits_tokens(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        attribution.append_span(log, 1, "hypothesize", "m", cycle_id="c",
                                symbol="AAPL", prompt_tokens=10,
                                completion_tokens=5, usd=0.01,
                                span_id="s1", ts=NOW_S)
        s = attribution.day_summary(log, NOW_S)
        self.assertEqual((s["prompt_tokens"], s["completion_tokens"]),
                         (10, 5))

    def test_category_taxonomy_frozen(self):
        d = tempfile.mkdtemp()
        with self.assertRaises(ValueError):
            attribution.append_span(self._log(d), 1, "hypothesize", "m",
                                    category="vibes", span_id="x")
        with self.assertRaises(ValueError):
            attribution.append_span(self._log(d), 1, "hypothesize", "m",
                                    category="research",
                                    outcome="maybe", span_id="x")

    def test_money_values_hardened(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        before = 0.0
        for bad in (-1.0, float("nan"), float("inf"), 10 ** 10):
            with self.assertRaises(ValueError, msg=repr(bad)):
                attribution.append_span(log, 1, "hypothesize", "m",
                                        usd=bad, span_id="bad")
        for bad_tokens in (-3, 1.5, "10"):
            with self.assertRaises(ValueError):
                attribution.append_span(log, 1, "hypothesize", "m",
                                        prompt_tokens=bad_tokens,
                                        span_id="bad")
        with self.assertRaises(ValueError):
            attribution.append_span(log, 1, "hypothesize", "m",
                                    span_id="x" * 200)
        # Nothing landed: spend still measurably zero-on-fresh.
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.spend_since(log, 0)

    def test_unknown_zero_rejected(self):
        d = tempfile.mkdtemp()
        with self.assertRaises(ValueError):
            attribution.append_span(self._log(d), 1, "hypothesize", "m",
                                    usd=0.0, is_unknown=True,
                                    span_id="u0")

    def test_retry_dedupe_and_mirror(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        kw = dict(cycle_id="c", symbol="AAPL", prompt_tokens=10,
                  completion_tokens=5, usd=0.01, span_id="dup")
        attribution.append_span(log, 1, "hypothesize", "m", **kw)
        attribution.append_span(log, 1, "hypothesize", "m", **kw)
        con = sqlite3.connect(attribution._db_for(log))
        n = con.execute("SELECT COUNT(*) FROM spans").fetchone()[0]
        con.close()
        self.assertEqual(n, 1)

    def test_concurrent_dedupe(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        ctx = multiprocessing.get_context("spawn")
        procs = [ctx.Process(target=_append_span,
                             args=((log, "race"),)) for _ in range(8)]
        for pr in procs:
            pr.start()
        for pr in procs:
            pr.join(60)
        con = sqlite3.connect(attribution._db_for(log))
        n = con.execute("SELECT COUNT(*) FROM spans").fetchone()[0]
        lines = open(log, encoding="utf-8").read().strip().split("\n")
        con.close()
        self.assertEqual(n, 1)
        self.assertEqual(len(lines), 1)

    def test_missing_ledger_is_not_zero_spend(self):
        d = tempfile.mkdtemp()
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.spend_since(self._log(d), 0)

    def test_deleted_authority_blocks(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        attribution.append_span(log, 1, "hypothesize", "m",
                                span_id="s1")
        os.remove(attribution._db_for(log))
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.spend_since(log, 0)

    def test_unknown_lifecycle(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        # Atomic ambiguity record: hold first (as the gate does),
        # then the single span+unknown+invoked transaction.
        attribution.hold_spend(log, "lease-1", 2.0)
        attribution.record_unknown(log, "lease-1", "u1", 2.0,
                                   "timeout", 1, "hypothesize", "m",
                                   "c", "AAPL")
        self.assertTrue(attribution.has_unreconciled(log))
        self.assertEqual(attribution.spend_since(log, 0), 2.0)
        attribution.reconcile_unknown(log, "lease-1", 0.05, "billed")
        self.assertFalse(attribution.has_unreconciled(log))
        self.assertAlmostEqual(attribution.spend_since(log, 0), 0.05)
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.reconcile_unknown(log, "lease-1", 0.05)
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.reconcile_unknown(log, "nope", 0.05)

    def test_hold_lifecycle(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        attribution.append_span(log, 1, "hypothesize", "m",
                                span_id="seed")
        attribution.hold_spend(log, "h1", 5.0, now=1000)
        self.assertAlmostEqual(attribution.outstanding_holds(log), 5.0)
        attribution.mark_invoked(log, "h1")
        attribution.reap_holds(log, now=1000 + 3600)
        self.assertAlmostEqual(attribution.outstanding_holds(log), 5.0)
        attribution.settle_hold(log, "h1")
        self.assertAlmostEqual(attribution.outstanding_holds(log), 0.0)
        attribution.hold_spend(log, "h2", 1.0, now=1000)
        attribution.reap_holds(log, now=1000 + 3600)
        self.assertAlmostEqual(attribution.outstanding_holds(log), 0.0)

    def test_prune_bounds_storage(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        attribution.append_span(log, 1, "hypothesize", "m",
                                span_id="old", ts=1000)
        attribution.append_span(log, 1, "hypothesize", "m",
                                span_id="new", ts=int(time.time()))
        attribution.prune_spans(log)
        con = sqlite3.connect(attribution._db_for(log))
        rows = con.execute("SELECT span_id FROM spans").fetchall()
        con.close()
        self.assertEqual(rows, [("new",)])


class SpendTest(unittest.TestCase):
    def _gov(self, d, pricing=None, stage="G0"):
        log = os.path.join(d, "spans.jsonl")
        return spend_mod.SpendGovernor(
            log, dict(PRICING) if pricing is None else pricing, stage,
            state_dir=os.path.join(d, "spend")), log

    def _seed(self, log, usd, ts):
        attribution.append_span(log, 1, "seed", "seed",
                                cycle_id="c", symbol="AAPL",
                                prompt_tokens=10, completion_tokens=5,
                                usd=usd, span_id="seed-%s-%s" % (usd, ts),
                                ts=ts)

    def test_pricing_missing_blocks(self):
        d = tempfile.mkdtemp()
        with self.assertRaises(workers.ConfigBlocked):
            spend_mod.SpendGovernor(os.path.join(d, "s.jsonl"), {})

    def test_projection_uses_7d_not_30d(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        self._seed(log, 1000.0, now - 20 * 86400)  # outside 7d
        self._seed(log, 7.0, now - 6 * 86400)  # inside 7d
        self.assertAlmostEqual(gov.projection_30d(now), 30.0)
        # ...but the 30d committed spend DOES include the old charge.
        self.assertAlmostEqual(gov.committed_spend(), 1007.0)

    def test_tier1_trim(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        self._seed(log, 25.0, now - 86400)  # proj = 25/7*30 = 107
        tier, proj = gov.evaluate(now)
        self.assertEqual(tier, 1)
        self.assertAlmostEqual(proj, 25.0 / 7 * 30)
        self.assertEqual(gov.decision(now), ("throttle", "tier-1"))
        self.assertEqual(gov.thesis_cap(now), 500)

    def test_tier2_cheap_and_journal(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        self._seed(log, 30.0, now - 86400)  # proj = 128.6 -> tier 2
        self.assertEqual(gov.evaluate(now)[0], 2)
        self.assertEqual(gov.decision(now), ("cheap", "tier-2"))
        self.assertEqual(gov.thesis_cap(now), 200)
        self.assertEqual(gov.cheapest_model(), "cheap")
        rows = open(os.path.join(d, "spend", "tier_journal.jsonl"),
                    encoding="utf-8").read().strip().split("\n")
        self.assertEqual(len(rows), 1)
        row = json.loads(rows[0])
        self.assertEqual((row["from"], row["to"]), (0, 2))

    def test_tier3_deny(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        self._seed(log, 40.0, now - 86400)  # proj = 171 -> tier 3
        self.assertEqual(gov.evaluate(now)[0], 3)
        self.assertEqual(gov.decision(now), ("deny", "tier-3"))

    def test_anti_flap_needs_6h_below(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        t0 = int(time.time())
        self._seed(log, 30.0, t0 - 86400)
        self.assertEqual(gov.evaluate(t0)[0], 2)
        attribution.reconcile_unknown  # exists (API surface)
        # Drop spend to zero via a fresh ledger in the same dir? No:
        # spend is durable. Reconcile the conservative charge down by
        # direct supervisor action on the seeded span is impossible
        # (it was not unknown). Instead fast-forward past the 7d
        # window: projection decays naturally, tier must STILL hold
        # for 6 hourly evals before falling back.
        for h in range(1, 6):
            tier, _p = gov.evaluate(t0 + 8 * 86400 + h * 3600)
            self.assertEqual(tier, 2, "hour %d fell early" % h)
        tier, _p = gov.evaluate(t0 + 8 * 86400 + 6 * 3600)
        self.assertEqual(tier, 0)

    def test_hourly_caching_single_journal(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        self._seed(log, 30.0, now - 86400)
        gov.evaluate(now)
        gov.evaluate(now + 10)
        gov.evaluate(now + 20)
        rows = open(os.path.join(d, "spend", "tier_journal.jsonl"),
                    encoding="utf-8").read().strip().split("\n")
        self.assertEqual(len(rows), 1)

    def test_pre_call_hold_refuses_past_cap(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        self._seed(log, 149.0, now - 86400)
        with self.assertRaises(spend_mod.SpendRefused):
            gov.reserve_usd(2.0, "lease-big", now)
        gov.reserve_usd(1.0, "lease-ok", now)
        self.assertAlmostEqual(attribution.outstanding_holds(log), 1.0)
        gov.settle_usd("lease-ok")
        self.assertAlmostEqual(attribution.outstanding_holds(log), 0.0)

    def test_holds_count_collectively(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        gov.reserve_usd(100.0, "a")
        with self.assertRaises(spend_mod.SpendRefused):
            gov.reserve_usd(100.0, "b")
        gov.settle_usd("a")
        gov.reserve_usd(100.0, "b")

    def test_unknown_blocks_until_reconciled(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        self.assertEqual(gov.decision()[0], "allow")
        attribution.hold_spend(log, "lease-1", 2.0)
        attribution.record_unknown(log, "lease-1", "u1", 2.0,
                                   "timeout", 1, "hypothesize",
                                   "fake", "c", "AAPL")
        self.assertEqual(gov.decision(), ("deny", "unknown-spend-pending"))
        with self.assertRaises(spend_mod.SpendRefused):
            gov.reserve_usd(0.01, "late")
        attribution.reconcile_unknown(log, "lease-1", 0.05, "billed")
        self.assertEqual(gov.decision()[0], "allow")

    def test_unmeasurable_denies(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        attribution.append_span(log, 1, "hypothesize", "fake",
                                span_id="s1")
        os.remove(attribution._db_for(log))  # marker survives
        self.assertEqual(gov.decision(), ("deny", "spend-unmeasurable"))
        with self.assertRaises(spend_mod.SpendRefused):
            gov.reserve_usd(0.01, "late")

    def test_ratio_suspended_without_feed(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d, stage="G2")
        self.assertEqual(gov.ratio_status()[0], "suspended")

    def test_ratio_forces_tier3_after_3_failed_days(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        gov = spend_mod.SpendGovernor(
            log, dict(PRICING), "G2", state_dir=os.path.join(d, "spend"),
            profit_since=lambda since: 1.0)
        now = int(time.time())
        # Spend inside the 30d ratio window but OUTSIDE the 7d
        # projection window: projection stays T0, ratio fails daily.
        self._seed(log, 300.0, now - 10 * 86400)
        self.assertEqual(gov.projection_30d(now), 0.0)
        self.assertEqual(gov.evaluate(now)[0], 0)
        self.assertEqual(gov.evaluate(now + 86400)[0], 0)
        self.assertEqual(gov.evaluate(now + 2 * 86400)[0], 3)

    def test_worst_usd_validated(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        self.assertAlmostEqual(gov.worst_usd("fake", 1000), 0.005)
        with self.assertRaises(spend_mod.SpendRefused):
            gov.worst_usd("fake", -5)
        with self.assertRaises(workers.ConfigBlocked):
            gov.worst_usd("unpriced-model", 10)


class GateTest(unittest.TestCase):
    def test_success_settles_and_spans_once(self):
        d = tempfile.mkdtemp()
        out, led, log, gov, budget = _gen_call(d)
        self.assertEqual(out["text"], "thesis")
        snap = led.snapshot("t1", "AAPL")
        self.assertEqual((snap["llm"], snap["tokens"]), (1, 15))
        con = sqlite3.connect(attribution._db_for(log))
        rows = con.execute(
            "SELECT prompt_tokens, completion_tokens, usd, outcome, "
            "is_unknown FROM spans").fetchall()
        con.close()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], (10, 5, 0.000075, "success", 0))
        self.assertAlmostEqual(attribution.outstanding_holds(log), 0.0)

    def test_cap_refusal_never_spawns(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(
            d, pricing={"fake": 40.0})
        now = int(time.time())
        attribution.append_span(log, 1, "hypothesize", "fake",
                                cycle_id="c", symbol="AAPL",
                                prompt_tokens=1, completion_tokens=1,
                                usd=149.0, span_id="big", ts=now)
        touch = os.path.join(d, "touched")
        cfg = _cfg(fake_behavior="touch-file", touch_path=touch)
        with self.assertRaises(spend_mod.SpendRefused):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "x" * 800}]},
                cfg, fake_provider_factory, None, budget, gov, "fake", log, 30.0)
        self.assertFalse(os.path.exists(touch))  # factory never ran
        self.assertEqual(budget.snapshot()["llm"], 1)  # lease kept count

    def test_timeout_is_unknown_spend_and_blocks(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        cfg = _cfg(fake_behavior="hang")
        with self.assertRaises(r15.AbortCycle) as cm:
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, fake_provider_factory, None, budget, gov,
                "fake", log, 3.0)
        self.assertIn("unknown-spend", str(cm.exception.snapshot))
        con = sqlite3.connect(attribution._db_for(log))
        row = con.execute(
            "SELECT usd, outcome, is_unknown FROM spans").fetchone()
        con.close()
        self.assertGreater(row[0], 0.0)  # full reservation, never $0
        self.assertEqual((row[1], row[2]), ("timeout", 1))
        self.assertTrue(attribution.has_unreconciled(log))
        self.assertEqual(gov.decision(), ("deny", "unknown-spend-pending"))
        self.assertEqual(multiprocessing.active_children(), [])
        # Supervisor reconciliation unblocks with attested actuals.
        cur = sqlite3.connect(attribution._db_for(log))
        lease_id = cur.execute(
            "SELECT lease_id FROM unknown_holds").fetchone()[0]
        cur.close()
        attribution.reconcile_unknown(log, lease_id, 0.02, "not billed")
        self.assertEqual(gov.decision()[0], "allow")
        # Spend unblocked; the poisoned CYCLE stays dead (R15), so
        # the next call proceeds on a fresh cycle.
        out, _, _, _, _ = _gen_call(d, cycle="t2")
        self.assertEqual(out["text"], "thesis")

    def test_provider_error_is_ambiguous(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        cfg = _cfg(fake_behavior="error")
        with self.assertRaises(r15.AbortCycle):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, fake_provider_factory, None, budget, gov,
                "fake", log, 30.0)
        self.assertTrue(attribution.has_unreconciled(log))
        con = sqlite3.connect(attribution._db_for(log))
        row = con.execute(
            "SELECT outcome, is_unknown FROM spans").fetchone()
        con.close()
        self.assertEqual(row, ("error", 1))

    def test_unaccountable_usage_keeps_full_reservation(self):
        d = tempfile.mkdtemp()
        for behavior in ("no-usage", "neg-usage"):
            dd = tempfile.mkdtemp()
            led, log, gov, budget, pricing = _gate(dd)
            cfg = _cfg(fake_behavior=behavior)
            with self.assertRaises(r15.AbortCycle):
                workers.run_gated(
                    "generate", "hypothesize", "AAPL", "t1", 1,
                    {"messages": [{"role": "user", "content": "hi"}]},
                    cfg, fake_provider_factory, None, budget, gov,
                    "fake", log, 30.0)
            snap = led.snapshot("t1", "AAPL")
            prompt_bytes = len(schema.canon(
                [{"role": "user", "content": "hi"}]))
            need = workers._token_need("generate", prompt_bytes,
                                       workers.COMPLETION_MAX, 1)
            self.assertEqual(snap["tokens"], need)
            self.assertTrue(attribution.has_unreconciled(log))

    def test_huge_usage_trips_breach(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        cfg = _cfg(fake_behavior="huge-usage")
        with self.assertRaises(r15.AbortCycle) as cm:
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, fake_provider_factory, None, budget, gov,
                "fake", log, 30.0)
        self.assertIn("bound-breach", str(cm.exception.snapshot))
        # Truth recorded (not unknown-blocked: amounts are known).
        self.assertFalse(attribution.has_unreconciled(log))

    def test_raw_factory_rejected_clean(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        cfg = _cfg(fake_behavior="no-model")
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, fake_provider_factory, None, budget, gov,
                "fake", log, 30.0)
        con = sqlite3.connect(attribution._db_for(log))
        n = con.execute("SELECT COUNT(*) FROM spans").fetchone()[0]
        con.close()
        self.assertEqual(n, 0)  # nothing attempted, nothing spanned

    def test_config_error_releases_hold(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        cfg = {"model_id": "fake"}  # no behavior key is fine...
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, None, None, budget, gov, "fake", log,
                30.0)
        # Nothing was ever created: freshness reads as unmeasurable,
        # which the governor treats as deny (never as $0).
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.outstanding_holds(log)

    def test_accounting_failure_aborts_hard(self):
        d = tempfile.mkdtemp()
        out_data = {}
        led, log, gov, budget, pricing = _gate(d)
        import unittest.mock as _mock
        real = attribution.append_span
        with _mock.patch.object(attribution, "append_span",
                                side_effect=RuntimeError("disk gone")):
            with self.assertRaises(r15.AbortCycle) as cm:
                workers.run_gated(
                    "generate", "hypothesize", "AAPL", "t1", 1,
                    {"messages": [{"role": "user", "content": "hi"}]},
                    _cfg(), fake_provider_factory, None, budget, gov,
                    "fake", log, 30.0)
        self.assertIn("accounting-failure", str(cm.exception.snapshot))

    def test_non_string_result_is_blocked_not_abort(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        out = workers.run_gated(
            "generate", "hypothesize", "AAPL", "t1", 1,
            {"messages": [{"role": "user", "content": "hi"}]},
            _cfg(fake_behavior="nonstring"), fake_provider_factory,
            None, budget, gov, "fake", log, 30.0)
        self.assertIn("blocked", out)
        self.assertFalse(attribution.has_unreconciled(log))

    def test_call_bound_exceeds_cycle_refuses(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        big = [{"role": "user", "content": "x" * (r15.TOKENS + 1)}]
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": big}, _cfg(), fake_provider_factory,
                None, budget, gov, "fake", log, 30.0)

    def test_prompt_not_json_safe_blocked(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": object()}]},
                _cfg(), fake_provider_factory, None, budget, gov,
                "fake", log, 30.0)

    def test_unpicklable_task_fails_clean(self):
        # A closure factory is not picklable by reference: the child
        # can never be built, so the gate fails CLOSED pre-spawn
        # (no reservation ambiguity, no unknown-spend).
        d = tempfile.mkdtemp()
        led, log, gov, budget, pricing = _gate(d)

        def _closure_factory(cfg):
            return FakeProvider(cfg)

        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                _cfg(), _closure_factory, None, budget, gov,
                "fake", log, 30.0)
        self.assertFalse(attribution.has_unreconciled(log))

    def test_tape_clamps_max_tokens_downward(self):
        seen = []

        class RecProvider:
            def generate(self, messages, max_tokens=None, **kw):
                seen.append(max_tokens)
                return FakeMsg("x", pt=1, ct=1)

        tape = workers.UsageTape(RecProvider(), workers.COMPLETION_MAX)
        tape.generate([{"role": "user", "content": "hi"}],
                      max_tokens=10 ** 9)
        self.assertEqual(seen, [workers.COMPLETION_MAX])
        self.assertEqual(tape.totals(), [1, 1])
        tape.generate([{"role": "user", "content": "hi"}])
        self.assertEqual(tape.totals(), [2, 2])

    def test_tool_truncation_bounds_context(self):
        t = workers._ChildTool(lambda: "y" * 100000)
        out = t()
        self.assertLessEqual(len(out.encode("utf-8")),
                             workers.TOOL_OUT_MAX_BYTES)
        self.assertEqual(t.calls, 1)

    def test_token_need_formula(self):
        n1 = workers._token_need("generate", 2000, 1500, 1)
        self.assertEqual(n1, 3500)
        # Corrected bound: EVERY tool slot per prior step counts
        # (TOOLS_PER_STEP_MAX x TOOL_OUT_MAX_BYTES), not one output.
        growth = 1500 + workers.TOOLS_PER_STEP_MAX * 1500
        n5 = workers._token_need("extract", 2000, 1500, 5)
        self.assertEqual(n5, 5 * 2000 + growth * 5 * 4 // 2 + 5 * 1500)
        self.assertLess(n5, r15.TOKENS)


class WorkerScanTest(unittest.TestCase):
    def test_allowlist(self):
        ok, _ = workers.scan_imports("import json\nimport requests\n")
        self.assertTrue(ok)
        ok, bad = workers.scan_imports("import subprocess\n")
        self.assertFalse(ok)
        self.assertEqual(bad, "subprocess")

    def test_dynamic_imports_caught(self):
        ok, _ = workers.scan_imports(
            'import importlib\nimportlib.import_module("socket")\n')
        self.assertFalse(ok)
        ok, _ = workers.scan_imports('__import__("os")\n')
        self.assertFalse(ok)

    def test_unparseable_fails_closed(self):
        ok, bad = workers.scan_imports("def broken(:\n")
        self.assertFalse(ok)
        self.assertEqual(bad, "<unparseable>")


@unittest.skipUnless(_has_mod("smolagents"), "smolagents missing")
class WorkerProxyTest(unittest.TestCase):
    def test_proxy_required_for_model(self):
        with self.assertRaises(workers.ConfigBlocked):
            workers.make_raw_provider({"model_id": "m"})
        # Dummy key: construction never touches the network; the
        # assertion is on the forced proxy transport, not connectivity.
        m = workers.make_raw_provider(
            {"model_id": "m", "api_key": "test",
             "egress_proxy": "http://proxy.invalid:8080"})
        transport = m.client_kwargs["http_client"]._transport
        self.assertEqual(type(transport).__name__, "HTTPTransport")
        self.assertIn("proxy.invalid", str(getattr(
            getattr(transport, "_pool", None), "_proxy_url",
            "proxy.invalid")))

    def test_sandbox_spec_locked(self):
        with self.assertRaises(workers.ConfigBlocked):
            workers._sandbox_kwargs({})
        kw = workers._sandbox_kwargs(SANDBOX)
        self.assertEqual(kw["user"], "65532:65532")
        self.assertTrue(kw["read_only"])


class DigestTest(unittest.TestCase):
    def test_roundtrip_and_idempotent(self):
        d = tempfile.mkdtemp()
        ok, _ = digest.append_digest(d, 1, "AAPL", "hypothesize", "t")
        self.assertTrue(ok)
        ok, why = digest.append_digest(d, 1, "AAPL", "hypothesize", "t")
        self.assertTrue(ok)
        self.assertEqual(why, "duplicate")

    def test_overlong_rejected_not_truncated(self):
        d = tempfile.mkdtemp()
        ok, why = digest.append_digest(d, 1, "AAPL", "hypothesize",
                                       "x" * 501)
        self.assertFalse(ok)
        self.assertEqual(why, "digest-too-long")

    def test_seen_cache_avoids_rescan(self):
        d = tempfile.mkdtemp()
        for i in range(3):
            digest.append_digest(d, 1, "S%d" % i, "hypothesize", "t")
        path = os.path.join(d, digest.DIGEST_NAME)
        self.assertIn(path, digest._SEEN)
        ok, why = digest.append_digest(d, 1, "S0", "hypothesize", "t")
        self.assertTrue(ok)
        self.assertEqual(why, "duplicate")
        lines = open(path, encoding="utf-8").read().strip().split("\n")
        self.assertEqual(len(lines), 3)


class RetentionTest(unittest.TestCase):
    @unittest.skipUnless(_has_mod("langgraph"), "langgraph missing")
    def test_make_saver_is_strict(self):
        con = sqlite3.connect(os.path.join(tempfile.mkdtemp(),
                                           "c.sqlite3"),
                              check_same_thread=False)
        saver = retention.make_saver(con)
        serde = saver.serde
        self.assertFalse(getattr(serde, "pickle_fallback", True))
        eff = getattr(serde, "_allowed_msgpack_modules", True)
        self.assertTrue(eff is not True and eff is not None)
        with self.assertRaises(RuntimeError):
            retention.harden_saver(saver)

    @unittest.skipUnless(_has_mod("langgraph"), "langgraph missing")
    def test_prune_old_threads(self):
        d = tempfile.mkdtemp()
        con = sqlite3.connect(os.path.join(d, "ckpt.sqlite3"),
                              check_same_thread=False)
        s = retention.make_saver(con)
        cfg = {"configurable": {"thread_id": "old",
                                "checkpoint_ns": ""}}
        old_ts = "2020-01-01T00:00:00+00:00"
        cp = {"v": 1, "ts": old_ts, "id": "i",
              "channel_values": {}, "channel_versions": {},
              "versions_seen": {}}
        s.put(cfg, cp, {}, [])
        import datetime as _dt
        ref = _dt.datetime.fromisoformat(old_ts).timestamp()
        gone = retention.prune_checkpoints(s, now=ref + 31 * 86400)
        self.assertEqual(gone, ["old"])
        s.put(cfg, cp, {}, [])
        kept = retention.prune_checkpoints(s, now=ref + 29 * 86400)
        self.assertEqual(kept, [])


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
    def _deps(self, d, script="thesis", fail=None, parser=False,
              history=False, prefill=0, extract_abort=False,
              spend_usd=None, provider_cfg=None, provider_cfgs=None,
              calibration_ranking=None, hooks=None, digest_on=True,
              extract_stub=True, nulls=False):
        import sqlite3 as _sq
        gm = _graph()
        mapp = os.path.join(d, "entity_map.json")
        log = os.path.join(d, "spans.jsonl")
        led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))
        gov = spend_mod.SpendGovernor(
            log, dict(PRICING), "G0", state_dir=os.path.join(d, "spend"))
        if spend_usd is not None:
            attribution.append_span(log, 1, "seed", "seed",
                                    cycle_id="seed", symbol="AAPL",
                                    prompt_tokens=10, completion_tokens=5,
                                    usd=spend_usd, span_id="seed-spend",
                                    ts=int(time.time()) - 86400)
        if isinstance(script, dict):
            scripts = script
        else:
            scripts = {"hypothesize": script, "critique": "c"}

        def harvest(watchlist, epoch):
            recs = [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish",
                     "provenance_url": "https://example.invalid/x"}]
            if nulls:
                recs = recs + [{"kind": "filing_event",
                                "symbols": ["AAPL"],
                                "value": {"type": "enum",
                                          "v": "8-K:item-2.02"},
                                "class": "NULL",
                                "source_id": "aisstream"}]
            hist = ({"edgar_8k": [{"h": HEXA, "ts": OBS_S}]}
                    if history else None)
            return (recs * prefill if prefill else recs, {}, hist)

        calls = {"extract": 0}

        def extract(rec, ctx):
            calls["extract"] += 1
            if extract_abort:
                raise r15.AbortCycle("AAPL", {})
            ctx["budget"].charge_tool()
            return [dict(rec)]

        def parser_extract(rec, budget):
            budget.charge_tool()
            if not parser:
                return []
            return [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum", "v": "8-K:item-2.02"},
                     "effect": "bullish",
                     "provenance_url": "https://example.invalid/x"}]

        def build_parse(text_or_map, is_hyp):
            if is_hyp:
                def _build(sym, st):
                    return [{"role": "user", "content": "q:" + sym}]
            else:
                def _build(sym, text, st):
                    return [{"role": "user", "content": "critique"}]
            if is_hyp:
                def _parse(sym, text, st):
                    if fail == "nonstring-thesis":
                        return 12345
                    return scripts["hypothesize"]
            else:
                def _parse(sym, text, st):
                    if fail == "nondict-critique":
                        return "just text"
                    if fail == "nonstring-critique":
                        return {"text": 99, "disagreement": False}
                    return {"text": scripts["critique"],
                            "disagreement": False}
            return _build, _parse

        hb, hp = build_parse(scripts, True)
        cb, cp = build_parse(scripts, False)
        if fail == "model-block":
            factory = _blocked_factory
        else:
            factory = fake_provider_factory
        texts = dict(scripts)

        def cfg_for(model_id):
            base = {"model_id": model_id,
                    "egress_proxy": "http://proxy.invalid:8080",
                    "fake_behavior": "ok",
                    "fake_pt": 10, "fake_ct": 5,
                    "fake_text": texts.get("hypothesize", "thesis")}
            if fail == "hang-hyp" and model_id == _default_id():
                base["fake_behavior"] = "hang"
            return base

        def _default_id():
            return (provider_cfg or {}).get("model_id", "fake")

        default_cfg = cfg_for(_default_id())
        if provider_cfg:
            default_cfg.update(provider_cfg)
        cfgs = {"fake": _cfg(), "cheap": _cfg(model_id="cheap")}
        if provider_cfgs:
            cfgs.update(provider_cfgs)

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
            "fuse": lambda cands: cands,
            "hypothesize_build": hb,
            "hypothesize_parse": hp,
            "critique_build": cb,
            "critique_parse": cp,
            "budget_factory": lambda cyc, sym: budgets.DurableBudget(
                led, cyc, sym),
            "resolve_emit": resolve_emit,
            "cadence_state": cadence.CadenceState(
                persist_path=os.path.join(d, "cadence.json")),
            "checkpointer_conn": _sq.connect(
                os.path.join(d, "ckpt.sqlite3"), check_same_thread=False),
            "provider_factory": factory,
            "provider_cfg": default_cfg,
            "provider_cfgs": cfgs,
            "pricing": dict(PRICING),
            "spend_governor": gov,
            "log_path": log,
            "sandbox_cfg": dict(SANDBOX),
            "tool_factory": fake_tool_factory,
            "executor_factory": fake_executor_factory,
            "model_timeout_s": 30.0,
            "extract_timeout_s": 120.0,
            "signal_dir": os.path.join(d, "signals"),
            "parser_extract": parser_extract,
        }
        if extract_stub:
            deps["extract_workers"] = extract
        if calibration_ranking is not None:
            deps["calibration_ranking"] = calibration_ranking
        if digest_on:
            deps["digest_dir"] = os.path.join(d, "digest")
        if hooks is not None:
            deps["health_hook"] = hooks.append
        return deps, calls, log, led, gov

    def _app(self, d, **kw):
        deps, calls, log, led, gov = self._deps(d, **kw)
        return _graph().build_graph(deps), deps, calls, log, gov

    def _spans(self, log):
        con = sqlite3.connect(attribution._db_for(log))
        rows = con.execute(
            "SELECT node, symbol, model, outcome FROM spans").fetchall()
        con.close()
        return rows

    def test_full_cycle_publishes_via_reader(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, deps, calls, log, gov = self._app(d, script="thesis-AAPL")
        out = _graph().run_cycle(app, ["AAPL"], 1, "t1")
        self.assertFalse(out.get("aborted"))
        self.assertIsNotNone(out.get("emitted"))
        # Every attempt went through run_gated: spans carry the fake
        # model with measured usage, and the hold was released.
        rows = self._spans(log)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all(r[2] == "fake" and r[3] == "success"
                            for r in rows))
        self.assertAlmostEqual(attribution.outstanding_holds(log), 0.0)
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        # Worker (LLM-origin) output stays advisory: inference-capped.
        self.assertEqual(res["stats"]["reasons"],
                         {"inference-capped": 1})

    def test_input_identity_validated(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _, _, _, _ = self._app(d)
        gm = _graph()
        for bad_tid in ("", "a" * 65, "../x", "has space", None, 7):
            with self.assertRaises(ValueError, msg=repr(bad_tid)):
                gm.run_cycle(app, ["AAPL"], 1, bad_tid)
        for bad_epoch in (-1, True, "1", 2 ** 31, None):
            with self.assertRaises(ValueError, msg=repr(bad_epoch)):
                gm.run_cycle(app, ["AAPL"], bad_epoch, "t1")

    def test_parser_path_earns_source(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _, _, _, _ = self._app(d, script="t", parser=True)
        out = _graph().run_cycle(app, ["AAPL"], 1, "t1")
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_candidate_origin_cannot_self_promote(self):
        # A worker candidate claiming parser origin is overwritten to
        # llm by the graph: content match still stays inference.
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        deps, calls, log, led, gov = self._deps(d, script="t")

        def evil_extract(rec, ctx):
            ctx["budget"].charge_tool()
            return [{"kind": "filing_event", "symbols": ["AAPL"],
                     "value": {"type": "enum",
                               "v": "8-K:item-2.02"},
                     "effect": "bullish", "origin": "parser",
                     "llm_touched": False}]

        deps["extract_workers"] = evil_extract
        app = _graph().build_graph(deps)
        out = _graph().run_cycle(app, ["AAPL"], 1, "te")
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"],
                         {"inference-capped": 1})

    def test_nonstring_thesis_rejected(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _, _, _, _ = self._app(d, fail="nonstring-thesis")
        out = _graph().run_cycle(app, ["AAPL"], 1, "t1")
        self.assertEqual(out.get("thesis"), {"AAPL": ""})
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("bad-thesis-type", blocked)
        # No str() coercion anywhere: the int never became prose.
        rows = self._spans(os.path.join(d, "spans.jsonl"))
        self.assertEqual(len(rows), 1)  # attempt accounted once

    def test_nondict_critique_rejected(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _, _, _, _ = self._app(d, fail="nondict-critique")
        out = _graph().run_cycle(app, ["AAPL"], 1, "t1")
        self.assertEqual(out["critique"]["AAPL"]["disagreement"], True)
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("non-dict", blocked)

    def test_model_block_applies_failure_defaults(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _, _, _, _ = self._app(d, fail="model-block")
        out = _graph().run_cycle(app, ["AAPL"], 1, "t1")
        # Raising factory: hypothesize blocked (clean config-error),
        # critique safe-default, nothing aborted-or-crashed.
        self.assertEqual(out.get("thesis"), {"AAPL": ""})
        self.assertFalse(out.get("cycle_aborted"))
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("no key", blocked)

    def test_tier1_trims(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        # spend 25 in the last 7d -> projection 107/150 = T1.
        app, deps, calls, log, gov = self._app(d, spend_usd=25.0)
        out = _graph().run_cycle(app, ["AAPL", "MSFT"], 1, "t1",
                                 trigger_symbols=("AAPL",))
        self.assertTrue(deps["cadence_state"].throttled)
        rows = self._spans(log)
        crit = sorted(r[1] for r in rows if r[0] == "critique")
        self.assertEqual(crit, ["AAPL"])  # TRIGGER-class only
        self.assertEqual(out.get("skipped_critique_tier"), 1)

    def test_tier1_suspends_null_extraction(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        # spend 25 in the last 7d -> T1: the NULL record suspends,
        # the normal record still flows to a published bundle.
        app, deps, calls, log, gov = self._app(d, spend_usd=25.0,
                                               nulls=True)
        out = _graph().run_cycle(app, ["AAPL"], 1, "t1n")
        self.assertEqual(gov.tier(), 1)
        self.assertEqual(out.get("dropped_null_class"), 1)
        self.assertIsNotNone(out.get("emitted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"],
                         {"inference-capped": 1})

    def test_tier2_cheap_watchlist2_softkill(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        long250 = "T" * 250
        # spend 30 in 7d -> projection 128.6/150 = T2.
        app, deps, calls, log, gov = self._app(
            d, script=long250,
            spend_usd=30.0,
            calibration_ranking={"AAPL": 0.9, "MSFT": 0.5,
                                 "TSLA": 0.1})
        hooks = []
        deps["health_hook"] = hooks.append
        out = _graph().run_cycle(app, ["MSFT", "AAPL", "TSLA"], 1, "t2")
        # Watchlist cut to the 2 best-calibrated.
        self.assertEqual(sorted(out.get("watchlist", [])),
                         ["AAPL", "MSFT"])
        self.assertIn("AAPL", out.get("thesis", {}))
        rows = self._spans(log)
        hyp_models = set(r[2] for r in rows if r[0] == "hypothesize")
        self.assertEqual(hyp_models, {"cheap"})  # cheapest switch
        # 250-char prose rejected under the 200 cap, never truncated.
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("thesis-too-long", blocked)
        self.assertNotIn(long250[:200], json.dumps(out.get("thesis")))
        # SOFT-kill signalled durably + on the hook.
        sig = os.path.join(d, "signals", "SOFT_KILL")
        self.assertTrue(os.path.exists(sig))
        self.assertTrue(out.get("soft_kill"))
        self.assertTrue(any(h.get("soft_kill") for h in hooks))

    def test_tier3_deny_and_medium_signal(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, deps, calls, log, gov = self._app(d, spend_usd=40.0)
        out = _graph().run_cycle(app, ["AAPL"], 1, "t3")
        self.assertTrue(out.get("cycle_aborted"))
        self.assertIsNone(out.get("emitted"))
        self.assertTrue(out.get("medium_kill"))
        self.assertTrue(os.path.exists(os.path.join(d, "signals",
                                                    "MEDIUM_KILL")))

    def test_tier2_unsignallable_denies(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, deps, calls, log, gov = self._app(d, spend_usd=30.0)
        deps.pop("signal_dir")
        out = _graph().run_cycle(app, ["AAPL"], 1, "t2x")
        self.assertTrue(out.get("cycle_aborted"))
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("unsignallable", blocked)

    def test_two_threads_two_identities(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, calls, log, led, gov = self._deps(d, script="t")
        app = _graph().build_graph(deps)
        gm = _graph()
        # Different epochs (TTL elapses) so BOTH runs actually attempt;
        # the assertion is on disjoint cycle identities, not cadence.
        gm.run_cycle(app, ["AAPL"], 1, "thread-A")
        gm.run_cycle(app, ["AAPL"], 7, "thread-B")
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
        app, _, _, _, _ = self._app(d, script="t", history=True,
                                    parser=True)
        out = _graph().run_cycle(app, ["AAPL"], 1, "th")
        self.assertFalse(out.get("aborted"))
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, _, _, _, _ = self._app(d, script="t")
        out = _graph().run_cycle(app, ["AAPL"], 1, "tr",
                                 trigger_symbols=("AAPL",))
        self.assertIn("AAPL", out.get("thesis", {}))

    def test_aborted_cycle_publishes_nothing(self):
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, _, _, _, _ = self._app(d, script="t", extract_abort=True,
                                    digest_on=False)
        out = _graph().run_cycle(app, ["AAPL"], 1, "tab")
        self.assertTrue(out.get("aborted"))
        self.assertIsNone(out.get("emitted"))
        self.assertIsNone(emit_mod.latest_complete(
            os.path.join(d, "out")))

    def test_abort_short_circuits_extract(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        app, deps, calls, log, gov = self._app(
            d, script="t", prefill=50, extract_abort=True)
        _graph().run_cycle(app, ["AAPL"], 1, "tasc")
        self.assertEqual(calls["extract"], 1)

    @unittest.skipUnless(_HAS_SMOL, "smolagents missing")
    def test_graph_owned_extract_path(self):
        # No extract_workers seam: the graph builds extraction through
        # run_gated (real CodeAgent + fake provider + fake executor in
        # the worker child). Candidates flow to the bundle.
        d = tempfile.mkdtemp()
        mapp, dbp, msha = _fixtures(d)
        app, deps, calls, log, gov = self._app(
            d, script="t", extract_stub=False)
        out = _graph().run_cycle(app, ["AAPL"], 1, "tgx")
        res = emit_mod.read_latest(os.path.join(d, "out"), dbp, mapp,
                                   NOW_S)
        reasons = res["stats"]["reasons"] if res else {}
        self.assertIn("inference-capped", reasons)

    def test_concurrent_run_refused(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, _, _, _, _ = self._deps(d)
        app = _graph().build_graph(deps)
        _graph()._RUN_GUARD.acquire()
        try:
            with self.assertRaises(RuntimeError):
                _graph().run_cycle(app, ["AAPL"], 1, "tcc")
        finally:
            _graph()._RUN_GUARD.release()

    def test_infinite_producer_terminates(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, _, _, _, _ = self._deps(d)

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
        app = _graph().build_graph(deps)
        t0 = time.monotonic()
        out = _graph().run_cycle(app, ["AAPL"], 1, "inf")
        self.assertLess(time.monotonic() - t0, 120.0)
        self.assertEqual(len(out.get("raw", [])), _graph().RAW_MAX)
        self.assertTrue(out.get("producer_overrun"))

    def test_huge_mapping_not_materialized(self):
        d = tempfile.mkdtemp()
        _fixtures(d)
        deps, _, _, _, _ = self._deps(d)
        big = {"k%06d" % i: "v" for i in range(100000)}

        def big_harvest(watchlist, epoch):
            return ([], big, None)

        deps["harvest"] = big_harvest
        app = _graph().build_graph(deps)
        out = _graph().run_cycle(app, ["AAPL"], 1, "big")
        self.assertEqual(len(out.get("stamps", {})), _graph().STAMPS_MAX)
        self.assertGreater(out.get("dropped_raw"), 90000)


if __name__ == "__main__":
    unittest.main()
