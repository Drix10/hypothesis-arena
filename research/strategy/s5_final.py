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

from .s5_eval import (BOOT_REPS, BOOT_SEED, EVAL_PROTOCOL, HOLM_ALPHA,
                      POWER_INNER, POWER_REPS, POWER_SEED, R_CHECKED,
                      R_SCOPE_NOTE, R_UNAVAILABLE, REQUIRED_STRESS,
                      SEQ_ALPHA_FINAL, SEQ_ALPHA_INTERIM, VARIANTS,
                      cluster_bootstrap_ci, cluster_null_p, daily_returns,
                      et_close_ns, et_open_ns, eval_hash, evaluate_bar,
                      holm, last_close_at_or_before, paired_deltas,
                      portfolio_curve, segment_bounds, sharpe_hac,
                      verify_r_monitor, walk_folds)

STRESS_MULT = {"1x": 1.0, "1.5x": 1.5, "2x": 2.0, "3x": 3.0}
# Fields allowed to differ between a 1x record and its re-resolved stress
# twin (same CID + variant): resolution/economics-derived ONLY. Every
# other field (candidate, JEV verdict, day, labels' inputs, fills' inputs)
# must be byte-identical, else the stress set is not the same population.
STRESS_MUTABLE = frozenset(("spread_mult", "exit_spread_bps",
                             "entry_fill", "exit_fill", "exit_ts_ns",
                             "resolved_r", "always_r", "always_label",
                             "always_realized", "filtered_r",
                             "filtered_taken", "r_breach_attempted",
                             "eval_hash"))
# Fields allowed to differ between the split variant's 1x record and
# another variant's 1x twin (same CID + spread): decision-derived ONLY.
VARIANT_MUTABLE = frozenset(("variant", "filtered_pass",
                              "filtered_action", "filtered_reason",
                              "filtered_r", "filtered_taken",
                              "r_breach_attempted", "eval_hash"))


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


def frozen_knobs(prereg=None):
    """Prereg-parsed inference knobs (committed prereg is the ONLY source).

    Every value is parsed from the prereg's structured inference_knobs
    section — no duplicated literals in the final authority path. Use
    check_knobs() to prove the s5_eval entry-point defaults match."""
    k = (prereg or _prereg())["inference_knobs"]
    return {"boot_seed": k["boot_seed"], "boot_reps": k["boot_reps"],
            "null_seed": k["null_seed"],
            "seq_alpha_interim": k["seq_alpha_interim"],
            "seq_alpha_final": k["seq_alpha_final"],
            "seq_reps": k["seq_reps"], "seq_seed": k["seq_seed"],
            "holm_alpha": k["holm_alpha"],
            "power_mde": k["power_mde"],
            "power_alpha": k["power_alpha"],
            "power_reps": k["power_reps"],
            "power_inner": k["power_inner"],
            "power_seed": k["power_seed"],
            "power_target": k["power_target"]}


def check_knobs(prereg=None):
    """Fail-closed mismatch list: parsed prereg knobs vs s5_eval defaults.

    Empty == implementation matches the commitment. A stale constant on
    either side shows up here (hostile: mutated prereg copy). The
    power-MDE/target rows pin the runner-passed literals (demo/slice
    pass mde=0.15 positionally; target=0.8 is power_study's default)."""
    import inspect as _insp
    from . import s5_eval as _e
    k = frozen_knobs(prereg)
    pw = _insp.signature(_e.power_study).parameters
    rows = [
        ("boot_seed", k["boot_seed"], _e.BOOT_SEED),
        ("boot_reps", k["boot_reps"], _e.BOOT_REPS),
        ("null_seed", k["null_seed"], _e.BOOT_SEED + 1),
        ("seq_alpha_interim", k["seq_alpha_interim"],
         _e.SEQ_ALPHA_INTERIM),
        ("seq_alpha_final", k["seq_alpha_final"],
         _e.SEQ_ALPHA_FINAL),
        ("seq_reps", k["seq_reps"], _e.BOOT_REPS),
        ("seq_seed", k["seq_seed"], _e.BOOT_SEED),
        ("holm_alpha", k["holm_alpha"], _e.HOLM_ALPHA),
        ("power_alpha", k["power_alpha"],
         pw["alpha"].default),
        ("power_reps", k["power_reps"], _e.POWER_REPS),
        ("power_inner", k["power_inner"], _e.POWER_INNER),
        ("power_seed", k["power_seed"], _e.POWER_SEED),
        ("power_target", k["power_target"], pw["target"].default),
    ]
    rows.append(("power_mde", k["power_mde"], 0.15))
    return [name for name, want, got in rows if want != got]


def frozen_scope():
    """The frozen amendment_b out-of-scope declaration, read from the
    committed prereg file. The final path trusts NO caller-supplied list."""
    here = _os.path.join(_os.path.dirname(__file__), "s5_prereg.json")
    return sorted(_json.load(open(here))["amendment_b"]["r_out_of_scope"])


def _record_digest(recs):
    """Canonical digest of exact evaluation records.

    SHA256 over sorted per-record eval_hash values. ANY field mutation
    (day, snapshot/exit ts, R, labels, fills, ...) changes the digest,
    so record CONTENT is bound, not just the CID set."""
    return _hashlib.sha256("|".join(sorted(r["eval_hash"]
                                            for r in recs)).encode()
                           ).hexdigest()


def _mint_split_token(holdout, bound, n_splits, stream_n, edges):
    """Authoritative split token. Mint point is holdout_split() ONLY.

    Binds holdout_start + count + CID hash + RECORD-CONTENT digest +
    dates + split variant + protocol + segmentation descriptor. The
    final path recomputes every field from the threaded split tuple;
    a subset (or any caller) minting its own token cannot reproduce
    the real split's record digest against the real evidence."""
    assert holdout, "empty holdout"
    cids = sorted(r["cid"] for r in holdout)
    return {"holdout_start": bound, "n": len(holdout),
            "cid_hash": _hashlib.sha256("|".join(cids).encode()
                                          ).hexdigest(),
            "record_hash": _record_digest(holdout),
            "dates": sorted({r["day"] for r in holdout}),
            "split_variant": holdout[0]["variant"],
            "protocol": EVAL_PROTOCOL,
            "n_splits": n_splits, "stream_n": stream_n,
            "edges": list(edges)}


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
    """FINAL path only: (folds, holdout, holdout_start, split_token).

    SOLE mint point of the authoritative split token. Folds are
    label-purged at the holdout boundary: every selection record
    resolves strictly before holdout_start. Asserts the preferred
    invariant plus segment disjointness. Thread the returned tuple
    into final_report; never re-mint, never substitute a subset."""
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
    token = _mint_split_token(holdout, bound, n_splits, len(recs),
                              edges)
    return folds, holdout, bound, token


def build_holdout_sessions(bars, token, data_id):
    """Canonical session construction INSIDE the final path.

    bars: {symbol: [Bar]} (frozen slice panels, ts-sorted). Sessions are
    DERIVED here from bars + token dates + data_id — no caller-supplied
    price population exists, so forged closes (AAPL=1M) are
    unrepresentable. Marks are the last bar at-or-before each 16:00 ET
    close (after-hours never marks); end_ts == close_ns always (no
    seam). Missing marks fail closed. Returns (sessions, session_proof)
    with session_hash over (day, close_ns, sorted symbol=px) + slice.
    """
    sessions = []
    for d in token["dates"]:
        close = et_close_ns(d)
        closes = {}
        for sym, bs in bars.items():
            closes[sym] = last_close_at_or_before(bs, close)
        assert all(v is not None for v in closes.values()), \
            "missing mark for %s" % d
        sessions.append({"day": d, "end_ts": close,
                         "close_ns": close, "closes": closes})
    body = ";".join("%s|%d|%s" % (s["day"], s["close_ns"], ",".join(
        "%s=%r" % (sym, s["closes"][sym])
        for sym in sorted(s["closes"]))) for s in sessions)
    proof = {"session_hash": _hashlib.sha256(body.encode()
                                               ).hexdigest(),
             "data_slice": data_id["slice"],
             "dataset_sha": data_id["dataset_sha"],
             "n_sessions": len(sessions)}
    return sessions, proof


def _check_record_self(rec):
    """Per-record self-consistency: stored eval_hash must equal a fresh
    recomputation over the record's own fields. Detects in-place field
    edits even before set-level comparison."""
    assert rec.get("eval_hash") == eval_hash(rec), \
        "eval_hash mismatch (mutated record): %s" % rec.get("cid")


def _validate_evidence(split, recs_1x, recs_stress):
    """Full evidence chain against the threaded split tuple.

    split = (folds, holdout, bound, split_token) from holdout_split.
    1. token recomputed from holdout (record digest, CID hash, n,
       dates, bound, segmentation) — tampered tokens fail.
    2. fold/holdout partition re-checked (disjoint, union == stream_n,
       purge invariants) — substituted splits fail.
    3. split-variant 1x set must digest-match the split holdout EXACTLY
       (record CONTENT equality) — subsets and mutated rows fail.
    4. other-variant 1x twins match field-wise (VARIANT_MUTABLE only).
    5. every stress record matches its same-variant 1x twin field-wise
       (STRESS_MUTABLE only) with the exact bucket spread_mult.
    Returns {cid: split-variant 1x record} (immutable reference map)."""
    folds, holdout, bound, token = split
    assert set(recs_1x) == set(VARIANTS)
    assert set(recs_stress) == set(REQUIRED_STRESS), \
        "stress must carry exactly %s" % (REQUIRED_STRESS,)
    # 1. token integrity from the threaded holdout
    assert token["holdout_start"] == bound
    assert token["n"] == len(holdout)
    assert token["record_hash"] == _record_digest(holdout)
    cids = sorted(r["cid"] for r in holdout)
    assert token["cid_hash"] == _hashlib.sha256("|".join(cids).encode()
                                                  ).hexdigest()
    assert token["dates"] == sorted({r["day"] for r in holdout})
    assert token["protocol"] == EVAL_PROTOCOL
    # 2. partition re-check (purge + disjointness; folds overlap by
    # design across walk-forward splits, so no size arithmetic here —
    # stream_n/edges stay as echoed audit fields)
    for tr, te in folds:
        for r in tr + te:
            assert r["time_exit_ns"] < bound
            assert r["cid"] not in set(cids)
    assert min(r["snapshot_ts_ns"] for r in holdout) >= bound
    sv = token["split_variant"]
    assert sv in VARIANTS
    # 3. split-variant 1x evidence IS the split holdout (content digest)
    ref = recs_1x[sv]
    assert ref, "empty evidence set"
    assert len(ref) == len(set(r["cid"] for r in ref)) == token["n"], \
        "duplicate CID or count mismatch"
    for r in ref:
        _check_record_self(r)
        assert r["spread_mult"] == 1.0, "1x spread_mult"
        assert r["variant"] == sv, "variant mismatch"
        assert r["eval_protocol"] == EVAL_PROTOCOL, "protocol"
    assert _record_digest(ref) == token["record_hash"], \
        "1x evidence != split holdout records"
    refmap = {r["cid"]: r for r in ref}
    # 4. other-variant 1x twins
    for variant, recs in recs_1x.items():
        if variant == sv:
            continue
        assert {r["cid"] for r in recs} == set(refmap), \
            "variant-twin CID set drifted"
        for r in recs:
            _check_record_self(r)
            assert r["spread_mult"] == 1.0
            assert r["variant"] == variant
            base = refmap[r["cid"]]
            for k in set(r) | set(base):
                if k not in VARIANT_MUTABLE:
                    assert k in base and k in r and r[k] == base[k], \
                        "variant-twin field %s drifted: %s" % (k,
                                                              r["cid"])
    # 5. stress twins
    for mult, by_var in recs_stress.items():
        assert set(by_var) == set(VARIANTS), mult
        for variant, recs in by_var.items():
            assert {r["cid"] for r in recs} == set(refmap), \
                "stress CID set drifted"
            base_map = {r2["cid"]: r2 for r2 in recs_1x[variant]}
            for r in recs:
                _check_record_self(r)
                assert r["spread_mult"] == STRESS_MULT[mult], \
                    "spread_mult %r != bucket %r" % (r["spread_mult"],
                                                      mult)
                assert r["variant"] == variant
                base = base_map[r["cid"]]
                for k in set(r) | set(base):
                    if k not in STRESS_MUTABLE:
                        assert k in base and k in r and \
                            r[k] == base[k], \
                            "stress-twin field %s drifted: %s" % (k,
                                                                  r["cid"])
    return refmap


BASELINE_MULTS = ("1x", "1.5x", "2x", "3x")


def baseline_gate(chall, baseline, proof, token):
    """Mechanical challenger-vs-baseline_v1 gate (docs 07/11/12).

    chall: {mult_label or '1x': filtered_sharpe, 'dd_1x': ..., } built
    from the holdout rep (same window, same sessions, same costs).
    baseline: frozen baseline_v1 holdout artifact {baseline_id,
    data_slice, dataset_sha, dates, protocol, metrics: {mult: {sharpe_f,
    max_dd_pct, n_closed}}}. Fail closed on absent/malformed/mismatched
    artifact (S2 acceptance OPEN => no valid artifact exists yet, so the
    gate reads ABSENT and promotion stays closed). Beats requires
    challenger net Sharpe > baseline at ALL of 1x/1.5x/2x/3x with
    1x drawdown not worse than baseline. Returns (verdict, failed,
    detail)."""
    if baseline is None:
        return (False, ["baseline_absent"],
                {"status": "absent (S2 acceptance OPEN)"})
    failed, detail = [], {"status": "evaluated"}
    try:
        assert baseline["baseline_id"] == "baseline_v1"
        assert baseline["protocol"] == EVAL_PROTOCOL
        assert baseline["data_slice"] == proof["data_slice"]
        assert baseline["dataset_sha"] == proof["dataset_sha"]
        assert sorted(baseline["dates"]) == sorted(token["dates"])
        bm = baseline["metrics"]
        assert set(bm) == set(BASELINE_MULTS)
        for m in BASELINE_MULTS:
            for k in ("sharpe_f", "max_dd_pct", "n_closed"):
                assert isinstance(bm[m][k], (int, float))
    except (KeyError, AssertionError, TypeError) as e:
        return (False, ["baseline_malformed"], {"status": "malformed",
                                                 "error": str(e)})
    for m in BASELINE_MULTS:
        if not chall[m] > baseline["metrics"][m]["sharpe_f"]:
            failed.append("beats_%s" % m)
    if not chall["dd_1x"] <= baseline["metrics"]["1x"]["max_dd_pct"]:
        failed.append("dd_1x")
    detail["challenger"] = chall
    return (not failed, failed, detail)
def final_report(split, recs_1x, recs_stress, sessions, proof, bars,
                 data_id, equity, baseline=None, selected_variant=None):
    """Holdout verdict per variant + pooled Holm + baseline gate.

    split: the (folds, holdout, bound, split_token) tuple from
    holdout_split, threaded from selection — the final path validates
    evidence against THIS split (subset evidence + real split =
    rejection). sessions/proof: built by build_holdout_sessions from
    bars + token dates + data_id; this function REBUILDS from bars and
    demands equality, so mutated closes (either side) fail closed.
    bars: {symbol: [Bar]} frozen slice panels. data_id: {slice,
    dataset_sha} bound into the session proof. The bar is frozen_bar()
    (no caller bar). Sharpe uses close-to-close daily returns with a
    boundary-aware first interval (mid-session start excludes the
    partial stub; exact-close start includes the first full daily
    return). baseline: frozen baseline_v1 holdout artifact or None
    (S2 OPEN => None => gate reads ABSENT, promotion stays closed).
    R scope from frozen prereg."""
    folds, holdout, bound, token = split
    _validate_evidence(split, recs_1x, recs_stress)
    scope = frozen_scope()
    bar = frozen_bar()
    knobs = frozen_knobs()
    assert not check_knobs(), "implementation drifted from prereg knobs"
    rsess, rproof = build_holdout_sessions(bars, token, data_id)
    assert sessions == rsess, "sessions != canonical rebuild from bars"
    assert proof == rproof, "session proof != canonical rebuild"
    first_day = token["dates"][0]
    include_first = bound <= et_open_ns(first_day)
    if selected_variant is not None:
        assert selected_variant in VARIANTS
    pvals, rep = [], {"variants": {},
                      "selected_variant": selected_variant,
                      "split_token": token,
                      "session_proof": proof,
                      "first_interval_included": include_first,
                      "r_rules_checked": R_CHECKED,
                      "r_rules_unavailable": R_UNAVAILABLE,
                      "r_scope_note": R_SCOPE_NOTE}
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
        srets_f = daily_returns(rets_f, include_first)
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
            srets_f = daily_returns(srets_f0, include_first)
            srets_a = daily_returns(srets_a0, include_first)
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
    rep["knobs"] = knobs
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
        chall = {"1x": v["sharpe_f"], "dd_1x": v["max_dd_pct"]}
        for mult, (f, _a) in v["stress"].items():
            chall[mult] = f
        bv, bf, bd = baseline_gate(chall, baseline, proof, token)
        v["baseline_gate"] = {"verdict": bv, "failed": bf,
                              "detail": bd}
        v["promotion_ready"] = bool(verdict and bv)
    return rep
