"""JEV filter candidate-bound tests (stdlib only, synthetic fixtures).

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
from research.strategy import jev_filter as jf
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
    p = jf.make_payload(c, mkt or MARKET, ans or answers(), created,
                           expires)
    return jf.sign(p, seed)


def test_valid_candidate_accepted():
    c = cand()
    action, reason = jf.evaluate(c, artifact(c), NOW, PUB, dict(ENGINE))
    assert (action, reason) == ("PASS_BASE", "strong"), (action, reason)
    print("valid_accept OK")


def test_contract_tag_pinned():
    assert jf.CONTRACT == "jev"
    p = jf.make_payload(cand(), MARKET, answers(), NOW, NOW + 60)
    assert p["contract"] == "jev"
    print("qversion OK")


def test_cid_mismatch_rejected():
    c = cand()
    art = artifact(c)
    art["payload"]["candidate"]["cid"] = "0" * 64
    assert jf.evaluate(c, art, NOW, PUB, dict(ENGINE))[1] == "cid_mismatch"
    print("cid_mismatch OK")


def test_altered_side_rejected():
    c = cand()
    art = artifact(c)
    art["payload"]["candidate"]["proposed_side"] = "SELL"
    assert jf.evaluate(c, art, NOW, PUB, dict(ENGINE))[1] == "cid_mismatch"
    print("side_binding OK")


def test_altered_economics_rejected():
    c = cand()
    for f, v in (("entry_px", "101.0"), ("stop_px", "98.0"),
                 ("tp_px", "103.0"), ("time_exit_ns", "2001")):
        art = artifact(c)
        art["payload"]["candidate"][f] = v
        r = jf.evaluate(c, art, NOW, PUB, dict(ENGINE))[1]
        assert r in ("cid_mismatch", "economics_binding"), (f, r)
    print("economics_binding OK")


def test_feature_hash_binding():
    c = cand()
    art = artifact(c)
    art["payload"]["feature_snapshot_hash"] = "featBBB"
    assert jf.evaluate(c, art, NOW, PUB, dict(ENGINE))[1] == "feature_binding"
    c2 = cand(feature_snapshot_hash="featBBB")
    assert jf.evaluate(c2, art, NOW, PUB, dict(ENGINE))[1] != "PASS_BASE"
    print("feature_binding OK")


def test_family_cannot_substitute():
    c = cand()
    art = artifact(c)
    art["payload"]["answers"]["edge_family"] = "mean_reversion"
    assert jf.evaluate(c, art, NOW, PUB, dict(ENGINE))[1] == "family_binding"
    print("family_binding OK")


def test_replay_deterministic():
    c = cand()
    art = artifact(c)
    r1 = jf.evaluate(c, copy.deepcopy(art), NOW, PUB, dict(ENGINE))
    r2 = jf.evaluate(c, copy.deepcopy(art), NOW, PUB, dict(ENGINE))
    assert r1 == r2 and r1[0] == "PASS_BASE"
    print("replay OK", r1)


def test_no_side_emission():
    c = cand()
    action, reason = jf.evaluate(c, artifact(c), NOW, PUB, dict(ENGINE))
    assert "BUY" not in action and "SELL" not in action
    assert "BUY" not in reason and "SELL" not in reason
    assert set(jf.CONVICTIONS) == {"flat", "lean", "strong", "max"}
    print("no_side OK", action, reason)


def test_label_uses_actual_economics():
    c = cand()
    hit_tp = [Bar(ts_ns=1001, o=100.0, h=102.5, l=99.5, c=101.0)]
    r = jf.resolve_label(c, hit_tp, entry_spread_bps=2.0)
    assert r["label"] == "win" and r["realized"] and r["exit_reason"] == "tp", r
    hit_stop = [Bar(ts_ns=1001, o=100.0, h=100.5, l=98.5, c=99.0)]
    r2 = jf.resolve_label(c, hit_stop, entry_spread_bps=2.0)
    assert r2["label"] == "loss" and r2["exit_reason"] == "stop", r2
    print("label OK", round(r["r_realized"], 3), round(r2["r_realized"], 3))


def test_fail_closed_matrix():
    c = cand()
    base = artifact(c)
    cases = []
    exp = copy.deepcopy(base)
    exp["payload"]["answers"]["enter"] = 0.2
    exp = jf.sign(exp["payload"], SEED)
    cases.append((exp, "no_edge"))
    lat = copy.deepcopy(base)
    lat["payload"]["answers"]["latent_risk"] = 0.9
    lat = jf.sign(lat["payload"], SEED)
    cases.append((lat, "latent_risk"))
    old = artifact(c, created=NOW - 300, expires=NOW - 240)
    cases.append((old, "expired"))
    badsig = copy.deepcopy(base)
    badsig["signature"] = "ab" * 64
    cases.append((badsig, "unauthenticated"))
    wrong_seed = os.urandom(32)
    wrongkey = artifact(c, seed=wrong_seed)
    cases.append((wrongkey, "unauthenticated"))
    malformed = copy.deepcopy(base)
    del malformed["payload"]["answers"]
    cases.append((malformed, "malformed"))
    stale_state = copy.deepcopy(base)
    stale_state["payload"]["price_s"] = "999.0"
    cases.append((stale_state, "decision_binding"))
    for art, want in cases:
        got = jf.evaluate(c, art, NOW, PUB, dict(ENGINE))
        assert got == ("HOLD", want), (want, got)
    assert jf.evaluate(c, artifact(c), NOW, PUB,
                          dict(ENGINE, deterministic_veto=True)) == ("HOLD", "engine")
    print("fail_closed OK", len(cases) + 1, "rows")


def test_cross_symbol_and_cross_cid_isolation():
    a = cand(symbol="AAPL")
    b = cand(symbol="MSFT")
    aa, bb = artifact(a), artifact(b)
    assert jf.evaluate(b, aa, NOW, PUB, dict(ENGINE))[1] == "cid_mismatch"
    assert jf.evaluate(a, bb, NOW, PUB, dict(ENGINE))[1] == "cid_mismatch"
    # cache keyed by CID: decisions cannot cross-contaminate
    cache = {a.cid: jf.evaluate(a, aa, NOW, PUB, dict(ENGINE)),
             b.cid: jf.evaluate(b, bb, NOW, PUB, dict(ENGINE))}
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
        got = jf.evaluate(c, artifact(c, ans=a), NOW, PUB, e)
        assert got[0] == want, (over, eng, got)
    print("table OK", len(rows), "rows")


def test_wire_type_parity():
    # Every JSON-type mismatch C++ rejects, Python must reject identically.
    c = cand()

    def signed_mut(fn):
        art = artifact(c)
        fn(art["payload"])
        return jf.sign(art["payload"], SEED)

    cases = [
        (lambda p: p["candidate"].update(entry_px=100.0)),
        (lambda p: p["candidate"].update(snapshot_ts_ns=1000)),
        (lambda p: p["answers"].update(enter="0.9")),
        (lambda p: p["answers"].update(enter=True)),
        (lambda p: p["answers"].update(latent_risk=0)),
        (lambda p: p.update(created_at="1700000000")),
        (lambda p: p.update(expires_at=NOW + 60.0)),
        (lambda p: p.update(snapshot_epoch="1700000000")),
        (lambda p: p.update(price_s=100.0)),
        (lambda p: p["answers"].update(conviction=3)),
    ]
    for i, fn in enumerate(cases):
        got = jf.evaluate(c, signed_mut(fn), NOW, PUB, dict(ENGINE))
        assert got == ("HOLD", "malformed"), (i, got)
    # int-valued enter/latent are NOT valid (C++ NUM-double branch only).
    bad_int = signed_mut(lambda p: p["answers"].update(enter=1))
    assert jf.evaluate(c, bad_int, NOW, PUB, dict(ENGINE)) == \
        ("HOLD", "malformed")
    print("wire_parity OK", len(cases) + 1, "rejections")


def test_exact_sixty_expiry():
    c = cand()

    def signed_at(created, expires):
        return jf.sign(jf.make_payload(c, MARKET, answers(), created,
                                            expires), SEED)

    assert jf.evaluate(c, signed_at(NOW, NOW + 60), NOW, PUB,
                          dict(ENGINE))[0] == "PASS_BASE"
    for delta in (59, 61, 3600, 0):
        got = jf.evaluate(c, signed_at(NOW, NOW + delta), NOW, PUB,
                             dict(ENGINE))
        assert got == ("HOLD", "malformed"), (delta, got)
    old = signed_at(NOW - 300, NOW - 240)  # exact +60, but elapsed
    assert jf.evaluate(c, old, NOW, PUB, dict(ENGINE)) == \
        ("HOLD", "expired")
    print("exact60 OK")


def test_int_domain_parity():
    # C++ ParseStrictUint domain: 0 <= v <= INT64_MAX, type-exact int.
    MX = 9223372036854775807
    assert jf._is_int(0) and jf._is_int(MX)
    assert not jf._is_int(-1) and not jf._is_int(MX + 1)
    assert not jf._is_int(True) and not jf._is_int(1.0)
    c = cand()

    def signed_mut(fn, rebalance=False):
        art = artifact(c)
        fn(art["payload"])
        if rebalance:
            art["payload"]["decision_key"] = \
                jf.decision_key(art["payload"])
        return jf.sign(art["payload"], SEED)

    bad = [lambda p: p.update(snapshot_epoch=-1),
           lambda p: p.update(created_at=-1, expires_at=59),
           lambda p: p.update(expires_at=-1),
           lambda p: p.update(snapshot_epoch=MX + 1),
           lambda p: p.update(created_at=MX + 1, expires_at=MX + 61),
           lambda p: p.update(expires_at=MX + 1)]
    for i, fn in enumerate(bad):
        got = jf.evaluate(c, signed_mut(fn), NOW, PUB, dict(ENGINE))
        assert got == ("HOLD", "malformed"), (i, got)
    ok = signed_mut(lambda p: p.update(snapshot_epoch=MX), rebalance=True)
    assert jf.evaluate(c, ok, NOW, PUB, dict(ENGINE))[0] == "PASS_BASE"
    fut = signed_mut(lambda p: p.update(created_at=MX - 60, expires_at=MX))
    assert jf.evaluate(c, fut, NOW, PUB, dict(ENGINE)) == \
        ("HOLD", "malformed")
    print("int_domain OK", len(bad) + 2, "cases")


def test_committed_vectors_agree():
    # Differential proof: every committed kernel/jev_vectors vector evaluates in
    # Python to exactly its expect.json verdict (C++ suite asserts the same).
    import json as _json
    from research.strategy.gen_jev_vectors import cand as _gcand
    vdir = os.path.join(os.path.dirname(__file__), "..", "..", "kernel",
                        "jev_vectors")
    by_name = {
        "valid_sell_pass": _gcand(proposed_side="SELL",
                                   proposed_family="mean_reversion",
                                   entry_px=100.0, stop_px=101.0,
                                   tp_px=98.0,
                                   feature_snapshot_hash="b" * 64),
        "execution_hold": _gcand(proposed_family="execution"),
        "cross_symbol": _gcand(symbol="MSFT"),
    }
    names = sorted(f[:-14] for f in os.listdir(vdir)
                   if f.endswith(".artifact.json"))
    assert len(names) >= 20, names
    for nm in names:
        art = _json.load(open(os.path.join(vdir, nm + ".artifact.json")))
        exp = _json.load(open(os.path.join(vdir, nm + ".expect.json")))
        candidate = by_name.get(nm, _gcand())
        pub = bytes.fromhex(exp["pubkey"])
        got = jf.evaluate(candidate, copy.deepcopy(art),
                             exp["now_unix"], pub, dict(exp["engine"]))
        assert (got[0], got[1]) == (exp["action"], exp["reason"]), \
            (nm, got, exp["action"], exp["reason"])
    print("vectors_agree OK", len(names), "vectors")


def test_label_cost_record():
    # Spread/cost inputs are part of the immutable evaluation record: the
    # same candidate yields different labels under different recorded
    # spreads, so S5 must bind the spread to the record, not the caller.
    c = cand()
    bars = [Bar(ts_ns=1001, o=100.0, h=100.5, l=99.5, c=100.1)]
    r_lo = jf.resolve_label(c, bars, entry_spread_bps=2.0)
    r_hi = jf.resolve_label(c, bars, entry_spread_bps=50.0)
    assert r_lo["r_realized"] != r_hi["r_realized"]
    rec_lo = {"cid": c.cid, "entry_spread_bps": 2.0,
              "r": r_lo["r_realized"], "label": r_lo["label"]}
    rec_hi = {"cid": c.cid, "entry_spread_bps": 50.0,
              "r": r_hi["r_realized"], "label": r_hi["label"]}
    assert rec_lo != rec_hi and rec_lo["cid"] == rec_hi["cid"]
    print("cost_record OK", round(r_lo["r_realized"], 4),
          round(r_hi["r_realized"], 4))


def test_sidecar_artifact_passes_filter():
    """Producer and evaluator agree: what the sidecar signs, the filter
    accepts (same key, same candidate, no shared test scaffolding)."""
    import tempfile
    from collector import jev
    tmp = tempfile.mkdtemp()
    jev.CACHE_DIR = os.path.join(tmp, "cache")
    jev.SPEND_DIR = os.path.join(tmp, "spend")
    jev.CALL_LOG = os.path.join(tmp, "calls.jsonl")
    jev.KEY_PATH = os.path.join(tmp, "keys", "k.json")
    _seed, pub = jev.keypair()
    c = cand()
    resp = {"model": jev.REVISION, "provider": jev.PROVIDER,
            "answers": {"enter": {"type": "noul", "noul": 0.9},
                        "edge_family": {"type": "choice",
                                        "choice": "momentum"},
                        "conviction": {"type": "score", "score": "strong"},
                        "latent_risk": {"type": "noul", "noul": 0.1}},
            "usage": {"cost": 0.00001}}
    state = jf.build_state(c, MARKET)
    row, art = jev.decide(state, now=float(NOW), key="k",
                          post_fn=lambda b, k: (resp, None))
    assert row["action"] == "ANSWER" and art is not None, row
    assert jf.evaluate(c, art, NOW, pub, dict(ENGINE)) == \
        ("PASS_BASE", "strong")
    other = cand(symbol="MSFT")
    assert jf.evaluate(other, art, NOW, pub, dict(ENGINE))[0] == "HOLD"
    print("sidecar_artifact OK")


if __name__ == "__main__":
    test_valid_candidate_accepted()
    test_contract_tag_pinned()
    test_cid_mismatch_rejected()
    test_altered_side_rejected()
    test_altered_economics_rejected()
    test_feature_hash_binding()
    test_family_cannot_substitute()
    test_replay_deterministic()
    test_no_side_emission()
    test_label_uses_actual_economics()
    test_fail_closed_matrix()
    test_wire_type_parity()
    test_exact_sixty_expiry()
    test_committed_vectors_agree()
    test_label_cost_record()
    test_int_domain_parity()
    test_cross_symbol_and_cross_cid_isolation()
    test_table_rows()
    test_sidecar_artifact_passes_filter()
    print("ALL JEV FILTER TESTS GREEN")
