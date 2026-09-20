#!/usr/bin/env python3
'''P1.5 acceptance: every ctx/boundary/plausibility contract has a test.
Run: python3 collector/test_ctx.py (stdlib only, temp DB, no P1.4 writes)
'''
import hashlib
import json
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from ctx_read import read_bundle, combine_hashes, HB_MAP  # noqa: E402


def datetime_ts(s):
    from datetime import datetime
    return datetime.fromisoformat(s).timestamp()


NOW = 1789747200.0  # fixed processing time (2026-09-18T16:00Z)
IN_SESSION = int(datetime_ts("2026-09-18T14:00:00+00:00")) * 1_000_000_000
OVERNIGHT = int(datetime_ts("2026-09-18T02:00:00+00:00")) * 1_000_000_000


TMP = tempfile.mkdtemp()
DB = os.path.join(TMP, "c.db")
H1, H2 = "a" * 64, "b" * 64
con = sqlite3.connect(DB)
con.execute("CREATE TABLE records (source, source_id, content_hash)")
con.execute("INSERT INTO records VALUES (?,?,?)", ("edgar_8k", "x", H1))
con.execute("INSERT INTO records VALUES (?,?,?)", ("edgar_8k", "y", H2))
con.commit()
con.close()
MAP = os.path.join(HERE, "entity_map.json")
N = 0


def feat(**kw):
    global N
    N += 1
    f = {"feature_id": "f%d" % N, "schema_version": "f2", "kind": "filing_event",
         "symbols": ["AAPL"], "observed_at_ns": IN_SESSION, "ttl_s": 10800,
         "value": {"type": "enum", "v": "8-K:item-2.02"}, "effect": "bullish",
         "evidence": "source", "confidence_bucket": "high",
         "source_id": "edgar_8k", "canonical_hash": H1}
    f.update(kw)
    return f


def run(features, extra=None, name="b"):
    b = {"bundle_id": name, "commit": True, "entity_map_version": "entity-v1",
         "features": features}
    b.update(extra or {})
    p = os.path.join(TMP, name + ".json")
    json.dump(b, open(p, "w"))
    return read_bundle(p, DB, MAP, NOW)


def check(name, cond):
    assert cond, name
    print("ok " + name)


# 1. valid single + multi-hash lineage
multi = feat(feature_id="m", canonical_hash=combine_hashes([H1, H2]),
             canonical_hashes=[H2, H1])
r = run([feat(), multi])
check("valid-accepted", r["stats"]["accepted"] == 2 and r["stats"]["rejected"] == 0)

# 2. incomplete bundle rejected wholesale
b = {"bundle_id": "inc", "commit": False, "features": [feat()]}
p = os.path.join(TMP, "inc.json")
json.dump(b, open(p, "w"))
r = read_bundle(p, DB, MAP, NOW)
check("incomplete-wholesale", r["accepted"] == [] and "bundle-incomplete" in r["stats"]["reasons"])

# 3. prose quarantined (nested)
r = run([feat(extra_deep={"thesis_text": "buy now"})])
check("prose-quarantined", r["stats"]["reasons"].get("prose-quarantined") == 1
      and r["stats"]["accepted"] == 0)

# 4. lineage failures
r = run([feat(canonical_hash="c" * 64)])
check("lineage-unresolved", r["stats"]["reasons"].get("lineage-unresolved") == 1)
r = run([feat(canonical_hash="d" * 64, canonical_hashes=[H1, H2])])
check("lineage-mismatch", r["stats"]["reasons"].get("lineage-mismatch") == 1)

# 5. entity binding
r = run([feat(symbols=["FAKECOIN"])])
check("entity-unmapped", "entity-unmapped:FAKECOIN" in r["stats"]["reasons"])
r = run([feat(symbols=["EURUSD"], kind="macro_release",
              observed_at_ns=IN_SESSION)])
check("macro-symbols-pass", r["stats"]["accepted"] == 1)

# 6. frozen feed (N=3) vs below threshold
hist3 = {"history": {"edgar_8k": [H1, H1, H1]}}
r = run([feat()], extra=hist3)
check("frozen-feed", r["stats"]["reasons"].get("frozen-feed") == 1)
r = run([feat()], extra={"history": {"edgar_8k": [H2, H1, H1]}})
check("below-frozen-threshold", r["stats"]["accepted"] == 1)

# 7. session freshness
r = run([feat(observed_at_ns=OVERNIGHT, ttl_s=86400)])
check("session-reject", r["stats"]["reasons"].get("session-reject") == 1)
r = run([feat(observed_at_ns=OVERNIGHT, kind="calendar_ahead", ttl_s=86400)])
check("overnight-allowlist", r["stats"]["accepted"] == 1)

# 8. R12 + TTL
r = run([feat(observed_at_ns=int((NOW + 60) * 1e9))])
check("future-timestamp", r["stats"]["reasons"].get("future-timestamp") == 1)
r = run([feat(observed_at_ns=int((NOW - 7200) * 1e9), ttl_s=3600)])
check("ttl-expired", r["stats"]["reasons"].get("ttl-expired") == 1)

# 9. heartbeat mapping, all 8 inputs
expect = {"ok": "healthy", "EMPTY_SUCCESS": "healthy", "STALE": "stale",
          "SOURCE_DOWN": "failed", "AUTH_FAILURE": "failed",
          "RATE_LIMITED": "failed", "PARSE_FAILURE": "failed",
          "SKIPPED_CONFIG": "not_scheduled"}
check("heartbeat-map", HB_MAP == expect)

# 10. map version mismatch
r = run([feat()], extra={"entity_map_version": "entity-v99"})
check("map-version-mismatch", r["accepted"] == []
      and "map-version-mismatch" in r["stats"]["reasons"])

# 11. inference capped, not dropped
r = run([feat(evidence="inference")])
check("inference-capped", r["stats"]["accepted"] == 1
      and r["stats"]["reasons"].get("inference-capped") == 1)

print("ALL CTX CHECKS PASS")
