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

import hashlib as _hashlib
import json as _json
import os as _os

from .s5_eval import (EVAL_PROTOCOL, R_CHECKED, R_UNAVAILABLE,
                      REQUIRED_STRESS, VARIANTS, cluster_bootstrap_ci,
                      cluster_null_p, daily_returns, et_close_ns,
                      evaluate_bar, holm, paired_deltas, portfolio_curve,
                      segment_bounds, sharpe_hac, verify_r_monitor,
                      walk_folds)

STRESS_MULT = {"1x": 1.0, "1.5x": 1.5, "2x": 2.0, "3x": 3.0}


def _prereg():
    here = _os.path.join(_os.path.dirname(__file__), "s5_prereg.json")
    return _json.load(open(here))


def frozen_bar():
    """The frozen absolute bar, from the committed prereg ONLY.
    final_report takes NO caller bar (a weaker caller bar is
    unrepresentable)."""
    c = _prereg()["absolute_bar"]["conditions"]
    return {"filtered_net_sharpe_gt": c["filtered_net_sharpe_gt"],
            "holm_adjusted_p_lt": c["holm_adjusted_p_lt"],
            "max_drawdown_pct_lte": c["max_drawdown_pct_lte"],
            "min_closed_trades": c["min_closed_trades"]}


def frozen_knobs():
    """Prereg-bound inference knobs (single source: committed prereg).
    Runners use s5_eval defaults; this is the authority they match."""
    p = _prereg()
    return {"boot_seed": 24269, "boot_reps": 2000, "null_seed": 24270,
            "seq_alpha_interim": 0.025, "seq_alpha_final": 0.025,
            "holm_alpha": 0.05,
            "power_mde": 0.15, "power_alpha": p["power"]["alpha"],
            "power_reps": p["power"]["replicates"],
            "power_inner": p["power"]["inner_resamples"],
            "power_seed": p["power"]["seed"]}


def frozen_scope():
    """The frozen amendment_b out-of-scope declaration, read from the
    committed prereg file. The final path trusts NO caller-supplied list."""
    here = _os.path.join(_os.path.dirname(__file__), "s5_prereg.json")
    return sorted(_json.load(open(here))["amendment_b"]["r_out_of_scope"])


def make_holdout_token(holdout, bound):
    """Deterministic provenance token from holdout_split output.

    Binds holdout_start + exact CID multiset hash + count + dates +
    protocol. The final path recomputes all of it from the evidence
    sets; a manufactured CID set cannot match. No reselection after."""
    assert holdout, "empty holdout"
    cids = sorted(r["cid"] for r in holdout)
    return {"holdout_start": bound, "n": len(holdout),
            "cid_hash": _hashlib.sha256("|".join(cids).encode()
                                          ).hexdigest(),
            "dates": sorted({r["day"] for r in holdout}),
            "protocol": EVAL_PROTOCOL}


def _validate_set(recs, token, spread, variant):
    """Multiset-safe exact-holdout validation for ONE evidence set.

    Non-empty, no duplicate CIDs, len == token n, CID-hash == token
    hash, every record carries the expected spread_mult / variant /
    eval_protocol. Fail closed on any mismatch."""
    assert recs, "empty evidence set"
    cids = [r["cid"] for r in recs]
    assert len(cids) == len(set(cids)) == token["n"], \
        "duplicate CID or count mismatch"
    assert _hashlib.sha256("|".join(sorted(cids)).encode()
                           ).hexdigest() == token["cid_hash"], \
        "CID set != token holdout"
    for r in recs:
        assert r["spread_mult"] == spread, \
            "spread_mult %r != bucket %r" % (r["spread_mult"], spread)
        assert r["variant"] == variant, "variant mismatch"
        assert r["eval_protocol"] == token["protocol"] == \
            EVAL_PROTOCOL, "protocol mismatch"
    return set(cids)


def assert_exact_holdout(candidate_recs, holdout):
    """Legacy exact-set check (kept for runner/diagnostic use).

    Final evidence uses token validation (_validate_set), which is
    multiset-safe. holdout is the record list from holdout_split or
    its CID set. Returns the CID set."""
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


def final_report(recs_1x, recs_stress, sessions, equity, token,
                 selected_variant=None):
    """Holdout verdict per variant + pooled Holm.

    token: make_holdout_token() output from the REAL holdout_split.
    Every 1x/stress set is multiset-validated against it (count +
    CID-hash + per-record spread_mult/variant/protocol); day-membership
    reconstruction, duplicates, wrong multipliers, and manufactured
    sets all fail closed. sessions must carry exact 16:00 ET close_ns
    marks and cover EXACTLY the token dates (pre/post injections
    rejected). The bar is frozen_bar() (no caller bar exists).
    Sharpe uses close-to-close daily_returns (partial first interval
    excluded from Sharpe, retained in curve/DD). R out-of-scope comes
    from the frozen prereg declaration (frozen_scope)."""
    assert set(recs_1x) == set(VARIANTS)
    assert set(recs_stress) == set(REQUIRED_STRESS), \
        "stress must carry exactly %s" % (REQUIRED_STRESS,)
    for variant, recs in recs_1x.items():
        _validate_set(recs, token, STRESS_MULT["1x"], variant)
    for mult, by_var in recs_stress.items():
        assert set(by_var) == set(VARIANTS), mult
        for variant, recs in by_var.items():
            _validate_set(recs, token, STRESS_MULT[mult], variant)
    scope = frozen_scope()
    bar = frozen_bar()
    sdays = [s["day"] for s in sessions]
    assert sdays == sorted(token["dates"]), \
        "sessions must cover exactly the holdout dates"
    for s in sessions:
        assert s["close_ns"] == et_close_ns(s["day"]), \
            "session mark is not the 16:00 ET close: %s" % s["day"]
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
        srets_f = daily_returns(rets_f)
        closed = sum(1 for t in trades_f
                     if labels.get(t["cid"]) in ("win", "loss"))
        breach_attempts = sum(1 for r in recs if r["r_breach_attempted"])
        monitor = verify_r_monitor(trades_f, curve_f, day_of)
        stress = {}
        for mult, by_var in recs_stress.items():
            srecs = by_var[variant]
            _, _, srets_f0, _ = portfolio_curve(srecs, "filtered",
                                                equity, sessions)
            _, _, srets_a0, _ = portfolio_curve(srecs, "always", equity,
                                                sessions)
            srets_f = daily_returns(srets_f0)
            srets_a = daily_returns(srets_a0)
            stress[mult] = (sharpe_hac(srets_f)[0], sharpe_hac(srets_a)[0])
        rep["variants"][variant] = {
            "paired_mean_R": mu, "ci95": [lo, hi], "null_p": p,
            "sharpe_f": sharpe_hac(srets_f)[0],
            "max_dd_pct": dd_f, "n_closed": closed,
            "n_trades_taken": len(trades_f),
            "r_breach_attempted": breach_attempts,
            "r_monitor_breaches": monitor,
            "r_breach_count": breach_attempts + len(monitor),
            "stress": stress}
    rep["holm"] = holm(pvals)
    rep["r_scope_frozen"] = scope
    rep["bar_frozen"] = bar
    rep["knobs"] = frozen_knobs()
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
