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
import calendar
import json
import math
import os
import time
import urllib.error
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
MAX_RECORDS = 64
LOOKBACK_DAYS = 7
TICKERS_CACHE_DAYS = 7

FORMS = ("8-K", "10-Q", "10-K", "4")

CADENCE_S = 300
TTL_S = 900  # doc 09: EDGAR stale after 15 min -> features expire
HEARTBEAT_VERSION = 1
HEARTBEAT_MAX_BYTES = 65536

DAY_NS = 86400 * 1000000000
SKEW_ALLOW_S = 300

_HB_KEYS = frozenset(("version", "ts", "cadence_s", "ttl_s",
                       "ok", "stale", "records", "error"))

_tmp_seq = [0]


def _next_tmp_seq():
    _tmp_seq[0] += 1
    return _tmp_seq[0]


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
    # Exact UTC midnight: timegm, never locale-dependent mktime.
    return int(calendar.timegm(tt) * 1000000000)


def contact_from_env(env=None):
    c = (env or os.environ).get("MIRO_CONTACT", "")
    return c.strip()


def _read_capped(r):
    chunks = []
    left = MAX_BODY_BYTES + 1
    while left > 0:
        b = r.read(min(65536, left))
        if not b:
            break
        chunks.append(b)
        left -= len(b)
    return b"".join(chunks)


def _default_transport(url, headers, timeout_s):
    """Stdlib urllib. Honors HTTP(S)_PROXY from the environment when set;
    deployment chooses DIRECT vs proxy via env, not code.

    Boundary law: urlopen RAISES urllib.error.HTTPError for non-2xx
    responses — the status path in _get() is unreachable unless this
    function normalizes HTTPError back into (status, headers, body).
    Only genuine transport failures (timeout/DNS/refused) raise."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            h = {k.lower(): v for k, v in r.getheaders()}
            return r.status, h, _read_capped(r)
    except urllib.error.HTTPError as e:
        try:
            body = _read_capped(e)
        except Exception:
            body = b""
        try:
            h = {k.lower(): v for k, v in (e.headers.items() if
                                           e.headers else [])}
        except Exception:
            h = {}
        try:
            status = int(e.code)
        except (TypeError, ValueError):
            raise OSError("bad HTTP status: %r" % (e.code,))
        return status, h, body
    except Exception:
        raise


class Adapter:
    """EDGAR poller. Build via build(); call poll() per cadence tick."""

    def __init__(self, contact, transport=None, clock=None, sleeper=None,
                 jitter=None, backoff_base_s=BACKOFF_BASE_S,
                 cache_dir=None, timeout_s=DEFAULT_TIMEOUT_S, mono=None):
        if not contact or not contact.strip():
            raise ConfigError("edgar: MIRO_CONTACT missing — refusing "
                              "to poll without SEC fair-access contact")
        self.contact = contact.strip()
        self.ua = "%s contact=%s" % (UA_BASE, self.contact)
        self.transport = transport or _default_transport
        self.clock = clock or time.time
        # Pacing/throttle run on a monotonic clock; wall clock stays
        # for source timestamps. Injected fake clocks serve both.
        self.mono = mono or (clock if clock is not None
                             else time.monotonic)
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
        now = self.mono()
        if self.throttle_until and now >= self.throttle_until:
            # episode over: deterministic recovery to the ceiling rate
            self.interval = MIN_INTERVAL_S
            self.throttle_until = 0.0
        wait = self._next_ok - now
        if wait > 0:
            self.sleep(wait)
            now = self.mono()
        self._next_ok = now + self.interval

    def _on_429(self):
        now = self.mono()
        if now >= self.throttle_until:
            # new episode: exactly one halving for one hour
            self.interval = min(self.interval * 2, 60.0)
            self.throttle_until = now + THROTTLE_S
        # same episode: state already halved — never re-double

    def _get(self, url, extra_headers=None):
        """(status, headers, body|None, error). Bounded, retried, paced."""
        err = ""
        headers = {"User-Agent": self.ua, "Accept": "*/*"}
        if extra_headers:
            headers.update(extra_headers)
        for attempt in range(RETRIES + 1):
            self._pace()
            try:
                status, h, body = self.transport(
                    url, headers, self.timeout_s)
            except Exception as e:
                err = "%s: %s" % (type(e).__name__, str(e)[:200])
                if attempt < RETRIES:
                    self.sleep(self.jitter(
                        0.8 * self.backoff_base, 1.2 * self.backoff_base))
                continue
            if status == 429:
                self._on_429()
                err = "HTTP 429: rate limited by SEC"
                if attempt < RETRIES:
                    self.sleep(self.jitter(
                        0.8 * self.backoff_base, 1.2 * self.backoff_base))
                continue
            if status == 304:
                return 304, h, b"", ""  # conditional: use cache
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
        """symbol -> cik int. ETag/Last-Modified conditional refresh;
        validators are sent, 304 reuses the cache, and validators are
        durably updated only after a new body commits. Stale cache
        beats no map; corrupt cache refetches, never crashes."""
        data_path, meta_path = self._cache_paths()
        cached = None
        validators = {}
        if data_path and os.path.exists(data_path):
            try:
                if os.path.getsize(data_path) > (1 << 20):
                    raise ValueError("cache too large")
                with open(data_path, encoding="utf-8") as fh:
                    cached = json.load(fh)
                meta = {}
                if meta_path and os.path.exists(meta_path):
                    with open(meta_path, encoding="utf-8") as fh:
                        meta = json.load(fh)
                age = self.clock() - float(meta.get("ts", 0))
                if meta.get("etag"):
                    validators["If-None-Match"] = meta["etag"]
                if meta.get("last_modified"):
                    validators["If-Modified-Since"] = \
                        meta["last_modified"]
                if age < TICKERS_CACHE_DAYS * 86400:
                    return self._ticker_index(cached), "cache-hit", ""
            except Exception:
                cached = None  # corrupt cache: refetch, never crash
                validators = {}
        status, h, body, err = self._get(TICKERS_URL, validators)
        if status == 304:
            if cached is not None:
                # 304 carries no validators: keep the stored ones,
                # refresh only the revalidation timestamp.
                try:
                    old = {}
                    if meta_path and os.path.exists(meta_path):
                        with open(meta_path, encoding="utf-8") as fh:
                            old = json.load(fh)
                except Exception:
                    old = {}
                old["ts"] = self.clock()
                if meta_path:
                    self._atomic_write_json(meta_path, old)
                return self._ticker_index(cached), \
                    "cache-revalidated", ""
            return {}, "unavailable", "304-without-cache"
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
            # data commits first; validators follow the commit (doc 09:
            # ETag persists only after the signals it versions).
            if self._atomic_write_json(data_path, raw):
                self._write_meta(meta_path, h)
        return self._ticker_index(raw), "live", ""

    def _atomic_write_json(self, path, obj):
        """Atomic tmp+fsync+replace. Temp removed on every failure
        path. Returns True on commit."""
        tmp = "%s.tmp-%d-%d" % (path, os.getpid(), _next_tmp_seq())
        try:
            os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(obj, fh)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
            return True
        except Exception:
            try:
                if os.path.exists(tmp):
                    os.remove(tmp)
            except Exception:
                pass
            return False

    def _write_meta(self, meta_path, headers):
        if not meta_path:
            return
        self._atomic_write_json(meta_path, {
            "ts": self.clock(),
            "etag": headers.get("etag", ""),
            "last_modified": headers.get("last-modified", "")})

    @staticmethod
    def _recent_arrays(sub):
        """Validated parallel arrays or None (malformed, never partial).
        accessionNumber/form/filingDate must be equal-length str lists;
        primaryDocument/items, when present, must match in length
        (str or null rows); when absent they default to empty."""
        try:
            recent = sub["filings"]["recent"]
        except (KeyError, TypeError):
            return None
        if not isinstance(recent, dict):
            return None
        core = []
        for key in ("accessionNumber", "form", "filingDate"):
            arr = recent.get(key)
            if not isinstance(arr, list):
                return None
            core.append(arr)
        n = len(core[0])
        if any(len(a) != n for a in core):
            return None
        if any(not isinstance(v, str) for a in core for v in a):
            return None
        opt = []
        for key in ("primaryDocument", "items"):
            arr = recent.get(key, [""] * n)
            if not isinstance(arr, list) or len(arr) != n:
                return None
            if any(v is not None and not isinstance(v, str)
                   for v in arr):
                return None
            opt.append([v or "" for v in arr])
        return core[0], core[1], core[2], opt[0], opt[1]

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
                "truncated": 0, "tickers": ""}
        try:
            cutoff_ns = int((now - LOOKBACK_DAYS * 86400) * 1000000000)
        except (OverflowError, ValueError):
            cutoff_ns = 0
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
            except Exception:
                info["errors"].append("%s:submissions-malformed" % sym)
                continue
            parsed = self._recent_arrays(sub)
            if parsed is None:
                info["errors"].append("%s:submissions-malformed" % sym)
                continue
            accs, forms, dates, pdocs, items_arr = parsed
            for i in range(len(accs)):
                acc, form, fdate = accs[i], forms[i], dates[i]
                pdoc, items = pdocs[i], items_arr[i]
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
                if obs_ns < cutoff_ns:
                    continue  # outside the recent window, not an error
                if len(recs) >= MAX_RECORDS:
                    info["truncated"] += 1  # valid row, explicit cap;
                    continue  # NOT marked seen: stays eligible next poll
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
                # Seen ONLY on emit: truncated rows stay eligible.
                self._seen[acc] = 1
                if len(self._seen) > 4096:
                    # bounded cycle-local memory: drop oldest keys
                    for k in list(self._seen)[:1024]:
                        del self._seen[k]
        info["records"] = len(recs)
        # Freshness is measured at COMPLETION: a slow poll/retry
        # episode must not publish fresh health from a stale start.
        done = self.clock()
        # Health is source-level: ANY requested-symbol failure keeps the
        # poll unhealthy. Successful records are preserved; missing ones
        # are never fabricated. last_ok advances only on a fully clean
        # poll, so partial failure cannot erase staleness.
        if not info["errors"]:
            info["ok"] = True
            self.last_ok_ts = done
            self.last_error = ""
            # A poll that itself outlasts the TTL cannot publish
            # fresh health from a stale-duration operation.
            info["stale"] = (done - now) > TTL_S
        else:
            self.failures += 1
            self.last_error = "; ".join(info["errors"][:3])
        if done - self.last_ok_ts > TTL_S:
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
        tmp = "%s.tmp-%d-%d" % (path, os.getpid(), _next_tmp_seq())
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    @staticmethod
    def _valid_heartbeat(hb):
        """Strict schema gate (mirrors earnings hardened pattern).
        Never raises: any anomaly -> False."""
        try:
            if not isinstance(hb, dict) or set(hb.keys()) != _HB_KEYS:
                return False
            if hb["version"] != HEARTBEAT_VERSION \
                    or type(hb["version"]) is not int:
                return False
            if hb["cadence_s"] != CADENCE_S or hb["ttl_s"] != TTL_S:
                return False
            if type(hb["ok"]) is not bool:
                return False
            if type(hb["stale"]) is not bool:
                return False
            if type(hb["records"]) is not int or hb["records"] < 0:
                return False
            if not isinstance(hb["error"], str) \
                    or len(hb["error"]) > 200:
                return False
            ts = hb["ts"]
            if type(ts) not in (int, float) or not math.isfinite(ts):
                return False
            return True
        except Exception:
            return False

    def read_heartbeat(self, path, now=None):
        now = now if now is not None else self.clock()
        try:
            if os.path.getsize(path) > HEARTBEAT_MAX_BYTES:
                return {"state": "invalid"}
            with open(path, encoding="utf-8") as fh:
                hb = json.load(fh)
        except Exception:
            return {"state": "invalid"}
        if not self._valid_heartbeat(hb):
            return {"state": "invalid"}
        ts = float(hb["ts"])
        if ts > now + SKEW_ALLOW_S:
            return {"state": "invalid"}  # future skew cap
        if now - ts > TTL_S:
            return {"state": "stale"}
        if hb["stale"]:
            return {"state": "stale"}  # declared stale is stale,
        if not hb["ok"]:  # even beside ok=true: never healthy
            return {"state": "failed"}
        return {"state": "healthy"}


def build(contact=None, env=None, **kw):
    """Build an adapter. contact defaults to MIRO_CONTACT from env;
    missing contact raises ConfigError (fail closed, no requests)."""
    c = contact if contact is not None else contact_from_env(env)
    return Adapter(c, **kw)
