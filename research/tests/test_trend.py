import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy.sleeves import trend as T


def cal(months):
    ds = []
    for m in range(months):
        y, mo = 2020 + m // 12, m % 12 + 1
        ds += [f"{y}-{mo:02d}-{d:02d}" for d in (10, 20)]
    return ds


class TrendTest(unittest.TestCase):
    def test_month_end_no_lookahead(self):
        f = T.month_end_flags(["2020-01-30", "2020-01-31", "2020-02-03"])
        self.assertEqual(list(f), ["2020-01-31"])  # last session unflagged

    def drive(self, fn, s, series):
        """Feed closes exactly as portfolio.run does: history lists."""
        hist = {k: [] for k in series(0)}
        flags = T.month_end_flags(s)
        outs = []
        for i, d in enumerate(s):
            for k, v in series(i // 2).items():
                hist[k].append(v)
            r = fn(d, {k: list(v) for k, v in hist.items()})
            if d in flags:
                outs.append(r)
            else:
                self.assertIsNone(r)
        return outs

    def test_ma10_warmup_in_cash_then_follows_trend(self):
        s = cal(14)
        fn = T.make_target_fn(s, ["A", "B"])
        outs = self.drive(fn, s, lambda m: {
            "A": 100 + m * 2, "B": 100 - m * 2, "BIL": 100.0})
        self.assertEqual(outs[8], {"BIL": 1.0})       # < 10 month ends
        self.assertEqual(outs[-1], {"A": 0.5, "BIL": 0.5})

    def test_no_park_leaves_cash_unallocated(self):
        s = cal(14)
        fn = T.make_target_fn(s, ["A", "B"], park=False)
        outs = self.drive(fn, s, lambda m: {
            "A": 100 + m * 2, "B": 100 - m * 2, "BIL": 100.0})
        self.assertEqual(outs[-1], {"A": 0.5})

    def test_data_hole_skips_rebalance(self):
        s = ["2020-01-31", "2020-02-03", "2020-02-28", "2020-03-02"]
        fn = T.make_target_fn(s, ["A"])
        self.assertIsNone(fn("2020-01-31", {"A": [0.0], "BIL": [1.0]}))
        self.assertIsNone(fn("2020-01-31", {"A": [5.0]}))  # no cash leg
        for bad in (dict(variant="x"), dict(universe=[]),
                    dict(universe=["A", "A"]), dict(universe=["BIL"])):
            kw = dict(sessions=s, universe=["A"], variant="ma10")
            kw.update(bad)
            with self.assertRaises(T.TrendError):
                T.make_target_fn(**kw)

    def test_mom12_vs_tbill(self):
        s = cal(15)
        fn = T.make_target_fn(s, ["A", "B"], "mom12_vs_tbill")
        outs = self.drive(fn, s, lambda m: {
            "A": 100 * 1.02 ** m, "B": 100 * 0.99 ** m,
            "BIL": 100 * 1.001 ** m})
        self.assertEqual(outs[-1], {"A": 0.5, "BIL": 0.5})

    def test_runs_end_to_end_through_the_portfolio_engine(self):
        from research.strategy import portfolio as P
        s = cal(30)
        px = {}
        for k, g in (("A", 1.02), ("B", 0.99), ("BIL", 1.001)):
            px[k], p = {}, 100.0
            for d in s:
                px[k][d] = (p, p * g)
                p *= g
        r = P.run(s, px, T.make_target_fn(s, ["A", "B"]))
        held = {t[1] for t in r["trades"] if t[2] == "BUY"}
        self.assertIn("A", held)
        self.assertGreater(r["equity"][-1], 100000.0)


class PreregFileTest(unittest.TestCase):
    def test_t1_prereg_valid(self):
        import json
        from research.strategy import prereg as P
        f = os.path.join(os.path.dirname(__file__), "..", "prereg",
                         "t1_trend_etf_v1.json")
        with open(f) as fh:
            d = json.load(fh)
        self.assertEqual(P.validate(d), [])
        self.assertEqual(d["variants"], list(T.VARIANTS))


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL TREND TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
