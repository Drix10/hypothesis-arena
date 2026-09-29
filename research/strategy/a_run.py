"""A-gate runner for sleeve T1 (doc 11 §11.3a). Stdlib only.

    python3 -m research.strategy.a_run t1

Registers one ledger trial per pre-registered variant BEFORE any result is
computed, runs each through the settled-cash portfolio engine at 1x and 2x
cost, gates the primary variant on the untouched holdout, and closes every
trial. A second run of unchanged code is refused (trial id reuse): the
holdout is looked at once.
"""
import hashlib
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import benchmarks, gates, ledger, portfolio, prereg, \
    sip_fetch, stats
from research.strategy.sleeves import trend

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
DATA = os.path.join(ROOT, "data", "sip")
LEDGER = os.path.join(ROOT, "research", "ledger", "trials.jsonl")
CHECKPOINT = os.path.join(ROOT, "research", "ledger", "checkpoint.json")
REPORTS = os.path.join(ROOT, "research", "reports")
CODE = ("strategy/a_run.py", "strategy/portfolio.py", "strategy/costs_v2.py",
        "strategy/settlement.py", "strategy/stats.py", "strategy/gates.py",
        "strategy/benchmarks.py", "strategy/sleeves/trend.py")
ALLOWLIST = frozenset({"VTI", "VEU", "VNQ", "IEF", "DBC", "BIL"})
FETCH_START = "2016-01-01T00:00:00Z"  # earliest history on the free feed


def code_hash():
    h = hashlib.sha256()
    base = os.path.join(ROOT, "research")
    for rel in CODE:
        with open(os.path.join(base, rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    return h.hexdigest()


def load_bars(symbols, end):
    """Fetch (or reuse) adjusted daily SIP bars; returns manifests by symbol."""
    manifests = {}
    for s in symbols:
        tag = f"{s}_bars_1Day_all"
        mp = os.path.join(DATA, tag + ".manifest.json")
        if not os.path.exists(mp):
            _load_env()
            sip_fetch.write_dataset(s, "bars", FETCH_START, end, DATA,
                                    "1Day", "all")
        with open(mp) as f:
            manifests[s] = json.load(f)
    return manifests


def _load_env():
    from collector.config import load
    cfg = load()
    for n in ("ALPACA_KEY_ID", "ALPACA_SECRET"):
        v = getattr(cfg, n, None)
        if v:
            os.environ.setdefault(n, v)


def read_prices(symbols):
    """prices[sym][date] = (open, close); volume[sym][date] = shares."""
    prices, volume = {}, {}
    for s in symbols:
        prices[s], volume[s] = {}, {}
        with open(os.path.join(DATA, f"{s}_bars_1Day_all.jsonl")) as f:
            for line in f:
                b = json.loads(line)
                d = b["t"][:10]
                if not (b["o"] > 0 and b["c"] > 0):
                    raise ValueError(f"bad-bar:{s}:{d}")
                prices[s][d] = (float(b["o"]), float(b["c"]))
                volume[s][d] = float(b["v"])
    return prices, volume


def common_sessions(prices):
    dates = None
    for s in prices:
        ds = set(prices[s])
        dates = ds if dates is None else dates & ds
    return sorted(dates)


def median_volume_20d(volume, sessions, sym, i):
    w = [volume[sym][sessions[j]] for j in range(max(0, i - 20), i)
         if sessions[j] in volume[sym]]
    return statistics.median(w) if w else 0.0


def participation_ok(trades, volume, sessions):
    idx = {d: i for i, d in enumerate(sessions)}
    worst = 0.0
    for d, sym, _side, qty, _px in trades:
        med = median_volume_20d(volume, sessions, sym, idx[d])
        if med <= 0:
            return False, None
        worst = max(worst, qty / med)
    return worst <= 0.01, worst


def close_returns(prices, sym, sessions):
    out, prev = [0.0], prices[sym][sessions[0]][1]
    for d in sessions[1:]:
        c = prices[sym][d][1]
        out.append(c / prev - 1.0)
        prev = c
    return out


def haircut_ok(r1, r2, cash):
    """50% published-effect haircut must still clear 2x cost. The 1x cost
    drag is the mean gap between the 1x and 2x series."""
    drag = stats.mean(r1) - stats.mean(r2)
    gross_excess = stats.mean(r1) + drag - stats.mean(cash)
    return 0.5 * gross_excess - 2.0 * drag > 0.0


def run_t1(pre, pre_hash, end):
    universe, variants = pre["universe"], pre["variants"]
    symbols = universe + [trend.CASH_LEG]
    if not set(symbols) <= ALLOWLIST:
        raise ValueError("non-allowlisted-symbol")
    manifests = load_bars(symbols, end)
    prices, volume = read_prices(symbols)
    sessions = common_sessions(prices)
    hs, he = pre["holdout"]["start"], pre["holdout"]["end"]
    ho = [i for i, d in enumerate(sessions) if hs <= d < he]
    if len(ho) < pre["decision"]["min_days"]:
        raise ValueError("holdout-shorter-than-min-days")
    lo, hi = ho[0], ho[-1] + 1

    led = ledger.TrialLedger(LEDGER)
    ch = code_hash()
    dh = sorted({m["sha256"] for m in manifests.values()})
    tids = {}
    for v in variants:
        tid = f"{pre['experiment_id']}:{v}:{ch[:12]}"
        led.open_trial(trial_id=tid, hypothesis_card_id=pre["experiment_id"],
                       prereg_hash=pre_hash, family=pre["family"], variant=v,
                       dataset_hashes=dh, code_hash=ch,
                       cost_model_version="cost_v2",
                       window={"start": sessions[0], "end": sessions[-1],
                               "holdout": [hs, he]},
                       split_scheme=pre["split"]["scheme"],
                       runner="research.strategy.a_run")
        tids[v] = tid
    try:
        res = {}
        for v in variants:
            for mult in (1.0, 2.0):
                fn = trend.make_target_fn(sessions, universe, v)
                res[(v, mult)] = portfolio.run(sessions, prices, fn,
                                               cost_mult=mult)
        passive = benchmarks.sixty_forty(sessions, prices, equity="VTI",
                                         bond="IEF")["returns"]
        ew = benchmarks.buy_and_hold(sessions, prices, universe)["returns"]
        cash = close_returns(prices, trend.CASH_LEG, sessions)
        sl = slice(lo, hi)
        n = led.count_trials(pre["family"])
        sharpes = [stats.sharpe(res[(v, 1.0)]["returns"][sl])
                   for v in variants]
        sr_var = statistics.variance(sharpes) if len(sharpes) > 1 else None
        matrix = [[res[(v, 1.0)]["returns"][i] for v in variants]
                  for i in range(lo, hi)]
        reports = {}
        for v in variants:
            r1 = res[(v, 1.0)]["returns"][sl]
            r2 = res[(v, 2.0)]["returns"][sl]
            part, worst = participation_ok(res[(v, 1.0)]["trades"], volume,
                                           sessions)
            rep = gates.a_gate(
                r1, r2, cash[sl], passive[sl], n, sr_var, seed=0,
                variants_matrix=matrix if len(variants) > 1 else None,
                literature=True, haircut_ok=haircut_ok(r1, r2, cash[sl]),
                transfer_ok=True, participation_ok=part)
            rep.update(variant=v, trial_id=tids[v], prereg_hash=pre_hash,
                       n_trials=n, holdout=[sessions[lo], sessions[hi - 1]],
                       sessions=hi - lo,
                       trades=len(res[(v, 1.0)]["trades"]),
                       max_participation=worst,
                       cost_usd_1x=res[(v, 1.0)]["cost_usd"],
                       full_sample_sharpe=stats.sharpe(
                           res[(v, 1.0)]["returns"], 252),
                       holdout_sharpe=stats.sharpe(r1, 252),
                       holdout_max_dd=stats.max_drawdown(r1),
                       passive_holdout_sharpe=stats.sharpe(passive[sl], 252),
                       equal_weight_bh_holdout_sharpe=stats.sharpe(
                           ew[sl], 252),
                       cash_holdout_sharpe=stats.sharpe(cash[sl], 252))
            reports[v] = rep
    except BaseException:
        for tid in tids.values():
            led.close_trial(tid, "crashed", {})
        raise
    for v in variants:
        r = reports[v]
        led.close_trial(tids[v], "pass" if r["verdict"] == "PASS" else "fail",
                        {"failed": r["failed"],
                         "holdout_sharpe": r["holdout_sharpe"]})
    led.write_checkpoint(CHECKPOINT)
    return reports


def main(argv):
    if argv[1:] != ["t1"]:
        raise SystemExit("usage: python3 -m research.strategy.a_run t1")
    path = os.path.join(ROOT, "research", "prereg", "t1_trend_etf_v1.json")
    with open(path) as f:
        pre = json.load(f)
    reports = run_t1(pre, prereg.require_valid(pre), "2026-09-01T00:00:00Z")
    os.makedirs(REPORTS, exist_ok=True)
    out = os.path.join(REPORTS, "t1_trend_etf_v1_a_gate.json")
    with open(out, "w") as f:
        f.write(gates.render(reports) + "\n")
    for v, r in reports.items():
        print(v, r["verdict"], r["failed"])


if __name__ == "__main__":
    main(sys.argv)
