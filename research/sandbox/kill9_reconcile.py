#!/usr/bin/env python3
"""kill9_reconcile.py — supervisor reconcile step of the kill-9 demo.

Lists unreconciled unknown-spend leases in the ledger and reconciles
each at its attested actual (demo: fake provider bills nothing, so $0
with an explicit note). Prints reconciled leases. Exits 1 if none
pending (the demo expects the killed epoch to leave exactly the
ambiguous-spend block).
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(
    os.path.abspath(__file__))))

from plane import attribution as attribution_mod  # noqa: E402

d = sys.argv[1]
dbp = attribution_mod._db_for(os.path.join(d, "spans.jsonl"))
con = sqlite3.connect(dbp)
pending = [r[0] for r in con.execute(
    "SELECT lease_id FROM unknown_holds WHERE reconciled=0").fetchall()]
held = [r[0] for r in con.execute(
    "SELECT lease_id FROM spend_holds WHERE state='invoked' AND "
    "usd > 0").fetchall()]
con.close()
for lease in held:
    if lease not in pending:
        pending.append(lease)
if not pending:
    print("FAIL: no pending unknown-spend leases (expected the kill "
          "to leave ambiguity)")
    sys.exit(1)
for lease in pending:
    attribution_mod.reconcile_unknown(
        os.path.join(d, "spans.jsonl"), lease, 0.0,
        note="kill9-demo: fake provider attests $0 billed")
    print("reconciled %s at $0.00" % lease)
print("PASS: ambiguous spend reconciled, block cleared")
