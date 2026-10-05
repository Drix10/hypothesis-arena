import math
import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import etf_trend as E


def sessions(n=300):
    out, d = [], date(2024, 1, 2)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


SESS = sessions()
CUT = max(i for i in range(len(SESS) - 1) if SESS[i][:7] != SESS[i + 1][:7]) + 1
LAST = SESS[CUT - 1]


def series(drift, swing, n=CUT):
    """Daily returns alternate drift+swing and drift-swing, so annual
    volatility is about swing * sqrt(252)."""
    c, out = 100.0, []
    for i in range(n):
        out.append(c)
        c *= 1.0 + drift + (swing if i % 2 else -swing)
    return out


def make(**kw):
    kw.setdefault("universe", ["UP", "DN", "BIL"])
    return E.EtfTrend(SESS, **kw)


def book(**kw):
    return {"UP": series(0.002, 0.01), "DN": series(-0.002, 0.01),
            "BIL": series(0.0, 0.0), **kw}


class EtfTrendTest(unittest.TestCase):
    def test_sign_and_direction(self):
        w = make()(LAST, book())
        self.assertGreater(w["UP"], 0)
        self.assertLess(w["DN"], 0)
        self.assertNotIn("BIL", w)

    def test_none_off_month_end(self):
        self.assertIsNone(make()(SESS[CUT - 2], book()))

    def test_volatility_scaling(self):
        swing = 0.0126
        closes = {"UP": series(0.002, swing), "BIL": series(0.0, 0.0)}
        w = make(universe=["UP", "BIL"])(LAST, closes)
        self.assertAlmostEqual(w["UP"] * swing * math.sqrt(252), 0.10,
                               delta=0.002)

    def test_inverse_volatility(self):
        w = make()(LAST, book(DN=series(0.002, 0.02)))
        self.assertAlmostEqual(w["UP"] / w["DN"], 2.0, delta=0.05)

    def test_gross_cap(self):
        closes = book(UP=series(0.002, 0.001), DN=series(-0.002, 0.001))
        w = make(gross_max=1.2)(LAST, closes)
        self.assertAlmostEqual(sum(abs(x) for x in w.values()), 1.2)

    def test_long_only(self):
        w = make(long_only=True)(LAST, book())
        self.assertEqual(list(w), ["UP"])
        self.assertGreater(w["UP"], 0)

    def test_short_history_excluded_and_counted(self):
        t = make()
        w = t(LAST, book(DN=series(-0.002, 0.01)[-100:]))
        self.assertEqual(list(w), ["UP"])
        self.assertEqual(t.excluded, 1)

    def test_short_cash_history_is_empty(self):
        t = make(universe=["UP", "BIL"])
        self.assertEqual(t(LAST, book(BIL=series(0.0, 0.0)[-50:])), {})
        self.assertEqual(t.excluded, 1)

    def test_bad_parameters(self):
        for kw in ({"universe": ["UP"]}, {"vol_window": 1},
                   {"target_vol": 0.0}, {"gross_max": float("nan")}):
            with self.assertRaises(E.EtfTrendError):
                make(**kw)


class ExposureScaleTest(unittest.TestCase):
    def prices(self, mkt, cash=None, n=CUT):
        cash = cash or series(0.0, 0.0)
        return {"VTI": {d: (c, c) for d, c in zip(SESS[:n], mkt)},
                "BIL": {d: (c, c) for d, c in zip(SESS[:n], cash)}}

    def scale(self, prices, prev=None, date=LAST):
        return E.exposure_scale(prices, date, prev, "VTI")

    def test_continuous_around_trend_threshold(self):
        vals = [self.scale(self.prices(series(d, 0.002)))
                for d in (0.0003, 0.0004, 0.0005, 0.0006)]
        self.assertEqual(vals, sorted(vals))
        for a, b in zip(vals, vals[1:]):
            self.assertLess(b - a, 0.2)

    def test_bounds_and_volatility_cut(self):
        calm = self.scale(self.prices(series(0.002, 0.001)))
        wild = self.scale(self.prices(series(0.002, 0.03)))
        self.assertAlmostEqual(calm, E.SCALE_CEILING)
        self.assertLess(wild, calm)
        down = self.scale(self.prices(series(-0.002, 0.001)))
        self.assertEqual(down, E.SCALE_FLOOR)

    def test_rate_cap(self):
        p = self.prices(series(0.002, 0.001))
        self.assertAlmostEqual(self.scale(p, prev=0.2), 0.2 + E.RATE_CAP)
        p = self.prices(series(-0.002, 0.001))
        self.assertAlmostEqual(self.scale(p, prev=0.9), 0.9 - E.RATE_CAP)

    def test_missing_or_stale_data_is_floor(self):
        good = self.prices(series(0.002, 0.001))
        self.assertEqual(self.scale({"BIL": good["BIL"]}, prev=1.0), E.SCALE_FLOOR)
        stale = self.prices(series(0.002, 0.001), n=CUT - 1)
        self.assertEqual(self.scale(stale, prev=1.0), E.SCALE_FLOOR)
        short = self.prices(series(0.002, 0.001)[-100:], n=100)
        self.assertEqual(self.scale(short, prev=1.0, date=SESS[99]), E.SCALE_FLOOR)
        del good["VTI"][SESS[CUT - 1]]
        self.assertEqual(self.scale(good, prev=1.0), E.SCALE_FLOOR)

    def test_future_bars_ignored(self):
        base = self.prices(series(0.002, 0.001), n=CUT)
        ext = self.prices(series(0.002, 0.001, n=CUT + 20), n=CUT + 20)
        for sym in ext:
            for d in SESS[CUT:CUT + 20]:
                ext[sym][d] = (1.0, 1.0)
        self.assertEqual(self.scale(base), self.scale(ext))


if __name__ == "__main__":
    unittest.main()
