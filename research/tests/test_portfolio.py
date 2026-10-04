import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import benchmarks as B
from research.strategy import margin as M
from research.strategy import portfolio as P


def mkdata(n=30):
    sess = ["2024-%02d-%02d" % (1 + i // 28, 1 + i % 28) for i in range(n)]
    px = {}
    for s, g in (("AAA", 1.004), ("BBB", 0.999)):
        px[s] = {}
        p = 100.0
        for d in sess:
            px[s][d] = (p, p * g)
            p *= g
    return sess, px


class T(unittest.TestCase):
    def test_flat_target_holds_and_costs_positive(self):
        sess, px = mkdata()
        r = P.run(sess, px, lambda d, h: {"AAA": 1.0} if d == sess[0]
                  else None)
        self.assertGreater(r["cost_usd"], 0)
        self.assertGreater(r["equity"][-1], 100000.0 * 0.99)
        self.assertEqual(len([t for t in r["trades"] if t[2] == "BUY"]), 1)

    def test_long_only_and_leverage_refused(self):
        sess, px = mkdata()
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: {"AAA": -0.1})
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: {"AAA": 0.7, "BBB": 0.4})
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: {"ZZZ": 0.1})

    def test_no_lookahead_hist_ends_at_decision_day(self):
        sess, px = mkdata()
        seen = []

        def fn(d, h):
            seen.append((d, len(h["AAA"])))
            return None
        P.run(sess, px, fn)
        for i, (d, n) in enumerate(seen):
            self.assertEqual(n, i + 1)

    def test_switch_uses_settled_cash_only(self):
        # full rotation AAA -> BBB: sale proceeds settle T+1, so the buy of
        # BBB at the same open is limited to the (tiny) settled remainder
        sess, px = mkdata()

        def fn(d, h):
            if d == sess[0]:
                return {"AAA": 1.0}
            if d == sess[5]:
                return {"BBB": 1.0}
            return None
        r = P.run(sess, px, fn)
        buys = [t for t in r["trades"] if t[2] == "BUY" and t[1] == "BBB"]
        first_bbb = sum(t[3] * t[4] for t in buys if t[0] == sess[6])
        self.assertLess(first_bbb, 0.05 * 100000)

    def test_cost_stress_lowers_equity(self):
        sess, px = mkdata()
        fn = lambda d, h: {"AAA": 1.0} if d == sess[0] else None
        a = P.run(sess, px, fn)["equity"][-1]
        b = P.run(sess, px, fn, cost_mult=3.0)["equity"][-1]
        self.assertLess(b, a)

    def test_benchmarks(self):
        sess, px = mkdata()
        px["SPY"], px["IEF"] = px["AAA"], px["BBB"]
        bh = B.buy_and_hold(sess, px, ["AAA", "BBB"])
        sf = B.sixty_forty(sess, px)
        self.assertEqual(len(bh["returns"]), len(sess))
        self.assertEqual(len(sf["returns"]), len(sess))
        c = B.cash_returns(len(sess), 0.04)
        self.assertAlmostEqual((1 + c[0]) ** 252, 1.04, places=9)
        s, p = B.vol_match([0.01, -0.02, 0.03, -0.01],
                           [0.005, -0.01, 0.015, -0.005])
        self.assertAlmostEqual(B.stats.stdev(s), B.stats.stdev(p), places=12)
        with self.assertRaises(B.BenchmarkError):
            B.vol_match([0.01, 0.02], [0.01])
        out = B.compare(bh["returns"], {"cash": c, "sf": sf["returns"]})
        self.assertIn("cash", out)

    def test_rotation_completes_after_settlement(self):
        sess, px = mkdata()

        def fn(d, h):
            if d == sess[0]:
                return {"AAA": 1.0}
            if d == sess[10]:
                return {"BBB": 1.0}
            return None
        r = P.run(sess, px, fn)
        log = [(t[1], t[2]) for t in r["trades"]]
        self.assertEqual(log, [("AAA", "BUY"), ("AAA", "SELL"),
                               ("BBB", "BUY")])
        buy_day = [t[0] for t in r["trades"] if t[1] == "BBB"][0]
        sell_day = [t[0] for t in r["trades"] if t[2] == "SELL"][0]
        self.assertGreater(buy_day, sell_day)  # T+1: never same session
        self.assertEqual(len([t for t in r["trades"]]), 3)  # no daily churn

    def test_idle_cash_earns_the_cash_return(self):
        sess, px = mkdata()
        n = len(sess)
        r = P.run(sess, px, lambda d, h: None, cash_returns=[0.001] * n)
        self.assertAlmostEqual(r["equity"][-1], 100000.0 * 1.001 ** (n - 1),
                               places=4)
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: None, cash_returns=[0.0])
        neg = P.run(sess, px, lambda d, h: None, cash_returns=[-0.001] * n)
        self.assertLess(neg["equity"][-1], 100000.0)

    def test_hold_does_not_drift_rebalance(self):
        sess, px = mkdata()
        r = P.run(sess, px, lambda d, h: {"AAA": 0.5, "BBB": 0.5}
                  if d == sess[0] else None)
        self.assertEqual(len(r["trades"]), 2)


TERMS = M.MarginTerms(margin_rate=0.08)


def mkrally(n=30, g=1.05):
    sess, px = mkdata(n)
    px["CCC"] = {}
    p = 100.0
    for d in sess:
        px["CCC"][d] = (p, p * g)
        p *= g
    return sess, px


class Margin(unittest.TestCase):
    def test_long_only_book_is_unchanged(self):
        sess, px = mkdata()

        def fn(d, h):
            if d == sess[0]:
                return {"AAA": 0.6, "BBB": 0.4}
            if d == sess[10]:
                return {"BBB": 1.0}
            return None
        r = P.run(sess, px, fn)
        self.assertEqual(r["equity"][-1], 100138.89541662647)
        self.assertEqual(r["cost_usd"], 46.75806282576588)
        self.assertEqual(len(r["trades"]), 4)

    def test_short_round_trip_profits_on_a_falling_name(self):
        sess, px = mkdata()

        def fn(d, h):
            if d == sess[0]:
                return {"BBB": -0.5}
            if d == sess[10]:
                return {}
            return None
        r = P.run(sess, px, fn, margin=TERMS)
        self.assertEqual([t[2] for t in r["trades"]], ["SELL", "BUY"])
        self.assertGreater(r["trades"][0][4], 0)
        self.assertGreater(r["equity"][-1], 100000.0)
        self.assertEqual(r["breaches"], [])
        self.assertEqual(r["carry_usd"], 0.0)

    def test_short_pays_the_dividend(self):
        sess, px = mkdata()
        fn = lambda d, h: {"BBB": -0.5} if d == sess[0] else None
        base = P.run(sess, px, fn, margin=TERMS)
        div = P.run(sess, px, fn, margin=TERMS,
                    dividends={"BBB": {sess[5]: 0.50}})
        qty = base["trades"][0][3]
        self.assertAlmostEqual(base["equity"][-1] - div["equity"][-1],
                               qty * 0.50, places=6)
        long_fn = lambda d, h: {"AAA": 0.5} if d == sess[0] else None
        lq = P.run(sess, px, long_fn, margin=TERMS)["trades"][0][3]
        got = P.run(sess, px, long_fn, margin=TERMS,
                    dividends={"AAA": {sess[5]: 0.50}})
        self.assertAlmostEqual(got["equity"][-1]
                               - P.run(sess, px, long_fn,
                                       margin=TERMS)["equity"][-1],
                               lq * 0.50, places=6)

    def test_borrow_and_margin_interest_accrue(self):
        led = M.MarginLedger(100000.0, M.MarginTerms(0.08, borrow_rate=0.02))
        led.trade("X", -100, 10000.0)  # short 100 @ 100, proceeds kept
        px = {"X": 100.0}
        self.assertAlmostEqual(led.accrue_carry(px, 3),
                               10000.0 * 0.02 * 3 / 360)
        led = M.MarginLedger(100000.0, TERMS)
        led.trade("X", 1500, -150000.0)  # cash -50000: a debit balance
        self.assertAlmostEqual(led.accrue_carry({"X": 100.0}, 3),
                               50000.0 * 0.08 * 3 / 360)
        sess, px = mkdata()
        fn = lambda d, h: {"AAA": 1.4} if d == sess[0] else None
        r = P.run(sess, px, fn, margin=TERMS)
        self.assertGreater(r["carry_usd"], 0)
        s2 = P.run(sess, px, fn, margin=M.MarginTerms(0.0))
        self.assertEqual(s2["carry_usd"], 0.0)
        self.assertAlmostEqual(s2["equity"][-1] - r["equity"][-1],
                               r["carry_usd"], places=6)

    def test_maintenance_breach_flattens_and_halts(self):
        sess, px = mkrally()
        calls = []

        def fn(d, h):
            calls.append(d)
            return {"CCC": -1.0} if d == sess[0] else None
        r = P.run(sess, px, fn, margin=TERMS)
        self.assertEqual(len(r["breaches"]), 1)
        breach = r["breaches"][0]
        self.assertNotIn(sess[-1], calls)
        self.assertEqual([t[2] for t in r["trades"]], ["SELL", "BUY"])
        self.assertGreater(r["trades"][1][0], breach)
        self.assertLess(calls[-1], breach)

    def test_requirements_and_refusals(self):
        led = M.MarginLedger(100000.0, TERMS)
        led.trade("L", 100, -10000.0)
        led.trade("S", -100, 2000.0)
        px = {"L": 100.0, "S": 20.0}
        self.assertAlmostEqual(led.maintenance_requirement(px),
                               0.30 * 10000.0 + 100 * 6.0)
        self.assertAlmostEqual(led.initial_requirement(px), 0.5 * 12000.0)
        sess, px = mkdata()
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: {"AAA": 1.0, "BBB": -0.6},
                  margin=TERMS)
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: None, margin=TERMS,
                  cash_returns=[0.0] * len(sess))
        with self.assertRaises(P.PortfolioError):
            P.run(sess, px, lambda d, h: None, dividends={})


if __name__ == "__main__":
    unittest.main()
