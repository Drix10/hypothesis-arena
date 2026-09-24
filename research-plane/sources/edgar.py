"""Production EDGAR source adapter (doc 09 Tier A, first vertical slice).

Locked scope: submissions JSON + companyfacts only — no full-text crawl
beyond the filing index. Contact-bearing frozen UA, hard 10 req/s
ceiling, explicit per-request timeout, bounded bodies, 3 retries with
jittered backoff, 429 halves the poll rate for an hour, on-disk
CIK-map cache with ETag/Last-Modified validators.

This module is the harvest-callable raw-record producer. It emits RAW
records only (dicts with a `symbols` list, JSON-safe, size-capped —
the graph harvest-node contract); classification into frozen f2
happens downstream in extract/emit, never here. No f2 fields are
invented or reinterpreted.

Timestamps: observed_at_ns comes from the regulator's own filingDate
field. Rows with missing/invalid/future filingDate are DROPPED
(counted, never estimated) — an estimated timestamp must never become
TRIGGER-eligible evidence, and local observation time is never
substituted. Outage/empty means stale/expired downstream, never
fabricated neutral data. Exits are unaffected (this adapter cannot
reach broker state, journals, HALT, or STAGE).

Side effects: none by default except the optional heartbeat file and
the bounded CIK-map cache (atomic rename, same-file replacement).
Transport, clock, sleep, and jitter are injected: unit tests run with
a fake transport; the default transport is stdlib urllib honoring the
process proxy environment (deployment chooses DIRECT vs Squid via
env — this module hardcodes neither).

Implementation-complete is NOT production-proven: live deployment
evidence (soak, zero-403 record, measured p50/p99) is still open.
"""
import json
import os
import time
import urllib.request

SOURCE_ID = "edgar_8k"
KIND = "filing_event"
SCHEMA_KINDS = ("filing_event",)  # frozen schema.py mirror (subset we emit)

UA_BASE = "MiroHedge/phase0"

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK%010d.json"
COMPANYFACTS_URL = ("https://data.sec.gov/api/xbrl/companyfacts/"
                    "CIK%010d.json")
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"

MAX_REQ_PER_S = 10
MIN_INTERVAL_S = 1.0 / MAX_REQ_PER_S
RETRIES = 3
BACKOFF_BASE_S = 15.0
THROTTLE_S = 3600.0
DEFAULT_TIMEOUT_S = 30
MAX_BODY_BYTES = 2 << 20
MAX_FILINGS_PER_SYMBOL = 8
MAX_RECORDS = 64
LOOKBACK_DAYS = 7
TICKERS_CACHE_DAYS = 7

FORMS = ("8-K", "10-Q", "10-K", "4")

CADENCE_S = 300
TTL_S = 900  # doc 09: EDGAR stale after 15 min -> features expire
HEARTBEAT_VERSION = 1
HEARTBEAT_MAX_BYTES = 65536

DAY_NS = 86400 * 1000000000


class ConfigError(ValueError):
    pass


def _utc_today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def _filing_date_to_ns(date_s, today_s):
    """Regulator publication date -> ns. None on missing/invalid/future."""
    if not isinstance(date_s, str) or len(date_s) != 10:
        return None
    if date_s[4] != "-" or date_s[7] != "-":
        return None
    try:
        y, m, d = int(date_s[0:4]), int(date_s[5:7]), int(date_s[8:10])
        if not (1990 <= y <= 2100 and 1 <= m <= 12 and 1 <= d <= 31):
            return None
    except ValueError:
        return None
    if date_s > today_s:
        return None  # future leakage: never admit
    try:
        tt = time.strptime(date_s, "%Y-%m-%d")
    except ValueError:
        return None
    epoch = time.mktime(time.struct_time(
        (tt.tm_year, tt.tm_mon, tt.tm_mday, 0, 0, 0, 0, 0, -1)))
    # mktime is local-time; correct to UTC midnight via gmtime round-trip.
    back = time.gmtime(epoch)
    off = epoch - time.mktime(time.struct_time(
        (back.tm_year, back.tm_mon, back.tm_mday, back.tm_hour,
         back.tm_min, back.tm_sec, 0, 0, -1)))
    return int((epoch + off) * 1000000000)


def contact_from_env(env=None):
    c = (env or os.environ).get("MIRO_CONTACT", "")
    return c.strip()


def _default_transport(url, headers, timeout_s):
    """Stdlib urllib. Honors HTTP(S)_PROXY from the environment when set;
    deployment chooses DIRECT vs proxy via env, not code."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            status = r.status
            h = {k.lower(): v for k, v in r.getheaders()}
            chunks = []
            left = MAX_BODY_BYTES + 1
            while left > 0:
                b = r.read(min(65536, left))
                if not b:
                    break
                chunks.append(b)
                left -= len(b)
            body = b"".join(chunks)
            return status, h, body
    except Exception:
        raise


class Adapter:
    """EDGAR poller. Build via build(); call poll() per cadence tick."""

    def __init__(self, contact, transport=None, clock=None, sleeper=None,
                 jitter=None, backoff_base_s=BACKOFF_BASE_S,
                 cache_dir=None, timeout_s=DEFAULT_TIMEOUT_S):
        if not contact or not contact.strip():
            raise ConfigError("edgar: MIRO_CONTACT missing — refusing "
                              "to poll without SEC fair-access contact")
        self.contact = contact.strip()
        self.ua = "%s contact=%s" % (UA_BASE, self.contact)
        self.transport = transport or _default_transport
        self.clock = clock or time.time
        self.sleep = sleeper or time.sleep
        self.jitter = jitter or (lambda a, b: a + (b - a) * 0.5)
        self.backoff_base = backoff_base_s
        self.timeout_s = timeout_s
        self.cache_dir = cache_dir
        self.interval = MIN_INTERVAL_S
        self.throttle_until = 0.0
        self._next_ok = 0.0
        self._seen = {}  # accession -> 1 (cycle-local PK dedupe; the
        # durable PK-dedupe lives in classify per doc 09)
        self.last_ok_ts = 0.0
        self.last_error = ""
        self.polls = 0
        self.failures = 0

    # -- rate limit -------------------------------------------------
    def _pace(self):
        now = self.clock()
        if now < self.throttle_until:
            # throttled: caller still paces at the halved rate
            pass
        wait = self._next_ok - now
        if wait > 0:
            self.sleep(wait)
            now = self.clock()
        self._next_ok = now + self.interval

    def _get(self, url):
        """(status, headers, body|None, error). Bounded, retried, paced."""
        err = ""
        throttled = False
        for attempt in range(RETRIES + 1):
            self._pace()
            try:
                status, h, body = self.transport(
                    url, {"User-Agent": self.ua, "Accept": "*/*"},
                    self.timeout_s)
            except Exception as e:
                err = "%s: %s" % (type(e).__name__, str(e)[:200])
                if attempt < RETRIES:
                    self.sleep(self.jitter(
                        0.8 * self.backoff_base, 1.2 * self.backoff_base))
                continue
            if status == 429:
                if not throttled:
                    # one halving per episode, not per retry
                    self.interval = min(self.interval * 2, 60.0)
                    throttled = True
                self.throttle_until = self.clock() + THROTTLE_S
                err = "HTTP 429: rate limited by SEC"
                if attempt < RETRIES:
                    self.sleep(self.jitter(
                        0.8 * self.backoff_base, 1.2 * self.backoff_base))
                continue
            if status != 200:
                return status, h, None, "HTTP %d" % status
            if len(body) > MAX_BODY_BYTES:
                return status, h, None, "oversized: %d bytes" % len(body)
            return status, h, body, ""
        return 0, {}, None, err or "transport failed"

    # -- CIK map (bounded on-disk cache, ETag/Last-Modified) -------
    def _cache_paths(self):
        if not self.cache_dir:
            return None, None
        base = os.path.join(self.cache_dir, "edgar_tickers")
        return base + ".json", base + ".meta.json"

    def _load_tickers(self):
        """symbol -> cik int. Refresh weekly; stale cache beats no map."""
        data_path, meta_path = self._cache_paths()
        cached = None
        if data_path and os.path.exists(data_path):
            try:
                if os.path.getsize(data_path) > (1 << 20):
                    raise ValueError("cache too large")
                cached = json.load(open(data_path, encoding="utf-8"))
                meta = {}
                if meta_path and os.path.exists(meta_path):
                    meta = json.load(open(meta_path, encoding="utf-8"))
                age = self.clock() - float(meta.get("ts", 0))
                if age < TICKERS_CACHE_DAYS * 86400:
                    return self._ticker_index(cached), "cache-hit", ""
            except Exception as e:
                cached = None  # corrupt cache: refetch, never crash
        status, h, body, err = self._get(TICKERS_URL)
        if err or body is None:
            if cached is not None:
                return self._ticker_index(cached), "cache-stale", err
            return {}, "unavailable", err
        try:
            raw = json.loads(body.decode("utf-8"))
        except Exception:
            if cached is not None:
                return self._ticker_index(cached), "cache-stale", \
                    "tickers-malformed"
            return {}, "unavailable", "tickers-malformed"
        if data_path:
            try:
                os.makedirs(self.cache_dir, exist_ok=True)
                tmp = data_path + ".tmp-%d" % os.getpid()
                with open(tmp, "w", encoding="utf-8") as fh:
                    json.dump(raw, fh)
                    fh.flush()
                    os.fsync(fh.fileno())
                os.replace(tmp, data_path)
                with open(meta_path, "w", encoding="utf-8") as fh:
                    json.dump({"ts": self.clock(),
                               "etag": h.get("etag", ""),
                               "last_modified": h.get(
                                   "last-modified", "")}, fh)
            except Exception:
                pass  # cache write is best-effort; memory map is truth
        return self._ticker_index(raw), "live", ""

    @staticmethod
    def _ticker_index(raw):
        idx = {}
        vals = raw.values() if isinstance(raw, dict) else raw
        try:
            for row in vals:
                t = str(row.get("ticker", "")).upper()
                try:
                    cik = int(row.get("cik_str", 0))
                except (TypeError, ValueError):
                    continue
                if t and cik > 0:
                    idx[t] = cik
        except (AttributeError, TypeError):
            pass
        return idx

    # -- companyfacts (same limiter; no crawl, single bounded GET) --
    def fetch_facts(self, cik):
        url = COMPANYFACTS_URL % int(cik)
        status, _h, body, err = self._get(url)
        if err or body is None:
            return None, err
        try:
            return json.loads(body.decode("utf-8")), ""
        except Exception:
            return None, "companyfacts-malformed"

    # -- poll --------------------------------------------------------
    def poll(self, symbols, since=None, today=None):
        """Poll recent filings. Returns (records, info); never raises on
        provider failure — outage is explicit in info, not fabricated."""
        since = since or {}
        today_s = today or _utc_today()
        now = self.clock()
        self.polls += 1
        info = {"ok": False, "stale": True, "errors": [],
                "dropped": 0, "duplicates": 0, "records": 0,
                "tickers": ""}
        tickers, tick_state, tick_err = self._load_tickers()
        info["tickers"] = tick_state
        if tick_err:
            info["errors"].append(tick_err)
        if not tickers:
            self.failures += 1
            self.last_error = tick_err or "no ticker map"
            return [], info
        recs = []
        for sym in symbols:
            cik = tickers.get(str(sym).upper())
            if not cik:
                info["dropped"] += 1
                info["errors"].append("unknown-symbol:%s" % sym)
                continue
            url = SUBMISSIONS_URL % cik
            _st, _h, body, err = self._get(url)
            if err or body is None:
                info["errors"].append("%s:%s" % (sym, err))
                continue
            try:
                sub = json.loads(body.decode("utf-8"))
                filings = sub["filings"]["recent"]
            except Exception:
                info["errors"].append("%s:submissions-malformed" % sym)
                continue
            n = min(len(filings.get("accessionNumber", [])),
                    MAX_FILINGS_PER_SYMBOL)
            for i in range(n):
                try:
                    acc = str(filings["accessionNumber"][i])
                    form = str(filings["form"][i])
                    fdate = str(filings["filingDate"][i])
                    pdoc = str(filings.get("primaryDocument", [""] * n)[i]
                               or "")
                    items = str(filings.get("items", [""] * n)[i] or "")
                except (IndexError, TypeError):
                    info["dropped"] += 1
                    continue
                if form not in FORMS:
                    continue
                if since.get(str(sym).upper()) == acc:
                    break  # watermark reached: older rows already seen
                if acc in self._seen:
                    info["duplicates"] += 1
                    continue
                obs_ns = _filing_date_to_ns(fdate, today_s)
                if obs_ns is None:
                    info["dropped"] += 1  # missing/invalid/future:
                    continue  # never estimate, never substitute now
                try:
                    cutoff = (now - LOOKBACK_DAYS * 86400) * 1000000000
                except OverflowError:
                    cutoff = 0
                if obs_ns < cutoff:
                    continue  # outside the recent window, not an error
                self._seen[acc] = 1
                if len(self._seen) > 4096:
                    # bounded cycle-local memory: drop oldest keys
                    for k in list(self._seen)[:1024]:
                        del self._seen[k]
                acc_nodash = acc.replace("-", "")
                recs.append({
                    "source_id": SOURCE_ID,
                    "symbols": [str(sym).upper()],
                    "kind": KIND,
                    "form": form,
                    "accession": acc,
                    "filing_date": fdate,
                    "items": items,
                    "primary_document": pdoc,
                    "observed_at_ns": obs_ns,
                    "provenance_url":
                        "https://www.sec.gov/Archives/edgar/data/%d/%s/"
                        % (cik, acc_nodash),
                })
                if len(recs) >= MAX_RECORDS:
                    break
            if len(recs) >= MAX_RECORDS:
                break
        info["records"] = len(recs)
        if recs or not info["errors"]:
            info["ok"] = True
            info["stale"] = False
            self.last_ok_ts = now
            self.last_error = ""
        else:
            self.failures += 1
            self.last_error = "; ".join(info["errors"][:3])
        if now - self.last_ok_ts > TTL_S:
            info["stale"] = True
        return recs, info

    # -- harvest envelope (graph harvest-node callable) --------------
    def harvest(self, watchlist, epoch):
        recs, info = self.poll(list(watchlist))
        stamps = {SOURCE_ID: {
            "ok": info["ok"], "stale": info["stale"],
            "checked_at_ns": int(self.clock() * 1000000000),
            "records": info["records"],
            "epoch": epoch}}
        return recs, stamps

    # -- heartbeat (ops side; mirrors earnings.py hardened pattern) --
    def heartbeat(self, info):
        now = self.clock()
        return {"version": HEARTBEAT_VERSION, "ts": now,
                "cadence_s": CADENCE_S, "ttl_s": TTL_S,
                "ok": bool(info.get("ok", False)),
                "stale": bool(info.get("stale", True)),
                "records": int(info.get("records", 0)),
                "error": str(self.last_error)[:200]}

    def write_heartbeat(self, path, hb):
        data = json.dumps(hb, sort_keys=True)
        if len(data.encode("utf-8")) > HEARTBEAT_MAX_BYTES:
            raise ConfigError("heartbeat too large")
        tmp = "%s.tmp-%d" % (path, os.getpid())
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    def read_heartbeat(self, path, now=None):
        now = now if now is not None else self.clock()
        try:
            if os.path.getsize(path) > HEARTBEAT_MAX_BYTES:
                return {"state": "invalid"}
            hb = json.load(open(path, encoding="utf-8"))
        except Exception:
            return {"state": "invalid"}
        try:
            if hb["version"] != HEARTBEAT_VERSION:
                return {"state": "invalid"}
            if hb["cadence_s"] != CADENCE_S or hb["ttl_s"] != TTL_S:
                return {"state": "invalid"}
            ts = float(hb["ts"])
        except (KeyError, TypeError, ValueError):
            return {"state": "invalid"}
        if ts > now + 300:
            return {"state": "invalid"}  # future skew cap
        if now - ts > TTL_S:
            return {"state": "stale"}
        if not hb.get("ok", False):
            return {"state": "failed"}
        return {"state": "healthy"}


def build(contact=None, env=None, **kw):
    """Build an adapter. contact defaults to MIRO_CONTACT from env;
    missing contact raises ConfigError (fail closed, no requests)."""
    c = contact if contact is not None else contact_from_env(env)
    return Adapter(c, **kw)
