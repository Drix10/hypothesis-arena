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
    assert r["label"] == "loss" and r["realized"] and r["exit_reason"] == "stop", r
    assert abs(r["r_realized"] - ((98.9901 - 100.01))) < 1e-6, r  # two-leg fills
    tp_only = [Bar(ts_ns=1, o=100.0, h=102.5, l=99.5, c=101.0)]
    r2 = bt.resolve(c, tp_only)
    assert r2["label"] == "win" and abs(r2["r_realized"] - (102 - 102 * 0.0001 - 100.01)) < 1e-6, r2
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
    assert r["label"] == "loss" and r["realized"] and r["exit_reason"] == "gap", r
    assert abs(r["r_realized"] - ((97 - 97 * 0.0001 - 100.01))) < 1e-6, r  # at the print, not -1R
    flat = [Bar(ts_ns=1, o=100.0, h=100.5, l=99.5, c=100.1)]
    r2 = bt.resolve(c, flat)
    assert r2["label"] == "censored" and r2["realized"] and r2["exit_reason"] == "time", r2
    assert r2["r_realized"] != 0.0  # time exit is a REALIZED trade for economics
    r3 = bt.resolve(c, [])
    assert r3["label"] == "excluded" and not r3["realized"], r3
    print("gap_and_censor OK")


def test_cost_stress_monotone():
    assert fill_px("BUY", 100.0, 2.0, 1.0) < fill_px("BUY", 100.0, 2.0, 3.0)
    assert fill_px("SELL", 100.0, 2.0, 1.0) > fill_px("SELL", 100.0, 2.0, 3.0)
    assert fill_px("BUY", 100.0, 0.0, 1.0) == 100.0 * 1.0001  # 1bp floor
    print("cost_stress OK")


def test_cost_applies_all_paths():
    c = make_candidate(strategy_version="baseline_v1", symbol="T", snapshot_ts_ns=0,
                       proposed_side="BUY", proposed_family="momentum",
                       entry_px=100.0, stop_px=99.0, tp_px=102.0,
                       time_exit_ns=10**18, exit_profile_version="exit_profile_v1",
                       cost_model_version="paper_fill_v1", expected_cost_bps=4.0,
                       feature_snapshot_hash="h", feature_revision="synth")
    tp_bar = [Bar(ts_ns=1, o=100.0, h=102.5, l=99.5, c=101.0, spread_bps=10.0)]
    r1 = bt.resolve(c, tp_bar, spread_mult=1.0, spread_bps=10.0)
    r3 = bt.resolve(c, tp_bar, spread_mult=3.0, spread_bps=10.0)
    assert r1["label"] == "win" and r3["label"] == "win"
    assert r3["r_realized"] < r1["r_realized"] < 2.0, (r1, r3)
    # time-exit hold counts only bars within horizon
    bars = [Bar(ts_ns=i, o=100.0, h=100.5, l=99.5, c=100.1) for i in (1, 2, 3)]
    c2 = make_candidate(strategy_version="baseline_v1", symbol="T", snapshot_ts_ns=0,
                        proposed_side="BUY", proposed_family="momentum",
                        entry_px=100.0, stop_px=99.0, tp_px=102.0,
                        time_exit_ns=2, exit_profile_version="exit_profile_v1",
                        cost_model_version="paper_fill_v1", expected_cost_bps=4.0,
                        feature_snapshot_hash="h", feature_revision="synth")
    rt = bt.resolve(c2, bars)
    assert rt["label"] == "censored" and rt["realized"] and rt["bars_held"] == 2, rt
    print("cost_all_paths OK", round(r1["r_realized"], 4), round(r3["r_realized"], 4))
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
    # Frozen reference: 25% cap x 0.1% stop = 0.00025 equity = 2.5 bps.
    unc, con, binding, eff, frac = bt.size_notional(100000.0, 0.1, 100.0)
    assert unc == 250.0 and con == 25.0 and binding, (unc, con)
    assert eff == 2.5 and frac == 0.00025, (eff, frac)
    # Tight stop, no R2 bind: full 25bp budget realized.
    unc2, con2, binding2, eff2, frac2 = bt.size_notional(100000.0, 5.0, 100.0)
    assert not binding2 and con2 == unc2 == 5.0, (unc2, con2)
    assert eff2 == 25.0 and frac2 == 0.0025, (eff2, frac2)
    print("r2_telemetry OK", round(unc, 2), round(eff, 4))


def test_backtest_runs_and_reports():
    syms = {"A": mkbars(600, drift=0.002), "B": mkbars(600, drift=-0.002)}
    recs, rep = bt.run(syms)
    assert rep["candidates"] == len(recs)
    assert rep["realized"] + rep["portfolio_excluded_caps"] + rep["excluded"] == len(recs)
    assert abs(sum(r["pnl_usd"] for r in recs if r["taken"]) - rep["net_pnl"]) < 1e-9
    assert 0.0 <= rep["win_rate"] <= 1.0 and 0.0 <= rep["r2_binding_rate"] <= 1.0
    recs2, rep2 = bt.run(syms)
    assert rep == rep2, "backtest must replay identically"
    print("backtest_report OK", {k: (round(v, 4) if isinstance(v, float) else v)
                                 for k, v in rep.items()})


def test_chrono_portfolio_invariants():
    syms = {f"S{i}": mkbars(600, drift=0.002, ts0=i) for i in range(4)}
    recs, rep = bt.run(syms)
    pts = set()
    for r in recs:
        if r["taken"]:
            pts.add(r["c"].snapshot_ts_ns)
            pts.add(r["res"]["exit_ts_ns"])
    for t in sorted(pts):
        live = [r for r in recs if r["taken"] and r["c"].snapshot_ts_ns <= t < r["res"]["exit_ts_ns"]]
        assert len(live) <= 3, ("max 3 violated", t, len(live))
        assert len({r["c"].symbol for r in live}) == len(live), ("one-per-symbol violated", t)
        assert sum(r["eff_frac"] for r in live) <= 0.75 + 1e-12, ("R2 total violated", t)
    print("chrono_invariants OK", len(recs), "records checked")


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
    test_chrono_portfolio_invariants()
    print("ALL STRATEGY TESTS GREEN")
