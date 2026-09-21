"""Crash-durable R15 budget ledger (stdlib + sqlite3, doc 08 sec. 8.4).

Budgets stay OUT of LangGraph checkpoint state (checkpoints are
resumable data, not spending authority), but in-memory-only budgets
lose accounting on crash-resume. This ledger is the supervisor-owned
spending record: SQLite with one counters row per (cycle_id, symbol)
plus one row per reservation LEASE. A restarted process reconstructs
exact counters instead of minting fresh ones.

Fail-closed corruption rule (frozen): a MISSING ledger file for a new
cycle starts at zero. An EXISTING but corrupt/oversized/unreadable
ledger NEVER becomes a fresh budget — every operation raises
AbortCycle (the cycle stops and publishes nothing) instead of
resetting the safety counters. snapshot() and settle() obey the same
rule: a missing reservation at settle time is an accounting error,
not a silent discard.

Leases (idempotent settlement): every reserve mints
lease_id = "cycle:symbol:kind:seq" and persists it unsettled.
settle() on an unknown lease raises; settle() twice on the same lease
raises. The SQLite redesign (not JSON) also removes the 1MiB rewrite-
the-world cap: rows are per-cycle and pruned by retention (cycles
older than LEDGER_RETAIN_DAYS vanish on the next reservation —
bounded storage for unattended runs).

Flow per actual model/tool attempt (enforced by workers.py wrappers,
never by graph-level counting):
  lease = budget.reserve_llm()   # BEFORE execution, raises at cap
  msg = call_with_timeout(...)   # bounded wall clock
  budget.settle_llm(lease, actual_tokens)  # reconcile; double-settle
                                           # raises; unknown lease raises
  # on error/timeout: no settle — the reservation stands (an ambiguous
  # attempt counts as spent) AND the lease stays open as evidence.

Token reservation: TOKENS_PER_CALL = TOKENS // LLM_CALLS (6250),
derived from the frozen caps. The wrapper additionally clamps
provider max_tokens downward and aborts the cycle when actual usage
breaches the reservation (see workers.py) — the reservation is the
pre-call gate, the post-call audit closes the loop.
"""
import os
import sqlite3
import time

from . import r15

TOKENS_PER_CALL = r15.TOKENS // r15.LLM_CALLS  # 6250, derived
LEDGER_RETAIN_DAYS = 7
LEDGER_MAX_BYTES = 64 << 20


class LedgerCorrupt(AssertionError):
    """Internal: an existing ledger failed validation. Callers convert
    to AbortCycle (fail closed, never fresh counters)."""


def _abort(symbol, reason):
    raise r15.AbortCycle(symbol, {"ledger": reason})


class BudgetLedger:
    """Atomic SQLite ledger. Cross-process safe via SQLite locking +
    BEGIN IMMEDIATE; the FileLock serializes schema setup."""

    def __init__(self, path):
        self.path = path

    def _connect(self, fresh_ok, abort_symbol):
        exists = os.path.exists(self.path)
        if not exists and not fresh_ok:
            _abort(abort_symbol, "ledger-missing")
        if exists:
            try:
                if os.path.getsize(self.path) > LEDGER_MAX_BYTES:
                    raise LedgerCorrupt("oversize")
            except OSError as e:
                raise LedgerCorrupt(str(e))
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        try:
            con = sqlite3.connect(self.path, timeout=60.0,
                                  check_same_thread=False,
                                  isolation_level=None)
        except sqlite3.Error as e:
            raise LedgerCorrupt(str(e))
        try:
            con.execute("PRAGMA journal_mode=WAL")
            con.execute("PRAGMA synchronous=FULL")
            con.execute(
                "CREATE TABLE IF NOT EXISTS counters (cycle TEXT, "
                "symbol TEXT, llm INT, tools INT, tokens INT, depth INT,"
                " start_wall REAL, dead INT DEFAULT 0, "
                "PRIMARY KEY (cycle, symbol))")
            con.execute(
                "CREATE TABLE IF NOT EXISTS leases (lease_id TEXT "
                "PRIMARY KEY, cycle TEXT, symbol TEXT, kind TEXT, "
                "reserved INT, actual INT, settled INT DEFAULT 0)")
            con.execute("PRAGMA integrity_check")
        except sqlite3.Error as e:
            con.close()
            raise LedgerCorrupt(str(e))
        return con

    def _prune(self, con, now_wall):
        cutoff = now_wall - LEDGER_RETAIN_DAYS * 86400
        con.execute("DELETE FROM counters WHERE start_wall < ?", (cutoff,))
        con.execute(
            "DELETE FROM leases WHERE lease_id IN (SELECT l.lease_id "
            "FROM leases l LEFT JOIN counters c ON l.cycle = c.cycle "
            "AND l.symbol = c.symbol WHERE c.cycle IS NULL)")

    def _row(self, con, cycle_id, symbol, now_wall, create):
        cur = con.execute(
            "SELECT llm, tools, tokens, depth, start_wall, dead "
            "FROM counters WHERE cycle = ? AND symbol = ?",
            (cycle_id, symbol))
        r = cur.fetchone()
        if r is None:
            if not create:
                return None
            con.execute(
                "INSERT INTO counters VALUES (?,?,?,?,?,?,?,0)",
                (cycle_id, symbol, 0, 0, 0, 0, now_wall))
            return [0, 0, 0, 0, now_wall, 0]
        return list(r)

    def _check_row(self, e, symbol, now_wall):
        if e[5]:
            _abort(symbol, "budget-dead")
        if now_wall - e[4] > r15.WALL_S:
            _abort(symbol, "wall-exhausted")
        if (e[0] >= r15.LLM_CALLS or e[1] >= r15.TOOL_CALLS or
                e[2] >= r15.TOKENS or e[3] >= r15.DEPTH):
            _abort(symbol, "cap-exhausted")

    def _op(self, fresh_ok, fn, abort_symbol, *args):
        try:
            con = self._connect(fresh_ok, abort_symbol)
        except LedgerCorrupt as e:
            _abort(abort_symbol, "ledger-corrupt:%s" % e)
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                out = fn(con, *args)
                con.execute("COMMIT")
                return out
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        except r15.AbortCycle:
            raise
        except sqlite3.Error as e:
            _abort(abort_symbol, "ledger-io:%s" % e)
        finally:
            con.close()

    def snapshot(self, cycle_id, symbol):
        def _get(con):
            e = self._row(con, cycle_id, symbol, time.time(), False)
            if e is None:
                return {"llm": 0, "tools": 0, "tokens": 0, "depth": 0,
                        "start_wall": time.time(), "dead": False}
            return {"llm": e[0], "tools": e[1], "tokens": e[2],
                    "depth": e[3], "start_wall": e[4],
                    "dead": bool(e[5])}
        try:
            return self._op(True, _get, symbol)
        except r15.AbortCycle:
            _abort(symbol, "ledger-unreadable")

    def reserve_llm(self, cycle_id, symbol, reserve_tokens=None,
                    now_wall=None):
        reserve_tokens = TOKENS_PER_CALL if reserve_tokens is None \
            else reserve_tokens
        now_wall = time.time() if now_wall is None else now_wall

        def _res(con):
            self._prune(con, now_wall)
            e = self._row(con, cycle_id, symbol, now_wall, True)
            self._check_row(e, symbol, now_wall)
            if e[2] + reserve_tokens > r15.TOKENS:
                _abort(symbol, "tokens-exhausted")
            e[0] += 1
            e[3] += 1
            e[2] += reserve_tokens
            con.execute(
                "UPDATE counters SET llm=?, tools=?, tokens=?, depth=?"
                " WHERE cycle=? AND symbol=?",
                (e[0], e[1], e[2], e[3], cycle_id, symbol))
            lease_id = "%s:%s:llm:%d" % (cycle_id, symbol, e[0])
            con.execute(
                "INSERT INTO leases VALUES (?,?,?,?,?,NULL,0)",
                (lease_id, cycle_id, symbol, "llm", reserve_tokens))
            return {"lease_id": lease_id, "seq": e[0],
                    "reserved": reserve_tokens,
                    "remaining_tokens": r15.TOKENS - e[2]}
        return self._op(True, _res, symbol)

    def settle_llm(self, cycle_id, symbol, lease, actual_tokens):
        if (type(actual_tokens) is not int or actual_tokens < 0 or
                actual_tokens > 10 ** 12):
            _abort(symbol, "tokens-unaccountable")

        def _set(con):
            cur = con.execute(
                "SELECT reserved, actual, settled FROM leases "
                "WHERE lease_id = ?", (lease["lease_id"],))
            r = cur.fetchone()
            if r is None:
                _abort(symbol, "unknown-lease")
            if r[2]:
                _abort(symbol, "double-settle")
            reserved = r[0]
            con.execute(
                "UPDATE leases SET actual=?, settled=1 WHERE lease_id=?",
                (actual_tokens, lease["lease_id"]))
            e = self._row(con, cycle_id, symbol, time.time(), False)
            if e is None:
                _abort(symbol, "counters-missing-at-settle")
            e[2] = max(0, e[2] - reserved + actual_tokens)
            con.execute("UPDATE counters SET tokens=? WHERE cycle=? "
                        "AND symbol=?", (e[2], cycle_id, symbol))
            return e[2]
        return self._op(False, _set, symbol)

    def reserve_tool(self, cycle_id, symbol, now_wall=None):
        now_wall = time.time() if now_wall is None else now_wall

        def _res(con):
            self._prune(con, now_wall)
            e = self._row(con, cycle_id, symbol, now_wall, True)
            self._check_row(e, symbol, now_wall)
            e[1] += 1
            e[3] += 1
            con.execute(
                "UPDATE counters SET tools=?, depth=? WHERE cycle=? "
                "AND symbol=?", (e[1], e[3], cycle_id, symbol))
            return {"seq": e[1]}
        return self._op(True, _res, symbol)

    def check(self, cycle_id, symbol, now_wall=None):
        now_wall = time.time() if now_wall is None else now_wall

        def _chk(con):
            e = self._row(con, cycle_id, symbol, now_wall, False)
            if e is None:
                return
            self._check_row(e, symbol, now_wall)
        self._op(True, _chk, symbol)

    def invalidate(self, cycle_id, symbol):
        """Poison a (cycle, symbol) after a timeout/ambiguous failure:
        leaked threads that settle late cannot corrupt accounting, and
        no further reservation succeeds. Missing row: nothing to do."""

        def _inv(con):
            con.execute("UPDATE counters SET dead=1 WHERE cycle=? AND"
                        " symbol=?", (cycle_id, symbol))
        self._op(True, _inv, symbol)


class DurableBudget:
    """Supervisor-owned per-(cycle, symbol) budget handle. Duck-typed
    to the CycleBudget surface the graph needs (check/reserve/settle/
    snapshot) plus counter properties for the cadence recorder."""

    def __init__(self, ledger, cycle_id, symbol):
        self.ledger = ledger
        self.cycle_id = cycle_id
        self.symbol = symbol

    def reserve_llm(self, reserve_tokens=None):
        return self.ledger.reserve_llm(self.cycle_id, self.symbol,
                                       reserve_tokens)

    def settle_llm(self, lease, actual_tokens):
        return self.ledger.settle_llm(self.cycle_id, self.symbol, lease,
                                      actual_tokens)

    def reserve_tool(self):
        return self.ledger.reserve_tool(self.cycle_id, self.symbol)

    def check(self):
        self.ledger.check(self.cycle_id, self.symbol)

    def invalidate(self):
        self.ledger.invalidate(self.cycle_id, self.symbol)

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
