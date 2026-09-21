"""D5 R15 runaway caps (doc 08 sec. 8.4, stdlib only).

Enforced by the orchestrator AND the supervisor independently. Pure
counters: the graph checks before every LLM/tool call; a stubbed looping
tool is caught by the tool-call cap in the acceptance test.

Frozen caps (per research cycle, per symbol):
  LLM calls 40 | tool calls 120 | wall clock 8 min | tokens 250k |
  graph depth 25.
Consecutive aborts: 3 same-symbol -> that symbol pauses; majority of the
watchlist aborting in-window -> plane degrades. An aborted cycle is never
retried in-interval and publishes nothing (last complete bundle stands).

CycleBudget below is the IN-MEMORY reference implementation of these
semantics. Production attempts go through the crash-durable
budgets.DurableBudget; CycleBudget is explicitly retained as the
semantic oracle (a live equivalence regression proves both agree),
not as a second authority.
"""
import time

LLM_CALLS = 40
TOOL_CALLS = 120
WALL_S = 8 * 60
TOKENS = 250000
DEPTH = 25
ABORTS_PAUSE_SYMBOL = 3


class CycleBudget:
    """Per-symbol per-cycle counters. check() raises AbortCycle."""

    def __init__(self, symbol, now=None, cycle_id="local"):
        self.symbol = symbol
        self.cycle_id = cycle_id
        self._dead = False
        self.llm = 0
        self.tools = 0
        self.tokens = 0
        self.depth = 0
        self.start = time.monotonic() if now is None else now
        self._now = time.monotonic if now is None else (lambda: now)

    def _elapsed(self):
        return self._now() - self.start

    def charge_llm(self, tokens=0):
        self.llm += 1
        self.tokens += tokens
        self.depth += 1
        self._enforce()

    def charge_tool(self):
        self.tools += 1
        self.depth += 1
        self._enforce()

    def invalidate(self):
        """Poison after a timeout/ambiguous failure: no further
        reservation succeeds (mirrors the durable ledger)."""
        self._dead = True

    def check(self):
        """Pre-call guard WITHOUT incrementing: raises AbortCycle when
        the cycle is already exhausted. Node boundaries call this;
        actual attempts go through charge_*/reserve_* (workers.py)."""
        if self._dead:
            raise AbortCycle(self.symbol, {"dead": True})
        if (self.llm >= LLM_CALLS or self.tools >= TOOL_CALLS or
                self.tokens >= TOKENS or self.depth >= DEPTH or
                self._elapsed() > WALL_S):
            raise AbortCycle(self.symbol, self.snapshot())

    def _enforce(self):
        if self._dead:
            raise AbortCycle(self.symbol, {"dead": True})
        if (self.llm > LLM_CALLS or self.tools > TOOL_CALLS or
                self.tokens > TOKENS or self.depth > DEPTH or
                self._elapsed() > WALL_S):
            raise AbortCycle(self.symbol, self.snapshot())

    def snapshot(self):
        return {"symbol": self.symbol, "cycle_id": self.cycle_id,
                "llm": self.llm,
                "tools": self.tools, "tokens": self.tokens,
                "depth": self.depth, "elapsed_s": self._elapsed()}


class AbortCycle(Exception):
    def __init__(self, symbol, snapshot):
        super().__init__("research_abort:%s" % symbol)
        self.symbol = symbol
        self.snapshot = snapshot


class PlaneHealth:
    """Consecutive-abort tracking across symbols (supervisor side).

    Two distinct rules (doc 08 sec. 8.3a/8.4):
    - 3 consecutive aborts on one symbol -> that symbol pauses (count-
      based; a success clears the count and unpauses).
    - a majority of watchlist symbols aborting within the trailing
      HEALTH_WINDOW_S (default 1h, monotonic clock) -> plane degraded.
      Degraded is RECOMPUTED on every record from current window state:
      healthy operation ages out and clears it automatically (never
      sticky). now_s is injectable for deterministic tests.
    """

    HEALTH_WINDOW_S = 3600

    def __init__(self, watchlist, now_s=None):
        self.watchlist = list(watchlist)
        self.consecutive = {s: 0 for s in self.watchlist}
        self.last_abort = {}  # symbol -> last abort timestamp
        self.paused = set()
        self.degraded = False
        self._now = (lambda: now_s) if now_s is not None else None

    def _t(self, now_s):
        if now_s is not None:
            return now_s
        if self._now is not None:
            return self._now()
        import time
        return time.monotonic()

    def record(self, symbol, aborted, now_s=None):
        t = self._t(now_s)
        if aborted:
            self.consecutive[symbol] = self.consecutive.get(symbol, 0) + 1
            self.last_abort[symbol] = t
        else:
            self.consecutive[symbol] = 0
            self.last_abort.pop(symbol, None)
            self.paused.discard(symbol)
        if self.consecutive.get(symbol, 0) >= ABORTS_PAUSE_SYMBOL:
            self.paused.add(symbol)
        cutoff = t - self.HEALTH_WINDOW_S
        in_window = sum(1 for s in self.watchlist
                        if self.last_abort.get(s, float("-inf")) >= cutoff)
        self.degraded = (bool(self.watchlist) and
                         in_window * 2 > len(self.watchlist))
        return {"paused": sorted(self.paused), "degraded": self.degraded}
