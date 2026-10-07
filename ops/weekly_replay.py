"""Weekly determinism replay of the paper loop (plan/execution.md, daily rhythm).

    python3 ops/weekly_replay.py <dir> [--week-ending YYYY-MM-DD] [--json]

Replays the seven UTC days ending on the date (default: yesterday) from the logged
inputs only, journal.jsonl and candidates.jsonl, and compares the result with the
recorded decisions.jsonl. It never re-runs an agent or the strategy engine. A
candidate the gate rejects on its own contents (shape, schema, id) must carry that
rejection; an accepted candidate must have exactly one decision whose cid and symbol
match, and a submitted entry must have its intent row in the journal. Any difference
is a determinism failure: exit 1. Writes <dir>/replays/<week-ending>.json (atomic).
Read-only otherwise."""
import datetime
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ops import monitor
from research.strategy import candidate_wire as W

DAY_NS = 86400 * 10 ** 9
GENESIS = "0" * 64
# A decision with no cid exists only for these rejections (kernel/runner/paper_loop.cpp).
CIDLESS = ("cand-shape", "cand-schema", "cand-cid-mismatch", "line-too-long")
CANDIDATE_KEYS = ("schema", "created_ns", "candidate")
UNDECIDED_GRACE_NS = DAY_NS  # the loop may not have reached a late line yet


def read_journal(d):
    """(rows, torn): rows are dicts of a 7-field line; torn counts other lines."""
    rows, torn = [], 0
    for ln in monitor.read_lines(os.path.join(d, "journal.jsonl")):
        p = ln.split("|")
        if len(p) != 7:
            torn += 1
            continue
        try:
            rows.append({"seq": int(p[0]), "ts_ns": int(p[1]), "kind": p[2],
                         "intent": p[3], "payload": p[4], "prev": p[5],
                         "hash": p[6]})
        except ValueError:
            torn += 1
    return rows, torn


def chain_error(rows, torn=0):
    """First reason the journal fails to verify, or None."""
    if torn:
        return "%d unreadable journal line(s)" % torn
    prev = GENESIS
    for i, r in enumerate(rows):
        if r["seq"] != i or r["prev"] != prev:
            return "chain break at seq %d" % r["seq"]
        body = "%d|%d|%s|%s|%s|%s" % (r["seq"], r["ts_ns"], r["kind"],
                                      r["intent"], r["payload"], r["prev"])
        if hashlib.sha256(body.encode()).hexdigest() != r["hash"]:
            return "row digest mismatch at seq %d" % r["seq"]
        prev = r["hash"]
    return None


def gate_outcome(line):
    """(rejection reason or None, record or None) from the candidate line alone."""
    try:
        rec = json.loads(line)
    except ValueError:
        return "cand-shape", None
    if not isinstance(rec, dict) or sorted(rec) != sorted(CANDIDATE_KEYS):
        return "cand-shape", None
    c = rec["candidate"]
    if not isinstance(c, dict) or len(c) != 12:
        return "cand-shape", None
    if rec["schema"] != W.SCHEMA:
        return "cand-schema", None
    try:
        fields = {k: c[k] for k in W.ID_FIELDS}
    except KeyError:
        return "cand-shape", None
    if any(not isinstance(v, str) or "|" in v for v in fields.values()):
        return "cand-shape", None
    if W.candidate_id(**fields) != c.get("cid"):
        return "cand-cid-mismatch", None
    return None, c


def load_candidates(d):
    """[(rejection or None, candidate dict or None)] in file order."""
    return [gate_outcome(ln) for ln in monitor.read_lines(
        os.path.join(d, "candidates.jsonl")) if ln.strip()]


def week_bounds(week_ending):
    end = datetime.datetime.combine(week_ending + datetime.timedelta(days=1),
                                    datetime.time(), datetime.timezone.utc)
    end_ns = int(end.timestamp()) * 10 ** 9
    return end_ns - 7 * DAY_NS, end_ns


def replay(d, week_ending):
    """List of mismatch strings for the week; empty means the week reproduces."""
    lo, hi = week_bounds(week_ending)
    out = []
    rows, torn = read_journal(d)
    err = chain_error(rows, torn)
    if err:
        out.append("journal: " + err)
    cands = load_candidates(d)
    by_cid = {c["cid"]: c for rej, c in cands if c}
    decisions = monitor.jrows(os.path.join(d, "decisions.jsonl"))
    seen = {}
    for dec in decisions:
        cid = dec.get("cid")
        if cid:
            seen[cid] = seen.get(cid, 0) + 1
    submitted_in_week = 0
    for dec in decisions:
        ts = dec.get("ts_ns")
        if not isinstance(ts, int) or not lo <= ts < hi:
            continue
        cid, reason = dec.get("cid") or "", dec.get("reason")
        label = "decision %s" % (cid[:12] or reason)
        proceed, qty = dec.get("proceed"), dec.get("qty")
        if proceed and not (isinstance(qty, int) and qty > 0
                            and dec.get("submit") == "submitted"):
            out.append("%s: proceed without a submitted quantity" % label)
        if not proceed and (qty != 0 or dec.get("submit") == "submitted"):
            out.append("%s: hold with a quantity or a submission" % label)
        if proceed and dec.get("submit") == "submitted":
            submitted_in_week += 1
        if not cid:
            if reason not in CIDLESS:
                out.append("%s: no cid and reason %r" % (label, reason))
            continue
        c = by_cid.get(cid)
        if c is None:
            out.append("%s: cid not in candidates.jsonl" % label)
            continue
        if seen[cid] > 1:
            out.append("%s: decided %d times" % (label, seen[cid]))
        if dec.get("symbol") != c["symbol"]:
            out.append("%s: symbol %r, candidate %r" % (
                label, dec.get("symbol"), c["symbol"]))
    for rej, c in cands:
        if c is None:
            continue
        ts = int(c["snapshot_ts_ns"])
        if lo <= ts < hi - UNDECIDED_GRACE_NS and c["cid"] not in seen:
            out.append("candidate %s: no recorded decision" % c["cid"][:12])
    cidless = sum(1 for dec in decisions if not dec.get("cid") and
                  isinstance(dec.get("ts_ns"), int) and lo <= dec["ts_ns"] < hi
                  and dec.get("reason") != "line-too-long")
    rejected = sum(1 for rej, c in cands if rej)  # whole file: lines carry no stamp
    if cidless > rejected:
        out.append("%d cid-less decisions for %d rejected candidate lines"
                   % (cidless, rejected))
    week_intents = sum(1 for r in rows if r["kind"] == "intent"
                       and lo <= r["ts_ns"] < hi)
    if submitted_in_week > week_intents:
        out.append("%d submitted decisions but %d intent rows in the journal"
                   % (submitted_in_week, week_intents))
    return out


def main(argv, now=None):
    rest = list(argv[1:])
    as_json = "--json" in rest
    week_ending = None
    if "--week-ending" in rest:
        i = rest.index("--week-ending")
        try:
            week_ending = datetime.date.fromisoformat(rest[i + 1])
        except (IndexError, ValueError):
            raise SystemExit("--week-ending needs YYYY-MM-DD")
        del rest[i:i + 2]
    args = [a for a in rest if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    d = os.path.expanduser(args[0])
    if not os.path.isdir(d):
        raise SystemExit("not a run directory: " + d)
    if week_ending is None:
        now = now or datetime.datetime.now(datetime.timezone.utc)
        week_ending = now.date() - datetime.timedelta(days=1)
    mismatches = replay(d, week_ending)
    report = {"week_ending": week_ending.isoformat(),
              "determinism_failures": mismatches}
    os.makedirs(os.path.join(d, "replays"), exist_ok=True)
    path = os.path.join(d, "replays", week_ending.isoformat() + ".json")
    with open(path + ".tmp", "w") as f:
        json.dump(report, f, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(path + ".tmp", path)
    if as_json:
        print(json.dumps(report, sort_keys=True))
    elif mismatches:
        print("DETERMINISM FAILURE, week ending %s" % report["week_ending"])
        for m in mismatches:
            print("  " + m)
    else:
        print("replay ok, week ending %s" % report["week_ending"])
    return 1 if mismatches else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
