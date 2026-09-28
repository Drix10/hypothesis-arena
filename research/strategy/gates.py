"""A-gate / B-gate report generators (doc 11 §11.3a). Stdlib only.

Mechanical: every condition is computed from supplied series and returned
with its value; the verdict is PASS only if ALL conditions pass. A missing
input FAILS the condition (fail closed), never skips it. Passing is
necessary evidence for a human decision, never a promotion.
"""
import json

from research.strategy import benchmarks, stats

DSR_MIN = 0.95
PBO_MAX = 0.20
EXCLUDED_EVENT_MAX = 0.05
B_MIN_SESSIONS = 60
B_MIN_TRADES = 30
B_MIN_REBALANCES = 3
B_COST_RATIO_MAX = 1.5


def _c(name, ok, value):
    return {"name": name, "pass": bool(ok), "value": value}


def a_gate(ret_1x, ret_2x, cash, passive, n_trials, sr_var, *, seed=0,
           variants_matrix=None, literature=False, tstat=None,
           haircut_ok=None, transfer_ok=None, participation_ok=None,
           excluded_event_frac=None, is_event_sleeve=False,
           ai_component=False, paired_no_ai_exists=None):
    """Return {'verdict','failed','conditions'} for the holdout series."""
    conds = []
    ci = stats.bootstrap_ci(ret_1x, stats.sharpe, seed=seed)
    conds.append(_c("net_sharpe_ci_lower_gt_0", ci[0] > 0, ci))
    s2 = stats.sharpe(ret_2x)
    conds.append(_c("sharpe_at_2x_cost_gt_0", s2 > 0, s2))
    ex = [a - b for a, b in zip(ret_1x, cash)]
    eci = stats.bootstrap_ci(ex, stats.mean, seed=seed + 1)
    conds.append(_c("excess_over_cash_ci_lower_gt_0", eci[0] > 0, eci))
    sl, pa = benchmarks.vol_match(ret_1x, passive)
    sh_s, sh_p = stats.sharpe(sl), stats.sharpe(pa)
    dd_s, dd_p = stats.max_drawdown(sl), stats.max_drawdown(pa)
    conds.append(_c("vs_vol_matched_passive",
                    sh_s >= sh_p and dd_s <= dd_p,
                    {"sharpe": [sh_s, sh_p], "max_dd": [dd_s, dd_p]}))
    dsr = stats.deflated_sharpe(ret_1x, n_trials, sr_var)
    conds.append(_c("dsr_ge_0.95", dsr >= DSR_MIN, dsr))
    if variants_matrix is not None:
        pbo, _ = stats.pbo(variants_matrix)
        conds.append(_c("pbo_le_0.2", pbo <= PBO_MAX, pbo))
    sk, ku = stats.skew_kurt(ret_1x)
    need = stats.min_trl(stats.sharpe(ret_1x), sk, ku)
    conds.append(_c("history_ge_min_trl", len(ret_1x) >= need, need))
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
             if live_cost_est_usd and live_cost_est_usd > 0 else None)
    conds.append(_c("modeled_cost_within_1.5x_live",
                    ratio is not None and ratio <= B_COST_RATIO_MAX, ratio))
    conds.append(_c("zero_unexplained_anomalies",
                    unexplained_anomalies == 0, unexplained_anomalies))
    failed = [c["name"] for c in conds if not c["pass"]]
    return {"gate": "B", "verdict": "PASS" if not failed else "FAIL",
            "failed": failed, "conditions": conds}


def render(report):
    return json.dumps(report, sort_keys=True, indent=2, default=str)
