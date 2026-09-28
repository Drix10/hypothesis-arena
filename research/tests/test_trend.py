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

    def test_ma10_needs_history_then_follows_trend(self):
        s = cal(14)
        fn = T.make_target_fn(s, ["A", "B"])
        flags = T.month_end_flags(s)
        outs = []
        for i, d in enumerate(s):
            m = i // 2
            r = fn(d, {"A": 100 + m * 2, "B": 100 - m * 2})
            if d in flags:
                outs.append(r)
            else:
                self.assertIsNone(r)
        self.assertEqual(outs[8], {})            # < 10 month ends yet
        self.assertEqual(outs[-1], {"A": 0.5})   # A up-trend, B down

    def test_bad_price_goes_to_cash_and_validation(self):
        s = ["2020-01-31", "2020-02-03", "2020-02-28", "2020-03-02"]
        fn = T.make_target_fn(s, ["A"])
        self.assertEqual(fn("2020-01-31", {"A": 0}), {})
        for bad in (dict(variant="x"), dict(universe=[]),
                    dict(universe=["A", "A"]),
                    dict(universe=["BIL"], variant="mom12_vs_tbill")):
            kw = dict(sessions=s, universe=["A"], variant="ma10")
            kw.update(bad)
            with self.assertRaises(T.TrendError):
                T.make_target_fn(**kw)

    def test_mom12_vs_tbill(self):
        s = cal(15)
        fn = T.make_target_fn(s, ["A", "B"], "mom12_vs_tbill")
        flags = T.month_end_flags(s)
        last = None
        for i, d in enumerate(s):
            m = i // 2
            r = fn(d, {"A": 100 * 1.02 ** m, "B": 100 * 0.99 ** m,
                       "BIL": 100 * 1.001 ** m})
            if d in flags:
                last = r
        self.assertEqual(last, {"A": 0.5})


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
