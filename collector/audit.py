#!/usr/bin/env python3
"""P1.3 audit: machine-readable baseline report for a signals sample.

Runs the pipeline against a scratch DB (canonical.db untouched) and reports:
total / unique / duplicates / revisions / malformed / stale /
TRIGGER candidates / CONTEXT / rejected / reason_by_category (+ per source).
Usage: python3 collector/audit.py data/signals/<day>.jsonl
"""
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix="miro-audit-")
os.environ["MIRO_CANONICAL_DB"] = os.path.join(tmp, "audit.db")
os.environ["MIRO_CLASSIFIED_DIR"] = tmp
sys.path.insert(0, HERE)

from classify import run  # noqa: E402


def main():
    from datetime import datetime, timezone
    as_of = datetime.now(timezone.utc).isoformat()
    out_path, stats = run(sys.argv[1], as_of=as_of)
    agg = {"input_records": 0, "unique_event_keys": 0, "unique_content_versions": 0,
           "duplicates": 0, "revisions": 0, "corrections": 0,
           "malformed": 0, "stale": 0, "trigger_candidates": 0,
           "context": 0, "rejected": 0, "reason_by_category": {},
           "per_source": stats.get("per_source", {}),
           # legacy aliases (definition: unique == unique_content_versions)
           "total": 0, "unique": 0}
    event_keys = set()
    for src, s in agg["per_source"].items():
        for k, v in s.items():
            if k in ("new", "correction"):
                agg["unique_content_versions"] += v
            elif k == "revision":
                agg["unique_content_versions"] += v
                agg["revisions"] += v
            elif k == "duplicate":
                agg["duplicates"] += v
            elif k == "malformed":
                agg["malformed"] += v
            elif k == "TRIGGER_CANDIDATE":
                agg["trigger_candidates"] += v
            elif k == "CONTEXT":
                agg["context"] += v
            elif k in ("REJECTED", "STALE"):
                agg["rejected"] += v
                if k == "STALE":
                    agg["stale"] += v
            elif k.startswith("reason:"):
                agg["reason_by_category"][k[7:]] = \
                    agg["reason_by_category"].get(k[7:], 0) + v
    for src, s in agg["per_source"].items():
        agg["input_records"] += sum(v for k, v in s.items()
                            if k in ("new", "duplicate", "revision", "correction", "malformed"))
    # unique_event_keys: exact distinct (source, source_id) from the audit DB.
    import sqlite3
    try:
        con = sqlite3.connect(os.environ["MIRO_CANONICAL_DB"])
        agg["unique_event_keys"] = con.execute(
            "SELECT COUNT(*) FROM (SELECT DISTINCT source, source_id FROM records)"
        ).fetchone()[0]
        con.close()
    except Exception:
        agg["unique_event_keys"] = None
    agg["corrections"] = sum(
        s.get("reason:amendment-never-triggers", 0)
        for s in agg["per_source"].values())
    agg["malformed"] += stats.get("malformed_lines", 0) + stats.get("schema_invalid", 0)
    agg["input_records"] += stats.get("malformed_lines", 0) + stats.get("schema_invalid", 0)
    agg["total"] = agg["input_records"]
    agg["unique"] = agg["unique_content_versions"]
    agg["as_of"] = as_of
    agg["classified_file"] = out_path
    print(json.dumps(agg, indent=1))


if __name__ == "__main__":
    main()
