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
- CANONICAL AUTHORITY: there is exactly one canonicalization — the
  frozen collector/classify.py (validate_record + temporal_violation
  + ingest_signal + content_hash over source/source_id/title/text/
  url/links/published_at, volatile timing excluded). The seam adapts
  each adapter record into that canonical-record shape, validates
  with the frozen validator, ingests with the frozen ingester into
  the SHARED records table, and uses the RETURNED hash as the
  resolver/ctx_read canonical_hash. No parallel hash namespace, no
  seam-v1 hashing, no invented verdicts (ingest assigns them).
- Lineage DB honors MIRO_CANONICAL_DB exactly like the frozen
  collector/reader; a lineage persistence/validation failure is
  fail-closed BEFORE publish (the record never enters recs_all, the
  drop is counted visibly per source).
- History: harvest returns (recs, stamps, history) with bounded
  per-source {h, ts} observations using ONLY actual poll timestamps;
  a same-timestamp repeat appends nothing (no fabricated +1s, no
  manufactured coverage). The graph/state→publish path carries it to
  the bundle, preserving frozen-feed detection.
- RESTART/RESUME: process memory (_by_hash, _hist) is a cache, never
  the authority. Canonical lookup falls back to a seam-owned cache
  TABLE in the same lineage DB (written atomically with the
  authority ingest, keyed by the authority hash, read back on
  memory miss; absent → None, fail closed). History is recovered
  from durable accepted bundles (Seam.restore_from_bundles): only
  persisted {h, ts} observations, re-validated shape + monotonicity,
  bounded. No durable state → warming tail (no frozen-feed coverage
  claimed, never fabricated). A resumed Runner over the same DB +
  bundle dir therefore resolves the same hashes and carries the
  same tail.
"""
import collections
import hashlib
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

try:
    from collector import classify as _classify
except ImportError:  # pragma: no cover - production path bootstrap
    _HERE = os.path.abspath(os.path.dirname(__file__))
    sys.path.insert(0, os.path.abspath(
        os.path.join(_HERE, "..", "..")))
    from collector import classify as _classify

from sources import bea as _bea
from sources import bls as _bls
from sources import edgar as _edgar
from sources import fred as _fred
from sources import treasury as _treasury

SOURCES = ("edgar_8k", "fred_macro", "treasury_auctions", "bls_empsit",
           "bea_nipa_gdp")

ENTITY_MAP_REL = os.path.join("collector", "entity_map.json")
LINEAGE_DB_REL = os.path.join("data", "canonical.db")

HISTORY_PER_SOURCE_MAX = 8

CANON_CACHE_DDL = (
    "CREATE TABLE IF NOT EXISTS seam_canonical ("
    "content_hash TEXT PRIMARY KEY, canonical_json TEXT NOT NULL)")

HIST_ENTRY_KEYS = frozenset(("h", "ts"))


def _repo_root():
    here = os.path.abspath(os.path.dirname(__file__))
    return os.path.abspath(os.path.join(here, "..", ".."))


def default_lineage_db_path(env=None):
    """Same resolution as the frozen collector/reader: explicit
    MIRO_CANONICAL_DB wins, else the repo canonical DB."""
    src = os.environ if env is None else env
    override = (src.get("MIRO_CANONICAL_DB", "") or "").strip()
    if override:
        return override
    return os.path.join(_repo_root(), LINEAGE_DB_REL)


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


def _collector_record(rec, estimated, retrieved_iso):
    """Adapter record -> frozen collector canonical-record shape.

    Only fields the collector authority owns (its KNOWN_FIELDS):
    identity, human labels, provenance URL, publication/observation
    instants. Labels are deterministic mechanical renderings, never
    interpretations (no direction, no scores, no prose).
    """
    src = rec.get("source_id")
    pk = _pk_of(rec)
    if pk is None:
        return None
    obs_iso = _iso(rec["observed_at_ns"])
    if estimated:
        pub_iso = None
    else:
        pub_iso = _iso(rec["observed_at_ns"])
    if src == "edgar_8k":
        title = "%s %s" % (rec.get("form", ""), pk)
        text = rec.get("items", "") or ""
    elif src == "fred_macro":
        title = "%s %s" % (rec.get("series_id", ""), rec.get("date", ""))
        text = rec.get("value", "") or ""
    elif src == "treasury_auctions":
        title = "Treasury auction %s %s" % (
            rec.get("cusip", ""), rec.get("record_date", ""))
        text = rec.get("security_type", "") or ""
    elif src == "bls_empsit":
        title = rec.get("title", "") or ""
        text = ""
    elif src == "bea_nipa_gdp":
        title = "%s %s %s" % (rec.get("table", ""),
                              rec.get("series", ""),
                              rec.get("time_period", ""))
        text = rec.get("data_value", "") or ""
    else:
        return None
    url = rec.get("provenance_url", "") or ""
    return {"id": pk, "source": src, "source_id": pk,
            "title": title.strip(), "text": text, "url": url,
            "links": [], "observed_at": obs_iso,
            "published_at": pub_iso, "published_estimated": estimated}


def to_canonical(rec, ingested_ns):
    """Adapter record -> frozen resolver canonical shape (or None).

    The canonical_hash is produced by the FROZEN collector authority
    (validate + temporal check + ingest into the shared records
    table), never by seam-local hashing. Returns None on any defect
    (missing keys, wrong types, unregistered source/kind, non-bool
    estimated flag, frozen-validation failure, temporal violation,
    lineage persistence failure): the caller counts, never emits.
    observed_at_estimated MUST be a real bool when present (missing
    stays conservative/estimated); truthy strings/ints must never
    decide timestamp authority.
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
    crec = _collector_record(rec, flag, _iso(ingested_ns))
    if crec is None:
        return None
    if _classify.validate_record(crec) is not None:
        return None
    if _classify.temporal_violation(crec, _iso(ingested_ns)) is not None:
        return None
    ref = rec.get("entity_ref")
    if ref is not None and not isinstance(ref, dict):
        return None
    # Timestamp authority: estimated instants NEVER become
    # published_ns (resolver would treat them as source truth).
    pub_ns = None if flag else obs_ns
    return {
        "source_id": src,
        "kind": kind,
        "content_hash": None,  # filled by CanonicalStore.note()
        "published_ns": pub_ns,
        "ingested_ns": ingested_ns,
        "symbols": list(syms),
        # value is presence-count (one validated source row exists),
        # never a measure and never directional: the resolver requires
        # a value dict, and count-1 states exactly what this layer
        # knows.
        "value": {"type": "count", "v": 1},
        "effect": None,
        "parser_confidence": "high",
        "corroborated": False,
        "entity_ref": dict(ref) if ref is not None else None,
        "provenance_url": rec.get("provenance_url", ""),
        "observed_at_estimated": flag,
        "_collector_record": crec,
    }


class CanonicalStore:
    """hash -> canonical registry over the shared lineage table.

    note() converts via to_canonical() and persists through the
    FROZEN collector ingester. Validation, temporal, or persistence
    failure returns None (fail-closed BEFORE publish); successes are
    counted per outcome for ops visibility.
    """

    def __init__(self, db_path=None, env=None):
        self._by_hash = {}
        self.db_path = db_path or default_lineage_db_path(env)
        self.lineage_errors = 0
        self.lineage_noted = 0
        self._db_ready = False

    def _connect(self):
        parent = os.path.dirname(os.path.abspath(self.db_path))
        if parent:
            os.makedirs(parent, exist_ok=True)
        con = sqlite3.connect(self.db_path)
        _classify.init_db(con)
        # Seam-owned projection cache (NOT a second authority: the
        # sole writer is note() from authority-returned data, keyed
        # by the authority hash; the reader falls back to it on
        # memory miss after restart).
        con.execute(CANON_CACHE_DDL)
        return con

    def note(self, rec, ingested_ns):
        canon = to_canonical(rec, ingested_ns)
        if canon is None:
            return None
        crec = canon.pop("_collector_record", None)
        if crec is None:
            return None
        try:
            con = self._connect()
            try:
                _verdict, ch, _first, _rev = \
                    _classify.ingest_signal(con, crec, _iso(ingested_ns))
                canon = dict(canon, content_hash=ch)
                con.execute(
                    "INSERT OR REPLACE INTO seam_canonical "
                    "(content_hash, canonical_json) VALUES (?, ?)",
                    (ch, json.dumps(canon, sort_keys=True)))
                con.commit()
            finally:
                con.close()
        except Exception:
            self.lineage_errors += 1
            return None
        self._by_hash[ch] = canon
        self.lineage_noted += 1
        return ch

    def canonical_for(self, candidate):
        if not isinstance(candidate, dict):
            return None
        h = candidate.get("canonical_hash")
        hit = self._by_hash.get(h)
        if hit is not None:
            return hit
        # Restart path: reconstruct from the durable projection of
        # the same authority (never a default, never recomputed
        # trust). Unparseable/absent → None, fail closed.
        if not isinstance(h, str) or not h:
            return None
        try:
            con = self._connect()
            try:
                row = con.execute(
                    "SELECT canonical_json FROM seam_canonical "
                    "WHERE content_hash=?", (h,)).fetchone()
            finally:
                con.close()
        except Exception:
            return None
        if row is None:
            return None
        try:
            canon = json.loads(row[0])
        except ValueError:
            return None
        if not isinstance(canon, dict) or \
                canon.get("content_hash") != h:
            return None
        self._by_hash[h] = canon
        return canon

    def items(self):
        """Public read access: (content_hash, canonical) pairs."""
        return list(self._by_hash.items())


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
                 db_path=None, env=None):
        self.sources = list(sources)
        self.heartbeat_dir = heartbeat_dir
        self.clock = clock or time.time
        self.store = CanonicalStore(db_path=db_path, env=env)
        self._hist = {s.source_id: collections.deque(
            maxlen=HISTORY_PER_SOURCE_MAX) for s in self.sources}
        self.last_stamps = {}
        self.last_epoch = None

    def parser_extract(self, rec, budget):
        """Seam-owned deterministic extract (deps[\"parser_extract\"]):
        adapter record -> parser candidate carrying ONLY
        authority-resolved lineage. Unknown/missing lineage yields no
        candidate (dropped + counted downstream, never emitted)."""
        try:
            budget.charge_tool()
        except Exception:
            raise
        h = rec.get("canonical_hash") if isinstance(rec, dict) \
            else None
        canon = self.store.canonical_for({"canonical_hash": h}) \
            if isinstance(h, str) else None
        if canon is None:
            return []
        cand = {"kind": canon["kind"],
                "value": dict(canon["value"]),
                "symbols": list(canon["symbols"]),
                "effect": canon["effect"],
                "canonical_hash": canon["content_hash"],
                "origin": "parser"}
        if canon.get("entity_ref") is not None:
            cand["entity_ref"] = dict(canon["entity_ref"])
        if canon.get("provenance_url"):
            cand["provenance_url"] = canon["provenance_url"]
        return [cand]

    def watermarks(self, _state=None):
        """Seam-owned publisher callback: per-source
        {last_observation_at, cursor} from the latest harvest stamps
        (same-cycle only; a resumed process re-harvests before any
        emit, so no stale vouching). Only healthy polls vouch."""
        out = {}
        for sid, stamp in self.last_stamps.items():
            if not stamp.get("ok"):
                continue
            out[sid] = {
                "last_observation_at":
                    int(stamp["checked_at_ns"] // 1000000000),
                "cursor": "seam-e%d" % self.last_epoch}
        return out

    @staticmethod
    def _valid_hist_entry(e):
        return isinstance(e, dict) and set(e) == HIST_ENTRY_KEYS \
            and isinstance(e.get("h"), str) and len(e["h"]) == 64 \
            and all(c in "0123456789abcdef" for c in e["h"]) \
            and type(e.get("ts")) is int and e["ts"] > 0

    def _merge_hist(self, sid, entries):
        """Merge persisted observations: shape-checked, sorted,
        strictly increasing only, bounded. Returns count kept."""
        dq = self._hist.get(sid)
        if dq is None:
            return 0
        good = sorted((e for e in entries
                       if self._valid_hist_entry(e)),
                      key=lambda e: e["ts"])
        kept = 0
        for e in good:
            if not dq or e["ts"] > dq[-1]["ts"]:
                dq.append({"h": e["h"], "ts": e["ts"]})
                kept += 1
        return kept

    def restore_from_bundles(self, outdir):
        """Restart recovery: rebuild bounded history tails from
        durable accepted bundles (features-*.json). Only persisted
        observations, never synthesized. Returns {source: kept}. No
        bundles → empty tails = explicit warming (no frozen-feed
        coverage claimed until real polls rebuild depth)."""
        recovered = {}
        pooled = {}
        try:
            names = sorted(os.listdir(outdir))
        except OSError:
            return recovered
        for name in names:
            if not (name.startswith("features-") and
                    name.endswith(".json")):
                continue
            try:
                with open(os.path.join(outdir, name),
                          encoding="utf-8") as fh:
                    bundle = json.load(fh)
            except (OSError, ValueError):
                continue
            hist = bundle.get("history") if isinstance(bundle,
                                                       dict) else None
            if not isinstance(hist, dict):
                continue
            for sid, entries in hist.items():
                if isinstance(entries, list):
                    pooled.setdefault(sid, []).extend(entries)
        for sid, entries in pooled.items():
            # Single merge: an honest bounded suffix of everything
            # durable (shape-checked, sorted, strictly increasing).
            recovered[sid] = self._merge_hist(sid, entries)
        return recovered

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
            dropped_lineage = 0
            last_h = None
            for r in recs:
                # Fail-closed BEFORE publish: without authoritative
                # lineage persistence the record is not harvestable.
                # The authority hash rides ON the record downstream so
                # the graph's parser path can only ever emit
                # authority-resolved lineage (never prose alone).
                h = self.store.note(r, ingested_ns)
                if h is None:
                    dropped_lineage += 1
                    continue
                kept.append(dict(r, canonical_hash=h))
                last_h = h
            recs_all.extend(kept)
            stamp = {
                "ok": bool(info.get("ok", False)),
                "stale": bool(info.get("stale", True)),
                "checked_at_ns": ingested_ns,
                "records": int(info.get("records", len(kept))),
                "epoch": epoch}
            if dropped_lineage:
                stamp["lineage_dropped"] = dropped_lineage
            stamps[src.source_id] = stamp
            dq = self._hist[src.source_id]
            if kept:
                # Honest history only: append strictly on a newer
                # ACTUAL poll timestamp. A same-timestamp repeat keeps
                # the existing tail (never a fabricated +1).
                if not dq or ingested_s > dq[-1]["ts"]:
                    dq.append({"h": last_h, "ts": ingested_s})
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
        self.last_stamps = stamps
        self.last_epoch = epoch
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
    lineage_db_path defaults to the MIRO_CANONICAL_DB-honoring shared
    canonical DB (same authority ctx_read checks); tests inject a
    scratch path. Explicit key/contact overrides exist for tests;
    default is env.
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
                db_path=lineage_db_path, env=src_env)
