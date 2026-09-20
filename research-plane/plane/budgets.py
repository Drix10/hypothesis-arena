"""Crash-durable R15 budget ledger (stdlib only, doc 08 sec. 8.4).

Budgets stay OUT of LangGraph checkpoint state (checkpoints are
resumable data, not spending authority), but in-memory-only budgets
lose accounting on crash-resume: a restarted process would mint a
fresh budget for an already-started cycle and overspend. This ledger
is the supervisor-owned spending record: one JSON file keyed by
(cycle_id, symbol), mutated ONLY under the inter-process FileLock,
written atomically. A restarted process reconstructs the exact
counters for its cycle instead of starting at zero.

Flow per actual model/tool attempt (enforced by workers.py wrappers,
never by graph-level counting):
  lease = budget.reserve_llm(reserve_tokens)   # BEFORE execution,
                                               # raises AbortCycle at cap
  msg = call_with_timeout(model.generate, ...) # bounded wall clock
  budget.settle_llm(lease, actual_tokens)      # reconcile reservation
  # on error/timeout: no settle — the reservation stands (fail-closed:
  # an ambiguous attempt counts as spent, matching the JEV money-gate
  # rule that ambiguous transport never refunds).

Token reservation: TOKENS_PER_CALL = TOKENS // LLM_CALLS (6250),
derived from the frozen caps, not invented. The wrapper also passes
max_tokens=reservation to the provider (best-effort bound; providers
may ignore it — the reservation is the enforcement).
"""
import json
import os
import time

from . import locks
from . import r15

LEDGER_NAME = "budget_ledger.json"
TOKENS_PER_CALL = r15.TOKENS // r15.LLM_CALLS  # 6250, derived


class BudgetLedger:
    """Atomic file ledger. All mutations hold the lock file."""

    def __init__(self, path):
        self.path = path

    def _lock(self):
        return locks.FileLock(self.path + ".lock")

    def _read(self):
        try:
            data = locks.load_json_bounded(self.path,
                                           max_bytes=1 << 20)
        except (OSError, ValueError):
            return {}
        return data if isinstance(data, dict) else {}

    def _write(self, data):
        raw = json.dumps(data, sort_keys=True).encode("utf-8")
        locks.atomic_write_bytes(
            os.path.dirname(os.path.abspath(self.path)) or ".",
            os.path.basename(self.path), raw)

    def _key(self, cycle_id, symbol):
        return "%s\x00%s" % (cycle_id, symbol)

    def snapshot(self, cycle_id, symbol):
        with self._lock():
            e = self._read().get(self._key(cycle_id, symbol))
        return dict(e) if isinstance(e, dict) else {
            "llm": 0, "tools": 0, "tokens": 0, "depth": 0,
            "start_wall": time.time()}

    def _check(self, e, symbol, now_wall):
        if now_wall - e["start_wall"] > r15.WALL_S:
            raise r15.AbortCycle(symbol, dict(e))
        if (e["llm"] >= r15.LLM_CALLS or e["tools"] >= r15.TOOL_CALLS or
                e["tokens"] >= r15.TOKENS or e["depth"] >= r15.DEPTH):
            raise r15.AbortCycle(symbol, dict(e))

    def reserve_llm(self, cycle_id, symbol, reserve_tokens=None,
                    now_wall=None):
        """Charge one LLM attempt BEFORE execution. Returns a lease
        {seq, reserved} for settle_llm. Raises AbortCycle at any cap."""
        reserve_tokens = TOKENS_PER_CALL if reserve_tokens is None \
            else reserve_tokens
        now_wall = time.time() if now_wall is None else now_wall
        with self._lock():
            data = self._read()
            k = self._key(cycle_id, symbol)
            e = data.get(k)
            if not isinstance(e, dict):
                e = {"llm": 0, "tools": 0, "tokens": 0, "depth": 0,
                     "start_wall": now_wall}
            self._check(e, symbol, now_wall)
            if e["tokens"] + reserve_tokens > r15.TOKENS:
                raise r15.AbortCycle(symbol, dict(e))
            e["llm"] += 1
            e["depth"] += 1
            e["tokens"] += reserve_tokens
            data[k] = e
            self._write(data)
            return {"seq": e["llm"], "reserved": reserve_tokens,
                    "remaining_tokens": r15.TOKENS - e["tokens"]}

    def settle_llm(self, cycle_id, symbol, lease, actual_tokens):
        """Reconcile: tokens = tokens - reserved + actual. Never below
        pre-reserve level accounting is kept simple: the difference is
        applied and the total is floored at zero."""
        with self._lock():
            data = self._read()
            k = self._key(cycle_id, symbol)
            e = data.get(k)
            if not isinstance(e, dict):
                return
            e["tokens"] = max(
                0, e["tokens"] - lease["reserved"] + actual_tokens)
            data[k] = e
            self._write(data)

    def reserve_tool(self, cycle_id, symbol, now_wall=None):
        now_wall = time.time() if now_wall is None else now_wall
        with self._lock():
            data = self._read()
            k = self._key(cycle_id, symbol)
            e = data.get(k)
            if not isinstance(e, dict):
                e = {"llm": 0, "tools": 0, "tokens": 0, "depth": 0,
                     "start_wall": now_wall}
            self._check(e, symbol, now_wall)
            e["tools"] += 1
            e["depth"] += 1
            data[k] = e
            self._write(data)
            return {"seq": e["tools"]}

    def check(self, cycle_id, symbol, now_wall=None):
        """Pre-call guard WITHOUT incrementing: raises AbortCycle when
        the cycle is already exhausted. The graph uses this at node
        boundaries; actual attempts always go through reserve_*."""
        now_wall = time.time() if now_wall is None else now_wall
        with self._lock():
            e = self._read().get(self._key(cycle_id, symbol))
        if not isinstance(e, dict):
            return
        self._check(e, symbol, now_wall)


class DurableBudget:
    """Supervisor-owned per-(cycle, symbol) budget handle. Duck-typed
    to the CycleBudget surface the graph needs (check/reserve/settle/
    snapshot) plus counter properties for the cadence recorder."""

    def __init__(self, ledger, cycle_id, symbol):
        self.ledger = ledger
        self.cycle_id = cycle_id
        self.symbol = symbol

    # -- production path: real attempts reserve first --
    def reserve_llm(self, reserve_tokens=None):
        return self.ledger.reserve_llm(self.cycle_id, self.symbol,
                                       reserve_tokens)

    def settle_llm(self, lease, actual_tokens):
        self.ledger.settle_llm(self.cycle_id, self.symbol, lease,
                               actual_tokens)

    def reserve_tool(self):
        return self.ledger.reserve_tool(self.cycle_id, self.symbol)

    def check(self):
        self.ledger.check(self.cycle_id, self.symbol)

    # -- legacy/test-double path: charge_* kept so stubs can account --
    def charge_llm(self, tokens=0):
        lease = self.reserve_llm(reserve_tokens=tokens)
        self.settle_llm(lease, tokens)

    def charge_tool(self):
        self.reserve_tool()

    def snapshot(self):
        return self.ledger.snapshot(self.cycle_id, self.symbol)

    @property
    def llm(self):
        return self.snapshot().get("llm", 0)

    @property
    def tools(self):
        return self.snapshot().get("tools", 0)

    @property
    def tokens(self):
        return self.snapshot().get("tokens", 0)
