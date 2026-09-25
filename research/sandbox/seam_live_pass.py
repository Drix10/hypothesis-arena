"""Live production-seam pass (Track A operational evidence).

Runs ONE harvest through the real production seam (build_seam with
live transports, real pacing, real credentials from root .env via
collector.config) for ["AAPL", "SPY"], persists canonical lineage
into a scratch DB, resolves via the frozen resolver path, emits one
bundle, and reads it with frozen ctx_read. Proves on live data:
outage-is-absence (BLS contributes nothing, nothing blocks), and
live records flow end-to-end through the ACCEPTED path.

Usage: python3 research/sandbox/seam_live_pass.py [--out PATH]
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
    # Accounting invariants asserted in-script (exit 1 on any
    # violation): the evidence script checks, not just dumps.
    import sqlite3 as _sq
    ok = True

    def check(cond, msg):
        nonlocal ok
        if not cond:
            ok = False
            ev.setdefault("violations", []).append(msg)
            print("VIOLATION: %s" % msg)

    check(len(fused) > 0, "no fused candidates from live harvest")
    check(out.get("emitted"),
          "no emitted bundle despite fused candidates")
    check(isinstance(bpath, str) and os.path.isfile(bpath),
          "emitted bundle path missing")
    if isinstance(bpath, str) and os.path.isfile(bpath):
        with open(bpath, encoding="utf-8") as fh:
            env = json.load(fh)
        feats = env.get("features", [])
        # Committed: manifest row present for the emitted id.
        man_path = os.path.join(outdir, "manifest.jsonl")
        try:
            with open(man_path, encoding="utf-8") as fh:
                committed = any(
                    json.loads(line).get("bundle_id") ==
                    out.get("emitted") for line in fh
                    if line.strip())
        except (OSError, ValueError):
            committed = False
        check(committed, "emitted bundle not manifest-committed")
        # Contractual 64-feature cap.
        check(len(feats) <= 64,
              "bundle over 64-feature cap: %d" % len(feats))
        if len(fused) > 64:
            check(len(feats) == 64,
                  "cap not applied: fused=%d feats=%d"
                  % (len(fused), len(feats)))
        # accepted + rejected reconciles with bundle features.
        st = res["stats"]
        check(st["accepted"] + st["rejected"] == len(feats),
              "ctx accounting: %d+%d != %d feats"
              % (st["accepted"], st["rejected"], len(feats)))
        # BLS outage contributes zero accepted features while other
        # sources remain usable.
        check(all(f.get("source_id") != "bls_empsit"
                  for f in feats),
              "outage source contributed features")
        check(any(f.get("source_id") != "bls_empsit"
                  for f in feats),
              "no usable-source features")
        # Every emitted hash resolves against the frozen authority.
        con = _sq.connect(lineage_db)
        try:
            for f in feats:
                row = con.execute(
                    "SELECT source, raw_json FROM records WHERE "
                    "content_hash=?",
                    (f["canonical_hash"],)).fetchone()
                check(row is not None,
                      "hash without authority row: %s"
                      % f["canonical_hash"][:12])
                if row is not None:
                    from collector import classify as _clf
                    check(row[0] == f["source_id"],
                          "authority wrong source")
                    try:
                        parsed = json.loads(row[1])
                    except ValueError:
                        parsed = None
                    check(parsed is not None and
                          _clf.content_hash(parsed) ==
                          f["canonical_hash"],
                          "authority hash mismatch")
        finally:
            con.close()
    ev["ok"] = bool(ok)
    print("harvest_ms=%s records=%d fused=%d emitted=%s ctx=%s" % (
        harvest_ms, len(recs), len(fused), out.get("emitted"),
        res["stats"]))
    out_path = out_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "seam-live-pass-%d.json" % ev["ts"])
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(ev, indent=2, sort_keys=True))
    print("wrote %s" % out_path)
    print("live-pass invariants: ok=%s" % ev["ok"])
    return 0 if ev["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
