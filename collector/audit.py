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
    out_path, stats = run(sys.argv[1])
    agg = {"total": 0, "unique": 0, "duplicates": 0, "revisions": 0,
           "malformed": 0, "stale": 0, "trigger_candidates": 0,
           "context": 0, "rejected": 0, "reason_by_category": {},
           "per_source": stats.get("per_source", {})}
    for src, s in agg["per_source"].items():
        for k, v in s.items():
            if k in ("new", "correction"):
                agg["unique"] += v
            elif k == "revision":
                agg["unique"] += v
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
        agg["total"] += sum(v for k, v in s.items()
                            if k in ("new", "duplicate", "revision", "correction", "malformed"))
    agg["malformed"] += stats.get("malformed_lines", 0)
    agg["total"] += stats.get("malformed_lines", 0)
    agg["classified_file"] = out_path
    print(json.dumps(agg, indent=1))


if __name__ == "__main__":
    main()
