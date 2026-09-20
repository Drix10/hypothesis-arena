#!/usr/bin/env python3
'''soak_check regression: real schema parsing, UNREADABLE fails, heartbeat
freshness uses heartbeat_at, subprocess exits propagate. Stdlib only.
Run: python3 collector/test_soak_check.py (no network, temp dirs)
'''
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import soak_check  # noqa: E402

TMP = tempfile.mkdtemp()
SOAK = os.path.join(TMP, "soak")
DATA = os.path.join(TMP, "data")
os.makedirs(SOAK)
os.makedirs(DATA)
soak_check.SOAK = SOAK
soak_check.DATA = DATA

DAY = "2026-09-18"
AT = DAY + "T18:00:00+00:00"
OLD_AT = "2026-09-17T18:00:00+00:00"


def check(name, cond):
    assert cond, name
    print("ok " + name)


def write_polls(rows):
    with open(os.path.join(SOAK, "polls.jsonl"), "w",
              encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    with open(os.path.join(SOAK, "window.json"), "w",
              encoding="utf-8") as fh:
        json.dump({"start": DAY + "T00:00:00+00:00",
                   "end": "2026-09-19T00:00:00+00:00"}, fh)
    # A same-day audit artifact: absence is tested explicitly by deleting
    # it (audit-missing), never by the shared fixture lacking one.
    with open(os.path.join(SOAK, f"audit-{DAY}.json"), "w",
              encoding="utf-8") as fh:
        json.dump({"per_source": {}, "as_of": DAY + "T00:00:00+00:00",
                   "input_records": 0}, fh)


def hb(status, at=AT):
    return {"status": status, "detail": "", "items": 0, "heartbeat_at": at}


def run(day=DAY):
    sys.argv = ["soak_check.py", day]
    return soak_check.main()


def results():
    with open(os.path.join(SOAK, f"acceptance-{DAY}.json"),
              encoding="utf-8") as fh:
        return {c["check"]: c["result"]
                for c in json.load(fh)["checks"]}


NAMES = [s["name"] for s in
         json.load(open(os.path.join(HERE, "sources.json"), encoding="utf-8"))]

# 1. real sources.json parses as a top-level list (the .get() bug class)
good_row = {"at": AT, "exits": {"collect": 0, "classify": 0},
            "sources": {n: hb("ok") for n in NAMES}}
write_polls([good_row])
check("acceptance-runs", run() == 0)
r = results()
check("sources-schema", r["sources-schema"] == "PASS")
check("heartbeat-freshness", r["heartbeat-freshness"] == "PASS")
check("heartbeat-coverage", r["heartbeat-coverage"] == "PASS")
check("subprocess-health", r["subprocess-health"] == "PASS")

# 2. UNREADABLE heartbeat always FAILs
bad = {"at": AT, "exits": {"collect": 0},
       "sources": {n: hb("ok") for n in NAMES}}
bad["sources"][NAMES[0]] = {"status": "UNREADABLE", "heartbeat_at": None}
write_polls([bad])
run()
check("unreadable-fails", results()["heartbeat-freshness"] == "FAIL")

# 3. stale heartbeat_at (yesterday's file copied into today's row) FAILs
stale = {"at": AT, "exits": {"collect": 0},
         "sources": {n: hb("ok") for n in NAMES}}
stale["sources"][NAMES[1]] = hb("ok", OLD_AT)
write_polls([stale])
run()
check("stale-heartbeat-fails", results()["heartbeat-freshness"] == "FAIL")

# 3b. SAME-DAY but 12h-old heartbeat FAILs (date-fresh is not cycle-fresh)
noon = {"at": AT, "exits": {"collect": 0},
        "sources": {n: hb("ok") for n in NAMES}}
noon["sources"][NAMES[2]] = hb("ok", DAY + "T06:00:00+00:00")
write_polls([noon])
run()
check("sameday-stale-fails", results()["heartbeat-freshness"] == "FAIL")
# 10-min-old heartbeat for a 15-min-cadence source passes
fresh = {"at": AT, "exits": {"collect": 0},
         "sources": {n: hb("ok") for n in NAMES}}
fresh["sources"][NAMES[0]] = hb("ok", DAY + "T17:50:00+00:00")
write_polls([fresh])
run()
check("cycle-fresh-passes", results()["heartbeat-freshness"] == "PASS")

# 4. nonzero collect/classify/audit exits FAIL acceptance
fail = {"at": AT, "exits": {"collect": 1, "classify": 0},
        "sources": {n: hb("ok") for n in NAMES}}
write_polls([fail])
run()
check("collect-exit-fails", results()["subprocess-health"] == "FAIL")
fail["exits"] = {"collect": 0, "classify": 2}
write_polls([fail])
run()
check("classify-exit-fails", results()["subprocess-health"] == "FAIL")
fail["exits"] = {"collect": 0, "classify": 0, "audit": 3}
write_polls([fail])
run()
check("audit-exit-fails", results()["subprocess-health"] == "FAIL")

# 5. corrupt sources.json -> sources-schema FAIL (never AttributeError)
soak_check.HERE = TMP
with open(os.path.join(TMP, "sources.json"), "w",
          encoding="utf-8") as fh:
    json.dump({"sources": [{"name": "x"}]}, fh)
write_polls([good_row])
run()
check("sources-dict-fails", results()["sources-schema"] == "FAIL")
soak_check.HERE = HERE

# 6. missing configured source -> coverage FAIL
short = {"at": AT, "exits": {"collect": 0},
         "sources": {n: hb("ok") for n in NAMES[1:]}}
write_polls([short])
run()
check("coverage-missing", results()["heartbeat-coverage"] == "FAIL")

# 7. malformed poll lines fail poll-log-integrity (never silently skipped)
write_polls([good_row])
with open(os.path.join(SOAK, "polls.jsonl"), "a",
          encoding="utf-8") as fh:
    fh.write("{not json\n")
    fh.write('"bare string row"\n')
run()
check("poll-integrity-fails", results()["poll-log-integrity"] == "FAIL")

# 8. malformed classified rows fail classified-integrity (never skipped)
write_polls([good_row])
clf_dir = os.path.join(DATA, "classified")
os.makedirs(clf_dir, exist_ok=True)
with open(os.path.join(clf_dir, DAY + ".jsonl"), "w",
          encoding="utf-8") as fh:
    fh.write("{bad classified\n")
    fh.write('"bare string"\n')
    fh.write(json.dumps({"id": "x", "timestamps": {}}) + "\n")
run()
check("classified-integrity-fails",
      results()["classified-integrity"] == "FAIL")
os.remove(os.path.join(clf_dir, DAY + ".jsonl"))
write_polls([good_row])
run()
check("classified-integrity-passes",
      results()["classified-integrity"] == "PASS")

# 9. SQLite acceptance runs PRAGMA integrity_check on a real database
import sqlite3 as _sq
_db = os.path.join(DATA, "canonical.db")
_con = _sq.connect(_db)
_con.execute("CREATE TABLE records(source TEXT, source_id TEXT, "
             "content_hash TEXT, first_seen_at TEXT, last_seen_at TEXT, "
             "published_at TEXT, retrieved_at TEXT, revision_id TEXT, "
             "verdict TEXT, raw_json TEXT, parser_version TEXT, "
             "PRIMARY KEY(source, source_id, content_hash))")
_con.execute("CREATE TABLE corrections(source TEXT, amending_id TEXT, "
             "base_id TEXT, at TEXT, "
             "UNIQUE(source, amending_id, base_id))")
_con.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)",
             ("edgar_8k", "a", "h", "t", "t", None, "t", None,
              "new", "{}", "p1"))
_con.commit()
_con.close()
write_polls([good_row])
run()
check("sqlite-pragma-passes", results()["sqlite-integrity"] == "PASS")
_con = _sq.connect(_db)
_con.execute("INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)",
             (None, "b", "h2", "t", "t", None, "t", None,
              "new", "{}", "p1"))
_con.commit()
_con.close()
run()
check("sqlite-null-key-fails", results()["sqlite-integrity"] == "FAIL")
os.remove(_db)

# 10. audit absence is absence: no fallback to another day's audit
write_polls([good_row])
run()
check("audit-present-passes", results()["audit-present"] == "PASS")
os.remove(os.path.join(SOAK, f"audit-{DAY}.json"))
with open(os.path.join(SOAK, "audit-2000-01-01.json"), "w",
          encoding="utf-8") as fh:
    json.dump({"per_source": {}}, fh)
run()
check("audit-missing-fails", results()["audit-present"] == "FAIL")
for _f in os.listdir(SOAK):
    if _f.startswith("audit-"):
        os.remove(os.path.join(SOAK, _f))

# 11. soak runner: timeout/spawn failures are persisted evidence codes
import soak as _soak
_r = _soak.run_step([sys.executable, "-c",
                     "import time; time.sleep(30)"], timeout=2)
check("run-step-timeout", _r.returncode == 124)
_r = _soak.run_step([os.path.join(TMP, "no-such-binary-xyz")], timeout=10)
check("run-step-spawn", _r.returncode == 127)
# restart derivation: dead interval becomes an explicit MISSED_RANGE row
_soak.POLLS = os.path.join(SOAK, "polls.jsonl")
_old = {"at": "2026-09-18T10:00:00+00:00",
        "sources": {n: hb("ok", "2026-09-18T10:00:00+00:00")
                      for n in NAMES}}
write_polls([_old])
_n = _soak.record_missed_range("2026-09-18T16:45:00+00:00")
check("missed-range-count", _n == 27)  # 6h45m // 15m
_last = [json.loads(_l) for _l in
         open(os.path.join(SOAK, "polls.jsonl"),
              encoding="utf-8")][-1]
check("missed-range-row",
      _last["status"] == "MISSED_RANGE" and _last["count"] == 27
      and _last["from"] == "2026-09-18T10:00:00+00:00")
# continuous restart records nothing
write_polls([good_row])  # last at 18:00, now 18:05 -> gap < 1.5 cycles
_n = _soak.record_missed_range("2026-09-18T18:05:00+00:00")
check("missed-range-quiet", _n == 0)

print("ALL SOAK-CHECK TESTS PASS")
