"""S3 candidate-contract isolation tests (c1 authority: candidate.py).

Seam under test: market data -> generator -> immutable Candidate -> JEV.
Proves JEV can neither originate nor mutate trade economics, and that
identity is deterministic, collision-free across authoritative fields,
and cache-safe. No JEV logic here (S4 NOT AUTHORIZED).
"""
import dataclasses
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy.candidate import (
    CANDIDATE_SCHEMA_VERSION, _ID_FIELDS, Candidate, candidate_id,
    make_candidate)


def base_kw(**over):
    kw = dict(strategy_version="baseline_v1", symbol="AAPL",
              snapshot_ts_ns=1000, proposed_side="BUY",
              proposed_family="momentum", entry_px=100.0, stop_px=99.0,
              tp_px=102.0, time_exit_ns=2000,
              exit_profile_version="exit_profile_v1",
              cost_model_version="paper_fill_v1", expected_cost_bps=0.0,
              feature_snapshot_hash="h", feature_revision="r1")
    kw.update(over)
    return kw


def test_schema_version_pinned():
    assert CANDIDATE_SCHEMA_VERSION == "c1"


def test_identical_inputs_identical_cid():
    a, b = make_candidate(**base_kw()), make_candidate(**base_kw())
    assert a.cid == b.cid and a == b
    assert candidate_id(**{f: base_kw()[f] for f in _ID_FIELDS}) == a.cid


def test_side_flip_distinct_cid():
    sell = base_kw(proposed_side="SELL", stop_px=101.0, tp_px=98.0)
    assert make_candidate(**base_kw()).cid != make_candidate(**sell).cid


def test_every_recipe_field_distinct():
    ref = make_candidate(**base_kw()).cid
    variants = dict(symbol="MSFT", snapshot_ts_ns=1001,
                    proposed_family="mean_reversion", entry_px=100.5,
                    stop_px=98.5, tp_px=102.5, time_exit_ns=2001,
                    strategy_version="baseline_v2",
                    exit_profile_version="exit_profile_v2",
                    cost_model_version="paper_fill_v2",
                    feature_revision="r2")
    for f in _ID_FIELDS:
        if f == "proposed_side":
            continue  # covered by test_side_flip_distinct_cid
        kw = base_kw(**{f: variants[f]})
        assert make_candidate(**kw).cid != ref, f"CID ignores {f}"


def test_non_recipe_fields_share_cid():
    # Contract premise (recorded question, not a change): expected_cost_bps
    # and feature_snapshot_hash ride along but do not enter identity.
    a = make_candidate(**base_kw())
    b = make_candidate(**base_kw(expected_cost_bps=4.0,
                                 feature_snapshot_hash="other"))
    assert a.cid == b.cid and a != b


def test_cid_unforgable():
    direct = Candidate(**base_kw())
    assert direct.cid == make_candidate(**base_kw()).cid
    assert direct.cid == candidate_id(**{f: base_kw()[f] for f in _ID_FIELDS})
    with pytest.raises(TypeError):
        Candidate(**base_kw(), cid="forged")
    print("cid_unforgable OK", direct.cid[:16])


def test_immutable_after_construction():
    c = make_candidate(**base_kw())
    with pytest.raises(dataclasses.FrozenInstanceError):
        c.entry_px = 999.0
    with pytest.raises(dataclasses.FrozenInstanceError):
        c.proposed_side = "SELL"
    assert c.entry_px == 100.0 and c.proposed_side == "BUY"


def test_malformed_rejected():
    bad = [base_kw(proposed_side="HOLD"),
           base_kw(stop_px=100.5),            # BUY stop above entry
           base_kw(tp_px=99.5),               # BUY tp below entry
           base_kw(entry_px=-1.0, stop_px=-2.0, tp_px=-0.5),
           base_kw(proposed_side="SELL", stop_px=99.0, tp_px=101.0)]
    for kw in bad:
        with pytest.raises(ValueError):
            make_candidate(**kw)


def test_omitted_authoritative_field_raises():
    kw = {f: base_kw()[f] for f in _ID_FIELDS if f != "stop_px"}
    with pytest.raises(KeyError):
        candidate_id(**kw)
    with pytest.raises(TypeError):
        Candidate(**{k: v for k, v in base_kw().items() if k != "stop_px"})


def test_cache_isolation_by_cid():
    buy = make_candidate(**base_kw())
    sell = make_candidate(**base_kw(proposed_side="SELL", stop_px=101.0,
                                    tp_px=98.0))
    cache = {buy.cid: ("PASS", buy.entry_px),
             sell.cid: ("HOLD", sell.entry_px)}
    assert len(cache) == 2
    assert cache[buy.cid][1] == 100.0 and cache[sell.cid][0] == "HOLD"
    # same symbol + timestamp, opposite economics: no cross-contamination
    assert cache[buy.cid] != cache[sell.cid]


def test_no_jev_coupling():
    src = open(os.path.join(os.path.dirname(__file__), "..", "strategy",
                            "candidate.py")).read()
    imports = [ln.strip() for ln in src.splitlines()
               if ln.strip().startswith(("import ", "from "))]
    assert not any("jev" in ln.lower() for ln in imports), imports


if __name__ == "__main__":
    test_schema_version_pinned()
    test_identical_inputs_identical_cid()
    test_side_flip_distinct_cid()
    test_every_recipe_field_distinct()
    test_non_recipe_fields_share_cid()
    test_immutable_after_construction()
    test_malformed_rejected()
    test_omitted_authoritative_field_raises()
    test_cid_unforgable()
    test_cache_isolation_by_cid()
    test_no_jev_coupling()
    print("ALL CANDIDATE TESTS GREEN")
