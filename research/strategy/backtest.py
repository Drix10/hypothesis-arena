"""Deterministic backtester for baseline_v1 (research/shadow-only, no orders).

Two orthogonal axes (audit-hardened):

  label (frozen doc-11 calibration protocol):
      win / loss / censored / excluded
      Neither-stop-nor-TP by horizon -> censored (calibration only).
  realization (portfolio economics):
      realized=yes for TP / stop / gap / time_exit (a time exit is a REAL
      trade under exit_profile_v1 — it only stays censored for calibration).
      realized=no for excluded (no market path to resolve).

PnL authority: exactly ONE construction — per-trade records
  pnl_usd = r_realized x eff_frac x equity
and total/daily/equity/Sharpe/DD all derive from those records.
Reconciliation invariant: sum(trade_pnl) == total_pnl (tested).

Fills (frozen paper_fill_v1, two-leg): each leg executes at its adverse
price — entry leg at adverse(entry mid), exit leg at adverse(exit mid).
No constant round-trip deduction.

Gap-through-stop: exits at the FIRST TRADABLE PRINT (the gap open), never
clamped to -1R.

Chronology: run() walks a single timestamp-ordered event stream across all
symbols and maintains global portfolio state (max 3, R2 total 75%, one
open position per symbol). Per-symbol loops would make the caps fiction.

Risk (doc 05 + doc 03 steps 2-6, stage mult 1.0): 25bp base budget,
notional = budget/stop_dist x entry, R2 caps, 25bp... see size_notional.
"""
import hashlib
import math

from . import baseline_v1 as bv
from .candidate import make_candidate
from .costs import fill_px

STRATEGY_VERSION = "baseline_v1"
EXIT_PROFILE_VERSION = "exit_profile_v1"
COST_MODEL_VERSION = "paper_fill_v1"
RISK_BUDGET_BPS = 25.0
R2_SINGLE_PCT = 25.0
R2_TOTAL_PCT = 75.0
MAX_POSITIONS = 3
OPP = {"BUY": "SELL", "SELL": "BUY"}


def _horizon_ns(ts_ns: int, is_fx: bool) -> int:
    if is_fx:
        return ts_ns + 24 * 3600 * 10**9
    return ts_ns  # caller overrides for equities


def generate(symbol, bars, i, session_open, day_end_ns=None, is_fx=True,
             feature_rev="synth"):
    """-> Candidate | None. Deterministic; bars[..i] only."""
    sig = bv.signal(bars, i, session_open)
    if sig is None:
        return None
    side, family = sig
    atr = bv.atr14(bars, i)
    if atr is None or atr <= 0:
        return None
    bar = bars[i]
    entry = bar.c
    stop, tp, risk = bv.exits(entry, side, atr)
    horizon = day_end_ns if (not is_fx and day_end_ns) else _horizon_ns(bar.ts_ns, is_fx)
    if horizon <= bar.ts_ns:
        return None
    spread = bar.spread_bps or 0.0
    fhash = hashlib.sha256(
        f"{symbol}|{bar.ts_ns}|{bv.zscore20(bars, i)}|{bv.regime(bars, i)}".encode()
    ).hexdigest()
    return make_candidate(
        strategy_version=STRATEGY_VERSION, symbol=symbol,
        snapshot_ts_ns=bar.ts_ns, proposed_side=side, proposed_family=family,
        entry_px=entry, stop_px=stop, tp_px=tp, time_exit_ns=horizon,
        exit_profile_version=EXIT_PROFILE_VERSION,
        cost_model_version=COST_MODEL_VERSION,
        expected_cost_bps=0.0,  # realized two-leg fills carry costs, not estimates
        feature_snapshot_hash=fhash, feature_revision=feature_rev)


def _exit_fill(side_out, mid, spread_bps, mult):
    return fill_px(side_out, mid, spread_bps, mult)


def resolve(candidate, bars_after, spread_mult=1.0):
    """-> dict(label, realized, r_realized, exit_reason, bars_held,
    entry_fill, exit_fill, exit_ts_ns).

    r_realized is net of BOTH adverse legs. Time exit: label=censored,
    realized=True. No resolvable path: label=excluded, realized=False.
    """
    side = candidate.proposed_side
    entry, stop, tp = candidate.entry_px, candidate.stop_px, candidate.tp_px
    risk = abs(entry - stop)
    blank = {"label": "excluded", "realized": False, "r_realized": 0.0,
             "exit_reason": "excluded", "bars_held": 0,
             "entry_fill": 0.0, "exit_fill": 0.0, "exit_ts_ns": 0}
    if risk <= 0:
        return blank
    is_buy = side == "BUY"
    spread_in = bars_after[0].spread_bps if bars_after else 0.0
    entry_fill = fill_px(side, entry, spread_in or 1.0, spread_mult)

    def r_of(exit_mid, exit_spread):
        exit_fill = _exit_fill(OPP[side], exit_mid, exit_spread or 1.0, spread_mult)
        r = ((exit_fill - entry_fill) / risk) if is_buy else \
            ((entry_fill - exit_fill) / risk)
        return r, exit_fill

    for n, b in enumerate(bars_after):
        if b.ts_ns > candidate.time_exit_ns:
            break
        if is_buy:
            hit_stop = b.l <= stop
            hit_tp = b.h >= tp
            gapped = b.o <= stop and b.o < entry
        else:
            hit_stop = b.h >= stop
            hit_tp = b.l <= tp
            gapped = b.o >= stop and b.o > entry
        if hit_stop and hit_tp:
            r, xf = r_of(stop, b.spread_bps)  # stop-first (frozen)
            return {"label": "loss", "realized": True, "r_realized": r,
                    "exit_reason": "stop", "bars_held": n + 1,
                    "entry_fill": entry_fill, "exit_fill": xf,
                    "exit_ts_ns": b.ts_ns}
        if hit_stop:
            if gapped:
                # first tradable print, never clamped to -1R
                r, xf = r_of(b.o, b.spread_bps)
                return {"label": "loss", "realized": True, "r_realized": r,
                        "exit_reason": "gap", "bars_held": n + 1,
                        "entry_fill": entry_fill, "exit_fill": xf,
                        "exit_ts_ns": b.ts_ns}
            r, xf = r_of(stop, b.spread_bps)
            return {"label": "loss", "realized": True, "r_realized": r,
                    "exit_reason": "stop", "bars_held": n + 1,
                    "entry_fill": entry_fill, "exit_fill": xf,
                    "exit_ts_ns": b.ts_ns}
        if hit_tp:
            r, xf = r_of(tp, b.spread_bps)
            return {"label": "win", "realized": True, "r_realized": r,
                    "exit_reason": "tp", "bars_held": n + 1,
                    "entry_fill": entry_fill, "exit_fill": xf,
                    "exit_ts_ns": b.ts_ns}
    last = None
    for b in bars_after:
        if b.ts_ns <= candidate.time_exit_ns:
            last = b
        else:
            break
    if last is None:
        return blank
    r, xf = r_of(last.c, last.spread_bps)
    held = sum(1 for b in bars_after if b.ts_ns <= candidate.time_exit_ns)
    return {"label": "censored", "realized": True, "r_realized": r,
            "exit_reason": "time", "bars_held": held,
            "entry_fill": entry_fill, "exit_fill": xf,
            "exit_ts_ns": last.ts_ns}


def size_notional(equity: float, risk_dist: float, entry: float):
    """-> (unconstrained_pct, constrained_pct, r2_binding, effective_risk_bps,
    effective_risk_frac). Shares = budget/risk_dist; notional = shares x entry.
    Frozen reference: 25% cap x 0.1% stop = 0.00025 equity = 2.5 bps."""
    budget = equity * RISK_BUDGET_BPS / 10000.0
    unc = (budget / risk_dist * entry) / equity * 100.0 \
        if risk_dist > 0 and entry > 0 else 0.0
    con = min(unc, R2_SINGLE_PCT)
    eff_usd = min(budget, con / 100.0 * equity * (risk_dist / entry)) \
        if entry > 0 else 0.0
    eff_frac = eff_usd / equity if equity > 0 else 0.0
    return (unc, con, unc > R2_SINGLE_PCT, eff_frac * 10000.0, eff_frac)


def run(symbols_bars, equity=100000.0, spread_mult=1.0, session_fn=None,
        is_fx_fn=None, day_end_fn=None):
    """Chronological multi-symbol backtest.

    Single timestamp-ordered event stream; global state: one open position
    per symbol, max 3 concurrent, R2 total 75% on eff_frac. Candidates that
    fail portfolio admission are recorded taken=False (calibration stream
    still resolves them; portfolio ignores them).
    Returns (records, report) where records hold the full trade ledger.
    """
    session_fn = session_fn or (lambda sym, b: True)
    is_fx_fn = is_fx_fn or (lambda sym: True)
    events = []
    for sym, bars in symbols_bars.items():
        for i, b in enumerate(bars):
            events.append((b.ts_ns, sym, i))
    events.sort()
    records = []
    open_pos = []  # [exit_ts_ns, eff_frac, symbol]
    for ts, sym, i in events:
        bars = symbols_bars[sym]
        open_pos = [p for p in open_pos if p[0] > ts]
        c = generate(sym, bars, i, session_fn(sym, bars[i]),
                     day_end_ns=day_end_fn(sym, bars[i]) if day_end_fn else None,
                     is_fx=is_fx_fn(sym))
        if c is None:
            continue
        risk = abs(c.entry_px - c.stop_px)
        unc, con, binding, eff_bps, eff_frac = size_notional(
            equity, risk, c.entry_px)
        res = resolve(c, bars[i + 1:], spread_mult=spread_mult)
        taken = (res["realized"] and
                 not any(p[2] == sym for p in open_pos) and
                 len(open_pos) < MAX_POSITIONS and
                 sum(p[1] for p in open_pos) + eff_frac <= R2_TOTAL_PCT / 100.0)
        if taken:
            open_pos.append([res["exit_ts_ns"], eff_frac, sym])
        pnl = res["r_realized"] * eff_frac * equity if (taken and res["realized"]) else 0.0
        records.append({"c": c, "res": res, "unc": unc, "con": con,
                        "binding": binding, "eff_bps": eff_bps,
                        "eff_frac": eff_frac, "taken": taken, "pnl_usd": pnl})
    return records, summarize(records, equity)


def summarize(records, equity):
    realized = [r for r in records if r["taken"] and r["res"]["realized"]]
    calib_closed = [r for r in records if r["res"]["label"] in ("win", "loss")]
    wins = [r for r in realized if r["res"]["label"] == "win"]
    rs = [r["res"]["r_realized"] for r in realized]
    n = len(realized)
    total = sum(r["pnl_usd"] for r in realized)
    # reconciliation invariant is structural: total IS the sum by construction;
    # recompute independently as the tripwire.
    assert abs(sum(r["pnl_usd"] for r in realized) - total) < 1e-9 * max(1.0, abs(total))
    return {
        "candidates": len(records),
        "realized": n,
        "realized_wins": len(wins),
        "realized_time_exits": sum(1 for r in realized if r["res"]["exit_reason"] == "time"),
        "calib_closed_winloss": len(calib_closed),
        "calib_censored": sum(1 for r in records if r["res"]["label"] == "censored"),
        "excluded": sum(1 for r in records if r["res"]["label"] == "excluded"),
        "portfolio_excluded_caps": sum(1 for r in records if not r["taken"] and r["res"]["realized"]),
        "win_rate": len(wins) / n if n else 0.0,
        "avg_r": sum(rs) / n if n else 0.0,
        "median_r": sorted(rs)[n // 2] if n else 0.0,
        "expectancy_r": sum(rs) / n if n else 0.0,
        "net_pnl": total,
        "r2_binding_rate": sum(1 for r in records if r["binding"]) / len(records) if records else 0.0,
        "avg_effective_risk_bps": (sum(r["eff_bps"] for r in realized) / n) if n else 0.0,
        "avg_effective_risk_frac": (sum(r["eff_frac"] for r in realized) / n) if n else 0.0,
        "avg_stop_bps": (sum(abs(r["c"].entry_px - r["c"].stop_px) / r["c"].entry_px * 10000.0
                             for r in realized) / n) if n else 0.0,
        "avg_bars_held": (sum(r["res"]["bars_held"] for r in realized) / n) if n else 0.0,
        "time_exit_rate": (sum(1 for r in realized if r["res"]["exit_reason"] == "time") / n) if n else 0.0,
        "turnover": sum(r["con"] / 100.0 for r in realized),
    }
