"""S6 tests: event_direction_v1 frozen interpretation table (stdlib only).

1 carried-positive 2 carried-negative 3 risk-axes 4 neutral-and-zero
5 conflict 6 missing-inputs 7 malformed-inputs 8 ts-ambiguity 9 duplicates
10 replay-determinism 11 unknown-never-directional 12 context-only
13 no-lookahead 14 boundary-ts 15 no-foreign-capability 16 table-pin
17 unmapped-source-kind 18 parser-table-contradiction.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)  # research/: plane/

from plane import event_direction as ed
from plane import schema

ASOF = 1_700_000_000_000_000_000


def _obs(kind="macro_release", v="cpi:m/m:0.3", ts=None,
         source="fred_macro", pe=None):
    o = {"kind": kind, "value": {"type": "enum", "v": v},
         "observed_at_ns": ASOF if ts is None else ts,
         "source_id": source}
    if pe is not None:
        o["parser_effect"] = pe
    return o


def test_1_carried_positive():
    r = ed.resolve([_obs(pe="bullish")], ASOF)
    assert r["effect"] == "bullish", r
    assert r["rows"] == ["carried"], r
    print("1 OK")


def test_2_carried_negative():
    r = ed.resolve([_obs(pe="bearish")], ASOF)
    assert r["effect"] == "bearish", r
    print("2 OK")


def test_3_risk_axes():
    # v1 has no measured value rows: the risk axis is covered by
    # carried parser effects (the only contracted directional source).
    hi = ed.resolve([_obs(pe="risk_up")], ASOF)
    assert hi["effect"] == "risk_up", hi
    lo = ed.resolve([_obs(pe="risk_down")], ASOF)
    assert lo["effect"] == "risk_down", lo
    # risk_up vs risk_down on one set is a clash -> unknown (R14 axis).
    clash = ed.resolve([_obs(v="a", pe="risk_up"),
                        _obs(v="b", pe="risk_down")], ASOF)
    assert clash["effect"] == "unknown", clash
    assert "conflict" in clash["reasons"], clash
    print("3 OK")


def test_4_neutral_and_zero():
    cal = ed.resolve([_obs(kind="calendar_ahead",
                           v="fomc:2026-10-28",
                           source="fed_monetary")], ASOF)
    assert cal["effect"] == "neutral", cal
    zero = ed.resolve([{"kind": "macro_release",
                        "value": {"type": "count", "v": 0},
                        "observed_at_ns": ASOF,
                        "source_id": "fred_macro"}], ASOF)
    # zero is a well-formed count, not a direction: unknown, and
    # NEVER silently neutral.
    assert zero["effect"] == "unknown", zero
    print("4 OK")


def test_5_conflict():
    r = ed.resolve([_obs(v="a", pe="bullish"),
                    _obs(v="b", pe="bearish")], ASOF)
    assert r["effect"] == "unknown", r
    assert "conflict" in r["reasons"], r
    assert r["rows"] == [], r
    print("5 OK")


def test_6_missing_inputs():
    o = _obs()
    del o["value"]
    r = ed.resolve([o], ASOF)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["malformed-value"], r
    o2 = _obs()
    del o2["observed_at_ns"]
    r2 = ed.resolve([o2], ASOF)
    assert r2["effect"] == "unknown", r2
    print("6 OK")


def test_7_malformed_inputs():
    cases = [("unmapped-kind", dict(_obs(), kind="rumor")),
             ("malformed-vtype",
              dict(_obs(), value={"type": "float", "v": 1.5})),
             ("malformed-v",
              dict(_obs(), value={"type": "bool", "v": "yes"})),
             ("malformed-ts", dict(_obs(), observed_at_ns=-1)),
             ("malformed-parser-effect", _obs(pe="moon"))]
    for needle, o in cases:
        r = ed.resolve([o], ASOF)
        assert r["effect"] == "unknown", (needle, r)
        assert r["reasons"] == [needle], (needle, r)
    print("7 OK")


def test_8_ts_ambiguity():
    a = _obs(v="rev", ts=ASOF - 10)
    b = _obs(v="rev", ts=ASOF - 5)
    r = ed.resolve([a, b], ASOF)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["order-ambiguous-ts"], r
    # input order carries no information: permutation is identical.
    fwd = ed.resolve([_obs(v="x", pe="bullish"),
                      _obs(kind="calendar_ahead", v="y",
                           source="fed_monetary")], ASOF)
    rev = ed.resolve([_obs(kind="calendar_ahead", v="y",
                           source="fed_monetary"),
                      _obs(v="x", pe="bullish")], ASOF)
    assert fwd == rev and fwd["effect"] == "bullish", (fwd, rev)
    print("8 OK")


def test_9_duplicates():
    one = ed.resolve([_obs(pe="bullish")], ASOF)
    two = ed.resolve([_obs(pe="bullish"), _obs(pe="bullish")], ASOF)
    assert two["effect"] == "bullish", two
    assert "duplicate-collapsed" in two["reasons"], two
    assert two["rows"] == one["rows"], (one, two)
    print("9 OK")


def test_10_replay_determinism():
    o = [_obs(v="x", pe="bullish"),
         _obs(kind="calendar_ahead", v="y", source="fed_monetary")]
    assert ed.resolve(o, ASOF) == ed.resolve(o, ASOF)
    assert ed.resolve(o, ASOF) == ed.resolve(list(reversed(o)), ASOF)
    print("10 OK")


def test_11_unknown_never_directional():
    for o in (_obs(v="never-mapped"),
              _obs(kind="filing_event", v="8-K:item-9.01",
                   source="edgar_8k"),
              _obs(kind="macro_release", v="revision:-0.2",
                   source="bea_nipa_gdp")):
        r = ed.resolve([o], ASOF)
        assert r["effect"] == "unknown", (o, r)
        assert r["rows"] == [], (o, r)
    print("11 OK")


def test_12_context_only():
    for eff in ("bullish", "bearish", "neutral", "unknown"):
        o = _obs(pe=eff) if eff != "neutral" else \
            _obs(kind="calendar_ahead", v="fomc", source="fed_monetary")
        if eff == "unknown":
            o = _obs(v="zzz-unmapped")
        r = ed.resolve([o], ASOF)
        assert r["classification"] == "CONTEXT", (eff, r)
        assert r["table"] == "event_direction_v1", (eff, r)
    print("12 OK")


def test_13_no_lookahead():
    future = ed.resolve([_obs(ts=ASOF + 1)], ASOF)
    assert future["effect"] == "unknown", future
    assert future["reasons"] == ["future-data"], future
    print("13 OK")


def test_14_boundary_ts():
    # observed exactly AT asof is observed history, not the future.
    at = ed.resolve([_obs(ts=ASOF, pe="bullish")], ASOF)
    assert at["effect"] == "bullish", at
    zero = ed.resolve([_obs(ts=0, pe="bearish")], 0)
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
    assert ed.KIND_DEFAULT == {"calendar_ahead": "neutral"}
    assert set(schema.EFFECTS) == {"bullish", "bearish", "risk_up",
                                   "risk_down", "neutral", "unknown"}
    print("16 OK")


def test_17_unmapped_source_kind():
    # edgar_8k cannot emit macro_release (frozen EMITTERS mirror).
    r = ed.resolve([_obs(kind="macro_release", v="x",
                         source="edgar_8k")], ASOF)
    assert r["effect"] == "unknown", r
    assert r["reasons"] == ["unmapped-source-kind"], r
    print("17 OK")


def test_18_parser_table_contradiction():
    # calendar_ahead default is neutral; a parser claiming bearish on
    # a scheduled item contradicts the frozen table -> unknown.
    o = _obs(kind="calendar_ahead", v="fomc:2026-10-28",
             source="fed_monetary", pe="bearish")
    r = ed.resolve([o], ASOF)
    assert r["effect"] == "unknown", r
    assert r["rows"] == [], r
    # agreement carries: neutral parser + neutral default.
    ok = _obs(kind="calendar_ahead", v="fomc:2026-10-28",
              source="fed_monetary", pe="neutral")
    r2 = ed.resolve([ok], ASOF)
    assert r2["effect"] == "neutral", r2
    print("18 OK")


if __name__ == "__main__":
    test_1_carried_positive()
    test_2_carried_negative()
    test_3_risk_axes()
    test_4_neutral_and_zero()
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
    test_18_parser_table_contradiction()
    print("ALL S6 TESTS GREEN")
