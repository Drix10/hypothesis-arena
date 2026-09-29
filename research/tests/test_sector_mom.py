import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import portfolio as P
from research.strategy.sleeves import sector_mom as S

UNI = ["A", "B", "C", "D", "E"]


def data(n=520, growth=None):
    growth = growth or {"A": 1.0009, "B": 1.0006, "C": 1.0003, "D": 0.9995,
                        "E": 0.999, "BIL": 1.0001}
    sess = []
    y, m, d = 2020, 1, 1
    while len(sess) < n:
        sess.append("%04d-%02d-%02d" % (y, m, d))
        d += 1
        if d > 21:
            d, m = 1, m + 1
            if m > 12:
                m, y = 1, y + 1
    px = {}
    for s, g in growth.items():
        p, px[s] = 100.0, {}
        for day in sess:
            px[s][day] = (p, p * g)
            p *= g
    return sess, px


class T(unittest.TestCase):
    def test_top_k_hold_and_cash_park(self):
        sess, px = data()
        fn = S.make_target_fn(sess, UNI, "mom6_0")
        tgt = None
        for i, d in enumerate(sess):
            closes = {s: [px[s][x][1] for x in sess[:i + 1]] for s in px}
            t = fn(d, closes)
            if t:
                tgt = t
        self.assertEqual(set(tgt), {"A", "B", "C"})  # winners only
        self.assertAlmostEqual(sum(tgt.values()), 1.0)

    def test_losers_park_in_cash(self):
        g = {s: 0.999 for s in UNI}
        g["BIL"] = 1.0002
        sess, px = data(growth=g)
        fn = S.make_target_fn(sess, UNI, "mom6_0")
        tgt = None
        for i, d in enumerate(sess):
            closes = {s: [px[s][x][1] for x in sess[:i + 1]] for s in px}
            t = fn(d, closes)
            if t:
                tgt = t
        self.assertEqual(tgt, {"BIL": 1.0})

    def test_no_signal_before_history(self):
        sess, px = data(120)
        fn = S.make_target_fn(sess, UNI, "mom12_1")
        for i, d in enumerate(sess):
            closes = {s: [px[s][x][1] for x in sess[:i + 1]] for s in px}
            self.assertIsNone(fn(d, closes))

    def test_runs_through_the_settled_cash_engine(self):
        sess, px = data()
        r = P.run(sess, px, S.make_target_fn(sess, UNI, "mom6_0"))
        buys = {t[1] for t in r["trades"] if t[2] == "BUY"}
        self.assertTrue({"A", "B", "C"} <= buys)
        self.assertGreater(r["equity"][-1], 100000.0)

    def test_refusals(self):
        sess, _ = data(60)
        with self.assertRaises(S.SectorError):
            S.make_target_fn(sess, UNI, "nope")
        with self.assertRaises(S.SectorError):
            S.make_target_fn(sess, ["A", "A", "B", "C", "D"])
        with self.assertRaises(S.SectorError):
            S.make_target_fn(sess, ["A", "B", "C"])
        with self.assertRaises(S.SectorError):
            S.make_target_fn(sess, UNI[:4] + ["BIL"])

    def test_data_hole_skips_rebalance(self):
        sess, px = data(60)
        fn = S.make_target_fn(sess, UNI, "mom6_0")
        closes = {s: [px[s][x][1] for x in sess[:22]] for s in px}
        closes["B"][-1] = None
        self.assertIsNone(fn(sess[21], closes))


if __name__ == "__main__":
    unittest.main()
