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

NODES = ("harvest", "extract", "fuse", "hypothesize", "critique", "emit")


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


def build_graph(deps):
    """deps: {harvest, extract_workers, hypothesize, critique, resolve_emit,
    budgets, health, cadence_state}. Returns a compiled graph."""
    if not _LANGGRAPH:
        raise RuntimeError("langgraph not installed (see requirements.txt)")

    def harvest(state):
        recs, stamps = deps["harvest"](state["watchlist"], state["epoch"])
        return {"raw": recs, "stamps": stamps}

    def extract(state):
        cands = []
        budgets = deps.get("budgets") or {}
        for rec in state.get("raw", []):
            syms = rec.get("symbols") or [None]
            try:
                cands.extend(deps["extract_workers"](
                    rec, budgets.get(syms[0], budgets.get(None))))
            except r15.AbortCycle:
                state["extract_aborts"] = state.get("extract_aborts", 0) + 1
        return {"candidates": cands}

    def fuse(state):
        return {"fused": deps["fuse"](state.get("candidates", []))}

    def hypothesize(state):
        out = {}
        for sym in state["watchlist"]:
            if not deps["cadence_state"].should_refresh(
                    sym, state["epoch"], state.get("trigger_symbols", ())):
                continue
            try:
                out[sym] = deps["hypothesize"](sym, state)
            except r15.AbortCycle:
                out[sym] = ""
        deps["cadence_state"].mark_run(
            state["epoch"], [s for s in out])
        return {"thesis": out}

    def critique(state):
        out = {}
        for sym, text in state.get("thesis", {}).items():
            if not text:
                out[sym] = {"text": "", "disagreement": True}
                continue
            try:
                out[sym] = deps["critique"](sym, text, state)
            except r15.AbortCycle:
                out[sym] = {"text": "", "disagreement": True}
        return {"critique": out}

    def emit(state):
        return deps["resolve_emit"](state)

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
