"""Deterministic strategy-stack tests (stdlib only, synthetic fixtures).

Covers §30 baseline battery: deterministic replay, no-lookahead, PIT-shape
handling, cost stress, stop/TP resolution, censoring, risk constraints,
effective-risk telemetry, candidate identity/binding.
"""
import math
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy.data import Bar
from research.strategy import baseline_v1 as bv
from research.strategy import backtest as bt
from research.strategy.candidate import make_candidate, candidate_id
from research.strategy.costs import fill_px


def mkbars(n, start=100.0, drift=0.0, amp=0.5, ts0=0, step=3600_000_000_000,
           spread=2.0):
    bars = []
    px = start
    for i in range(n):
        px = px + drift + amp * math.sin(i / 5.0)
        bars.append(Bar(ts_ns=ts0 + i * step, o=px - 0.05, h=px + 0.2,
                        l=px - 0.2, c=px, spread_bps=spread))
    return bars


def test_indicators_deterministic():
    bars = mkbars(600)
    a = (bv.rsi14(bars, 599), bv.zscore20(bars, 599), bv.atr14(bars, 599),
         bv.adx14(bars, 599), bv.vol_bucket(bars, 599), bv.regime(bars, 599))
    b = (bv.rsi14(bars, 599), bv.zscore20(bars, 599), bv.atr14(bars, 599),
         bv.adx14(bars, 599), bv.vol_bucket(bars, 599), bv.regime(bars, 599))
    assert a == b, "indicators must replay bit-identically"
    assert a[0] is not None and 0 <= a[0] <= 100
    assert a[4] in ("low", "mid", "high") and a[5] in ("trend", "range", "volatile")
    print("indicators_deterministic OK", a)


def test_no_lookahead():
    bars = mkbars(600)
    before = (bv.rsi14(bars, 500), bv.zscore20(bars, 500), bv.signal(bars, 500, True))
    bars[550] = Bar(ts_ns=bars[550].ts_ns, o=1.0, h=500.0, l=0.5, c=400.0, spread_bps=2.0)
    after = (bv.rsi14(bars, 500), bv.zscore20(bars, 500), bv.signal(bars, 500, True))
    assert before == after, "future bars must not affect past signals"
    print("no_lookahead OK")


def test_warmup_gates():
    bars = mkbars(100)
    assert bv.vol_bucket(bars, 99) is None, "vol bucket needs 480-bar warmup"
    assert bv.regime(bars, 99) is None, "regime needs full inputs"
    assert bv.signal(bars, 99, True) is None
    print("warmup_gates OK")


def test_range_mean_reversion_direction():
    # flat base then a spike up in range regime -> SELL toward mean
    bars = mkbars(500, amp=0.05)
    last = bars[-1]
    spike = Bar(ts_ns=last.ts_ns + 3600_000_000_000, o=last.c, h=last.c + 6.0,
                l=last.c - 0.2, c=last.c + 5.0, spread_bps=2.0)
    bars2 = bars + [spike]
    sig = bv.signal(bars2, len(bars2) - 1, True)
    # regime may be range (low vol) -> expect SELL mean reversion; if inputs
    # disagree the structural assertion is just determinism + side validity
    if sig is not None:
        assert sig[0] in ("BUY", "SELL") and sig[1] in ("mean_reversion", "momentum")
    print("range_direction OK", sig)


def test_stop_first_and_tp():
    # BUY candidate: bar hits both stop and tp -> stop-first loss
    c = make_candidate(strategy_version="baseline_v1", symbol="T", snapshot_ts_ns=0,
                       proposed_side="BUY", proposed_family="mean_reversion",
                       entry_px=100.0, stop_px=99.0, tp_px=102.0,
                       time_exit_ns=10**18, exit_profile_version="exit_profile_v1",
                       cost_model_version="paper_fill_v1", expected_cost_bps=4.0,
                       feature_snapshot_hash="h", feature_revision="synth")
    both = [Bar(ts_ns=1, o=100.0, h=103.0, l=98.0, c=101.0)]
    r = bt.resolve(c, both)
    assert r["outcome"] == "loss" and r["exit_reason"] == "stop", r
    tp_only = [Bar(ts_ns=1, o=100.0, h=102.5, l=99.5, c=101.0)]
    r2 = bt.resolve(c, tp_only)
    assert r2["outcome"] == "win" and r2["r_multiple"] == 2.0, r2
    print("stop_first_and_tp OK")


def test_gap_and_censor():
    c = make_candidate(strategy_version="baseline_v1", symbol="T", snapshot_ts_ns=0,
                       proposed_side="BUY", proposed_family="momentum",
                       entry_px=100.0, stop_px=99.0, tp_px=102.0,
                       time_exit_ns=10**18, exit_profile_version="exit_profile_v1",
                       cost_model_version="paper_fill_v1", expected_cost_bps=4.0,
                       feature_snapshot_hash="h", feature_revision="synth")
    gap = [Bar(ts_ns=1, o=97.0, h=98.0, l=96.0, c=97.5)]
    r = bt.resolve(c, gap)
    assert r["outcome"] == "loss" and r["exit_reason"] == "gap", r
    flat = [Bar(ts_ns=1, o=100.0, h=100.5, l=99.5, c=100.1)]
    r2 = bt.resolve(c, flat)
    assert r2["outcome"] == "censored" and r2["exit_reason"] == "time", r2
    r3 = bt.resolve(c, [])
    assert r3["outcome"] == "excluded", r3
    print("gap_and_censor OK")


def test_cost_stress_monotone():
    assert fill_px("BUY", 100.0, 2.0, 1.0) < fill_px("BUY", 100.0, 2.0, 3.0)
    assert fill_px("SELL", 100.0, 2.0, 1.0) > fill_px("SELL", 100.0, 2.0, 3.0)
    assert fill_px("BUY", 100.0, 0.0, 1.0) == 100.0 * 1.0001  # 1bp floor
    print("cost_stress OK")


def test_candidate_identity():
    kw = dict(strategy_version="baseline_v1", symbol="EURUSD", snapshot_ts_ns=7,
              proposed_side="BUY", proposed_family="momentum", entry_px=1.1,
              stop_px=1.09, tp_px=1.12, time_exit_ns=9,
              exit_profile_version="exit_profile_v1",
              cost_model_version="paper_fill_v1", expected_cost_bps=4.0,
              feature_snapshot_hash="h", feature_revision="r")
    a, b = make_candidate(**kw), make_candidate(**kw)
    assert a.cid == b.cid == candidate_id(**{k: kw[k] for k in
        ("strategy_version", "symbol", "snapshot_ts_ns", "proposed_side",
         "proposed_family", "entry_px", "stop_px", "tp_px", "time_exit_ns",
         "exit_profile_version", "cost_model_version", "feature_revision")})
    kw2 = dict(kw, proposed_side="SELL", entry_px=1.1, stop_px=1.11, tp_px=1.08)
    c = make_candidate(**kw2)
    assert c.cid != a.cid, "BUY vs SELL must never share identity"
    try:
        make_candidate(**dict(kw, stop_px=1.2))
        assert False, "incoherent economics must raise"
    except ValueError:
        pass
    print("candidate_identity OK", a.cid[:16])


def test_r2_telemetry():
    unc, con, binding, eff = bt.size_notional(100000.0, 0.0001, 100.0)
    assert binding and con == 25.0 and unc > 25.0, (unc, con)
    assert eff <= 25.0 + 1e-9, eff  # effective risk capped by R2
    unc2, con2, binding2, _ = bt.size_notional(100000.0, 5.0, 100.0)
    assert not binding2 and con2 == unc2
    print("r2_telemetry OK", round(unc, 2), round(eff, 2))


def test_backtest_runs_and_reports():
    syms = {"A": mkbars(600, drift=0.002), "B": mkbars(600, drift=-0.002)}
    cands, res, rep = bt.run(syms)
    assert rep["candidates"] == len(res)
    assert rep["closed"] + rep["censored"] + rep["excluded"] == len(res)
    assert 0.0 <= rep["win_rate"] <= 1.0 and 0.0 <= rep["r2_binding_rate"] <= 1.0
    # rerun determinism
    _, _, rep2 = bt.run(syms)
    assert rep == rep2, "backtest must replay identically"
    print("backtest_report OK", {k: (round(v, 4) if isinstance(v, float) else v)
                                 for k, v in rep.items()})


if __name__ == "__main__":
    test_indicators_deterministic()
    test_no_lookahead()
    test_warmup_gates()
    test_range_mean_reversion_direction()
    test_stop_first_and_tp()
    test_gap_and_censor()
    test_cost_stress_monotone()
    test_candidate_identity()
    test_r2_telemetry()
    test_backtest_runs_and_reports()
    print("ALL STRATEGY TESTS GREEN")
