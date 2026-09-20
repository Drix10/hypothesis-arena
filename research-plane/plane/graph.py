"""D1 six-node research graph (doc 08 sec. 8.3, LangGraph, pinned).

harvest -> extract -> fuse -> hypothesize -> critique -> emit

- Checkpointed after every node (hardened SqliteSaver: strict msgpack
  allowlist; 30-day retention via retention.prune_checkpoints under the
  supervisor) for resume at the last completed node.
- Side-effecting nodes carry idempotency keys: re-execution converges,
  never duplicates (emit re-emit is idempotent by bundle_id; digest
  appends are keyed by epoch+symbol+node).
- hypothesize/critique are gated by cadence.py (TRIGGER-new or 30-min
  TTL; triggers arrive as explicit run_cycle() input), capped by
  durable R15 budgets. Failure defaults per doc 08 §8.3 table.
- LLM nodes run through workers.py (sandboxed smolagents or deterministic
  stub when no model key is configured — explicit blocker, never fake).

Enforcement placement (frozen):
- R15 budgets come from deps["budgets"] (supervisor-owned durable
  handles, outside checkpoints). Node boundaries call budget.check()
  (guard, no increment); the dep callables MUST charge actual usage
  through reserve_*/settle_* (workers.py wrappers do; stubs use
  charge_*). A symbol with no wired budget is ConfigBlocked (fail
  closed: no budget, no call).
- Budgets are keyed by (cycle_id, symbol); cycle_id is the
  run_cycle() thread_id, so crash-resume reconstructs counters from
  the ledger instead of minting fresh ones.
- ConfigBlocked applies the documented per-node failure defaults and
  marks state. AbortCycle sets cycle_aborted AND short-circuits: no
  further expensive work runs once the cycle cannot publish.
- Cadence freshness advances ONLY for successful theses; persist
  failures are blocked evidence, never cycle crashes.
- PlaneHealth is SUPERVISOR-owned: the graph never pauses/degrades
  itself. The emit node reports the cycle outcome through the optional
  deps["health_hook"](summary); pausing/degrading/restarting is the
  supervisor's job (deployment contract, not an implied Phase-D
  feature).
- Every checkpointed field is bounded (finding 18): watchlist,
  triggers, stamps, blocked, history, thesis/critique text, candidate
  size. Caps truncate oldest-arrival... keep-FIRST (stable order) and
  count the dropped rest; untrusted producers are consumed through
  bounded iterators (never list() before the cap).
"""
import sqlite3
import time

try:
    from typing_extensions import TypedDict
    from langgraph.checkpoint.sqlite import SqliteSaver
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
SYMBOL_MAX = 64
WATCHLIST_MAX = 64
TRIGGER_MAX = 64
BLOCKED_MAX = 128
BLOCKED_CHARS = 256
STAMPS_MAX = 256
HISTORY_SOURCES_MAX = 16
HISTORY_ENTRIES_MAX = 256
THESIS_CHARS_MAX = 4096
CRITIQUE_CHARS_MAX = 4096
CANDIDATE_BYTES_MAX = 16384


class PlaneState(TypedDict, total=False):
    watchlist: list
    epoch: int
    trigger_symbols: tuple
    raw: list
    stamps: dict
    history: dict
    candidates: list
    extract_aborts: int
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


def _take_capped(producer, limit):
    """Consume an (untrusted, possibly huge) iterable, keeping the
    FIRST `limit` items and counting the rest WITHOUT materializing
    them. Returns (kept, dropped)."""
    kept = []
    dropped = 0
    for item in producer:
        if len(kept) < limit:
            kept.append(item)
        else:
            dropped += 1
    return kept, dropped


def _bound_str(s, limit):
    s = s if isinstance(s, str) else str(s)
    return s[:limit]


def build_graph(deps):
    """deps: {harvest, extract_workers, hypothesize, critique,
    resolve_emit, budgets, cadence_state, checkpointer_conn,
    digest_dir?, health_hook?, cycle_id?}.

    harvest(records contract): returns (recs, stamps) or
      (recs, stamps, history); recs may be ANY iterable (bounded here).
      history = {source: [{h: hex64, ts: int}]}, bounded here.
    """
    if not _LANGGRAPH:
        raise RuntimeError("langgraph not installed (see requirements.txt)")
    cycle_id = deps.get("cycle_id", "local")

    def _budget(sym):
        b = (deps.get("budgets") or {}).get(sym)
        if b is None:
            raise _workers.ConfigBlocked("no R15 budget for %s" % sym)
        return b

    def harvest(state):
        out = deps["harvest"](state["watchlist"], state["epoch"])
        recs, stamps = out[0], out[1]
        hist = out[2] if len(out) > 2 else None
        raw, dropped = _take_capped(iter(recs), RAW_MAX)
        # Individual record size bound (checkpointed state stays small).
        bounded = []
        for rec in raw:
            try:
                import json as _json
                if len(_json.dumps(rec, sort_keys=True,
                                   default=str)) > CANDIDATE_BYTES_MAX:
                    dropped += 1
                    continue
            except (TypeError, ValueError):
                dropped += 1
                continue
            bounded.append(rec)
        raw = bounded
        stamps = stamps if isinstance(stamps, dict) else {}
        if len(stamps) > STAMPS_MAX:
            stamps = dict(list(stamps.items())[:STAMPS_MAX])
        history = None
        if isinstance(hist, dict):
            history = {}
            for src, entries in list(hist.items())[:HISTORY_SOURCES_MAX]:
                if not isinstance(entries, list):
                    continue
                history[src] = entries[:HISTORY_ENTRIES_MAX]
        upd = {"raw": raw, "stamps": stamps, "dropped_raw": dropped}
        if history is not None:
            upd["history"] = history
        return upd

    def extract(state):
        cands = []
        dropped = 0
        budgets = deps.get("budgets") or {}
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        aborts = state.get("extract_aborts", 0)
        for rec in state.get("raw", []):
            if aborted:
                break  # doomed cycle: no further expensive work
            syms = rec.get("symbols") or [None]
            bkey = syms[0] if syms[0] in budgets else None
            try:
                _budget(bkey).check()
                for cand in deps["extract_workers"](
                        rec, _budget(bkey)):
                    try:
                        import json as _json
                        oversize = len(_json.dumps(
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
        for cand in deps["fuse"](state.get("candidates", [])):
            if len(fused) < FUSED_MAX:
                fused.append(cand)
            else:
                dropped += 1
        return {"fused": fused, "dropped_fused": dropped}

    def hypothesize(state):
        out = {}
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        succeeded = []
        digest_dir = deps.get("digest_dir")
        for sym in state["watchlist"][:SYMBOL_MAX]:
            if aborted:
                break
            if not deps["cadence_state"].should_refresh(
                    sym, state["epoch"], state.get("trigger_symbols", ())):
                continue
            try:
                _budget(sym).check()
                text = deps["hypothesize"](sym, state)
                text = _bound_str(text, THESIS_CHARS_MAX)
                out[sym] = text
                succeeded.append(sym)  # ONLY successes advance cadence
                if digest_dir is not None:
                    # The writer enforces the frozen ≤500-char thesis;
                    # over-long producer output is counted, not rewritten.
                    ok, reason = digest.append_digest(
                        digest_dir, state["epoch"], sym, "hypothesize",
                        text)
                    if not ok and len(blocked) < BLOCKED_MAX:
                        blocked.append(_bound_str(
                            "digest:%s:%s" % (sym, reason),
                            BLOCKED_CHARS))
            except r15.AbortCycle:
                aborted = True
                out[sym] = ""
            except _workers.ConfigBlocked as e:
                if len(blocked) < BLOCKED_MAX:
                    blocked.append(_bound_str(
                        "hypothesize:%s:%s" % (sym, e), BLOCKED_CHARS))
                out[sym] = ""
        try:
            deps["cadence_state"].mark_run(state["epoch"], succeeded)
        except OSError as e:
            if len(blocked) < BLOCKED_MAX:
                blocked.append(_bound_str("cadence-persist-failed:%s" % e,
                                          BLOCKED_CHARS))
        upd = {"thesis": out, "cycle_aborted": aborted}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def critique(state):
        out = {}
        blocked = [_bound_str(b, BLOCKED_CHARS)
                   for b in (state.get("blocked") or [])[:BLOCKED_MAX]]
        aborted = bool(state.get("cycle_aborted"))
        digest_dir = deps.get("digest_dir")
        for sym, text in state.get("thesis", {}).items():
            if aborted:
                break
            if not text:
                out[sym] = {"text": "", "disagreement": True}
                continue
            try:
                _budget(sym).check()
                crit = deps["critique"](sym, text, state)
                if not isinstance(crit, dict):
                    crit = {"text": _bound_str(crit, CRITIQUE_CHARS_MAX),
                            "disagreement": True}
                else:
                    crit = {"text": _bound_str(
                        crit.get("text", ""), CRITIQUE_CHARS_MAX),
                            "disagreement": bool(
                                crit.get("disagreement", True))}
                out[sym] = crit
                if digest_dir is not None:
                    ok, reason = digest.append_digest(
                        digest_dir, state["epoch"], sym, "critique",
                        crit["text"],
                        extra={"disagreement": crit["disagreement"]})
                    if not ok and len(blocked) < BLOCKED_MAX:
                        blocked.append(_bound_str(
                            "digest:%s:%s" % (sym, reason),
                            BLOCKED_CHARS))
            except r15.AbortCycle:
                aborted = True
                out[sym] = {"text": "", "disagreement": True}
            except _workers.ConfigBlocked as e:
                if len(blocked) < BLOCKED_MAX:
                    blocked.append(_bound_str(
                        "critique:%s:%s" % (sym, e), BLOCKED_CHARS))
                out[sym] = {"text": "", "disagreement": True}
        upd = {"critique": out, "cycle_aborted": aborted}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def emit(state):
        # Steady-state estimate input: per-cycle budget totals (durable
        # attribution rows remain the audit source).
        try:
            total = sum((getattr(b, "llm", 0) or 0)
                        for b in (deps.get("budgets") or {}).values())
            deps["cadence_state"].record_cycle(total)
        except (AttributeError, TypeError):
            pass
        hook = deps.get("health_hook")
        if hook is not None:
            try:
                hook({"cycle_id": cycle_id, "epoch": state["epoch"],
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
    checkpointer = retention.harden_saver(
        SqliteSaver(deps["checkpointer_conn"]))
    return g.compile(checkpointer=checkpointer)


def run_cycle(app, watchlist, epoch, thread_id, budgets=None,
              trigger_symbols=()):
    """One supervised cycle. thread_id IS the cycle_id: durable R15
    budgets key on it, so crash-resume reconstructs instead of
    re-minting. trigger_symbols makes TRIGGER-immediate cadence
    reachable (explicit cycle input, capped)."""
    import itertools
    # Count WITHOUT materializing: take cap+1, then drain-count the
    # rest (iteration only, no storage — hostile sizes cost CPU, never
    # memory).
    def _capped_count(it, limit):
        it = iter(it)
        head = list(itertools.islice(it, limit + 1))
        extra = sum(1 for _ in it)
        return head[:limit], max(0, len(head) - limit) + extra
    wl, dropped_wl = _capped_count(watchlist, WATCHLIST_MAX)
    trig, _ = _capped_count(trigger_symbols, TRIGGER_MAX)
    state = {"watchlist": wl, "epoch": epoch,
             "trigger_symbols": tuple(trig),
             "dropped_watchlist": dropped_wl}
    return app.invoke(state, {"configurable": {"thread_id": thread_id}})
