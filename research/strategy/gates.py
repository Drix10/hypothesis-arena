"""backtest gate and shadow gate report generators. Every condition is computed from the
supplied series and reported with its value; the verdict is PASS only if all
conditions pass, and required evidence that is missing fails its condition.
Sharpe-based conditions use returns in excess of the cash leg. Passing is
necessary for a human decision, never a promotion."""
import json
import math

from research.strategy import benchmarks, stats

DSR_MIN = 0.95
PBO_MAX = 0.20
EXCLUDED_EVENT_MAX = 0.05
SHADOW_MIN_SESSIONS = 60
SHADOW_MIN_TRADES = 30
SHADOW_MIN_REBALANCES = 3
SHADOW_COST_RATIO_MAX = 1.5
ANNUAL = 252
FACTOR_NAMES = ("Mkt-RF", "SMB", "HML", "RMW", "CMA", "Mom")


class GateError(ValueError):
    pass


def _c(name, ok, value):
    return {"name": name, "pass": bool(ok), "value": value}


def backtest_gate(ret_1x, ret_2x, cash, passive, n_trials, sr_var, *, seed=0,
           variants_matrix=None, literature=False, tstat=None,
           haircut_ok=None, transfer_ok=None, participation_ok=None,
           excluded_event_frac=None, is_event_strategy=False,
           model_component=False, paired_no_model_exists=None, decision=None,
           cost_multiple=None, dates=None, factors=None, promoted=None):
    """Holdout series in, {'gate','verdict','failed','conditions'} out.

    `variants_matrix[t][j]` holds each registered variant's return; PBO is
    not applicable (and skipped) for a single variant. `decision` is the
    pre-registration's decision block: its thresholds become conditions.
    `dates` (ISO, one per return), `factors` (french_factors rows) and
    `promoted` ({name: returns}) add a 'breadth' entry; it never changes the
    verdict."""
    n = len(ret_1x)
    if not (len(ret_2x) == len(cash) == len(passive) == n) or n < 4:
        raise GateError("series-length")
    ex1 = [a - c for a, c in zip(ret_1x, cash)]
    ex2 = [a - c for a, c in zip(ret_2x, cash)]
    conds = []
    ci = stats.bootstrap_ci(ex1, stats.sharpe, seed=seed)
    conds.append(_c("net_sharpe_ci_lower_gt_0", ci[0] > 0, ci))
    s2 = stats.sharpe(ex2)
    conds.append(_c("sharpe_at_2x_cost_gt_0", s2 > 0, s2))
    eci = stats.bootstrap_ci(ex1, stats.mean, seed=seed + 1)
    conds.append(_c("excess_over_cash_ci_lower_gt_0", eci[0] > 0, eci))
    sl, pa = benchmarks.vol_match(ret_1x, passive)
    sh_s, sh_p = stats.sharpe(sl), stats.sharpe(pa)
    dd_s, dd_p = stats.max_drawdown(sl), stats.max_drawdown(pa)
    conds.append(_c("vs_vol_matched_passive",
                    sh_s >= sh_p and dd_s <= dd_p,
                    {"sharpe": [sh_s, sh_p], "max_dd": [dd_s, dd_p]}))
    dsr = stats.deflated_sharpe(ex1, n_trials, sr_var)
    conds.append(_c("dsr_ge_0.95", dsr >= DSR_MIN, dsr))
    if variants_matrix is not None:
        if len(variants_matrix) != n:
            raise GateError("variants-length")
        pbo, _ = stats.pbo([[x - c for x in row]
                            for row, c in zip(variants_matrix, cash)])
        conds.append(_c("pbo_le_0.2", pbo <= PBO_MAX, pbo))
    if decision is not None:
        conds.append(_c("net_sharpe_ge_prereg_min",
                        stats.sharpe(ex1, ANNUAL) >= decision["min_net_sharpe"],
                        stats.sharpe(ex1, ANNUAL)))
        conds.append(_c("max_dd_le_prereg",
                        stats.max_drawdown(ret_1x) * 100.0
                        <= decision["max_drawdown_pct"],
                        stats.max_drawdown(ret_1x) * 100.0))
        conds.append(_c("cost_multiple_ge_prereg",
                        cost_multiple is not None
                        and cost_multiple >= decision["min_cost_multiple"],
                        cost_multiple))
    sk, ku = stats.skew_kurt(ex1)
    need = stats.min_trl(stats.sharpe(ex1), sk, ku)
    conds.append(_c("history_ge_min_trl", n >= need, need))
    if not literature:
        conds.append(_c("tstat_ge_3_new_signal",
                        tstat is not None and tstat >= 3.0, tstat))
    else:
        conds.append(_c("literature_haircut_met", haircut_ok is True,
                        haircut_ok))
    conds.append(_c("transferability", transfer_ok is True, transfer_ok))
    conds.append(_c("participation_caps", participation_ok is True,
                    participation_ok))
    if is_event_strategy:
        conds.append(_c("excluded_events_le_5pct",
                        excluded_event_frac is not None
                        and excluded_event_frac <= EXCLUDED_EVENT_MAX,
                        excluded_event_frac))
    if model_component:
        conds.append(_c("paired_no_model_variant_exists",
                        paired_no_model_exists is True, paired_no_model_exists))
    failed = [c["name"] for c in conds if not c["pass"]]
    report = {"gate": "backtest", "verdict": "PASS" if not failed else "FAIL",
              "failed": failed, "conditions": conds}
    if dates is not None or factors is not None or promoted is not None:
        report["breadth"] = breadth(ret_1x, cash, dates, factors, promoted)
    return report


def _decade_alpha(ex, dates):
    by = {}
    for d, x in zip(dates, ex):
        by.setdefault(int(d[:4]) // 10 * 10, []).append(x)
    return {str(k): {"annual_net_alpha": stats.mean(v) * ANNUAL, "n": len(v)}
            for k, v in sorted(by.items())}


def _solve(a, b):
    """Gauss-Jordan with partial pivoting on a small square system."""
    m = len(a)
    aug = [row[:] + [v] for row, v in zip(a, b)]
    for i in range(m):
        piv = max(range(i, m), key=lambda r: abs(aug[r][i]))
        if abs(aug[piv][i]) < 1e-14:
            raise GateError("factors-collinear")
        aug[i], aug[piv] = aug[piv], aug[i]
        for r in range(m):
            if r != i:
                f = aug[r][i] / aug[i][i]
                aug[r] = [x - f * y for x, y in zip(aug[r], aug[i])]
    return [aug[i][m] / aug[i][i] for i in range(m)]


def _factor_alpha(ex, dates, factors):
    """Six-factor (FF5 + momentum) alpha on the dates both series share."""
    rows = {d: v for d, v in factors}
    idx = [i for i, d in enumerate(dates) if d in rows]
    if len(idx) < 4:
        raise GateError("factor-overlap")
    y = [ex[i] - rows[dates[i]]["RF"] for i in idx]
    x = [[1.0] + [rows[dates[i]][k] for k in FACTOR_NAMES] for i in idx]
    p = len(x[0])
    xtx = [[sum(r[a] * r[b] for r in x) for b in range(p)] for a in range(p)]
    beta = _solve(xtx, [sum(r[a] * v for r, v in zip(x, y)) for a in range(p)])
    # The fitted factor premium, without the intercept, makes spanning_alpha's
    # intercept equal the multi-factor alpha. lean: its t-stat and CI ignore
    # the estimation error of the loadings; replace with a joint regression
    # if the gate ever conditions on them.
    fit = [sum(b * v for b, v in zip(beta[1:], r[1:])) for r in x]
    out = stats.spanning_alpha(y, fit)
    out["loadings"] = dict(zip(FACTOR_NAMES, beta[1:]))
    return out


def _corr(a, b):
    ma, mb = stats.mean(a), stats.mean(b)
    sa = sum((x - ma) ** 2 for x in a)
    sb = sum((x - mb) ** 2 for x in b)
    if sa <= 0.0 or sb <= 0.0:
        raise GateError("constant-series")
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(sa * sb)


def effective_signals(corr):
    """(sum of eigenvalues)^2 / sum of squared eigenvalues of a correlation
    matrix, i.e. n^2 over its squared Frobenius norm."""
    n = len(corr)
    return n * n / sum(v * v for row in corr for v in row)


def breadth(ret_1x, cash, dates=None, factors=None, promoted=None):
    """Net alpha per decade, factor alpha, correlation with each promoted
    strategy and the effective number of independent signals."""
    n = len(ret_1x)
    ex = [a - c for a, c in zip(ret_1x, cash)]
    out = {}
    if (dates is not None and len(dates) != n) or (
            promoted and any(len(r) != n for r in promoted.values())):
        raise GateError("breadth-length")
    if dates is not None:
        out["net_alpha_by_decade"] = _decade_alpha(ex, dates)
        if factors is not None:
            out["factor_alpha"] = _factor_alpha(ex, dates, factors)
    elif factors is not None:
        raise GateError("factors-need-dates")
    if promoted is not None:
        names = sorted(promoted)
        series = [ret_1x] + [promoted[k] for k in names]
        out["promoted_correlation"] = {k: _corr(ret_1x, promoted[k])
                                       for k in names}
        out["effective_signals"] = effective_signals(
            [[_corr(a, b) for b in series] for a in series])
    return out


def shadow_gate(kind, sessions, trades, rebalances, shadow_ret, band_lo, band_hi,
           modeled_cost_usd, live_cost_est_usd, unexplained_anomalies):
    """kind: 'daily' or 'monthly'. Tracking = shadow total return inside
    [band_lo, band_hi] (5th/95th pct of equal-length bootstrapped
    backtest paths, supplied by the caller)."""
    if kind not in ("daily", "monthly"):
        raise ValueError("kind")
    conds = []
    if kind == "daily":
        conds.append(_c("min_sessions_60", sessions >= SHADOW_MIN_SESSIONS,
                        sessions))
        conds.append(_c("min_trades_30", trades >= SHADOW_MIN_TRADES, trades))
    else:
        conds.append(_c("min_rebalances_3", rebalances >= SHADOW_MIN_REBALANCES,
                        rebalances))
    tot = 1.0
    for r in shadow_ret:
        tot *= 1.0 + r
    tot -= 1.0
    conds.append(_c("inside_tracking_band", band_lo <= tot <= band_hi,
                    [band_lo, tot, band_hi]))
    ratio = (modeled_cost_usd / live_cost_est_usd
             if live_cost_est_usd and live_cost_est_usd > 0
             and modeled_cost_usd and modeled_cost_usd > 0 else None)
    conds.append(_c("modeled_cost_within_1.5x_live",
                    ratio is not None
                    and 1.0 / SHADOW_COST_RATIO_MAX <= ratio <= SHADOW_COST_RATIO_MAX,
                    ratio))
    conds.append(_c("zero_unexplained_anomalies",
                    unexplained_anomalies == 0, unexplained_anomalies))
    failed = [c["name"] for c in conds if not c["pass"]]
    return {"gate": "shadow", "verdict": "PASS" if not failed else "FAIL",
            "failed": failed, "conditions": conds}


def _finite(x):
    if isinstance(x, float) and not math.isfinite(x):
        return "inf" if x > 0 else "-inf" if x < 0 else "nan"
    if isinstance(x, dict):
        return {k: _finite(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_finite(v) for v in x]
    return x


def render(report):
    return json.dumps(_finite(report), sort_keys=True, indent=2,
                      allow_nan=False, default=str)
