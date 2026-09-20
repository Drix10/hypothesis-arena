#!/usr/bin/env python3
'''P1.5 stub ctx reader: validates section 8.5 bundles, enforces every boundary.
Stdlib only, read-only (canonical.db opened read-only; P1.4 evidence never
written). Rejects incomplete bundles wholesale; per-feature rejects are
counted with reasons. Prose is quarantined, never consumed.

Usage: python3 collector/ctx_read.py <bundle.json> [--db PATH] [--map PATH]

Atomicity note (DESIGN FROZEN, IMPLEMENTATION DEFERRED to Phase 2.5): the
`commit is True` flag checked here is the bundle-INTERNAL completeness flag.
The writer-side generation manifest (a separate manifest proving a complete
committed publish, consumed by the reader) does not exist yet and is NOT
enforced: do not describe this reader as manifest-backed until Phase 2.5
implements the manifest mechanism.
'''
import hashlib
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA = "f2"
RULES = "plausibility_v1"
FROZEN_N = 3
KINDS = {"filing_event", "macro_release", "calendar_ahead", "osint_event",
         "sentiment_tail", "regime_hint"}
EFFECTS = {"bullish", "bearish", "risk_up", "risk_down", "neutral", "unknown"}
EVIDENCE = {"source", "derived", "inference"}
CONF = {"low", "medium", "high"}
VTYPES = {"enum", "bucket", "bool", "count"}
OVERNIGHT_ALLOW = {"calendar_ahead", "macro_release"}
REQUIRED_FIELDS = {"schema_version", "kind", "symbols", "value", "effect",
                   "evidence", "confidence_bucket", "source_id",
                   "canonical_hash", "observed_at_ns", "ttl_s"}
OPTIONAL_FIELDS = {"feature_id", "canonical_hashes", "entity_ref",
                   "ingested_at_ns", "provenance_url"}
HEX64 = re.compile("^[0-9a-f]{64}$")
SOURCE_COVER_MIN = {"edgar_8k": 45, "fed_monetary": 180, "ecb_mid": 180,
                      "treasury_auctions": 1080, "bls_empsit": 1080,
                      "fred_macro": 1080}
SOURCE_IDS = frozenset(SOURCE_COVER_MIN)  # frozen source namespace (X11)
# Frozen source->kind emission registry: which kinds each source may emit.
# Directional/osint/sentiment/regime kinds have NO frozen emitter: they need
# the Phase 2.5 deterministic source->feature resolver, so they are rejected
# here (kind-no-emitter), never admitted on structural validity alone.
SOURCE_KINDS = {
    "edgar_8k": {"filing_event"},
    "fed_monetary": {"macro_release", "calendar_ahead"},
    "treasury_auctions": {"macro_release", "calendar_ahead"},
    "bls_empsit": {"macro_release", "calendar_ahead"},
    "ecb_mid": {"macro_release", "calendar_ahead"},
    "fred_macro": {"macro_release", "calendar_ahead"},
}
BUNDLE_REQUIRED = {"schema_version", "research_epoch", "bundle_id",
                   "commit", "watermarks", "features"}
BUNDLE_OPTIONAL = {"history"}
BUNDLE_SCHEMA = "f2"
TTL_MAX_S = 7 * 86400  # emitters never grant freshness beyond this (X4)
MAX_FEATURES = 64  # plan cap, now enforced (X3)
MAX_HASHES = 16  # rows contributing to one derived feature (X9)
MAX_BUNDLE_BYTES = 1024 * 1024  # raw cap before parse (X1)
MAX_DEPTH = 16
MAX_NODES = 20000
MAX_STR = 4096
INT64_MIN, INT64_MAX = -(2 ** 63), 2 ** 63 - 1
NY = ZoneInfo("America/New_York")
EQUITY_SESSION = (9 * 60 + 30, 16 * 60)
PROSE_KEYS = {"thesis_text", "critique_text", "narrative", "summary",
              "thesis", "critique", "commentary", "analysis_text"}

HB_MAP = {"ok": "healthy", "EMPTY_SUCCESS": "healthy", "STALE": "stale",
          "SOURCE_DOWN": "failed", "AUTH_FAILURE": "failed",
          "RATE_LIMITED": "failed", "PARSE_FAILURE": "failed",
          "SKIPPED_CONFIG": "not_scheduled"}


class _DupKey(ValueError):
    pass


def _no_dupes(pairs):
    """object_pairs_hook rejecting duplicate JSON members. P3.1 rejects
    duplicate members at the crypto boundary; the provenance boundary must
    too — last-write-wins on source_id would silently rebind lineage."""
    obj = {}
    for k, v in pairs:
        if k in obj:
            raise _DupKey(k)
        obj[k] = v
    return obj


def parse_strict(raw):
    """json.loads with duplicate-key rejection. Raises _DupKey."""
    return json.loads(raw, object_pairs_hook=_no_dupes)


def combine_hashes(hashes):
    return hashlib.sha256("‖".join(sorted(hashes)).encode()).hexdigest()


def measure(obj, depth=0):
    """Structural pre-pass: (nodes, maxstr) or None when over bounds.
    Runs BEFORE any semantic walk (incl. prose scan) so hostile shapes
    fail on size, never on recursion or work."""
    if depth > MAX_DEPTH:
        return None
    if isinstance(obj, dict):
        total, ms = 1, 0
        for k, v in obj.items():
            if not isinstance(k, str) or len(k) > MAX_STR:
                return None
            r = measure(v, depth + 1)
            if r is None:
                return None
            total += r[0]
            ms = max(ms, len(k), r[1])
            if total > MAX_NODES or ms > MAX_STR:
                return None
        return total, ms
    if isinstance(obj, (list, tuple)):
        total, ms = 1, 0
        for v in obj:
            r = measure(v, depth + 1)
            if r is None:
                return None
            total += r[0]
            ms = max(ms, r[1])
            if total > MAX_NODES or ms > MAX_STR:
                return None
        return total, ms
    if isinstance(obj, str):
        return (1, len(obj)) if len(obj) <= MAX_STR else None
    return 1, 0


def has_prose(obj):
    # Only called after measure() bounds the shape (see read_bundle).
    if isinstance(obj, dict):
        return (any(k in PROSE_KEYS for k in obj)
                or any(has_prose(v) for v in obj.values()))
    if isinstance(obj, list):
        return any(has_prose(v) for v in obj)
    return False


def check_feature(f, con, emap, history, now_ts):
    '''Returns (ok, reason). First failure wins, counted by caller.'''
    if has_prose(f):
        return False, "prose-quarantined"
    unknown = set(f) - REQUIRED_FIELDS - OPTIONAL_FIELDS
    if unknown:
        return False, "unknown-field:" + sorted(unknown)[0]
    missing = REQUIRED_FIELDS - set(f)
    if missing:
        return False, "schema-missing:" + sorted(missing)[0]
    if f["schema_version"] != SCHEMA:
        return False, "schema-version"
    if not isinstance(f["source_id"], str) or f["source_id"] not in SOURCE_IDS:
        return False, "source-unknown"
    for _k in ("schema_version", "kind", "effect", "evidence",
               "confidence_bucket", "source_id"):
        if not isinstance(f[_k], str):
            return False, "primitive-type:" + _k
    enums_ok = (f["kind"] in KINDS and f["effect"] in EFFECTS
                and f["evidence"] in EVIDENCE and f["confidence_bucket"] in CONF)
    if not enums_ok:
        return False, "schema-enum"
    if f["kind"] not in SOURCE_KINDS.get(f["source_id"], ()):
        return False, "kind-no-emitter"
    if not isinstance(f["value"], dict):
        return False, "schema-value"
    if not isinstance(f["value"].get("type"), str):
        return False, "value-shape"
    if f["value"]["type"] not in VTYPES:
        return False, "schema-value"
    v = f["value"]
    vtype_shapes = {"enum": str, "bucket": str, "bool": bool, "count": int}
    if set(v) != {"type", "v"}:
        return False, "value-shape"
    if not isinstance(v["type"], str) or v["type"] not in VTYPES:
        return False, "value-shape"
    if "v" not in v or type(v["v"]) is not vtype_shapes[v["type"]]:
        return False, "value-shape"
    if v["type"] == "count" and v["v"] < 0:
        return False, "value-shape"
    if not isinstance(f["symbols"], list) or not f["symbols"]:
        return False, "symbols-type"
    if any(not isinstance(s, str) or not s for s in f["symbols"]):
        return False, "symbols-type"
    if type(f["observed_at_ns"]) is not int:
        return False, "observed-type"
    if not (0 <= f["observed_at_ns"] <= INT64_MAX):
        return False, "observed-range"
    if type(f["ttl_s"]) is not int or not (1 <= f["ttl_s"] <= TTL_MAX_S):
        return False, "ttl-type"
    if not isinstance(f["canonical_hash"], str):
        return False, "hash-format"
    if not HEX64.match(f["canonical_hash"]):
        return False, "hash-format"
    chs = f.get("canonical_hashes")
    if chs is not None:
        if not isinstance(chs, list) or not chs or len(chs) > MAX_HASHES:
            return False, "hash-format"
        if len(set(chs)) != len(chs):
            return False, "hash-format"
        if any(not isinstance(h, str) or not HEX64.match(h) for h in chs):
            return False, "hash-format"
    hs = chs or [f["canonical_hash"]]
    expect = hs[0] if len(hs) == 1 else combine_hashes(hs)
    if f["canonical_hash"] != expect:
        return False, "lineage-mismatch"
    for h in hs:
        # Lineage binds hash AND source: a row with this hash under the
        # feature's claimed source must exist (X10). Same bytes under a
        # different source do not satisfy this feature's lineage.
        row = con.execute(
            "SELECT 1 FROM records WHERE content_hash=? AND source=?",
            (h, f["source_id"])).fetchone()
        if not row:
            # Distinguish "hash unknown anywhere" from "wrong source".
            anyrow = con.execute(
                "SELECT 1 FROM records WHERE content_hash=?", (h,)).fetchone()
            return False, "lineage-unresolved" if not anyrow else "lineage-mismatch"
    obs = f["observed_at_ns"] / 1e9
    if obs > now_ts:
        return False, "future-timestamp"
    if now_ts - obs > f["ttl_s"]:
        return False, "ttl-expired"
    if "ingested_at_ns" in f:
        if type(f["ingested_at_ns"]) is not int:
            return False, "ingested-type"
        if not (0 <= f["ingested_at_ns"] <= INT64_MAX):
            return False, "ingested-range"
        if f["ingested_at_ns"] / 1e9 > now_ts:
            return False, "ingested-future"
    if "provenance_url" in f and not isinstance(f["provenance_url"], str):
        return False, "provenance-type"
    tickers = set(emap.get("cik_to_ticker", {}).values())
    macro = {x for v in emap.get("macro_release_to_symbols", {}).values()
             for x in v}
    for s in f["symbols"]:
        if s not in tickers and s not in macro and s not in ("USD", "RATES"):
            return False, "entity-unmapped:" + s
    if "entity_ref" in f:
        ref = f["entity_ref"]
        if not isinstance(ref, dict) or set(ref) != {"cik"}:
            return False, "entity-ref-shape"
        if type(ref["cik"]) is not str:
            return False, "entity-ref-shape"
        ref_cik = ref["cik"]
        want = emap.get("cik_to_ticker", {}).get(ref_cik)
        if want is None:
            return False, "entity-ref-unknown"
        if want not in f["symbols"]:
            return False, "entity-contradiction"
    if "feature_id" in f and (not isinstance(f["feature_id"], str) or
                               not f["feature_id"] or
                               len(f["feature_id"]) > 128):
        return False, "feature-id-shape"
    hist = (history or {}).get(f["source_id"], [])
    if hist and any(not isinstance(e, dict) or set(e) != {"h", "ts"}
                    or not isinstance(e["h"], str)
                    or not HEX64.match(e["h"])
                    or type(e["ts"]) is not int for e in hist):
        return False, "history-undated"
    if len(hist) >= FROZEN_N:
        tail = hist[-FROZEN_N:]
        same = len({e["h"] for e in tail}) == 1 and             tail[-1]["h"] == f["canonical_hash"]
        span = tail[-1]["ts"] - tail[0]["ts"]
        cover = SOURCE_COVER_MIN.get(f["source_id"], 60) * 60
        if same and span >= cover * 0.5:
            return False, "frozen-feed"
    # Asset class from the pinned entity map, never symbol spelling (X12):
    # equity = every symbol is a mapped equity ticker; macro/other otherwise.
    equity_like = f["symbols"] and all(s in tickers for s in f["symbols"])
    if equity_like:
        lt = datetime.fromtimestamp(obs, NY)
        mins = lt.hour * 60 + lt.minute
        in_session = EQUITY_SESSION[0] <= mins < EQUITY_SESSION[1]
        if not in_session and f["kind"] not in OVERNIGHT_ALLOW:
            return False, "session-reject"
    if f["evidence"] == "inference":
        return True, "inference-capped"
    return True, "ok"


def trigger_eligible(feature_result):
    """Downstream invariant: ctx-accepted inference is CONTEXT-only, never
    TRIGGER-eligible. Only evidence==source features may trigger."""
    return feature_result.get("evidence") == "source"


def read_bundle(path, db_path, map_path, now_ts=None):
    if now_ts is None:
        now_ts = datetime.now(timezone.utc).timestamp()
    try:
        size = os.path.getsize(path)
    except OSError:
        size = None
    if size is None or size > MAX_BUNDLE_BYTES:
        return {"bundle_id": None, "accepted": [],
                "stats": {"accepted": 0, "rejected": 1,
                            "reasons": {"bundle-too-large": 1}}}
    with open(path, encoding="utf-8") as fh:
        raw = fh.read(MAX_BUNDLE_BYTES + 1)
    if len(raw) > MAX_BUNDLE_BYTES:
        return {"bundle_id": None, "accepted": [],
                "stats": {"accepted": 0, "rejected": 1,
                            "reasons": {"bundle-too-large": 1}}}
    try:
        b = parse_strict(raw)
    except _DupKey:
        return {"bundle_id": None, "accepted": [],
                "stats": {"accepted": 0, "rejected": 1,
                            "reasons": {"bundle-duplicate-keys": 1}}}
    except ValueError:
        return {"bundle_id": None, "accepted": [],
                "stats": {"accepted": 0, "rejected": 1,
                            "reasons": {"bundle-unparseable": 1}}}
    stats = {"accepted": 0, "rejected": 0, "reasons": {}}
    if not isinstance(b, dict) or measure(b) is None:
        stats["reasons"]["bundle-shape"] = 1
        return {"bundle_id": None, "accepted": [], "stats": stats}
    # Strict bundle envelope: unknown top-level keys are smuggling surface.
    unknown_keys = set(b) - BUNDLE_REQUIRED - BUNDLE_OPTIONAL
    if unknown_keys:
        stats["reasons"]["bundle-unknown-field:" + sorted(unknown_keys)[0]] = 1
        _bid = b.get("bundle_id")
        return {"bundle_id": _bid if isinstance(_bid, str) else None,
                "accepted": [], "stats": stats}
    # Exact bundle envelope (X7/X8): schema, id, epoch, commit, features.
    if b.get("schema_version") != BUNDLE_SCHEMA:
        stats["reasons"]["bundle-schema"] = 1
        return {"bundle_id": b.get("bundle_id"), "accepted": [],
                "stats": stats}
    if not isinstance(b.get("bundle_id"), str) or not b["bundle_id"] or \
            len(b["bundle_id"]) > 256:
        stats["reasons"]["bundle-id"] = 1
        return {"bundle_id": None, "accepted": [], "stats": stats}
    if type(b.get("research_epoch")) is not int or b["research_epoch"] < 0:
        stats["reasons"]["research-epoch"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [],
                "stats": stats}
    if b.get("commit") is not True:
        stats["reasons"]["bundle-incomplete"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [],
                "stats": stats}
    feats = b.get("features")
    if not isinstance(feats, list) or not (1 <= len(feats) <= MAX_FEATURES):
        stats["reasons"]["bundle-features"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [],
                "stats": stats}
    hist = b.get("history")
    if hist is not None:
        if not isinstance(hist, dict):
            stats["reasons"]["history-shape"] = 1
            return {"bundle_id": b["bundle_id"], "accepted": [],
                    "stats": stats}
        for _src, _entries in hist.items():
            if not isinstance(_entries, list):
                stats["reasons"]["history-shape"] = 1
                return {"bundle_id": b["bundle_id"], "accepted": [],
                        "stats": stats}
            for _e in _entries:
                if not isinstance(_e, dict) or set(_e) != {"h", "ts"} \
                        or not isinstance(_e["h"], str) \
                        or not HEX64.match(_e["h"]) \
                        or type(_e["ts"]) is not int or _e["ts"] < 0:
                    stats["reasons"]["history-shape"] = 1
                    return {"bundle_id": b["bundle_id"], "accepted": [],
                            "stats": stats}
    # feature_id uniqueness: duplicates would corrupt feature_revision
    # (derived from IDs) without representing distinct evidence.
    _ids = [f["feature_id"] for f in feats
            if isinstance(f, dict) and isinstance(f.get("feature_id"), str)]
    if len(set(_ids)) != len(_ids):
        stats["reasons"]["bundle-duplicate-feature-id"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [],
                "stats": stats}
    wm = b.get("watermarks") or {}
    if not isinstance(wm, dict) or "entity_map_version" not in wm             or "entity_map_sha256" not in wm:
        stats["reasons"]["watermarks-missing"] = 1
        return {"bundle_id": b.get("bundle_id"), "accepted": [], "stats": stats}
    with open(map_path, "rb") as _mf:
        raw_map = _mf.read()
    if hashlib.sha256(raw_map).hexdigest() != wm["entity_map_sha256"]:
        stats["reasons"]["map-hash-mismatch"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [], "stats": stats}
    try:
        emap = parse_strict(raw_map.decode("utf-8"))
    except _DupKey:
        stats["reasons"]["map-duplicate-keys"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [],
                "stats": stats}
    except ValueError:
        stats["reasons"]["map-version-mismatch"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [],
                "stats": stats}
    if emap.get("map_version") != wm["entity_map_version"]:
        stats["reasons"]["map-version-mismatch"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [], "stats": stats}
    con = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
    out = []
    try:
        for f in b["features"]:
            if not isinstance(f, dict):
                stats["reasons"]["feature-shape"] = 1
                stats["rejected"] += 1
                continue
            ok, reason = check_feature(f, con, emap, b.get("history"), now_ts)
            stats["reasons"][reason] = stats["reasons"].get(reason, 0) + 1
            if ok:
                stats["accepted"] += 1
                out.append(f.get("feature_id", "?"))
            else:
                stats["rejected"] += 1
    finally:
        con.close()
    total = stats["accepted"] + stats["rejected"]
    stats["rejection_rate"] = stats["rejected"] / max(1, total)
    return {"bundle_id": b["bundle_id"], "accepted": out, "stats": stats}


def main():
    path = sys.argv[1]
    if "--db" in sys.argv:
        db = sys.argv[sys.argv.index("--db") + 1]
    else:
        db = os.path.join(os.path.dirname(HERE), "data", "canonical.db")
    if "--map" in sys.argv:
        mp = sys.argv[sys.argv.index("--map") + 1]
    else:
        mp = os.path.join(HERE, "entity_map.json")
    print(json.dumps(read_bundle(path, db, mp), indent=1))


if __name__ == "__main__":
    main()
