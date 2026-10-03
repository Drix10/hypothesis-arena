"""Cost model tests (plan/math.md, Costs and capacity)."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import costs as C


class FillTest(unittest.TestCase):
    def test_quote_validation(self):
        mid, sp = C.quote_mid_spread_bps(99.99, 100.01)
        self.assertAlmostEqual(mid, 100.0)
        self.assertAlmostEqual(sp, 2.0, places=6)
        for b, a in ((100, 99), (0, 1), (-1, 1), (None, 1), (True, 2),
                     (1, float("inf")), (float("nan"), 1)):
            with self.assertRaises(C.CostError):
                C.quote_mid_spread_bps(b, a)
        self.assertEqual(C.quote_mid_spread_bps(100, 100)[1], 0.0)

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

    def test_fill_price_and_min_1bp(self):
        self.assertLess(C.fill_px("BUY", 100.0, 2.0, 1.0),
                        C.fill_px("BUY", 100.0, 2.0, 3.0))
        self.assertGreater(C.fill_px("SELL", 100.0, 2.0, 1.0),
                           C.fill_px("SELL", 100.0, 2.0, 3.0))
        self.assertEqual(C.fill_px("BUY", 100.0, 0.0, 1.0), 100.0 * 1.0001)
        with self.assertRaises(ValueError):
            C.fill_px("HOLD", 100.0, 1.0)
        r = C.fill("BUY", 100.0, 100.0, 10)  # zero spread -> 1 bp floor
        self.assertAlmostEqual(r["px"], 100.01)
        r = C.fill("SELL", 99.98, 100.02, 10, mult=2.0)
        self.assertAlmostEqual(r["px"], C.fill_px("SELL", 100.0, 4.0, 2.0))
        self.assertGreater(r["cost_usd"], 0)

    def test_stress_monotone(self):
        costs = [C.fill("SELL", 99.9, 100.1, 500, mult=m)["cost_usd"]
                 for m in C.STRESS_LEGS]
        self.assertEqual(costs, sorted(costs))
        self.assertLess(costs[0], costs[-1])
        with self.assertRaises(C.CostError):
            C.fill("BUY", 99, 101, 1, mult=0.5)

    def test_participation_cap(self):
        self.assertEqual(C.max_fillable_shares(1_000_000), 10_000)
        self.assertEqual(C.max_fillable_shares(1_000_000, 300), 300)
        r = C.fill("BUY", 99.9, 100.1, 25_000,
                   median_daily_volume_20d=1_000_000)
        self.assertEqual((r["filled"], r["deferred"]), (10_000, 15_000))
        r = C.fill("BUY", 99.9, 100.1, 100, median_daily_volume_20d=50)
        self.assertEqual((r["filled"], r["deferred"], r["px"]), (0, 100, None))
        with self.assertRaises(C.CostError):
            C.max_fillable_shares(0)

    def test_dividends(self):
        self.assertAlmostEqual(C.dividend_credit(100, 0.42), 42.0)
        with self.assertRaises(C.CostError):
            C.dividend_credit(-1, 1)


class ImpactAndCarryTest(unittest.TestCase):
    def test_impact_square_root_law(self):
        imp = C.impact_usd(1000, 50.0, 0.02, 1_000_000)
        self.assertAlmostEqual(imp, 1000 * 50.0 * 0.02 * math.sqrt(0.001))
        # 4x the size costs 8x the dollars (size x sqrt(size))
        self.assertAlmostEqual(
            C.impact_usd(4000, 50.0, 0.02, 1_000_000) / imp, 8.0)
        self.assertAlmostEqual(
            C.impact_usd(1000, 50.0, 0.02, 1_000_000, mult=2.0), 2 * imp)
        for bad in ((0, 50, 0.02, 1e6), (10, 0, 0.02, 1e6), (10, 50, -0.1, 1e6),
                    (10, 50, 0.02, 0)):
            with self.assertRaises(C.CostError):
                C.impact_usd(*bad)

    def test_impact_adds_to_fill(self):
        base = C.fill("BUY", 49.99, 50.01, 1000, 1.0, 1_000_000)
        full = C.fill_with_impact("BUY", 49.99, 50.01, 1000, 0.02, 1_000_000)
        self.assertEqual(full["filled"], base["filled"])
        self.assertAlmostEqual(full["px"], base["px"])
        self.assertAlmostEqual(full["cost_usd"],
                               base["cost_usd"] + full["impact_usd"])
        self.assertGreater(full["impact_usd"], 0.0)

    def test_impact_respects_participation_cap(self):
        full = C.fill_with_impact("SELL", 49.99, 50.01, 50_000, 0.02, 1_000_000)
        self.assertEqual(full["filled"], 10_000)          # 1% of ADV
        self.assertEqual(full["deferred"], 40_000)
        self.assertAlmostEqual(
            full["impact_usd"], C.impact_usd(10_000, full["px"], 0.02, 1_000_000))

    def test_borrow_fee_actual_360(self):
        self.assertEqual(C.borrow_fee_usd(-10_000.0, 30, C.ETB_BORROW_RATE), 0.0)
        self.assertAlmostEqual(
            C.borrow_fee_usd(-10_000.0, 36, C.STRESS_BORROW_RATE),
            10_000 * 0.005 * 36 / 360)
        self.assertAlmostEqual(C.borrow_fee_usd(10_000.0, 36, 0.01),
                               C.borrow_fee_usd(-10_000.0, 36, 0.01))
        with self.assertRaises(C.CostError):
            C.borrow_fee_usd(1000.0, -1, 0.01)

    def test_margin_interest_only_on_debit(self):
        self.assertEqual(C.margin_interest_usd(-5_000.0, 30, 0.065), 0.0)
        self.assertAlmostEqual(C.margin_interest_usd(5_000.0, 30, 0.065),
                               5_000 * 0.065 * 30 / 360)

    def test_short_dividend(self):
        self.assertAlmostEqual(C.short_dividend_usd(100, 0.25), 25.0)
        with self.assertRaises(C.CostError):
            C.short_dividend_usd(-1, 0.25)


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL COST TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
