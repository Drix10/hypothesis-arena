#!/usr/bin/env python3
'''P1.5 acceptance: every ctx/boundary/plausibility contract has a test.
Run: python3 collector/tests/test_ctx.py (stdlib only, temp DB, no P1.4 writes)
'''
import hashlib
import json
import os
import sqlite3
import sys
import tempfile

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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
             "bls_empsit", "fred_macro", "bea_nipa_gdp"):
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


def wm_full(*sources):
    """Frozen watermark envelope for tests: map pins + per-source
    {last_observation_at, cursor} for the given sources."""
    sha = hashlib.sha256(open(MAP, "rb").read()).hexdigest()
    srcs = sources or ("edgar_8k", "fed_monetary", "ecb_mid",
                       "treasury_auctions", "bls_empsit", "fred_macro",
                       "bea_nipa_gdp")
    return {"entity_map_version": "entity-v1",
            "entity_map_sha256": sha,
            "sources": {s: {"last_observation_at": int(NOW) - 300,
                              "cursor": "test-cursor"} for s in srcs}}


def run(features, extra=None, name="b"):
    b = {"bundle_id": name, "commit": True, "schema_version": "f2",
         "research_epoch": 0, "watermarks": wm_full(),
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
              source_id="fed_monetary", observed_at_ns=IN_SESSION)])
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
r = run([feat(observed_at_ns=OVERNIGHT, kind="calendar_ahead",
              source_id="fed_monetary", symbols=["EURUSD"], ttl_s=86400)])
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

# 14. undated history rejected at the bundle boundary (strict entries)
r = run([feat()], extra={"history": {"edgar_8k": [H1, H1, H1]}})
check("history-undated", "history-shape" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)
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
    b = {"bundle_id": "env", "commit": True, "schema_version": "f2",
         "research_epoch": 3, "watermarks": wm_full(),
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
r = run([feat(observed_at_ns=-1)], name="bx6")
check("observed-negative", "observed-range" in r["stats"]["reasons"])

# 29. source/kind emission registry: structurally valid but semantically
# impossible combinations are rejected (kind-no-emitter)
r = run([feat(kind="macro_release")], name="bk1")
check("edgar-macro-rejected",
      r["stats"]["reasons"].get("kind-no-emitter") == 1)
r = run([feat(kind="sentiment_tail")], name="bk2")
check("sentiment-no-emitter",
      r["stats"]["reasons"].get("kind-no-emitter") == 1)
r = run([feat(kind="regime_hint", source_id="fed_monetary",
              symbols=["EURUSD"])], name="bk3")
check("regime-no-emitter",
      r["stats"]["reasons"].get("kind-no-emitter") == 1)
r = run([feat(source_id="fed_monetary", symbols=["EURUSD"],
              kind="macro_release")], name="bk4")
check("fed-macro-emitter", r["stats"]["accepted"] == 1)

# 30. duplicate JSON members rejected (bundle + nested feature)
dup_raw = ('{"bundle_id": "dup", "bundle_id": "dup2", '
           '"commit": true, "schema_version": "f2", '
           '"research_epoch": 0, "watermarks": {}, "features": []}')
_pp = os.path.join(TMP, "dup.json")
open(_pp, "w").write(dup_raw)
r = read_bundle(_pp, DB, MAP, NOW)
check("bundle-duplicate-keys",
      "bundle-duplicate-keys" in r["stats"]["reasons"])
_fraw = ('{"bundle_id": "dupf", "commit": true, '
         '"schema_version": "f2", "research_epoch": 0, '
         '"watermarks": {"entity_map_version": "entity-v1", '
         '"entity_map_sha256": "%s"}, '
         '"features": [{"source_id": "edgar_8k", '
         '"source_id": "fed_monetary"}]}' % MAP_SHA)
_pp2 = os.path.join(TMP, "dupf.json")
open(_pp2, "w").write(_fraw)
r = read_bundle(_pp2, DB, MAP, NOW)
check("feature-duplicate-keys",
      "bundle-duplicate-keys" in r["stats"]["reasons"])

# 31. strict bundle envelope: unknown top-level keys rejected
r = run([feat()], extra={"thesis_text": "smuggled"}, name="benv")
check("bundle-unknown-field",
      "bundle-unknown-field:thesis_text" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)

# 32. feature_id uniqueness within a bundle
_f1, _f2 = feat(feature_id="same"), feat(feature_id="same")
r = run([_f1, _f2], name="bdup")
check("bundle-duplicate-feature-id",
      "bundle-duplicate-feature-id" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)

# 33. non-dict features + strict history entries
r = raw_bundle(features=[[1, 2]])
check("feature-shape",
      r["stats"]["reasons"].get("feature-shape") == 1)
r = run([feat()], extra={"history": {"edgar_8k": [{"h": H1}]}},
        name="bhist")
check("history-entry-shape", "history-shape" in r["stats"]["reasons"])
r = run([feat()], extra={"history": {"edgar_8k": [dated(H1, -5)]}},
        name="bhist2")
check("history-negative-ts", "history-shape" in r["stats"]["reasons"])

# 34. history namespace: unknown source keys rejected at the boundary
r = run([feat()], extra={"history": {"fake-source": [dated(H1, t0)]}},
        name="bhist-ns")
check("history-unknown-source",
      "history-unknown-source" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)

# 35. history monotonicity: reordered + duplicate timestamps rejected
r = run([feat()],
        extra={"history": {"edgar_8k": [dated(H1, t0),
                                          dated(H1, t0 + 100),
                                          dated(H1, t0 + 50)]}},
        name="bhist-reorder")
check("history-nonmonotonic",
      "history-nonmonotonic" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)
r = run([feat()],
        extra={"history": {"edgar_8k": [dated(H1, t0),
                                          dated(H1, t0)]}},
        name="bhist-dupe-ts")
check("history-duplicate-ts",
      "history-nonmonotonic" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)

# 36. watermark envelope: shape, namespace, skew, coverage
_bad_wm = dict(wm_full())
_bad_wm["extra"] = 1
r = run([feat()], extra={"watermarks": _bad_wm}, name="bwm-extra")
check("watermark-extra-key", "watermark-shape" in r["stats"]["reasons"])
_bad_wm2 = wm_full()
_bad_wm2["sources"]["edgar_8k"] = {"last_observation_at": int(NOW) - 10}
r = run([feat()], extra={"watermarks": _bad_wm2}, name="bwm-keys")
check("watermark-source-keys",
      "watermark-shape" in r["stats"]["reasons"])
_bad_wm3 = wm_full()
_bad_wm3["sources"]["edgar_8k"] = {
    "last_observation_at": int(NOW) + 3600, "cursor": "c"}
r = run([feat()], extra={"watermarks": _bad_wm3}, name="bwm-future")
check("watermark-future", "watermark-shape" in r["stats"]["reasons"])
_bad_wm4 = wm_full("fed_monetary")  # edgar_8k participates, unwatermarked
r = run([feat()], extra={"watermarks": _bad_wm4}, name="bwm-cover")
check("watermark-coverage",
      "watermark-coverage:edgar_8k" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)
_bad_wm5 = wm_full()
_bad_wm5["sources"]["nope"] = {"last_observation_at": 1,
                                   "cursor": "c"}
r = run([feat()], extra={"watermarks": _bad_wm5}, name="bwm-ns")
check("watermark-unknown-source",
      "watermark-unknown-source" in r["stats"]["reasons"])
# history-only participant must also be watermarked
_hist_wm = wm_full("edgar_8k")
r = run([feat()],
        extra={"watermarks": _hist_wm,
               "history": {"fed_monetary": [dated(H1, t0)]}},
        name="bwm-histcover")
check("watermark-history-coverage",
      "watermark-coverage:fed_monetary" in r["stats"]["reasons"])

# 37. symbols cardinality bound
r = run([feat(symbols=["AAPL"] * 17)], name="bsym17")
check("symbols-cardinality",
      r["stats"]["reasons"].get("symbols-cardinality") == 1
      and r["stats"]["accepted"] == 0)
r = run([feat(symbols=["AAPL"] * 16)], name="bsym16")
check("symbols-16-ok", r["stats"]["accepted"] == 1)

# 38. history-future bound + ingested/observed provenance order
r = run([feat()],
        extra={"history": {"edgar_8k": [dated(H1, int(NOW) + 3600)]}},
        name="bhist-future")
check("history-future",
      "history-future" in r["stats"]["reasons"]
      and r["stats"]["accepted"] == 0)
r = run([feat(observed_at_ns=IN_SESSION,
              ingested_at_ns=IN_SESSION - 10 ** 9)], name="bing-ord")
check("ingested-before-observed",
      r["stats"]["reasons"].get("ingested-before-observed") == 1
      and r["stats"]["accepted"] == 0)

# 39. BEA NIPA GDP namespace admission (registration proof)
bea_hist = {"history": {"bea_nipa_gdp": [dated(H1, NOW - 3000),
                                             dated(H1, NOW - 1500),
                                             dated(H1, NOW - 100)]}}
bea = feat(source_id="bea_nipa_gdp", symbols=["SPY"],
           kind="macro_release")
r = run([bea], extra=bea_hist, name="bbea")
check("bea-admitted", r["stats"]["accepted"] == 1)
r = run([feat(source_id="bea_nipa_gdp", symbols=["SPY"],
              kind="calendar_ahead")], extra=bea_hist, name="bbea2")
check("bea-wrong-kind",
      r["stats"]["reasons"].get("kind-no-emitter") == 1
      and r["stats"]["accepted"] == 0)
r = run([feat(source_id="nope_src", symbols=["SPY"],
              kind="macro_release")], name="bunknown")
check("unknown-source-still-rejected",
      r["stats"]["reasons"].get("source-unknown") == 1
      and r["stats"]["accepted"] == 0)

print("ALL CTX CHECKS PASS")
