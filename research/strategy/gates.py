"""A-gate and B-gate report generators. Every condition is computed from the
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
B_MIN_SESSIONS = 60
B_MIN_TRADES = 30
B_MIN_REBALANCES = 3
B_COST_RATIO_MAX = 1.5
ANNUAL = 252


class GateError(ValueError):
    pass


def _c(name, ok, value):
    return {"name": name, "pass": bool(ok), "value": value}


def a_gate(ret_1x, ret_2x, cash, passive, n_trials, sr_var, *, seed=0,
           variants_matrix=None, literature=False, tstat=None,
           haircut_ok=None, transfer_ok=None, participation_ok=None,
           excluded_event_frac=None, is_event_sleeve=False,
           ai_component=False, paired_no_ai_exists=None, decision=None,
           cost_multiple=None):
    """Holdout series in, {'gate','verdict','failed','conditions'} out.

    `variants_matrix[t][j]` holds each registered variant's return; PBO is
    not applicable (and skipped) for a single variant. `decision` is the
    pre-registration's decision block: its thresholds become conditions."""
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
    if is_event_sleeve:
        conds.append(_c("excluded_events_le_5pct",
                        excluded_event_frac is not None
                        and excluded_event_frac <= EXCLUDED_EVENT_MAX,
                        excluded_event_frac))
    if ai_component:
        conds.append(_c("paired_no_ai_variant_exists",
                        paired_no_ai_exists is True, paired_no_ai_exists))
    failed = [c["name"] for c in conds if not c["pass"]]
    return {"gate": "A", "verdict": "PASS" if not failed else "FAIL",
            "failed": failed, "conditions": conds}


def b_gate(kind, sessions, trades, rebalances, shadow_ret, band_lo, band_hi,
           modeled_cost_usd, live_cost_est_usd, unexplained_anomalies):
    """kind: 'daily' or 'monthly'. Tracking = shadow total return inside
    [band_lo, band_hi] (5th/95th pct of equal-length bootstrapped
    backtest paths, supplied by the caller)."""
    if kind not in ("daily", "monthly"):
        raise ValueError("kind")
    conds = []
    if kind == "daily":
        conds.append(_c("min_sessions_60", sessions >= B_MIN_SESSIONS,
                        sessions))
        conds.append(_c("min_trades_30", trades >= B_MIN_TRADES, trades))
    else:
        conds.append(_c("min_rebalances_3", rebalances >= B_MIN_REBALANCES,
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
                    and 1.0 / B_COST_RATIO_MAX <= ratio <= B_COST_RATIO_MAX,
                    ratio))
    conds.append(_c("zero_unexplained_anomalies",
                    unexplained_anomalies == 0, unexplained_anomalies))
    failed = [c["name"] for c in conds if not c["pass"]]
    return {"gate": "B", "verdict": "PASS" if not failed else "FAIL",
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
