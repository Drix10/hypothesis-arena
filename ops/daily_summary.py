"""One-page daily summary of the paper loop (plan/execution.md, daily rhythm).

    python3 ops/daily_summary.py <dir> [--date YYYY-MM-DD]

Reads the journal, candidates.jsonl, decisions.jsonl, alerts.jsonl, the forward
ledgers and the model-spend ledger in <dir>; prints the page and writes it to
<dir>/summaries/<date>.txt (atomic). The date is a UTC day, default yesterday.
Every money figure is net: costs are subtracted, and a figure that cannot be
computed is shown as UNAVAILABLE, never as zero (plan/risk.md). The journal holds
no prices, so fills are counted and costs are the cost model applied to the
decided quantity at the candidate reference price. Exit 1 when the journal chain
fails or any figure is unavailable. Read-only apart from the summary file."""
import datetime
import json
import os
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ops import forward_ledgers as S
from ops import monitor
from ops import weekly_replay as R
from research.engine import attribution, spend
from research.strategy import costs

UNAVAILABLE = "UNAVAILABLE"
SPEND_FILE = "spend.jsonl"  # attribution ledger path stem; its db sits beside it
SPEND_WINDOW_S = 30 * 86400


def day_bounds(day):
    lo = int(datetime.datetime.combine(day, datetime.time(),
                                       datetime.timezone.utc).timestamp()) * 10 ** 9
    return lo, lo + R.DAY_NS


def in_day(row, key, lo, hi):
    v = row.get(key)
    return isinstance(v, int) and lo <= v < hi


def trade_costs(decisions, by_cid):
    """(modelled cost USD, signed submitted notional) over submitted decisions, or
    None when a submitted decision has no candidate to price it from."""
    cost, net = 0.0, 0.0
    for dec in decisions:
        c = by_cid.get(dec.get("cid"))
        if c is None:
            return None
        qty, px = dec["qty"], float(c["entry_px"])
        cost += qty * px * costs.MIN_COST_BPS / 1e4 + costs.regulatory_fees(
            c["side"], qty, px)
        net += qty * px * (1 if c["side"] == "BUY" else -1)
    return cost, net


def shadow_lines(d, lo, hi):
    """Per shadow ledger: net return over the day and the symbols it targets."""
    sd = os.path.join(d, "ledgers")
    out, targets = [], {}
    names = sorted(n for n in os.listdir(sd) if n.endswith(".jsonl")) \
        if os.path.isdir(sd) else []
    for n in names:
        sid = n[:-6]
        try:
            rows, _ = S.read_log(os.path.join(sd, n))
        except (ValueError, KeyError, OSError):
            out.append("  %-20s %s (ledger chain)" % (sid, UNAVAILABLE))
            continue
        day = datetime.datetime.fromtimestamp(lo // 10 ** 9, datetime.timezone.utc
                                              ).date().isoformat()
        row = next((r for r in rows if r["date"] == day), None)
        if row is None:
            out.append("  %-20s no session %s" % (sid, day))
            continue
        out.append("  %-20s net return %+.4f%%  equity %.2f" % (
            sid, row["ret"] * 100, row["equity"]))
        if not sid.startswith("bench_") and row.get("target"):
            targets[sid] = {s for s, w in row["target"].items() if w > 0}
    return out, targets


def model_spend(d, now):
    """(30-day spend, cap) or None when the ledger is absent or unreadable."""
    log = os.path.join(d, SPEND_FILE)
    if not os.path.exists(attribution._db_for(log)):
        return None
    try:
        return (attribution.spend_since(log, now - SPEND_WINDOW_S),
                spend.STAGE_CAPS_USD["paper"])
    except (sqlite3.Error, OSError, ValueError, attribution.LedgerUnavailable):
        return None


def summarize(d, day, now):
    """(page lines, ok)."""
    lo, hi = day_bounds(day)
    ok = True
    out = ["MiroHedge paper daily summary, %s UTC (net figures)" % day, ""]
    rows, torn = R.read_journal(d)
    err = R.chain_error(rows, torn)
    if err:
        ok = False
    out.append("journal: %s" % (("CHAIN FAILED, " + err) if err else
                                 "chain intact, %d rows" % len(rows)))
    kinds = {}
    for r in rows:
        if lo <= r["ts_ns"] < hi:
            kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    out.append("fills: %d fill, %d partial, %d cancel, %d unknown" % (
        kinds.get("fill", 0), kinds.get("partial", 0), kinds.get("cancel", 0),
        kinds.get("unknown", 0)))

    decisions = [x for x in monitor.jrows(os.path.join(d, "decisions.jsonl"))
                 if in_day(x, "ts_ns", lo, hi)]
    holds = {}
    for x in decisions:
        if not x.get("proceed"):
            holds[x.get("reason")] = holds.get(x.get("reason"), 0) + 1
    submitted = [x for x in decisions
                 if x.get("proceed") and x.get("submit") == "submitted"]
    out.append("decisions: %d, submitted %d, held %d%s" % (
        len(decisions), len(submitted), sum(holds.values()),
        "".join(" [%s %d]" % kv for kv in sorted(holds.items()))))

    by_cid = {c["cid"]: c for rej, c in R.load_candidates(d) if c}
    priced = trade_costs(submitted, by_cid)
    if priced is None:
        ok = False
        out.append("costs: %s (a submitted decision has no candidate)" % UNAVAILABLE)
    else:
        out.append("costs: $%.2f modelled (spread floor %.1f bp + SEC and TAF fees)"
                   % (priced[0], costs.MIN_COST_BPS))

    exposure = trade_costs([x for x in monitor.jrows(os.path.join(d, "decisions.jsonl"))
                            if x.get("proceed") and x.get("submit") == "submitted"
                            and x.get("ts_ns", 0) < hi], by_cid)
    out.append("exposure: %s" % (UNAVAILABLE if exposure is None else
                                 "$%.2f net submitted notional to date (loop "
                                 "decisions, not broker state)" % exposure[1]))
    if exposure is None:
        ok = False

    ms = model_spend(d, now)
    if ms is None:
        ok = False
        out.append("model spend: %s (no %s ledger in the run directory)" % (
            UNAVAILABLE, SPEND_FILE))
    else:
        out.append("model spend: $%.2f of $%.2f paper cap (30 days)%s" % (
            ms[0], ms[1], "  OVER CAP" if ms[0] > ms[1] else ""))

    out.append("shadow ledgers:")
    lines, targets = shadow_lines(d, lo, hi)
    out.extend(lines or ["  none"])
    held = set()
    for x in decisions:
        c = by_cid.get(x.get("cid"))
        if c and x.get("proceed") and x.get("submit") == "submitted" and c["side"] == "BUY":
            held.add(c["symbol"])
    for sid, want in sorted(targets.items()):
        out.append("divergence from %s: shadow-only %s, paper-only %s" % (
            sid, sorted(want - held) or "none", sorted(held - want) or "none"))

    alerts = [a for a in monitor.jrows(os.path.join(d, "alerts.jsonl"))
              if in_day(a, "ts_ns", lo, hi)]
    out.append("alerts: %d" % len(alerts))
    for a in alerts:
        out.append("  %s %s %s" % (a.get("level"), a.get("code"),
                                   str(a.get("detail", ""))[:80]))
    return out, ok


def main(argv, now=None):
    rest = list(argv[1:])
    day = None
    if "--date" in rest:
        i = rest.index("--date")
        try:
            day = datetime.date.fromisoformat(rest[i + 1])
        except (IndexError, ValueError):
            raise SystemExit("--date needs YYYY-MM-DD")
        del rest[i:i + 2]
    args = [a for a in rest if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    d = os.path.expanduser(args[0])
    if not os.path.isdir(d):
        raise SystemExit("not a run directory: " + d)
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if day is None:
        day = now.date() - datetime.timedelta(days=1)
    lines, ok = summarize(d, day, now.timestamp())
    page = "\n".join(lines) + "\n"
    os.makedirs(os.path.join(d, "summaries"), exist_ok=True)
    path = os.path.join(d, "summaries", day.isoformat() + ".txt")
    with open(path + ".tmp", "w") as f:
        f.write(page)
    os.replace(path + ".tmp", path)
    sys.stdout.write(page)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
