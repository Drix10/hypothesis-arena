"""D9 spend/token attribution ledger (doc 08 sec. 8.2 + doc 10 sec. 10.4).

One durable row per actual model invocation, written by the parent-side
gate (workers.run_gated) that also reserves R15 budget.

Durability: SQLite is authoritative (UNIQUE(span_id) gives atomic
exactly-once across processes). The JSONL mirror beside it is a
best-effort Langfuse tail, appended only when the ledger actually inserts
(rowcount == 1); sync_mirror() regenerates it atomically from the ledger.

Row schema (doc-10 spend taxonomy + outcome + unknown flag):
  ts, research_epoch, cycle_id, stage, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category, outcome,
  is_unknown, span_id.
category is the doc-10 set {decision, research, experiment,
observability}; error/timeout/blocked live in `outcome`
{success, error, timeout, blocked}. is_unknown=1 marks an ambiguous
attempt (may have been billed): its usd is the full pre-call reservation,
never $0, and it blocks future spend until a supervisor reconciles it
(reconcile_unknown). usd is supplied by the caller from the deployment
pricing table; 0.0 on a success row means a zero-price model (unpriced
models never run).

Spend authorization is one atomic transaction (reserve_spend_hold):
reap expired holds, unknown/invoked block check, committed measurement,
cap compare and hold insert under one lock in a single BEGIN IMMEDIATE.
Any positive-dollar spend_holds row in state='invoked' counts as
unresolved unknown spend (crash backstop). Ambiguous attempts are
recorded by record_unknown() in one transaction (span + unknown row +
invoked mark); reconcile_unknown() recovers from a crash at any point of
that path.

Duplicate span identity is strict: same span_id + identical payload is an
idempotent no-op; same span_id + different payload is a hard conflict.

Row validation: every numeric/string field is validated in Python and
constrained in DDL (CHECK(usd=usd) rejects NaN, usd >= 0, token bounds,
string length bounds, category/outcome enums). PRAGMA user_version is
pinned and PRAGMA integrity_check is read (non-"ok" aborts). A
missing/corrupt ledger is LedgerUnavailable, never zero spend, except a
genuinely new path (no DB and no init marker), which mints fresh.
Marker-without-DB aborts (authority-deleted). Storage (main+wal+shm) is
bounded with checkpoint/vacuum reclaim.

hold_spend/mark_invoked/settle_hold/reap_holds are the crash-state
constructors the recovery tests build ambiguous states from (production
authorization goes only through reserve_spend_hold);
day_summary/sync_mirror/committed_spend are read-only supervisor/audit
surfaces.
"""
import hashlib
import json
import math
import os
import sqlite3
import time

from . import locks

CATEGORIES = ("decision", "research", "experiment", "observability")
OUTCOMES = ("success", "error", "timeout", "blocked")

SCHEMA_VERSION = 3
LEDGER_MAX_BYTES = 64 << 20
SPAN_RETAIN_DAYS = 120  # > 90d ratio window + margin, then pruned

SPAN_ID_MAX = 128
IDENT_MAX = 64
MODEL_MAX = 128
STAGE_MAX = 16
USD_MAX = 10 ** 9
TOKENS_MAX = 10 ** 12
EPOCH_MAX = 2 ** 31 - 1

_SPANS_DDL = (
    "CREATE TABLE IF NOT EXISTS spans ("
    "span_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, "
    "research_epoch INTEGER NOT NULL, cycle_id TEXT NOT NULL, "
    "stage TEXT NOT NULL, symbol TEXT NOT NULL, "
    "node TEXT NOT NULL, model TEXT NOT NULL, "
    "prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, "
    "usd REAL NOT NULL, category TEXT NOT NULL, outcome TEXT NOT NULL, "
    "is_unknown INT NOT NULL DEFAULT 0, "
    "CHECK (usd = usd AND usd >= 0 AND usd <= 1000000000.0), "
    "CHECK (prompt_tokens >= 0 AND prompt_tokens <= "
    "1000000000000), "
    "CHECK (completion_tokens >= 0 AND completion_tokens <= "
    "1000000000000), "
    "CHECK (length(span_id) BETWEEN 1 AND 128), "
    "CHECK (category IN "
    "('decision','research','experiment','observability')), "
    "CHECK (outcome IN ('success','error','timeout','blocked')), "
    "CHECK (is_unknown IN (0, 1)))")
_UNKNOWN_DDL = (
    "CREATE TABLE IF NOT EXISTS unknown_holds ("
    "lease_id TEXT PRIMARY KEY, span_id TEXT NOT NULL, usd REAL NOT NULL, "
    "ts INTEGER NOT NULL, reconciled INT NOT NULL DEFAULT 0, "
    "CHECK (usd = usd AND usd >= 0))")
_RECON_DDL = (
    "CREATE TABLE IF NOT EXISTS reconciliations ("
    "lease_id TEXT NOT NULL, old_usd REAL NOT NULL, "
    "new_usd REAL NOT NULL, ts INTEGER NOT NULL, note TEXT NOT NULL)")
_SPEND_HOLDS_DDL = (
    "CREATE TABLE IF NOT EXISTS spend_holds ("
    "lease_id TEXT PRIMARY KEY, usd REAL NOT NULL, state TEXT NOT NULL, "
    "ts INTEGER NOT NULL, span_id TEXT, "
    "CHECK (usd = usd AND usd >= 0), "
    "CHECK (state IN ('reserved','invoked')))")
_META_DDL = ("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, "
             "v TEXT NOT NULL)")

_EXPECTED_COLUMNS = {
    "spans": ["span_id", "ts", "research_epoch", "cycle_id", "stage",
              "symbol", "node", "model", "prompt_tokens",
              "completion_tokens", "usd", "category", "outcome",
              "is_unknown"],
    "unknown_holds": ["lease_id", "span_id", "usd", "ts",
                      "reconciled"],
    "reconciliations": ["lease_id", "old_usd", "new_usd", "ts",
                        "note"],
    "spend_holds": ["lease_id", "usd", "state", "ts", "span_id"],
    "meta": ["k", "v"],
    "content_digest": ["table", "digest", "n", "a", "b"],
}

# Tables whose presence the missing-table gate enforces. The digest table
# is excluded: its absence on an established ledger is a versioned backfill
# (recompute from truth once), while an emptied digest table over live rows
# is tamper and denies.
_GATED_TABLES = ("spans", "unknown_holds", "reconciliations",
                 "spend_holds", "meta")

_DIGEST_DDL = (
    "CREATE TABLE IF NOT EXISTS content_digest ("
    "\"table\" TEXT PRIMARY KEY, digest TEXT NOT NULL, "
    "n INTEGER NOT NULL, a INTEGER NOT NULL, b INTEGER NOT NULL)")

# Canonical column order per digest slot; the SELECT order must match or the
# fingerprint changes. aux (a, b) per slot: spans a = exact usd cents; holds
# a = created, b = closed (same transaction, no lag); other slots a = b = 0.
_DIGEST_COLS = {
    "spans": _EXPECTED_COLUMNS["spans"],
    "recon": _EXPECTED_COLUMNS["reconciliations"],
    "unknown": _EXPECTED_COLUMNS["unknown_holds"],
    "holds": _EXPECTED_COLUMNS["spend_holds"],
}

_ZERO_DIGEST = "0" * 64


def _hrow(values):
    """Canonical row hash: JSON of the value list (floats via shortest
    repr). Column order is the schema order (see _DIGEST_COLS)."""
    return hashlib.sha256(
        json.dumps(list(values), separators=(",", ":")).encode(
            "utf-8")).hexdigest()


def _dxor(a, b):
    return "%064x" % (int(a, 16) ^ int(b, 16))


def _cents(usd):
    """Exact usd-cents fingerprint by truncation, matching the SQL CAST used
    at recompute (same double multiply), so incremental and recomputed sums
    agree regardless of row order."""
    return int(usd * 100)


def _recompute_table(con, slot, sql_table):
    """Re-fingerprint one table from live rows: (digest, count,
    cents-or-0). XOR-based, so VACUUM, rowid reuse and plan changes cannot
    cause a false deny."""
    cols = _DIGEST_COLS[slot]
    cur = con.execute("SELECT %s FROM %s" % (",".join(cols),
                                               sql_table))
    acc = 0
    n = 0
    cents = 0
    usd_idx = cols.index("usd") if "usd" in cols else None
    for row in cur:
        acc ^= int(_hrow(row), 16)
        n += 1
        if usd_idx is not None and row[usd_idx] is not None:
            cents += _cents(row[usd_idx])
    return "%064x" % acc, n, cents


def _dig_apply(con, slot, sql_table, outs=(), ins=(), dn=0, da=0,
               db=0):
    """Incremental digest maintenance inside the mutation's own SQLite
    transaction: outs/ins are canonical value-lists of removed/added rows,
    dn/da/db counter deltas. Rows and digest are therefore both old or both
    new after a crash. Out-of-band SQL (attacker, corruption, torn pages)
    does not update the digest and shows as digest-mismatch at verify. A
    missing digest row denies, never recreates."""
    row = con.execute(
        "SELECT digest, n, a, b FROM content_digest WHERE \"table\"=?",
        (slot,)).fetchone()
    if row is None:
        raise LedgerUnavailable("digest-missing:%s" % slot)
    acc = int(row[0], 16)
    for vals in outs:
        acc ^= int(_hrow(vals), 16)
    for vals in ins:
        acc ^= int(_hrow(vals), 16)
    con.execute(
        "UPDATE content_digest SET digest=?, n=n+?, a=a+?, b=b+? "
        "WHERE \"table\"=?",
        ("%064x" % acc, dn, da, db, slot))


class LedgerUnavailable(Exception):
    pass


class SpendBlocked(Exception):
    """Spend refusal from inside the ledger transaction (cap crossed,
    unknowns pending, unmeasurable). The governor converts it to
    SpendRefused."""
    pass


def _storage_size(path):
    total = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            total += os.path.getsize(path + suffix)
        except OSError:
            pass
    return total


_ZERO_DIGEST = "0" * 64
_ZERO_ROOTS = {"spans": {"digest": _ZERO_DIGEST, "count": 0,
                           "cents": 0},
               "recon": {"digest": _ZERO_DIGEST, "count": 0},
               "unknown": {"digest": _ZERO_DIGEST, "count": 0},
               "holds": {"digest": _ZERO_DIGEST, "count": 0,
                           "created": 0, "closed": 0}}


def _req_int(slot, key, tag):
    """One required root integer: exact int (bool excluded), non-negative.
    Missing slots, floats (including NaN/inf) and negatives deny."""
    try:
        val = slot.get(key)
    except AttributeError:
        raise LedgerUnavailable("marker-roots-corrupt:%s" % tag)
    if type(val) is not int or isinstance(val, bool) or val < 0:
        raise LedgerUnavailable("marker-roots-corrupt:%s" % tag)
    return val


def _req_digest(slot, tag):
    """One required 64-hex content digest; anything else denies."""
    try:
        val = slot.get("digest")
    except AttributeError:
        raise LedgerUnavailable("marker-roots-corrupt:%s" % tag)
    if type(val) is not str or len(val) != 64:
        raise LedgerUnavailable("marker-roots-corrupt:%s" % tag)
    try:
        int(val, 16)
    except ValueError:
        raise LedgerUnavailable("marker-roots-corrupt:%s" % tag)
    return val


def _verify_history_locked(db_path, con, roots):
    """Row-content integrity check on every open of an established ledger.
    For each money table, re-fingerprint live rows and compare with the
    same-transaction in-DB digest; any mismatch is an out-of-band edit
    (UPDATE, DELETE, torn page) and denies as digest-mismatch. Holds must
    also satisfy active + closed == created. The marker mirror is then
    strictly validated (malformed slots deny) and re-baselined from in-DB
    truth when stale: the marker is refreshed from truth, never trusted over
    it, so marker tampering is erased and crash lag self-heals."""
    expect = (("spans", "spans", True),
              ("recon", "reconciliations", False),
              ("unknown", "unknown_holds", False),
              ("holds", "spend_holds", False))
    try:
        live = {t: con.execute(
            "SELECT digest, n, a, b FROM content_digest WHERE "
            "\"table\"=?", (t,)).fetchone() for t, _, _ in expect}
    except (sqlite3.Error, ValueError) as e:
        raise LedgerUnavailable("digest-read:%s" % (e,))
    for slot, sql_table, has_cents in expect:
        if live[slot] is None:
            raise LedgerUnavailable("digest-missing:%s" % slot)
        digest, n, cents = _recompute_table(con, slot, sql_table)
        if digest != live[slot][0] or n != live[slot][1]:
            raise LedgerUnavailable("digest-mismatch:%s" % slot)
        if has_cents and cents != live[slot][2]:
            raise LedgerUnavailable("digest-mismatch:%s-cents"
                                    % slot)
    active = con.execute(
        "SELECT COUNT(*) FROM spend_holds").fetchone()[0]
    if active + live["holds"][3] != live["holds"][2]:
        raise LedgerUnavailable("holds-count")
    for slot, _, _ in expect:
        mslot = roots.get(slot)
        if not isinstance(mslot, dict):
            raise LedgerUnavailable("marker-roots-corrupt:%s"
                                    % slot)
        _req_digest(mslot, slot)
        _req_int(mslot, "count", slot)
        if slot == "spans":
            _req_int(mslot, "cents", slot)
        if slot == "holds":
            _req_int(mslot, "created", slot)
            _req_int(mslot, "closed", slot)
    _mirror_roots_locked(db_path, con, live)


def _mirror_roots_locked(db_path, con, live=None):
    """Re-baseline the marker mirror from in-DB truth (post-commit, file
    lock held): digest/count/cents/created/closed copied from the digest
    table. Raises LedgerUnavailable on failure; the committed mutation stays
    valid and the next open retries the mirror."""
    try:
        if live is None:
            live = {t: con.execute(
                "SELECT digest, n, a, b FROM content_digest WHERE "
                "\"table\"=?", (t,)).fetchone()
                for t in ("spans", "recon", "unknown", "holds")}
        stats = {}
        for slot in ("spans", "recon", "unknown", "holds"):
            row = live[slot]
            if row is None:
                raise ValueError("digest row missing: %s" % slot)
            stats[slot] = {"digest": row[0], "count": row[1]}
        stats["spans"]["cents"] = live["spans"][2]
        stats["holds"]["created"] = live["holds"][2]
        stats["holds"]["closed"] = live["holds"][3]
        locks.merge_marker_roots(
            db_path, stats,
            exact=("count", "cents", "created", "closed"))
    except (OSError, ValueError) as e:
        raise LedgerUnavailable("roots-mirror:%s" % (e,))


def _pristine_locked(con, have):
    """No init token and every present money table empty: init never
    completed, so a single-transaction re-init cannot destroy established
    state. Absent tables count as empty (crash-interrupted first init)."""
    try:
        if "meta" in have:
            cur = con.execute(
                "SELECT v FROM meta WHERE k='init_token'"
            ).fetchone()
            if cur is not None:
                return False
        for table in ("spans", "unknown_holds", "reconciliations",
                      "spend_holds"):
            if table in have and con.execute(
                    "SELECT COUNT(*) FROM %s" % table
                    ).fetchone()[0] > 0:
                return False
        if "content_digest" in have:
            try:
                bad = con.execute(
                    "SELECT COUNT(*) FROM content_digest WHERE "
                    "n != 0 OR a != 0 OR b != 0 OR digest != '%s'"
                    % _ZERO_DIGEST).fetchone()[0]
            except (sqlite3.Error, ValueError):
                return False
            if bad:
                return False
    except (sqlite3.Error, ValueError):
        return False
    return True


def _connect(db_path, create=False):
    # First creation is check-then-mint: serialize it across processes on a
    # dedicated lock file. Lock order is always data-lock -> create-lock (this
    # function never takes a data lock), so creators cannot double-mint or cycle.
    with locks.FileLock(db_path + ".create.lock", purpose="create"):
        return _connect_locked(db_path, create)


def _marker_digest_era(db_path):
    """Marker shape as digest-era proof: True when any history slot carries
    a digest, False for pre-digest or pre-roots markers, None when the marker
    is unparseable (the caller denies)."""
    try:
        roots = locks.marker_roots(db_path)
    except ValueError:
        return None
    if not roots:
        return False
    for slot in ("spans", "recon", "unknown", "holds"):
        s = roots.get(slot)
        if isinstance(s, dict) and "digest" in s:
            return True
    return False


def _connect_locked(db_path, create=False):
    exists = os.path.exists(db_path)
    mstate, marker = locks.marker_state(db_path)
    if not exists:
        if mstate == "valid":
            # the spend authority was deleted: block, never report $0
            raise LedgerUnavailable("attribution authority deleted")
        if mstate == "invalid":
            # a damaged marker with no DB looks like a deleted authority: never mint fresh
            raise LedgerUnavailable("attribution marker invalid")
        if not create:
            raise LedgerUnavailable("attribution ledger missing: %s"
                                    % db_path)
    if exists and _storage_size(db_path) > LEDGER_MAX_BYTES:
        raise LedgerUnavailable("attribution ledger oversize")
    d = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(d, exist_ok=True)
    try:
        con = sqlite3.connect(db_path, timeout=60.0,
                              check_same_thread=False, isolation_level=None)
    except sqlite3.Error as e:
        raise LedgerUnavailable(str(e))
    try:
        con.execute("PRAGMA journal_mode=WAL")
        con.execute("PRAGMA synchronous=FULL")
        try:
            have = {r[0] for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")}
        except (sqlite3.Error, ValueError) as e:
            # unreadable catalog (torn page, bad text): schema unverifiable, deny
            raise LedgerUnavailable("catalog-unreadable:%r" % (e,))
        missing = [t for t in _GATED_TABLES if t not in have]
        if missing and not (
                locks.may_create_tables(have, exists, mstate)
                or (exists and mstate == "absent"
                    and _pristine_locked(con, have))):
            # An established file never regrows tables: a deleted spans/unknown/hold
            # table with a surviving marker or token would recreate empty and reset
            # spend history (the DB itself still verifies). Recreate only on a
            # provable first init or a pristine file (see locks.may_create_tables).
            raise LedgerUnavailable("table-missing:%s" % missing[0])
        if not exists or (mstate == "absent"
                           and _pristine_locked(con, have)):
            # Genuine first init (no file, no marker) or a crash-interrupted one (no
            # marker, no token, no rows): the whole init (schema + version + token)
            # commits in one transaction, so a crash leaves an absent or pristine
            # file, never a half-built authority. The sidecar marker (zeroed
            # roots) publishes after.
            token = locks.fresh_token()
            try:
                con.execute("BEGIN IMMEDIATE")
                try:
                    con.execute(_SPANS_DDL)
                    con.execute(_UNKNOWN_DDL)
                    con.execute(_RECON_DDL)
                    con.execute(_SPEND_HOLDS_DDL)
                    con.execute(_META_DDL)
                    con.execute(_DIGEST_DDL)
                    for _slot in ("spans", "recon", "unknown",
                                  "holds"):
                        con.execute(
                            "INSERT INTO content_digest VALUES "
                            "(?,?,?,?,?)",
                            (_slot, _ZERO_DIGEST, 0, 0, 0))
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
                raise LedgerUnavailable("init:%s" % (e,))
            try:
                locks.write_marker(db_path, token,
                                   roots=dict(_ZERO_ROOTS))
            except (OSError, ValueError) as e:
                raise LedgerUnavailable("marker-write:%s" % (e,))
        else:
            # Established authority: every table is present (the gate above denied
            # otherwise) and no DDL runs here, since a CREATE could mask a deletion.
            # Exception: the digest table on a provably pre-digest ledger, one
            # versioned migration (CREATE + full recompute from truth + version
            # stamp in one idempotent transaction). "Provably" means a pre-digest
            # version and a pre-digest marker shape; a digest-era marker, a
            # digest-bearing version or an unreadable marker with a missing digest
            # table is deletion, and the digest is never rebuilt over it (that
            # would re-baseline authority over possibly modified rows). A version
            # reset alone cannot reach migration; only a coherent rows+digest
            # rewrite could, which is the documented host-scope residual.
            ver0 = con.execute("PRAGMA user_version"
                               ).fetchone()[0]
            if "content_digest" not in have:
                era = _marker_digest_era(db_path)
                if era is not False or ver0 >= SCHEMA_VERSION:
                    raise LedgerUnavailable("digest-deleted")
                try:
                    con.execute("BEGIN IMMEDIATE")
                    try:
                        con.execute(_DIGEST_DDL)
                        for _slot, _sql in (
                                ("spans", "spans"),
                                ("recon", "reconciliations"),
                                ("unknown", "unknown_holds"),
                                ("holds", "spend_holds")):
                            _d, _n, _c = _recompute_table(
                                con, _slot, _sql)
                            _a, _b = (0, 0)
                            if _slot == "spans":
                                _a = _c
                            elif _slot == "holds":
                                _a = con.execute(
                                    "SELECT COUNT(*) FROM "
                                    "spend_holds").fetchone()[0]
                            con.execute(
                                "INSERT OR IGNORE INTO content_digest "
                                "VALUES (?,?,?,?,?)",
                                (_slot, _d, _n, _a, _b))
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
                    raise LedgerUnavailable("digest-backfill:%s"
                                            % (e,))
                try:
                    _mirror_roots_locked(db_path, con)
                except LedgerUnavailable:
                    raise
            elif ver0 < SCHEMA_VERSION:
                # Digest present, version lags: adopt v3 without recomputing (a recompute
                # would bless edits the intact digest still detects). A pre-digest
                # marker shape means a crash between the backfill commit and the
                # mirror, so resume the mirror (it adopts from in-DB truth, which
                # verify still guards). An unreadable marker leaves everything
                # untouched for the strict checks below.
                era = _marker_digest_era(db_path)
                if era is None:
                    pass
                else:
                    if era is False:
                        try:
                            _mirror_roots_locked(db_path, con)
                        except LedgerUnavailable:
                            raise
                    con.execute("PRAGMA user_version=%d" %
                                SCHEMA_VERSION)
            for table, cols in _EXPECTED_COLUMNS.items():
                got = [r[1] for r in con.execute(
                    "PRAGMA table_info(%s)" % table)]
                if got != cols:
                    raise LedgerUnavailable("schema-mismatch:%s"
                                            % table)
            row = con.execute("PRAGMA integrity_check").fetchone()
            if row is None or row[0] != "ok":
                raise LedgerUnavailable("integrity:%r" % (row,))
            ver = con.execute("PRAGMA user_version").fetchone()[0]
            cur = con.execute(
                "SELECT v FROM meta WHERE k='init_token'"
            ).fetchone()
            if ver != SCHEMA_VERSION:
                raise LedgerUnavailable("version:%r" % (ver,))
            if cur is None:
                raise LedgerUnavailable("token-missing")
            if mstate == "invalid":
                raise LedgerUnavailable("marker-invalid")
            if mstate == "absent":
                # a missing trust root over live money denies; the only heal is a
                # token-bearing but empty DB (crash between init commit and marker)
                live = False
                for table in ("spans", "unknown_holds",
                              "reconciliations", "spend_holds"):
                    if con.execute(
                            "SELECT COUNT(*) FROM %s" % table
                            ).fetchone()[0] > 0:
                        live = True
                        break
                if live:
                    raise LedgerUnavailable("marker-deleted")
                locks.write_marker(db_path, cur[0],
                                   roots=dict(_ZERO_ROOTS))
            elif marker != cur[0]:
                raise LedgerUnavailable("token-mismatch")
            try:
                roots = locks.marker_roots(db_path)
            except ValueError:
                raise LedgerUnavailable("marker-roots-corrupt")
            if roots:
                _verify_history_locked(db_path, con, roots)
            else:
                # Pre-roots marker: trust-on-first-use adoption. The live DB verifies
                # (schema + integrity + token above), so baseline its truth once;
                # later opens verify strictly. Deletions before this upgrade are
                # unprovable (documented).
                _mirror_roots_locked(db_path, con)
    except LedgerUnavailable:
        con.close()
        raise
    except (sqlite3.Error, ValueError) as e:
        # ValueError covers undecodable text from torn pages, which is corruption too
        con.close()
        raise LedgerUnavailable(str(e))
    return con


def _db_for(log_path):
    base, _ext = os.path.splitext(log_path)
    return base + ".ledger.sqlite3"


def _check_str(name, value, limit):
    if not isinstance(value, str) or not 0 < len(value) <= limit:
        raise ValueError("bad %s: %r" % (name, value))


def _check_int(name, value, lo, hi):
    if type(value) is not int or not lo <= value <= hi:
        raise ValueError("bad %s: %r" % (name, value))


def _check_usd(value):
    # type-exact (bool is not a number here) and finite: True==1 or an infinite reservation must not move money
    if (type(value) not in (int, float) or
            not math.isfinite(value) or not 0 <= value <= USD_MAX):
        raise ValueError("bad usd: %r" % (value,))


def _span_identity(epoch, cycle_id, stage, symbol, node, model,
                   prompt_tokens, completion_tokens, usd, category,
                   outcome, is_unknown):
    """Canonical span-identity tuple (spans-table column order minus
    span_id/ts). ts is excluded: it is wall-clock metadata, so an identical
    retry one second later is the same attempt. append_span() and
    record_unknown() both compare through here."""
    return (epoch, cycle_id, stage, symbol, node, model,
            prompt_tokens, completion_tokens, usd, category,
            outcome, 1 if is_unknown else 0)


_IDENTITY_COLS = ("research_epoch, cycle_id, stage, symbol, node, "
                  "model, prompt_tokens, completion_tokens, usd, "
                  "category, outcome, is_unknown")


def _span_verdict(con, span_id, identity):
    """One span_id under one payload comparison: absent / identical /
    conflict."""
    got = con.execute("SELECT " + _IDENTITY_COLS + " FROM spans "
                      "WHERE span_id=?", (span_id,)).fetchone()
    if got is None:
        return "absent"
    return "identical" if tuple(got) == identity else "conflict"


def append_span(log_path, epoch, node, model_id, calls=1, tokens=0,
                dollars=0.0, span_id=None, cycle_id="local", stage="r",
                symbol="?", prompt_tokens=0, completion_tokens=0,
                usd=None, category="research", outcome="success",
                ts=None, is_unknown=False):
    """Append one span. The same span_id with an identical payload is an
    idempotent no-op (ledger and mirror converge); the same span_id with a
    different payload raises ValueError. The JSONL mirror is appended only
    when the insert lands; sync_mirror() regenerates it from the ledger.

    Negative/NaN/infinite usd, negative or non-integer token counts,
    over-long identities and off-enum category/outcome raise ValueError
    before touching the ledger. Ambiguous attempts must pass is_unknown=True
    with usd set to the full pre-call reservation (never 0.0).

    Compatibility: tokens= is prompt+completion combined; dollars= is usd.
    Explicit prompt/completion/usd win when given.
    """
    if category not in CATEGORIES:
        raise ValueError("bad category: %r" % category)
    if outcome not in OUTCOMES:
        raise ValueError("bad outcome: %r" % outcome)
    if usd is None:
        usd = dollars
    if prompt_tokens == 0 and completion_tokens == 0 and tokens:
        prompt_tokens = tokens  # legacy combined figure
    _check_usd(usd)
    _check_int("prompt_tokens", prompt_tokens, 0, TOKENS_MAX)
    _check_int("completion_tokens", completion_tokens, 0, TOKENS_MAX)
    _check_int("research_epoch", epoch, 0, EPOCH_MAX)
    _check_str("node", node, IDENT_MAX)
    _check_str("model", model_id, MODEL_MAX)
    _check_str("cycle_id", cycle_id, IDENT_MAX)
    _check_str("stage", stage, STAGE_MAX)
    _check_str("symbol", symbol, IDENT_MAX)
    ts = int(time.time()) if ts is None else ts
    _check_int("ts", ts, 0, 2 ** 63 - 1)
    if span_id is None:
        span_id = "adhoc-%d-%s-%s-%d" % (epoch, node, model_id, ts)
    _check_str("span_id", span_id, SPAN_ID_MAX)
    if is_unknown and not usd > 0:
        # an ambiguous attempt at $0 would bless a possibly-billed call as free;
        # the gate always passes the full reservation
        raise ValueError("unknown spend without reserved usd")
    row = {"ts": ts, "research_epoch": epoch, "cycle_id": cycle_id,
           "stage": stage, "symbol": symbol, "node": node,
           "model": model_id, "prompt_tokens": prompt_tokens,
           "completion_tokens": completion_tokens, "usd": usd,
           "category": category, "outcome": outcome, "span_id": span_id,
           "is_unknown": bool(is_unknown),
           "calls": calls, "tokens": prompt_tokens + completion_tokens,
           "dollars": usd, "model_id": model_id}
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        # create=True mints the ledger only for a new path (no DB, no marker); a
        # deleted authority raises above and blocks
        con = _connect(db_path, create=True)
        try:
            identity = _span_identity(
                epoch, cycle_id, stage, symbol, node, model_id,
                prompt_tokens, completion_tokens, usd, category,
                outcome, is_unknown)
            verdict = _span_verdict(con, span_id, identity)
            if verdict == "conflict":
                raise ValueError("span-conflict: %s" % span_id)
            if verdict == "identical":
                inserted = False
            else:
                # row + digest commit atomically (see _dig_apply)
                con.execute("BEGIN IMMEDIATE")
                try:
                    try:
                        con.execute(
                            "INSERT INTO spans (span_id, ts, "
                            "research_epoch, cycle_id, stage, symbol, "
                            "node, model, prompt_tokens, "
                            "completion_tokens, usd, category, "
                            "outcome, is_unknown) "
                            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                            (span_id, ts) + identity)
                        inserted = True
                    except sqlite3.IntegrityError:
                        # lost a same-id race: re-read and decide, the winner may disagree
                        verdict = _span_verdict(con, span_id,
                                              identity)
                        if verdict == "conflict":
                            raise ValueError("span-conflict: %s"
                                             % span_id)
                        inserted = verdict == "absent"
                    if inserted:
                        _dig_apply(
                            con, "spans", "spans",
                            ins=[[span_id, ts] + list(identity)],
                            dn=1, da=_cents(usd))
                    con.execute("COMMIT")
                except BaseException:
                    try:
                        con.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                    raise
            # marker mirror from in-DB truth (same lock)
            _mirror_roots_locked(db_path, con)
        finally:
            con.close()
        if inserted:
            try:
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row, sort_keys=True) + "\n")
                    fh.flush()
                    os.fsync(fh.fileno())
            except OSError:
                pass  # ledger is authoritative; the mirror self-heals
                # hourly via prune_spans -> sync_mirror
    return row


def record_unknown(log_path, lease_id, span_id, usd, outcome, epoch,
                   node, model_id, cycle_id, symbol, ts=None):
    """One atomic ambiguity record: the unknown span (full reserved usd,
    is_unknown=1) + the unknown_holds row + the spend hold moved to invoked
    with its span_id, in one transaction. A crash leaves nothing (hold still
    reserved, reaped only if pre-spawn) or everything (recoverable via
    reconcile); never a partial ambiguity. The spend hold must already exist
    (reserved pre-spawn); a missing hold is an ordering defect. Raises
    SpendBlocked on any accounting defect (the caller keeps the hold and
    aborts)."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    _check_str("span_id", span_id, SPAN_ID_MAX)
    _check_usd(usd)
    if not usd > 0:
        raise ValueError("unknown spend without reserved usd")
    if outcome not in OUTCOMES:
        raise ValueError("bad outcome: %r" % outcome)
    _check_int("research_epoch", epoch, 0, EPOCH_MAX)
    _check_str("node", node, IDENT_MAX)
    _check_str("model", model_id, MODEL_MAX)
    _check_str("cycle_id", cycle_id, IDENT_MAX)
    _check_str("symbol", symbol, IDENT_MAX)
    ts = int(time.time()) if ts is None else ts
    _check_int("ts", ts, 0, 2 ** 63 - 1)
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        try:
            con = _connect(db_path)
        except LedgerUnavailable as e:
            raise SpendBlocked("spend-unmeasurable:%s" % e)
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                have = con.execute(
                    "SELECT usd, state FROM spend_holds WHERE "
                    "lease_id=?", (lease_id,)).fetchone()
                if have is None:
                    raise SpendBlocked("unknown-lease-no-hold:%s" %
                                       lease_id)
                if have[0] != usd:
                    # the hold is the reservation: converting a different amount would mint or erase dollars
                    raise SpendBlocked("unknown-hold-usd-mismatch:%s"
                                       % lease_id)
                if have[1] not in ("reserved", "invoked"):
                    raise SpendBlocked("unknown-hold-state:%s" %
                                       lease_id)
                identity = _span_identity(
                    epoch, cycle_id, "r", symbol, node, model_id,
                    0, 0, usd, "research", outcome, True)
                verdict = _span_verdict(con, span_id, identity)
                if verdict == "conflict":
                    raise SpendBlocked("span-conflict:%s" % span_id)
                if verdict == "absent":
                    # column order is load-bearing: stage='r' belongs to STAGE, the symbol to SYMBOL
                    cur = con.execute(
                        "INSERT INTO spans (span_id, ts, "
                        "research_epoch, cycle_id, stage, symbol, "
                        "node, model, prompt_tokens, "
                        "completion_tokens, usd, category, outcome, "
                        "is_unknown) VALUES "
                        "(?,?,?,?, 'r', ?,?,?,?,?,?,'research',?,1)",
                        (span_id, ts, epoch, cycle_id, symbol, node,
                         model_id, 0, 0, usd, outcome))
                    if cur.rowcount != 1:
                        raise SpendBlocked("span-insert:%s" % span_id)
                    _dig_apply(
                        con, "spans", "spans",
                        ins=[[span_id, ts, epoch, cycle_id, "r",
                              symbol, node, model_id, 0, 0, usd,
                              "research", outcome, 1]],
                        dn=1, da=_cents(usd))
                uh = con.execute(
                    "SELECT span_id, usd FROM unknown_holds WHERE "
                    "lease_id=?", (lease_id,)).fetchone()
                if uh is not None:
                    # as for spans: an identical retry is idempotent, a conflicting payload fails
                    if uh != (span_id, usd):
                        raise SpendBlocked(
                            "unknown-hold-conflict:%s" % lease_id)
                else:
                    cur = con.execute(
                        "INSERT INTO unknown_holds VALUES (?,?,?,?,0)",
                        (lease_id, span_id, usd, ts))
                    if cur.rowcount != 1:
                        raise SpendBlocked(
                            "unknown-hold-insert:%s" % lease_id)
                    _dig_apply(con, "unknown", "unknown_holds",
                               ins=[[lease_id, span_id, usd, ts, 0]],
                               dn=1)
                old_hold = con.execute(
                    "SELECT lease_id, usd, state, ts, span_id FROM "
                    "spend_holds WHERE lease_id=?",
                    (lease_id,)).fetchone()
                cur = con.execute(
                    "UPDATE spend_holds SET state='invoked', "
                    "span_id=? WHERE lease_id=?",
                    (span_id, lease_id))
                if cur.rowcount != 1:
                    raise SpendBlocked(
                        "unknown-hold-transition:%s" % lease_id)
                _dig_apply(con, "holds", "spend_holds",
                           outs=[list(old_hold)],
                           ins=[[lease_id, usd, "invoked",
                                 old_hold[3], span_id]])
                con.execute("COMMIT")
                _mirror_roots_locked(db_path, con)
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


def has_unreconciled(log_path):
    """True when an ambiguous charge is outstanding: an unreconciled unknown
    row, or any positive-dollar spend hold in state='invoked' (crash
    backstop). Zero-dollar invoked holds never block. A missing ledger raises
    (unmeasurable blocks); only a genuine fresh path reports False."""
    db_path = _db_for(log_path)
    con = _connect(db_path)
    try:
        unk = con.execute("SELECT COUNT(*) FROM unknown_holds WHERE "
                          "reconciled=0").fetchone()[0]
        inv = con.execute("SELECT COALESCE(SUM(usd),0) FROM "
                          "spend_holds WHERE state='invoked' AND "
                          "usd > 0").fetchone()[0]
    finally:
        con.close()
    return bool(unk or inv > 0)


def reserve_spend_hold(log_path, lease_id, usd, cap_usd, now=None):
    """Pre-call USD authorization: one transaction under the spend lock that
    reaps expired reserved holds, refuses when unknowns are pending, measures
    (30d committed + outstanding holds), compares against the cap, inserts
    the hold and commits. The provider may be spawned only after this
    returns. Raises SpendBlocked (refusal) or LedgerUnavailable
    (unmeasurable). Callers must not repeat the read/compare/insert
    elsewhere."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    _check_usd(usd)
    if (type(cap_usd) not in (int, float) or
            not math.isfinite(cap_usd) or cap_usd < 0):
        raise SpendBlocked("bad cap: %r" % (cap_usd,))
    now = int(time.time()) if now is None else now
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        try:
            con = _connect(db_path, create=True)
        except LedgerUnavailable as e:
            raise SpendBlocked("spend-unmeasurable:%s" % e)
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                reaped_rows = con.execute(
                    "SELECT lease_id, usd, state, ts, span_id FROM "
                    "spend_holds WHERE state='reserved' AND ts < ?",
                    (now - HOLD_TTL_S,)).fetchall()
                reaped = con.execute(
                    "DELETE FROM spend_holds WHERE "
                    "state='reserved' AND ts < ?",
                    (now - HOLD_TTL_S,)).rowcount or 0
                if reaped_rows:
                    _dig_apply(con, "holds", "spend_holds",
                               outs=[list(r) for r in reaped_rows],
                               dn=-len(reaped_rows), db=reaped)
                unk = con.execute(
                    "SELECT COUNT(*) FROM unknown_holds WHERE "
                    "reconciled=0").fetchone()[0]
                inv = con.execute(
                    "SELECT COALESCE(SUM(usd),0) FROM spend_holds "
                    "WHERE state='invoked' AND usd > 0").fetchone()[0]
                if unk or inv > 0:
                    raise SpendBlocked("unknown-spend-pending")
                spent = con.execute(
                    "SELECT COALESCE(SUM(usd),0) FROM spans WHERE "
                    "ts >= ?", (now - 30 * 86400,)).fetchone()[0]
                holds = con.execute(
                    "SELECT COALESCE(SUM(usd),0) FROM "
                    "spend_holds").fetchone()[0]
                if spent + holds + usd > cap_usd:
                    raise SpendBlocked(
                        "stage-cap: %.2f+%.2f>%.2f" %
                        (spent + holds, usd, cap_usd))
                try:
                    con.execute("INSERT INTO spend_holds VALUES "
                                "(?,?,?,?,NULL)",
                                (lease_id, usd, "reserved", now))
                except sqlite3.IntegrityError:
                    raise SpendBlocked("duplicate-hold:%s" % lease_id)
                _dig_apply(con, "holds", "spend_holds",
                           ins=[[lease_id, usd, "reserved", now,
                                 None]],
                           dn=1, da=1)
                con.execute("COMMIT")
                _mirror_roots_locked(db_path, con)
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


def reconcile_unknown(log_path, lease_id, actual_usd, note=""):
    """Supervisor reconciliation of an ambiguous charge: replace the
    conservative reservation with the attested actual, clear the block and
    journal the adjustment. actual_usd must be finite, non-negative and not
    above the reservation; note is recorded verbatim (bounded).

    Recovers from every point of the ambiguity path: complete unknown rows
    (normal); an invoked hold with no unknown rows (a synthetic unknown span
    is created from the hold first, then the unknown row, the span settlement
    and the hold deletion, all rowcount-verified); an error when nothing was
    ever recorded (typo safety), never a silent no-op."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    _check_usd(actual_usd)
    if not isinstance(note, str) or len(note) > 256:
        raise ValueError("bad note")
    import time as _t
    now = int(_t.time())
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                hold = con.execute(
                    "SELECT span_id, usd, reconciled FROM unknown_holds"
                    " WHERE lease_id=?", (lease_id,)).fetchone()
                if hold is not None and hold[2]:
                    raise LedgerUnavailable("already reconciled: %s"
                                            % lease_id)
                if hold is not None:
                    span_id, old_usd = hold[0], hold[1]
                    tag = note
                else:
                    # crash between the invoked mark and the atomic unknown record (or a
                    # partial legacy path): recover from the hold, which counted the dollars
                    inv = con.execute(
                        "SELECT usd, span_id FROM spend_holds WHERE "
                        "lease_id=? AND state='invoked'",
                        (lease_id,)).fetchone()
                    if inv is None:
                        # an orphan unknown span with no rows cannot be attributed to a lease
                        # (spans carry no lease link): error. Orphan spans do not block; only
                        # unknown rows and invoked holds do.
                        raise LedgerUnavailable("unknown lease: %s"
                                                % lease_id)
                    old_usd = inv[0]
                    if actual_usd > old_usd:
                        # the reservation is the worst case, so a bill above it is a defect;
                        # reject before mutating (rollback keeps the hold blocking)
                        raise LedgerUnavailable(
                            "reconcile-over-reservation:%s" % lease_id)
                    span_id = inv[1]
                    if span_id is None:
                        # hold-only recovery: no span was written for this attempt, so mint a
                        # marked synthetic unknown span from the reservation first
                        span_id = ("recovered-%s" %
                                   hashlib.sha256(
                                       lease_id.encode("utf-8"),
                                       usedforsecurity=False
                                   ).hexdigest()[:48])
                        cur = con.execute(
                            "INSERT INTO spans (span_id, ts, "
                            "research_epoch, cycle_id, stage, "
                            "symbol, node, model, prompt_tokens, "
                            "completion_tokens, usd, category, "
                            "outcome, is_unknown) VALUES "
                            "(?,?,0,'recovered','r','?',"
                            "'reconcile','unknown',0,0,?,"
                            "'research','error',1)",
                            (span_id, now, old_usd))
                        if cur.rowcount != 1:
                            raise LedgerUnavailable(
                                "reconcile-span-mint:%s" % lease_id)
                        _dig_apply(
                            con, "spans", "spans",
                            ins=[[span_id, now, 0, "recovered", "r",
                                  "?", "reconcile", "unknown", 0,
                                  0, old_usd, "research", "error",
                                  1]],
                            dn=1, da=_cents(old_usd))
                    else:
                        got = con.execute(
                            "SELECT is_unknown FROM spans WHERE "
                            "span_id=?", (span_id,)).fetchone()
                        if got is None:
                            cur = con.execute(
                                "INSERT INTO spans (span_id, ts, "
                                "research_epoch, cycle_id, stage, "
                                "symbol, node, model, "
                                "prompt_tokens, completion_tokens, "
                                "usd, category, outcome, is_unknown)"
                                " VALUES (?,?,0,'recovered','r','?',"
                                "'reconcile','unknown',0,0,?,"
                                "'research','error',1)",
                                (span_id, now, old_usd))
                            if cur.rowcount != 1:
                                raise LedgerUnavailable(
                                    "reconcile-span-mint:%s" % lease_id)
                            _dig_apply(
                                con, "spans", "spans",
                                ins=[[span_id, now, 0, "recovered",
                                      "r", "?", "reconcile",
                                      "unknown", 0, 0, old_usd,
                                      "research", "error", 1]],
                                dn=1, da=_cents(old_usd))
                        elif got[0] != 1:
                            # a settled span re-entering reconcile is an ordering defect
                            raise LedgerUnavailable(
                                "reconcile-span-not-unknown:%s"
                                % lease_id)
                    try:
                        con.execute(
                            "INSERT INTO unknown_holds VALUES "
                            "(?,?,?,?,0)",
                            (lease_id, span_id, old_usd, now))
                    except sqlite3.IntegrityError:
                        raise LedgerUnavailable(
                            "reconcile-unknown-row-race:%s" % lease_id)
                    _dig_apply(con, "unknown", "unknown_holds",
                               ins=[[lease_id, span_id, old_usd, now,
                                     0]],
                               dn=1)
                    tag = (note + ":recovered" if note
                           else "recovered")
                if hold is not None:
                    if actual_usd > old_usd:
                        raise LedgerUnavailable(
                            "reconcile-over-reservation:%s" % lease_id)
                old_span = None
                if span_id is not None:
                    old_span = con.execute(
                        "SELECT span_id, ts, research_epoch, cycle_id, "
                        "stage, symbol, node, model, prompt_tokens, "
                        "completion_tokens, usd, category, outcome, "
                        "is_unknown FROM spans WHERE span_id=? AND "
                        "is_unknown=1", (span_id,)).fetchone()
                    cur = con.execute(
                        "UPDATE spans SET usd=?, is_unknown=0 "
                        "WHERE span_id=? AND is_unknown=1",
                        (actual_usd, span_id))
                    if cur.rowcount != 1:
                        # complete path with no unknown span, or a span that is not unknown: the
                        # evidence does not match the claim; abort, hold kept
                        raise LedgerUnavailable(
                            "reconcile-span-missing:%s" % lease_id)
                    new_span = list(old_span)
                    new_span[10] = actual_usd
                    new_span[13] = 0
                    _dig_apply(con, "spans", "spans",
                               outs=[list(old_span)], ins=[new_span],
                               da=_cents(actual_usd) - _cents(
                                   old_span[10]))
                old_uh = con.execute(
                    "SELECT lease_id, span_id, usd, ts, reconciled "
                    "FROM unknown_holds WHERE lease_id=?",
                    (lease_id,)).fetchone()
                con.execute("UPDATE unknown_holds SET reconciled=1 "
                            "WHERE lease_id=?", (lease_id,))
                _dig_apply(con, "unknown", "unknown_holds",
                           outs=[list(old_uh)],
                           ins=[[lease_id, old_uh[1], old_uh[2],
                                 old_uh[3], 1]])
                con.execute(
                    "INSERT INTO reconciliations VALUES (?,?,?,?,?)",
                    (lease_id, old_usd, actual_usd, now, tag))
                _dig_apply(con, "recon", "reconciliations",
                           ins=[[lease_id, old_usd, actual_usd, now,
                                 tag]],
                           dn=1)
                old_hold = con.execute(
                    "SELECT lease_id, usd, state, ts, span_id FROM "
                    "spend_holds WHERE lease_id=?",
                    (lease_id,)).fetchone()
                cur = con.execute(
                    "DELETE FROM spend_holds WHERE lease_id=?",
                    (lease_id,))
                closed_holds = cur.rowcount or 0
                if old_hold is not None:
                    _dig_apply(con, "holds", "spend_holds",
                               outs=[list(old_hold)], dn=-1,
                               db=closed_holds)
                con.execute("COMMIT")
                _mirror_roots_locked(db_path, con)
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


# pre-call spend holds (absolute-cap enforcement)

HOLD_TTL_S = 600  # a pre-spawn crash releases; post-spawn stays


def hold_spend(log_path, lease_id, usd, now=None):
    """Reserve worst-case dollars before the provider may be touched.
    state=reserved: reap_holds() may release it after HOLD_TTL_S (a crash
    before spawn never billed)."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    _check_usd(usd)
    now = int(time.time()) if now is None else now
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path, create=True)
        try:
            con.execute("BEGIN IMMEDIATE")
            try:
                con.execute("INSERT INTO spend_holds VALUES "
                            "(?,?,?,?,NULL)",
                            (lease_id, usd, "reserved", now))
                _dig_apply(con, "holds", "spend_holds",
                           ins=[[lease_id, usd, "reserved", now,
                                 None]],
                           dn=1, da=1)
                con.execute("COMMIT")
                _mirror_roots_locked(db_path, con)
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


def mark_invoked(log_path, lease_id):
    """The child process started: this hold may have been billed and never
    auto-releases. Only settle_hold()/reconcile_unknown() clear it."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            # row + digest commit atomically (see _dig_apply)
            con.execute("BEGIN IMMEDIATE")
            try:
                old_hold = con.execute(
                    "SELECT lease_id, usd, state, ts, span_id FROM "
                    "spend_holds WHERE lease_id=? AND "
                    "state='reserved'",
                    (lease_id,)).fetchone()
                cur = con.execute(
                    "UPDATE spend_holds SET state='invoked'"
                    " WHERE lease_id=? AND state='reserved'",
                    (lease_id,))
                if cur.rowcount != 1:
                    # no reserved hold: a missing or already-invoked hold is an ordering
                    # defect (an unmarked post-spawn hold could auto-release)
                    raise LedgerUnavailable("mark-invoked-no-hold:%s"
                                            % lease_id)
                _dig_apply(con, "holds", "spend_holds",
                           outs=[list(old_hold)],
                           ins=[[lease_id, old_hold[1], "invoked",
                                 old_hold[3], old_hold[4]]])
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            _mirror_roots_locked(db_path, con)
        finally:
            con.close()


def settle_hold(log_path, lease_id):
    """A cleanly accounted call releases its hold (the span carries the
    actual). A missing hold is a no-op (already settled or pre-hold failure)."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            # row + digest commit atomically (see _dig_apply)
            con.execute("BEGIN IMMEDIATE")
            try:
                old_hold = con.execute(
                    "SELECT lease_id, usd, state, ts, span_id FROM "
                    "spend_holds WHERE lease_id=?",
                    (lease_id,)).fetchone()
                closed = con.execute(
                    "DELETE FROM spend_holds WHERE lease_id=?",
                    (lease_id,)).rowcount or 0
                if old_hold is not None:
                    _dig_apply(con, "holds", "spend_holds",
                               outs=[list(old_hold)], dn=-1,
                               db=closed)
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            _mirror_roots_locked(db_path, con)
        finally:
            con.close()


def reap_holds(log_path, now=None):
    """Release pre-spawn-crash holds (state=reserved, older than HOLD_TTL_S).
    Invoked holds are never reaped: a timed-out or crashed post-spawn attempt
    may have been billed."""
    now = int(time.time()) if now is None else now
    db_path = _db_for(log_path)
    mstate, _tok = locks.marker_state(db_path)
    if not os.path.exists(db_path) and mstate == "absent":
        return  # genuinely new path: nothing to reap
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            # rows + digest commit atomically (see _dig_apply)
            con.execute("BEGIN IMMEDIATE")
            try:
                reaped_rows = con.execute(
                    "SELECT lease_id, usd, state, ts, span_id FROM "
                    "spend_holds WHERE state='reserved' AND ts < ?",
                    (now - HOLD_TTL_S,)).fetchall()
                closed = con.execute(
                    "DELETE FROM spend_holds WHERE state='reserved'"
                    " AND ts < ?", (now - HOLD_TTL_S,)).rowcount or 0
                if reaped_rows:
                    _dig_apply(con, "holds", "spend_holds",
                               outs=[list(r) for r in reaped_rows],
                               dn=-len(reaped_rows), db=closed)
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            _mirror_roots_locked(db_path, con)
        finally:
            con.close()


def outstanding_holds(log_path):
    """Sum of held (not yet settled) dollars. Unmeasurable raises."""
    db_path = _db_for(log_path)
    con = _connect(db_path)
    try:
        row = con.execute(
            "SELECT COALESCE(SUM(usd),0) FROM spend_holds").fetchone()
    finally:
        con.close()
    return row[0]


def prune_spans(log_path, now=None):
    """Bounded storage: drop spans (and settled holds) older than
    SPAN_RETAIN_DAYS, then checkpoint/vacuum when over bound. Also heals the
    JSONL mirror from the ledger (best-effort; a mirror failure never fails
    the prune). Runs hourly through the tier evaluator."""
    now = int(time.time()) if now is None else now
    cutoff = now - SPAN_RETAIN_DAYS * 86400
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            # rows + digest commit atomically (see _dig_apply)
            con.execute("BEGIN IMMEDIATE")
            try:
                gone_spans = con.execute(
                    "SELECT span_id, ts, research_epoch, cycle_id, "
                    "stage, symbol, node, model, prompt_tokens, "
                    "completion_tokens, usd, category, outcome, "
                    "is_unknown FROM spans WHERE ts < ?",
                    (cutoff,)).fetchall()
                gone_recon = con.execute(
                    "SELECT lease_id, old_usd, new_usd, ts, note FROM "
                    "reconciliations WHERE ts < ?",
                    (cutoff,)).fetchall()
                con.execute("DELETE FROM spans WHERE ts < ?",
                            (cutoff,))
                con.execute("DELETE FROM reconciliations WHERE ts < ?",
                            (cutoff,))
                if gone_spans:
                    _dig_apply(con, "spans", "spans",
                               outs=[list(r) for r in gone_spans],
                               dn=-len(gone_spans),
                               da=-sum(_cents(r[10]) for r in
                                       gone_spans))
                if gone_recon:
                    _dig_apply(con, "recon", "reconciliations",
                               outs=[list(r) for r in gone_recon],
                               dn=-len(gone_recon))
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            _mirror_roots_locked(db_path, con)
        finally:
            con.close()
    try:
        sync_mirror(log_path)
    except (OSError, LedgerUnavailable, ValueError):
        pass
    if _storage_size(db_path) > LEDGER_MAX_BYTES:
        try:
            con = sqlite3.connect(db_path, timeout=60.0,
                                  check_same_thread=False,
                                  isolation_level=None)
            try:
                con.execute("VACUUM")
            finally:
                con.close()
        except sqlite3.Error:
            pass


def sync_mirror(log_path):
    """Regenerate the JSONL mirror from the ledger atomically (temp +
    replace). The ledger is capped at LEDGER_MAX_BYTES with 120-day
    retention, so the materialized rows are bounded. Runs hourly via
    prune_spans; best-effort."""
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        try:
            con = _connect(db_path)
        except LedgerUnavailable:
            return False
        try:
            rows = con.execute(
                "SELECT ts, research_epoch, cycle_id, stage, symbol, "
                "node, model, prompt_tokens, completion_tokens, usd, "
                "category, outcome, is_unknown, span_id FROM spans "
                "ORDER BY ts, span_id").fetchall()
        finally:
            con.close()
    keys = ("ts", "research_epoch", "cycle_id", "stage", "symbol",
            "node", "model", "prompt_tokens", "completion_tokens",
            "usd", "category", "outcome", "is_unknown", "span_id")
    lines = []
    for r in rows:
        d = dict(zip(keys, r))
        d["calls"] = 1
        d["tokens"] = d["prompt_tokens"] + d["completion_tokens"]
        d["dollars"] = d["usd"]
        d["model_id"] = d["model"]
        lines.append(json.dumps(d, sort_keys=True))
    d = os.path.dirname(os.path.abspath(log_path))
    os.makedirs(d, exist_ok=True)
    locks.atomic_write_bytes(d, os.path.basename(log_path),
                             ("\n".join(lines) + "\n" if lines
                              else "").encode("utf-8"))
    return True


def day_summary(log_path, day_ts=None):
    """Aggregate the ledger for the UTC day containing day_ts. A
    missing/corrupt ledger raises LedgerUnavailable, never zero spend."""
    if day_ts is None:
        day_ts = int(time.time())
    day = day_ts - (day_ts % 86400)
    out = {"calls": 0, "tokens": 0, "prompt_tokens": 0,
           "completion_tokens": 0, "dollars": 0.0, "by_node": {},
           "by_model": {}, "by_outcome": {}, "spend_30d": 0.0}
    db_path = _db_for(log_path)
    con = _connect(db_path)
    try:
        rows = con.execute(
            "SELECT node, model, outcome, prompt_tokens, "
            "completion_tokens, usd FROM spans WHERE ts >= ? AND ts < ?",
            (day, day + 86400)).fetchall()
    finally:
        con.close()
    for node, model, outcome, pt, ct, usd in rows:
        out["calls"] += 1
        out["tokens"] += pt + ct
        out["prompt_tokens"] += pt
        out["completion_tokens"] += ct
        out["dollars"] += usd
        out["by_node"][node] = out["by_node"].get(node, 0) + 1
        out["by_model"][model] = out["by_model"].get(model, 0.0) + usd
        out["by_outcome"][outcome] = out["by_outcome"].get(outcome, 0) + 1
    out["spend_30d"] = out["dollars"] * 30
    return out


def spend_since(log_path, since_ts):
    """Total usd recorded at/after since_ts. Raises when the ledger is
    unavailable. Unknown spans count at their full reserved usd."""
    db_path = _db_for(log_path)
    con = _connect(db_path)
    try:
        row = con.execute("SELECT COALESCE(SUM(usd),0) FROM spans "
                          "WHERE ts >= ?", (since_ts,)).fetchone()
    finally:
        con.close()
    return row[0]
