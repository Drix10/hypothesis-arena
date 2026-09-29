"""A-gate runner for sleeve T2 (sector momentum).

    python3 -m research.strategy.a_run_t2 [--dry]

Same protocol as a_run (T1): one ledger trial per pre-registered variant is
opened before anything is computed, each variant runs through the settled-cash
engine at 1x and 2x cost, is gated on the holdout, and every trial is closed.
--dry checks plumbing only (sessions, data holes, trade counts) without the
ledger and without printing any performance figure: the holdout is looked at
once."""
import hashlib
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import a_run, benchmarks, gates, ledger, portfolio, \
    prereg, stats
from research.strategy.sleeves import sector_mom

ROOT = a_run.ROOT
CODE = ("strategy/a_run.py", "strategy/a_run_t2.py", "strategy/portfolio.py",
        "strategy/costs.py", "strategy/costs_v2.py", "strategy/settlement.py",
        "strategy/stats.py", "strategy/gates.py", "strategy/benchmarks.py",
        "strategy/ledger.py", "strategy/prereg.py", "strategy/sip_fetch.py",
        "strategy/sleeves/trend.py", "strategy/sleeves/sector_mom.py")
SECTORS = ("XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLRE", "XLU", "XLV",
           "XLY")
ALLOWLIST = frozenset(SECTORS) | {"VTI", "IEF", "BIL"}


def code_hash():
    h = hashlib.sha256()
    for rel in CODE:
        with open(os.path.join(ROOT, "research", rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    return h.hexdigest()


def run_t2(pre, pre_hash, end, dry=False):
    universe, variants = pre["universe"], pre["variants"]
    if not set(universe) <= ALLOWLIST:
        raise ValueError("non-allowlisted-symbol")
    symbols = universe + ["BIL", "VTI", "IEF"]
    manifests = a_run.load_bars(symbols, end)
    prices, volume = a_run.read_prices(symbols)
    sessions = a_run.common_sessions(prices)
    hs, he = pre["holdout"]["start"], pre["holdout"]["end"]
    ho = [i for i, d in enumerate(sessions) if hs <= d < he]
    if len(ho) < pre["decision"]["min_days"]:
        raise ValueError("holdout-shorter-than-min-days")
    lo, hi = ho[0], ho[-1] + 1

    led = tids = None
    prior = 0
    ch = code_hash()
    if not dry:
        led = ledger.TrialLedger(a_run.LEDGER)
        if os.path.exists(a_run.CHECKPOINT):
            led.verify(a_run.CHECKPOINT)
        prior = led.count_trials()
        dh = sorted({m["sha256"] for m in manifests.values()})
        tids = {}
        for v in variants:
            tid = f"{pre['experiment_id']}:{v}:{ch[:12]}"
            led.open_trial(trial_id=tid,
                           hypothesis_card_id=pre["experiment_id"],
                           prereg_hash=pre_hash, family=pre["family"],
                           variant=v, dataset_hashes=dh, code_hash=ch,
                           cost_model_version="cost_v2",
                           window={"start": sessions[0], "end": sessions[-1],
                                   "holdout": [hs, he]},
                           split_scheme=pre["split"]["scheme"],
                           runner="research.strategy.a_run_t2")
            tids[v] = tid
    try:
        res = {}
        for v in variants:
            for mult in (1.0, 2.0):
                fn = sector_mom.make_target_fn(sessions, universe, v)
                res[(v, mult)] = portfolio.run(sessions, prices, fn,
                                               cost_mult=mult)
        if dry:
            for v in variants:
                print(v, "sessions", len(sessions), sessions[0], sessions[-1],
                      "holdout_sessions", hi - lo, "trades",
                      len(res[(v, 1.0)]["trades"]))
            return {}
        passive = benchmarks.sixty_forty(sessions, prices, equity="VTI",
                                         bond="IEF")["returns"]
        ew = benchmarks.buy_and_hold(sessions, prices, universe)["returns"]
        cash = a_run.close_returns(prices, "BIL", sessions)
        sl = slice(lo, hi)
        n = (led.count_trials() if led else 0)
        sharpes = [stats.sharpe([a - c for a, c in zip(
            res[(v, 1.0)]["returns"][sl], cash[sl])]) for v in variants]
        sr_var = max(statistics.variance(sharpes) if len(sharpes) > 1 else 0.0,
                     1.0 / (hi - lo - 1))
        matrix = [[res[(v, 1.0)]["returns"][i] for v in variants]
                  for i in range(lo, hi)]
        reports = {}
        for v in variants:
            r1 = res[(v, 1.0)]["returns"][sl]
            r2 = res[(v, 2.0)]["returns"][sl]
            part, worst = a_run.participation_ok(res[(v, 1.0)]["trades"],
                                                 volume, sessions)
            rep = gates.a_gate(
                r1, r2, cash[sl], passive[sl], n, sr_var, seed=0,
                variants_matrix=matrix if len(variants) > 1 else None,
                literature=True,
                haircut_ok=a_run.haircut_ok(r1, r2, cash[sl]),
                transfer_ok=set(symbols) <= ALLOWLIST,
                participation_ok=part, decision=pre["decision"],
                cost_multiple=2.0)
            ex = [a - c for a, c in zip(r1, cash[sl])]
            rep.update(variant=v, trial_id=(tids or {}).get(v),
                       prereg_hash=pre_hash, n_trials=n, prior_trials=prior,
                       holdout=[sessions[lo], sessions[hi - 1]],
                       sessions=hi - lo,
                       trades=len(res[(v, 1.0)]["trades"]),
                       max_participation=worst,
                       cost_usd_1x=res[(v, 1.0)]["cost_usd"],
                       full_sample_sharpe=stats.sharpe(
                           res[(v, 1.0)]["returns"], 252),
                       holdout_sharpe_excess=stats.sharpe(ex, 252),
                       holdout_max_dd=stats.max_drawdown(r1),
                       passive_holdout_sharpe=stats.sharpe(passive[sl], 252),
                       equal_weight_bh_holdout_sharpe=stats.sharpe(
                           ew[sl], 252),
                       cash_holdout_sharpe=stats.sharpe(cash[sl], 252))
            reports[v] = rep
    except BaseException:
        for tid in (tids or {}).values():
            led.close_trial(tid, "crashed", {})
        raise
    if led:
        for v in variants:
            r = reports[v]
            led.close_trial(tids[v],
                            "pass" if r["verdict"] == "PASS" else "fail",
                            {"failed": r["failed"],
                             "holdout_sharpe_excess":
                                 r["holdout_sharpe_excess"]})
        led.write_checkpoint(a_run.CHECKPOINT)
    return reports


def main(argv):
    dry = argv[1:] == ["--dry"]
    if argv[1:] and not dry:
        raise SystemExit("usage: python3 -m research.strategy.a_run_t2 [--dry]")
    path = os.path.join(ROOT, "research", "prereg", "t2_sector_mom_v1.json")
    with open(path) as f:
        pre = json.load(f)
    reports = run_t2(pre, prereg.require_valid(pre), "2026-09-01T00:00:00Z",
                     dry=dry)
    if dry:
        return
    for v, r in reports.items():
        print(v, r["verdict"], r["failed"])
    os.makedirs(a_run.REPORTS, exist_ok=True)
    out = os.path.join(a_run.REPORTS, "t2_sector_mom_v1_a_gate.json")
    with open(out, "w") as f:
        f.write(gates.render(reports) + "\n")


if __name__ == "__main__":
    main(sys.argv)
