"""Frozen f2 bundle/feature constants + builders (doc 08 sec. 8.5).

Single source of truth for SHAPE. Validity is owned exclusively by the
frozen reader (collector/ctx_read.py); this module never re-validates —
the acceptance tests round-trip every emitted bundle through
read_bundle(). Builders produce canonical-JSON-ready dicts only.
"""
import json

SCHEMA_VERSION = "f2"
MAX_FEATURES = 64

# Bundle envelope keys (BUNDLE_REQUIRED + BUNDLE_OPTIONAL in ctx_read).
BUNDLE_KEYS = ("schema_version", "research_epoch", "bundle_id", "commit",
               "watermarks", "features")
BUNDLE_OPTIONAL_KEYS = ("history",)

# Feature-level keys (required + optional in ctx_read f2).
FEATURE_REQUIRED = ("schema_version", "kind", "symbols", "value", "effect",
                    "evidence", "confidence_bucket", "source_id",
                    "canonical_hash", "observed_at_ns", "ttl_s")
FEATURE_OPTIONAL = ("feature_id", "canonical_hashes", "entity_ref",
                    "ingested_at_ns", "provenance_url")

KINDS = ("filing_event", "macro_release", "calendar_ahead", "osint_event",
         "sentiment_tail", "regime_hint")
EFFECTS = ("bullish", "bearish", "risk_up", "risk_down", "neutral",
           "unknown")
EVIDENCE = ("source", "derived", "inference")
CONFIDENCE = ("low", "medium", "high")
VTYPES = ("enum", "bucket", "bool", "count")

# Frozen emitter registry mirror (kind must be emittable by source_id).
EMITTERS = {
    "edgar_8k": ("filing_event",),
    "fed_monetary": ("macro_release", "calendar_ahead"),
    "ecb_mid": ("macro_release", "calendar_ahead"),
    "treasury_auctions": ("macro_release", "calendar_ahead"),
    "bls_empsit": ("macro_release", "calendar_ahead"),
    "fred_macro": ("macro_release", "calendar_ahead"),
}

# Frozen source reliability tier for confidence computation (doc 09 tiers).
SOURCE_TIER = {
    "edgar_8k": "high",
    "fed_monetary": "high",
    "ecb_mid": "high",
    "treasury_auctions": "high",
    "bls_empsit": "high",
    "fred_macro": "medium",
}
SOURCE_TTL_S = {
    "edgar_8k": 45 * 60,
    "fed_monetary": 3 * 3600,
    "ecb_mid": 3 * 3600,
    "treasury_auctions": 18 * 3600,
    "bls_empsit": 18 * 3600,
    "fred_macro": 18 * 3600,
}


def canon(obj):
    """Canonical bytes: the frozen P3.2 form (sort_keys, compact)."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True).encode("utf-8")


def make_bundle_id(epoch, content_sha):
    # Full digest identity (>= 128-bit rule: the whole 256-bit sha).
    # Truncated 64-bit IDs collide under birthday search and are
    # unfit for security-sensitive dedupe/identity.
    return "rp-%d-%s" % (epoch, content_sha)


def build_feature(kind, symbols, value, effect, evidence, conf, source_id,
                  canonical_hash, observed_ns, ingested_ns, ttl_s,
                  feature_id=None, hashes=None, entity_ref=None,
                  provenance_url=None):
    f = {"schema_version": SCHEMA_VERSION, "kind": kind,
         "symbols": list(symbols), "value": value, "effect": effect,
         "evidence": evidence, "confidence_bucket": conf,
         "source_id": source_id, "canonical_hash": canonical_hash,
         "observed_at_ns": observed_ns, "ingested_at_ns": ingested_ns,
         "ttl_s": ttl_s}
    if feature_id is not None:
        f["feature_id"] = feature_id
    if hashes is not None:
        f["canonical_hashes"] = list(hashes)
    if entity_ref is not None:
        f["entity_ref"] = dict(entity_ref)
    if provenance_url is not None:
        f["provenance_url"] = provenance_url
    return f


def build_bundle(epoch, bundle_id, features, watermarks, history=None):
    b = {"schema_version": SCHEMA_VERSION, "research_epoch": epoch,
         "bundle_id": bundle_id, "commit": True,
         "watermarks": dict(watermarks), "features": list(features)}
    if history is not None:
        b["history"] = dict(history)
    return b


# Strict JSON-safe validation (producer/state inputs): only plain
# containers and finite scalars pass. Anything else (arbitrary
# objects, non-finite floats, over-long strings, over-deep nesting)
# is REJECTED — never admitted via a lossy str() coercion that
# would pass the size test while leaving unserializable or
# unexpectedly expensive objects in checkpoint state.
JSON_SAFE_MAX_NODES = 100000
JSON_SAFE_MAX_STR = 65536
JSON_SAFE_MAX_DEPTH = 32


def json_safe(obj, max_nodes=JSON_SAFE_MAX_NODES,
              max_str=JSON_SAFE_MAX_STR):
    """(ok, reason): True only for plain JSON-shaped data."""
    import math
    count = [0]

    def _walk(o, depth):
        count[0] += 1
        if count[0] > max_nodes:
            return "too-many-nodes"
        if depth > JSON_SAFE_MAX_DEPTH:
            return "too-deep"
        if o is None or o is True or o is False:
            return None
        if type(o) is int:
            return None
        if type(o) is float:
            return None if math.isfinite(o) else "non-finite-float"
        if isinstance(o, str):
            return None if len(o) <= max_str else "string-too-long"
        if isinstance(o, list):
            for v in o:
                bad = _walk(v, depth + 1)
                if bad:
                    return bad
            return None
        if isinstance(o, dict):
            for k, v in o.items():
                if not isinstance(k, str) or len(k) > max_str:
                    return "bad-key"
                bad = _walk(v, depth + 1)
                if bad:
                    return bad
            return None
        return "non-json-type:%s" % type(o).__name__
    bad = _walk(obj, 0)
    return (bad is None, bad or "ok")
