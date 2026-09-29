"""JEV filter contract: candidate-bound answers (research implementation).

JEV is a pure evaluator of an already-constructed Candidate. It never
originates or mutates side/family/economics.

enter semantics: "Given this exact candidate and its supplied economics,
what is P(it resolves favorably per the frozen label)?"
Label: resolution of the ACTUAL candidate economics (side/entry/stop/
TP/time_exit/costs/horizon as one event) via backtest.resolve, never a
detached +/-R race.

Identity: c1 CID recomputed from the frozen 12-field recipe, never
trusted. feature_snapshot_hash is bound explicitly alongside (NOT part
of CID). expected_cost_bps is non-authoritative metadata.

State, decision key, payload shape and signing live in the sidecar
(collector/jev.py) and are reused here, so producer and evaluator cannot
drift. The kernel recomputes the same checks in C++ (kernel/jev_filter.hpp).
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from collector import jev
from collector.jev import (canon, sha256_hex, ed_sign, ed_verify,
                           CLOCK_SKEW_S, CONTRACT, FAMILIES as _FAMILIES,
                           CONVICTIONS as _CONVICTIONS, decision_key)
from research.strategy import backtest as bt
from research.strategy.candidate import _ID_FIELDS, candidate_id

FAMILIES = tuple(sorted(_FAMILIES))
CONVICTIONS = ("flat", "lean", "strong", "max")
assert set(CONVICTIONS) == set(_CONVICTIONS)
assert tuple(_ID_FIELDS) == jev.CID_FIELDS


def cid_field_strs(candidate):
    """Exact strings the c1 CID hashes (Python str(v) per field)."""
    return {f: str(getattr(candidate, f)) for f in _ID_FIELDS}


def build_state(candidate, market, stage="G0_PAPER"):
    """market: snapshot_epoch(int) price_s/spread_bps_s(str) session/regime(str).

    All economics travel as the exact CID strings; C++ hashes the strings
    and parses them to doubles for coherence (never re-renders floats)."""
    cand = dict(cid_field_strs(candidate), cid=candidate.cid)
    return jev.state_from_candidate(cand, market, stage,
                                    candidate.feature_snapshot_hash)


def make_payload(candidate, market, answers, created_at, expires_at):
    payload = jev.make_payload(build_state(candidate, market), answers,
                               created_at)
    payload["expires_at"] = expires_at
    return payload


def sign(payload, seed):
    msg = canon(payload).encode()
    return {"payload": payload,
            "response_hash": sha256_hex(canon(payload)),
            "signature": ed_sign(seed, msg).hex()}


def verify_sig(artifact, pub):
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


def _is_str(v):
    return isinstance(v, str)


INT64_MAX = 9223372036854775807


def _is_int(v):
    # C++ ParseStrictUint domain: decimal digits, non-negative, <= INT64_MAX.
    # type() is X int (not isinstance): bools are already out, subclasses too.
    return type(v) is int and 0 <= v <= INT64_MAX


def _num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    if v != v or v in (float("inf"), float("-inf")):
        return None
    return v


def evaluate(candidate, artifact, now_unix, pubkey, engine):
    """-> (action, reason). Fails closed; never emits side/family/size.

    engine: {deterministic_veto, disagreement, blackout, calib_gate}.
    calib_gate in {pass, insufficient, breach}."""
    p = artifact.get("payload") if isinstance(artifact, dict) else None
    if not isinstance(p, dict):
        return ("HOLD", "absent")
    # Top-level wire shape mirrors C++ exactly (non-string hash/sig = absent).
    if not _is_str(artifact.get("response_hash")) or \
       not _is_str(artifact.get("signature")):
        return ("HOLD", "absent")
    if not _is_str(p.get("contract")) or \
       p.get("contract") != CONTRACT:
        return ("HOLD", "contract_mismatch")
    c = p.get("candidate")
    if not isinstance(c, dict):
        return ("HOLD", "malformed")
    # Every CID field must be a JSON string (C++ rejects numbers here).
    if any(not _is_str(c.get(f)) for f in _ID_FIELDS) or \
       not _is_str(c.get("cid")):
        return ("HOLD", "malformed")
    if c.get("cid") != candidate.cid:
        return ("HOLD", "cid_mismatch")
    if candidate_id(**{f: c.get(f) for f in _ID_FIELDS}) != candidate.cid:
        return ("HOLD", "cid_mismatch")
    if not _is_str(p.get("feature_snapshot_hash")) or \
       not (1 <= len(p["feature_snapshot_hash"]) <= 256):
        return ("HOLD", "malformed")
    if p.get("feature_snapshot_hash") != candidate.feature_snapshot_hash:
        return ("HOLD", "feature_binding")
    if not _is_str(p.get("symbol")):
        return ("HOLD", "malformed")
    if p.get("symbol") != candidate.symbol:
        return ("HOLD", "symbol_binding")
    for f in ("price_s", "spread_bps_s", "session", "regime"):
        if not _is_str(p.get(f)):
            return ("HOLD", "malformed")
    if not _is_int(p.get("snapshot_epoch")):
        return ("HOLD", "malformed")
    nums = {k: _num(c.get(k)) for k in ("entry_px", "stop_px", "tp_px")}
    if any(v is None or v <= 0 for v in nums.values()):
        return ("HOLD", "malformed")
    e, s, t = nums["entry_px"], nums["stop_px"], nums["tp_px"]
    if (e != candidate.entry_px or s != candidate.stop_px or
            t != candidate.tp_px):
        return ("HOLD", "economics_binding")
    if candidate.proposed_side == "BUY":
        coherent = s < e < t
    else:
        coherent = t < e < s
    if not coherent:
        return ("HOLD", "malformed")
    a = p.get("answers")
    if not isinstance(a, dict):
        return ("HOLD", "malformed")
    if not _is_str(a.get("edge_family")) or \
       a.get("edge_family") != candidate.proposed_family:
        return ("HOLD", "family_binding")
    if not _is_str(p.get("decision_key")) or \
       len(p["decision_key"]) != 64:
        return ("HOLD", "malformed")
    if decision_key(p) != p.get("decision_key"):
        return ("HOLD", "decision_binding")
    if sha256_hex(canon(p)) != artifact.get("response_hash"):
        return ("HOLD", "response_binding")
    if not verify_sig(artifact, pubkey):
        return ("HOLD", "unauthenticated")
    if not _is_int(p.get("created_at")) or not _is_int(p.get("expires_at")):
        return ("HOLD", "malformed")
    created, expires = p["created_at"], p["expires_at"]
    if expires != created + 60:
        return ("HOLD", "malformed")
    if not (created <= now_unix + CLOCK_SKEW_S):
        return ("HOLD", "malformed")
    if not (now_unix <= expires):
        return ("HOLD", "expired")
    if not isinstance(a.get("enter"), float) or \
       not isinstance(a.get("latent_risk"), float):
        # C++ requires JSON floats here (NUM-double branch); ints/bools/
        # strings are malformed on both sides.
        return ("HOLD", "malformed")
    enter, latent = float(a["enter"]), float(a["latent_risk"])
    if not (0.0 <= enter <= 1.0 and 0.0 <= latent <= 1.0):
        return ("HOLD", "malformed")
    conv = a.get("conviction")
    if not _is_str(conv) or conv not in CONVICTIONS:
        return ("HOLD", "malformed")
    # decision table (doc 03 §3.2 rows, candidate-specific enter). First HOLD wins.
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


def resolve_label(candidate, bars_after, spread_mult=1.0,
                     entry_spread_bps=0.0):
    """Frozen label: actual candidate economics as one event."""
    return bt.resolve(candidate, bars_after, spread_mult=spread_mult,
                      entry_spread_bps=entry_spread_bps)
