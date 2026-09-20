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

    def __init__(self, symbol, now=None):
        self.symbol = symbol
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

    def _enforce(self):
        if (self.llm > LLM_CALLS or self.tools > TOOL_CALLS or
                self.tokens > TOKENS or self.depth > DEPTH or
                self._elapsed() > WALL_S):
            raise AbortCycle(self.symbol, self.snapshot())

    def snapshot(self):
        return {"symbol": self.symbol, "llm": self.llm,
                "tools": self.tools, "tokens": self.tokens,
                "depth": self.depth, "elapsed_s": self._elapsed()}


class AbortCycle(Exception):
    def __init__(self, symbol, snapshot):
        super().__init__("research_abort:%s" % symbol)
        self.symbol = symbol
        self.snapshot = snapshot


class PlaneHealth:
    """Consecutive-abort tracking across symbols (supervisor side)."""

    def __init__(self, watchlist):
        self.watchlist = list(watchlist)
        self.consecutive = {s: 0 for s in self.watchlist}
        self.paused = set()
        self.degraded = False

    def record(self, symbol, aborted):
        if aborted:
            self.consecutive[symbol] = self.consecutive.get(symbol, 0) + 1
        else:
            self.consecutive[symbol] = 0
            self.paused.discard(symbol)
        if self.consecutive.get(symbol, 0) >= ABORTS_PAUSE_SYMBOL:
            self.paused.add(symbol)
        window = [self.consecutive.get(s, 0) > 0 for s in self.watchlist]
        if self.watchlist and sum(window) * 2 > len(self.watchlist):
            self.degraded = True
        return {"paused": sorted(self.paused), "degraded": self.degraded}
