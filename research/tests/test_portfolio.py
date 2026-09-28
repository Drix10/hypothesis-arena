import unittest

from research.strategy import benchmarks as B
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


if __name__ == "__main__":
    unittest.main()
