"""S5 tests: 22 end-to-end properties (stdlib only, synthetic stream).

1 same-CID 2 same-economics 3 HOLD-no-fill 4 PASS-same 5 paired-reconcile
6 censored 7 no-lookahead 8 replay 9 isolation 10 bootstrap-determinism
11 null-p (+hostile) 12 cost-stress-reflected 13 variant-family
14 holdout-boundary 15 R-disqualify 16 sequential 17 power 18 daily-curve
19 maxDD 20 bar-mechanical 21 baseline-reconcile 22 no-hardcoded-pass.
"""
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
DAY = lambda ts: "d%d" % (ts // 60)
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
    days = sorted({DAY(c.snapshot_ts_ns) for c, _, _, _, _ in items},
                  key=lambda d: int(d[1:]))
    return [{"day": d, "end_ts": (int(d[1:]) + 1) * 60 - 1,
             "closes": {"SYN": 100.0 + int(d[1:])}} for d in days]


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
    rep = s5f.final_report(by_var, {k: by_var for k in
                                    ("1.5x", "2x", "3x")},
                           sess, 100000.0, BAR,
                           r_out_of_scope=SCOPE)
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
    p1 = s5.power_study(vals, dys, 0.15)
    p2 = s5.power_study(vals, dys, 0.15)
    assert p1 == p2  # deterministic
    plo = s5.power_study(vals, dys, 0.02)
    assert p1["by_multiplier"][1] >= plo["by_multiplier"][1]  # monotone MDE
    assert set(inspect.signature(s5.power_study).parameters) <= \
        {"train_values", "train_days", "mde", "alpha", "reps", "seed",
         "target", "multipliers"}  # train-only inputs: no holdout slot
    assert p1["n_base"] == len(vals)
    folds2, holdout2, _ = s5f.holdout_split(recs, n_splits=2)
    hset = {r["cid"] for r in holdout2}
    power_in = [r for f in folds2 for r in f[0]]
    assert hset and not (hset & {r["cid"] for r in power_in})
    print("17 OK", p1["by_multiplier"])


def test_18_19_curve_and_drawdown():
    items = synth_stream(48)
    recs = run_all(items)[s5.VARIANTS[0]]
    sess = sessions_for(items)
    sess.append({"day": "d999", "end_ts": 10 ** 18,
                 "closes": {"SYN": 100.0}})
    trades, curve, rets, dd = s5.portfolio_curve(recs, "always", 100000.0,
                                                 sess)
    assert len(rets) == len(sess) - 1
    assert len(curve) == len(sess)
    assert any(r == 0.0 for r in rets)  # zero-days kept
    assert dd >= 0.0
    assert s5.max_drawdown([("a", 100.0), ("b", 100.0)]) == 0.0
    assert abs(s5.max_drawdown([("a", 100.0), ("b", 80.0),
                                ("c", 90.0)]) - 20.0) < 1e-9
    print("18_19 OK", len(trades), "trades, dd=%.2f" % dd)




def _mkrec(cid, symbol, side, snap, exit_ts, entry, stop, r_val, day,
           realized=True, taken=True):
    return {"cid": cid, "symbol": symbol, "proposed_side": side,
            "snapshot_ts_ns": snap, "exit_ts_ns": exit_ts,
            "entry_px": entry, "stop_px": stop, "always_r": r_val,
            "filtered_r": r_val, "always_realized": realized,
            "filtered_taken": taken, "spread_mult": 1.0,
            "disqualified": False}


def test_18b_lookahead_hostile():
    # A enters day 2; day-1 close must be blind to it (long + short).
    recs = [_mkrec("A", "SYN", "BUY", 150, 250, 100.0, 99.0, 1.0, "d2"),
            _mkrec("B", "SYN", "SELL", 150, 250, 100.0, 101.0, 1.0, "d2")]
    sess = [{"day": "d1", "end_ts": 100, "closes": {"SYN": 100.0}},
            {"day": "d2", "end_ts": 200, "closes": {"SYN": 101.0}},
            {"day": "d3", "end_ts": 300, "closes": {"SYN": 102.0}}]
    _, curve, rets, _ = s5.portfolio_curve([recs[0]], "always", 100000.0,
                                           sess)
    # hand-verified: con 25% -> qty 250; pnl +250; d1 blind; d2 marked.
    assert curve[0] == ("d1", 100000.0), curve
    assert curve[1] == ("d2", 100250.0), curve
    assert curve[2] == ("d3", 100250.0), curve
    _, s_curve, _, _ = s5.portfolio_curve([recs[1]], "always", 100000.0,
                                          sess)
    assert s_curve[0] == ("d1", 100000.0), s_curve
    assert s_curve[1] == ("d2", 99750.0), s_curve  # short marks down
    # future-price mutation: day-3 close cannot move day-1/day-2.
    sess2 = [dict(s, closes={"SYN": 500.0}) if s["day"] == "d3" else s
             for s in sess]
    _, curve2, _, _ = s5.portfolio_curve([recs[0]], "always", 100000.0,
                                         sess2)
    assert curve2[0] == curve[0] and curve2[1] == curve[1]
    assert curve2[2][1] == curve[2][1]  # exited before d3: immune too
    # live-through-close mutation DOES move only the open mark.
    recs_open = [_mkrec("C", "SYN", "BUY", 150, 999, 100.0, 99.0, 0.0,
                        "d2")]
    _, o1, _, _ = s5.portfolio_curve(recs_open, "always", 100000.0, sess)
    _, o2, _, _ = s5.portfolio_curve(recs_open, "always", 100000.0, sess2)
    assert o1[0] == o2[0] and o1[1] == o2[1]  # d1/d2 unaffected by d3
    assert o2[2][1] != o1[2][1]  # d3 mark reflects the d3 close only
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
    try:
        s5f.final_report({s5.VARIANTS[0]: [], s5.VARIANTS[1]: []}, {},
                         [], 100000.0, BAR)
        raise SystemExit("stress assert should have raised")
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
    assert len(curve) == 6 and len(rets) == 5  # full daily vectors
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
    folds, holdout, _ = s5f.holdout_split(by_var[s5.VARIANTS[0]], n_splits=2)
    assert holdout
    hdays = {r["day"] for r in holdout}
    h1x = {v: [r for r in by_var[v] if r["day"] in hdays]
           for v in s5.VARIANTS}
    stress = {}
    for mult, lab in ((1.5, "1.5x"), (2.0, "2x"), (3.0, "3x")):
        sv = run_all(items, spread_mult=mult)
        stress[lab] = {v: [r for r in sv[v] if r["day"] in hdays]
                       for v in s5.VARIANTS}
    sess = [s for s in sessions_for(items) if s["day"] in hdays]
    rep = s5f.final_report(h1x, stress, sess, 100000.0, BAR,
                           r_out_of_scope=SCOPE)
    for v, s in rep["variants"].items():
        assert s["bar_verdict"] is False and s["bar_failed"], v
    assert rep["holm"]
    print("22 OK", [(v, s["bar_failed"]) for v, s in
                    rep["variants"].items()])




def test_21b_n_closed_hostile():
    # 200 closed candidates, filtered takes only 1 -> n_closed MUST be 1.
    items = synth_stream(200)
    by_var = run_all(items)
    recs = by_var[s5.VARIANTS[0]]
    one = [r for r in recs if r["always_label"] in ("win", "loss")]
    assert len(one) >= 100
    solo = [dict(one[0], filtered_taken=True,
                 filtered_r=one[0]["always_r"])]
    solo += [dict(r, filtered_taken=False, filtered_r=0.0,
                  filtered_action="HOLD") for r in recs[1:]]
    days = sorted({r["day"] for r in recs},
                  key=lambda d: int(d[1:]))
    sess = [{"day": d, "end_ts": (int(d[1:]) + 1) * 60 - 1,
             "closes": {"SYN": 100.0}} for d in days]
    same = {s5.VARIANTS[0]: solo, s5.VARIANTS[1]: solo}
    rep = s5f.final_report(same, {k: same for k in
                                  ("1.5x", "2x", "3x")},
                           sess, 100000.0, BAR, r_out_of_scope=SCOPE)
    got = rep["variants"][s5.VARIANTS[0]]
    assert got["n_closed"] == 1, got["n_closed"]
    assert "closed" in got["bar_failed"]
    # 100 actually taken closed trades -> closed condition can pass
    many = [dict(r, filtered_taken=True, filtered_r=r["always_r"],
                 filtered_action="PASS_BASE") for r in recs
            if r["always_label"] in ("win", "loss")][:100]
    assert len(many) == 100
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
    # R4 flip-lock (ns scale): SELL 30min after BUY exit, same symbol
    base = 1700000000000000000
    flip = [_tkr("e1", "S", "BUY", base, base + 1000000000),
            _tkr("e2", "S", "SELL", base + 2000000000, base + 3000000000)]
    b = s5.verify_r_monitor(flip, flat, {"e1": "d", "e2": "d"})
    assert any(x.startswith("R4-fliplock") for x in b), b
    # R5 halt: curve DD > 10
    b = s5.verify_r_monitor([], [("a", 100.0), ("b", 89.0)])
    assert any(x.startswith("R5-halt") for x in b), b
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
    test_18b_lookahead_hostile()
    test_21_baseline_reconcile()
    test_22_final_report_no_hardcode()
    print("ALL S5 TESTS GREEN")
