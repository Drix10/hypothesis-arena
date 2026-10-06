"""Connected Drift composite (plan/strategies.md, plan/math.md Composite score):
link propagation, section-level Filing Change and opportunistic insider
components, each winsorized, ranked to z, residualized and equal-weighted, then
agreement-gated and short-vetoed into a signed target for portfolio.run."""
import datetime
import math
from statistics import NormalDist

WINSOR = (0.01, 0.99)
TAU_PROPOSED = 1.0  # proposed agreement-gate threshold in z units (strategies.md)
MIN_SHORT_CAP = 1e9
INSIDER_DAYS = 31
SINGLE_NAME_CAP = 0.06  # of the book, plan/strategies.md Sizing
NO_TRADE_BAND = 0.20
BETA_CAP = 0.3
TARGET_VOL = 0.10
VOL_WINDOW = 63
TRADING_DAYS = 252
VETOES = ("distress", "no_borrow", "crowded", "forced_seller")


class CompositeError(ValueError):
    pass


def _day(text):
    return datetime.date.fromisoformat(text[:10])


def _sign(x):
    return (x > 0) - (x < 0)


def _finite(x):
    return isinstance(x, (int, float)) and not isinstance(x, bool) \
        and math.isfinite(x)


def _percentile(xs, p):
    k = (len(xs) - 1) * p
    lo = int(math.floor(k))
    hi = min(lo + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def winsorize(x, bounds=WINSOR):
    """Clip a {key: value} cross-section at its percentile bounds."""
    if not x:
        return {}
    xs = sorted(x.values())
    lo, hi = _percentile(xs, bounds[0]), _percentile(xs, bounds[1])
    return {k: min(max(v, lo), hi) for k, v in x.items()}


def zscore(x):
    """Rank (ties share their mean rank) mapped through the inverse normal CDF
    of (rank - 0.5) / n."""
    items = sorted(x.items(), key=lambda kv: (kv[1], kv[0]))
    n, out, i = len(items), {}, 0
    inv = NormalDist().inv_cdf
    while i < n:
        j = i
        while j + 1 < n and items[j + 1][1] == items[i][1]:
            j += 1
        z = inv(((i + j) / 2.0 + 1.0 - 0.5) / n)
        for k in range(i, j + 1):
            out[items[k][0]] = z
        i = j + 1
    return out


def _solve(a, b):
    n = len(a)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-12:
            raise CompositeError("singular-controls")
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][k] * x[k] for k in range(r + 1, n))) / m[r][r]
    return x


def residualize(z, controls):
    """OLS residual of `z` on `controls` ({key: feature list}) plus an
    intercept, rescaled to unit sample standard deviation. Empty when there
    are too few observations, the controls are collinear or the residual is
    flat."""
    keys = sorted(z)
    if not keys:
        return {}
    rows = [[1.0] + list(controls[k]) for k in keys]
    p = len(rows[0])
    if len(keys) <= p:
        return {}
    xtx = [[sum(r[i] * r[j] for r in rows) for j in range(p)] for i in range(p)]
    xty = [sum(r[i] * z[k] for r, k in zip(rows, keys)) for i in range(p)]
    try:
        beta = _solve(xtx, xty)
    except CompositeError:
        return {}
    res = [z[k] - sum(b * v for b, v in zip(beta, r))
           for k, r in zip(keys, rows)]
    sd = math.sqrt(sum(e * e for e in res) / (len(res) - 1))
    if not sd > 1e-12:
        return {}
    return {k: e / sd for k, e in zip(keys, res)}


def _universe(data):
    """Symbols with every control present and finite; any other symbol has no
    position."""
    out = {}
    for s, cap in sorted((data.get("market_cap") or {}).items()):
        beta = (data.get("beta") or {}).get(s)
        ret = (data.get("returns") or {}).get(s)
        ind = (data.get("industry") or {}).get(s)
        if _finite(cap) and cap > 0 and _finite(beta) and _finite(ret) \
                and ind is not None:
            out[s] = (beta, math.log(cap), ret, ind)
    return out


def _controls(universe, syms):
    levels = sorted({universe[s][3] for s in syms})[1:]
    return {s: [universe[s][0], universe[s][1], universe[s][2]]
            + [1.0 if universe[s][3] == lv else 0.0 for lv in levels]
            for s in syms}


def link_raw(data, universe, date):
    """Link propagation: per source the row-normalized weights of edges known
    and valid on `date`, averaged over the sources present, row-normalized
    again and applied to partners' returns net of market and industry. Edge
    times are YYYYMMDD integers; `ciks` maps cik to symbol."""
    asof = int(date.replace("-", ""))
    ciks = data.get("ciks") or {}
    mret = data.get("market_return")
    iret = data.get("industry_returns") or {}
    returns = data.get("returns") or {}
    industry = data.get("industry") or {}
    if not _finite(mret):
        return {}
    sources = {}
    for e in data.get("edges") or []:
        if e["known_at"] > asof or e["valid_from"] > asof or (
                e["valid_to"] is not None and asof >= e["valid_to"]):
            continue
        i, j = ciks.get(e["src_cik"]), ciks.get(e["dst_cik"])
        if i not in universe or j == i or not e["weight"] > 0:
            continue
        r, ind = returns.get(j), iret.get(industry.get(j))
        if not _finite(r) or not _finite(ind):
            continue
        row = sources.setdefault(e["source"], {}).setdefault(i, {})
        row[j] = row.get(j, 0.0) + e["weight"]
    w = {}
    for rows in sources.values():
        for i, row in rows.items():
            tot = sum(row.values())
            for j, v in row.items():
                w.setdefault(i, {})[j] = w.get(i, {}).get(j, 0.0) \
                    + v / tot / len(sources)
    out = {}
    for i, row in w.items():
        tot = sum(row.values())
        out[i] = sum(v / tot * (returns[j] - mret - iret[industry[j]])
                     for j, v in row.items())
    return out


def filing_raw(data, universe, date):
    """Negated Filing Change delta of each symbol's latest score known
    strictly before `date`; acceptance on the day itself may be after the
    close. A score without a parseable known_at is unusable.
    lean: no age cap on the latest score; add one with the registration."""
    out = {}
    for s, scores in (data.get("filings") or {}).items():
        if s not in universe:
            continue
        best = None
        for sc in scores:
            try:
                known = _day(sc["known_at"])
            except (KeyError, TypeError, ValueError):
                continue
            if known >= _day(date) or not _finite(sc.get("delta")):
                continue
            if best is None or sc["known_at"] > best["known_at"]:
                best = sc
        if best is not None:
            out[s] = -best["delta"]
    return out


def insider_raw(data, universe, date):
    """Summed log(1 + value) of opportunistic purchases in the trailing month
    whose entry session is on or before `date`; an event with no entry is
    unusable. Symbols without an event are absent."""
    out = {}
    d = _day(date)
    for e in data.get("events") or []:
        if not e.get("opportunistic") or e.get("symbol") not in universe:
            continue
        try:
            entry, filed = _day(e["entry"]), _day(e["date"])
        except (KeyError, TypeError, ValueError):
            continue
        if entry > d or not 0 <= (d - filed).days <= INSIDER_DAYS \
                or not _finite(e.get("value")) or e["value"] < 0:
            continue
        out[e["symbol"]] = out.get(e["symbol"], 0.0) + math.log1p(e["value"])
    return out


def components(data, date):
    """{'link', 'filing', 'insider'} -> {symbol: z} over the eligible
    universe, each after winsorize, rank and residualization; a symbol with no
    score for a component is absent from it."""
    universe = _universe(data)
    raws = {"link": link_raw(data, universe, date),
            "filing": filing_raw(data, universe, date),
            "insider": insider_raw(data, universe, date)}
    out = {}
    for name, raw in raws.items():
        z = zscore(winsorize(raw))
        out[name] = residualize(z, _controls(universe, sorted(z))) if z else {}
    return out


def composite(z_by_component, universe_syms):
    """S = mean of the three z, a missing z counting as zero."""
    return {s: sum(z.get(s, 0.0) for z in z_by_component.values())
            / len(z_by_component) for s in universe_syms}


def passes_gate(zs, s, tau):
    """False when a nonzero component z has the opposite sign to the
    composite `s` and exceeds `tau` in size."""
    return not any(z != 0 and _sign(z) != _sign(s) and abs(z) > tau
                   for z in zs)


def short_vetoed(sym, data):
    """True when a short in `sym` is vetoed. `vetoes` maps each of VETOES to
    a predicate (symbol -> bool, True vetoes); a missing predicate, a
    non-boolean answer or a market cap below MIN_SHORT_CAP vetoes."""
    cap = (data.get("market_cap") or {}).get(sym)
    if not _finite(cap) or cap < MIN_SHORT_CAP:
        return True
    preds = data.get("vetoes") or {}
    for name in VETOES:
        pred = preds.get(name)
        if pred is None or pred(sym) is not False:
            return True
    return False


def target(data, date, n_side, tau=TAU_PROPOSED, gross=1.0, exposure=1.0):
    """Signed weights: the `n_side` highest positive and lowest negative
    composites, gated, shorts also vetoed, each side sums to gross * clip(exposure, 0, 1)
    / 2 with weights proportional to |composite|. Dropped names are not
    replaced. Missing inputs give {}."""
    if not data or n_side < 1 or not _finite(exposure):
        return {}
    comps = components(data, date)
    universe = _universe(data)
    if not any(comps.values()):
        return {}
    s = composite(comps, universe)
    ranked = sorted(s, key=lambda k: (-s[k], k))
    longs = [k for k in ranked[:n_side] if s[k] > 0]
    shorts = [k for k in ranked[::-1][:n_side] if s[k] < 0]
    side = gross * min(max(exposure, 0.0), 1.0) / 2.0
    kept = []
    for k in longs + shorts:
        if not passes_gate([c.get(k, 0.0) for c in comps.values()], s[k], tau):
            continue
        if s[k] < 0 and short_vetoed(k, data):
            continue
        kept.append(k)
    out = {}
    for sign in (1, -1):
        names = [k for k in kept if (s[k] > 0) == (sign > 0)]
        tot = sum(abs(s[k]) for k in names)
        for k in names:
            out[k] = sign * side * abs(s[k]) / tot
    return out


def cap_weights(w, cap=SINGLE_NAME_CAP):
    """Each |weight| clipped to `cap`; the excess is not redistributed."""
    return {s: min(max(x, -cap), cap) for s, x in w.items()}


def net_beta(w, beta):
    return sum(x * beta[s] for s, x in w.items())


def beta_limit(w, beta, cap=BETA_CAP):
    """Names without a finite point-in-time beta are dropped; when |net beta|
    exceeds `cap` every weight is scaled by cap / |net beta|."""
    w = {s: x for s, x in w.items() if _finite(beta.get(s))}
    net = abs(net_beta(w, beta))
    if net > cap:
        w = {s: x * cap / net for s, x in w.items()}
    return w


def vol_scale(w, bars, date, target=TARGET_VOL, window=VOL_WINDOW):
    """min(1, target / trailing annual volatility) of the book `w` held over
    the last `window` SPY sessions to `date`; 0 (flat) when a session, a held
    symbol's close or the volatility is missing. `bars[sym][d] = (open, close)`.
    lean: realised volatility of today's weights, not the sector-shrunk EWMA
    covariance of plan/math.md; upgrade with the covariance model."""
    if not w:
        return 1.0
    try:
        days = sorted(d for d in bars["SPY"] if d <= date)[-window - 1:]
        if len(days) < window + 1 or days[-1] != date:
            return 0.0
        px = {s: [float(bars[s][d][1]) for d in days] for s in w}
    except (KeyError, TypeError, ValueError, IndexError):
        return 0.0
    if not all(_finite(c) and c > 0 for v in px.values() for c in v):
        return 0.0
    rets = [sum(x * (px[s][i] / px[s][i - 1] - 1.0) for s, x in w.items())
            for i in range(1, window + 1)]
    mean = sum(rets) / window
    vol = math.sqrt(sum((r - mean) ** 2 for r in rets) / (window - 1)
                    * TRADING_DAYS)
    if not vol > 0:
        return 0.0
    return min(1.0, target / vol)


def no_trade_band(new, old, band=NO_TRADE_BAND):
    """`new` with a held name's weight kept at its `old` value when the change
    is under `band` of the old size; entries, exits and larger changes trade."""
    return {s: old[s] if old.get(s) and abs(x - old[s]) < band * abs(old[s])
            else x for s, x in new.items()}


class CompositeTarget:
    """Callable target_fn(date, closes) -> {sym: signed weight} on month-end
    sessions, None otherwise. `inputs(date)` returns the as-of data dict
    (market_cap, beta, returns, industry, market_return, industry_returns,
    ciks, edges, filings, events, vetoes) or None; `exposure` is the ETF
    Trend multiplier, a number or a function of the date."""

    def __init__(self, sessions, inputs, n_side, tau=TAU_PROPOSED, gross=1.0,
                 exposure=1.0):
        if not (isinstance(n_side, int) and n_side >= 1):
            raise CompositeError("bad-n-side")
        if not (_finite(tau) and tau > 0):
            raise CompositeError("bad-tau")
        if not (_finite(gross) and gross > 0):
            raise CompositeError("bad-gross")
        self.inputs = inputs
        self.n_side = n_side
        self.tau = tau
        self.gross = gross
        self.exposure = exposure
        self.month_ends = {a for a, b in zip(sessions, sessions[1:])
                           if a[:7] != b[:7]}

    def __call__(self, date, closes):
        if date not in self.month_ends:
            return None
        mult = self.exposure(date) if callable(self.exposure) \
            else self.exposure
        return target(self.inputs(date), date, self.n_side, self.tau,
                      self.gross, mult)


def component_correlation(columns):
    """Pairwise-complete Pearson correlation of equal-length columns of
    float or None (the event-sparse insider column is read over the months it
    fires). A pair with under 3 common rows or a flat column raises."""
    if len({len(c) for c in columns}) != 1:
        raise CompositeError("ragged-columns")
    n = len(columns)
    out = [[1.0] * n for _ in range(n)]
    for a in range(n):
        for b in range(a + 1, n):
            pairs = [(x, y) for x, y in zip(columns[a], columns[b])
                     if x is not None and y is not None]
            if len(pairs) < 3:
                raise CompositeError("too-few-pairs")
            mx = sum(x for x, _ in pairs) / len(pairs)
            my = sum(y for _, y in pairs) / len(pairs)
            sxx = sum((x - mx) ** 2 for x, _ in pairs)
            syy = sum((y - my) ** 2 for _, y in pairs)
            if not (sxx > 0 and syy > 0):
                raise CompositeError("flat-column")
            out[a][b] = out[b][a] = sum(
                (x - mx) * (y - my) for x, y in pairs) / math.sqrt(sxx * syy)
    return out


def effective_signal_count(corr):
    """(sum of eigenvalues)^2 / sum of squared eigenvalues of a symmetric
    matrix, computed as trace^2 over the squared Frobenius norm."""
    n = len(corr)
    if n == 0 or any(len(r) != n for r in corr):
        raise CompositeError("not-square")
    trace = sum(corr[i][i] for i in range(n))
    frob = sum(v * v for r in corr for v in r)
    if not frob > 0:
        raise CompositeError("zero-matrix")
    return trace * trace / frob
