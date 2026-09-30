"""S5 FINAL path: holdout materialization + holdout verdict.

Kept apart from s5_eval so selection code has no holdout API (asserted: no
attribute containing 'holdout' there). The holdout is materialized here only
after selection freezes, and its results never feed back into
select_variant(). The split token's variant is re-verified from the full
streams (_validate_evidence 0c); a caller-supplied selected_variant may only
echo the token-bound selection. Research/shadow-only.
"""

import hashlib as _hashlib
import json as _json
import math as _math
import os as _os
import sys as _sys

from .s5_eval import (BOOT_REPS, BOOT_SEED, EVAL_PROTOCOL, HOLM_ALPHA,
                      POWER_INNER, POWER_REPS, POWER_SEED, R_CHECKED,
                      R_SCOPE_NOTE, R_UNAVAILABLE, REQUIRED_STRESS,
                      SEQ_ALPHA_FINAL, SEQ_ALPHA_INTERIM, VARIANTS,
                      canon_num, cluster_bootstrap_ci, cluster_null_p,
                      daily_returns, et_close_ns, et_open_ns, eval_hash,
                      evaluate_bar, holm, last_close_at_or_before,
                      paired_deltas, portfolio_curve, segment_bounds,
                      select_variant, sequential_inputs, seq_pair, sharpe_hac, utc_day,
                      verify_r_monitor, walk_folds)

STRESS_MULT = {"1x": 1.0, "1.5x": 1.5, "2x": 2.0, "3x": 3.0}
# Fields that may differ between a 1x record and its stress twin (same CID +
# variant): resolution/economics only; everything else must be identical.
STRESS_MUTABLE = frozenset(("spread_mult", "exit_spread_bps",
                             "entry_fill", "exit_fill", "exit_ts_ns",
                             "resolved_r", "always_r", "always_label",
                             "always_realized", "filtered_r",
                             "filtered_taken", "r_breach_attempted",
                             "eval_hash"))
# Fields that may differ between the split variant's 1x record and another
# variant's 1x twin (same CID + spread): decision-derived only.
VARIANT_MUTABLE = frozenset(("variant", "filtered_pass",
                              "filtered_action", "filtered_reason",
                              "filtered_r", "filtered_taken",
                              "r_breach_attempted", "eval_hash"))


def _prereg():
    here = _os.path.join(_os.path.dirname(__file__), "s5_prereg.json")
    with open(here) as fh:
        return _json.load(fh)


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


def frozen_n_splits():
    """The authoritative segmentation contract, from prereg ONLY.

    The final path re-derives the canonical split with this n_splits
    and rejects any token/split built under another segmentation."""
    return _prereg()["holdout"]["n_splits"]


def _canonical_split_ids(full_stream, n_splits):
    """Canonical terminal segmentation derived from authority.

    Same construction as holdout_split (segment_bounds + walk_folds +
    terminal slice), reduced to identities: (edges, bound,
    [(train_cids, test_cids)...], holdout_cids). The caller-threaded
    split must match this structurally; content is bound separately
    by record digests."""
    edges, bound = segment_bounds(full_stream, n_splits)
    folds = walk_folds(full_stream, n_splits, holdout_start=bound)
    recs = sorted(full_stream, key=lambda r: r["snapshot_ts_ns"])
    hs = [r["cid"] for r in recs[edges[n_splits + 1]:]]
    assert hs, "empty canonical holdout"
    fc = [([r["cid"] for r in tr], [r["cid"] for r in te])
          for tr, te in folds]
    return edges, bound, fc, hs


def frozen_scope():
    """The frozen amendment_b out-of-scope declaration, read from the
    committed prereg file. The final path trusts NO caller-supplied list."""
    here = _os.path.join(_os.path.dirname(__file__), "s5_prereg.json")
    with open(here) as fh:
        return sorted(_json.load(fh)["amendment_b"]["r_out_of_scope"])


def _record_digest(recs):
    """Canonical digest of exact evaluation records.

    SHA256 over sorted per-record eval_hash values. ANY field mutation
    (day, snapshot/exit ts, R, labels, fills, ...) changes the digest,
    so record CONTENT is bound, not just the CID set."""
    return _hashlib.sha256("|".join(sorted(r["eval_hash"]
                                            for r in recs)).encode()
                           ).hexdigest()


def _mint_split_token(holdout, bound, n_splits, stream_n, edges,
                      stream_cid_hash, stream_record_hash):
    """Authoritative split token. Mint point is holdout_split() ONLY.

    Binds holdout_start + count + CID hash + RECORD-CONTENT digest +
    dates + split variant + protocol + segmentation descriptor +
    COMPLETE-STREAM identity (stream_cid_hash over every stream CID,
    stream_record_hash over every stream record). A different valid
    stream mints a different root: its token cannot validate against
    the pinned expected root. The final path recomputes every field
    from the threaded split tuple + full streams; a subset (or any
    caller) minting its own token cannot reproduce the real split's
    digests."""
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
            "edges": list(edges),
            "stream_cid_hash": stream_cid_hash,
            "stream_record_hash": stream_record_hash}


def holdout_split(records, n_splits=None):
    """Runner-side constructor of the threaded split echo: (folds,
    holdout, holdout_start, split_token).

    The segmentation is the FROZEN contract, not a caller choice: an
    omitted n_splits resolves to frozen_n_splits() and any other
    value fails closed HERE (the old default 3 was a misuse footgun).
    AUTHORITY stays with the final path's canonical re-derivation
    the final path's canonical re-derivation (_canonical_split_ids +
    step 0d): a caller split must match it structurally. Folds are
    label-purged at the holdout boundary: every selection record
    resolves strictly before holdout_start. Asserts the preferred
    invariant plus segment disjointness. Thread the returned tuple
    into final_report; never re-mint, never substitute a subset."""
    if n_splits is None:
        n_splits = frozen_n_splits()
    assert n_splits == frozen_n_splits(), \
        "split segmentation != frozen n_splits"
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
    scids = sorted(r["cid"] for r in recs)
    stream_cid_hash = _hashlib.sha256("|".join(scids).encode()
                                       ).hexdigest()
    stream_record_hash = _record_digest(recs)
    token = _mint_split_token(holdout, bound, n_splits, len(recs),
                              edges, stream_cid_hash,
                              stream_record_hash)
    return folds, holdout, bound, token


def pinned_slice_root():
    """Production expected root: the prereg-pinned S2 slice pin.

    Measured once over the frozen slice and code, pinned in s5_prereg.json
    experiments; drift fails closed in final_report. Carries the production
    bars_digest, which the bars consumed must hash to. Test fixtures use
    stream_roots instead."""
    return dict(_prereg()["experiments"]["s2_slice_stream_root"])


def _running_python_minor():
    return "%d.%d" % (_sys.version_info[0],
                        _sys.version_info[1])


def _check_pin_interpreter(pin):
    """The production pin reproduces ONLY under its measuring
    interpreter (major.minor). Python 3.12 changed sum() to Neumaier
    compensated summation: upstream frozen floats (backtest fhash via
    baseline_v1.zscore20) differ in the last ulp across the 3.11/3.12
    boundary, so record digests cannot match under a different minor.
    Fail closed with both versions named - never misreport an
    interpreter drift as evidence tampering."""
    want = pin["measured_python_minor"]
    got = _running_python_minor()
    assert got == want, \
        "production pin measured under %s, running %s" % (want, got)


def _production_pin():
    """The pinned production root (single parsed source for identity).

    Production data identity == this pin's data_slice + dataset_sha.
    Production inputs MUST present this root EXACTLY (dict equality);
    a caller cannot substitute a self-minted root under the
    production identity."""
    return pinned_slice_root()


def _is_production_identity(data_id):
    pin = _production_pin()
    return (data_id.get("slice") == pin["data_slice"]
            and data_id.get("dataset_sha") == pin["dataset_sha"])


def stream_roots(full_streams, data_id):
    """Expected-root shape for final_report (TEST-FIXTURE mint).

    Derives the root structure from the given streams and marks it
    test_fixture=True; production uses the root pinned in s5_prereg.json.
    final_report requires bars_proof=None under a fixture root, so fixture
    data cannot pass as production S2 evidence."""
    assert set(full_streams) == set(VARIANTS)
    triples, slices, shas, pers, n = set(), set(), set(), {}, None
    for v, recs in full_streams.items():
        assert recs, "empty stream %s" % v
        if n is None:
            n = len(recs)
        assert len(recs) == n, "variant streams must pair 1:1"
        for r in recs:
            _check_record_self(r)
            triples.add((r["model"], r["revision"], r["provider"]))
            slices.add(r["data_slice"])
            shas.add(r["dataset_sha"])
        pers[v] = _record_digest(recs)
    assert len(triples) == 1, triples
    assert slices == {data_id["slice"]}, slices
    assert shas == {data_id["dataset_sha"]}, shas
    cids = sorted(r["cid"] for r in full_streams[VARIANTS[0]])
    assert all(sorted(r["cid"] for r in recs) == cids
               for recs in full_streams.values())
    model, revision, provider = next(iter(triples))
    return {"data_slice": data_id["slice"],
            "dataset_sha": data_id["dataset_sha"],
            "protocol": EVAL_PROTOCOL, "stream_n": n,
            "stream_cid_hash": _hashlib.sha256("|".join(cids
                                                  ).encode()).hexdigest(),
            "per_variant": pers,
            "answers": {"model": model, "revision": revision,
                          "provider": provider},
            "test_fixture": True}


FROZEN_FILES = ("dataset_manifest.json", "universe_s2_v1.json",
                "AAPL_1h.jsonl", "MSFT_1h.jsonl")


def verify_frozen_files(raw_dir, frozen_dir, report_path):
    """File-level frozen provenance for the production S2 slice.

    Asserts: (a) sha256 over the frozen-dir files (sorted filenames,
    raw bytes) EQUALS the committed report's frozen_dataset_sha256
    (the S2 frozen identity — never invented here); (b) every frozen
    file is byte-identical in raw_dir (the bars are loaded from raw,
    so raw==frozen binds the loaded bytes to the frozen identity).
    Returns {"frozen_dataset_sha256": h}. Missing data fails closed
    (never a vacuous pass). Reads S2 files only; edits nothing."""
    with open(report_path) as fh:
        report = _json.load(fh)
    want = report["frozen_dataset_sha256"]
    h = _hashlib.sha256()
    for fn in sorted(_os.listdir(frozen_dir)):
        with open(_os.path.join(frozen_dir, fn), "rb") as fh:
            h.update(fh.read())
    got = h.hexdigest()
    assert got == want, "frozen data != committed report identity"
    for fn in FROZEN_FILES:
        with open(_os.path.join(raw_dir, fn), "rb") as fh:
            a = fh.read()
        with open(_os.path.join(frozen_dir, fn), "rb") as fh:
            b = fh.read()
        assert a == b, "raw != frozen copy: %s" % fn
    return {"frozen_dataset_sha256": got}


def digest_bars(bars):
    """Canonical digest of the LOADED Bar objects actually consumed.

    File verification binds bytes on disk; this binds the parsed
    objects (symbol, ts, OHLC, volume, spread via D6 canon_num),
    so an in-memory bar mutation after load still fails. Sorted
    symbols, ts-ordered bars."""
    parts = []
    for sym in sorted(bars):
        for b in sorted(bars[sym], key=lambda x: x.ts_ns):
            parts.append("%s|%d|%s|%s|%s|%s|%s|%s" %
                         (sym, b.ts_ns, canon_num(b.o),
                          canon_num(b.h), canon_num(b.l),
                          canon_num(b.c), canon_num(b.dollar_volume),
                          canon_num(b.spread_bps)))
    assert parts, "empty bar panel"
    return _hashlib.sha256("|".join(parts).encode()).hexdigest()


def build_holdout_sessions(bars, token, data_id):
    """Canonical session construction INSIDE the final path.

    bars: {symbol: [Bar]} (frozen slice panels, ts-sorted). Sessions are
    DERIVED here from bars + token dates + data_id — no caller-supplied
    price population exists, so forged closes (AAPL=1M) are
    unrepresentable. Marks are the last bar at-or-before each 16:00 ET
    close (after-hours never marks); end_ts == close_ns always (no
    seam). Missing marks fail closed.

    CAL7 calendar: sessions cover EVERY frozen-data session day from
    the first through the last holdout date — not just candidate days.
    A market session with no candidate record is still a session: it
    enters the curve (0.0 when the book is flat) and stays in Sharpe.
    Every candidate day must exist in the frozen bars, else fail.
    Returns (sessions, session_proof) with session_hash over (day,
    close_ns, sorted symbol=px, D6 canonical) + slice + full date
    sequence.
    """
    first, last = token["dates"][0], token["dates"][-1]
    bar_dates = sorted({utc_day(b.ts_ns) for bs in bars.values()
                        for b in bs})
    for d in token["dates"]:
        assert d in bar_dates, "candidate day %s has no frozen bars" % d
    cal = [d for d in bar_dates if first <= d <= last]
    assert cal and cal[0] == first and cal[-1] == last, \
        "calendar != holdout window"
    sessions = []
    for d in cal:
        close = et_close_ns(d)
        closes = {}
        for sym, bs in bars.items():
            closes[sym] = last_close_at_or_before(bs, close)
        assert all(v is not None for v in closes.values()), \
            "missing mark for %s" % d
        sessions.append({"day": d, "end_ts": close,
                         "close_ns": close, "closes": closes})
    body = ";".join("%s|%d|%s" % (s["day"], s["close_ns"], ",".join(
        "%s=%s" % (sym, canon_num(s["closes"][sym]))
        for sym in sorted(s["closes"]))) for s in sessions)
    proof = {"session_hash": _hashlib.sha256(body.encode()
                                               ).hexdigest(),
             "data_slice": data_id["slice"],
             "dataset_sha": data_id["dataset_sha"],
             "session_dates": [s["day"] for s in sessions],
             "n_sessions": len(sessions)}
    return sessions, proof


def _check_record_self(rec):
    """Per-record self-consistency: stored eval_hash must equal a fresh
    recomputation over the record's own fields. Detects in-place field
    edits even before set-level comparison."""
    assert rec.get("eval_hash") == eval_hash(rec), \
        "eval_hash mismatch (mutated record): %s" % rec.get("cid")


def _validate_evidence(split, recs_1x, recs_stress, full_streams,
                       root_expected, data_id, bars, bars_proof):
    """Full evidence chain against the threaded split tuple.

    split = (folds, holdout, bound, split_token) from holdout_split.
    0. complete-stream + experiment identity: every full-stream
       variant validates against the pinned/test root (count, shared
       CID hash, per-variant content digest, uniform answers triple,
       data slice/sha); token stream hashes must equal the expected
       root; the split-variant token root must equal that variant's
       pinned digest (a foreign valid stream + own valid token fails
       here). Bars authority: production roots (frozen hash present)
       REQUIRE a matching bars_proof (frozen identity + object digest
       recomputed from the supplied bars); fixture roots REQUIRE
       bars_proof=None (fixture data never poses as production).
    1. token recomputed from holdout (record digest, CID hash, n,
       dates, bound, segmentation) — tampered tokens fail.
    2. fold/holdout partition re-checked (disjoint, union == stream_n,
       purge invariants) — substituted splits fail.
    3. split-variant 1x set must digest-match the split holdout EXACTLY
       (record CONTENT equality) — subsets and mutated rows fail.
    4. other-variant 1x twins match field-wise (VARIANT_MUTABLE only).
    5. every stress record matches its same-variant 1x twin field-wise
       (STRESS_MUTABLE only) with the exact bucket spread_mult.
    6. holdout records ARE the split-variant full-stream records at
       the holdout CIDs (content digest) — the split cannot drift
       from the authoritative stream.
    Returns {cid: split-variant 1x record} (immutable reference map)."""
    folds, holdout, bound, token = split
    # Interpreter gate FIRST: under a foreign minor every downstream
    # digest comparison would misreport drift as tampering. Name both
    # versions before any hash is compared.
    if _is_production_identity(data_id):
        _check_pin_interpreter(_production_pin())
    assert set(recs_1x) == set(VARIANTS)
    assert set(recs_stress) == set(REQUIRED_STRESS), \
        "stress must carry exactly %s" % (REQUIRED_STRESS,)
    # 0. roots, streams, bars
    for k in ("data_slice", "dataset_sha", "protocol", "stream_n",
              "stream_cid_hash", "per_variant", "answers"):
        assert k in root_expected, "root missing %s" % k
    assert root_expected["data_slice"] == data_id["slice"]
    assert root_expected["dataset_sha"] == data_id["dataset_sha"]
    assert root_expected["protocol"] == EVAL_PROTOCOL
    assert token["protocol"] == EVAL_PROTOCOL
    assert token["stream_n"] == root_expected["stream_n"]
    assert token["stream_cid_hash"] == \
        root_expected["stream_cid_hash"]
    sv = token["split_variant"]
    assert sv in VARIANTS
    assert token["stream_record_hash"] == \
        root_expected["per_variant"][sv], "split stream != pinned root"
    assert set(full_streams) == set(VARIANTS)
    for variant, recs in full_streams.items():
        assert len(recs) == root_expected["stream_n"], variant
        fcids = sorted(r["cid"] for r in recs)
        assert _hashlib.sha256("|".join(fcids).encode()
                               ).hexdigest() == \
            root_expected["stream_cid_hash"], variant
        for r in recs:
            _check_record_self(r)
            assert r["data_slice"] == root_expected["data_slice"]
            assert r["dataset_sha"] == root_expected["dataset_sha"]
            assert (r["model"], r["revision"], r["provider"]) == \
                (root_expected["answers"]["model"],
                 root_expected["answers"]["revision"],
                 root_expected["answers"]["provider"]), variant
        assert _record_digest(recs) == \
            root_expected["per_variant"][variant], variant
    # 0b. root-kind authority: the data identity decides which root is
    # acceptable. The production identity must present the pinned root
    # exactly (dict equality), and the consumed bars must hash to the pinned
    # bars_digest, so regenerating a proof over mutated bars still fails.
    # Other identities must present a test_fixture root; a frozen-flavored
    # fixture runs the same bars checks against its own root digest, a plain
    # fixture carries no bars proof.
    pin = _production_pin()
    assert "bars_digest" in pin and "frozen_dataset_sha256" in pin, \
        "pinned root must carry the authoritative bars digest"
    assert "measured_python_minor" in pin, \
        "pinned root must name its measuring interpreter"
    if _is_production_identity(data_id):
        _check_pin_interpreter(pin)
        assert root_expected == pin, \
            "production inputs must use the pinned root exactly"
        assert bars_proof is not None, "production root needs bars proof"
        assert bars_proof["frozen_dataset_sha256"] == \
            pin["frozen_dataset_sha256"]
        assert bars_proof["bars_digest"] == pin["bars_digest"] == \
            digest_bars(bars), "bars != pinned production bars digest"
    elif root_expected.get("test_fixture") is True:
        if "frozen_dataset_sha256" in root_expected:
            assert bars_proof is not None, \
                "frozen-flavored fixture needs bars proof"
            assert bars_proof["frozen_dataset_sha256"] == \
                root_expected["frozen_dataset_sha256"]
            assert bars_proof["bars_digest"] == \
                root_expected["bars_digest"] == digest_bars(bars), \
                "bars != fixture root bars digest"
        else:
            assert bars_proof is None, \
                "fixture data must never carry production bars proof"
            assert "bars_digest" not in root_expected, \
                "plain fixture must not carry a bars digest"
    else:
        raise AssertionError(
            "ambiguous root: neither pinned production nor fixture")
    # 0c. selection binding: the token's variant must equal the fold
    # selection recomputed from the full streams with the frozen holdout
    # boundary. Sequential evidence follows only the verified selection.
    fold_stats = {}
    for variant in VARIANTS:
        _, _b = segment_bounds(full_streams[variant],
                               n_splits=token["n_splits"])
        assert _b == bound, "segmentation drifted from split bound"
        fold_stats[variant] = [
            sum(paired_deltas(te)) for _, te in
            walk_folds(full_streams[variant],
                       n_splits=token["n_splits"], holdout_start=_b)]
    assert select_variant(fold_stats) == token["split_variant"], \
        "token selection != mechanical fold selection"
    # 0d. canonical terminal split: bound, edges, fold CID structure and the
    # holdout CID population are derived here from the selected full stream
    # under the frozen segmentation. The threaded split is only an echo, so a
    # favorable-subset token, altered edges, other n_splits or a truncated
    # holdout fail even with authentic records. Fold records are checked by
    # self-hash and by field equality against the full-stream record.
    frozen_n = frozen_n_splits()
    assert token["n_splits"] == frozen_n, \
        "split segmentation != frozen n_splits"
    c_edges, c_bound, c_folds, c_holdout = _canonical_split_ids(
        full_streams[sv], frozen_n)
    assert bound == c_bound, "split bound != canonical bound"
    assert list(token["edges"]) == list(c_edges), \
        "split edges != canonical edges"
    assert sorted(r["cid"] for r in holdout) == sorted(c_holdout), \
        "split holdout != canonical holdout population"
    stream_recs = {r["cid"]: r for r in full_streams[sv]}
    assert len(folds) == len(c_folds), "fold count != canonical"
    for (tr, te), (ctr, cte) in zip(folds, c_folds):
        assert [r["cid"] for r in tr] == list(ctr), \
            "fold train != canonical structure"
        assert [r["cid"] for r in te] == list(cte), \
            "fold test != canonical structure"
        for r in tr + te:
            _check_record_self(r)
            assert r["cid"] in stream_recs, \
                "fold record outside authoritative stream"
            assert r == stream_recs[r["cid"]], \
                "fold record != authoritative stream record"
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
    # 6. holdout IS the split-variant full stream at the holdout CIDs
    hset = {r["cid"] for r in holdout}
    counterparts = [r for r in full_streams[sv] if r["cid"] in hset]
    assert len(counterparts) == len(holdout) == token["n"]
    assert _record_digest(counterparts) == token["record_hash"], \
        "split holdout != authoritative stream records"
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

# Baseline artifact identity. None until S2 is accepted: any non-None baseline
# under the production identity fails closed (baseline_gate reads ABSENT only
# for baseline=None). Pin the baseline artifact hash here on acceptance.
# Fixture identities exercise the gate under self-hash only.
BASELINE_EXPECTED = None


def _canon_baseline(v):
    if isinstance(v, bool):
        raise AssertionError("bool is not a baseline metric")
    if isinstance(v, (int, float)):
        return {"$num": canon_num(v)}
    if isinstance(v, (str, type(None))):
        return v
    if isinstance(v, list):
        return [_canon_baseline(x) for x in v]
    if isinstance(v, dict):
        return {k: _canon_baseline(v[k]) for k in sorted(v)}
    raise AssertionError("non-canonical baseline field: %r" % type(v))


def baseline_artifact_hash(baseline):
    """Canonical baseline artifact identity (D6 fixed-point metrics).

    SHA256 over the canonical artifact body - everything EXCEPT
    artifact_sha256 itself. NaN/inf/bool/unknown types fail closed,
    so fabricated metrics cannot hide behind float formatting."""
    body = {k: _canon_baseline(baseline[k]) for k in sorted(baseline)
            if k != "artifact_sha256"}
    return _hashlib.sha256(_json.dumps(body, sort_keys=True).encode()
                           ).hexdigest()


def _is_production_proof(proof):
    pin = _production_pin()
    return (proof.get("data_slice") == pin["data_slice"]
            and proof.get("dataset_sha") == pin["dataset_sha"])


def baseline_gate(chall, baseline, proof, token, baseline_expected=None):
    """Mechanical challenger-vs-baseline_v1 gate (docs 07/11/12).

    Authority contract (mirrors the frozen stream root): the artifact
    must carry artifact_sha256 == baseline_artifact_hash(artifact)
    (self-identity; fabricated metrics fail the digest). Under the
    PRODUCTION identity a pinned expected identity is ADDITIONALLY
    required - baseline_expected is None while S2 acceptance is OPEN,
    so any non-None production baseline fails closed as
    baseline_unpinned (never trusted, never promotion). Under fixture
    identities the self-hash gates the mechanics. Metrics must be
    finite real numbers (bool/NaN/inf fail closed as malformed).
    Beats requirements unchanged: challenger net Sharpe > baseline at
    ALL of 1x/1.5x/2x/3x with 1x drawdown not worse than baseline."""
    if baseline is None:
        return (False, ["baseline_absent"],
                {"status": "absent (S2 acceptance OPEN)"})
    failed, detail = [], {"status": "evaluated"}
    try:
        assert baseline["artifact_sha256"] == \
            baseline_artifact_hash(baseline), "artifact identity"
        if _is_production_proof(proof):
            assert baseline_expected is not None and \
                baseline["artifact_sha256"] == baseline_expected, \
                "unpinned production baseline artifact"
        assert baseline["baseline_id"] == "baseline_v1"
        assert baseline["protocol"] == EVAL_PROTOCOL
        assert baseline["data_slice"] == proof["data_slice"]
        assert baseline["dataset_sha"] == proof["dataset_sha"]
        assert baseline["session_hash"] == proof["session_hash"], \
            "session proof mismatch"
        assert sorted(baseline["dates"]) == \
            sorted(proof["session_dates"]), "session dates mismatch"
        bm = baseline["metrics"]
        assert set(bm) == set(BASELINE_MULTS)
        for m in BASELINE_MULTS:
            for k in ("sharpe_f", "max_dd_pct", "n_closed"):
                v = bm[m][k]
                assert isinstance(v, (int, float)) and \
                    not isinstance(v, bool), "non-numeric metric"
                assert isinstance(v, int) or _math.isfinite(v), \
                    "non-finite metric"
    except (KeyError, AssertionError, TypeError) as e:
        if isinstance(e, AssertionError) and "session" in str(e):
            return (False, ["baseline_session"],
                    {"status": "session-mismatch", "error": str(e)})
        if isinstance(e, AssertionError) and "unpinned" in str(e):
            return (False, ["baseline_unpinned"],
                    {"status": "unpinned-production", "error": str(e)})
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
                 data_id, equity, full_streams, root_expected,
                 bars_proof=None, baseline=None, selected_variant=None):
    """Holdout verdict per variant + pooled Holm + baseline gate.

    split: the (folds, holdout, bound, split_token) tuple from
    holdout_split, threaded from selection - an echo ONLY. The final
    path re-derives the canonical split (bound, edges, fold CID
    structure, exact holdout population) from the authoritative
    selected full stream under the frozen n_splits contract and
    demands structural equality (subset evidence + real split =
    rejection; self-consistent subset splits = rejection). sessions/proof: built by build_holdout_sessions from
    bars + token dates + data_id; this function REBUILDS from bars and
    demands equality, so mutated closes (either side) fail closed.
    bars: {symbol: [Bar]} frozen slice panels. data_id: {slice,
    dataset_sha} bound into the session proof. full_streams: the
    COMPLETE 1x evaluation streams per variant (pre-split universe);
    root_expected: the pinned/test expected root (production: prereg
    experiments pin incl. frozen_dataset_sha256; tests: stream_roots
    fixture). bars_proof: {frozen_dataset_sha256, bars_digest} from
    verify_frozen_files + digest_bars (production) or None (fixture).
    The bar is frozen_bar() (no caller bar). Sharpe uses close-to-close
    daily returns with a boundary-aware first interval (mid-session
    start excludes the partial stub; exact-close start includes the
    first full daily return). Sequential evidence is DERIVED HERE from
    the selected variant's full stream (pre-holdout closed only) with
    frozen knobs — no caller-computed sequential enters; holdout CIDs
    are structurally excluded and asserted absent. baseline: frozen
    baseline_v1 holdout artifact (artifact_sha256 self-identity +
    pinned expected identity under production) or None (S2 OPEN =>
    None => gate reads ABSENT, promotion stays closed). A caller
    selected_variant may only echo the token-bound selection.
    s5_gate_ready is ONLY (absolute S5 bar AND baseline gate) - NOT
    the full Plan-11 promotion gate (decision counts, calibration,
    AI-cost, search-budget, non-LLM baseline, human sign-off live
    outside S5). R scope from frozen prereg."""
    folds, holdout, bound, token = split
    _validate_evidence(split, recs_1x, recs_stress, full_streams,
                       root_expected, data_id, bars, bars_proof)
    scope = frozen_scope()
    bar = frozen_bar()
    knobs = frozen_knobs()
    assert not check_knobs(), "implementation drifted from prereg knobs"
    rsess, rproof = build_holdout_sessions(bars, token, data_id)
    assert sessions == rsess, "sessions != canonical rebuild from bars"
    assert proof == rproof, "session proof != canonical rebuild"
    first_day = token["dates"][0]
    include_first = bound <= et_open_ns(first_day)
    # Selection is token-bound and verified (0c): the caller may echo it,
    # never override it.
    if selected_variant is not None:
        assert selected_variant == token["split_variant"], \
            "caller selection != token-bound selection"
    sel = token["split_variant"]
    sd, sy, sc = sequential_inputs(full_streams[sel], bound)
    assert not (set(sc) & {r["cid"] for r in holdout}), \
        "holdout CID in sequential input"
    if sd:
        seq_i, seq_f = seq_pair(sd, sy, reps=knobs["seq_reps"],
                                seed=knobs["seq_seed"])
    else:
        seq_i, seq_f = ("no-evidence", 0.0, 1.0), \
            ("not_run", None, None)
    if selected_variant is not None:
        assert selected_variant in VARIANTS
    pvals, rep = [], {"variants": {},
                      "selected_variant": sel,
                      "split_token": token,
                      "session_proof": proof,
                      "first_interval_included": include_first,
                      "sequential": {"variant": sel,
                                     "n_closed": len(sd),
                                     "interim": seq_i,
                                     "final": seq_f},
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
        # keep the 1x primary vector before the stress loop, which must not
        # shadow it (sharpe_f/challenger-1x are 1x)
        srets_1x = daily_returns(rets_f, include_first)
        sharpe_1x = sharpe_hac(srets_1x)[0]
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
            srets_sf = daily_returns(srets_f0, include_first)
            srets_sa = daily_returns(srets_a0, include_first)
            stress[mult] = (sharpe_hac(srets_sf)[0],
                            sharpe_hac(srets_sa)[0])
        rep["variants"][variant] = {
            "paired_mean_R": mu, "ci95": [lo, hi], "null_p": p,
            "sharpe_f": sharpe_1x,
            "n_sharpe_obs": len(srets_1x),
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
        bv, bf, bd = baseline_gate(chall, baseline, proof, token,
                                   BASELINE_EXPECTED)
        v["baseline_gate"] = {"verdict": bv, "failed": bf,
                              "detail": bd}
        v["s5_gate_ready"] = bool(verdict and bv)
    return rep
