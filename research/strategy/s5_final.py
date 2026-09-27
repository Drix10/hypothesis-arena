"""S5 FINAL path: holdout materialization + holdout verdict.

Separate module from s5_eval (selection machinery) by construction:
selection code imports s5_eval only, which has NO holdout API
(asserted: no attribute containing 'holdout' exists there). The holdout
is materialized here, in the final path, only after selection freezes.
Research/shadow-only.
"""

from .s5_eval import (VARIANTS, cluster_bootstrap_ci, cluster_null_p,
                      evaluate_bar, holm, paired_deltas, portfolio_curve,
                      sharpe_hac, walk_folds)


def holdout_split(records, n_splits=3):
    """FINAL path only: (folds, holdout). Called after selection freezes."""
    folds = walk_folds(records, n_splits)
    recs = sorted(records, key=lambda r: r["snapshot_ts_ns"])
    n = len(recs)
    edges = [i * n // (n_splits + 2) for i in range(n_splits + 3)]
    return folds, recs[edges[n_splits + 1]:]




def final_report(recs_1x, recs_stress, sessions, equity, bar):
    """Holdout verdict per variant + pooled Holm.

    recs_1x: {variant: records at 1x costs} on the SAME holdout stream.
    recs_stress: {mult_label: {variant: records re-evaluated at that
    spread multiplier}} — cost stress enters through re-resolved economics,
    never by scaling a 1x number."""
    assert set(recs_1x) == set(VARIANTS)
    pvals, rep = [], {"variants": {}}
    for variant, recs in recs_1x.items():
        d = paired_deltas(recs)
        days = [r["day"] for r in recs]
        mu, lo, hi = cluster_bootstrap_ci(d, days)
        p = cluster_null_p(d, days)
        pvals.append((variant, p))
        _, _, rets_f, dd_f = portfolio_curve(recs, "filtered", equity,
                                             sessions)
        closed = sum(1 for r in recs
                     if r["always_label"] in ("win", "loss"))
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
            "sharpe_f": sharpe_hac(portfolio_curve(
                recs, "filtered", equity, sessions)[2])[0],
            "max_dd_pct": dd_f, "n_closed": closed,
            "r_breach_taken": sum(1 for r in recs
                                  if r["r_breach_attempted"]),
            "stress": stress}
    rep["holm"] = holm(pvals)
    adj = dict((n, a) for n, a, _ in rep["holm"])
    for variant, v in rep["variants"].items():
        m = {"sharpe_f": v["sharpe_f"], "holm_p": adj[variant],
             "max_dd_pct": v["max_dd_pct"], "n_closed": v["n_closed"],
             "stress": v["stress"], "r_breach_taken": v["r_breach_taken"]}
        verdict, failed, checks = evaluate_bar(m, bar)
        v["bar_verdict"], v["bar_failed"], v["bar_checks"] = \
            verdict, failed, checks
    return rep
