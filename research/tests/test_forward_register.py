"""Forward-shadow trial registration (ops/forward_register.py). Stdlib only.
Every test writes to a temp ledger; the real research/ledger/ is only read, and
one test proves it is byte-identical after the whole suite."""
import hashlib
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ops import event_shadow
from ops import forward_register as F
from ops import macro_shadow
from ops import sleeve_shadow as S
from research.strategy import ledger as L
from research.strategy import prereg

REAL = os.path.join(os.path.dirname(__file__), "..", "ledger")
REAL_FILES = [os.path.join(REAL, n) for n in ("trials.jsonl", "checkpoint.json")]


def _sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def _read(path):
    with open(path) as f:
        return f.read()


REAL_BEFORE = [_sha(p) for p in REAL_FILES]

EXPECTED = (["core_passive_v1", "trend_etf_v1", "sector_mom_v1"]
            + sorted(event_shadow.E1_IDS.values())
            + sorted(event_shadow.I1_IDS.values())
            + ["macro_lite_v1", "core_passive_v1__jev", "trend_etf_v1__jev",
               "sector_mom_v1__jev"])


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
    def test_every_expected_sleeve_registered_once_and_left_open(self):
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
            self.assertEqual(r["hypothesis_card_id"], "forward_shadow_2026q4")
            self.assertEqual(r["cost_model_version"], "cost_v2")
            self.assertEqual(r["split_scheme"], "forward_only")
            self.assertEqual(r["window"]["start"], "2026-09-30")
            self.assertEqual(r["runner"], "ops.forward_register")
        for lid in ("core_passive_v1__jev", "trend_etf_v1__jev",
                    "sector_mom_v1__jev"):
            self.assertEqual(by[lid]["family"], "jev_filter")
        with open(os.path.join(F.PREREG, "m1_macro_lite_v1.json")) as f:
            macro = json.load(f)
        self.assertEqual(by["macro_lite_v1"]["prereg_hash"],
                         prereg.require_valid(macro))
        self.assertEqual(by["macro_lite_v1"]["family"], "macro")
        self.assertEqual(by["core_passive_v1"]["prereg_hash"],
                         hashlib.sha256(F.CORE_SPEC.encode()).hexdigest())
        with open(os.path.join(F.PREREG, "t2_sector_mom_v1.json")) as f:
            t2 = json.load(f)
        self.assertEqual(by["sector_mom_v1"]["prereg_hash"],
                         prereg.prereg_hash(t2))
        self.assertEqual(len({by[v]["prereg_hash"]
                              for v in event_shadow.E1_IDS.values()}), 1)
        self.assertEqual(len({by[v]["trial_id"]
                              for v in event_shadow.E1_IDS.values()}), 3)

    def test_idempotent_second_run_appends_nothing(self):
        self.reg()
        before = (_sha(self.lp), _sha(self.cp))
        res = self.reg()
        self.assertEqual(res["registered"], [])
        self.assertEqual(res["already"], len(EXPECTED))
        self.assertEqual((_sha(self.lp), _sha(self.cp)), before)

    def test_appends_to_a_copy_of_the_real_ledger_and_keeps_its_chain(self):
        shutil.copy(REAL_FILES[0], self.lp)
        shutil.copy(REAL_FILES[1], self.cp)
        n0 = L.TrialLedger(self.lp).verify(self.cp)
        n_open0 = L.TrialLedger(self.lp).count_trials()
        self.reg()
        led = L.TrialLedger(self.lp)
        self.assertEqual(led.verify(self.cp), n0 + len(EXPECTED))
        self.assertEqual(led.count_trials(), n_open0 + len(EXPECTED))
        self.assertEqual(self.reg()["registered"], [])

    def test_changed_spec_opens_a_new_trial(self):
        self.reg()
        old = F.CORE_SPEC
        F.CORE_SPEC = old + " v2"
        self.addCleanup(setattr, F, "CORE_SPEC", old)
        res = self.reg()
        self.assertEqual(len(res["registered"]), 1)
        self.assertIn(":core_passive_v1:", res["registered"][0])
        self.assertEqual(L.TrialLedger(self.lp).count_trials(),
                         len(EXPECTED) + 1)

    def test_late_registration_is_flagged(self):
        os.makedirs(os.path.join(self.dir, "sleeves"))
        with open(os.path.join(self.dir, "sleeves", "macro_lite_v1.jsonl"),
                  "w") as f:
            f.write("{}\n")
        self.assertEqual(self.reg()["late"], ["macro_lite_v1"])


class Refusal(Base):
    def test_broken_chain_refused_and_nothing_appended(self):
        self.reg()
        rows = _read(self.lp).split("\n")
        rows[3] = rows[3].replace("forward_only", "forward_ONLY")
        with open(self.lp, "w") as f:
            f.write("\n".join(rows))
        before = _sha(self.lp)
        with self.assertRaises(L.LedgerError):
            self.reg()
        self.assertEqual(_sha(self.lp), before)

    def test_truncated_vs_checkpoint_refused(self):
        self.reg()
        rows = _read(self.lp).split("\n")
        with open(self.lp, "w") as f:
            f.write("\n".join(rows[:5]) + "\n")
        with self.assertRaises(L.LedgerError):
            self.reg()
        self.assertEqual(len(_read(self.lp).splitlines()), 5)

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


class Prereg(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(F.PREREG, "m1_macro_lite_v1.json")) as f:
            self.p = json.load(f)

    def test_valid_forward_only_new_signal(self):
        self.assertEqual(prereg.validate(self.p), [])
        self.assertEqual(self.p["family"], "macro")
        self.assertNotIn("llm", self.p)
        self.assertEqual(self.p["decision"]["new_signal_tstat_min"], 3.0)
        self.assertEqual(self.p["split"]["scheme"], "forward_only")
        self.assertEqual(self.p["holdout"]["start"], "2026-09-30")
        self.assertGreaterEqual(self.p["holdout"]["start"], S.FORWARD_START)
        self.assertEqual(len(self.p["variants"]), 1)
        self.assertEqual(self.p["sleeve"], macro_shadow.SLEEVE_ID)
        for k in ("FORWARD", "no historical holdout", "3.0"):
            self.assertIn(k, self.p["hypothesis"] + self.p["holdout"]["rule"])

    def test_matches_macro_shadow_signal(self):
        sig = self.p["signal"]
        self.assertEqual(macro_shadow.TILT, 0.10)
        self.assertIn("TILT = 10 percentage points", sig)
        self.assertIn(macro_shadow.SERIES, sig)
        self.assertIn("FRED:" + macro_shadow.SERIES, self.p["universe"])
        for s in macro_shadow.BASE:
            self.assertIn(s, self.p["universe"])
        self.assertIn("more than %d days old" % macro_shadow.MAX_ANCHOR_AGE_DAYS,
                      sig)
        self.assertIn("more than %d days before" % macro_shadow.MAX_PRIOR_GAP_DAYS,
                      sig)


class Hook(unittest.TestCase):
    def test_sleeve_shadow_hook_never_raises(self):
        orig = F.register

        def boom(*a, **k):
            raise RuntimeError("boom")
        F.register = boom
        self.addCleanup(setattr, F, "register", orig)
        err = io.StringIO()
        with redirect_stderr(err):
            S._register_forward("/nonexistent")   # must not raise
        self.assertIn("forward_register", err.getvalue())

    def test_sleeve_shadow_hook_calls_register_once(self):
        calls = []
        orig = F.register
        F.register = lambda d, *a, **k: calls.append(d) or {"registered": []}
        self.addCleanup(setattr, F, "register", orig)
        S._register_forward("somedir")
        self.assertEqual(calls, ["somedir"])


class RealLedgerUntouched(unittest.TestCase):
    def test_zz_real_ledger_byte_identical(self):
        self.assertEqual([_sha(p) for p in REAL_FILES], REAL_BEFORE)


if __name__ == "__main__":
    unittest.main()
