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
WINDOW_PATH = os.path.join(SOAK, "window.json")

# Missed-cycle semantics (explicit): a cycle interrupted during the 15-min
# wait is a MISSED cycle. It is recorded (polls.jsonl row, no collection),
# never backfilled: catch-up polls would double-collect and corrupt the
# record-balance evidence. Gaps are data, not errors to hide.


def load_window(hours):
    """Persisted observation window. First launch writes it atomically;
    restarts read it and can never extend the formal deadline."""
    os.makedirs(SOAK, exist_ok=True)
    if os.path.exists(WINDOW_PATH):
        with open(WINDOW_PATH, encoding="utf-8") as fh:
            w = json.load(fh)
        if not valid_window(w):
            raise SystemExit(f"refusing to run: corrupt {WINDOW_PATH}")
        print(f"resuming window {w['start']} -> {w['end']} (restart-safe)")
        return w
    now = time.time()
    w = {"start": datetime.fromtimestamp(now, timezone.utc).isoformat(),
         "end": datetime.fromtimestamp(now + hours * 3600,
                                         timezone.utc).isoformat(),
         "hours": hours}
    tmp = WINDOW_PATH + ".tmp"
    atomic_write_json(WINDOW_PATH, w)
    print(f"new window {w['start']} -> {w['end']}")
    return w


def append_poll_row(row):
    """Append-only polls log with flush+fsync: a crash loses at most the
    in-flight row, never truncates committed history."""
    os.makedirs(SOAK, exist_ok=True)
    with open(POLLS, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def atomic_write_json(dest, obj):
    tmp = dest + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, dest)


def valid_window(w):
    """Window config bounds: ISO instants, start < end, 1h..720h."""
    try:
        s = datetime.fromisoformat(w["start"])
        e = datetime.fromisoformat(w["end"])
        if s.tzinfo is None or e.tzinfo is None:
            return False
        hours = (e - s).total_seconds() / 3600
        return 1 <= hours <= 720
    except (KeyError, ValueError, TypeError):
        return False


def record_missed(at):
    append_poll_row({"at": at, "status": "MISSED",
                     "note": "cycle interrupted during wait; not backfilled"})


def ts_now():
    return datetime.now(timezone.utc).isoformat()


def snapshot_heartbeats(at, exits=None):
    """Snapshot per-source heartbeats. Each entry preserves the heartbeat
    file's OWN `at` as `heartbeat_at`: checkers validate the heartbeat's
    freshness, never the snapshot row's timestamp (a stale file copied
    into today's row must not read as today's coverage). `exits` records
    this cycle's subprocess return codes (None = step not run)."""
    row = {"at": at, "sources": {}}
    if exits:
        row["exits"] = exits
    for f in glob.glob(os.path.join(ROOT, "data", "state", "*.heartbeat.json")):
        try:
            with open(f, encoding="utf-8") as fh:
                h = json.load(fh)
            row["sources"][h.get("source", os.path.basename(f))] = {
                "status": h.get("status"), "detail": h.get("detail", "")[:200],
                "items": h.get("items", 0),
                "heartbeat_at": h.get("at")}
        except (OSError, ValueError):
            row["sources"][os.path.basename(f)] = {"status": "UNREADABLE",
                                                      "heartbeat_at": None}
    os.makedirs(SOAK, exist_ok=True)
    append_poll_row(row)
    return row


def cycle():
    at = ts_now()
    day = at[:10]
    exits = {}
    r1 = subprocess.run([sys.executable, os.path.join(HERE, "collect.py")],
                        capture_output=True, text=True, timeout=600)
    exits["collect"] = r1.returncode
    print(r1.stdout[-500:] if r1.stdout else "", end="")
    if r1.returncode != 0:
        print(f"COLLECT EXIT {r1.returncode}: {r1.stderr[-500:]}")
    sig = os.path.join(ROOT, "data", "signals", f"{day}.jsonl")
    if os.path.exists(sig):
        r2 = subprocess.run(
            [sys.executable, os.path.join(HERE, "classify.py"), sig],
            capture_output=True, text=True, timeout=300)
        exits["classify"] = r2.returncode
        if r2.returncode != 0:
            print(f"CLASSIFY EXIT {r2.returncode}: {r2.stderr[-500:]}")
        print(r2.stdout.strip().splitlines()[-1] if r2.stdout.strip() else "")
    # daily audit artifact (overwritten once per day, kept per day)
    audit_path = os.path.join(SOAK, f"audit-{day}.json")
    if not os.path.exists(audit_path) and os.path.exists(sig):
        r3 = subprocess.run(
            [sys.executable, os.path.join(HERE, "audit.py"), sig],
            capture_output=True, text=True, timeout=300)
        exits["audit"] = r3.returncode
        try:
            atomic_write_json(audit_path, json.loads(r3.stdout))
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
            exits[tool.replace(".py", "")] = r4.returncode
            tail = (r4.stdout.strip().splitlines() or [""])[-3:]
            print(f"[{tool} exit={r4.returncode}]")
            print("\n".join(tail))
    # Snapshot LAST so the persisted row carries every subprocess exit code
    # of this cycle (a collector/classify failure must be visible to the
    # acceptance checker, not printed and forgotten).
    hb = snapshot_heartbeats(at, exits)
    bad = {k: v["status"] for k, v in hb["sources"].items()
           if v.get("status") not in ("ok", "EMPTY_SUCCESS", "SKIPPED_CONFIG")}
    if bad:
        print(f"ATTENTION heartbeat: {bad}")
    return hb


def main():
    if "--once" in sys.argv:
        cycle()
    elif "--loop" in sys.argv:
        sys.path.insert(0, HERE)
        from config import load as load_config
        cfg = load_config()
        if cfg["status"] == "MISSING_REQUIRED_CONFIG":
            print(f"MISSING_REQUIRED_CONFIG: {','.join(cfg['missing_required'])} "
                  f"-- refusing loop", file=sys.stderr)
            return 2
        hours = 168.0
        for i, a in enumerate(sys.argv):
            if a == "--window-hours" and i + 1 < len(sys.argv):
                hours = float(sys.argv[i + 1])
        w = load_window(hours)
        end = datetime.fromisoformat(w["end"]).timestamp()
        while time.time() < end:
            cycle()
            nxt = (int(time.time() / CYCLE_S) + 1) * CYCLE_S
            wait = nxt - time.time()
            if wait > CYCLE_S * 1.5:
                # woke up over a cycle late (sleep interrupted / host stalled)
                record_missed(ts_now())
            time.sleep(max(60, wait))
        print(f"window closed {w['end']}")
    else:
        print(__doc__)


if __name__ == "__main__":
    sys.exit(main())
