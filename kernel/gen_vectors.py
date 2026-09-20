# P3.2 vector generator. Uses the FROZEN sidecar (collector/jev.py) read-only:
# calls canon()/sha256_hex()/sign_answerset()/decision_key() with a FIXED key.
# No sidecar semantics are changed; this only commits known vectors.
# Run: python3 kernel/gen_vectors.py  (writes kernel/vectors/*)
import io
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "collector"))
import jev  # noqa: E402  (frozen sidecar, consumed as-is)

VEC = os.path.join(os.path.dirname(__file__), "vectors")
os.makedirs(VEC, exist_ok=True)

SEED = bytes.fromhex("1f" * 32)
PUB = jev.ed_pubkey(SEED).hex()


def w(name, data):
    if isinstance(data, (dict, list)):
        data = json.dumps(data)
    p = os.path.join(VEC, name)
    io.open(p, "w", encoding="utf-8").write(data)
    print("wrote", name, len(data))


# ---- V1: genuine P3.1-valid artifact with float edges inside ----
STATE = {
    "context_hash": "p32-vector",
    "symbol": "EURUSD",
    "stage": "G0_PAPER",
    "question_set_version": "v3",
    "snapshot_epoch": 11,
    "cycle_id": "c-p32-1",
    "spread_bps": 1.5,
    "research_revision": "r1",
    "indicators": {"regime": "range", "price_return_bucket": "b0",
                   "atr_bucket": "a1", "zscore": 0.2},
    "portfolio": {"exposure_pct": 0.0},
    "event_window": {"phase": "none"},
    "risk_flags": {},
    "features": [{"feature_id": "f1"}, {"feature_id": "f2"}],
}
state_canon = jev.canon(STATE)
payload_v1 = {
    "schema_version": "answerset_v1",
    "question_set_version": "v3",
    "model": jev.MODEL,
    "revision": jev.REVISION,
    "provider": jev.PROVIDER,
    "symbol": "EURUSD",
    "snapshot_epoch": 11,
    "state_hash": jev.sha256_hex(state_canon),
    "decision_key": jev.decision_key(STATE),
    "created_at": "2026-09-21T00:00:00+00:00",
    "expires_at": datetime(2026, 9, 21, tzinfo=timezone.utc).timestamp() + 60.0,
    "answers": {
        "enter": {"type": "noul", "noul": 0.9},
        "edge_family": {"type": "choice", "choice": "momentum",
                        "probabilities": {
                            "execution": 0.05,
                            "macro": 0.1,
                            "mean_reversion": 0.15,
                            "momentum": 0.30000000000000004},
                        "confidence": 0.5},
        "conviction": {"type": "score", "score": "strong"},
        "latent_risk": {"type": "noul", "noul": -0.0},
    },
}
canon_v1 = jev.canon(payload_v1)
art_v1 = {"payload": payload_v1,
          "response_hash": jev.sha256_hex(canon_v1),
          "signature": jev.ed_sign(SEED, canon_v1.encode()).hex(),
          "pubkey": PUB}
w("v1_artifact.json", art_v1)
w("v1_payload.json", payload_v1)
w("v1_canonical.hex", canon_v1.encode().hex())
w("v1_response_hash.txt", art_v1["response_hash"])
w("v1_signature.txt", art_v1["signature"])
w("v1_state_canon.json", state_canon)

# ---- V2: canonicalization stress (bytes layer only, not schema-valid) ----
payload_v2 = {
    "z": 1,
    "é": "caf\u00e9",
    "€": ["tick", "tock"],
    "\U0001F600 key": {"nested": {"deep": [1, 2.5, -0.0, True, None]}},
    "": "empty-key",
    "awy": {"m": 1, "a": 2, "z": {"y": [], "b": {}}},
    "bigints": [0, -1, 2 ** 63 - 1, -(2 ** 63), 2 ** 100],
    "floats": [1e16, 100000.0, -0.0, 0.0, 5e-324, 1.7976931348623157e308,
               0.1 + 0.2, 2.5e-07, 1e21, 123456789.0, 0.0001, 1e15],
    "quoted": "say \"hi\" \\ bye\b\f\n\r\t",
    "del": "a\x7fb",
    "empty": {"o": {}, "a": []},
}
canon_v2 = jev.canon(payload_v2)
w("v2_payload.json", payload_v2)
w("v2_canonical.hex", canon_v2.encode().hex())
w("v2_response_hash.txt", jev.sha256_hex(canon_v2))
w("v2_signature.txt", jev.ed_sign(SEED, canon_v2.encode()).hex())
w("pubkey.txt", PUB)
print("done")
