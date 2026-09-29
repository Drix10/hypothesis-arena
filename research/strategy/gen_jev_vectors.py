"""Generate committed cross-language JEV filter vectors (kernel/jev_vectors/*.json).

Stable test keypair (ephemeral seed; ONLY signatures + pubkey committed).
Each vector: artifact.json + expect.json {action, reason, engine, now,
expected_cid, expected_symbol, expected_fhash, pubkey}.
Python self-check: evaluate agrees with expect before writing.
"""
import copy
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from collector.jev import ed_pubkey
from research.strategy import jev_filter as jf
from research.strategy.candidate import make_candidate

SEED = bytes.fromhex("9f" * 32)
PUB = ed_pubkey(SEED).hex()
NOW = 1_700_000_000
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "kernel", "jev_vectors")
ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}


def cand(**over):
    kw = dict(strategy_version="baseline_v1", symbol="AAPL",
              snapshot_ts_ns=1000, proposed_side="BUY",
              proposed_family="momentum", entry_px=100.0, stop_px=99.0,
              tp_px=102.0, time_exit_ns=2000,
              exit_profile_version="exit_profile_v1",
              cost_model_version="paper_fill_v1", expected_cost_bps=0.0,
              feature_snapshot_hash="a" * 64, feature_revision="r1")
    kw.update(over)
    return make_candidate(**kw)


MARKET = {"snapshot_epoch": 1700000000, "price_s": "100.0",
          "spread_bps_s": "2.0", "session": "us_open", "regime": "trend"}


def answers(**over):
    a = {"enter": 0.9, "edge_family": "momentum", "conviction": "strong",
         "latent_risk": 0.1}
    a.update(over)
    return a


def base_art(c, ans=None, created=NOW, expires=NOW + 60, seed=SEED):
    return jf.sign(jf.make_payload(c, MARKET, ans or answers(),
                                        created, expires), seed)


def mutate(c, fn, ans=None, **kw):
    art = base_art(c, ans=ans, **kw)
    fn(art["payload"])
    return art


def smutate(c, fn, ans=None, **kw):
    """Re-signed mutation: reaches the targeted check instead of the sig."""
    art = base_art(c, ans=ans, **kw)
    fn(art["payload"])
    return jf.sign(art["payload"], SEED)


def rebind(c, fn, ans=None, **kw):
    """Re-signed AND decision-key-rebound mutation: fully valid artifact."""
    art = base_art(c, ans=ans, **kw)
    fn(art["payload"])
    art["payload"]["decision_key"] = jf.decision_key(art["payload"])
    return jf.sign(art["payload"], SEED)


VECTORS = []


def add(name, candidate, artifact, expect_action, expect_reason, engine=None):
    VECTORS.append((name, candidate, artifact, {
        "action": expect_action, "reason": expect_reason,
        "engine": engine or dict(ENGINE),
        "now_unix": NOW, "pubkey": PUB,
        "expected_cid": candidate.cid,
        "expected_symbol": candidate.symbol,
        "expected_fhash": candidate.feature_snapshot_hash}))


def build():
    c = cand()
    sell = cand(proposed_side="SELL", proposed_family="mean_reversion",
                entry_px=100.0, stop_px=101.0, tp_px=98.0,
                feature_snapshot_hash="b" * 64)
    exe = cand(proposed_family="execution")
    msft = cand(symbol="MSFT")
    add("valid_pass", c, base_art(c), "PASS_BASE", "strong")
    add("valid_sell_pass", sell, base_art(sell, ans=answers(edge_family="mean_reversion")), "PASS_BASE", "strong")
    add("max_elevated", c,
        base_art(c, ans=answers(conviction="max", enter=0.93,
                               latent_risk=0.1)),
        "PASS_ELEVATED_ELIGIBLE", "max_gate")
    add("cid_mismatch", c,
        mutate(c, lambda p: p["candidate"].update(cid="0" * 64)),
        "HOLD", "cid_mismatch")
    add("side_altered", c,
        mutate(c, lambda p: p["candidate"].update(proposed_side="SELL")),
        "HOLD", "cid_mismatch")
    add("entry_altered", c,
        mutate(c, lambda p: p["candidate"].update(entry_px="101.0")),
        "HOLD", "cid_mismatch")
    add("stop_altered", c,
        mutate(c, lambda p: p["candidate"].update(stop_px="98.0")),
        "HOLD", "cid_mismatch")
    add("timeexit_altered", c,
        mutate(c, lambda p: p["candidate"].update(time_exit_ns="2001")),
        "HOLD", "cid_mismatch")
    add("feature_binding", c,
        mutate(c, lambda p: p.update(feature_snapshot_hash="c" * 64)),
        "HOLD", "feature_binding")
    add("family_substitute", c,
        mutate(c, lambda p: p["answers"].update(edge_family="macro")),
        "HOLD", "family_binding")
    add("expired", c, base_art(c, created=NOW - 300, expires=NOW - 240),
        "HOLD", "expired")
    bad = base_art(c)
    bad["signature"] = "ab" * 64
    add("bad_signature", c, bad, "HOLD", "unauthenticated")
    add("execution_hold", exe,
        base_art(exe, ans=answers(edge_family="execution", enter=0.7)),
        "HOLD", "midband")
    add("no_edge", c, base_art(c, ans=answers(enter=0.2)),
        "HOLD", "no_edge")
    add("latent_hold", c,
        base_art(c, ans=answers(latent_risk=0.9)), "HOLD", "latent_risk")
    add("cross_symbol", msft, base_art(c), "HOLD", "cid_mismatch")
    add("type_field_number", c,
        smutate(c, lambda p: p["candidate"].update(entry_px=100.0)),
        "HOLD", "malformed")
    add("type_answer_string", c,
        smutate(c, lambda p: p["answers"].update(enter="0.9")),
        "HOLD", "malformed")
    add("type_answer_bool", c,
        smutate(c, lambda p: p["answers"].update(enter=True)),
        "HOLD", "malformed")
    add("type_created_string", c,
        smutate(c, lambda p: p.update(created_at="1700000000")),
        "HOLD", "malformed")
    add("type_epoch_string", c,
        smutate(c, lambda p: p.update(snapshot_epoch="1700000000")),
        "HOLD", "malformed")
    add("expiry_plus59", c,
        smutate(c, lambda p: p.update(expires_at=NOW + 59)),
        "HOLD", "malformed")
    add("expiry_plus61", c,
        smutate(c, lambda p: p.update(expires_at=NOW + 61)),
        "HOLD", "malformed")
    add("expiry_plus3600", c,
        smutate(c, lambda p: p.update(expires_at=NOW + 3600)),
        "HOLD", "malformed")
    MX = 9223372036854775807
    add("epoch_minus1", c,
        smutate(c, lambda p: p.update(snapshot_epoch=-1)),
        "HOLD", "malformed")
    add("created_minus1", c,
        smutate(c, lambda p: p.update(created_at=-1, expires_at=59)),
        "HOLD", "malformed")
    add("expires_minus1", c,
        smutate(c, lambda p: p.update(expires_at=-1)),
        "HOLD", "malformed")
    add("epoch_int64max", c,
        rebind(c, lambda p: p.update(snapshot_epoch=MX)),
        "PASS_BASE", "strong")  # MAX itself is a valid epoch
    add("epoch_int64max_plus1", c,
        smutate(c, lambda p: p.update(snapshot_epoch=MX + 1)),
        "HOLD", "malformed")
    add("created_int64max_plus1", c,
        smutate(c, lambda p: p.update(created_at=MX + 1,
                                      expires_at=MX + 61)),
        "HOLD", "malformed")
    add("expires_int64max_plus1", c,
        smutate(c, lambda p: p.update(expires_at=MX + 1)),
        "HOLD", "malformed")
    add("expiry_int64max_future", c,
        smutate(c, lambda p: p.update(created_at=MX - 60, expires_at=MX)),
        "HOLD", "malformed")  # exact +60, but far-future: both reject


def main():
    build()
    os.makedirs(OUT, exist_ok=True)
    pub = bytes.fromhex(PUB)
    n = 0
    for name, candidate, art, exp in VECTORS:
        got = jf.evaluate(candidate, copy.deepcopy(art), NOW, pub,
                             dict(exp["engine"]))
        assert (got[0], got[1]) == (exp["action"], exp["reason"]), \
            (name, got, exp)
        json.dump(art, open(os.path.join(OUT, name + ".artifact.json"),
                            "w"), indent=2, sort_keys=True)
        json.dump(exp, open(os.path.join(OUT, name + ".expect.json"),
                            "w"), indent=2, sort_keys=True)
        n += 1
    print(f"wrote {n} vectors to {OUT}")


if __name__ == "__main__":
    main()
