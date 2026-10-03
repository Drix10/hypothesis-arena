"""Sharpe inference and overfitting diagnostics (PSR/DSR, MinTRL, HAC t-stat,
stationary bootstrap, purged splits, CPCV, PBO, Holm). Inputs are periodic
returns as floats, already net of the risk-free leg; stochastic routines take
an explicit seed."""
import itertools
import math
import random
from statistics import NormalDist

_N = NormalDist()
EULER_GAMMA = 0.5772156649015329


class StatsError(ValueError):
    pass


def _clean(xs, min_n=2):
    xs = list(xs)
    if len(xs) < min_n:
        raise StatsError("too-few-observations")
    for x in xs:
        if not isinstance(x, (int, float)) or isinstance(x, bool) \
                or not math.isfinite(x):
            raise StatsError("non-finite-return")
    return xs


def mean(xs):
    xs = _clean(xs, 1)
    return sum(xs) / len(xs)


def _flat(m, var):
    """Variance is float dust around a constant series."""
    return var <= (1e-12 * max(abs(m), 1e-300)) ** 2 or var == 0.0


def stdev(xs):
    xs = _clean(xs)
    m = mean(xs)
    var = sum((x - m) ** 2 for x in xs) / (len(xs) - 1)
    return 0.0 if _flat(m, var) else math.sqrt(var)


def sharpe(xs, ann=1.0):
    """Per-period Sharpe (rf already netted out); ann = periods/year."""
    s = stdev(xs)
    if s == 0.0:
        return 0.0
    return mean(xs) / s * math.sqrt(ann)


def skew_kurt(xs):
    """(skewness, NON-excess kurtosis; normal = 3)."""
    xs = _clean(xs, 4)
    n = len(xs)
    m = mean(xs)
    m2 = sum((x - m) ** 2 for x in xs) / n
    if _flat(m, m2):
        return 0.0, 3.0
    m3 = sum((x - m) ** 3 for x in xs) / n
    m4 = sum((x - m) ** 4 for x in xs) / n
    return m3 / m2 ** 1.5, m4 / m2 ** 2


def max_drawdown(xs):
    """Max peak-to-trough drop of the compounded equity curve (>= 0)."""
    eq, peak, mdd = 1.0, 1.0, 0.0
    for r in _clean(xs, 1):
        eq *= 1.0 + r
        peak = max(peak, eq)
        mdd = max(mdd, 1.0 - eq / peak)
    return mdd


def hac_mean_tstat(xs, lag=None):
    """t-stat of the mean with Newey-West (Bartlett) standard error."""
    xs = _clean(xs, 3)
    n = len(xs)
    if lag is None:
        lag = int(4 * (n / 100.0) ** (2.0 / 9.0))
    m = mean(xs)
    d = [x - m for x in xs]
    g0 = sum(v * v for v in d) / n
    var = g0
    for k in range(1, min(lag, n - 1) + 1):
        gk = sum(d[i] * d[i - k] for i in range(k, n)) / n
        var += 2.0 * (1.0 - k / (lag + 1.0)) * gk
    if var <= 0.0:
        raise StatsError("non-positive-hac-variance")
    return m / math.sqrt(var / n)


def stationary_bootstrap_indices(n, mean_block, rng):
    p = 1.0 / mean_block
    idx = []
    i = rng.randrange(n)
    for _ in range(n):
        idx.append(i)
        i = rng.randrange(n) if rng.random() < p else (i + 1) % n
    return idx


def stationary_bootstrap(xs, stat, b=2000, mean_block=None, seed=0):
    """Sorted list of `stat` over b stationary-bootstrap resamples."""
    xs = _clean(xs, 4)
    n = len(xs)
    if mean_block is None:
        mean_block = max(2.0, n ** (1.0 / 3.0))
    rng = random.Random(seed)
    out = []
    for _ in range(b):
        idx = stationary_bootstrap_indices(n, mean_block, rng)
        out.append(stat([xs[i] for i in idx]))
    out.sort()
    return out


def bootstrap_ci(xs, stat, level=0.95, **kw):
    dist = stationary_bootstrap(xs, stat, **kw)
    a = (1.0 - level) / 2.0
    lo = dist[int(math.floor(a * (len(dist) - 1)))]
    hi = dist[int(math.ceil((1.0 - a) * (len(dist) - 1)))]
    return lo, hi


def _ols(ys, xs):
    """(alpha, beta, residuals) of ys = alpha + beta * xs."""
    mx, my = mean(xs), mean(ys)
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx <= 0.0:
        raise StatsError("zero-variance-regressor")
    beta = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
    alpha = my - beta * mx
    return alpha, beta, [y - alpha - beta * x for x, y in zip(xs, ys)]


def spanning_alpha(rs, rb, level=0.95, b=2000, seed=0, lag=None):
    """Spanning test: regress the strategy's periodic
    excess returns rs on the reference book's rb, paired by period.
    Returns dict(alpha, beta, t_alpha, ci, n): the Newey-West t-stat of
    alpha and a stationary-bootstrap CI of alpha over resampled pairs."""
    rs, rb = list(rs), list(rb)
    if len(rs) != len(rb):
        raise StatsError("unpaired")
    if len(rs) < 4 or any(not math.isfinite(v) for v in rs + rb):
        raise StatsError("spanning-input")
    alpha, beta, resid = _ols(rs, rb)
    n = len(rs)
    if lag is None:
        lag = int(4 * (n / 100.0) ** (2.0 / 9.0))
    mx = mean(rb)
    sxx = sum((x - mx) ** 2 for x in rb)
    # Newey-West variance of alpha: the alpha influence term per period is
    # resid_t * (1 - n * mx * (x_t - mx) / sxx) / n.
    u = [e * (1.0 - n * mx * (x - mx) / sxx) for e, x in zip(resid, rb)]
    var = sum(v * v for v in u) / n
    for k in range(1, min(lag, n - 1) + 1):
        gk = sum(u[i] * u[i - k] for i in range(k, n)) / n
        var += 2.0 * (1.0 - k / (lag + 1.0)) * gk
    t = alpha / math.sqrt(var / n) if var > 0.0 else None
    rng = random.Random(seed)
    mean_block = max(2.0, n ** (1.0 / 3.0))
    dist = []
    for _ in range(b):
        idx = stationary_bootstrap_indices(n, mean_block, rng)
        try:
            dist.append(_ols([rs[i] for i in idx], [rb[i] for i in idx])[0])
        except StatsError:
            continue
    dist.sort()
    a = (1.0 - level) / 2.0
    ci = (dist[int(math.floor(a * (len(dist) - 1)))],
          dist[int(math.ceil((1.0 - a) * (len(dist) - 1)))]) if dist else None
    return {"alpha": alpha, "beta": beta, "t_alpha": t, "ci": ci, "n": n}


def psr(sr, n_obs, skew, kurt, sr_star=0.0):
    """Probabilistic Sharpe Ratio (Bailey & Lopez de Prado), per-period."""
    if n_obs < 3:
        raise StatsError("too-few-observations")
    den = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr
    if den <= 0.0:
        raise StatsError("non-positive-sharpe-variance")
    return _N.cdf((sr - sr_star) * math.sqrt(n_obs - 1) / math.sqrt(den))


def expected_max_sharpe(n_trials, sr_var):
    """SR0: expected maximum Sharpe of n_trials zero-skill trials."""
    if n_trials < 1:
        raise StatsError("n-trials")
    if n_trials == 1:
        return 0.0
    if sr_var is None or sr_var < 0.0:
        raise StatsError("trial-sharpe-variance-required")
    e = math.e
    return math.sqrt(sr_var) * (
        (1.0 - EULER_GAMMA) * _N.inv_cdf(1.0 - 1.0 / n_trials)
        + EULER_GAMMA * _N.inv_cdf(1.0 - 1.0 / (n_trials * e)))


def deflated_sharpe(xs, n_trials, sr_var=None):
    """DSR of the return series `xs` given the ledger's trial count N.

    sr_var = cross-trial variance of per-period Sharpes (from the ledger's
    closed trials); required when N > 1 (fail closed: no guessing).
    """
    xs = _clean(xs, 4)
    sk, ku = skew_kurt(xs)
    sr0 = expected_max_sharpe(n_trials, sr_var)
    return psr(sharpe(xs), len(xs), sk, ku, sr_star=sr0)


def min_trl(sr, skew=0.0, kurt=3.0, sr_star=0.0, alpha=0.05):
    """Minimum track-record length (periods) for SR > sr_star at 1-alpha."""
    if sr <= sr_star:
        return math.inf
    den = 1.0 - skew * sr + (kurt - 1.0) / 4.0 * sr * sr
    if den <= 0.0:
        return math.inf
    z = _N.inv_cdf(1.0 - alpha)
    return 1.0 + den * (z / (sr - sr_star)) ** 2


def holm(pvalues, alpha=0.05):
    """Holm-Bonferroni step-down. Returns reject flags in input order."""
    m = len(pvalues)
    for p in pvalues:
        if not (isinstance(p, (int, float)) and 0.0 <= p <= 1.0):
            raise StatsError("bad-pvalue")
    order = sorted(range(m), key=lambda i: pvalues[i])
    reject = [False] * m
    for rank, i in enumerate(order):
        if pvalues[i] <= alpha / (m - rank):
            reject[i] = True
        else:
            break
    return reject


def purged_walk_forward(n, n_splits, label_horizon=0, embargo=0,
                        min_train=1):
    """Expanding-window walk-forward with purge + embargo.

    Test folds partition the tail [n_first_test, n). Training indices end
    `label_horizon` bars before the test fold starts (purge: a training
    label may not overlap the test window) and embargo bars are also
    dropped. Yields (train, test) index lists.
    """
    if n_splits < 1 or n < n_splits + min_train:
        raise StatsError("bad-split-geometry")
    fold = n // (n_splits + 1)
    if fold < 1:
        raise StatsError("bad-split-geometry")
    for k in range(1, n_splits + 1):
        t0 = k * fold
        t1 = n if k == n_splits else (k + 1) * fold
        tr_end = t0 - label_horizon - embargo
        if tr_end < min_train:
            raise StatsError("train-empty-after-purge")
        yield list(range(0, tr_end)), list(range(t0, t1))


def cpcv_splits(n, n_groups, k_test, label_horizon=0, embargo=0):
    """Combinatorial purged CV: yields (train, test, test_groups).

    Groups are contiguous; every k_test-subset is a test set once. Train
    indices within `label_horizon` before or `embargo` after any test
    group are removed.
    """
    if not (1 <= k_test < n_groups) or n < n_groups:
        raise StatsError("bad-cpcv-geometry")
    size = n // n_groups
    bounds = [(g * size, n if g == n_groups - 1 else (g + 1) * size)
              for g in range(n_groups)]
    for combo in itertools.combinations(range(n_groups), k_test):
        test = []
        banned = set()
        for g in combo:
            a, b = bounds[g]
            test.extend(range(a, b))
            banned.update(range(max(0, a - label_horizon), a))
            banned.update(range(b, min(n, b + embargo)))
        tset = set(test)
        train = [i for i in range(n) if i not in tset and i not in banned]
        if not train:
            raise StatsError("train-empty-after-purge")
        yield train, test, combo


def pbo(matrix, n_slices=8):
    """Probability of Backtest Overfitting via CSCV.

    matrix[t][j] = return of variant j at time t (all variants, same
    dates). Returns (pbo, logits). >= 2 variants required.
    """
    t = len(matrix)
    if t < n_slices or n_slices % 2 or n_slices < 4:
        raise StatsError("bad-pbo-geometry")
    nv = len(matrix[0])
    if nv < 2 or any(len(r) != nv for r in matrix):
        raise StatsError("pbo-needs-two-variants")
    size = t // n_slices
    slices = [range(s * size, (s + 1) * size) for s in range(n_slices)]

    def perf(rows):
        return [sharpe([matrix[i][j] for i in rows]) for j in range(nv)]

    logits = []
    for is_ids in itertools.combinations(range(n_slices), n_slices // 2):
        oos_ids = [s for s in range(n_slices) if s not in is_ids]
        is_rows = [i for s in is_ids for i in slices[s]]
        oos_rows = [i for s in oos_ids for i in slices[s]]
        is_perf, oos_perf = perf(is_rows), perf(oos_rows)
        best = max(range(nv), key=lambda j: (is_perf[j], -j))
        rank = 1 + sum(1 for j in range(nv) if oos_perf[j] < oos_perf[best])
        omega = rank / (nv + 1.0)
        logits.append(math.log(omega / (1.0 - omega)))
    return sum(1 for x in logits if x <= 0.0) / len(logits), logits
