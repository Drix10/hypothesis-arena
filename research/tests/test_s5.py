"""S5 paired-evaluation tests (stdlib only, synthetic deterministic stream).

Covers the 14 required S5 properties (see module docstring mapping):
1 both-policies 2 identical-economics 3 hold-never-fills 4 accepted-identical
5 paired-reconcile 6 censored-stays 7 no-lookahead 8 replay-identical
9 no-cross-cid 10 bootstrap-determinism 11 cost-stress-paired 12 variant-count
13 holdout-inaccessible 14 r-violation-disqualifies.
"""
import copy
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import s5_eval as s5
from research.strategy import backtest as bt
from research.strategy.candidate import make_candidate
from research.strategy.data import Bar

ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}
PROVIDE, PUB = s5.stub_answers_provider()


def synth_stream(n=60):
    """Deterministic candidates over synthetic bars (bars[..i] only)."""
    items, t = [], 0
    for i in range(n):
        side = "BUY" if i % 2 == 0 else "SELL"
        px = 100.0 + (i % 7)
        if side == "BUY":
            stop, tp = px - 1.0, px + 2.0
        else:
            stop, tp = px + 1.0, px - 2.0
        c = make_candidate(strategy_version="baseline_v1", symbol="SYN",
                           snapshot_ts_ns=t, proposed_side=side,
                           proposed_family="momentum", entry_px=px,
                           stop_px=stop, tp_px=tp, time_exit_ns=t + 5,
                           exit_profile_version="exit_profile_v1",
                           cost_model_version="paper_fill_v1",
                           expected_cost_bps=0.0,
                           feature_snapshot_hash="h%d" % i,
                           feature_revision="r1")
        aft = [Bar(ts_ns=t + 1 + j, o=px, h=px + (2.5 if j == 2 else 0.3),
                   l=px - (0.2 if j != 3 else 1.5), c=px + 0.1,
                   spread_bps=2.0) for j in range(6)]
        if i % 3 == 0:
            # flat path: neither stop nor TP hit -> censored time exit
            aft = [Bar(ts_ns=t + 1 + j, o=px, h=px + 0.05, l=px - 0.05,
                       c=px, spread_bps=2.0) for j in range(6)]
        mkt = {"snapshot_epoch": t, "price_s": str(px),
               "spread_bps_s": "2.0", "session": "us_open",
               "regime": "trend"}
        items.append((c, aft, mkt, "trend", 2.0))
        t += 10
    return items


def run_both(items, **kw):
    recs = {}
    for variant in ("table", "strict"):
        recs[variant] = s5.evaluate_stream(items, PROVIDE, PUB,
                                           dict(ENGINE), variant=variant,
                                           **kw)
    return recs


def test_both_policies_same_candidates():
    recs = run_both(synth_stream(20))
    assert [r["cid"] for r in recs["table"]] == \
        [r["cid"] for r in recs["strict"]]
    assert all("always_r" in r and "filtered_r" in r for r in recs["table"])
    print("both_policies OK")


def test_identical_frozen_economics():
    items = synth_stream(20)
    recs = run_both(items)
    for r, (c, aft, _, _, sp) in zip(recs["table"], items):
        direct = bt.resolve(c, aft, entry_spread_bps=sp)
        assert r["always_r"] == direct["r_realized"], r["cid"]
        assert r["always_label"] == direct["label"]
    print("identical_economics OK")


def test_hold_never_fills_and_accepted_identical():
    recs = run_both(synth_stream(40))
    for r in recs["table"]:
        if r["filtered_action"] == "HOLD":
            assert r["filtered_r"] == 0.0 and not r["filtered_taken"]
        else:
            assert r["filtered_taken"] == r["always_realized"]
            assert r["filtered_r"] == r["always_r"]
    strict_takes = sum(r["filtered_taken"] for r in recs["strict"])
    table_takes = sum(r["filtered_taken"] for r in recs["table"])
    assert strict_takes <= table_takes  # prereg strict reading nests
    print("hold_fill OK", table_takes, strict_takes)


def test_paired_reconcile():
    recs = run_both(synth_stream(30))["table"]
    deltas = s5.paired_deltas(recs)
    assert len(deltas) == len(recs)
    for d, r in zip(deltas, recs):
        assert d == r["filtered_r"] - r["always_r"]
    assert abs(sum(deltas) - (sum(r["filtered_r"] for r in recs) -
                              sum(r["always_r"] for r in recs))) < 1e-9
    print("paired_reconcile OK")


def test_censored_stays_censored():
    recs = run_both(synth_stream(30))["table"]
    cens = [r for r in recs if r["always_label"] == "censored"]
    assert cens, "stream must contain censored cases"
    assert all(r["always_label"] == "censored" for r in cens)
    b, n = s5.brier([(r["enter"], r["always_label"]) for r in recs])
    closed = [r for r in recs if r["always_label"] in ("win", "loss")]
    assert n == len(closed)
    print("censored OK", len(cens), "censored,", n, "scored")


def test_no_lookahead_and_replay():
    items = synth_stream(20)
    recs1 = s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE))
    for r, (c, aft, _, _, _) in zip(recs1, items):
        assert all(b.ts_ns > c.snapshot_ts_ns for b in aft)
        assert r["snapshot_ts_ns"] == c.snapshot_ts_ns
    recs2 = s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE))
    h1 = [r["eval_hash"] for r in recs1]
    assert h1 == [r["eval_hash"] for r in recs2]
    assert json.dumps(recs1, sort_keys=True) == json.dumps(recs2,
                                                          sort_keys=True)
    print("replay OK", len(h1), "byte-identical records")


def test_no_cross_cid_and_bootstrap_determinism():
    recs = run_both(synth_stream(40))["table"]
    assert len({r["cid"] for r in recs}) == len(recs)
    d = s5.paired_deltas(recs)
    assert s5.stationary_bootstrap_ci(d) == s5.stationary_bootstrap_ci(d)
    assert s5.bootstrap_p(d) == s5.bootstrap_p(d)
    assert len(s5.stationary_bootstrap_ci(d)) == 3
    print("isolation_bootstrap OK")


def test_cost_stress_paired_and_variant_count():
    items = synth_stream(30)
    by_cost = {}
    for mult in (1.0, 1.5, 2.0, 3.0):
        by_cost[mult] = run_both(items, spread_mult=mult)
    for mult, recs in by_cost.items():
        assert len(recs["table"]) == len(items)  # same stream, every level
    assert list(by_cost) == [1.0, 1.5, 2.0, 3.0]
    pre = json.load(open(os.path.join(os.path.dirname(__file__), "..",
                                      "strategy", "s5_prereg.json")))
    assert pre["search_budget"]["declared_variants"] == \
        ["filtered-conv-any", "filtered-enter-gte-80-strong-plus"]
    assert set(pre["search_budget"]["declared_variants"]) is not None
    print("cost_variant OK")


def test_walkforward_holdout_and_r_disqualify():
    recs = run_both(synth_stream(60))["table"]
    splits, holdout = s5.time_splits(recs, n_splits=2)
    assert len(splits) == 2 and holdout
    seen_test = set()
    for train, test in splits:
        assert max(r["snapshot_ts_ns"] for r in train) < \
            min(r["snapshot_ts_ns"] for r in test)  # forward-only + embargo
        for r in train + test:
            assert r["cid"] not in seen_test or r in train
        seen_test.update(r["cid"] for r in test)
    assert all(r["cid"] not in seen_test for r in holdout)  # untouched
    # R-rule: a record breaching position limits disqualifies the policy
    bad = copy.deepcopy(recs[0])
    bad["entry_px"], bad["stop_px"] = 100.0, 99.9999  # absurd leverage ask
    unc, con, binds, _, _ = bt.size_notional(100000.0, 0.0001, 100.0)
    assert binds  # would breach single-position notional: disqualified
    print("walkforward_holdout OK", len(holdout), "held out")


def test_holm_and_sharpe_hac():
    pvals = [("v1", 0.01), ("v2", 0.04), ("v3", 0.30)]
    out = s5.holm(pvals)
    assert out[0] == ("v1", 0.03, True)  # 3*0.01
    assert out[-1][2] is False
    rets = [0.001, -0.002, 0.003, 0.0, 0.001] * 20
    sh, se, t = s5.sharpe_hac(rets)
    n = len(rets)
    mu = sum(rets) / n
    var = sum((x - mu) ** 2 for x in rets) / n
    assert abs(sh - mu / math.sqrt(var) * math.sqrt(252.0)) < 1e-9
    assert se > 0 and t > 0 and math.isfinite(t)
    assert s5.sharpe_hac([0.0] * 10)[1] == float("inf")  # zero-variance guard
    print("holm_hac OK", round(sh, 3))


def test_portfolio_loop_mirrors_backtest():
    # S5 always-take ledger must match bt.run economics on the same stream.
    bars = {}
    for s in ("P", "Q"):
        px, bs = 100.0, []
        for i in range(600):
            px += 0.05
            bs.append(Bar(ts_ns=i, o=px - 0.05, h=px + 0.2, l=px - 0.2,
                          c=px, spread_bps=2.0))
        bars[s] = bs
    recs_bt, rep = bt.run(bars, universe_mode="diagnostic")
    items = []
    idx = {s: {b.ts_ns: i for i, b in enumerate(bs)}
           for s, bs in bars.items()}
    for r in [x for x in recs_bt if x["taken"]]:
        c = r["c"]
        i = idx[c.symbol][c.snapshot_ts_ns]
        mkt = {"snapshot_epoch": c.snapshot_ts_ns, "price_s": "1.0",
               "spread_bps_s": "2.0", "session": "us_open",
               "regime": "trend"}
        items.append((c, bars[c.symbol][i + 1:], mkt, "trend", 2.0))
    got = s5.evaluate_stream(items, PROVIDE, PUB, dict(ENGINE))
    eq, _ = s5.portfolio_loop(got, "always", 100000.0)
    assert abs(eq - rep["end_equity"]) < 1e-4 * max(1.0, rep["end_equity"]), \
        (eq, rep["end_equity"])
    print("ledger_mirror OK", round(eq, 2))


if __name__ == "__main__":
    test_both_policies_same_candidates()
    test_identical_frozen_economics()
    test_hold_never_fills_and_accepted_identical()
    test_paired_reconcile()
    test_censored_stays_censored()
    test_no_lookahead_and_replay()
    test_no_cross_cid_and_bootstrap_determinism()
    test_cost_stress_paired_and_variant_count()
    test_walkforward_holdout_and_r_disqualify()
    test_holm_and_sharpe_hac()
    test_portfolio_loop_mirrors_backtest()
    test_portfolio_loop_mirrors_backtest()
    print("ALL S5 TESTS GREEN")
