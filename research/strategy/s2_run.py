"""S2 runner: baseline_v1 VALIDATION SLICE (equities) -> report json+md.

Slice identity (NOT full-universe acceptance): AAPL+MSFT 1h 2023-2024.
Two ledgers per cost level:
  primary   (universe_mode=eligible): spread-unknown candidates are
            universe-excluded from the economics ledger (option A).
  diagnostic(universe_mode=diagnostic): lower-bound 1bp-floor cost run.
Reads data/s2_raw/, writes data/s2_out/ (gitignored) + frozen byte copy.
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


def run_once(symbols_bars, spread_mult, mode):
    recs, rep = bt.run(
        symbols_bars, equity=EQUITY, spread_mult=spread_mult,
        session_fn=lambda s, b: True, is_fx_fn=lambda s: False,
        day_end_fn=lambda s, b: day_end_ns(b), universe_mode=mode)
    by_sym, by_reg, daily = {}, {}, {}
    idx = {s: {b.ts_ns: i for i, b in enumerate(bs)}
           for s, bs in symbols_bars.items()}
    for r in recs:
        c = r["c"]
        i = idx[c.symbol][c.snapshot_ts_ns]
        reg = bv.regime(symbols_bars[c.symbol], i)
        e = {"taken": r["taken"], "reason": r["reason"],
             "label": r["res"]["label"], "realized": r["res"]["realized"],
             "r": r["res"]["r_realized"], "pnl_usd": r["pnl_usd"],
             "exit": r["res"]["exit_reason"], "bars_held": r["res"]["bars_held"],
             "eligible": r["eligible"], "regime": reg}
        by_sym.setdefault(c.symbol, []).append(e)
        by_reg.setdefault(reg or "unknown", []).append(e)
        if r["taken"] and r["res"]["realized"]:
            day = datetime.fromtimestamp(
                c.snapshot_ts_ns / 1e9, NY).date().isoformat()
            daily[day] = daily.get(day, 0.0) + r["pnl_usd"] / EQUITY
    assert abs(sum(r["pnl_usd"] for r in recs if r["taken"]) - rep["net_pnl"]) < 1e-6
    return recs, rep, by_sym, by_reg, daily


def curve(daily, all_days):
    rets = [daily.get(d, 0.0) for d in all_days]
    sh = (statistics.mean(rets) / statistics.pstdev(rets) * math.sqrt(252.0)
          if len(rets) > 1 and statistics.pstdev(rets) > 0 else 0.0)
    eq, peak, mdd = 1.0, 1.0, 0.0
    for x in rets:
        eq *= (1 + x)
        peak = max(peak, eq)
        mdd = max(mdd, (peak - eq) / peak)
    return sh, mdd


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
    all_days = sorted({datetime.fromtimestamp(b.ts_ns / 1e9, NY).date().isoformat()
                       for bs in syms.values() for b in bs})
    out = {"eligible": {}, "diagnostic": {}}
    detail = None
    for mode in ("eligible", "diagnostic"):
        for mult in (1.0, 1.5, 2.0, 3.0):
            recs, rep, by_sym, by_reg, daily = run_once(syms, mult, mode)
            sh, mdd = curve(daily, all_days)
            rep.update({"sharpe_ann": sh, "max_dd": mdd, "session_days": len(all_days)})
            out[mode][str(mult)] = {"rep": rep, "by_sym": by_sym, "by_reg": by_reg}
            if mode == "diagnostic" and mult == 1.0:
                detail = (by_sym, by_reg)
    p1 = out["eligible"]["1.0"]["rep"]
    d1 = out["diagnostic"]["1.0"]["rep"]
    by_sym, by_reg = detail
    fz = os.path.join(outdir, "dataset_frozen")
    os.makedirs(fz, exist_ok=True)
    for fn in ("dataset_manifest.json", "universe_s2_v1.json",
               "AAPL_1h.jsonl", "MSFT_1h.jsonl"):
        shutil.copy(os.path.join(rawdir, fn), os.path.join(fz, fn))
    fhash = hashlib.sha256()
    for fn in sorted(os.listdir(fz)):
        fhash.update(open(os.path.join(fz, fn), "rb").read())
    report = {
        "slice_id": SLICE_ID,
        "strategy_version": "baseline_v1",
        "strategy_file_sha256": STRAT_HASH,
        "candidate_schema": "c1",
        "cost_model": "paper_fill_v1",
        "exit_profile": "exit_profile_v1",
        "dataset_manifest": manifest, "universe": universe,
        "frozen_dataset_sha256": fhash.hexdigest(),
        "equity_usd": EQUITY,
        "liquidity_median_daily_usd": liq,
        "universe_exclusions": {"illiquid_symbols": liq_excluded,
                                "fx_sleeve": "NOT INCLUDED (source pending)",
                                "pit_scope": "AAPL+MSFT continuous S&P members, 2023-01-01..2025-01-01"},
        "primary_eligible": {m: v["rep"] for m, v in out["eligible"].items()},
        "diagnostic_lower_bound": {m: v["rep"] for m, v in out["diagnostic"].items()},
        "diagnostic_per_symbol_1x": {
            s: {"n_realized": sum(1 for e in v if e["taken"] and e["realized"]),
                "pnl_usd": sum(e["pnl_usd"] for e in v)} for s, v in by_sym.items()},
        "diagnostic_per_regime_1x": {r: {"n": len(v)} for r, v in by_reg.items()},
    }
    jp = os.path.join(outdir, "baseline_v1_report.json")
    json.dump(report, open(jp, "w"), indent=2)

    def row(tag, r):
        return (f"- {tag}: candidates={r['candidates']} realized={r['realized']} "
                f"(wins={r['realized_wins']}, time={r['realized_time_exits']}) "
                f"univ_excl={r['universe_excluded']} cap={r['cap_excluded']} "
                f"win={r['win_rate']:.3f} avgR={r['avg_r']:.3f} pnl=${r['net_pnl']:,.0f} "
                f"sharpe={r['sharpe_ann']:.2f} dd={r['max_dd']:.3f} "
                f"singleR2={r['single_notional_binding_rate']:.2f} "
                f"totalR2={r['total_notional_binding_rate']:.2f} "
                f"maxposR2={r['max_position_binding_rate']:.2f} "
                f"eff={r['avg_effective_risk_bps']:.1f}bps turn={r['turnover']:.0f}x")
    lines = [f"# {SLICE_ID} (validation slice, acceptance OPEN)",
             "", f"Universe `{universe['artifact_hash'][:16]}` | strategy `{STRAT_HASH[:16]}` | "
                 f"dataset `{fhash.hexdigest()[:16]}`. End equity eligible=${p1['end_equity']:,.0f} "
                 f"diagnostic=${d1['end_equity']:,.0f}.",
             "", "## Primary (universe-eligible; spread-unknown excluded from ledger)",
             row("1x", p1),
             "".join(f"\n{row(m + 'x', out['eligible'][m]['rep'])}" for m in ("1.5", "2.0", "3.0")),
             "", "## Diagnostic (lower-bound 1bp-floor costs, spread-unknown included)",
             row("1x", d1),
             "".join(f"\n{row(m + 'x', out['diagnostic'][m]['rep'])}" for m in ("1.5", "2.0", "3.0")),
             "", "> Descriptive only. Full S2 acceptance OPEN (FX, spread eligibility, PIT breadth)."]
    mp = os.path.join(outdir, "baseline_v1_report.md")
    open(mp, "w").write("\n".join(lines) + "\n")
    print("\n".join(lines))
    print("wrote", jp, mp)


if __name__ == "__main__":
    main()
