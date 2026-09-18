#!/usr/bin/env python3
"""P1.3 canonical layer: signals.jsonl (event log) -> SQLite (truth) -> classified.jsonl.

Deterministic only. No LLM anywhere: TRIGGER eligibility comes from
source + record type + rule table, never from interpretation. Records that
need economic interpretation stay CONTEXT with effect_pending until the
interpretation table exists (research plane, Phase 2.5).

Verdicts per record: new | duplicate | revision | correction | malformed | stale.
Eligibility: TRIGGER_CANDIDATE | CONTEXT | REJECTED | STALE.
"""
import json
import os
import re
import sqlite3
import sys
import hashlib
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PARSER_VERSION = "p1"
RULES_VERSION = "rules_v1"
DB = os.environ.get("MIRO_CANONICAL_DB", os.path.join(ROOT, "data", "canonical.db"))
CLASSIFIED = os.environ.get("MIRO_CLASSIFIED_DIR", os.path.join(ROOT, "data", "classified"))

# Per-source feature TTL: older than this -> STALE (kept in index, ineligible).
SOURCE_TTL = {
    "edgar_8k": 900, "fed_monetary": 21600, "ecb_mid": 21600,
    "treasury_auctions": 86400, "bls_empsit": 86400, "fred_macro": 86400,
}
# 8-K items that may become TRIGGER candidates (deterministic table, rules_v1).
TRIGGER_ITEMS = {"1.01", "1.02", "2.02", "2.06", "5.02", "7.01", "8.01"}
# Header-anchored detection (rules_v1): an item promotes only as a section
# header — line start, after <br>/newline/`>`, or after `;` — followed by
# `:` or `-`. Narrative mentions ("discussion of Item 2.02 in...") do not.
ITEM_HEADER_RE = re.compile(
    r"(?:^|[\n\r>]|<br\s*/?>|;\s*)\s*Item\s+(\d+\.\d+)\s*[:\-\u2013\u2014]",
    re.IGNORECASE)


def detect_amendment(source, rec):
    """rules_v1 scope (explicit limitation): EDGAR-only heuristic. An 8-K/A
    accession amends its base accession. Any other source, or any EDGAR record
    not matching this contract, is at most a revision — never a correction."""
    if source != "edgar_8k":
        return False
    title = rec.get("title", "") or ""
    return "/A" in title.split("(")[0] or (rec.get("source_id", "") or "").endswith("/A")
FED_TRIGGER_RE = re.compile(
    r"FOMC statement|monetary policy|discount rate|Federal Open Market|target range",
    re.IGNORECASE)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]")


def parse_ts(s):
    """Best-effort publication parse. Returns (iso, estimated)."""
    if not s:
        return None, True
    try:
        if isinstance(s, str) and ISO_RE.match(s.strip()):
            return datetime.fromisoformat(s).astimezone(timezone.utc).isoformat(), False
        return parsedate_to_datetime(s).astimezone(timezone.utc).isoformat(), False
    except (ValueError, TypeError):
        return None, True


def content_hash(rec):
    """Hash over the canonical authoritative payload.
    Excluded (volatile transport, changes every poll): observed_at.
    Everything else a source can authoritatively correct — title, text, url,
    links, published_at — is hashed, so metadata-only changes become revisions."""
    h = hashlib.sha256()
    payload = {k: rec.get(k) for k in
               ("source", "source_id", "title", "text", "url", "links", "published_at")}
    h.update(json.dumps(payload, sort_keys=True, default=str).encode())
    return h.hexdigest()[:24]


REQUIRED_FIELDS = ("id", "source", "source_id")


def validate_record(rec):
    """Structural schema gate. Returns None if valid, else a reason string.
    Runs BEFORE ingest_signal touches rec[...] so malformed schema can never
    raise KeyError or enter SQLite as a canonical event."""
    if not isinstance(rec, dict):
        return "not-an-object"
    for f in REQUIRED_FIELDS:
        v = rec.get(f)
        if not isinstance(v, str) or not v:
            return f"missing-or-null-{f}"
    if not (rec.get("title") or rec.get("text") or rec.get("url")):
        return "no-content-at-all"
    return None


def init_db(con):
    con.execute("""CREATE TABLE IF NOT EXISTS records(
      source TEXT, source_id TEXT, content_hash TEXT,
      first_seen_at TEXT, last_seen_at TEXT, published_at TEXT,
      retrieved_at TEXT, revision_id TEXT, verdict TEXT, raw_json TEXT,
      parser_version TEXT, PRIMARY KEY(source, source_id, content_hash))""")
    con.execute("""CREATE TABLE IF NOT EXISTS corrections(
      source TEXT, amending_id TEXT, base_id TEXT, at TEXT)""")


def ingest_signal(con, rec, retrieved_at):
    """Revision-aware dedupe. Caller MUST run validate_record() first.
    Returns (verdict, content_hash, first_seen_at, revision_of)."""
    ch = content_hash(rec)
    cur = con.execute(
        "SELECT content_hash, verdict FROM records WHERE source=? AND source_id=? "
        "ORDER BY first_seen_at",
        (rec["source"], rec["source_id"]))
    prior = cur.fetchall()
    pub, estimated = parse_ts(rec.get("published_at"))
    if estimated and rec.get("published_at"):
        pub = None  # unparseable counts as missing, never as a guessed time
    is_amend = detect_amendment(rec["source"], rec)
    revision_of = prior[-1][0] if prior else None
    if any(p[0] == ch for p in prior):
        con.execute(
            "UPDATE records SET last_seen_at=? WHERE source=? AND source_id=? AND content_hash=?",
            (retrieved_at, rec["source"], rec["source_id"], ch))
        row = con.execute(
            "SELECT first_seen_at FROM records WHERE source=? AND source_id=? AND content_hash=?",
            (rec["source"], rec["source_id"], ch)).fetchone()
        return "duplicate", ch, (row[0] if row else retrieved_at), None
    if prior and is_amend:
        verdict = "correction"
    elif prior:
        verdict = "revision"
    elif not (rec.get("title") or rec.get("text")):
        verdict = "malformed"
    else:
        verdict = "new"
    cur = con.execute(
        "INSERT OR IGNORE INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (rec["source"], rec["source_id"], ch, retrieved_at, retrieved_at,
         pub, retrieved_at,
         rec["source_id"] if is_amend else None, verdict,
         json.dumps(rec, ensure_ascii=False), PARSER_VERSION))
    if cur.rowcount == 0:
        # Lost a concurrent race: the row exists now -> duplicate.
        con.execute(
            "UPDATE records SET last_seen_at=? WHERE source=? AND source_id=? AND content_hash=?",
            (retrieved_at, rec["source"], rec["source_id"], ch))
        row = con.execute(
            "SELECT first_seen_at FROM records WHERE source=? AND source_id=? AND content_hash=?",
            (rec["source"], rec["source_id"], ch)).fetchone()
        return "duplicate", ch, (row[0] if row else retrieved_at), None
    if verdict == "correction":
        base = rec["source_id"].replace("/A", "")
        con.execute("INSERT OR IGNORE INTO corrections VALUES(?,?,?,?)",
                    (rec["source"], rec["source_id"], base, retrieved_at))
    row = con.execute(
        "SELECT first_seen_at FROM records WHERE source=? AND source_id=? AND content_hash=?",
        (rec["source"], rec["source_id"], ch)).fetchone()
    return verdict, ch, (row[0] if row else retrieved_at), revision_of


ARCHAEOLOGY_DAYS = 7


def is_archaeology(published_at):
    """Known publication older than a week: archaeology, not news."""
    if not published_at:
        return False
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(published_at)).total_seconds()
    except ValueError:
        return False
    return age > ARCHAEOLOGY_DAYS * 86400


def is_fresh(first_seen_at, source):
    """Candidate urgency keys on when WE first saw it (source activity),
    not on publication age: a fact discovered late is actionable late,
    with published_at preserved for the lookahead audit."""
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(first_seen_at)).total_seconds()
    except (ValueError, TypeError):
        return False
    return age <= SOURCE_TTL.get(source, 21600)


def classify(source, rec, verdict, published_at, estimated, fresh=True, retrieved_at=None):
    """Deterministic eligibility. Returns (eligibility, effect, confidence, reason)."""
    if verdict == "malformed":
        return "REJECTED", None, 1.0, "empty-record"
    if verdict in ("duplicate",):
        return "REJECTED", None, 1.0, "duplicate"
    if verdict == "correction":
        return "CONTEXT", {"corrects": True}, 1.0, "amendment-never-triggers"
    if is_archaeology(published_at):
        return "STALE", None, 1.0, "archaeology"
    effective = published_at or retrieved_at
    if retrieved_at and effective and effective > retrieved_at:
        # Hard lookahead invariant: economically-effective time after our own
        # observation time is never downstream-eligible, no exceptions.
        return "REJECTED", None, 1.0, "future-timestamp"
    elig, effect, conf, reason = _base_classify(source, rec, estimated)
    if elig == "TRIGGER_CANDIDATE" and not fresh:
        effect = dict(effect or {});
        effect["aged"] = True
        return "CONTEXT", effect, conf, "candidate-expired"
    return elig, effect, conf, reason


def _base_classify(source, rec, estimated):
    title, text = rec.get("title", ""), rec.get("text", "")
    if source == "edgar_8k":
        items = sorted(set(ITEM_HEADER_RE.findall(text + " " + title)))
        if not items:
            return "CONTEXT", {"items_unknown": True}, 0.5, "no-parsable-items"
        if estimated:
            return "CONTEXT", {"items": items}, 0.5, "estimated-timestamp-caps-context"
        hot = sorted(set(items) & TRIGGER_ITEMS)
        if hot:
            return "TRIGGER_CANDIDATE", {"items": hot}, 1.0, f"8K-items:{','.join(hot)}"
        return "CONTEXT", {"items": items}, 1.0, "routine-items"
    if source == "fed_monetary":
        if estimated:
            return "CONTEXT", None, 0.5, "estimated-timestamp-caps-context"
        if FED_TRIGGER_RE.search(title + " " + text):
            return "TRIGGER_CANDIDATE", {"statement": True}, 1.0, "policy-statement"
        return "CONTEXT", None, 1.0, "speech-or-testimony"
    if source == "treasury_auctions":
        return "CONTEXT", {"effect_pending": "auction-interpretation-undefined"}, 1.0, \
            "auction-values-recorded-no-direction"
    if source == "bls_empsit":
        return "CONTEXT", {"values_pending": True}, 1.0, "headline-only-no-values"
    if source == "ecb_mid":
        return "CONTEXT", {"infra": True}, 1.0, "collateral-eligibility-reference"
    return "CONTEXT", None, 0.5, "default-context"


def run(signals_path):
    os.makedirs(CLASSIFIED, exist_ok=True)
    con = sqlite3.connect(DB, timeout=30)
    init_db(con)
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    out_path = os.path.join(CLASSIFIED, f"{day}.jsonl")
    stats = {"per_source": {}}
    with open(out_path, "a", encoding="utf-8") as out:
        for line in open(signals_path, encoding="utf-8"):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                stats["malformed_lines"] = stats.get("malformed_lines", 0) + 1
                continue
            try:
                schema_problem = validate_record(rec)
            except Exception:
                schema_problem = "validator-crash"
            if schema_problem:
                stats["schema_invalid"] = stats.get("schema_invalid", 0) + 1
                s = stats["per_source"].setdefault(
                    rec.get("source", "unknown") if isinstance(rec, dict) else "unknown", {})
                s["REJECTED"] = s.get("REJECTED", 0) + 1
                s[f"reason:schema-{schema_problem}"] = \
                    s.get(f"reason:schema-{schema_problem}", 0) + 1
                continue  # structurally invalid: never SQLite, never emitted
            try:
                retrieved_at = now_iso()  # OUR processing time, not the source's
                verdict, ch, first_seen, revision_of = ingest_signal(con, rec, retrieved_at)
            except Exception as e:
                stats["ingest_crash"] = stats.get("ingest_crash", 0) + 1
                stats["ingest_crash_last"] = f"{type(e).__name__}: {e}"[:200]
                continue  # one bad row never kills the batch
            pub_row = con.execute(
                "SELECT published_at FROM records WHERE source=? AND source_id=? AND content_hash=?",
                (rec["source"], rec["source_id"], ch)).fetchone()
            published_at = pub_row[0] if pub_row else None
            estimated = published_at is None
            effective_at = published_at or retrieved_at
            fresh = is_fresh(first_seen, rec["source"])
            elig, effect, conf, reason = classify(
                rec["source"], rec, verdict, published_at, estimated, fresh, retrieved_at)
            s = stats["per_source"].setdefault(rec["source"], {})
            s[verdict] = s.get(verdict, 0) + 1
            s[elig] = s.get(elig, 0) + 1
            s[f"reason:{reason}"] = s.get(f"reason:{reason}", 0) + 1
            if elig in ("TRIGGER_CANDIDATE", "CONTEXT"):
                out.write(json.dumps({
                    "id": rec["id"], "source": rec["source"], "source_id": rec["source_id"],
                    "eligibility": elig, "effect": effect, "confidence": conf,
                    "reason": reason,
                    "timestamps": {"published_at": published_at,
                                   "retrieved_at": retrieved_at,
                                   "source_observed_at": rec.get("observed_at"),
                                   "effective_at": effective_at,
                                   "first_seen_at": first_seen,
                                   "published_estimated": estimated},
                    "provenance": {"raw_hash": ch, "parser_version": PARSER_VERSION,
                                   "rule_version": RULES_VERSION, "created_at": retrieved_at,
                                   "revision_of": revision_of},
                }, ensure_ascii=False) + "\n")
    con.commit()
    con.close()
    return out_path, stats


if __name__ == "__main__":
    path, stats = run(sys.argv[1])
    print(f"classified -> {path}")
    print(json.dumps(stats, indent=1))
