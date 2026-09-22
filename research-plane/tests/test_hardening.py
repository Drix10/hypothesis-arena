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
        # The authoritative spend ledger carries the reconciled $1 on
        # a minted recovered-* span (never vanished); the orphan
        # span stays unknown evidence (counted, never lost).
        got = con.execute(
            "SELECT usd, is_unknown FROM spans WHERE "
            "span_id LIKE 'recovered-%'").fetchone()
        orphan = con.execute(
            "SELECT usd, is_unknown FROM spans WHERE "
            "span_id='orphan-1'").fetchone()
        con.close()
        self.assertEqual(unk[0], 1)
        self.assertEqual((rec[0], rec[1]), (3.0, 1.0))
        self.assertIn("recovered", rec[2])
        self.assertEqual(tuple(got), (1.0, 0))
        self.assertEqual(tuple(orphan), (3.0, 1))

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

    def test_generate_text_capped_before_ipc(self):
        # A 2 MiB provider string never reaches the envelope: the
        # child drops it (byte-measured) so the pipe never carries
        # it. Spend accounting is the parent's job; the text is None
        # exactly as the parent's own oversize path expects.
        def _huge(cfg):
            class _P:
                def generate(self, messages, max_tokens=None, **kw):
                    return T.FakeMsg("x" * (2 << 20))
            return _P()
        p = self._payload(provider_factory=_huge)
        out = workers._llm_child_main(p)
        self.assertEqual(out["status"], "ok")
        self.assertIsNone(out["text"])
        # Boundary: exactly 1 MiB passes; one byte over does not.
        for n, want in (((1 << 20), False), ((1 << 20) + 1, True)):
            def _mk(cfg, _n=n):
                class _P:
                    def generate(self, messages, max_tokens=None,
                                 **kw):
                        return T.FakeMsg("y" * _n)
                return _P()
            got = workers._llm_child_main(
                self._payload(provider_factory=_mk))
            self.assertEqual(got["text"] is None, want)

    @unittest.skipUnless(T._HAS_SMOL, "smolagents missing")
    def test_extract_prompt_overhead_bound(self):
        # Finding 4: the reservation must cover the ACTUAL first
        # agent prompt (system + framing + tools), not just the
        # brief. A recording provider captures the exact generated
        # messages; every call's measured prompt must fit
        # brief + EXTRACT_PROMPT_OVERHEAD_BYTES (here the overhead
        # dwarfs the 4-byte brief, which is the finding's case).
        seen = []

        class _RecProv(T.FakeProvider):
            def generate(self, messages, max_tokens=None, **kw):
                seen.append(messages)
                return super().generate(messages,
                                        max_tokens=max_tokens, **kw)

        def _factory(cfg):
            return _RecProv(cfg)
        p = {"kind": "extract", "provider_factory": _factory,
             "provider_cfg": dict(T._cfg()), "max_tokens": 100,
             "token_budget": 100000,
             "sandbox_cfg": dict(T.SANDBOX),
             "container_name": "miro-c-s-9", "brief": "TINY",
             "rec_defaults": {}, "steps": 5,
             "tool_factory": lambda: [],
             "executor_factory": T.fake_executor_factory}
        out = workers._llm_child_main(p)
        self.assertEqual(out["status"], "ok")
        self.assertTrue(seen)
        tape = workers.UsageTape(T.FakeProvider({}), 100, 100000)
        bound = len("TINY".encode("utf-8")) + \
            workers.EXTRACT_PROMPT_OVERHEAD_BYTES
        for messages in seen:
            self.assertLessEqual(tape._prompt_bytes(messages), bound)
        # The reservation formula actually spends the overhead:
        comp, steps = 100, 5
        self.assertGreater(
            workers._token_need("extract", bound, comp, steps),
            workers._token_need("extract", len("TINY"), comp,
                                steps))

    @unittest.skipUnless(T._HAS_SMOL, "smolagents missing")
    def test_extract_cleanup_failure_rides_envelope(self):
        # Child-side Docker cleanup failure is data in the envelope
        # ("cleanup"), never a swallowed exception: the parent
        # decides the authoritative reclaim.
        class _FailCleanup(T.FakeExecutor):
            def cleanup(self):
                raise RuntimeError("cleanup boom")
        p = {"kind": "extract",
             "provider_factory": T.FakeProvider,
             "provider_cfg": dict(T._cfg()),
             "max_tokens": 100, "token_budget": 100000,
             "sandbox_cfg": dict(T.SANDBOX),
             "container_name": "miro-c-s-9",
             "brief": "b", "rec_defaults": {}, "steps": 5,
             "tool_factory": lambda: [],
             "executor_factory": _FailCleanup}
        out = workers._llm_child_main(p)
        self.assertEqual(out["status"], "ok")
        self.assertTrue(out["cleanup"])
        self.assertIn("cleanup boom", out["cleanup"])


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

    def _tier2_gov(self, d):
        # Governor that transitions 0 -> 2 on first evaluation
        # ($30 spend vs $150 G0 cap), leaving a rev-1 journal row.
        from plane import spend as spend_mod
        log = os.path.join(d, "spans.jsonl")
        now = int(time.time())
        attribution.append_span(log, 1, "seed", "m", cycle_id="c",
                                symbol="AAPL", prompt_tokens=10,
                                completion_tokens=5, usd=30.0,
                                span_id="t2seed", ts=now)
        gov = spend_mod.SpendGovernor(
            log, dict(T.PRICING), "G0",
            state_dir=os.path.join(d, "spend"))
        tA, _p = gov.evaluate(now)
        self.assertEqual(tA, 2)
        return gov, now

    def test_tier_journal_malformed_denies(self):
        # Finding 7: a damaged tier journal must deny, never resolve
        # to the older weaker tier on disk.
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        self.assertTrue(os.path.exists(jpath))
        with open(jpath, "a", encoding="utf-8") as fh:
            fh.write('{"ts": broken}\n')
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._load_state(now + 7200)
        self.assertEqual(gov.decision(now + 7200)[0], "deny")

    def test_tier_journal_deleted_with_rev_denies(self):
        # Transitions on record (rev 1) plus a missing journal =
        # deleted evidence -> deny. Missing journal with rev 0
        # stays a fresh path.
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        os.remove(jpath)
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._load_state(now + 7200)
        d2 = tempfile.mkdtemp()
        from plane import spend as _sp
        gov2 = _sp.SpendGovernor(
            os.path.join(d2, "spans.jsonl"), dict(T.PRICING), "G0",
            state_dir=os.path.join(d2, "spend"))
        gov2.evaluate(int(time.time()))  # no transition, rev 0
        self.assertEqual(gov2._load_state()["tier_rev"], 0)

    def test_tier_journal_truncated_denies(self):
        # Journal rows older than the state's rev (lost tail rows)
        # deny: the surviving history cannot prove the transition.
        import json as _json
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        with open(jpath, encoding="utf-8") as fh:
            rows = [l for l in fh.read().split("\n") if l.strip()]
        row = _json.loads(rows[-1])
        row["rev"] = 0  # tail evidence older than state rev 1
        with open(jpath, "w", encoding="utf-8") as fh:
            fh.write(_json.dumps(row, sort_keys=True) + "\n")
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._load_state(now + 7200)

    def test_tier_chain_forgery_denies(self):
        # Finding 3: a syntactically valid row attempting T2 -> T0
        # through recovery (valid binding, newer timestamp, rev
        # continuing the chain) must deny — the chain plus the
        # state-mirror rule proves it was not governor-written.
        import json as _json
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        forged_state = gov._initial_state()  # tier 0, current bind
        forged_state.update(tier=0, projection=10.0,
                            evaluated_at=now + 3600)
        forged = {"ts": now + 7200, "from": 2, "to": 0,
                  "projection_30d": 10.0, "cap": 150.0,
                  "stage": "G0", "rev": 2,
                  "state": forged_state}
        with open(jpath, "a", encoding="utf-8") as fh:
            fh.write(_json.dumps(forged, sort_keys=True) + "\n")
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._load_state(now + 7200)
        self.assertEqual(gov.decision(now + 7200)[0], "deny")

    def test_tier_chain_break_denies(self):
        # A chain-broken row (first transition not from Tier 0)
        # denies even though every field is well-typed.
        import json as _json
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        with open(jpath, encoding="utf-8") as fh:
            rows = [l for l in fh.read().split("\n") if l.strip()]
        row = _json.loads(rows[-1])
        row["from"] = 1  # real first transition is from 0
        with open(jpath, "w", encoding="utf-8") as fh:
            fh.write(_json.dumps(row, sort_keys=True) + "\n")
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._load_state(now + 7200)

    def test_tier_legacy_forgery_denies(self):
        # Finding 3: a rev-less row with current binding, a valid
        # weaker-tier state, and a newer timestamp cannot bypass
        # the revision chain through legacy recovery — once
        # revisioned history exists, rev-less rows are corruption.
        import json as _json
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        forged_state = gov._initial_state()  # tier 0, current bind
        forged_state.update(tier=0, projection=10.0,
                            evaluated_at=now + 3600)
        forged = {"ts": now + 7200, "state": forged_state}
        with open(jpath, "a", encoding="utf-8") as fh:
            fh.write(_json.dumps(forged, sort_keys=True) + "\n")
        with self.assertRaises(spend_mod.StateUnavailable) as cm:
            gov._load_state(now + 7200)
        self.assertIn("legacy-forged", str(cm.exception))
        self.assertEqual(gov.decision(now + 7200)[0], "deny")

    def test_tier_future_timestamp_denies(self):
        # Finding 4: a chained-valid row carrying a future timestamp
        # (or a snapshot from the future) denies — same defect
        # class as future start_wall.
        import json as _json
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov, now = self._tier2_gov(d)
        jpath = os.path.join(d, "spend", "tier_journal.jsonl")
        with open(jpath, encoding="utf-8") as fh:
            rows = [l for l in fh.read().split("\n") if l.strip()]
        row = _json.loads(rows[-1])
        row["ts"] = now + 86400
        row["state"]["evaluated_at"] = now + 86400
        with open(jpath, "w", encoding="utf-8") as fh:
            fh.write(_json.dumps(row, sort_keys=True) + "\n")
        with self.assertRaises(spend_mod.StateUnavailable) as cm:
            gov._load_state(now + 7200)
        self.assertIn("future", str(cm.exception))

    def test_journal_write_failure_keeps_new_state(self):
        # State-first persist: if the journal write fails, the new
        # (restrictive) state already stands — no recovery needed,
        # no downgrade possible, journal simply absent.
        import json as _json
        d = tempfile.mkdtemp()
        gov, _log = self._gov(d)
        now = int(time.time())
        gov.evaluate(now)
        st = gov._initial_state()
        st.update(tier=2, projection=130.0, evaluated_at=now + 3600,
                  below_count=0)
        real_journal = gov._journal_locked
        try:
            gov._journal_locked = lambda n, r: (_ for _ in ()).throw(
                OSError("crash"))
            with self.assertRaises(OSError):
                gov._save_state_and_journal(
                    st, T.spend_mod.TIER_JOURNAL_NAME,
                    {"ts": now + 3600, "from": 0, "to": 2,
                     "projection_30d": 130.0, "cap": 150.0,
                     "stage": "G0"})
        finally:
            gov._journal_locked = real_journal
        loaded = gov._load_state(now + 7200)
        self.assertEqual(loaded["tier"], 2)
        self.assertEqual(loaded["evaluated_at"], now + 3600)
        self.assertFalse(os.path.exists(
            os.path.join(d, "spend", "tier_journal.jsonl")))

    def test_legacy_journal_newer_than_state_recovers(self):
        # Backward compat: a journal-first-era row (no rev) newer
        # than the state file is still adopted.
        import json as _json
        d = tempfile.mkdtemp()
        gov, _log = self._gov(d)
        now = int(time.time())
        gov.evaluate(now)  # Tier-0 state, no journal (no transition)
        st = gov._initial_state()
        st.update(tier=2, projection=130.0, evaluated_at=now + 3600,
                  below_count=0)
        row = {"ts": now + 3600, "from": 0, "to": 2,
               "projection_30d": 130.0, "cap": 150.0,
               "stage": "G0", "state": st}
        with open(os.path.join(d, "spend", "tier_journal.jsonl"),
                  "w", encoding="utf-8") as fh:
            fh.write(_json.dumps(row, sort_keys=True) + "\n")
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


def _big_result(n):
    return "x" * n


def _hang_forever():
    import time as _t
    _t.sleep(3600)


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
        # Digest-coherent plant (white-box): the test targets
        # record_unknown's conflict logic, not the digest — an
        # incoherent plant would (correctly) deny at connect.
        planted = ['L1', 'OTHER', 2.0, 1, 0]
        row = con.execute(
            "SELECT digest, n FROM content_digest WHERE "
            "\"table\"='unknown'").fetchone()
        new = "%064x" % (int(row[0], 16) ^ int(
            attribution._hrow(planted), 16))
        con.execute("UPDATE content_digest SET digest=?, n=n+1 "
                    "WHERE \"table\"='unknown'", (new,))
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
        # The conservative reservation is preserved (lease still
        # charged, never silently unwound by the failed cleanup).
        self.assertEqual(budget.llm, 1)

    def test_pipe_missing_result_is_loud_and_fast(self):
        # A child that dies with no envelope reads as immediate EOF
        # (all write ends closed): loud, never a wait to the deadline.
        from plane import timeout as timeout_mod
        t0 = time.monotonic()
        with self.assertRaises(RuntimeError) as cm:
            timeout_mod.run_in_process(_silent_exit, 20)
        self.assertIn("without a result", str(cm.exception))
        self.assertLess(time.monotonic() - t0, 20.0)
        self.assertEqual(multiprocessing.active_children(), [])

    def test_pipe_large_result_streams_while_child_runs(self):
        # ~1 MB result >> 64 KiB OS pipe buffer: the parent drains
        # concurrently, so the child's send() never blocks against a
        # parent that only reads after death (the old deadlock).
        from plane import timeout as timeout_mod
        t0 = time.monotonic()
        out = timeout_mod.run_in_process(_big_result, 60, 1 << 20)
        dt = time.monotonic() - t0
        self.assertEqual(len(out), 1 << 20)
        self.assertLess(dt, 45.0)
        self.assertEqual(multiprocessing.active_children(), [])

    def test_stale_snapshot_cannot_overwrite_restrictive_tier(self):
        # B reads tier-0 state; A persists tier 2; B's only persist
        # path (evaluate) re-reads under the whole-transition lock,
        # so the restrictive tier stands and no downgrade is written.
        # The transition also holds exactly one tier-lock
        # acquisition (single critical section, no nesting).
        import unittest.mock as _mock
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        now = int(time.time())
        attribution.append_span(log, 1, "hypothesize", "m",
                                cycle_id="c", symbol="AAPL",
                                prompt_tokens=10, completion_tokens=5,
                                usd=30.0, span_id="prime", ts=now)
        mk = lambda: spend_mod.SpendGovernor(
            log, dict(T.PRICING), "G0",
            state_dir=os.path.join(d, "spend"))
        govA, govB = mk(), mk()
        stale = govB._load_state(now)
        self.assertEqual(stale["tier"], 0)
        tA, _p = govA.evaluate(now)
        self.assertEqual(tA, 2)
        acq = []
        real = locks.FileLock
        lock_path = govB._tier_lock_path()

        class CountingLock(real):
            def __enter__(self):
                acq.append(self.path)
                return super().__enter__()

        with _mock.patch.object(locks, "FileLock", CountingLock):
            tB, _p = govB.evaluate(now + 1)
        self.assertEqual(tB, 2)
        self.assertEqual(acq.count(lock_path), 1)
        loaded = govA._load_state(now + 3600)
        self.assertEqual(loaded["tier"], 2)
        rows = []
        with open(os.path.join(d, "spend", "tier_journal.jsonl"),
                  encoding="utf-8") as fh:
            for line in fh:
                if line.strip():
                    import json as _json
                    rows.append(_json.loads(line))
        self.assertTrue(rows)
        self.assertTrue(all(r["to"] == 2 for r in rows))

    def test_deleted_spans_table_denies(self):
        # Finding 1: an established ledger that loses its spans
        # table must deny, never recreate empty ($149 of history
        # must not become $0 with a still-valid marker).
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        now = int(time.time())
        attribution.append_span(log, 1, "seed", "m", cycle_id="c",
                                symbol="AAPL", prompt_tokens=10,
                                completion_tokens=5, usd=149.0,
                                span_id="hist", ts=now)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("DROP TABLE spans")
        con.commit()
        con.close()
        with self.assertRaises(attribution.LedgerUnavailable) as cm:
            attribution.append_span(log, 1, "s2", "m", cycle_id="c",
                                    symbol="AAPL", prompt_tokens=1,
                                    completion_tokens=1, usd=1.0,
                                    span_id="s2", ts=now)
        self.assertIn("table-missing:spans", str(cm.exception))

    def test_deleted_hold_tables_deny(self):
        # spend_holds / unknown_holds deletion denies on the next
        # open (reap/has_unreconciled both open the DB).
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        now = int(time.time())
        attribution.append_span(log, 1, "seed", "m", cycle_id="c",
                                symbol="AAPL", prompt_tokens=10,
                                completion_tokens=5, usd=1.0,
                                span_id="hist", ts=now)
        dbp = attribution._db_for(log)
        for table, probe in (
                ("spend_holds", attribution.reap_holds),
                ("unknown_holds", attribution.has_unreconciled)):
            con = sqlite3.connect(dbp)
            con.execute("DROP TABLE %s" % table)
            con.commit()
            con.close()
            with self.assertRaises(
                    attribution.LedgerUnavailable) as cm:
                probe(log)
            self.assertIn("table-missing:%s" % table,
                          str(cm.exception))

    def test_deleted_counters_table_denies(self):
        # The budget twin: a deleted counters table on an
        # established ledger aborts instead of minting fresh rows.
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("DROP TABLE counters")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("table-missing:counters",
                      str(cm.exception.snapshot))

    def test_cycles_schema_version_gating(self):
        # Finding 2: cycles absence is a versioned migration ONLY
        # for old ledgers. A current-version ledger missing cycles
        # denies (deletion); a v1 ledger without it migrates and
        # adopts version 2; a v1 ledger WITH it adopts silently.
        import sqlite3 as _sq
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = _sq.connect(path)
        con.execute("DROP TABLE cycles")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("table-missing:cycles",
                      str(cm.exception.snapshot))
        # Old (v1, pre-registry) ledger: backfill + version adopt.
        con = _sq.connect(path)
        con.execute("PRAGMA user_version=1")
        con.commit()
        con.close()
        led2 = budgets.BudgetLedger(path)
        led2.reserve_call("c", "AAPL", 10, 0)
        con = _sq.connect(path)
        ver = con.execute("PRAGMA user_version").fetchone()[0]
        reg = con.execute("SELECT COUNT(*) FROM cycles").fetchone()
        con.close()
        self.assertEqual(ver, budgets.SCHEMA_VERSION)
        self.assertEqual(reg[0], 1)
        # v1 ledger that already has the table: silent adopt.
        con = _sq.connect(path)
        con.execute("PRAGMA user_version=1")
        con.commit()
        con.close()
        budgets.BudgetLedger(path).reserve_call("c", "AAPL", 10,
                                                 0)
        con = _sq.connect(path)
        ver = con.execute("PRAGMA user_version").fetchone()[0]
        con.close()
        self.assertEqual(ver, budgets.SCHEMA_VERSION)
        # Hard-deadline semantics: the kill ladder begins within a
        # fraction of a second of the deadline — never seconds
        # later — and the attempt is still ambiguous (CallTimeout).
        from plane import timeout as timeout_mod
        t0 = time.monotonic()
        with self.assertRaises(timeout_mod.CallTimeout):
            timeout_mod.run_in_process(_hang_forever, 2)
        dt = time.monotonic() - t0
        self.assertGreaterEqual(dt, 2.0)
        self.assertLess(dt, 6.0)
        self.assertEqual(multiprocessing.active_children(), [])

    def _strip_checks(self, path, table, ddl):
        # Simulate a pre-CHECK legacy schema: same columns, no
        # CHECK constraints, data preserved. Read-validation must
        # still catch corruption the DDL never saw.
        import sqlite3 as _sq
        con = _sq.connect(path)
        con.execute("ALTER TABLE %s RENAME TO %s_legacy" % (table,
                                                             table))
        con.execute(ddl)
        con.execute("INSERT INTO %s SELECT * FROM %s_legacy" % (
            table, table))
        con.execute("DROP TABLE %s_legacy" % table)
        con.commit()
        con.close()

    _COUNTERS_NOCHECK = (
        "CREATE TABLE counters (cycle TEXT, symbol TEXT, llm INT, "
        "tools INT, tokens INT, depth INT, start_wall REAL, "
        "dead INT DEFAULT 0, PRIMARY KEY (cycle, symbol))")
    _LEASES_NOCHECK = (
        "CREATE TABLE leases (lease_id TEXT PRIMARY KEY, cycle TEXT, "
        "symbol TEXT, kind TEXT, reserved INT, actual INT, "
        "settled INT DEFAULT 0)")

    def test_budget_ddl_checks_reject_corruption(self):
        # New-schema layer: corrupt writes cannot land at all.
        import sqlite3 as _sq
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 100, 0)
        con = _sq.connect(path)
        for sql in ("UPDATE counters SET llm=-100",
                    "UPDATE counters SET dead=2",
                    "UPDATE leases SET reserved=-5"):
            with self.assertRaises(_sq.IntegrityError):
                con.execute(sql)
        con.close()

    def test_budget_numeric_corruption_aborts(self):
        # Finding 5: out-of-band edits trip the content digest
        # first (digest-mismatch); the numeric read-validation
        # behind it still aborts (never normalizes) for
        # digest-coherent paths.
        import sqlite3 as _sq
        cases = [
            ("UPDATE counters SET llm=-100", "reserve",
             "digest-mismatch:counters"),
            ("UPDATE counters SET depth=-1000", "check",
             "digest-mismatch:counters"),
            ("UPDATE counters SET dead=2", "snapshot",
             "digest-mismatch:counters"),
            # NB: a negative wall would be legitimately pruned as
            # ancient before validation; +inf is invalid but
            # unpruneable, so it reaches the reader check.
            ("UPDATE counters SET start_wall=1e999", "reserve",
             "digest-mismatch:counters"),
        ]
        for sql, op, why in cases:
            d = tempfile.mkdtemp()
            path = os.path.join(d, "ledger.sqlite3")
            led = budgets.BudgetLedger(path)
            led.reserve_call("c", "AAPL", 10, 0)
            # Legacy schema (no CHECKs) so the corruption lands;
            # read-validation must still abort.
            self._strip_checks(path, "counters",
                               self._COUNTERS_NOCHECK)
            con = _sq.connect(path)
            con.execute(sql)
            con.commit()
            con.close()
            with self.assertRaises(r15.AbortCycle) as cm:
                if op == "reserve":
                    led.reserve_call("c", "AAPL", 10, 0)
                elif op == "check":
                    led.check("c", "AAPL")
                else:
                    led.snapshot("c", "AAPL")
            self.assertIn(why, str(cm.exception.snapshot))
        # Corrupt lease terms mis-settle: reserved/settled validated
        # before any counter moves.
        for sql in ("UPDATE leases SET reserved=-5",
                    "UPDATE leases SET settled=2"):
            d = tempfile.mkdtemp()
            path = os.path.join(d, "ledger.sqlite3")
            led = budgets.BudgetLedger(path)
            lease = led.reserve_call("c", "AAPL", 100, 0)
            self._strip_checks(path, "leases",
                               self._LEASES_NOCHECK)
            con = _sq.connect(path)
            con.execute(sql)
            con.commit()
            con.close()
            with self.assertRaises(r15.AbortCycle) as cm:
                led.settle_call("c", "AAPL", lease, 100)
            self.assertIn("digest-mismatch:leases",
                          str(cm.exception.snapshot))

    def test_ratio_journal_order_denies(self):
        # Finding 4: duplicate, out-of-order, or future days can
        # flip the newest row for a day and break the
        # three-distinct-failed-days rule without any malformed
        # JSON. The journal must be a strictly increasing sequence.
        import json as _json
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov = self._ratio_gov(d, "G2")
        now = int(time.time())
        today = now - (now % 86400)
        jpath = os.path.join(d, "spend",
                             spend_mod.RATIO_JOURNAL_NAME)

        def _rows(days):
            os.makedirs(os.path.dirname(jpath), exist_ok=True)
            with open(jpath, "w", encoding="utf-8") as fh:
                for dd in days:
                    fh.write(_json.dumps(
                        {"day": dd, "state": "failed",
                         "stage": "G2"}) + "\n")

        D = today - 3 * 86400
        _rows([D, D + 86400, D + 86400])  # duplicate day
        with self.assertRaises(spend_mod.StateUnavailable) as cm:
            gov._ratio_rows_strict(0, now)
        self.assertIn("ratio-journal-order", str(cm.exception))
        _rows([D, D + 2 * 86400, D + 86400])  # out of order
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._ratio_rows_strict(0, now)
        _rows([D, today + 86400])  # future day
        with self.assertRaises(spend_mod.StateUnavailable):
            gov._ratio_rows_strict(0, now)
        # Control: an ordered history still reads.
        _rows([D, D + 86400, D + 2 * 86400])
        self.assertEqual(len(gov._ratio_rows_strict(0, now)), 3)

    def test_checkpoint_future_and_naive_reject(self):
        # Finding 5: a future checkpoint extends the budget window
        # like a future start_wall; a naive timestamp has no
        # provable age (host-local interpretation). Both reject.
        from plane import graph as graph_mod
        import datetime as _dt
        future = (_dt.datetime.now(_dt.timezone.utc) +
                  _dt.timedelta(days=1)).isoformat()
        naive = (_dt.datetime.now(_dt.timezone.utc) -
                 _dt.timedelta(hours=1)).replace(
                     tzinfo=None).isoformat()

        class _Snap:
            def __init__(self, created):
                self.created_at = created
                self.config = {"configurable":
                               {"thread_id": "t",
                                "checkpoint_id": "ckpt-9"}}

        class _App:
            checkpointer = object()

            def __init__(self, snap):
                self._snap = snap

            def get_state(self, _cfg):
                return self._snap

        with self.assertRaises(ValueError) as cm:
            graph_mod._reject_stale_thread(_App(_Snap(future)),
                                           "t")
        self.assertIn("future", str(cm.exception))
        with self.assertRaises(ValueError) as cm:
            graph_mod._reject_stale_thread(_App(_Snap(naive)), "t")
        self.assertIn("timezone-less", str(cm.exception))

    def test_cleanup_before_shape_rejection(self):
        # Finding 8: a failed cleanup plus malformed candidates
        # still surfaces the leak — the shape rejection cannot
        # skip the reclaim. Direct unit test on the extracted
        # shaper (no spawn).
        import unittest.mock as _mock
        bad = {"status": "ok", "candidates": "not-a-list",
               "usage": [1, 2], "tool_calls": 0,
               "cleanup": "boom"}
        with _mock.patch.object(workers, "_reap_container",
                                side_effect=RuntimeError(
                                    "rm failed")) as rm:
            out = workers._shape_success_result(
                "extract", bad, [1, 2], 0, "miro-c-1")
        self.assertIn("reap-failed", out["blocked"])
        rm.assert_called_once_with("miro-c-1")
        with _mock.patch.object(workers, "_reap_container") as rm2:
            out2 = workers._shape_success_result(
                "extract", bad, [1, 2], 0, "miro-c-1")
        self.assertEqual(
            out2["blocked"],
            "non-list-candidates+container-reaped-by-parent")
        rm2.assert_called_once_with("miro-c-1")

    def test_retention_list_failure_raises(self):
        # Finding 10: a failed checkpoint LIST is not an empty set
        # (which would silently grow retention); individually bad
        # entries are still skipped.
        from plane import retention as retention_mod

        class _Tup:
            def __init__(self, tid, ts):
                self.config = {"configurable": {"thread_id": tid}}
                self.checkpoint = {"ts": ts}

        class _Saver:
            def __init__(self, tuples=None, boom=False):
                self._tuples = tuples or []
                self._boom = boom

            def list(self, _filter):
                if self._boom:
                    raise ValueError("db gone")
                return self._tuples

        with self.assertRaises(ValueError):
            retention_mod._thread_latest(_Saver(boom=True))
        good = _Tup("t1", "2026-01-01T00:00:00+00:00")
        bad = _Tup("t2", None)
        latest = retention_mod._thread_latest(_Saver([good, bad]))
        self.assertEqual(sorted(latest), ["t1"])

    def test_row_deletion_denies_attribution(self):
        # Finding 1: wholesale row deletion — and same-schema
        # DROP+CREATE, which the column check accepts — resets
        # $149 to $0 under a green schema/marker/token/integrity.
        # The marker-carried history roots must deny.
        import json as _json
        now = int(time.time())

        def _spent(d):
            log = os.path.join(d, "spans.jsonl")
            attribution.append_span(
                log, 1, "seed", "m", cycle_id="c",
                symbol="AAPL", prompt_tokens=10,
                completion_tokens=5, usd=149.0, span_id="hist",
                ts=now)
            return log

        def _probe(log):
            with self.assertRaises(
                    attribution.LedgerUnavailable) as cm:
                attribution.append_span(
                    log, 1, "s2", "m", cycle_id="c",
                    symbol="AAPL", prompt_tokens=1,
                    completion_tokens=1, usd=1.0, span_id="s2",
                    ts=now)
            self.assertIn("digest-mismatch", str(cm.exception))

        d = tempfile.mkdtemp()
        log = _spent(d)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("DELETE FROM spans")
        con.commit()
        con.close()
        _probe(log)
        # Same-schema DROP+CREATE: columns match, history gone.
        d = tempfile.mkdtemp()
        log = _spent(d)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("DROP TABLE spans")
        con.execute(attribution._SPANS_DDL)
        con.commit()
        con.close()
        _probe(log)
        # Unknown-hold wipe.
        d = tempfile.mkdtemp()
        log = _spent(d)
        dbp = attribution._db_for(log)
        attribution.hold_spend(log, "h1", 20.0, now=now)
        attribution.record_unknown(
            log, lease_id="h1", span_id="u1", usd=20.0,
            outcome="timeout", epoch=1, node="hypothesize",
            model_id="m", cycle_id="c", symbol="AAPL", ts=now)
        con = sqlite3.connect(dbp)
        con.execute("DELETE FROM unknown_holds")
        con.commit()
        con.close()
        _probe(log)
        # Spend-hold wipe (outstanding $20 vanishes).
        d = tempfile.mkdtemp()
        log = _spent(d)
        dbp = attribution._db_for(log)
        attribution.hold_spend(log, "h2", 20.0, now=now)
        con = sqlite3.connect(dbp)
        con.execute("DELETE FROM spend_holds")
        con.commit()
        con.close()
        _probe(log)

    def test_prune_to_empty_still_verifies(self):
        # Legitimate full prune must NOT trip the roots: the
        # pre-declared cutoff proves the emptiness.
        now = int(time.time())
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        old = now - (attribution.SPAN_RETAIN_DAYS + 1) * 86400
        attribution.append_span(
            log, 1, "seed", "m", cycle_id="c", symbol="AAPL",
            prompt_tokens=10, completion_tokens=5, usd=149.0,
            span_id="old", ts=old)
        attribution.prune_spans(log, now)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        left = con.execute(
            "SELECT COUNT(*) FROM spans").fetchone()[0]
        con.close()
        self.assertEqual(left, 0)
        attribution.append_span(
            log, 1, "s2", "m", cycle_id="c", symbol="AAPL",
            prompt_tokens=1, completion_tokens=1, usd=1.0,
            span_id="s2", ts=now)  # must not raise

    def test_marker_deleted_over_live_denies(self):
        # A missing trust root over live money denies on both
        # ledgers (it cannot re-baseline history it never saw).
        now = int(time.time())
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(
            log, 1, "seed", "m", cycle_id="c", symbol="AAPL",
            prompt_tokens=10, completion_tokens=5, usd=149.0,
            span_id="hist", ts=now)
        os.remove(attribution._db_for(log) + ".init")
        with self.assertRaises(
                attribution.LedgerUnavailable) as cm:
            attribution.append_span(
                log, 1, "s2", "m", cycle_id="c", symbol="AAPL",
                prompt_tokens=1, completion_tokens=1, usd=1.0,
                span_id="s2", ts=now)
        self.assertIn("marker-deleted", str(cm.exception))
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        budgets.BudgetLedger(path).reserve_call("c", "AAPL",
                                                 10, 0)
        os.remove(path + ".init")
        with self.assertRaises(r15.AbortCycle) as cm:
            budgets.BudgetLedger(path).reserve_call("c", "AAPL",
                                                     10, 0)
        self.assertIn("marker-deleted",
                      str(cm.exception.snapshot))

    def test_crashed_init_reinits(self):
        # Finding 5: a crash-interrupted first init (tables
        # without a token, no marker) re-inits in one transaction
        # instead of wedging on version/token.
        import sqlite3 as _sq2
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        con = _sq2.connect(path)
        con.execute(budgets._COUNTERS_DDL)
        con.execute(budgets._LEASES_DDL)
        con.execute(budgets._META_DDL)
        con.commit()
        con.close()
        budgets.BudgetLedger(path).reserve_call("c", "AAPL",
                                                 10, 0)
        self.assertTrue(os.path.exists(path + ".init"))
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        dbp = attribution._db_for(log)
        con = _sq2.connect(dbp)
        con.execute(attribution._SPANS_DDL)
        con.commit()
        con.close()
        con = attribution._connect(dbp, create=True)
        con.close()
        self.assertTrue(os.path.exists(dbp + ".init"))

    def test_row_deletion_denies_budgets(self):
        # Finding 1 (R15 side): joint counters+registry deletion
        # recreates a zeroed row; cycles-only deletion drops the
        # registry under a live row. Both deny; the pre-existing
        # counters-only case still denies via the in-DB rule.
        import sqlite3 as _sq
        now = time.time()

        def _led(d):
            path = os.path.join(d, "ledger.sqlite3")
            led = budgets.BudgetLedger(path)
            led.reserve_call("c", "AAPL", 10, 0)
            return led, path

        d = tempfile.mkdtemp()
        led, path = _led(d)
        con = _sq.connect(path)
        con.execute("DELETE FROM counters")
        con.execute("DELETE FROM cycles")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("digest-mismatch:counters",
                      str(cm.exception.snapshot))
        d = tempfile.mkdtemp()
        led, path = _led(d)
        con = _sq.connect(path)
        con.execute("DELETE FROM counters")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("digest-mismatch:counters",
                      str(cm.exception.snapshot))
        d = tempfile.mkdtemp()
        led, path = _led(d)
        con = _sq.connect(path)
        con.execute("DELETE FROM cycles")
        con.commit()
        con.close()
        for op in (lambda: led.check("c", "AAPL"),
                   lambda: led.snapshot("c", "AAPL"),
                   lambda: led.reserve_call("c", "AAPL", 10,
                                             0)):
            with self.assertRaises(r15.AbortCycle) as cm:
                op()
            self.assertIn("digest-mismatch:cycles",
                          str(cm.exception.snapshot))

    def test_future_start_wall_denies(self):
        # Finding 2: a start 24h in the future keeps
        # now - start negative, so wall-exhausted can never fire.
        # Deny on every reader, plus at write for the now_wall
        # control parameter.
        import sqlite3 as _sq
        now = time.time()
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = _sq.connect(path)
        con.execute("UPDATE counters SET start_wall=?",
                    (now + 86400,))
        con.commit()
        con.close()
        for op in (lambda: led.check("c", "AAPL"),
                   lambda: led.snapshot("c", "AAPL"),
                   lambda: led.reserve_call("c", "AAPL", 10,
                                             0)):
            with self.assertRaises(r15.AbortCycle) as cm:
                op()
            # Out-of-band wall edit trips the digest before the
            # wall check reads the row.
            self.assertIn("digest-mismatch:counters",
                          str(cm.exception.snapshot))
        # Write-path probe on a FRESH ledger (the ledger above is
        # still corrupted by the UPDATE sub-case, which correctly
        # denies first).
        ledw = budgets.BudgetLedger(
            os.path.join(tempfile.mkdtemp(), "ledger.sqlite3"))
        with self.assertRaises(r15.AbortCycle) as cm:
            ledw.reserve_call("c2", "AAPL", 10, 0,
                              now_wall=now + 86400)
        self.assertIn("future-start-wall",
                      str(cm.exception.snapshot))
        # Control: present and past starts still verify (fresh
        # ledger, past control clock).
        led2 = budgets.BudgetLedger(
            os.path.join(tempfile.mkdtemp(), "ledger.sqlite3"))
        led2.reserve_call("c", "AAPL", 10, 0,
                          now_wall=now - 100)

    def test_update_spend_content_denies(self):
        # Finding 1: UPDATEs that preserve MAX(ts), row counts,
        # schema, token, version, and integrity must still deny —
        # the fingerprint covers canonical row CONTENT.
        now = int(time.time())

        def _spent(d):
            log = os.path.join(d, "spans.jsonl")
            attribution.append_span(
                log, 1, "seed", "m", cycle_id="c",
                symbol="AAPL", prompt_tokens=10,
                completion_tokens=5, usd=149.0, span_id="hist",
                ts=now)
            return log

        def _probe(log, frag):
            with self.assertRaises(
                    attribution.LedgerUnavailable) as cm:
                attribution.append_span(
                    log, 1, "s2", "m", cycle_id="c",
                    symbol="AAPL", prompt_tokens=1,
                    completion_tokens=1, usd=1.0, span_id="s2",
                    ts=now)
            self.assertIn(frag, str(cm.exception))

        d = tempfile.mkdtemp()
        log = _spent(d)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("UPDATE spans SET usd = 0 WHERE span_id='hist'")
        con.commit()
        con.close()
        _probe(log, "digest-mismatch:spans")
        d = tempfile.mkdtemp()
        log = _spent(d)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("UPDATE spans SET model = 'evil' WHERE "
                    "span_id='hist'")
        con.commit()
        con.close()
        _probe(log, "digest-mismatch:spans")

    def test_crash_before_mirror_then_delete_denies(self):
        # Finding 1 crash seam: a row committed but never mirrored
        # (crashed before the marker bump), then deleted before
        # restart, must deny — the same-transaction in-DB digest
        # remembers the row the marker never saw.
        import unittest.mock as _mock
        now = int(time.time())
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(
            log, 1, "seed", "m", cycle_id="c", symbol="AAPL",
            prompt_tokens=10, completion_tokens=5, usd=149.0,
            span_id="hist", ts=now)
        with _mock.patch.object(attribution, "_mirror_roots_locked"):
            attribution.append_span(
                log, 1, "s2", "m", cycle_id="c", symbol="AAPL",
                prompt_tokens=1, completion_tokens=1, usd=1.0,
                span_id="fresh", ts=now)
        dbp = attribution._db_for(log)
        con = sqlite3.connect(dbp)
        con.execute("DELETE FROM spans WHERE span_id='fresh'")
        con.commit()
        con.close()
        with self.assertRaises(
                attribution.LedgerUnavailable) as cm:
            attribution.append_span(
                log, 1, "s3", "m", cycle_id="c", symbol="AAPL",
                prompt_tokens=1, completion_tokens=1, usd=1.0,
                span_id="s3", ts=now)
        self.assertIn("digest-mismatch:spans", str(cm.exception))

    def test_malformed_roots_deny(self):
        # Finding 1 strictness: missing slots, NaN numerics, and
        # non-dict slots deny — never default, never weaken.
        import json as _json
        now = int(time.time())
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(
            log, 1, "seed", "m", cycle_id="c", symbol="AAPL",
            prompt_tokens=10, completion_tokens=5, usd=149.0,
            span_id="hist", ts=now)
        dbp = attribution._db_for(log)

        def _mutate(fn):
            with open(dbp + ".init", encoding="utf-8") as fh:
                body = _json.load(fh)
            fn(body["roots"])
            with open(dbp + ".init", "w",
                       encoding="utf-8") as fh:
                fh.write(_json.dumps(body, allow_nan=True))

        def _denies():
            with self.assertRaises(
                    attribution.LedgerUnavailable) as cm:
                attribution.append_span(
                    log, 1, "s2", "m", cycle_id="c",
                    symbol="AAPL", prompt_tokens=1,
                    completion_tokens=1, usd=1.0, span_id="s2",
                    ts=now)
            self.assertIn("marker-roots-corrupt", str(cm.exception))

        _mutate(lambda r: r.pop("spans"))
        _denies()
        d = tempfile.mkdtemp()
        log = os.path.join(d, "spans.jsonl")
        attribution.append_span(
            log, 1, "seed", "m", cycle_id="c", symbol="AAPL",
            prompt_tokens=10, completion_tokens=5, usd=149.0,
            span_id="hist", ts=now)
        dbp = attribution._db_for(log)
        _mutate(lambda r: r["spans"].__setitem__("count",
                                                   float("nan")))
        _denies()

    def test_update_counters_content_denies(self):
        # Budgets twin: zeroing usage counters passes every numeric
        # check but must deny on content.
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        lease = led.reserve_call("c", "AAPL", 100, 0)
        led.settle_call("c", "AAPL", lease, 40)
        con = sqlite3.connect(path)
        con.execute("UPDATE counters SET llm=0, tools=0, tokens=0, "
                    "depth=0")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.check("c", "AAPL")
        self.assertIn("digest-mismatch:counters",
                      str(cm.exception.snapshot))

    def test_registry_sidecar_deletion_denies(self):
        # Finding 2: counters + cycles + .seen deletion denies
        # (digest fires); dropping the digest table too forces the
        # backfill path, where the adoption flag denies
        # (seen-deleted); losing ONLY the sidecar file re-adopts
        # and stays available.
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("DELETE FROM counters")
        con.execute("DELETE FROM cycles")
        con.commit()
        con.close()
        os.remove(path + ".seen")
        with self.assertRaises(r15.AbortCycle):
            led.reserve_call("c", "AAPL", 10, 0)
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("DELETE FROM counters")
        con.execute("DELETE FROM cycles")
        con.execute("DROP TABLE content_digest")
        con.commit()
        con.close()
        os.remove(path + ".seen")
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("seen-deleted",
                      str(cm.exception.snapshot))
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        os.remove(path + ".seen")
        led.reserve_call("c", "AAPL", 10, 0)  # re-adopts

    def test_marker_unreadable_is_invalid_not_absent(self):
        # An unreadable marker (here: a directory in the way —
        # deterministic, no permission juggling) is "invalid", never
        # "absent": a missing DB with an unreadable marker must not
        # mint a fresh authority.
        d = tempfile.mkdtemp()
        dbp = os.path.join(d, "ledger.sqlite3")
        os.mkdir(dbp + ".init")
        self.assertEqual(locks.marker_state(dbp)[0], "invalid")
        led = budgets.BudgetLedger(dbp)
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("marker-invalid", str(cm.exception.snapshot))
        # Control: a provably missing marker is still absent.
        os.rmdir(dbp + ".init")
        self.assertEqual(locks.marker_state(dbp)[0], "absent")

    def test_tier_state_unreadable_denies_not_tier0(self):
        # A present-but-unreadable tier state (directory in the way)
        # denies — it must not initialize a fresh Tier 0 that would
        # loosen T1/T2/T3 gating.
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        sdir = os.path.join(d, "spend")
        os.makedirs(sdir)
        os.mkdir(os.path.join(sdir, spend_mod.TIER_STATE_NAME))
        gov = spend_mod.SpendGovernor(
            os.path.join(d, "spans.jsonl"), dict(T.PRICING), "G0",
            state_dir=sdir)
        with self.assertRaises(spend_mod.StateUnavailable):
            gov.evaluate()
        verdict, _reason = gov.decision()
        self.assertEqual(verdict, "deny")

    def _ratio_gov(self, d, stage):
        from plane import spend as spend_mod
        log = os.path.join(d, "spans.jsonl")
        now = int(time.time())
        attribution.append_span(log, 1, "seed", "m", cycle_id="c",
                                symbol="AAPL", prompt_tokens=10,
                                completion_tokens=5, usd=30.0,
                                span_id="ratio-seed", ts=now)
        return spend_mod.SpendGovernor(
            log, dict(T.PRICING), stage,
            state_dir=os.path.join(d, "spend"),
            profit_since=lambda since: 100.0)

    def test_ratio_journal_deletion_fails_closed(self):
        # $30 spend vs $100 profit trips a failed ratio day, which is
        # journaled and tripwired in state. Deleting the journal then
        # denies (streak cannot reset to zero); corrupting it denies
        # too.
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov = self._ratio_gov(d, "G2")
        t0 = int(time.time())
        gov.evaluate(t0)
        jpath = os.path.join(d, "spend",
                             spend_mod.RATIO_JOURNAL_NAME)
        self.assertTrue(os.path.exists(jpath))
        os.remove(jpath)
        # Explicit later nows: the hourly state cache must not mask
        # the journal read (the point of the test is the read).
        with self.assertRaises(spend_mod.StateUnavailable):
            gov.evaluate(t0 + 3700)
        verdict, _reason = gov.decision(t0 + 3700)
        self.assertEqual(verdict, "deny")
        # Corrupt (newline-terminated garbage) likewise denies.
        with open(jpath, "w", encoding="utf-8") as fh:
            fh.write('{"day": 1, BROKEN\n')
        with self.assertRaises(spend_mod.StateUnavailable):
            gov.evaluate(t0 + 7400)

    def test_ratio_structural_rows_rejected(self):
        # Finding 6: syntactically valid but structurally wrong
        # journal lines (a list, a string, a dict with wrong
        # keys/types) are corruption — history controlling Tier 3
        # must not silently lose records.
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        gov = self._ratio_gov(d, "G2")
        t0 = int(time.time())
        gov.evaluate(t0)
        jpath = os.path.join(d, "spend",
                             spend_mod.RATIO_JOURNAL_NAME)
        self.assertTrue(os.path.exists(jpath))
        for bad in ('[]\n', '"garbage"\n',
                    '{"day": 1}\n',
                    '{"day": "x", "state": "failed", '
                    '"stage": "G2"}\n',
                    '{"day": 1, "state": "meh", '
                    '"stage": "G2"}\n'):
            with open(jpath, "w", encoding="utf-8") as fh:
                fh.write(bad)
            with self.assertRaises(spend_mod.StateUnavailable):
                gov.evaluate(t0 + 3700)
        # Control: a structurally valid history still reads.
        day = t0 - (t0 % 86400)
        with open(jpath, "w", encoding="utf-8") as fh:
            fh.write('{"day": %d, "state": "failed", '
                     '"stage": "G2"}\n' % day)
        gov.evaluate(t0 + 3700)  # must not raise

    def test_ratio_first_run_without_journal_is_fresh(self):
        # Upgrade path: tier history (G0, suspended, never journaled)
        # plus no ratio journal is a fresh streak, not a deletion —
        # the first counted day journals cleanly.
        from plane import spend as spend_mod
        d = tempfile.mkdtemp()
        g0 = self._ratio_gov(d, "G0")
        g0.evaluate()
        jpath = os.path.join(d, "spend",
                             spend_mod.RATIO_JOURNAL_NAME)
        self.assertFalse(os.path.exists(jpath))
        g2 = self._ratio_gov(d, "G2")
        g2.evaluate()  # must not raise
        self.assertTrue(os.path.exists(jpath))

    def test_migration_crash_residue_denies(self):
        # A present-but-empty registry over live counters is
        # cycles-only deletion (indistinguishable from the crash
        # residue the pre-transactional migration could leave, and
        # healing it would resurrect cover for deleted authority)
        # → deny on every reader, never backfill.
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("DELETE FROM cycles")  # registry-only wipe
        con.commit()
        con.close()
        led2 = budgets.BudgetLedger(path)
        for op in (lambda: led2.reserve_call("c", "AAPL", 10,
                                              0),
                   lambda: led2.check("c", "AAPL"),
                   lambda: led2.snapshot("c", "AAPL")):
            with self.assertRaises(r15.AbortCycle) as cm:
                op()
            self.assertIn("digest-mismatch:cycles",
                          str(cm.exception.snapshot))

    def test_stale_thread_refused(self):
        # A thread_id whose checkpoint outlives the R15 window is
        # refused (same cycle_id must never mint a second budget);
        # new threads, recent threads, and unreadable saver state
        # proceed.
        from plane import graph as graph_mod
        import datetime as _dt
        old = (_dt.datetime.now(_dt.timezone.utc) -
               _dt.timedelta(days=8)).isoformat()
        new = (_dt.datetime.now(_dt.timezone.utc) -
               _dt.timedelta(hours=1)).isoformat()

        class _Snap:
            def __init__(self, created):
                self.created_at = created

        class _App:
            def __init__(self, created, boom=False,
                         checkpointer=True):
                self._created = created
                self._boom = boom
                self.checkpointer = object() if checkpointer else None

            def get_state(self, _cfg):
                if self._boom:
                    raise RuntimeError("storage failure")
                return _Snap(self._created)

        with self.assertRaises(ValueError):
            graph_mod._reject_stale_thread(_App(old), "t")
        graph_mod._reject_stale_thread(_App(new), "t")
        graph_mod._reject_stale_thread(_App(None), "t")
        # Finding 3 (round 5): a failed lookup with a checkpointer
        # present rejects (an old checkpoint plus a storage error
        # is the bypass); only a checkpointer-less app proceeds
        # blind.
        with self.assertRaises(ValueError):
            graph_mod._reject_stale_thread(_App(old, boom=True),
                                           "t")
        graph_mod._reject_stale_thread(
            _App(old, boom=True, checkpointer=False), "t")
        # Finding 6 (round 6): a timestamp-less snapshot is not a
        # nonexistent one — checkpoint identity decides. A real
        # checkpoint id with no readable age rejects; neither id
        # nor timestamp proceeds.
        class _Snap2:
            def __init__(self, created, cid):
                self.created_at = created
                self.config = {"configurable":
                               {"thread_id": "t",
                                "checkpoint_id": cid}}

        class _App2:
            checkpointer = object()

            def __init__(self, snap):
                self._snap = snap

            def get_state(self, _cfg):
                return self._snap

        with self.assertRaises(ValueError):
            graph_mod._reject_stale_thread(
                _App2(_Snap2(None, "ckpt-1")), "t")
        graph_mod._reject_stale_thread(_App2(_Snap2(None, None)),
                                       "t")
        graph_mod._reject_stale_thread(_App2(_Snap2(new, None)),
                                       "t")
        with self.assertRaises(ValueError):
            graph_mod._reject_stale_thread(_App("not-a-ts"), "t")
        # Integration: reusing a live thread is not a stale thread.
        d = tempfile.mkdtemp()
        con = sqlite3.connect(os.path.join(d, "ckpt.sqlite3"),
                              check_same_thread=False)
        from plane import retention as retention_mod
        from langgraph.graph import StateGraph, END
        from typing import TypedDict

        class _S(TypedDict):
            x: int

        g = StateGraph(_S)
        g.add_node("n", lambda s: {"x": 1})
        g.set_entry_point("n")
        g.add_edge("n", END)
        app = g.compile(
            checkpointer=retention_mod.make_saver(con))
        # Integration: the guard reads a real checkpointer — a just
        # written checkpoint is recent, so reuse proceeds.
        app.invoke({"x": 0},
                   {"configurable": {"thread_id": "live"}})
        graph_mod._reject_stale_thread(app, "live")
        graph_mod._reject_stale_thread(app, "never-seen")

    def test_partial_frame_cannot_hang_recv(self):
        # A sender readable-but-never-completing its frame must not
        # hang recv() past the deadline. Hermetic (no subprocess,
        # no platform pipe-fd tricks — an earlier subprocess version
        # passed vacuously on Windows where os.write to a pipe
        # HANDLE fails): a fake conn whose recv blocks until
        # released, simulating the kill closing the write end. This
        # proves the deadline bound AND the post-kill thread exit
        # (no thread debt).
        import threading as _th
        from plane import timeout as timeout_mod
        release = _th.Event()

        class _StalledConn:
            def poll(self, timeout):
                return True
            def recv(self):
                release.wait(30)
                raise EOFError("closed")

        t0 = time.monotonic()
        outcome = timeout_mod._recv_envelope(_StalledConn(), 2)
        dt = time.monotonic() - t0
        self.assertEqual(outcome[0], "none")
        self.assertEqual(len(outcome), 2)  # reader outstanding
        self.assertGreaterEqual(dt, 2.0)
        self.assertLess(dt, 5.0)
        release.set()  # the kill closed the write end
        outcome[1].join(5)
        self.assertFalse(outcome[1].is_alive())

    def test_reap_container_contract(self):
        # Authoritative reclaim: exact argv, nonzero exit and
        # missing-binary both raise (the caller folds them into
        # blocked evidence), empty name is a no-op.
        import subprocess as _sp
        import unittest.mock as _mock
        with _mock.patch.object(_sp, "run") as run:
            run.return_value = _mock.Mock(returncode=0)
            self.assertIsNone(workers._reap_container("miro-c-1"))
            args, kw = run.call_args
            self.assertEqual(args[0],
                             ["docker", "rm", "-f", "miro-c-1"])
            self.assertEqual(kw.get("timeout"), 30)
            run.return_value = _mock.Mock(returncode=1, stderr=b"x")
            with self.assertRaises(RuntimeError):
                workers._reap_container("miro-c-1")
            run.side_effect = FileNotFoundError()
            with self.assertRaises(RuntimeError):
                workers._reap_container("miro-c-1")
        with _mock.patch.object(_sp, "run") as run:
            self.assertIsNone(workers._reap_container(""))
            run.assert_not_called()

    def test_reconcile_over_reservation_is_rejected(self):
        # An attested bill above the worst-case reservation is a
        # defect: reject BEFORE mutating (rollback keeps the hold
        # blocking, nothing settled).
        d = tempfile.mkdtemp()
        log = self._held(d, lease="L9", usd=2.0)
        self._rec(log, lease="L9", span="S9", usd=2.0)
        with self.assertRaises(attribution.LedgerUnavailable) as cm:
            attribution.reconcile_unknown(log, "L9", 2.5, "over")
        self.assertIn("over-reservation", str(cm.exception))
        self.assertTrue(attribution.has_unreconciled(log))
        con = sqlite3.connect(attribution._db_for(log))
        hold = con.execute(
            "SELECT state, usd FROM spend_holds WHERE "
            "lease_id='L9'").fetchone()
        span = con.execute(
            "SELECT usd, is_unknown FROM spans WHERE "
            "span_id='S9'").fetchone()
        con.close()
        self.assertEqual(tuple(hold), ("invoked", 2.0))
        self.assertEqual(tuple(span), (2.0, 1))

    def test_r15_deleted_live_row_aborts(self):
        # A live cycle whose counters row vanishes is a deletion,
        # never a first use: the next reservation aborts.
        d = tempfile.mkdtemp()
        led = budgets.BudgetLedger(os.path.join(d, "ledger.sqlite3"))
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(os.path.join(d, "ledger.sqlite3"))
        con.execute("DELETE FROM counters")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("digest-mismatch:counters", str(cm.exception.snapshot))

    def test_r15_snapshot_and_check_fail_closed_on_deletion(self):
        # Deletion detection covers every reader, not just new
        # reservations: a missing row for a seen cycle aborts in
        # snapshot() (which feeds the cycle estimate) and check(),
        # instead of minting zeros. Genuinely new cycles still read
        # zero.
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        snap = led.snapshot("fresh", "AAPL")
        self.assertEqual(
            (snap["llm"], snap["tokens"]), (0, 0))
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("DELETE FROM counters")
        con.commit()
        con.close()
        with self.assertRaises(r15.AbortCycle) as cm:
            led.snapshot("c", "AAPL")
        self.assertIn("digest-mismatch:counters",
                      str(cm.exception.snapshot))
        with self.assertRaises(r15.AbortCycle):
            led.check("c", "AAPL")

    def test_r15_migration_backfills_registry(self):
        # An old-schema ledger (no cycles table) gains deletion
        # detection immediately on upgrade: existing counters rows
        # are registered from start_wall in the migration itself.
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        led.reserve_call("c", "AAPL", 10, 0)
        con = sqlite3.connect(path)
        con.execute("DROP TABLE cycles")
        # Simulate a genuine pre-registry (v1) ledger: versioned
        # migration (not deletion) is the legitimate path here.
        con.execute("PRAGMA user_version=1")
        con.commit()
        con.close()
        led2 = budgets.BudgetLedger(path)
        led2.reserve_call("c", "AAPL", 10, 0)  # upgrade + resume
        con = sqlite3.connect(path)
        reg = con.execute(
            "SELECT COUNT(*) FROM cycles WHERE cycle='c' AND "
            "symbol='AAPL'").fetchone()[0]
        con.execute("DELETE FROM counters")
        con.commit()
        con.close()
        self.assertEqual(reg, 1)
        with self.assertRaises(r15.AbortCycle) as cm:
            led2.reserve_call("c", "AAPL", 10, 0)
        self.assertIn("digest-mismatch:counters",
                      str(cm.exception.snapshot))

    def test_r15_prune_aged_row_recreates(self):
        # Prune is the only legitimate deleter: an aged-out cycle
        # may start over (registry memory older than retain too).
        d = tempfile.mkdtemp()
        path = os.path.join(d, "ledger.sqlite3")
        led = budgets.BudgetLedger(path)
        old = time.time() - 8 * 86400
        led.reserve_call("c", "AAPL", 10, 0, now_wall=old)
        out = led.reserve_call("c", "AAPL", 10, 0)
        self.assertEqual(out["seq"], 1)

    def test_settle_failure_aborts_with_hold_retained(self):
        # Success-path settlement that does not land is an
        # incomplete protocol: no success return, hold retained and
        # still blocking.
        import unittest.mock as _mock
        d = tempfile.mkdtemp()
        _led, log, gov, budget, _p = T._gate(d)
        cfg = T._cfg()
        with _mock.patch.object(
                attribution, "settle_hold",
                side_effect=attribution.LedgerUnavailable(
                    "disk-gone")):
            with self.assertRaises(r15.AbortCycle) as cm:
                workers.run_gated(
                    "generate", "hypothesize", "AAPL", "t1", 1,
                    {"messages": [{"role": "user",
                                   "content": "hi"}]},
                    cfg, T.fake_provider_factory, None, budget,
                    gov, "fake", log, 30.0)
        self.assertIn("accounting-failure", cm.exception.snapshot)
        self.assertTrue(attribution.has_unreconciled(log))
        self.assertGreater(attribution.outstanding_holds(log), 0)


if __name__ == "__main__":
    unittest.main()
