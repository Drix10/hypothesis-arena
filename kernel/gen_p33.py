# P3.3 fixture generator. Uses the FROZEN sidecar (collector/jev.py)
# read-only, same FIXED test key as P3.1 (SEED 1f*32): no new key material.
# Run: python3 kernel/gen_p33.py  (writes kernel/p33/*.json)
# Outputs:
#   state_canon.json .... shared replay state (pretty input form)
#   r_000..r_199.json ... 200 systematic answer combos (epochs 0..199)
#   t_*.json ............ targeted table cases (epochs 200+)
#   state_vector.json ... JEVStateV3 interop state (tricky strings/numbers)
#   state_vector_canon.hex / _hash.txt / _dkey.txt ... committed ground truth
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "collector"))
import jev  # noqa: E402  (frozen sidecar, consumed as-is)

OUT = os.path.join(os.path.dirname(__file__), "p33")
os.makedirs(OUT, exist_ok=True)

SEED = bytes.fromhex("1f" * 32)  # SAME test identity as P3.1 fixtures
PUB = jev.ed_pubkey(SEED).hex()

STATE = {
    "context_hash": "p33-replay",
    "symbol": "EURUSD",
    "stage": "G0_PAPER",
    "question_set_version": "v3",
    "snapshot_epoch": 0,  # rewritten per artifact below
    "spread_bps": 1.5,
    "research_revision": "r1",
    "indicators": {"regime": "range", "price_return_bucket": "b0",
                   "atr_bucket": "a1", "zscore": 0.2},
    "portfolio": {"exposure_pct": 0.0},
    "event_window": {"phase": "none"},
    "features": [{"feature_id": "f1"}, {"feature_id": "f2"}],
}
CREATED = "2026-09-20T04:49:54.261637+00:00"  # fixed past instant (REPLAY)


def sign_payload(payload):
    msg = jev.canon(payload).encode()
    return {"payload": payload,
            "response_hash": jev.sha256_hex(jev.canon(payload)),
            "signature": jev.ed_sign(SEED, msg).hex(),
            "pubkey": PUB}


def artifact(state, answers, epoch):
    import datetime
    st = dict(state)
    st["snapshot_epoch"] = epoch
    canon = jev.canon(st)
    created_dt = datetime.datetime.fromisoformat(CREATED)
    payload = {
        "schema_version": "answerset_v1",
        "question_set_version": "v3",
        "model": jev.MODEL,
        "revision": jev.REVISION,
        "provider": jev.PROVIDER,
        "symbol": st["symbol"],
        "snapshot_epoch": epoch,
        "state_hash": jev.sha256_hex(canon),
        "decision_key": jev.decision_key(st),
        "created_at": CREATED,
        "expires_at": created_dt.timestamp() + 60.0,
        "answers": answers,
    }
    return sign_payload(payload), canon


def ans(e, f, c, l):
    return {
        "enter": {"type": "noul", "noul": e},
        "edge_family": {"type": "choice", "choice": f, "probabilities": {}},
        "conviction": {"type": "score", "score": c},
        "latent_risk": {"type": "noul", "noul": l},
    }


def w(name, obj):
    p = os.path.join(OUT, name)
    io.open(p, "w", encoding="utf-8").write(json.dumps(obj))
    return p


w("state_canon_input.json", STATE)

E_GRID = [0.0, 0.25, 0.49, 0.5, 0.65, 0.79, 0.8, 0.81, 0.9, 1.0]
F_GRID = ["mean_reversion", "momentum", "macro", "execution"]
C_GRID = ["flat", "lean", "strong", "max"]
L_GRID = [0.0, 0.3, 0.5, 0.51, 0.9]
for i in range(200):
    a = ans(E_GRID[i % 10], F_GRID[(i // 5) % 4],
            C_GRID[(i // 7) % 4], L_GRID[(i // 11) % 5])
    art, _ = artifact(STATE, a, i)
    w("r_%03d.json" % i, art)
print("wrote 200 replay artifacts")

TARGETED = [
    ("t_veto", ans(0.88, "mean_reversion", "strong", 0.1)),
    ("t_latent", ans(0.9, "momentum", "strong", 0.8)),
    ("t_disagree", ans(0.86, "mean_reversion", "strong", 0.1)),
    ("t_blackout", ans(0.89, "momentum", "strong", 0.1)),
    ("t_calib", ans(0.91, "momentum", "max", 0.1)),
    ("t_noedge", ans(0.4, "momentum", "strong", 0.1)),
    ("t_midband_exec", ans(0.6, "execution", "strong", 0.1)),
    ("t_midband_lean", ans(0.7, "momentum", "lean", 0.1)),
    ("t_exec_high", ans(0.85, "execution", "strong", 0.1)),
    ("t_flat", ans(0.9, "momentum", "flat", 0.1)),
    ("t_lean_base", ans(0.9, "momentum", "lean", 0.1)),
    ("t_strong_base", ans(0.9, "momentum", "strong", 0.1)),
    ("t_max_elevated", ans(0.93, "macro", "max", 0.1)),
    ("t_max_downgrade_L", ans(0.93, "macro", "max", 0.4)),
    ("t_max_downgrade_insuf", ans(0.93, "macro", "max", 0.1)),
    ("t_bound_E50", ans(0.5, "momentum", "strong", 0.1)),
    ("t_bound_L50", ans(0.9, "momentum", "strong", 0.5)),
    ("t_bound_E80", ans(0.8, "macro", "max", 0.1)),
    ("t_bound_E79", ans(0.79, "macro", "max", 0.1)),
    ("t_bound_E50_lean", ans(0.5, "momentum", "lean", 0.1)),
]
for j, (name, a) in enumerate(TARGETED):
    art, _ = artifact(STATE, a, 200 + j)
    w(name + ".json", art)
print("wrote %d targeted artifacts" % len(TARGETED))

xxx = dict(STATE)
xxx["symbol"] = "XXX"
art, _ = artifact(xxx, ans(0.9, "momentum", "strong", 0.1), 0)
w("t_symbol_xxx.json", art)

# Interop state vector: tricky strings + mixed scalar types. The C++
# JEVStateV3 serializer must reproduce canon bytes bit-for-bit.
VSTATE = {
    "context_hash": "ab" * 32,
    "symbol": "EURUSD",
    "stage": "G0_PAPER",
    "question_set_version": "v3",
    "snapshot_epoch": 123456789,
    "spread_bps": 2.25,
    "cycle_id": "c\"q\\tail\n",
    "research_revision": "r\xe9v\u00e9\u0001\U0001f600",
    "indicators": {"regime": "trend", "price_return_bucket": 3,
                   "atr_bucket": "a\tb", "zscore": -1.75},
    "portfolio": {"exposure_pct": 0},
    "event_window": {"phase": "none"},
    "features": [{"feature_id": "z9"}, {"feature_id": "a1"}],
}
w("state_vector.json", VSTATE)
canon = jev.canon(VSTATE)
io.open(os.path.join(OUT, "state_vector_canon.hex"), "w").write(canon.encode().hex())
io.open(os.path.join(OUT, "state_vector_hash.txt"), "w").write(jev.sha256_hex(canon))
io.open(os.path.join(OUT, "state_vector_dkey.txt"), "w").write(jev.decision_key(VSTATE))
print("wrote state vector + ground truth")
