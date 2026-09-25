"""Live production-seam pass (Track A operational evidence).

Runs ONE harvest through the real production seam (build_seam with
live transports, real pacing, real credentials from root .env via
collector.config) for ["AAPL", "SPY"], persists canonical lineage
into a scratch DB, resolves via the frozen resolver path, emits one
bundle, and reads it with frozen ctx_read. Proves on live data:
outage-is-absence (BLS contributes nothing, nothing blocks), and
live records flow end-to-end through the ACCEPTED path.

Usage: python3 research-plane/sandbox/seam_live_pass.py [--out PATH]
Exit 0 always (evidence, not a gate). Secrets never printed.
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from collector import config as cfg_mod
from collector import ctx_read
from plane import publish, schema
from plane import source_seam

MAP_PATH = os.path.join(ROOT, "..", "collector", "entity_map.json")


def main(argv):
    out_path = None
    for i, a in enumerate(argv):
        if a == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]
    cfg = cfg_mod.load()
    if cfg["status"] != "CONFIG_OK":
        print("config not ok: %s" % (cfg["missing_required"],))
        return 1
    env = cfg["values"]
    tmp = tempfile.mkdtemp(prefix="seamlive-")
    lineage_db = os.path.join(tmp, "lineage.db")
    hbdir = os.path.join(tmp, "hb")
    seam = source_seam.build_seam(env=env, heartbeat_dir=hbdir,
                                  lineage_db_path=lineage_db)
    t0 = time.monotonic()
    recs, stamps, hist = seam.harvest(["AAPL", "SPY"], 3)
    harvest_ms = round((time.monotonic() - t0) * 1000.0, 1)
    with open(MAP_PATH, encoding="utf-8") as fh:
        emap = json.load(fh)
    # Production publisher path (same binding the Runner uses):
    # fused parser candidates -> real resolve_emit (64-feature cap,
    # watermark coverage) -> emitted bundle -> frozen reader.
    fused = []
    for r in recs:
        h = r.get("canonical_hash")
        canon = seam.store.canonical_for({"canonical_hash": h}) \
            if isinstance(h, str) else None
        if canon is None:
            continue
        cand = {"kind": canon["kind"],
                "value": dict(canon["value"]),
                "symbols": list(canon["symbols"]),
                "effect": canon["effect"],
                "canonical_hash": canon["content_hash"],
                "origin": "parser"}
        if canon.get("entity_ref") is not None:
            cand["entity_ref"] = dict(canon["entity_ref"])
        if canon.get("provenance_url"):
            cand["provenance_url"] = canon["provenance_url"]
        fused.append(cand)
    outdir = os.path.join(tmp, "out")
    out = publish.resolve_emit(
        {"outdir": outdir, "map_path": MAP_PATH,
         "canonical_for": seam.store.canonical_for,
         "source_watermarks": seam.watermarks},
        {"epoch": 3, "fused": fused, "history": hist})
    bpath = out.get("bundle_path")
    res = ctx_read.read_bundle(bpath, lineage_db, MAP_PATH,
                               now_ts=time.time()) \
        if isinstance(bpath, str) and os.path.isfile(bpath) \
        else {"stats": {"accepted": 0, "rejected": 0,
                          "reasons": {"no-bundle": 1}},
                "note": "emit-empty-or-aborted"}
    ev = {"ts": int(time.time()), "harvest_ms": harvest_ms,
          "records": len(recs), "fused": len(fused),
          "emitted": out.get("emitted"), "empty": out.get("empty"),
          "stamps": {s: {"ok": bool(st.get("ok", False)),
                           "stale": bool(st.get("stale", True)),
                           "records": int(st.get("records", 0)),
                           "errors": [str(e) for e in
                                        st.get("errors", [])][:3]}
                      for s, st in stamps.items()},
          "ctx_stats": res["stats"]}
    print("harvest_ms=%s records=%d fused=%d emitted=%s ctx=%s" % (
        harvest_ms, len(recs), len(fused), out.get("emitted"),
        res["stats"]))
    out_path = out_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "seam-live-pass-%d.json" % ev["ts"])
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(ev, indent=2, sort_keys=True))
    print("wrote %s" % out_path)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
