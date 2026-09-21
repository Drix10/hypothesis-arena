"""D9 spend/token attribution ledger (doc 08 sec. 8.2 + doc 10 sec. 10.4).

Exactly one durable row per ACTUAL model invocation — written by the
workers.py invocation wrappers (the same code that reserves R15
budget), never by graph-level counting.

Durability: SQLite is AUTHORITATIVE (UNIQUE(span_id) gives atomic
exactly-once under concurrent processes — no check-then-act race).
The JSONL mirror beside it is a best-effort Langfuse tail: it is
appended ONLY when the ledger actually inserts (rowcount == 1), so
retries never duplicate the mirror; sync_mirror() regenerates it
atomically (temp + replace) from the ledger.

Row schema (frozen doc-10 spend taxonomy + outcome):
  ts, research_epoch, cycle_id, stage, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category, outcome, span_id.
category is the FROZEN doc-10 set {decision, research, experiment,
observability}; error/timeout/blocked live in `outcome`
{success, error, timeout, blocked} — a separate dimension, never a
category replacement. usd is caller-supplied from the deployment
pricing table; 0.0 means UNPRICED (tokens remain the load-bearing
measure until pricing is wired — explicit, not hidden).

Missing/corrupt ledger is LedgerUnavailable, NEVER zero spend: a
spend-control input that cannot prove its number must block, not
report $0.
"""
import json
import os
import sqlite3
import time

from . import locks

CATEGORIES = ("decision", "research", "experiment", "observability")
OUTCOMES = ("success", "error", "timeout", "blocked")


class LedgerUnavailable(Exception):
    pass


def _connect(db_path, create=False):
    if not create and not os.path.exists(db_path):
        raise LedgerUnavailable("attribution ledger missing: %s" % db_path)
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
        con.execute(
            "CREATE TABLE IF NOT EXISTS spans ("
            "span_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, "
            "research_epoch INTEGER NOT NULL, cycle_id TEXT NOT NULL, "
            "stage TEXT NOT NULL, symbol TEXT NOT NULL, "
            "node TEXT NOT NULL, model TEXT NOT NULL, "
            "prompt_tokens INTEGER NOT NULL, "
            "completion_tokens INTEGER NOT NULL, usd REAL NOT NULL, "
            "category TEXT NOT NULL, outcome TEXT NOT NULL)")
        cols = [r[1] for r in con.execute("PRAGMA table_info(spans)")]
        if "outcome" not in cols:
            raise LedgerUnavailable("legacy attribution schema")
        con.execute("PRAGMA integrity_check")
    except sqlite3.Error as e:
        con.close()
        raise LedgerUnavailable(str(e))
    return con


def _db_for(log_path):
    base, _ext = os.path.splitext(log_path)
    return base + ".ledger.sqlite3"


def append_span(log_path, epoch, node, model_id, calls=1, tokens=0,
                dollars=0.0, span_id=None, cycle_id="local", stage="r",
                symbol="?", prompt_tokens=0, completion_tokens=0,
                usd=None, category="research", outcome="success", ts=None):
    """Append one span. With span_id: INSERT OR IGNORE under the
    inter-process lock, and the JSONL mirror is appended ONLY when the
    insert actually lands (cursor rowcount) — concurrent duplicates
    collapse to one ledger row AND one mirror row.

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
    ts = int(time.time()) if ts is None else ts
    if span_id is None:
        span_id = "adhoc-%d-%s-%s-%d" % (epoch, node, model_id, ts)
    row = {"ts": ts, "research_epoch": epoch, "cycle_id": cycle_id,
           "stage": stage, "symbol": symbol, "node": node,
           "model": model_id, "prompt_tokens": prompt_tokens,
           "completion_tokens": completion_tokens, "usd": usd,
           "category": category, "outcome": outcome, "span_id": span_id,
           "calls": calls, "tokens": prompt_tokens + completion_tokens,
           "dollars": usd, "model_id": model_id}
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock"):
        # create=True mints the ledger ONLY for a genuinely new path;
        # an EXISTING unreadable file raises (never reset to empty).
        con = _connect(db_path, create=True)
        try:
            cur = con.execute(
                "INSERT OR IGNORE INTO spans (span_id, ts, "
                "research_epoch, cycle_id, stage, symbol, node, model,"
                " prompt_tokens, completion_tokens, usd, category, "
                "outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (span_id, ts, epoch, cycle_id, stage, symbol, node,
                 model_id, prompt_tokens, completion_tokens, usd,
                 category, outcome))
            inserted = cur.rowcount
        finally:
            con.close()
        if inserted:
            try:
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps(row, sort_keys=True) + "\n")
                    fh.flush()
                    os.fsync(fh.fileno())
            except OSError:
                pass  # ledger is authoritative; mirror repaired below
    return row


def sync_mirror(log_path):
    """Regenerate the JSONL mirror from the authoritative ledger,
    atomically (temp + replace — readers never see a half file)."""
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock"):
        try:
            con = _connect(db_path)
        except LedgerUnavailable:
            return False
        try:
            rows = con.execute(
                "SELECT ts, research_epoch, cycle_id, stage, symbol, "
                "node, model, prompt_tokens, completion_tokens, usd, "
                "category, outcome, span_id FROM spans "
                "ORDER BY ts, span_id").fetchall()
        finally:
            con.close()
    keys = ("ts", "research_epoch", "cycle_id", "stage", "symbol",
            "node", "model", "prompt_tokens", "completion_tokens",
            "usd", "category", "outcome", "span_id")
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
    with con:
        rows = con.execute(
            "SELECT node, model, outcome, prompt_tokens, "
            "completion_tokens, usd FROM spans WHERE ts >= ? AND ts < ?",
            (day, day + 86400)).fetchall()
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
    raises (never zero)."""
    db_path = _db_for(log_path)
    con = _connect(db_path)
    with con:
        row = con.execute("SELECT COALESCE(SUM(usd),0) FROM spans "
                          "WHERE ts >= ?", (since_ts,)).fetchone()
    return row[0]
