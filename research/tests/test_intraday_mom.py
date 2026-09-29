import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy.sleeves import intraday_mom as I


def day(prev_close, first_close, last_open, last_close, n=13):
    """(open, close) 30-minute bars; only the first close and the last bar
    matter to the rule."""
    bars = [(prev_close, prev_close)] * n
    bars[0] = (prev_close, first_close)
    bars[-1] = (last_open, last_close)
    return bars


def series(n, up=True):
    days, order, prev = {}, [], 100.0
    for i in range(n):
        d = "2024-%02d-%02d" % (1 + i // 28, 1 + i % 28)
        first = prev * (1.002 if up else 0.998)
        last = first * 1.001
        days[d] = day(prev, first, first, last)
        prev = days[d][-1][1]
        order.append(d)
    return days, order


class T(unittest.TestCase):
    def test_r1_uses_previous_close(self):
        days, order = series(5)
        r = I.first_half_hour_returns(days, order)
        self.assertNotIn(order[0], r)  # no previous close
        self.assertAlmostEqual(r[order[1]], 0.002, places=9)

    def test_pos_rule_trades_only_after_an_up_open(self):
        up, order = series(10, True)
        dn, _ = series(10, False)
        self.assertEqual(len(I.decisions(up, order, "pos")), 9)
        self.assertEqual(I.decisions(dn, order, "pos"), set())

    def test_no_lookahead(self):
        days, order = series(30)
        base = I.decisions(days, order, "pos")
        d = order[10]
        alt = dict(days)
        bars = list(alt[d])
        bars[-1] = (bars[-1][0], bars[-1][1] * 0.5)  # later data changes
        alt[d] = bars
        self.assertEqual(I.decisions(alt, order, "pos"), base)

    def test_tercile_needs_history_and_uses_past_only(self):
        days, order, prev = {}, [], 100.0
        for i in range(160):
            d = "2024-%02d-%02d" % (1 + i // 28, 1 + i % 28)
            first = prev * (1 + 0.0005 * ((i * 7) % 11 - 5))  # varied r1
            days[d] = day(prev, first, first, first * 1.001)
            prev = days[d][-1][1]
            order.append(d)
        got = I.decisions(days, order, "top_tercile")
        self.assertTrue(got)
        self.assertTrue(all(order.index(x) > I.MIN_HISTORY for x in got))
        # A later spike cannot change an earlier decision.
        alt = dict(days)
        alt[order[-1]] = day(prev, prev * 1.5, 1.0, 1.0)
        early = {x for x in got if order.index(x) < len(order) - 1}
        self.assertEqual({x for x in I.decisions(alt, order, "top_tercile")
                          if order.index(x) < len(order) - 1}, early)

    def test_incomplete_day_breaks_the_chain(self):
        days, order = series(6)
        days[order[3]] = days[order[3]][:5]  # early close / data hole
        r = I.first_half_hour_returns(days, order)
        self.assertNotIn(order[3], r)
        self.assertNotIn(order[4], r)  # its previous close is unknown
        self.assertIn(order[5], r)

    def test_costs_and_stress(self):
        days, order = series(40)
        a = I.simulate(days, order, "pos")
        b = I.simulate(days, order, "pos", mult=3.0)
        self.assertGreater(a["cost_usd"], 0)
        self.assertLess(sum(b["pnl"]), sum(a["pnl"]))
        sells = [t for t in a["trades"] if t[2] == "SELL"]
        self.assertEqual(len(sells), len(a["trades"]) // 2)
        self.assertEqual(len(a["pnl"]), len(order))

    def test_whole_shares_and_no_short(self):
        days, order = series(20)
        for t in I.simulate(days, order, "pos")["trades"]:
            self.assertIsInstance(t[3], int)
            self.assertGreater(t[3], 0)

    def test_refusals(self):
        days, order = series(5)
        with self.assertRaises(I.IntradayError):
            I.decisions(days, order, "nope")


if __name__ == "__main__":
    unittest.main()
