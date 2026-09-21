"""D9 spend/token attribution ledger (doc 08 sec. 8.2 + doc 10 sec. 10.4).

Exactly one durable row per ACTUAL model invocation — written by the
parent-side gate (workers.run_gated) that also reserves R15 budget,
never by graph-level counting.

Durability: SQLite is AUTHORITATIVE (UNIQUE(span_id) gives atomic
exactly-once under concurrent processes — no check-then-act race).
The JSONL mirror beside it is a best-effort Langfuse tail: it is
appended ONLY when the ledger actually inserts (rowcount == 1), so
retries never duplicate the mirror; sync_mirror() regenerates it
atomically (temp + replace) from the ledger.

Row schema (frozen doc-10 spend taxonomy + outcome + unknown flag):
  ts, research_epoch, cycle_id, stage, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category, outcome,
  is_unknown, span_id.
category is the FROZEN doc-10 set {decision, research, experiment,
observability}; error/timeout/blocked live in `outcome`
{success, error, timeout, blocked} — a separate dimension, never a
category replacement. is_unknown=1 marks an AMBIGUOUS attempt (may
have been billed): its usd is the full pre-call reservation (never
$0 — an ambiguous billed attempt recorded as $0 would bless an
unbounded charge), and it blocks future spend until a supervisor
reconciles it (reconcile_unknown). usd is caller-supplied from the
deployment pricing table; 0.0 on a success row means a zero-price
model, never "unpriced" — unpriced models never run.

Spend authorization is ONE atomic transaction (reserve_spend_hold):
reap-expired + unknown/invoked block check + committed measurement +
cap compare + hold insert happen under the same lock inside a single
BEGIN IMMEDIATE. There is no second non-atomic cap check anywhere.
Any positive-dollar spend_holds row in state='invoked' counts as
unresolved unknown spend (crash backstop: an invoked hold without
its unknown rows still blocks). Ambiguous attempts are recorded by
record_unknown() in ONE transaction (span + unknown row + invoked
mark); reconcile_unknown() recovers from a crash at any point of
that path.

Duplicate span identity is STRICT: same span_id + identical payload
is an idempotent no-op; same span_id + different payload is a hard
conflict (never silently INSERT OR IGNORE'd away).

Authoritative-row hardening: every numeric/string field is validated
in Python AND constrained in DDL (CHECK(usd=usd) rejects NaN,
usd >= 0 rejects negatives, token bounds, string length bounds,
category/outcome enums). PRAGMA user_version is pinned and
PRAGMA integrity_check is READ (a non-"ok" result aborts, not
ignored). Missing/corrupt ledger is LedgerUnavailable, NEVER zero
spend — except a GENUINELY NEW path (no DB and no init marker),
which mints fresh. Marker-without-DB aborts (authority-deleted).
Storage (main+wal+shm) is bounded with checkpoint/vacuum reclaim.

Retained low-level primitives (audited, live-tested, no undead
code): hold_spend/mark_invoked/settle_hold/reap_holds are the
crash-state constructors the recovery tests build ambiguous states
from (production authorization goes ONLY through the atomic
reserve_spend_hold above); day_summary/sync_mirror/committed_spend
are the read-only supervisor/audit surfaces. Each is covered by a
live regression, not kept for convenience.
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

SCHEMA_VERSION = 2
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
}


class LedgerUnavailable(Exception):
    pass


class SpendBlocked(Exception):
    """Authoritative spend refusal from inside the ledger
    transaction (cap crossed, unknowns pending, unmeasurable). The
    governor converts this to SpendRefused; it is never a crash."""
    pass


def _storage_size(path):
    total = 0
    for suffix in ("", "-wal", "-shm"):
        try:
            total += os.path.getsize(path + suffix)
        except OSError:
            pass
    return total


def _connect(db_path, create=False):
    exists = os.path.exists(db_path)
    mstate, marker = locks.marker_state(db_path)
    if not exists:
        if mstate == "valid":
            # The spend authority was deleted. A missing ledger must
            # block, never report $0 — recreating fresh would too.
            raise LedgerUnavailable("attribution authority deleted")
        if mstate == "invalid":
            # A damaged marker with no DB is indistinguishable from a
            # deleted authority: fail closed, never mint fresh.
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
        con.execute(_SPANS_DDL)
        con.execute(_UNKNOWN_DDL)
        con.execute(_RECON_DDL)
        con.execute(_SPEND_HOLDS_DDL)
        con.execute(_META_DDL)
        for table, cols in _EXPECTED_COLUMNS.items():
            got = [r[1] for r in con.execute(
                "PRAGMA table_info(%s)" % table)]
            if got != cols:
                raise LedgerUnavailable("schema-mismatch:%s" % table)
        row = con.execute("PRAGMA integrity_check").fetchone()
        if row is None or row[0] != "ok":
            raise LedgerUnavailable("integrity:%r" % (row,))
        ver = con.execute("PRAGMA user_version").fetchone()[0]
        cur = con.execute(
            "SELECT v FROM meta WHERE k='init_token'").fetchone()
        if not exists and mstate == "absent":
            token = locks.fresh_token()
            con.execute("PRAGMA user_version=%d" % SCHEMA_VERSION)
            con.execute("INSERT INTO meta VALUES ('init_token',?)",
                        (token,))
            locks.write_marker(db_path, token)
        else:
            if ver != SCHEMA_VERSION:
                raise LedgerUnavailable("version:%r" % (ver,))
            if cur is None:
                raise LedgerUnavailable("token-missing")
            if mstate == "invalid":
                # The DB verifies but its authority token cannot be
                # confirmed: not healed blindly, abort.
                raise LedgerUnavailable("marker-invalid")
            if mstate == "absent":
                # Heal ONLY here: the DB verified (schema +
                # integrity above) and carries a valid token.
                locks.write_marker(db_path, cur[0])
            elif marker != cur[0]:
                raise LedgerUnavailable("token-mismatch")
    except LedgerUnavailable:
        con.close()
        raise
    except sqlite3.Error as e:
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
    # Type-exact (bool is NOT a number here) and finite: neither a
    # True==1 discount nor an infinite reservation may move money.
    if (type(value) not in (int, float) or
            not math.isfinite(value) or not 0 <= value <= USD_MAX):
        raise ValueError("bad usd: %r" % (value,))


def append_span(log_path, epoch, node, model_id, calls=1, tokens=0,
                dollars=0.0, span_id=None, cycle_id="local", stage="r",
                symbol="?", prompt_tokens=0, completion_tokens=0,
                usd=None, category="research", outcome="success",
                ts=None, is_unknown=False):
    """Append one span. Duplicate span identity is STRICT: the same
    span_id with an IDENTICAL payload is an idempotent no-op (ledger
    and mirror both converge); the same span_id with a DIFFERENT
    payload is a hard ValueError conflict — conflicting spend data is
    never silently INSERT OR IGNORE'd away. The JSONL mirror is
    appended ONLY when the insert actually lands, so retries never
    duplicate the mirror; sync_mirror() regenerates it from the
    ledger.

    Authoritative validation: negative/NaN/infinite usd, negative or
    non-integer token counts, over-long identities, and off-enum
    category/outcome are ValueErrors BEFORE the ledger — a direct
    caller cannot reduce spend or poison arithmetic. Ambiguous
    attempts MUST pass is_unknown=True with usd set to the full
    pre-call reservation (never 0.0).

    Compatibility: tokens= prompt+completion combined; dollars= usd.
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
        # An ambiguous attempt recorded as $0 would bless a possibly-
        # billed call as free. The gate always passes the full
        # reservation here.
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
        # create=True mints the ledger ONLY for a genuinely new path
        # (no DB and no marker); a deleted authority raises above and
        # blocks instead of resetting spend to zero.
        con = _connect(db_path, create=True)
        try:
            payload = (ts, epoch, cycle_id, stage, symbol, node,
                       model_id, prompt_tokens, completion_tokens,
                       usd, category, outcome, 1 if is_unknown else 0)
            got = con.execute(
                "SELECT ts, research_epoch, cycle_id, stage, symbol, "
                "node, model, prompt_tokens, completion_tokens, usd, "
                "category, outcome, is_unknown FROM spans WHERE "
                "span_id=?", (span_id,)).fetchone()
            if got is not None:
                if tuple(got) != payload:
                    raise ValueError("span-conflict: %s" % span_id)
                inserted = False
            else:
                try:
                    con.execute(
                        "INSERT INTO spans (span_id, ts, "
                        "research_epoch, cycle_id, stage, symbol, node, "
                        "model, prompt_tokens, completion_tokens, usd, "
                        "category, outcome, is_unknown) "
                        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (span_id,) + payload)
                except sqlite3.IntegrityError:
                    # Lost a same-id race: re-read and decide (never
                    # blind-ignore — the winner may disagree).
                    got = con.execute(
                        "SELECT ts, research_epoch, cycle_id, stage, "
                        "symbol, node, model, prompt_tokens, "
                        "completion_tokens, usd, category, outcome, "
                        "is_unknown FROM spans WHERE span_id=?",
                        (span_id,)).fetchone()
                    if got is None or tuple(got) != payload:
                        raise ValueError("span-conflict: %s" % span_id)
                inserted = True
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
    """ONE atomic ambiguity record: the unknown span (full reserved
    usd, is_unknown=1) + the unknown_holds row + the spend hold moved
    to invoked with its span_id — all in a single transaction. A crash
    can therefore leave either NOTHING (hold still reserved: reaped
    only if pre-spawn) or EVERYTHING (recoverable via the normal
    reconcile path); never a partial ambiguity. The spend hold must
    already exist (reserved pre-spawn); a missing hold is a loud
    ordering defect, not a silent mint. Raises SpendBlocked on any
    accounting defect (the caller keeps the hold and aborts)."""
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
                got = con.execute(
                    "SELECT usd, is_unknown FROM spans WHERE "
                    "span_id=?", (span_id,)).fetchone()
                if got is not None:
                    if got[0] != usd or not got[1]:
                        raise SpendBlocked("span-conflict:%s" %
                                           span_id)
                else:
                    con.execute(
                        "INSERT INTO spans (span_id, ts, "
                        "research_epoch, cycle_id, stage, symbol, "
                        "node, model, prompt_tokens, "
                        "completion_tokens, usd, category, outcome, "
                        "is_unknown) VALUES "
                        "(?,?,?,?,?,'r',?,?,?,?,?,'research',?,1)",
                        (span_id, ts, epoch, cycle_id, symbol, node,
                         model_id, 0, 0, usd, outcome))
                con.execute(
                    "INSERT OR IGNORE INTO unknown_holds VALUES "
                    "(?,?,?,?,0)", (lease_id, span_id, usd, ts))
                con.execute(
                    "UPDATE spend_holds SET state='invoked', "
                    "span_id=? WHERE lease_id=?",
                    (span_id, lease_id))
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


def has_unreconciled(log_path):
    """True when an ambiguous charge is still outstanding: an
    unreconciled unknown row, OR any positive-dollar spend hold in
    state='invoked' (crash backstop — an invoked hold whose unknown
    rows were never written still blocks). Zero-dollar invoked holds
    never block (nothing uncertain). A missing ledger raises
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
    """THE pre-call USD authorization: ONE transaction under the
    spend lock — reap expired reserved holds, refuse when unknowns are
    pending, measure (30d committed + all outstanding holds), compare
    against the cap, insert the hold, commit. Only after this returns
    may the provider be spawned. Raises SpendBlocked (refusal, never a
    crash) or LedgerUnavailable (unmeasurable). There is no second
    non-atomic cap check: callers must not re-implement read/compare/
    insert outside this function."""
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
                con.execute("DELETE FROM spend_holds WHERE "
                            "state='reserved' AND ts < ?",
                            (now - HOLD_TTL_S,))
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
                con.execute("COMMIT")
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
    conservative reservation with the attested actual (which may KEEP
    the full reservation — never below it without attestation), clear
    the block, and journal the adjustment. actual_usd must be finite
    and non-negative; note is recorded verbatim (bounded).

    Crash recovery: reconciles from EVERY point of the ambiguity
    path — complete unknown rows (normal), an invoked hold with no
    unknown rows (fabricate + settle the missing rows from the hold,
    journaled as recovered), or an orphan unknown span (clear the
    flag, journaled). A lease with no trace at all is a loud error
    (supervisor typo safety), never a silent no-op."""
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
                    # Crash between the invoked mark and the atomic
                    # unknown record (or a partially written legacy
                    # path): recover FROM THE HOLD, which conservatively
                    # counted the dollars the whole time.
                    inv = con.execute(
                        "SELECT usd, span_id FROM spend_holds WHERE "
                        "lease_id=? AND state='invoked'",
                        (lease_id,)).fetchone()
                    if inv is None:
                        # Maybe an orphan unknown span with no rows at
                        # all: find it by the lease-derived span shape?
                        # Spans carry no lease link, so this state is
                        # only reachable when nothing was ever
                        # recorded — a loud error, never a silent ok.
                        raise LedgerUnavailable("unknown lease: %s"
                                                % lease_id)
                    old_usd = inv[0]
                    span_id = inv[1]
                    if span_id is not None:
                        con.execute(
                            "INSERT OR IGNORE INTO unknown_holds "
                            "VALUES (?,?,?,?,0)",
                            (lease_id, span_id, old_usd, now))
                    else:
                        span_id = ("recovered-%s" %
                                   hashlib.sha256(
                                       lease_id.encode("utf-8"),
                                       usedforsecurity=False
                                   ).hexdigest()[:48])
                        con.execute(
                            "INSERT OR IGNORE INTO unknown_holds "
                            "VALUES (?,?,?,?,0)",
                            (lease_id, span_id, old_usd, now))
                    tag = (note + ":recovered" if note
                           else "recovered")
                if span_id is not None:
                    con.execute("UPDATE spans SET usd=?, is_unknown=0 "
                                "WHERE span_id=? AND is_unknown=1",
                                (actual_usd, span_id))
                con.execute("UPDATE unknown_holds SET reconciled=1 "
                            "WHERE lease_id=?", (lease_id,))
                con.execute(
                    "INSERT INTO reconciliations VALUES (?,?,?,?,?)",
                    (lease_id, old_usd, actual_usd, now, tag))
                con.execute("DELETE FROM spend_holds WHERE lease_id=?",
                            (lease_id,))
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


# -- pre-call spend holds (the absolute-cap enforcement side) --------

HOLD_TTL_S = 600  # a pre-spawn crash releases; post-spawn stays


def hold_spend(log_path, lease_id, usd, now=None):
    """Reserve worst-case dollars BEFORE the provider may be touched.
    state=reserved: releasable by reap_holds() after HOLD_TTL_S (a
    crash before spawn never billed, safe to release)."""
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
                con.execute("COMMIT")
            except BaseException:
                try:
                    con.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise
        finally:
            con.close()


def mark_invoked(log_path, lease_id):
    """The child process started: this hold may have been billed and
    must NEVER auto-release. Only settle_hold()/reconcile_unknown()
    clear it."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            con.execute("UPDATE spend_holds SET state='invoked' WHERE "
                        "lease_id=? AND state='reserved'", (lease_id,))
        finally:
            con.close()


def settle_hold(log_path, lease_id):
    """A cleanly accounted call releases its hold (the span carries
    the actual). Missing hold: nothing to do (already settled or a
    pre-hold failure — both safe)."""
    _check_str("lease_id", lease_id, SPAN_ID_MAX)
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            con.execute("DELETE FROM spend_holds WHERE lease_id=?",
                        (lease_id,))
        finally:
            con.close()


def reap_holds(log_path, now=None):
    """Release pre-spawn-crash holds (state=reserved, older than
    HOLD_TTL_S). Invoked holds are NEVER reaped: a timed-out or
    crashed post-spawn attempt may have been billed."""
    now = int(time.time()) if now is None else now
    db_path = _db_for(log_path)
    mstate, _tok = locks.marker_state(db_path)
    if not os.path.exists(db_path) and mstate == "absent":
        return  # genuinely new path: nothing to reap
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            con.execute("DELETE FROM spend_holds WHERE state='reserved'"
                        " AND ts < ?", (now - HOLD_TTL_S,))
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
    SPAN_RETAIN_DAYS, then checkpoint/vacuum when over bound. Also
    self-heals the best-effort JSONL mirror from the ledger
    (best-effort: mirror failure never fails the prune — the ledger
    is authoritative). Runs hourly through the tier evaluator."""
    now = int(time.time()) if now is None else now
    cutoff = now - SPAN_RETAIN_DAYS * 86400
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock", purpose="spans"):
        con = _connect(db_path)
        try:
            con.execute("DELETE FROM spans WHERE ts < ?", (cutoff,))
            con.execute("DELETE FROM reconciliations WHERE ts < ?",
                        (cutoff,))
            con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
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
    """Regenerate the JSONL mirror from the authoritative ledger,
    atomically (temp + replace — readers never see a half file).
    Bounded by construction: the ledger itself is capped at
    LEDGER_MAX_BYTES with 120-day retention, so the materialized
    rows are deployment-bounded, not unbounded. Runs hourly via
    prune_spans (mirror self-heal); best-effort throughout."""
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
    """Aggregate the LEDGER for the UTC day containing day_ts. A
    missing/corrupt ledger raises LedgerUnavailable — it is never
    reported as zero spend."""
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
    """Total usd recorded at/after since_ts. Ledger-unavailable
    raises (never zero). Unknown (ambiguous) spans count at their
    full reserved usd — conservative by construction."""
    db_path = _db_for(log_path)
    con = _connect(db_path)
    try:
        row = con.execute("SELECT COALESCE(SUM(usd),0) FROM spans "
                          "WHERE ts >= ?", (since_ts,)).fetchone()
    finally:
        con.close()
    return row[0]
