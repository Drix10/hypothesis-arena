"""Final-hardening P0 regressions (Phase-D audit items 1-7 + markers).

Proven through the REAL authorities (SQLite ledgers, file locks, the
run_gated boundary), never through doubles of the code under test.
Multiprocess tests use the spawn context with module-level children;
a go-file gate forces genuine concurrency on the reservation race.
"""
import hashlib
import multiprocessing
import os
import sqlite3
import sys
import tempfile
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root: collector/
sys.path.insert(0, ROOT)  # research-plane/: plane/

import test_plane as T
from plane import attribution, budgets, locks, r15
from plane import spend as spend_mod
from plane import workers


def _wait_go(d, tag, timeout=60.0):
    ready = os.path.join(d, "ready-%s" % tag)
    with open(ready, "w", encoding="utf-8") as fh:
        fh.write("ready")
    go = os.path.join(d, "go")
    end = time.monotonic() + timeout
    while not os.path.exists(go):
        if time.monotonic() > end:
            raise RuntimeError("go gate timed out")
        time.sleep(0.02)


def _race_reserve_child(args):
    d, lease_id, amount, cap, tag, resultq = args
    log = os.path.join(d, "spans.jsonl")
    _wait_go(d, tag)
    try:
        attribution.reserve_spend_hold(log, lease_id, amount, cap)
        resultq.put(("ok", lease_id))
    except attribution.SpendBlocked as e:
        resultq.put(("refused", str(e)))
    except Exception as e:  # never mask a harness defect as refusal
        resultq.put(("error", "%r" % (e,)))


def _race_gated_child(args):
    d, tag, touch, resultq = args
    log = os.path.join(d, "spans.jsonl")
    _wait_go(d, tag)
    pricing = {"racer": 5.0}
    led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))
    gov = spend_mod.SpendGovernor(
        log, pricing, "G0", state_dir=os.path.join(d, "spend"))
    budget = budgets.DurableBudget(led, "race-%s" % tag, "AAPL")
    cfg = {"model_id": "racer",
           "egress_proxy": "http://proxy.invalid:8080",
           "fake_behavior": "touch-file", "touch_path": touch,
           "fake_text": "won", "fake_pt": 1, "fake_ct": 1}
    # $90 reservation: need=18000 tokens at $5/1k (prompt 16500 B).
    messages = [{"role": "user", "content": "x" * 16500}]
    try:
        workers.run_gated(
            "generate", "hypothesize", "AAPL", "race-%s" % tag, 1,
            {"messages": messages}, cfg, T.fake_provider_factory,
            None, budget, gov, "racer", log, 60.0)
        resultq.put(("ok", tag))
    except spend_mod.SpendRefused as e:
        resultq.put(("refused", str(e)))
    except Exception as e:
        resultq.put(("error", "%r" % (e,)))


class AtomicReserveTest(unittest.TestCase):
    def _run_kids(self, d, target, items, tags):
        ctx = multiprocessing.get_context("spawn")
        resultq = ctx.Queue()
        procs = [ctx.Process(target=target, args=(a + (resultq,),))
                 for a in items]
        for p in procs:
            p.start()
        try:
            for tag in tags:
                ready = os.path.join(d, "ready-%s" % tag)
                end = time.monotonic() + 60.0
                while not os.path.exists(ready):
                    if time.monotonic() > end:
                        self.fail("child never ready")
                    time.sleep(0.02)
            with open(os.path.join(d, "go"), "w",
                      encoding="utf-8") as fh:
                fh.write("go")
            for p in procs:
                p.join(120)
                self.assertEqual(p.exitcode, 0)
            # Deterministic drain: every child puts exactly one
            # result; never poll empty() (feeder-thread race).
            out = [resultq.get(timeout=60) for _ in procs]
            return out
        finally:
            for p in procs:
                if p.is_alive():
                    p.terminate()
            self.assertEqual(multiprocessing.active_children(), [])

    def test_concurrent_reserves_atomic(self):
        # Cap $1.00, four concurrent $0.60 requests: exactly one wins
        # and committed + holds never exceeds the cap. The old
        # read/check/insert sequence admitted all four ($2.40).
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        items = [(d, "lease-%d" % i, 0.60, 1.00, "r%d" % i)
                 for i in range(4)]
        out = self._run_kids(d, _race_reserve_child, items,
                             ["r%d" % i for i in range(4)])
        wins = [t for t in out if t[0] == "ok"]
        self.assertEqual(len(wins), 1)
        self.assertFalse([t for t in out if t[0] == "error"])
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        holds = con.execute(
            "SELECT COALESCE(SUM(usd),0) FROM spend_holds").fetchone()[0]
        spent = con.execute(
            "SELECT COALESCE(SUM(usd),0) FROM spans").fetchone()[0]
        con.close()
        self.assertAlmostEqual(holds + spent, 0.60)
        self.assertLessEqual(holds + spent, 1.00)

    def test_race_loser_never_touches_provider(self):
        # End to end through run_gated: two concurrent $90 attempts
        # against the $150 G0 cap. Exactly one provider build happens;
        # the loser is refused pre-spawn (no touch file, no hold).
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        touches = [os.path.join(d, "touch-%d" % i) for i in range(2)]
        items = [(d, "g%d" % i, touches[i]) for i in range(2)]
        out = self._run_kids(d, _race_gated_child, items,
                             ["g%d" % i for i in range(2)])
        wins = sorted(t[1] for t in out if t[0] == "ok")
        self.assertEqual(len(wins), 1)
        self.assertFalse([t for t in out if t[0] == "error"])
        winner = wins[0]
        for i, touch in enumerate(touches):
            self.assertEqual(os.path.exists(touch),
                             ("g%d" % i) == winner)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        holds = con.execute(
            "SELECT COALESCE(SUM(usd),0) FROM spend_holds").fetchone()[0]
        spent = con.execute(
            "SELECT COALESCE(SUM(usd),0) FROM spans").fetchone()[0]
        con.close()
        self.assertLessEqual(holds + spent, 150.0)


class IdentityTest(unittest.TestCase):
    def test_model_identity_mismatch_refuses_pre_reserve(self):
        # Priced model "cheap", provider config naming "expensive":
        # clean ConfigBlocked, factory never invoked, no hold, no span.
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(
            d, pricing={"cheap": 0.001})
        touch = os.path.join(d, "touched")
        cfg = {"model_id": "expensive",
               "egress_proxy": "http://proxy.invalid:8080",
               "fake_behavior": "touch-file", "touch_path": touch}
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, T.fake_provider_factory, None, budget, gov,
                "cheap", log, 30.0)
        self.assertFalse(os.path.exists(touch))
        self.assertFalse(os.path.exists(attribution._db_for(log)))

    def test_non_dict_provider_cfg_refuses(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(d)
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                ["not", "a", "dict"], T.fake_provider_factory, None,
                budget, gov, "fake", log, 30.0)


class UnknownRecoveryTest(unittest.TestCase):
    def _log(self, d):
        return os.path.join(d, "spans.jsonl")

    def test_invoked_hold_blocks_without_unknown_rows(self):
        # Crash between the invoked mark and the atomic unknown
        # record: the invoked hold ALONE blocks (never silently
        # spendable), and reconcile recovers from the hold.
        d = tempfile.mkdtemp()
        log = self._log(d)
        led, _l, gov, _b, _p = T._gate(d)
        attribution.hold_spend(log, "crash-1", 2.0)
        attribution.mark_invoked(log, "crash-1")
        self.assertTrue(attribution.has_unreconciled(log))
        with self.assertRaises(spend_mod.SpendRefused):
            gov.reserve_usd(0.01, "late")
        self.assertEqual(gov.decision(), ("deny", "unknown-spend-pending"))
        attribution.reconcile_unknown(log, "crash-1", 2.0, "crashed")
        self.assertFalse(attribution.has_unreconciled(log))
        self.assertEqual(gov.decision()[0], "allow")
        gov.reserve_usd(0.01, "after")
        gov.settle_usd("after")

    def test_span_without_rows_recovers(self):
        # Unknown span written, unknown row + hold lost: reconcile
        # clears the span flag and journals the adjustment.
        d = tempfile.mkdtemp()
        log = self._log(d)
        T._gate(d)
        attribution.append_span(log, 1, "hypothesize", "m", usd=3.0,
                                outcome="error", is_unknown=True,
                                span_id="orphan-1")
        attribution.hold_spend(log, "orphan-lease", 3.0)
        attribution.mark_invoked(log, "orphan-lease")
        # Simulate the lost unknown row by hand: hold carries no
        # span_id (crashed before the atomic record).
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("UPDATE spend_holds SET span_id=NULL WHERE "
                    "lease_id='orphan-lease'")
        con.commit()
        con.close()
        attribution.reconcile_unknown(log, "orphan-lease", 1.0, "audit")
        self.assertFalse(attribution.has_unreconciled(log))
        con = sqlite3.connect(dbp)
        unk = con.execute(
            "SELECT reconciled FROM unknown_holds WHERE "
            "lease_id='orphan-lease'").fetchone()
        rec = con.execute(
            "SELECT old_usd, new_usd, note FROM reconciliations WHERE "
            "lease_id='orphan-lease'").fetchone()
        con.close()
        self.assertEqual(unk[0], 1)
        self.assertEqual((rec[0], rec[1]), (3.0, 1.0))
        self.assertIn("recovered", rec[2])

    def test_complete_record_reconciles_normally(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        T._gate(d)
        attribution.hold_spend(log, "full-1", 2.0)
        attribution.record_unknown(log, "full-1", "sp-1", 2.0,
                                   "timeout", 1, "hypothesize", "m",
                                   "c", "AAPL")
        self.assertTrue(attribution.has_unreconciled(log))
        attribution.reconcile_unknown(log, "full-1", 0.5, "billed")
        self.assertFalse(attribution.has_unreconciled(log))
        con = sqlite3.connect(attribution._db_for(log))
        row = con.execute(
            "SELECT usd, is_unknown FROM spans WHERE span_id='sp-1'"
            ).fetchone()
        con.close()
        self.assertEqual(tuple(row), (0.5, 0))

    def test_nothing_recorded_is_loud(self):
        d = tempfile.mkdtemp()
        log = self._log(d)
        T._gate(d)
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.reconcile_unknown(log, "ghost", 1.0, "x")

    def test_zero_price_timeout_proceeds(self):
        # A free model that hangs: AbortCycle + R15 poison, but no
        # unreconcilable dollar block — the next fresh cycle runs.
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(
            d, pricing={"free": 0.0}, cycle="z1")
        cfg = {"model_id": "free",
               "egress_proxy": "http://proxy.invalid:8080",
               "fake_behavior": "hang"}
        with self.assertRaises(r15.AbortCycle):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "z1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                cfg, T.fake_provider_factory, None, budget, gov,
                "free", log, 2.0)
        self.assertFalse(attribution.has_unreconciled(log))
        self.assertEqual(gov.decision()[0], "allow")
        con = sqlite3.connect(attribution._db_for(log))
        n = con.execute(
            "SELECT COUNT(*) FROM unknown_holds").fetchone()[0]
        con.close()
        self.assertEqual(n, 0)
        # The poisoned (cycle,symbol) stays dead, but a FRESH cycle
        # proceeds end to end (proves no permanent block).
        led2, log2, gov2, budget2, _p2 = T._gate(
            d, pricing={"free": 0.0}, cycle="z2")
        out = workers.run_gated(
            "generate", "hypothesize", "AAPL", "z2", 1,
            {"messages": [{"role": "user", "content": "hi"}]},
            dict(cfg, fake_behavior="ok", fake_text="back"),
            T.fake_provider_factory, None, budget2, gov2,
            "free", log2, 30.0)
        self.assertEqual(out["text"], "back")

    def test_recording_failure_is_unresolved_not_blocked(self):
        # The atomic unknown record itself fails after a real timeout:
        # hard abort, the invoked hold stays, future spend blocks on
        # the hold backstop (never a downgraded blocked result).
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(d)
        import unittest.mock as _mock
        cfg = T._cfg(fake_behavior="hang")
        with _mock.patch.object(attribution, "record_unknown",
                                side_effect=RuntimeError("disk gone")):
            with self.assertRaises(r15.AbortCycle) as cm:
                workers.run_gated(
                    "generate", "hypothesize", "AAPL", "t1", 1,
                    {"messages": [{"role": "user", "content": "hi"}]},
                    cfg, T.fake_provider_factory, None, budget, gov,
                    "fake", log, 2.0)
        self.assertIn("unresolved-spend", str(cm.exception.snapshot))
        self.assertTrue(attribution.has_unreconciled(log))
        self.assertEqual(gov.decision(), ("deny", "unknown-spend-pending"))


class StrictSpanTest(unittest.TestCase):
    def test_identical_span_id_is_idempotent(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        kw = dict(epoch=1, node="hypothesize", model_id="m",
                  cycle_id="c", symbol="AAPL", prompt_tokens=10,
                  completion_tokens=5, usd=1.0, span_id="same",
                  ts=1700000000)
        attribution.append_span(log, **kw)
        attribution.append_span(log, **kw)
        con = sqlite3.connect(attribution._db_for(log))
        n = con.execute(
            "SELECT COUNT(*) FROM spans WHERE span_id='same'"
            ).fetchone()[0]
        con.close()
        self.assertEqual(n, 1)
        with open(log, encoding="utf-8") as fh:
            mirror = [l for l in fh if l.strip()]
        self.assertEqual(len(mirror), 1)

    def test_conflicting_span_id_is_loud(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        kw = dict(epoch=1, node="hypothesize", model_id="m",
                  cycle_id="c", symbol="AAPL", prompt_tokens=10,
                  completion_tokens=5, usd=1.0, span_id="same")
        attribution.append_span(log, **kw)
        with self.assertRaises(ValueError):
            attribution.append_span(log, **dict(kw, usd=2.0))
        with self.assertRaises(ValueError):
            attribution.append_span(
                log, **dict(kw, model_id="other"))
        with self.assertRaises(ValueError):
            attribution.append_span(log, **dict(kw, outcome="error"))


class MarkerTriStateTest(unittest.TestCase):
    def test_attribution_marker_states(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        dbp = attribution._db_for(log)
        # DB absent + marker absent: genuine first init mints.
        attribution.append_span(log, 1, "n", "m", span_id="s1")
        # DB present + marker invalid: abort, never heal blindly.
        with open(dbp + ".init", "wb") as fh:
            fh.write(b"garbage{{{")
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.append_span(log, 1, "n", "m", span_id="s2")
        # DB absent + marker invalid: abort, never mint fresh.
        os.remove(dbp)
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.append_span(log, 1, "n", "m", span_id="s3")
        # DB absent + marker valid (deleted authority): abort.
        locks.write_marker(dbp, "tok-deleted")
        with self.assertRaises(attribution.LedgerUnavailable):
            attribution.append_span(log, 1, "n", "m", span_id="s4")

    def test_budget_marker_states(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        with open(path + ".init", "wb") as fh:
            fh.write(b"[{bad]")
        with self.assertRaises(r15.AbortCycle) as cm:
            budgets.BudgetLedger(path).snapshot("c", "AAPL")
        self.assertIn("marker-invalid", str(cm.exception.snapshot))
        os.remove(path)
        with self.assertRaises(r15.AbortCycle) as cm:
            budgets.BudgetLedger(path).snapshot("c", "AAPL")
        self.assertIn("marker-invalid", str(cm.exception.snapshot))


class TokenBudgetTest(unittest.TestCase):
    def test_tape_prefit_refuses_pre_provider(self):
        touched = []

        class TouchProvider:
            def generate(self, messages, max_tokens=None, **kw):
                touched.append(True)
                return T.FakeMsg("x", pt=1, ct=1)

        tape = workers.UsageTape(TouchProvider(),
                                 workers.COMPLETION_MAX,
                                 token_budget=100)
        with self.assertRaises(workers.ConfigBlocked):
            tape.generate([{"role": "user",
                            "content": "x" * 1000}],
                          max_tokens=1500)
        self.assertEqual(touched, [])  # provider never touched
        msg = tape.generate([{"role": "user", "content": "hi"}],
                            max_tokens=10)
        self.assertEqual(touched, [True])
        self.assertEqual(tape.totals(), [1, 1])

    def test_four_tool_outputs_fit_within_corrected_bound(self):
        # Four max-size tool outputs appended over agent steps: the
        # corrected closed form covers them; the old one-slot form
        # would not.
        p, c, s = 2000, 1500, 5
        need = workers._token_need("extract", p, c, s)
        new_growth = (c + 4 * 1500) * s * (s - 1) // 2
        old_growth = (c + 1500) * s * (s - 1) // 2
        self.assertGreater(new_growth, old_growth)  # 75000 > 30000
        self.assertGreaterEqual(
            new_growth, 4 * 1500 * s * (s - 1) // 2)  # 4 outs/step
        four = [{"tool": "t%d" % i, "output": "y" * 1500}
                for i in range(4)]
        hist_bytes = len(T.schema.canon(four))
        self.assertLess(p + hist_bytes, need)
        # The tape enforces the same bound call by call.
        touched = []

        class TouchProvider:
            def generate(self, messages, max_tokens=None, **kw):
                touched.append(True)
                return T.FakeMsg("x", pt=10, ct=10)

        tape = workers.UsageTape(TouchProvider(), c,
                                 token_budget=need)
        big_step = [{"role": "user", "content": "x" * p}] + four
        for _ in range(s):
            tape.generate(big_step, max_tokens=c)
        self.assertEqual(len(touched), s)
        # Remaining-based refusal across steps: a tight budget fits
        # the step once, then refuses when actuals consumed the
        # headroom (prompt bytes + completion vs what is left).
        step_bytes = len(T.schema.canon(big_step))
        tight = step_bytes + c  # exactly one step fits
        tape2 = workers.UsageTape(TouchProvider(), c,
                                  token_budget=tight)
        tape2.generate(big_step, max_tokens=c)
        self.assertEqual(len(touched), s + 1)
        with self.assertRaises(workers.ConfigBlocked):
            tape2.generate(big_step, max_tokens=c)
        self.assertEqual(len(touched), s + 1)  # still pre-provider


class ChildValidationTest(unittest.TestCase):
    def _touch_factory(self, path):
        def _factory(cfg):
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("touched")
            return T.FakeProvider(cfg)
        return _factory

    def _payload(self, **kw):
        p = {"kind": "generate",
             "provider_factory": self._touch_factory(
                 os.path.join(tempfile.mkdtemp(), "t")),
             "provider_cfg": {"model_id": "m"},
             "max_tokens": 100, "token_budget": 100000,
             "messages": [{"role": "user", "content": "hi"}]}
        p.update(kw)
        return p

    def test_invalid_task_never_builds_provider(self):
        d = tempfile.mkdtemp()
        # Invalid sandbox on an extract task: factory untouched.
        touch = os.path.join(d, "touched")
        out = workers._llm_child_main({
            "kind": "extract",
            "provider_factory": self._touch_factory(touch),
            "provider_cfg": {"model_id": "m"},
            "max_tokens": 100, "token_budget": 100000,
            "sandbox_cfg": {},  # missing proxy network etc.
            "container_name": "miro-c-s-1",
            "brief": "b", "rec_defaults": {}, "steps": 5})
        self.assertEqual(out["status"], "config-error")
        self.assertFalse(os.path.exists(touch))
        # Bad brief / steps / budget / container likewise.
        base = self._payload()
        base.update({"kind": "extract",
                     "sandbox_cfg": dict(T.SANDBOX),
                     "container_name": "miro-c-s-1",
                     "brief": "b", "rec_defaults": {},
                     "steps": 5})
        for bad in ({"brief": ""}, {"steps": 99},
                    {"token_budget": -1},
                    {"container_name": "a;b"},
                    {"max_tokens": 10 ** 9}):
            p = dict(base, **bad)
            p["provider_factory"] = self._touch_factory(
                os.path.join(d, "t%d" % len(str(bad))))
            out = workers._llm_child_main(p)
            self.assertEqual(out["status"], "config-error")
        self.assertEqual(os.listdir(d), [])

    def test_valid_generate_still_runs(self):
        out = workers._llm_child_main(self._payload())
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["text"], "thesis")


class BoundedOutputTest(unittest.TestCase):
    def test_huge_repr_never_called(self):
        called = []

        class BadRepr:
            def __repr__(self):
                called.append(True)
                return "x" * (100 << 20)

        t = workers._ChildTool(lambda: BadRepr())
        out = t()
        self.assertEqual(called, [])
        self.assertLess(len(out.encode("utf-8")), 256)
        self.assertIn("BadRepr", out)

    def test_huge_str_sliced_not_encoded(self):
        t = workers._ChildTool(lambda: "y" * (100 << 20))
        out = t()
        self.assertLessEqual(len(out.encode("utf-8")),
                             workers.TOOL_OUT_MAX_BYTES)

    def test_huge_int_becomes_placeholder(self):
        t = workers._ChildTool(lambda: (1 << 1000000))
        out = t()
        self.assertLess(len(out.encode("utf-8")), 256)
        self.assertIn("int:", out)

    def test_huge_result_capped_before_ipc(self):
        many = [{"kind": "filing_event", "symbols": ["AAPL"],
                 "value": {"type": "enum", "v": "e"}}
                for _ in range(1000)]
        cands = workers._to_candidates(many, {})
        self.assertEqual(len(cands), workers.CHILD_CANDIDATES_MAX)
        self.assertEqual(workers._to_candidates("x" * (2 << 20), {}),
                         [])
        big = {"kind": "filing_event", "symbols": ["AAPL"],
               "value": {"type": "enum", "v": "e"},
               "pad": "z" * (1 << 20)}
        self.assertEqual(workers._to_candidates([big], {}), [])


class ProcessBoundaryTest(unittest.TestCase):
    def test_repeated_success_and_timeout_leave_no_debt(self):
        for _ in range(5):
            self.assertEqual(
                T.timeout_mod.run_in_process(T._sleepy, 30, 0), "woke")
        for _ in range(3):
            with self.assertRaises(T.timeout_mod.CallTimeout):
                T.timeout_mod.run_in_process(T._sleepy, 1, 60)
        self.assertEqual(multiprocessing.active_children(), [])
        # Child errors propagate as RuntimeError, not silence.
        with self.assertRaises(RuntimeError):
            T.timeout_mod.run_in_process(T._emit_same,
                                         30, ("x",))
        self.assertEqual(multiprocessing.active_children(), [])

    def test_bad_timeout_blocks_pre_spawn(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(d)
        touch = os.path.join(d, "touched")
        cfg = T._cfg(fake_behavior="touch-file", touch_path=touch)
        for bad in (None, "30", -1, 0, float("nan"), float("inf"),
                    10 ** 9, True):
            with self.assertRaises(workers.ConfigBlocked):
                workers.run_gated(
                    "generate", "hypothesize", "AAPL", "t1", 1,
                    {"messages": [{"role": "user", "content": "hi"}]},
                    cfg, T.fake_provider_factory, None, budget, gov,
                    "fake", log, bad)
        self.assertFalse(os.path.exists(touch))
        # Nothing ever reserved: the ledger was never even created.
        self.assertFalse(os.path.exists(attribution._db_for(log)))

    def test_bad_container_name_blocks_pre_spawn(self):
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(d)
        with self.assertRaises(workers.ConfigBlocked):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t1", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                T._cfg(), T.fake_provider_factory, None, budget, gov,
                "fake", log, 30.0, container_name="a;b|c")


class GraphGovernanceTest(unittest.TestCase):
    def _app(self, d, **kw):
        return T.GraphTest()._app(d, **kw)

    def test_no_governor_build_blocked(self):
        d = tempfile.mkdtemp()
        gt = T.GraphTest()
        deps, _c, _l, _led, _g = gt._deps(d)
        del deps["spend_governor"]
        with self.assertRaises(workers.ConfigBlocked):
            T._graph().build_graph(deps)
        # Stateless governor: durable tier state would be destroyed.
        deps2, _c2, _l2, _led2, _g2 = gt._deps(d)
        log2 = os.path.join(d, "spans2.jsonl")
        deps2["spend_governor"] = T.spend_mod.SpendGovernor(
            log2, dict(T.PRICING), "G0", state_dir=None)
        with self.assertRaises(workers.ConfigBlocked):
            T._graph().build_graph(deps2)
        # Partial interface double is rejected at construction.
        class Partial:
            state_dir = os.path.join(d, "spend")

            def tier(self):
                return 0
        deps3, _c3, _l3, _led3, _g3 = gt._deps(d)
        deps3["spend_governor"] = Partial()
        with self.assertRaises(workers.ConfigBlocked):
            T._graph().build_graph(deps3)

    def test_pricing_cannot_diverge(self):
        # deps["pricing"] wildly disagrees with the governor table:
        # Tier-2 model selection AND reservation pricing both follow
        # the governor (sole authority) through the real graph path.
        d = tempfile.mkdtemp()
        T._fixtures(d)
        gt = T.GraphTest()
        deps, _c, log, _led, gov = gt._deps(d, script="t",
                                            spend_usd=30.0)
        deps["pricing"] = {"fake": 0.0001, "cheap": 999.0}
        app = T._graph().build_graph(deps)
        out = T._graph().run_cycle(app, ["AAPL"], 1, "diverge")
        self.assertFalse(out.get("aborted"))
        con = sqlite3.connect(attribution._db_for(log))
        rows = con.execute(
            "SELECT node, model, prompt_tokens, completion_tokens, "
            "usd FROM spans").fetchall()
        con.close()
        hyp = [r for r in rows if r[0] == "hypothesize"]
        self.assertTrue(hyp)
        # Governor cheapest (cheap @ 0.001), NOT deps cheapest.
        self.assertTrue(all(r[1] == "cheap" for r in hyp))
        for _n, _m, pt, ct, usd in hyp:
            self.assertAlmostEqual(usd, (pt + ct) / 1000.0 * 0.001)

    def test_malformed_harvest_envelopes(self):
        blocked_cases = [None, 42, "recs", ([],), ([], {}, {}, {}),
                         (None, {}), ("str-recs", {}), (b"bytes", {}),
                         ({"dict": 1}, {})]
        for i, bad in enumerate(blocked_cases):
            with self.subTest(case=i):
                d = tempfile.mkdtemp()
                T._fixtures(d)
                gt = T.GraphTest()
                deps, _c, _l, _led, _g = gt._deps(d)

                def _h(watchlist, epoch, _bad=bad):
                    return _bad

                deps["harvest"] = _h
                app = T._graph().build_graph(deps)
                out = T._graph().run_cycle(app, ["AAPL"], 1,
                                            "mal%d" % i)
                self.assertIsNone(out.get("emitted"))
                blocked = " ".join(out.get("blocked") or [])
                self.assertIn("harvest:", blocked)
        # Tolerated-but-counted envelope defects: no publication,
        # defects visible in dropped counts.
        for i, bad in enumerate([([], "stamps"), ([], {}, "hist"),
                                 ([], None)]):
            with self.subTest(counted=i):
                d = tempfile.mkdtemp()
                T._fixtures(d)
                gt = T.GraphTest()
                deps, _c, _l, _led, _g = gt._deps(d)

                def _h2(watchlist, epoch, _bad=bad):
                    return _bad

                deps["harvest"] = _h2
                app = T._graph().build_graph(deps)
                out = T._graph().run_cycle(app, ["AAPL"], 1,
                                            "malc%d" % i)
                self.assertIsNone(out.get("emitted"))
                self.assertGreater(out.get("dropped_raw", 0), 0)

    def test_infinite_parser_and_worker_terminate(self):
        d = tempfile.mkdtemp()
        T._fixtures(d)
        gt = T.GraphTest()
        deps, _c, _l, _led, _g = gt._deps(d, extract_stub=False)

        def _inf(_rec, _ctx):
            i = 0
            while True:
                i += 1
                yield {"kind": "filing_event", "symbols": ["AAPL"],
                       "value": {"type": "enum", "v": "e"}}

        deps["parser_extract"] = _inf
        deps["extract_workers"] = _inf
        app = T._graph().build_graph(deps)
        t0 = time.monotonic()
        out = T._graph().run_cycle(app, ["AAPL"], 1, "inf2")
        self.assertLess(time.monotonic() - t0, 120.0)
        self.assertTrue(out.get("producer_overrun"))
        self.assertLessEqual(len(out.get("candidates", [])),
                             T._graph().CAND_MAX)
        self.assertGreater(out.get("dropped_candidates", 0), 0)

    def test_hook_failure_visible_not_breaking(self):
        d = tempfile.mkdtemp()
        T._fixtures(d)

        def _boom(row):
            raise RuntimeError("hook down")

        app, deps, _c, log, gov = self._app(
            d, script="thesis-AAPL", hooks=[])
        deps["health_hook"] = _boom
        app = T._graph().build_graph(deps)
        out = T._graph().run_cycle(app, ["AAPL"], 1, "hookfail")
        self.assertIsNotNone(out.get("emitted"))
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("health-hook-failed", blocked)

    def test_sentinel_failure_fails_closed(self):
        # signal_dir that cannot hold a sentinel (an existing FILE):
        # Tier-2 research cannot signal, so it must not publish.
        d = tempfile.mkdtemp()
        T._fixtures(d)
        blocker = os.path.join(d, "not-a-dir")
        with open(blocker, "w", encoding="utf-8") as fh:
            fh.write("x")
        gt = T.GraphTest()
        deps, _c, _l, _led, _g = gt._deps(d, script="t",
                                          spend_usd=130.0)
        deps["signal_dir"] = blocker
        app = T._graph().build_graph(deps)
        out = T._graph().run_cycle(app, ["AAPL"], 1, "sigfail")
        self.assertTrue(out.get("aborted"))
        self.assertIsNone(out.get("emitted"))
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("signal-persist-failed", blocked)

    def test_strict_timeout_blocks_attempt(self):
        d = tempfile.mkdtemp()
        T._fixtures(d)
        gt = T.GraphTest()
        deps, _c, _l, _led, _g = gt._deps(d, script="t")
        deps["model_timeout_s"] = "soon"
        app = T._graph().build_graph(deps)
        out = T._graph().run_cycle(app, ["AAPL"], 1, "badto")
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("bad-model-timeout", blocked)
        dbp = attribution._db_for(os.path.join(d, "spans.jsonl"))
        n = 0
        if os.path.exists(dbp):
            con = sqlite3.connect(dbp)
            try:
                n = con.execute(
                    "SELECT COUNT(*) FROM spans WHERE node IN "
                    "('hypothesize','critique')").fetchone()[0]
            except sqlite3.OperationalError:
                n = 0  # no span ever written: nothing attempted
            con.close()
        self.assertEqual(n, 0)


    def test_strict_timeout_blocks_attempt(self):
        d = tempfile.mkdtemp()
        T._fixtures(d)
        gt = T.GraphTest()
        deps, _c, _l, _led, _g = gt._deps(d, script="t")
        deps["model_timeout_s"] = "soon"
        app = T._graph().build_graph(deps)
        out = T._graph().run_cycle(app, ["AAPL"], 1, "badto")
        blocked = " ".join(out.get("blocked") or [])
        self.assertIn("bad-model-timeout", blocked)
        dbp = attribution._db_for(os.path.join(d, "spans.jsonl"))
        n = 0
        if os.path.exists(dbp):
            con = sqlite3.connect(dbp)
            try:
                n = con.execute(
                    "SELECT COUNT(*) FROM spans WHERE node IN "
                    "('hypothesize','critique')").fetchone()[0]
            except sqlite3.OperationalError:
                n = 0  # no span ever written: nothing attempted
            con.close()
        self.assertEqual(n, 0)


class TierStateTest(unittest.TestCase):
    def _gov(self, d, **kw):
        log = os.path.join(d, "spans.jsonl")
        return T.spend_mod.SpendGovernor(
            log, dict(T.PRICING), "G0",
            state_dir=os.path.join(d, "spend")), log

    def test_deleted_state_fails_closed(self):
        d = tempfile.mkdtemp()
        gov, _log = self._gov(d)
        now = int(time.time())
        self.assertEqual(gov.evaluate(now)[0], 0)
        # Journal-free fresh state may re-init; WITH history present
        # (force a journal row via a transition) deletion aborts.
        gov._journal(T.spend_mod.TIER_JOURNAL_NAME,
                     {"ts": now, "from": 0, "to": 0,
                      "projection_30d": 0.0, "cap": 150.0,
                      "stage": "G0"})
        os.remove(os.path.join(d, "spend",
                               T.spend_mod.TIER_STATE_NAME))
        with self.assertRaises(T.spend_mod.StateUnavailable):
            gov.evaluate(now + 3600)
        self.assertEqual(gov.decision(now + 3600)[0], "deny")

    def test_corrupt_and_future_state_fail_closed(self):
        d = tempfile.mkdtemp()
        gov, _log = self._gov(d)
        now = int(time.time())
        gov.evaluate(now)
        sp = os.path.join(d, "spend", T.spend_mod.TIER_STATE_NAME)
        with open(sp, "wb") as fh:
            fh.write(b"{corrupt")
        with self.assertRaises(T.spend_mod.StateUnavailable):
            gov.evaluate(now + 3600)
        with open(sp, "w", encoding="utf-8") as fh:
            import json as _json
            fh.write(_json.dumps(
                {"tier": 0, "projection": 0.0,
                 "evaluated_at": now + 360000, "below_count": 0,
                 "binding": gov._binding()}))
        with self.assertRaises(T.spend_mod.StateUnavailable):
            gov.evaluate(now + 3600)

    def test_config_change_forces_fresh_evaluation(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d)
        now = int(time.time())
        gov.evaluate(now)
        # Same dir, changed pricing: the cached tier is NOT reused —
        # a fresh evaluation runs immediately (hourly cache bypassed).
        gov2 = T.spend_mod.SpendGovernor(
            log, {"fake": 99.0}, "G0",
            state_dir=os.path.join(d, "spend"))
        t, _p = gov2.evaluate(now + 10)
        self.assertEqual(t, 0)
        st = gov2._load_state(now + 10)
        self.assertEqual(st["binding"]["pricing_fp"],
                         gov2._binding()["pricing_fp"])

    def test_crash_between_journal_and_state_recovers(self):
        # Injected failure at the exact crash point: journal carries
        # the transition, state never lands — the next load adopts
        # the journaled snapshot deterministically.
        d = tempfile.mkdtemp()
        gov, _log = self._gov(d)
        now = int(time.time())
        gov.evaluate(now)
        st = gov._initial_state()
        st.update(tier=2, projection=130.0, evaluated_at=now + 3600,
                  below_count=0)
        real_save = gov._save_state_locked
        try:
            gov._save_state_locked = lambda s: (_ for _ in ()).throw(
                OSError("crash"))
            with self.assertRaises(OSError):
                gov._save_state_and_journal(
                    st, T.spend_mod.TIER_JOURNAL_NAME,
                    {"ts": now + 3600, "from": 0, "to": 2,
                     "projection_30d": 130.0, "cap": 150.0,
                     "stage": "G0"})
        finally:
            gov._save_state_locked = real_save
        recovered = gov._load_state(now + 7200)
        self.assertEqual(recovered["tier"], 2)
        self.assertEqual(recovered["evaluated_at"], now + 3600)


class RatioDaysTest(unittest.TestCase):
    def _gov(self, d, profits):
        log = os.path.join(d, "spans.jsonl")
        calls = {"n": 0}

        def _profit(since):
            i = min(calls["n"], len(profits) - 1)
            calls["n"] += 1
            return profits[i]

        gov = T.spend_mod.SpendGovernor(
            log, dict(T.PRICING), "G2",
            state_dir=os.path.join(d, "spend"), profit_since=_profit)
        return gov, log

    def _seed(self, log, usd, ts):
        attribution.append_span(log, 1, "seed", "seed",
                                cycle_id="c", symbol="AAPL",
                                prompt_tokens=10, completion_tokens=5,
                                usd=usd, span_id="seed-%d" % ts, ts=ts)

    def test_five_same_day_failures_no_tier3(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d, [1.0])
        now = int(time.time())
        self._seed(log, 300.0, now - 10 * 86400)
        for i in range(5):
            self.assertEqual(gov.evaluate(now + i * 60)[0], 0)
        rows = []
        jp = os.path.join(d, "spend", T.spend_mod.RATIO_JOURNAL_NAME)
        import json as _json
        with open(jp, encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    rows.append(_json.loads(line))
        # One counted evaluation per UTC day, however many hourly
        # evaluations ran.
        self.assertEqual(len(rows), 1)

    def test_three_distinct_days_force_tier3(self):
        d = tempfile.mkdtemp()
        gov, log = self._gov(d, [1.0])
        now = int(time.time())
        self._seed(log, 300.0, now - 10 * 86400)
        day = now - (now % 86400)
        self.assertEqual(gov.evaluate(day + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 86500)[0], 0)
        self.assertEqual(gov.evaluate(day + 2 * 86400 + 100)[0], 3)

    def test_ok_day_resets_streak(self):
        d = tempfile.mkdtemp()
        # fail, fail, OK (huge profit), fail, fail, fail -> T3 only
        # on the third consecutive failure AFTER the reset.
        gov, log = self._gov(d, [1.0, 1.0, 10 ** 9, 1.0, 1.0, 1.0])
        now = int(time.time())
        self._seed(log, 300.0, now - 10 * 86400)
        day = now - (now % 86400)
        self.assertEqual(gov.evaluate(day + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 86500)[0], 0)
        self.assertEqual(gov.evaluate(day + 2 * 86400 + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 3 * 86400 + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 4 * 86400 + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 5 * 86400 + 100)[0], 3)

    def test_suspended_day_breaks_streak(self):
        d = tempfile.mkdtemp()
        # fail, fail, suspended (no profit), fail -> no Tier 3.
        gov, log = self._gov(d, [1.0, 1.0, 0.0, 1.0])
        now = int(time.time())
        self._seed(log, 300.0, now - 10 * 86400)
        day = now - (now % 86400)
        self.assertEqual(gov.evaluate(day + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 86500)[0], 0)
        self.assertEqual(gov.evaluate(day + 2 * 86400 + 100)[0], 0)
        self.assertEqual(gov.evaluate(day + 3 * 86400 + 100)[0], 0)


class BudgetOracleTest(unittest.TestCase):
    """CycleBudget (in-memory reference) vs DurableBudget (production
    authority): the same scripted sequences must agree on counters
    and on abort-vs-proceed. A divergence is a semantic defect in
    one of the two — the oracle pins them together."""

    def test_sequences_agree(self):
        d = tempfile.mkdtemp()
        led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))
        ref = T.r15.CycleBudget("AAPL", cycle_id="c")
        dur = budgets.DurableBudget(led, "c", "AAPL")
        # Script: reserve 100 tokens + 2 tools, settle 50, reserve
        # again, over-reserve aborts both, invalidate poisons both.
        lease = dur.reserve_call(100, 2)
        ref.charge_llm(100)
        ref.charge_tool()
        ref.charge_tool()
        s_ref, s_dur = ref.snapshot(), dur.snapshot()
        self.assertEqual((s_ref["llm"], s_ref["tools"],
                          s_ref["tokens"]),
                         (s_dur["llm"], s_dur["tools"],
                          s_dur["tokens"]))
        dur.settle_call(lease, 50)
        ref.tokens = 50  # reference settles by assignment in tests
        self.assertEqual(dur.snapshot()["tokens"],
                         ref.snapshot()["tokens"])
        for reserve in (lambda: dur.reserve_call(T.r15.TOKENS, 0),
                        lambda: ref.charge_llm(T.r15.TOKENS)):
            with self.assertRaises(T.r15.AbortCycle):
                reserve()
        dur.invalidate()
        ref.invalidate()
        with self.assertRaises(T.r15.AbortCycle):
            dur.reserve_call(1, 0)
        with self.assertRaises(T.r15.AbortCycle):
            ref.check()


class LifecycleStressTest(unittest.TestCase):
    def test_repeated_timeouts_reap_every_time(self):
        # Eight consecutive hung calls: no live child after ANY of
        # them (not just at the end), proven inside the loop.
        for _ in range(8):
            with self.assertRaises(T.timeout_mod.CallTimeout):
                T.timeout_mod.run_in_process(T._sleepy, 1, 60)
            self.assertEqual(multiprocessing.active_children(), [])

    def test_container_reap_runs_after_worker_death(self):
        # The parent reaps the executor container only after
        # run_in_process guarantees the worker dead: the stub observes
        # zero live children at reap time. On accounted success the
        # parent reaps nothing (child-side finally owns cleanup).
        import unittest.mock as _mock
        d = tempfile.mkdtemp()
        led, log, gov, budget, _p = T._gate(d)
        observed = []

        def _stub(cmd, **kw):
            observed.append(list(multiprocessing.active_children()))

            class _R:
                returncode = 0
                stderr = b""
            return _R()

        cfg = T._cfg(fake_behavior="hang")
        with _mock.patch.object(workers.subprocess, "run", _stub):
            with self.assertRaises(T.r15.AbortCycle):
                workers.run_gated(
                    "generate", "hypothesize", "AAPL", "t1", 1,
                    {"messages": [{"role": "user", "content": "hi"}]},
                    cfg, T.fake_provider_factory, None, budget, gov,
                    "fake", log, 2.0)
        self.assertEqual(len(observed), 1)
        self.assertEqual(observed[0], [])
        observed.clear()
        # Success leg on a FRESH ledger (the hang leg above left a
        # real unreconciled unknown — correctly blocking).
        d2 = tempfile.mkdtemp()
        led2, log2, gov2, budget2, _p2 = T._gate(d2, cycle="t2")
        with _mock.patch.object(workers.subprocess, "run", _stub):
            workers.run_gated(
                "generate", "hypothesize", "AAPL", "t2", 1,
                {"messages": [{"role": "user", "content": "hi"}]},
                T._cfg(), T.fake_provider_factory, None, budget2,
                gov2, "fake", log2, 30.0)
        self.assertEqual(observed, [])


class NumericsTest(unittest.TestCase):
    def test_bool_and_infinite_pricing_blocked(self):
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        for bad_price in (True, False, float("inf"), float("-inf"),
                          float("nan"), -1.0, 10 ** 9):
            with self.subTest(price=bad_price):
                with self.assertRaises(workers.ConfigBlocked):
                    T.spend_mod.SpendGovernor(log, {"m": bad_price},
                                              "G0")

    def test_bool_and_infinite_amounts_refused(self):
        d = tempfile.mkdtemp()
        led, log, gov, _b, _p = T._gate(d)
        for bad in (True, False, float("inf"), float("nan"), -0.5):
            with self.subTest(amount=bad):
                with self.assertRaises(T.spend_mod.SpendRefused):
                    gov.reserve_usd(bad, "lease-bad")
                with self.assertRaises(ValueError):
                    attribution.append_span(
                        log, 1, "n", "m", usd=bad, span_id="s-bad")

    def test_bool_calibration_ignored(self):
        # A True calibration score is not 1.0: ignored (fallback),
        # never ranked — proven through a real Tier-2 watchlist cut.
        d = tempfile.mkdtemp()
        T._fixtures(d)
        gt = T.GraphTest()
        deps, _c, _l, _led, _g = gt._deps(
            d, script="t", spend_usd=30.0,
            calibration_ranking={"MSFT": True, "AAPL": 0.5,
                                 "GOOG": 0.7,
                                 "TSLA": float("inf")})
        app = T._graph().build_graph(deps)
        out = T._graph().run_cycle(app, ["MSFT", "AAPL", "GOOG"],
                                    1, "cal")
        # Only finite numbers rank: GOOG (0.7) then AAPL (0.5).
        self.assertEqual(out.get("watchlist"), ["GOOG", "AAPL"])

    def test_infinite_projection_fails_closed(self):
        import json as _json
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        gov = T.spend_mod.SpendGovernor(
            log, dict(T.PRICING), "G0",
            state_dir=os.path.join(d, "spend"))
        now = int(time.time())
        gov.evaluate(now)
        sp = os.path.join(d, "spend", T.spend_mod.TIER_STATE_NAME)
        st = gov._load_state(now)
        st["projection"] = float("inf")
        with open(sp, "w", encoding="utf-8") as fh:
            fh.write(_json.dumps(st))
        with self.assertRaises(T.spend_mod.StateUnavailable):
            gov.evaluate(now + 3600)
        self.assertEqual(gov.decision(now + 3600)[0], "deny")


class PublisherHardeningTest(unittest.TestCase):
    def _pub_deps(self, d, mapp, **kw):
        deps = {"outdir": os.path.join(d, "out"),
                "map_path": mapp,
                "canonical_for": lambda c: T._canon(),
                "source_watermarks": lambda st: {
                    "edgar_8k": {"last_observation_at": T.OBS_S,
                                   "cursor": "g"}}}
        deps.update(kw)
        return deps

    def _cand(self, **kw):
        c = {"kind": "filing_event", "symbols": ["AAPL"],
             "value": {"type": "enum", "v": "8-K:item-2.02"},
             "effect": "bullish", "origin": "parser",
             "provenance_url": "https://example.invalid/x"}
        c.update(kw)
        return c

    def test_malformed_direct_calls_closed(self):
        from plane import publish as pub
        d = tempfile.mkdtemp()
        mapp, _dbp, _msha = T._fixtures(d)
        state = {"epoch": 1, "fused": [self._cand()]}
        ok = pub.resolve_emit(self._pub_deps(d, mapp), state)
        self.assertIsNotNone(ok.get("emitted"))
        for deps, st in (
                (None, state), ({}, state),
                (self._pub_deps(d, mapp), None),
                (self._pub_deps(d, mapp), {"epoch": "x"}),
                (self._pub_deps(d, mapp), {"epoch": 1}),
                (self._pub_deps(d, mapp),
                 {"epoch": 1, "fused": "nope"}),
                (self._pub_deps(d, mapp),
                 {"epoch": 1, "fused": [self._cand()],
                  "history": "str"}),
                (self._pub_deps(d, mapp),
                 {"epoch": 1, "fused": [self._cand()],
                  "history": {"s%d" % i: [] for i in range(17)}}),
                (dict(self._pub_deps(d, mapp), outdir=""), state),
                (dict(self._pub_deps(d, mapp),
                      canonical_for=None), state)):
            with self.subTest(deps=bool(deps), st=bool(st)):
                out = pub.resolve_emit(deps, st)
                self.assertIsNone(out.get("emitted"))
                self.assertIn("resolve_error", out)
        # Per-candidate drops (oversize candidate) are counted, not
        # call-malformed: legitimate-empty with evidence.
        out = pub.resolve_emit(
            self._pub_deps(d, mapp),
            {"epoch": 1, "fused": [{"kind": "x" * 70000}]})
        self.assertIsNone(out.get("emitted"))
        self.assertTrue(out.get("empty"))
        self.assertGreater(out.get("dropped_resolve", 0), 0)
        # A raising canonical lookup drops the candidate (counted),
        # never crashes the emit: legitimate-empty, not malformed.
        def _boom(cand):
            raise RuntimeError("lookup down")
        out = pub.resolve_emit(
            self._pub_deps(d, mapp, canonical_for=_boom), state)
        self.assertIsNone(out.get("emitted"))
        self.assertTrue(out.get("empty"))
        self.assertGreater(out.get("dropped_resolve", 0), 0)
        # Oversize watermark/history mappings fail closed.
        wm = {"k%d" % i: {"last_observation_at": T.OBS_S,
                            "cursor": "c"} for i in range(65)}
        out = pub.resolve_emit(
            self._pub_deps(
                d, mapp,
                source_watermarks=lambda st: wm), state)
        self.assertIsNone(out.get("emitted"))

    def test_map_rejections(self):
        import json as _json
        from plane import publish as pub
        d = tempfile.mkdtemp()
        mapp, _dbp, _msha = T._fixtures(d)
        state = {"epoch": 1, "fused": [self._cand()]}
        base = _json.loads(open(mapp, encoding="utf-8").read())
        cases = []
        bad = dict(base, cik_to_ticker={"ABC": "AAPL"})
        cases.append(bad)
        bad = dict(base, cik_to_ticker={"0000320193": "aapl"})
        cases.append(bad)
        bad = dict(base, evil=1)
        cases.append(bad)
        bad = dict(base, macro_release_to_symbols={"FOMC": "EURUSD"})
        cases.append(bad)
        bad = dict(base, note="n" * 1025)
        cases.append(bad)
        for i, m in enumerate(cases):
            with self.subTest(case=i):
                p = os.path.join(d, "m%d.json" % i)
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(_json.dumps(m))
                out = pub.resolve_emit(self._pub_deps(d, p), state)
                self.assertIsNone(out.get("emitted"))
                self.assertIn("map_error", out)


class ManifestBoundTest(unittest.TestCase):
    def test_strict_rows_and_huge_manifest(self):
        import json as _json
        from plane import emit as emit_mod
        d = tempfile.mkdtemp()
        mapp, dbp, msha = T._fixtures(d)
        outdir = os.path.join(d, "out")
        ok, (_feat, _c) = __import__('plane.resolver', fromlist=['x']).resolve(
            {"kind": "filing_event", "symbols": ["AAPL"],
             "value": {"type": "enum", "v": "8-K:item-2.02"},
             "effect": "bullish",
             "provenance_url": "https://example.invalid/x"},
            T._canon(), T.MAP, origin="parser")
        self.assertTrue(ok)
        bid, good = emit_mod.emit_bundle(
            outdir, 7, [_feat],
            {"entity_map_version": T.MAP["map_version"],
             "entity_map_sha256": msha,
             "sources": {"edgar_8k": {"last_observation_at": T.OBS_S,
                                          "cursor": "g"}}})
        # Semantically-wrong rows (right hash shape, wrong envelope
        # linkage) are ignored, not blessed.
        with open(os.path.join(outdir, "manifest.jsonl"), "a",
                  encoding="utf-8") as fh:
            for bad in ({"bundle_id": "rp-99-row", "commit": True,
                         "research_epoch": 99, "feature_count": 1,
                         "entity_map_sha256": msha,
                         "path": "features-99-rp-99-row.json",
                         "sha256": "0" * 64},
                        {"bundle_id": bid, "commit": True,
                         "research_epoch": 7, "feature_count": -1,
                         "entity_map_sha256": msha,
                         "path": os.path.basename(good),
                         "sha256": "0" * 64}):
                fh.write(_json.dumps(bad, sort_keys=True) + "\n")
        self.assertEqual(emit_mod.latest_complete(outdir), good)
        # A multi-MB hostile manifest stays bounded: garbage oldest,
        # valid generation newest (inside the tail) still resolves in
        # bounded time, and the next emit rotates the file back under
        # the bound while keeping the newest rows resolvable.
        with open(os.path.join(outdir, "manifest.jsonl"), "a",
                  encoding="utf-8") as fh:
            fh.write(("x" * 200 + "\n") * 20000)
        bid2, good2 = emit_mod.emit_bundle(
            outdir, 8, [_feat],
            {"entity_map_version": T.MAP["map_version"],
             "entity_map_sha256": msha,
             "sources": {"edgar_8k": {"last_observation_at": T.OBS_S,
                                          "cursor": "g2"}}})
        t0 = time.monotonic()
        self.assertEqual(emit_mod.latest_complete(outdir), good2)
        self.assertLess(time.monotonic() - t0, 10.0)
        size = os.path.getsize(os.path.join(outdir, "manifest.jsonl"))
        self.assertLessEqual(size, emit_mod.MANIFEST_MAX_BYTES)
        self.assertEqual(emit_mod.latest_complete(outdir), good2)

    def test_reader_falls_back_past_throwing_generation(self):
        import json as _json
        from plane import emit as emit_mod
        from collector import ctx_read
        d = tempfile.mkdtemp()
        mapp, dbp, msha = T._fixtures(d)
        outdir = os.path.join(d, "out")
        ok, (_feat, _c) = __import__('plane.resolver', fromlist=['x']).resolve(
            {"kind": "filing_event", "symbols": ["AAPL"],
             "value": {"type": "enum", "v": "8-K:item-2.02"},
             "effect": "bullish",
             "provenance_url": "https://example.invalid/x"},
            T._canon(), T.MAP, origin="parser")
        bid1, _p1 = emit_mod.emit_bundle(
            outdir, 1, [_feat],
            {"entity_map_version": T.MAP["map_version"],
             "entity_map_sha256": msha,
             "sources": {"edgar_8k": {"last_observation_at": T.OBS_S,
                                          "cursor": "g"}}})
        # Newer generation: hash-valid + envelope-valid, but the
        # frozen reader THROWS on it (simulated downstream defect).
        env = {"schema_version": "f2", "research_epoch": 2,
               "bundle_id": "rp-2-" + "b" * 64, "commit": True,
               "watermarks": {}, "features": []}
        raw = _json.dumps(env, sort_keys=True,
                          separators=(",", ":")).encode()
        name = "features-2-rp-2-" + "b" * 64 + ".json"
        with open(os.path.join(outdir, name), "wb") as fh:
            fh.write(raw)
        with open(os.path.join(outdir, "manifest.jsonl"), "a",
                  encoding="utf-8") as fh:
            fh.write(_json.dumps(
                {"bundle_id": "rp-2-" + "b" * 64, "commit": True,
                 "research_epoch": 2, "feature_count": 0,
                 "entity_map_sha256": msha, "path": name,
                 "sha256": hashlib.sha256(
                     raw).hexdigest()}, sort_keys=True) + "\n")
        real = ctx_read.read_bundle
        calls = {"n": 0}

        def _flaky(snap, db, mp, now):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("reader defect")
            return real(snap, db, mp, now)

        ctx_read.read_bundle = _flaky
        try:
            res = emit_mod.read_latest(outdir, dbp, mapp, T.NOW_S)
        finally:
            ctx_read.read_bundle = real
        self.assertIsNotNone(res)
        self.assertEqual(res["bundle_id"], bid1)


class DigestConflictTest(unittest.TestCase):
    def test_conflict_not_duplicate(self):
        from plane import digest as digest_mod
        d = tempfile.mkdtemp()
        ok, why = digest_mod.append_digest(d, 1, "AAPL", "hypothesize",
                                           "thesis-one")
        self.assertEqual((ok, why), (True, "ok"))
        ok, why = digest_mod.append_digest(d, 1, "AAPL", "hypothesize",
                                           "thesis-one")
        self.assertEqual((ok, why), (True, "duplicate"))
        ok, why = digest_mod.append_digest(d, 1, "AAPL", "hypothesize",
                                           "thesis-TWO")
        self.assertEqual((ok, why), (False, "digest-conflict"))
        rows = open(os.path.join(d, digest_mod.DIGEST_NAME),
                    encoding="utf-8").read().strip().split("\n")
        self.assertEqual(len(rows), 1)  # first write wins

    def test_many_epochs_bound_memory(self):
        from plane import digest as digest_mod
        d = tempfile.mkdtemp()
        for e in range(4200):
            ok, _why = digest_mod.append_digest(d, e, "AAPL",
                                                "hypothesize", "t%d" % e)
            self.assertTrue(ok)
        path = os.path.join(d, digest_mod.DIGEST_NAME)
        self.assertLessEqual(len(digest_mod._SEEN[path][1]),
                             digest_mod._SEEN_KEYS_MAX)
        # Evicted keys re-derive from the file (still correct).
        ok, why = digest_mod.append_digest(d, 0, "AAPL", "hypothesize",
                                           "t0")
        self.assertEqual((ok, why), (True, "duplicate"))


class MirrorAndEmitBoundTest(unittest.TestCase):
    def test_mirror_self_heals_on_prune(self):
        # A mirror row lost to an append failure is regenerated from
        # the ledger by the hourly prune path (production wiring).
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(log, 1, "n", "m", usd=1.0,
                                span_id="s1")
        with open(log, "w", encoding="utf-8") as fh:
            fh.write("{corrupt\n")
        attribution.prune_spans(log)
        rows = [l for l in open(log, encoding="utf-8")
                if l.strip()]
        self.assertEqual(len(rows), 1)
        self.assertIn('"span_id": "s1"', rows[0])

    def test_emit_bundle_rejects_hostile_input(self):
        from plane import emit as emit_mod
        d = tempfile.mkdtemp()
        wm = {"entity_map_version": "v", "entity_map_sha256": "a",
              "sources": {}}

        def _inf():
            i = 0
            while True:
                i += 1
                yield {"n": i}

        t0 = time.monotonic()
        with self.assertRaises(ValueError):
            emit_mod.emit_bundle(os.path.join(d, "o"), 1, _inf(),
                                 wm)
        self.assertLess(time.monotonic() - t0, 10.0)
        with self.assertRaises(ValueError):
            emit_mod.emit_bundle(os.path.join(d, "o"), 1,
                                 [{"n": i} for i in range(65)], wm)


def _silent_exit():
    import os as _os
    _os._exit(0)


class ReauditFixTest(unittest.TestCase):
    """Human re-audit of the shipped 62e1019 tree (5 code findings +
    pipe IPC). Each test pins the exact gap, through the real
    authorities."""

    def _log(self, d):
        return os.path.join(d, "spans.jsonl")

    def _held(self, d, lease="L1", usd=2.0):
        log = self._log(d)
        T._gate(d)
        attribution.hold_spend(log, lease, usd)
        return log

    def _rec(self, log, lease="L1", span="S1", usd=2.0, **kw):
        args = dict(lease_id=lease, span_id=span, usd=usd,
                    outcome="timeout", epoch=1, node="hypothesize",
                    model_id="m", cycle_id="c", symbol="AAPL")
        args.update(kw)
        attribution.record_unknown(log, **args)

    def test_record_unknown_rejects_usd_mismatch(self):
        d = tempfile.mkdtemp()
        log = self._held(d, usd=2.0)
        with self.assertRaises(attribution.SpendBlocked) as cm:
            self._rec(log, usd=1.0)
        self.assertIn("usd-mismatch", str(cm.exception))

    def _seeded_log(self, d):
        """Ledger exists (fail-closed missing-ledger distinguished
        from a present ledger with no such hold)."""
        log = self._log(d)
        T._gate(d)
        attribution.hold_spend(log, "seed", 1.0)
        attribution.settle_hold(log, "seed")
        return log

    def test_record_unknown_rejects_missing_hold(self):
        d = tempfile.mkdtemp()
        log = self._seeded_log(d)
        with self.assertRaises(attribution.SpendBlocked) as cm:
            self._rec(log)
        self.assertIn("no-hold", str(cm.exception))

    def test_record_unknown_conflicting_unknown_row_is_loud(self):
        d = tempfile.mkdtemp()
        log = self._held(d, usd=2.0)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("INSERT INTO unknown_holds VALUES "
                    "('L1','OTHER',2.0,1,0)")
        con.commit()
        con.close()
        with self.assertRaises(attribution.SpendBlocked) as cm:
            self._rec(log)
        self.assertIn("unknown-hold-conflict", str(cm.exception))
        # Atomic rollback: the span was NOT half-written.
        con = sqlite3.connect(dbp)
        n = con.execute(
            "SELECT COUNT(*) FROM spans WHERE span_id='S1'"
            ).fetchone()[0]
        con.close()
        self.assertEqual(n, 0)

    def test_record_unknown_identical_retry_is_idempotent(self):
        d = tempfile.mkdtemp()
        log = self._held(d, usd=2.0)
        self._rec(log)
        self._rec(log)  # identical retry: no raise
        con = sqlite3.connect(attribution._db_for(log))
        nspan = con.execute(
            "SELECT COUNT(*) FROM spans WHERE span_id='S1'"
            ).fetchone()[0]
        nunk = con.execute(
            "SELECT COUNT(*) FROM unknown_holds WHERE lease_id='L1'"
            ).fetchone()[0]
        hold = con.execute(
            "SELECT state, span_id FROM spend_holds WHERE "
            "lease_id='L1'").fetchone()
        con.close()
        self.assertEqual((nspan, nunk), (1, 1))
        self.assertEqual(tuple(hold), ("invoked", "S1"))

    def test_record_unknown_span_identity_is_full(self):
        # Same span_id, different node: the strict span contract
        # fires even though usd + is_unknown match.
        d = tempfile.mkdtemp()
        log = self._held(d, usd=2.0)
        self._rec(log)
        with self.assertRaises(attribution.SpendBlocked) as cm:
            self._rec(log, node="critique")
        self.assertIn("span-conflict", str(cm.exception))

    def test_mark_invoked_rejects_missing_hold(self):
        d = tempfile.mkdtemp()
        log = self._seeded_log(d)
        with self.assertRaises(attribution.LedgerUnavailable) as cm:
            attribution.mark_invoked(log, "ghost")
        self.assertIn("no-hold", str(cm.exception))

    def test_tier_journal_state_single_lock(self):
        d = tempfile.mkdtemp()
        _led, _log, gov, _budget, _p = T._gate(d)
        lock_path = gov._tier_lock_path()
        st = dict(gov._initial_state())
        st.update(tier=1, projection=10.0,
                  evaluated_at=int(time.time()), below_count=0)
        acq = []
        real = locks.FileLock

        class CountingLock(real):
            def __enter__(self):
                acq.append(self.path)
                return super().__enter__()

        import unittest.mock as _mock
        with _mock.patch.object(locks, "FileLock", CountingLock):
            gov._save_state_and_journal(st, "tier_journal.jsonl",
                                        {"t": 1,
                                         "ts": st["evaluated_at"]})
        self.assertEqual(acq.count(lock_path), 1)
        # Both artifacts landed, journal first (snapshot carried).
        self.assertTrue(os.path.exists(
            os.path.join(d, "spend", "tier_journal.jsonl")))
        loaded = gov._load_state(int(time.time()) + 3600)
        self.assertEqual(loaded["tier"], 1)
        # Crash recovery still works: a STALE state file with a
        # newer journal tail replays the journal snapshot (a MISSING
        # state with journal history stays fail-closed deleted).
        stale = dict(gov._initial_state())
        stale.update(evaluated_at=st["evaluated_at"] - 100)
        gov._save_state_locked(stale)
        recovered = gov._load_state(int(time.time()) + 3600)
        self.assertEqual(recovered["tier"], 1)

    def test_pre_provider_cleanup_failure_aborts(self):
        import unittest.mock as _mock
        d = tempfile.mkdtemp()
        _led, log, gov, budget, _p = T._gate(d)
        cfg = T._cfg()
        with _mock.patch.object(
                spend_mod.SpendGovernor, "reserve_usd",
                side_effect=spend_mod.SpendRefused("cap")):
            with _mock.patch.object(
                    budget, "settle_call",
                    side_effect=r15.AbortCycle(
                        "AAPL", {"boom": True})):
                with self.assertRaises(r15.AbortCycle) as cm:
                    workers.run_gated(
                        "generate", "hypothesize", "AAPL", "t1", 1,
                        {"messages": [{"role": "user",
                                       "content": "hi"}]},
                        cfg, T.fake_provider_factory, None, budget,
                        gov, "fake", log, 30.0)
        snap = cm.exception.snapshot
        self.assertIn("pre-provider-cleanup-failure", snap)
        self.assertIn("lease-cleanup-failed",
                      snap["pre-provider-cleanup-failure"])

    def test_pipe_missing_result_is_loud_and_fast(self):
        import unittest.mock as _mock
        from plane import timeout as timeout_mod
        t0 = time.monotonic()
        with _mock.patch.object(timeout_mod, "RECEIVE_TIMEOUT_S",
                                1.0):
            with self.assertRaises(RuntimeError) as cm:
                timeout_mod.run_in_process(_silent_exit, 20)
        self.assertIn("without a result", str(cm.exception))
        self.assertLess(time.monotonic() - t0, 20.0)
        self.assertEqual(multiprocessing.active_children(), [])


if __name__ == "__main__":
    unittest.main()
