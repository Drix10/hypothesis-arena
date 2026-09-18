#!/usr/bin/env python3
"""P1.4 soak runner: observation/validation ONLY. Changes no rules.

One cycle: collect -> classify today's signals -> snapshot heartbeats ->
daily audit. Loop mode aligns to 15-min boundaries for the 7-day window.
rules_v1 is FROZEN during the soak; this script cannot change it.

Usage:
  python3 collector/soak.py --once    # single cycle (validation)
  python3 collector/soak.py --loop    # 7-day loop (run under nohup/systemd)
"""
import glob
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOAK = os.path.join(ROOT, "data", "soak")
POLLS = os.path.join(SOAK, "polls.jsonl")
CYCLE_S = 15 * 60


def ts_now():
    return datetime.now(timezone.utc).isoformat()


def snapshot_heartbeats(at):
    row = {"at": at, "sources": {}}
    for f in glob.glob(os.path.join(ROOT, "data", "state", "*.heartbeat.json")):
        try:
            h = json.load(open(f))
            row["sources"][h.get("source", os.path.basename(f))] = {
                "status": h.get("status"), "detail": h.get("detail", "")[:200],
                "items": h.get("items", 0)}
        except (OSError, ValueError):
            row["sources"][os.path.basename(f)] = {"status": "UNREADABLE"}
    os.makedirs(SOAK, exist_ok=True)
    with open(POLLS, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")
    return row


def cycle():
    at = ts_now()
    day = at[:10]
    r1 = subprocess.run([sys.executable, os.path.join(HERE, "collect.py")],
                        capture_output=True, text=True, timeout=600)
    print(r1.stdout[-500:] if r1.stdout else "", end="")
    if r1.returncode != 0:
        print(f"COLLECT EXIT {r1.returncode}: {r1.stderr[-500:]}")
    sig = os.path.join(ROOT, "data", "signals", f"{day}.jsonl")
    if os.path.exists(sig):
        r2 = subprocess.run(
            [sys.executable, os.path.join(HERE, "classify.py"), sig],
            capture_output=True, text=True, timeout=300)
        print(r2.stdout.strip().splitlines()[-1] if r2.stdout.strip() else "")
    hb = snapshot_heartbeats(at)
    bad = {k: v["status"] for k, v in hb["sources"].items()
           if v.get("status") not in ("ok", "EMPTY_SUCCESS", "SKIPPED_CONFIG")}
    if bad:
        print(f"ATTENTION heartbeat: {bad}")
    # daily audit artifact (overwritten once per day, kept per day)
    audit_path = os.path.join(SOAK, f"audit-{day}.json")
    if not os.path.exists(audit_path) and os.path.exists(sig):
        r3 = subprocess.run(
            [sys.executable, os.path.join(HERE, "audit.py"), sig],
            capture_output=True, text=True, timeout=300)
        try:
            json.dump(json.loads(r3.stdout), open(audit_path, "w"), indent=1)
            print(f"audit -> {audit_path}")
        except ValueError:
            print(f"audit failed: {r3.stderr[-300:]}")
    # daily objective evidence: pre-grade triage + acceptance checks (read-only)
    clf = os.path.join(ROOT, "data", "classified", f"{day}.jsonl")
    if os.path.exists(clf):
        for tool, args in (("pregrade.py", [clf]), ("soak_check.py", [day])):
            r4 = subprocess.run(
                [sys.executable, os.path.join(HERE, tool)] + args,
                capture_output=True, text=True, timeout=600)
            tail = (r4.stdout.strip().splitlines() or [""])[-3:]
            print(f"[{tool} exit={r4.returncode}]")
            print("\n".join(tail))
    return hb


def main():
    if "--once" in sys.argv:
        cycle()
    elif "--loop" in sys.argv:
        end = time.time() + 7 * 24 * 3600
        while time.time() < end:
            cycle()
            nxt = (int(time.time() / CYCLE_S) + 1) * CYCLE_S
            time.sleep(max(60, nxt - time.time()))
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
