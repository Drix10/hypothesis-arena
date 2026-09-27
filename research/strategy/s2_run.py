"""S2 runner: baseline_v1 VALIDATION SLICE (equities) -> report json+md.

Slice identity (NOT the full frozen baseline): AAPL+MSFT 1h 2023-2024.
Full-universe acceptance (6 FX majors + PIT S&P + spread<=5bp enforcement)
stays OPEN. Reads data/s2_raw/, writes data/s2_out/ (both gitignored) and
freezes a content-hashed dataset copy next to the report.

Universe eligibility vs cost assumption (separate by construction):
  - spread unknown (OHLC source) -> eligibility=spread_unknown (counted as
    universe exclusion); costs use the 1bp-floor leg = LOWER BOUND only.
  - liquidity median-daily-$vol <= $50M -> symbol excluded for real.
"""
import hashlib
import json
import math
import os
import shutil
import statistics
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy.data import Bar
from research.strategy import baseline_v1 as bv
from research.strategy import backtest as bt
from research.strategy.universe import LIQ_MIN_MEDIAN_DAILY_USD

NY = ZoneInfo("America/New_York")
EQUITY = 100000.0
SLICE_ID = "baseline_v1_validation_slice_s2_equities"
STRAT_HASH = hashlib.sha256(open(os.path.join(
    os.path.dirname(__file__), "baseline_v1.py"), "rb").read()).hexdigest()


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
    return int(loc.replace(hour=16, minute=0, second=0, microsecond=0).timestamp() * 1e9)


def median_daily_dvol(bars):
    days = {}
    for b in bars:
        loc = datetime.fromtimestamp(b.ts_ns / 1e9, NY)
        days.setdefault(loc.date().isoformat(), 0.0)
        days[loc.date().isoformat()] += b.dollar_volume
    vals = sorted(days.values())
    return vals[len(vals) // 2] if vals else 0.0


def main():
    rawdir, outdir = "data/s2_raw", "data/s2_out"
    os.makedirs(outdir, exist_ok=True)
    manifest = json.load(open(os.path.join(rawdir, "dataset_manifest.json")))
    universe = json.load(open(os.path.join(rawdir, "universe_s2_v1.json")))
    syms, liq, liq_excluded = {}, {}, []
    for sym in ("AAPL", "MSFT"):
        bars = load(sym, rawdir)
        liq[sym] = median_daily_dvol(bars)
        if liq[sym] <= LIQ_MIN_MEDIAN_DAILY_USD:
            liq_excluded.append(sym)
            continue
        syms[sym] = bars
    idx = {s: {b.ts_ns: i for i, b in enumerate(bs)} for s, bs in syms.items()}
    stress, detail = {}, None
    for mult in (1.0, 1.5, 2.0, 3.0):
        recs, rep = bt.run(syms, equity=EQUITY, spread_mult=mult,
                           session_fn=lambda s, b: True,
                           is_fx_fn=lambda s: False,
                           day_end_fn=lambda s, b: day_end_ns(b))
        # daily curve from the SAME trade ledger (realized+taken only)
        daily = {}
        for r in recs:
            if r["taken"] and r["res"]["realized"]:
                day = datetime.fromtimestamp(
                    r["c"].snapshot_ts_ns / 1e9, NY).date().isoformat()
                daily[day] = daily.get(day, 0.0) + r["pnl_usd"] / EQUITY
        all_days = sorted({datetime.fromtimestamp(b.ts_ns / 1e9, NY).date().isoformat()
                           for bs in syms.values() for b in bs})
        rets = [daily.get(d, 0.0) for d in all_days]
        sh = (statistics.mean(rets) / statistics.pstdev(rets) * math.sqrt(252.0)
              if len(rets) > 1 and statistics.pstdev(rets) > 0 else 0.0)
        eq, peak, mdd = 1.0, 1.0, 0.0
        for x in rets:
            eq *= (1 + x)
            peak = max(peak, eq)
            mdd = max(mdd, (peak - eq) / peak)
        rep.update({"sharpe_ann": sh, "max_dd": mdd, "session_days": len(all_days)})
        # reconciliation: ledger sum == reported total (asserted in summarize too)
        assert abs(sum(r["pnl_usd"] for r in recs if r["taken"]) - rep["net_pnl"]) < 1e-6
        stress[str(mult)] = rep
        if mult == 1.0:
            detail = recs
    # eligibility + splits from the 1x ledger
    by_sym, by_reg, spread_unknown = {}, {}, 0
    for r in detail:
        c = r["c"]
        i = idx[c.symbol][c.snapshot_ts_ns]
        bars = syms[c.symbol]
        if not bars[i].spread_bps:
            spread_unknown += 1
        reg = bv.regime(bars, i)
        e = {"outcome": r["res"]["label"], "realized": r["res"]["realized"],
             "taken": r["taken"], "r": r["res"]["r_realized"],
             "pnl_usd": r["pnl_usd"], "exit": r["res"]["exit_reason"],
             "bars_held": r["res"]["bars_held"]}
        by_sym.setdefault(c.symbol, []).append(e)
        by_reg.setdefault(reg or "unknown", []).append(e)
    s1 = stress["1.0"]
    report = {
        "slice_id": SLICE_ID,
        "strategy_version": "baseline_v1",
        "strategy_file_sha256": STRAT_HASH,
        "candidate_schema": "c1",
        "cost_model": "paper_fill_v1",
        "exit_profile": "exit_profile_v1",
        "dataset_manifest": manifest, "universe": universe,
        "equity_usd": EQUITY,
        "liquidity_median_daily_usd": liq,
        "universe_exclusions": {"illiquid_symbols": liq_excluded,
                                "spread_unknown_candidates": spread_unknown,
                                "fx_sleeve": "NOT INCLUDED (source pending)",
                                "pit_scope": "AAPL+MSFT continuous S&P members, "
                                             "2023-01-01..2025-01-01"},
        "stress": stress,
        "per_symbol_1x": {s: {"n_realized": sum(1 for e in v if e["taken"] and e["realized"]),
                              "pnl_usd": sum(e["pnl_usd"] for e in v)} for s, v in by_sym.items()},
        "per_regime_1x": {r: {"n": len(v)} for r, v in by_reg.items()},
    }
    jp = os.path.join(outdir, "baseline_v1_report.json")
    json.dump(report, open(jp, "w"), indent=2)
    # frozen dataset artifact: byte copy next to the report, hash-pinned
    fz = os.path.join(outdir, "dataset_frozen")
    os.makedirs(fz, exist_ok=True)
    for fn in ("dataset_manifest.json", "universe_s2_v1.json",
               "AAPL_1h.jsonl", "MSFT_1h.jsonl"):
        shutil.copy(os.path.join(rawdir, fn), os.path.join(fz, fn))
    fhash = hashlib.sha256()
    for fn in sorted(os.listdir(fz)):
        fhash.update(open(os.path.join(fz, fn), "rb").read())
    report["frozen_dataset_sha256"] = fhash.hexdigest()
    json.dump(report, open(jp, "w"), indent=2)
    lines = [f"# {SLICE_ID} (validation slice — NOT full-universe acceptance)",
             "", f"Universe hash `{universe['artifact_hash'][:16]}` | strategy `{STRAT_HASH[:16]}` | "
                 f"dataset `{fhash.hexdigest()[:16]}`. Costs: 1bp-floor legs = LOWER BOUND.",
             f"FX sleeve excluded; spread-unknown candidates: {spread_unknown} (eligibility counts, economics labeled slice).",
             "", "## 1x (realized portfolio)",
             f"- candidates={s1['candidates']} realized={s1['realized']} (wins={s1['realized_wins']}, "
             f"time_exits={s1['realized_time_exits']}) calib_censored={s1['calib_censored']} excluded={s1['excluded']} "
             f"cap_excluded={s1['portfolio_excluded_caps']}",
             f"- win_rate={s1['win_rate']:.3f} avg_R={s1['avg_r']:.3f} median_R={s1['median_r']:.3f}",
             f"- net_pnl=${s1['net_pnl']:,.0f} sharpe_ann={s1['sharpe_ann']:.2f} max_dd={s1['max_dd']:.3f} "
             f"turnover={s1['turnover']:.1f}x equity",
             f"- r2_binding={s1['r2_binding_rate']:.2f} avg_eff_risk={s1['avg_effective_risk_bps']:.2f}bps "
             f"({s1['avg_effective_risk_frac']:.6f}) avg_stop={s1['avg_stop_bps']:.0f}bps "
             f"avg_hold={s1['avg_bars_held']:.1f}bars time_exit={s1['time_exit_rate']:.2f}",
             "", "## Cost stress (net PnL, same ledger)",
             "".join(f"\n- {m}x: pnl=${stress[m]['net_pnl']:,.0f} avgR={stress[m]['avg_r']:.3f}" for m in stress),
             "", "> Descriptive only. Full S2 acceptance OPEN (FX, spread eligibility, PIT breadth)."]
    mp = os.path.join(outdir, "baseline_v1_report.md")
    open(mp, "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("wrote", jp, mp)


if __name__ == "__main__":
    main()
