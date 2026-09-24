"""Phase-2.5 production source→graph seam (doc 08 §8.3 harvest).

ARCHITECTURE BOUNDARY (explicit, not silent):
- plan/08 §8.3 assigns the graph harvest node to pull the doc-09
  sources. The five accepted adapters (EDGAR/FRED/Treasury/BLS/BEA)
  ARE that harvest implementation: pure I/O, no LLM, harvest-envelope
  shaped. This seam is the single orchestration point around them.
- ARCHITECTURE.md §5 ("collector is the poller, sources/ are probes")
  describes the FROZEN P1 pipeline (collect.py → data/signals), which
  is untouched and keeps running. Within Phase 2.5 there is exactly
  ONE poll path per source: the adapter singletons owned here. No
  second poller is constructed anywhere on this path.
- Credentials live only in seam construction (env). Outage evidence
  travels via stamps + heartbeat files. Nothing here trades: this is
  not the hot path, and exits never depend on it.

Contents:
- build_seam(...) -> Seam: constructs/owns the five adapters once.
  A keyed source without credentials (or EDGAR without contact) is
  recorded misconfigured: its stamp fails closed every cycle, other
  sources poll on, harvest never crashes.
- Seam.harvest(watchlist, epoch) -> (recs, stamps): fans out to owned
  adapters with per-source isolation (one source's exception becomes
  its failed stamp). EDGAR receives only watchlist symbols present in
  the pinned map (unmapped symbols would poison its health); with no
  mappable symbol EDGAR is not scheduled (no stamp, not a failure).
  Heartbeats are written per poll when heartbeat_dir is set.
- to_canonical(rec, ingested_ns) -> dict | None: maps one adapter
  record onto the frozen resolver canonical shape. published_ns is
  the adapter instant ONLY when the adapter marks it non-estimated
  (EDGAR authoritative acceptance); estimated timestamps ALWAYS map
  to None + permanent R12 cap (copying an estimate into published_ns
  would wrongly earn source trust). effect=None (unknown downstream;
  no directional invention); value is presence-count (one validated
  row exists), never a measure; content_hash = sha256 of the
  canonical adapter bytes (single-source lineage).
- CanonicalStore: hash -> canonical registry + canonical_for() for
  publish.resolve_emit deps. note() ingests harvest records.
"""
import hashlib
import json
import os
import time

from sources import bea as _bea
from sources import bls as _bls
from sources import edgar as _edgar
from sources import fred as _fred
from sources import treasury as _treasury

SOURCES = ("edgar_8k", "fred_macro", "treasury_auctions", "bls_empsit",
           "bea_nipa_gdp")

ENTITY_MAP_REL = os.path.join("collector", "entity_map.json")


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


def to_canonical(rec, ingested_ns):
    """Adapter record -> frozen resolver canonical shape (or None).

    Returns None on any defect (missing keys, wrong types,
    unregistered source/kind): the caller counts, never emits.
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
    # Timestamp authority: estimated instants NEVER become
    # published_ns (resolver would treat them as source truth).
    estimated = rec.get("observed_at_estimated", True)
    pub_ns = None if estimated else obs_ns
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
        "observed_at_estimated": bool(estimated),
    }


class CanonicalStore:
    """hash -> canonical registry; canonical_for() for resolve_emit."""

    def __init__(self):
        self._by_hash = {}

    def note(self, rec, ingested_ns):
        canon = to_canonical(rec, ingested_ns)
        if canon is None:
            return None
        self._by_hash[canon["content_hash"]] = canon
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
    def __init__(self, sources, heartbeat_dir=None, clock=None):
        self.sources = list(sources)
        self.heartbeat_dir = heartbeat_dir
        self.clock = clock or time.time
        self.store = CanonicalStore()

    def harvest(self, watchlist, epoch):
        recs_all = []
        stamps = {}
        ingested_ns = int(self.clock() * 1000000000)
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
            for r in recs:
                self.store.note(r, ingested_ns)
            recs_all.extend(recs)
            stamps[src.source_id] = {
                "ok": bool(info.get("ok", False)),
                "stale": bool(info.get("stale", True)),
                "checked_at_ns": ingested_ns,
                "records": int(info.get("records", len(recs))),
                "epoch": epoch}
            if self.heartbeat_dir:
                try:
                    hb = src.adapter.heartbeat(info)
                    src.adapter.write_heartbeat(
                        os.path.join(self.heartbeat_dir,
                                     src.source_id + ".json"), hb)
                except Exception:
                    pass
        return recs_all, stamps


def _edgar_poll(adapter, watchlist, sym_to_cik):
    syms = [s for s in watchlist
            if isinstance(s, str) and s.upper() in sym_to_cik]
    if not syms:
        return [], {"skipped": True}
    return adapter.poll(syms)


def build_seam(env=None, heartbeat_dir=None, clock=None,
               transports=None, entity_map_path=None,
               contact=None, fred_key=None, bea_id=None):
    """Construct + own the five adapters once. Never raises for a
    misconfigured source: the failure becomes its stamp, fail-closed.
    Explicit key/contact overrides exist for tests; default is env.
    """
    src_env = os.environ if env is None else env
    clock = clock or time.time
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
        kw.setdefault("sleeper", lambda d: None)
        kw.setdefault("jitter", lambda a, b: 0.0)
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
    for sid, mod in (("treasury_auctions", _treasury),
                     ("bls_empsit", _bls)):
        try:
            ad = mod.Adapter(**common(sid.split("_")[0]))
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
    return Seam(sources, heartbeat_dir=heartbeat_dir, clock=clock)
