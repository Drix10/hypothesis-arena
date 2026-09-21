"""Crash-durable R15 budget ledger (stdlib + sqlite3, doc 08 sec. 8.4).

Budgets stay OUT of LangGraph checkpoint state (checkpoints are
resumable data, not spending authority), but in-memory-only budgets
lose accounting on crash-resume. This ledger is the supervisor-owned
spending record: SQLite with one counters row per (cycle_id, symbol)
plus one row per reservation LEASE. A restarted process reconstructs
exact counters instead of minting fresh ones.

Fail-closed rules (frozen):
- An EXISTING but corrupt/oversized/unreadable ledger NEVER becomes a
  fresh budget — every operation raises AbortCycle.
- Deletion of the authority fails closed: the DB is created together
  with a sidecar init marker holding the same random token that is
  stored inside the DB. Marker-without-DB aborts ("authority-deleted"),
  never recreates. Supervisor fresh-start = delete BOTH (documented).
- PRAGMA integrity_check is READ (== "ok" single row), the table
  schemas are verified column-exact, and PRAGMA user_version is pinned.
  A non-ok integrity result aborts — executing the pragma without
  reading it is not a check.
- Storage is bounded INCLUDING wal/shm sidecars: main+wal+shm over
  LEDGER_MAX_BYTES aborts; post-prune reclaim runs
  wal_checkpoint(TRUNCATE) and VACUUMs when over bound, and a still-
  over-bound store aborts on the next open.

Reservation model (the pre-call gate): reserve_call(token_need,
tool_need) validates BOTH needs as exact ints in range (non-int,
negative, or absurd values are "tokens-unaccountable" aborts, never
clamped into validity) and persists llm+1/depth+1/tokens+=need/
tools+=tool_need BEFORE the provider may be touched. settle_call()
reconciles to measured actuals; unknown lease / double-settle /
missing counters abort. An unsettled reservation stands charged
(an ambiguous attempt counts as spent) AND the lease stays open as
evidence. Tool-only counting (deterministic in-parent parser work,
no provider) keeps the small reserve_tool path.
"""
import os
import sqlite3
import time

from . import locks
from . import r15

LEDGER_MAX_BYTES = 64 << 20
LEDGER_RETAIN_DAYS = 7
SCHEMA_VERSION = 1
TOKENS_ABSOLUTE_MAX = r15.TOKENS  # a single need can never exceed cap
TOOLS_ABSOLUTE_MAX = r15.TOOL_CALLS

_COUNTERS_DDL = (
    "CREATE TABLE IF NOT EXISTS counters (cycle TEXT, symbol TEXT, "
    "llm INT, tools INT, tokens INT, depth INT, start_wall REAL, "
    "dead INT DEFAULT 0, PRIMARY KEY (cycle, symbol))")
_LEASES_DDL = (
    "CREATE TABLE IF NOT EXISTS leases (lease_id TEXT PRIMARY KEY, "
    "cycle TEXT, symbol TEXT, kind TEXT, reserved INT, actual INT, "
    "settled INT DEFAULT 0)")
_META_DDL = ("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, "
             "v TEXT NOT NULL)")

_EXPECTED_COLUMNS = {
    "counters": ["cycle", "symbol", "llm", "tools", "tokens", "depth",
                 "start_wall", "dead"],
    "leases": ["lease_id", "cycle", "symbol", "kind", "reserved",
               "actual", "settled"],
    "meta": ["k", "v"],
}


class LedgerCorrupt(AssertionError):
    """Internal: an existing ledger failed validation. Callers convert
    to AbortCycle (fail closed, never fresh counters)."""


def _abort(symbol, reason):
    raise r15.AbortCycle(symbol, {"ledger": reason})


def _storage_size(path):
    total = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            total += os.path.getsize(path + suffix)
        except OSError:
            pass
    return total


class BudgetLedger:
    """Atomic SQLite ledger. Cross-process safe via SQLite locking +
    BEGIN IMMEDIATE."""

    def __init__(self, path):
        self.path = path

    def _connect(self, fresh_ok, abort_symbol):
        exists = os.path.exists(self.path)
        marker = locks.read_marker(self.path)
        if not exists:
            if marker is not None:
                # The authority was deleted mid-deployment. Recreate-
                # as-fresh would zero live counters: abort instead.
                raise LedgerCorrupt("authority-deleted")
            if not fresh_ok:
                _abort(abort_symbol, "ledger-missing")
        if exists and _storage_size(self.path) > LEDGER_MAX_BYTES:
            raise LedgerCorrupt("oversize")
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
            con.execute(_COUNTERS_DDL)
            con.execute(_LEASES_DDL)
            con.execute(_META_DDL)
            for table, cols in _EXPECTED_COLUMNS.items():
                got = [r[1] for r in con.execute(
                    "PRAGMA table_info(%s)" % table)]
                if got != cols:
                    raise LedgerCorrupt("schema-mismatch:%s" % table)
            row = con.execute("PRAGMA integrity_check").fetchone()
            if row is None or row[0] != "ok":
                raise LedgerCorrupt("integrity:%r" % (row,))
            ver = con.execute("PRAGMA user_version").fetchone()[0]
            cur = con.execute(
                "SELECT v FROM meta WHERE k='init_token'").fetchone()
            if not exists and marker is None:
                # Genuine first init: mint the token inside the DB,
                # then publish the sidecar marker. A crash between
                # the two heals on next open (DB verifies, marker
                # re-created from the DB token).
                token = locks.fresh_token()
                con.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
                con.execute("INSERT INTO meta VALUES ('init_token',?)",
                            (token,))
                locks.write_marker(self.path, token)
            else:
                if ver != SCHEMA_VERSION:
                    raise LedgerCorrupt("version:%r" % (ver,))
                if cur is None:
                    raise LedgerCorrupt("token-missing")
                if marker is None:
                    locks.write_marker(self.path, cur[0])
                elif marker != cur[0]:
                    raise LedgerCorrupt("token-mismatch")
        except LedgerCorrupt:
            con.close()
            raise
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

    def _reclaim(self):
        """Bounded-storage policy: checkpoint the WAL away and vacuum
        when over bound. Runs outside any transaction; failure to
        reclaim leaves the next open to abort (fail closed)."""
        try:
            con = sqlite3.connect(self.path, timeout=60.0,
                                  check_same_thread=False,
                                  isolation_level=None)
        except sqlite3.Error:
            return
        try:
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            if _storage_size(self.path) > LEDGER_MAX_BYTES:
                con.execute("VACUUM")
        except sqlite3.Error:
            pass
        finally:
            con.close()

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

    @staticmethod
    def _valid_need(value, maximum, name, symbol):
        # Exact ints in range. bool is not an int here; floats,
        # strings, negatives, and over-cap values are accounting
        # defects, never clamped into validity.
        if type(value) is not int or not 0 <= value <= maximum:
            _abort(symbol, "%s-unaccountable" % name)

    def reserve_call(self, cycle_id, symbol, token_need, tool_need,
                     now_wall=None):
        """One atomic pre-call reservation: llm+1, depth+1,
        tokens+=token_need, tools+=tool_need. Returns the lease; the
        provider may be touched ONLY after this returns."""
        self._valid_need(token_need, TOKENS_ABSOLUTE_MAX, "tokens",
                         symbol)
        self._valid_need(tool_need, TOOLS_ABSOLUTE_MAX, "tools",
                         symbol)
        now_wall = time.time() if now_wall is None else now_wall

        def _res(con):
            self._prune(con, now_wall)
            e = self._row(con, cycle_id, symbol, now_wall, True)
            self._check_row(e, symbol, now_wall)
            if e[2] + token_need > r15.TOKENS:
                _abort(symbol, "tokens-exhausted")
            if e[1] + tool_need > r15.TOOL_CALLS:
                _abort(symbol, "tools-exhausted")
            e[0] += 1
            e[3] += 1
            e[2] += token_need
            e[1] += tool_need
            if e[0] > r15.LLM_CALLS or e[3] > r15.DEPTH:
                _abort(symbol, "cap-exhausted")
            con.execute(
                "UPDATE counters SET llm=?, tools=?, tokens=?, depth=?"
                " WHERE cycle=? AND symbol=?",
                (e[0], e[1], e[2], e[3], cycle_id, symbol))
            lease_id = "%s:%s:call:%d" % (cycle_id, symbol, e[0])
            con.execute(
                "INSERT INTO leases VALUES (?,?,?,?,?,NULL,0)",
                (lease_id, cycle_id, symbol, "call", token_need))
            return {"lease_id": lease_id, "seq": e[0],
                    "reserved": token_need,
                    "tools_reserved": tool_need,
                    "remaining_tokens": r15.TOKENS - e[2]}
        out = self._op(True, _res, symbol)
        if _storage_size(self.path) > LEDGER_MAX_BYTES:
            self._reclaim()
        return out

    def settle_call(self, cycle_id, symbol, lease, actual_tokens):
        self._valid_need(actual_tokens, 10 ** 12, "tokens", symbol)

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
        """In-parent deterministic tool counting (parser work, no
        provider). Provider tool consumption reserves through
        reserve_call's tool_need instead."""
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
        no further reservation succeeds. Missing row: nothing to do."""

        def _inv(con):
            con.execute("UPDATE counters SET dead=1 WHERE cycle=? AND"
                        " symbol=?", (cycle_id, symbol))
        self._op(True, _inv, symbol)


class DurableBudget:
    """Supervisor-owned per-(cycle, symbol) budget handle. Duck-typed
    to the surface the graph needs (check/reserve/settle/snapshot)
    plus counter properties for the cadence recorder."""

    def __init__(self, ledger, cycle_id, symbol):
        self.ledger = ledger
        self.cycle_id = cycle_id
        self.symbol = symbol

    def reserve_call(self, token_need, tool_need=0):
        return self.ledger.reserve_call(self.cycle_id, self.symbol,
                                        token_need, tool_need)

    def settle_call(self, lease, actual_tokens):
        return self.ledger.settle_call(self.cycle_id, self.symbol,
                                       lease, actual_tokens)

    def reserve_tool(self):
        return self.ledger.reserve_tool(self.cycle_id, self.symbol)

    def check(self):
        self.ledger.check(self.cycle_id, self.symbol)

    def invalidate(self):
        self.ledger.invalidate(self.cycle_id, self.symbol)

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
