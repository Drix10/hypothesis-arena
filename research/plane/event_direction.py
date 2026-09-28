"""S6 deterministic directional resolver, table event_direction_v1.

Contract (no invention):
- doc 03 state rules: `effect` comes from a deterministic
  interpretation table per kind, never from model invention.
- doc 08 sec. 8.5: table frozen with the schema; parser-assigned
  effects are CARRIED when present, else unknown; LLM output can
  never declare evidence (here: never declare direction).
- roadmap S6: unknown on ambiguity; output CONTEXT until measured
  (no promotion has been earned or executed: classification is a
  frozen constant, never TRIGGER).
- doc 09: non-price sources inform regime only, never trigger entry.

v1 rows are transcription-only (the value literally names the
state) plus one kind-level mechanical default. ANY new row needs
measured justification + promotion gate + table version bump;
per-record judgment is unrepresentable.

No LLM, no network, no clock reads (asof_ns is an argument), no
floats in or out. Same inputs (in any order) -> byte-identical
output: observations are canonically sorted before evaluation.
"""
from . import schema

TABLE = "event_direction_v1"
VERSION = "v1"

CLASSIFICATION = "CONTEXT"  # frozen until measured (never TRIGGER here)

DIRECTIONAL = ("bullish", "bearish", "risk_up", "risk_down")

# Kind-level mechanical default: a scheduled future event has no
# realized direction yet.
KIND_DEFAULT = {"calendar_ahead": "neutral"}

# Exact-match transcription rows: (kind, value.type, value.v) ->
# effect. EMPTY in v1: no value transcription has measured
# justification yet, and per-record judgment is unrepresentable.
# Adding a row needs measured justification + promotion gate +
# table version bump + test_16 update (friction by design).
ROWS = {}

_FORBIDDEN_NOTE = "checked by test_13_no_foreign_capability"


def _obs_key(o):
    # Total and tolerant: sorting precedes validation, so a defective
    # observation must still sort (it resolves unknown right after).
    v = o.get("value") if isinstance(o, dict) else None
    if not isinstance(v, dict):
        v = {}
    ts = o.get("observed_at_ns") if isinstance(o, dict) else None
    return (str(o.get("kind")), str(v.get("type")), str(v.get("v")),
            str(ts), str(o.get("source_id")),
            str(o.get("parser_effect") or ""))


def _defect(o):
    """Data defect code, or None when the observation is well-formed.

    Well-formed: known kind, known value type with a correctly typed
    v (enum/bucket: str; bool: bool; count: int >= 0), integer
    observed_at_ns >= 0, source_id registered for the kind in the
    frozen EMITTERS mirror, parser_effect absent or a contracted
    effect. Anything else is ambiguity, not a crash: the SET resolves
    unknown."""
    if o.get("kind") not in schema.KINDS:
        return "unmapped-kind"
    v = o.get("value")
    if not isinstance(v, dict):
        return "malformed-value"
    vt, vv = v.get("type"), v.get("v")
    if vt not in schema.VTYPES:
        return "malformed-vtype"
    if vt in ("enum", "bucket") and not isinstance(vv, str):
        return "malformed-v"
    if vt == "bool" and not isinstance(vv, bool):
        return "malformed-v"
    if vt == "count" and (not isinstance(vv, int)
                          or isinstance(vv, bool) or vv < 0):
        return "malformed-v"
    ts = o.get("observed_at_ns")
    if not isinstance(ts, int) or isinstance(ts, bool) or ts < 0:
        return "malformed-ts"
    sid = o.get("source_id")
    if sid not in schema.EMITTERS or o["kind"] not in schema.EMITTERS[sid]:
        return "unmapped-source-kind"
    pe = o.get("parser_effect")
    if pe is not None and pe not in schema.EFFECTS:
        return "malformed-parser-effect"
    return None


def _direct(o):
    """Single-observation direction: (effect, row-or-rule)."""
    pe = o.get("parser_effect")
    key = (o["kind"], o["value"]["type"], o["value"]["v"])
    table = KIND_DEFAULT.get(o["kind"], ROWS.get(key))
    if pe is not None:
        if table is not None and table != pe:
            return "unknown", None  # parser/table contradiction
        return pe, "carried"
    if table is not None:
        rule = ("kind-default:" + o["kind"]
                if o["kind"] in KIND_DEFAULT
                else "row:%s/%s/%s" % key)
        return table, rule
    return "unknown", None


def resolve(observations, asof_ns):
    """Resolve a set of canonical observations to one effect.

    observations: non-empty list of dicts {kind, value:{type,v},
      observed_at_ns, source_id, parser_effect?}. asof_ns: required
    integer bound; any observation newer than asof is future data
    (no lookahead) and voids the set to unknown. Returns
    {effect, classification, table, rows, reasons} with no floats.
    """
    assert isinstance(asof_ns, int) and not isinstance(asof_ns, bool) \
        and asof_ns >= 0, "asof_ns is a required non-negative integer"
    assert isinstance(observations, list) and observations, \
        "observations is a required non-empty list"
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
    reasons = ["duplicate-collapsed"] if len(uniq) < len(obs) else []
    effs, rows = [], []
    for o in uniq:
        e, r = _direct(o)
        effs.append(e)
        if r is not None:
            rows.append(r)
        elif e == "unknown":
            reasons.append("unmapped")
    sharp = sorted({e for e in effs if e in DIRECTIONAL})
    if len(sharp) > 1:
        return {"effect": "unknown", "classification": CLASSIFICATION,
                "table": TABLE, "rows": [],
                "reasons": reasons + ["conflict"]}
    if sharp:
        return {"effect": sharp[0], "classification": CLASSIFICATION,
                "table": TABLE, "rows": sorted(rows),
                "reasons": reasons + ["resolved"]}
    if "neutral" in effs:
        return {"effect": "neutral", "classification": CLASSIFICATION,
                "table": TABLE, "rows": sorted(rows),
                "reasons": reasons + ["resolved"]}
    return {"effect": "unknown", "classification": CLASSIFICATION,
            "table": TABLE, "rows": [],
            "reasons": reasons + ["all-unknown"]}
