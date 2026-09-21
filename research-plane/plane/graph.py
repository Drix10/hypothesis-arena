"""D1 six-node research graph (doc 08 sec. 8.3, LangGraph, pinned).

harvest -> extract -> fuse -> hypothesize -> critique -> emit

- Checkpointed after every node (hardened SqliteSaver: strict msgpack
  allowlist, fail-closed; 30-day retention via retention module under
  the supervisor) for resume at the last completed node.
- ONE active run_cycle per process (module guard): synchronous
  SqliteSaver is documented for lightweight synchronous use and does
  not scale to multiple threads — concurrency is refused loudly, not
  silently corrupted.
- Side-effecting nodes carry idempotency keys: re-execution converges,
  never duplicates (emit re-emit is idempotent by bundle_id; digest
  appends are keyed by epoch+symbol+node).
- hypothesize/critique are gated by cadence.py (TRIGGER-new or 30-min
  TTL; triggers arrive as explicit run_cycle() input), capped by
  durable R15 budgets, governed by spend.py tiers. Failure defaults
  per doc 08 §8.3 table.

R15/ATTRIBUTION BOUNDARY (finding 1 — enforced, not documented):
hypothesize/critique NEVER receive a model object. They are pure
build/parse callables:
  build(sym, state) -> messages (pure prompt construction, no I/O),
  parse(sym, text, state) -> thesis/critique (pure shaping, no I/O).
The GRAPH performs every provider call through the REQUIRED
deps["model_factory"](node, symbol, budget, cycle_id) -> gated model
(workers.GatedModel: reserve-before-execute, token reconciliation,
watchdog timeout, exactly-one-span). An arbitrary DEP callable
physically cannot reach the provider — there is no model reference
outside the graph's live call. model_factory raising ConfigBlocked
(no key / no sandbox / no pricing) applies the documented per-node
failure defaults.

- Cycle identity: run_cycle() stamps state["cycle_id"] = thread_id.
  Budgets come from deps["budget_factory"](cycle_id, symbol) per
  attempt — one compiled app serving two thread_ids accrues two
  disjoint ledger namespaces and two span identities. There are no
  compile-time-global budgets.
- Budgets are supervisor-owned durable handles outside checkpoints.
  Node boundaries call budget.check() (guard, no increment); actual
  attempts reserve through the gated model. No budget for a symbol is
  impossible: the factory mints the (cycle, symbol) row on first
  reserve; a corrupt ledger aborts instead of resetting.
- AbortCycle sets cycle_aborted AND short-circuits: no further
  expensive work runs once the cycle cannot publish.
- Cadence freshness advances ONLY after a successful thesis AND its
  successful digest write; persist failures are blocked evidence.
- The frozen thesis is <=500 chars: longer producer output is
  REJECTED (thesis-too-long), never truncated. Model prompts are
  size-capped (32KB) before any reservation (spend protection).
- PlaneHealth is SUPERVISOR-owned: the emit node reports the cycle
  outcome through optional deps["health_hook"](summary).
- Harvest is a trust boundary: raw records are type/shape-validated
  before orchestration (malformed counted, never indexed).
- Producers are drained through a hard iteration ceiling (finding 22):
  caps bound memory; the ceiling bounds CPU. Overrun reports a
  lower-bound dropped count + producer-overrun flag instead of
  iterating forever.
- Every checkpointed field is bounded (watchlist/trigger symbol
  type+length, stamps, blocked, history shape, fused candidate bytes,
  thesis text). Origin stamping is graph-owned: worker output is
  stamped origin="llm" (overwritten, never trusted from the
  candidate), parser output origin="parser".
"""
import itertools
import json
import threading
import time

try:
    from typing_extensions import TypedDict
    from langgraph.graph import END, StateGraph
    _LANGGRAPH = True
except ImportError:  # pragma: no cover - build gate pins the dep
    _LANGGRAPH = False

from . import cadence, digest, r15, retention
from . import emit as emit_mod
from . import workers as _workers

NODES = ("harvest", "extract", "fuse", "hypothesize", "critique", "emit")

# Checkpoint resource caps: stored state is bounded BEFORE
# materialization (bounded iterators below); counts record the rest.
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
HISTORY_ENTRIES_MAX = 256
THESIS_CHARS_MAX = 500  # frozen thesis: reject, never truncate
CRITIQUE_CHARS_MAX = 2000
CANDIDATE_BYTES_MAX = 16384
MODEL_PROMPT_BYTES_MAX = 32768
# Hard producer-iteration ceiling (CPU bound to go with the memory
# caps): a harvest/fuse iterable yielding beyond limit+ceiling stops
# the drain with producer_overrun=True and a lower-bound count.
PRODUCER_CEILING = 10000

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
    fused: list
    thesis: dict
    critique: dict
    bundle_id: str
    blocked: list
    cycle_aborted: bool
    emitted: object
    aborted: bool
    dropped_raw: int
    dropped_candidates: int
    dropped_fused: int
    dropped_watchlist: int
    producer_overrun: bool


def _take_capped(producer, limit):
    """Consume an (untrusted, possibly infinite) iterable, keeping the
    FIRST `limit` items. At most limit+PRODUCER_CEILING items are drawn;
    beyond that the drain stops with overrun=True and dropped reported
    as a LOWER BOUND (never an infinite count loop)."""
    kept = []
    drawn = 0
    overrun = False
    for item in producer:
        drawn += 1
        if len(kept) < limit:
            kept.append(item)
        if drawn >= limit + PRODUCER_CEILING:
            overrun = True
            break
    dropped = max(0, drawn - len(kept))
    return kept, dropped, overrun


def _bound_str(s, limit):
    s = s if isinstance(s, str) else str(s)
    return s[:limit]


def _valid_symbol(s):
    return isinstance(s, str) and 0 < len(s) <= SYMBOL_CHARS_MAX


def build_graph(deps):
    """deps: {harvest, extract_workers, parser_extract?,
    hypothesize_build, hypothesize_parse, critique_build,
    critique_parse, model_factory, budget_factory, spend_governor?,
    cadence_state, checkpointer_conn, digest_dir?, health_hook?}.

    harvest contract: (recs, stamps) or (recs, stamps, history); recs
    may be ANY iterable (bounded + validated here).
    model_factory(node, symbol, budget, cycle_id) -> gated model with
    .generate(messages, **kw). budget_factory(cycle_id, symbol) ->
    budget handle with check()/snapshot(). Both REQUIRED: a missing
    factory is ConfigBlocked for every LLM attempt (fail closed).
    """
    if not _LANGGRAPH:
        raise RuntimeError("langgraph not installed (see requirements.txt)")
    for req in ("model_factory", "budget_factory", "fuse",
                "hypothesize_build", "hypothesize_parse",
                "critique_build", "critique_parse"):
        if req not in deps:
            raise _workers.ConfigBlocked("graph missing dep: %s" % req)

    def _blocked(state, msg):
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        if len(blocked) < BLOCKED_MAX:
            blocked.append(_bound_str(msg, BLOCKED_CHARS))
        return blocked

    def harvest(state):
        out = deps["harvest"](state["watchlist"], state["epoch"])
        recs, stamps = out[0], out[1]
        hist = out[2] if len(out) > 2 else None
        raw, dropped, overrun = _take_capped(iter(recs), RAW_MAX)
        # Raw validation BEFORE orchestration: harvest is a trust
        # boundary; malformed records count, never crash indexing.
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
            try:
                if len(json.dumps(rec, sort_keys=True, default=str)) > \
                        CANDIDATE_BYTES_MAX:
                    malformed += 1
                    continue
            except (TypeError, ValueError):
                malformed += 1
                continue
            valid.append(rec)
        dropped += len(raw) - len(valid)
        stamps = stamps if isinstance(stamps, dict) else {}
        items = list(stamps.items())[:STAMPS_MAX]
        stamps = {}
        for k, v in items:
            if not isinstance(k, str) or len(k) > STAMP_KEY_CHARS_MAX:
                continue
            try:
                if len(json.dumps(v, default=str)) > \
                        STAMP_VALUE_BYTES_MAX:
                    continue
            except (TypeError, ValueError):
                continue
            stamps[k] = v
        history = None
        history_dropped = 0
        if isinstance(hist, dict):
            history = {}
            for src, entries in list(hist.items())[:HISTORY_SOURCES_MAX]:
                if not isinstance(src, str) or not isinstance(entries,
                                                              list):
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
            history_dropped += max(
                0, len(hist) - HISTORY_SOURCES_MAX)
        upd = {"raw": valid, "stamps": stamps, "dropped_raw": dropped,
               "malformed_raw": malformed,
               "producer_overrun": overrun}
        if history is not None:
            upd["history"] = history
            upd["history_dropped"] = history_dropped
        return upd

    def _stamp(cands, origin):
        out = []
        dropped = 0
        for cand in cands:
            if not isinstance(cand, dict):
                dropped += 1
                continue
            cand = dict(cand)
            cand["origin"] = origin  # graph-owned overwrite: candidate
            # output can never self-declare a trusted parser origin.
            out.append(cand)
        return out, dropped

    def extract(state):
        cyc = state.get("cycle_id", "local")
        cands = []
        dropped = 0
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        aborts = state.get("extract_aborts", 0)
        parser = deps.get("parser_extract")
        for rec in state.get("raw", []):
            if aborted:
                break  # doomed cycle: no further expensive work
            syms = rec.get("symbols") or [None]
            sym = syms[0] if isinstance(syms[0], str) else None
            try:
                budget = deps["budget_factory"](cyc, sym)
                budget.check()
                produced = []
                if parser is not None:
                    for cand in parser(rec, budget):
                        produced.append((cand, "parser"))
                for cand in deps["extract_workers"](rec, budget):
                    produced.append((cand, "llm"))
                for cand, origin in produced:
                    if not isinstance(cand, dict):
                        dropped += 1
                        continue
                    cand = dict(cand)
                    cand["origin"] = origin
                    try:
                        oversize = len(json.dumps(
                            cand, sort_keys=True, default=str)) > \
                            CANDIDATE_BYTES_MAX
                    except (TypeError, ValueError):
                        oversize = True
                    if oversize or len(cands) >= CAND_MAX:
                        dropped += 1
                    else:
                        cands.append(cand)
            except r15.AbortCycle:
                aborted = True
                aborts += 1
            except _workers.ConfigBlocked as e:
                if len(blocked) < BLOCKED_MAX:
                    blocked.append(_bound_str("extract:%s" % e,
                                              BLOCKED_CHARS))
        out = {"candidates": cands, "dropped_candidates": dropped,
               "cycle_aborted": aborted, "extract_aborts": aborts}
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
            try:
                if len(json.dumps(cand, sort_keys=True, default=str)) > \
                        FUSED_CANDIDATE_BYTES_MAX:
                    dropped += 1
                    continue
            except (TypeError, ValueError):
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

    def _llm_attempt(state, blocked, node, sym, build, parse):
        """One FORCED-boundary model attempt. Returns
        (value_or_None, blocked, aborted, model_ran). The provider is
        touched ONLY by model_factory's gated model, inside this
        function — build/parse callables never see it."""
        cyc = state.get("cycle_id", "local")
        try:
            messages = build(sym, state)
        except Exception as e:
            return None, _blocked(state, "%s-build:%s" % (node, e)), \
                False, False
        try:
            prompt_bytes = len(json.dumps(messages, default=str))
        except (TypeError, ValueError):
            return None, _blocked(state, "%s-prompt-shape" % node), \
                False, False
        if prompt_bytes > MODEL_PROMPT_BYTES_MAX:
            return None, _blocked(state, "%s-prompt-too-large" % node), \
                False, False
        try:
            budget = deps["budget_factory"](cyc, sym)
            budget.check()
            model = deps["model_factory"](node, sym, budget, cyc)
        except _workers.ConfigBlocked as e:
            return None, _blocked(state, "%s:%s" % (node, e)), False, False
        try:
            text = model.generate(messages)
        except r15.AbortCycle:
            return None, blocked, True, True
        except _workers.ConfigBlocked as e:
            return None, _blocked(state, "%s:%s" % (node, e)), False, True
        except Exception as e:
            return None, _blocked(state, "%s-error:%s" % (node, e)), \
                False, True
        try:
            value = parse(sym, text, state)
        except Exception as e:
            return None, _blocked(state, "%s-parse:%s" % (node, e)), \
                False, True
        return value, blocked, False, True

    def _spend_verdict(state):
        gov = deps.get("spend_governor")
        if gov is None:
            return "allow", "no-governor"
        try:
            return gov.decision()
        except Exception:
            return "deny", "governor-error"

    def hypothesize(state):
        out = {}
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        succeeded = []
        verdict, reason = _spend_verdict(state)
        deps["cadence_state"].throttled = (verdict != "allow")
        if verdict == "deny":
            blocked = _blocked(state, "spend-deny:%s" % reason)
            # Tier 3 denies the whole LLM cycle: abort (no publication)
            # with research_abort accounting, not a silent skip.
            return {"thesis": {}, "cycle_aborted": True,
                    "blocked": blocked}
        digest_dir = deps.get("digest_dir")
        for sym in state["watchlist"][:SYMBOL_MAX]:
            if aborted:
                break
            if verdict == "triggers-only" and \
                    sym not in set(state.get("trigger_symbols", ())):
                continue
            if not deps["cadence_state"].should_refresh(
                    sym, state["epoch"], state.get("trigger_symbols", ())):
                continue
            value, blocked, hit, _ran = _llm_attempt(
                dict(state, blocked=blocked), blocked, "hypothesize",
                sym, deps["hypothesize_build"],
                deps["hypothesize_parse"])
            if hit:
                aborted = True
                out[sym] = ""
                continue
            if value is None:
                out[sym] = ""
                continue
            text = value if isinstance(value, str) else str(value)
            # Frozen thesis: reject over-long output, never truncate.
            if len(text) > THESIS_CHARS_MAX or not text:
                blocked = _blocked(dict(state, blocked=blocked),
                                   "hypothesize:thesis-too-long"
                                   if text else "hypothesize:empty")
                out[sym] = ""
                continue
            if digest_dir is not None:
                try:
                    ok, why = digest.append_digest(
                        digest_dir, state["epoch"], sym, "hypothesize",
                        text)
                except OSError as e:
                    ok, why = False, "digest-io:%s" % e
                if not ok:
                    # Digest failure leaves the thesis STALE: freshness
                    # advances only for fully durable output.
                    blocked = _blocked(dict(state, blocked=blocked),
                                       "digest:%s:%s" % (sym, why))
                    out[sym] = ""
                    continue
            # Freshness advances ONLY after thesis AND digest both durable.
            out[sym] = text
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
        verdict, reason = _spend_verdict(state)
        if verdict == "deny":
            blocked = _blocked(state, "spend-deny:%s" % reason)
            return {"critique": out, "cycle_aborted": True,
                    "blocked": blocked}
        digest_dir = deps.get("digest_dir")
        for sym, text in state.get("thesis", {}).items():
            if aborted:
                break
            if not text:
                out[sym] = {"text": "", "disagreement": True}
                continue
            value, blocked, hit, _ran = _llm_attempt(
                dict(state, blocked=blocked), blocked, "critique",
                sym,
                lambda s, st, _t=text: deps["critique_build"](s, _t, st),
                lambda s, t, st: deps["critique_parse"](s, t, st))
            if hit:
                aborted = True
                out[sym] = {"text": "", "disagreement": True}
                continue
            if value is None:
                out[sym] = {"text": "", "disagreement": True}
                continue
            crit = value if isinstance(value, dict) else {"text": value,
                                                          "disagreement":
                                                          True}
            crit = {"text": crit.get("text", "") if isinstance(
                crit, dict) else crit,
                    "disagreement": bool(crit.get("disagreement", True))
                    if isinstance(crit, dict) else True}
            if len(crit["text"]) > CRITIQUE_CHARS_MAX:
                blocked = _blocked(dict(state, blocked=blocked),
                                   "critique:too-long")
                out[sym] = {"text": "", "disagreement": True}
                continue
            out[sym] = crit
            if digest_dir is not None:
                try:
                    ok, why = digest.append_digest(
                        digest_dir, state["epoch"], sym, "critique",
                        crit["text"],
                        extra={"disagreement": crit["disagreement"]})
                except OSError as e:
                    ok, why = False, "digest-io:%s" % e
                if not ok:
                    blocked = _blocked(dict(state, blocked=blocked),
                                       "digest:%s:%s" % (sym, why))
        upd = {"critique": out, "cycle_aborted": aborted}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def emit(state):
        # Steady-state estimate input: per-cycle model-call totals from
        # the durable budgets (attribution rows remain the audit source).
        try:
            syms = set(state.get("watchlist", [])) | {None}
            cyc = state.get("cycle_id", "local")
            total = 0
            for s in syms:
                try:
                    total += (deps["budget_factory"](cyc, s).llm or 0)
                except (r15.AbortCycle, _workers.ConfigBlocked,
                        AttributeError, TypeError):
                    pass
            deps["cadence_state"].record_cycle(total)
        except (AttributeError, TypeError):
            pass
        hook = deps.get("health_hook")
        if hook is not None:
            try:
                hook({"cycle_id": state.get("cycle_id", "local"),
                      "epoch": state["epoch"],
                      "aborted": bool(state.get("cycle_aborted")),
                      "watchlist": list(state.get("watchlist", [])),
                      "blocked": list(state.get("blocked") or [])})
            except Exception:
                pass  # supervision telemetry never breaks the cycle
        # Frozen contract: an aborted cycle publishes NOTHING. The last
        # complete bundle stands; the supervisor records research_abort.
        if state.get("cycle_aborted"):
            return {"emitted": None, "aborted": True}
        upd = deps["resolve_emit"](state)
        upd.setdefault("aborted", False)
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
    """One supervised cycle. thread_id IS the cycle_id: it is stamped
    into state, so budgets/attribution/health derive run-scoped
    identities from the actual run — never a compile-time global.
    trigger_symbols makes TRIGGER-immediate cadence reachable.
    Single-run-per-process: a second concurrent run_cycle raises
    RuntimeError (synchronous SqliteSaver is not multi-thread safe)."""
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


def _capped_count(items, limit):
    it = iter(items)
    head = list(itertools.islice(it, limit + 1))
    extra = 0
    for _ in it:
        extra += 1
        if extra > PRODUCER_CEILING:
            break
    return head[:limit], max(0, len(head) - limit) + extra
