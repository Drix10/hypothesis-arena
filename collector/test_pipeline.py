#!/usr/bin/env python3
"""P1.3 self-check: duplicate, amendment, stale, malformed, replay,
lookahead, concurrent-write. Stdlib only; fails loudly.
Usage: python3 collector/test_pipeline.py
"""
import os
import sys
import tempfile
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix="miro-test-")
os.environ["MIRO_CANONICAL_DB"] = os.path.join(tmp, "t.db")
os.environ["MIRO_CLASSIFIED_DIR"] = tmp
sys.path.insert(0, HERE)

import sqlite3  # noqa: E402
from classify import init_db, ingest_signal, classify, DB, \
    temporal_violation  # noqa: E402

N = 0


def rec(**kw):
    global N
    N += 1
    r = {"id": f"t:{N}", "source": "edgar_8k", "source_id": f"acc-{N}",
         "title": "8-K", "text": "Item 2.02 Results of Operations",
         "url": "http://x", "observed_at": "2026-09-18T18:00:00+00:00",
         "published_at": "2026-09-18T17:00:00+00:00"}
    r.update(kw)
    return r


_open = []


def fresh():
    for c in _open:
        try:
            c.close()
        except Exception:
            pass
    del _open[:]
    if os.path.exists(DB):
        os.remove(DB)
    con = sqlite3.connect(DB, timeout=30)
    init_db(con)
    _open.append(con)
    return con


# 1. duplicate: same content twice -> new, duplicate
r = rec(source_id="same-1")
con2 = fresh()
a, _, _, _ = ingest_signal(con2, r, "2026-09-18T18:00:00+00:00")
b, _, _, _ = ingest_signal(con2, dict(r), "2026-09-18T18:01:00+00:00")
assert (a, b) == ("new", "duplicate"), (a, b)
print("ok duplicate")

# 2. amendment: same id, changed text, /A title -> correction, CONTEXT only
con = fresh()
base = rec(source_id="acc-9", title="8-K ACME", text="Item 2.02 earnings beat")
ingest_signal(con, base, "2026-09-18T18:00:00+00:00")
amd = rec(source_id="acc-9", title="8-K/A ACME", text="Item 2.02 restated")
# same source_id but different text: prior exists -> revision or correction?
v, _, _, _ = ingest_signal(con, amd, "2026-09-18T19:00:00+00:00")
assert v == "correction", v
e, *_ = classify("edgar_8k", amd, v, "2026-09-18T19:00:00+00:00", False)
assert e == "CONTEXT", e
print("ok amendment-correction")

# 3. revision (non-amendment changed content) links, stays versioned not dropped
con = fresh()
ingest_signal(con, rec(source_id="r1", text="Item 8.01 v1"), "2026-09-18T18:00:00+00:00")
v, _, _, _ = ingest_signal(con, rec(source_id="r1", text="Item 8.01 v2"), "2026-09-18T18:05:00+00:00")
assert v == "revision", v
print("ok revision")

# 4. stale: old publication -> STALE, never candidate
con = fresh()
old = rec(source_id="old1", published_at="2026-09-10T12:00:00+00:00")
ingest_signal(con, old, "2026-09-18T18:00:00+00:00")
e, *_ = classify("edgar_8k", old, "new", "2026-09-10T12:00:00+00:00", False)
assert e == "STALE", e
print("ok stale")

# 5. malformed: empty title+text -> REJECTED, kept out of candidates
e, *_ = classify("edgar_8k", rec(title="", text=""), "malformed", None, True)
assert e == "REJECTED", e
print("ok malformed")

# 6. replay idempotency: same batch twice -> identical verdict sequence
def batch(con, rows, ts):
    return [ingest_signal(con, dict(r), ts)[0] for r in rows]
rows = [rec(source_id=f"p{i}") for i in range(5)]
con = fresh()
first = batch(con, rows, "2026-09-18T18:00:00+00:00")
con.commit()
second = batch(con, rows, "2026-09-18T18:01:00+00:00")
assert first == ["new"] * 5 and second == ["duplicate"] * 5, (first, second)
print("ok replay")

# 7. lookahead: estimated timestamp never becomes a candidate
hot = rec(source_id="hot1", text="<br>Item 2.02: blowout quarter", published_at=None)
e, eff, conf, reason, _ = classify("edgar_8k", hot, "new", None, True)
assert e == "CONTEXT" and "estimated" in reason, (e, reason)
print("ok lookahead")

# 8. concurrent-write: two connections, same record -> one new + one duplicate
con = fresh()
con.commit()
shared = rec(source_id="cc1")
outcomes = []
barrier = threading.Barrier(2)


def writer():
    c = sqlite3.connect(DB, timeout=30)
    barrier.wait()
    outcomes.append(ingest_signal(c, dict(shared), "2026-09-18T18:00:00+00:00")[0])
    c.commit()
    c.close()


ts = [threading.Thread(target=writer) for _ in range(2)]
[t.start() for t in ts]
[t.join() for t in ts]
assert sorted(outcomes) == ["duplicate", "new"], outcomes
print("ok concurrent-write")

print("ALL P1.3 CHECKS PASS")

# 9. aged candidate: hot items but first seen beyond TTL -> CONTEXT + aged flag
from classify import is_fresh, validate_record, ITEM_HEADER_RE  # noqa: E402
from datetime import datetime, timezone  # noqa: E402
con = fresh()
old_seen = rec(source_id="aged1", text="<br>Item 2.02: blowout quarter",
               published_at="2026-09-18T17:50:00+00:00")
v, _, fs, _ = ingest_signal(con, old_seen, "2026-09-18T17:51:00+00:00")
assert is_fresh("2000-01-01T00:00:00+00:00", "edgar_8k") is False
assert is_fresh(datetime.now(timezone.utc).isoformat(), "edgar_8k") is True
e, eff, conf, reason, _ = classify("edgar_8k", old_seen, v,
                                "2026-09-18T17:51:00+00:00", False, fresh=False)
assert e == "CONTEXT" and (eff or {}).get("aged") is True and reason == "candidate-expired", (e, eff, reason)
print("ok aged-candidate")

# 10. future published_at -> REJECTED (hard lookahead invariant)
con = fresh()
fut = rec(source_id="fut1", published_at="2999-01-01T00:00:00+00:00")
ingest_signal(con, fut, "2026-09-18T18:00:00+00:00")
e, *_ = classify("edgar_8k", fut, "new", "2999-01-01T00:00:00+00:00",
                 False, True, "2026-09-18T18:00:00+00:00")
assert e == "REJECTED", e
print("ok future-timestamp")

# 11. equal timestamps (published == retrieved) are fine, not future
e, *_ = classify("edgar_8k", rec(source_id="eq1"), "new",
                 "2026-09-18T18:00:00+00:00", False, True, "2026-09-18T18:00:00+00:00")
assert e in ("TRIGGER_CANDIDATE", "CONTEXT"), e
print("ok equal-timestamps")

# 12. malformed timezone / unparseable published -> estimated, CONTEXT-capped
e, eff, conf, reason, _ = classify(
    "edgar_8k", rec(source_id="tz1", text="<br>Item 8.01: Something"), "new",
    None, True, True, "2026-09-18T18:00:00+00:00")
assert e == "CONTEXT" and "estimated" in reason, (e, reason)
print("ok malformed-timezone")

# 13. schema validation: missing/null/invalid identifiers never reach SQLite
assert validate_record({"title": "hello"}) == "missing-or-null-id"
assert validate_record({"id": "x", "source": "edgar_8k"}) == "missing-or-null-source_id"
assert validate_record({"id": "x", "source": "s", "source_id": None}) == "missing-or-null-source_id"
assert validate_record({"id": "x", "source": "s", "source_id": 42}) == "missing-or-null-source_id"
assert validate_record({"id": "x", "source": "s", "source_id": "a"}) == "no-content-at-all"
assert validate_record(rec()) is None
print("ok schema-validation")

# 14. metadata-only revision: same title/text/url, changed published_at -> revision
con = fresh()
m1 = rec(source_id="meta1", published_at="2026-09-18T17:00:00+00:00")
m2 = rec(source_id="meta1", published_at="2026-09-18T17:05:00+00:00")
v1, _, _, _ = ingest_signal(con, m1, "2026-09-18T18:00:00+00:00")
v2, _, _, ro = ingest_signal(con, m2, "2026-09-18T18:01:00+00:00")
assert (v1, v2) == ("new", "revision"), (v1, v2)
assert ro is not None, "revision_of must point at the prior version"
print("ok metadata-revision")

# 15. EDGAR header vs narrative: real headers promote, mentions do not
assert ITEM_HEADER_RE.findall("<br>Item 2.02: Results of Operations") == ["2.02"]
assert ITEM_HEADER_RE.findall("Item 8.01: Other Events\n<br>Item 9.01: Exhibits") == ["8.01", "9.01"]
assert ITEM_HEADER_RE.findall("See discussion of Item 2.02 in the previous filing.") == []
assert ITEM_HEADER_RE.findall("restates Item 5.02 disclosure from last quarter") == []
narr = rec(source_id="narr1", text="See discussion of Item 2.02 in the previous filing.")
e, *_ = classify("edgar_8k", narr, "new", "2026-09-18T17:00:00+00:00",
                 False, True, "2026-09-18T18:00:00+00:00")
assert e == "CONTEXT", e
print("ok edgar-false-positive")

# 16. amendments never become candidates, even with hot items + fresh + exact ts
amd = rec(source_id="acc-77", title="8-K/A ACME (0001234)",
          text="<br>Item 2.02: Results of Operations",
          published_at="2026-09-18T17:00:00+00:00")
con = fresh()
ingest_signal(con, rec(source_id="acc-77", title="8-K ACME",
                       text="<br>Item 2.02: Results",
                       published_at="2026-09-18T16:00:00+00:00"),
              "2026-09-18T18:00:00+00:00")
v, _, _, ro = ingest_signal(con, amd, "2026-09-18T18:00:00+00:00")
assert v == "correction" and ro is not None, (v, ro)
e, *_ = classify("edgar_8k", amd, v, "2026-09-18T17:00:00+00:00",
                 False, True, "2026-09-18T18:00:00+00:00")
assert e == "CONTEXT", e
print("ok amendment-never-candidate")

print("ALL HARDENED CHECKS PASS")

RT = "2026-09-18T18:00:00+00:00"
FUT = "2999-01-01T00:00:00+00:00"

# 17. future matrix: revision, correction, archaeology+future all REJECTED
con = fresh()
base = rec(source_id="fm1", text="<br>Item 8.01: v1", published_at="2026-09-18T17:00:00+00:00")
ingest_signal(con, base, RT)
rev = rec(source_id="fm1", text="<br>Item 8.01: v2", published_at=FUT)
v, _, _, _ = ingest_signal(con, rev, RT)
assert v == "revision", v
e, *_ = classify("edgar_8k", rev, v, FUT, False, True, RT)
assert e == "REJECTED", ("future-revision", e)

con = fresh()
b2 = rec(source_id="fm2", title="8-K ACME", text="<br>Item 2.02: x",
         published_at="2026-09-18T16:00:00+00:00")
ingest_signal(con, b2, RT)
a2 = rec(source_id="fm2", title="8-K/A ACME", text="<br>Item 2.02: y", published_at=FUT)
v, _, _, _ = ingest_signal(con, a2, RT)
assert v == "correction", v
e, *_ = classify("edgar_8k", a2, v, FUT, False, True, RT)
assert e == "REJECTED", ("future-correction", e)

old_fut = rec(source_id="fm3", published_at=FUT)
e, *_ = classify("edgar_8k", old_fut, "new", FUT, False, False, RT)
assert e == "REJECTED", ("future-beats-everything", e)
print("ok future-matrix")

# 18. cross-accession amendment: different IDs, no fabricated linkage
con = fresh()
base = rec(source_id="urn:acc-123", title="8-K ACME (0001234)",
           text="<br>Item 2.02: Results", published_at="2026-09-18T16:00:00+00:00")
v1, _, _, ro1 = ingest_signal(con, base, RT)
amd = rec(source_id="urn:acc-456", title="8-K/A ACME (0001234)",
          text="<br>Item 2.02: Restated", published_at="2026-09-18T17:00:00+00:00")
v2, _, _, ro2 = ingest_signal(con, amd, RT)
# different source_id, no prior under amendment id: verdict is new (honest),
# revision_of is None (never fabricated)...
assert (v1, v2) == ("new", "new"), (v1, v2)
assert ro2 is None, ro2
# ...but eligibility still refuses candidacy for the unlinked amendment
e, eff, *_ = classify("edgar_8k", amd, v2, "2026-09-18T17:00:00+00:00",
                      False, True, RT)
assert e == "CONTEXT" and (eff or {}).get("amendment_unlinked") is True, (e, eff)
print("ok cross-accession-amendment")

# 19. pinned reference time makes archaeology deterministic
import classify as C  # noqa: E402
C.REF["t"] = "2026-09-20T00:00:00+00:00"
assert C.is_archaeology("2026-09-10T00:00:00+00:00") is True
assert C.is_archaeology("2026-09-19T12:00:00+00:00") is False
assert C.is_fresh("2026-09-19T23:50:00+00:00", "edgar_8k") is True
assert C.is_fresh("2026-09-19T23:00:00+00:00", "edgar_8k") is False
C.REF["t"] = None
print("ok pinned-reference-time")

print("ALL CORRECTIVE CHECKS PASS")

# 20. canonical record allowlist: unknown keys rejected, never carried
assert validate_record(dict(rec(), evil_field="x")).startswith("unknown-field")
assert validate_record(rec()) is None
print("ok record-allowlist")

# 21. corrections idempotent under UNIQUE(source, amending_id, base_id)
con = fresh()
con.execute("INSERT OR IGNORE INTO corrections VALUES(?,?,?,?)",
            ("edgar_8k", "a/A", "a", "t"))
con.execute("INSERT OR IGNORE INTO corrections VALUES(?,?,?,?)",
            ("edgar_8k", "a/A", "a", "t"))
n = con.execute("SELECT COUNT(*) FROM corrections").fetchone()[0]
assert n == 1, n
print("ok corrections-unique")

# 22. exhaustive field typing: every allowlisted field is type-gated
assert validate_record(dict(rec(), updated_at=123)) == "bad-type-updated_at"
assert validate_record(dict(rec(), updated_at="2026-09-18T18:00:00+00:00")) is None
assert validate_record(dict(rec(), published_estimated="yes")) == \
    "bad-type-published_estimated"
assert validate_record(dict(rec(), published_estimated=True)) is None
assert validate_record(dict(rec(), has_external_link=1)) == \
    "bad-type-has_external_link"
assert validate_record(dict(rec(), word_count="lots")) == "bad-type-word_count"
assert validate_record(dict(rec(), links="http://x")) == "bad-type-links"
assert validate_record(dict(rec(), links=["http://x"])) is None
print("ok exhaustive-types")

# 23. revision tie-break: same first_seen_at -> rowid decides, always.
# Insert B (hash-high) first, A (hash-low) second, identical timestamps;
# a third revision must link to the later-INSERTED row (A), not the
# lexicographically-smaller hash. Without ORDER BY ... rowid this is
# SQLite's unspecified order.
con = fresh()
TS = "2026-09-18T18:00:00+00:00"
rb = rec(source_id="tie1", text="Item 8.01 version BRAVO zzz")
ra = rec(source_id="tie1", text="Item 8.01 version ALPHA aaa")
vb, hb, _, _ = ingest_signal(con, rb, TS)
va, ha, _, _ = ingest_signal(con, ra, TS)
assert (vb, va) == ("new", "revision"), (vb, va)
rc = rec(source_id="tie1", text="Item 8.01 version CHARLIE mmm")
vc, _, _, rev_of = ingest_signal(con, rc, TS)
assert vc == "revision" and rev_of == ha, (vc, rev_of)
print("ok revision-tiebreak")

# 24. temporal ordering: published <= observed <= retrieved enforced.
RET = "2026-09-18T18:00:00+00:00"
assert temporal_violation(rec(), RET) is None  # sane fixture passes
assert temporal_violation(
    dict(rec(), observed_at="2026-09-18T19:00:00+00:00"),
    RET) == "observed-in-future"
assert temporal_violation(
    dict(rec(), published_at="2026-09-18T17:30:00+00:00",
         observed_at="2026-09-18T17:00:00+00:00"),
    RET) == "published-after-observed"
# absent publication (estimated) only checks observed <= retrieved
assert temporal_violation(dict(rec(), published_at=None), RET) is None
print("ok temporal-ordering")
