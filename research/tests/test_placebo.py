"""Placebo-graph tool tests."""
import os
import random
import sys
import unittest
from collections import Counter

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import placebo as P


def random_edges(n, m, directed, seed):
    rng = random.Random(seed)
    out, seen = [], set()
    while len(out) < m:
        a, b = rng.randrange(n), rng.randrange(n)
        k = (a, b) if directed else frozenset((a, b))
        if a == b or k in seen:
            continue
        seen.add(k)
        out.append((a, b))
    return out


def degrees(edges, directed):
    if directed:
        return Counter(a for a, _ in edges), Counter(b for _, b in edges)
    c = Counter()
    for a, b in edges:
        c[a] += 1
        c[b] += 1
    return c


def clique_score(edges):
    """Edges inside the planted block {0..9}."""
    return sum(1 for a, b in edges if a < 10 and b < 10)


class RewireTest(unittest.TestCase):
    def check(self, directed):
        edges = random_edges(40, 120, directed, 1)
        out = P.rewire(edges, random.Random(2), directed)
        self.assertEqual(degrees(out, directed), degrees(edges, directed))
        self.assertEqual(len(out), len(edges))
        keys = [(a, b) if directed else frozenset((a, b)) for a, b in out]
        self.assertEqual(len(set(keys)), len(keys))
        self.assertTrue(all(a != b for a, b in out))
        self.assertNotEqual(sorted(map(sorted, out)), sorted(map(sorted, edges)))

    def test_undirected(self):
        self.check(False)

    def test_directed(self):
        self.check(True)

    def test_rejects_bad_input(self):
        with self.assertRaises(P.PlaceboError):
            P.rewire([(1, 1)], random.Random(0))
        with self.assertRaises(P.PlaceboError):
            P.rewire([(1, 2), (2, 1)], random.Random(0))


class PlaceboTest(unittest.TestCase):
    def test_deterministic(self):
        edges = random_edges(30, 60, False, 3)
        a = P.placebo_test(edges, clique_score, seed=7)
        b = P.placebo_test(edges, clique_score, seed=7)
        self.assertEqual(a, b)
        self.assertEqual(len(a.scores), 100)

    def test_planted_structure_passes(self):
        edges = [(a, b) for a in range(10) for b in range(a + 1, 10)]
        edges += random_edges(60, 80, False, 4)
        edges = list({frozenset(e): e for e in edges}.values())
        r = P.placebo_test(edges, clique_score)
        self.assertGreater(r.percentile, 95.0)
        self.assertTrue(r.passed)

    def test_noise_fails(self):
        edges = random_edges(60, 120, False, 5)
        r = P.placebo_test(edges, clique_score)
        self.assertFalse(r.passed)

    def test_bad_draws(self):
        with self.assertRaises(P.PlaceboError):
            P.placebo_test([(1, 2)], clique_score, draws=0)


if __name__ == "__main__":
    unittest.main()
