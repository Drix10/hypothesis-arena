"""A-gate runner for sleeve I1 (intraday momentum on SPY).

    python3 -m research.strategy.a_run_i1 [--dry]

Same protocol as a_run: one ledger trial per pre-registered variant is opened
before anything is computed, each variant is simulated at 1x and 2x cost, gated
on the holdout, and every trial is closed. --dry checks plumbing only (bars per
day, skipped sessions, trade counts) without the ledger and without printing
any performance figure: the holdout is looked at once."""
import datetime
import hashlib
import json
import os
import statistics
import sys
import zoneinfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import a_run, benchmarks, gates, ledger, prereg, \
    sip_fetch, stats
from research.strategy.sleeves import intraday_mom

ROOT = a_run.ROOT
DATA = a_run.DATA
CODE = ("strategy/a_run.py", "strategy/a_run_i1.py", "strategy/costs.py",
        "strategy/costs_v2.py", "strategy/stats.py", "strategy/gates.py",
        "strategy/benchmarks.py", "strategy/ledger.py", "strategy/prereg.py",
        "strategy/sip_fetch.py", "strategy/sleeves/intraday_mom.py")
ALLOWLIST = frozenset({"SPY", "VTI", "IEF", "BIL"})
ET = zoneinfo.ZoneInfo("America/New_York")
BARS = "30Min"


def code_hash():
    h = hashlib.sha256()
    for rel in CODE:
        with open(os.path.join(ROOT, "research", rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    return h.hexdigest()


def load_intraday(end):
    args = (DATA, "SPY", "bars", BARS, "all")
    if not os.path.exists(sip_fetch.dataset_paths(*args)[1]):
        a_run._load_env()
        sip_fetch.write_dataset("SPY", "bars", a_run.FETCH_START, end, DATA,
                                BARS, "all")
    return sip_fetch.verify_dataset(*args)


EARLY_CLOSE_VOLUME_RATIO = 0.25


def read_days():
    """days[date] = [(open, close)] for regular-session 30-minute bars.

    The feed carries extended-hours bars, so on a 13:00 early close the hours
    after the bell still look like a full session. Those days are detected from
    the data (the 15:30 bar, where the trade is placed, trades a fraction of
    the 12:30 bar) and dropped: a 15:30 entry there would be an after-hours
    fill. The same rule drops sessions with a data hole at the entry bar."""
    raw = {}
    path = os.path.join(DATA, f"SPY_bars_{BARS}_all.jsonl")
    with open(path) as f:
        for line in f:
            b = json.loads(line)
            t = datetime.datetime.fromisoformat(
                b["t"].replace("Z", "+00:00")).astimezone(ET)
            if not (datetime.time(9, 30) <= t.time() < datetime.time(16, 0)):
                continue
            if not (b["o"] > 0 and b["c"] > 0):
                raise ValueError(f"bad-bar:{b['t']}")
            raw.setdefault(t.date().isoformat(), []).append(
                (t.time(), float(b["o"]), float(b["c"]), float(b["v"])))
    days, dropped = {}, []
    for d, bars in raw.items():
        vol = {t: v for t, _o, _c, v in bars}
        v1230, v1530 = vol.get(datetime.time(12, 30)), \
            vol.get(datetime.time(15, 30))
        if v1230 and v1530 is not None and \
                v1530 < EARLY_CLOSE_VOLUME_RATIO * v1230:
            dropped.append(d)
            continue
        days[d] = [(o, c) for _t, o, c, _v in bars]
    return days, sorted(dropped)


def run_i1(pre, pre_hash, end, dry=False):
    variants = pre["variants"]
    manifest = load_intraday(end)
    days, early = read_days()
    symbols = ["SPY", "VTI", "IEF", "BIL"]
    if not set(symbols) <= ALLOWLIST:
        raise ValueError("non-allowlisted-symbol")
    dman = a_run.load_bars(symbols, end)
    prices, volume = a_run.read_prices(symbols)
    sessions = a_run.common_sessions(prices)
    hs, he = pre["holdout"]["start"], pre["holdout"]["end"]
    ho = [i for i, d in enumerate(sessions) if hs <= d < he]
    if len(ho) < pre["decision"]["min_days"]:
        raise ValueError("holdout-shorter-than-min-days")
    lo, hi = ho[0], ho[-1] + 1
    complete = sum(1 for d in sessions
                   if len(days.get(d, ())) == intraday_mom.BARS_PER_DAY)

    led = tids = None
    prior = 0
    ch = code_hash()
    if not dry:
        led = ledger.TrialLedger(a_run.LEDGER)
        if os.path.exists(a_run.CHECKPOINT):
            led.verify(a_run.CHECKPOINT)
        prior = led.count_trials()
        dh = sorted({manifest["sha256"]} |
                    {m["sha256"] for m in dman.values()})
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
                           runner="research.strategy.a_run_i1")
            tids[v] = tid
    try:
        cash = a_run.close_returns(prices, "BIL", sessions)
        res = {}
        for v in variants:
            for mult in (1.0, 2.0):
                res[(v, mult)] = intraday_mom.simulate(days, sessions, v,
                                                       mult=mult)
        if dry:
            for v in variants:
                print(v, "sessions", len(sessions), "complete_days", complete,
                      "early_close_dropped", len(early), early,
                      "holdout_sessions", hi - lo, "trades",
                      len(res[(v, 1.0)]["trades"]) // 2)
            return {}
        passive = benchmarks.sixty_forty(sessions, prices, equity="VTI",
                                         bond="IEF")["returns"]
        buy_hold = a_run.close_returns(prices, "SPY", sessions)
        # Idle cash earns the BIL return; the trade adds its net profit.
        series = {k: [c + p for c, p in zip(cash, r["pnl"])]
                  for k, r in res.items()}
        sl = slice(lo, hi)
        n = led.count_trials()
        sharpes = [stats.sharpe([a - c for a, c in zip(
            series[(v, 1.0)][sl], cash[sl])]) for v in variants]
        sr_var = max(statistics.variance(sharpes) if len(sharpes) > 1 else 0.0,
                     1.0 / (hi - lo - 1))
        matrix = [[series[(v, 1.0)][i] for v in variants]
                  for i in range(lo, hi)]
        reports = {}
        for v in variants:
            r1 = series[(v, 1.0)][sl]
            r2 = series[(v, 2.0)][sl]
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
            rep.update(variant=v, trial_id=tids[v], prereg_hash=pre_hash,
                       n_trials=n, prior_trials=prior,
                       holdout=[sessions[lo], sessions[hi - 1]],
                       sessions=hi - lo,
                       trades=len(res[(v, 1.0)]["trades"]) // 2,
                       max_participation=worst,
                       cost_usd_1x=res[(v, 1.0)]["cost_usd"],
                       full_sample_sharpe=stats.sharpe(series[(v, 1.0)], 252),
                       holdout_sharpe_excess=stats.sharpe(ex, 252),
                       holdout_max_dd=stats.max_drawdown(r1),
                       passive_holdout_sharpe=stats.sharpe(passive[sl], 252),
                       buy_hold_spy_holdout_sharpe=stats.sharpe(
                           buy_hold[sl], 252),
                       cash_holdout_sharpe=stats.sharpe(cash[sl], 252))
            reports[v] = rep
    except BaseException:
        for tid in (tids or {}).values():
            led.close_trial(tid, "crashed", {})
        raise
    for v in variants:
        r = reports[v]
        led.close_trial(tids[v], "pass" if r["verdict"] == "PASS" else "fail",
                        {"failed": r["failed"],
                         "holdout_sharpe_excess": r["holdout_sharpe_excess"]})
    led.write_checkpoint(a_run.CHECKPOINT)
    return reports


def main(argv):
    dry = argv[1:] == ["--dry"]
    if argv[1:] and not dry:
        raise SystemExit("usage: python3 -m research.strategy.a_run_i1 [--dry]")
    path = os.path.join(ROOT, "research", "prereg", "i1_intraday_mom_v1.json")
    with open(path) as f:
        pre = json.load(f)
    reports = run_i1(pre, prereg.require_valid(pre), "2026-09-01T00:00:00Z",
                     dry=dry)
    if dry:
        return
    for v, r in reports.items():
        print(v, r["verdict"], r["failed"])
    os.makedirs(a_run.REPORTS, exist_ok=True)
    out = os.path.join(a_run.REPORTS, "i1_intraday_mom_v1_a_gate.json")
    with open(out, "w") as f:
        f.write(gates.render(reports) + "\n")


if __name__ == "__main__":
    main(sys.argv)
