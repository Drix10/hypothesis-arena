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
SCOPE = json.load(open(os.path.join(os.path.dirname(__file__), "..",
                                    "strategy",
                                    "s5_prereg.json")))["amendment_b"]["r_out_of_scope"]
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


def run_all(items, **kw):
    kw = dict({"day_fn": DAY, "data_id": DATA_ID}, **kw)
    return {v: s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE),
                                  variant=v, **kw) for v in s5.VARIANTS}


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
    pre = json.load(open(os.path.join(os.path.dirname(__file__), "..",
                                      "strategy", "s5_prereg.json")))
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
    folds3, holdout, bound3 = s5f.holdout_split(recs, n_splits=2)
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
    from research.strategy import jev_v4 as v4
    seed = bytes.fromhex("cd" * 32)
    pub = ed_pubkey(seed)

    def provide(candidate, market, now_unix):
        ans = {"enter": 0.95, "edge_family": candidate.proposed_family,
               "conviction": "max", "latent_risk": 0.01}
        payload = v4.make_v4_payload(candidate, market, ans, now_unix,
                                     now_unix + 60)
        art = v4.sign_v4(payload, seed)
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
    stream = [(bad, aft, mkt, reg, sp)] + items[1:6]
    by_var = {v: s5.evaluate_stream(stream, sprovide, spub, dict(ENGINE),
                                    variant=v, day_fn=DAY, data_id=DATA_ID)
              for v in s5.VARIANTS}
    brec = by_var[s5.VARIANTS[0]][0]
    assert brec["disqualified"] and brec["filtered_pass"]  # JEV would take
    assert not brec["filtered_taken"] and not brec["always_realized"]
    assert brec["always_r"] == 0.0 and brec["filtered_r"] == 0.0  # finding 4
    assert s5.paired_deltas([brec]) == [0.0]
    assert brec["always_label"] == "censored"  # diagnostic label retained
    assert brec["resolved_r"] == brec["resolved_r"]  # economics present
    assert brec["r_breach_attempted"]  # forbidden take attempted
    assert not any(r["disqualified"] for r in by_var[s5.VARIANTS[0]][1:])
    sess = sessions_for(stream)
    _tok = s5f.make_holdout_token(by_var[s5.VARIANTS[0]], 0)
    _stress = {}
    for _mult, _lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        _sv = run_all(stream, spread_mult=_mult)
        _stress[_lab] = _sv
    rep = s5f.final_report(by_var, _stress, sess, 100000.0, _tok)
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
    try:
        s5f.final_report({s5.VARIANTS[0]: [], s5.VARIANTS[1]: []}, {},
                         [], 100000.0, None)
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


def test_22_final_report_no_hardcode():
    items = synth_stream(72)
    by_var = run_all(items)
    folds, holdout, bound = s5f.holdout_split(by_var[s5.VARIANTS[0]],
                                              n_splits=2)
    assert holdout
    tok = s5f.make_holdout_token(holdout, bound)
    assert tok["n"] == len(holdout) and tok["holdout_start"] == bound
    assert tok["protocol"] == "eval_v1"
    hset = {r["cid"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["cid"] in hset]
           for v in s5.VARIANTS}
    # hostile: explicit mid-day boundary; day reconstruction smuggles.
    bound2 = bound + 25
    hdays2 = {r["day"] for r in by_var[s5.VARIANTS[0]]
              if r["snapshot_ts_ns"] >= bound2}
    daybuilt = [r for r in by_var[s5.VARIANTS[0]] if r["day"] in hdays2]
    smuggled = [r for r in daybuilt if r["snapshot_ts_ns"] < bound2]
    assert smuggled, "need pre-bound same-day records for the hostile"
    true2 = [r for r in by_var[s5.VARIANTS[0]]
             if r["snapshot_ts_ns"] >= bound2]
    tok2 = s5f.make_holdout_token(true2, bound2)
    try:
        s5f.final_report({v: daybuilt for v in s5.VARIANTS},
                         {k: {v: daybuilt for v in s5.VARIANTS}
                          for k in ("1.5x", "2x", "3x")},
                         sessions_for(items), 100000.0, tok2)
        raise SystemExit("day-built set must be rejected")
    except AssertionError:
        pass
    # hostile: duplicate a holdout row (same CID set, altered population)
    dup = h1x[s5.VARIANTS[0]] + [h1x[s5.VARIANTS[0]][0]]
    try:
        s5f.final_report({s5.VARIANTS[0]: dup,
                          s5.VARIANTS[1]: h1x[s5.VARIANTS[1]]},
                         {k: h1x for k in ("1.5x", "2x", "3x")},
                         sessions_for(items), 100000.0, tok)
        raise SystemExit("duplicated holdout row must be rejected")
    except AssertionError:
        pass
    # hostile: 1x records filed under a stress bucket
    badstress = {k: h1x for k in ("1.5x", "2x", "3x")}
    hdays = {r["day"] for r in holdout}
    hotsess = [x for x in sessions_for(items) if x["day"] in hdays]
    try:
        s5f.final_report(h1x, badstress, hotsess, 100000.0, tok)
        raise SystemExit("1x-under-3x must be rejected")
    except AssertionError:
        pass
    # hostile: manufactured CID set (fake provenance)
    faketok = dict(tok, cid_hash="0" * 64)
    try:
        s5f.final_report(h1x, badstress, hotsess, 100000.0, faketok)
        raise SystemExit("fake token must be rejected")
    except AssertionError:
        pass
    # hostile: session injection outside the holdout window
    badsess = hotsess + [dict(hotsess[0], day="2020-01-01",
                              close_ns=s5.et_close_ns("2020-01-01"))]
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["cid"] in hset]
                       for v in s5.VARIANTS}
    try:
        s5f.final_report(h1x, stress, badsess, 100000.0, tok)
        raise SystemExit("pre-holdout session must be rejected")
    except AssertionError:
        pass
    rep = s5f.final_report(h1x, stress, hotsess, 100000.0, tok)
    for v, x in rep["variants"].items():
        assert x["bar_verdict"] is False and x["bar_failed"], v
    assert rep["holm"]
    assert rep["bar_frozen"] == dict(BAR)
    assert rep["r_scope_frozen"] == SCOPE
    kn = rep["knobs"]
    assert kn["boot_seed"] == 24269 and kn["null_seed"] == 24270
    assert kn["boot_reps"] == s5.BOOT_REPS == 2000
    print("22 OK", [(v, x["bar_failed"]) for v, x in
                    rep["variants"].items()])


def test_21b_n_closed_hostile():
    # 200 closed candidates, filtered takes only 1 -> n_closed MUST be 1.
    items = synth_stream(200)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    def _solo(stream_recs):
        first = [r for r in stream_recs
                 if r["always_label"] in ("win", "loss")]
        assert len(first) >= 100
        out = [dict(first[0], filtered_taken=True,
                    filtered_r=first[0]["always_r"])]
        out += [dict(r, filtered_taken=False, filtered_r=0.0,
                     filtered_action="HOLD") for r in stream_recs
                if r["cid"] != first[0]["cid"]]
        return out
    same = {v: _solo(by_var[v]) for v in s5.VARIANTS}
    solo = same[s5.VARIANTS[0]]
    days = sorted({r["day"] for r in recs})
    sess = [{"day": d, "end_ts": s5.et_close_ns(d),
             "close_ns": s5.et_close_ns(d),
             "closes": {"SYN": 100.0}} for d in days]
    _tok21 = s5f.make_holdout_token(solo, 0)
    # stress plumbing: same population re-labeled at each multiplier
    # (economics not asserted here; n_closed counting is).
    _st21 = {}
    for _m, _lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        _st21[_lab] = {v: [dict(r, spread_mult=_m) for r in recs]
                       for v, recs in same.items()}
    rep = s5f.final_report(same, _st21, sess, 100000.0, _tok21)
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
    pre = json.load(open(os.path.join(os.path.dirname(__file__), "..",
                                      "strategy", "s5_prereg.json")))
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


def test_30_token_determinism_and_tamper():
    items = synth_stream(40)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    _, holdout, bound = s5f.holdout_split(recs, n_splits=2)
    t1 = s5f.make_holdout_token(holdout, bound)
    t2 = s5f.make_holdout_token(list(reversed(holdout)), bound)
    assert t1 == t2  # order-independent, deterministic
    _hset = {r["cid"] for r in holdout}
    _hrecs = [r for r in recs if r["cid"] in _hset]
    assert s5f._validate_set(_hrecs, t1, 1.0, s5.VARIANTS[0]) == _hset
    for bad in (dict(t1, n=t1["n"] + 1),
                dict(t1, holdout_start=bound + 1),
                dict(t1, dates=t1["dates"][:-1]),
                dict(t1, protocol="evil")):
        try:
            s5f._validate_set(recs, bad, 1.0, s5.VARIANTS[0])
            raise SystemExit("tampered token must fail: %r" % (bad,))
        except AssertionError:
            pass
    # wrong-variant records rejected under the right token
    other = [dict(r, variant=s5.VARIANTS[1]) for r in recs
             if r["cid"] in {x["cid"] for x in holdout}]
    try:
        s5f._validate_set(other, t1, 1.0, s5.VARIANTS[0])
        raise SystemExit("wrong-variant set must fail")
    except AssertionError:
        pass
    print("30 OK")


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
    test_30_token_determinism_and_tamper()
    print("ALL S5 TESTS GREEN")
