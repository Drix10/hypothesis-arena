"""Production resolve+emit step (doc 08 sec. 8.5, stdlib only).

The graph's emit node calls this (injected as deps["resolve_emit"]).
For each fused advisory candidate: resolve deterministically against
its canonical record (deps supply the canonical lookup); collect
resolved features; emit ONE committed bundle when at least one
feature resolved, otherwise publish NOTHING (empty=True — an aborted
or fully-dropped cycle leaves the last complete bundle standing,
exactly like an R15 abort).

Map-identity binding (finding 22): deps supply map_PATH, not a map
object. Publish reads the map file bytes (bounded), hashes them for
the watermark, parses them (duplicate-key rejecting), and passes THAT
parsed map to the resolver. The resolver and the watermark can never
disagree about which map version was used; a corrupt/unparseable map
file fails the whole emit closed (nothing publishes).

Producer/consumer contract (finding 19): the frozen reader accepts at
most 64 features. Resolved features are ordered deterministically by
(source_id, kind, canonical_hash) and the first 64 are emitted; the
rest are counted as dropped_over_cap (never silently spilled into a
reader-rejected bundle).

Feature identity (finding 20): feature_id is assigned HERE from
trusted canonical lineage (sha256 of kind+symbols+value+effect+
canonical_hash+observed_ns), never from candidate output. Identical
lineage collapses to one feature (first wins, duplicates counted), so
a model cannot invalidate a bundle with duplicate IDs.

Canonical lookup: deps["canonical_for"](candidate) -> canonical record
dict or None (no record -> candidate dropped + counted, never emitted
on prose alone). History: state["history"] (bounded dated per-source
tails from harvest) passes straight to the bundle.
"""
import hashlib
import json

from . import emit as emit_mod
from . import resolver
from . import schema

EMIT_MAX_FEATURES = 64  # frozen reader cap, enforced at the producer


def _load_map(map_path):
    """Read map file bytes; return (sha256, parsed) or (None, reason).
    Bounded (1MB) + duplicate-key rejecting: a hostile map file fails
    closed before it can bind anything."""
    try:
        with open(map_path, "rb") as fh:
            raw = fh.read(1 << 20 + 1)
    except OSError as e:
        return None, "map-unreadable:%s" % e
    if len(raw) > 1 << 20:
        return None, "map-too-large"
    sha = hashlib.sha256(raw).hexdigest()
    try:
        parsed = json.loads(raw.decode("utf-8"),
                            object_pairs_hook=_no_dupes)
    except ValueError:
        return None, "map-unparseable"
    if not isinstance(parsed, dict) or not isinstance(
            parsed.get("map_version"), str):
        return None, "map-shape"
    return (sha, parsed), None


def _no_dupes(pairs):
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise ValueError("duplicate key: %s" % k)
        obj[k] = v
    return obj


def _feature_lineage_id(feat):
    lineage = {"kind": feat["kind"], "symbols": feat["symbols"],
               "value": feat["value"], "effect": feat["effect"],
               "canonical_hash": feat["canonical_hash"],
               "observed_at_ns": feat["observed_at_ns"]}
    return "f-" + hashlib.sha256(
        schema.canon(lineage)).hexdigest()[:16]


def resolve_emit(deps, state):
    outdir = deps["outdir"]
    mapinfo, map_err = _load_map(deps["map_path"])
    if mapinfo is None:
        return {"emitted": None, "empty": True, "aborted": False,
                "map_error": map_err, "dropped_resolve": 0}
    map_sha, entity_map = mapinfo
    resolved = []
    dropped = 0
    for cand in state.get("fused", []):
        canon = deps["canonical_for"](cand)
        if canon is None:
            dropped += 1
            continue
        ok, out = resolver.resolve(
            cand, canon, entity_map,
            llm_touched=cand.get("llm_touched", True))
        if not ok:
            dropped += 1
            continue
        feat, _capped = out
        # No side-channel: R12 capping is already encoded as
        # evidence=inference by the resolver (no published ts can never
        # be mechanically identical). Nothing extra enters the bundle.
        feat["feature_id"] = _feature_lineage_id(feat)
        resolved.append(feat)
    # Deterministic order + dedupe + the frozen 64-feature boundary.
    resolved.sort(key=lambda f: (f["source_id"], f["kind"],
                                 f["canonical_hash"],
                                 f["feature_id"]))
    unique = []
    seen = set()
    dupes = 0
    for feat in resolved:
        if feat["feature_id"] in seen:
            dupes += 1
            continue
        seen.add(feat["feature_id"])
        unique.append(feat)
    over_cap = max(0, len(unique) - EMIT_MAX_FEATURES)
    clean = unique[:EMIT_MAX_FEATURES]
    if not clean:
        return {"emitted": None, "empty": True, "aborted": False,
                "dropped_resolve": dropped + dupes, "dropped_over_cap": 0}
    wm = {"entity_map_version": entity_map["map_version"],
          "entity_map_sha256": map_sha,
          "sources": dict(deps["source_watermarks"](state))}
    bid, path = emit_mod.emit_bundle(outdir, state["epoch"], clean, wm,
                                     state.get("history"))
    return {"emitted": bid, "bundle_path": path, "empty": False,
            "aborted": False, "dropped_resolve": dropped + dupes,
            "dropped_over_cap": over_cap}
