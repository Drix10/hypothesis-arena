"""cost_v2 tests (doc 06 §6.0a)."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import costs_v2 as C
from research.strategy.costs import fill_px


class CostV2Test(unittest.TestCase):
    def test_quote_validation(self):
        mid, sp = C.quote_mid_spread_bps(99.99, 100.01)
        self.assertAlmostEqual(mid, 100.0)
        self.assertAlmostEqual(sp, 2.0, places=6)
        for b, a in ((100, 99), (0, 1), (-1, 1), (None, 1), (True, 2)):
            with self.assertRaises(C.CostError):
                C.quote_mid_spread_bps(b, a)
        self.assertEqual(C.quote_mid_spread_bps(100, 100)[1], 0.0)  # locked ok

    def test_buy_pays_no_reg_fee_sell_pays(self):
        self.assertEqual(C.regulatory_fees("BUY", 100, 50.0), 0.0)
        f = C.regulatory_fees("SELL", 1000, 100.0)
        self.assertAlmostEqual(f, 100000 / 1e6 * 27.80 + 1000 * 0.000166,
                               places=9)
        self.assertAlmostEqual(C.regulatory_fees("SELL", 1000, 100.0, 2.0),
                               2 * f)

    def test_taf_cap(self):
        big = C.regulatory_fees("SELL", 1_000_000, 1.0)
        self.assertAlmostEqual(big, 1e6 / 1e6 * 27.80 + 8.30, places=9)

    def test_fill_matches_paper_fill_v1_and_min_1bp(self):
        r = C.fill_v2("BUY", 100.0, 100.0, 10)  # zero spread -> 1bp floor
        self.assertAlmostEqual(r["px"], fill_px("BUY", 100.0, 0.0))
        self.assertAlmostEqual(r["px"], 100.01)
        r = C.fill_v2("SELL", 99.98, 100.02, 10, mult=2.0)
        self.assertAlmostEqual(r["px"], fill_px("SELL", 100.0, 4.0, 2.0))
        self.assertGreater(r["cost_usd"], 0)

    def test_stress_monotone(self):
        costs = [C.fill_v2("SELL", 99.9, 100.1, 500, mult=m)["cost_usd"]
                 for m in C.STRESS_LEGS]
        self.assertEqual(costs, sorted(costs))
        self.assertLess(costs[0], costs[-1])
        with self.assertRaises(C.CostError):
            C.fill_v2("BUY", 99, 101, 1, mult=0.5)

    def test_participation_cap(self):
        self.assertEqual(C.max_fillable_shares(1_000_000), 10_000)
        self.assertEqual(C.max_fillable_shares(1_000_000, 300), 300)
        r = C.fill_v2("BUY", 99.9, 100.1, 25_000,
                      median_daily_volume_20d=1_000_000)
        self.assertEqual((r["filled"], r["deferred"]), (10_000, 15_000))
        r = C.fill_v2("BUY", 99.9, 100.1, 100, median_daily_volume_20d=50)
        self.assertEqual((r["filled"], r["deferred"], r["px"]), (0, 100, None))
        with self.assertRaises(C.CostError):
            C.max_fillable_shares(0)

    def test_dividends(self):
        self.assertAlmostEqual(C.dividend_credit(100, 0.42), 42.0)
        with self.assertRaises(C.CostError):
            C.dividend_credit(-1, 1)


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL COST_V2 TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
