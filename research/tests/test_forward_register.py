"""Forward-shadow trial registration (ops/forward_register.py). Stdlib only.
Every test writes to a temp ledger; the real research/ledger/ is only read, and
one test proves it is byte-identical after the whole suite."""
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ops import forward_register as F
from ops import forward_ledgers as S
from research.strategy import ledger as L

def _sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _read(path):
    with open(path) as f:
        return f.read()


EXPECTED = ["passive_core"]


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = os.path.join(self.tmp.name, "shadow")
        self.lp = os.path.join(self.tmp.name, "trials.jsonl")
        self.cp = os.path.join(self.tmp.name, "checkpoint.json")

    def reg(self):
        return F.register(self.dir, self.lp, self.cp)

    def opens(self):
        return [r for r in L.TrialLedger(self.lp).rows() if r["kind"] == "open"]


class Register(Base):
    def test_every_expected_strategy_registered_once_and_left_open(self):
        res = self.reg()
        rows = self.opens()
        lids = sorted(r["trial_id"].split(":")[1] for r in rows)
        self.assertEqual(lids, sorted(EXPECTED))
        self.assertEqual(len(rows), len(EXPECTED))
        self.assertEqual(len(res["registered"]), len(EXPECTED))
        led = L.TrialLedger(self.lp)
        self.assertEqual(led.count_trials(), len(EXPECTED))
        self.assertEqual(sorted(led.unclosed()),
                         sorted(r["trial_id"] for r in rows))
        self.assertEqual(led.verify(self.cp), len(EXPECTED))   # checkpoint ok
        self.assertEqual({r["kind"] for r in L.TrialLedger(self.lp).rows()},
                         {"open"})                 # no verdicts invented

    def test_benchmarks_are_not_trials(self):
        self.reg()
        text = _read(self.lp)
        for b in getattr(S, "BENCHMARKS", ()) + ("bench_",):
            self.assertNotIn(b, text)

    def test_row_contents(self):
        self.reg()
        by = {r["trial_id"].split(":")[1]: r for r in self.opens()}
        for r in by.values():
            self.assertEqual(r["hypothesis_card_id"], "forward_shadow")
            self.assertEqual(r["cost_model"], "costs")
            self.assertEqual(r["split_scheme"], "forward_only")
            self.assertEqual(r["window"]["start"], "2026-09-30")
            self.assertEqual(r["runner"], "ops.forward_register")
        self.assertEqual(by["passive_core"]["family"], "passive_core")
        self.assertEqual(by["passive_core"]["prereg_hash"],
                         hashlib.sha256(F.CORE_SPEC.encode()).hexdigest())

    def test_idempotent_second_run_appends_nothing(self):
        self.reg()
        before = (_sha(self.lp), _sha(self.cp))
        res = self.reg()
        self.assertEqual(res["registered"], [])
        self.assertEqual(res["already"], len(EXPECTED))
        self.assertEqual((_sha(self.lp), _sha(self.cp)), before)

    def test_changed_spec_opens_a_new_trial(self):
        self.reg()
        old = F.CORE_SPEC
        F.CORE_SPEC = old + " v2"
        self.addCleanup(setattr, F, "CORE_SPEC", old)
        res = self.reg()
        self.assertEqual(len(res["registered"]), 1)
        self.assertIn(":passive_core:", res["registered"][0])
        self.assertEqual(L.TrialLedger(self.lp).count_trials(),
                         len(EXPECTED) + 1)

    def test_late_registration_is_flagged(self):
        os.makedirs(os.path.join(self.dir, "ledgers"))
        with open(os.path.join(self.dir, "ledgers", "passive_core.jsonl"),
                  "w") as f:
            f.write("{}\n")
        self.assertEqual(self.reg()["late"], ["passive_core"])


class Refusal(Base):
    def _two_trials(self):
        self.reg()
        old = F.CORE_SPEC
        F.CORE_SPEC = old + " v2"
        self.addCleanup(setattr, F, "CORE_SPEC", old)
        self.reg()
        F.CORE_SPEC = old

    def test_broken_chain_refused_and_nothing_appended(self):
        self._two_trials()
        rows = _read(self.lp).split("\n")
        rows[0] = rows[0].replace("forward_only", "forward_ONLY")
        with open(self.lp, "w") as f:
            f.write("\n".join(rows))
        before = _sha(self.lp)
        with self.assertRaises(L.LedgerError):
            self.reg()
        self.assertEqual(_sha(self.lp), before)

    def test_truncated_vs_checkpoint_refused(self):
        self._two_trials()
        rows = _read(self.lp).split("\n")
        with open(self.lp, "w") as f:
            f.write(rows[0] + "\n")
        with self.assertRaises(L.LedgerError):
            self.reg()
        self.assertEqual(len(_read(self.lp).splitlines()), 1)

    def test_torn_tail_refused(self):
        self.reg()
        with open(self.lp, "ab") as f:
            f.write(b'{"partial')
        with self.assertRaises(L.LedgerError):
            self.reg()

    def test_main_exit_codes_and_output(self):
        F.LEDGER, F.CHECKPOINT = self.lp, self.cp
        self.addCleanup(lambda: (setattr(F, "LEDGER", os.path.join(
            F.ROOT, "research", "ledger", "trials.jsonl")),
            setattr(F, "CHECKPOINT", os.path.join(
                F.ROOT, "research", "ledger", "checkpoint.json"))))
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = F.main(["forward_register.py", self.dir])
        self.assertEqual(rc, 0)
        self.assertEqual(len(json.loads(out.getvalue())["registered"]),
                         len(EXPECTED))
        with open(self.lp, "a") as f:
            f.write("garbage\n")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = F.main(["forward_register.py", self.dir])
        self.assertEqual(rc, 2)
        self.assertIn("refused", err.getvalue())
        with self.assertRaises(SystemExit):
            F.main(["forward_register.py"])


class Hook(unittest.TestCase):
    def test_strategy_shadow_hook_never_raises(self):
        orig = F.register

        def boom(*a, **k):
            raise RuntimeError("boom")
        F.register = boom
        self.addCleanup(setattr, F, "register", orig)
        err = io.StringIO()
        with redirect_stderr(err):
            S._register_forward("/nonexistent")   # must not raise
        self.assertIn("forward_register", err.getvalue())

    def test_strategy_shadow_hook_calls_register_once(self):
        calls = []
        orig = F.register
        F.register = lambda d, *a, **k: calls.append(d) or {"registered": []}
        self.addCleanup(setattr, F, "register", orig)
        S._register_forward("somedir")
        self.assertEqual(calls, ["somedir"])


if __name__ == "__main__":
    unittest.main()
