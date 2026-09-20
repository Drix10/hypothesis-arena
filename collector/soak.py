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
from types import SimpleNamespace

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOAK = os.path.join(ROOT, "data", "soak")
POLLS = os.path.join(SOAK, "polls.jsonl")
CYCLE_S = 15 * 60
WINDOW_PATH = os.path.join(SOAK, "window.json")
SOAK_LOCK_PATH = os.path.join(SOAK, "soak.lock")

if os.name == "nt":
    import msvcrt
else:
    import fcntl


class _SingletonLock:
    """Non-blocking OS-native file lock, held for the whole soak run.
    Twin of collect.py's guard (kept local: importing collect would drag
    its config load into the orchestrator). Two --loop (or --once)
    coordinators would otherwise interleave classify/audit/poll evidence
    even though the collector itself refuses concurrency."""
    def __init__(self, path):
        self.path = path
        self.fh = None

    def acquire(self):
        parent = os.path.dirname(self.path)
        if parent:
            try:
                os.makedirs(parent, exist_ok=True)
            except OSError:
                return False
        try:
            self.fh = open(self.path, "a+b")
            self.fh.seek(0)
            if os.name == "nt":
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except (OSError, IOError):
            try:
                if self.fh is not None:
                    self.fh.close()
            except (OSError, ValueError):
                pass
            self.fh = None
            return False

    def release(self):
        if self.fh is None:
            return
        try:
            if os.name == "nt":
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
        except (OSError, ValueError):
            pass
        try:
            self.fh.close()
        except (OSError, ValueError):
            pass
        self.fh = None

# Missed-cycle semantics (explicit and honest): a hard kill during the
# 15-min sleep writes NOTHING — a dead process cannot append rows. The
# absence is detectable, but it is absence, not a recorded MISSED row.
# On (re)start, the supervisor derives the dead interval from the
# persisted window + last poll row and appends ONE explicit MISSED_RANGE
# row {from, through, count}. Late wakeups (sleep returned over a cycle
# late but the process lived) derive the same way. Gaps are data, never
# backfilled: catch-up polls would double-collect and corrupt the
# record-balance evidence.


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


def _parse_at(s):
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    return dt if dt.tzinfo is not None else None


def last_poll_at():
    """Newest parseable `at` in polls.jsonl, or None (first launch).
    Malformed lines are skipped here (the checker, not the runner,
    judges log integrity)."""
    latest = None
    try:
        with open(POLLS, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(row, dict):
                    continue
                inst = _parse_at(row.get("at"))
                if inst is not None and (latest is None or inst > latest):
                    latest = inst
    except OSError:
        return None
    return latest


def record_missed_range(now_iso):
    """Derive the dead interval since the last poll row and record ONE
    explicit MISSED_RANGE row. Returns the missed count (0 = continuous).
    Called at loop start (covers hard kills) and on late wakeups."""
    last = last_poll_at()
    if last is None:
        return 0  # first launch: nothing missed
    now = _parse_at(now_iso) or datetime.now(timezone.utc)
    gap = (now - last).total_seconds()
    if gap <= CYCLE_S * 1.5:
        return 0
    count = int(gap // CYCLE_S)
    append_poll_row({"at": now_iso, "status": "MISSED_RANGE",
                     "from": last.isoformat(), "through": now_iso,
                     "count": count,
                     "note": "restart-derived dead interval; the dead "
                             "process wrote nothing, this row is the "
                             "restart speaking for it; never backfilled"})
    return count


def ts_now():
    return datetime.now(timezone.utc).isoformat()


def snapshot_heartbeats(at, exits=None, started_at=None):
    """Snapshot per-source heartbeats. Each entry preserves the heartbeat
    file's OWN `at` as `heartbeat_at`: checkers validate the heartbeat's
    freshness, never the snapshot row's timestamp (a stale file copied
    into today's row must not read as today's coverage). `exits` records
    this cycle's subprocess return codes (None = step not run).
    `at` is the SNAPSHOT-CREATION instant (freshness anchor), never the
    cycle-start time: heartbeats born during the cycle must not read as
    future-dated. `started_at` is carried for lag forensics only."""
    row = {"at": at, "sources": {}}
    if started_at is not None:
        row["started_at"] = started_at
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


def run_step(args, timeout):
    """Subprocess with failure-as-evidence. A hung/crashing child must
    NEVER kill the soak runner before the snapshot: TimeoutExpired and
    spawn errors become synthetic nonzero codes (124 timeout, 127 spawn)
    recorded in the poll row like any other exit."""
    try:
        return subprocess.run(args, capture_output=True, text=True,
                              timeout=timeout)
    except subprocess.TimeoutExpired as e:
        out = e.stdout or ""
        if isinstance(out, bytes):
            out = out.decode(errors="replace")
        return SimpleNamespace(returncode=124, stdout=out,
                               stderr=f"TimeoutExpired after {timeout}s")
    except OSError as e:
        return SimpleNamespace(returncode=127, stdout="",
                               stderr=f"spawn-failed: {e}")


def valid_audit_doc(obj):
    """Gate for publishing the daily audit artifact: must be the audit
    schema (dict, per_source dict, as_of str). A failed audit that happens
    to emit parseable JSON must never become the artifact."""
    return (isinstance(obj, dict)
            and isinstance(obj.get("per_source"), dict)
            and isinstance(obj.get("as_of"), str))


def cycle():
    # Timestamp discipline (explicit): `started_at` marks cycle start for
    # lag forensics. The EVIDENCE DAY and the snapshot freshness anchor
    # (`at`) are captured AFTER collection, at snapshot creation: a cycle
    # starting 23:59:59 whose collector finishes 00:00:10 classifies the
    # NEW day's file (whatever the collector just wrote is picked up next
    # cycle — PK-dedupe makes the boundary lossless, never duplicated).
    # Classifying the previous day's file after a midnight rollover would
    # silently drop the just-written records from this snapshot's view.
    started_at = ts_now()
    exits = {}
    r1 = run_step([sys.executable, os.path.join(HERE, "collect.py")], 600)
    exits["collect"] = r1.returncode
    print(r1.stdout[-500:] if r1.stdout else "", end="")
    if r1.returncode != 0:
        print(f"COLLECT EXIT {r1.returncode}: {r1.stderr[-500:]}")
    at = ts_now()
    day = at[:10]
    sig = os.path.join(ROOT, "data", "signals", f"{day}.jsonl")
    if os.path.exists(sig):
        r2 = run_step(
            [sys.executable, os.path.join(HERE, "classify.py"), sig], 300)
        exits["classify"] = r2.returncode
        if r2.returncode != 0:
            print(f"CLASSIFY EXIT {r2.returncode}: {r2.stderr[-500:]}")
        print(r2.stdout.strip().splitlines()[-1] if r2.stdout.strip() else "")
    # daily audit artifact (overwritten once per day, kept per day)
    audit_path = os.path.join(SOAK, f"audit-{day}.json")
    if not os.path.exists(audit_path) and os.path.exists(sig):
        r3 = run_step(
            [sys.executable, os.path.join(HERE, "audit.py"), sig], 300)
        exits["audit"] = r3.returncode
        if r3.returncode == 0:
            try:
                doc = json.loads(r3.stdout)
                if not valid_audit_doc(doc):
                    raise ValueError("audit-schema")
            except ValueError as e:
                print(f"audit output rejected: {e}")
                exits["audit"] = 126  # ran, but output unusable: evidence
            else:
                atomic_write_json(audit_path, doc)
                print(f"audit -> {audit_path}")
        else:
            print(f"AUDIT EXIT {r3.returncode}: {r3.stderr[-300:]}")
    # daily objective evidence: pre-grade triage + acceptance checks (read-only)
    clf = os.path.join(ROOT, "data", "classified", f"{day}.jsonl")
    if os.path.exists(clf):
        for tool, args in (("pregrade.py", [clf]), ("soak_check.py", [day])):
            r4 = run_step(
                [sys.executable, os.path.join(HERE, tool)] + args, 600)
            exits[tool.replace(".py", "")] = r4.returncode
            tail = (r4.stdout.strip().splitlines() or [""])[-3:]
            print(f"[{tool} exit={r4.returncode}]")
            print("\n".join(tail))
    # Snapshot LAST so the persisted row carries every subprocess exit code
    # of this cycle (a collector/classify failure must be visible to the
    # acceptance checker, not printed and forgotten). Timestamped at
    # creation (`at`), not at cycle start.
    hb = snapshot_heartbeats(at, exits, started_at)
    bad = {k: v["status"] for k, v in hb["sources"].items()
           if v.get("status") not in ("ok", "EMPTY_SUCCESS", "SKIPPED_CONFIG")}
    if bad:
        print(f"ATTENTION heartbeat: {bad}")
    return hb


def main():
    if "--once" in sys.argv:
        lock = _SingletonLock(SOAK_LOCK_PATH)
        if not lock.acquire():
            print("SOAK_ALREADY_RUNNING: another soak.py holds soak.lock "
                  "-- refusing concurrent orchestration",
                  file=sys.stderr)
            return 3
        try:
            cycle()
        finally:
            lock.release()
    elif "--loop" in sys.argv:
        sys.path.insert(0, HERE)
        from config import load as load_config
        cfg = load_config()
        if cfg["status"] == "MISSING_REQUIRED_CONFIG":
            print(f"MISSING_REQUIRED_CONFIG: {','.join(cfg['missing_required'])} "
                  f"-- refusing loop", file=sys.stderr)
            return 2
        lock = _SingletonLock(SOAK_LOCK_PATH)
        if not lock.acquire():
            print("SOAK_ALREADY_RUNNING: another soak.py holds soak.lock "
                  "-- refusing concurrent orchestration",
                  file=sys.stderr)
            return 3
        try:
            _loop()
        finally:
            lock.release()
    else:
        print(__doc__)


def _loop():
    hours = 168.0
    for i, a in enumerate(sys.argv):
        if a == "--window-hours" and i + 1 < len(sys.argv):
            hours = float(sys.argv[i + 1])
    w = load_window(hours)
    # A previous incarnation may have died mid-window: derive and
    # record the dead interval BEFORE the first cycle, so the gap is
    # explicit evidence rather than silent absence.
    record_missed_range(ts_now())
    end = datetime.fromisoformat(w["end"]).timestamp()
    while time.time() < end:
        cycle()
        nxt = (int(time.time() / CYCLE_S) + 1) * CYCLE_S
        wait = nxt - time.time()
        if wait > CYCLE_S * 1.5:
            # Woke over a cycle late but alive: derive the lost
            # interval from the last poll row (honest count, not one
            # generic row).
            record_missed_range(ts_now())
        time.sleep(max(60, wait))
    print(f"window closed {w['end']}")


if __name__ == "__main__":
    sys.exit(main())
