"""Trial ledger tests (doc 11 §11.0a). Stdlib only."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import ledger as L

H = "a" * 64


def mk(tid="t1", **kw):
    f = dict(trial_id=tid, hypothesis_card_id="hc1", prereg_hash=H,
             family="trend", variant="v0", dataset_hashes=[H],
             code_hash=H, cost_model_version="cost_v2",
             window="2015..2024", split_scheme="wf", runner="test")
    f.update(kw)
    return f


class LedgerTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.addCleanup(self.d.cleanup)
        self.p = os.path.join(self.d.name, "trials.jsonl")
        self.led = L.TrialLedger(self.p)

    def test_open_close_count_and_chain(self):
        self.led.open_trial(**mk("t1"))
        self.led.close_trial("t1", "fail", {"sharpe": -1.09})
        self.led.open_trial(**mk("t2", variant="v1"))
        self.assertEqual(self.led.count_trials(), 2)
        self.assertEqual(self.led.count_trials("trend"), 2)
        self.assertEqual(self.led.count_trials("other"), 0)
        self.assertEqual(self.led.unclosed(), ["t2"])
        self.assertEqual(self.led.verify(), 3)

    def test_declared_n_must_match(self):
        self.led.open_trial(**mk("t1"))
        self.led.assert_declared_n(1)
        with self.assertRaises(L.LedgerError):
            self.led.assert_declared_n(0)

    def test_reuse_close_twice_unknown_and_bad_fields(self):
        self.led.open_trial(**mk("t1"))
        with self.assertRaises(L.LedgerError):
            self.led.open_trial(**mk("t1"))
        with self.assertRaises(L.LedgerError):
            self.led.close_trial("nope", "fail", {})
        self.led.close_trial("t1", "pass", {})
        with self.assertRaises(L.LedgerError):
            self.led.close_trial("t1", "fail", {})
        with self.assertRaises(L.LedgerError):
            self.led.close_trial("t1", "great", {})
        bad = mk("t3")
        del bad["family"]
        with self.assertRaises(L.LedgerError):
            self.led.open_trial(**bad)
        with self.assertRaises(L.LedgerError):
            self.led.open_trial(**mk("t4", prereg_hash="xyz"))
        with self.assertRaises(L.LedgerError):
            self.led.open_trial(**mk("t5", dataset_hashes=[]))
        with self.assertRaises(L.LedgerError):
            self.led.open_trial(**mk("t6", extra=1))
        self.led.open_trial(**mk("t7"))
        with self.assertRaises(ValueError):
            self.led.close_trial("t7", "pass", {"x": float("nan")})
        self.assertEqual(self.led.unclosed(), ["t7"])

    def _lines(self):
        with open(self.p, "rb") as fh:
            return fh.read().split(b"\n")[:-1]

    def _write(self, lines):
        with open(self.p, "wb") as fh:
            fh.write(b"\n".join(lines) + (b"\n" if lines else b""))

    def test_tamper_detected(self):
        self.led.open_trial(**mk("t1"))
        self.led.close_trial("t1", "fail", {"s": 1})
        self.led.open_trial(**mk("t2"))
        ls = self._lines()
        row = json.loads(ls[1])
        row["metrics"]["s"] = 9
        ls[1] = json.dumps(row, sort_keys=True,
                           separators=(",", ":")).encode()
        self._write(ls)
        with self.assertRaises(L.LedgerError):
            self.led.verify()

    def test_delete_middle_and_torn_tail_detected(self):
        for i in range(3):
            self.led.open_trial(**mk("t%d" % i))
        ls = self._lines()
        self._write([ls[0], ls[2]])
        with self.assertRaises(L.LedgerError):
            self.led.verify()
        self._write(ls)
        with open(self.p, "ab") as fh:
            fh.write(b'{"seq":3')
        with self.assertRaises(L.LedgerError):
            self.led.verify()

    def test_checkpoint_catches_tail_truncation_and_rewrite(self):
        cp = os.path.join(self.d.name, "cp.json")
        for i in range(3):
            self.led.open_trial(**mk("t%d" % i))
        self.led.write_checkpoint(cp)
        self.assertEqual(self.led.verify(checkpoint=cp), 3)
        self.led.open_trial(**mk("t9"))
        self.assertEqual(self.led.verify(checkpoint=cp), 4)
        ls = self._lines()
        self._write(ls[:2])  # a valid-chain prefix: only the checkpoint sees it
        self.assertEqual(self.led.verify(), 2)
        with self.assertRaises(L.LedgerError):
            self.led.verify(checkpoint=cp)
        with open(cp, "w") as fh:
            fh.write("garbage")
        with self.assertRaises(L.LedgerError):
            self.led.verify(checkpoint=cp)

    def test_checkpoint_rewrite_with_forged_rows(self):
        cp = os.path.join(self.d.name, "cp.json")
        self.led.open_trial(**mk("t1"))
        self.led.write_checkpoint(cp)
        os.remove(self.p)
        L.TrialLedger(self.p).open_trial(**mk("tX"))  # different history
        with self.assertRaises(L.LedgerError):
            self.led.verify(checkpoint=cp)

    def test_concurrent_appends_keep_chain(self):
        import threading
        errs = []

        def work(k):
            try:
                for i in range(5):
                    self.led.open_trial(**mk("c%d_%d" % (k, i)))
            except Exception as e:  # pragma: no cover
                errs.append(e)
        ts = [threading.Thread(target=work, args=(k,)) for k in range(4)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errs, [])
        self.assertEqual(self.led.verify(), 20)
        self.assertEqual(self.led.count_trials(), 20)

    def test_concurrent_duplicate_open_and_double_close(self):
        import threading
        errs, lock = [], threading.Lock()

        def go(fn):
            try:
                fn()
            except L.LedgerError as e:
                with lock:
                    errs.append(str(e))
        ts = [threading.Thread(target=go, args=(
            lambda: self.led.open_trial(**mk("dup")),)) for _ in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(self.led.count_trials(), 1)
        self.assertEqual(errs.count("trial-id-reused"), 5)
        errs.clear()
        ts = [threading.Thread(target=go, args=(
            lambda: self.led.close_trial("dup", "fail", {}),))
            for _ in range(6)]
        [t.start() for t in ts]
        [t.join() for t in ts]
        self.assertEqual(errs.count("close-twice"), 5)
        self.assertEqual(self.led.verify(), 2)

    def test_unhashable_and_mistyped_fields_refused(self):
        for bad in (dict(trial_id=["x"]), dict(trial_id=""),
                    dict(family=3), dict(window=5), dict(variant=None)):
            with self.assertRaises(L.LedgerError):
                self.led.open_trial(**mk(**bad))
        self.assertEqual(self.led.count_trials(), 0)

    def test_deleted_ledger_is_caught_by_checkpoint(self):
        self.led.open_trial(**mk("a"))
        cp = os.path.join(self.d.name, "cp.json")
        self.led.write_checkpoint(cp)
        os.remove(self.led.path)
        with self.assertRaises(L.LedgerError):
            self.led.verify(cp)

    def test_empty_ledger(self):
        self.assertEqual(self.led.count_trials(), 0)
        self.assertEqual(self.led.verify(), 0)


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL LEDGER TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
