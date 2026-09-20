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
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from collect import validate_sources_config, ConfigError  # noqa: E402
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOAK = os.path.join(ROOT, "data", "soak")
DATA = os.path.join(ROOT, "data")
ALLOWED_HB = {"ok", "EMPTY_SUCCESS", "SKIPPED_CONFIG", "SOURCE_DOWN",
              "AUTH_FAILURE", "RATE_LIMITED", "PARSE_FAILURE", "STALE"}
# Freshness is proven per CYCLE, not per calendar day: a heartbeat may be
# at most max(2x that source's poll_min, 15 min) older than the snapshot
# row that cites it, and never more than 60 s newer (clock skew allowance).
FRESH_FUTURE_SKEW = 60
FRESH_MIN_BOUND = 900


def verdict(name, ok, detail=""):
    return {"check": name, "result": "PASS" if ok else "FAIL", "detail": detail}


def parse_instant(s):
    """ISO timestamp -> aware datetime, or None (never string-compare)."""
    try:
        dt = datetime.fromisoformat(s)
    except (ValueError, TypeError):
        return None
    if dt.tzinfo is None:
        return None
    return dt.astimezone(timezone.utc)


def row_day(row):
    inst = parse_instant(row.get("at"))
    return inst.strftime("%Y-%m-%d") if inst else None


def iter_poll_rows():
    """Yield (kind, row) for every polls.jsonl line: ("row", dict),
    ("nondict", obj), ("malformed", None). The single context-managed
    reader for all consumers: corruption is reported everywhere, never
    silently skipped by any single loop."""
    for f in glob.glob(os.path.join(SOAK, "polls.jsonl")):
        try:
            with open(f, encoding="utf-8") as fh:
                lines = fh.read().splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                row = json.loads(line)
            except ValueError:
                yield "malformed", None
                continue
            if not isinstance(row, dict):
                yield "nondict", row
            else:
                yield "row", row


def atomic_write_json(dest, obj):
    tmp = dest + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, indent=1)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, dest)


def main():
    day = sys.argv[1] if len(sys.argv) > 1 else \
        datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out = {"day": day, "rules_version": "rules_v1", "checks": []}
    C = out["checks"]
    # Configured universe FIRST: freshness bounds and coverage both key on it.
    try:
        with open(os.path.join(HERE, "sources.json"),
                   encoding="utf-8") as fh:
            _ss = validate_sources_config(json.load(fh))
            configured = {s["name"] for s in _ss}
            POLL_MIN = {s["name"]: s.get("poll_min", 15) for s in _ss}
    except (OSError, ValueError, ConfigError) as e:
        configured = set()
        POLL_MIN = {}
        C.append(verdict("sources-schema", False,
                         f"{type(e).__name__}: {e}"))
    else:
        C.append(verdict("sources-schema", True,
                         f"{len(configured)} sources"))

    # 1. EDGAR: polls + zero 403
    edgar_polls, edgar_403, edgar_other = 0, [], []
    for kind, row in iter_poll_rows():
        if kind != "row":
            continue
        if row_day(row) != day:
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

    # 2. heartbeat vocabulary (day-filtered) + coverage: every configured
    # source must have at least one heartbeat stamped for `day`. Freshness
    # is judged per CYCLE: heartbeat_at must fall inside the bounded
    # freshness window of the snapshot row citing it (same-day-date alone
    # is not freshness — a 00:01 heartbeat copied into 18:00 rows FAILs).
    # UNREADABLE always FAILs: broken observability is evidence of failure.
    unknown, statuses = [], {}
    seen_sources = set()
    stale_hb = []
    malformed_rows = 0
    for kind, row in iter_poll_rows():
        if kind != "row":
            malformed_rows += 1
            continue
        if row_day(row) != day:
            continue
        snap = parse_instant(row.get("at"))
        for src, h in (row.get("sources") or {}).items():
            if not isinstance(h, dict):
                stale_hb.append({"at": row.get("at"), "src": src,
                                 "why": "heartbeat-not-a-dict"})
                continue
            s = h.get("status")
            statuses[f"{src}:{s}"] = statuses.get(f"{src}:{s}", 0) + 1
            if s == "UNREADABLE":
                stale_hb.append({"at": row.get("at"), "src": src,
                                 "why": "unreadable-heartbeat"})
                continue
            if s not in ALLOWED_HB:
                unknown.append({"at": row.get("at"), "src": src,
                                "status": s})
                continue
            seen_sources.add(src)
            hb_at = parse_instant(h.get("heartbeat_at"))
            bound = max(2 * POLL_MIN.get(src, 15) * 60,
                        FRESH_MIN_BOUND)
            if snap is None or hb_at is None:
                stale_hb.append({"at": row.get("at"), "src": src,
                                 "why": "heartbeat-undated",
                                 "heartbeat_at": h.get("heartbeat_at")})
            else:
                age = (snap - hb_at).total_seconds()
                if not (-FRESH_FUTURE_SKEW <= age <= bound):
                    stale_hb.append({
                        "at": row.get("at"), "src": src,
                        "why": "heartbeat-not-fresh",
                        "heartbeat_at": h.get("heartbeat_at"),
                        "age_s": round(age, 1),
                        "bound_s": bound})
    C.append(verdict("heartbeat-vocabulary", not unknown,
                     f"{len(statuses)} combos seen, unknown={len(unknown)}"))
    out["heartbeat_combos"] = statuses
    C.append(verdict("heartbeat-freshness", not stale_hb,
                     f"stale_or_unreadable={len(stale_hb)}"))
    out["stale_heartbeat_samples"] = stale_hb[:5]
    C.append(verdict("poll-log-integrity", malformed_rows == 0,
                     f"malformed_poll_rows={malformed_rows}"))
    missing_hb = sorted(configured - seen_sources)
    C.append(verdict("heartbeat-coverage", not missing_hb,
                     f"missing={missing_hb or 'none'}"))
    # 2b. subprocess health: nonzero collect/classify exits recorded in the
    # day's poll rows fail acceptance (a failed collection that still
    # "passes" elsewhere is a verification lie).
    bad_exits = []
    for kind, row in iter_poll_rows():
        if kind != "row":
            continue
        if row_day(row) != day:
            continue
        for step in ("collect", "classify", "audit"):
                code = (row.get("exits") or {}).get(step)
                if code is not None and code != 0:
                    bad_exits.append({"at": row.get("at"), "step": step,
                                      "exit": code})
    C.append(verdict("subprocess-health", not bad_exits,
                     f"failures={bad_exits[:5] or 'none'}"))

    # 3a. replay determinism: same input + same FIXED as_of -> byte-identical
    # classified output. as_of is pinned (not wall-clock): without the pin
    # the two runs use different processing clocks and the comparison proves
    # nothing. Full file bytes are compared, not just per_source counters.
    sig = os.path.join(DATA, "signals", f"{day}.jsonl")
    det_ok, det_detail = True, "no signals file"
    if os.path.exists(sig):
        as_of = f"{day}T23:59:00+00:00"
        try:
            seqs = []
            for i in range(2):
                with tempfile.TemporaryDirectory() as tmp:
                    env = dict(os.environ,
                               MIRO_CANONICAL_DB=os.path.join(tmp, "c.db"),
                               MIRO_CLASSIFIED_DIR=os.path.join(tmp, "cl"))
                    r = subprocess.run(
                        [sys.executable, os.path.join(HERE, "classify.py"),
                         sig, "--as-of", as_of],
                        capture_output=True, text=True, env=env, timeout=300)
                    if r.returncode != 0:
                        raise RuntimeError(f"classify exit {r.returncode}")
                    with open(os.path.join(tmp, "cl", f"{day}.jsonl"),
                              encoding="utf-8") as fh:
                        seqs.append(fh.read())
            det_ok = seqs[0] == seqs[1]
            det_detail = "byte-identical" if det_ok else "outputs differ"
        except Exception as e:
            det_ok, det_detail = False, f"{type(e).__name__}: {e}"
    C.append(verdict("replay-determinism", det_ok, det_detail))

    # 3b. future-timestamp leakage in the DAY's classified feed, compared as
    # instants (never strings); unparseable timestamps are flagged too.
    # Malformed classified rows are evidence failure (classified-integrity),
    # never skipped: corruption in the derived projection must fail the
    # same way corruption in polls.jsonl does.
    day_classified = os.path.join(DATA, "classified", f"{day}.jsonl")
    leaks = []
    malformed_classified = 0
    if os.path.exists(day_classified):
        with open(day_classified, encoding="utf-8") as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    malformed_classified += 1
                    continue
                if not isinstance(r, dict):
                    malformed_classified += 1
                    continue
                t = r.get("timestamps") or {}
                pub, ret = parse_instant(t.get("published_at")), \
                    parse_instant(t.get("retrieved_at"))
                if t.get("published_at") and t.get("retrieved_at") and \
                        (pub is None or ret is None or pub > ret):
                    leaks.append(r.get("id"))
    C.append(verdict("no-future-leakage", not leaks, f"leaks={len(leaks)}"))
    C.append(verdict("classified-integrity", malformed_classified == 0,
                     f"malformed_classified_rows={malformed_classified}"))

    # 3c. SQLite integrity: no null keys, corrections link to real rows,
    # AND the file itself is structurally sound (PRAGMA integrity_check
    # must return exactly one row "ok": logical row checks cannot see
    # physical corruption).
    db = os.path.join(DATA, "canonical.db")
    integ_ok, integ_detail = True, "no db"
    if os.path.exists(db):
        try:
            con = sqlite3.connect(db)
            try:
                pragma = con.execute("PRAGMA integrity_check").fetchall()
                pragma_ok = (len(pragma) == 1 and pragma[0][0] == "ok")
                pragma_detail = pragma[0][0] if pragma else "empty"
                nulls = con.execute(
                    "SELECT COUNT(*) FROM records WHERE source IS NULL OR source_id IS NULL"
                ).fetchone()[0]
                orphans = con.execute(
                    """SELECT COUNT(*) FROM corrections c WHERE NOT EXISTS
                       (SELECT 1 FROM records r WHERE r.source=c.source
                        AND (r.source_id=c.base_id OR r.source_id=c.amending_id))"""
                ).fetchone()[0]
                n = con.execute("SELECT COUNT(*) FROM records").fetchone()[0]
            finally:
                con.close()
            integ_ok = (pragma_ok and nulls == 0 and orphans == 0)
            integ_detail = (f"rows={n} null_keys={nulls} "
                            f"orphan_corrections={orphans} pragma={pragma_detail}")
        except Exception as e:
            integ_ok, integ_detail = False, f"{type(e).__name__}: {e}"
    C.append(verdict("sqlite-integrity", integ_ok, integ_detail))

    # 5. soak window configuration: bounded, ISO, start < end.
    wpath = os.path.join(SOAK, "window.json")
    wok, wdetail = False, "no window.json"
    try:
        with open(wpath, encoding="utf-8") as fh:
            w = json.load(fh)
        s, e = parse_instant(w.get("start")), parse_instant(w.get("end"))
        hours = (e - s).total_seconds() / 3600 if s and e else -1
        wok = bool(s and e and 0 < hours <= 24 * 30)
        wdetail = f"{w.get('start')} -> {w.get('end')} ({hours:.1f}h)"
    except (OSError, ValueError, TypeError) as ex:
        wdetail = f"{type(ex).__name__}"
    C.append(verdict("window-config", wok, wdetail))

    # 4. boundary: no features.jsonl, no C++ artifacts anywhere under data/
    viol = []
    for f in glob.glob(os.path.join(DATA, "**", "*"), recursive=True):
        b = os.path.basename(f)
        if b.startswith("features") and b.endswith(".jsonl"):
            viol.append(f)
        if b.endswith((".o", ".so", ".a", ".out")) or b in ("hft", "core"):
            viol.append(f)
    C.append(verdict("boundary-intact", not viol, f"violations={len(viol)}"))

    # 6. config hygiene: template committed, real values untracked + present.
    # Uses config.load(): the SAME resolution as the soak itself (root .env
    # auto-loaded), not raw os.environ -- otherwise an unexported .env
    # would false-fail here while collection works fine.
    tracked = subprocess.run(["git", "-C", ROOT, "ls-files"],
                             capture_output=True, text=True).stdout.split()
    secret_leak = [f for f in tracked
                   if os.path.basename(f) == ".env" or f.endswith(".env")]
    tmpl_ok = os.path.exists(os.path.join(ROOT, ".env.example"))
    sys.path.insert(0, HERE)
    from config import load as load_config
    cfg = load_config()
    contact_ok = (cfg["status"] == "CONFIG_OK"
                   and "MIRO_CONTACT" in cfg["values"])
    hyg_ok = (not secret_leak and tmpl_ok and contact_ok)
    C.append(verdict("config-hygiene", hyg_ok,
                     f"template={tmpl_ok} tracked_envs={secret_leak or 'none'} "
                     f"contact_in_env={contact_ok}"))
    audits = sorted(glob.glob(os.path.join(SOAK, "audit-*.json")))
    day_audits = [a for a in audits if day in os.path.basename(a)]
    # Absence is absence: NEVER fall back to another day's audit. A stale
    # audit presented as today's evidence is a verification lie.
    C.append(verdict("audit-present", bool(day_audits),
                     f"audits_for_day={len(day_audits)}"))
    if day_audits:
        with open(day_audits[-1], encoding="utf-8") as fh:
            a = json.load(fh)
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
    atomic_write_json(dest, out)
    print(out["summary"])
    for c in C:
        print(f"  [{'x' if c['result'] == 'PASS' else '!'}] {c['check']}: {c['detail']}")
    print(f"acceptance -> {dest}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
