import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import benchmarks as B
from research.strategy import delisting as D
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
        sess, px = mkrally(g=1.6)  # a gap past the buffer straight to a breach
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

    def test_order_leaving_equity_under_the_buffer_is_refused(self):
        led = M.MarginLedger(100000.0, TERMS)
        px = {"S": 10.0}  # maintenance is the $5 floor, half the price
        self.assertFalse(P._initial_ok(led, px, "S", -10000, 100000.0))
        self.assertTrue(P._initial_ok(led, px, "S", -8000, 80000.0))
        sess, _ = mkdata()
        flat = {"S": {d: (10.0, 10.0) for d in sess}}
        r = P.run(sess, flat, lambda d, h: {"S": -1.0} if d == sess[0]
                  else None, margin=TERMS)
        qty = r["trades"][0][3]
        self.assertTrue(7000 < qty < 10000)
        self.assertEqual(r["buffer_cuts"], [])
        self.assertEqual(r["breaches"], [])

    def test_buffer_breach_cuts_to_half_gross_and_holds_entries(self):
        sess, px = mkrally()
        calls = []

        def fn(d, h):
            calls.append(d)
            return {"CCC": -1.0} if d == sess[0] else None
        r = P.run(sess, px, fn, margin=TERMS)
        cut = r["buffer_cuts"][0]
        self.assertEqual(r["breaches"], [])
        self.assertNotIn(cut, calls)
        short = r["trades"][0][3]
        after = [t for t in r["trades"] if t[0] > cut]
        self.assertTrue(after)
        self.assertTrue(all(t[2] == "BUY" for t in after))
        left = short - sum(t[3] for t in after)
        self.assertTrue(0 < left < short / 2)
        self.assertTrue(all(t[0] > cut for t in r["trades"][1:]))
        self.assertEqual(r["trades"][1][0], sess[sess.index(cut) + 1])

    def test_cut_resumes_the_strategy_once_restored(self):
        sess, px = mkrally()
        calls = []

        def fn(d, h):
            calls.append(d)
            return {"CCC": -1.0} if d == sess[0] else None
        r = P.run(sess, px, fn, margin=TERMS)
        self.assertGreater(calls[-1], r["buffer_cuts"][0])

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


def truncated(px, sym, last):
    return {s: ({d: v for d, v in series.items() if d <= last}
                if s == sym else series) for s, series in px.items()}


class Delisting(unittest.TestCase):
    def setUp(self):
        self.sess, full = mkdata()
        self.last = self.sess[9]
        self.px = truncated(full, "AAA", self.last)
        self.ends = {"AAA": {"date": self.last, "type": "delisting"}}

    def hold(self, w):
        return lambda d, h: w if d == self.sess[0] else None

    def test_long_is_closed_at_the_delisting_return(self):
        fn = self.hold({"AAA": 1.0})
        r = P.run(self.sess, self.px, fn, ends=self.ends)
        qty = r["trades"][0][3]
        last_close = self.px["AAA"][self.last][1]
        self.assertAlmostEqual(r["equity"][10],
                               r["equity"][9] + qty * last_close * D.LONG_RETURN)
        self.assertEqual(r["equity"][-1], r["equity"][10])

    def test_without_ends_the_last_close_is_carried_forward(self):
        r = P.run(self.sess, self.px, self.hold({"AAA": 1.0}))
        self.assertEqual(r["equity"][-1], r["equity"][9])

    def test_acquisition_closes_a_long_at_the_last_price(self):
        ends = {"AAA": {"date": self.last, "type": "acquisition"}}
        r = P.run(self.sess, self.px, self.hold({"AAA": 1.0}), ends=ends)
        self.assertAlmostEqual(r["equity"][10], r["equity"][9])
        self.assertEqual(r["equity"][-1], r["equity"][10])

    def test_long_return_is_a_parameter(self):
        fn = self.hold({"AAA": 1.0})
        a = P.run(self.sess, self.px, fn, ends=self.ends)["equity"][-1]
        b = P.run(self.sess, self.px, fn, ends=self.ends,
                  long_return=-1.0)["equity"][-1]
        self.assertLess(b, a)

    def test_short_is_covered_at_the_last_price(self):
        sess, full = mkdata()
        px = truncated(full, "BBB", sess[9])
        ends = {"BBB": {"date": sess[9], "type": "delisting"}}
        r = P.run(sess, px, self.hold({"BBB": -0.5}), margin=TERMS, ends=ends)
        self.assertEqual(r["trades"][-1][0], sess[0 + 1])
        self.assertLess(abs(r["equity"][10] - r["equity"][9]), 1.0)
        self.assertEqual(r["equity"][-1], r["equity"][10])

    def test_margin_long_takes_the_delisting_return(self):
        fn = self.hold({"AAA": 0.5})
        base = P.run(self.sess, self.px, fn, margin=TERMS)
        r = P.run(self.sess, self.px, fn, margin=TERMS, ends=self.ends)
        self.assertLess(r["equity"][10], base["equity"][10])

    def test_session_ends_flags_unverified_series(self):
        prices = {"AAA": self.px["AAA"], "BBB": self.px["BBB"]}
        ev = {"AAA": [{"form": "25", "date": "2024-01-08", "accession": "a-1",
                       "security_class": "common"}]}
        ends, unverified = D.session_ends(prices, ev, self.sess[-1])
        self.assertEqual(ends, {"AAA": {"date": self.last, "type": "delisting"}})
        self.assertEqual(unverified, [])
        ends, unverified = D.session_ends(prices, {}, self.sess[-1])
        self.assertEqual((list(ends), unverified), (["AAA"], ["AAA"]))
        with self.assertRaises(D.DelistingError):
            D.require_verified(unverified, 10)
        D.require_verified(unverified, 20)


if __name__ == "__main__":
    unittest.main()
