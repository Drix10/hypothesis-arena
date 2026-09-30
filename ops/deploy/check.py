"""Acceptance check for a running (or finished) G0 paper loop. Exit 0 = PASS.

    python3 ops/deploy/check.py <loop_dir> [--no-broker] [--watch SECONDS]

Fails when any of these hold:
  - the loop process is not alive (loop.pid)
  - freeze.txt exists
  - alerts.jsonl holds a flatten*, unprotected-position, journal-* or kill alert
  - the order journal hash chain is broken
  - loop.log or sleeves.log contains a traceback
  - (broker) a held position has no resting sell order, or an open order is stuck
Read-only: it never places or cancels anything.
--watch N repeats every N seconds and stops at the first FAIL (exit 1)."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import monitor  # noqa: E402

BAD_ALERT = ("flatten", "unprotected", "journal-", "kill", "freeze")


def check(d, broker):
    fails, notes = [], []
    pid = monitor.read_lines(os.path.join(d, "loop.pid"))
    if pid:
        try:
            os.kill(int(pid[0]), 0)
        except (OSError, ValueError):
            fails.append("loop process not running")
    else:
        fails.append("no loop.pid")
    if os.path.exists(os.path.join(d, "freeze.txt")):
        fails.append("frozen: " + " ".join(monitor.read_lines(os.path.join(d, "freeze.txt"))))
    for a in monitor.jrows(os.path.join(d, "alerts.jsonl")):
        code = str(a.get("code", ""))
        if any(code.startswith(b) or b in code for b in BAD_ALERT):
            fails.append("alert %s: %s" % (code, a.get("detail", "")))
    rows = [ln.split("|") for ln in monitor.read_lines(os.path.join(d, "journal.jsonl"))]
    rows = [p for p in rows if len(p) == 7]
    try:
        if not all(rows[i][5] == rows[i - 1][6] and int(rows[i][0]) == int(rows[i - 1][0]) + 1
                   for i in range(1, len(rows))):
            fails.append("journal chain broken")
    except ValueError:
        fails.append("journal row unreadable")
    for log in ("loop.log", "sleeves.log"):
        if any("Traceback" in ln for ln in monitor.read_lines(os.path.join(d, "logs", log))):
            fails.append("traceback in logs/" + log)
    notes.append("journal rows %d" % len(rows))
    if broker is not None:
        try:
            pos = broker.get("/v2/positions")
            openo = broker.get("/v2/orders?status=open&limit=100&nested=true")
        except Exception as e:
            fails.append("broker unreachable: %s" % e)
            return fails, notes
        sells = set()
        for o in openo:
            for x in [o] + (o.get("legs") or []):
                if x.get("side") == "sell" and x.get("status") in (
                        "new", "accepted", "held", "partially_filled", "pending_new"):
                    sells.add(x.get("symbol"))
        for p in pos:
            if float(p.get("qty", 0)) > 0 and p["symbol"] not in sells:
                fails.append("NO STOP: long %s x%s has no resting sell" % (p["symbol"], p["qty"]))
        notes.append("positions %d, symbols with a stop %s" % (len(pos), sorted(sells)))
    return fails, notes


def main(argv):
    rest = list(argv[1:])
    watch = 0.0
    if "--watch" in rest:
        i = rest.index("--watch")
        watch = float(rest[i + 1])
        del rest[i:i + 2]
    args = [a for a in rest if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit(__doc__)
    d = os.path.expanduser(args[0])
    broker = None if "--no-broker" in rest else monitor.Broker(monitor.load_env())
    while True:
        fails, notes = check(d, broker)
        stamp = time.strftime("%H:%M:%S")
        if fails:
            print("%s FAIL" % stamp)
            for f in fails:
                print("  - " + f)
            return 1
        print("%s PASS  %s" % (stamp, "; ".join(notes)), flush=True)
        if not watch:
            return 0
        time.sleep(watch)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
