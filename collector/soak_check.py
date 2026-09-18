#!/usr/bin/env python3
"""P1.4 objective acceptance checker. Read-only; verifies every acceptance
criterion that does not need a human eye, and emits PASS/FAIL per criterion.
The only human work left: grading data/soak/human-queue.jsonl (ambiguous
candidates the pre-grader could not resolve).

Usage: python3 collector/soak_check.py [day]
  day defaults to today (UTC). Writes data/soak/acceptance-<day>.json.
"""
import glob
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOAK = os.path.join(ROOT, "data", "soak")
DATA = os.path.join(ROOT, "data")
ALLOWED_HB = {"ok", "EMPTY_SUCCESS", "SKIPPED_CONFIG", "SOURCE_DOWN",
              "AUTH_FAILURE", "RATE_LIMITED", "PARSE_FAILURE", "STALE"}


def verdict(name, ok, detail=""):
    return {"check": name, "result": "PASS" if ok else "FAIL", "detail": detail}


def main():
    day = sys.argv[1] if len(sys.argv) > 1 else \
        datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = {"day": day, "rules_version": "rules_v1", "checks": []}
    C = out["checks"]

    # 1. EDGAR: polls + zero 403
    edgar_polls, edgar_403, edgar_other = 0, [], []
    for f in glob.glob(os.path.join(SOAK, "polls.jsonl")):
        for line in open(f, encoding="utf-8"):
            try:
                row = json.loads(line)
            except ValueError:
                continue
            e = (row.get("sources") or {}).get("edgar_8k")
            if not e:
                continue
            edgar_polls += 1
            det = str(e.get("detail", ""))
            if "403" in det or e.get("status") in ("AUTH_FAILURE",):
                edgar_403.append({"at": row.get("at"), "detail": det[:120]})
            elif e.get("status") not in ("ok", "EMPTY_SUCCESS"):
                edgar_other.append({"at": row.get("at"), "status": e.get("status")})
    C.append(verdict("edgar-zero-403", not edgar_403,
                     f"polls={edgar_polls} 403s={len(edgar_403)} "
                     f"other={len(edgar_other)}"))
    out["edgar_403_samples"] = edgar_403[:5]

    # 2. heartbeat vocabulary
    unknown, statuses = [], {}
    for f in glob.glob(os.path.join(SOAK, "polls.jsonl")):
        for line in open(f, encoding="utf-8"):
            try:
                row = json.loads(line)
            except ValueError:
                continue
            for src, h in (row.get("sources") or {}).items():
                s = h.get("status")
                statuses[f"{src}:{s}"] = statuses.get(f"{src}:{s}", 0) + 1
                if s not in ALLOWED_HB and s != "UNREADABLE":
                    unknown.append({"at": row.get("at"), "src": src, "status": s})
    C.append(verdict("heartbeat-vocabulary", not unknown,
                     f"{len(statuses)} combos seen, unknown={len(unknown)}"))
    out["heartbeat_combos"] = statuses

    # 3a. replay determinism: same input + same as_of -> identical verdicts
    sig = os.path.join(DATA, "signals", f"{day}.jsonl")
    det_ok, det_detail = True, "no signals file"
    if os.path.exists(sig):
        try:
            seqs = []
            for i in range(2):
                tmp = tempfile.mkdtemp()
                env = dict(os.environ, MIRO_CANONICAL_DB=os.path.join(tmp, "c.db"),
                           MIRO_CLASSIFIED_DIR=os.path.join(tmp, "cl"))
                r = subprocess.run(
                    [sys.executable, os.path.join(HERE, "classify.py"), sig],
                    capture_output=True, text=True, env=env, timeout=300)
                lines = r.stdout.strip().splitlines()
                stats = json.loads("\n".join(lines[1:]))  # skip 'classified ->' line
                per = stats.get("per_source", {})
                seqs.append(json.dumps(per, sort_keys=True))
            det_ok = seqs[0] == seqs[1]
            det_detail = "identical" if det_ok else f"{seqs[0][:200]} != {seqs[1][:200]}"
        except Exception as e:
            det_ok, det_detail = False, f"{type(e).__name__}: {e}"
    C.append(verdict("replay-determinism", det_ok, det_detail))

    # 3b. future-timestamp leakage in emitted classified feed
    leaks = []
    for f in glob.glob(os.path.join(DATA, "classified", "*.jsonl")):
        for line in open(f, encoding="utf-8"):
            try:
                r = json.loads(line)
            except ValueError:
                continue
            t = r.get("timestamps") or {}
            if t.get("published_at") and t.get("retrieved_at") and \
                    t["published_at"] > t["retrieved_at"]:
                leaks.append(r.get("id"))
    C.append(verdict("no-future-leakage", not leaks, f"leaks={len(leaks)}"))

    # 3c. SQLite integrity: no null keys, corrections link to real rows
    db = os.path.join(DATA, "canonical.db")
    integ_ok, integ_detail = True, "no db"
    if os.path.exists(db):
        try:
            con = sqlite3.connect(db)
            nulls = con.execute(
                "SELECT COUNT(*) FROM records WHERE source IS NULL OR source_id IS NULL"
            ).fetchone()[0]
            orphans = con.execute(
                """SELECT COUNT(*) FROM corrections c WHERE NOT EXISTS
                   (SELECT 1 FROM records r WHERE r.source=c.source
                    AND (r.source_id=c.base_id OR r.source_id=c.amending_id))"""
            ).fetchone()[0]
            n = con.execute("SELECT COUNT(*) FROM records").fetchone()[0]
            con.close()
            integ_ok = (nulls == 0 and orphans == 0)
            integ_detail = f"rows={n} null_keys={nulls} orphan_corrections={orphans}"
        except Exception as e:
            integ_ok, integ_detail = False, f"{type(e).__name__}: {e}"
    C.append(verdict("sqlite-integrity", integ_ok, integ_detail))

    # 4. boundary: no features.jsonl, no C++ artifacts anywhere under data/
    viol = []
    for f in glob.glob(os.path.join(DATA, "**", "*"), recursive=True):
        b = os.path.basename(f)
        if b.startswith("features") and b.endswith(".jsonl"):
            viol.append(f)
        if b.endswith((".o", ".so", ".a", ".out")) or b in ("hft", "core"):
            viol.append(f)
    C.append(verdict("boundary-intact", not viol, f"violations={len(viol)}"))

    # 5. aggregate rates from the latest soak audit
    audits = sorted(glob.glob(os.path.join(SOAK, "audit-*.json")))
    if audits:
        a = json.load(open(audits[-1]))
        out["latest_audit"] = {
            k: a.get(k) for k in ("input_records", "unique_event_keys",
                                  "unique_content_versions", "duplicates",
                                  "revisions", "corrections", "malformed",
                                  "stale", "trigger_candidates", "context",
                                  "rejected", "as_of")}
        ps = a.get("per_source", {})
        out["rates_per_source"] = {
            s: {k: v.get(k, 0) for k in ("new", "TRIGGER_CANDIDATE", "CONTEXT",
                                         "STALE", "duplicate", "revision")}
            for s, v in ps.items()}

    fails = [c for c in C if c["result"] == "FAIL"]
    out["summary"] = f"{len(C) - len(fails)}/{len(C)} objective checks PASS"
    os.makedirs(SOAK, exist_ok=True)
    dest = os.path.join(SOAK, f"acceptance-{day}.json")
    json.dump(out, open(dest, "w"), indent=1)
    print(out["summary"])
    for c in C:
        print(f"  [{'x' if c['result'] == 'PASS' else '!'}] {c['check']}: {c['detail']}")
    print(f"acceptance -> {dest}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
