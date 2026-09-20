#!/usr/bin/env python3
'''P1.5 stub ctx reader: validates section 8.5 bundles, enforces every boundary.
Stdlib only, read-only (canonical.db opened read-only; P1.4 evidence never
written). Rejects incomplete bundles wholesale; per-feature rejects are
counted with reasons. Prose is quarantined, never consumed.

Usage: python3 collector/ctx_read.py <bundle.json> [--db PATH] [--map PATH]
'''
import hashlib
import json
import os
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
NY = ZoneInfo("America/New_York")
EQUITY_SESSION = (9 * 60 + 30, 16 * 60)
PROSE_KEYS = {"thesis_text", "critique_text", "narrative", "summary",
              "thesis", "critique", "commentary", "analysis_text"}

HB_MAP = {"ok": "healthy", "EMPTY_SUCCESS": "healthy", "STALE": "stale",
          "SOURCE_DOWN": "failed", "AUTH_FAILURE": "failed",
          "RATE_LIMITED": "failed", "PARSE_FAILURE": "failed",
          "SKIPPED_CONFIG": "not_scheduled"}


def combine_hashes(hashes):
    return hashlib.sha256("‖".join(sorted(hashes)).encode()).hexdigest()


def has_prose(obj):
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
    for k in ("schema_version", "kind", "symbols", "value", "effect",
              "evidence", "confidence_bucket", "source_id",
              "canonical_hash", "observed_at_ns", "ttl_s"):
        if k not in f:
            return False, "schema-missing:" + k
    if f["schema_version"] != SCHEMA:
        return False, "schema-version"
    enums_ok = (f["kind"] in KINDS and f["effect"] in EFFECTS
                and f["evidence"] in EVIDENCE and f["confidence_bucket"] in CONF)
    if not enums_ok:
        return False, "schema-enum"
    if not isinstance(f["value"], dict) or f["value"].get("type") not in VTYPES:
        return False, "schema-value"
    hs = f.get("canonical_hashes") or [f["canonical_hash"]]
    expect = hs[0] if len(hs) == 1 else combine_hashes(hs)
    if f["canonical_hash"] != expect:
        return False, "lineage-mismatch"
    for h in hs:
        row = con.execute(
            "SELECT 1 FROM records WHERE content_hash=?", (h,)).fetchone()
        if not row:
            return False, "lineage-unresolved"
    obs = f["observed_at_ns"] / 1e9
    if obs > now_ts:
        return False, "future-timestamp"
    if now_ts - obs > f["ttl_s"]:
        return False, "ttl-expired"
    tickers = set(emap.get("cik_to_ticker", {}).values())
    macro = {x for v in emap.get("macro_release_to_symbols", {}).values()
             for x in v}
    for s in f["symbols"]:
        if s not in tickers and s not in macro and s not in ("USD", "RATES"):
            return False, "entity-unmapped:" + s
    hist = (history or {}).get(f["source_id"], [])
    frozen = (len(hist) >= FROZEN_N and len(set(hist[-FROZEN_N:])) == 1
              and hist[-1] == f["canonical_hash"])
    if frozen:
        return False, "frozen-feed"
    equity_like = f["symbols"] and all(
        "/" not in s and s.isalpha() and len(s) <= 5 for s in f["symbols"])
    if equity_like:
        lt = datetime.fromtimestamp(obs, NY)
        mins = lt.hour * 60 + lt.minute
        in_session = EQUITY_SESSION[0] <= mins < EQUITY_SESSION[1]
        if not in_session and f["kind"] not in OVERNIGHT_ALLOW:
            return False, "session-reject"
    if f["evidence"] == "inference":
        return True, "inference-capped"
    return True, "ok"


def read_bundle(path, db_path, map_path, now_ts=None):
    if now_ts is None:
        now_ts = datetime.now(timezone.utc).timestamp()
    b = json.load(open(path, encoding="utf-8"))
    stats = {"accepted": 0, "rejected": 0, "reasons": {}}
    complete = b.get("commit") and b.get("bundle_id") and isinstance(
        b.get("features"), list)
    if not complete:
        stats["rejected"] += len(b.get("features", [])) or 1
        stats["reasons"]["bundle-incomplete"] = stats["rejected"]
        return {"bundle_id": b.get("bundle_id"), "accepted": [],
                "stats": stats}
    emap = json.load(open(map_path, encoding="utf-8"))
    if emap.get("map_version") != (b.get("entity_map_version") or "entity-v1"):
        stats["reasons"]["map-version-mismatch"] = 1
        return {"bundle_id": b["bundle_id"], "accepted": [], "stats": stats}
    con = sqlite3.connect("file:" + db_path + "?mode=ro", uri=True)
    out = []
    try:
        for f in b["features"]:
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
