# P3.3 (corrected) fixture generator. Uses the FROZEN sidecar
# (collector/jev.py) read-only, same FIXED test key as P3.1 (SEED 1f*32):
# no new key material. States are FULL frozen §3.4 contracts (17 keys,
# full feature records); canon/state_hash/decision_key come from the
# sidecar's own functions, so C++ proves byte-equality against Python.
# Run: python3 kernel/gen_p33.py  (writes kernel/p33/*.json)
# Outputs:
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

CTX = "ab" * 32  # 64-hex context hash


def feat(kind, symbols, vtype, v, effect, evidence, conf, age, src):
    return {"kind": kind, "symbols": symbols,
            "value": {"type": vtype, "v": v}, "effect": effect,
            "evidence": evidence, "confidence_bucket": conf,
            "age_s": age, "source_id": src}


F_BASE = [
    feat("filing_event", ["AAPL"], "enum", "8-K:item-2.02", "bullish",
         "source", "high", 240, "edgar_8k"),
    feat("macro_release", ["EURUSD"], "bucket", "cpi-hot", "risk_up",
         "derived", "medium", 900, "fred_macro"),
]


def full_state(epoch, regime="range", phase="none", impact="none",
               gate="insufficient", vs="insufficient", brier=0.0,
               exposure=0.5, blackout=False, disagree=False,
               feats=None, price=1.08532, spread=1.5, equity=100000.0,
               stage="G0_PAPER", session="london", rsi=55.5, z=0.4,
               atr=0.0012, prb="0.0-0.1", ab="low", pending=0.0,
               positions=0, bp=100000.0, trig=2, ctxn=7,
               src_status=None, rev="rev-1", sym="EURUSD"):
    return {
        "context_hash": CTX, "symbol": sym, "price": price,
        "spread_bps": spread, "session": session,
        "indicators": {"rsi": rsi, "zscore": z, "atr": atr,
                       "regime": regime, "price_return_bucket": prb,
                       "atr_bucket": ab},
        "features": F_BASE if feats is None else feats,
        "source_status": {"edgar_8k": "healthy",
                          "fred_macro": "healthy"} if src_status is None
        else src_status,
        "signal_buckets": {"trigger_6h": trig, "context_6h": ctxn},
        "portfolio": {"equity": equity, "exposure_pct": exposure,
                      "pending_exposure_pct": pending,
                      "open_positions": positions, "buying_power": bp},
        "disagreement": disagree,
        "event_window": {"blackout": blackout, "impact": impact,
                         "phase": phase},
        "calibration": {"enter_brier_200": brier, "vs_baseline": vs,
                        "gate": gate},
        "stage": stage, "research_revision": rev,
        "risk_flags": {"deterministic_veto": False, "var_breach": False,
                       "corr_breach": False},
        "snapshot_epoch": epoch,
    }


def answers(E, F, C, L):
    return {"enter": {"type": "noul", "noul": E},
            "edge_family": {"type": "choice", "choice": F,
                            "probabilities": {F: 0.7}},
            "conviction": {"type": "score", "score": C},
            "latent_risk": {"type": "noul", "noul": L}}


CREATED = "2026-09-20T00:00:00+00:00"
EXPIRES = 1789862400.0 + 60.0  # == created + 60 s exactly


def artifact(state, E, F, C, L):
    payload = {"schema_version": "answerset_v1",
               "question_set_version": "v3", "model": "typesafe/jev-1.13",
               "revision": "typesafe/jev-1.13-20260917",
               "provider": "TypeSafe", "symbol": state["symbol"],
               "snapshot_epoch": state["snapshot_epoch"],
               "state_hash": jev.sha256_hex(jev.canon(state)),
               "decision_key": jev.decision_key(state),
               "created_at": CREATED, "expires_at": EXPIRES,
               "answers": answers(E, F, C, L)}
    canon_payload = jev.canon(payload)
    return {"payload": payload,
            "response_hash": jev.sha256_hex(canon_payload),
            "signature": jev.ed_sign(SEED, canon_payload.encode()).hex(),
            "pubkey": PUB,
            "state": state}


def write(name, obj):
    with io.open(os.path.join(OUT, name), "w", encoding="utf-8",
                 newline="") as fh:
        json.dump(obj, fh, sort_keys=True, separators=(",", ":"))
        fh.write("\n")


# ---- systematic 200: sweep answers x state rows over full states ----
FAMS = ["momentum", "mean_reversion", "macro", "execution"]
CONVS = ["flat", "lean", "strong", "max"]
E_GRID = [0.1, 0.49, 0.5, 0.65, 0.79, 0.8, 0.81, 0.9, 0.95, 1.0]
L_GRID = [0.0, 0.3, 0.5, 0.51, 0.9]
GATES = ["insufficient", "pass", "breach"]
for i in range(200):
    E = E_GRID[i % 10]
    F = FAMS[(i // 5) % 4]
    C = CONVS[(i // 7) % 4]
    L = L_GRID[(i // 11) % 5]
    gate = GATES[(i // 13) % 3]
    st = full_state(i, gate=gate,
                    vs=("better" if gate == "pass"
                        else "insufficient"),
                    brier=(0.18 if gate == "pass" else 0.0))
    write("r_%03d.json" % i, artifact(st, E, F, C, L))

# ---- targeted table cases (epochs 200+) ----
T = {}
T["t_veto"] = (full_state(200), (0.9, "momentum", "strong", 0.1))
T["t_latent"] = (full_state(201), (0.9, "momentum", "strong", 0.8))
T["t_disagree"] = (full_state(202, disagree=True),
                   (0.86, "mean_reversion", "strong", 0.1))
T["t_blackout"] = (full_state(203, blackout=True, impact="binary",
                              phase="pre"), (0.89, "momentum", "strong", 0.1))
T["t_calib"] = (full_state(204, gate="breach", vs="worse", brier=0.31),
                (0.91, "momentum", "max", 0.1))
T["t_noedge"] = (full_state(205), (0.2, "momentum", "strong", 0.1))
T["t_bound_E50"] = (full_state(206), (0.5, "momentum", "strong", 0.1))
T["t_bound_E50_lean"] = (full_state(207), (0.5, "momentum", "lean", 0.1))
T["t_bound_E79"] = (full_state(208), (0.79, "momentum", "strong", 0.1))
T["t_bound_E80"] = (full_state(209), (0.8, "momentum", "strong", 0.1))
T["t_bound_L50"] = (full_state(210), (0.9, "momentum", "strong", 0.5))
T["t_exec_high"] = (full_state(211), (0.95, "execution", "strong", 0.1))
T["t_flat"] = (full_state(212), (0.9, "momentum", "flat", 0.1))
T["t_lean_base"] = (full_state(213), (0.9, "momentum", "lean", 0.1))
T["t_strong_base"] = (full_state(214), (0.9, "momentum", "strong", 0.1))
T["t_midband_exec"] = (full_state(215), (0.65, "execution", "strong", 0.1))
T["t_midband_lean"] = (full_state(216), (0.65, "momentum", "lean", 0.1))
T["t_max_elevated"] = (full_state(217, gate="pass", vs="better",
                                  brier=0.18), (0.93, "macro", "max", 0.1))
T["t_max_downgrade_L"] = (full_state(218), (0.93, "macro", "max", 0.4))
T["t_max_downgrade_insuf"] = (full_state(219),
                              (0.93, "macro", "max", 0.1))
for name, (st, (E, F, C, L)) in T.items():
    write(name + ".json", artifact(st, E, F, C, L))

# ---- state interop vector: tricky strings + mixed scalars, full state ----
V = full_state(
    999, regime="volatile", phase="post", impact="high", gate="pass",
    vs="better", brier=0.18, exposure=12.5, price=100.0, spread=10,
    equity=250000.5, stage="G1_TINY", session="new_york", rsi=81.25,
    z=-2.5, atr=0.0, prb='buck"et\\hots\n + caf\u00e9 \U0001f4c8',
    ab="a/b", pending=1.25, positions=3, bp=200000.0, trig=0, ctxn=0,
    src_status={"edgar_8k": "stale", "fred_macro": "not_scheduled"},
    rev='rev-"q"\n2', sym="AAPL",
    feats=[feat("osint_event", ["AAPL", "MSFT"], "bool", True, "bearish",
                "inference", "low", 0, "fred_macro"),
           feat("calendar_ahead", ["EURUSD"], "count", 3, "neutral",
                "derived", "medium", 86400, "fed_monetary"),
           feat("regime_hint", ["AAPL"], "bucket", "vol-high", "risk_up",
                "inference", "medium", 60, "ecb_mid")] +
    F_BASE)
write("state_vector.json", V)
canon_v = jev.canon(V)
with io.open(os.path.join(OUT, "state_vector_canon.hex"), "w",
             encoding="utf-8", newline="") as fh:
    fh.write(canon_v.encode().hex())
with io.open(os.path.join(OUT, "state_vector_hash.txt"), "w",
             encoding="utf-8", newline="") as fh:
    fh.write(jev.sha256_hex(canon_v))
with io.open(os.path.join(OUT, "state_vector_dkey.txt"), "w",
             encoding="utf-8", newline="") as fh:
    fh.write(jev.decision_key(V))
print("wrote %d artifacts + state vector" % (200 + len(T)))
