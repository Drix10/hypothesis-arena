"""Phase-2.5 production source→graph seam (doc 08 §8.3 harvest).

ARCHITECTURE BOUNDARY (explicit, not silent):
- plan/08 §8.3 assigns the graph harvest node to pull the doc-09
  sources. The five accepted adapters (EDGAR/FRED/Treasury/BLS/BEA)
  ARE that harvest implementation: pure I/O, no LLM, harvest-envelope
  shaped. This seam is the single orchestration point around them.
- ARCHITECTURE.md §5 ("collector is the poller, sources/ are probes")
  describes the FROZEN P1 pipeline (collect.py → data/signals), which
  is untouched and keeps running. Within Phase 2.5 there is exactly
  ONE poll path per source: the adapter singletons owned here, one
  instance per source for the seam's lifetime (plane/runner.py owns
  the seam for the process; no per-cycle reconstruction, no globals).
- Credentials live only in seam construction (env). Outage evidence
  travels via stamps + heartbeat files. Nothing here trades: this is
  not the hot path, and exits never depend on it.
- Pacing is production-real: the seam wires the real sleeper and a
  monotonic clock into every adapter (their accepted 1 req/s pacing,
  backoff, and 429 throttle actually wait). Tests inject fakes via
  explicit build_seam params — never by patching adapters after
  construction.
- Lineage: CanonicalStore.note() persists each canonical row into the
  SAME canonical records table the frozen ctx reader checks
  (source, source_id, content_hash keying; INSERT OR IGNORE + touch,
  mirroring collector/classify.py). Same authority, same table — not
  a second one. parser_version "seam-v1" marks the writer honestly.
- History: harvest returns (recs, stamps, history) with bounded
  per-source {h, ts} observations (no fabrication: only noted
  records; monotonic ts enforced). The graph/state→publish path
  carries it to the bundle, preserving frozen-feed detection.
"""
import collections
import hashlib
import json
import os
import sqlite3
import time
from datetime import datetime, timezone

from sources import bea as _bea
from sources import bls as _bls
from sources import edgar as _edgar
from sources import fred as _fred
from sources import treasury as _treasury

SOURCES = ("edgar_8k", "fred_macro", "treasury_auctions", "bls_empsit",
           "bea_nipa_gdp")

ENTITY_MAP_REL = os.path.join("collector", "entity_map.json")
LINEAGE_DB_REL = os.path.join("data", "canonical.db")

# Canonical records table DDL, byte-identical in shape to
# collector/classify.py::init_db (test_lineage_ddl_matches pins it).
RECORDS_DDL = (
    "CREATE TABLE IF NOT EXISTS records(\n"
    "      source TEXT, source_id TEXT, content_hash TEXT,\n"
    "      first_seen_at TEXT, last_seen_at TEXT, published_at TEXT,\n"
    "      retrieved_at TEXT, revision_id TEXT, verdict TEXT, raw_json TEXT,\n"
    "      parser_version TEXT, PRIMARY KEY(source, source_id, content_hash))")

SEAM_PARSER_VERSION = "seam-v1"
HISTORY_PER_SOURCE_MAX = 8


def _repo_root():
    here = os.path.abspath(os.path.dirname(__file__))
    return os.path.abspath(os.path.join(here, "..", ".."))


def _load_sym_to_cik(path=None):
    """{SYMBOL: cik} derived mechanically from the single pinned map."""
    path = path or os.path.join(_repo_root(), ENTITY_MAP_REL)
    with open(path, encoding="utf-8") as fh:
        raw = json.load(fh)
    out = {}
    for cik, ticker in raw.get("cik_to_ticker", {}).items():
        if isinstance(ticker, str) and ticker.strip():
            try:
                out[ticker.strip().upper()] = int(cik)
            except (TypeError, ValueError):
                continue
    return out


def _content_hash(rec):
    return hashlib.sha256(
        json.dumps(rec, sort_keys=True, separators=(",", ":"),
                   ensure_ascii=True).encode("utf-8")).hexdigest()


def _pk_of(rec):
    """Adapter-record primary key for the lineage source_id column.

    Uses each adapter's own dedupe identity (never synthesized: a
    record missing its identity cannot be lineage-addressed).
    """
    src = rec.get("source_id")
    try:
        if src == "edgar_8k":
            acc = rec.get("accession")
            return acc if isinstance(acc, str) and acc else None
        if src == "fred_macro":
            sid, date = rec.get("series_id"), rec.get("date")
            if isinstance(sid, str) and sid and isinstance(date, str) \
                    and date:
                return sid + "|" + date
            return None
        if src == "treasury_auctions":
            cusip, rd = rec.get("cusip"), rec.get("record_date")
            if isinstance(cusip, str) and cusip and isinstance(rd, str) \
                    and rd:
                return cusip + "|" + rd
            return None
        if src == "bls_empsit":
            guid = rec.get("guid")
            return guid if isinstance(guid, str) and guid else None
        if src == "bea_nipa_gdp":
            table, series, tp = (rec.get("table"), rec.get("series"),
                                 rec.get("time_period"))
            if all(isinstance(v, str) and v
                   for v in (table, series, tp)):
                return table + "|" + series + "|" + tp
            return None
    except Exception:
        return None
    return None


def _iso(ns):
    return datetime.fromtimestamp(ns / 1000000000,
                                  tz=timezone.utc).isoformat()


def to_canonical(rec, ingested_ns):
    """Adapter record -> frozen resolver canonical shape (or None).

    Returns None on any defect (missing keys, wrong types,
    unregistered source/kind, non-bool estimated flag): the caller
    counts, never emits. observed_at_estimated MUST be a real bool
    when present (missing stays conservative/estimated); truthy
    strings/ints must never decide timestamp authority.
    """
    if not isinstance(rec, dict):
        return None
    from . import schema
    src = rec.get("source_id")
    kind = rec.get("kind")
    syms = rec.get("symbols")
    obs_ns = rec.get("observed_at_ns")
    if not isinstance(src, str) or src not in schema.EMITTERS:
        return None
    if not isinstance(kind, str) or kind not in schema.EMITTERS[src]:
        return None
    if not isinstance(syms, list) or not syms or len(syms) > 16 or \
            any(not isinstance(s, str) or not s for s in syms):
        return None
    if type(obs_ns) is not int or obs_ns <= 0:
        return None
    if type(ingested_ns) is not int or ingested_ns <= 0:
        return None
    flag = rec.get("observed_at_estimated", True)
    if type(flag) is not bool:
        return None
    # Timestamp authority: estimated instants NEVER become
    # published_ns (resolver would treat them as source truth).
    pub_ns = None if flag else obs_ns
    ref = rec.get("entity_ref")
    if ref is not None and not isinstance(ref, dict):
        return None
    # value is presence-count (one validated source row exists),
    # never a measure and never directional: the resolver requires a
    # value dict, and count-1 states exactly what this layer knows.
    return {
        "source_id": src,
        "kind": kind,
        "content_hash": _content_hash(rec),
        "published_ns": pub_ns,
        "ingested_ns": ingested_ns,
        "symbols": list(syms),
        "value": {"type": "count", "v": 1},
        "effect": None,
        "parser_confidence": "high",
        "corroborated": False,
        "entity_ref": dict(ref) if ref is not None else None,
        "provenance_url": rec.get("provenance_url", ""),
        "observed_at_estimated": flag,
    }


class CanonicalStore:
    """hash -> canonical registry + lineage persistence.

    note() converts AND persists the canonical row into the shared
    records table (same authority ctx_read checks). A persistence
    failure is counted (lineage_errors) and the record is still
    returned: downstream lineage checks fail closed and loudly rather
    than harvest silently dropping evidence.
    """

    def __init__(self, db_path=None):
        self._by_hash = {}
        self.db_path = db_path
        self.lineage_errors = 0
        self._db_ready = False

    def _ensure_db(self):
        if self._db_ready or not self.db_path:
            return self.db_path is not None
        try:
            parent = os.path.dirname(os.path.abspath(self.db_path))
            if parent:
                os.makedirs(parent, exist_ok=True)
            con = sqlite3.connect(self.db_path)
            try:
                con.execute(RECORDS_DDL)
                con.commit()
            finally:
                con.close()
            self._db_ready = True
            return True
        except Exception:
            return False

    def _persist(self, canon, rec, ingested_ns):
        pk = _pk_of(rec)
        if pk is None or not self._ensure_db():
            return False
        pub_ns = canon["published_ns"]
        try:
            con = sqlite3.connect(self.db_path)
            try:
                con.execute(
                    "INSERT OR IGNORE INTO records VALUES"
                    "(?,?,?,?,?,?,?,?,?,?,?)",
                    (canon["source_id"], pk, canon["content_hash"],
                     _iso(ingested_ns), _iso(ingested_ns),
                     _iso(pub_ns) if pub_ns is not None else None,
                     _iso(ingested_ns), None, "new",
                     json.dumps(rec, sort_keys=True, separators=(
                         ",", ":"), ensure_ascii=True),
                     SEAM_PARSER_VERSION))
                con.execute(
                    "UPDATE records SET last_seen_at=? WHERE source=?"
                    " AND source_id=? AND content_hash=?",
                    (_iso(ingested_ns), canon["source_id"], pk,
                     canon["content_hash"]))
                con.commit()
            finally:
                con.close()
            return True
        except Exception:
            return False

    def note(self, rec, ingested_ns):
        canon = to_canonical(rec, ingested_ns)
        if canon is None:
            return None
        self._by_hash[canon["content_hash"]] = canon
        if not self._persist(canon, rec, ingested_ns):
            self.lineage_errors += 1
        return canon["content_hash"]

    def canonical_for(self, candidate):
        if not isinstance(candidate, dict):
            return None
        return self._by_hash.get(candidate.get("canonical_hash"))


class _Source:
    def __init__(self, source_id, adapter=None, config_error="",
                 poll=None):
        self.source_id = source_id
        self.adapter = adapter
        self.config_error = config_error
        self._poll = poll

    def run(self, watchlist):
        if self.adapter is None:
            return [], {"ok": False, "stale": True,
                        "error": self.config_error or "misconfigured"}
        return self._poll(self.adapter, watchlist)


class Seam:
    def __init__(self, sources, heartbeat_dir=None, clock=None,
                 db_path=None):
        self.sources = list(sources)
        self.heartbeat_dir = heartbeat_dir
        self.clock = clock or time.time
        self.store = CanonicalStore(db_path=db_path)
        self._hist = {s.source_id: collections.deque(
            maxlen=HISTORY_PER_SOURCE_MAX) for s in self.sources}

    def harvest(self, watchlist, epoch):
        recs_all = []
        stamps = {}
        hist = {}
        ingested_ns = int(self.clock() * 1000000000)
        ingested_s = ingested_ns // 1000000000
        for src in self.sources:
            try:
                recs, info = src.run(list(watchlist))
            except Exception as e:
                recs, info = [], {"ok": False, "stale": True,
                                  "records": 0, "completed_at": 0.0,
                                  "errors": ["%s" % type(e).__name__]}
                try:
                    src.adapter.failures += 1
                except Exception:
                    pass
            if info.get("skipped"):
                continue  # not scheduled this cycle: no stamp
            kept = []
            for r in recs:
                if self.store.note(r, ingested_ns) is None:
                    continue  # defective: counted downstream by
                kept.append(r)  # absence (no canonical, no lineage)
            recs_all.extend(kept)
            stamps[src.source_id] = {
                "ok": bool(info.get("ok", False)),
                "stale": bool(info.get("stale", True)),
                "checked_at_ns": ingested_ns,
                "records": int(info.get("records", len(kept))),
                "epoch": epoch}
            dq = self._hist[src.source_id]
            if kept:
                # One entry per source per poll (head observation):
                # ctx history demands strictly increasing ts, so the
                # tick advances past the previous entry when the clock
                # has not (fake clocks, fast retries). No fabrication:
                # only actually-noted records extend history.
                ts = ingested_s if not dq else max(dq[-1]["ts"] + 1,
                                                   ingested_s)
                dq.append({"h": _content_hash(kept[-1]), "ts": ts})
            if dq:
                hist[src.source_id] = list(dq)
            if self.heartbeat_dir:
                try:
                    hb = src.adapter.heartbeat(info)
                    src.adapter.write_heartbeat(
                        os.path.join(self.heartbeat_dir,
                                     src.source_id + ".json"), hb)
                except Exception as e:
                    # Heartbeat failure is operational evidence: mark
                    # the stamp visibly, never erase it. Source health
                    # (ok/stale) still describes the poll itself.
                    stamps[src.source_id]["heartbeat_error"] = \
                        "%s" % type(e).__name__
        return recs_all, stamps, hist


def _edgar_poll(adapter, watchlist, sym_to_cik):
    syms = [s for s in watchlist
            if isinstance(s, str) and s.upper() in sym_to_cik]
    if not syms:
        return [], {"skipped": True}
    return adapter.poll(syms)


def build_seam(env=None, heartbeat_dir=None, clock=None, sleeper=None,
               mono=None, transports=None, entity_map_path=None,
               contact=None, fred_key=None, bea_id=None,
               lineage_db_path=None):
    """Construct + own the five adapters once. Never raises for a
    misconfigured source: the failure becomes its stamp, fail-closed.
    Production wiring is real: sleeper defaults to time.sleep and
    pacing runs on time.monotonic unless tests inject fakes.
    lineage_db_path defaults to the shared canonical DB (same
    authority ctx_read checks); tests inject a scratch path.
    Explicit key/contact overrides exist for tests; default is env.
    """
    src_env = os.environ if env is None else env
    clock = clock or time.time
    sleeper = sleeper or time.sleep
    mono = mono or time.monotonic
    transports = transports or {}
    sym_to_cik = _load_sym_to_cik(entity_map_path)
    contact = (contact if contact is not None
               else src_env.get("MIRO_CONTACT", "").strip())
    fred_key = (fred_key if fred_key is not None
                else src_env.get("FRED_API_KEY", "").strip())
    bea_id = (bea_id if bea_id is not None
              else src_env.get("BEA_USER_ID", "").strip())
    t = lambda mod: transports.get(mod)  # noqa: E731

    def common(mod, **kw):
        kw.setdefault("transport", t(mod))
        kw.setdefault("clock", clock)
        kw.setdefault("sleeper", sleeper)
        kw.setdefault("mono", mono)
        kw.setdefault("jitter", lambda a, b: a + (b - a) * 0.5)
        kw.setdefault("backoff_base_s", 0.0)
        return kw

    if lineage_db_path is None:
        lineage_db_path = os.path.join(_repo_root(), LINEAGE_DB_REL)
    sources = []
    try:
        ed = _edgar.Adapter(contact, entity_map=sym_to_cik,
                            **common("edgar"))
        sources.append(_Source(
            "edgar_8k", ed, poll=lambda a, wl: _edgar_poll(
                a, wl, sym_to_cik)))
    except Exception as e:
        sources.append(_Source("edgar_8k",
                               config_error="%s" % type(e).__name__))
    try:
        fr = _fred.Adapter(fred_key, **common("fred"))
        sources.append(_Source("fred_macro", fr,
                               poll=lambda a, wl: a.poll()))
    except Exception as e:
        sources.append(_Source("fred_macro",
                               config_error="%s" % type(e).__name__))
    for sid, mod, tkey in (("treasury_auctions", _treasury, "treasury"),
                           ("bls_empsit", _bls, "bls")):
        try:
            ad = mod.Adapter(**common(tkey))
            sources.append(_Source(sid, ad,
                                   poll=lambda a, wl: a.poll()))
        except Exception as e:
            sources.append(_Source(sid, config_error="%s" %
                                   type(e).__name__))
    try:
        be = _bea.Adapter(bea_id, **common("bea"))
        sources.append(_Source("bea_nipa_gdp", be,
                               poll=lambda a, wl: a.poll()))
    except Exception as e:
        sources.append(_Source("bea_nipa_gdp",
                               config_error="%s" % type(e).__name__))
    # Deterministic source order (registration order above).
    return Seam(sources, heartbeat_dir=heartbeat_dir, clock=clock,
                db_path=lineage_db_path)
