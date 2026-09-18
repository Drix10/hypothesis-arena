#!/usr/bin/env python3
"""P1.4 pre-grader: triages TRIGGER_CANDIDATEs so humans review ONLY the
ambiguous ones. Deterministic stdlib heuristics, read-only. NOT classification:
rules_v1 verdicts are never changed here; this only sorts the review queue.

  auto_genuine  header-parsed items (or FOMC policy text), source timestamp,
                fresh           -> almost certainly on-topic
  auto_noise    candidate-shaped rows that should not exist under rules_v1
                (estimated timestamp, aged, no parsable items) -> counted as
                noise AND filed as observed defects
  ambiguous     everything else -> human review list

Usage: python3 collector/pregrade.py data/classified/<day>.jsonl
Writes data/soak/pregrade-<day>.jsonl + prints the triage + noise estimate.
Noise % = (auto_noise + human-confirmed-ambiguous-noise) / graded.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SOAK = os.path.join(ROOT, "data", "soak")


def triage(row):
    ts = row.get("timestamps", {})
    reason = row.get("reason", "")
    eff = row.get("effect") or {}
    if ts.get("published_estimated"):
        return "auto_noise", "candidate-on-estimated-timestamp"
    if (eff.get("aged") is True) or reason == "candidate-expired":
        return "auto_noise", "aged-candidate-emitted"
    if "items_unknown" in eff:
        return "auto_noise", "candidate-without-parsable-items"
    if reason.startswith("8K-items:") or reason == "policy-statement":
        if eff.get("items") or reason == "policy-statement":
            return "auto_genuine", reason
    return "ambiguous", reason or "unparsed-reason"


def main():
    path = sys.argv[1]
    day = os.path.basename(path).replace(".jsonl", "")
    rows, out = [], []
    for line in open(path, encoding="utf-8"):
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if r.get("eligibility") != "TRIGGER_CANDIDATE":
            continue
        bucket, why = triage(r)
        rows.append({"id": r.get("id"), "source": r.get("source"),
                     "source_id": r.get("source_id"), "bucket": bucket,
                     "why": why, "reason": r.get("reason"),
                     "published_at": (r.get("timestamps") or {}).get("published_at")})
    os.makedirs(SOAK, exist_ok=True)
    dest = os.path.join(SOAK, f"pregrade-{day}.jsonl")
    with open(dest, "w", encoding="utf-8") as fh:
        for r in rows:
            fh.write(json.dumps(r) + "\n")
    n = len(rows)
    g = sum(1 for r in rows if r["bucket"] == "auto_genuine")
    nz = sum(1 for r in rows if r["bucket"] == "auto_noise")
    amb = n - g - nz
    print(f"candidates={n} auto_genuine={g} auto_noise={nz} ambiguous={amb}")
    print(f"pre-noise floor={nz}/{n}={nz / n * 100:.1f}% (auto only, human pending)"
          if n else "no candidates")
    if amb:
        print(f"--- human review queue ({amb}) ---")
        for r in rows:
            if r["bucket"] == "ambiguous":
                print(f"  [{r['source']}] {r['source_id']} :: {r['why']}")
    print(f"pregrade -> {dest}")
    # also refresh the human queue across the whole soak on every run
    queue = os.path.join(SOAK, "human-queue.jsonl")
    with open(queue, "w", encoding="utf-8") as q:
        for f in sorted(glob.glob(os.path.join(SOAK, "pregrade-*.jsonl"))):
            for line in open(f, encoding="utf-8"):
                r = json.loads(line)
                if r["bucket"] == "ambiguous":
                    q.write(line)


if __name__ == "__main__":
    main()
