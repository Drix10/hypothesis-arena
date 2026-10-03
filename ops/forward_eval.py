"""Read-only evaluator for the forward shadow ledgers (<dir>/sleeves/*.jsonl).

    python3 ops/forward_eval.py <dir> [--json]

Every forward ledger is judged against a benchmark ledger of
ops/forward_ledgers.py (BENCHMARKS); the result is evidence, never a promotion.
This tool never places orders, never fetches prices and never touches a
ledger; its only write is <dir>/sleeves/eval.json (atomic).

Per non-benchmark ledger, from its daily rows (the first row is the rebase
row with ret 0.0 by construction and is not a return observation):
  sessions, cumulative return, annualised return / vol / Sharpe (excess of
  bench_cash_bil_v1, paired by date), max drawdown; and the PAIRED daily
  active return against its benchmark (MAPPING): mean, HAC t-stat
  (stats.hac_mean_tstat), 95% stationary-bootstrap CI of the annualised active
  return (stats.bootstrap_ci), tracking error, information ratio. One-sided
  p-values (H1: active mean > 0) come from the HAC t-stat.

Multiplicity (plan/11 section 11.0b: Holm): one Holm (stats.holm) over every
non-benchmark ledger present in the directory. The family is the ledger set,
not "the ledgers that have matured", so it cannot shrink by ignoring a young
or broken ledger: a ledger whose p-value cannot be computed (too few
observations, zero variance, no benchmark, broken chain) enters the family
with p = 1.0.

Checkpoint decision (pre-set, from the plan; constants below, never tuned):
  sessions < WARMUP_SESSIONS (60)          WARMUP: plumbing / fidelity only,
                                           no judgement.
  sessions >= 60                           CONTINUE, unless
  KILL-FUTILE   the 95% bootstrap CI UPPER bound of the annualised active
                return is below 0 AND sessions >= FUTILITY_SESSIONS (126).
  EVIDENCE-INSUFFICIENT is the normal evidence state until sessions >=
  REVIEW_SESSIONS (504, two years).
  ELIGIBLE-FOR-REVIEW only when sessions >= 504 AND Holm-adjusted p < 0.05
  AND the CI lower bound > 0 AND the ledger's max drawdown is not larger than
  its benchmark's over the same dates. ELIGIBLE-FOR-REVIEW only means that a
  human MAY review the ledger. It is never a promotion, an approval or a
  trading signal.

Fidelity: every ledger goes through forward_ledgers.read_log (hash chain). A
broken chain is reported loudly, excludes that ledger from the statistics and
makes the CLI exit 3. Replay-vs-log fidelity needs prices and is checked by
`ops/forward_ledgers.py --verify`, not here.
"""
import json
import math
import os
import sys
from statistics import NormalDist

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ops import forward_ledgers as S
from research.strategy import stats

ANNUAL = 252
WARMUP_SESSIONS = 60
FUTILITY_SESSIONS = 126
REVIEW_SESSIONS = 504
ALPHA = 0.05
CI_LEVEL = 0.95
Z_ONE_SIDED_95 = 1.645
BOOT_B = 2000
SEED = 20260930
CASH_BENCH = S.BENCH_CASH

NOTICE = ("ELIGIBLE-FOR-REVIEW only means a human may review the ledger; it is "
          "never a promotion.")

# Ledger id prefix -> (benchmark ledger id, reason). Longest matching prefix
# wins. A sleeve that passes its A-gate adds its mapping here.
MAPPING = {
    "core_passive": (S.BENCH_SPY,
                     "core is the 60/40 sanity reference (plan/12 s12.6 item 3); "
                     "scored against SPY buy-and-hold to show what the passive "
                     "equity alternative did"),
}


def benchmark_for(sid):
    """(benchmark id, reason) or (None, None) when the ledger has no mapping."""
    hit = [k for k in MAPPING if sid.startswith(k)]
    if not hit:
        return None, None
    return MAPPING[max(hit, key=len)]


# ------------------------------------------------------------------ inputs

def _read_ledger(path):
    """(rows, None) or (None, 'why') - the chain check is S.read_log."""
    try:
        rows, _ = S.read_log(path)
        for a, b in zip(rows, rows[1:]):
            if not a["date"] < b["date"]:
                return None, "date-order:" + b["date"]
    except (ValueError, KeyError, TypeError, OSError) as e:
        return None, str(e) or repr(e)
    return rows, None


def _rets(rows):
    """{date: ret} of the return observations (row 0 is the rebase row)."""
    return {r["date"]: float(r["ret"]) for r in rows[1:]}


# ------------------------------------------------------------------ maths

def one_sided_p(t):
    """P(T >= t) under the normal approximation; 1.0 when undefined."""
    return 1.0 if t is None else 1.0 - NormalDist().cdf(t)


def holm_adjusted(ps):
    """Holm step-down adjusted p-values in input order."""
    m = len(ps)
    order = sorted(range(m), key=lambda i: ps[i])
    out, run = [1.0] * m, 0.0
    for rank, i in enumerate(order):
        run = max(run, min(1.0, (m - rank) * ps[i]))
        out[i] = run
    return out


def describe(rets, cash=None):
    """Level statistics of a daily return list. `cash` = matching daily cash
    returns (same length) for the excess Sharpe, or None -> None ('n/a')."""
    n = len(rets)
    out = {"n_returns": n, "cum_return": None, "ann_return": None,
           "ann_vol": None, "sharpe_excess_cash": None, "max_drawdown": None}
    if n < 1:
        return out
    cum = 1.0
    for r in rets:
        cum *= 1.0 + r
    out["cum_return"] = cum - 1.0
    if cum > 0:
        out["ann_return"] = cum ** (ANNUAL / n) - 1.0
    out["max_drawdown"] = stats.max_drawdown(rets)
    if n >= 2:
        out["ann_vol"] = stats.stdev(rets) * math.sqrt(ANNUAL)
        if cash is not None and len(cash) == n:
            out["sharpe_excess_cash"] = stats.sharpe(
                [a - c for a, c in zip(rets, cash)], ANNUAL)
    return out


def paired_stats(active, boot_b=BOOT_B, seed=SEED):
    """HAC / bootstrap / IR of a daily active-return list (missing -> None)."""
    n = len(active)
    out = {"n": n, "mean_daily": None, "active_ann": None, "t_hac": None,
           "p_one_sided": 1.0, "ci95_active_ann": None,
           "tracking_error_ann": None, "ir_ann": None}
    if n < 1:
        return out
    m = stats.mean(active)
    out["mean_daily"], out["active_ann"] = m, m * ANNUAL
    if n >= 3:
        try:
            out["t_hac"] = stats.hac_mean_tstat(active)
        except stats.StatsError:
            pass
        out["p_one_sided"] = one_sided_p(out["t_hac"])
    if n >= 4:
        lo, hi = stats.bootstrap_ci(
            active, lambda x: stats.mean(x) * ANNUAL, level=CI_LEVEL,
            b=boot_b, seed=seed)
        out["ci95_active_ann"] = [lo, hi]
    if n >= 2:
        sd = stats.stdev(active)
        out["tracking_error_ann"] = sd * math.sqrt(ANNUAL)
        if sd > 0:
            out["ir_ann"] = m / sd * math.sqrt(ANNUAL)
    return out


def power_line(ir_ann, n_returns):
    """Sessions for the OBSERVED annualised IR to reach one-sided 95%:
    (1.645 / IR_ann)^2 * 252 when IR > 0, else 'n/a'."""
    if ir_ann is None or not ir_ann > 0:
        return {"ir_ann": ir_ann, "sessions_needed": "n/a",
                "more_needed": "n/a"}
    need = math.ceil((Z_ONE_SIDED_95 / ir_ann) ** 2 * ANNUAL)
    return {"ir_ann": ir_ann, "sessions_needed": need,
            "more_needed": max(0, need - n_returns)}


def decide(sessions, ci, adj_p, dd_ok):
    """(state, evidence, reasons) from the pre-set rules (module docstring)."""
    if sessions < WARMUP_SESSIONS:
        return ("WARMUP", "n/a (warmup)",
                ["%d < %d sessions: plumbing/fidelity only, no judgement"
                 % (sessions, WARMUP_SESSIONS)])
    lo, hi = ci if ci else (None, None)
    if sessions >= FUTILITY_SESSIONS and hi is not None and hi < 0:
        return ("KILL-FUTILE", "EVIDENCE-INSUFFICIENT",
                ["95%% CI upper bound of annualised active return %.4f < 0 at "
                 "%d >= %d sessions" % (hi, sessions, FUTILITY_SESSIONS)])
    if sessions < REVIEW_SESSIONS:
        return ("CONTINUE", "EVIDENCE-INSUFFICIENT",
                ["%d < %d sessions (2 years): evidence is insufficient by "
                 "construction" % (sessions, REVIEW_SESSIONS)])
    missing = []
    if adj_p is None or not adj_p < ALPHA:
        missing.append("Holm-adjusted p not < %.2f" % ALPHA)
    if lo is None or not lo > 0:
        missing.append("CI lower bound not > 0")
    if not dd_ok:
        missing.append("max drawdown larger than benchmark's")
    if missing:
        return "CONTINUE", "EVIDENCE-INSUFFICIENT", missing
    return ("ELIGIBLE-FOR-REVIEW", "REVIEW-CRITERIA-MET",
            ["criteria met: a human MAY review; this is not a promotion"])


# ------------------------------------------------------------------ driver

def evaluate(d, boot_b=BOOT_B, seed=SEED):
    sd = os.path.join(d, "sleeves")
    names = sorted(f[:-6] for f in os.listdir(sd)
                   if f.endswith(".jsonl")) if os.path.isdir(sd) else []
    ledgers, broken = {}, {}
    for sid in names:
        rows, why = _read_ledger(os.path.join(sd, sid + ".jsonl"))
        if why:
            broken[sid] = why
        else:
            ledgers[sid] = rows
    cash = _rets(ledgers[CASH_BENCH]) if CASH_BENCH in ledgers else None

    def cash_for(dates):
        if cash is None or any(x not in cash for x in dates):
            return None
        return [cash[x] for x in dates]

    res = {"schema": "sleeve_eval_v1", "notice": NOTICE,
           "asof": max((r[-1]["date"] for r in ledgers.values() if r),
                       default=None),
           "rules": {"warmup_sessions": WARMUP_SESSIONS,
                     "futility_sessions": FUTILITY_SESSIONS,
                     "review_sessions": REVIEW_SESSIONS, "alpha": ALPHA,
                     "bootstrap_b": boot_b, "seed": seed},
           "fidelity": {
               "ok": not broken,
               "chain_failures": dict(broken),
               "note": "hash chain only; replay-vs-log fidelity needs prices: "
                       "run ops/forward_ledgers.py --verify"},
           "mapping": {k: {"benchmark": v[0], "reason": v[1]}
                       for k, v in MAPPING.items()},
           "benchmarks": {}, "ledgers": {}, "holm": {}}

    for sid in names:
        if sid not in S.BENCHMARKS:
            continue
        if sid in broken:
            res["benchmarks"][sid] = {"fidelity": "CHAIN-BROKEN: " + broken[sid],
                                      "sessions": None}
            continue
        r = _rets(ledgers[sid])
        ds = sorted(r)
        e = describe([r[x] for x in ds], cash_for(ds))
        e.update(sessions=len(ledgers[sid]),
                 last_date=ledgers[sid][-1]["date"] if ledgers[sid] else None,
                 fidelity="chain-ok")
        res["benchmarks"][sid] = e

    ev_ids = [s for s in names if s not in S.BENCHMARKS]
    for sid in ev_ids:
        bid, reason = benchmark_for(sid)
        e = {"benchmark": bid, "mapping_reason": reason, "sessions": None,
             "last_date": None, "fidelity": "chain-ok", "returns": None,
             "paired": None, "power": None, "checkpoint": None}
        res["ledgers"][sid] = e
        if sid in broken:
            e["fidelity"] = "CHAIN-BROKEN: " + broken[sid]
            e["checkpoint"] = {"state": "CHAIN-BROKEN", "evidence": "n/a",
                               "reasons": [broken[sid]]}
            continue
        rows = ledgers[sid]
        e["sessions"] = len(rows)
        e["last_date"] = rows[-1]["date"] if rows else None
        if bid is None:
            e["checkpoint"] = {"state": "NO-MAPPING", "evidence": "n/a",
                               "reasons": ["no benchmark mapping for " + sid]}
            continue
        r = _rets(rows)
        ds = sorted(r)
        e["returns"] = describe([r[x] for x in ds], cash_for(ds))
        if bid in broken or bid not in ledgers:
            why = (bid + " chain broken: " + broken[bid]) if bid in broken \
                else bid + " ledger missing"
            e["checkpoint"] = {"state": "NO-BENCHMARK", "evidence": "n/a",
                               "reasons": [why]}
            continue
        b = _rets(ledgers[bid])
        common = [x for x in ds if x in b]
        p = paired_stats([r[x] - b[x] for x in common], boot_b, seed)
        p["ledger_max_dd_paired"] = (stats.max_drawdown([r[x] for x in common])
                                     if common else None)
        p["bench_max_dd_paired"] = (stats.max_drawdown([b[x] for x in common])
                                    if common else None)
        p["dd_ok"] = (p["ledger_max_dd_paired"] is not None
                      and p["ledger_max_dd_paired"] <= p["bench_max_dd_paired"])
        e["paired"] = p
        e["power"] = power_line(p["ir_ann"], p["n"])

    # Holm over the non-benchmark ledgers; family = ledger set.
    ps = [res["ledgers"][s]["paired"]["p_one_sided"]
          if res["ledgers"][s]["paired"] else 1.0 for s in ev_ids]
    adj = holm_adjusted(ps)
    rej = stats.holm(ps, ALPHA) if ps else []
    res["holm"]["pooled"] = {"alpha": ALPHA, "m": len(ev_ids),
                             "ledgers": ev_ids, "p": ps, "adjusted": adj,
                             "reject": rej}
    for s, a, rj in zip(ev_ids, adj, rej):
        pr = res["ledgers"][s]["paired"]
        if pr is not None:
            pr["holm_p"], pr["holm_reject"] = a, bool(rj)

    for sid in ev_ids:
        e = res["ledgers"][sid]
        if e["checkpoint"] is not None:
            continue
        pr = e["paired"]
        st, ev, why = decide(e["sessions"], pr["ci95_active_ann"],
                             pr.get("holm_p"), pr["dd_ok"])
        e["checkpoint"] = {"state": st, "evidence": ev, "reasons": why}
    return _clean(res)


def _clean(x):
    if isinstance(x, float) and not math.isfinite(x):
        return None
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_clean(v) for v in x]
    return x


def write_eval(d, **kw):
    """evaluate + atomic write of <dir>/sleeves/eval.json; returns the dict."""
    res = evaluate(d, **kw)
    sd = os.path.join(d, "sleeves")
    os.makedirs(sd, exist_ok=True)
    tmp = os.path.join(sd, "eval.json.tmp")
    with open(tmp, "w") as f:
        json.dump(res, f, sort_keys=True, indent=1, allow_nan=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(sd, "eval.json"))
    return res


# ------------------------------------------------------------------ output

def _pct(x, sign=True):
    return "n/a" if x is None else ("%+.2f" if sign else "%.2f") % (x * 100)


def _f(x, fmt="%+.2f"):
    return "n/a" if x is None else fmt % x


def format_table(res):
    out = []
    fid = res["fidelity"]
    if not fid["ok"]:
        out.append("!" * 72)
        out.append("!!! FIDELITY FAILURE: hash chain broken - ledger(s) EXCLUDED "
                   "from every statistic")
        for k, v in fid["chain_failures"].items():
            out.append("!!!   %s: %s" % (k, v))
        out.append("!" * 72)
    else:
        out.append("fidelity: hash chains OK (replay check: "
                   "ops/forward_ledgers.py --verify)")
    out.append("asof %s | %s" % (res["asof"], res["notice"]))
    hdr = "%-30s %5s %8s %8s %7s %6s %7s | %8s %6s %6s %6s  %s"
    out.append(hdr % ("ledger", "n", "cum%", "ann%", "vol%", "shrp", "mdd%",
                      "act%/y", "t", "holmP", "IR", "state"))
    for sid, b in res["benchmarks"].items():
        if b.get("sessions") is None:
            out.append("%-30s CHAIN-BROKEN" % sid)
            continue
        out.append(hdr % (sid, b["sessions"], _pct(b["cum_return"]),
                          _pct(b["ann_return"]), _pct(b["ann_vol"], False),
                          _f(b["sharpe_excess_cash"]),
                          _pct(b["max_drawdown"], False),
                          "", "", "", "", "BENCHMARK"))
    for sid, e in res["ledgers"].items():
        r, p, c = e["returns"] or {}, e["paired"] or {}, e["checkpoint"]
        out.append(hdr % (
            sid[:30], "n/a" if e["sessions"] is None else e["sessions"],
            _pct(r.get("cum_return")), _pct(r.get("ann_return")),
            _pct(r.get("ann_vol"), False), _f(r.get("sharpe_excess_cash")),
            _pct(r.get("max_drawdown"), False), _pct(p.get("active_ann")),
            _f(p.get("t_hac")), _f(p.get("holm_p"), "%.3f"),
            _f(p.get("ir_ann")), c["state"]))
        if p:
            ci, pw = p.get("ci95_active_ann"), e["power"]
            out.append("    vs %s: n=%d TE %s%%/y CI95 act/y %s | power: %s | %s"
                       % (e["benchmark"], p["n"],
                          _pct(p["tracking_error_ann"], False),
                          "n/a" if ci is None else
                          "[%+.2f%%, %+.2f%%]" % (ci[0] * 100, ci[1] * 100),
                          "n/a" if pw["sessions_needed"] == "n/a" else
                          "%d sessions at obs. IR %.2f (%d more)" % (
                              pw["sessions_needed"], pw["ir_ann"],
                              pw["more_needed"]), c["evidence"]))
        else:
            out.append("    " + "; ".join(c["reasons"]))
    return "\n".join(out)


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print("usage: forward_eval.py <dir> [--json]", file=sys.stderr)
        return 2
    res = write_eval(args[0])
    print(json.dumps(res, sort_keys=True) if "--json" in argv
          else format_table(res))
    return 0 if res["fidelity"]["ok"] else 3


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
