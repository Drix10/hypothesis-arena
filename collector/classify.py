#!/usr/bin/env python3
"""P1.3 canonical layer: signals.jsonl (event log) -> SQLite (truth) -> classified.jsonl.

Authority: the SQLite DB is the canonical truth. classified.jsonl is a
DERIVED, rebuildable projection (rerun run() over the same signals file
reproduces it PK-idempotently); a crash between DB commit and file publish
loses nothing authoritative.

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
    """rules_v1 amendment contract (explicit scope, no SEC parser):
    EDGAR-only. Matches when the feed entry itself carries the amendment
    marker (8-K/A in the title prefix, or source_id ending /A).
    Cross-accession linkage (amendment accession -> base accession) is NOT
    determinable from the Atom feed, so a first-seen amendment can never
    claim correction linkage: it stays CONTEXT until its base is observed
    under the same source_id, and revision_of is never fabricated."""
    if source != "edgar_8k":
        return False
    title = rec.get("title", "") or ""
    if AMEND_TITLE_RE.match(title):
        return True
    return (rec.get("source_id", "") or "").endswith("/A")
# Strict EDGAR amendment marker: anchored title prefix `8-K/A` (optional
# leading space, then whitespace/paren/colon/end) or a trailing `/A` on the
# source_id. Substring matching ("/A" anywhere) false-positives on titles
# like "SEC FORM 4/A..." handled by other sources or narrative text.
AMEND_TITLE_RE = re.compile(r"\s*8-K/A(?=[\s(:]|$)")
FED_TRIGGER_RE = re.compile(
    r"FOMC statement|monetary policy|discount rate|Federal Open Market|target range",
    re.IGNORECASE)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]")


def parse_ts(s):
    """Publication parse. Returns (iso, estimated).
    Authoritative timestamps REQUIRE explicit timezone (Z or +/-HH:MM).
    Naive timestamps are never authoritative: (None, True) — the record is
    permanently CONTEXT-capped, never TRIGGER on a guessed clock."""
    if not s:
        return None, True
    try:
        if isinstance(s, str) and ISO_RE.match(s.strip()):
            dt = datetime.fromisoformat(s)
            if dt.tzinfo is None:
                return None, True
            return dt.astimezone(timezone.utc).isoformat(), False
        dt = parsedate_to_datetime(s)
        if dt.tzinfo is None:
            return None, True
        return dt.astimezone(timezone.utc).isoformat(), False
    except (ValueError, TypeError):
        return None, True


def content_hash(rec):
    """Hash over the canonical authoritative payload (FULL 64-hex SHA-256).
    Excluded (volatile transport, changes every poll): observed_at.
    Everything else a source can authoritatively correct — title, text, url,
    links, published_at — is hashed, so metadata-only changes become revisions.
    No default=str: exact types are enforced by validate_record() first; a
    non-serializable payload raises instead of silently stringifying."""
    h = hashlib.sha256()
    payload = {k: rec.get(k) for k in
               ("source", "source_id", "title", "text", "url", "links", "published_at")}
    h.update(json.dumps(payload, sort_keys=True).encode())
    return h.hexdigest()


REQUIRED_FIELDS = ("id", "source", "source_id")
# Canonical record allowlist: every key a collector may author. Unknown keys
# are schema rejections, never silently carried (provenance smuggling
# surface). The hash payload (§content_hash) draws from this set.
KNOWN_FIELDS = frozenset(("id", "source", "source_id", "title", "text",
                          "url", "links", "observed_at", "published_at",
                          "published_estimated", "updated_at", "word_count",
                          "has_external_link"))
# Exact types for source-authored fields (None = absent; anything else wrong
# is a schema rejection, never coerced). Extra unknown keys are allowed
# through (collectors may annotate) but never enter the hash payload.
OPTIONAL_STR = ("title", "text", "url", "published_at", "observed_at",
                "updated_at")
OPTIONAL_BOOL = ("published_estimated", "has_external_link")


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
    for k in rec:
        if k not in KNOWN_FIELDS:
            return f"unknown-field-{k}"
    for f in OPTIONAL_STR:
        v = rec.get(f)
        if v is not None and not isinstance(v, str):
            return f"bad-type-{f}"
    for f in OPTIONAL_BOOL:
        v = rec.get(f)
        if v is not None and not isinstance(v, bool):
            return f"bad-type-{f}"
    links = rec.get("links")
    if links is not None:
        if not isinstance(links, list) or \
                any(not isinstance(x, str) for x in links):
            return "bad-type-links"
    wc = rec.get("word_count")
    if wc is not None and (isinstance(wc, bool) or not isinstance(wc, int)):
        return "bad-type-word_count"
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
      source TEXT, amending_id TEXT, base_id TEXT, at TEXT,
      UNIQUE(source, amending_id, base_id))""")


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
        base = rec["source_id"]
        if base.endswith("/A"):
            base = base[: -len("/A")]
        con.execute("INSERT OR IGNORE INTO corrections VALUES(?,?,?,?)",
                    (rec["source"], rec["source_id"], base, retrieved_at))
    row = con.execute(
        "SELECT first_seen_at FROM records WHERE source=? AND source_id=? AND content_hash=?",
        (rec["source"], rec["source_id"], ch)).fetchone()
    return verdict, ch, (row[0] if row else retrieved_at), revision_of


ARCHAEOLOGY_DAYS = 7
REF = {"t": None}  # explicit reference time; run()/audit set it, tests can pin it


def _now():
    if REF["t"] is not None:
        return datetime.fromisoformat(REF["t"])
    return datetime.now(timezone.utc)


def is_archaeology(published_at):
    """Known publication older than a week: archaeology, not news."""
    if not published_at:
        return False
    try:
        age = (_now() - datetime.fromisoformat(published_at)).total_seconds()
    except ValueError:
        return False
    return age > ARCHAEOLOGY_DAYS * 86400


def is_fresh(first_seen_at, source):
    """Candidate urgency keys on when WE first saw it (source activity),
    not on publication age: a fact discovered late is actionable late,
    with published_at preserved for the lookahead audit."""
    try:
        age = (_now() - datetime.fromisoformat(first_seen_at)).total_seconds()
    except (ValueError, TypeError):
        return False
    return age <= SOURCE_TTL.get(source, 21600)


def classify(source, rec, verdict, published_at, estimated, fresh=True, retrieved_at=None):
    """Deterministic eligibility. Returns (eligibility, effect, confidence, reason)."""
    # Timestamp validity FIRST: no branch below may bypass it. effective_at is
    # derived here, once, as the single canonical calculation.
    effective_at = published_at or retrieved_at
    if retrieved_at and effective_at and effective_at > retrieved_at:
        return "REJECTED", None, 1.0, "future-timestamp", effective_at
    if verdict == "malformed":
        return "REJECTED", None, 1.0, "empty-record", effective_at
    if verdict in ("duplicate",):
        return "REJECTED", None, 1.0, "duplicate", effective_at
    if verdict == "correction":
        return "CONTEXT", {"corrects": True}, 1.0, "amendment-never-triggers", effective_at
    if is_archaeology(published_at):
        return "STALE", None, 1.0, "archaeology", effective_at
    elig, effect, conf, reason = _base_classify(source, rec, estimated)
    if elig == "TRIGGER_CANDIDATE" and not fresh:
        effect = dict(effect or {});
        effect["aged"] = True
        return "CONTEXT", effect, conf, "candidate-expired", effective_at
    return elig, effect, conf, reason, effective_at


def _base_classify(source, rec, estimated):
    title, text = rec.get("title", ""), rec.get("text", "")
    if source == "edgar_8k":
        if detect_amendment(source, rec):
            # First-seen (or cross-accession) amendment: base not established
            # under this source_id, so correction linkage cannot be claimed.
            # CONTEXT, never a candidate. (Same-id amendments with prior rows
            # take the correction path in classify() before reaching here.)
            return "CONTEXT", {"amendment_unlinked": True}, 1.0, \
                "amendment-needs-base"
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


def run(signals_path, as_of=None):
    REF["t"] = as_of or now_iso()
    os.makedirs(CLASSIFIED, exist_ok=True)
    con = sqlite3.connect(DB, timeout=30)
    init_db(con)
    # Deterministic replay: when as_of is supplied, OUR processing clock and
    # the output day both come from as_of — never wall-clock. Reruns of the
    # same input reproduce the same rows and the same file.
    now = REF["t"]
    day = now[:10]
    out_path = os.path.join(CLASSIFIED, f"{day}.jsonl")
    stats = {"per_source": {}}
    emitted = []  # published only after a successful DB commit (C6)
    with open(signals_path, encoding="utf-8") as fh:
        for line in fh:
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
                retrieved_at = now  # OUR processing time, not the source's
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
            fresh = is_fresh(first_seen, rec["source"])
            elig, effect, conf, reason, effective_at = classify(
                rec["source"], rec, verdict, published_at, estimated, fresh, retrieved_at)
            s = stats["per_source"].setdefault(rec["source"], {})
            s[verdict] = s.get(verdict, 0) + 1
            s[elig] = s.get(elig, 0) + 1
            s[f"reason:{reason}"] = s.get(f"reason:{reason}", 0) + 1
            if elig in ("TRIGGER_CANDIDATE", "CONTEXT"):
                emitted.append({
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
                })
    # Crash-consistent publication: commit the canonical truth FIRST, then
    # write the output to temp + fsync + atomic rename. A crash before the
    # commit leaves neither DB rows nor output; a crash during the file
    # write leaves the previous artifact intact; reruns are PK-idempotent.
    con.commit()
    tmp_path = out_path + f".tmp-{os.getpid()}"
    with open(tmp_path, "w", encoding="utf-8") as out:
        for row in emitted:
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
        out.flush()
        os.fsync(out.fileno())
    os.replace(tmp_path, out_path)
    con.close()
    return out_path, stats


if __name__ == "__main__":
    argv = sys.argv[1:]
    as_of = None
    if "--as-of" in argv:
        i = argv.index("--as-of")
        try:
            as_of = argv[i + 1]
        except IndexError:
            print("--as-of requires an ISO instant", file=sys.stderr)
            sys.exit(2)
        argv = [a for j, a in enumerate(argv) if j not in (i, i + 1)]
    if len(argv) != 1:
        print(f"usage: classify.py <signals.jsonl> [--as-of ISO]",
              file=sys.stderr)
        sys.exit(2)
    path, stats = run(argv[0], as_of=as_of)
    print(f"classified -> {path}")
    print(json.dumps(stats, indent=1))
