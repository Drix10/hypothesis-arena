"""D9 spend/token attribution ledger (doc 08 sec. 8.2 + doc 10 sec. 10.4).

Exactly one durable row per ACTUAL model invocation — written by the
workers.py invocation wrappers (the same code that reserves R15
budget), never by graph-level counting. Standalone append_span() calls
outside that boundary are a test/supervisor affordance, not the spend
record.

Durability: SQLite is AUTHORITATIVE (UNIQUE(span_id) gives atomic
exactly-once under concurrent processes — no check-then-act race).
The JSONL mirror beside it is a best-effort Langfuse tail, regenerated
by sync_mirror(); day_summary() aggregates the ledger, never memory.

Row schema (frozen doc-10 spend fields + identity):
  ts, research_epoch, cycle_id, stage, symbol, node, model,
  prompt_tokens, completion_tokens, usd, category, span_id.
tokens aggregate = prompt + completion. category is one of
{research, error, timeout, blocked}. usd is caller-supplied from the
deployment pricing table; 0.0 means UNPRICED (tokens remain the
load-bearing measure until pricing is wired — explicit, not hidden).
"""
import json
import os
import sqlite3
import time

from . import locks

CATEGORIES = ("research", "error", "timeout", "blocked")


def _connect(db_path):
    d = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(d, exist_ok=True)
    con = sqlite3.connect(db_path, timeout=60.0,
                          check_same_thread=False, isolation_level=None)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=FULL")
    con.execute(
        "CREATE TABLE IF NOT EXISTS spans ("
        "span_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, "
        "research_epoch INTEGER NOT NULL, cycle_id TEXT NOT NULL, "
        "stage TEXT NOT NULL, symbol TEXT NOT NULL, node TEXT NOT NULL,"
        "model TEXT NOT NULL, prompt_tokens INTEGER NOT NULL, "
        "completion_tokens INTEGER NOT NULL, usd REAL NOT NULL, "
        "category TEXT NOT NULL)")
    return con


def _db_for(log_path):
    base, _ext = os.path.splitext(log_path)
    return base + ".ledger.sqlite3"


def append_span(log_path, epoch, node, model_id, calls=1, tokens=0,
                dollars=0.0, span_id=None, cycle_id="local", stage="r",
                symbol="?", prompt_tokens=0, completion_tokens=0,
                usd=None, category="research", ts=None):
    """Append one span. With span_id: INSERT OR IGNORE under the
    inter-process lock — concurrent duplicates collapse to one row
    (returns the row either way). Without span_id (legacy/test use):
    one fresh row per call.

    Compatibility: tokens= prompt+completion combined; dollars= usd.
    Explicit prompt/completion/usd win when given.
    """
    if category not in CATEGORIES:
        raise ValueError("bad category: %r" % category)
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
           "category": category, "span_id": span_id,
           "calls": calls, "tokens": prompt_tokens + completion_tokens,
           "dollars": usd, "model_id": model_id}
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock"):
        con = _connect(db_path)
        try:
            con.execute(
                "INSERT OR IGNORE INTO spans (span_id, ts, "
                "research_epoch, cycle_id, stage, symbol, node, model,"
                " prompt_tokens, completion_tokens, usd, category) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (span_id, ts, epoch, cycle_id, stage, symbol, node,
                 model_id, prompt_tokens, completion_tokens, usd,
                 category))
        finally:
            con.close()
        # Best-effort mirror for the Langfuse tail; the ledger above is
        # authoritative (a crash here is repaired by sync_mirror()).
        try:
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        except OSError:
            pass
    return row


def sync_mirror(log_path):
    """Rewrite the JSONL mirror from the authoritative ledger."""
    db_path = _db_for(log_path)
    with locks.FileLock(db_path + ".lock"):
        con = _connect(db_path)
        try:
            rows = con.execute(
                "SELECT ts, research_epoch, cycle_id, stage, symbol, "
                "node, model, prompt_tokens, completion_tokens, usd, "
                "category, span_id FROM spans ORDER BY ts, span_id"
            ).fetchall()
        finally:
            con.close()
    keys = ("ts", "research_epoch", "cycle_id", "stage", "symbol",
            "node", "model", "prompt_tokens", "completion_tokens",
            "usd", "category", "span_id")
    with open(log_path, "w", encoding="utf-8") as fh:
        for r in rows:
            d = dict(zip(keys, r))
            d["calls"] = 1
            d["tokens"] = d["prompt_tokens"] + d["completion_tokens"]
            d["dollars"] = d["usd"]
            d["model_id"] = d["model"]
            fh.write(json.dumps(d, sort_keys=True) + "\n")
        fh.flush()
        os.fsync(fh.fileno())


def day_summary(log_path, day_ts=None):
    """Aggregate the LEDGER for the UTC day containing day_ts."""
    if day_ts is None:
        day_ts = int(time.time())
    day = day_ts - (day_ts % 86400)
    out = {"calls": 0, "tokens": 0, "prompt_tokens": 0,
           "completion_tokens": 0, "dollars": 0.0, "by_node": {},
           "by_model": {}, "spend_30d": 0.0}
    db_path = _db_for(log_path)
    try:
        con = _connect(db_path)
    except OSError:
        return out
    with con:
        try:
            rows = con.execute(
                "SELECT node, model, prompt_tokens, completion_tokens,"
                " usd FROM spans WHERE ts >= ? AND ts < ?",
                (day, day + 86400)).fetchall()
        except OSError:
            return out
    for node, model, pt, ct, usd in rows:
        out["calls"] += 1
        out["tokens"] += pt + ct
        out["prompt_tokens"] += pt
        out["completion_tokens"] += ct
        out["dollars"] += usd
        out["by_node"][node] = out["by_node"].get(node, 0) + 1
        out["by_model"][model] = out["by_model"].get(model, 0.0) + usd
    out["spend_30d"] = out["dollars"] * 30
    return out
