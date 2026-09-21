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
import re

from . import emit as emit_mod
from . import resolver
from . import schema

EMIT_MAX_FEATURES = 64  # frozen reader cap, enforced at the producer
EMIT_MAX_SYMBOLS = 16  # frozen ctx MAX_SYMBOLS, enforced at producer
CURSOR_MAX_LEN = 256
# Strict map bounds: the pinned map is small and exact; anything
# larger or misshapen is hostile input, not a map.
MAP_MAX_CIK = 20000
MAP_MAX_MACRO_KEYS = 20000
MAP_MAX_MACRO_SYMS = 512
MAP_VERSION_MAX = 64
TICKER_RE = re.compile(r"[A-Z][A-Z0-9.\-]{0,15}")
CIK_RE = re.compile(r"[0-9]{1,10}")
MAP_ALLOWED_KEYS = {"map_version", "cik_to_ticker",
                    "macro_release_to_symbols", "note"}


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
    if set(parsed) - MAP_ALLOWED_KEYS:
        return None, "map-keys"
    if not 0 < len(parsed["map_version"]) <= MAP_VERSION_MAX:
        return None, "map-version"
    note = parsed.get("note")
    if note is not None and (not isinstance(note, str) or
                              len(note) > 1024):
        return None, "map-note"
    cik = parsed.get("cik_to_ticker")
    if not isinstance(cik, dict) or len(cik) > MAP_MAX_CIK:
        return None, "map-cik-shape"
    for k, v in cik.items():
        if not isinstance(k, str) or not CIK_RE.fullmatch(k):
            return None, "map-cik-key"
        if not isinstance(v, str) or not TICKER_RE.fullmatch(v):
            return None, "map-cik-value"
    macro = parsed.get("macro_release_to_symbols")
    if not isinstance(macro, dict) or \
            len(macro) > MAP_MAX_MACRO_KEYS:
        return None, "map-macro-shape"
    for k, v in macro.items():
        if not isinstance(k, str) or not 0 < len(k) <= 128:
            return None, "map-macro-key"
        if (not isinstance(v, list) or
                len(v) > MAP_MAX_MACRO_SYMS or
                any(not isinstance(s, str) or
                    not TICKER_RE.fullmatch(s) for s in v)):
            return None, "map-macro-value"
    return (sha, parsed), None


def _no_dupes(pairs):
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise ValueError("duplicate key: %s" % k)
        obj[k] = v
    return obj


def _validate_watermarks(sources, feature_srcs, history_srcs):
    """Strict producer-side watermark check. Returns (ok, clean,
    uncovered): ok=False fails the whole emit closed (structurally
    invalid envelope); uncovered is the set of participating sources
    with no valid watermark entry, whose features are dropped."""
    if not isinstance(sources, dict):
        return False, {}, "watermark-shape"
    clean = {}
    for sid, w in sources.items():
        if not isinstance(sid, str) or not sid:
            return False, {}, "watermark-shape"
        if (not isinstance(w, dict) or set(w) !=
                {"last_observation_at", "cursor"} or
                type(w["last_observation_at"]) is not int or
                w["last_observation_at"] < 0 or
                not isinstance(w["cursor"], str) or
                len(w["cursor"]) > CURSOR_MAX_LEN):
            return False, {}, "watermark-shape"
        clean[sid] = {"last_observation_at": w["last_observation_at"],
                      "cursor": w["cursor"]}
    uncovered = (set(feature_srcs) | set(history_srcs)) - set(clean)
    return True, clean, uncovered


def _validate_history(history):
    """Producer-side history shape check. Returns (clean_or_None,
    dropped_count). Malformed tails are dropped+counted here so the
    reader never sees them."""
    if history is None:
        return None, 0
    if not isinstance(history, dict):
        return None, 1
    clean = {}
    dropped = 0
    for src, entries in history.items():
        if not isinstance(src, str) or not isinstance(entries, list):
            dropped += 1
            continue
        good = []
        prev = None
        for e in entries:
            if (isinstance(e, dict) and set(e) == {"h", "ts"}
                    and isinstance(e["h"], str)
                    and len(e["h"]) == 64
                    and type(e["ts"]) is int and e["ts"] >= 0
                    and (prev is None or e["ts"] > prev)):
                good.append({"h": e["h"], "ts": e["ts"]})
                prev = e["ts"]
            else:
                dropped += 1
        clean[src] = good
    return clean, dropped


def _feature_lineage_id(feat):
    lineage = {"kind": feat["kind"], "symbols": feat["symbols"],
               "value": feat["value"], "effect": feat["effect"],
               "canonical_hash": feat["canonical_hash"],
               "observed_at_ns": feat["observed_at_ns"]}
    # Full digest identity (see schema.make_bundle_id): 64-bit
    # truncation is unfit for security-sensitive dedupe.
    return "f-" + hashlib.sha256(
        schema.canon(lineage)).hexdigest()


def resolve_emit(deps, state):
    outdir = deps["outdir"]
    mapinfo, map_err = _load_map(deps["map_path"])
    if mapinfo is None:
        return {"emitted": None, "empty": True, "aborted": False,
                "map_error": map_err, "dropped_resolve": 0}
    map_sha, entity_map = mapinfo
    history, history_dropped = _validate_history(state.get("history"))
    resolved = []
    dropped = history_dropped
    for cand in state.get("fused", []):
        if not isinstance(cand, dict):
            dropped += 1
            continue
        canon = deps["canonical_for"](cand)
        if canon is None:
            dropped += 1
            continue
        # Origin is graph-stamped (worker output is overwritten to
        # "llm" at production time); the candidate's own llm_touched
        # field, if any, is IGNORED here and inside the resolver.
        origin = cand.get("origin", "llm")
        if origin not in ("parser", "llm"):
            dropped += 1
            continue
        ok, out = resolver.resolve(cand, canon, entity_map,
                                   origin=origin)
        if not ok:
            dropped += 1
            continue
        feat, _capped = out
        # No side-channel: R12 capping is already encoded as
        # evidence=inference by the resolver (no published ts can never
        # be mechanically identical). Nothing extra enters the bundle.
        # Frozen downstream symbol cap, enforced at the producer: a
        # 17-symbol valid feature must never ship to a 16-symbol reader.
        if len(feat["symbols"]) > EMIT_MAX_SYMBOLS:
            dropped += 1
            continue
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
    feature_srcs = {f["source_id"] for f in clean}
    history_srcs = set(history) if history else set()
    ok_wm, clean_wm, uncovered = _validate_watermarks(
        deps["source_watermarks"](state), feature_srcs, history_srcs)
    if not ok_wm:
        return {"emitted": None, "empty": True, "aborted": False,
                "watermark_error": uncovered, "dropped_resolve": dropped,
                "dropped_over_cap": 0}
    if uncovered:
        # Drop features/history of uncovered sources, count them, emit
        # the covered rest (graceful + safe; coverage failure never
        # ships).
        before = len(clean)
        clean = [f for f in clean if f["source_id"] not in uncovered]
        dropped += before - len(clean)
        history = {s: v for s, v in (history or {}).items()
                   if s not in uncovered}
        dropped += len(history_srcs & uncovered)
        if not clean:
            return {"emitted": None, "empty": True, "aborted": False,
                    "watermark_uncovered": sorted(uncovered),
                    "dropped_resolve": dropped, "dropped_over_cap": 0}
    wm = {"entity_map_version": entity_map["map_version"],
          "entity_map_sha256": map_sha,
          "sources": clean_wm}
    bid, path = emit_mod.emit_bundle(outdir, state["epoch"], clean, wm,
                                     history if history else None)
    return {"emitted": bid, "bundle_path": path, "empty": False,
            "aborted": False, "dropped_resolve": dropped + dupes,
            "dropped_over_cap": over_cap}
