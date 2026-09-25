"""D4 deterministic evidence resolver (doc 08 sec. 8.5, stdlib only).

LLM outputs are advisory candidates, never evidence. This resolver
recomputes every load-bearing field from the canonical source record
before emission. No LLM, no network, no clock reads (timestamps in).

Inputs:
  candidate: advisory dict (kind, value, symbols?, effect?,
             evidence?, entity_ref?, provenance_url?). feature_id, when
             present on a candidate, is IGNORED: feature identity is
             assigned downstream from trusted canonical lineage, never
             from model output (duplicate/invented IDs cannot survive).
  canonical: the deterministic source record the candidate claims to
             derive from: {source_id, kind (parser-assigned), content_hash,
             published_ns (or None), ingested_ns, symbols, effect
             (parser-assigned or None), parser_confidence
             ("high"/"medium"/"low"), corroborated (bool)}
  entity_map: {"cik_to_ticker": {...}, "macro_release_to_symbols": {...}}
  map_version, map_sha: pinned map identity for the bundle watermarks.

Output: (ok, feature_dict_or_reject_reason). Reject reasons mirror the
f2 vocabulary where the defect is shape-like; resolver-native rejects
use the "unverifiable-*" / "contradiction" codes (counted, never emitted).

Rules (frozen):
- kind/source must be in the frozen registry; unknown kind or a kind the
  source cannot emit -> reject (never admitted on structure alone).
- symbols must resolve through the pinned map (EDGAR CIK or macro
  release table) and number at most 16 (frozen ctx MAX_SYMBOLS — the
  producer enforces the downstream limit, never ships past it).
  Unresolvable -> reject. entity_ref cik contradicting
  the claimed symbol -> reject ("contradiction").
- evidence = "source" ONLY for a pipeline-owned deterministic-parser
  origin (origin="parser", stamped by the graph — never by candidate
  output) with kind, value, symbols, and observed_at_ns mechanically
  identical to the canonical record AND the effect equal to the
  parser-assigned canonical effect. LLM-origin output (origin="llm")
  is ALWAYS "inference", even when its content happens to match:
  advisory content can never promote itself to evidence. The legacy
  candidate llm_touched field is IGNORED entirely.
- effect is never invented: carried from the canonical record when
  present, else "unknown". The resolver owns no directional mapping;
  per-source directional tables are parser config added only with
  measured justification (promotion gate), never per-record judgment.
- observed_at_ns comes from the canonical published timestamp. Missing
  published ts -> observed = ingested AND context_cap = True
  (R12: permanently CONTEXT-capped, still emittable for research).
- canonical_hash = the canonical content_hash (single-source lineage).
- confidence_bucket is computed, never self-reported:
  base = source tier (high->high, medium->medium); drop one level if the
  published timestamp was missing; drop one level if uncorroborated and
  the candidate was LLM-touched (llm_touched=True); drop per
  parser_confidence (high: 0, medium: 1, low: 2 — a low-confidence
  parser result can never ride a high tier to high confidence).
  Floor is "low".
- the canonical record itself is validated FIRST: missing keys, wrong
  types, non-hex content_hash, unknown parser_confidence, or an
  entity_ref CIK unknown to the pinned map are deterministic REJECTS
  (canonical-shape / entity-unmapped), never exceptions and never
  knowingly-invalid emitted features.
"""
from . import schema


def _drop(level):
    return {"high": "medium", "medium": "low", "low": "low"}[level]


def resolve(candidate, canonical, entity_map, origin="llm",
            llm_touched=True):
    # origin is pipeline-stamped (graph overwrites worker output to
    # "llm"); llm_touched is accepted for backward compatibility but
    # IGNORED — a candidate-controlled trust bit can never earn source
    # evidence. Only origin="parser" may.
    # Canonical record validation FIRST: malformed trusted input is a
    # counted reject, never a KeyError/TypeError and never a feature.
    if not isinstance(canonical, dict):
        return False, "canonical-shape"
    src = canonical.get("source_id")
    canon_kind = canonical.get("kind")
    canon_value = canonical.get("value")
    canon_symbols = canonical.get("symbols")
    canon_effect = canonical.get("effect")
    pub_ns = canonical.get("published_ns")
    ingested_ns = canonical.get("ingested_ns")
    content_hash = canonical.get("content_hash")
    parser_conf = canonical.get("parser_confidence")
    corroborated = canonical.get("corroborated")
    import re as _re
    if (not isinstance(src, str) or not isinstance(canon_kind, str) or
            not isinstance(canon_value, dict) or
            not isinstance(canon_symbols, list) or
            not all(isinstance(s, str) and s
                    for s in canon_symbols) or
            not isinstance(content_hash, str) or
            not _re.fullmatch(r"[0-9a-f]{64}", content_hash) or
            (pub_ns is not None and type(pub_ns) is not int) or
            type(ingested_ns) is not int or
            parser_conf not in ("high", "medium", "low") or
            not isinstance(corroborated, bool)):
        return False, "canonical-shape"
    kind = candidate.get("kind")
    if kind not in schema.KINDS:
        return False, "schema-enum"
    if src not in schema.EMITTERS or kind not in schema.EMITTERS[src]:
        return False, "kind-no-emitter"
    # Symbols: candidate claim first, canonical record as ground truth.
    claimed = candidate.get("symbols") or []
    if (not isinstance(claimed, list) or not claimed or
            len(claimed) > 16 or
            any(not isinstance(s, str) or not s for s in claimed)):
        return False, "symbols-type"
    tickers = entity_map.get("cik_to_ticker", {})
    macro = entity_map.get("macro_release_to_symbols", {})
    bound = []
    for sym in claimed:
        if src == "edgar_8k":
            hit = [t for c, t in tickers.items() if t == sym]
            if not hit:
                return False, "entity-unmapped:%s" % sym
        else:
            ok_syms = []
            for _rel, syms in macro.items():
                ok_syms.extend(syms)
            if sym not in ok_syms:
                return False, "entity-unmapped:%s" % sym
        bound.append(sym)
    ref = candidate.get("entity_ref")
    if ref is not None:
        if (not isinstance(ref, dict) or set(ref) != {"cik"} or
                not isinstance(ref.get("cik"), str)):
            return False, "entity-ref-shape"
        actual = tickers.get(ref["cik"])
        # Unknown CIK rejects HERE (resolver), not downstream: an
        # unmapped reference must never become an emitted feature.
        if actual is None:
            return False, "entity-unmapped:%s" % ref["cik"]
        if actual not in bound:
            return False, "contradiction"
    # Value: exact type discipline mirrored from the f2 reader.
    value = candidate.get("value")
    if not isinstance(value, dict):
        return False, "schema-value"
    if not isinstance(value.get("type"), str):
        return False, "value-shape"
    if value["type"] not in schema.VTYPES:
        return False, "schema-value"
    if set(value) != {"type", "v"}:
        return False, "value-shape"
    shapes = {"enum": str, "bucket": str, "bool": bool, "count": int}
    want = shapes[value["type"]]
    if "v" not in value or type(value["v"]) is not want:
        return False, "value-shape"
    if value["type"] == "count" and value["v"] < 0:
        return False, "value-shape"
    # Mechanical identity with the canonical record, INCLUDING the
    # parser-assigned kind: a candidate must not relabel canonical
    # semantics (e.g. macro_release -> calendar_ahead) while keeping the
    # checked fields identical and still earn evidence=source.
    identical = (origin == "parser" and canon_kind == kind and
                 canon_value == value and
                 list(canon_symbols) == list(bound) and
                 pub_ns is not None and
                 candidate.get("effect") == canon_effect)
    context_cap = False
    if pub_ns is None:
        observed_ns = ingested_ns
        context_cap = True  # R12: no source-published ts, CONTEXT forever
    else:
        observed_ns = pub_ns
    if identical and canon_effect in schema.EFFECTS:
        evidence = "source"
        effect = canon_effect
    else:
        evidence = "inference"
        effect = (canon_effect if canon_effect in schema.EFFECTS
                  else "unknown")
    # Confidence: computed from tier x timestamp quality x corroboration
    # x PARSER confidence. A low-confidence parse never reaches high,
    # even on a high-tier source with corroboration. LLM-origin output
    # additionally drops one level (advisory content, never parser
    # output) unless corroborated by an independent deterministic
    # record.
    conf = {"high": "high", "medium": "medium"}.get(
        schema.SOURCE_TIER.get(src, "medium"), "medium")
    if pub_ns is None:
        conf = _drop(conf)
    if origin != "parser" and not corroborated:
        conf = _drop(conf)
    for _ in range({"high": 0, "medium": 1, "low": 2}[parser_conf]):
        conf = _drop(conf)
    ttl = schema.SOURCE_TTL_S.get(src, 3600)
    feat = schema.build_feature(
        kind, bound, dict(value), effect, evidence, conf, src,
        content_hash, observed_ns, ingested_ns,
        ttl, feature_id=None, hashes=[content_hash],
        entity_ref=dict(ref) if ref else None,
        provenance_url=candidate.get("provenance_url"))
    return True, (feat, context_cap)
