"""Pre-registration validator and contamination guard. A pre-registration is
committed before any result exists; its canonical SHA-256 is the prereg_hash
carried by every ledger row. Any missing or malformed field is an error."""
import datetime
import hashlib
import json
import math

SCHEMA = "prereg"
REQUIRED = ("schema", "experiment_id", "family", "hypothesis", "strategy",
            "universe", "signal", "variants", "cost_model",
            "split", "holdout", "decision", "created")
SPLIT_KEYS = ("scheme", "n_splits", "label_horizon_days", "embargo_days")
HOLDOUT_KEYS = ("start", "end", "rule")
DECISION_KEYS = ("min_net_sharpe", "max_drawdown_pct", "min_cost_multiple",
                 "min_days", "new_signal_tstat_min")
COST_MODELS = ("costs",)
CUTOFF_MARGIN_DAYS = 30


class PreregError(Exception):
    pass


def canonical(obj):
    return json.dumps(obj, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=True, allow_nan=False).encode("ascii")


def prereg_hash(obj):
    return hashlib.sha256(canonical(obj)).hexdigest()


def _date(s):
    if not isinstance(s, str):
        raise ValueError
    return datetime.date.fromisoformat(s)


def contamination_errors(llm, eval_start):
    """LLM-influenced evidence must start after cutoff + 30 d ()."""
    errs = []
    if not isinstance(llm, dict):
        return ["llm-block-malformed"]
    try:
        cutoff = _date(llm.get("knowledge_cutoff"))
    except ValueError:
        return ["llm-knowledge-cutoff-missing-or-bad"]
    try:
        start = _date(eval_start)
    except ValueError:
        return ["llm-evidence-start-bad"]
    earliest = cutoff + datetime.timedelta(days=CUTOFF_MARGIN_DAYS)
    if start <= cutoff + datetime.timedelta(days=CUTOFF_MARGIN_DAYS - 1):
        errs.append("contaminated:evidence-start-%s-before-%s"
                    % (start, earliest))
    return errs


def validate(p):
    """Return a list of error strings ([] means valid)."""
    if not isinstance(p, dict):
        return ["not-an-object"]
    errs = []
    for k in REQUIRED:
        if k not in p:
            errs.append("missing:" + k)
    if errs:
        return errs
    if p["schema"] != SCHEMA:
        errs.append("schema")
    for k in ("experiment_id", "family", "hypothesis", "strategy", "signal"):
        if not isinstance(p[k], str) or not p[k].strip():
            errs.append("empty:" + k)
    if not isinstance(p["universe"], list) or not p["universe"] \
            or not all(isinstance(u, str) and u for u in p["universe"]):
        errs.append("universe")
    v = p["variants"]
    if not isinstance(v, list) or not v \
            or len({json.dumps(x, sort_keys=True) for x in v}) != len(v):
        errs.append("variants-must-be-nonempty-and-distinct")
    if p["cost_model"] not in COST_MODELS:
        errs.append("cost-model-version")
    for name, keys in (("split", SPLIT_KEYS), ("holdout", HOLDOUT_KEYS),
                       ("decision", DECISION_KEYS)):
        blk = p[name]
        if not isinstance(blk, dict):
            errs.append("not-an-object:" + name)
            continue
        for k in keys:
            if k not in blk:
                errs.append("missing:%s.%s" % (name, k))
    if errs:
        return errs
    try:
        created = _date(p["created"])
        hs, he = _date(p["holdout"]["start"]), _date(p["holdout"]["end"])
        if hs >= he:
            errs.append("holdout-window")
        if created > datetime.date.today():
            errs.append("created-in-future")
    except ValueError:
        errs.append("date-format")
        return errs
    d, sp = p["decision"], p["split"]
    for blk, k, lo, hi in (
            (d, "min_net_sharpe", 0.0, None),
            (d, "max_drawdown_pct", 0.0, 100.0),
            (d, "min_cost_multiple", 2.0, None),
            (d, "new_signal_tstat_min", 3.0, None),
            (sp, "label_horizon_days", 0, None),
            (sp, "embargo_days", 0, None)):
        v = blk[k]
        ok = isinstance(v, (int, float)) and not isinstance(v, bool) \
            and math.isfinite(v) and v >= lo and (hi is None or v <= hi)
        if not ok or (k in ("min_net_sharpe", "max_drawdown_pct") and v == 0):
            errs.append("bad-value:" + k)
    for blk, k, lo in ((d, "min_days", 1), (sp, "n_splits", 2)):
        v = blk[k]
        if not isinstance(v, int) or isinstance(v, bool) or v < lo:
            errs.append("bad-value:" + k)
    if p.get("llm") is not None:
        errs.extend(contamination_errors(p["llm"],
                                         p["llm"].get("evidence_start")
                                         if isinstance(p["llm"], dict)
                                         else None))
        if _safe_before(p["holdout"]["start"], p["llm"]):
            errs.append("contaminated:holdout-starts-before-cutoff+30d")
    return errs


def _safe_before(start, llm):
    try:
        cutoff = _date(llm.get("knowledge_cutoff"))
        return _date(start) < cutoff + datetime.timedelta(
            days=CUTOFF_MARGIN_DAYS)
    except (ValueError, AttributeError):
        return False


def require_valid(p):
    """Return the prereg hash, or raise PreregError listing every error."""
    errs = validate(p)
    if errs:
        raise PreregError(";".join(errs))
    return prereg_hash(p)
