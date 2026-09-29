import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import a_run as A

S = [f"2024-01-{d:02d}" for d in range(1, 30)]


class RunnerHelpers(unittest.TestCase):
    def test_common_sessions_is_intersection(self):
        p = {"A": {"d1": (1, 1), "d2": (1, 1)}, "B": {"d2": (1, 1), "d3": (1, 1)}}
        self.assertEqual(A.common_sessions(p), ["d2"])

    def test_close_returns_alignment(self):
        p = {"X": {"d1": (1, 100.0), "d2": (1, 110.0), "d3": (1, 99.0)}}
        r = A.close_returns(p, "X", ["d1", "d2", "d3"])
        self.assertEqual(r[0], 0.0)
        self.assertAlmostEqual(r[1], 0.10)
        self.assertAlmostEqual(r[2], -0.10)

    def test_participation_cap(self):
        vol = {"X": {d: 1_000_000.0 for d in S}}
        ok, worst = A.participation_ok([(S[25], "X", "BUY", 9000, 1.0)],
                                       vol, S)
        self.assertTrue(ok)
        self.assertAlmostEqual(worst, 0.009)
        ok, _ = A.participation_ok([(S[25], "X", "BUY", 10001, 1.0)], vol, S)
        self.assertFalse(ok)
        ok, w = A.participation_ok([(S[0], "X", "BUY", 1, 1.0)], vol, S)
        self.assertFalse(ok)          # no volume history: fail closed
        self.assertIsNone(w)

    def test_haircut_rule(self):
        cash = [0.0001] * 100
        strong = [0.0010, 0.0012] * 50
        strong2x = [x - 0.0001 for x in strong]
        self.assertTrue(A.haircut_ok(strong, strong2x, cash))
        weak = [0.00011, 0.00013] * 50
        weak2x = [x - 0.0002 for x in weak]
        self.assertFalse(A.haircut_ok(weak, weak2x, cash))

    def test_code_hash_is_stable_and_hex(self):
        h = A.code_hash()
        self.assertEqual(h, A.code_hash())
        self.assertEqual(len(h), 64)

    def test_allowlist_covers_t1_universe(self):
        import json
        with open(os.path.join(A.ROOT, "research", "prereg",
                               "t1_trend_etf_v1.json")) as f:
            u = set(json.load(f)["universe"])
        self.assertTrue(u | {"BIL"} <= A.ALLOWLIST)


def weekdays(start, n):
    import datetime
    d, out = datetime.date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out


class EndToEnd(unittest.TestCase):
    def setUp(self):
        import json
        import random
        import tempfile
        from research.strategy import sip_fetch
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        t = self.tmp.name
        self.saved = (A.DATA, A.LEDGER, A.CHECKPOINT)
        A.DATA = os.path.join(t, "sip")
        A.LEDGER = os.path.join(t, "trials.jsonl")
        A.CHECKPOINT = os.path.join(t, "cp.json")
        self.addCleanup(lambda: setattr(A, "DATA", self.saved[0]) or
                        setattr(A, "LEDGER", self.saved[1]) or
                        setattr(A, "CHECKPOINT", self.saved[2]))
        days = weekdays("2023-01-02", 460)
        rng = random.Random(3)
        os.makedirs(A.DATA)
        for k, sym in enumerate(["VTI", "VEU", "VNQ", "IEF", "DBC", "BIL"]):
            p, rows = 100.0, []
            drift = 0.0001 if sym == "BIL" else 0.0004
            vol = 0.0001 if sym == "BIL" else 0.01
            for d in days:
                c = p * (1 + rng.gauss(drift, vol))
                rows.append({"t": d + "T05:00:00Z", "o": p, "c": c,
                             "h": max(p, c), "l": min(p, c), "v": 1e6})
                p = c
            q = sip_fetch.build_query(sym, "bars", A.FETCH_START,
                                      "2026-01-01T00:00:00Z", "1Day", "all")
            dp, mp = sip_fetch.dataset_paths(A.DATA, sym, "bars", "1Day",
                                             "all")
            sip_fetch._atomic_write(dp, sip_fetch.serialize(rows))
            sip_fetch._atomic_write(mp, json.dumps(
                sip_fetch.manifest(sym, "bars", q, rows)).encode())
        with open(os.path.join(A.ROOT, "research", "prereg",
                               "t1_trend_etf_v1.json")) as f:
            self.pre = json.load(f)
        self.pre["holdout"] = {"start": days[300], "end": "2026-01-01",
                               "rule": "test"}
        self.pre["decision"]["min_days"] = 100

    def test_full_pipeline_ledgers_gates_and_refuses_rerun(self):
        from research.strategy import ledger, prereg
        h = prereg.require_valid(self.pre)
        reports = A.run_t1(self.pre, h, "2026-01-01T00:00:00Z")
        self.assertEqual(set(reports), {"ma10", "mom12_vs_tbill"})
        for r in reports.values():
            self.assertIn(r["verdict"], ("PASS", "FAIL"))
            self.assertEqual(r["prior_trials"], 0)
            self.assertEqual(r["n_trials"], 2)
        led = ledger.TrialLedger(A.LEDGER)
        kinds = [r["kind"] for r in led.rows()]
        self.assertEqual(kinds, ["open", "open", "close", "close"])
        self.assertEqual(led.verify(A.CHECKPOINT), 4)
        with self.assertRaises(ledger.LedgerError):
            A.run_t1(self.pre, h, "2026-01-01T00:00:00Z")

    def test_tampered_dataset_is_refused(self):
        from research.strategy import prereg, sip_fetch
        dp, _ = sip_fetch.dataset_paths(A.DATA, "VTI", "bars", "1Day", "all")
        with open(dp, "a") as f:
            f.write("{}\n")
        with self.assertRaises(sip_fetch.SipError):
            A.run_t1(self.pre, prereg.require_valid(self.pre),
                     "2026-01-01T00:00:00Z")

    def test_deleted_ledger_is_refused(self):
        from research.strategy import ledger, prereg
        h = prereg.require_valid(self.pre)
        A.run_t1(self.pre, h, "2026-01-01T00:00:00Z")
        os.remove(A.LEDGER)
        with self.assertRaises(ledger.LedgerError):
            A.run_t1(self.pre, h, "2026-01-01T00:00:00Z")


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL A-RUN TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
