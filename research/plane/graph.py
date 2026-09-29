"""D1 six-node research graph (doc 08 sec. 8.3, LangGraph, pinned).

harvest -> extract -> fuse -> hypothesize -> critique -> emit

- Checkpointed after every node (SqliteSaver with a strict msgpack
  allowlist; 30-day retention via the retention module) for resume at the
  last completed node.
- One active run_cycle per process (module guard): the synchronous
  SqliteSaver does not scale to multiple threads, so concurrency is
  refused.
- Side-effecting nodes carry idempotency keys: emit is idempotent by
  bundle_id, digest appends are keyed by epoch+symbol+node.
- hypothesize/critique/extract never receive a model object; they are
  pure build/parse callables. The graph makes every provider call through
  workers.run_gated(), fed by the required deps["provider_factory"], which
  is invoked inside the spawned worker child (no provider exists in the
  parent, so a refused reservation never runs the factory). Test doubles
  that never touch a provider may be injected as deps["extract_workers"].
- Cycle identity: run_cycle() stamps state["cycle_id"] = thread_id
  (str, 1..64 chars, [A-Za-z0-9_.~-]). Budgets come from
  deps["budget_factory"](cycle_id, symbol) per attempt.
- Spend tiers (doc 10 §10.4, reported by the governor, applied here): T1
  doubles the interval, filters critique to TRIGGER-class symbols and
  suspends NULL-class extraction; T2 switches non-JEV LLM work to the
  cheapest configured model, caps hypothesize prose at 200 chars, cuts the
  watchlist to the 2 best-calibrated symbols and emits the SOFT-kill
  signal; T3 denies all research LLM and emits the MEDIUM-kill signal. JEV
  lives in collector/jev.py and is never throttled.
  deps["spend_governor"] is required, with a persistent state_dir, and is
  the sole pricing authority (deps["pricing"] is ignored), so pricing
  cannot drift from cap enforcement.
- Kill signals are durable sentinel files (signal_dir, required for
  Tier-2+) plus a supplemental health_hook event. A hook failure is
  blocked evidence; a sentinel write failure fails the cycle with no
  publication. The supervisor/trading side consumes them; the C++ kill
  state machine is Slice-D+ work and not authorized. The plane never acts
  on capital.
- Every producer (harvest records, parser/worker candidates) drains under
  its own ceiling: infinite generators end with producer_overrun and a
  lower-bound dropped count. Malformed harvest envelopes are blocked
  evidence with no publication.
- AbortCycle sets cycle_aborted and short-circuits further expensive work.
- Cadence freshness advances only after a successful thesis and its
  digest write; persist failures are blocked evidence.
- build/parse outputs of the wrong type are rejected as blocked evidence,
  never coerced with str(); len() is called only after isinstance(str).
- Harvest is a trust boundary: raw records are shape-validated (strict
  JSON-safe) before orchestration.
- Checkpointed fields are bounded without full materialization (len()
  gate, then islice). Origin is graph-stamped: worker output is
  overwritten with origin="llm", parser output gets origin="parser".
"""
import itertools
import json
import os
import re
import threading
import time

try:
    from typing_extensions import TypedDict
    from langgraph.graph import END, StateGraph
    _LANGGRAPH = True
except ImportError:  # pragma: no cover - build gate pins the dep
    _LANGGRAPH = False

from . import cadence, digest, locks, r15, retention, schema
from . import emit as emit_mod
from . import spend as spend_mod
from . import workers as _workers

NODES = ("harvest", "extract", "fuse", "hypothesize", "critique", "emit")

# checkpoint resource caps: len() gate first, then islice; counts record the rest
RAW_MAX = 512
CAND_MAX = 256
FUSED_MAX = 128
FUSED_CANDIDATE_BYTES_MAX = 16384
SYMBOL_MAX = 64
WATCHLIST_MAX = 64
TRIGGER_MAX = 64
SYMBOL_CHARS_MAX = 64
BLOCKED_MAX = 128
BLOCKED_CHARS = 256
STAMPS_MAX = 256
STAMP_KEY_CHARS_MAX = 128
STAMP_VALUE_BYTES_MAX = 1024
HISTORY_SOURCES_MAX = 16
HISTORY_SOURCE_KEY_MAX = 128
HISTORY_ENTRIES_MAX = 256
THESIS_CHARS_MAX = 500  # frozen thesis: reject, never truncate
CRITIQUE_CHARS_MAX = 2000
CANDIDATE_BYTES_MAX = 16384
MODEL_PROMPT_BYTES_MAX = 32768
# producer-iteration ceiling: a harvest/fuse iterable yielding beyond
# limit+ceiling stops with producer_overrun=True and a lower-bound count
PRODUCER_CEILING = 10000
# NULL-class sources (doc 09 Tier-C): carried as declared nulls, suspended under Tier 1+
NULL_SOURCES = frozenset({"x_lists_tail", "launch_library",
                          "submarine_cables", "aisstream", "opensky_adsb"})
THREAD_ID_RE = re.compile(r"[A-Za-z0-9_.\-~]{1,64}")
EPOCH_MAX = 2 ** 31 - 1
MODEL_TIMEOUT_DEFAULT = 120.0
EXTRACT_TIMEOUT_DEFAULT = 420.0
WATCHLIST_TIER2 = 2

_RUN_GUARD = threading.Lock()


class PlaneState(TypedDict, total=False):
    watchlist: list
    epoch: int
    cycle_id: str
    trigger_symbols: tuple
    raw: list
    stamps: dict
    history: dict
    history_dropped: int
    candidates: list
    candidate_origin: str
    extract_aborts: int
    malformed_raw: int
    dropped_null_class: int
    fused: list
    thesis: dict
    critique: dict
    skipped_critique_tier: int
    bundle_id: str
    blocked: list
    cycle_aborted: bool
    emitted: object
    aborted: bool
    dropped_raw: int
    dropped_candidates: int
    dropped_fused: int
    dropped_watchlist: int
    dropped_watchlist_tier: int
    soft_kill: bool
    medium_kill: bool
    producer_overrun: bool


def _drain(producer, keep_max):
    """Draw items from an untrusted producer (possibly infinite, raising or
    non-iterable). Keeps the first keep_max items and draws at most
    keep_max+PRODUCER_CEILING (then overrun=True with a lower-bound dropped
    count). AbortCycle/ConfigBlocked propagate; other exceptions end that
    producer as blocked evidence. Returns (kept, dropped, overrun, error)."""
    kept = []
    drawn = 0
    try:
        it = iter(producer)
    except TypeError:
        return kept, 0, False, "producer-not-iterable"
    while True:
        try:
            item = next(it)
        except StopIteration:
            break
        except (r15.AbortCycle, _workers.ConfigBlocked):
            raise
        except Exception as e:
            return kept, drawn - len(kept), False, \
                "producer-error:%r" % (e,)
        drawn += 1
        if len(kept) < keep_max:
            kept.append(item)
        if drawn >= keep_max + PRODUCER_CEILING:
            break
    overrun = drawn >= keep_max + PRODUCER_CEILING
    return kept, drawn - len(kept), overrun, None


def _islice_capped(mapping, limit):
    """First `limit` items of a mapping without list()ing it. Callers check
    len() first and report the excess as dropped."""
    return list(itertools.islice(iter(mapping.items()), limit))


def _bound_str(s, limit):
    s = s if isinstance(s, str) else str(s)
    return s[:limit]


def _valid_symbol(s):
    return isinstance(s, str) and 0 < len(s) <= SYMBOL_CHARS_MAX


def _sized_ok(obj, byte_cap):
    """JSON-safe shape, then canonical size. Returns (ok, reason)."""
    ok, why = schema.json_safe(obj)
    if not ok:
        return False, "not-json-safe:%s" % why
    try:
        if len(schema.canon(obj)) > byte_cap:
            return False, "oversize"
    except (TypeError, ValueError):
        return False, "unserializable"
    return True, "ok"


def _require_governor(gov):
    """Require an explicit governor with persistent tier state and the full
    gate interface; a missing, stateless or partial one is ConfigBlocked at
    construction rather than mid-cycle."""
    if gov is None:
        raise _workers.ConfigBlocked("graph requires spend_governor")
    if getattr(gov, "state_dir", None) is None:
        raise _workers.ConfigBlocked(
            "spend_governor without state_dir: tier state would "
            "not be durable")
    for meth in ("tier", "decision", "verdict_snapshot",
                 "check_research_tier", "price_for",
                 "cheapest_model",
                 "worst_usd", "reserve_usd",
                 "reserve_research_call", "mark_invoked",
                 "settle_usd", "evaluate", "thesis_cap"):
        if not callable(getattr(gov, meth, None)):
            raise _workers.ConfigBlocked(
                "spend_governor missing interface: %s" % meth)
    return gov


def build_graph(deps):
    """deps: {harvest, extract_workers?, parser_extract?,
    hypothesize_build, hypothesize_parse, critique_build,
    critique_parse, provider_factory, provider_cfg, provider_cfgs?,
    pricing, budget_factory, spend_governor?, calibration_ranking?,
    cadence_state, checkpointer_conn, log_path?, model_timeout_s?,
    extract_timeout_s?, sandbox_cfg?, tool_factory?,
    executor_factory?, digest_dir?, signal_dir?, health_hook?}.

    harvest contract: (recs, stamps) or (recs, stamps, history); recs may be
    any iterable (bounded and validated here).
    provider_factory(cfg) -> raw provider: module-level builder invoked only
    inside run_gated's spawned child. Required; without it every LLM attempt
    is ConfigBlocked. provider_cfg selects the default research model;
    provider_cfgs maps model_id -> cfg for the Tier-2 cheapest switch (a
    cheapest model without a cfg blocks).
    spend_governor is required, with a persistent state_dir: an implicit
    SpendGovernor(..., state_dir=None) would lose durable tier state. It is
    also the sole pricing authority (deps["pricing"] is ignored), so price
    lookups, cheapest-model choice and worst-case computation use the same
    table as cap enforcement. log_path carries the attribution spans.
    budget_factory(cycle_id, symbol) -> handle with
    reserve_call/settle_call/check/snapshot.
    """
    if not _LANGGRAPH:
        raise RuntimeError("langgraph not installed (see requirements.txt)")
    for req in ("provider_factory", "budget_factory", "fuse",
                "hypothesize_build", "hypothesize_parse",
                "critique_build", "critique_parse",
                "spend_governor"):
        if req not in deps:
            raise _workers.ConfigBlocked("graph missing dep: %s" % req)
    if not callable(deps["provider_factory"]):
        raise _workers.ConfigBlocked("provider_factory not callable")
    _require_governor(deps["spend_governor"])

    def _blocked(state, msg):
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        if len(blocked) < BLOCKED_MAX:
            blocked.append(_bound_str(msg, BLOCKED_CHARS))
        return blocked

    def _tier(state):
        try:
            return deps["spend_governor"].tier()
        except Exception:
            return 3  # uncertain plane: most restrictive

    def _rank2(watchlist):
        """T2 watchlist cut: the 2 best-calibrated symbols. Without a supervisor
        calibration ranking it is the first 2 alphabetically; the ranking only
        chooses which two."""
        wl = [s for s in watchlist if _valid_symbol(s)]
        if len(wl) <= WATCHLIST_TIER2:
            return wl, "short-watchlist"
        ranking = deps.get("calibration_ranking")
        scored = []
        if isinstance(ranking, dict):
            for s in wl:
                v = ranking.get(s)
                # type-exact and finite: True is not 1.0, and infinity must not poison the ranking
                if type(v) in (int, float) and v == v and \
                        abs(v) != float("inf"):
                    scored.append((v, s))
        if len(scored) >= WATCHLIST_TIER2:
            scored.sort(key=lambda vs: (-vs[0], vs[1]))
            return [s for _, s in scored[:WATCHLIST_TIER2]], "calibrated"
        return sorted(wl)[:WATCHLIST_TIER2], "uncalibrated-fallback"

    def _invalid_harvest(state, msg):
        # malformed harvest envelope: stale/blocked, no publication
        return {"raw": [], "stamps": {}, "dropped_raw": 0,
                "malformed_raw": 0, "producer_overrun": False,
                "blocked": _blocked(state, "harvest:%s" % msg)}

    def harvest(state):
        out = deps["harvest"](state["watchlist"], state["epoch"])
        # envelope is (recs, stamps) or (recs, stamps, history); anything else is blocked evidence
        if not isinstance(out, (tuple, list)) or \
                not 2 <= len(out) <= 3:
            return _invalid_harvest(state, "envelope-shape")
        recs, stamps = out[0], out[1]
        hist = out[2] if len(out) > 2 else None
        if isinstance(recs, (str, bytes, dict)) or \
                not hasattr(recs, "__iter__"):
            return _invalid_harvest(state, "records-not-iterable")
        envelope_defects = 0
        if not isinstance(stamps, dict):
            stamps = {}
            envelope_defects += 1
        if hist is not None and not isinstance(hist, dict):
            hist = None
            envelope_defects += 1
        try:
            raw, dropped, overrun, herr = _drain(iter(recs), RAW_MAX)
        except (r15.AbortCycle, _workers.ConfigBlocked):
            raise
        except Exception as e:
            return _invalid_harvest(state, "records-error:%r" % (e,))
        if herr is not None:
            return _invalid_harvest(state, herr)
        # validate raw records (JSON-safe shape, then size) before orchestration
        valid = []
        malformed = 0
        for rec in raw:
            if not isinstance(rec, dict):
                malformed += 1
                continue
            syms = rec.get("symbols", [None])
            if not isinstance(syms, list) or not syms or any(
                    s is not None and not isinstance(s, str)
                    for s in syms):
                malformed += 1
                continue
            ok, _why = _sized_ok(rec, CANDIDATE_BYTES_MAX)
            if not ok:
                malformed += 1
                continue
            valid.append(rec)
        dropped += len(raw) - len(valid) + envelope_defects
        # stamps: len() gate before materialization, then islice
        stamps = stamps if isinstance(stamps, dict) else {}
        if len(stamps) > STAMPS_MAX:
            dropped += len(stamps) - STAMPS_MAX
        clean_stamps = {}
        for k, v in _islice_capped(stamps, STAMPS_MAX):
            if not isinstance(k, str) or len(k) > STAMP_KEY_CHARS_MAX:
                dropped += 1
                continue
            ok, _why = _sized_ok(v, STAMP_VALUE_BYTES_MAX)
            if not ok:
                dropped += 1
                continue
            clean_stamps[k] = v
        history = None
        history_dropped = 0
        if isinstance(hist, dict):
            if len(hist) > HISTORY_SOURCES_MAX:
                history_dropped += len(hist) - HISTORY_SOURCES_MAX
            history = {}
            for src, entries in _islice_capped(hist,
                                               HISTORY_SOURCES_MAX):
                if not isinstance(src, str) or not src or \
                        len(src) > HISTORY_SOURCE_KEY_MAX or \
                        not isinstance(entries, list):
                    history_dropped += 1
                    continue
                good = []
                for e in entries[:HISTORY_ENTRIES_MAX]:
                    if (isinstance(e, dict) and set(e) == {"h", "ts"}
                            and isinstance(e["h"], str)
                            and len(e["h"]) == 64
                            and type(e["ts"]) is int
                            and e["ts"] >= 0):
                        good.append({"h": e["h"], "ts": e["ts"]})
                    else:
                        history_dropped += 1
                history[src] = good
        upd = {"raw": valid, "stamps": clean_stamps,
               "dropped_raw": dropped, "malformed_raw": malformed,
               "producer_overrun": overrun}
        if history is not None:
            upd["history"] = history
            upd["history_dropped"] = history_dropped
        # T2 watchlist cut applies before any node sees the watchlist
        if _tier(state) >= 2:
            cut, why = _rank2(state.get("watchlist", []))
            upd["watchlist"] = cut
            upd["dropped_watchlist_tier"] = max(
                0, len(state.get("watchlist", [])) - len(cut))
            blocked = _blocked(state, "watchlist-tier2:%s" % why)
            if blocked:
                upd["blocked"] = blocked
        return upd

    def _null_class(rec):
        return rec.get("class") == "NULL" or \
            rec.get("source_id") in NULL_SOURCES

    def _default_extract(rec, ctx):
        """Graph-owned LLM extraction through run_gated, the only provider-
        reaching extract path. Test doubles may replace it via
        deps["extract_workers"]."""
        sandbox_cfg = deps.get("sandbox_cfg")
        if sandbox_cfg is None:
            raise _workers.ConfigBlocked("no sandbox for extraction")
        log_path = deps.get("log_path")
        if not log_path:
            raise _workers.ConfigBlocked("no attribution log")
        tier = _tier(ctx)
        model_id, cfg = _select_model(tier)
        out = _workers.run_gated(
            "extract", "extract", ctx.get("symbol") or "?",
            ctx.get("cycle_id", "local"), ctx.get("epoch", 0),
            {"brief": _workers._record_brief(rec),
             "rec_defaults": {
                 "kind": rec.get("kind", "filing_event"),
                 "symbols": [s for s in (rec.get("symbols") or [])
                             if isinstance(s, str)],
                 "provenance_url": rec.get("provenance_url")}},
            cfg, deps["provider_factory"], sandbox_cfg, ctx["budget"],
            deps["spend_governor"],
            model_id, log_path,
            _extract_timeout(), tool_factory=deps.get("tool_factory"),
            executor_factory=deps.get("executor_factory"),
            entry_tier=tier)
        if isinstance(out, dict) and "blocked" in out:
            raise _workers.ConfigBlocked("extract-result:%s" %
                                         out["blocked"])
        return out.get("candidates", []) if isinstance(out, dict) \
            else []

    def _model_timeout():
        # an invalid timeout blocks the attempt (ConfigBlocked), never becomes a default
        t = deps.get("model_timeout_s", MODEL_TIMEOUT_DEFAULT)
        if (type(t) not in (int, float) or t != t or
                not 1.0 <= t <= 3600.0):
            raise _workers.ConfigBlocked("bad-model-timeout:%r" % (t,))
        return float(t)

    def _extract_timeout():
        t = deps.get("extract_timeout_s", EXTRACT_TIMEOUT_DEFAULT)
        if (type(t) not in (int, float) or t != t or
                not 1.0 <= t <= 3600.0):
            raise _workers.ConfigBlocked("bad-extract-timeout:%r" % (t,))
        return float(t)

    def _select_model(tier):
        """(model_id, cfg): the default research model, or the cheapest
        configured model under Tier 2+. Identity and price both come from the
        governor; a cheapest model without a config blocks."""
        cfgs = deps.get("provider_cfgs") or {}
        default = deps.get("provider_cfg")
        gov = deps["spend_governor"]
        if tier >= 2:
            cheapest = gov.cheapest_model()
            if isinstance(cfgs, dict) and cheapest in cfgs:
                return cheapest, cfgs[cheapest]
            raise _workers.ConfigBlocked(
                "tier-2 cheapest model %r not configured" % (cheapest,))
        if not isinstance(default, dict) or \
                not default.get("model_id"):
            raise _workers.ConfigBlocked("no default provider_cfg")
        return default["model_id"], default

    def _keep_candidate(cand, origin, cands):
        """Stamp + bound one produced candidate. True when kept."""
        if not isinstance(cand, dict):
            return False
        cand = dict(cand)
        cand["origin"] = origin  # graph-stamped, never trusted from the candidate
        ok, _why = _sized_ok(cand, CANDIDATE_BYTES_MAX)
        if not ok or len(cands) >= CAND_MAX:
            return False
        cands.append(cand)
        return True

    def extract(state):
        cyc = state.get("cycle_id", "local")
        epoch = state.get("epoch", 0)
        tier = _tier(state)
        cands = []
        dropped = 0
        null_dropped = 0
        overrun = bool(state.get("producer_overrun"))
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        aborts = state.get("extract_aborts", 0)
        parser = deps.get("parser_extract")
        worker = deps.get("extract_workers") or _default_extract
        for rec in state.get("raw", []):
            if aborted:
                break  # doomed cycle: no further expensive work
            if tier >= 1 and _null_class(rec):
                # T1+: NULL-class extraction suspended
                null_dropped += 1
                continue
            syms = rec.get("symbols") or [None]
            sym = syms[0] if isinstance(syms[0], str) else None
            try:
                budget = deps["budget_factory"](cyc, sym)
                budget.check()
                # each producer drains under its own ceiling and is counted separately
                if parser is not None:
                    produced, pdrop, pov, perr = _drain(
                        parser(rec, budget), CAND_MAX - len(cands))
                    dropped += pdrop
                    overrun = overrun or pov
                    if perr is not None:
                        if len(blocked) < BLOCKED_MAX:
                            blocked.append(_bound_str(
                                "parser:%s" % perr, BLOCKED_CHARS))
                    else:
                        for cand in produced:
                            if not _keep_candidate(cand, "parser",
                                                   cands):
                                dropped += 1
                produced, wdrop, wov, werr = _drain(
                    worker(rec, {"budget": budget, "cycle_id": cyc,
                                 "symbol": sym, "epoch": epoch}),
                    CAND_MAX - len(cands))
                dropped += wdrop
                overrun = overrun or wov
                if werr is not None:
                    if len(blocked) < BLOCKED_MAX:
                        blocked.append(_bound_str(
                            "extract:%s" % werr, BLOCKED_CHARS))
                else:
                    for cand in produced:
                        if not _keep_candidate(cand, "llm", cands):
                            dropped += 1
            except r15.AbortCycle:
                # an ambiguous or errored attempt aborts the cycle and leaves blocked
                # evidence, so an aborted cycle never has an empty blocked list
                aborted = True
                aborts += 1
                if len(blocked) < BLOCKED_MAX:
                    blocked.append("extract-aborted")
            except _workers.ConfigBlocked as e:
                if len(blocked) < BLOCKED_MAX:
                    blocked.append(_bound_str("extract:%s" % e,
                                              BLOCKED_CHARS))
            except spend_mod.SpendRefused as e:
                # clean pre-spawn refusal (durable Tier 3, a tier raised since this node's
                # read, or the dollar cap): blocked evidence, not a node crash
                if len(blocked) < BLOCKED_MAX:
                    blocked.append(_bound_str(
                        "extract:spend-refused:%s" % e,
                        BLOCKED_CHARS))
        out = {"candidates": cands, "dropped_candidates": dropped,
               "dropped_null_class": null_dropped,
               "cycle_aborted": aborted, "extract_aborts": aborts,
               "producer_overrun": overrun}
        if blocked:
            out["blocked"] = blocked
        return out

    def fuse(state):
        fused = []
        dropped = 0
        overrun = bool(state.get("producer_overrun"))
        drawn = 0
        for cand in deps["fuse"](state.get("candidates", [])):
            drawn += 1
            if drawn > FUSED_MAX + PRODUCER_CEILING:
                overrun = True
                break
            if not isinstance(cand, dict):
                dropped += 1
                continue
            ok, _why = _sized_ok(cand, FUSED_CANDIDATE_BYTES_MAX)
            if not ok:
                dropped += 1
                continue
            if len(fused) < FUSED_MAX:
                fused.append(cand)
            else:
                dropped += 1
        if overrun:
            dropped += 1  # lower bound: the undrained remainder
        return {"fused": fused, "dropped_fused": dropped,
                "producer_overrun": overrun}

    def _llm_attempt(state, blocked, node, sym, build, parse,
                     entry_tier=None):
        """One model attempt via run_gated. Returns (value_or_None, blocked,
        aborted, model_ran). The provider is touched only inside run_gated's child.
        SpendRefused (clean pre-spawn refusal) becomes blocked evidence, not an
        abort. entry_tier is the node decision's snapshot tier (model choice,
        prose cap). A Tier-3 snapshot stops here; a stale lower one is refused by
        run_gated's durable re-read, atomic with the dollar hold
        (reserve_research_call)."""
        cyc = state.get("cycle_id", "local")
        epoch = state.get("epoch", 0)
        try:
            messages = build(sym, state)
        except Exception as e:
            return None, _blocked(state, "%s-build:%s" % (node, e)), \
                False, False
        log_path = deps.get("log_path")
        if not log_path:
            return None, _blocked(state, "%s:no-attribution-log" % node), \
                False, False
        if entry_tier is not None and entry_tier >= 3:
            return None, _blocked(
                state, "%s:research-llm-stopped" % node), False, False
        try:
            budget = deps["budget_factory"](cyc, sym)
            budget.check()
            tier = entry_tier if entry_tier is not None else \
                _tier(state)
            model_id, cfg = _select_model(tier)
            out = _workers.run_gated(
                "generate", node, sym or "?", cyc, epoch,
                {"messages": messages}, cfg, deps["provider_factory"],
                None, budget, deps["spend_governor"],
                model_id, log_path,
                _model_timeout(), entry_tier=entry_tier)
        except _workers.ConfigBlocked as e:
            return None, _blocked(state, "%s:%s" % (node, e)), False, False
        except spend_mod.SpendRefused as e:
            return None, _blocked(state, "%s-spend-refused:%s" % (node,
                                                                  e)), \
                False, False
        except r15.AbortCycle:
            return None, blocked, True, True
        except Exception as e:
            # run_gated raises only the above; anything else is a harness defect
            # (blocked evidence, counted, no abort)
            return None, _blocked(state, "%s-harness:%s" % (node, e)), \
                False, True
        if isinstance(out, dict) and "blocked" in out:
            return None, _blocked(state, "%s-result:%s" % (
                node, out["blocked"])), False, True
        try:
            value = parse(sym, out.get("text"), state)
        except Exception as e:
            return None, _blocked(state, "%s-parse:%s" % (node, e)), \
                False, True
        return value, blocked, False, True

    def _spend_verdict(state):
        # one snapshot per node decision: verdict, tier and reason come from a
        # single durable pass, so a concurrent tier raise cannot split them (a
        # stale (allow, 3) would skip the Tier-3 research stop)
        gov = deps["spend_governor"]
        try:
            return gov.verdict_snapshot()
        except Exception:
            return "deny", 3, "governor-error"

    def _signallable(state):
        # Tier-2+ research requires the durable sentinel path: the health hook is
        # supplemental telemetry and its failure never breaks the cycle, so a hook
        # alone must not gate Tier-2 work (without signal_dir the plane could
        # research before any durable SOFT_KILL exists)
        return bool(deps.get("signal_dir"))

    def hypothesize(state):
        out = {}
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        succeeded = []
        verdict, tier, reason = _spend_verdict(state)
        deps["cadence_state"].throttled = verdict in ("throttle", "cheap")
        if verdict == "deny":
            blocked = _blocked(state, "spend-deny:%s" % reason)
            # Tier 3 denies the whole LLM cycle: abort with research_abort accounting
            return {"thesis": {}, "cycle_aborted": True,
                    "blocked": blocked}
        if tier >= 2 and not _signallable(state):
            # the SOFT-kill signal cannot reach the supervisor: Tier-2 research without it is a breach
            blocked = _blocked(state, "spend-tier2-unsignallable")
            return {"thesis": {}, "cycle_aborted": True,
                    "blocked": blocked}
        cap = spend_mod.TIERS[tier]["thesis_cap"] if tier in spend_mod.TIERS \
            else THESIS_CHARS_MAX
        digest_dir = deps.get("digest_dir")
        for sym in state["watchlist"][:SYMBOL_MAX]:
            if aborted:
                break
            if not deps["cadence_state"].should_refresh(
                    sym, state["epoch"], state.get("trigger_symbols", ())):
                continue
            value, blocked, hit, _ran = _llm_attempt(
                dict(state, blocked=blocked), blocked, "hypothesize",
                sym, deps["hypothesize_build"],
                deps["hypothesize_parse"], entry_tier=tier)
            if hit:
                aborted = True
                out[sym] = ""
                continue
            # parse output must be a thesis string; anything else is rejected
            if not isinstance(value, str) or not value:
                blocked = _blocked(dict(state, blocked=blocked),
                                   "hypothesize:non-string-thesis"
                                   if isinstance(value, str)
                                   else "hypothesize:bad-thesis-type")
                out[sym] = ""
                continue
            if len(value) > cap:
                blocked = _blocked(dict(state, blocked=blocked),
                                   "hypothesize:thesis-too-long")
                out[sym] = ""
                continue
            if digest_dir is not None:
                try:
                    ok, why = digest.append_digest(
                        digest_dir, state["epoch"], sym, "hypothesize",
                        value)
                except OSError as e:
                    ok, why = False, "digest-io:%s" % e
                if not ok:
                    # a digest failure leaves the thesis stale: freshness advances only for durable output
                    blocked = _blocked(dict(state, blocked=blocked),
                                       "digest:%s:%s" % (sym, why))
                    out[sym] = ""
                    continue
            # freshness advances only after thesis and digest are both durable
            out[sym] = value
            succeeded.append(sym)
        try:
            deps["cadence_state"].mark_run(state["epoch"], succeeded)
        except OSError as e:
            blocked = _blocked(dict(state, blocked=blocked),
                               "cadence-persist-failed:%s" % e)
        upd = {"thesis": out, "cycle_aborted": aborted}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def critique(state):
        out = {}
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        verdict, tier, reason = _spend_verdict(state)
        if verdict == "deny":
            blocked = _blocked(state, "spend-deny:%s" % reason)
            return {"critique": out, "cycle_aborted": True,
                    "blocked": blocked}
        triggers = set(state.get("trigger_symbols", ()))
        skipped = 0
        for sym, text in state.get("thesis", {}).items():
            if aborted:
                break
            if not text:
                out[sym] = {"text": "", "disagreement": True}
                continue
            if tier >= 1 and sym not in triggers:
                # T1+: critique runs on TRIGGER-class symbols only; skipped symbols keep the safe default
                out[sym] = {"text": "", "disagreement": True}
                skipped += 1
                continue
            value, blocked, hit, _ran = _llm_attempt(
                dict(state, blocked=blocked), blocked, "critique",
                sym,
                lambda s, st, _t=text: deps["critique_build"](s, _t, st),
                lambda s, t, st: deps["critique_parse"](s, t, st),
                entry_tier=tier)
            if hit:
                aborted = True
                out[sym] = {"text": "", "disagreement": True}
                continue
            # critique output must be a dict with string text; otherwise the safe
            # default (len() only after isinstance)
            if not isinstance(value, dict):
                blocked = _blocked(dict(state, blocked=blocked),
                                   "critique:non-dict")
                out[sym] = {"text": "", "disagreement": True}
                continue
            ctext = value.get("text", "")
            if not isinstance(ctext, str):
                blocked = _blocked(dict(state, blocked=blocked),
                                   "critique:non-string-text")
                out[sym] = {"text": "", "disagreement": True}
                continue
            dis = value.get("disagreement", True)
            if not isinstance(dis, bool):
                dis = True
            if len(ctext) > CRITIQUE_CHARS_MAX:
                blocked = _blocked(dict(state, blocked=blocked),
                                   "critique:too-long")
                out[sym] = {"text": "", "disagreement": True}
                continue
            out[sym] = {"text": ctext, "disagreement": dis}
            digest_dir = deps.get("digest_dir")
            if digest_dir is not None:
                try:
                    ok, why = digest.append_digest(
                        digest_dir, state["epoch"], sym, "critique",
                        ctext,
                        extra={"disagreement": dis})
                except OSError as e:
                    ok, why = False, "digest-io:%s" % e
                if not ok:
                    blocked = _blocked(dict(state, blocked=blocked),
                                       "digest:%s:%s" % (sym, why))
        upd = {"critique": out, "cycle_aborted": aborted,
               "skipped_critique_tier": skipped}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def _ensure_signal(kind, tier, state):
        """Durable kill-signal sentinel (required) plus a hook event
        (supplemental telemetry). The plane signals; the supervisor acts. A
        sentinel write failure raises, so the caller fails the cycle rather than
        run Tier-2+ research unsignalled."""
        proj = 0.0
        try:
            _t, proj = deps["spend_governor"].evaluate()
        except Exception:
            proj = 0.0
        row = {"signal": kind, "tier": tier, "projection_30d": proj,
               "ts": int(time.time()),
               "cycle_id": state.get("cycle_id", "local")}
        sigdir = deps.get("signal_dir")
        if not sigdir:
            # no durable path: the signal cannot be proven
            raise _workers.ConfigBlocked("signal-dir-missing:%s" % kind)
        os.makedirs(sigdir, exist_ok=True)
        locks.atomic_write_bytes(
            sigdir, kind,
            json.dumps(row, sort_keys=True).encode("utf-8"))
        hook = deps.get("health_hook")
        if hook is not None:
            try:
                hook(dict(row))
            except Exception as e:
                # telemetry failure is returned but never breaks the cycle; the sentinel is authoritative
                return row, "health-hook-failed:%s" % e
        return row, None

    def emit(state):
        # steady-state estimate input: per-cycle model-call totals from the durable
        # budgets (attribution rows remain the audit source). A deleted live counter
        # raises AbortCycle here (blocked evidence), so the estimate never silently
        # under-counts
        r15_blind = False
        try:
            syms = set(state.get("watchlist", [])) | {None}
            cyc = state.get("cycle_id", "local")
            total = 0
            for s in syms:
                try:
                    total += (deps["budget_factory"](cyc, s).llm or 0)
                except r15.AbortCycle:
                    r15_blind = True
                except (_workers.ConfigBlocked, AttributeError,
                        TypeError):
                    pass
            deps["cadence_state"].record_cycle(total)
        except (AttributeError, TypeError):
            pass
        soft = medium = False
        try:
            tier = deps["spend_governor"].tier()
        except Exception:
            tier = 3
        blocked_emit = [_bound_str(b, BLOCKED_CHARS)
                        for b in (state.get("blocked") or [])
                        [:BLOCKED_MAX]]
        if r15_blind and len(blocked_emit) < BLOCKED_MAX:
            blocked_emit.append("r15-budget-unreadable")
        if tier >= 2:
            try:
                _row, hook_note = _ensure_signal("SOFT_KILL", tier,
                                                  state)
                if hook_note and len(blocked_emit) < BLOCKED_MAX:
                    blocked_emit.append(_bound_str(hook_note,
                                                   BLOCKED_CHARS))
                soft = True
            except (OSError, _workers.ConfigBlocked) as e:
                # unsignallable Tier-2+: fail closed, publish nothing
                upd = {"soft_kill": False, "medium_kill": False,
                       "emitted": None, "aborted": True,
                       "blocked": _blocked(
                           state, "signal-persist-failed:%s" % e)}
                return upd
        if tier >= 3:
            try:
                _row, hook_note = _ensure_signal("MEDIUM_KILL", tier,
                                                  state)
                if hook_note and len(blocked_emit) < BLOCKED_MAX:
                    blocked_emit.append(_bound_str(hook_note,
                                                   BLOCKED_CHARS))
                medium = True
            except (OSError, _workers.ConfigBlocked) as e:
                upd = {"soft_kill": soft, "medium_kill": False,
                       "emitted": None, "aborted": True,
                       "blocked": _blocked(
                           state, "signal-persist-failed:%s" % e)}
                return upd
        hook = deps.get("health_hook")
        if hook is not None:
            try:
                hook({"cycle_id": state.get("cycle_id", "local"),
                      "epoch": state["epoch"],
                      "aborted": bool(state.get("cycle_aborted")),
                      "watchlist": list(state.get("watchlist", [])),
                      "tier": tier, "soft_kill": soft,
                      "medium_kill": medium,
                      "blocked": list(state.get("blocked") or [])})
            except Exception as e:
                # supervision telemetry failure is blocked evidence, never a cycle-breaker
                if len(blocked_emit) < BLOCKED_MAX:
                    blocked_emit.append(_bound_str(
                        "health-hook-failed:%s" % e, BLOCKED_CHARS))
        upd = {"soft_kill": soft, "medium_kill": medium}
        # an aborted cycle publishes nothing; the last complete bundle stands and
        # the supervisor records research_abort
        if state.get("cycle_aborted"):
            upd.update({"emitted": None, "aborted": True})
            if blocked_emit:
                upd["blocked"] = blocked_emit
            return upd
        upd.update(deps["resolve_emit"](state))
        upd.setdefault("aborted", False)
        if blocked_emit:
            seen = set(upd.get("blocked") or [])
            merged = list(upd.get("blocked") or [])
            for b in blocked_emit:
                if b not in seen and len(merged) < BLOCKED_MAX:
                    merged.append(b)
                    seen.add(b)
            upd["blocked"] = merged
        return upd

    g = StateGraph(PlaneState)
    g.add_node("harvest", harvest)
    g.add_node("extract", extract)
    g.add_node("fuse", fuse)
    g.add_node("hypothesize", hypothesize)
    g.add_node("critique", critique)
    g.add_node("emit", emit)
    g.set_entry_point("harvest")
    for a, b in zip(NODES, NODES[1:]):
        g.add_edge(a, b)
    g.add_edge("emit", END)
    checkpointer = retention.make_saver(deps["checkpointer_conn"])
    return g.compile(checkpointer=checkpointer)


def run_cycle(app, watchlist, epoch, thread_id, trigger_symbols=()):
    """One supervised cycle. thread_id is the cycle_id (str, charset
    [A-Za-z0-9_.~-], 1..64 chars; it enters checkpoint state, SQLite keys,
    span IDs and filenames). epoch is an exact int in range.
    trigger_symbols makes TRIGGER-immediate cadence reachable. A second
    concurrent run_cycle raises RuntimeError (SqliteSaver is not thread safe)."""
    if not isinstance(thread_id, str) or not THREAD_ID_RE.fullmatch(
            thread_id):
        raise ValueError("bad thread_id: %r" % (thread_id,))
    if type(epoch) is not int or isinstance(epoch, bool) or \
            not 0 <= epoch <= EPOCH_MAX:
        raise ValueError("bad epoch: %r" % (epoch,))
    _reject_stale_thread(app, thread_id)
    if not _RUN_GUARD.acquire(blocking=False):
        raise RuntimeError("concurrent run_cycle refused: one active "
                           "graph run per process")
    try:
        wl_in, wl_drop = _capped_count(watchlist, WATCHLIST_MAX)
        wl = [s for s in wl_in if _valid_symbol(s)]
        wl_drop += len(wl_in) - len(wl)
        trig_in, _t_drop = _capped_count(trigger_symbols, TRIGGER_MAX)
        trig = tuple(s for s in trig_in if _valid_symbol(s))
        state = {"watchlist": wl, "epoch": epoch,
                 "cycle_id": thread_id,
                 "trigger_symbols": trig,
                 "dropped_watchlist": wl_drop,
                 "producer_overrun": False}
        return app.invoke(state,
                          {"configurable": {"thread_id": thread_id}})
    finally:
        _RUN_GUARD.release()


def _reject_stale_thread(app, thread_id):
    """Refuse a thread_id whose checkpoint outlives R15 budget authority.
    Counters are kept 7 days and checkpoints 30, so resuming an older cycle
    would mint it a fresh budget under the same cycle_id.
      no checkpointer on the app -> proceed;
      no checkpoint for the thread (no checkpoint id) -> proceed;
      checkpoint recent with a valid timestamp -> proceed;
      checkpoint old -> reject;
      timestamp unreadable -> reject (age unprovable);
      checkpoint present (by id) but timestamp missing -> reject;
      checkpoint lookup fails -> reject (an unverifiable checkpoint set must
        not skip the guard).
    """
    from . import budgets as _budgets
    if getattr(app, "checkpointer", None) is None:
        # no checkpoint retention on this app: no stale-resume vector
        return
    try:
        snap = app.get_state({"configurable":
                              {"thread_id": thread_id}})
    except Exception as e:
        raise ValueError("stale thread_id (checkpoint lookup "
                         "failed): %r" % (thread_id,)) from e
    created = getattr(snap, "created_at", None)
    if not created:
        # no timestamp: presence is tested by checkpoint identity
        # (config.checkpoint_id), since LangGraph types created_at as str | None
        cid = None
        try:
            cfg = getattr(snap, "config", None)
            if isinstance(cfg, dict):
                cid = cfg.get("configurable", {}).get(
                    "checkpoint_id")
        except (AttributeError, TypeError):
            cid = None
        if cid:
            raise ValueError("stale thread_id (checkpoint %r has "
                             "no readable age): %r" % (cid,
                                                         thread_id))
        return
    try:
        import datetime as _dt
        parsed = _dt.datetime.fromisoformat(created)
    except (ValueError, TypeError, OverflowError) as e:
        raise ValueError("stale thread_id (unreadable checkpoint "
                         "age): %r" % (thread_id,)) from e
    if parsed.tzinfo is None:
        # a naive timestamp is host-local time: age is unprovable, so reject
        raise ValueError("stale thread_id (timezone-less checkpoint "
                         "age): %r" % (thread_id,))
    age = time.time() - parsed.timestamp()
    from . import r15 as _r15
    if age < -_r15.CLOCK_SKEW_S:
        # a checkpoint from the future extends the budget window like a future start_wall: reject
        raise ValueError("stale thread_id (checkpoint in the "
                         "future): %r" % (thread_id,))
    if age > _budgets.LEDGER_RETAIN_DAYS * 86400:
        raise ValueError("stale thread_id (checkpoint %.1f days "
                         "old, R15 window %d): %r"
                         % (age / 86400,
                            _budgets.LEDGER_RETAIN_DAYS, thread_id))


def _capped_count(items, limit):
    it = iter(items)
    head = list(itertools.islice(it, limit + 1))
    extra = 0
    for _ in it:
        extra += 1
        if extra > PRODUCER_CEILING:
            break
    return head[:limit], max(0, len(head) - limit) + extra
