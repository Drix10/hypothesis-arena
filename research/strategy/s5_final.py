"""S5 FINAL path: holdout materialization + holdout verdict.

Separate module from s5_eval (selection machinery) by construction:
selection code imports s5_eval only, which has NO holdout API
(asserted: no attribute containing 'holdout' exists there). The holdout
is materialized here, in the final path, only after selection freezes.

Terminal evidence step: holdout results are NEVER fed back into
select_variant(). An optional selected_variant (from folds) may be
recorded for the audit trail; it cannot alter any computation and
holdout performance never overwrites it. Research/shadow-only.
"""

import json as _json
import os as _os

from .s5_eval import (R_CHECKED, R_UNAVAILABLE, REQUIRED_STRESS, VARIANTS,
                      cluster_bootstrap_ci, cluster_null_p, evaluate_bar,
                      holm, paired_deltas, portfolio_curve, segment_bounds,
                      sharpe_hac, verify_r_monitor, walk_folds)


def frozen_scope():
    """The frozen amendment_b out-of-scope declaration, read from the
    committed prereg file. The final path trusts NO caller-supplied list."""
    here = _os.path.join(_os.path.dirname(__file__), "s5_prereg.json")
    return sorted(_json.load(open(here))["amendment_b"]["r_out_of_scope"])


def assert_exact_holdout(candidate_recs, holdout):
    """Final evidence must be the EXACT holdout CID set (never day
    membership, never a superset). holdout is the record list from
    holdout_split or its CID set. Returns the CID set."""
    if holdout and isinstance(next(iter(holdout)), dict):
        hset = {r["cid"] for r in holdout}
    else:
        hset = set(holdout)
    cset = {r["cid"] for r in candidate_recs}
    assert cset == hset, "final set != exact holdout CIDs"
    return hset


def holdout_split(records, n_splits=3):
    """FINAL path only: (folds, holdout, holdout_start).

    Folds are label-purged at the holdout boundary: every selection
    record resolves strictly before holdout_start. Asserts the preferred
    invariant plus segment disjointness."""
    edges, bound = segment_bounds(records, n_splits)
    folds = walk_folds(records, n_splits, holdout_start=bound)
    recs = sorted(records, key=lambda r: r["snapshot_ts_ns"])
    holdout = recs[edges[n_splits + 1]:]
    assert holdout, "empty holdout"
    for tr, te in folds:
        for r in tr + te:
            assert r["time_exit_ns"] < bound, \
                "selection label resolves inside holdout"
    hset = {r["cid"] for r in holdout}
    assert not (hset & {r["cid"] for tr, te in folds for r in tr + te}), \
        "holdout leaks into selection folds"
    assert min(r["snapshot_ts_ns"] for r in holdout) >= bound
    return folds, holdout, bound


def final_report(recs_1x, recs_stress, sessions, equity, bar,
                 holdout_cids, selected_variant=None):
    """Holdout verdict per variant + pooled Holm.

    holdout_cids: the EXACT CID set from holdout_split. Every 1x and
    stress record set MUST equal it exactly (asserted; day-membership
    reconstruction cannot pass). R out-of-scope comes from the frozen
    prereg declaration (frozen_scope); no caller list is accepted."""
    assert set(recs_1x) == set(VARIANTS)
    for _v, _recs in recs_1x.items():
        assert_exact_holdout(_recs, holdout_cids)
    for _mult, _by_var in recs_stress.items():
        for _v, _recs in _by_var.items():
            assert_exact_holdout(_recs, holdout_cids)
    scope = frozen_scope()
    assert set(recs_stress) == set(REQUIRED_STRESS), \
        "stress must carry exactly %s" % (REQUIRED_STRESS,)
    for mult, by_var in recs_stress.items():
        assert set(by_var) == set(VARIANTS), mult
    if selected_variant is not None:
        assert selected_variant in VARIANTS
    pvals, rep = [], {"variants": {},
                      "selected_variant": selected_variant,
                      "r_rules_checked": R_CHECKED,
                      "r_rules_unavailable": R_UNAVAILABLE}
    for variant, recs in recs_1x.items():
        d = paired_deltas(recs)
        days = [r["day"] for r in recs]
        mu, lo, hi = cluster_bootstrap_ci(d, days)
        p = cluster_null_p(d, days)
        pvals.append((variant, p))
        labels = {r["cid"]: r["always_label"] for r in recs}
        day_of = {r["cid"]: r["day"] for r in recs}
        trades_f, curve_f, rets_f, dd_f = portfolio_curve(recs, "filtered",
                                                        equity, sessions)
        closed = sum(1 for t in trades_f
                     if labels.get(t["cid"]) in ("win", "loss"))
        breach_attempts = sum(1 for r in recs if r["r_breach_attempted"])
        monitor = verify_r_monitor(trades_f, curve_f, day_of)
        stress = {}
        for mult, by_var in recs_stress.items():
            srecs = by_var[variant]
            _, _, srets_f, _ = portfolio_curve(srecs, "filtered", equity,
                                               sessions)
            _, _, srets_a, _ = portfolio_curve(srecs, "always", equity,
                                               sessions)
            stress[mult] = (sharpe_hac(srets_f)[0], sharpe_hac(srets_a)[0])
        rep["variants"][variant] = {
            "paired_mean_R": mu, "ci95": [lo, hi], "null_p": p,
            "sharpe_f": sharpe_hac(rets_f)[0],
            "max_dd_pct": dd_f, "n_closed": closed,
            "n_trades_taken": len(trades_f),
            "r_breach_attempted": breach_attempts,
            "r_monitor_breaches": monitor,
            "r_breach_count": breach_attempts + len(monitor),
            "stress": stress}
    rep["holm"] = holm(pvals)
    rep["r_scope_frozen"] = scope
    adj = dict((n, a) for n, a, _ in rep["holm"])
    for variant, v in rep["variants"].items():
        m = {"sharpe_f": v["sharpe_f"], "holm_p": adj[variant],
             "max_dd_pct": v["max_dd_pct"], "n_closed": v["n_closed"],
             "stress": v["stress"],
             "r_breach_count": v["r_breach_count"],
             "r_unavailable": R_UNAVAILABLE,
             "r_out_of_scope": scope}
        verdict, failed, checks = evaluate_bar(m, bar)
        v["bar_verdict"], v["bar_failed"], v["bar_checks"] = \
            verdict, failed, checks
    return rep
