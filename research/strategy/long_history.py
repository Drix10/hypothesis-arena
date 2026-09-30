"""L1 long-history replication (Track L): the canonical trend and industry
momentum rules on Kenneth French daily industry portfolios (1926 onward),
judged by sub-period and by post-publication decay (McLean-Pontiff style).

Fixed before any real-data run (research/prereg/l1_long_history_v1.json binds
these constants; `check_prereg` refuses a run whose prereg disagrees):

Rules (target functions are reused unchanged from research.strategy.sleeves)
  ts_ma10     trend.ma10: hold an industry iff its month-end total-return
              index is above its 10-month average, else the slot is cash
  ts_mom12    trend.mom12_vs_tbill: hold an industry iff its 12-month return
              beats the risk-free 12-month return, else the slot is cash
  xs_mom12_1  sector_mom.mom12_1: top 3 industries by 12-1 month return, a
              slot is cash when that return does not beat cash; long-only
  Trend slots are equal weight (1/N). Cash earns the French RF series, so
  the sleeves' "BIL" symbol is a synthetic RF total-return index here.
Benchmarks: ew_monthly (equal weight of the same industries, rebalanced at
  month ends; the primary comparator for active return) and ew_drift (equal
  weight bought once at the evaluation start and never rebalanced).
Timing: the target is decided from data through the month-end close t and
  earns returns from session t+1 (entry at the close of t); `delay` adds
  sessions and is only used for the disclosed robustness block.
Costs: 10 bp of traded notional per side on industry legs (French data has
  no spreads; an assumption, not a measurement); cash legs cost nothing.
  The 2x stress uses 20 bp.
Universe: industries with no missing (-99.99) daily return anywhere in the
  file; the rest are dropped and listed. At least 12 must remain.
Evaluation start: the session after the 14th month-end (all rules warmed up).
  A final calendar month with fewer than 15 sessions is dropped.
Periods (by realisation date): full, pre_1999, 1999_2011, 2012_latest, plus
  post_1999 (1999 to the end). 1999 is the publication year of Moskowitz and
  Grinblatt; it is applied to all three rules. A rule-specific publication
  year (ts_ma10 2007 Faber, ts_mom12 2012 Moskowitz-Ooi-Pedersen, xs_mom12_1
  1999) drives the secondary `rule_pub` decay window.
Statistics: monthly excess returns (rule minus RF, compounded from daily);
  Sharpe = mean/sd * sqrt(12); Newey-West t of the mean; max drawdown on the
  daily total-return curve; stationary-bootstrap 95% CIs (B=2000, fixed seed);
  active return = rule minus ew_monthly total return. Decay ratio =
  Sharpe(post)/Sharpe(pre) with an independent stationary bootstrap of each
  sample; undefined (None) when the pre Sharpe is not positive.

The portfolio.run engine is not used: it copies every close history each
session (quadratic over 25k sessions) and prices US equity fills, while French
returns are close-to-close with no quotes. `run_engine` below holds weights
and pays the proportional cost, and is fed the same target functions.
"""
import bisect
import datetime
import io
import json
import math
import random
import re
import zipfile

from research.strategy import stats
from research.strategy.sleeves import sector_mom, trend

CASH = trend.CASH_LEG
COST_BP_PER_SIDE = 10.0
STRESS_MULT = 2.0
TOP_K = 3
WARMUP_MONTH_ENDS = 14
MIN_TAIL_SESSIONS = 15
MIN_MONTHS = 24
MIN_UNIVERSE = 12
MAX_DATE_MISMATCH = 0.005
BOOT_B = 2000
SEED = 20260930
MISSING_AT_OR_BELOW = -99.0
MAX_UNZIPPED = 200 * 1024 * 1024
LEVEL_BASE = 100.0

RULES = {"ts_ma10": ("trend", "ma10"),
         "ts_mom12": ("trend", "mom12_vs_tbill"),
         "xs_mom12_1": ("sector", "mom12_1")}
PUB_YEAR = {"ts_ma10": 2007, "ts_mom12": 2012, "xs_mom12_1": 1999}
PERIODS = (("full", None, None), ("pre_1999", None, "1998-12-31"),
           ("1999_2011", "1999-01-01", "2011-12-31"),
           ("2012_latest", "2012-01-01", None),
           ("post_1999", "1999-01-01", None))
DECAY_WINDOWS = ("post_1999", "1999_2011", "2012_latest", "rule_pub")
BENCHES = ("ew_monthly", "ew_drift")
PRIMARY_BENCH = "ew_monthly"


class LongHistoryError(ValueError):
    pass


class FrenchParseError(LongHistoryError):
    pass


# ---------------------------------------------------------------- parsing

_MISSING_TOKENS = {"", "na", "nan", "n/a", "-", "--"}


def _date_token(tok):
    """(freq, key) for a date-like token, None when it is not one. Raises on
    an impossible calendar date so a corrupt row cannot pass as text."""
    t = tok.strip()
    if re.fullmatch(r"\d{8}|\d{4}-\d{2}-\d{2}|\d{4}/\d{2}/\d{2}", t):
        dg = re.sub(r"\D", "", t)
        y, m, d = int(dg[:4]), int(dg[4:6]), int(dg[6:])
        if not 1600 <= y <= 2200:
            return None
        try:
            datetime.date(y, m, d)
        except ValueError:
            raise FrenchParseError("bad-date:" + t)
        return "daily", "%04d-%02d-%02d" % (y, m, d)
    if re.fullmatch(r"\d{6}", t):
        y, m = int(t[:4]), int(t[4:])
        if not 1600 <= y <= 2200:
            return None
        if not 1 <= m <= 12:
            raise FrenchParseError("bad-date:" + t)
        return "monthly", "%04d-%02d" % (y, m)
    if re.fullmatch(r"\d{4}", t) and 1600 <= int(t) <= 2200:
        return "annual", t
    return None


def _values(tokens, lineno):
    out = []
    for tok in tokens:
        t = tok.strip()
        if t.lower() in _MISSING_TOKENS:
            out.append(None)
            continue
        try:
            v = float(t)
        except ValueError:
            raise FrenchParseError("bad-value:line-%d:%r" % (lineno, t))
        out.append(None if (not math.isfinite(v) or v <= MISSING_AT_OR_BELOW)
                   else v)
    return out


def _is_number(tok):
    try:
        float(tok)
    except ValueError:
        return False
    return True


def parse_french_text(text):
    """Split a French-library CSV into blocks: [{title, freq, columns, dates,
    rows, orphan}]. Values are percent, with -99.99 / -999 read as None.

    A block is a header row (leading empty field) plus the dated rows that
    follow it; blank lines, text lines (titles, footers) and a change of date
    granularity (daily to annual) end a block. Preamble and footer text are
    ignored, a data row that is malformed raises. Rows that resume after a gap
    with no new header become `orphan` blocks that selection ignores."""
    blocks, cur = [], None
    columns, title, pending, pend_title = None, "", False, ""
    for lineno, raw in enumerate(text.lstrip("﻿").splitlines(), 1):
        line = raw.strip()
        if not line.strip(","):
            cur = None
            continue
        fields = [f.strip() for f in line.split(",")]
        dt = _date_token(fields[0]) if len(fields) > 1 else None
        if dt is not None:
            if columns is None:
                raise FrenchParseError("data-before-header:line-%d" % lineno)
            vals = _values(fields[1:], lineno)
            while len(vals) > len(columns) and vals[-1] is None:
                vals.pop()
            if len(vals) != len(columns):
                raise FrenchParseError("ragged-row:line-%d" % lineno)
            freq, key = dt
            if cur is None or cur["freq"] != freq:
                cur = {"title": pend_title if pending else "", "freq": freq,
                       "columns": list(columns), "dates": [], "rows": [],
                       "orphan": not pending}
                blocks.append(cur)
                pending = False
            if cur["dates"] and key <= cur["dates"][-1]:
                raise FrenchParseError("non-increasing-date:line-%d" % lineno)
            cur["dates"].append(key)
            cur["rows"].append(vals)
            continue
        names = fields[1:]
        while names and not names[-1]:
            names.pop()
        if fields[0] in ("", "date", "Date") and names \
                and all(n and not _is_number(n) for n in names):
            if len(set(names)) != len(names):
                raise FrenchParseError("duplicate-columns:line-%d" % lineno)
            columns, pending, pend_title, cur = names, True, title, None
            continue
        title, cur = line.strip(", "), None
    return [b for b in blocks if b["rows"]]


def read_french_text(path):
    """Text of a French CSV or of the single CSV/TXT member of its zip."""
    with open(path, "rb") as f:
        raw = f.read()
    if zipfile.is_zipfile(io.BytesIO(raw)):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            members = [i for i in z.infolist() if not i.is_dir()
                       and i.filename.lower().endswith((".csv", ".txt"))]
            if not members:
                raise LongHistoryError("zip-has-no-csv")
            m = max(members, key=lambda i: i.file_size)
            if m.file_size > MAX_UNZIPPED:
                raise LongHistoryError("zip-member-too-large")
            raw = z.read(m)
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("latin-1")


def select_block(blocks, freq="daily", title_contains=None, nth=None):
    """One block of `freq`. With `nth`, the nth non-orphan block of that
    frequency. Else the first whose title contains `title_contains`; when no
    title matches a lone candidate is taken, several are ambiguous (error)."""
    cand = [b for b in blocks if b["freq"] == freq and not b["orphan"]]
    if not cand:
        raise FrenchParseError("no-%s-block" % freq)
    if nth is not None:
        if not 0 <= nth < len(cand):
            raise FrenchParseError("block-index")
        return cand[nth]
    if title_contains:
        hit = [b for b in cand
               if title_contains.lower() in b["title"].lower()]
        if hit:
            return hit[0]
        if len(cand) > 1:
            raise FrenchParseError("ambiguous-block:" + title_contains)
    return cand[0]


def block_returns(block):
    """{column: [decimal return or None]} from a percent block."""
    return {c: [None if r[j] is None else r[j] / 100.0 for r in block["rows"]]
            for j, c in enumerate(block["columns"])}


def parse_index_csv(text):
    """User-supplied total-return index: header `date,close`, ISO or
    YYYYMMDD dates, strictly increasing, close > 0. Returns [(date, close)]."""
    lines = [ln.strip() for ln in text.lstrip("﻿").splitlines()
             if ln.strip()]
    if not lines:
        raise LongHistoryError("empty-csv")
    head = [h.strip().lower() for h in lines[0].split(",")]
    if "date" not in head or "close" not in head:
        raise LongHistoryError("csv-header-needs-date,close")
    di, ci = head.index("date"), head.index("close")
    out = []
    for n, ln in enumerate(lines[1:], 2):
        f = [x.strip() for x in ln.split(",")]
        if len(f) <= max(di, ci):
            raise LongHistoryError("ragged-csv-row:%d" % n)
        dt = _date_token(f[di])
        if dt is None or dt[0] != "daily":
            raise LongHistoryError("bad-csv-date:%d" % n)
        try:
            c = float(f[ci])
        except ValueError:
            raise LongHistoryError("bad-csv-close:%d" % n)
        if not (math.isfinite(c) and c > 0):
            raise LongHistoryError("bad-csv-close:%d" % n)
        if out and dt[1] <= out[-1][0]:
            raise LongHistoryError("non-increasing-csv-date:%d" % n)
        out.append((dt[1], c))
    if len(out) < 2:
        raise LongHistoryError("csv-too-short")
    return out


# ------------------------------------------------------------ data assembly

def _compound(returns, base=LEVEL_BASE):
    lv, x = [], base
    for r in returns:
        x *= 1.0 + r
        lv.append(x)
    return lv


def prepare_french(ind_block, fac_block, min_universe=MIN_UNIVERSE,
                   max_mismatch=MAX_DATE_MISMATCH):
    """Sessions, total-return levels and the universe from an industry block
    and a factor block (its RF column). Levels are compounded over every
    industry date, then sampled at the sessions (dates present in both files);
    RF is compounded over its own dates, so a date dropped for a missing RF
    only loses that day of cash yield."""
    rets = block_returns(ind_block)
    kept, dropped = {}, []
    for name, col in rets.items():
        miss = [i for i, r in enumerate(col) if r is None]
        if miss:
            first = next((ind_block["dates"][i] for i, r in enumerate(col)
                          if r is not None), None)
            dropped.append({"name": name, "n_missing": len(miss),
                            "first_valid": first})
        else:
            kept[name] = col
    if CASH in kept or len(kept) < min_universe:
        raise LongHistoryError("universe-too-small:%d" % len(kept))
    fac = block_returns(fac_block)
    rf_cols = [c for c in fac if c.strip().lower() == "rf"]
    if len(rf_cols) != 1:
        raise LongHistoryError("rf-column")
    rf = {d: r for d, r in zip(fac_block["dates"], fac[rf_cols[0]])
          if r is not None}
    ind_dates = ind_block["dates"]
    rf_dates = sorted(rf)
    sessions = sorted(set(ind_dates) & set(rf))
    ind_only = len(ind_dates) - len(sessions)
    rf_only = len(rf_dates) - len(sessions)
    if not sessions or ind_only > max_mismatch * len(ind_dates) \
            or rf_only > max_mismatch * len(rf_dates):
        raise LongHistoryError("calendar-mismatch:%d:%d" % (ind_only, rf_only))
    pos = {d: i for i, d in enumerate(ind_dates)}
    levels = {}
    for name, col in kept.items():
        lv = _compound(col)
        levels[name] = [lv[pos[d]] for d in sessions]
    rf_lv = dict(zip(rf_dates, _compound([rf[d] for d in rf_dates])))
    levels[CASH] = [rf_lv[d] for d in sessions]
    return {"sessions": sessions, "levels": levels,
            "universe": sorted(kept), "rf_level_by_date": rf_lv,
            "info": {"n_sessions": len(sessions), "first": sessions[0],
                     "last": sessions[-1], "n_universe": len(kept),
                     "dropped_industries": dropped,
                     "industry_dates_not_in_rf": ind_only,
                     "rf_dates_not_in_industries": rf_only,
                     "industry_block_title": ind_block["title"],
                     "factor_block_title": fac_block["title"]}}


def prepare_custom(rf_level_by_date, series, min_sessions=2000):
    """Hook for user-supplied total-return indices {symbol: [(date, close)]}:
    sessions are the dates common to every series and the RF; the RF level
    is sampled at the same dates so cash compounds across any gap."""
    if not series or CASH in series:
        raise LongHistoryError("custom-symbols")
    common = set(rf_level_by_date)
    for pts in series.values():
        common &= {d for d, _ in pts}
    sessions = sorted(common)
    if len(sessions) < min_sessions:
        raise LongHistoryError("custom-too-few-common-sessions:%d"
                               % len(sessions))
    levels = {}
    for sym, pts in series.items():
        m = dict(pts)
        levels[sym] = [m[d] for d in sessions]
    levels[CASH] = [rf_level_by_date[d] for d in sessions]
    return {"sessions": sessions, "levels": levels,
            "universe": sorted(series),
            "info": {"n_sessions": len(sessions), "first": sessions[0],
                     "last": sessions[-1], "n_universe": len(series)}}


# ------------------------------------------------------------------- engine

def run_engine(sessions, levels, target_fn, cost_bp=COST_BP_PER_SIDE,
               delay=0):
    """Weights held as fractions of equity. A target decided at the close of
    session i (from closes through i) is held from the close of i + delay and
    earns the returns of sessions i + 1 + delay onward; the proportional cost
    on the traded non-cash weight comes off the first such day. Idle weight
    is cash. Returns dict(returns, turnover, weights); session 0 has return 0
    and the book starts fully in cash."""
    n = len(sessions)
    if CASH not in levels or delay < 0:
        raise LongHistoryError("engine-input")
    for v in levels.values():
        if len(v) != n:
            raise LongHistoryError("levels-length")
    cost = cost_bp / 1e4
    hist = {s: [] for s in levels}
    hold = {CASH: 1.0}
    rets, turn, sched, wlog = [0.0] * n, [0.0] * n, {}, []
    for i, d in enumerate(sessions):
        for s, v in levels.items():
            hist[s].append(v[i])
        if i > 0:
            tgt = sched.pop(i, None)
            paid = 0.0
            if tgt is not None:
                new = {s: x for s, x in tgt.items() if x > 0}
                rest = 1.0 - sum(new.values())
                if rest > 1e-12:
                    new[CASH] = new.get(CASH, 0.0) + rest
                tov = sum(abs(new.get(s, 0.0) - hold.get(s, 0.0))
                          for s in set(new) | set(hold) if s != CASH)
                turn[i], paid, hold = tov, cost * tov, new
            rr = {s: levels[s][i] / levels[s][i - 1] - 1.0 for s in hold}
            gross = sum(w * rr[s] for s, w in hold.items())
            rets[i] = gross - paid
            hold = {s: w * (1.0 + rr[s]) / (1.0 + gross)
                    for s, w in hold.items()}
        w = target_fn(d, hist)
        if w is None:
            continue
        tot = 0.0
        for s, x in w.items():
            if s not in levels or not (isinstance(x, (int, float))
                                       and math.isfinite(x) and x >= 0):
                raise LongHistoryError("bad-target:" + str(s))
            tot += x
        if tot > 1.0 + 1e-9:
            raise LongHistoryError("leverage-violation")
        wlog.append((d, dict(w)))
        if i + 1 + delay < n:
            sched[i + 1 + delay] = dict(w)
    return {"returns": rets, "turnover": turn, "weights": wlog}


def make_rule_fn(name, sessions, universe):
    kind, variant = RULES[name]
    if kind == "trend":
        return trend.make_target_fn(sessions, universe, variant)
    return sector_mom.make_target_fn(sessions, universe, variant, TOP_K)


def _ew_fn(sessions, universe, start_after=None):
    """Equal weight; rebalanced at month ends and on the first session, or
    bought once at session `start_after` when given (buy and hold)."""
    w = {s: 1.0 / len(universe) for s in universe}
    flags = trend.month_end_flags(sessions)
    first = sessions[0]

    def fn(date, _closes):
        if start_after is not None:
            return w if date == start_after else None
        return w if date == first or date in flags else None
    return fn


def eval_start_index(sessions):
    """First session after the WARMUP_MONTH_ENDS-th month-end."""
    flags = trend.month_end_flags(sessions)
    ends = [i for i, d in enumerate(sessions) if d in flags]
    if len(ends) <= WARMUP_MONTH_ENDS:
        raise LongHistoryError("history-too-short")
    return ends[WARMUP_MONTH_ENDS - 1] + 1


def eval_end_index(sessions, start):
    """Exclusive end: drops a final calendar month with < 15 sessions."""
    end = len(sessions)
    last = sessions[-1][:7]
    k = sum(1 for d in sessions[start:] if d[:7] == last)
    if k < MIN_TAIL_SESSIONS:
        end -= k
    if end - start < 2 * MIN_MONTHS * 15:
        raise LongHistoryError("history-too-short")
    return end


# ---------------------------------------------------------------- statistics

def to_monthly(dates, rets):
    """Calendar-month compounded returns: (months, values)."""
    months, vals, cur, acc = [], [], None, 1.0
    for d, r in zip(dates, rets):
        m = d[:7]
        if m != cur:
            if cur is not None:
                months.append(cur)
                vals.append(acc - 1.0)
            cur, acc = m, 1.0
        acc *= 1.0 + r
    if cur is not None:
        months.append(cur)
        vals.append(acc - 1.0)
    return months, vals


def _num(x):
    if x is None or not isinstance(x, (int, float)) or not math.isfinite(x):
        return None
    return float(x)


def _sr(xs):
    """Annualised monthly Sharpe without validation (bootstrap inner loop)."""
    n = len(xs)
    m = sum(xs) / n
    v = sum((x - m) ** 2 for x in xs) / (n - 1)
    if v <= (1e-12 * max(abs(m), 1e-300)) ** 2:
        return 0.0
    return m / math.sqrt(v) * math.sqrt(12.0)


def _mean12(xs):
    return sum(xs) / len(xs) * 12.0


def _ci(sorted_draws, level=0.95):
    a = (1.0 - level) / 2.0
    n = len(sorted_draws)
    return (sorted_draws[int(math.floor(a * (n - 1)))],
            sorted_draws[int(math.ceil((1.0 - a) * (n - 1)))])


def _hac(xs):
    try:
        return _num(stats.hac_mean_tstat(xs))
    except stats.StatsError:
        return None


def period_metrics(exc, daily, turnover=None, boot=BOOT_B, seed=SEED):
    """Metrics of a monthly excess-return list; `daily` are the daily total
    returns of the same span (max drawdown), `turnover` the daily traded
    weight. boot=0 skips the confidence interval."""
    n = len(exc)
    if n < MIN_MONTHS:
        return {"n_months": n, "status": "insufficient-months"}
    sd = stats.stdev(exc)
    out = {"n_months": n, "n_sessions": len(daily),
           "ann_excess_return": _num(stats.mean(exc) * 12.0),
           "ann_vol": _num(sd * math.sqrt(12.0)),
           "sharpe": _num(stats.sharpe(exc, 12.0)),
           "max_drawdown": _num(stats.max_drawdown(daily)),
           "hac_t": _hac(exc)}
    if turnover is not None:
        out["ann_traded_weight"] = _num(sum(turnover) / (n / 12.0))
    if boot:
        lo, hi = _ci(stats.stationary_bootstrap(exc, _sr, b=boot, seed=seed))
        out["sharpe_ci95"] = [_num(lo), _num(hi)]
    return out


def active_metrics(act, boot=BOOT_B, seed=SEED):
    n = len(act)
    if n < MIN_MONTHS:
        return {"n_months": n, "status": "insufficient-months"}
    sd = stats.stdev(act)
    out = {"n_months": n, "ann_active_return": _num(stats.mean(act) * 12.0),
           "tracking_error": _num(sd * math.sqrt(12.0)),
           "info_ratio": _num(stats.sharpe(act, 12.0)), "hac_t": _hac(act)}
    if boot:
        lo, hi = _ci(stats.stationary_bootstrap(act, _mean12, b=boot,
                                                seed=seed))
        out["ann_active_ci95"] = [_num(lo), _num(hi)]
    return out


def decay(pre, post, boot=BOOT_B, seed=SEED):
    """Sharpe(post)/Sharpe(pre) for two disjoint monthly samples, with
    independent stationary bootstraps of each and the (always defined)
    difference. `decay_pct` is the McLean-Pontiff style 1 - ratio."""
    if len(pre) < MIN_MONTHS or len(post) < MIN_MONTHS:
        return {"status": "insufficient-months", "n_pre": len(pre),
                "n_post": len(post)}
    sp, sq = stats.sharpe(pre, 12.0), stats.sharpe(post, 12.0)
    out = {"n_pre": len(pre), "n_post": len(post), "sharpe_pre": _num(sp),
           "sharpe_post": _num(sq), "sharpe_diff": _num(sq - sp),
           "ratio": _num(sq / sp) if sp > 0 else None}
    out["decay_pct"] = None if out["ratio"] is None else 1.0 - out["ratio"]
    if not boot:
        return out
    rng = random.Random(seed)
    bp = max(2.0, len(pre) ** (1.0 / 3.0))
    bq = max(2.0, len(post) ** (1.0 / 3.0))
    ratios, diffs, undefined = [], [], 0
    for _ in range(boot):
        a = _sr([pre[i] for i in stats.stationary_bootstrap_indices(
            len(pre), bp, rng)])
        c = _sr([post[i] for i in stats.stationary_bootstrap_indices(
            len(post), bq, rng)])
        diffs.append(c - a)
        if a > 0:
            ratios.append(c / a)
        else:
            undefined += 1
    diffs.sort()
    ratios.sort()
    out["sharpe_diff_ci95"] = [_num(x) for x in _ci(diffs)]
    out["frac_pre_nonpositive"] = undefined / boot
    out["ratio_ci95"] = [_num(x) for x in _ci(ratios)] \
        if len(ratios) >= 0.5 * boot else None
    out["ratio_unstable"] = undefined / boot > 0.05
    return out


def _span(keys, lo, hi):
    """[i, j) of the sorted string `keys` within [lo, hi] (None = open)."""
    i = 0 if lo is None else bisect.bisect_left(keys, lo)
    j = len(keys) if hi is None else bisect.bisect_right(keys, hi)
    return i, max(i, j)


# ------------------------------------------------------------------- study

def _series(sessions, levels, res, s0, s1):
    dates = sessions[s0:s1]
    lv = levels[CASH]
    rf = [lv[i] / lv[i - 1] - 1.0 for i in range(s0, s1)]
    months, tot = to_monthly(dates, res["returns"][s0:s1])
    _, rfm = to_monthly(dates, rf)
    return {"dates": dates, "daily": res["returns"][s0:s1],
            "turnover": res["turnover"][s0:s1], "months": months,
            "tot": tot, "exc": [a - b for a, b in zip(tot, rfm)]}


def _period_slices(ser, start, end):
    mi, mj = _span(ser["months"], start and start[:7], end and end[:7])
    di, dj = _span(ser["dates"], start, end)
    return mi, mj, di, dj


def _metrics_for(ser, start, end, boot, seed):
    mi, mj, di, dj = _period_slices(ser, start, end)
    return period_metrics(ser["exc"][mi:mj], ser["daily"][di:dj],
                          turnover=ser["turnover"][di:dj], boot=boot,
                          seed=seed)


def _decay_windows(ser, pub_year):
    m = ser["months"]

    def cut(y):
        return _span(m, None, "%04d-12" % (y - 1))[1]
    out = {}
    pre_end = cut(1999)
    for name, lo, hi in (("post_1999", "1999-01", None),
                         ("1999_2011", "1999-01", "2011-12"),
                         ("2012_latest", "2012-01", None)):
        i, j = _span(m, lo, hi)
        out[name] = (0, pre_end, i, j)
    out["rule_pub"] = (0, cut(pub_year), cut(pub_year), len(m))
    return out


def build_study(prepared, rules=None, boot=BOOT_B, seed=SEED, robustness=True):
    """Run every rule and benchmark on `prepared` and tabulate. Pure: no IO."""
    sessions, levels = prepared["sessions"], prepared["levels"]
    universe = prepared["universe"]
    rules = list(rules or RULES)
    if len(universe) <= TOP_K:
        rules = [r for r in rules if RULES[r][0] != "sector"]
    s0 = eval_start_index(sessions)
    s1 = eval_end_index(sessions, s0)
    sims = {}
    for r in rules:
        for tag, bp, dl in (("1x", COST_BP_PER_SIDE, 0),
                            ("2x", COST_BP_PER_SIDE * STRESS_MULT, 0)) + (
                (("delay1", COST_BP_PER_SIDE, 1),) if robustness else ()):
            sims[(r, tag)] = run_engine(
                sessions, levels, make_rule_fn(r, sessions, universe),
                bp, dl)
    sims[("ew_monthly", "1x")] = run_engine(
        sessions, levels, _ew_fn(sessions, universe))
    sims[("ew_drift", "1x")] = run_engine(
        sessions, levels, _ew_fn(sessions, universe,
                                 start_after=sessions[s0 - 1]))
    ser = {k: _series(sessions, levels, v, s0, s1) for k, v in sims.items()}
    bench = ser[(PRIMARY_BENCH, "1x")]
    report = {"eval_window": {"first": sessions[s0], "last": sessions[s1 - 1],
                              "sessions": s1 - s0,
                              "months": len(bench["months"])},
              "periods": {}, "benchmarks": {}, "rules": {}}
    for name, lo, hi in PERIODS:
        di, dj = _span(bench["dates"], lo, hi)
        report["periods"][name] = {"start": lo, "end": hi, "sessions": dj - di}
    for b in BENCHES:
        report["benchmarks"][b] = {
            p: _metrics_for(ser[(b, "1x")], lo, hi, boot, seed)
            for p, lo, hi in PERIODS}
    b_windows = _decay_windows(bench, 1999)
    report["benchmarks"][PRIMARY_BENCH + "_decay"] = {
        w: decay(bench["exc"][a:b], bench["exc"][c:d], boot, seed)
        for w, (a, b, c, d) in b_windows.items() if w != "rule_pub"}
    for r in rules:
        one = ser[(r, "1x")]
        act = [x - y for x, y in zip(one["tot"], bench["tot"])]
        res = {"periods": {}, "stress_2x_cost": {}, "delay_1_session": {},
               "active_vs_" + PRIMARY_BENCH: {}, "decay": {},
               "decay_active": {}, "publication_year": PUB_YEAR[r],
               "trades": sum(1 for t in sims[(r, "1x")]["turnover"] if t > 0)}
        for p, lo, hi in PERIODS:
            res["periods"][p] = _metrics_for(one, lo, hi, boot, seed)
            res["stress_2x_cost"][p] = _metrics_for(ser[(r, "2x")], lo, hi,
                                                    0, seed)
            if robustness:
                res["delay_1_session"][p] = _metrics_for(ser[(r, "delay1")],
                                                         lo, hi, 0, seed)
            mi, mj, _, _ = _period_slices(one, lo, hi)
            res["active_vs_" + PRIMARY_BENCH][p] = active_metrics(
                act[mi:mj], boot, seed)
        for w, (a, b, c, d) in _decay_windows(one, PUB_YEAR[r]).items():
            res["decay"][w] = decay(one["exc"][a:b], one["exc"][c:d], boot,
                                    seed)
            res["decay_active"][w] = decay(act[a:b], act[c:d], boot, seed)
        report["rules"][r] = res
    return report


# ---------------------------------------------------------- pre-registration

def check_prereg(pre):
    """Errors when the prereg's machine-readable block disagrees with this
    module's constants (a run under a different spec is void)."""
    want = {
        "cost_bp_per_side": COST_BP_PER_SIDE, "stress_cost_multiple":
        STRESS_MULT, "top_k": TOP_K, "warmup_month_ends": WARMUP_MONTH_ENDS,
        "min_months": MIN_MONTHS, "min_universe": MIN_UNIVERSE,
        "bootstrap_b": BOOT_B, "bootstrap_seed": SEED,
        "rules": {k: list(v) for k, v in RULES.items()},
        "publication_years": PUB_YEAR, "primary_benchmark": PRIMARY_BENCH,
        "periods": {n: [lo, hi] for n, lo, hi in PERIODS}}
    errs = []
    for k, v in want.items():
        if json.loads(json.dumps(pre.get(k))) != json.loads(json.dumps(v)):
            errs.append("prereg-mismatch:" + k)
    return errs


def evaluate_criteria(report, decision):
    """Pre-registered descriptive flags per rule (no sleeve gate rides on
    them). Thresholds come from the prereg `decision` block."""
    out = {}
    sr_min = decision["min_net_sharpe"]
    t_new = decision["new_signal_tstat_min"]
    t_post = decision["post_publication_tstat_min"]
    dd_max = decision["max_drawdown_pct"] / 100.0
    for r, res in report["rules"].items():
        pre = res["periods"]["pre_1999"]
        post = res["periods"]["post_1999"]
        st2 = res["stress_2x_cost"]["post_1999"]
        act = res["active_vs_" + PRIMARY_BENCH]["post_1999"]

        def ok(cond):
            return bool(cond) if cond is not None else False
        out[r] = {
            "replicates_pre_1999": ok(
                pre.get("sharpe") is not None and pre["sharpe"] >= sr_min
                and pre["hac_t"] is not None and pre["hac_t"] >= t_new),
            "survives_post_1999": ok(
                post.get("sharpe") is not None and post["sharpe"] >= sr_min
                and post["hac_t"] is not None and post["hac_t"] >= t_post),
            "positive_at_2x_cost_post_1999": ok(
                st2.get("sharpe") is not None and st2["sharpe"] > 0),
            "max_dd_within_limit_post_1999": ok(
                post.get("max_drawdown") is not None
                and post["max_drawdown"] <= dd_max),
            "active_ci_lower_gt_0_post_1999": ok(
                act.get("ann_active_ci95") is not None
                and act["ann_active_ci95"][0] > 0)}
    return out
