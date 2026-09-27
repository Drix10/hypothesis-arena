"""S2 runner: exact frozen baseline_v1 on real 1h data -> report json+md.

Reads data/s2_raw/<SYM>_1h.jsonl + dataset_manifest.json +
universe_s2_v1.json. No network, no LLM, deterministic. Writes
research/strategy/baseline_v1_report.json (report dir = data/s2_out/,
gitignored); the .md is generated alongside.
"""
import hashlib
import json
import math
import os
import statistics
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy.data import Bar
from research.strategy import baseline_v1 as bv
from research.strategy import backtest as bt

NY = ZoneInfo("America/New_York")
EQUITY = 100000.0
STRAT_HASH = hashlib.sha256(open(os.path.join(
    os.path.dirname(__file__), "baseline_v1.py"), "rb").read()).hexdigest()[:16]


def load(sym, rawdir="data/s2_raw"):
    bars = []
    with open(os.path.join(rawdir, f"{sym}_1h.jsonl")) as f:
        for line in f:
            d = json.loads(line)
            bars.append(Bar(ts_ns=d["ts_ns"], o=d["o"], h=d["h"], l=d["l"],
                            c=d["c"], dollar_volume=d.get("dollar_volume", 0.0),
                            spread_bps=d.get("spread_bps", 0.0)))
    return bars


def day_end_ns(bar):
    loc = datetime.fromtimestamp(bar.ts_ns / 1e9, NY)
    close = loc.replace(hour=16, minute=0, second=0, microsecond=0)
    return int(close.timestamp() * 1e9)


def median_daily_dvol(bars):
    days = {}
    for b in bars:
        loc = datetime.fromtimestamp(b.ts_ns / 1e9, NY)
        days.setdefault(loc.date().isoformat(), 0.0)
        days[loc.date().isoformat()] += b.dollar_volume
    vals = sorted(days.values())
    return vals[len(vals) // 2] if vals else 0.0


def run_once(symbols_bars, spread_mult):
    cands, res, rep = bt.run(
        symbols_bars, equity=EQUITY, spread_mult=spread_mult,
        session_fn=lambda s, b: True, is_fx_fn=lambda s: False,
        day_end_fn=lambda s, b: day_end_ns(b))
    # per-symbol / per-regime splits + daily curve
    by_sym, by_reg, daily = {}, {}, {}
    idx = {s: {b.ts_ns: i for i, b in enumerate(bs)}
           for s, bs in symbols_bars.items()}
    for (c, r, unc, con, binding, eff, frac) in res:
        i = idx[c.symbol][c.snapshot_ts_ns]
        reg = bv.regime(symbols_bars[c.symbol], i)
        pnl_usd = r["r_multiple"] * frac * EQUITY if r["outcome"] in ("win", "loss") else 0.0
        entry = {"symbol": c.symbol, "side": c.proposed_side,
                 "family": c.proposed_family, "outcome": r["outcome"],
                 "r": r["r_multiple"], "pnl_usd": pnl_usd,
                 "bars_held": r["bars_held"], "exit": r["exit_reason"],
                 "r2_binding": binding, "eff_bps": eff, "regime": reg}
        by_sym.setdefault(c.symbol, []).append(entry)
        by_reg.setdefault(reg or "unknown", []).append(entry)
        if r["outcome"] in ("win", "loss"):
            day = datetime.fromtimestamp(
                c.snapshot_ts_ns / 1e9, NY).date().isoformat()
            daily[day] = daily.get(day, 0.0) + pnl_usd / EQUITY
    return rep, by_sym, by_reg, daily


def sharpe_dd(daily, all_days):
    rets = [daily.get(d, 0.0) for d in all_days]
    if len(rets) < 2 or statistics.pstdev(rets) == 0:
        return 0.0, 0.0, rets
    sh = statistics.mean(rets) / statistics.pstdev(rets) * math.sqrt(252.0)
    eq, peak, mdd = 1.0, 1.0, 0.0
    for r in rets:
        eq *= (1 + r)
        peak = max(peak, eq)
        mdd = max(mdd, (peak - eq) / peak)
    return sh, mdd, rets


def main():
    rawdir, outdir = "data/s2_raw", "data/s2_out"
    os.makedirs(outdir, exist_ok=True)
    manifest = json.load(open(os.path.join(rawdir, "dataset_manifest.json")))
    universe = json.load(open(os.path.join(rawdir, "universe_s2_v1.json")))
    syms = {}
    liq = {}
    for sym in ("AAPL", "MSFT"):
        bars = load(sym, rawdir)
        liq[sym] = median_daily_dvol(bars)
        syms[sym] = bars
    all_days = sorted({datetime.fromtimestamp(b.ts_ns / 1e9, NY).date().isoformat()
                       for bs in syms.values() for b in bs})
    stress = {}
    detail = None
    for mult in (1.0, 1.5, 2.0, 3.0):
        rep, by_sym, by_reg, daily = run_once(syms, mult)
        sh, mdd, _ = sharpe_dd(daily, all_days)
        rep.update({"sharpe_ann": sh, "max_dd": mdd,
                    "session_days": len(all_days)})
        stress[str(mult)] = rep
        if mult == 1.0:
            detail = (by_sym, by_reg)
    by_sym, by_reg = detail
    report = {
        "strategy_version": "baseline_v1",
        "strategy_file_hash": STRAT_HASH,
        "candidate_schema": "c1",
        "dataset_manifest": {k: manifest["symbols"][k]["sha256"]
                             for k in manifest["symbols"]},
        "universe_hash": universe["artifact_hash"],
        "equity_usd": EQUITY,
        "liquidity_median_daily_usd": liq,
        "stress": stress,
        "per_symbol_1x": {s: {"n": len(v),
                              "win_rate": sum(1 for e in v if e["outcome"] == "win") /
                              max(1, sum(1 for e in v if e["outcome"] in ("win", "loss"))),
                              "avg_r": sum(e["r"] for e in v if e["outcome"] in ("win", "loss")) /
                              max(1, sum(1 for e in v if e["outcome"] in ("win", "loss"))),
                              "pnl_usd": sum(e["pnl_usd"] for e in v)} for s, v in by_sym.items()},
        "per_regime_1x": {r: {"n": len(v),
                              "win_rate": sum(1 for e in v if e["outcome"] == "win") /
                              max(1, sum(1 for e in v if e["outcome"] in ("win", "loss")))}
                          for r, v in by_reg.items()},
    }
    jp = os.path.join(outdir, "baseline_v1_report.json")
    json.dump(report, open(jp, "w"), indent=2)
    s1 = stress["1.0"]
    lines = ["# baseline_v1 S2 report (real data, equities sleeve)",
             "", f"Universe: universe_s2_v1 `{universe['artifact_hash'][:16]}` "
                 "(AAPL+MSFT, 2023-01-01..2025-01-01, 1h NYSE session bars).",
             f"Strategy file hash: `{STRAT_HASH}`. Costs: 1bp-floor legs = LOWER BOUND (no spread in OHLC).",
             f"FX sleeve: NOT included (source pending).",
             "", "## 1x costs",
             f"- candidates={s1['candidates']} closed={s1['closed']} censored={s1['censored']} excluded={s1['excluded']}",
             f"- win_rate={s1['win_rate']:.3f} avg_R={s1['avg_r']:.3f} median_R={s1['median_r']:.3f}",
             f"- net_pnl=${s1['net_pnl']:,.0f} sharpe_ann={s1['sharpe_ann']:.2f} max_dd={s1['max_dd']:.3f}",
             f"- r2_binding={s1['r2_binding_rate']:.2f} avg_eff_risk={s1['avg_effective_risk_bps']:.2f}bps "
             f"({s1['avg_effective_risk_frac']:.6f} equity)",
             f"- avg_stop={s1['avg_stop_bps']:.0f}bps avg_hold={s1['avg_bars_held']:.1f}bars "
             f"time_exit={s1['time_exit_rate']:.2f}",
             "", "## Cost stress (net PnL)",
             "".join(f"\n- {m}x: pnl=${stress[m]['net_pnl']:,.0f} win={stress[m]['win_rate']:.3f} "
                       f"avgR={stress[m]['avg_r']:.3f}" for m in ("1.0", "1.5", "2.0", "3.0")),
             "", "## Per-symbol / per-regime (1x)",
             "".join(f"\n- {s}: {d}" for s, d in report["per_symbol_1x"].items()),
             "".join(f"\n- {r}: {d}" for r, d in report["per_regime_1x"].items()),
             "", "> Descriptive only. No edge verdict: sample + cost-lower-bound limits apply."]
    mp = os.path.join(outdir, "baseline_v1_report.md")
    open(mp, "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("wrote", jp, mp)


if __name__ == "__main__":
    main()
