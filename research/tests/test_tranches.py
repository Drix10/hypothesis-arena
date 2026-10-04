import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import margin as M
from research.strategy import portfolio as P
from research.strategy import tranches as T

TERMS = M.MarginTerms(margin_rate=0.05)
SYMS = ["S%03d" % i for i in range(120)]
PER_SIDE = 15


def mkdata(months=8):
    sess, d = [], date(2024, 1, 2)
    while d < date(2024, 1 + months, 1):
        if d.weekday() < 5:
            sess.append(d.isoformat())
        d += timedelta(days=1)
    px = {s: {d: (100.0 + i % 7, 100.0 + i % 7) for d in sess}
          for i, s in enumerate(SYMS)}
    return sess, px


def picks(d, closes):
    """Longs and shorts rotate through the universe by month."""
    k = (int(d[5:7]) * 2 * PER_SIDE) % len(SYMS)
    names = [SYMS[(k + j) % len(SYMS)] for j in range(2 * PER_SIDE)]
    return {s: (1.0 if j < PER_SIDE else -1.0) for j, s in enumerate(names)}


def run(sess, px, **kw):
    fn = T.Tranches(sess, picks, min_names=PER_SIDE, **kw)
    return P.run(sess, px, fn, margin=TERMS)


class Tests(unittest.TestCase):
    def test_name_held_three_months_then_replaced(self):
        sess, px = mkdata()
        w = {d[:7]: b for d, b in run(sess, px)["weights"]}
        month = lambda m: "2024-%02d" % m
        entered = [s for s in picks(month(1) + "-31", None)]
        for m in (1, 2, 3):
            self.assertTrue(all(s in w[month(m)] for s in entered), m)
        self.assertFalse(any(s in w[month(4)] for s in entered))

    def test_one_third_turns_over_a_month(self):
        sess, px = mkdata()
        books = [b for _, b in run(sess, px)["weights"]]
        for a, b in zip(books[2:], books[3:]):
            moved = sum(abs(b.get(s, 0.0) - a.get(s, 0.0))
                        for s in set(a) | set(b)) / 2
            self.assertAlmostEqual(moved / 1.5, 1 / 3)

    def test_gross_never_exceeds_cap(self):
        sess, px = mkdata()
        books = [b for _, b in run(sess, px)["weights"]]
        self.assertGreater(len(books), 3)
        for b in books:
            self.assertLessEqual(sum(abs(x) for x in b.values()), 1.5 + 1e-9)
        self.assertAlmostEqual(sum(abs(x) for x in books[-1].values()), 1.5)

    def test_whole_shares_and_reproducible(self):
        sess, px = mkdata()
        a, b = run(sess, px), run(sess, px)
        self.assertEqual(a, b)
        self.assertTrue(a["trades"])
        self.assertTrue(all(isinstance(t[3], int) for t in a["trades"]))

    def test_too_few_names_refused(self):
        sess, px = mkdata(2)
        fn = T.Tranches(sess, picks, min_names=PER_SIDE + 1)
        with self.assertRaises(T.TrancheError):
            P.run(sess, px, fn, margin=TERMS)

    def test_bad_parameters_refused(self):
        sess, _ = mkdata(2)
        for kw in ({"horizon": 0}, {"gross": 0.0}, {"min_names": 0}):
            with self.assertRaises(T.TrancheError):
                T.Tranches(sess, picks, **kw)


if __name__ == "__main__":
    unittest.main()
