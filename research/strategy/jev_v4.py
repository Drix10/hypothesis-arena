"""JEV v4 candidate-bound contract (research implementation, S4).

JEV is a pure evaluator of an already-constructed Candidate. It never
originates or mutates side/family/economics.

v4 enter semantics: "Given this exact candidate and its supplied
economics, what is P(it resolves favorably per the frozen v4 label)?"
v4 label: resolution of the ACTUAL candidate economics (side/entry/stop/
TP/time_exit/costs/horizon as one event) via backtest.resolve — never a
detached +/-R race.

Identity: c1 CID recomputed from the frozen 12-field recipe, never
trusted. feature_snapshot_hash is bound explicitly alongside (NOT part
of CID). expected_cost_bps is non-authoritative metadata.

Crypto/format reuse (no new deps, no duplicated crypto): canon/sha/ed
from collector.jev (frozen sidecar, stdlib RFC-8032).
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from collector.jev import (canon, sha256_hex, ed_sign, ed_verify, MODEL,
                           REVISION, PROVIDER, ANSWER_MAX_AGE_S, CLOCK_SKEW_S)
from research.strategy import backtest as bt
from research.strategy.candidate import _ID_FIELDS, candidate_id

QVERSION_V4 = "v4"
V4_SCHEMA = "jev4/1"
FAMILIES = ("mean_reversion", "momentum", "macro", "execution")
CONVICTIONS = ("flat", "lean", "strong", "max")

# Frozen v4 decision_key recipe (pipe-joined exact strings; C++ recomputes
# field-for-field). cid binds all 12 CID fields; the rest bind market,
# snapshot identity, and evidence linkage.
V4_DKEY_ORDER = ("cid", "symbol", "snapshot_epoch", "price_s",
                 "spread_bps_s", "session", "regime",
                 "feature_snapshot_hash", "question_set_version")


def cid_field_strs(candidate):
    """Exact strings the c1 CID hashes (Python str(v) per field)."""
    return {f: str(getattr(candidate, f)) for f in _ID_FIELDS}


def build_v4_state(candidate, market):
    """market: snapshot_epoch(int) price_s/spread_bps_s(str) session/regime(str).

    All economics travel as the exact CID strings; C++ hashes the strings
    and parses them to doubles for coherence (never re-renders floats)."""
    return {
        "question_set_version": QVERSION_V4,
        "cid": candidate.cid,
        "candidate": dict(cid_field_strs(candidate), cid=candidate.cid),
        "feature_snapshot_hash": candidate.feature_snapshot_hash,
        "symbol": candidate.symbol,
        "snapshot_epoch": market["snapshot_epoch"],
        "price_s": market["price_s"],
        "spread_bps_s": market["spread_bps_s"],
        "session": market["session"],
        "regime": market["regime"],
    }


def v4_decision_key(state):
    return sha256_hex("|".join(str(state[f]) for f in V4_DKEY_ORDER))


def make_v4_payload(candidate, market, answers, created_at, expires_at):
    state = build_v4_state(candidate, market)
    return dict(state, decision_key=v4_decision_key(state),
                created_at=created_at, expires_at=expires_at,
                answers=answers)


def sign_v4(payload, seed):
    msg = canon(payload).encode()
    return {"payload": payload,
            "response_hash": sha256_hex(canon(payload)),
            "signature": ed_sign(seed, msg).hex()}


def verify_v4_sig(artifact, pub):
    try:
        msg = canon(artifact["payload"]).encode()
        sig = bytes.fromhex(artifact["signature"])
    except (KeyError, ValueError):
        return False
    if len(sig) != 64:
        return False
    if sha256_hex(canon(artifact["payload"])) != artifact.get("response_hash"):
        return False
    return ed_verify(pub, msg, sig)


def _num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def evaluate_v4(candidate, artifact, now_unix, pubkey, engine):
    """-> (action, reason). FAIL-CLOSED; never emits side/family/size.

    engine: {deterministic_veto, disagreement, blackout, calib_gate}.
    calib_gate in {pass, insufficient, breach}."""
    p = artifact.get("payload") if isinstance(artifact, dict) else None
    if not isinstance(p, dict):
        return ("HOLD", "v4_absent")
    if p.get("question_set_version") != QVERSION_V4:
        return ("HOLD", "v4_contract_mismatch")
    c = p.get("candidate")
    if not isinstance(c, dict):
        return ("HOLD", "v4_malformed")
    if c.get("cid") != candidate.cid:
        return ("HOLD", "v4_cid_mismatch")
    if candidate_id(**{f: c.get(f) for f in _ID_FIELDS}) != candidate.cid:
        return ("HOLD", "v4_cid_mismatch")
    if p.get("feature_snapshot_hash") != candidate.feature_snapshot_hash:
        return ("HOLD", "v4_feature_binding")
    if p.get("symbol") != candidate.symbol:
        return ("HOLD", "v4_symbol_binding")
    nums = {k: _num(c.get(k)) for k in ("entry_px", "stop_px", "tp_px")}
    if any(v is None or v <= 0 for v in nums.values()):
        return ("HOLD", "v4_malformed")
    e, s, t = nums["entry_px"], nums["stop_px"], nums["tp_px"]
    if (e != candidate.entry_px or s != candidate.stop_px or
            t != candidate.tp_px):
        return ("HOLD", "v4_economics_binding")
    if candidate.proposed_side == "BUY":
        coherent = s < e < t
    else:
        coherent = t < e < s
    if not coherent:
        return ("HOLD", "v4_malformed")
    a = p.get("answers")
    if not isinstance(a, dict):
        return ("HOLD", "v4_malformed")
    if a.get("edge_family") != candidate.proposed_family:
        return ("HOLD", "v4_family_binding")
    if v4_decision_key(p) != p.get("decision_key"):
        return ("HOLD", "v4_decision_binding")
    if sha256_hex(canon(p)) != artifact.get("response_hash"):
        return ("HOLD", "v4_response_binding")
    if not verify_v4_sig(artifact, pubkey):
        return ("HOLD", "v4_unauthenticated")
    try:
        created, expires = int(p["created_at"]), int(p["expires_at"])
    except (KeyError, TypeError, ValueError):
        return ("HOLD", "v4_malformed")
    if not (created <= now_unix + CLOCK_SKEW_S):
        return ("HOLD", "v4_malformed")
    if not (now_unix <= expires):
        return ("HOLD", "v4_expired")
    try:
        enter = float(a["enter"])
        latent = float(a["latent_risk"])
    except (KeyError, TypeError, ValueError):
        return ("HOLD", "v4_malformed")
    if not (0.0 <= enter <= 1.0 and 0.0 <= latent <= 1.0):
        return ("HOLD", "v4_malformed")
    conv = a.get("conviction")
    if conv not in CONVICTIONS:
        return ("HOLD", "v4_malformed")
    # v4 table (§3.2 rows, candidate-specific enter). First HOLD wins.
    if engine.get("deterministic_veto"):
        return ("HOLD", "engine")
    if latent > 0.5:
        return ("HOLD", "latent_risk")
    if engine.get("disagreement"):
        return ("HOLD", "disagreement")
    if engine.get("blackout"):
        return ("HOLD", "blackout")
    if engine.get("calib_gate") == "breach":
        return ("HOLD", "calibration")
    if enter < 0.5:
        return ("HOLD", "no_edge")
    if enter <= 0.8 and (a["edge_family"] == "execution" or
                         conv in ("flat", "lean")):
        return ("HOLD", "midband")
    if a["edge_family"] == "execution":
        return ("HOLD", "execution")
    if conv == "flat":
        return ("HOLD", "flat")
    if conv == "lean":
        return ("PASS_BASE", "lean")
    if conv == "strong":
        return ("PASS_BASE", "strong")
    gate = (enter >= 0.8 and latent <= 0.3 and
            engine.get("calib_gate") == "pass" and not engine.get("veto_max"))
    if gate:
        return ("PASS_ELEVATED_ELIGIBLE", "max_gate")
    return ("PASS_BASE", "max_downgrade")


def resolve_v4_label(candidate, bars_after, spread_mult=1.0,
                     entry_spread_bps=0.0):
    """Frozen v4 label: actual candidate economics as one event."""
    return bt.resolve(candidate, bars_after, spread_mult=spread_mult,
                      entry_spread_bps=entry_spread_bps)
