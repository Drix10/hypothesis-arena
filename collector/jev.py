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
DAILY_CALL_CEILING = 5000
DAILY_CALL_ALERT = 2500
STAGE_30D_CAPS_USD = {"G0_PAPER": 150.0, "G1_TINY": 150.0,
                      "G2_SCALED": 400.0, "G3_FULL": 1000.0}
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
    for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
        line = line.strip()
        if line.startswith("OPENROUTER_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    return os.environ.get("OPENROUTER_API_KEY", "")


def canon(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


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
    os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
    try:
        kp = json.load(open(KEY_PATH, encoding="utf-8"))
        return bytes.fromhex(kp["seed"]), bytes.fromhex(kp["pub"])
    except (OSError, ValueError, KeyError):
        seed = os.urandom(32)
        pub = ed_pubkey(seed)
        fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump({"seed": seed.hex(), "pub": pub.hex()}, fh)
        return seed, pub


# ---- request / response ----
def build_questions():
    qs = {}
    for name, qtype, instructions, criteria in QUESTIONS:
        qs[name] = {"type": qtype, "instructions": instructions,
                    "criteria": criteria}
    return qs


def validate_state(state):
    if not isinstance(state, dict):
        return False, "state-not-object"
    for k in ("context_hash", "symbol", "stage"):
        if k not in state:
            return False, "state-missing:" + k
    if state.get("question_set_version", QVERSION) != QVERSION:
        return False, "state-qversion"
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
        if e["type"] != "noul" or not finite_prob(e["noul"]):
            return None, "enter-shape"
        if l["type"] != "noul" or not finite_prob(l["noul"]):
            return None, "latent-shape"
        if f["type"] != "choice" or f["choice"] not in FAMILIES:
            return None, "family-shape"
        if c["type"] != "score" or c["score"] not in CONVICTIONS:
            return None, "conviction-shape"
    except (KeyError, TypeError):
        return None, "answers-incomplete"
    clean = {"enter": {"type": "noul", "noul": e["noul"]},
             "edge_family": {"type": "choice", "choice": f["choice"],
                             "probabilities": f.get("probabilities", {})},
             "conviction": {"type": "score", "score": c["score"]},
             "latent_risk": {"type": "noul", "noul": l["noul"]}}
    if f.get("confidence") is not None:
        clean["edge_family"]["confidence"] = f["confidence"]
    if c.get("confidence") is not None:
        clean["conviction"]["confidence"] = c["confidence"]
    return clean, "ok"


def sign_answerset(payload):
    seed, pub = keypair()
    msg = canon(payload).encode()
    return {"payload": payload, "response_hash": sha256_hex(canon(payload)),
            "signature": ed_sign(seed, msg).hex(), "pubkey": pub.hex()}


def verify_answerset(artifact):
    try:
        msg = canon(artifact["payload"]).encode()
        sig = bytes.fromhex(artifact["signature"])
        pub = bytes.fromhex(artifact["pubkey"])
    except (KeyError, ValueError):
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


def cache_get(state, now):
    try:
        c = json.load(open(os.path.join(
            CACHE_DIR, sha256_hex(research_key(state)) + ".json"),
            encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if c.get("research_key") != research_key(state):
        return None
    if c.get("decision_key") != decision_key(state):
        return None
    if c.get("protected") != protected_state(state):
        return None
    if now - c.get("at", 0) > ANSWER_MAX_AGE_S:
        return None
    return c.get("artifact")


def cache_put(state, artifact, now):
    os.makedirs(CACHE_DIR, exist_ok=True)
    c = {"research_key": research_key(state),
         "decision_key": decision_key(state),
         "protected": protected_state(state),
         "artifact": artifact, "at": now}
    p = os.path.join(CACHE_DIR, sha256_hex(research_key(state)) + ".json")
    tmp = p + ".tmp"
    json.dump(c, open(tmp, "w"))
    os.replace(tmp, p)


# ---- spend ----
def spend_today():
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    p = os.path.join(SPEND_DIR, day + ".json")
    try:
        return json.load(open(p, encoding="utf-8")), p
    except (OSError, ValueError):
        return {"usd": 0.0, "calls": 0, "prompt_tokens": 0,
                "completion_tokens": 0}, p


def spend_add(cost, prompt_t=0, completion_t=0):
    os.makedirs(SPEND_DIR, exist_ok=True)
    s, p = spend_today()
    s["usd"] = round(s["usd"] + cost, 8)
    s["calls"] += 1
    s["prompt_tokens"] += prompt_t
    s["completion_tokens"] += completion_t
    json.dump(s, open(p, "w"))
    return s


def spend_30d():
    total = 0.0
    try:
        files = sorted(os.listdir(SPEND_DIR))[-30:]
    except OSError:
        return 0.0
    for fn in files:
        try:
            total += json.load(open(os.path.join(SPEND_DIR, fn),
                                    encoding="utf-8")).get("usd", 0.0)
        except (OSError, ValueError):
            pass
    return round(total, 8)


def cost_tag(state, usage, category="decision"):
    return {"stage": state.get("stage"), "cycle_id": state.get("cycle_id"),
            "symbol": state.get("symbol"), "node": "jev", "model": REVISION,
            "prompt_tokens": (usage or {}).get("prompt_tokens", 0),
            "completion_tokens": (usage or {}).get("completion_tokens", 0),
            "usd": (usage or {}).get("cost", "unknown"),
            "category": category}


# ---- provider call ----
def post(body, key):
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        ENDPOINT, data=data,
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"})
    try:
        return json.load(urllib.request.urlopen(req, timeout=TIMEOUT_S)), None
    except urllib.error.HTTPError as e:
        return None, "provider-http-%d" % e.code
    except Exception as e:
        return None, "provider-error:%s" % type(e).__name__


def hold_row(state, reason, cost=0.0, cached=False):
    return {"action": "HOLD", "reason": reason, "symbol": state.get("symbol"),
            "context_hash": state.get("context_hash"), "cost": cost,
            "cached": cached,
            "at": datetime.now(timezone.utc).isoformat()}


def log_row(row):
    os.makedirs(os.path.dirname(CALL_LOG), exist_ok=True)
    with open(CALL_LOG, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(row) + "\n")


def decide(state, now=None, key=None, post_fn=None):
    '''Single decision cycle. Returns (row, artifact-or-None).
    Never raises on provider failure; never fabricates answers.'''
    now = now if now is not None else time.time()
    ok, why = validate_state(state)
    if not ok:
        row = hold_row(state if isinstance(state, dict) else {}, why)
        log_row(row)
        return row, None
    hit = cache_get(state, now)
    if hit is not None:
        if not verify_answerset(hit):
            row = hold_row(state, "signature-failure")
            log_row(row)
            return row, None
        row = {"action": "CACHED", "answers": hit["payload"]["answers"],
               "symbol": state.get("symbol"), "cached": True,
               "at": datetime.now(timezone.utc).isoformat()}
        row["cost"] = cost_tag(state, {"cost": 0.0})
        log_row(row)
        return row, hit
    key = key if key is not None else api_key()
    if not key:
        row = hold_row(state, "jev_error:no-key")
        log_row(row)
        return row, None
    cap = STAGE_30D_CAPS_USD.get(state.get("stage"), 150.0)
    if spend_30d() >= cap:
        row = hold_row(state, "spend-stage-cap")
        row["cost"] = cost_tag(state, None)
        log_row(row)
        return row, None
    post_fn = post_fn or post
    resp, err, attempts = None, "not-attempted", 0
    for attempt in range(2):
        spent, _ = spend_today()
        if spent["calls"] >= DAILY_CALL_CEILING:
            row = hold_row(state, "spend-call-ceiling")
            row["cost"] = cost_tag(state, None)
            log_row(row)
            return row, None
        if attempt:
            time.sleep(RETRY_DELAY_S)
        attempts += 1
        resp, err = post_fn(build_request(state), key)
        if err is None:
            break
    if err is not None:
        row = hold_row(state, "jev_error:" + err)
        row["cost"] = cost_tag(state, None)  # unknown cost, explicitly shown
        row["attempts"] = attempts
        log_row(row)
        return row, None
    answers, why = validate_response(resp)
    if answers is None:
        row = hold_row(state, why)
        row["cost"] = cost_tag(state, resp.get("usage"))
        log_row(row)
        return row, None
    usage = resp.get("usage") or {}
    cost = float(usage.get("cost") or 0.0)
    spent = spend_add(cost, usage.get("prompt_tokens", 0),
                      usage.get("completion_tokens", 0))
    created = datetime.now(timezone.utc).isoformat()
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
    artifact = sign_answerset(payload)
    cache_put(state, artifact, now)
    row = {"action": "ANSWER", "answers": answers, "symbol": state.get("symbol"),
           "context_hash": state.get("context_hash"), "cached": False,
           "calls_day_total": spent["calls"],
           "calls_alert": spent["calls"] >= DAILY_CALL_ALERT,
           "spend_30d_usd": spend_30d(),
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
    '''Zero-network replay: verify + emit downstream input.'''
    artifact = json.load(open(artifact_path, encoding="utf-8"))
    if not verify_answerset(artifact):
        return {"action": "HOLD", "reason": "signature-failure"}
    p = artifact["payload"]
    if p.get("revision") != REVISION or p.get("provider") != PROVIDER:
        return {"action": "HOLD", "reason": "wrong-revision"}
    if p.get("question_set_version") != QVERSION:
        return {"action": "HOLD", "reason": "wrong-qversion"}
    return {"action": "ANSWER", "answers": p["answers"],
            "state_hash": p["state_hash"], "replayed": True}


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--replay":
        print(json.dumps(replay(sys.argv[2]), indent=1))
        return
    state = json.load(sys.stdin)
    row, _ = decide(state)
    print(json.dumps(row, indent=1))


if __name__ == "__main__":
    main()
