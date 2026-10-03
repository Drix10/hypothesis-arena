"""Statistics standard tests (doc 11 §11.0b). Stdlib only; closed-form and
property fixtures."""
import math
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import stats as S


def noise(n, seed, mu=0.0, sd=0.01):
    r = random.Random(seed)
    return [r.gauss(mu, sd) for _ in range(n)]


class ClosedFormTest(unittest.TestCase):
    def test_psr_normal_closed_form(self):
        # SR=0.1/period, T=251, normal: z = 0.1*sqrt(250)/sqrt(1.005)
        z = 0.1 * math.sqrt(250) / math.sqrt(1.005)
        want = 0.5 * (1 + math.erf(z / math.sqrt(2)))
        self.assertAlmostEqual(S.psr(0.1, 251, 0.0, 3.0), want, places=12)
        self.assertAlmostEqual(want, 0.9426, places=3)

    def test_min_trl_closed_form(self):
        z = 1.6448536269514722
        want = 1 + 1.005 * (z / 0.1) ** 2
        self.assertAlmostEqual(S.min_trl(0.1), want, places=6)
        self.assertTrue(math.isinf(S.min_trl(0.0)))
        self.assertTrue(math.isinf(S.min_trl(-0.2)))

    def test_expected_max_sharpe(self):
        self.assertEqual(S.expected_max_sharpe(1, None), 0.0)
        a = S.expected_max_sharpe(10, 0.01)
        b = S.expected_max_sharpe(100, 0.01)
        self.assertTrue(0 < a < b)  # more search -> higher bar
        with self.assertRaises(S.StatsError):
            S.expected_max_sharpe(10, None)  # variance required, fail closed
        self.assertAlmostEqual(S.expected_max_sharpe(4, 0.04) /
                               S.expected_max_sharpe(4, 0.01), 2.0, places=9)

    def test_dsr_n1_equals_psr0_and_deflates_with_n(self):
        xs = noise(756, 1, mu=0.0006)
        sk, ku = S.skew_kurt(xs)
        self.assertAlmostEqual(S.deflated_sharpe(xs, 1),
                               S.psr(S.sharpe(xs), len(xs), sk, ku), 12)
        d10 = S.deflated_sharpe(xs, 10, sr_var=0.0004)
        d200 = S.deflated_sharpe(xs, 200, sr_var=0.0004)
        self.assertLess(d200, d10)
        self.assertLess(d10, S.deflated_sharpe(xs, 1))

    def test_holm(self):
        self.assertEqual(S.holm([0.01, 0.04, 0.03]), [True, False, False])
        self.assertEqual(S.holm([0.001, 0.002, 0.003]), [True] * 3)
        self.assertEqual(S.holm([0.2, 0.9]), [False, False])
        with self.assertRaises(S.StatsError):
            S.holm([1.2])

    def test_max_drawdown(self):
        self.assertAlmostEqual(S.max_drawdown([0.1, -0.1]), 0.1)
        self.assertAlmostEqual(S.max_drawdown([0.5, -0.5, 0.1]), 0.5)
        self.assertEqual(S.max_drawdown([0.01, 0.02]), 0.0)

    def test_skew_kurt_normal_and_flat(self):
        sk, ku = S.skew_kurt(noise(20000, 3))
        self.assertLess(abs(sk), 0.1)
        self.assertLess(abs(ku - 3.0), 0.2)
        self.assertEqual(S.skew_kurt([0.01] * 10), (0.0, 3.0))

    def test_rejects_bad_input(self):
        for bad in ([0.1], [0.1, float("nan")], [0.1, float("inf")],
                    [0.1, True]):
            with self.assertRaises(S.StatsError):
                S.sharpe(bad)


class HacBootstrapTest(unittest.TestCase):
    def test_hac_matches_naive_when_iid_and_inflates_when_autocorrelated(self):
        iid = noise(2000, 5, mu=0.0004)
        t_hac = S.hac_mean_tstat(iid)
        t_naive = S.mean(iid) / (S.stdev(iid) / math.sqrt(len(iid)))
        self.assertLess(abs(t_hac - t_naive) / abs(t_naive), 0.25)
        r = random.Random(9)
        ar, prev = [], 0.0
        for _ in range(2000):
            prev = 0.8 * prev + r.gauss(0.0, 0.01)
            ar.append(prev + 0.0004)
        naive = S.mean(ar) / (S.stdev(ar) / math.sqrt(len(ar)))
        self.assertLess(abs(S.hac_mean_tstat(ar)), abs(naive))

    def test_bootstrap_deterministic_and_covers_mean(self):
        xs = noise(500, 7, mu=0.001)
        a = S.bootstrap_ci(xs, S.mean, b=400, seed=11)
        b = S.bootstrap_ci(xs, S.mean, b=400, seed=11)
        self.assertEqual(a, b)
        self.assertLess(a[0], 0.001 + 0.002)
        self.assertLess(a[0], S.mean(xs))
        self.assertGreater(a[1], S.mean(xs))
        self.assertNotEqual(a, S.bootstrap_ci(xs, S.mean, b=400, seed=12))

    def test_bootstrap_ci_excludes_zero_for_strong_edge_only(self):
        strong = noise(1000, 2, mu=0.004)
        weak = noise(1000, 2, mu=0.0)
        self.assertGreater(S.bootstrap_ci(strong, S.sharpe, b=300, seed=1)[0], 0)
        self.assertLess(S.bootstrap_ci(weak, S.sharpe, b=300, seed=1)[0], 0)


class SplitTest(unittest.TestCase):
    def test_walk_forward_purge_embargo_no_overlap(self):
        splits = list(S.purged_walk_forward(1000, 4, label_horizon=5,
                                            embargo=3))
        self.assertEqual(len(splits), 4)
        for tr, te in splits:
            self.assertTrue(max(tr) + 5 + 3 <= min(te))
            self.assertFalse(set(tr) & set(te))
        tests = [i for _, te in splits for i in te]
        self.assertEqual(tests, sorted(set(tests)))
        self.assertEqual(tests[-1], 999)
        with self.assertRaises(S.StatsError):
            list(S.purged_walk_forward(20, 4, label_horizon=50))

    def test_cpcv_counts_and_purge(self):
        sp = list(S.cpcv_splits(600, 6, 2, label_horizon=4, embargo=2))
        self.assertEqual(len(sp), math.comb(6, 2))
        for train, test, combo in sp:
            self.assertFalse(set(train) & set(test))
            for g in combo:
                a = g * 100
                for i in range(a - 4, a):
                    self.assertNotIn(i, train)
                for i in range(a + 100, a + 102):
                    self.assertNotIn(i, train)
        # each group is tested in C(5,1)=5 combinations
        for g in range(6):
            self.assertEqual(sum(1 for *_, c in sp if g in c), 5)


class PboTest(unittest.TestCase):
    def test_pbo_zero_when_best_is_persistent(self):
        r = random.Random(4)
        m = [[0.002 * j + r.gauss(0, 0.005) for j in range(6)]
             for _ in range(800)]
        p, _ = S.pbo(m)
        self.assertLess(p, 0.05)

    def test_pbo_high_for_pure_noise_selection(self):
        r = random.Random(8)
        m = [[r.gauss(0, 0.01) for _ in range(30)] for _ in range(800)]
        p, logits = S.pbo(m)
        self.assertGreater(p, 0.3)
        self.assertEqual(len(logits), math.comb(8, 4))

    def test_pbo_needs_variants_and_geometry(self):
        with self.assertRaises(S.StatsError):
            S.pbo([[0.0]] * 100)
        with self.assertRaises(S.StatsError):
            S.pbo([[0.0, 0.1]] * 4, n_slices=8)


class SpanningTest(unittest.TestCase):
    def _series(self, n, alpha, beta, seed):
        import random
        rng = random.Random(seed)
        rb = [0.0003 + rng.gauss(0, 0.01) for _ in range(n)]
        rs = [alpha + beta * b + rng.gauss(0, 0.004) for b in rb]
        return rs, rb

    def test_recovers_alpha_and_beta(self):
        rs, rb = self._series(1500, 0.0006, 0.4, 7)
        r = S.spanning_alpha(rs, rb, b=400)
        self.assertAlmostEqual(r["beta"], 0.4, delta=0.03)
        self.assertAlmostEqual(r["alpha"], 0.0006, delta=0.0003)
        self.assertGreater(r["t_alpha"], 3)
        self.assertGreater(r["ci"][0], 0)
        self.assertEqual(r["n"], 1500)

    def test_pure_beta_has_no_alpha(self):
        rs, rb = self._series(1500, 0.0, 1.5, 8)
        r = S.spanning_alpha(rs, rb, b=400)
        self.assertLess(abs(r["t_alpha"]), 3)
        self.assertLess(r["ci"][0], 0)
        self.assertGreater(r["ci"][1], 0)

    def test_matches_ols_closed_form(self):
        rb = [0.01, -0.02, 0.03, 0.0, 0.015, -0.005]
        rs = [0.001 + 0.5 * b for b in rb]
        r = S.spanning_alpha(rs, rb, b=50)
        self.assertAlmostEqual(r["alpha"], 0.001)
        self.assertAlmostEqual(r["beta"], 0.5)

    def test_deterministic_and_refuses_bad_input(self):
        rs, rb = self._series(300, 0.0004, 0.3, 9)
        self.assertEqual(S.spanning_alpha(rs, rb, b=200, seed=3),
                         S.spanning_alpha(rs, rb, b=200, seed=3))
        for a, b in ((rs[:10], rb[:9]), ([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]),
                     ([0.1] * 5, [0.0] * 5), ([0.1, float("nan"), 0, 0, 0], [0.1, 0.2, 0.3, 0.1, 0.0])):
            with self.assertRaises(S.StatsError):
                S.spanning_alpha(a, b, b=20)


if __name__ == "__main__":
    r = unittest.main(exit=False, verbosity=0).result
    if r.wasSuccessful():
        print("ALL STATS TESTS GREEN")
    sys.exit(0 if r.wasSuccessful() else 1)
