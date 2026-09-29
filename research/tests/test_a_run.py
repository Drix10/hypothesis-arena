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


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL A-RUN TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
