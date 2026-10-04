"""Placebo-graph test (plan/math.md, Edge validation): rescore a signal on
degree-preserving rewirings of the link graph and place the real score in that
distribution."""
import random
from dataclasses import dataclass

PASS_PERCENTILE = 95.0


class PlaceboError(ValueError):
    pass


@dataclass(frozen=True)
class PlaceboResult:
    real: float
    scores: tuple
    percentile: float  # share of placebo scores strictly below the real score, 0-100

    @property
    def passed(self):
        return self.percentile > PASS_PERCENTILE


def _key(edge, directed):
    return edge if directed else frozenset(edge)


def _clean(edges, directed):
    seen = set()
    out = []
    for a, b in edges:
        if a == b:
            raise PlaceboError("self-loop %r" % (a,))
        k = _key((a, b), directed)
        if k in seen:
            raise PlaceboError("duplicate edge %r" % ((a, b),))
        seen.add(k)
        out.append((a, b))
    return out, seen


def rewire(edges, rng, directed=False, swaps_per_edge=10):
    """Double edge swaps: (a,b),(c,d) -> (a,d),(c,b). Every node keeps its
    degree (in and out degree when directed); a swap that would create a
    self-loop or duplicate edge is skipped."""
    cur, present = _clean(edges, directed)
    n = len(cur)
    if n < 2:
        return cur
    for _ in range(swaps_per_edge * n):
        i, j = rng.randrange(n), rng.randrange(n)
        if i == j:
            continue
        a, b = cur[i]
        c, d = cur[j]
        if not directed and rng.random() < 0.5:
            c, d = d, c
        if a == d or c == b:
            continue
        e1, e2 = (a, d), (c, b)
        k1, k2 = _key(e1, directed), _key(e2, directed)
        if k1 == k2 or k1 in present or k2 in present:
            continue
        present.difference_update((_key(cur[i], directed), _key(cur[j], directed)))
        present.update((k1, k2))
        cur[i], cur[j] = e1, e2
    return cur


def placebo_test(edges, score_fn, directed=False, draws=100, seed=0,
                 swaps_per_edge=10):
    """score_fn maps an edge list to a float. Returns the real score, the
    placebo scores and the real score's percentile among them."""
    if draws < 1:
        raise PlaceboError("draws must be positive")
    edges = list(edges)
    real = score_fn(edges)
    rng = random.Random(seed)
    scores = tuple(score_fn(rewire(edges, rng, directed, swaps_per_edge))
                   for _ in range(draws))
    below = sum(1 for s in scores if s < real)
    return PlaceboResult(real, scores, 100.0 * below / draws)
