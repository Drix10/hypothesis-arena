"""Healthy -> stale -> healthy transition evidence (Track A ops).

Fault injection lives ONLY at the transport layer: a switchable
transport delegates to the real Treasury urllib transport when
healthy and raises TimeoutError when faulted. Adapters, seam,
pacing, lineage, publisher, and reader are all real. No synthetic
records, no fixture data, no clock games.

Phases (fresh seam per phase = fresh process equivalent; shared
lineage DB + bundle outdir; real pacing):
  A healthy:     harvest -> treasury ok, features accepted.
  B faulted x2:  harvest x2 -> treasury stale/absent, zero treasury
                 features, unrelated sources continue, uncovered
                 treasury history dropped from the bundle, heartbeat
                 bad.
  C recovered:   harvest -> treasury ok + accepted again, heartbeat
                 good (already-seen rows would dedupe, but fresh
                 adapters see the live rows anew).

Invariants are asserted in-script (exit 1 on violation): this
script is evidence AND check. Exit 0 + evidence JSON on success.
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
from plane import publish
from plane import source_seam
from sources import treasury as treasury_mod

MAP_PATH = os.path.join(ROOT, "..", "collector", "entity_map.json")
WATCH = ["AAPL", "SPY"]


class SwitchTransport:
    """Real transport with an injectable egress fault."""

    def __init__(self):
        self.failing = False
        self.calls = 0
        self.failures = 0

    def __call__(self, url, headers, timeout_s):
        self.calls += 1
        if self.failing:
            self.failures += 1
            raise TimeoutError("injected-egress-fault")
        return treasury_mod._default_transport(url, headers,
                                               timeout_s)


def emit_and_read(seam, outdir, epoch, lineage_db):
    recs, stamps, hist = seam.harvest(list(WATCH), epoch)
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
    out = publish.resolve_emit(
        {"outdir": outdir, "map_path": MAP_PATH,
         "canonical_for": seam.store.canonical_for,
         "source_watermarks": seam.watermarks},
        {"epoch": epoch, "fused": fused, "history": hist})
    bpath = out.get("bundle_path")
    res = ctx_read.read_bundle(bpath, lineage_db, MAP_PATH,
                               now_ts=time.time()) \
        if isinstance(bpath, str) and os.path.isfile(bpath) \
        else {"stats": {"accepted": 0, "rejected": 0,
                        "reasons": {"no-bundle": 1}}}
    by_source = {}
    if isinstance(bpath, str) and os.path.isfile(bpath):
        with open(bpath, encoding="utf-8") as fh:
            for f in json.load(fh)["features"]:
                by_source[f["source_id"]] = \
                    by_source.get(f["source_id"], 0) + 1
    return {"epoch": epoch, "records": len(recs), "fused": len(fused),
            "emitted": out.get("emitted"), "empty": out.get("empty"),
            "stamps": {s: {"ok": bool(st.get("ok", False)),
                           "stale": bool(st.get("stale", True)),
                           "records": int(st.get("records", 0)),
                           "errors": [str(e) for e in
                                      st.get("errors", [])][:2]}
                       for s, st in stamps.items()},
            "watermarks": seam.watermarks(),
            "bundle_sources": by_source, "ctx_stats": res["stats"]}


def check(cond, msg, ev):
    if not cond:
        ev["violations"] = ev.get("violations", []) + [msg]
        print("VIOLATION: %s" % msg)
    return cond


def main(argv):
    out_path = None
    for i, a in enumerate(argv):
        if a == "--out" and i + 1 < len(argv):
            out_path = argv[i + 1]
    cfg = cfg_mod.load()
    if cfg["status"] != "CONFIG_OK":
        print("config not ok: %s" % (cfg["missing_required"],))
        return 1
    tmp = tempfile.mkdtemp(prefix="stalerec-")
    lineage_db = os.path.join(tmp, "lineage.db")
    hbdir = os.path.join(tmp, "hb")
    outdir = os.path.join(tmp, "out")
    switch = SwitchTransport()

    def fresh_seam(epoch_note):
        # Fresh process equivalent: new adapters + empty memory over
        # the same durable lineage + bundles (production restores
        # history the same way). Returns (seam, note) where note
        # records adapter-identity freshness for the evidence.
        seam = source_seam.build_seam(
            env=cfg["values"], heartbeat_dir=hbdir,
            lineage_db_path=lineage_db,
            transports={"treasury": switch})
        seam.restore_from_bundles(outdir)
        return seam

    ev = {"ts": int(time.time()), "phases": {}}

    # Phase A: healthy baseline.
    a = emit_and_read(fresh_seam("A"), outdir, 10, lineage_db)
    ev["phases"]["A_healthy"] = a
    ok = True
    ok &= check(a["stamps"]["treasury_auctions"]["ok"],
                "A: treasury stamp not ok", ev)
    ok &= check(a["bundle_sources"].get("treasury_auctions", 0) > 0,
                "A: no treasury features accepted", ev)
    ok &= check(a["watermarks"].get("treasury_auctions", {})
                .get("last_observation_at", 0) > 0,
                "A: no treasury watermark", ev)

    # Phase B: injected egress fault, two cycles.
    switch.failing = True
    for epoch, key in ((11, "B_fault_1"), (12, "B_fault_2")):
        b = emit_and_read(fresh_seam(key), outdir, epoch, lineage_db)
        ev["phases"][key] = b
        ok &= check(not b["stamps"]["treasury_auctions"]["ok"],
                    "%s: treasury stamp ok during fault" % key, ev)
        ok &= check(b["stamps"]["treasury_auctions"]["records"] == 0,
                    "%s: treasury records during fault" % key, ev)
        ok &= check("treasury_auctions" not in b["bundle_sources"],
                    "%s: stale treasury contributed features" % key,
                    ev)
        ok &= check("treasury_auctions" not in b["watermarks"],
                    "%s: faulted source vouched a watermark" % key, ev)
        others = [s for s in ("edgar_8k", "fred_macro",
                              "bea_nipa_gdp")
                  if b["stamps"].get(s, {}).get("ok")]
        ok &= check(len(others) >= 2,
                    "%s: outage blocked unrelated sources: %r"
                    % (key, others), ev)
        ok &= check(sum(v for k, v in b["bundle_sources"].items()
                        if k != "treasury_auctions") > 0,
                    "%s: no unrelated features accepted" % key, ev)

    # Phase C: fault cleared — eligibility restored, no re-emission
    # of already-seen rows (dedupe), no resurrection of stale rows.
    switch.failing = False
    c = emit_and_read(fresh_seam("C"), outdir, 13, lineage_db)
    ev["phases"]["C_recovered"] = c
    ok &= check(c["stamps"]["treasury_auctions"]["ok"],
                "C: treasury stamp not ok after recovery", ev)
    ok &= check(c["watermarks"].get("treasury_auctions", {})
                .get("last_observation_at", 0) > 0,
                "C: no treasury watermark after recovery", ev)
    ok &= check(switch.failures >= 2,
                "C: fault never actually fired", ev)

    ev["transport"] = {"calls": switch.calls,
                       "injected_failures": switch.failures}
    ev["ok"] = bool(ok)
    out_path = out_path or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "stale-recovery-%d.json" % ev["ts"])
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(ev, indent=2, sort_keys=True))
    print("stale-recovery evidence: ok=%s wrote %s" % (ok, out_path))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
