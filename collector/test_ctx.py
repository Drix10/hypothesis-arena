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
from ctx_read import read_bundle, combine_hashes, HB_MAP, trigger_eligible  # noqa: E402


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
# Hashes exist under EVERY registered source: lineage binds hash AND source.
for _src in ("edgar_8k", "fed_monetary", "ecb_mid", "treasury_auctions",
             "bls_empsit", "fred_macro"):
    con.execute("INSERT INTO records VALUES (?,?,?)", (_src, "x", H1))
    con.execute("INSERT INTO records VALUES (?,?,?)", (_src, "y", H2))
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
    import hashlib as _hl
    sha = _hl.sha256(open(MAP, "rb").read()).hexdigest()
    b = {"bundle_id": name, "commit": True, "schema_version": "f2",
         "research_epoch": 0,
         "watermarks": {"entity_map_version": "entity-v1",
                        "entity_map_sha256": sha},
         "features": features}
    b.update(extra or {})
    p = os.path.join(TMP, name + ".json")
    json.dump(b, open(p, "w"))
    return read_bundle(p, DB, MAP, NOW)


def dated(h, ts):
    return {"h": h, "ts": int(ts)}


def check(name, cond):
    assert cond, name
    print("ok " + name)


# 1. valid single + multi-hash lineage
multi = feat(feature_id="m", canonical_hash=combine_hashes([H1, H2]),
             canonical_hashes=[H2, H1])
r = run([feat(), multi])
check("valid-accepted", r["stats"]["accepted"] == 2 and r["stats"]["rejected"] == 0)

# 2. incomplete bundle rejected wholesale
b = {"bundle_id": "inc", "commit": False, "schema_version": "f2",
     "research_epoch": 0, "features": [feat()]}
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

# 6. frozen feed (N=3 + time cover) vs below threshold
t0 = NOW - 3000
hist3 = {"history": {"edgar_8k": [dated(H1, t0), dated(H1, t0 + 1500),
                                     dated(H1, t0 + 2900)]}}
r = run([feat()], extra=hist3)
check("frozen-feed-v1", r["stats"]["reasons"].get("frozen-feed") == 1)
r = run([feat()], extra={"history": {"edgar_8k": [dated(H2, t0),
                                                  dated(H1, t0 + 1500),
                                                  dated(H1, t0 + 2900)]}})
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

# 10. map version mismatch + hash mismatch + missing watermarks
import hashlib as _hlm
MAP_SHA = _hlm.sha256(open(MAP, "rb").read()).hexdigest()
wm = {"watermarks": {"entity_map_version": "entity-v99",
                     "entity_map_sha256": MAP_SHA}}
r = run([feat()], extra=wm, name="bmap1")
check("map-version-mismatch", r["accepted"] == []
      and "map-version-mismatch" in r["stats"]["reasons"])
wm2 = {"watermarks": {"entity_map_version": "entity-v1",
                      "entity_map_sha256": "0" * 64}}
r = run([feat()], extra=wm2, name="bmap2")
check("map-hash-mismatch", r["accepted"] == []
      and "map-hash-mismatch" in r["stats"]["reasons"])
b = {"bundle_id": "nowm", "commit": True, "schema_version": "f2",
     "research_epoch": 0, "features": [feat()]}
p = os.path.join(TMP, "nowm.json")
json.dump(b, open(p, "w"))
r = read_bundle(p, DB, MAP, NOW)
check("watermarks-missing", r["accepted"] == []
      and "watermarks-missing" in r["stats"]["reasons"])

# 11. inference capped, not dropped
r = run([feat(evidence="inference")])
check("inference-capped", r["stats"]["accepted"] == 1
      and r["stats"]["reasons"].get("inference-capped") == 1)

# 12. hash format + unknown fields
r = run([feat(canonical_hash="not-a-hash")])
check("hash-format", r["stats"]["reasons"].get("hash-format") == 1)
r = run([feat(description="smuggled prose under unknown key")])
check("unknown-field", "unknown-field:description" in r["stats"]["reasons"])

# 13. entity contradiction (Option A groundwork)
r = run([feat(entity_ref={"cik": "0000320193"})])
check("entity-ref-consistent", r["stats"]["accepted"] == 1)
r = run([feat(symbols=["MSFT"], entity_ref={"cik": "0000320193"})])
check("entity-contradiction",
      r["stats"]["reasons"].get("entity-contradiction") == 1)
r = run([feat(entity_ref={"cik": "9999999999"})])
check("entity-ref-unknown", r["stats"]["reasons"].get("entity-ref-unknown") == 1)

# 14. dated history contracts
r = run([feat()], extra={"history": {"edgar_8k": [H1, H1, H1]}})
check("history-undated", r["stats"]["reasons"].get("history-undated") == 1)
tight = {"history": {"edgar_8k": [dated(H1, t0), dated(H1, t0 + 60),
                                 dated(H1, t0 + 120)]}}
r = run([feat()], extra=tight)
check("frozen-needs-time-cover", r["stats"]["accepted"] == 1)
# per-source-family covers: Fed 180m -> 90m span; Treasury 1080m -> 9h span
fed_ok = {"history": {"fed_monetary": [dated(H1, NOW - 6000),
                                           dated(H1, NOW - 3000),
                                           dated(H1, NOW - 100)]}}
ff = feat(source_id="fed_monetary", symbols=["EURUSD"], kind="macro_release")
r = run([ff], extra=fed_ok, name="bfed")
check("frozen-fed-cover", r["stats"]["reasons"].get("frozen-feed") == 1)
fed_short = {"history": {"fed_monetary": [dated(H1, NOW - 3000),
                                              dated(H1, NOW - 1500),
                                              dated(H1, NOW - 100)]}}
r = run([feat(source_id="fed_monetary", symbols=["EURUSD"],
              kind="macro_release")], extra=fed_short, name="bfed2")
check("frozen-fed-short", r["stats"]["accepted"] == 1)
tre_ok = {"history": {"treasury_auctions": [dated(H1, NOW - 35000),
                                                dated(H1, NOW - 17000),
                                                dated(H1, NOW - 100)]}}
ft = feat(source_id="treasury_auctions", symbols=["USD"], kind="macro_release")
r = run([ft], extra=tre_ok, name="btre")
check("frozen-treasury-cover", r["stats"]["reasons"].get("frozen-feed") == 1)

# 15. inference never TRIGGER-eligible downstream
inf = feat(evidence="inference")
check("inference-never-trigger",
      trigger_eligible(inf) is False
      and trigger_eligible(feat()) is True)

# 16. doc-example round trip: bundle-level vs feature-level ownership
full = feat(ingested_at_ns=int(NOW * 1e9),
            provenance_url="https://www.sec.gov/")
r = run([full], name="broundtrip")
check("doc-fields-accepted", r["stats"]["accepted"] == 1)

# 17. malformed nested types fail closed
r = run([feat(symbols="AAPL")], name="bm1")
check("symbols-str", r["stats"]["reasons"].get("symbols-type") == 1)
r = run([feat(symbols=[])], name="bm2")
check("symbols-empty", r["stats"]["reasons"].get("symbols-type") == 1)
r = run([feat(observed_at_ns=1.5)], name="bm3")
check("observed-float", r["stats"]["reasons"].get("observed-type") == 1)
r = run([feat(ttl_s="3600")], name="bm4")
check("ttl-str", r["stats"]["reasons"].get("ttl-type") == 1)
r = run([feat(ttl_s=0)], name="bm5")
check("ttl-zero", r["stats"]["reasons"].get("ttl-type") == 1)
r = run([feat(value={"type": "bool", "v": "yes"})], name="bm6")
check("value-bool-shape", r["stats"]["reasons"].get("value-shape") == 1)
r = run([feat(value={"type": "count", "v": -3})], name="bm7")
check("value-count-neg", r["stats"]["reasons"].get("value-shape") == 1)
r = run([feat(value={"type": "enum"})], name="bm8")
check("value-no-v", r["stats"]["reasons"].get("value-shape") == 1)
r = run([feat(entity_ref={"garbage": True})], name="bm9")
check("entity-ref-shape", r["stats"]["reasons"].get("entity-ref-shape") == 1)
r = run([feat(canonical_hash=H1, canonical_hashes=[H1, H1])], name="bm10")
check("hashes-dup", r["stats"]["reasons"].get("hash-format") == 1)

# 18. bool is not int at this boundary
r = run([feat(observed_at_ns=True)], name="bd1")
check("observed-bool", r["stats"]["reasons"].get("observed-type") == 1)
r = run([feat(ttl_s=True)], name="bd2")
check("ttl-bool", r["stats"]["reasons"].get("ttl-type") == 1)
r = run([feat(value={"type": "count", "v": True})], name="bd3")
check("count-bool", r["stats"]["reasons"].get("value-shape") == 1)

# 19. entity_ref must be exactly {cik: str}
r = run([feat(entity_ref={})], name="bd4")
check("entity-ref-empty", r["stats"]["reasons"].get("entity-ref-shape") == 1)

# 20. unhashable primitives reject, never raise
for fld, bad, name in [("kind", [], "kind-list"),
                        ("effect", {}, "effect-dict"),
                        ("evidence", [], "evidence-list"),
                        ("confidence_bucket", True, "conf-bool"),
                        ("source_id", ["x"], "source-list"),
                        ("schema_version", [], "schema-list")]:
    try:
        r = run([feat(**{fld: bad})], name="bd-" + name)
        got = r["stats"]["reasons"]
        ok = sum(got.values()) == 1 and r["stats"]["accepted"] == 0
    except TypeError:
        ok = False
    check(name, ok)

# 21. optional field types
r = run([feat(ingested_at_ns="now")], name="bd5")
check("ingested-str", r["stats"]["reasons"].get("ingested-type") == 1)
r = run([feat(ingested_at_ns=int((NOW + 60) * 1e9))], name="bd6")
check("ingested-future", r["stats"]["reasons"].get("ingested-future") == 1)
r = run([feat(provenance_url=123)], name="bd7")
check("provenance-int", r["stats"]["reasons"].get("provenance-type") == 1)

# 22. value object fail-closed
r = run([feat(value={"type": "enum", "v": "x", "extra": 1})], name="bd8")
check("value-extra-key", r["stats"]["reasons"].get("value-shape") == 1)

# 23. empty symbol string
r = run([feat(symbols=[""])], name="bd9")
check("symbols-empty-str", r["stats"]["reasons"].get("symbols-type") == 1)

# 24. exception-safety: entity_ref shapes that once threw
for bad_ref, name in [([], "ref-list"), (["cik"], "ref-cik-list"),
                       ("cik", "ref-str"), (None, "ref-null"),
                       ({"cik": 123}, "ref-cik-int"),
                       ({"cik": "x", "y": 1}, "ref-extra")]:
    try:
        r = run([feat(entity_ref=bad_ref)], name="be-" + name)
        got = r["stats"]["reasons"]
        ok = sum(got.values()) == 1 and r["stats"]["accepted"] == 0
    except (AttributeError, TypeError):
        ok = False
    check(name, ok)

# 25. value.type shapes that once relied on membership semantics
for bad_t, name in [([], "vtype-list"), ({}, "vtype-dict"),
                     (True, "vtype-bool"), (123, "vtype-int")]:
    try:
        r = run([feat(value={"type": bad_t, "v": 1})], name="bv-" + name)
        got = r["stats"]["reasons"]
        ok = sum(got.values()) == 1 and r["stats"]["accepted"] == 0
    except TypeError:
        ok = False
    check(name, ok)

# 26. non-object bundles reject deterministically
for blob, name in [([], "bundle-list"), ("garbage", "bundle-str"),
                    (123, "bundle-int"), (None, "bundle-null")]:
    try:
        p = os.path.join(TMP, "bb-" + name + ".json")
        json.dump(blob, open(p, "w"))
        r = read_bundle(p, DB, MAP, NOW)
        ok = r["accepted"] == [] and \
            "bundle-shape" in r["stats"]["reasons"]
    except AttributeError:
        ok = False
    check(name, ok)

# 27. lineage binds hash AND source: H3 lives only under edgar_8k.
H3 = "c" * 64
con = sqlite3.connect(DB)
con.execute("INSERT INTO records VALUES (?,?,?)", ("edgar_8k", "z", H3))
con.commit()
con.close()
r = run([feat(source_id="fed_monetary", symbols=["EURUSD"],
              kind="macro_release", canonical_hash=H3)], name="bx10")
check("lineage-wrong-source", r["stats"]["reasons"].get("lineage-mismatch") == 1
      and r["stats"]["accepted"] == 0)
r = run([feat(canonical_hash=H3)], name="bx10b")
check("lineage-right-source", r["stats"]["accepted"] == 1)

# 28. bundle envelope: schema/research_epoch/commit-exact/batch bounds.


def raw_bundle(**kw):
    import hashlib as _hl
    sha = _hl.sha256(open(MAP, "rb").read()).hexdigest()
    b = {"bundle_id": "env", "commit": True, "schema_version": "f2",
         "research_epoch": 3,
         "watermarks": {"entity_map_version": "entity-v1",
                          "entity_map_sha256": sha},
         "features": [feat()]}
    b.update(kw)
    p = os.path.join(TMP, "env-%d.json" % raw_bundle.n)
    raw_bundle.n += 1
    json.dump(b, open(p, "w"))
    return read_bundle(p, DB, MAP, NOW)


raw_bundle.n = 0
r = raw_bundle()
check("envelope-ok", r["stats"]["accepted"] == 1)
r = raw_bundle(schema_version="f1")
check("envelope-schema", "bundle-schema" in r["stats"]["reasons"])
r = raw_bundle(research_epoch=-1)
check("envelope-epoch-neg", "research-epoch" in r["stats"]["reasons"])
r = raw_bundle(research_epoch="3")
check("envelope-epoch-type", "research-epoch" in r["stats"]["reasons"])
r = raw_bundle(commit="yes")
check("envelope-commit-truthy", "bundle-incomplete" in r["stats"]["reasons"])
r = raw_bundle(bundle_id="")
check("envelope-id", "bundle-id" in r["stats"]["reasons"])
r = raw_bundle(features=[])
check("envelope-empty", "bundle-features" in r["stats"]["reasons"])
r = raw_bundle(features=[feat()] * 65)
check("envelope-65", "bundle-features" in r["stats"]["reasons"])
# oversize + unknown source + bad ttl + bad feature_id
big = raw_bundle()
bigp = os.path.join(TMP, "env-big.json")
json.dump([0] * 600000, open(bigp, "w"))
r = read_bundle(bigp, DB, MAP, NOW)
check("envelope-too-large", "bundle-too-large" in r["stats"]["reasons"])
r = run([feat(source_id="edgar_submissions")], name="bx11")
check("source-unknown", "source-unknown" in r["stats"]["reasons"])
r = run([feat(ttl_s=10 ** 18)], name="bx4")
check("ttl-bounded", "ttl-type" in r["stats"]["reasons"])
r = run([feat(feature_id="")], name="bxid")
check("feature-id-shape", "feature-id-shape" in r["stats"]["reasons"])
r = run([feat(observed_at_ns=2 ** 70)], name="bx5")
check("observed-range", "observed-range" in r["stats"]["reasons"])

print("ALL CTX CHECKS PASS")
