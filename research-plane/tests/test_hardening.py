"""Final-hardening P0 regressions (Phase-D audit items 1-7 + markers).

Proven through the REAL authorities (SQLite ledgers, file locks, the
run_gated boundary), never through doubles of the code under test.
Multiprocess tests use the spawn context with module-level children;
a go-file gate forces genuine concurrency on the reservation race.
"""
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


if __name__ == "__main__":
    unittest.main()
