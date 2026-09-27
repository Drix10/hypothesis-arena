"""Deterministic backtester for baseline_v1 (research/shadow-only, no orders).

Axes:
  label (frozen doc-11 calibration): win / loss / censored / excluded.
  realization (portfolio): TP/stop/gap/time_exit realized; excluded not.
  Time exit = censored label + REALIZED economics.

R2 (frozen doc 05, NOTIONAL exposure — not stop risk):
  single <= 25% notional/equity, total <= 75% notional/equity, pending
  counts. Admission uses constrained NOTIONAL usd vs SNAPSHOT equity.
  Effective stop-risk is telemetry only, never an admission input.
  Structural note: max 3 x single 25% = 75% exactly, so total-R2 rejection
  is unreachable under frozen limits; the check + metric stay as tripwire.

Equity: evolving portfolio state. Realized PnL lands at position exit;
every candidate sizes against current snapshot equity. Same-timestamp
rule: exits purge before entries at equal ts (no time travel).

Spreads: entry leg uses the CANDIDATE bar spread (never a future bar);
exit leg uses the exit bar spread. Unknown spread (0.0) -> universe
INELIGIBLE for the primary slice; the 1bp floor leg is a separately
named lower-bound diagnostic, never frozen-universe evidence.

Modes: universe_mode="eligible" (primary: universe-ineligible excluded
from the economics ledger) | "diagnostic" (lower-bound cost experiment).
"""
import hashlib

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
SPREAD_MAX_BPS = 5.0  # frozen universe filter (doc 12)
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
    horizon = day_end_ns if (not is_fx and day_end_ns) else _horizon_ns(
        bar.ts_ns, is_fx)
    if horizon <= bar.ts_ns:
        return None
    fhash = hashlib.sha256(
        f"{symbol}|{bar.ts_ns}|{bv.zscore20(bars, i)}|{bv.regime(bars, i)}".encode()
    ).hexdigest()
    return make_candidate(
        strategy_version=STRATEGY_VERSION, symbol=symbol,
        snapshot_ts_ns=bar.ts_ns, proposed_side=side, proposed_family=family,
        entry_px=entry, stop_px=stop, tp_px=tp, time_exit_ns=horizon,
        exit_profile_version=EXIT_PROFILE_VERSION,
        cost_model_version=COST_MODEL_VERSION,
        expected_cost_bps=0.0,  # two-leg realized fills carry costs
        feature_snapshot_hash=fhash, feature_revision=feature_rev)


def resolve(candidate, bars_after, spread_mult=1.0, entry_spread_bps=0.0):
    """-> dict(label, realized, r_realized, exit_reason, bars_held,
    entry_fill, exit_fill, exit_ts_ns). Entry leg uses entry_spread_bps
    (candidate bar); exit leg uses the exit bar spread. Gap exits at the
    first tradable print, never clamped."""
    side = candidate.proposed_side
    entry, stop, tp = candidate.entry_px, candidate.stop_px, candidate.tp_px
    risk = abs(entry - stop)
    blank = {"label": "excluded", "realized": False, "r_realized": 0.0,
             "exit_reason": "excluded", "bars_held": 0,
             "entry_fill": 0.0, "exit_fill": 0.0, "exit_ts_ns": 0}
    if risk <= 0:
        return blank
    is_buy = side == "BUY"
    entry_fill = fill_px(side, entry, entry_spread_bps or 1.0, spread_mult)

    def r_of(exit_mid, exit_spread):
        exit_fill = fill_px(OPP[side], exit_mid, exit_spread or 1.0, spread_mult)
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
    """-> (unconstrained_pct, constrained_pct, single_binds, eff_bps, eff_frac).
    Shares = budget/risk_dist; notional = shares x entry. Frozen reference:
    25% cap x 0.1% stop = 0.00025 equity = 2.5 bps."""
    budget = equity * RISK_BUDGET_BPS / 10000.0
    unc = (budget / risk_dist * entry) / equity * 100.0 \
        if risk_dist > 0 and entry > 0 else 0.0
    con = min(unc, R2_SINGLE_PCT)
    eff_usd = min(budget, con / 100.0 * equity * (risk_dist / entry)) \
        if entry > 0 else 0.0
    eff_frac = eff_usd / equity if equity > 0 else 0.0
    return (unc, con, unc > R2_SINGLE_PCT, eff_frac * 10000.0, eff_frac)


def run(symbols_bars, equity=100000.0, spread_mult=1.0, session_fn=None,
        is_fx_fn=None, day_end_fn=None, universe_mode="eligible"):
    """Chronological multi-symbol backtest with evolving snapshot equity.

    Event stream sorted by (ts, symbol, idx). State: equity (realized PnL
    lands at exit purge, exits-first at equal ts) + open positions as
    NOTIONAL usd. Admission: symbol-free, count<3, single clamp 25%,
    total notional/equity<=75%. Rejection reasons recorded; universe
    eligibility (spread known and <=5bp) gates the primary ledger.
    """
    assert universe_mode in ("eligible", "diagnostic")
    session_fn = session_fn or (lambda sym, b: True)
    is_fx_fn = is_fx_fn or (lambda sym: True)
    events = []
    for sym, bars in symbols_bars.items():
        for i, b in enumerate(bars):
            events.append((b.ts_ns, sym, i))
    events.sort()
    records = []
    open_pos = []  # [exit_ts_ns, symbol, con_usd, pnl_at_exit]
    eq = equity
    for ts, sym, i in events:
        bars = symbols_bars[sym]
        # exits first: realized PnL lands before same-ts entries size
        still = []
        for p in open_pos:
            if p[0] <= ts:
                eq += p[3]
            else:
                still.append(p)
        open_pos = still
        c = generate(sym, bars, i, session_fn(sym, bars[i]),
                     day_end_ns=day_end_fn(sym, bars[i]) if day_end_fn else None,
                     is_fx=is_fx_fn(sym))
        if c is None:
            continue
        risk = abs(c.entry_px - c.stop_px)
        unc, con, single_binds, eff_bps, eff_frac = size_notional(eq, risk, c.entry_px)
        con_usd = con / 100.0 * eq
        eff_usd = eff_frac * eq
        res = resolve(c, bars[i + 1:], spread_mult=spread_mult,
                      entry_spread_bps=bars[i].spread_bps)
        spread_known = bars[i].spread_bps > 0
        eligible = spread_known and bars[i].spread_bps <= SPREAD_MAX_BPS
        reason = None
        taken = False
        if res["realized"]:
            if universe_mode == "eligible" and not eligible:
                reason = "universe"
            elif any(p[1] == sym for p in open_pos):
                reason = "symbol"
            elif len(open_pos) >= MAX_POSITIONS:
                reason = "maxpos"
            elif (sum(p[2] for p in open_pos) + con_usd) / eq > R2_TOTAL_PCT / 100.0:
                reason = "total_r2"
            else:
                taken = True
        pnl = res["r_realized"] * eff_usd if (taken and res["realized"]) else 0.0
        if taken:
            # exit economics frozen at entry snapshot; PnL lands at exit
            open_pos.append([res["exit_ts_ns"], sym, con_usd, pnl])
        records.append({"c": c, "res": res, "unc": unc, "con": con,
                        "single_binds": single_binds, "eff_bps": eff_bps,
                        "eff_frac": eff_frac, "con_usd": con_usd,
                        "entry_equity": eq, "taken": taken, "reason": reason,
                        "eligible": eligible, "pnl_usd": pnl,
                        "mode": universe_mode})
    return records, summarize(records, equity)


def summarize(records, start_equity):
    realized = [r for r in records if r["taken"] and r["res"]["realized"]]
    n = len(realized)
    total = sum(r["pnl_usd"] for r in realized)
    assert abs(sum(r["pnl_usd"] for r in realized) - total) < 1e-9 * max(1.0, abs(total))
    wins = [r for r in realized if r["res"]["label"] == "win"]
    rs = [r["res"]["r_realized"] for r in realized]
    end_eq = start_equity + sum(r["pnl_usd"] for r in records
                                if r["taken"] and r["res"]["realized"])
    return {
        "candidates": len(records),
        "mode": records[0]["mode"] if records else "eligible",
        "realized": n,
        "realized_wins": len(wins),
        "realized_time_exits": sum(1 for r in realized if r["res"]["exit_reason"] == "time"),
        "calib_closed_winloss": sum(1 for r in records if r["res"]["label"] in ("win", "loss")),
        "calib_censored": sum(1 for r in records if r["res"]["label"] == "censored"),
        "excluded": sum(1 for r in records if r["res"]["label"] == "excluded"),
        "universe_excluded": sum(1 for r in records if r["reason"] == "universe"),
        "cap_excluded": {k: sum(1 for r in records if r["reason"] == k)
                         for k in ("symbol", "maxpos", "total_r2")},
        "single_notional_binding_rate": (sum(1 for r in records if r["single_binds"]) /
                                         len(records)) if records else 0.0,
        "total_notional_binding_rate": (sum(1 for r in records if r["reason"] == "total_r2") /
                                        len(records)) if records else 0.0,
        "max_position_binding_rate": (sum(1 for r in records if r["reason"] == "maxpos") /
                                      len(records)) if records else 0.0,
        "win_rate": len(wins) / n if n else 0.0,
        "avg_r": sum(rs) / n if n else 0.0,
        "median_r": sorted(rs)[n // 2] if n else 0.0,
        "expectancy_r": sum(rs) / n if n else 0.0,
        "net_pnl": total,
        "end_equity": end_eq,
        "avg_effective_risk_bps": (sum(r["eff_bps"] for r in realized) / n) if n else 0.0,
        "avg_effective_risk_frac": (sum(r["eff_frac"] for r in realized) / n) if n else 0.0,
        "avg_stop_bps": (sum(abs(r["c"].entry_px - r["c"].stop_px) / r["c"].entry_px * 10000.0
                             for r in realized) / n) if n else 0.0,
        "avg_bars_held": (sum(r["res"]["bars_held"] for r in realized) / n) if n else 0.0,
        "time_exit_rate": (sum(1 for r in realized if r["res"]["exit_reason"] == "time") / n) if n else 0.0,
        "turnover": sum(r["con_usd"] for r in realized) / start_equity,
    }
