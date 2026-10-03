"""Production resolve+emit step (doc 08 sec. 8.5, stdlib only).

The graph's emit node calls this (injected as deps["resolve_emit"]).
Each fused advisory candidate is resolved against its canonical record
(deps["canonical_for"](candidate) -> record dict or None; no record
drops and counts the candidate). One committed bundle is emitted when
at least one feature resolved; otherwise nothing is published
(empty=True) and the last complete bundle stands, as after an R15 abort.
state["history"] (bounded dated per-source tails) passes to the bundle.

Map identity (finding 22): deps supply map_path. The file bytes are read
(bounded), hashed for the watermark, parsed (duplicate keys rejected) and
that parsed map goes to the resolver, so watermark and resolver always
use the same map. A corrupt map fails the whole emit closed.

Reader cap (finding 19): the frozen reader accepts at most 64 features.
Features are ordered by (source_id, kind, canonical_hash); the first 64
are emitted and the rest counted as dropped_over_cap.

Feature identity (finding 20): feature_id is assigned here from trusted
lineage (sha256 of kind+symbols+value+effect+canonical_hash+observed_ns),
never from candidate output. Identical lineage collapses to one feature
(first wins, duplicates counted).
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
# producer-side input bounds; resolve_emit validates its own inputs
WM_SOURCES_MAX = 64
WM_KEY_MAX = 256
HISTORY_SOURCES_MAX = 16
HISTORY_SOURCE_KEY_MAX = 128
HISTORY_ENTRIES_MAX = 256
CANDIDATE_BYTES_MAX = 16384
# the pinned map is small and exact; larger or misshapen input is rejected
MAP_MAX_CIK = 20000
MAP_MAX_MACRO_KEYS = 20000
MAP_MAX_MACRO_SYMS = 512
MAP_VERSION_MAX = 64
TICKER_RE = re.compile(r"[A-Z][A-Z0-9.\-]{0,15}")
CIK_RE = re.compile(r"[0-9]{1,10}")
MAP_ALLOWED_KEYS = {"map_version", "cik_to_ticker",
                    "macro_release_to_symbols", "note"}


def _load_map(map_path):
    """Read map file bytes (max 1MB, duplicate keys rejected). Returns
    (sha256, parsed) or (None, reason)."""
    try:
        with open(map_path, "rb") as fh:
            raw = fh.read((1 << 20) + 1)
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
    """Returns (ok, clean, uncovered). ok=False fails the emit (invalid
    envelope); uncovered is the participating sources with no valid
    watermark, whose features are dropped."""
    if not isinstance(sources, dict):
        return False, {}, "watermark-shape"
    if len(sources) > WM_SOURCES_MAX:
        return False, {}, "watermark-too-many"
    clean = {}
    for sid, w in sources.items():
        if (not isinstance(sid, str) or not sid or
                len(sid) > WM_KEY_MAX):
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
    """Returns (clean_or_None, dropped, ok). Malformed top-level history
    (not a dict, too many sources) gives ok=False and nothing publishes;
    malformed tails in a well-formed mapping are dropped and counted."""
    if history is None:
        return None, 0, True
    if not isinstance(history, dict):
        return None, 0, False
    if len(history) > HISTORY_SOURCES_MAX:
        return None, 0, False
    clean = {}
    dropped = 0
    for src, entries in history.items():
        if (not isinstance(src, str) or not src or
                len(src) > HISTORY_SOURCE_KEY_MAX or
                not isinstance(entries, list) or
                len(entries) > HISTORY_ENTRIES_MAX):
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
    return clean, dropped, True


def _feature_lineage_id(feat):
    lineage = {"kind": feat["kind"], "symbols": feat["symbols"],
               "value": feat["value"], "effect": feat["effect"],
               "canonical_hash": feat["canonical_hash"],
               "observed_at_ns": feat["observed_at_ns"]}
    # full digest, not truncated (see schema.make_bundle_id)
    return "f-" + hashlib.sha256(
        schema.canon(lineage)).hexdigest()


def _closed(reason, **extra):
    """Resolve outcome where nothing publishes."""
    out = {"emitted": None, "empty": True, "aborted": False,
           "resolve_error": reason, "dropped_resolve": 0,
           "dropped_over_cap": 0}
    out.update(extra)
    return out


def resolve_emit(deps, state):
    if not isinstance(deps, dict) or not isinstance(state, dict):
        return _closed("resolve-shape")
    outdir = deps.get("outdir")
    if not isinstance(outdir, str) or not outdir:
        return _closed("resolve-outdir")
    if not isinstance(deps.get("map_path"), str):
        return _closed("resolve-map-path")
    for key in ("canonical_for", "source_watermarks"):
        if not callable(deps.get(key)):
            return _closed("resolve-%s" % key.replace("_", "-"))
    epoch = state.get("epoch")
    if type(epoch) is not int or isinstance(epoch, bool) or \
            not 0 <= epoch <= 2 ** 31 - 1:
        return _closed("resolve-epoch")
    if "fused" not in state:
        return _closed("fused-shape")
    fused = state.get("fused")
    if not isinstance(fused, list):
        return _closed("fused-shape")
    history, history_dropped, history_ok = _validate_history(
        state.get("history"))
    if not history_ok:
        return _closed("history-shape")
    mapinfo, map_err = _load_map(deps["map_path"])
    if mapinfo is None:
        return _closed("map", map_error=map_err)
    map_sha, entity_map = mapinfo
    resolved = []
    dropped = history_dropped
    for cand in fused:
        if not isinstance(cand, dict):
            dropped += 1
            continue
        # bound candidates on direct calls
        ok_c, _why = schema.json_safe(cand)
        if not ok_c:
            dropped += 1
            continue
        try:
            oversize = len(schema.canon(cand)) > CANDIDATE_BYTES_MAX
        except (TypeError, ValueError):
            oversize = True
        if oversize:
            dropped += 1
            continue
        try:
            canon = deps["canonical_for"](cand)
        except Exception:
            dropped += 1
            continue
        if canon is None:
            dropped += 1
            continue
        # origin is graph-stamped (worker output is overwritten to "llm");
        # a candidate's llm_touched field is ignored here and in the resolver
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
        # R12 capping is already encoded as evidence=inference by the resolver.
        # Enforce the reader's symbol cap here: 17 symbols must not ship.
        if len(feat["symbols"]) > EMIT_MAX_SYMBOLS:
            dropped += 1
            continue
        feat["feature_id"] = _feature_lineage_id(feat)
        resolved.append(feat)
    # deterministic order, dedupe, 64-feature cap
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
    try:
        wm_sources = deps["source_watermarks"](state)
    except Exception:
        return _closed("watermark-callback", watermark_error=True,
                        dropped_resolve=dropped)
    ok_wm, clean_wm, uncovered = _validate_watermarks(
        wm_sources, feature_srcs, history_srcs)
    if not ok_wm:
        return _closed("watermark", watermark_error=uncovered,
                        dropped_resolve=dropped)
    if uncovered:
        # drop and count features/history of uncovered sources, emit the rest
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
    bid, path = emit_mod.emit_bundle(outdir, epoch, clean, wm,
                                     history if history else None)
    return {"emitted": bid, "bundle_path": path, "empty": False,
            "aborted": False, "dropped_resolve": dropped + dupes,
            "dropped_over_cap": over_cap}
