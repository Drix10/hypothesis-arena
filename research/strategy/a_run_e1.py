"""A-gate runner for sleeve E1 (insider purchases).

    python3 -m research.strategy.a_run_e1

Opens one ledger trial per pre-registered variant before any return is
computed, runs each at 1x and 2x cost through the settled-cash engine, gates
it on the holdout and closes every trial. Unchanged code cannot be run
twice (trial ids embed the code hash)."""
import glob
import hashlib
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import (a_run, benchmarks, bulk_bars, gates,
                               insider_data, ledger, portfolio, prereg,
                               sip_fetch, stats)
from research.strategy.sleeves.insider import InsiderSleeve

ROOT = a_run.ROOT
E1 = os.path.join(ROOT, "data", "e1")
DERA = os.path.join(ROOT, "data", "dera")
RAW, SPLIT = os.path.join(E1, "raw"), os.path.join(E1, "split")
CODE = ("strategy/a_run_e1.py", "strategy/a_run.py", "strategy/insider_data.py",
        "strategy/portfolio.py", "strategy/costs.py", "strategy/costs_v2.py",
        "strategy/settlement.py", "strategy/stats.py", "strategy/gates.py",
        "strategy/benchmarks.py", "strategy/ledger.py", "strategy/prereg.py",
        "strategy/sip_fetch.py", "strategy/bulk_bars.py",
        "strategy/sleeves/insider.py")
TIERS = {
    "tierA_opp": dict(min_price=2.0, min_dollar_volume=2e6, min_insiders=1,
                      spread_bps=50.0),
    "tierB_opp": dict(min_price=5.0, min_dollar_volume=20e6, min_insiders=1,
                      spread_bps=10.0),
    "tierA_cluster": dict(min_price=2.0, min_dollar_volume=2e6,
                          min_insiders=2, spread_bps=50.0),
}
SAMPLE_START = "2016-01-04"
FETCH_START, FETCH_END = "2016-01-01T00:00:00Z", "2026-09-01T00:00:00Z"
MIN_VALUE = 25000.0
REFERENCE = ("VTI", "IEF", "BIL")


def code_hash():
    h = hashlib.sha256()
    for rel in CODE:
        with open(os.path.join(ROOT, "research", rel), "rb") as f:
            h.update(rel.encode() + b"\0" + f.read() + b"\0")
    return h.hexdigest()


def build_events():
    rows = []
    for p in sorted(glob.glob(os.path.join(DERA, "*_form345.zip"))):
        rows += insider_data.read_quarter(p)
    events = [e for e in insider_data.build_events(rows)
              if e["date"] >= SAMPLE_START and e["value"] >= MIN_VALUE]
    digest = hashlib.sha256()
    for p in sorted(glob.glob(os.path.join(DERA, "*_form345.zip"))):
        with open(p, "rb") as f:
            digest.update(hashlib.sha256(f.read()).digest())
    return events, digest.hexdigest()


def read_symbol(directory, sym):
    """Bars as {date: (open, high, low, close, volume)}; {} if none."""
    out = {}
    path = sip_fetch.dataset_paths(directory, sym, "bars", "1Day",
                                   os.path.basename(directory))[0]
    try:
        with open(path) as f:
            for line in f:
                b = json.loads(line)
                if b["o"] > 0 and b["c"] > 0:
                    out[b["t"][:10]] = (float(b["o"]), float(b["h"]),
                                        float(b["l"]), float(b["c"]),
                                        float(b["v"]))
    except OSError:
        return {}
    return out


def folder_digest(directory, syms):
    h = hashlib.sha256()
    for s in sorted(syms):
        try:
            m = sip_fetch.verify_dataset(directory, s, "bars", "1Day",
                                         os.path.basename(directory))
        except (OSError, ValueError):
            continue
        h.update(m["sha256"].encode())
    return h.hexdigest()


def eligible_symbols(events, raw_syms, sessions):
    """(keep, with_data): symbols with a tier-A-eligible event (a superset of
    the other tiers) and symbols that have any bars at all."""
    keep, with_data = set(), set()
    for s in raw_syms:
        bars = read_symbol(RAW, s)
        if not bars:
            continue
        with_data.add(s)
        raw = {s: {d: (b[0], b[3], b[4]) for d, b in bars.items()}}
        sl = InsiderSleeve([], raw, {}, sessions, min_price=2.0,
                           min_dollar_volume=2e6)
        for e in events:
            if e["symbol"] == s and sl._eligible(s, _session(sessions, e["date"])):
                keep.add(s)
                break
    return keep, with_data


def _session(sessions, d):
    import bisect
    i = bisect.bisect_left(sessions, d)
    return sessions[min(i, len(sessions) - 1)]


def entered_symbols(events, raw, adj, sessions, tier, never=()):
    sl = _sleeve(events, raw, adj, sessions, tier, never)
    ent = set()
    for d in sessions:
        w = sl.target_fn(d, {})
        ent |= set(w or {})
    return ent


def _sleeve(events, raw, adj, sessions, tier, never=()):
    t = TIERS[tier]
    return InsiderSleeve(events, raw, adj, sessions, min_price=t["min_price"],
                         min_dollar_volume=t["min_dollar_volume"],
                         min_insiders=t["min_insiders"], min_value=MIN_VALUE,
                         never_eligible=never)


def run(pre, pre_hash, log=print):
    variants = pre["variants"]
    events, events_digest = build_events()
    log(f"events {len(events)}")
    a_run.DATA  # reference bars come from the T1 dataset folder
    ref_m = a_run.load_bars(list(REFERENCE) + ["IWM"], FETCH_END)
    ref, _ = a_run.read_prices(list(REFERENCE) + ["IWM"])
    sessions = [d for d in a_run.common_sessions(ref) if d >= SAMPLE_START]
    ev_syms = sorted({e["symbol"] for e in events})
    raw_syms = [s for s in ev_syms
                if os.path.exists(sip_fetch.dataset_paths(
                    RAW, s, "bars", "1Day", "raw")[1])]
    log(f"event symbols {len(ev_syms)} with raw bars {len(raw_syms)}")
    keep, with_data = eligible_symbols(events, raw_syms, sessions)
    never = with_data - keep
    log(f"symbols with data {len(with_data)}, tier-A eligible {len(keep)}")
    _, failed = bulk_bars.fetch_all(sorted(keep), "split", SPLIT, FETCH_START,
                                    FETCH_END, log=log)
    if failed:
        log(f"split fetch failures {len(failed)}")
    raw, adj, vol = {}, {}, {}
    for s in sorted(keep):
        r, a = read_symbol(RAW, s), read_symbol(SPLIT, s)
        if r and a:
            raw[s] = {d: (b[0], b[3], b[4]) for d, b in r.items()}
            adj[s] = {d: (b[0], b[1], b[2], b[3]) for d, b in a.items()}
            vol[s] = {d: b[4] for d, b in r.items()}

    hs, he = pre["holdout"]["start"], pre["holdout"]["end"]
    ho = [i for i, d in enumerate(sessions) if hs <= d < he]
    if len(ho) < pre["decision"]["min_days"]:
        raise ValueError("holdout-shorter-than-min-days")
    lo, hi = ho[0], ho[-1] + 1
    cash = a_run.close_returns(ref, "BIL", sessions)
    ref_px = {s: ref[s] for s in ("VTI", "IEF")}
    passive = benchmarks.sixty_forty(sessions, ref_px, equity="VTI",
                                     bond="IEF")["returns"]
    iwm = a_run.close_returns(ref, "IWM", sessions)

    led = ledger.TrialLedger(a_run.LEDGER)
    if os.path.exists(a_run.CHECKPOINT):
        led.verify(a_run.CHECKPOINT)
    prior = led.count_trials()
    ch = code_hash()
    dh = sorted({events_digest, folder_digest(RAW, raw_syms),
                 folder_digest(SPLIT, keep)} |
                {m["sha256"] for m in ref_m.values()})
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
                       runner="research.strategy.a_run_e1")
        tids[v] = tid
    try:
        res, sl_stats = {}, {}
        for v in variants:
            ent = entered_symbols(events, raw, adj, sessions, v, never)
            prices = {s: {d: (b[0], b[3]) for d, b in adj[s].items()}
                      for s in ent}
            prices["BIL"] = ref["BIL"]
            for mult in (1.0, 2.0):
                sl = _sleeve(events, raw, adj, sessions, v, never)
                res[(v, mult)] = portfolio.run(
                    sessions, prices, sl.target_fn,
                    spread_bps=TIERS[v]["spread_bps"], cost_mult=mult,
                    cash_returns=cash)
                if mult == 1.0:
                    sl_stats[v] = dict(sl.stats)
        sl = slice(lo, hi)
        n = led.count_trials()
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
            st = sl_stats[v]
            part, worst = a_run.participation_ok(res[(v, 1.0)]["trades"], vol,
                                                 sessions)
            excl = (st["no_data"] + st["orphan"]) / max(1, st["considered"])
            rep = gates.a_gate(
                r1, r2, cash[sl], passive[sl], n, sr_var, seed=0,
                variants_matrix=matrix, literature=True,
                haircut_ok=a_run.haircut_ok(r1, r2, cash[sl]),
                transfer_ok=True, participation_ok=part,
                is_event_sleeve=True, excluded_event_frac=excl,
                decision=pre["decision"], cost_multiple=2.0)
            ex = [a - c for a, c in zip(r1, cash[sl])]
            rep.update(variant=v, trial_id=tids[v], prereg_hash=pre_hash,
                       n_trials=n, prior_trials=prior,
                       holdout=[sessions[lo], sessions[hi - 1]],
                       sessions=hi - lo,
                       trades=len(res[(v, 1.0)]["trades"]),
                       sleeve_stats=st, max_participation=worst,
                       cost_usd_1x=res[(v, 1.0)]["cost_usd"],
                       full_sample_sharpe=stats.sharpe(
                           res[(v, 1.0)]["returns"], 252),
                       holdout_sharpe_excess=stats.sharpe(ex, 252),
                       holdout_max_dd=stats.max_drawdown(r1),
                       passive_holdout_sharpe=stats.sharpe(passive[sl], 252),
                       iwm_holdout_sharpe=stats.sharpe(iwm[sl], 252),
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
                         "holdout_sharpe_excess": r["holdout_sharpe_excess"]})
    led.write_checkpoint(a_run.CHECKPOINT)
    return reports


def main():
    path = os.path.join(ROOT, "research", "prereg", "e1_insider_buy_v1.json")
    with open(path) as f:
        pre = json.load(f)
    reports = run(pre, prereg.require_valid(pre),
                  log=lambda m: print(m, flush=True))
    os.makedirs(a_run.REPORTS, exist_ok=True)
    out = os.path.join(a_run.REPORTS, "e1_insider_buy_v1_a_gate.json")
    with open(out, "w") as f:
        f.write(gates.render(reports) + "\n")
    for v, r in reports.items():
        print(v, r["verdict"], r["failed"])


if __name__ == "__main__":
    main()
