"""JEV shadow mode: asks JEV about each paper candidate and only LOGS the
answer. It never blocks, sizes or orders anything.

    python3 ops/jev_shadow.py <loop_dir>          # one pass, then exit

Reads  <loop_dir>/candidates.jsonl   (append-only, written by the emitter)
Writes <loop_dir>/jev_shadow.jsonl   (one row per candidate)
       <loop_dir>/jev_shadow.offset  (byte offset already processed)
It does not touch the journal, candidates, approved.json or STAGE. Provider
calls go through collector.jev.decide, so the spend governor, cache and
signing apply unchanged. No key means a logged HOLD row, never a guess.

Scope: the frozen provider speaks the v3 question set, so this proves the
plumbing and records what JEV would have said (would_block is hypothetical).
It is not v4 evidence and not a promotion input on its own."""
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from collector import jev

SHADOW = "jev_shadow.jsonl"
OFFSET = "jev_shadow.offset"


def build_state(cand, now):
    """v3 state bound to the candidate: context_hash is the cid."""
    return {"context_hash": cand["cid"], "symbol": cand["symbol"],
            "stage": "G0_PAPER", "question_set_version": "v3",
            "snapshot_epoch": int(int(cand["snapshot_ts_ns"]) // 10**9),
            "indicators": {"regime": "unknown",
                           "proposed_side": cand["proposed_side"],
                           "proposed_family": cand["proposed_family"],
                           "entry_px": cand["entry_px"],
                           "stop_px": cand["stop_px"],
                           "tp_px": cand["tp_px"]},
            "portfolio": {}, "event_window": {}, "risk_flags": {}}


def summarize(cand, row):
    """Flatten the sidecar row; would_block is a what-if, never applied."""
    out = {"cid": cand["cid"], "symbol": cand["symbol"],
           "action": row.get("action"), "shadow": True}
    a = row.get("answers")
    if isinstance(a, dict):
        try:
            enter = a["enter"]["noul"]
            risk = a["latent_risk"]["noul"]
            fam = a["edge_family"]["choice"]
            out.update(enter=enter, latent_risk=risk, edge_family=fam,
                       conviction=a["conviction"]["score"],
                       would_block=bool(enter < 0.5 or risk > 0.5
                                        or fam != cand["proposed_family"]))
        except (KeyError, TypeError):
            out["action"] = "HOLD"
            out["reason"] = "answers-shape"
    else:
        out["reason"] = row.get("reason") or row.get("hold_reason")
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
            state = build_state(cand, now)
        except (ValueError, KeyError, TypeError):
            rec = {"action": "SKIP", "reason": "bad-candidate-line",
                   "shadow": True}
        else:
            row, _ = jev.decide(state, now=now, key=key, post_fn=post_fn)
            rec = summarize(cand, row)
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
