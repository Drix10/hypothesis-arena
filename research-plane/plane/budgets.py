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
import math
import os
import sqlite3
import time
import hashlib as _hashlib
import json as _json

from . import locks
from . import r15

LEDGER_MAX_BYTES = 64 << 20
LEDGER_RETAIN_DAYS = 7
CYCLES_RETAIN_DAYS = 30
SCHEMA_VERSION = 2
TOKENS_ABSOLUTE_MAX = r15.TOKENS  # a single need can never exceed cap
TOOLS_ABSOLUTE_MAX = r15.TOOL_CALLS

_COUNTERS_DDL = (
    "CREATE TABLE IF NOT EXISTS counters (cycle TEXT, symbol TEXT, "
    "llm INT, tools INT, tokens INT, depth INT, start_wall REAL, "
    "dead INT DEFAULT 0, PRIMARY KEY (cycle, symbol), "
    "CHECK (llm >= 0 AND tools >= 0 AND tokens >= 0 AND "
    "depth >= 0 AND dead IN (0, 1) AND "
    "typeof(start_wall) IN ('real', 'integer') AND "
    "start_wall = start_wall AND start_wall >= 0))")
_LEASES_DDL = (
    "CREATE TABLE IF NOT EXISTS leases (lease_id TEXT PRIMARY KEY, "
    "cycle TEXT, symbol TEXT, kind TEXT, reserved INT, actual INT, "
    "settled INT DEFAULT 0, "
    "CHECK (reserved >= 0 AND actual >= 0 AND settled IN (0, 1)))")
_META_DDL = ("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, "
             "v TEXT NOT NULL)")
# Registry of every (cycle, symbol) that ever reserved: the ONLY
# legitimate deleter of a counters row is _prune (older than
# LEDGER_RETAIN_DAYS). A missing counters row for a RECENTLY seen
# cycle is an illegitimate deletion → fail closed, never mint fresh
# counters over a live cycle. Registry memory past CYCLES_RETAIN_DAYS
# is pruned: no live cycle can be that old (WALL_S bounds a cycle to
# minutes), so re-creation there is genuinely new, not resurrected.
_CYCLES_DDL = (
    "CREATE TABLE IF NOT EXISTS cycles (cycle TEXT, symbol TEXT, "
    "first_wall REAL NOT NULL, PRIMARY KEY (cycle, symbol))")

_EXPECTED_COLUMNS = {
    "counters": ["cycle", "symbol", "llm", "tools", "tokens", "depth",
                 "start_wall", "dead"],
    "leases": ["lease_id", "cycle", "symbol", "kind", "reserved",
               "actual", "settled"],
    "meta": ["k", "v"],
    "cycles": ["cycle", "symbol", "first_wall"],
    "content_digest": ["table", "digest", "n", "a", "b"],
}

_BDIGEST_DDL = (
    "CREATE TABLE IF NOT EXISTS content_digest ("
    "\"table\" TEXT PRIMARY KEY, digest TEXT NOT NULL, "
    "n INTEGER NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL)")

# Canonical column order per digest slot (schema order).
_BDIGEST_COLS = {
    "counters": _EXPECTED_COLUMNS["counters"],
    "cycles": _EXPECTED_COLUMNS["cycles"],
    "leases": _EXPECTED_COLUMNS["leases"],
}

_BZERO_DIGEST = "0" * 64


def _bhrow(values):
    return _hashlib.sha256(
        _json.dumps(list(values), separators=(",", ":")).encode(
            "utf-8")).hexdigest()


def _bdxor(a, b):
    return "%064x" % (int(a, 16) ^ int(b, 16))


def _brecompute_table(con, slot, sql_table):
    cols = _BDIGEST_COLS[slot]
    cur = con.execute("SELECT %s FROM %s" % (",".join(cols),
                                               sql_table))
    acc = 0
    n = 0
    for row in cur:
        acc ^= int(_bhrow(row), 16)
        n += 1
    return "%064x" % acc, n


def _bdig_apply(con, slot, outs=(), ins=(), dn=0):
    """Same-transaction digest maintenance (see the attribution
    twin _dig_apply for the protocol): outs/ins are canonical
    value-lists, dn the row-count delta. Missing digest row
    denies, never recreates."""
    row = con.execute(
        "SELECT digest, n FROM content_digest WHERE \"table\"=?",
        (slot,)).fetchone()
    if row is None:
        raise LedgerCorrupt("digest-missing:%s" % slot)
    acc = int(row[0], 16)
    for vals in outs:
        acc ^= int(_bhrow(vals), 16)
    for vals in ins:
        acc ^= int(_bhrow(vals), 16)
    con.execute(
        "UPDATE content_digest SET digest=?, n=n+? WHERE "
        "\"table\"=?", ("%064x" % acc, dn, slot))


def _breq_int(slot, key, tag):
    try:
        val = slot.get(key)
    except AttributeError:
        raise LedgerCorrupt("marker-roots-corrupt:%s" % tag)
    if type(val) is not int or isinstance(val, bool) or val < 0:
        raise LedgerCorrupt("marker-roots-corrupt:%s" % tag)
    return val


def _breq_digest(slot, tag):
    try:
        val = slot.get("digest")
    except AttributeError:
        raise LedgerCorrupt("marker-roots-corrupt:%s" % tag)
    if type(val) is not str or len(val) != 64:
        raise LedgerCorrupt("marker-roots-corrupt:%s" % tag)
    try:
        int(val, 16)
    except ValueError:
        raise LedgerCorrupt("marker-roots-corrupt:%s" % tag)
    return val


def _bverify_history_locked(db_path, con, roots):
    """Budgets twin of the attribution content verify: re-fingerprint
    counters/cycles/leases and compare against the same-transaction
    in-DB digest (an UPDATE counters SET llm=0 reset denies here as
    digest-mismatch, although every numeric check passes). Marker
    slots are strict-validated then re-baselined from in-DB truth
    (adopt — same direction rule as attribution)."""
    expect = (("counters", "counters"), ("cycles", "cycles"),
              ("leases", "leases"))
    try:
        live = {t: con.execute(
            "SELECT digest, n FROM content_digest WHERE "
            "\"table\"=?", (t,)).fetchone() for t, _ in expect}
    except (sqlite3.Error, ValueError) as e:
        raise LedgerCorrupt("digest-read:%s" % (e,))
    for slot, sql_table in expect:
        if live[slot] is None:
            raise LedgerCorrupt("digest-missing:%s" % slot)
        digest, n = _brecompute_table(con, slot, sql_table)
        if digest != live[slot][0] or n != live[slot][1]:
            raise LedgerCorrupt("digest-mismatch:%s" % slot)
    for slot, _ in expect:
        mslot = roots.get(slot)
        if not isinstance(mslot, dict):
            raise LedgerCorrupt("marker-roots-corrupt:%s" % slot)
        _breq_digest(mslot, slot)
        _breq_int(mslot, "count", slot)
    seen_flag = roots.get("_seen")
    if seen_flag is not None:
        if not isinstance(seen_flag, dict) or \
                seen_flag.get("v") != 1:
            raise LedgerCorrupt("marker-roots-corrupt:_seen")
    _bmirror_roots_locked(db_path, con, live)


def _bmirror_roots_locked(db_path, con, live=None):
    try:
        if live is None:
            live = {t: con.execute(
                "SELECT digest, n FROM content_digest WHERE "
                "\"table\"=?", (t,)).fetchone()
                for t in ("counters", "cycles", "leases")}
        stats = {}
        for slot in ("counters", "cycles", "leases"):
            row = live[slot]
            if row is None:
                raise ValueError("digest row missing: %s" % slot)
            stats[slot] = {"digest": row[0], "count": row[1]}
        locks.merge_marker_roots(
            db_path, stats, exact=("count",))
    except (OSError, ValueError) as e:
        raise LedgerCorrupt("roots-mirror:%s" % (e,))


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

    def _seen_path(self):
        return self.path + ".seen"

    def _read_seen(self):
        """Out-of-band cycle registry root: {(cycle, symbol):
        first_wall} for every reservation ever made (pruned past
        the 30-day cycles window on write). Returns None when
        absent (trust-on-first-use adoption by the caller). Raises
        LedgerCorrupt on malformed/oversized/unreadable content —
        an unverifiable root denies, never verifies vacuously.
        Separate from the 1 KiB marker: a row set cannot live in
        the marker, and it shares the marker's directory and
        permissions (no new trust assumption)."""
        try:
            data = locks.load_json_bounded(self._seen_path(),
                                           max_bytes=1 << 20)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            raise LedgerCorrupt("seen-unreadable:%s" % (e,))
        if not isinstance(data, dict):
            raise LedgerCorrupt("seen-malformed")
        clean = {}
        for key, val in data.items():
            if type(key) is not str or "\x00" not in key:
                raise LedgerCorrupt("seen-malformed")
            if type(val) not in (int, float) or \
                    isinstance(val, bool):
                raise LedgerCorrupt("seen-malformed")
            clean[key] = val
        return clean

    def _write_seen(self, seen, now_wall):
        """Merge-add into the sidecar registry (pruning entries
        past the cycles window). Additive merge converges across
        processes; every reserve re-adds its key from DB truth, so
        a lost update self-heals on next touch (graceful to the
        in-DB registry rule, never to silent creation). Records the
        adoption flag in the marker (one-time-migration witness:
        a later missing sidecar with the flag set denies as
        seen-deleted). Raises LedgerCorrupt on write failure."""
        cutoff = now_wall - CYCLES_RETAIN_DAYS * 86400
        try:
            cur = self._read_seen() or {}
        except LedgerCorrupt:
            raise
        for key in [k for k, v in cur.items() if v < cutoff]:
            del cur[key]
        for key, val in seen.items():
            cur[key] = val
        import json as _json
        raw = _json.dumps(cur, sort_keys=True).encode("utf-8")
        if len(raw) > (1 << 20):
            raise LedgerCorrupt("seen-overflow")
        try:
            import os as _os
            locks.atomic_write_bytes(
                _os.path.dirname(_os.path.abspath(self.path)),
                _os.path.basename(self._seen_path()), raw)
            locks.merge_marker_roots(self.path, {"_seen": {"v": 1}})
        except (OSError, ValueError) as e:
            raise LedgerCorrupt("seen-write:%s" % (e,))

    @staticmethod
    def _seen_key(cycle_id, symbol):
        return "%s\x00%s" % (cycle_id, symbol)

    def _pristine(self, con, have):
        """No init token and every present ledger table empty:
        init never completed, so a single-transaction re-init
        cannot destroy established state. A present digest table
        with nonzero rows blocks pristine (inconsistent with empty
        money tables — that denies at verify instead)."""
        try:
            if "meta" in have:
                cur = con.execute(
                    "SELECT v FROM meta WHERE k='init_token'"
                ).fetchone()
                if cur is not None:
                    return False
            for table in ("counters", "leases", "cycles"):
                if table in have and con.execute(
                        "SELECT COUNT(*) FROM %s" % table
                        ).fetchone()[0] > 0:
                    return False
            if "content_digest" in have and con.execute(
                    "SELECT COUNT(*) FROM content_digest WHERE "
                    "n != 0 OR a != 0 OR b != 0 OR digest != '%s'"
                    % _BZERO_DIGEST).fetchone()[0] > 0:
                return False
        except (sqlite3.Error, ValueError):
            return False
        return True

    def _connect(self, fresh_ok, abort_symbol):
        # See attribution._connect: first-creation check-then-mint
        # serializes on a dedicated lock file (data-lock ->
        # create-lock order, never the reverse).
        with locks.FileLock(self.path + ".create.lock",
                            purpose="create"):
            return self._connect_locked(fresh_ok, abort_symbol)

    def _connect_locked(self, fresh_ok, abort_symbol):
        exists = os.path.exists(self.path)
        mstate, marker = locks.marker_state(self.path)
        if not exists:
            if mstate == "valid":
                # The authority was deleted mid-deployment. Recreate-
                # as-fresh would zero live counters: abort instead.
                raise LedgerCorrupt("authority-deleted")
            if mstate == "invalid":
                # Damaged marker, no DB: cannot prove first install.
                raise LedgerCorrupt("marker-invalid")
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
            ver0 = con.execute("PRAGMA user_version").fetchone()[0]
            try:
                have = {r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE "
                    "type='table'")}
            except (sqlite3.Error, ValueError) as e:
                # Unreadable catalog (torn page, bad text): the
                # schema is unverifiable, so the authority is
                # too — deny.
                raise LedgerCorrupt("catalog-unreadable:%r" % (e,))
            missing = [t for t in ("counters", "leases", "meta")
                       if t not in have]
            if missing and not (
                    locks.may_create_tables(have, exists, mstate)
                    or (exists and mstate == "absent"
                        and self._pristine(con, have))):
                # Established file, table gone: deletion or
                # corruption, never a creation case (a recreated
                # empty counters table would reset live budgets).
                # First init and pristine files create below.
                raise LedgerCorrupt("table-missing:%s" % missing[0])
            inited = False
            digest_backfilled = False
            if locks.may_create_tables(have, exists, mstate) or \
                    (exists and mstate == "absent"
                     and self._pristine(con, have)):
                # First init (or a crash-interrupted one: no
                # marker, no token, no rows) — schema + version +
                # token in ONE transaction, marker + empty seen
                # registry after. A crash can only leave an
                # absent/pristine file that re-inits cleanly. No
                # DDL runs outside this transaction.
                token = locks.fresh_token()
                try:
                    con.execute("BEGIN IMMEDIATE")
                    try:
                        con.execute(_COUNTERS_DDL)
                        con.execute(_LEASES_DDL)
                        con.execute(_META_DDL)
                        con.execute(_CYCLES_DDL)
                        con.execute(_BDIGEST_DDL)
                        for _slot in ("counters", "cycles",
                                      "leases"):
                            con.execute(
                                "INSERT INTO content_digest VALUES "
                                "(?,?,?,?,?)",
                                (_slot, _BZERO_DIGEST, 0, 0, 0))
                        con.execute("PRAGMA user_version=%d" %
                                    SCHEMA_VERSION)
                        con.execute("INSERT INTO meta VALUES "
                                    "('init_token',?)", (token,))
                        con.execute("COMMIT")
                    except BaseException:
                        try:
                            con.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                        raise
                except sqlite3.Error as e:
                    raise LedgerCorrupt("init:%s" % (e,))
                try:
                    locks.write_marker(self.path, token)
                    self._write_seen({}, int(time.time()))
                except (OSError, ValueError, LedgerCorrupt) as e:
                    raise LedgerCorrupt("init-publish:%s" % (e,))
                inited = True
                cycles_present = True
            else:
                cycles_present = "cycles" in have
            if not inited and "cycles" not in have:
                if exists and ver0 == SCHEMA_VERSION:
                    # Versioned schema says the registry exists:
                    # its absence is deletion, not an upgrade.
                    raise LedgerCorrupt("table-missing:cycles")
                if exists and ver0 not in (0, 1):
                    # Unknown version: the version gate below owns
                    # this case (never migrate blindly into it).
                    pass
                else:
                    # Old ledger (or fresh file): explicit versioned
                    # migration — CREATE + backfill + version bump in
                    # ONE transaction, so a crash can only leave the
                    # table ABSENT (migration retries cleanly), never
                    # present-but-empty over live counters. No CREATE
                    # runs outside this transaction. The content
                    # digest rides the same transaction (old ledgers
                    # have no digest table: CREATE + full recompute
                    # from backfilled truth).
                    try:
                        con.execute("BEGIN IMMEDIATE")
                        try:
                            con.execute(_CYCLES_DDL)
                            con.execute(
                                "INSERT INTO cycles SELECT cycle, "
                                "symbol, start_wall FROM counters")
                            con.execute(_BDIGEST_DDL)
                            for _slot, _sql in (
                                    ("counters", "counters"),
                                    ("cycles", "cycles"),
                                    ("leases", "leases")):
                                _d, _n = _brecompute_table(con, _slot,
                                                           _sql)
                                con.execute(
                                    "INSERT OR IGNORE INTO "
                                    "content_digest VALUES "
                                    "(?,?,?,?,?)",
                                    (_slot, _d, _n, 0, 0))
                            con.execute("PRAGMA user_version=%d" %
                                        SCHEMA_VERSION)
                            con.execute("COMMIT")
                        except BaseException:
                            try:
                                con.execute("ROLLBACK")
                            except sqlite3.Error:
                                pass
                            raise
                    except sqlite3.Error as e:
                        raise LedgerCorrupt("cycles-backfill:%s" % e)
                cycles_present = True
                digest_backfilled = True
            elif not inited:
                if ver0 == 1:
                    # Round-3/4-era ledger: schema-identical to v2,
                    # adopt the version explicitly.
                    con.execute("PRAGMA user_version=%d" %
                                SCHEMA_VERSION)
                # NOTE: no present-but-empty backfill here. An empty
                # cycles table over live counters is cycles-only
                # deletion (pruning forgets a cycle only after its
                # counters aged out, and the versioned migration
                # above is single-transaction) — healing it would
                # resurrect registry cover for deleted authority.
                # The reuse readers (_reserve_row/_live_row_or_abort)
                # and the sidecar verify below deny it instead.
            if "content_digest" not in have:
                # Pre-digest ledger: one versioned backfill (CREATE
                # + full recompute from truth in a single
                # transaction, idempotent and retry-clean). A
                # present table is never backfilled here (a
                # present-but-emptied digest over live rows is
                # tamper and denies at verify).
                try:
                    con.execute("BEGIN IMMEDIATE")
                    try:
                        con.execute(_BDIGEST_DDL)
                        for _slot, _sql in (
                                ("counters", "counters"),
                                ("cycles", "cycles"),
                                ("leases", "leases")):
                            _d, _n = _brecompute_table(con, _slot,
                                                       _sql)
                            con.execute(
                                "INSERT OR IGNORE INTO content_digest "
                                "VALUES (?,?,?,?,?)",
                                (_slot, _d, _n, 0, 0))
                        con.execute("COMMIT")
                    except BaseException:
                        try:
                            con.execute("ROLLBACK")
                        except sqlite3.Error:
                            pass
                        raise
                except sqlite3.Error as e:
                    raise LedgerCorrupt("digest-backfill:%s" % (e,))
                digest_backfilled = True
            for table, cols in _EXPECTED_COLUMNS.items():
                got = [r[1] for r in con.execute(
                    "PRAGMA table_info(%s)" % table)]
                if got != cols:
                    raise LedgerCorrupt("schema-mismatch:%s" % table)
            row = con.execute("PRAGMA integrity_check").fetchone()
            if row is None or row[0] != "ok":
                raise LedgerCorrupt("integrity:%r" % (row,))
            ver = con.execute("PRAGMA user_version").fetchone()[0]
            cur = None
            if "meta" in have or inited:
                cur = con.execute(
                    "SELECT v FROM meta WHERE k='init_token'"
                ).fetchone()
            if not inited:
                # Established ledger (init published above and
                # skips this: its ver/token/marker were just set).
                if ver != SCHEMA_VERSION:
                    raise LedgerCorrupt("version:%r" % (ver,))
                if cur is None:
                    raise LedgerCorrupt("token-missing")
                if mstate == "invalid":
                    raise LedgerCorrupt("marker-invalid")
                if mstate == "absent":
                    # A missing trust root over live rows denies;
                    # over an empty token-bearing DB (crashed init
                    # between commit and marker) it heals.
                    live = con.execute(
                        "SELECT COUNT(*) FROM counters"
                    ).fetchone()[0] + con.execute(
                        "SELECT COUNT(*) FROM leases"
                    ).fetchone()[0]
                    if cycles_present:
                        live += con.execute(
                            "SELECT COUNT(*) FROM cycles"
                        ).fetchone()[0]
                    if live:
                        raise LedgerCorrupt("marker-deleted")
                    locks.write_marker(self.path, cur[0])
                elif marker != cur[0]:
                    raise LedgerCorrupt("token-mismatch")
            try:
                roots = locks.marker_roots(self.path)
            except ValueError:
                raise LedgerCorrupt("marker-roots-corrupt")
            if any(k in roots
                   for k in ("counters", "cycles", "leases")):
                _bverify_history_locked(self.path, con, roots)
            else:
                # No content slots yet (fresh init or pre-roots
                # marker): trust-on-first-use adoption of in-DB
                # truth (documented); every later open verifies
                # strictly. The _seen flag, if present, is
                # preserved by the merge.
                _bmirror_roots_locked(self.path, con)
            try:
                seen = self._read_seen()
            except LedgerCorrupt:
                raise
            now_now = int(time.time())
            if seen is None:
                try:
                    adopted_before = bool(
                        locks.marker_roots(self.path).get("_seen"))
                except ValueError:
                    raise LedgerCorrupt("marker-roots-corrupt")
                if adopted_before:
                    if digest_backfilled:
                        # The digest itself was reconstructed this
                        # open (its table was gone): with the
                        # registry sidecar also gone, nothing proves
                        # the reconstructed truth is complete — a
                        # wiped registry could be hiding behind the
                        # backfill. Deny, never fresh-create.
                        raise LedgerCorrupt("seen-deleted")
                    # Only the sidecar file is lost: the content
                    # digest verified intact above, so no rows were
                    # deleted and re-adoption from the live registry
                    # is safe (self-healing availability; the flag
                    # is re-recorded by the write).
                # Genuinely pre-sidecar ledger: one-time adoption
                # from the cycles registry (verified above); the
                # write records the adoption flag in the marker, so
                # this path never runs twice for one ledger.
                adopt = {}
                if cycles_present:
                    for cyc, sym, fw in con.execute(
                            "SELECT cycle, symbol, first_wall FROM "
                            "cycles"):
                        adopt[self._seen_key(cyc, sym)] = fw
                try:
                    self._write_seen(adopt, now_now)
                except LedgerCorrupt:
                    raise
                seen = adopt
            else:
                young = now_now - CYCLES_RETAIN_DAYS * 86400
                for key, fw in seen.items():
                    if fw < young:
                        continue
                    cyc, sym = key.split("\x00")
                    hit = con.execute(
                        "SELECT 1 FROM cycles WHERE cycle=? AND "
                        "symbol=?", (cyc, sym)).fetchone()
                    if hit is None:
                        # A young registry row cannot prune away:
                        # joint deletion of counters + registry.
                        raise LedgerCorrupt(
                            "registry-deleted:%s" % cyc)
        except LedgerCorrupt:
            con.close()
            raise
        except (sqlite3.Error, ValueError) as e:
            # ValueError covers undecodable text from torn pages
            # (integrity/table reads), which is corruption too.
            con.close()
            raise LedgerCorrupt(str(e))
        return con

    def _prune(self, con, now_wall):
        cutoff = now_wall - LEDGER_RETAIN_DAYS * 86400
        gone_counters = con.execute(
            "SELECT cycle, symbol, llm, tools, tokens, depth, "
            "start_wall, dead FROM counters WHERE start_wall < ?",
            (cutoff,)).fetchall()
        con.execute("DELETE FROM counters WHERE start_wall < ?", (cutoff,))
        if gone_counters:
            _bdig_apply(con, "counters",
                        outs=[list(r) for r in gone_counters],
                        dn=-len(gone_counters))
        gone_leases = con.execute(
            "SELECT l.lease_id, l.cycle, l.symbol, l.kind, l.reserved, "
            "l.actual, l.settled FROM leases l LEFT JOIN counters c "
            "ON l.cycle = c.cycle AND l.symbol = c.symbol "
            "WHERE c.cycle IS NULL").fetchall()
        con.execute(
            "DELETE FROM leases WHERE lease_id IN (SELECT l.lease_id "
            "FROM leases l LEFT JOIN counters c ON l.cycle = c.cycle "
            "AND l.symbol = c.symbol WHERE c.cycle IS NULL)")
        if gone_leases:
            _bdig_apply(con, "leases",
                        outs=[list(r) for r in gone_leases],
                        dn=-len(gone_leases))
        gone_cycles = con.execute(
            "SELECT cycle, symbol, first_wall FROM cycles WHERE "
            "first_wall < ?",
            (now_wall - CYCLES_RETAIN_DAYS * 86400,)).fetchall()
        con.execute("DELETE FROM cycles WHERE first_wall < ?",
                    (now_wall - CYCLES_RETAIN_DAYS * 86400,))
        if gone_cycles:
            _bdig_apply(con, "cycles",
                        outs=[list(r) for r in gone_cycles],
                        dn=-len(gone_cycles))

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

    def _note_seen(self, cycle_id, symbol, first_wall, now_wall):
        """Post-commit sidecar registry maintenance: re-add this
        cycle's key from DB truth (creation and every reuse). Runs
        AFTER the SQLite commit — a crash before it leaves the DB
        row present, so the next reserve re-adds the key
        (self-healing); a crash after it is a normal committed
        reservation. Publish failure aborts (fail-closed; the
        counters already moved, which is the safe direction —
        over-counted, never under — and the next reserve
        retries the note)."""
        try:
            self._write_seen(
                {self._seen_key(cycle_id, symbol): first_wall},
                now_wall)
        except LedgerCorrupt as e:
            _abort(symbol, "seen-publish:%s" % (e,))

    def _reserve_row(self, con, cycle_id, symbol, now_wall):
        """Counters row for a new reservation: existing rows resume;
        a missing row for a cycle seen within LEDGER_RETAIN_DAYS is
        an illegitimate deletion (only _prune may delete, and only
        older rows) → abort, never fresh counters over live state.
        A missing row with old or no registry memory is genuinely
        new (or prune-aged) → create + (re)register. A PRESENT row
        whose registry entry is gone is registry-only deletion
        (pruning forgets cycles only after their counters aged
        out) → abort. Returns (row, registry_first_wall)."""
        e = self._row(con, cycle_id, symbol, now_wall, False)
        if e is not None:
            reg = con.execute(
                "SELECT first_wall FROM cycles WHERE cycle=? AND "
                "symbol=?", (cycle_id, symbol)).fetchone()
            if reg is None:
                _abort(symbol, "registry-deleted")
            return e, reg[0]
        seen = con.execute(
            "SELECT first_wall FROM cycles WHERE cycle=? AND "
            "symbol=?", (cycle_id, symbol)).fetchone()
        if (seen is not None and seen[0] >=
                now_wall - LEDGER_RETAIN_DAYS * 86400):
            _abort(symbol, "counters-deleted")
        if now_wall > time.time() + r15.CLOCK_SKEW_S:
            # The inserted start_wall derives from now_wall (a
            # test/control parameter): a future value would mint a
            # future-dated authority — refuse at write, not just
            # at read.
            _abort(symbol, "future-start-wall")
        old_reg = con.execute(
            "SELECT cycle, symbol, first_wall FROM cycles WHERE "
            "cycle=? AND symbol=?", (cycle_id, symbol)).fetchone()
        con.execute(
            "INSERT INTO counters VALUES (?,?,?,?,?,?,?,0)",
            (cycle_id, symbol, 0, 0, 0, 0, now_wall))
        _bdig_apply(con, "counters",
                    ins=[[cycle_id, symbol, 0, 0, 0, 0, now_wall, 0]],
                    dn=1)
        con.execute("INSERT OR REPLACE INTO cycles VALUES (?,?,?)",
                    (cycle_id, symbol, now_wall))
        if old_reg is None:
            _bdig_apply(con, "cycles",
                        ins=[[cycle_id, symbol, now_wall]], dn=1)
        else:
            _bdig_apply(con, "cycles", outs=[list(old_reg)],
                        ins=[[cycle_id, symbol, now_wall]])
        return [0, 0, 0, 0, now_wall, 0], now_wall

    def _live_row_or_abort(self, con, cycle_id, symbol, now_wall):
        """Read-only twin of _reserve_row: an existing row resumes;
        a missing row for a cycle seen within LEDGER_RETAIN_DAYS is
        a deleted authority → abort (a reader that mints zeros over
        a live cycle corrupts every downstream estimate). Missing
        with old or no registry memory → None (genuinely new). A
        present row with no registry entry is registry-only
        deletion (pruning forgets a cycle only after its counters
        aged out, so a live row always has its entry) → abort."""
        e = self._row(con, cycle_id, symbol, now_wall, False)
        if e is not None:
            reg = con.execute(
                "SELECT 1 FROM cycles WHERE cycle=? AND symbol=?",
                (cycle_id, symbol)).fetchone()
            if reg is None:
                _abort(symbol, "registry-deleted")
            return e
        seen = con.execute(
            "SELECT first_wall FROM cycles WHERE cycle=? AND "
            "symbol=?", (cycle_id, symbol)).fetchone()
        if (seen is not None and seen[0] >=
                now_wall - LEDGER_RETAIN_DAYS * 86400):
            _abort(symbol, "counters-deleted")
        return None

    def _row(self, con, cycle_id, symbol, now_wall, create):
        # NOTE: create=True is legacy; reserve paths use _reserve_row
        # (deletion-detecting). No other caller passes True.
        cur = con.execute(
            "SELECT llm, tools, tokens, depth, start_wall, dead "
            "FROM counters WHERE cycle = ? AND symbol = ?",
            (cycle_id, symbol))
        r = cur.fetchone()
        if r is None:
            if not create:
                return None
            if now_wall > time.time() + r15.CLOCK_SKEW_S:
                _abort(symbol, "future-start-wall")
            con.execute(
                "INSERT INTO counters VALUES (?,?,?,?,?,?,?,0)",
                (cycle_id, symbol, 0, 0, 0, 0, now_wall))
            return [0, 0, 0, 0, now_wall, 0]
        e = list(r)
        # Semantic validation on EVERY read (old DBs predate the DDL
        # CHECKs, and corruption/fraud can edit any file): negative
        # counters would authorize beyond R15, a bad dead flag would
        # misroute, a non-finite wall would break retention math. An
        # invalid row aborts — never normalized, never clamped.
        if (not all(type(v) is int and v >= 0 for v in e[:4])
                or type(e[4]) not in (int, float)
                or isinstance(e[4], bool)
                or not math.isfinite(e[4]) or e[4] < 0
                or type(e[5]) is not int or e[5] not in (0, 1)):
            _abort(symbol, "counters-corrupt")
        if e[4] > now_wall + r15.CLOCK_SKEW_S:
            # A start in the future extends the wall-clock budget:
            # now - start stays negative, so wall-exhausted can
            # never fire. Fail closed (small skew allowance for
            # honest clock drift), never extend the authority.
            _abort(symbol, "future-start-wall")
        return e

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
            e = self._live_row_or_abort(con, cycle_id, symbol,
                                        time.time())
            if e is None:
                return {"llm": 0, "tools": 0, "tokens": 0, "depth": 0,
                        "start_wall": time.time(), "dead": False}
            return {"llm": e[0], "tools": e[1], "tokens": e[2],
                    "depth": e[3], "start_wall": e[4],
                    "dead": bool(e[5])}
        # No reason-masking: _op already raises specific ledger-* aborts
        # (corrupt/deleted/integrity), which must reach the caller.
        return self._op(True, _get, symbol)

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
            e, first_wall = self._reserve_row(con, cycle_id, symbol,
                                              now_wall)
            self._check_row(e, symbol, now_wall)
            if e[2] + token_need > r15.TOKENS:
                _abort(symbol, "tokens-exhausted")
            if e[1] + tool_need > r15.TOOL_CALLS:
                _abort(symbol, "tools-exhausted")
            e_old = list(e)
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
            _bdig_apply(con, "counters",
                        outs=[[cycle_id, symbol] + e_old],
                        ins=[[cycle_id, symbol] + e])
            lease_id = "%s:%s:call:%d" % (cycle_id, symbol, e[0])
            con.execute(
                "INSERT INTO leases VALUES (?,?,?,?,?,NULL,0)",
                (lease_id, cycle_id, symbol, "call", token_need))
            _bdig_apply(con, "leases",
                        ins=[[lease_id, cycle_id, symbol, "call",
                              token_need, None, 0]],
                        dn=1)
            _bmirror_roots_locked(self.path, con)
            return ({"lease_id": lease_id, "seq": e[0],
                    "reserved": token_need,
                    "tools_reserved": tool_need,
                    "remaining_tokens": r15.TOKENS - e[2]},
                    first_wall)
        out, first_wall = self._op(True, _res, symbol)
        if _storage_size(self.path) > LEDGER_MAX_BYTES:
            self._reclaim()
        self._note_seen(cycle_id, symbol, first_wall, now_wall)
        return out

    def settle_call(self, cycle_id, symbol, lease, actual_tokens):
        self._valid_need(actual_tokens, 10 ** 12, "tokens", symbol)
        if actual_tokens > r15.TOKENS:
            # Actual usage outside the legal cycle bound is an
            # accounting defect, never a number to store.
            _abort(symbol, "actual-exceeds-cycle-bound")

        def _set(con):
            cur = con.execute(
                "SELECT cycle, symbol, kind, reserved, actual, settled "
                "FROM leases WHERE lease_id = ?",
                (lease["lease_id"],))
            r = cur.fetchone()
            if r is None:
                _abort(symbol, "unknown-lease")
            if (type(r[3]) is not int or r[3] < 0
                    or type(r[5]) is not int or r[5] not in (0, 1)):
                # Corrupt lease terms would mis-settle another row's
                # counters: abort, never normalize.
                _abort(symbol, "lease-corrupt")
            if r[5]:
                _abort(symbol, "double-settle")
            if r[0] != cycle_id or r[1] != symbol or r[2] != "call":
                # Cross-cycle / cross-symbol / cross-kind settlement
                # would corrupt another row's counters: refuse loudly.
                _abort(symbol, "cross-lease-settle")
            reserved = r[3]
            con.execute(
                "UPDATE leases SET actual=?, settled=1 WHERE lease_id=?",
                (actual_tokens, lease["lease_id"]))
            _bdig_apply(con, "leases",
                        outs=[[lease["lease_id"]] + list(r)],
                        ins=[[lease["lease_id"], r[0], r[1], r[2],
                              r[3], actual_tokens, 1]])
            e = self._live_row_or_abort(con, cycle_id, symbol,
                                        time.time())
            if e is None:
                _abort(symbol, "counters-missing-at-settle")
            new_tokens = e[2] - reserved + actual_tokens
            if new_tokens < 0:
                # Counter corruption: clamping to zero would hide it.
                _abort(symbol, "token-underflow")
            con.execute("UPDATE counters SET tokens=? WHERE cycle=? "
                        "AND symbol=?", (new_tokens, cycle_id, symbol))
            new_e = list(e)
            new_e[2] = new_tokens
            _bdig_apply(con, "counters",
                        outs=[[cycle_id, symbol] + e],
                        ins=[[cycle_id, symbol] + new_e])
            _bmirror_roots_locked(self.path, con)
            return new_tokens
        return self._op(False, _set, symbol)

    def reserve_tool(self, cycle_id, symbol, now_wall=None):
        """In-parent deterministic tool counting (parser work, no
        provider). Provider tool consumption reserves through
        reserve_call's tool_need instead."""
        now_wall = time.time() if now_wall is None else now_wall

        def _res(con):
            self._prune(con, now_wall)
            e, first_wall = self._reserve_row(con, cycle_id, symbol,
                                              now_wall)
            self._check_row(e, symbol, now_wall)
            e_old = list(e)
            e[1] += 1
            e[3] += 1
            con.execute(
                "UPDATE counters SET tools=?, depth=? WHERE cycle=? "
                "AND symbol=?", (e[1], e[3], cycle_id, symbol))
            _bdig_apply(con, "counters",
                        outs=[[cycle_id, symbol] + e_old],
                        ins=[[cycle_id, symbol] + e])
            _bmirror_roots_locked(self.path, con)
            return {"seq": e[1]}, first_wall
        out, first_wall = self._op(True, _res, symbol)
        self._note_seen(cycle_id, symbol, first_wall, now_wall)
        return out

    def check(self, cycle_id, symbol, now_wall=None):
        now_wall = time.time() if now_wall is None else now_wall

        def _chk(con):
            e = self._live_row_or_abort(con, cycle_id, symbol, now_wall)
            if e is None:
                return
            self._check_row(e, symbol, now_wall)
        self._op(True, _chk, symbol)

    def invalidate(self, cycle_id, symbol):
        """Poison a (cycle, symbol) after a timeout/ambiguous failure:
        no further reservation succeeds. A missing row is a loud
        defect (invalidating a cycle that never reserved hides
        ordering bugs), not a silent no-op."""

        def _inv(con):
            if self._live_row_or_abort(con, cycle_id, symbol,
                                       time.time()) is None:
                _abort(symbol, "counters-missing-at-invalidate")
            old = con.execute(
                "SELECT cycle, symbol, llm, tools, tokens, depth, "
                "start_wall, dead FROM counters WHERE cycle=? AND "
                "symbol=?", (cycle_id, symbol)).fetchone()
            cur = con.execute("UPDATE counters SET dead=1 WHERE cycle=?"
                              " AND symbol=?", (cycle_id, symbol))
            if not cur.rowcount:
                _abort(symbol, "counters-missing-at-invalidate")
            new = list(old)
            new[7] = 1
            _bdig_apply(con, "counters", outs=[list(old)],
                        ins=[new])
            _bmirror_roots_locked(self.path, con)
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
