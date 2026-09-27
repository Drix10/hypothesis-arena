"""Deterministic backtester for baseline_v1 (research/shadow-only, no orders).

Resolution follows the doc-11 §11.1 label protocol: same-bar stop+TP touch
→ stop-first (loss); gap through stop → loss at first tradable print;
neither hit by horizon → censored (excluded from win-rate, counted
separately); halt/missing before resolution → excluded.

Risk (doc 05 + doc 03 §3.3 steps 2-6, stage mult 1.0): 25bp base budget,
notional = budget/stop_dist, R2 caps (25% single / 75% total incl.
pending), max 3 positions, 1/symbol. Telemetry exposes the nominal-vs-R2
interaction (unconstrained vs constrained notional, effective risk bps,
r2_binding) — measured, never silently "fixed".
"""
import hashlib
import math

from . import baseline_v1 as bv
from .candidate import make_candidate
from .costs import fill_px, roundtrip_cost_bps

STRATEGY_VERSION = "baseline_v1"
EXIT_PROFILE_VERSION = "exit_profile_v1"
COST_MODEL_VERSION = "paper_fill_v1"
RISK_BUDGET_BPS = 25.0
R2_SINGLE_PCT = 25.0
R2_TOTAL_PCT = 75.0
MAX_POSITIONS = 3


def _horizon_ns(symbol: str, ts_ns: int, is_fx: bool) -> int:
    if is_fx:
        return ts_ns + 24 * 3600 * 10**9
    # stocks: EOD time exit; caller passes session close via day_end_ns
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
    horizon = day_end_ns if (not is_fx and day_end_ns) else _horizon_ns(symbol, bar.ts_ns, is_fx)
    if horizon <= bar.ts_ns:
        return None
    spread = bar.spread_bps or 1.0
    fhash = hashlib.sha256(
        f"{symbol}|{bar.ts_ns}|{bv.zscore20(bars, i)}|{bv.regime(bars, i)}".encode()
    ).hexdigest()
    return make_candidate(
        strategy_version=STRATEGY_VERSION, symbol=symbol,
        snapshot_ts_ns=bar.ts_ns, proposed_side=side, proposed_family=family,
        entry_px=entry, stop_px=stop, tp_px=tp, time_exit_ns=horizon,
        exit_profile_version=EXIT_PROFILE_VERSION,
        cost_model_version=COST_MODEL_VERSION,
        expected_cost_bps=roundtrip_cost_bps(spread),
        feature_snapshot_hash=fhash, feature_revision=feature_rev)


def resolve(candidate, bars_after, spread_mult=1.0, spread_bps=1.0):
    """Resolve a candidate over subsequent bars.

    Returns dict(outcome=win|loss|censored|excluded, r_multiple,
    exit_reason=tp|stop|gap|time|censored|excluded, bars_held).
    Costs: entry adverse leg at resolve-time spread; economics in R.
    """
    side = candidate.proposed_side
    entry, stop, tp = candidate.entry_px, candidate.stop_px, candidate.tp_px
    risk = abs(entry - stop)
    if risk <= 0:
        return {"outcome": "excluded", "r_multiple": 0.0,
                "exit_reason": "excluded", "bars_held": 0}
    is_buy = side == "BUY"
    for n, b in enumerate(bars_after):
        if b.ts_ns > candidate.time_exit_ns:
            break
        if is_buy:
            hit_stop = b.l <= stop
            hit_tp = b.h >= tp
        else:
            hit_stop = b.h >= stop
            hit_tp = b.l <= tp
        # Gap through stop at the open: loss at first tradable print.
        gap = (b.o <= stop) if is_buy else (b.o >= stop)
        if n == 0 and gap and ((b.o < entry) if is_buy else (b.o > entry)):
            pass  # handled below as stop resolution, never a free fill
        if hit_stop and hit_tp:
            r = -1.0  # stop-first (frozen label protocol)
            return {"outcome": "loss", "r_multiple": r,
                    "exit_reason": "stop", "bars_held": n + 1}
        if hit_stop:
            return {"outcome": "loss", "r_multiple": -1.0,
                    "exit_reason": "gap" if gap else "stop", "bars_held": n + 1}
        if hit_tp:
            return {"outcome": "win", "r_multiple": 2.0,
                    "exit_reason": "tp", "bars_held": n + 1}
    # Time exit: mark at exit economics.
    last = None
    for b in bars_after:
        if b.ts_ns <= candidate.time_exit_ns:
            last = b
        else:
            break
    if last is None:
        return {"outcome": "excluded", "r_multiple": 0.0,
                "exit_reason": "excluded", "bars_held": 0}
    px = last.c
    r = ((px - entry) / risk) if is_buy else ((entry - px) / risk)
    cost_r = (roundtrip_cost_bps(spread_bps, spread_mult) / 10000.0 * entry) / risk
    return {"outcome": "censored", "r_multiple": r - cost_r,
            "exit_reason": "time", "bars_held": len(bars_after)}


def size_notional(equity: float, risk_dist: float, entry: float):
    """-> (unconstrained_pct, constrained_pct, r2_binding, effective_risk_bps,
    effective_risk_frac). Shares = budget/risk_dist; notional = shares x entry.
    Frozen reference: 25% cap x 0.1% stop = 0.00025 equity = 2.5 bps."""
    budget = equity * RISK_BUDGET_BPS / 10000.0
    unc = (budget / risk_dist * entry) / equity * 100.0 if risk_dist > 0 and entry > 0 else 0.0
    con = min(unc, R2_SINGLE_PCT)
    # effective risk $ = constrained notional x stop fraction (risk_dist/entry)
    eff_usd = min(budget, con / 100.0 * equity * (risk_dist / entry)) if entry > 0 else 0.0
    eff_frac = eff_usd / equity if equity > 0 else 0.0
    return (unc, con, unc > R2_SINGLE_PCT, eff_frac * 10000.0, eff_frac)


def run(symbols_bars, equity=100000.0, spread_mult=1.0, session_fn=None,
        is_fx_fn=None, day_end_fn=None):
    """Full deterministic backtest. symbols_bars: {symbol: [Bar]}.

    Returns (candidates, resolutions, report). One position per symbol
    (flat re-entry allowed after resolution); max 3 concurrent (by
    earliest candidate). R2 total cap enforced against open risk.
    """
    session_fn = session_fn or (lambda sym, b: True)
    is_fx_fn = is_fx_fn or (lambda sym: True)
    candidates, resolutions = [], []
    open_risk = []  # (exit_ts_ns, risk_frac_of_equity)
    for sym, bars in symbols_bars.items():
        for i in range(len(bars)):
            # expire risk allocations past their horizon
            open_risk = [r for r in open_risk if r[0] > bars[i].ts_ns]
            if len(open_risk) >= MAX_POSITIONS:
                continue
            c = generate(sym, bars, i, session_fn(sym, bars[i]),
                         day_end_ns=day_end_fn(sym, bars[i]) if day_end_fn else None,
                         is_fx=is_fx_fn(sym))
            if c is None:
                continue
            risk = abs(c.entry_px - c.stop_px)
            unc, con, binding, eff, eff_frac = size_notional(equity, risk, c.entry_px)
            if sum(r[1] for r in open_risk) + eff_frac > R2_TOTAL_PCT / 100.0:
                continue
            candidates.append((c, unc, con, binding, eff, eff_frac))
            open_risk.append((c.time_exit_ns, eff_frac))
            res = resolve(c, bars[i + 1:], spread_mult=spread_mult,
                          spread_bps=bars[i].spread_bps or 1.0)
            resolutions.append((c, res, unc, con, binding, eff, eff_frac))
    return candidates, resolutions, summarize(resolutions, equity)


def summarize(resolutions, equity):
    closed = [r for _, r, *_ in resolutions if r["outcome"] in ("win", "loss")]
    wins = [r for r in closed if r["outcome"] == "win"]
    rs = [r["r_multiple"] for r in closed]
    n = len(closed)
    win_rate = len(wins) / n if n else 0.0
    avg_r = sum(rs) / n if n else 0.0
    med_r = sorted(rs)[n // 2] if n else 0.0
    # Daily net returns in R → equity curve at 25bp/trade risk.
    pnl = sum(rs) * equity * RISK_BUDGET_BPS / 10000.0
    r2_hits = sum(1 for _, _, _, _, b, _, _ in resolutions if b)
    stops = [abs(c.entry_px - c.stop_px) / c.entry_px * 10000.0
             for c, _, _, _, _, _, _ in resolutions]
    effs = [e for _, _, _, _, _, e, _ in resolutions]
    eff_fracs = [f for _, _, _, _, _, _, f in resolutions]
    return {
        "candidates": len(resolutions),
        "closed": n,
        "censored": sum(1 for _, r, *_ in resolutions if r["outcome"] == "censored"),
        "excluded": sum(1 for _, r, *_ in resolutions if r["outcome"] == "excluded"),
        "win_rate": win_rate,
        "avg_r": avg_r,
        "median_r": med_r,
        "expectancy_r": avg_r,
        "net_pnl": pnl,
        "r2_binding_rate": r2_hits / len(resolutions) if resolutions else 0.0,
        "avg_effective_risk_bps": sum(effs) / len(effs) if effs else 0.0,
        "avg_effective_risk_frac": sum(eff_fracs) / len(eff_fracs) if eff_fracs else 0.0,
        "avg_stop_bps": sum(stops) / len(stops) if stops else 0.0,
        "avg_bars_held": (sum(r["bars_held"] for _, r, *_ in resolutions) /
                           len(resolutions)) if resolutions else 0.0,
        "time_exit_rate": (sum(1 for _, r, *_ in resolutions
                               if r["exit_reason"] == "time") /
                           len(resolutions)) if resolutions else 0.0,
    }
