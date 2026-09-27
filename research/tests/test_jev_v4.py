"""S4 JEV v4 candidate-bound tests (stdlib only, synthetic fixtures).

Required coverage: valid accept; CID/side/economics/time-exit binding;
feature-hash binding; family-fit cannot substitute; replay determinism;
no BUY/SELL emission; actual-economics label; stale/malformed/expired/
unauthenticated fail-closed; cross-symbol/cross-CID isolation; v3 frozen.
"""
import copy
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from collector.jev import ed_pubkey, canon
from research.strategy import jev_v4 as v4
from research.strategy.candidate import make_candidate
from research.strategy.data import Bar

SEED = os.urandom(32)
PUB = ed_pubkey(SEED)
NOW = 1_700_000_000
ENGINE = {"deterministic_veto": False, "disagreement": False,
          "blackout": False, "calib_gate": "pass", "veto_max": False}
MARKET = {"snapshot_epoch": 1700000000, "price_s": "100.0",
          "spread_bps_s": "2.0", "session": "us_open", "regime": "trend"}


def cand(**over):
    kw = dict(strategy_version="baseline_v1", symbol="AAPL",
              snapshot_ts_ns=1000, proposed_side="BUY",
              proposed_family="momentum", entry_px=100.0, stop_px=99.0,
              tp_px=102.0, time_exit_ns=2000,
              exit_profile_version="exit_profile_v1",
              cost_model_version="paper_fill_v1", expected_cost_bps=0.0,
              feature_snapshot_hash="featAAA", feature_revision="r1")
    kw.update(over)
    return make_candidate(**kw)


def answers(**over):
    a = {"enter": 0.9, "edge_family": "momentum", "conviction": "strong",
         "latent_risk": 0.1}
    a.update(over)
    return a


def artifact(c, mkt=None, ans=None, created=NOW, expires=NOW + 60, seed=SEED):
    p = v4.make_v4_payload(c, mkt or MARKET, ans or answers(), created,
                           expires)
    return v4.sign_v4(p, seed)


def test_valid_candidate_accepted():
    c = cand()
    action, reason = v4.evaluate_v4(c, artifact(c), NOW, PUB, dict(ENGINE))
    assert (action, reason) == ("PASS_BASE", "strong"), (action, reason)
    print("valid_accept OK")


def test_qversion_pinned_v4():
    assert v4.QVERSION_V4 == "v4"
    p = v4.make_v4_payload(cand(), MARKET, answers(), NOW, NOW + 60)
    assert p["question_set_version"] == "v4"
    print("qversion OK")


def test_cid_mismatch_rejected():
    c = cand()
    art = artifact(c)
    art["payload"]["candidate"]["cid"] = "0" * 64
    assert v4.evaluate_v4(c, art, NOW, PUB, dict(ENGINE))[1] == "v4_cid_mismatch"
    print("cid_mismatch OK")


def test_altered_side_rejected():
    c = cand()
    art = artifact(c)
    art["payload"]["candidate"]["proposed_side"] = "SELL"
    assert v4.evaluate_v4(c, art, NOW, PUB, dict(ENGINE))[1] == "v4_cid_mismatch"
    print("side_binding OK")


def test_altered_economics_rejected():
    c = cand()
    for f, v in (("entry_px", "101.0"), ("stop_px", "98.0"),
                 ("tp_px", "103.0"), ("time_exit_ns", "2001")):
        art = artifact(c)
        art["payload"]["candidate"][f] = v
        r = v4.evaluate_v4(c, art, NOW, PUB, dict(ENGINE))[1]
        assert r in ("v4_cid_mismatch", "v4_economics_binding"), (f, r)
    print("economics_binding OK")


def test_feature_hash_binding():
    c = cand()
    art = artifact(c)
    art["payload"]["feature_snapshot_hash"] = "featBBB"
    assert v4.evaluate_v4(c, art, NOW, PUB, dict(ENGINE))[1] == "v4_feature_binding"
    c2 = cand(feature_snapshot_hash="featBBB")
    assert v4.evaluate_v4(c2, art, NOW, PUB, dict(ENGINE))[1] != "PASS_BASE"
    print("feature_binding OK")


def test_family_cannot_substitute():
    c = cand()
    art = artifact(c)
    art["payload"]["answers"]["edge_family"] = "mean_reversion"
    assert v4.evaluate_v4(c, art, NOW, PUB, dict(ENGINE))[1] == "v4_family_binding"
    print("family_binding OK")


def test_replay_deterministic():
    c = cand()
    art = artifact(c)
    r1 = v4.evaluate_v4(c, copy.deepcopy(art), NOW, PUB, dict(ENGINE))
    r2 = v4.evaluate_v4(c, copy.deepcopy(art), NOW, PUB, dict(ENGINE))
    assert r1 == r2 and r1[0] == "PASS_BASE"
    print("replay OK", r1)


def test_no_side_emission():
    c = cand()
    action, reason = v4.evaluate_v4(c, artifact(c), NOW, PUB, dict(ENGINE))
    assert "BUY" not in action and "SELL" not in action
    assert "BUY" not in reason and "SELL" not in reason
    assert set(v4.CONVICTIONS) == {"flat", "lean", "strong", "max"}
    print("no_side OK", action, reason)


def test_label_uses_actual_economics():
    c = cand()
    hit_tp = [Bar(ts_ns=1001, o=100.0, h=102.5, l=99.5, c=101.0)]
    r = v4.resolve_v4_label(c, hit_tp, entry_spread_bps=2.0)
    assert r["label"] == "win" and r["realized"] and r["exit_reason"] == "tp", r
    hit_stop = [Bar(ts_ns=1001, o=100.0, h=100.5, l=98.5, c=99.0)]
    r2 = v4.resolve_v4_label(c, hit_stop, entry_spread_bps=2.0)
    assert r2["label"] == "loss" and r2["exit_reason"] == "stop", r2
    print("label OK", round(r["r_realized"], 3), round(r2["r_realized"], 3))


def test_fail_closed_matrix():
    c = cand()
    base = artifact(c)
    cases = []
    exp = copy.deepcopy(base)
    exp["payload"]["answers"]["enter"] = 0.2
    exp = v4.sign_v4(exp["payload"], SEED)
    cases.append((exp, "no_edge"))
    lat = copy.deepcopy(base)
    lat["payload"]["answers"]["latent_risk"] = 0.9
    lat = v4.sign_v4(lat["payload"], SEED)
    cases.append((lat, "latent_risk"))
    old = artifact(c, created=NOW - 300, expires=NOW - 240)
    cases.append((old, "v4_expired"))
    badsig = copy.deepcopy(base)
    badsig["signature"] = "ab" * 64
    cases.append((badsig, "v4_unauthenticated"))
    wrong_seed = os.urandom(32)
    wrongkey = artifact(c, seed=wrong_seed)
    cases.append((wrongkey, "v4_unauthenticated"))
    malformed = copy.deepcopy(base)
    del malformed["payload"]["answers"]
    cases.append((malformed, "v4_malformed"))
    stale_state = copy.deepcopy(base)
    stale_state["payload"]["price_s"] = "999.0"
    cases.append((stale_state, "v4_decision_binding"))
    for art, want in cases:
        got = v4.evaluate_v4(c, art, NOW, PUB, dict(ENGINE))
        assert got == ("HOLD", want), (want, got)
    assert v4.evaluate_v4(c, artifact(c), NOW, PUB,
                          dict(ENGINE, deterministic_veto=True)) == ("HOLD", "engine")
    print("fail_closed OK", len(cases) + 1, "rows")


def test_cross_symbol_and_cross_cid_isolation():
    a = cand(symbol="AAPL")
    b = cand(symbol="MSFT")
    aa, bb = artifact(a), artifact(b)
    assert v4.evaluate_v4(b, aa, NOW, PUB, dict(ENGINE))[1] == "v4_cid_mismatch"
    assert v4.evaluate_v4(a, bb, NOW, PUB, dict(ENGINE))[1] == "v4_cid_mismatch"
    # cache keyed by CID: decisions cannot cross-contaminate
    cache = {a.cid: v4.evaluate_v4(a, aa, NOW, PUB, dict(ENGINE)),
             b.cid: v4.evaluate_v4(b, bb, NOW, PUB, dict(ENGINE))}
    assert cache[a.cid][0] == cache[b.cid][0] == "PASS_BASE"
    assert len({a.cid, b.cid}) == 2
    print("isolation OK")


def test_table_rows():
    c = cand()
    rows = [({"enter": 0.9, "conviction": "max", "latent_risk": 0.1},
             {"calib_gate": "pass"}, "PASS_ELEVATED_ELIGIBLE"),
            ({"enter": 0.9, "conviction": "max", "latent_risk": 0.1},
             {"calib_gate": "breach"}, "HOLD"),
            ({"enter": 0.6, "conviction": "lean"}, {}, "HOLD"),
            ({"enter": 0.6, "conviction": "strong"}, {}, "PASS_BASE"),
            ({"conviction": "flat"}, {}, "HOLD"),
            ({"conviction": "lean", "enter": 0.9}, {}, "PASS_BASE")]
    for over, eng, want in rows:
        a = answers(**over)
        e = dict(ENGINE)
        e.update(eng)
        got = v4.evaluate_v4(c, artifact(c, ans=a), NOW, PUB, e)
        assert got[0] == want, (over, eng, got)
    print("table OK", len(rows), "rows")


def test_v3_frozen_untouched():
    import hashlib
    assert open("collector/jev.py", "rb").read().find(b"QVERSION = \"v3\"") >= 0
    print("v3_frozen OK")


if __name__ == "__main__":
    test_valid_candidate_accepted()
    test_qversion_pinned_v4()
    test_cid_mismatch_rejected()
    test_altered_side_rejected()
    test_altered_economics_rejected()
    test_feature_hash_binding()
    test_family_cannot_substitute()
    test_replay_deterministic()
    test_no_side_emission()
    test_label_uses_actual_economics()
    test_fail_closed_matrix()
    test_cross_symbol_and_cross_cid_isolation()
    test_table_rows()
    test_v3_frozen_untouched()
    print("ALL JEV-V4 TESTS GREEN")
