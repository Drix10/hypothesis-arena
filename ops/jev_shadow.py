"""JEV shadow mode: asks JEV about each paper candidate and only LOGS what
the filter would have done. It never blocks, sizes or orders anything.

    python3 ops/jev_shadow.py <loop_dir>          # one pass, then exit

Reads  <loop_dir>/candidates.jsonl   (append-only, written by the emitter)
Writes <loop_dir>/jev_shadow.jsonl   (one row per candidate)
       <loop_dir>/jev_shadow.offset  (byte offset already processed)
It does not touch the journal, candidates, approved.json or STAGE. Provider
calls go through collector.jev.decide, so the spend governor, cache and
signing apply unchanged; the signed answer is then run through the same
filter the kernel would use. No key means a logged HOLD row, never a guess.

Market fields the emitter does not have (spread, session, regime) are
recorded as "unknown" rather than invented; calibration is "insufficient",
so nothing is ever elevated."""
import json
import os
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from collector import jev
from research.strategy import jev_filter

SHADOW = "jev_shadow.jsonl"
OFFSET = "jev_shadow.offset"
STAGE = "G0_PAPER"
ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "insufficient", "veto_max": False}


def build_state(cand):
    market = {"snapshot_epoch": int(cand["snapshot_ts_ns"]) // 10**9,
              "price_s": cand["entry_px"], "spread_bps_s": "unknown",
              "session": "unknown", "regime": "unknown"}
    return jev.state_from_candidate(cand, market, STAGE,
                                    cand["feature_revision"])


def as_candidate(cand, state):
    """The wire candidate as the filter's evaluator expects it."""
    return SimpleNamespace(
        cid=cand["cid"], symbol=cand["symbol"],
        feature_snapshot_hash=state["feature_snapshot_hash"],
        proposed_side=cand["proposed_side"],
        proposed_family=cand["proposed_family"],
        entry_px=float(cand["entry_px"]), stop_px=float(cand["stop_px"]),
        tp_px=float(cand["tp_px"]))


def summarize(cand, state, row, art, now):
    out = {"cid": cand["cid"], "symbol": cand["symbol"],
           "action": row.get("action"), "shadow": True}
    if art is None:
        out["verdict"] = "HOLD"
        out["reason"] = row.get("reason")
        return out
    a = art["payload"]["answers"]
    verdict, why = jev_filter.evaluate(
        as_candidate(cand, state), art, int(now), jev.load_pubkey(),
        dict(ENGINE))
    out.update(verdict=verdict, reason=why, enter=a["enter"],
               latent_risk=a["latent_risk"], edge_family=a["edge_family"],
               conviction=a["conviction"])
    return out


def run(loop_dir, now=None, key=None, post_fn=None):
    now = now if now is not None else time.time()
    src = os.path.join(loop_dir, "candidates.jsonl")
    off_path = os.path.join(loop_dir, OFFSET)
    try:
        with open(off_path) as f:
            off = int(f.read().strip() or 0)
    except (OSError, ValueError):
        off = 0
    try:
        with open(src, "rb") as f:
            f.seek(off)
            data = f.read()
    except OSError:
        return 0
    n = 0
    end = data.rfind(b"\n") + 1  # ignore a half-written last line
    for raw in data[:end].splitlines():
        try:
            cand = json.loads(raw)["candidate"]
            state = build_state(cand)
        except (ValueError, KeyError, TypeError):
            rec = {"action": "SKIP", "reason": "bad-candidate-line",
                   "shadow": True}
        else:
            row, art = jev.decide(state, now=now, key=key, post_fn=post_fn)
            rec = summarize(cand, state, row, art, now)
        rec["at"] = now
        with open(os.path.join(loop_dir, SHADOW), "a") as f:
            f.write(json.dumps(rec, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        n += 1
    tmp = off_path + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(off + end))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, off_path)
    return n


def main(argv):
    if len(argv) != 2:
        raise SystemExit("usage: jev_shadow.py <loop_dir>")
    print("shadowed %d candidate(s)" % run(argv[1]))


if __name__ == "__main__":
    main(sys.argv)
