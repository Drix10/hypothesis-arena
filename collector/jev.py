#!/usr/bin/env python3
'''Phase 2 JEV sidecar: stdin state -> batched v3 call -> signed AnswerSet.
Optimized for correctness -> provenance -> failure containment ->
replayability -> cost -> latency. Latency is explicitly last: the fast path
begins AFTER this artifact crosses the boundary into C++.

Authority: this adapter reports what the frozen dependency said. It cannot
size, authorize risk, or gate budgets. Every failure mode returns HOLD rows;
defaults are never fabricated. Replay performs ZERO remote calls.
Stdlib only (Ed25519 implemented from RFC 8032 over hashlib, no new deps).
'''
import hashlib
import json
import math
import os
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

MODEL = "typesafe/jev-1.13"
REVISION = "typesafe/jev-1.13-20260917"
PROVIDER = "TypeSafe"
ENDPOINT = "https://openrouter.ai/api/alpha/decisions"
QVERSION = "v3"
TIMEOUT_S = 10
RETRY_DELAY_S = 5.0
ANSWER_MAX_AGE_S = 60
CLOCK_SKEW_S = 60.0  # max tolerated future-dating of signed created_at
DAILY_CALL_CEILING = 5000
DAILY_CALL_ALERT = 2500
STAGES = frozenset({"G0_PAPER", "G1_TINY", "G2_SCALED", "G3_FULL"})
STAGE_30D_CAPS_USD = {"G0_PAPER": 150.0, "G1_TINY": 150.0,
                      "G2_SCALED": 400.0, "G3_FULL": 1000.0}
# Frozen maximum authorized charge for ONE provider call. The money gate
# reserves this amount BEFORE sending the request and reconciles the actual
# cost after: a call is only authorized when total_30d + this reservation
# fits inside the stage cap, so one call can never overshoot an absolute
# cap merely because usage is learned afterward. Covers the worst-case
# pinned-model 4-question call with headroom; raising it is a doc edit +
# version bump (it weakens the pre-call bound), never a silent constant
# tweak. Actual overruns (provider reprices above this) are charged in
# full AND trip unknown_charges: the governor holds until a human audits.
MAX_AUTHORIZED_CALL_USD = 2.00
# Clock-skew allowance for artifact admission: a signed created_at up to
# this far in the future is tolerated (signer/verifier clock offset),
# anything beyond is future-dated evidence and rejected.
CACHE_DIR = os.path.join(ROOT, "data", "jev_cache")
SPEND_DIR = os.path.join(ROOT, "data", "jev_spend")
CALL_LOG = os.path.join(ROOT, "data", "jev_calls.jsonl")
KEY_PATH = os.path.join(ROOT, "data", "keys", "jev_ed25519.json")

QUESTIONS = [
    ("enter", "noul",
     "Given this context, take this opportunity now?",
     {"true": "Edge + timing align; risk within limits",
      "false": "Wait or stay flat; edge unclear or timing off"}),
    ("edge_family", "choice",
     "Which strategy family does the evidence support?",
     {"mean_reversion": "z-score / distance from equilibrium / half-life, regime-compatible",
      "momentum": "trend / macro surprise / flow",
      "macro": "rates / central-bank / event-drift",
      "execution": "liquidity / spread only, never a directional reason alone"}),
    ("conviction", "score",
     "Bounded qualitative control: budget gate input only, never sizes.",
     ["flat", "lean", "strong", "max"]),
    ("latent_risk", "noul",
     "Material risk NOT captured by the deterministic engine?",
     {"true": "Hidden risk likely: unflagged event, gap/overnight exposure, "
              "suspicious provenance, regime the engine is blind in",
      "false": "No latent risk seen"}),
]
FAMILIES = {"mean_reversion", "momentum", "macro", "execution"}
CONVICTIONS = {"flat", "lean", "strong", "max"}


def api_key():
    try:
        with open(os.path.join(ROOT, ".env"), encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line.startswith("OPENROUTER_API_KEY="):
                    return line.split("=", 1)[1].strip().strip("'\"")
    except OSError:
        pass
    return os.environ.get("OPENROUTER_API_KEY", "")


def canon(obj):
    # allow_nan=False: non-finite floats raise instead of emitting
    # non-standard NaN/Infinity tokens the C++ boundary rejects.
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


def sha256_hex(s):
    return hashlib.sha256(s.encode()).hexdigest()


# ---- minimal RFC 8032 Ed25519 (sign+verify, hashlib-only) ----
_B = 256
_Q = (1 << 255) - 19
_L = (1 << 252) + 27742317777372353535851937790883648493


def _H(m):
    return hashlib.sha512(m).digest()


def _expmod(b, e, m):
    return pow(b, e, m)


def _inv(x):
    return _expmod(x, _Q - 2, _Q)


_d = -121665 * _inv(121666) % _Q
_I = _expmod(2, (_Q - 1) // 4, _Q)


def _xrecover(y):
    xx = (y * y - 1) * _inv(_d * y * y + 1) % _Q
    x = _expmod(xx, (_Q + 3) // 8, _Q)
    if (x * x - xx) % _Q != 0:
        x = (x * _I) % _Q
    return x if x % 2 == 0 else _Q - x


_By = (4 * _inv(5)) % _Q
_Bx = _xrecover(_By)
_B = (_Bx % _Q, _By % _Q, 1, (_Bx * _By) % _Q)


def _edwards(P, Q):
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Q
    a = ((y1 - x1) * (y2 - x2)) % _Q
    b = ((y1 + x1) * (y2 + x2)) % _Q
    c = (t1 * 2 * _d * t2) % _Q
    dd = (z1 * 2 * z2) % _Q
    e = (b - a) % _Q
    f = (dd - c) % _Q
    g = (dd + c) % _Q
    h = (b + a) % _Q
    return ((e * f) % _Q, (g * h) % _Q, (f * g) % _Q, (e * h) % _Q)


def _scalarmult(P, e):
    Q = (0, 1, 1, 0)
    e = e % _L
    bit = 1 << 253
    while bit > 0:
        Q = _edwards(Q, Q)
        if e & bit:
            Q = _edwards(Q, P)
        bit >>= 1
    return Q


def _encodepoint(P):
    x, y, z, t = P
    zi = _inv(z)
    x = (x * zi) % _Q
    y = (y * zi) % _Q
    bits = [(y >> i) & 1 for i in range(255)] + [(x & 1)]
    return bytes(sum(b << (i % 8) for i, b in
                     enumerate(bits[j * 8:(j + 1) * 8]))
                 for j in range(32))


def _decodepoint(s):
    y = sum(2 ** i * ((s[i // 8] >> (i % 8)) & 1) for i in range(255))
    sign = (s[31] >> 7) & 1
    x = _xrecover(y)
    if x & 1 != sign:
        x = _Q - x
    P = (x, y, 1, (x * y) % _Q)
    return P


def ed_pubkey(seed):
    h = _H(seed)
    a = 2 ** 254 + sum(2 ** i * ((h[i // 8] >> (i % 8)) & 1)
                       for i in range(3, 254))
    return _encodepoint(_scalarmult(_B, a))


def ed_sign(seed, msg):
    h = _H(seed)
    a = 2 ** 254 + sum(2 ** i * ((h[i // 8] >> (i % 8)) & 1)
                       for i in range(3, 254))
    r = int.from_bytes(_H(h[32:] + msg), "little") % _L
    R = _encodepoint(_scalarmult(_B, r))
    pub = _encodepoint(_scalarmult(_B, a))
    S = (r + int.from_bytes(_H(R + pub + msg), "little") * a) % _L
    return R + S.to_bytes(32, "little")


def ed_verify(pub, msg, sig):
    if len(sig) != 64 or len(pub) != 32:
        return False
    R = sig[:32]
    try:
        A = _decodepoint(pub)
        _decodepoint(R)
    except Exception:
        return False
    S = int.from_bytes(sig[32:], "little")
    if S >= _L:
        return False
    h = int.from_bytes(_H(R + pub + msg), "little")
    P = _scalarmult(_B, S)
    Q = _edwards(_decodepoint(R), _scalarmult(A, h))
    px = (P[0] * _inv(P[2])) % _Q
    qx = (Q[0] * _inv(Q[2])) % _Q
    py = (P[1] * _inv(P[2])) % _Q
    qy = (Q[1] * _inv(Q[2])) % _Q
    return px == qx and py == qy


def keypair():
    """Explicit bootstrap ONLY: creates a fresh signing identity iff none
    exists. Refuses to overwrite. Runtime paths never call this."""
    os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
    if os.path.exists(KEY_PATH):
        raise FileExistsError("key already exists; refusing to overwrite " +
                              KEY_PATH)
    seed = os.urandom(32)
    pub = ed_pubkey(seed)
    fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"seed": seed.hex(), "pub": pub.hex()}, fh)
    return seed, pub


class KeyMaterialError(Exception):
    pass


def load_keypair():
    """Runtime key load. Missing/malformed/mismatched material raises —
    never silently regenerates (a corrupt key file must HOLD + alert, not
    rotate identity and orphan every existing artifact)."""
    try:
        with open(KEY_PATH, encoding="utf-8") as fh:
            kp = json.load(fh)
        seed = bytes.fromhex(kp["seed"])
        pub = bytes.fromhex(kp["pub"])
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise KeyMaterialError(f"unreadable key file: {type(e).__name__}")
    if len(seed) != 32 or len(pub) != 32:
        raise KeyMaterialError("key length")
    if ed_pubkey(seed) != pub:
        raise KeyMaterialError("seed/pub mismatch")
    return seed, pub


def load_pubkey():
    """Configured trust anchor for verification (B5). Raises when the
    anchor itself is unusable — verification then fails closed."""
    _, pub = load_keypair()
    return pub


# ---- request / response ----
def build_questions():
    qs = {}
    for name, qtype, instructions, criteria in QUESTIONS:
        qs[name] = {"type": qtype, "instructions": instructions,
                    "criteria": criteria}
    return qs


STATE_MAX_DEPTH = 32
STATE_MAX_MEMBERS = 1024
STATE_MAX_STR = 65536


def _finite_json(obj, depth=0):
    """Recursive admission scan: JSON scalars only, floats finite, bounded
    shape. The sidecar must never hash-and-send a state carrying nested
    NaN/Infinity (canon() would emit non-standard tokens C++ rejects) or
    non-JSON Python objects."""
    if depth > STATE_MAX_DEPTH:
        return False
    if obj is None or isinstance(obj, bool):
        return True
    if isinstance(obj, int):
        return True
    if isinstance(obj, float):
        return math.isfinite(obj)
    if isinstance(obj, str):
        return len(obj) <= STATE_MAX_STR
    if isinstance(obj, dict):
        if len(obj) > STATE_MAX_MEMBERS:
            return False
        return all(isinstance(k, str) and _finite_json(v, depth + 1)
                   for k, v in obj.items())
    if isinstance(obj, (list, tuple)):
        if len(obj) > STATE_MAX_MEMBERS:
            return False
        return all(_finite_json(v, depth + 1) for v in obj)
    return False


def validate_state(state):
    if not isinstance(state, dict):
        return False, "state-not-object"
    for k in ("context_hash", "symbol", "stage"):
        if k not in state:
            return False, "state-missing:" + k
    if not isinstance(state.get("context_hash"), str) or \
            not state["context_hash"]:
        return False, "state-context_hash"
    if not isinstance(state.get("symbol"), str) or not state["symbol"]:
        return False, "state-symbol"
    if state.get("stage") not in STAGES:
        return False, "invalid-stage"
    if state.get("question_set_version", QVERSION) != QVERSION:
        return False, "state-qversion"
    ep = state.get("snapshot_epoch", "?")
    if ep != "?" and (isinstance(ep, bool) or not isinstance(ep, int)
                        or ep < 0):
        return False, "state-epoch"
    for k in ("indicators", "portfolio", "event_window"):
        if k in state and not isinstance(state[k], dict):
            return False, "state-" + k
    if "features" in state and not isinstance(state["features"], list):
        return False, "state-features"
    if "features" in state:
        for f in state["features"]:
            if isinstance(f, dict) and "feature_id" in f and \
                    not isinstance(f["feature_id"], str):
                # decision_key() would raise sorting mixed types: refuse
                # admission instead of crashing mid-cycle (B11).
                return False, "state-feature-id"
    if "research_revision" in state and \
            not isinstance(state["research_revision"], str):
        return False, "state-research_revision"
    if "spread_bps" in state and \
            (isinstance(state["spread_bps"], bool) or
             not isinstance(state["spread_bps"], (int, float))):
        return False, "state-spread"
    if "cycle_id" in state and not isinstance(state["cycle_id"], str):
        return False, "state-cycle_id"
    if not _finite_json(state):
        return False, "state-nonfinite"
    return True, "ok"


def build_request(state):
    return {"model": MODEL, "questions": build_questions(),
            "state": state, "user": "miro-jev-sidecar"}


def finite_prob(x):
    return type(x) in (int, float) and math.isfinite(x) and 0.0 <= x <= 1.0


def validate_response(resp):
    if not isinstance(resp, dict):
        return None, "response-not-object"
    if resp.get("model") != REVISION:
        return None, "wrong-revision"
    if resp.get("provider") != PROVIDER:
        return None, "wrong-provider"
    ans = resp.get("answers")
    if not isinstance(ans, dict):
        return None, "answers-not-object"
    if set(ans) != {"enter", "edge_family", "conviction", "latent_risk"}:
        return None, "answers-keys"
    try:
        e = ans["enter"]
        l = ans["latent_risk"]
        f = ans["edge_family"]
        c = ans["conviction"]
        if not isinstance(e, dict) or set(e) != {"type", "noul"} or \
                e["type"] != "noul" or not finite_prob(e["noul"]):
            return None, "enter-shape"
        if not isinstance(l, dict) or set(l) != {"type", "noul"} or \
                l["type"] != "noul" or not finite_prob(l["noul"]):
            return None, "latent-shape"
        # Exact C++ boundary mirror (B7): allowed keys, bounded family map,
        # finite numerics only. The sidecar must never accept an artifact
        # the kernel would reject.
        if not isinstance(f, dict):
            return None, "family-shape"
        if set(f) - {"type", "choice", "probabilities", "confidence"}:
            return None, "family-shape"
        if f.get("type") != "choice" or f.get("choice") not in FAMILIES:
            return None, "family-shape"
        pr = f.get("probabilities", {})
        if not isinstance(pr, dict) or len(pr) > 4:
            return None, "family-shape"
        for k, v in pr.items():
            if k not in FAMILIES or not finite_prob(v):
                return None, "family-shape"
        if "confidence" in f:
            # Presence matters: explicit null is REJECTED, matching the C++
            # boundary (checkconf requires a number). Absence means unknown.
            cf = f["confidence"]
            if type(cf) not in (int, float) or not math.isfinite(cf):
                return None, "family-shape"
        if not isinstance(c, dict):
            return None, "conviction-shape"
        if set(c) - {"type", "score", "confidence"}:
            return None, "conviction-shape"
        if c.get("type") != "score" or c.get("score") not in CONVICTIONS:
            return None, "conviction-shape"
        if "confidence" in c:
            cf = c["confidence"]
            if type(cf) not in (int, float) or not math.isfinite(cf):
                return None, "conviction-shape"
    except (KeyError, TypeError):
        return None, "answers-incomplete"
    clean = {"enter": {"type": "noul", "noul": e["noul"]},
             "edge_family": {"type": "choice", "choice": f["choice"],
                             "probabilities": f.get("probabilities", {})},
             "conviction": {"type": "score", "score": c["score"]},
             "latent_risk": {"type": "noul", "noul": l["noul"]}}
    if "confidence" in f:
        clean["edge_family"]["confidence"] = f["confidence"]
    if "confidence" in c:
        clean["conviction"]["confidence"] = c["confidence"]
    return clean, "ok"


def sign_answerset(payload):
    seed, pub = load_keypair()  # raises KeyMaterialError: caller HOLDs
    msg = canon(payload).encode()
    return {"payload": payload, "response_hash": sha256_hex(canon(payload)),
            "signature": ed_sign(seed, msg).hex(), "pubkey": pub.hex()}


def verify_answerset(artifact):
    """Crypto verification against the CONFIGURED trust anchor (B5).
    artifact["pubkey"] is informational metadata only: a foreign keypair
    with a matching self-attested pubkey field never verifies."""
    try:
        msg = canon(artifact["payload"]).encode()
        sig = bytes.fromhex(artifact["signature"])
        pub = load_pubkey()
    except (KeyError, ValueError, KeyMaterialError):
        return False
    if len(sig) != 64:
        return False
    if sha256_hex(canon(artifact["payload"])) != artifact.get("response_hash"):
        return False
    return ed_verify(pub, msg, sig)


# ---- cache ----
def feature_ids(state):
    feats = state.get("features", [])
    return sorted(f.get("feature_id", "?") for f in feats
                  if isinstance(f, dict))


def feature_revision(state):
    return sha256_hex(",".join(feature_ids(state)))


def research_key(state):
    return "|".join([state.get("symbol", "?"),
                     str(state.get("indicators", {}).get("regime", "?")),
                     str(state.get("research_revision", "?")),
                     ",".join(feature_ids(state)), QVERSION])


def decision_key(state):
    ind = state.get("indicators", {})
    pf = state.get("portfolio", {})
    ew = state.get("event_window", {})
    parts = [state.get("symbol", "?"), str(state.get("snapshot_epoch", "?")),
             str(ind.get("price_return_bucket", "?")),
             str(state.get("spread_bps", "?")),
             str(ind.get("atr_bucket", "?")), str(ind.get("zscore", "?")),
             str(ind.get("regime", "?")), str(ew.get("phase", "?")),
             str(pf.get("exposure_pct", "?")), feature_revision(state),
             str(state.get("research_revision", "?")), QVERSION]
    return sha256_hex("|".join(parts))


def protected_state(state):
    return {"stage": state.get("stage"),
            "risk_flags": state.get("risk_flags", {}),
            "event_blackout": state.get("event_window", {}).get("blackout")}


def validate_cached_artifact(state, c, now):
    """Strict cache admission (B6). Returns the artifact or None (miss).
    Every cached artifact re-proves the full contract: exact envelope
    shapes, pins, answers, finite timestamps with coherent
    created/expires/at semantics, configured-key signature, binding, age."""
    if not isinstance(c, dict):
        return None
    if set(c) != {"research_key", "decision_key", "protected",
                   "artifact", "at"}:
        return None
    try:
        if c.get("research_key") != research_key(state):
            return None
        if c.get("decision_key") != decision_key(state):
            return None
        if c.get("protected") != protected_state(state):
            return None
        at = c.get("at")
        # Finite only: NaN passes every comparison (at > now and
        # now - at > MAX are both False), so it must be rejected outright.
        if type(at) not in (int, float) or not math.isfinite(at):
            return None
        if at > now or now - at > ANSWER_MAX_AGE_S:
            return None  # future-dated or stale: miss, never a hit
        art = c.get("artifact")
        if not isinstance(art, dict):
            return None
        if set(art) != {"payload", "response_hash", "signature",
                         "pubkey"}:
            return None
        p = art.get("payload")
        if not isinstance(p, dict):
            return None
        if set(p) != {"schema_version", "question_set_version", "model",
                       "revision", "provider", "symbol",
                       "snapshot_epoch", "state_hash", "decision_key",
                       "created_at", "expires_at", "answers"}:
            return None
        try:
            created = datetime.fromisoformat(p["created_at"])
        except (ValueError, TypeError):
            return None
        if created.tzinfo is None:
            return None
        exp = p["expires_at"]
        if type(exp) not in (int, float) or not math.isfinite(exp):
            return None
        if exp != created.timestamp() + ANSWER_MAX_AGE_S:
            return None  # expiry must equal created + 60 s, exactly
        if exp <= now:
            return None  # signed artifact itself expired, even though
            # the cache wrapper `at` is still fresh: admission is about
            # the ANSWER's lifetime, not the wrapper's.
        if created.timestamp() > now + CLOCK_SKEW_S:
            return None  # created in the future beyond skew: miss
        if p.get("schema_version") != "answerset_v1":
            return None
        if p.get("question_set_version") != QVERSION:
            return None
        if p.get("model") != MODEL or p.get("revision") != REVISION:
            return None
        if p.get("provider") != PROVIDER:
            return None
        if p.get("symbol") != state.get("symbol"):
            return None
        if p.get("snapshot_epoch") != state.get("snapshot_epoch"):
            return None
        clean, why = validate_response({"model": REVISION,
                                        "provider": PROVIDER,
                                        "answers": p.get("answers")})
        if clean is None:
            return None
        if not verify_answerset(art):
            return None
        if not bind_check(art, state):
            return None
        return art
    except Exception:
        return None  # malformed cache never crashes the cycle


def cache_get(state, now):
    try:
        with open(os.path.join(
                CACHE_DIR, sha256_hex(research_key(state)) + ".json"),
                encoding="utf-8") as fh:
            c = json.load(fh)
    except (OSError, ValueError):
        return None
    try:
        return validate_cached_artifact(state, c, now)
    except Exception:
        return None


def cache_put(state, artifact, now):
    os.makedirs(CACHE_DIR, exist_ok=True)
    c = {"research_key": research_key(state),
         "decision_key": decision_key(state),
         "protected": protected_state(state),
         "artifact": artifact, "at": now}
    p = os.path.join(CACHE_DIR, sha256_hex(research_key(state)) + ".json")
    tmp = p + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(c, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)
    prune_cache(now)


def prune_cache(now, max_age_s=3600):
    """Bounded cache GC: drop unparseable or ancient files. Best-effort."""
    try:
        files = os.listdir(CACHE_DIR)
    except OSError:
        return
    for fn in files:
        if not fn.endswith(".json") or fn.endswith(".tmp"):
            continue
        p = os.path.join(CACHE_DIR, fn)
        try:
            with open(p, encoding="utf-8") as fh:
                at = json.load(fh).get("at", 0)
            stale = not isinstance(at, (int, float)) or now - at > max_age_s
        except (OSError, ValueError):
            stale = True
        if stale:
            try:
                os.remove(p)
            except OSError:
                pass


# ---- spend (fail-closed ledger, atomic reservation) ----
# Ledger integrity failure is UNKNOWN_SPEND: conservative/high, never $0.
# Recovery is human repair only (delete the corrupt day-file after
# reconciling against provider billing, or move it aside).
MAX_COST_USD = 100.0
MAX_TOKENS = 10 ** 7


def valid_ledger(s):
    if not isinstance(s, dict):
        return False
    if type(s.get("usd")) not in (int, float):
        return False
    if not math.isfinite(s["usd"]) or s["usd"] < 0:
        return False
    for k in ("calls", "prompt_tokens", "completion_tokens"):
        if type(s.get(k)) is not int or s[k] < 0:
            return False
    if "unknown_charges" in s and (type(s["unknown_charges"]) is not int
                                     or s["unknown_charges"] < 0):
        return False
    return True


def blank_ledger():
    return {"usd": 0.0, "calls": 0, "prompt_tokens": 0,
            "completion_tokens": 0, "unknown_charges": 0}


def _spend_path(day):
    return os.path.join(SPEND_DIR, day + ".json")


def _persist_ledger(s, p):
    tmp = p + f".tmp-{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(s, fh)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)


if os.name == "nt":
    import msvcrt
else:
    import fcntl


class _FileLock:
    """OS-native mutual exclusion on a lock FILE (stdlib only: fcntl on
    POSIX, msvcrt on Windows). The OS releases the lock on close even if
    the process dies, so there are NO stale locks and NO reclamation race:
    nothing to observe, remove, or steal. Blocking acquire with a deadline;
    TimeoutError on expiry."""
    def __init__(self, path, timeout=30.0):
        self.path = path
        self.timeout = timeout
        self.fh = None

    def __enter__(self):
        parent = os.path.dirname(self.path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        self.fh = open(self.path, "a+b")
        self.fh.seek(0)
        deadline = time.time() + self.timeout
        while True:
            try:
                if os.name == "nt":
                    msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(self.fh.fileno(),
                                fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except (OSError, IOError):
                if time.time() > deadline:
                    try:
                        self.fh.close()
                    except (OSError, ValueError):
                        pass
                    self.fh = None
                    raise TimeoutError("lock busy: " + self.path)
                time.sleep(0.05)

    def __exit__(self, *a):
        try:
            if os.name == "nt":
                self.fh.seek(0)
                msvcrt.locking(self.fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
        except (OSError, ValueError):
            pass
        try:
            self.fh.close()
        except (OSError, ValueError):
            pass
        self.fh = None
        return False


def _spend_lock(timeout=30.0):
    return _FileLock(os.path.join(SPEND_DIR, ".lockfile"), timeout)


# Writer's exact temp form: <day>.json.tmp-<pid>. Only this pattern (and
# the lockfile) may be ignored; every other non-day filename is UNKNOWN.
TMP_LEDGER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json\.tmp-\d+$")
DAY_LEDGER_RE = re.compile(r"^\d{4}-\d{2}-\d{2}\.json$")


def _day_of(now):
    """UTC day string for an epoch instant. The spend ledger is keyed
    by the DECISION clock, never wall clock: replay/test with an
    injected now must read and write the same day-file the live caller
    would have used at that instant."""
    return datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")


def spend_today(now=None):
    """Returns (ledger-or-None, path). None = UNKNOWN_SPEND (corrupt or
    schema-invalid): callers must fail closed, never treat as $0.
    An ABSENT day-file is a fresh day (blank ledger); a present-but-bad
    file is corruption. `now` is the authoritative decision instant
    (epoch); None means live wall clock."""
    now = now if now is not None else time.time()
    day = _day_of(now)
    p = _spend_path(day)
    try:
        with open(p, encoding="utf-8") as fh:
            s = json.load(fh)
    except FileNotFoundError:
        return blank_ledger(), p
    except (OSError, ValueError):
        return None, p
    if not valid_ledger(s):
        return None, p
    return s, p


def _reserve_now(now, cap=None):
    """Reserve one attempt AND the maximum authorized call charge.
    Caller MUST hold _spend_lock (see decide's money gate); the public
    spend_reserve() takes it for standalone use. The money reservation
    makes the stage cap a pre-call bound: authorization requires
    total_30d + MAX_AUTHORIZED_CALL_USD <= cap, so the ledger can never
    cross the cap from a single call whose actual cost is learned later.
    cap=None skips the money-cap check (legacy standalone tooling only;
    the decision path always passes its stage cap). A crash between
    reserve and settle overstates spend (fail-closed)."""
    s, p = spend_today(now)
    if s is None:
        return "unknown", None
    if s["calls"] >= DAILY_CALL_CEILING:
        return "ceiling", s
    if cap is not None:
        total, unknown = spend_30d(now)
        if unknown:
            return "unknown", None
        if total + MAX_AUTHORIZED_CALL_USD > cap:
            return "stage-cap", s
    s["calls"] += 1
    s["usd"] = round(s["usd"] + MAX_AUTHORIZED_CALL_USD, 8)
    _persist_ledger(s, p)
    return "ok", s


def spend_reserve(now=None, cap=None):
    """Atomically reserve ONE provider attempt BEFORE the network call.
    Returns (status, ledger-or-None): ok | ceiling | unknown | lock-busy.
    The increment is persisted inside the lock, so concurrent sidecars
    cannot both observe headroom (B4). `now` is the authoritative
    decision instant; None means live wall clock."""
    try:
        with _spend_lock():
            return _reserve_now(now if now is not None else time.time(),
                                cap)
    except TimeoutError:
        return "lock-busy", None


def validate_usage(usage):
    """Provider usage -> (cost, prompt_t, completion_t, known).
    Malformed/negative/non-finite money or token counts are never coerced:
    unknown cost poisons the money governor (S10), never silently $0."""
    u = usage if isinstance(usage, dict) else {}
    cost = u.get("cost", "unknown")
    pt = u.get("prompt_tokens", 0)
    ct = u.get("completion_tokens", 0)
    if cost is None or isinstance(cost, str):
        return 0.0, 0, 0, False
    if type(cost) not in (int, float) or not math.isfinite(cost):
        return 0.0, 0, 0, False
    if not (0.0 <= cost <= MAX_COST_USD):
        return 0.0, 0, 0, False
    for t in (pt, ct):
        if type(t) is not int or not (0 <= t <= MAX_TOKENS):
            return 0.0, 0, 0, False
    return float(cost), pt, ct, True


def _charge_now(cost, prompt_t=0, completion_t=0, known=True, now=None):
    """Charge money/tokens. Caller MUST hold _spend_lock; the public
    spend_charge() takes it for standalone use."""
    s, p = spend_today(now if now is not None else time.time())
    if s is None:
        return None
    if known:
        s["usd"] = round(s["usd"] + cost, 8)
        s["prompt_tokens"] += prompt_t
        s["completion_tokens"] += completion_t
    else:
        s["unknown_charges"] = s.get("unknown_charges", 0) + 1
    _persist_ledger(s, p)
    return s


def _settle_now(cost, prompt_t, completion_t, known, now):
    """Reconcile the pre-call reservation against the actual cost.
    Caller MUST hold _spend_lock. Returns (ledger-or-None, flag) where
    flag is "ok" | "pricing-violation" (actual exceeded the frozen
    maximum: charged in full AND unknown_charges tripped, so the governor
    holds until a human audits the repricing). Unknown cost refunds the
    reservation and trips unknown_charges (money spent but unpriced)."""
    s, p = spend_today(now)
    if s is None:
        return None, "unknown"
    if not known:
        s["usd"] = round(s["usd"] - MAX_AUTHORIZED_CALL_USD, 8)
        if s["usd"] < 0:
            return None, "unknown"
        s["unknown_charges"] = s.get("unknown_charges", 0) + 1
        _persist_ledger(s, p)
        return s, "ok"
    if cost > MAX_AUTHORIZED_CALL_USD:
        s["usd"] = round(s["usd"] + (cost - MAX_AUTHORIZED_CALL_USD), 8)
        s["prompt_tokens"] += prompt_t
        s["completion_tokens"] += completion_t
        s["unknown_charges"] = s.get("unknown_charges", 0) + 1
        _persist_ledger(s, p)
        return s, "pricing-violation"
    s["usd"] = round(s["usd"] + (cost - MAX_AUTHORIZED_CALL_USD), 8)
    if s["usd"] < 0:
        return None, "unknown"
    s["prompt_tokens"] += prompt_t
    s["completion_tokens"] += completion_t
    _persist_ledger(s, p)
    return s, "ok"


def _refund_now(now):
    """Release the money reservation after a failed provider call:
    nothing was spent, the attempt stays counted. Caller MUST hold lock."""
    s, p = spend_today(now)
    if s is None:
        return None
    s["usd"] = round(s["usd"] - MAX_AUTHORIZED_CALL_USD, 8)
    if s["usd"] < 0:
        return None
    _persist_ledger(s, p)
    return s


def spend_charge(cost, prompt_t=0, completion_t=0, known=True, now=None):
    """Record a completed call's money/tokens. NEVER increments calls:
    attempts are counted once, at reservation (B2). Unknown cost sets the
    unknown_charges flag that trips the money governor (B8)."""
    with _spend_lock():
        return _charge_now(cost, prompt_t, completion_t, known,
                           now if now is not None else time.time())


def spend_add(cost, prompt_t=0, completion_t=0):
    """Legacy entry point kept for tooling: charges money/tokens only
    (calls are reservation-counted). Prefer spend_charge()."""
    return spend_charge(cost, prompt_t, completion_t, known=True)


def spend_attempt():
    """Legacy entry point kept for tooling: reserves one attempt."""
    status, s = spend_reserve()
    return s if s is not None else blank_ledger()


def spend_30d(now=None):
    """Returns (total_usd, unknown). Out-of-window files are ignored
    without penalty; in-window corrupt/invalid files (or unknown charges
    in any in-window ledger) set unknown=True -> governor holds (S10).
    `now` is the authoritative decision instant (epoch); None means live
    wall clock. Totals include outstanding pre-call reservations: money
    reserved is money accounted, even before the provider bill arrives."""
    now = now if now is not None else time.time()
    today = datetime.fromtimestamp(now, timezone.utc).date()
    total, unknown = 0.0, False
    try:
        files = os.listdir(SPEND_DIR)
    except FileNotFoundError:
        return 0.0, False  # nothing ever spent: known-zero
    except OSError:
        return 0.0, True  # unreadable ledger dir: unknown
    for fn in files:
        if fn == ".lockfile" or TMP_LEDGER_RE.match(fn):
            continue  # exactly the permitted lock/temp forms, nothing more
        full = os.path.join(SPEND_DIR, fn)
        if os.path.isdir(full):
            if fn == ".lock":
                continue  # legacy mkdir-lock artifact, harmless
            unknown = True
            continue
        if not DAY_LEDGER_RE.match(fn):
            # A malformed ledger filename inside the spend directory must
            # NOT disappear from accounting: S10 unknown spend is
            # high/conservative, never silently $0.
            unknown = True
            continue
        try:
            day = datetime.strptime(fn[:-5], "%Y-%m-%d").date()
        except ValueError:
            unknown = True
            continue
        if not (0 <= (today - day).days <= 29):
            continue
        try:
            with open(os.path.join(SPEND_DIR, fn), encoding="utf-8") as fh:
                s = json.load(fh)
        except (OSError, ValueError):
            unknown = True
            continue
        if not valid_ledger(s):
            unknown = True
            continue
        if s.get("unknown_charges", 0):
            unknown = True
        total += s["usd"]
    return round(total, 8), unknown


def cost_tag(state, usage, category="decision"):
    _c, pt, ct, known = validate_usage(usage)
    return {"stage": state.get("stage"), "cycle_id": state.get("cycle_id"),
            "symbol": state.get("symbol"), "node": "jev", "model": REVISION,
            "prompt_tokens": pt if known else 0,
            "completion_tokens": ct if known else 0,
            "usd": _c if known else "unknown",
            "category": category}


# ---- provider call ----
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
TRANSIENT_HTTP = {408, 429, 500, 502, 503, 504}


def transient_error(err):
    """Retry exactly once ONLY for transient failures (B9). Auth, bad
    request, schema rejections, and unknown models never retry."""
    if err is None:
        return False
    if err.startswith("provider-http-"):
        try:
            return int(err.split("-")[-1]) in TRANSIENT_HTTP
        except ValueError:
            return False
    if err.startswith("provider-error:"):
        kind = err.split(":", 1)[1]
        return kind in ("Timeout", "TimeoutError", "ConnectionError",
                        "ConnectionResetError", "RemoteDisconnected",
                        "URLError", "socket", "timeout") or \
            "Timeout" in kind or "Connection" in kind
    return False


def post(body, key):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        ENDPOINT, data=data,
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            raw = r.read(MAX_RESPONSE_BYTES + 1)
            if len(raw) > MAX_RESPONSE_BYTES:
                return None, "provider-error:oversize-response"
            return json.loads(raw), None
    except urllib.error.HTTPError as e:
        return None, "provider-http-%d" % e.code
    except Exception as e:
        return None, "provider-error:%s" % type(e).__name__


def hold_row(state, reason, cost=0.0, cached=False, now=None):
    at = datetime.fromtimestamp(now if now is not None else time.time(),
                                timezone.utc).isoformat()
    return {"action": "HOLD", "reason": reason, "symbol": state.get("symbol"),
            "context_hash": state.get("context_hash"), "cost": cost,
            "cached": cached, "at": at}


CALL_LOG_MAX_BYTES = 8 * 1024 * 1024


def log_row(row):
    os.makedirs(os.path.dirname(CALL_LOG), exist_ok=True)
    with _FileLock(CALL_LOG + ".lock"):
        with open(CALL_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        try:
            if os.path.getsize(CALL_LOG) > CALL_LOG_MAX_BYTES:
                with open(CALL_LOG, "rb") as fh:
                    fh.seek(-CALL_LOG_MAX_BYTES // 2, os.SEEK_END)
                    tail = fh.read().split(b"\n", 1)[-1]
                # Crash-consistent rotation: temp + fsync + atomic rename.
                # An in-place "wb" rewrite could crash mid-write and leave
                # a partial call log; the log is spend/replay evidence.
                tmp = CALL_LOG + f".tmp-{os.getpid()}"
                with open(tmp, "wb") as fh:
                    fh.write(tail)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, CALL_LOG)
        except OSError:
            pass


MONEY_GATE_TIMEOUT = 60.0  # worst-case wait for the serialized money gate


def _money_gate(state, key, post_fn, now):
    """Runs with the spend lock HELD. Returns ("hold", row) or
    ("answer", answers, usage, ledger). Never raises on provider failure.
    The stage USD cap is a PRE-CALL bound: _reserve_now() authorizes only
    when total_30d + MAX_AUTHORIZED_CALL_USD fits inside the cap, and the
    reservation is reconciled (settled/refunded) on every path below, so a
    single call can never overshoot the cap from learning actual cost late."""
    cap = STAGE_30D_CAPS_USD[state["stage"]]  # stage already allowlisted
    total_30d, unknown_30d = spend_30d(now)
    if unknown_30d:
        row = hold_row(state, "spend-unknown", now=now)
        row["cost"] = cost_tag(state, None)
        log_row(row)
        return "hold", row
    if total_30d + MAX_AUTHORIZED_CALL_USD > cap:
        row = hold_row(state, "spend-stage-cap", now=now)
        row["cost"] = cost_tag(state, None)
        log_row(row)
        return "hold", row
    resp, err, attempts = None, "not-attempted", 0
    for attempt in range(2):
        # Lock held: attempt + money reservation enforced pre-call, with
        # the stage cap passed so authorization is absolute, not advisory.
        status, _ = _reserve_now(now, cap)
        if status == "ceiling":
            row = hold_row(state, "spend-call-ceiling", now=now)
            row["cost"] = cost_tag(state, None)
            log_row(row)
            return "hold", row
        if status == "stage-cap":
            row = hold_row(state, "spend-stage-cap", now=now)
            row["cost"] = cost_tag(state, None)
            log_row(row)
            return "hold", row
        if status == "unknown":
            row = hold_row(state, "spend-unknown", now=now)
            row["cost"] = cost_tag(state, None)
            log_row(row)
            return "hold", row
        if status == "lock-busy":
            row = hold_row(state, "spend-lock-busy", now=now)
            row["cost"] = cost_tag(state, None)
            log_row(row)
            return "hold", row
        if attempt:
            time.sleep(RETRY_DELAY_S)
        resp, err = post_fn(build_request(state), key)
        attempts += 1
        if err is None or not transient_error(err):
            break  # success, or non-retryable: exactly one attempt
        _refund_now(now)  # transient retry: release this attempt's money
        # reservation before re-reserving; the attempt stays counted.
    if err is not None:
        _refund_now(now)  # failed call spent nothing: release reservation.
        row = hold_row(state, "jev_error:" + err, now=now)
        row["cost"] = cost_tag(state, None)  # unknown cost, explicitly shown
        row["attempts"] = attempts
        log_row(row)
        return "hold", row
    answers, why = validate_response(resp)
    usage = resp.get("usage") if isinstance(resp, dict) else None
    cost, pt, ct, known = validate_usage(usage)
    # Money spent is money recorded, even when answers are unusable.
    # _settle_now reconciles the reservation against actual cost; a failed
    # settle is spend-unknown (HOLD), never a silent loss of accounting.
    spent, flag = _settle_now(cost, pt, ct, known, now)
    if spent is None:
        row = hold_row(state, "spend-unknown", now=now)
        row["cost"] = cost_tag(state, usage)
        log_row(row)
        return "hold", row
    if answers is None:
        row = hold_row(state, why, now=now)
        row["cost"] = cost_tag(state, resp.get("usage") if isinstance(resp, dict) else None)
        log_row(row)
        return "hold", row
    if flag == "pricing-violation":
        # Valid answers, but the provider repriced above the frozen maximum:
        # actual cost charged in full, governor tripped for human audit.
        # The answer must NOT become a reusable artifact on this path.
        row = hold_row(state, "pricing-violation", now=now)
        row["cost"] = cost_tag(state, usage)
        log_row(row)
        return "hold", row
    return "answer", answers, usage, spent


def decide(state, now=None, key=None, post_fn=None):
    '''Single decision cycle. Returns (row, artifact-or-None).
    Never raises on provider failure; never fabricates answers.
    `now` is the authoritative decision instant (epoch): spend ledgers,
    cache freshness, HOLD/audit timestamps, and artifact created_at all
    derive from it. None means live wall clock (production caller passes
    time.time()); replay/tests MUST inject a fixed instant so no wall
    clock consults the evidence path.'''
    now = now if now is not None else time.time()
    ok, why = validate_state(state)
    if not ok:
        row = hold_row(state if isinstance(state, dict) else {}, why,
                       now=now)
        log_row(row)
        return row, None
    hit = cache_get(state, now)
    if hit is not None:
        # validate_cached_artifact already proved shape, pins, answers,
        # configured-key signature, binding, age, AND that the signed
        # artifact itself has not expired: safe to serve.
        row = {"action": "CACHED", "answers": hit["payload"]["answers"],
               "symbol": state.get("symbol"), "cached": True,
               "at": datetime.fromtimestamp(now, timezone.utc).isoformat()}
        row["cost"] = cost_tag(state, {"cost": 0.0})
        log_row(row)
        return row, hit
    key = key if key is not None else api_key()
    if not key:
        row = hold_row(state, "jev_error:no-key", now=now)
        log_row(row)
        return row, None
    post_fn = post_fn or post
    # MONEY GATE (serialized): the 30-day USD authorization, the attempt
    # reservation, the provider call, and the charge all happen inside ONE
    # OS-lock hold. Checking the cap outside the lock lets two processes
    # both observe headroom and jointly overshoot; the call ceiling was
    # already safe (reservation-counted), the money cap was not. Signing
    # and caching happen AFTER release: crypto needs no money lock.
    # Lock ordering is spend -> call-log everywhere (log_row's lock is a
    # different file, always taken inside, never outside, the spend lock).
    try:
        with _spend_lock(timeout=MONEY_GATE_TIMEOUT):
            gate = _money_gate(state, key, post_fn, now)
    except TimeoutError:
        row = hold_row(state, "spend-lock-busy", now=now)
        row["cost"] = cost_tag(state, None)
        log_row(row)
        return row, None
    if gate[0] == "hold":
        return gate[1], None
    answers, usage, spent = gate[1], gate[2], gate[3]
    created = datetime.fromtimestamp(now, timezone.utc).isoformat()
    payload = {"schema_version": "answerset_v1",
               "question_set_version": QVERSION, "model": MODEL,
               "revision": REVISION, "provider": PROVIDER,
               "symbol": state.get("symbol"),
               "snapshot_epoch": state.get("snapshot_epoch"),
               "state_hash": sha256_hex(canon(state)),
               "decision_key": decision_key(state),
               "created_at": created,
               "expires_at": (datetime.fromisoformat(created)
                              .timestamp() + ANSWER_MAX_AGE_S),
               "answers": answers}
    try:
        artifact = sign_answerset(payload)
    except KeyMaterialError as e:
        row = hold_row(state, f"signing-key-unavailable:{e}", now=now)
        row["cost"] = cost_tag(state, usage)
        log_row(row)
        return row, None
    cache_put(state, artifact, now)
    row = {"action": "ANSWER", "answers": answers, "symbol": state.get("symbol"),
           "context_hash": state.get("context_hash"), "cached": False,
           "calls_day_total": spent["calls"],
           "calls_alert": spent["calls"] >= DAILY_CALL_ALERT,
           "spend_30d_usd": spend_30d(now)[0],
           "spend_unknown": spend_30d(now)[1],
           "at": created}
    row["cost"] = cost_tag(state, usage)
    # Authority boundary: answers only. No size, no budget, no order fields.
    log_row(row)
    return row, artifact


def bind_check(artifact, state):
    """Explicit state binding at the artifact boundary: the AnswerSet is
    only valid FOR this exact canonical state. C++ performs this comparison
    before trusting anything inside."""
    try:
        p = artifact["payload"]
    except (KeyError, TypeError):
        return False
    return (p.get("state_hash") == sha256_hex(canon(state))
            and p.get("decision_key") == decision_key(state))


def replay(artifact_path):
    '''Zero-network replay: full-contract verification + downstream input.'''
    try:
        with open(artifact_path, encoding="utf-8") as fh:
            artifact = json.load(fh)
    except (OSError, ValueError):
        return {"action": "HOLD", "reason": "replay-unreadable"}
    if not isinstance(artifact, dict):
        return {"action": "HOLD", "reason": "replay-shape"}
    p = artifact.get("payload")
    if not isinstance(p, dict):
        return {"action": "HOLD", "reason": "replay-shape"}
    if not verify_answerset(artifact):
        return {"action": "HOLD", "reason": "signature-failure"}
    if p.get("schema_version") != "answerset_v1":
        return {"action": "HOLD", "reason": "wrong-schema"}
    if p.get("revision") != REVISION or p.get("provider") != PROVIDER:
        return {"action": "HOLD", "reason": "wrong-revision"}
    if p.get("question_set_version") != QVERSION:
        return {"action": "HOLD", "reason": "wrong-qversion"}
    if p.get("model") != MODEL:
        return {"action": "HOLD", "reason": "wrong-model"}
    clean, why = validate_response({"model": REVISION, "provider": PROVIDER,
                                    "answers": p.get("answers")})
    if clean is None:
        return {"action": "HOLD", "reason": why}
    return {"action": "ANSWER", "answers": clean,
            "state_hash": p["state_hash"], "replayed": True}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--replay":
        print(json.dumps(replay(sys.argv[2]), indent=1))
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--keygen":
        # Explicit bootstrap: creates identity once, never overwrites.
        try:
            _, pub = keypair()
        except FileExistsError as e:
            print(f"refusing: {e}", file=sys.stderr)
            return 1
        print(json.dumps({
            "pubkey": pub.hex(),
            "fingerprint": sha256_hex(pub.hex()),
            "path": KEY_PATH}))
        return
    state = json.load(sys.stdin)
    row, _ = decide(state)
    print(json.dumps(row, indent=1))


if __name__ == "__main__":
    main()
