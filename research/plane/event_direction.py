"""S6 deterministic directional resolver, table event_direction_v1.

Contract (no invention):
- doc 03 state rules: `effect` comes from a deterministic
  interpretation table per kind, never from model invention; R14
  disagreement is defined ON ONE SYMBOL.
- doc 08 sec. 8.5: table frozen with the schema; parser-assigned
  effects may be CARRIED when present, else unknown; LLM output can
  never declare direction; evidence levels gate what reaches entries.
- roadmap S6: unknown on ambiguity; output CONTEXT until measured
  (no promotion earned or executed: classification is constant).
- doc 09: non-price sources inform regime only, never trigger entry.

Authority rules (frozen here):
- direction is carried ONLY for parser-owned observations
  (origin == "parser" AND evidence == "source": the D4-contracted
  markers of pipeline-owned deterministic-parser output, stamped by
  the graph, never by candidates). origin == "llm", or evidence !=
  "source", means the parser_effect field is IGNORED: advisory
  content can never promote itself to direction. S6 trusts these
  markers; ONLY the graph may stamp origin="parser" (integration
  duty, future wiring: the resolver is not yet in the feature flow).
- one call resolves ONE symbol (R14 scope): every observation must
  carry symbols == [symbol] exactly; mixed scope voids to unknown.
  Callers partition multi-symbol features per symbol.
- fail-closed aggregation: any relevant unresolved observation
  alongside directional evidence voids the set to unknown
  (absent != neutral; unknown never becomes evidence).
- v1 ROWS is EMPTY (nothing has measured justification). Adding a
  row needs measured justification + promotion gate + table version
  bump + test_16 update. Uncarried, unmapped observations resolve
  unknown: there is deliberately no kind-wide default.

No LLM, no network, no clock reads (asof_ns is an argument), no
floats, no file IO. Same inputs (in any order) -> identical output:
observations are canonically sorted before evaluation.
"""
from . import schema

TABLE = "event_direction_v1"
VERSION = "v1"

CLASSIFICATION = "CONTEXT"  # frozen until measured (never TRIGGER here)

DIRECTIONAL = ("bullish", "bearish", "risk_up", "risk_down")

# Exact-match value rows: (kind, value.type, value.v) -> effect.
# EMPTY in v1 (see contract above).
ROWS = {}

TOP_FIELDS = ("kind", "value", "observed_at_ns", "source_id",
              "symbols", "origin", "evidence", "parser_effect")


def _obs_key(o):
    # Total and tolerant: sorting precedes validation, so a defective
    # observation must still sort (it resolves unknown right after).
    v = o.get("value") if isinstance(o, dict) else None
    if not isinstance(v, dict):
        v = {}
    return (str(o.get("kind")), str(v.get("type")), str(v.get("v")),
            str(o.get("observed_at_ns")), str(o.get("source_id")),
            str(o.get("symbols")), str(o.get("origin")),
            str(o.get("evidence")), str(o.get("parser_effect") or ""))


def _defect(o):
    """Data defect code, or None when the observation is well-formed.

    Exact shape: no unknown top-level or value fields (silent ignored
    fields are unrepresentable). kind/value/source held to the frozen
    schema registries. origin/evidence held to the contracted marker
    vocabularies. Anything defective voids its SET to unknown, never
    an exception."""
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

    Carrying requires the full parser-owned marker set; otherwise the
    parser_effect field is not authoritative and is ignored (an
    llm-origin bullish claim resolves exactly like an unmapped
    observation: unknown)."""
    owned = o.get("origin") == "parser" and o.get("evidence") == "source"
    pe = o.get("parser_effect")
    key = (o["kind"], o["value"]["type"], o["value"]["v"])
    if owned and pe is not None:
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
    reasons = sorted(codes)
    sharp = sorted({e for e in effs if e in DIRECTIONAL})
    if len(sharp) > 1:
        reasons = reasons + ["conflict"]
    if "unresolved" in codes and (sharp or "neutral" in effs):
        reasons = reasons + ["unresolved-present"]
    if len(sharp) > 1 or "unresolved" in codes:
        # fail closed: distinct directional claims clash, and any
        # relevant unresolved observation voids directional (or
        # neutral) evidence with it. Absent != neutral.
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
