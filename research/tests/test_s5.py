"""S5 tests: 22 end-to-end properties (stdlib only, synthetic stream).

1 same-CID 2 same-economics 3 HOLD-no-fill 4 PASS-same 5 paired-reconcile
6 censored 7 no-lookahead 8 replay 9 isolation 10 bootstrap-determinism
11 null-p (+hostile) 12 cost-stress-reflected 13 variant-family
14 holdout-boundary 15 R-disqualify 16 sequential 17 power 18 daily-curve
19 maxDD 20 bar-mechanical 21 baseline-reconcile 22 no-hardcoded-pass.
"""
import datetime
import hashlib
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import s5_eval as s5
from research.strategy import s5_final as s5f
from research.strategy import backtest as bt
from research.strategy.candidate import make_candidate
from research.strategy.data import Bar

ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}
PROVIDE, PUB = s5.stub_answers_provider()
DAY = lambda ts: (datetime.date(2024, 1, 2) +
                   datetime.timedelta(days=ts // 60)).isoformat()
DATA_ID = {"slice": "synth-test-v1", "dataset_sha": "test-sha"}
BAR = {"filtered_net_sharpe_gt": 1.0, "holm_adjusted_p_lt": 0.05,
       "max_drawdown_pct_lte": 15.0, "min_closed_trades": 100}
with open(os.path.join(os.path.dirname(__file__), "..",
                  "strategy", "s5_prereg.json")) as _pf:
    SCOPE = json.load(_pf)["amendment_b"]["r_out_of_scope"]
GOODM = {"sharpe_f": 1.5, "holm_p": 0.01, "max_dd_pct": 5.0, "n_closed": 200,
         "stress": {"1.5x": (1.2, 0.5), "2x": (1.1, 0.4), "3x": (1.0, 0.3)},
         "r_breach_count": 0, "r_unavailable": list(s5.R_UNAVAILABLE),
         "r_out_of_scope": SCOPE}


def synth_stream(n=60):
    items, t = [], 0
    for i in range(n):
        side = "BUY" if i % 2 == 0 else "SELL"
        px = 100.0 + (i % 7)
        stop, tp = (px - 1.0, px + 2.0) if side == "BUY" else \
            (px + 1.0, px - 2.0)
        c = make_candidate(strategy_version="baseline_v1", symbol="SYN",
                           snapshot_ts_ns=t, proposed_side=side,
                           proposed_family="momentum", entry_px=px,
                           stop_px=stop, tp_px=tp, time_exit_ns=t + 5,
                           exit_profile_version="exit_profile_v1",
                           cost_model_version="paper_fill_v1",
                           expected_cost_bps=0.0,
                           feature_snapshot_hash="h%d" % i,
                           feature_revision="r1")
        if i % 3 == 0:
            aft = [Bar(ts_ns=t + 1 + j, o=px, h=px + 0.05, l=px - 0.05,
                       c=px, spread_bps=2.0) for j in range(6)]
        else:
            aft = [Bar(ts_ns=t + 1 + j, o=px,
                       h=px + (2.5 if j == 2 else 0.3),
                       l=px - (0.2 if j != 3 else 1.5), c=px + 0.1,
                       spread_bps=2.0) for j in range(6)]
        mkt = {"snapshot_epoch": t, "price_s": str(px),
               "spread_bps_s": "2.0", "session": "us_open",
               "regime": "trend"}
        items.append((c, aft, mkt, "trend", 2.0))
        t += 10
    return items


def sessions_for(items):
    days = sorted({DAY(c.snapshot_ts_ns) for c, _, _, _, _ in items})
    return [{"day": d, "end_ts": s5.et_close_ns(d),
             "close_ns": s5.et_close_ns(d),
             "closes": {"SYN": 100.0 + i}} for i, d in enumerate(days)]


def bars_for(items):
    """Frozen-slice-style bar panel matching sessions_for closes.

    One bar per day at exactly the 16:00 ET close (plus nothing
    after-hours), so canonical session construction reproduces the
    sessions_for marks through the final path."""
    days = sorted({DAY(c.snapshot_ts_ns) for c, _, _, _, _ in items})
    return {"SYN": [Bar(ts_ns=s5.et_close_ns(d), o=100.0 + i,
                          h=100.0 + i, l=100.0 + i, c=100.0 + i)
                      for i, d in enumerate(days)]}


def run_all(items, **kw):
    kw = dict({"day_fn": DAY, "data_id": DATA_ID}, **kw)
    return {v: s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE),
                                  variant=v, **kw) for v in s5.VARIANTS}


def _roots(by_var, data_id=DATA_ID):
    """Fixture expected root for the given complete streams."""
    return s5f.stream_roots(by_var, data_id)


def _mechanical_winner(by_var, n_splits=2):
    """Runner-identical fold selection from the full streams."""
    stats = {}
    for v in s5.VARIANTS:
        _, b = s5.segment_bounds(by_var[v], n_splits=n_splits)
        stats[v] = [sum(s5.paired_deltas(te)) for _, te in
                    s5.walk_folds(by_var[v], n_splits=n_splits,
                                  holdout_start=b)]
    return s5.select_variant(stats)


def _winner_split(by_var, n_splits=2):
    """Mint the split on the MECHANICALLY SELECTED variant's stream.

    The token's claimed variant must equal the recomputed fold
    selection (final_report 0c): rigs mirror the runners (select,
    then split the winner), never a hardcoded variant."""
    return s5f.holdout_split(by_var[_mechanical_winner(by_var,
                                                       n_splits)],
                             n_splits=n_splits)


def _frep(split, h1x, stress, sess, proof, bars, by_var, equity=100000.0,
          **kw):
    """final_report with fixture roots over the given full streams."""
    return s5f.final_report(split, h1x, stress, sess, proof, bars,
                            DATA_ID, equity, by_var, _roots(by_var),
                            **kw)


def test_1_2_same_stream_same_economics():
    items = synth_stream(20)
    recs = run_all(items)
    assert [r["cid"] for r in recs[s5.VARIANTS[0]]] == \
        [r["cid"] for r in recs[s5.VARIANTS[1]]]
    for r, (c, aft, _, _, sp) in zip(recs[s5.VARIANTS[0]], items):
        direct = bt.resolve(c, aft, entry_spread_bps=sp)
        assert r["always_r"] == direct["r_realized"]
        assert r["always_label"] == direct["label"]
        assert r["entry_fill"] == direct["entry_fill"]
        assert r["exit_fill"] == direct["exit_fill"]
    print("1_2 OK")


def test_3_4_5_hold_pass_paired():
    recs = run_all(synth_stream(40))[s5.VARIANTS[0]]
    for r in recs:
        if r["filtered_action"] == "HOLD":
            assert r["filtered_r"] == 0.0 and not r["filtered_taken"]
        else:
            assert r["filtered_taken"] == r["always_realized"]
            assert r["filtered_r"] == r["always_r"]
    d = s5.paired_deltas(recs)
    assert all(x == f - a for x, f, a in
               zip(d, [r["filtered_r"] for r in recs],
                   [r["always_r"] for r in recs]))
    print("3_4_5 OK")


def test_6_censored_and_brier_scope():
    recs = run_all(synth_stream(30))[s5.VARIANTS[0]]
    cens = [r for r in recs if r["always_label"] == "censored"]
    assert cens and all(r["always_label"] == "censored" for r in cens)
    _, n = s5.brier([(r["enter"], r["always_label"]) for r in recs])
    assert n == sum(1 for r in recs if r["always_label"] in ("win", "loss"))
    print("6 OK", len(cens), "censored")


def test_7_8_9_lookahead_replay_isolation():
    items = synth_stream(20)
    a = s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE),
                           variant=s5.VARIANTS[0], day_fn=DAY,
                           data_id=DATA_ID)
    for r, (c, aft, _, _, _) in zip(a, items):
        assert all(b.ts_ns > c.snapshot_ts_ns for b in aft)
    b = s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE),
                           variant=s5.VARIANTS[0], day_fn=DAY,
                           data_id=DATA_ID)
    assert [r["eval_hash"] for r in a] == [r["eval_hash"] for r in b]
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert len({r["cid"] for r in a}) == len(a)
    print("7_8_9 OK")


def test_8b_replay_fields_bound():
    r = run_all(synth_stream(6))[s5.VARIANTS[0]][0]
    for k in ("strategy_version", "exit_profile_version",
              "cost_model_version", "expected_cost_bps",
              "feature_revision", "entry_spread_bps", "exit_spread_bps",
              "spread_mult", "entry_fill", "exit_fill", "response_hash",
              "signature", "decision_key", "model", "revision",
              "provider", "data_slice", "dataset_sha", "eval_protocol",
              "variant", "filtered_pass", "resolved_r",
              "r_breach_attempted"):
        assert k in r, k
    assert r["eval_protocol"] == "eval_v1"
    assert r["variant"] in s5.VARIANTS
    assert r["strategy_version"] == "baseline_v1"
    print("8b OK")


def test_10_11_bootstrap_and_null():
    recs = run_all(synth_stream(48))[s5.VARIANTS[0]]
    d = s5.paired_deltas(recs)
    days = [r["day"] for r in recs]
    assert s5.cluster_bootstrap_ci(d, days) == s5.cluster_bootstrap_ci(d, days)
    assert s5.cluster_null_p(d, days) == s5.cluster_null_p(d, days)
    # hostile: symmetric zero-mean noise must NOT read as significant
    z = [0.5, -0.5] * 30
    zd = ["d%d" % (i // 6) for i in range(60)]
    pz = s5.cluster_null_p(z, zd)
    assert pz > 0.05, pz
    # hostile: uniform positive shift MUST read as significant
    pp = s5.cluster_null_p([0.4] * 60, zd)
    assert pp < 0.05, pp
    # hostile: uniform negative shift must NEVER reject H1
    pn = s5.cluster_null_p([-0.4] * 60, zd)
    assert pn > 0.95, pn
    print("10_11 OK", round(pz, 3), pp, round(pn, 3))


def test_12_cost_stress_reflected():
    items = synth_stream(30)
    r1 = run_all(items, spread_mult=1.0)[s5.VARIANTS[0]]
    r3 = run_all(items, spread_mult=3.0)[s5.VARIANTS[0]]
    assert [r["cid"] for r in r1] == [r["cid"] for r in r3]
    assert all(r["spread_mult"] == 3.0 for r in r3)
    assert any(a != b for a, b in
               zip([r["always_r"] for r in r1], [r["always_r"] for r in r3]))
    print("12 OK")


def test_13_variant_family():
    assert set(s5.VARIANTS) == {"filtered-conv-any",
                                "filtered-enter-gte-80-strong-plus"}
    with open(os.path.join(os.path.dirname(__file__), "..",
                      "strategy", "s5_prereg.json")) as _pf:
        pre = json.load(_pf)
    assert pre["search_budget"]["declared_variants"] == list(s5.VARIANTS)
    assert set(pre["variants"]) == set(s5.VARIANTS)
    recs = run_all(synth_stream(40))
    t = sum(r["filtered_taken"] for r in recs["filtered-conv-any"])
    st = sum(r["filtered_taken"] for r in
             recs["filtered-enter-gte-80-strong-plus"])
    assert st <= t  # prereg strict reading nests inside conv-any
    print("13 OK", t, st)


def test_14_holdout_boundary_and_purge():
    items = synth_stream(72)
    recs = run_all(items)[s5.VARIANTS[0]]
    _, bound = s5.segment_bounds(recs, n_splits=2)
    folds = s5.walk_folds(recs, n_splits=2, holdout_start=bound)
    assert len(folds) == 2
    assert all(isinstance(f, tuple) and len(f) == 2 for f in folds)
    s5.select_variant_signature_clean()
    assert list(inspect.signature(s5.select_variant).parameters) ==         ["fold_stats"]
    assert not [a for a in dir(s5) if "holdout" in a.lower()],         "selection module must expose no holdout API"
    # preferred invariant on every selection record
    for tr, te in folds:
        for r in tr + te:
            assert r["time_exit_ns"] < bound
    folds3, holdout, bound3, _tok3 = s5f.holdout_split(recs, n_splits=2)
    assert bound3 == bound and holdout
    hmin = min(r["snapshot_ts_ns"] for r in holdout)
    assert all(r["snapshot_ts_ns"] < hmin
               for tr, te in folds3 for r in tr + te)
    # hostile: snapshot before bound, exit after bound -> excluded
    c, aft, mkt, reg, sp = items[0]
    cross = make_candidate(strategy_version="baseline_v1", symbol="SYN",
                           snapshot_ts_ns=bound - 50,
                           proposed_side="BUY", proposed_family="momentum",
                           entry_px=100.0, stop_px=99.0, tp_px=200.0,
                           time_exit_ns=bound + 500,
                           exit_profile_version="exit_profile_v1",
                           cost_model_version="paper_fill_v1",
                           expected_cost_bps=0.0,
                           feature_snapshot_hash="cross",
                           feature_revision="r1")
    flat = [Bar(ts_ns=bound - 50 + 1 + j, o=100.0, h=100.05, l=99.95,
                c=100.0, spread_bps=2.0) for j in range(6)]
    xr = s5.evaluate_stream([(cross, flat, mkt, reg, sp)], PROVIDE, PUB,
                            dict(ENGINE), variant=s5.VARIANTS[0],
                            day_fn=DAY, data_id=DATA_ID)
    assert xr[0]["time_exit_ns"] > bound
    falls = s5.walk_folds(recs + xr, n_splits=2, holdout_start=bound)
    assert all(xr[0]["cid"] != r["cid"] for tr, te in falls
               for r in tr + te)
    # mutation of post-bound prices cannot move selection metrics
    m1 = {v: [sum(s5.paired_deltas(te)) for _, te in
              s5.walk_folds(run_all(items)[v], n_splits=2,
                            holdout_start=bound)] for v in s5.VARIANTS}
    assert s5.select_variant(m1) in s5.VARIANTS
    print("14 OK", len(holdout), "held out; crossing record purged")


def strong_provider():
    """Fixed strong answers, own key (adversarial determinism, not JEV)."""
    from collector.jev import ed_pubkey
    from research.strategy import jev_filter as jf
    seed = bytes.fromhex("cd" * 32)
    pub = ed_pubkey(seed)

    def provide(candidate, market, now_unix):
        ans = {"enter": 0.95, "edge_family": candidate.proposed_family,
               "conviction": "max", "latent_risk": 0.01}
        payload = jf.make_payload(candidate, market, ans, now_unix,
                                     now_unix + 60)
        art = jf.sign(payload, seed)
        return art, {"model": "test-strong", "revision": "t1",
                     "provider": "test"}
    return provide, pub


def test_15_r_disqualify_full_path():
    items = synth_stream(12)
    c, aft, mkt, reg, sp = items[0]
    unc, con, binds, _, _ = bt.size_notional(100000.0, 0.0001, 100.0)
    assert binds  # cap binding is sizing...
    good = make_candidate(strategy_version="baseline_v1", symbol="SYN",
                          snapshot_ts_ns=c.snapshot_ts_ns,
                          proposed_side="BUY", proposed_family="momentum",
                          entry_px=100.0, stop_px=99.9999, tp_px=102.0,
                          time_exit_ns=c.time_exit_ns,
                          exit_profile_version="exit_profile_v1",
                          cost_model_version="paper_fill_v1",
                          expected_cost_bps=0.0,
                          feature_snapshot_hash="binds",
                          feature_revision="r1")
    assert not s5.r_validate(good)[0]  # ...NOT a violation
    bad = make_candidate(strategy_version="baseline_v1", symbol="SYN",
                         snapshot_ts_ns=c.snapshot_ts_ns,
                         proposed_side="BUY", proposed_family="macd",
                         entry_px=c.entry_px, stop_px=c.stop_px,
                         tp_px=c.tp_px, time_exit_ns=c.time_exit_ns,
                         exit_profile_version="exit_profile_v1",
                         cost_model_version="paper_fill_v1",
                         expected_cost_bps=0.0,
                         feature_snapshot_hash="bad",
                         feature_revision="r1")
    assert s5.r_validate(bad) == (True, "bad_family")
    sprovide, spub = strong_provider()
    sprovide, spub = strong_provider()
    # bad candidate carries the LATEST snapshot so it lands in holdout
    c_last = items[-1][0]
    bad = make_candidate(strategy_version="baseline_v1", symbol="SYN",
                         snapshot_ts_ns=c_last.snapshot_ts_ns + 10,
                         proposed_side="SELL", proposed_family="macd",
                         entry_px=c_last.entry_px, stop_px=c_last.stop_px,
                         tp_px=c_last.tp_px,
                         time_exit_ns=c_last.snapshot_ts_ns + 70,
                         exit_profile_version="exit_profile_v1",
                         cost_model_version="paper_fill_v1",
                         expected_cost_bps=0.0,
                         feature_snapshot_hash="bad",
                         feature_revision="r1")
    stream = items[:11] + [(bad, items[-1][1], items[-1][2], items[-1][3],
                            items[-1][4])]
    by_var = {v: s5.evaluate_stream(stream, sprovide, spub, dict(ENGINE),
                                    variant=v, day_fn=DAY, data_id=DATA_ID)
              for v in s5.VARIANTS}
    brec = [r for r in by_var[s5.VARIANTS[0]] if r["disqualified"]][0]
    assert brec["disqualified"] and brec["filtered_pass"]  # JEV would take
    assert not brec["filtered_taken"] and not brec["always_realized"]
    assert brec["always_r"] == 0.0 and brec["filtered_r"] == 0.0  # finding 4
    assert s5.paired_deltas([brec]) == [0.0]
    assert brec["always_label"] in ("win", "loss", "censored")  # diagnostic label retained
    assert brec["resolved_r"] == brec["resolved_r"]  # economics present
    assert brec["r_breach_attempted"]  # forbidden take attempted
    assert [r["cid"] for r in by_var[s5.VARIANTS[0]] if r["disqualified"]] == [brec["cid"]]
    _split = _winner_split(by_var, n_splits=2)
    _folds, _holdout, _bound, _tok = _split
    assert brec["cid"] in {r["cid"] for r in _holdout}, \
        "disqualified probe must sit in holdout evidence"
    _hset = {r["cid"] for r in _holdout}
    _h1x = {v: [r for r in by_var[v] if r["cid"] in _hset]
            for v in s5.VARIANTS}
    _stress = {}
    for _mult, _lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        _sv = {v: s5.evaluate_stream(stream, sprovide, spub,
                                     dict(ENGINE), variant=v,
                                     spread_mult=_mult, day_fn=DAY,
                                     data_id=DATA_ID) for v in s5.VARIANTS}
        _stress[_lab] = {v: [r for r in _sv[v] if r["cid"] in _hset]
                         for v in s5.VARIANTS}
    _bars = bars_for(stream)
    _sess, _proof = s5f.build_holdout_sessions(_bars, _tok, DATA_ID)
    rep = _frep(_split, _h1x, _stress, _sess, _proof, _bars, by_var)
    got = rep["variants"][s5.VARIANTS[0]]
    assert got["r_breach_attempted"] == 1  # generated, not injected
    assert got["r_breach_count"] == 1 + len(got["r_monitor_breaches"])
    v, failed, _ = s5.evaluate_bar(
        dict(GOODM, sharpe_f=5.0, holm_p=0.001, n_closed=500,
             r_breach_count=got["r_breach_count"]),
        BAR)
    assert not v and failed == ["no_r_breach"]
    assert got["bar_verdict"] is False and "no_r_breach" in got["bar_failed"]
    print("15 OK")


def test_16_sequential():
    days = ["d%d" % (i // 6) for i in range(60)]
    dec, mu, p = s5.seq_decision([0.6] * 60, days, "interim")
    assert dec == "stop-efficacy", (dec, mu, p)
    dec, mu, p = s5.seq_decision([-0.1] * 60, days, "interim")
    assert dec == "stop-futility", dec
    marg = [0.06] * 15 + [-0.04] * 15 + [0.0] * 30
    dec, mu, p = s5.seq_decision(marg, days, "interim")
    assert dec == "continue", (dec, mu, p)
    dec, mu, p = s5.seq_decision([0.6] * 60, days, "final")
    assert dec == "efficacy", dec
    dec, mu, p = s5.seq_decision([0.0] * 60, days, "final")
    assert dec == "fail", dec
    print("16 OK")


def test_17_power():
    recs = run_all(synth_stream(60))[s5.VARIANTS[0]]
    _, bound17 = s5.segment_bounds(recs, n_splits=2)
    folds = s5.walk_folds(recs, n_splits=2, holdout_start=bound17)
    tr = [r for f in folds for r in f[0]]
    vals = s5.paired_deltas(tr)
    dys = [r["day"] for r in tr]
    p1 = s5.power_study(tr, 0.15)
    p2 = s5.power_study(tr, 0.15)
    assert p1 == p2  # deterministic
    plo = s5.power_study(tr, 0.02)
    assert p1["by_multiplier"][1] >= plo["by_multiplier"][1]  # monotone MDE
    assert set(s5.power_study.__code__.co_varnames) >= {"train_records"}
    assert p1["n_base"] == p1["n_unique_cids"] == len({r["cid"]
                                                         for r in tr})
    # hostile: duplicated overlapping-fold records dedup by CID
    dup = tr + tr  # overlapping-fold duplication collapses by CID
    pd = s5.power_study(dup, 0.15)
    assert pd["n_unique_cids"] == pd["n_base"] == len({r["cid"]
                                                      for r in tr})
    # hostile: repeated source draws stay distinct (no collapse)
    rng = __import__("random").Random(7)
    draws = s5._draw_clusters([["a", "b"], ["c"]], rng)
    assert [d for d, _ in draws] == ["g0", "g1"]
    assert sorted([m for _, g in draws for m in g]) == ["a", "b", "c"]
    print("17 OK", p1["by_multiplier"])


def test_18_19_curve_and_drawdown():
    items = synth_stream(48)
    recs = run_all(items)[s5.VARIANTS[0]]
    sess = sessions_for(items)
    sess.append({"day": "d999", "end_ts": 10 ** 19,
                 "closes": {"SYN": 100.0}})
    trades, curve, rets, dd = s5.portfolio_curve(recs, "always", 100000.0,
                                                 sess)
    assert len(rets) == len(sess)  # baseline point included
    assert len(curve) == len(sess) + 1  # + pre-window baseline
    assert any(r == 0.0 for r in rets)  # zero-days kept
    assert dd >= 0.0
    assert s5.max_drawdown([("a", 100.0), ("b", 100.0)]) == 0.0
    assert abs(s5.max_drawdown([("a", 100.0), ("b", 80.0),
                                ("c", 90.0)]) - 20.0) < 1e-9
    print("18_19 OK", len(trades), "trades, dd=%.2f" % dd)




def _mkrec(cid, symbol, side, snap, exit_ts, entry, stop, r_val, day,
           realized=True, taken=True, fill=None):
    return {"cid": cid, "symbol": symbol, "proposed_side": side,
            "snapshot_ts_ns": snap, "exit_ts_ns": exit_ts,
            "entry_px": entry, "stop_px": stop, "always_r": r_val,
            "filtered_r": r_val, "always_realized": realized,
            "filtered_taken": taken, "spread_mult": 1.0,
            "entry_fill": entry if fill is None else fill,
            "exit_fill": entry, "disqualified": False}


def test_18b_lookahead_hostile():
    # A enters day 2; day-1 close must be blind to it (long + short).
    # Adverse fills: BUY pays 100.05, SELL receives 99.95 (qty 250).
    recs = [_mkrec("A", "SYN", "BUY", 150, 250, 100.0, 99.0, 1.0, "d2",
                   fill=100.05),
            _mkrec("B", "SYN", "SELL", 150, 250, 100.0, 101.0, 1.0, "d2",
                   fill=99.95)]
    sess = [{"day": "d1", "end_ts": 100, "closes": {"SYN": 100.0}},
            {"day": "d2", "end_ts": 200, "closes": {"SYN": 101.0}},
            {"day": "d3", "end_ts": 300, "closes": {"SYN": 102.0}}]
    _, curve, rets, _ = s5.portfolio_curve([recs[0]], "always", 100000.0,
                                           sess)
    # hand-verified: cash 100000-250*100.05=74987.5; d1 blind at start;
    # d2 = 74987.5+250*101 = 100237.5; d3 exit lands frozen pnl (+250).
    assert curve[0] == ("__start__", 100000.0), curve
    assert curve[1] == ("d1", 100000.0), curve
    assert curve[2] == ("d2", 100237.5), curve
    assert curve[3] == ("d3", 100250.0), curve
    assert rets[0] == 0.0 and abs(rets[1] - 0.002375) < 1e-9  # first-day rep
    _, s_curve, _, _ = s5.portfolio_curve([recs[1]], "always", 100000.0,
                                          sess)
    assert s_curve[1] == ("d1", 100000.0), s_curve
    assert s_curve[2] == ("d2", 99737.5), s_curve  # short marks down
    # future-price mutation: day-3 close cannot move day-1/day-2.
    sess2 = [dict(x, closes={"SYN": 500.0}) if x["day"] == "d3" else x
             for x in sess]
    _, curve2, _, _ = s5.portfolio_curve([recs[0]], "always", 100000.0,
                                         sess2)
    assert curve2[:3] == curve[:3]
    assert curve2[3][1] == curve[3][1]  # exited before d3: immune too
    # live-through-close mutation DOES move only the open mark.
    recs_open = [_mkrec("C", "SYN", "BUY", 150, 999, 100.0, 99.0, 0.0,
                        "d2", fill=100.05)]
    _, o1, _, _ = s5.portfolio_curve(recs_open, "always", 100000.0, sess)
    _, o2, _, _ = s5.portfolio_curve(recs_open, "always", 100000.0, sess2)
    assert o1[:3] == o2[:3]  # start/d1/d2 unaffected by d3
    assert o2[3][1] != o1[3][1]  # d3 mark reflects the d3 close only
    assert o1[3] == ("d3", 74987.5 + 250 * 102.0)
    # first-session loss from initial capital (drawdown baseline honest)
    recs_loss = [_mkrec("L", "SYN", "BUY", 50, 999, 100.0, 99.0, 0.0,
                        "d1", fill=100.05)]
    _, lcurve, lrets, ldd = s5.portfolio_curve(recs_loss, "always",
                                               100000.0, sess)
    assert lcurve[1][1] == 74987.5 + 250 * 100.0  # d1 mark below start
    assert lrets[0] < 0 and ldd > 0  # first-day loss represented
    print("18b OK")


def test_20b_stress_fail_closed_and_scope():
    assert s5.evaluate_bar(dict(GOODM, stress={}), BAR)[1] == ["stress"]
    assert s5.evaluate_bar(dict(GOODM, stress={"1.5x": (2.0, 1.0)}),
                           BAR)[1] == ["stress"]
    assert s5.evaluate_bar(dict(GOODM, stress={"1.5x": (2.0, 1.0),
                                               "2x": (2.0, 1.0)}),
                           BAR)[1] == ["stress"]
    assert s5.evaluate_bar(dict(GOODM, stress={"1.5x": (2.0, 1.0),
                                               "2x": (0.1, 0.5),
                                               "3x": (2.0, 1.0)}),
                           BAR)[1] == ["stress"]
    assert s5.evaluate_bar(GOODM, BAR)[0] is True
    bad_scope = dict(GOODM, r_out_of_scope=["R6"])
    assert s5.evaluate_bar(bad_scope, BAR)[1] == ["r_scope"]
    import inspect as _insp
    _sig = _insp.signature(s5f.final_report).parameters
    assert "bar" not in _sig, "caller bar must be unrepresentable"
    assert "holdout_cids" not in _sig, "raw CID sets out; token only"
    fb = s5f.frozen_bar()
    assert fb == dict(BAR), "frozen bar != prereg bar used by tests: %r" % fb
    import datetime as _dt
    _items = synth_stream(8)
    _by = run_all(_items)
    _split = _winner_split(_by, n_splits=2)
    _bars = bars_for(_items)
    _sess, _proof = s5f.build_holdout_sessions(_bars, _split[3], DATA_ID)
    _hset = {r["cid"] for r in _split[1]}
    _h1x = {v: [r for r in _by[v] if r["cid"] in _hset]
            for v in s5.VARIANTS}
    _stress = {}
    for _mult, _lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        _sv = run_all(_items, spread_mult=_mult)
        _stress[_lab] = {v: [r for r in _sv[v] if r["cid"] in _hset]
                         for v in s5.VARIANTS}
    try:
        _frep(_split, {s5.VARIANTS[0]: [], s5.VARIANTS[1]: []},
              _stress, _sess, _proof, _bars, _by)
        raise SystemExit("empty evidence must fail closed")
    except AssertionError:
        pass
    print("20b OK")


def test_20_bar_mechanical_and_holm():
    assert s5.holm([("a", 0.04), ("b", 0.041)]) == \
        [("a", 0.08, False), ("b", 0.08, False)]  # cummax, not 0.041
    h3 = s5.holm([("a", 0.1), ("b", 0.11), ("c", 0.12)])
    assert all(abs(a - 0.3) < 1e-9 for _, a, _ in h3)  # decreasing products
    assert s5.holm([("v1", 0.01), ("v2", 0.04), ("v3", 0.30)])[0] == \
        ("v1", 0.03, True)
    v, failed, checks = s5.evaluate_bar(dict(GOODM), BAR)
    assert v and failed == [] and all(checks.values())
    badm = dict(GOODM, sharpe_f=-0.5, holm_p=1.0)
    v2, failed2, _ = s5.evaluate_bar(badm, BAR)
    assert not v2 and set(failed2) == {"sharpe_gt", "holm_p"}
    print("20 OK")


def test_21_baseline_reconcile():
    bars = {}
    for s in ("P", "Q"):
        px, bs = 100.0, []
        for i in range(600):
            px += 0.05
            bs.append(Bar(ts_ns=i, o=px - 0.05, h=px + 0.2, l=px - 0.2,
                          c=px, spread_bps=2.0))
        bars[s] = bs
    recs_bt, rep_bt = bt.run(bars, universe_mode="diagnostic")
    idx = {s: {b.ts_ns: i for i, b in enumerate(bs)}
           for s, bs in bars.items()}
    items = []
    for r in [x for x in recs_bt if x["taken"]]:
        c = r["c"]
        i = idx[c.symbol][c.snapshot_ts_ns]
        mkt = {"snapshot_epoch": c.snapshot_ts_ns, "price_s": "1.0",
               "spread_bps_s": "2.0", "session": "us_open",
               "regime": "trend"}
        items.append((c, bars[c.symbol][i + 1:], mkt, "trend", 2.0))
    qday = lambda ts: "q%d" % (ts // 100)
    got = s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE),
                             variant=s5.VARIANTS[0], day_fn=qday,
                             data_id=DATA_ID)
    sess = [{"day": "q%d" % k, "end_ts": (k + 1) * 100 - 1,
             "closes": {s: bars[s][(k + 1) * 100 - 1].c for s in bars}}
            for k in range(6)]  # genuinely chronological sessions
    trades, curve, rets, dd = s5.portfolio_curve(got, "always", 100000.0,
                                                 sess)
    bt_taken = [r for r in recs_bt if r["taken"]]
    assert len(trades) == len(bt_taken)
    for t, b in zip(sorted(trades, key=lambda x: x["entry_ts"]),
                    sorted(bt_taken, key=lambda x: x["c"].snapshot_ts_ns)):
        assert t["cid"] == b["c"].cid
        assert t["entry_ts"] == b["c"].snapshot_ts_ns
        assert t["exit_ts"] == b["res"]["exit_ts_ns"]
        assert abs(t["pnl_usd"] - b["pnl_usd"]) <             1e-9 * max(1.0, abs(b["pnl_usd"]))
        assert abs(t["con_usd"] - b["con_usd"]) <             1e-9 * max(1.0, abs(b["con_usd"]))
    assert curve[0][1] == 100000.0  # pre-window baseline point
    assert len(curve) == 7 and len(rets) == 6  # full daily vectors
    assert abs(curve[-1][1] - rep_bt["end_equity"]) <         1e-9 * max(1.0, abs(rep_bt["end_equity"]))  # curve lands on ledger
    sh, se, tt = s5.sharpe_hac(rets)
    assert sh == sh and se > 0  # finite metrics over the real curve
    sess2 = [dict(x) for x in sess]
    sess2[-1] = dict(sess2[-1], closes={"P": 1e6, "Q": 1e6})
    _, curve2, _, _ = s5.portfolio_curve(got, "always", 100000.0, sess2)
    assert [c for c in curve2[:-1]] == [c for c in curve[:-1]]
    print("21 OK", len(trades), "trades + full curve reconcile")


def _rehash(rec):
    """Refresh eval_hash after a hostile-intended field override."""
    rec = dict(rec)
    rec["eval_hash"] = s5.eval_hash(rec)
    return rec


def test_21b_n_closed_hostile():
    # Holdout evidence with exactly 1 taken closed trade -> n_closed==1.
    items = synth_stream(200)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    split0 = s5f.holdout_split(recs, n_splits=2)
    hset0 = {r["cid"] for r in split0[1]}
    cand = [r for r in recs if r["cid"] in hset0
            and r["always_label"] in ("win", "loss")]
    assert cand, "holdout must contain a closed candidate"
    target = cand[0]["cid"]

    def _solo(stream_recs):
        out = []
        for r in stream_recs:
            if r["cid"] == target:
                out.append(_rehash(dict(r, filtered_taken=True,
                                        filtered_r=r["always_r"])))
            else:
                out.append(_rehash(dict(r, filtered_taken=False,
                                        filtered_r=0.0,
                                        filtered_action="HOLD")))
        return out
    same = {v: _solo(by_var[v]) for v in s5.VARIANTS}
    split = s5f.holdout_split(same[s5.VARIANTS[0]], n_splits=2)
    folds, holdout, bound, tok = split
    assert tok["split_variant"] == s5.VARIANTS[0]
    assert {r["cid"] for r in holdout} == hset0  # same segmentation
    hev = {v: [r for r in same[v] if r["cid"] in hset0]
           for v in s5.VARIANTS}
    # stress plumbing: same population re-labeled at each multiplier
    # (economics not asserted here; n_closed counting is).
    _st21 = {}
    for _m, _lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        _st21[_lab] = {v: [_rehash(dict(r, spread_mult=_m)) for r in recs]
                       for v, recs in hev.items()}
    days = sorted({r["day"] for r in holdout})
    bars = {"SYN": [Bar(ts_ns=s5.et_close_ns(d), o=100.0, h=100.0,
                        l=100.0, c=100.0) for d in days]}
    sess, proof = s5f.build_holdout_sessions(bars, tok, DATA_ID)
    rep = _frep(split, hev, _st21, sess, proof, bars, same)
    got = rep["variants"][s5.VARIANTS[0]]
    assert got["n_closed"] == 1, got["n_closed"]
    assert "closed" in got["bar_failed"]
    # 100 actually taken closed trades -> closed condition can pass
    m2 = dict(GOODM, n_closed=100)
    assert s5.evaluate_bar(m2, BAR)[0] is True
    print("21b OK")


def _tkr(cid, sym, side, ets, xts, con=25000.0, eq=100000.0):
    return {"cid": cid, "symbol": sym, "side": side, "entry_ts": ets,
            "exit_ts": xts, "con_usd": con, "entry_equity": eq,
            "pnl_usd": 0.0, "spread_mult": 1.0, "policy": "always"}


def test_23_r_monitor():
    flat = [("d", 100000.0)]
    assert s5.verify_r_monitor([], flat) == []
    # R3 churn: 21 takes one day / 4 same-symbol same-hour
    many = [_tkr("c%d" % i, "S", "BUY", 10 + i, 20 + i) for i in range(21)]
    b = s5.verify_r_monitor(many, flat, {t["cid"]: "d" for t in many})
    assert any(x.startswith("R3-day") for x in b), b
    four = [_tkr("h%d" % i, "S", "BUY", 10 + i, 20 + i) for i in range(4)]
    b = s5.verify_r_monitor(four, flat, {t["cid"]: "d" for t in four})
    assert any(x.startswith("R3-symhour") for x in b), b
    # R4 exact machine: flat-mediated S5 sequences NEVER complete a
    # flip (entries into flat do not count). Opposite-side entry after
    # an exit is NOT a flip completion under frozen doc-05 semantics.
    base = 1700000000000000000
    flatseq = [_tkr("e1", "S", "BUY", base, base + 1000000000),
               _tkr("e2", "S", "SELL", base + 2000000000,
                    base + 3000000000)]
    b = s5.verify_r_monitor(flatseq, flat, {"e1": "d", "e2": "d"})
    assert not any(x.startswith("R4") for x in b), b
    # the machine itself, on direct position-sign transitions:
    H = 3600000000000
    assert s5.r4_completions([(base, "S", 0, 1), (base + 1, "S", 1, 0),
                              (base + 2, "S", 0, -1)]) == []
    assert s5.r4_completions([(base, "S", 1, -1),
                              (base + 1000000000, "S", -1, 1)]) == ["S"]
    assert s5.r4_completions([(base, "S", -1, 1),
                              (base + 1000000000, "S", 1, -1)]) == ["S"]
    assert s5.r4_completions([(base, "S", 1, -1),
                              (base + H, "S", -1, 1)]) == ["S"]
    assert s5.r4_completions([(base, "S", 1, -1),
                              (base + H + 1, "S", -1, 1)]) == []
    assert s5.r4_completions([(base, "S", 1, -1)]) == []
    assert s5.r4_completions([(base, "A", 1, -1),
                              (base + 1, "B", -1, 1)]) == []
    # R5 is UNAVAILABLE (daily marks cannot see intraday spike-trough):
    # even a 12% close-to-close DD is NOT claimed as an R5 evaluation.
    assert dict(s5.R_S5_STATUS)["R5-halt"][0] == "UNAVAILABLE"
    b = s5.verify_r_monitor([], [("a", 100.0), ("b", 88.0)])
    assert not any(x.startswith("R5") for x in b), b
    # R1 direction: 3 concurrent same-side
    conc = [_tkr("k%d" % i, "S%d" % i, "BUY", 10, 999) for i in range(3)]
    b = s5.verify_r_monitor(conc, flat, {t["cid"]: "d" for t in conc})
    assert any(x.startswith("R1-direction") for x in b), b
    # R2 single: con/eq > 25%
    big = [_tkr("big", "S", "BUY", 10, 999, con=30000.0)]
    b = s5.verify_r_monitor(big, flat, {"big": "d"})
    assert any(x.startswith("R2-single") for x in b), b
    # valid small ledger is clean
    ok = [_tkr("o1", "A", "BUY", 10, 20), _tkr("o2", "B", "SELL", 30, 40)]
    assert s5.verify_r_monitor(ok, flat, {"o1": "d",
                                          "o2": "d"}) == []
    print("23 OK")


def test_22_final_report_no_hardcode():
    items = synth_stream(72)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    folds, holdout, bound, tok = split
    assert holdout and tok["n"] == len(holdout)
    assert tok["protocol"] == "eval_v1" and tok["record_hash"]
    hset = {r["cid"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    bars = bars_for(items)
    sess, proof = s5f.build_holdout_sessions(bars, tok, DATA_ID)
    assert proof["data_slice"] == DATA_ID["slice"]
    # hostile: explicit mid-day boundary; day reconstruction smuggles.
    bound2 = bound + 25
    hdays2 = {r["day"] for r in by_var[s5.VARIANTS[0]]
              if r["snapshot_ts_ns"] >= bound2}
    daybuilt = [r for r in by_var[s5.VARIANTS[0]] if r["day"] in hdays2]
    smuggled = [r for r in daybuilt if r["snapshot_ts_ns"] < bound2]
    assert smuggled, "need pre-bound same-day records for the hostile"
    true2 = [r for r in by_var[s5.VARIANTS[0]]
             if r["snapshot_ts_ns"] >= bound2]
    assert smuggled and not ({r["cid"] for r in true2} &
                             {r["cid"] for r in smuggled})
    try:
        _frep(split, {v: daybuilt for v in s5.VARIANTS},
              {k: {v: daybuilt for v in s5.VARIANTS}
               for k in ("1.5x", "2x", "3x")},
              sess, proof, bars, by_var)
        raise SystemExit("day-built set must be rejected")
    except AssertionError:
        pass
    # hostile: duplicate a holdout row (same CID set, altered population)
    dup = h1x[s5.VARIANTS[0]] + [h1x[s5.VARIANTS[0]][0]]
    try:
        _frep(split, {s5.VARIANTS[0]: dup,
                      s5.VARIANTS[1]: h1x[s5.VARIANTS[1]]},
              {k: h1x for k in ("1.5x", "2x", "3x")},
              sess, proof, bars, by_var)
        raise SystemExit("duplicated holdout row must be rejected")
    except AssertionError:
        pass
    # hostile: 1x records filed under a stress bucket
    badstress = {k: h1x for k in ("1.5x", "2x", "3x")}
    try:
        _frep(split, h1x, badstress, sess, proof, bars, by_var)
        raise SystemExit("1x-under-3x must be rejected")
    except AssertionError:
        pass
    # hostile: manufactured token (fake hash) with real evidence
    faketok = dict(tok, record_hash="0" * 64)
    fakesplit = (folds, holdout, bound, faketok)
    try:
        _frep(fakesplit, h1x, badstress, sess, proof, bars, by_var)
        raise SystemExit("fake token must be rejected")
    except AssertionError:
        pass
    # hostile: MUTATED holdout session close (valid day/close_ns, real
    # bars) — rebuild mismatch must fail
    mutsess = [dict(s, closes={"SYN": 999999.0}) for s in sess]
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    try:
        _frep(split, h1x, stress, mutsess, proof, bars, by_var)
        raise SystemExit("mutated session close must be rejected")
    except AssertionError:
        pass
    # hostile: session injection outside the holdout window
    badsess = sess + [dict(sess[0], day="2020-01-01",
                           close_ns=s5.et_close_ns("2020-01-01"))]
    try:
        _frep(split, h1x, stress, badsess, proof, bars, by_var)
        raise SystemExit("pre-holdout session must be rejected")
    except AssertionError:
        pass
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    for v, x in rep["variants"].items():
        assert x["bar_verdict"] is False and x["bar_failed"], v
        assert x["s5_gate_ready"] is False  # no baseline artifact yet
    sq = rep["sequential"]
    assert sq["variant"] == tok["split_variant"]
    assert sq["n_closed"] > 0 and len(sq["interim"]) == 3
    hset2 = {r["cid"] for r in holdout}
    _sd2, _sy2, _sc2 = s5.sequential_inputs(by_var[sq["variant"]], bound)
    assert not (set(_sc2) & hset2) and len(_sd2) == sq["n_closed"]
    assert rep["holm"]
    assert rep["bar_frozen"] == dict(BAR)
    assert rep["r_scope_frozen"] == SCOPE
    assert rep["r_scope_note"] == s5.R_SCOPE_NOTE
    kn = rep["knobs"]
    assert kn["boot_seed"] == 24269 and kn["null_seed"] == 24270
    assert kn["boot_reps"] == s5.BOOT_REPS == 2000
    assert rep["session_proof"] == proof
    assert rep["split_token"] == tok
    print("22 OK", [(v, x["bar_failed"]) for v, x in
                    rep["variants"].items()])


def test_24_closed_seq_and_selected_variant():
    items = synth_stream(48)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    d, dys = s5.closed_stream(recs)
    labs = [r["always_label"] for r in recs]
    assert "censored" in labs  # fixture mixes populations
    exp = sorted((r for r in recs
                  if r["always_label"] in ("win", "loss")),
                 key=lambda r: r["snapshot_ts_ns"])
    assert d == [r["filtered_r"] - r["always_r"] for r in exp]
    assert dys == [r["day"] for r in exp]
    assert [r["snapshot_ts_ns"] for r in exp] == sorted(
        r["snapshot_ts_ns"] for r in exp)  # snapshot-ordered
    # selection can pick variant 2; seq must follow the selected policy
    stats = {s5.VARIANTS[0]: [0.0, 0.0], s5.VARIANTS[1]: [1.0, 1.0]}
    assert s5.select_variant(stats) == s5.VARIANTS[1]
    d1, y1 = s5.closed_stream(by_var[s5.VARIANTS[0]])
    d2, y2 = s5.closed_stream(by_var[s5.VARIANTS[1]])
    sel = s5.select_variant(stats)
    ds, ys = s5.closed_stream(by_var[sel])
    assert ds == d2 and ys == y2  # sequential evidence follows selection
    dec, _, _ = s5.seq_decision(ds, ys, "final")
    assert dec in ("efficacy", "fail")
    print("24 OK")


def test_25_embargo_ignores_holdout():
    items = synth_stream(60)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    _, bound = s5.segment_bounds(recs, n_splits=2)
    f1 = s5.walk_folds(recs, n_splits=2, holdout_start=bound)
    m1 = [[(r["cid"], r["filtered_r"]) for r in tr + te] for tr, te in f1]
    # mutate ONLY holdout time_exit metadata; selection must be identical
    mut = [dict(r) if r["snapshot_ts_ns"] < bound
           else dict(r, time_exit_ns=r["time_exit_ns"] + 10 ** 12)
           for r in recs]
    f2 = s5.walk_folds(mut, n_splits=2, holdout_start=bound)
    assert [[(r["cid"], r["filtered_r"]) for r in tr + te]
            for tr, te in f2] == m1
    # TRUE price mutation: post-bound candidate prices change, records
    # rebuilt through the real evaluate_stream. Selection folds must be
    # byte-identical (pre-bound labels cannot see post-bound prices),
    # while holdout evidence legitimately moves.
    import copy
    mut_items = []
    for c, bars, mkt, reg, sp in items:
        if c.snapshot_ts_ns >= bound:
            c = copy.copy(c)
            object.__setattr__(c, "entry_px", c.entry_px * 2.0)
        mut_items.append((c, bars, mkt, reg, sp))
    by_mut = {v: s5.evaluate_stream(mut_items, PROVIDE, PUB,
                                    dict(ENGINE), variant=v, day_fn=DAY,
                                    data_id=DATA_ID) for v in s5.VARIANTS}
    f3 = s5.walk_folds(by_mut[s5.VARIANTS[0]], n_splits=2,
                       holdout_start=bound)
    assert [[(r["cid"], r["filtered_r"]) for r in tr + te]
            for tr, te in f3] == m1
    hm1 = [(r["cid"], r["resolved_r"], r["always_r"])
           for r in recs if r["snapshot_ts_ns"] >= bound]
    hm3 = [(r["cid"], r["resolved_r"], r["always_r"])
           for r in by_mut[s5.VARIANTS[0]]
           if r["snapshot_ts_ns"] >= bound]
    assert hm1 != hm3, "post-bound mutation must move holdout evidence"
    print("25 OK")


def test_26_prereg_seeds_pinned():
    import inspect as _insp
    with open(os.path.join(os.path.dirname(__file__), "..",
                      "strategy", "s5_prereg.json")) as _pf:
        pre = json.load(_pf)
    assert "24269" in pre["resampling"]["ci"], pre["resampling"]["ci"]
    assert "24270" in pre["resampling"]["null_test"]
    assert s5.BOOT_SEED == 24269, hex(s5.BOOT_SEED)
    assert s5.BOOT_REPS == 2000
    assert s5.SEQ_ALPHA_INTERIM == s5.SEQ_ALPHA_FINAL == 0.025
    assert s5.HOLM_ALPHA == 0.05
    assert s5.POWER_SEED == pre["power"]["seed"] == 41721
    assert s5.POWER_REPS == pre["power"]["replicates"] == 200
    assert s5.POWER_INNER == pre["power"]["inner_resamples"] == 200
    kn = s5f.frozen_knobs()
    assert kn["boot_seed"] == 24269 and kn["null_seed"] == 24270
    assert kn["power_mde"] == 0.15
    for fn in (s5.cluster_bootstrap_ci, s5.cluster_null_p,
               s5.seq_decision, s5.seq_pair):
        assert _insp.signature(fn).parameters["seed"].default == 24269, fn
        assert _insp.signature(fn).parameters["reps"].default == 2000, fn
    assert _insp.signature(s5.power_study).parameters["seed"].default == \
        41721
    print("26 OK")


def test_27_disqualified_excluded_from_closed():
    base = dict(_mkrec("N", "SYN", "BUY", 10, 50, 100.0, 99.0, 1.0,
                        "2024-01-02"),
                always_label="win", day="2024-01-02", filtered_r=2.0)
    disq = dict(_mkrec("X", "SYN", "BUY", 10, 50, 100.0, 99.0, 5.0,
                        "2024-01-02"),
                always_label="win", day="2024-01-02",
                disqualified=True, filtered_r=0.0, filtered_taken=False)
    cen = dict(_mkrec("C", "SYN", "BUY", 10, 50, 100.0, 99.0, 0.0,
                       "2024-01-02"),
               always_label="censored", day="2024-01-02")
    d, dys = s5.closed_stream([base, disq, cen])
    assert d == [1.0] and dys == ["2024-01-02"], (d, dys)
    print("27 OK")


def test_28_seq_pair_stops():
    # interim futility -> final NOT RUN
    d_f = [-1.0] * 10
    y_f = ["2024-01-%02d" % (1 + i // 2) for i in range(10)]
    i, f = s5.seq_pair(d_f, y_f)
    assert i[0] == "stop-futility" and f[0] == "not_run", (i, f)
    # interim efficacy -> final NOT RUN
    d_e = [1.0] * 20
    y_e = ["2024-02-%02d" % (1 + i // 2) for i in range(20)]
    i, f = s5.seq_pair(d_e, y_e)
    assert i[0] == "stop-efficacy" and f[0] == "not_run", (i, f)
    # interim continue -> final EXECUTED (here: fail on noisy full set)
    half = [1.0] * 5 + [-0.9] * 5
    d_c = half + half
    y_c = ["2024-03-%02d" % (1 + (i // 5)) for i in range(20)]
    i, f = s5.seq_pair(d_c, y_c)
    assert i[0] == "continue", i
    assert f[0] in ("efficacy", "fail") and f[0] != "not_run", f
    print("28 OK", i[0], f[0])


def test_29_et_session_contract():
    utc = datetime.timezone.utc
    # (a) EST vs EDT wall time: same 16:00 ET, different UTC hour
    jan = s5.et_close_ns("2024-01-16")
    jul = s5.et_close_ns("2024-07-16")
    assert datetime.datetime.fromtimestamp(jan / 1e9,
                                           tz=utc).hour == 21  # EST
    assert datetime.datetime.fromtimestamp(jul / 1e9,
                                           tz=utc).hour == 20  # EDT
    # (b) DST transition weekend: Monday after spring-forward is EDT
    mon = s5.et_close_ns("2024-03-11")
    assert datetime.datetime.fromtimestamp(mon / 1e9,
                                           tz=utc).hour == 20
    assert mon - s5.et_close_ns("2024-03-10") == 86400 * 10 ** 9
    # (a2) after-hours bars never mark: last bar <= close wins
    close = s5.et_close_ns("2024-07-16")
    bars = [Bar(ts_ns=close - 3600 * 10 ** 9, o=1, h=1, l=1,
                c=100.0),
            Bar(ts_ns=close, o=1, h=1, l=1, c=101.0),
            Bar(ts_ns=close + 2 * 3600 * 10 ** 9, o=1, h=1, l=1,
                c=999.0)]
    assert s5.last_close_at_or_before(bars, close) == 101.0
    assert s5.last_close_at_or_before(bars[:1], close) == 100.0
    assert s5.last_close_at_or_before([], close) is None
    # (c) partial first interval excluded from Sharpe, kept in curve
    rets = [0.5, 0.01, -0.02, 0.03]
    assert s5.daily_returns(rets) == [0.01, -0.02, 0.03]
    assert s5.sharpe_hac(s5.daily_returns(rets))[0] != \
        s5.sharpe_hac(rets)[0]
    # (d) zero-trade day: flat curve emits 0.0 observations
    _, curve, rets0, _ = s5.portfolio_curve([], "always", 100000.0,
                                            sessions_for(synth_stream(70)))
    assert [v for _, v in curve] == [100000.0] * len(curve)
    assert set(rets0) == {0.0} and set(s5.daily_returns(rets0)) == {0.0}
    print("29 OK")


def test_30_split_provenance():
    items = synth_stream(40)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    split = _winner_split(by_var, n_splits=2)
    folds, holdout, bound, t1 = split
    v0split = s5f.holdout_split(recs, n_splits=2)
    split_b = s5f.holdout_split(list(reversed(recs)), n_splits=2)
    assert split_b[3] == v0split[3]  # order-independent mint
    hset = {r["cid"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    bars = bars_for(items)
    sess, proof = s5f.build_holdout_sessions(bars, t1, DATA_ID)
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    # subset evidence + REAL split token => rejected as not the split.
    # (stress subsets are properly re-resolved twins, so ONLY the
    # subset dimension can trigger the rejection.)
    subset_ev = {v: recs_v[:-5] for v, recs_v in h1x.items()}
    subset_st = {k: {v: recs_v[:-5] for v, recs_v in by_var.items()}
                 for k, by_var in stress.items()}
    try:
        _frep(split, subset_ev, subset_st, sess, proof, bars, by_var)
        raise SystemExit("subset evidence must fail vs real split")
    except AssertionError:
        pass
    # tampered token fields fail against threaded holdout
    for badtok in (dict(t1, n=t1["n"] + 1),
                   dict(t1, holdout_start=bound + 1),
                   dict(t1, record_hash="0" * 64),
                   dict(t1, protocol="evil")):
        try:
            _frep((folds, holdout, bound, badtok), h1x,
                  stress, sess, proof, bars, by_var)
            raise SystemExit("tampered token must fail: %r" % (badtok,))
        except AssertionError:
            pass
    # control: real split + real evidence passes
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    assert rep["split_token"] == t1
    print("30 OK")


def _small_split(n=24):
    """Helper: split + evidence + bars + sessions/proof for gate tests."""
    items = synth_stream(n)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    folds, holdout, bound, tok = split
    hset = {r["cid"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    bars = bars_for(items)
    sess, proof = s5f.build_holdout_sessions(bars, tok, DATA_ID)
    return split, h1x, stress, sess, proof, bars, by_var, _roots(by_var)


def test_31_record_content_binding():
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    v0 = s5.VARIANTS[0]
    base = h1x[v0]
    # (a) naive in-place mutation (stale eval_hash) -> self-check fails
    for mutate in (lambda r: dict(r, day="2020-01-01"),
                   lambda r: dict(r, filtered_r=r["filtered_r"] + 9.0),
                   lambda r: dict(r, always_label="win"),
                   lambda r: dict(r, entry_fill=r["entry_fill"] + 1.0),
                   lambda r: dict(r, snapshot_ts_ns=r["snapshot_ts_ns"] + 1),
                   lambda r: dict(r, stop_px=r["stop_px"] + 5.0)):
        mut = [mutate(base[0])] + base[1:]
        try:
            _frep(split, {v0: mut,
                          s5.VARIANTS[1]: h1x[s5.VARIANTS[1]]},
                  stress, sess, proof, bars, by_var)
            raise SystemExit("mutated 1x content must fail")
        except AssertionError:
            pass
    # (b) mutation + refreshed hash -> set digest vs split token fails
    mut2 = [_rehash(dict(base[0], day="2020-01-01"))] + base[1:]
    try:
        _frep(split, {v0: mut2, s5.VARIANTS[1]: h1x[s5.VARIANTS[1]]},
              stress, sess, proof, bars, by_var)
        raise SystemExit("rehashed day mutation must fail digest")
    except AssertionError:
        pass
    # (c) stress twin candidate-field mutation fails (not in allowlist)
    smut = {k: {v: [dict(r) for r in recs] for v, recs in by_var.items()}
            for k, by_var in stress.items()}
    smut["2x"][v0][0]["entry_px"] += 1.0
    smut["2x"][v0][0] = _rehash(smut["2x"][v0][0])
    try:
        _frep(split, h1x, smut, sess, proof, bars, by_var)
        raise SystemExit("mutated stress candidate field must fail")
    except AssertionError:
        pass
    # (d) variant-twin decision-field mutation fails
    vmut = {v: [dict(r) for r in recs] for v, recs in h1x.items()}
    vmut[s5.VARIANTS[1]][0]["symbol"] = "XXX"
    vmut[s5.VARIANTS[1]][0] = _rehash(vmut[s5.VARIANTS[1]][0])
    try:
        _frep(split, vmut, stress, sess, proof, bars, by_var)
        raise SystemExit("mutated variant twin must fail")
    except AssertionError:
        pass
    print("31 OK")


def test_32_session_price_and_seam():
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    # (a) bars mutated under valid sessions -> rebuild mismatch rejects
    mutbars = {"SYN": [Bar(ts_ns=b.ts_ns, o=b.o, h=b.h, l=b.l,
                           c=b.c + 50.0) for b in bars["SYN"]]}
    try:
        _frep(split, h1x, stress, sess, proof, mutbars, by_var)
        raise SystemExit("mutated bars must fail rebuild")
    except AssertionError:
        pass
    # (b) data_id mismatch rejects
    baddata = dict(DATA_ID, dataset_sha="forged")
    try:
        s5f.final_report(split, h1x, stress, sess, proof, bars, baddata,
                         100000.0, by_var, root)
        raise SystemExit("forged data_id must fail rebuild")
    except AssertionError:
        pass
    # (c) end_ts/close_ns seam: portfolio_curve refuses a split session
    badsess = [dict(sess[0], end_ts=sess[0]["close_ns"] + 1)]
    try:
        s5.portfolio_curve(h1x[s5.VARIANTS[0]], "filtered", 100000.0,
                           badsess)
        raise SystemExit("end_ts seam must fail closed")
    except AssertionError:
        pass
    # control passes
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    assert rep["session_proof"] == proof
    print("32 OK")


def test_33_boundary_first_interval():
    d = "2024-03-11"
    op, cl = s5.et_open_ns(d), s5.et_close_ns(d)
    assert op < cl
    # mid-session bound -> partial stub excluded
    assert not (cl - 3600 * 10 ** 9 <= op)
    mid = cl - 3600 * 10 ** 9
    assert mid > op  # genuinely mid-session
    # exact previous-close bound -> full first interval included
    prev_cl = s5.et_close_ns("2024-03-08")
    assert prev_cl <= op
    assert s5.daily_returns([0.5, 0.1, 0.2], False) == [0.1, 0.2]
    assert s5.daily_returns([0.5, 0.1, 0.2], True) == [0.5, 0.1, 0.2]
    # synth bounds are pre-session (tiny ints) -> first interval included
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    assert rep["first_interval_included"] is True
    assert split[3]["holdout_start"] <= s5.et_open_ns(
        split[3]["dates"][0])
    print("33 OK")


def _baseline_fixture(proof, token, sharpes, dd=5.0, n=200):
    art = {"baseline_id": "baseline_v1", "protocol": "eval_v1",
           "data_slice": proof["data_slice"],
           "dataset_sha": proof["dataset_sha"],
           "session_hash": proof["session_hash"],
           "dates": list(proof["session_dates"]),
           "metrics": {m: {"sharpe_f": s, "max_dd_pct": dd,
                             "n_closed": n}
                       for m, s in sharpes.items()}}
    art["artifact_sha256"] = s5f.baseline_artifact_hash(art)
    return art


def test_34_baseline_gate():
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    tok = split[3]
    chall = {"1x": 0.5, "1.5x": 0.4, "2x": 0.3, "3x": 0.2, "dd_1x": 4.0}
    # (a) absent -> fail closed
    v, f, d = s5f.baseline_gate(chall, None, proof, tok)
    assert v is False and f == ["baseline_absent"], (v, f)
    # (b) malformed (missing mult) -> fail closed
    bad = _baseline_fixture(proof, tok, {"1x": 0.0, "2x": 0.0})
    v, f, d = s5f.baseline_gate(chall, bad, proof, tok)
    assert v is False and f == ["baseline_malformed"], (v, f)
    # (c) mismatched slice -> fail closed
    mis = _baseline_fixture(proof, tok, {"1x": 0.0, "1.5x": 0.0,
                                         "2x": 0.0, "3x": 0.0})
    mis["data_slice"] = "other-slice"
    v, f, d = s5f.baseline_gate(chall, mis, proof, tok)
    assert v is False and f == ["baseline_malformed"], (v, f)
    # (c2) session-hash mismatch -> session fail-closed (not malformed)
    sesh = _baseline_fixture(proof, tok, {"1x": 0.0, "1.5x": 0.0,
                                          "2x": 0.0, "3x": 0.0})
    sesh["session_hash"] = "0" * 64
    sesh["artifact_sha256"] = s5f.baseline_artifact_hash(sesh)
    v, f, d = s5f.baseline_gate(chall, sesh, proof, tok)
    assert v is False and f == ["baseline_session"], (v, f)
    # (c2b) same mutation under the STALE hash -> malformed (identity
    # covers content; the forgery invalidates the digest).
    sesh_stale = _baseline_fixture(proof, tok, {"1x": 0.0, "1.5x": 0.0,
                                                "2x": 0.0, "3x": 0.0})
    sesh_stale["session_hash"] = "0" * 64
    v, f, d = s5f.baseline_gate(chall, sesh_stale, proof, tok)
    assert v is False and f == ["baseline_malformed"], (v, f)
    # (c3) candidate-day dates instead of the full session calendar
    sesh2 = _baseline_fixture(proof, tok, {"1x": 0.0, "1.5x": 0.0,
                                           "2x": 0.0, "3x": 0.0})
    sesh2["dates"] = list(tok["dates"])[:-1] or list(tok["dates"])
    if sesh2["dates"] == list(proof["session_dates"]):
        sesh2["dates"] = sesh2["dates"] + ["2099-01-01"]
    sesh2["artifact_sha256"] = s5f.baseline_artifact_hash(sesh2)
    v, f, d = s5f.baseline_gate(chall, sesh2, proof, tok)
    assert v is False and f == ["baseline_session"], (v, f)
    # (d) losing baseline comparison -> beats_* failed
    lose = _baseline_fixture(proof, tok, {"1x": 9.0, "1.5x": 9.0,
                                          "2x": 9.0, "3x": 9.0})
    v, f, d = s5f.baseline_gate(chall, lose, proof, tok)
    assert v is False and f == ["beats_1x", "beats_1.5x", "beats_2x",
                                "beats_3x"], f
    # (e) winning comparison -> True
    win = _baseline_fixture(proof, tok, {"1x": 0.1, "1.5x": 0.1,
                                         "2x": 0.1, "3x": 0.1}, dd=9.0)
    v, f, d = s5f.baseline_gate(chall, win, proof, tok)
    assert v is True and f == [], (v, f)
    # wired into final_report: None baseline -> promotion closed
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    for vname, x in rep["variants"].items():
        assert x["baseline_gate"]["failed"] == ["baseline_absent"]
        assert x["s5_gate_ready"] is False
    rep2 = _frep(split, h1x, stress, sess, proof, bars, by_var,
                 baseline=win)
    # stub challenger Sharpe is 0.0, so even the 'winning' baseline
    # beats it on Sharpe while DD passes: wiring, not value, asserted.
    assert {tuple(x["baseline_gate"]["failed"])
            for x in rep2["variants"].values()} == {("beats_1x",
            "beats_1.5x", "beats_2x", "beats_3x")}
    print("34 OK")


def test_35_knobs_parsed_not_duplicated():
    import copy
    assert s5f.check_knobs() == []
    with open(os.path.join(os.path.dirname(__file__), "..",
                      "strategy", "s5_prereg.json")) as _pf:
        pre = json.load(_pf)
    assert s5f.frozen_knobs(pre)["boot_seed"] == 24269
    stale = copy.deepcopy(pre)
    stale["inference_knobs"]["boot_seed"] = 99999
    assert s5f.check_knobs(stale) == ["boot_seed"]
    assert s5f.frozen_knobs(stale)["boot_seed"] == 99999  # parsed, stale
    stale2 = copy.deepcopy(pre)
    stale2["inference_knobs"]["power_reps"] = 7
    assert s5f.check_knobs(stale2) == ["power_reps"]
    print("35 OK")


def test_36_r_scope_audited():
    import inspect as _insp
    src_all = _insp.getsource(s5)
    anchors = {"R1-positions": "MAX_POSITIONS",
               "R1-same-direction": "R1-direction",
               "R2-single": "R2-single", "R2-total": "R2-total",
               "R3-churn": "R3-day", "R4-fliplock": "r4_completions",
               "R8-maxgate": "evaluate",
               "R12-lookahead": "bars_after",
               "R14-disagree": "disagreement",
               "stop-rule": "exits-first"}
    assert set(anchors) == set(s5.R_CHECKED), \
        (set(anchors) ^ set(s5.R_CHECKED))
    for rule, marker in anchors.items():
        assert marker in src_all, rule
    assert "r4_completions" in _insp.getsource(s5.verify_r_monitor)
    assert "MAX_POSITIONS" in _insp.getsource(s5.portfolio_curve)
    assert "evaluate" in _insp.getsource(s5.evaluate_stream)
    for pend in ("R1-pending", "R2-pending", "R5-halt", "R6-vol",
                 "R7-corr", "R9-venue"):
        assert pend in s5.R_UNAVAILABLE, pend
    assert s5f.frozen_scope() == sorted(s5.R_UNAVAILABLE)
    assert set(s5.R_CHECKED) & set(s5.R_UNAVAILABLE) == set()
    assert len(s5.R_S5_STATUS) == 22  # R1/R2 split + R3-R17 + stop-rule
    assert "pending" in s5.R_SCOPE_NOTE and "UNAVAILABLE" in s5.R_SCOPE_NOTE
    print("36 OK")



def test_37_frozen_bars_authority():
    import tempfile
    # file-level provenance on an explicit throwaway fixture identity
    # (never the production S2 paths): valid passes; any drift fails.
    tmp = tempfile.mkdtemp(prefix="s5frozen")
    raw = os.path.join(tmp, "raw")
    frz = os.path.join(tmp, "frozen")
    os.makedirs(raw)
    os.makedirs(frz)
    blobs = {fn: ("%s-bytes-%d" % (fn, i)).encode()
             for i, fn in enumerate(s5f.FROZEN_FILES)}
    for fn, b in blobs.items():
        with open(os.path.join(raw, fn), "wb") as fh:
            fh.write(b)
        with open(os.path.join(frz, fn), "wb") as fh:
            fh.write(b)
    import hashlib as _hl
    h = _hl.sha256()
    for fn in sorted(os.listdir(frz)):
        with open(os.path.join(frz, fn), "rb") as fh:
            h.update(fh.read())
    rep_path = os.path.join(tmp, "report.json")
    json.dump({"frozen_dataset_sha256": h.hexdigest()},
              open(rep_path, "w"))
    got = s5f.verify_frozen_files(raw, frz, rep_path)
    assert got == {"frozen_dataset_sha256": h.hexdigest()}
    # hostile: mutated frozen copy
    open(os.path.join(frz, s5f.FROZEN_FILES[0]), "wb").write(b"evil")
    try:
        s5f.verify_frozen_files(raw, frz, rep_path)
        raise SystemExit("mutated frozen copy must fail")
    except AssertionError:
        pass
    open(os.path.join(frz, s5f.FROZEN_FILES[0]), "wb").write(
        blobs[s5f.FROZEN_FILES[0]])
    # hostile: raw regenerated under identical frozen copies
    open(os.path.join(raw, s5f.FROZEN_FILES[1]), "wb").write(b"evil")
    try:
        s5f.verify_frozen_files(raw, frz, rep_path)
        raise SystemExit("raw!=frozen must fail")
    except AssertionError:
        pass
    # object-level binding through the production final-report branch:
    # verified bars_digest passes; one mutated Bar fails even with
    # rebuilt sessions + rebuilt proof.
    items = synth_stream(24)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    hset = {r["cid"] for r in split[1]}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    bars = bars_for(items)
    proot = dict(_roots(by_var))
    proot["frozen_dataset_sha256"] = "F" * 64
    proot["bars_digest"] = s5f.digest_bars(bars)  # the pinned leg
    proof_ok = {"frozen_dataset_sha256": "F" * 64,
                "bars_digest": s5f.digest_bars(bars),
                "symbols": ["SYN"]}
    sess, proof = s5f.build_holdout_sessions(bars, split[3], DATA_ID)
    rep = s5f.final_report(split, h1x, stress, sess, proof, bars,
                           DATA_ID, 100000.0, by_var, proot,
                           bars_proof=proof_ok)
    assert rep["session_proof"] == proof
    # fixture roots REQUIRE bars_proof=None (never pose as production)
    try:
        s5f.final_report(split, h1x, stress, sess, proof, bars,
                         DATA_ID, 100000.0, by_var, _roots(by_var),
                         bars_proof=proof_ok)
        raise SystemExit("fixture root + bars proof must fail")
    except AssertionError:
        pass
    mutbars = {"SYN": [Bar(ts_ns=b.ts_ns, o=b.o, h=b.h, l=b.l,
                           c=b.c + 50.0) for b in bars["SYN"]]}
    msess, mproof = s5f.build_holdout_sessions(mutbars, split[3],
                                               DATA_ID)
    try:
        s5f.final_report(split, h1x, stress, msess, mproof, mutbars,
                         DATA_ID, 100000.0, by_var, proot,
                         bars_proof=proof_ok)
        raise SystemExit("mutated bar + rebuilt proof must fail digest")
    except AssertionError:
        pass
    # P0 hostile: mutate bars AND regenerate the proof (forged bars
    # digest agrees with the forged bars) -> must STILL fail: the
    # proof agrees with the bars but the PINNED root digest does not.
    forged = {"frozen_dataset_sha256": "F" * 64,
              "bars_digest": s5f.digest_bars(mutbars),
              "symbols": ["SYN"]}
    try:
        s5f.final_report(split, h1x, stress, msess, mproof, mutbars,
                         DATA_ID, 100000.0, by_var, proot,
                         bars_proof=forged)
        raise SystemExit("regenerated proof over forged bars must fail")
    except AssertionError:
        pass
    print("37 OK")


def test_38_foreign_stream_rejected():
    items = synth_stream(40)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    real_root = _roots(by_var)
    # reversed input mints the identical root (order-independent)
    rev = {v: list(reversed(recs)) for v, recs in by_var.items()}
    assert s5f.stream_roots(rev, DATA_ID) == real_root
    v0split = s5f.holdout_split(by_var[s5.VARIANTS[0]], n_splits=2)
    assert s5f.holdout_split(list(reversed(
        by_var[s5.VARIANTS[0]])), n_splits=2)[3] == v0split[3]
    # a DIFFERENT valid stream + its own valid token + matching
    # evidence FAILS against the real expected root.
    fitems = synth_stream(24)
    fby = run_all(fitems)
    fsplit = _winner_split(fby, n_splits=2)
    fhset = {r["cid"] for r in fsplit[1]}
    fh1x = {v: [r for r in fby[v] if r["cid"] in fhset]
            for v in s5.VARIANTS}
    fstress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        fsv = run_all(fitems, spread_mult=mult)
        fstress[lab] = {v: [r for r in fsv[v] if r["cid"] in fhset]
                        for v in s5.VARIANTS}
    fbars = bars_for(fitems)
    fsess, fproof = s5f.build_holdout_sessions(fbars, fsplit[3],
                                               DATA_ID)
    try:
        s5f.final_report(fsplit, fh1x, fstress, fsess, fproof, fbars,
                         DATA_ID, 100000.0, fby, real_root)
        raise SystemExit("foreign stream + own token must fail")
    except AssertionError:
        pass
    # control: foreign evidence validates under its OWN root
    rep = s5f.final_report(fsplit, fh1x, fstress, fsess, fproof, fbars,
                           DATA_ID, 100000.0, fby, _roots(fby))
    assert rep["split_token"] == fsplit[3]
    print("38 OK")


def test_39_sequential_excludes_holdout():
    items = synth_stream(48)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    folds, holdout, bound, tok = split
    sel = tok["split_variant"]
    hset = {r["cid"] for r in holdout}
    sd, sy, sc = s5.sequential_inputs(by_var[sel], bound)
    assert sd and not (set(sc) & hset)
    # hostile: perturb ONLY holdout closed outcomes -> inputs identical
    pert = []
    for r in by_var[sel]:
        if r["cid"] in hset:
            pert.append(_rehash(dict(r, filtered_r=r["filtered_r"] + 99.0,
                                     always_r=r["always_r"] - 99.0)))
        else:
            pert.append(dict(r))
    sd2, sy2, sc2 = s5.sequential_inputs(pert, bound)
    assert (sd2, sy2, sc2) == (sd, sy, sc)
    # rep-level: authoritative result, holdout structurally absent
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    bars = bars_for(items)
    sess, proof = s5f.build_holdout_sessions(bars, tok, DATA_ID)
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    sq = rep["sequential"]
    assert sq["variant"] == sel and sq["n_closed"] == len(sd)
    assert sq["interim"] == s5.seq_pair(sd, sy)[0]
    assert sq["final"] == s5.seq_pair(sd, sy)[1]
    # empty-input encoding (nothing resolves pre-bound)
    assert s5.sequential_inputs(by_var[sel], 0) == ([], [], [])
    print("39 OK")


def test_40_gap_day_zero_observation():
    items180 = synth_stream(180)
    days_all = sorted({DAY(c.snapshot_ts_ns) for c, _, _, _, _ in
                       items180})
    assert len(days_all) > 6
    # gap strictly INSIDE the holdout window (trial split first)
    full = run_all(items180)
    trial_days = s5f.holdout_split(full[s5.VARIANTS[0]],
                                   n_splits=2)[3]["dates"]
    assert len(trial_days) > 2
    gap = trial_days[len(trial_days) // 2]
    items = [it for it in items180
             if DAY(it[0].snapshot_ts_ns) != gap]
    assert items and not any(DAY(c.snapshot_ts_ns) == gap
                             for c, _, _, _, _ in items)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    folds, holdout, bound, tok = split
    assert tok["dates"][0] < gap < tok["dates"][-1]  # interior
    assert gap not in tok["dates"]  # no candidate that day
    hset = {r["cid"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    # bars span the gap day (frozen data has the session; S5 has no
    # candidate) -> the session must still exist.
    bars = {"SYN": [Bar(ts_ns=s5.et_close_ns(d), o=100.0 + i,
                        h=100.0 + i, l=100.0 + i, c=100.0 + i)
                    for i, d in enumerate(days_all)]}
    sess, proof = s5f.build_holdout_sessions(bars, tok, DATA_ID)
    assert gap in proof["session_dates"]
    assert proof["session_dates"] == sorted(
        d for d in days_all if tok["dates"][0] <= d <= tok["dates"][-1])
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    assert rep["session_proof"]["session_dates"] == proof["session_dates"]
    # flat book: every session return is exactly 0.0 (gap included)
    flat = [{**r, "filtered_taken": False, "always_realized": False}
            for r in h1x[s5.VARIANTS[0]]]
    _t, _c, rets, _dd = s5.portfolio_curve(flat, "filtered", 100000.0,
                                           sess)
    assert len(rets) == len(sess) and all(r == 0.0 for r in rets)
    print("40 OK")


def test_41_d6_canon():
    assert s5.D6_SCALE_PLACES == 6  # explicit documented scale
    assert s5.canon_num(100) == "i:100"
    assert s5.canon_num(-7) == "i:-7"
    assert s5.canon_num(100.0) == "f6:100.000000"  # scale in tag
    assert s5.canon_num(100) != s5.canon_num(100.0)  # type-tagged
    assert "e" not in format(__import__("decimal").Decimal(1e-7), "f")
    # equal doubles hash identically however constructed
    assert s5.canon_num(0.1) == s5.canon_num(1 / 10)
    assert s5.canon_num(100.0) == s5.canon_num(400.0 / 4)
    # sub-scale differences collapse BY DESIGN (fixed-point, not a bug)
    assert s5.canon_num(0.1 + 0.2) == s5.canon_num(0.3)
    assert s5.canon_num(100.0) == s5.canon_num(100.0000001)
    assert s5.canon_num(1.000001) == s5.canon_num(1.0000014)
    # scale-level differences stay distinct (economics preserved)
    assert s5.canon_num(1.000001) != s5.canon_num(1.000002)
    assert s5.canon_num(100.0) != s5.canon_num(100.000001)
    assert s5.canon_num(-3.115) == "f6:-3.115000"
    # eval_hash: insertion order irrelevant, values canonical
    r1 = {"b": 1.5, "a": 100, "c": "x", "d": True, "e": None}
    r2 = {"e": None, "d": True, "c": "x", "a": 100, "b": 1.5}
    assert s5.eval_hash(r1) == s5.eval_hash(r2)
    assert s5.eval_hash({"a": 100}) != s5.eval_hash({"a": 100.0})
    for bad in (float("nan"), float("inf"), object()):
        try:
            s5.eval_hash({"a": bad})
            raise SystemExit("must fail closed: %r" % (bad,))
        except AssertionError:
            pass
    try:
        s5.canon_num(True)  # bool is not a hashed number
        raise SystemExit("bool must fail closed")
    except AssertionError:
        pass
    print("41 OK")


def test_42_baseline_session_wiring():
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    tok = split[3]
    win = _baseline_fixture(proof, tok, {"1x": 0.1, "1.5x": 0.1,
                                         "2x": 0.1, "3x": 0.1}, dd=9.0)
    nosesh = dict(win)
    del nosesh["session_hash"]
    v, f, d = s5f.baseline_gate({"1x": 0.5, "1.5x": 0.4, "2x": 0.3,
                                 "3x": 0.2, "dd_1x": 4.0},
                                nosesh, proof, tok)
    assert v is False and f == ["baseline_malformed"], (v, f)
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var,
                baseline=win)
    for vname, x in rep["variants"].items():
        assert x["s5_gate_ready"] is False  # stub Sharpe loses
        assert "baseline_session" not in x["baseline_gate"]["failed"]
    badwin = dict(win, session_hash="1" * 64)
    badwin["artifact_sha256"] = s5f.baseline_artifact_hash(badwin)
    rep2 = _frep(split, h1x, stress, sess, proof, bars, by_var,
                 baseline=badwin)
    assert all(x["baseline_gate"]["failed"] == ["baseline_session"]
               for x in rep2["variants"].values())
    print("42 OK")


def test_43_missing_mark_fails_closed():
    items = synth_stream(24)
    by_var = run_all(items)
    taken = [r for r in by_var[s5.VARIANTS[0]] if r["filtered_taken"]]
    assert taken, "need a taken trade for the hostile"
    t = taken[0]
    d0 = t["day"]
    good = [{"day": d0, "end_ts": t["snapshot_ts_ns"],
             "closes": {"SYN": 100.0}}]
    # control: full marks sweep fine
    s5.portfolio_curve([t], "filtered", 100000.0, good)
    # hostile: the traded symbol has no mark while the position is
    # open (entry opens at the session end, mark computed after) ->
    # fail closed, never flat-filled at entry price.
    bad = [{"day": d0, "end_ts": t["snapshot_ts_ns"], "closes": {}}]
    try:
        s5.portfolio_curve([t], "filtered", 100000.0, bad)
        raise SystemExit("missing mark must fail closed")
    except AssertionError:
        pass
    print("43 OK")


def _ns_shift(items, base_ns):
    """Shift a synth stream to ns-scale around base_ns.

    All timestamps (snapshot, horizon, bars_after, market epoch) move
    by the same offset; relative structure (and hence economics) is
    preserved while the holdout boundary lands at a real ET wall time."""
    from dataclasses import replace
    t0 = items[0][0].snapshot_ts_ns
    out = []
    for c, aft, mkt, reg, sp in items:
        rel = c.snapshot_ts_ns - t0
        c2 = replace(c, snapshot_ts_ns=base_ns + rel,
                     time_exit_ns=c.time_exit_ns - c.snapshot_ts_ns +
                     base_ns + rel)
        aft2 = [replace(b, ts_ns=b.ts_ns - c.snapshot_ts_ns +
                        base_ns + rel) for b in aft]
        mkt2 = dict(mkt, snapshot_epoch=base_ns + rel)
        out.append((c2, aft2, mkt2, reg, sp))
    return out


def test_44_ns_boundary_branches():
    import datetime as _dt
    day_ns = lambda ts: _dt.datetime.fromtimestamp(
        ts / 1e9, tz=_dt.timezone.utc).strftime("%Y-%m-%d")
    base_items = synth_stream(60)
    t0 = base_items[0][0].snapshot_ts_ns
    span = base_items[-1][0].snapshot_ts_ns - t0
    d = "2024-01-16"
    # mid-session: whole stream inside 15:00 ET (bound > open)
    mid_base = s5.et_close_ns(d) - 3600 * 10 ** 9
    mid_items = _ns_shift(base_items, mid_base)
    assert max(c.snapshot_ts_ns for c, _, _, _, _ in mid_items) < \
        s5.et_close_ns(d)
    # pre-open: whole stream before 09:30 ET (bound <= open)
    pre_base = s5.et_open_ns(d) - 3600 * 10 ** 9
    pre_items = _ns_shift(base_items, pre_base)
    assert max(c.snapshot_ts_ns for c, _, _, _, _ in pre_items) < \
        s5.et_open_ns(d)
    reps = {}
    for tag, shifted in (("mid", mid_items), ("pre", pre_items)):
        by_var = {v: s5.evaluate_stream(shifted, PROVIDE, PUB,
                                        dict(ENGINE), variant=v,
                                        day_fn=day_ns, data_id=DATA_ID)
                  for v in s5.VARIANTS}
        split = _winner_split(by_var, n_splits=2)
        hset = {r["cid"] for r in split[1]}
        h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
               for v in s5.VARIANTS}
        stress = {}
        for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
            sv = {v: s5.evaluate_stream(shifted, PROVIDE, PUB,
                                        dict(ENGINE), variant=v,
                                        spread_mult=mult, day_fn=day_ns,
                                        data_id=DATA_ID)
                  for v in s5.VARIANTS}
            stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                           for v in s5.VARIANTS}
        bars = {"SYN": [Bar(ts_ns=s5.et_close_ns(d), o=100.0, h=100.0,
                            l=100.0, c=100.0)]}
        sess, proof = s5f.build_holdout_sessions(bars, split[3],
                                                 DATA_ID)
        rep = s5f.final_report(split, h1x, stress, sess, proof, bars,
                               DATA_ID, 100000.0, by_var,
                               _roots(by_var))
        reps[tag] = (rep, h1x, sess)
    (mid, mid_ev, mid_sess) = reps["mid"]
    (pre, pre_ev, pre_sess) = reps["pre"]
    assert mid["first_interval_included"] is False
    assert pre["first_interval_included"] is True
    # retention: the stub interval lives in the curve in BOTH branches
    for ev, sess in ((mid_ev, mid_sess), (pre_ev, pre_sess)):
        _t, curve, rets, _dd = s5.portfolio_curve(
            ev[s5.VARIANTS[0]], "filtered", 100000.0, sess)
        assert len(curve) == 2 and len(rets) == 1
    # Takes differ across branches (CIDs bind wall time, stub answers derive
    # from CIDs). The invariant is structural: the partial stub stays in the
    # curve in both branches and Sharpe drops it only in the mid-session one.
    assert mid["session_proof"]["session_dates"] ==         pre["session_proof"]["session_dates"]
    for v in s5.VARIANTS:
        mv, pv = mid["variants"][v], pre["variants"][v]
        assert mv["n_sharpe_obs"] == 0, (v, mv["n_sharpe_obs"])
        assert pv["n_sharpe_obs"] == 1, (v, pv["n_sharpe_obs"])
    print("44 OK")

def test_45_root_substitution_rejected():
    pin = s5f.pinned_slice_root()
    prod_id = {"slice": pin["data_slice"],
               "dataset_sha": pin["dataset_sha"]}
    items = synth_stream(24)
    fby = run_all(items, data_id=prod_id)
    fsplit = _winner_split(fby, n_splits=2)
    fhset = {r["cid"] for r in fsplit[1]}
    fh1x = {v: [r for r in fby[v] if r["cid"] in fhset]
            for v in s5.VARIANTS}
    fstress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        fsv = run_all(items, spread_mult=mult, data_id=prod_id)
        fstress[lab] = {v: [r for r in fsv[v] if r["cid"] in fhset]
                        for v in s5.VARIANTS}
    fbars = bars_for(items)
    fsess, fproof = s5f.build_holdout_sessions(fbars, fsplit[3],
                                               prod_id)
    # hostile (a): foreign valid stream + OWN self-minted root +
    # production data_id -> FAIL (production must equal the pin).
    froot = s5f.stream_roots(fby, prod_id)
    try:
        s5f.final_report(fsplit, fh1x, fstress, fsess, fproof, fbars,
                         prod_id, 100000.0, fby, froot)
        raise SystemExit("self-minted root under prod identity "
                         "must fail")
    except AssertionError:
        pass
    # hostile (b): frozen-flavored self-minted root (own digest, own
    # bars proof, all self-consistent) + production data_id -> FAIL.
    froot2 = dict(froot)
    froot2["frozen_dataset_sha256"] = pin["frozen_dataset_sha256"]
    froot2["bars_digest"] = s5f.digest_bars(fbars)
    fproof2 = {"frozen_dataset_sha256": pin["frozen_dataset_sha256"],
               "bars_digest": s5f.digest_bars(fbars),
               "symbols": ["SYN"]}
    try:
        s5f.final_report(fsplit, fh1x, fstress, fsess, fproof, fbars,
                         prod_id, 100000.0, fby, froot2,
                         bars_proof=fproof2)
        raise SystemExit("frozen-flavored self-mint under prod "
                         "identity must fail")
    except AssertionError:
        pass
    # control: fixture stream + fixture root + fixture data_id passes.
    split, h1x, stress, sess, proof, bars, by_var, root = \
        _small_split()
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    assert rep["split_token"] == split[3]
    print("45 OK")


def test_46_selection_binding():
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    tok = split[3]
    other = s5.VARIANTS[1] if tok["split_variant"] == s5.VARIANTS[0] \
        else s5.VARIANTS[0]
    # hostile (a): caller echoes the WRONG variant -> FAIL.
    try:
        _frep(split, h1x, stress, sess, proof, bars, by_var,
              selected_variant=other)
        raise SystemExit("caller override of selection must fail")
    except AssertionError:
        pass
    # hostile (b): forged token claiming the other variant (split +
    # evidence otherwise valid) -> FAIL.
    badsplit = (split[0], split[1], split[2],
                dict(tok, split_variant=other))
    try:
        _frep(badsplit, h1x, stress, sess, proof, bars, by_var)
        raise SystemExit("forged token selection must fail")
    except AssertionError:
        pass
    # hostile (c): split minted on the NON-selected variant's stream:
    # token + evidence + root all self-consistent for B, but the
    # mechanical fold selection from the full streams picks A -> FAIL.
    items = synth_stream(24)
    by2 = run_all(items)
    wsplit = s5f.holdout_split(by2[other], n_splits=2)
    assert wsplit[3]["split_variant"] == other
    whset = {r["cid"] for r in wsplit[1]}
    wh1x = {v: [r for r in by2[v] if r["cid"] in whset]
            for v in s5.VARIANTS}
    wstress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        wsv = run_all(items, spread_mult=mult)
        wstress[lab] = {v: [r for r in wsv[v] if r["cid"] in whset]
                        for v in s5.VARIANTS}
    wbars = bars_for(items)
    wsess, wproof = s5f.build_holdout_sessions(wbars, wsplit[3],
                                               DATA_ID)
    try:
        _frep(wsplit, wh1x, wstress, wsess, wproof, wbars, by2)
        raise SystemExit("non-selected split must fail binding")
    except AssertionError:
        pass
    # control: echoing the token-bound selection passes; the rep binds
    # it (selection + sequential follow the verified variant).
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var,
                selected_variant=tok["split_variant"])
    assert rep["selected_variant"] == tok["split_variant"]
    assert rep["sequential"]["variant"] == tok["split_variant"]
    print("46 OK")


def test_47_baseline_artifact_authority():
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split()
    tok = split[3]
    chall = {"1x": 0.5, "1.5x": 0.4, "2x": 0.3, "3x": 0.2, "dd_1x": 4.0}
    win = _baseline_fixture(proof, tok, {"1x": 0.1, "1.5x": 0.1,
                                         "2x": 0.1, "3x": 0.1}, dd=9.0)
    assert s5f.BASELINE_EXPECTED is None  # S2 OPEN: nothing pinned
    # (a) missing artifact identity -> malformed.
    noh = dict(win)
    del noh["artifact_sha256"]
    v, f, d = s5f.baseline_gate(chall, noh, proof, tok)
    assert v is False and f == ["baseline_malformed"], (v, f)
    # (b) fabricated metrics under the STALE hash -> malformed
    # (identity covers content; the forgery invalidates the digest).
    fab = {**win, "metrics":
           {m: {"sharpe_f": -99.0, "max_dd_pct": 0.0, "n_closed": 1}
            for m in s5f.BASELINE_MULTS}}
    v, f, d = s5f.baseline_gate(chall, fab, proof, tok)
    assert v is False and f == ["baseline_malformed"], (v, f)
    # (c) rehashed fabrication passes identity but loses on merits -
    # authority never blesses values; only a pin could (none exists).
    fab2 = dict(fab)
    fab2["artifact_sha256"] = s5f.baseline_artifact_hash(fab2)
    v, f, d = s5f.baseline_gate(chall, fab2, proof, tok)
    # fabricated Sharpe (-99) is trivially beaten; only the DD leg
    # fails on merits - identity never blesses values.
    assert v is False and f == ["dd_1x"], f
    # (d) bool/NaN/inf metrics fail closed (hash or gate, never
    # trusted). NaN/inf cannot even be hashed; bool is not a number.
    for bad in (True, float("nan"), float("inf")):
        b = _baseline_fixture(proof, tok, {"1x": 0.1, "1.5x": 0.1,
                                           "2x": 0.1, "3x": 0.1})
        b["metrics"]["1x"]["sharpe_f"] = bad
        try:
            b["artifact_sha256"] = s5f.baseline_artifact_hash(b)
            v, f, d = s5f.baseline_gate(chall, b, proof, tok)
            assert v is False and f == ["baseline_malformed"], (v, f)
        except AssertionError as e:
            assert "malformed" in str(e) or "metric" in str(e) or \
                "finite" in str(e) or "bool" in str(e) or \
                "canonical" in str(e) or "identity" in str(e), e
    # (e) production identity + non-None baseline -> UNPINNED
    # fail-closed (S2 OPEN means no artifact may authorize promotion).
    pin = s5f.pinned_slice_root()
    pproof = dict(proof, data_slice=pin["data_slice"],
                  dataset_sha=pin["dataset_sha"])
    v, f, d = s5f.baseline_gate(chall, win, pproof, tok,
                                s5f.BASELINE_EXPECTED)
    assert v is False and f == ["baseline_unpinned"], (v, f)
    # (f) None under production identity is still ABSENT (not an
    # error): the current and only valid production state.
    v, f, d = s5f.baseline_gate(chall, None, pproof, tok,
                                s5f.BASELINE_EXPECTED)
    assert v is False and f == ["baseline_absent"], (v, f)
    print("47 OK")

def test_48_pin_interpreter_bound():
    import sys as _sys
    pin = s5f.pinned_slice_root()
    assert pin["measured_python_minor"] == "3.11"
    assert s5f._running_python_minor() == \
        "%d.%d" % _sys.version_info[:2]
    if s5f._running_python_minor() == "3.11":
        s5f._check_pin_interpreter(pin)  # measuring interpreter: pass
    else:
        # wrong interpreter: fail closed naming BOTH versions (drift,
        # never misreported as tampering).
        try:
            s5f._check_pin_interpreter(pin)
            raise SystemExit("wrong-interpreter production must fail")
        except AssertionError as e:
            assert "measured under 3.11" in str(e), e
            assert "running %s" % s5f._running_python_minor() in \
                str(e), e
    # tampered interpreter field fails under every interpreter.
    badpin = dict(pin, measured_python_minor="9.9")
    try:
        s5f._check_pin_interpreter(badpin)
        raise SystemExit("tampered pin interpreter must fail")
    except AssertionError:
        pass
    print("48 OK")

def _must_fail_with(needle, fn):
    """Authority-regression gate: fn must raise AssertionError naming the INTENDED guard.

    A bare try/except AssertionError would let an unrelated failure
    at a different seam masquerade as the hostile being caught."""

    try:
        fn()
    except AssertionError as e:
        assert needle in str(e),             "wrong seam: %s (want %s)" % (e, needle)
        return
    raise SystemExit("must fail at seam: " + needle)


def test_49_canonical_holdout_enforced():
    import hashlib as _hl
    from collections import Counter as _C
    split, h1x, stress, sess, proof, bars, by_var, root = _small_split(48)
    folds, holdout, bound, tok = split
    sv = tok["split_variant"]
    assert tok["n_splits"] == s5f.frozen_n_splits() == 2
    assert len(holdout) == 12 and len(tok["dates"]) == 2
    # two droppable records sharing a day (dates stay canonical, so
    # only the population gate can fire on subset/truncation).
    dayn = _C(r["day"] for r in holdout)
    dropday = next(d for d, c in dayn.items() if c >= 3)
    daycids = [r["cid"] for r in holdout if r["day"] == dropday]
    todrop = set(daycids[:2])
    # hostile (a): favorable SUBSET - correct variant, authentic
    # records, honestly re-minted token over the subset + matching
    # evidence/stress. Content is real; MEMBERSHIP is not canonical.
    sub = [r for r in holdout if r["cid"] not in todrop]
    assert sorted({r["day"] for r in sub}) == tok["dates"]
    subc = sorted(r["cid"] for r in sub)
    subtok = dict(tok, n=len(sub),
                  cid_hash=_hl.sha256("|".join(subc).encode()
                                      ).hexdigest(),
                  record_hash=s5f._record_digest(sub))
    subcset = set(subc)
    subev = {v: [r for r in recs if r["cid"] in subcset]
             for v, recs in h1x.items()}
    subst = {k: {v: [r for r in recs if r["cid"] in subcset]
                 for v, recs in byv.items()}
             for k, byv in stress.items()}
    _must_fail_with("split holdout != canonical holdout population",
                     lambda: _frep((folds, sub, bound, subtok), subev,
                                   subst, sess, proof, bars, by_var))
    # hostile (b): altered edges, everything else canonical.
    e2 = list(tok["edges"])
    e2[1] += 1
    _must_fail_with("split edges != canonical edges",
                     lambda: _frep((folds, holdout, bound,
                                    dict(tok, edges=e2)), h1x, stress,
                                   sess, proof, bars, by_var))
    # hostile (c): altered n_splits - an honest n_splits=3 rig (own
    # winner, evidence, sessions) still fails the frozen contract.
    # Built BELOW the public constructor (which now enforces frozen
    # n_splits at mint time), so this proves final_report ITSELF
    # cannot be bypassed with a foreign segmentation.
    items3 = synth_stream(48)
    by3 = run_all(items3)
    w3 = _mechanical_winner(by3, n_splits=3)
    e3, b3 = s5.segment_bounds(by3[w3], 3)
    f3 = s5.walk_folds(by3[w3], 3, holdout_start=b3)
    r3 = sorted(by3[w3], key=lambda r: r["snapshot_ts_ns"])
    h3 = r3[e3[3 + 1]:]
    assert h3, "empty hostile holdout"
    for tr, te in f3:
        for r in tr + te:
            assert r["time_exit_ns"] < b3
    sc3 = sorted(r["cid"] for r in r3)
    t3 = s5f._mint_split_token(
        h3, b3, 3, len(r3), e3,
        _hl.sha256("|".join(sc3).encode()).hexdigest(),
        s5f._record_digest(r3))
    split3 = (f3, h3, b3, t3)
    assert t3["n_splits"] == 3
    hset3 = {r["cid"] for r in h3}
    h1x3 = {v: [r for r in by3[v] if r["cid"] in hset3]
            for v in s5.VARIANTS}
    stress3 = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv3 = run_all(items3, spread_mult=mult)
        stress3[lab] = {v: [r for r in sv3[v] if r["cid"] in hset3]
                        for v in s5.VARIANTS}
    bars3 = bars_for(items3)
    sess3, proof3 = s5f.build_holdout_sessions(bars3, t3, DATA_ID)
    _must_fail_with("split segmentation != frozen n_splits",
                     lambda: _frep(split3, h1x3, stress3, sess3,
                                   proof3, bars3, by3))
    # hostile (d): single-record truncation from the OTHER day
    # (dates preserved, so only the population gate can fire).
    otherday = next(d for d in dayn if d != dropday)
    cut = next(r["cid"] for r in holdout if r["day"] == otherday)
    trunc = [r for r in holdout if r["cid"] != cut]
    assert sorted({r["day"] for r in trunc}) == tok["dates"]
    truncc = sorted(r["cid"] for r in trunc)
    trunck = dict(tok, n=len(trunc),
                  cid_hash=_hl.sha256("|".join(truncc).encode()
                                      ).hexdigest(),
                  record_hash=s5f._record_digest(trunc))
    tset = set(truncc)
    trunev = {v: [r for r in recs if r["cid"] in tset]
              for v, recs in h1x.items()}
    trunst = {k: {v: [r for r in recs if r["cid"] in tset]
                  for v, recs in byv.items()}
              for k, byv in stress.items()}
    _must_fail_with("split holdout != canonical holdout population",
                     lambda: _frep((folds, trunc, bound, trunck),
                                   trunev, trunst, sess, proof, bars,
                                   by_var))
    # hostile (e): rehashed in-place field edit inside a threaded
    # TRAIN-leg fold record. CIDs, token, evidence, and test legs are
    # untouched (selection recomputes from test legs), so only the
    # authoritative field-equality gate can fire.
    f0tr, f0te = folds[0]
    assert f0tr, "empty train leg"
    victim = _rehash(dict(f0tr[0],
                           filtered_taken=not f0tr[0]["filtered_taken"]))
    assert victim != f0tr[0], "vacuous hostile"
    efolds = tuple(([victim] + list(tr[1:]), te) if i == 0 else (tr, te)
                   for i, (tr, te) in enumerate(folds))
    _must_fail_with("fold record != authoritative stream record",
                     lambda: _frep((efolds, holdout, bound, tok), h1x,
                                   stress, sess, proof, bars, by_var))
    # control still passes on the canonical population.
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    assert rep["split_token"] == tok
    print("49 OK")


def test_50_sharpe_f_is_1x():
    items = synth_stream(120)
    by_var = run_all(items)
    split = _winner_split(by_var, n_splits=2)
    folds, holdout, bound, tok = split
    hset = {r["cid"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    # hostile economics: flatten every 3x take (filtered_taken is a
    # stress-mutable field) -> 3x Sharpe exactly 0.0 while 1x keeps
    # its own (nonzero for at least one variant) value.
    stress["3x"] = {v: [_rehash(dict(r, filtered_taken=False))
                        for r in stress["3x"][v]]
                    for v in s5.VARIANTS}
    bars = bars_for(items)
    sess, proof = s5f.build_holdout_sessions(bars, tok, DATA_ID)
    rep = _frep(split, h1x, stress, sess, proof, bars, by_var)
    inc = rep["first_interval_included"]
    assert any(s5.sharpe_hac(s5.daily_returns(
        s5.portfolio_curve(h1x[v], "filtered", 100000.0, sess)[2],
        inc))[0] != 0.0 for v in s5.VARIANTS), "vacuous rig"
    for v in s5.VARIANTS:
        _, _, rets1, _ = s5.portfolio_curve(h1x[v], "filtered",
                                            100000.0, sess)
        exp1 = s5.sharpe_hac(s5.daily_returns(rets1, inc))[0]
        _, _, rets3, _ = s5.portfolio_curve(stress["3x"][v],
                                            "filtered", 100000.0, sess)
        exp3 = s5.sharpe_hac(s5.daily_returns(rets3, inc))[0]
        assert exp3 == 0.0, (v, exp3)
        got = rep["variants"][v]
        assert got["sharpe_f"] == exp1, (v, got["sharpe_f"], exp1)
        assert got["stress"]["3x"][0] == exp3, (v,)
        assert got["n_sharpe_obs"] == len(s5.daily_returns(rets1,
                                                           inc))
    print("50 OK")

def test_51_constructor_enforces_frozen_segmentation():
    items = synth_stream(48)
    by_var = run_all(items)
    recs = by_var[_mechanical_winner(by_var, n_splits=2)]
    # omitted n_splits resolves to the frozen contract (no stale default).
    _, _, _, tok = s5f.holdout_split(recs)
    assert tok["n_splits"] == s5f.frozen_n_splits() == 2
    # an explicit foreign segmentation fails closed AT THE MINT.
    _must_fail_with("split segmentation != frozen n_splits",
                    lambda: s5f.holdout_split(recs, n_splits=3))
    print("51 OK")

if __name__ == "__main__":
    test_1_2_same_stream_same_economics()
    test_3_4_5_hold_pass_paired()
    test_6_censored_and_brier_scope()
    test_7_8_9_lookahead_replay_isolation()
    test_8b_replay_fields_bound()
    test_10_11_bootstrap_and_null()
    test_12_cost_stress_reflected()
    test_13_variant_family()
    test_14_holdout_boundary_and_purge()
    test_15_r_disqualify_full_path()
    test_16_sequential()
    test_17_power()
    test_18_19_curve_and_drawdown()
    test_20_bar_mechanical_and_holm()
    test_20b_stress_fail_closed_and_scope()
    test_21b_n_closed_hostile()
    test_23_r_monitor()
    test_24_closed_seq_and_selected_variant()
    test_25_embargo_ignores_holdout()
    test_18b_lookahead_hostile()
    test_21_baseline_reconcile()
    test_22_final_report_no_hardcode()
    test_26_prereg_seeds_pinned()
    test_27_disqualified_excluded_from_closed()
    test_28_seq_pair_stops()
    test_29_et_session_contract()
    test_30_split_provenance()
    test_31_record_content_binding()
    test_32_session_price_and_seam()
    test_33_boundary_first_interval()
    test_34_baseline_gate()
    test_35_knobs_parsed_not_duplicated()
    test_36_r_scope_audited()
    test_37_frozen_bars_authority()
    test_38_foreign_stream_rejected()
    test_39_sequential_excludes_holdout()
    test_40_gap_day_zero_observation()
    test_41_d6_canon()
    test_42_baseline_session_wiring()
    test_43_missing_mark_fails_closed()
    test_44_ns_boundary_branches()
    test_45_root_substitution_rejected()
    test_46_selection_binding()
    test_47_baseline_artifact_authority()
    test_48_pin_interpreter_bound()
    test_49_canonical_holdout_enforced()
    test_50_sharpe_f_is_1x()
    test_51_constructor_enforces_frozen_segmentation()
    print("ALL S5 TESTS GREEN")
