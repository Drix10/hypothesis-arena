"""Kill-only decay monitors for the forward ledgers (plan/math.md, Decay monitoring).

    python3 ops/decay_monitor.py <dir> [--json]

Per non-benchmark ledger in <dir>/ledgers: the rolling 24-month spanning alpha
against its benchmark ledger (ops/forward_eval.MAPPING, excess of bench_cash_bil)
and a one-sided CUSUM on monthly net returns against the haircut expectation in
<dir>/ledgers/decay_expected.json ({ledger id: expected monthly net return}).
The only signals are "pause" and "demote"; nothing here promotes or sizes.
Missing or short history, a missing expectation, a broken chain or a missing
benchmark is state "insufficient" with signal "none". Writes
<dir>/ledgers/decay.json (atomic), each entry carrying the "line" ops/monitor.py shows; never touches a
ledger."""
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ops import forward_eval as E
from ops import forward_ledgers as S
from research.strategy import stats

WINDOW_MONTHS = 24   # plan/math.md: rolling 24-month spanning alpha
MIN_MONTHS = 24      # no judgement on a shorter window
CI_LEVEL = 0.95      # plan/math.md evaluation statistics: stationary-bootstrap CI
BOOT_B = 2000
SEED = 20260930
# One-sided CUSUM on (expected - realised), in units of the window's monthly
# volatility; standard allowance and decision interval, never tuned.
CUSUM_K_SIGMA = 0.5
CUSUM_H_SIGMA = 4.0
EXPECTED_FILE = "decay_expected.json"
OUT_FILE = "decay.json"


def monthly_returns(rows):
    """[(YYYY-MM, compounded return)] of complete months. The rebase row is not
    an observation and the month holding the last row may be partial, so it is
    dropped."""
    months = {}
    for r in rows[1:]:
        m = r["date"][:7]
        months[m] = months.get(m, 1.0) * (1.0 + float(r["ret"]))
    last = rows[-1]["date"][:7]
    return [(m, v - 1.0) for m, v in sorted(months.items()) if m != last]


def cusum(returns, expected):
    """(peak statistic, decision interval, tripped) for downward drift."""
    sigma = stats.stdev(returns)
    if sigma <= 0.0:
        raise stats.StatsError("zero-variance")
    s = peak = 0.0
    for x in returns:
        s = max(0.0, s + (expected - x) - CUSUM_K_SIGMA * sigma)
        peak = max(peak, s)
    h = CUSUM_H_SIGMA * sigma
    return peak, h, peak > h


def _insufficient(why):
    return {"state": "insufficient", "signal": "none", "reason": why}


def judge(sid, rows, bench_rows, cash_rows, expected, boot_b=BOOT_B):
    if not rows or len(rows) < 2:
        return _insufficient("no-history")
    if bench_rows is None or cash_rows is None:
        return _insufficient("no-benchmark")
    if expected is None:
        return _insufficient("no-expectation")
    strat = dict(monthly_returns(rows))
    bench = dict(monthly_returns(bench_rows)) if len(bench_rows) > 1 else {}
    cash = dict(monthly_returns(cash_rows)) if len(cash_rows) > 1 else {}
    common = sorted(set(strat) & set(bench) & set(cash))
    if len(common) < MIN_MONTHS:
        return _insufficient("short-history:%d" % len(common))
    common = common[-WINDOW_MONTHS:]
    rs = [strat[m] - cash[m] for m in common]
    rb = [bench[m] - cash[m] for m in common]
    try:
        span = stats.spanning_alpha(rs, rb, level=CI_LEVEL, b=boot_b, seed=SEED)
        peak, h, tripped = cusum([strat[m] for m in common], expected)
    except stats.StatsError as e:
        return _insufficient(str(e))
    if span["ci"] is None:
        return _insufficient("spanning-ci")
    if span["ci"][1] < 0.0:
        signal = "demote"
    elif tripped:
        signal = "pause"
    else:
        signal = "none"
    return {"state": "monitored", "signal": signal, "reason": None,
            "through": common[-1], "months": len(common),
            "alpha_monthly": span["alpha"], "t_alpha": span["t_alpha"],
            "alpha_ci": list(span["ci"]), "cusum": peak, "cusum_limit": h,
            "cusum_tripped": tripped}


def evaluate(d, boot_b=BOOT_B):
    sd = os.path.join(d, "ledgers")
    names = sorted(n[:-6] for n in os.listdir(sd)
                   if n.endswith(".jsonl")) if os.path.isdir(sd) else []
    logs = {n: E._read_ledger(os.path.join(sd, n + ".jsonl")) for n in names}
    try:
        with open(os.path.join(sd, EXPECTED_FILE)) as f:
            expected = json.load(f)
    except (OSError, ValueError):
        expected = {}
    cash = logs.get(S.BENCH_CASH, (None, None))[0]
    out = {}
    for sid in names:
        if sid in S.BENCHMARKS:
            continue
        rows, err = logs[sid]
        if rows is None:
            out[sid] = _insufficient("ledger:" + err)
            continue
        bid, _ = E.benchmark_for(sid)
        exp = expected.get(sid)
        if isinstance(exp, bool) or not isinstance(exp, (int, float)) \
                or not math.isfinite(exp):
            exp = None
        out[sid] = judge(sid, rows, logs.get(bid, (None, None))[0], cash, exp,
                         boot_b)
        out[sid]["benchmark"] = bid
    for entry in out.values():
        entry["line"] = line(entry)
    return out


def write_decay(d, **kw):
    res = evaluate(d, **kw)
    sd = os.path.join(d, "ledgers")
    os.makedirs(sd, exist_ok=True)
    tmp = os.path.join(sd, OUT_FILE + ".tmp")
    with open(tmp, "w") as f:
        json.dump(res, f, sort_keys=True, indent=1, allow_nan=False)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(sd, OUT_FILE))
    return res


def line(entry):
    """One monitor line for a decay entry."""
    if entry["state"] != "monitored":
        return "DECAY insufficient (%s)" % entry["reason"]
    t = entry["t_alpha"]
    return "DECAY %s  alpha_t=%s  cusum %.4f/%.4f  %d months" % (
        entry["signal"].upper(), "n/a" if t is None else "%+.2f" % t,
        entry["cusum"], entry["cusum_limit"], entry["months"])


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print("usage: decay_monitor.py <dir> [--json]", file=sys.stderr)
        return 2
    res = write_decay(args[0])
    if "--json" in argv:
        print(json.dumps(res, sort_keys=True))
    else:
        for sid in sorted(res):
            print("%-24s %s" % (sid, line(res[sid])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
