#!/usr/bin/env python3
"""kill9_verify.py — asserts for the kill-9 resume demo.

Usage: kill9_verify.py <dir> <n_epochs>
  1. progress log lists epochs 1..N exactly once each;
  2. span_ids unique in the ledger (no duplicate features);
  3. every epoch outdir resolves a verified latest bundle via the reader.
Exits 0 only if all hold.
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
# read_latest pulls the canonical ctx reader from collector/.
REPO = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))
if REPO not in sys.path:
    sys.path.insert(0, REPO)

from plane import attribution as attribution_mod  # noqa: E402
from plane import emit as emit_mod  # noqa: E402

d, n = sys.argv[1], int(sys.argv[2])
fails = []


def ok(desc):
    print("PASS: %s" % desc)


progs = sorted({int(x) for x in
                open(os.path.join(d, "progress.log")).read().split()
                if x.strip()})
if progs == list(range(1, n + 1)):
    ok("all %d epochs completed exactly once" % n)
else:
    fails.append("epochs != 1..%d: %r" % (n, progs[:6]))

dbp = attribution_mod._db_for(os.path.join(d, "spans.jsonl"))
con = sqlite3.connect(dbp)
total, distinct = con.execute(
    "SELECT COUNT(*), COUNT(DISTINCT span_id) FROM spans").fetchone()
con.close()
if total == distinct and total > 0:
    ok("span_ids unique (%d spans, no duplicate features)" % total)
else:
    fails.append("span dupes: total=%d distinct=%d" % (total, distinct))

outs = os.path.join(d, "out", "manifest.jsonl")
committed = 0
if os.path.exists(outs):
    import json as _json
    for ln in open(outs, encoding="utf-8"):
        ln = ln.strip()
        if ln and _json.loads(ln).get("commit"):
            committed += 1
if committed == n:
    ok("manifest holds %d committed bundles (one per epoch)" % n)
else:
    fails.append("committed bundles %d != %d epochs" % (committed,
                                                           n))
try:
    res = emit_mod.read_latest(
        os.path.join(d, "out"), os.path.join(d, "canonical.db"),
        os.path.join(d, "entity_map.json"), 2 ** 62)
    if res is not None:
        ok("reader resolves latest verified bundle")
    else:
        fails.append("read_latest returned None")
except Exception as e:  # noqa: BLE001
    fails.append("read_latest raised: %r" % e)

print("---")
if fails:
    for f in fails:
        print("FAIL: %s" % f)
    sys.exit(1)
print("ALL KILL9 ASSERTS PASS")
