"""S6 tests: event_direction_v1 frozen interpretation table (stdlib only).

1 carried-positive 2 carried-negative 3 risk-axes+clash 4 neutral-only
5 conflict 6 missing-inputs 7 malformed-inputs 8 ts-ambiguity 9 duplicates
10 replay-determinism 11 unknown-never-directional 12 context-only
13 no-lookahead 14 boundary-ts 15 no-foreign-capability 16 table-pin
17 unmapped-source-kind 18 same-sig-contradiction 19 origin-evidence-gate
20 symbol-scope 21 unknown-aggregation 22 directional-neutral-mix.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)  # research/: plane/

from plane import event_direction as ed
from plane import schema

ASOF = 1_700_000_000_000_000_000
SYM = "AAPL"


def _obs(kind="macro_release", v="cpi:m/m:0.3", ts=None,
         source="fred_macro", pe=None, sym=SYM, origin="parser",
         evidence="source"):
    o = {"kind": kind, "value": {"type": "enum", "v": v},
         "observed_at_ns": ASOF if ts is None else ts,
         "source_id": source, "symbols": [sym],
         "origin": origin, "evidence": evidence}
    if pe is not None:
        o["parser_effect"] = pe
    return o


def test_1_carried_positive():
    r = ed.resolve([_obs(pe="bullish")], ASOF, SYM)
    assert r["effect"] == "bullish", r
    assert r["rows"] == ["carried"], r
    print("1 OK")


def test_2_carried_negative():
    r = ed.resolve([_obs(pe="bearish")], ASOF, SYM)
    assert r["effect"] == "bearish", r
    print("2 OK")


def test_3_risk_axes():
    hi = ed.resolve([_obs(pe="risk_up")], ASOF, SYM)
    assert hi["effect"] == "risk_up", hi
    lo = ed.resolve([_obs(pe="risk_down")], ASOF, SYM)
    assert lo["effect"] == "risk_down", lo
    clash = ed.resolve([_obs(v="a", pe="risk_up"),
                        _obs(v="b", pe="risk_down")], ASOF, SYM)
    assert clash["effect"] == "unknown", clash
    assert "conflict" in clash["reasons"], clash
    print("3 OK")


def test_4_neutral_only():
    # neutral exists ONLY as a carried parser attestation: an
    # uncarried calendar item is unknown, never manufactured neutral.
    cal = ed.resolve([_obs(kind="calendar_ahead", v="fomc:2026-10-28",
                           source="fed_monetary")], ASOF, SYM)
    assert cal["effect"] == "unknown", cal
    assert cal["rows"] == [], cal
    attest = ed.resolve([_obs(pe="neutral")], ASOF, SYM)
    assert attest["effect"] == "neutral", attest
    zero = ed.resolve([{"kind": "macro_release",
                        "value": {"type": "count", "v": 0},
                        "observed_at_ns": ASOF,
                        "source_id": "fred_macro", "symbols": [SYM],
                        "origin": "parser", "evidence": "source"}],
                      ASOF, SYM)
    assert zero["effect"] == "unknown", zero
    print("4 OK")


def test_5_conflict():
    r = ed.resolve([_obs(v="a", pe="bullish"),
                    _obs(v="b", pe="bearish")], ASOF, SYM)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["conflict"], r
    assert r["rows"] == [], r
    print("5 OK")


def test_6_missing_inputs():
    o = _obs()
    del o["value"]
    r = ed.resolve([o], ASOF, SYM)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["malformed-value"], r
    o2 = _obs()
    del o2["observed_at_ns"]
    r2 = ed.resolve([o2], ASOF, SYM)
    assert r2["effect"] == "unknown", r2
    o3 = _obs()
    del o3["origin"]
    r3 = ed.resolve([o3], ASOF, SYM)
    assert r3["reasons"] == ["malformed-origin"], r3
    print("6 OK")


def test_7_malformed_inputs():
    cases = [("unmapped-kind", dict(_obs(), kind="rumor")),
             ("malformed-vtype",
              dict(_obs(), value={"type": "float", "v": 1.5})),
             ("malformed-v",
              dict(_obs(), value={"type": "bool", "v": "yes"})),
             ("malformed-ts", dict(_obs(), observed_at_ns=-1)),
             ("malformed-parser-effect", _obs(pe="moon")),
             ("malformed-origin", _obs(origin="analyst")),
             ("malformed-evidence", _obs(evidence="vibes")),
             ("malformed-symbols", _obs(sym=None)),
             ("extra-fields", dict(_obs(), whatever_hidden_field=1))]
    for needle, o in cases:
        r = ed.resolve([o], ASOF, SYM)
        assert r["effect"] == "unknown", (needle, r)
        assert r["reasons"] == [needle], (needle, r)
    print("7 OK")


def test_8_ts_ambiguity():
    a = _obs(v="rev", ts=ASOF - 10)
    b = _obs(v="rev", ts=ASOF - 5)
    r = ed.resolve([a, b], ASOF, SYM)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["order-ambiguous-ts"], r
    # input order carries no information: permutation is identical.
    fwd = ed.resolve([_obs(v="x", pe="bullish"),
                      _obs(v="n", pe="neutral")], ASOF, SYM)
    rev = ed.resolve([_obs(v="n", pe="neutral"),
                      _obs(v="x", pe="bullish")], ASOF, SYM)
    assert fwd == rev and fwd["effect"] == "bullish", (fwd, rev)
    print("8 OK")


def test_9_duplicates():
    one = ed.resolve([_obs(pe="bullish")], ASOF, SYM)
    two = ed.resolve([_obs(pe="bullish"), _obs(pe="bullish")],
                     ASOF, SYM)
    assert two["effect"] == "bullish", two
    assert "duplicate-collapsed" in two["reasons"], two
    assert two["rows"] == one["rows"], (one, two)
    print("9 OK")


def test_10_replay_determinism():
    o = [_obs(v="x", pe="bullish"), _obs(v="x", pe="bullish")]
    assert ed.resolve(o, ASOF, SYM) == ed.resolve(o, ASOF, SYM)
    assert ed.resolve(o, ASOF, SYM) == \
        ed.resolve(list(reversed(o)), ASOF, SYM)
    print("10 OK")


def test_11_unknown_never_directional():
    for o in (_obs(v="never-mapped"),
              _obs(kind="filing_event", v="8-K:item-9.01",
                   source="edgar_8k"),
              _obs(kind="macro_release", v="revision:-0.2",
                   source="bea_nipa_gdp")):
        r = ed.resolve([o], ASOF, SYM)
        assert r["effect"] == "unknown", (o, r)
        assert r["rows"] == [], (o, r)
    print("11 OK")


def test_12_context_only():
    for eff in ("bullish", "bearish", "neutral", "unknown"):
        o = _obs(pe=eff) if eff != "unknown" else _obs(v="zzz-unmapped")
        r = ed.resolve([o], ASOF, SYM)
        assert r["classification"] == "CONTEXT", (eff, r)
        assert r["table"] == "event_direction_v1", (eff, r)
    print("12 OK")


def test_13_no_lookahead():
    future = ed.resolve([_obs(ts=ASOF + 1)], ASOF, SYM)
    assert future["effect"] == "unknown", future
    assert future["reasons"] == ["future-data"], future
    print("13 OK")


def test_14_boundary_ts():
    at = ed.resolve([_obs(ts=ASOF, pe="bullish")], ASOF, SYM)
    assert at["effect"] == "bullish", at
    zero = ed.resolve([_obs(ts=0, pe="bearish")], 0, SYM)
    assert zero["effect"] == "bearish", zero
    print("14 OK")


def test_15_no_foreign_capability():
    import ast as _ast
    with open(os.path.join(ROOT, "plane",
                           "event_direction.py")) as _fh:
        src = _fh.read()
    tree = _ast.parse(src)
    imported = set()
    called = set()
    for node in _ast.walk(tree):
        if isinstance(node, _ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, _ast.ImportFrom):
            imported.add((node.module or "").split(".")[0])
        elif isinstance(node, _ast.Call):
            f = node.func
            if isinstance(f, _ast.Name):
                called.add(f.id)
    for mod in ("time", "datetime", "socket", "random", "requests",
                "urllib", "http", "os", "sys", "subprocess"):
        assert mod not in imported, mod
    assert "open" not in called, "file IO"
    print("15 OK")


def test_16_table_pin():
    assert ed.TABLE == "event_direction_v1", ed.TABLE
    assert ed.VERSION == "v1", ed.VERSION
    assert ed.CLASSIFICATION == "CONTEXT", ed.CLASSIFICATION
    # Frozen content: v1 carries NO value rows (nothing has measured
    # justification yet). Any added row needs a version bump + test
    # update (measured justification + promotion gate, never
    # per-record).
    assert ed.ROWS == {}, ed.ROWS
    assert set(schema.EFFECTS) == {"bullish", "bearish", "risk_up",
                                   "risk_down", "neutral", "unknown"}
    print("16 OK")


def test_17_unmapped_source_kind():
    # edgar_8k cannot emit macro_release (frozen EMITTERS mirror).
    r = ed.resolve([_obs(kind="macro_release", v="x",
                         source="edgar_8k")], ASOF, SYM)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["unmapped-source-kind"], r
    print("17 OK")


def test_18_same_sig_contradiction():
    base = dict(v="rev", ts=ASOF - 3)
    # same underlying observation, absent vs bullish interpretation:
    # not an exact duplicate, must not silently resolve directional.
    r = ed.resolve([_obs(**dict(base)), _obs(**dict(base, pe="bullish"))],
                   ASOF, SYM)
    assert r["effect"] == "unknown", r
    assert r["rows"] == [], r
    # same underlying observation, bullish vs bearish: conflict.
    r2 = ed.resolve([_obs(**dict(base, pe="bullish")),
                     _obs(**dict(base, pe="bearish"))], ASOF, SYM)
    assert r2["effect"] == "unknown", r2
    assert "conflict" in r2["reasons"], r2
    print("18 OK")


def test_19_origin_evidence_gate():
    # llm-origin can never carry direction, even with source evidence.
    llm = ed.resolve([_obs(pe="bullish", origin="llm")], ASOF, SYM)
    assert llm["effect"] == "unknown", llm
    assert llm["rows"] == [], llm
    # parser origin with non-source evidence can never carry either.
    inf = ed.resolve([_obs(pe="bullish", evidence="inference")],
                     ASOF, SYM)
    assert inf["effect"] == "unknown", inf
    assert inf["rows"] == [], inf
    der = ed.resolve([_obs(pe="bullish", evidence="derived")],
                     ASOF, SYM)
    assert der["effect"] == "unknown", der
    # and an llm claim cannot poison by pretending: it resolves like
    # any unmapped observation (here voiding a directional set).
    mix = ed.resolve([_obs(v="a", pe="bullish"),
                      _obs(v="b", pe="bearish", origin="llm")],
                     ASOF, SYM)
    assert mix["effect"] == "unknown", mix
    print("19 OK")


def test_20_symbol_scope():
    # AAPL bullish + EURUSD bearish must never become one conflict:
    # mixed scope voids.
    r = ed.resolve([_obs(v="a", pe="bullish", sym="AAPL"),
                    _obs(v="b", pe="bearish", sym="EURUSD")],
                   ASOF, "AAPL")
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["scope-mismatch"], r
    # correctly partitioned calls resolve independently.
    a = ed.resolve([_obs(v="a", pe="bullish", sym="AAPL")],
                   ASOF, "AAPL")
    e = ed.resolve([_obs(v="b", pe="bearish", sym="EURUSD")],
                   ASOF, "EURUSD")
    assert (a["effect"], e["effect"]) == ("bullish", "bearish"), (a, e)
    print("20 OK")


def test_21_unknown_aggregation():
    bull = _obs(v="a", pe="bullish")
    bear = _obs(v="a", pe="bearish")
    unk = _obs(v="z-unmapped")
    neu = _obs(v="n", pe="neutral")
    assert ed.resolve([bull, unk], ASOF, SYM)["effect"] == "unknown"
    assert ed.resolve([bear, unk], ASOF, SYM)["effect"] == "unknown"
    assert ed.resolve([neu, unk], ASOF, SYM)["effect"] == "unknown"
    both = ed.resolve([unk, _obs(v="y-unmapped")], ASOF, SYM)
    assert both["effect"] == "unknown", both
    assert both["rows"] == [], both
    print("21 OK")


def test_22_directional_neutral_mix():
    # neutral is a resolved no-direction attestation: it does not
    # contradict a directional claim the way unknown does.
    r = ed.resolve([_obs(v="a", pe="bullish"),
                    _obs(v="n", pe="neutral")], ASOF, SYM)
    assert r["effect"] == "bullish", r
    print("22 OK")


if __name__ == "__main__":
    test_1_carried_positive()
    test_2_carried_negative()
    test_3_risk_axes()
    test_4_neutral_only()
    test_5_conflict()
    test_6_missing_inputs()
    test_7_malformed_inputs()
    test_8_ts_ambiguity()
    test_9_duplicates()
    test_10_replay_determinism()
    test_11_unknown_never_directional()
    test_12_context_only()
    test_13_no_lookahead()
    test_14_boundary_ts()
    test_15_no_foreign_capability()
    test_16_table_pin()
    test_17_unmapped_source_kind()
    test_18_same_sig_contradiction()
    test_19_origin_evidence_gate()
    test_20_symbol_scope()
    test_21_unknown_aggregation()
    test_22_directional_neutral_mix()
    print("ALL S6 TESTS GREEN")
