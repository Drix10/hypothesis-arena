"""Deterministic directional resolver, table event_direction.

Contract:
- state rules: `effect` comes from a deterministic table per
  kind, never from model output; R14 disagreement is per symbol.
- sec. 8.5: table fixed with the schema; parser-assigned
  effects are carried when present, else unknown; LLM output never
  declares direction.
- roadmap S6: unknown on ambiguity; output is CONTEXT until measured.
-: non-price sources inform regime only, never trigger entry.

Authority rules:
- Direction is carried only for parser-owned observations (origin ==
  "parser" and evidence == "source", stamped by the graph, never by
  candidates). Otherwise parser_effect is ignored. Only the graph may
  stamp origin="parser"; the resolver is not yet in the feature flow.
- One call resolves one symbol: every observation must carry
  symbols == [symbol]; mixed scope voids to unknown. Callers partition
  multi-symbol features.
- Any relevant unresolved observation alongside directional evidence
  voids the set to unknown (absent != neutral).
- Contradictory interpretations of one observation void it, even
  bullish-vs-neutral (which stays resolvable across different
  observations).
- An explicit carried unknown stays unresolved, never neutral.
- v1 ROWS is empty. Adding a row needs measured justification, the
  promotion gate, a table version bump and a test_16 update. Unmapped
  observations resolve unknown; there is no kind-wide default.

No LLM, no network, no clock reads (asof_ns is an argument), no
floats, no file IO. Same inputs (in any order) -> identical output:
observations are canonically sorted before evaluation.
"""
from . import schema

TABLE = "event_direction"
VERSION = "v1"

CLASSIFICATION = "CONTEXT"  # fixed until measured (never TRIGGER here)

DIRECTIONAL = ("bullish", "bearish", "risk_up", "risk_down")

# Exact-match value rows: (kind, value.type, value.v) -> effect.
# EMPTY in v1 (see contract above).
ROWS = {}

TOP_FIELDS = ("kind", "value", "observed_at_ns", "source_id",
              "symbols", "origin", "evidence", "parser_effect")


def _obs_key(o):
    # must not raise on defective observations: sorting precedes validation
    v = o.get("value") if isinstance(o, dict) else None
    if not isinstance(v, dict):
        v = {}
    return (str(o.get("kind")), str(v.get("type")), str(v.get("v")),
            str(o.get("observed_at_ns")), str(o.get("source_id")),
            str(o.get("symbols")), str(o.get("origin")),
            str(o.get("evidence")), str(o.get("parser_effect") or ""))


def _defect(o):
    """Defect code, or None when well-formed: exact shape (no unknown
    top-level or value fields), kind/value/source in the schema
    registries, origin/evidence in the marker vocabularies. A defect
    voids the whole set to unknown."""
    if set(o) - set(TOP_FIELDS):
        return "extra-fields"
    if o.get("kind") not in schema.KINDS:
        return "unmapped-kind"
    v = o.get("value")
    if not isinstance(v, dict) or set(v) != {"type", "v"}:
        return "malformed-value"
    vt, vv = v.get("type"), v.get("v")
    if vt not in schema.VTYPES:
        return "malformed-vtype"
    if vt in ("enum", "bucket") and type(vv) is not str:
        return "malformed-v"
    if vt == "bool" and type(vv) is not bool:
        return "malformed-v"
    if vt == "count" and (type(vv) is not int or vv < 0):
        return "malformed-v"
    ts = o.get("observed_at_ns")
    if type(ts) is not int or ts < 0:
        return "malformed-ts"
    syms = o.get("symbols")
    if type(syms) is not list or not syms or \
            any(type(s) is not str for s in syms):
        return "malformed-symbols"
    sid = o.get("source_id")
    if sid not in schema.EMITTERS or o["kind"] not in schema.EMITTERS[sid]:
        return "unmapped-source-kind"
    if o.get("origin") not in ("parser", "llm"):
        return "malformed-origin"
    if o.get("evidence") not in schema.EVIDENCE:
        return "malformed-evidence"
    pe = o.get("parser_effect")
    if pe is not None and pe not in schema.EFFECTS:
        return "malformed-parser-effect"
    return None


def _direct(o):
    """Single-observation direction: (effect, row-or-rule).

    Carrying requires the full parser-owned marker set; otherwise
    parser_effect is ignored (an llm-origin claim resolves unknown)."""
    owned = o.get("origin") == "parser" and o.get("evidence") == "source"
    pe = o.get("parser_effect")
    key = (o["kind"], o["value"]["type"], o["value"]["v"])
    if owned and pe is not None:
        if pe == "unknown":
            # explicit unknown stays unresolved, never a row
            return "unknown", None
        if key in ROWS and ROWS[key] != pe:
            return "unknown", None  # parser/table contradiction
        return pe, "carried"
    if key in ROWS:
        return ROWS[key], "row:%s/%s/%s" % key
    return "unknown", None


def resolve(observations, asof_ns, symbol):
    """Resolve one symbol's observations to a single effect.

    observations: non-empty list of exact-shape dicts. asof_ns:
    required integer bound; anything newer is future data (no
    lookahead). symbol: required non-empty string scope; every
    observation must carry symbols == [symbol]. Returns {effect,
    classification, table, rows, reasons}; no floats, ever.
    """
    assert type(asof_ns) is int and asof_ns >= 0, \
        "asof_ns is a required non-negative integer"
    assert isinstance(observations, list) and observations, \
        "observations is a required non-empty list"
    assert type(symbol) is str and symbol, \
        "symbol is a required non-empty scope string"
    for o in observations:
        assert isinstance(o, dict), "observation must be a dict"
    obs = sorted(observations, key=_obs_key)  # input order is nothing
    for o in obs:
        bad = _defect(o)
        if bad is not None:
            return {"effect": "unknown", "classification": CLASSIFICATION,
                    "table": TABLE, "rows": [],
                    "reasons": [bad]}
        if o["observed_at_ns"] > asof_ns:
            return {"effect": "unknown", "classification": CLASSIFICATION,
                    "table": TABLE, "rows": [],
                    "reasons": ["future-data"]}
        if list(o["symbols"]) != [symbol]:
            return {"effect": "unknown", "classification": CLASSIFICATION,
                    "table": TABLE, "rows": [],
                    "reasons": ["scope-mismatch"]}
    seen = {}
    for o in obs:
        sig = (o["kind"], o["value"]["type"], o["value"]["v"],
               o["source_id"])
        if sig in seen and seen[sig] != o["observed_at_ns"]:
            return {"effect": "unknown", "classification": CLASSIFICATION,
                    "table": TABLE, "rows": [],
                    "reasons": ["order-ambiguous-ts"]}
        seen[sig] = o["observed_at_ns"]
    uniq = []
    for o in obs:
        if not uniq or _obs_key(o) != _obs_key(uniq[-1]):
            uniq.append(o)
    codes = set()
    if len(uniq) < len(obs):
        codes.add("duplicate-collapsed")
    effs, rows = [], []
    for o in uniq:
        e, r = _direct(o)
        effs.append(e)
        if r is not None:
            rows.append(r)
        else:
            codes.add("unresolved")
    # one identity (kind, value, source, timestamp, symbol) must have one
    # interpretation; different identities use the looser aggregation below
    ident = {}
    for o, e in zip(uniq, effs):
        gid = (o["kind"], o["value"]["type"], o["value"]["v"],
               o["source_id"], o["observed_at_ns"], symbol)
        ident.setdefault(gid, set()).add(e)
    if any(len(s) > 1 for s in ident.values()):
        return {"effect": "unknown", "classification": CLASSIFICATION,
                "table": TABLE, "rows": [],
                "reasons": sorted(codes) + ["identity-conflict"]}
    reasons = sorted(codes)
    sharp = sorted({e for e in effs if e in DIRECTIONAL})
    if len(sharp) > 1:
        reasons = reasons + ["conflict"]
    if "unresolved" in codes and (sharp or "neutral" in effs):
        reasons = reasons + ["unresolved-present"]
    if len(sharp) > 1 or "unresolved" in codes:
        # distinct directional claims clash; an unresolved observation voids
        # directional or neutral evidence (absent != neutral)
        return {"effect": "unknown", "classification": CLASSIFICATION,
                "table": TABLE, "rows": [],
                "reasons": reasons}
    if sharp:
        return {"effect": sharp[0], "classification": CLASSIFICATION,
                "table": TABLE, "rows": sorted(rows),
                "reasons": reasons + ["resolved"]}
    return {"effect": "neutral", "classification": CLASSIFICATION,
            "table": TABLE, "rows": sorted(rows),
            "reasons": reasons}
