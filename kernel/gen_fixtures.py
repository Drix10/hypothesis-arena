# P3.1 fixture generator. Uses the FROZEN sidecar (collector/jev.py) read-only:
# builds one valid artifact + single-class negatives with a FIXED key.
# Run: python3 kernel/gen_fixtures.py  (writes kernel/fixtures/*.json)
import io
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "collector"))
import jev  # noqa: E402  (frozen sidecar, consumed as-is)

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
os.makedirs(FIX, exist_ok=True)

SEED = bytes.fromhex("1f" * 32)
PUB = jev.ed_pubkey(SEED).hex()

STATE = {
    "context_hash": "p31-fixture",
    "symbol": "EURUSD",
    "stage": "G0_PAPER",
    "question_set_version": "v3",
    "snapshot_epoch": 7,
    "cycle_id": "c-fixture-1",
    "spread_bps": 1.5,
    "research_revision": "r1",
    "indicators": {"regime": "range", "price_return_bucket": "b0",
                   "atr_bucket": "a1", "zscore": 0.2},
    "portfolio": {"exposure_pct": 0.0},
    "event_window": {"phase": "none"},
    "risk_flags": {},
    "features": [{"feature_id": "f1"}, {"feature_id": "f2"}],
}
STATE_CANON = jev.canon(STATE)
STATE_HASH = jev.sha256_hex(STATE_CANON)
DECISION_KEY = jev.decision_key(STATE)
CREATED = "2026-09-20T04:49:54.261637+00:00"


def sign_payload(payload):
    msg = jev.canon(payload).encode()
    return {"payload": payload,
            "response_hash": jev.sha256_hex(jev.canon(payload)),
            "signature": jev.ed_sign(SEED, msg).hex(),
            "pubkey": PUB}


def base_payload():
    import datetime
    created_dt = datetime.datetime.fromisoformat(CREATED)
    return {
        "schema_version": "answerset_v1",
        "question_set_version": "v3",
        "model": jev.MODEL,
        "revision": jev.REVISION,
        "provider": jev.PROVIDER,
        "symbol": "EURUSD",
        "snapshot_epoch": 7,
        "state_hash": STATE_HASH,
        "decision_key": DECISION_KEY,
        "created_at": CREATED,
        "expires_at": created_dt.timestamp() + 60.0,
        "answers": {
            "enter": {"type": "noul", "noul": 0.9},
            "edge_family": {"type": "choice", "choice": "momentum",
                            "probabilities": {}},
            "conviction": {"type": "score", "score": "strong"},
            "latent_risk": {"type": "noul", "noul": 0.1},
        },
    }


def w(name, obj):
    p = os.path.join(FIX, name)
    io.open(p, "w", encoding="utf-8").write(json.dumps(obj))
    print("wrote", name)


valid = sign_payload(base_payload())
w("valid.json", valid)
io.open(os.path.join(FIX, "state_canon.json"), "w").write(STATE_CANON)
io.open(os.path.join(FIX, "decision_key.txt"), "w").write(DECISION_KEY)
io.open(os.path.join(FIX, "trusted_key.txt"), "w").write(PUB)
io.open(os.path.join(FIX, "created_unix.txt"), "w").write(
    str(__import__("datetime").datetime.fromisoformat(CREATED).timestamp()))


def mutated(name, fn, resign=True):
    if resign:
        p = base_payload()
        fn(p)
        art = sign_payload(p)
    else:
        art = json.loads(json.dumps(valid))
        fn(art)
    w(name, art)


def mutated_payload_noresign(name, fn):
    # mutate the payload inside a signed artifact WITHOUT re-signing:
    # the payload is tampered, the signature is stale (crypto must fail
    # downstream of whatever schema check the mutation targets).
    art = json.loads(json.dumps(valid))
    fn(art["payload"])
    w(name, art)


M = lambda f: (lambda p: f(p))  # noqa

# top-level shape (no resign: structural failure precedes crypto)
mutated("bad_top_extra.json",
        lambda a: a.update({"injected": 1}), resign=False)
mutated("bad_top_missing.json",
        lambda a: a.pop("signature"), resign=False)
# payload pins (resigned: fail at schema check, not crypto)
mutated("bad_schema_version.json",
        lambda p: p.update({"schema_version": "answerset_v9"}))
mutated("bad_qversion.json",
        lambda p: p.update({"question_set_version": "v2"}))
mutated("bad_model.json",
        lambda p: p.update({"model": "other/model-1.0"}))
mutated("bad_revision.json",
        lambda p: p.update({"revision": "typesafe/jev-9.99"}))
mutated("bad_provider.json",
        lambda p: p.update({"provider": "SomeoneElse"}))
mutated("bad_symbol.json",
        lambda p: p.update({"symbol": "eurusd"}))
mutated("bad_epoch_bool.json",
        lambda p: p.update({"snapshot_epoch": True}))
mutated("bad_epoch_double.json",
        lambda p: p.update({"snapshot_epoch": 7.0}))
mutated("bad_epoch_neg.json",
        lambda p: p.update({"snapshot_epoch": -1}))
mutated("bad_statehash_shape.json",
        lambda p: p.update({"state_hash": "xyz"}))
mutated_payload_noresign("bad_created.json",
                         lambda p: p.update({"created_at": "yesterday"}))
mutated("bad_expires_window.json",
        lambda p: p.update({"expires_at": p["expires_at"] + 120.0}))
# answers (resigned)
mutated("bad_answers_extra.json",
        lambda p: p["answers"].update({"mystery": {"type": "noul",
                                                  "noul": 0.5}}))
mutated("bad_enter_bool.json",
        lambda p: p["answers"]["enter"].update({"noul": True}))
mutated("bad_enter_range.json",
        lambda p: p["answers"]["enter"].update({"noul": 1.5}))
mutated("bad_family.json",
        lambda p: p["answers"]["edge_family"].update({"choice": "vibes"}))
mutated("bad_conviction.json",
        lambda p: p["answers"]["conviction"].update({"score": "ultra"}))
# NaN: Python emits it; C++ must refuse at parse
mutated("bad_enter_nan.json",
        lambda p: p["answers"]["enter"].update({"noul": float("nan")}))
# crypto: hash mismatch (sig intact, payload touched, NO resign)
art = json.loads(json.dumps(valid))
art["payload"]["answers"]["enter"]["noul"] = 0.11
w("bad_response_hash.json", art)
# crypto: flipped signature byte
art = json.loads(json.dumps(valid))
s = art["signature"]
art["signature"] = ("0" if s[0] != "0" else "1") + s[1:]
w("bad_sig.json", art)
# binding: decision_key replaced, artifact re-signed -> recompute must catch
mutated("bad_dkey.json",
        lambda p: p.update({"decision_key": "0" * 64}))
# answers: latent out of range (re-signed)
mutated("bad_latent_range.json",
        lambda p: p["answers"]["latent_risk"].update({"noul": 1.5}))
# answers: probabilities with a foreign key (re-signed)
mutated("bad_prob_key.json",
        lambda p: p["answers"]["edge_family"].update(
            {"probabilities": {"vibes": 0.5}}))
# confidence quarantine: huge finite confidence must still validate ...
mutated("conf_huge.json",
        lambda p: p["answers"]["edge_family"].update({"confidence": 1e9}))
# ... but a non-numeric confidence is a structural failure
mutated("conf_bool.json",
        lambda p: p["answers"]["edge_family"].update({"confidence": True}))
# timestamps: impossible calendar date / leap second (payload tampered,
# signature stale: created-at check precedes crypto)
mutated_payload_noresign("bad_date_feb31.json",
                         lambda p: p.update(
                             {"created_at": "2026-02-31T00:00:00+00:00"}))
mutated_payload_noresign("bad_leap60.json",
                         lambda p: p.update(
                             {"created_at": "2026-01-01T00:00:60+00:00"}))
# pubkey mutation must NOT affect trust
art = json.loads(json.dumps(valid))
art["pubkey"] = "00" * 32
w("pubkey_mutated.json", art)

# Float edge sweep (REPORT-ONLY evidence for P3.2; not a contract).
# C++ CanonDouble must reproduce these Python json.dumps outputs byte-for-byte.
edges = [1e16, 1e-5, 0.1 + 0.2, 1e21, 123456789.0, 2.5e-7, 100000.0, 0.0,
         -0.0, 3.141592653589793, 1.7976931348623157e308, 5e-324,
         2.2250738585072014e-308, 100.0, 0.5]
with io.open(os.path.join(FIX, "float_edges.txt"), "w") as f:
    for v in edges:
        f.write(repr(v) + " -> " + json.dumps(v) + "\n")
print("done")
