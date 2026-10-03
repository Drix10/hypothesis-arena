"""cost_v3 tests (plan/14 section 14.10)."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import costs_v2 as C2
from research.strategy import costs_v3 as C


class CostV3Test(unittest.TestCase):
    def test_impact_square_root_law(self):
        imp = C.impact_usd(1000, 50.0, 0.02, 1_000_000)
        self.assertAlmostEqual(imp, 1000 * 50.0 * 0.02 * math.sqrt(0.001))
        # 4x the size costs 8x the dollars (size x sqrt(size))
        self.assertAlmostEqual(C.impact_usd(4000, 50.0, 0.02, 1_000_000) / imp, 8.0)
        self.assertAlmostEqual(C.impact_usd(1000, 50.0, 0.02, 1_000_000, mult=2.0), 2 * imp)
        for bad in ((0, 50, 0.02, 1e6), (10, 0, 0.02, 1e6), (10, 50, -0.1, 1e6),
                    (10, 50, 0.02, 0)):
            with self.assertRaises(C2.CostError):
                C.impact_usd(*bad)

    def test_fill_v3_adds_impact_to_fill_v2(self):
        v2 = C2.fill_v2("BUY", 49.99, 50.01, 1000, 1.0, 1_000_000)
        v3 = C.fill_v3("BUY", 49.99, 50.01, 1000, 0.02, 1_000_000)
        self.assertEqual(v3["filled"], v2["filled"])
        self.assertAlmostEqual(v3["px"], v2["px"])
        self.assertAlmostEqual(v3["cost_usd"], v2["cost_usd"] + v3["impact_usd"])
        self.assertGreater(v3["impact_usd"], 0.0)

    def test_fill_v3_respects_participation_cap(self):
        v3 = C.fill_v3("SELL", 49.99, 50.01, 50_000, 0.02, 1_000_000)
        self.assertEqual(v3["filled"], 10_000)          # 1% of ADV
        self.assertEqual(v3["deferred"], 40_000)
        self.assertAlmostEqual(v3["impact_usd"],
                               C.impact_usd(10_000, v3["px"], 0.02, 1_000_000))

    def test_borrow_fee_actual_360(self):
        self.assertEqual(C.borrow_fee_usd(-10_000.0, 30, C.ETB_BORROW_RATE), 0.0)
        self.assertAlmostEqual(C.borrow_fee_usd(-10_000.0, 36, C.STRESS_BORROW_RATE),
                               10_000 * 0.005 * 36 / 360)
        self.assertAlmostEqual(C.borrow_fee_usd(10_000.0, 36, 0.01),
                               C.borrow_fee_usd(-10_000.0, 36, 0.01))
        with self.assertRaises(C2.CostError):
            C.borrow_fee_usd(1000.0, -1, 0.01)

    def test_margin_interest_only_on_debit(self):
        self.assertEqual(C.margin_interest_usd(-5_000.0, 30, 0.065), 0.0)
        self.assertAlmostEqual(C.margin_interest_usd(5_000.0, 30, 0.065),
                               5_000 * 0.065 * 30 / 360)

    def test_short_dividend(self):
        self.assertAlmostEqual(C.short_dividend_usd(100, 0.25), 25.0)
        with self.assertRaises(C2.CostError):
            C.short_dividend_usd(-1, 0.25)

    def test_version_tag(self):
        self.assertEqual(C.COST_MODEL_VERSION, "cost_v3")


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL COST_V3 TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
