"""Backtest runner (plan/validation.md): validates the prereg, registers the
trial in the ledger before any result exists, runs the holdout window through
the portfolio engine at each cost multiple, builds the benchmark set, applies
backtest_gate and writes the outcome back to the ledger. No I/O besides the
ledger."""
import copy
import hashlib

from research.strategy import benchmarks, gates, portfolio
from research.strategy import prereg as P
from research.strategy import stats

RUNNER = "research.strategy.backtest"


class BacktestError(ValueError):
    pass


def _hex(obj):
    return hashlib.sha256(P.canonical(obj)).hexdigest()


def _window(bars, holdout):
    """Prices restricted to the holdout window (inclusive) and its sessions."""
    prices = {}
    for sym, series in bars.items():
        px = {d: v for d, v in series.items()
              if holdout["start"] <= d <= holdout["end"]}
        if px:
            prices[sym] = px
    sessions = sorted({d for px in prices.values() for d in px})
    return sessions, prices


def _trial_variance(ledger, trial_id):
    """Cross-trial variance of per-period Sharpes of other closed trials, or
    None when fewer than two are recorded."""
    srs = [r["metrics"]["sharpe"] for r in ledger.rows()
           if r["kind"] == "close" and r["trial_id"] != trial_id
           and isinstance(r["metrics"].get("sharpe"), (int, float))]
    return stats.stdev(srs) ** 2 if len(srs) >= 2 else None


def run_backtest(prereg, bars, target_fn, ledger, *, variant=0, factors=None,
                 promoted=None, cost_mults=(1.0, 2.0), seed=0, margin=None,
                 cash0=100000.0, spread_bps=2.0, cash_rate=0.0, code_hash=None,
                 sr_var=None, **gate_kw):
    """Returns the report dict. `bars[sym][date] = (open, close)`; each cost
    run gets its own copy of `target_fn`. `variant` indexes
    prereg["variants"]. A prereg hash already ledgered under the same variant
    is refused. Input errors (short holdout, no SPY/IEF bars, no `sr_var` when
    the ledger cannot supply one) are refused before registration.
    `code_hash` defaults to the hash of the strategy, signal and variant.
    Extra keywords (transfer_ok, participation_ok, tstat, ...) go to
    gates.backtest_gate; missing evidence fails its condition. A failure after
    registration closes the trial as crashed and re-raises."""
    h = P.require_valid(prereg)
    if not (isinstance(variant, int) and not isinstance(variant, bool)
            and 0 <= variant < len(prereg["variants"])):
        raise BacktestError("variant-index")
    if 1.0 not in cost_mults or max(cost_mults) < prereg["decision"][
            "min_cost_multiple"]:
        raise BacktestError("cost-mults")
    var = prereg["variants"][variant]
    if any(r["kind"] == "open" and r["prereg_hash"] == h
           and r["variant"] == P.canonical(var).decode("ascii")
           for r in ledger.rows()):
        raise BacktestError("duplicate-prereg")
    sessions, prices = _window(bars, prereg["holdout"])
    if len(sessions) < 4:
        raise BacktestError("holdout-bars")
    if not all(s in prices for s in ("SPY", "IEF")):
        raise BacktestError("passive-benchmark-bars")
    trial_id = "%s-%s-v%d" % (prereg["experiment_id"], h[:12], variant)
    if sr_var is None and ledger.count_trials() + 1 > 1:
        sr_var = _trial_variance(ledger, trial_id)
        if sr_var is None:
            raise BacktestError("trial-sharpe-variance-required")
    row = ledger.open_trial(
        trial_id=trial_id, hypothesis_card_id=prereg["experiment_id"],
        prereg_hash=h, family=prereg["family"],
        variant=P.canonical(var).decode("ascii"),
        dataset_hashes=[_hex({s: sorted(px.items())
                              for s, px in sorted(prices.items())})],
        code_hash=code_hash or _hex([prereg["strategy"], prereg["signal"],
                                     var]),
        cost_model=prereg["cost_model"], window=prereg["holdout"],
        split_scheme=prereg["split"]["scheme"], runner=RUNNER)
    try:
        report = _evaluate(prereg, prices, sessions, target_fn, ledger,
                           factors, promoted, cost_mults, seed, margin, cash0,
                           spread_bps, cash_rate, sr_var, gate_kw)
    except Exception as e:
        ledger.close_trial(trial_id, "crashed", {"error": type(e).__name__})
        raise
    close = ledger.close_trial(
        trial_id, "pass" if report["verdict"] == "PASS" else "fail",
        {"sharpe": report["sharpe"], "failed": report["failed"],
         "n_sessions": len(sessions)})
    report.update(prereg_hash=h, trial={"trial_id": trial_id,
                                        "open_seq": row["seq"],
                                        "close_seq": close["seq"]})
    return report


def _evaluate(prereg, prices, sessions, target_fn, ledger, factors, promoted,
              cost_mults, seed, margin, cash0, spread_bps, cash_rate, sr_var,
              gate_kw):
    runs = {m: portfolio.run(sessions, prices, copy.deepcopy(target_fn),
                             cash0=cash0, spread_bps=spread_bps, cost_mult=m,
                             margin=margin)
            for m in sorted(cost_mults)}
    passive = benchmarks.sixty_forty(sessions, prices, cash0=cash0,
                                     spread_bps=spread_bps)["returns"]
    cash = benchmarks.cash_returns(len(sessions), cash_rate)
    r1 = runs[1.0]["returns"]
    dec = prereg["decision"]
    excess = {m: stats.sharpe([a - c for a, c in zip(r["returns"], cash)])
              for m, r in runs.items()}
    cost_multiple = max([m for m, s in excess.items() if s > 0], default=None)
    r2 = runs[max(cost_mults)]["returns"]
    n_trials = ledger.count_trials()
    ex1 = [a - c for a, c in zip(r1, cash)]
    try:
        gate_kw.setdefault("tstat", stats.hac_mean_tstat(ex1))
    except stats.StatsError:  # degenerate series: the condition fails closed
        pass
    gate = gates.backtest_gate(
        r1, r2, cash, passive, n_trials, sr_var, seed=seed, decision=dec, cost_multiple=cost_multiple, dates=sessions,
        factors=factors, promoted=promoted, **gate_kw)
    failed = list(gate["failed"])
    if len(sessions) < dec["min_days"]:
        failed.append("min_days")
    report = {"verdict": "PASS" if not failed else "FAIL", "failed": failed,
              "gate": gate, "sharpe": stats.sharpe(ex1),
              "cost_usd": {str(m): r["cost_usd"] for m, r in runs.items()},
              "n_trials": n_trials,
              "contamination_class": prereg["contamination_class"],
              "constraint_set": prereg["constraint_set"],
              "breadth": gate.get("breadth")}
    if prereg["holdout"]["rule"].startswith("seen-window"):
        report["seen_window"] = dict(prereg["holdout"])
    return report

