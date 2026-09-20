"""D1 six-node research graph (doc 08 sec. 8.3, LangGraph, pinned).

harvest -> extract -> fuse -> hypothesize -> critique -> emit

- Checkpointed after every node (SqliteSaver, paper) for resume at the
  last completed node, never the cycle start.
- Side-effecting nodes carry idempotency keys: re-execution converges,
  never duplicates (emit re-emit is idempotent by bundle_id; digest
  appends are keyed by epoch+symbol).
- hypothesize/critique are gated by cadence.py (TRIGGER-new or 30-min
  TTL), capped by r15.py budgets. Failure defaults per doc 08 §8.3 table.
- LLM nodes run through workers.py (sandboxed smolagents or deterministic
  stub when no model key is configured — explicit blocker, never fake).
- Durability = checkpoints + EXTERNAL supervisor (systemd unit): this
  module exposes run_cycle() + resume(); the supervisor owns restarts.
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

from . import cadence, r15
from . import emit as emit_mod
from . import workers as _workers

NODES = ("harvest", "extract", "fuse", "hypothesize", "critique", "emit")

# Checkpoint resource caps (finding 13): the frozen reader caps emitted
# features at 64, but raw/candidate/fused/thesis state is ALSO checkpointed
# into SQLite. Unbounded harvest/extraction must not exhaust checkpoint
# storage: truncate oldest-arrival-first... actually newest-first is wrong
# here — keep the FIRST n (stable order) and count the dropped rest.
RAW_MAX = 512
CAND_MAX = 256
FUSED_MAX = 128
SYMBOL_MAX = 64


class PlaneState(TypedDict, total=False):
    watchlist: list
    epoch: int
    trigger_symbols: tuple
    raw: list
    stamps: dict
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
    extract_aborts: int
    dropped_raw: int
    dropped_candidates: int
    dropped_fused: int


def build_graph(deps):
    """deps: {harvest, extract_workers, hypothesize, critique, resolve_emit,
    budgets, health, cadence_state}. Returns a compiled graph.

    Enforcement placement (frozen):
    - R15 budgets come from deps["budgets"] (supervisor-owned, outside
      checkpoints). Every LLM/tool attempt charges BEFORE the call, at
      the node boundary — including hypothesize/critique, not just
      extract. A symbol with no wired budget is ConfigBlocked (fail
      closed: no budget, no call).
    - ConfigBlocked (no model key, no sandbox) applies the documented
      per-node failure defaults (extract: drop+count; hypothesize:
      empty thesis; critique: disagreement=true) and marks state.
    - AbortCycle sets cycle_aborted: the emit node then publishes
      NOTHING (last complete bundle stands). A degraded/partial cycle
      never becomes a bundle — the frozen contract is abort -> no
      publication, and this graph implements exactly that.
    """
    if not _LANGGRAPH:
        raise RuntimeError("langgraph not installed (see requirements.txt)")
    def _budget(sym):
        b = (deps.get("budgets") or {}).get(sym)
        if b is None:
            raise _workers.ConfigBlocked("no R15 budget for %s" % sym)
        return b

    def harvest(state):
        recs, stamps = deps["harvest"](state["watchlist"], state["epoch"])
        recs = list(recs)
        dropped = max(0, len(recs) - RAW_MAX)
        return {"raw": recs[:RAW_MAX], "stamps": stamps,
                "dropped_raw": dropped}

    def extract(state):
        cands = []
        budgets = deps.get("budgets") or {}
        blocked = list(state.get("blocked") or [])
        aborted = bool(state.get("cycle_aborted"))
        aborts = state.get("extract_aborts", 0)
        for rec in state.get("raw", []):
            syms = rec.get("symbols") or [None]
            bkey = syms[0] if syms[0] in budgets else None
            try:
                cands.extend(deps["extract_workers"](rec, _budget(bkey)))
            except r15.AbortCycle:
                aborted = True
                aborts += 1
            except _workers.ConfigBlocked as e:
                blocked.append("extract:%s" % e)
        dropped = max(0, len(cands) - CAND_MAX)
        out = {"candidates": cands[:CAND_MAX], "dropped_candidates": dropped,
               "cycle_aborted": aborted, "extract_aborts": aborts}
        if blocked:
            out["blocked"] = blocked
        return out

    def fuse(state):
        fused = list(deps["fuse"](state.get("candidates", [])))
        dropped = max(0, len(fused) - FUSED_MAX)
        return {"fused": fused[:FUSED_MAX], "dropped_fused": dropped}

    def hypothesize(state):
        out = {}
        blocked = list(state.get("blocked") or [])
        aborted = bool(state.get("cycle_aborted"))
        for sym in state["watchlist"][:SYMBOL_MAX]:
            if not deps["cadence_state"].should_refresh(
                    sym, state["epoch"], state.get("trigger_symbols", ())):
                continue
            try:
                _budget(sym).charge_llm()
                out[sym] = deps["hypothesize"](sym, state)
            except r15.AbortCycle:
                aborted = True
                out[sym] = ""
            except _workers.ConfigBlocked as e:
                blocked.append("hypothesize:%s:%s" % (sym, e))
                out[sym] = ""
        deps["cadence_state"].mark_run(
            state["epoch"], [s for s in out])
        upd = {"thesis": out, "cycle_aborted": aborted}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def critique(state):
        out = {}
        blocked = list(state.get("blocked") or [])
        aborted = bool(state.get("cycle_aborted"))
        for sym, text in state.get("thesis", {}).items():
            if not text:
                out[sym] = {"text": "", "disagreement": True}
                continue
            try:
                _budget(sym).charge_llm()
                out[sym] = deps["critique"](sym, text, state)
            except r15.AbortCycle:
                aborted = True
                out[sym] = {"text": "", "disagreement": True}
            except _workers.ConfigBlocked as e:
                blocked.append("critique:%s:%s" % (sym, e))
                out[sym] = {"text": "", "disagreement": True}
        upd = {"critique": out, "cycle_aborted": aborted}
        if blocked:
            upd["blocked"] = blocked
        return upd

    def emit(state):
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
    checkpointer = SqliteSaver(deps["checkpointer_conn"])
    return g.compile(checkpointer=checkpointer)


def run_cycle(app, watchlist, epoch, thread_id, budgets=None):
    """One supervised cycle. Returns the final state dict.

    Budgets live outside checkpointed state (enforcement handles, not
    graph data): the caller owns them via deps["budgets"]."""
    state = {"watchlist": list(watchlist), "epoch": epoch}
    return app.invoke(state, {"configurable": {"thread_id": thread_id}})
