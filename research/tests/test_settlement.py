import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy.settlement import CashLedger, SettlementError as E

D = ["d1", "d2", "d3", "d4"]


class SettlementTest(unittest.TestCase):
    def test_t_plus_1(self):
        L = CashLedger(D, 1000)
        L.buy("A", 10, 1000)
        with self.assertRaises(E):
            L.buy("B", 1, 1)
        L.sell("A", 10, 1010)
        self.assertEqual(L.settled, 0)
        self.assertEqual(L.unsettled(), 1010)
        with self.assertRaises(E):          # proceeds not settled yet
            L.buy("B", 1, 500)
        L.advance("d2")
        self.assertEqual(L.settled, 1010)
        L.buy("B", 5, 500)
        self.assertEqual(L.shares, {"B": 5})

    def test_no_short_no_margin_no_negative(self):
        L = CashLedger(D, 100)
        with self.assertRaises(E):
            L.sell("A", 1, 10)
        with self.assertRaises(E):
            L.buy("A", 1, 100.5)
        with self.assertRaises(E):
            CashLedger(D, -1)
        with self.assertRaises(E):
            CashLedger(["b", "a"], 1)

    def test_advance_rules_and_last_session(self):
        L = CashLedger(D, 100)
        with self.assertRaises(E):
            L.advance("d1")
        with self.assertRaises(E):
            L.advance("zz")
        L.buy("A", 1, 100)
        L.advance("d3")  # skipping sessions is fine
        L.sell("A", 1, 99)
        with self.assertRaises(E):
            L.sell("A", 1, 1)
        L2 = CashLedger(["d1", "d2"], 10)
        L2.buy("A", 1, 10)
        L2.advance("d2")
        with self.assertRaises(E):
            L2.sell("A", 1, 10)  # would settle past the calendar: refuse
        self.assertEqual(L2.shares, {"A": 1})  # refusal is atomic

    def test_whole_shares_and_finite_amounts(self):
        L = CashLedger(D, 1000)
        for bad in (0.5, 0, -1, True, float("nan")):
            with self.assertRaises(E):
                L.buy("A", bad, 10)
        with self.assertRaises(E):
            L.buy("A", 1, float("inf"))
        L.buy("A", 2, 1000.0 + 5e-10)  # within tolerance, never negative
        self.assertEqual(L.settled, 0.0)
        with self.assertRaises(E):
            L.sell("A", 1.5, 10)

    def test_total_cash_conserved_and_dividend(self):
        L = CashLedger(D, 500)
        L.buy("A", 5, 200)
        L.sell("A", 5, 210)
        self.assertAlmostEqual(L.total_cash(), 510)
        L.credit(3.5)
        self.assertAlmostEqual(L.total_cash(), 513.5)


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL SETTLEMENT TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
