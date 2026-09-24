"""Production FRED/ALFRED source adapter (doc 09 Tier A, second slice).

Locked scope: api.stlouisfed.org series observations only
(series_id + file_type=json), plus ALFRED realtime windows
(realtime_start/end) for point-in-time vintage correctness. No
bulk download, no mirroring (license matrix, doc 09).

Key: FRED_API_KEY from the environment; missing -> ConfigError
before any request (SKIPPED_CONFIG heartbeat semantics, never a
failure, never a default). The key travels only in the request
query; it never appears in errors, records, heartbeats, or logs
(asserted by test with a sentinel key).

Timestamps: FRED observations carry a day-granularity `date`, not an
acceptance instant — so observed_at_ns is filing-date-midnight
EXPLICITLY flagged observed_at_estimated (context-only downstream
per doc 09 R12, never TRIGGER). ALFRED realtime_start/end ride in
the record for vintage replay. Missing "." values are dropped and
counted, never fabricated.

Rate: conservative 1 req/s operating pace (well under any plausible
provider ceiling; the ceiling is never assumed). 3 retries, jittered
backoff, 429 halves once per episode with deterministic recovery.

This module emits RAW records only (graph harvest envelope); frozen
f2 classification happens downstream. Transport/clock/sleep/jitter
are injected; default transport is stdlib urllib honoring proxy env.

Implementation-complete is NOT production-proven: live evidence
(soak, measured p50/p99, ALFRED replay against the live API) stays
open.
"""
import calendar
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

SOURCE_ID = "fred_macro"
KIND = "macro_release"

BASE = "https://api.stlouisfed.org"
OBS_PATH = "/fred/series/observations"
SERIES_PAGE = "https://fred.stlouisfed.org/series/%s"

UA_BASE = "MiroHedge/phase0"

MIN_INTERVAL_S = 1.0
RETRIES = 3
BACKOFF_BASE_S = 15.0
THROTTLE_S = 3600.0
DEFAULT_TIMEOUT_S = 30
MAX_BODY_BYTES = 2 << 20
MAX_RECORDS = 64

CADENCE_S = 3600
TTL_S = 18 * 3600  # frozen schema SOURCE_TTL_S[fred_macro]
HEARTBEAT_VERSION = 1
HEARTBEAT_MAX_BYTES = 65536
SKEW_ALLOW_S = 300

# Operating core set (NOT a frozen contract): series -> (release key,
# symbols drawn only from the pinned macro symbol universe).
SERIES_CORE = {
    "GDP": ("GDP", ["SPY"]),
    "CPIAUCSL": ("CPI", ["EURUSD", "USDJPY", "SPY"]),
    "PAYEMS": ("NFP", ["EURUSD", "USDJPY", "SPY"]),
    "UNRATE": ("NFP", ["EURUSD", "USDJPY", "SPY"]),
    "FEDFUNDS": ("FOMC", ["EURUSD", "USDJPY", "SPY", "GLD"]),
    "DGS10": ("FOMC", ["EURUSD", "USDJPY", "SPY", "GLD"]),
}

_tmp_seq = [0]


def _next_tmp_seq():
    _tmp_seq[0] += 1
    return _tmp_seq[0]


class ConfigError(ValueError):
    pass


def key_from_env(env=None):
    src = os.environ if env is None else env
    return src.get("FRED_API_KEY", "").strip()


def _utc_today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def _date_to_ns(date_s, today_s):
    """Observation day -> UTC-midnight ns. None on bad/future."""
    if not isinstance(date_s, str) or not re.match(
            r"^\d{4}-\d{2}-\d{2}$", date_s):
        return None
    if date_s > today_s:
        return None
    try:
        tt = time.strptime(date_s, "%Y-%m-%d")
    except ValueError:
        return None
    return int(calendar.timegm(tt) * 1000000000)


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
    """Stdlib urllib GET. Proxy via env. HTTPError normalized to
    (status, headers, body) with deterministic close; only genuine
    transport failures raise. Never includes secrets in exceptions."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            h = {k.lower(): v for k, v in r.getheaders()}
            return r.status, h, _read_capped(r)
    except urllib.error.HTTPError as e:
        try:
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
                raise OSError("bad HTTP status")
            return status, h, body
        finally:
            try:
                e.close()
            except Exception:
                pass
    except Exception:
        raise


class Adapter:
    def __init__(self, api_key, transport=None, clock=None, sleeper=None,
                 jitter=None, backoff_base_s=BACKOFF_BASE_S,
                 timeout_s=DEFAULT_TIMEOUT_S, mono=None, contact=None):
        if not api_key or not api_key.strip():
            raise ConfigError("fred: FRED_API_KEY missing — refusing "
                              "to poll without a key")
        self.api_key = api_key.strip()
        who = contact.strip() if contact and contact.strip() else \
            "research-plane-fred"
        self.ua = "%s contact=%s" % (UA_BASE, who)
        self.transport = transport or _default_transport
        self.clock = clock or time.time
        self.mono = mono or (clock if clock is not None
                             else time.monotonic)
        self.sleep = sleeper or time.sleep
        self.jitter = jitter or (lambda a, b: a + (b - a) * 0.5)
        self.backoff_base = backoff_base_s
        self.timeout_s = timeout_s
        self.interval = MIN_INTERVAL_S
        self.throttle_until = 0.0
        self._next_ok = 0.0
        self._seen = {}  # (series,date,value) cycle-local dedupe
        self.last_ok_ts = 0.0
        self.last_error = ""
        self.polls = 0
        self.failures = 0

    def _pace(self):
        now = self.mono()
        if self.throttle_until and now >= self.throttle_until:
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
            self.interval = min(self.interval * 2, 60.0)
            self.throttle_until = now + THROTTLE_S

    def _get(self, path, params, extra_headers=None):
        err = ""
        q = dict(params)
        q["api_key"] = self.api_key
        q["file_type"] = "json"
        url = BASE + path + "?" + urllib.parse.urlencode(q)
        headers = {"User-Agent": self.ua, "Accept": "application/json"}
        if extra_headers:
            headers.update(extra_headers)
        for attempt in range(RETRIES + 1):
            self._pace()
            try:
                status, h, body = self.transport(
                    url, headers, self.timeout_s)
            except Exception as e:
                # URL (with key) must never enter error strings.
                err = "%s" % type(e).__name__
                if attempt < RETRIES:
                    self.sleep(self.jitter(
                        0.8 * self.backoff_base, 1.2 * self.backoff_base))
                continue
            if status == 429:
                self._on_429()
                err = "HTTP 429: rate limited"
                if attempt < RETRIES:
                    self.sleep(self.jitter(
                        0.8 * self.backoff_base, 1.2 * self.backoff_base))
                continue
            if status == 400:
                # FRED 400 is generic Bad Request: credential denial
                # only on explicit key evidence in the error message —
                # never inferred from status alone, never logged.
                denied = False
                try:
                    msg = str(json.loads(body.decode("utf-8")).get(
                        "error_message", ""))
                    low = msg.lower()
                    denied = "api key" in low or "apikey" in low.replace(
                        " ", "")
                except Exception:
                    pass
                if denied:
                    return status, h, None, "HTTP 400: key denied"
                return status, h, None, "HTTP 400"
            if status in (401, 403):
                return status, h, None, "HTTP %d: key denied" % status
            if status == 304:
                return 304, h, b"", ""
            if status != 200:
                return status, h, None, "HTTP %d" % status
            if len(body) > MAX_BODY_BYTES:
                return status, h, None, "oversized: %d bytes" % len(body)
            try:
                return status, h, json.loads(body.decode("utf-8")), ""
            except Exception:
                return status, h, None, "malformed-json"
        return 0, {}, None, err or "transport failed"

    def fetch_observations(self, series_id, realtime_start=None,
                           realtime_end=None, observation_start=None,
                           observation_end=None):
        """Raw observation rows (+ realtime window echoed)."""
        params = {"series_id": series_id}
        for k, v in (("realtime_start", realtime_start),
                     ("realtime_end", realtime_end),
                     ("observation_start", observation_start),
                     ("observation_end", observation_end)):
            if v:
                params[k] = v
        status, _h, body, err = self._get(OBS_PATH, params)
        if err or not isinstance(body, dict):
            return None, err or "bad-envelope"
        obs = body.get("observations")
        if not isinstance(obs, list):
            return None, "missing-observations"
        return obs, ""

    def fetch_vintage(self, series_id, realtime_start, realtime_end,
                      observation_start=None, observation_end=None):
        """ALFRED point-in-time rows: [(date, value, rt_start, rt_end)]."""
        obs, err = self.fetch_observations(
            series_id, realtime_start, realtime_end,
            observation_start, observation_end)
        if err:
            return None, err
        rows = []
        for o in obs:
            if not isinstance(o, dict):
                return None, "vintage-row-shape"
            d, v = o.get("date"), o.get("value")
            if not isinstance(d, str) or not isinstance(v, str):
                return None, "vintage-row-shape"
            rows.append((d, v, o.get("realtime_start", realtime_start),
                         o.get("realtime_end", realtime_end)))
        return rows, ""

    def poll(self, series=None, today=None):
        """Latest observation per series. Never raises on provider
        failure; outage is explicit in info."""
        series = SERIES_CORE if series is None else series
        today_s = today or _utc_today()
        now = self.clock()
        self.polls += 1
        info = {"ok": False, "stale": True, "errors": [], "dropped": 0,
                "duplicates": 0, "records": 0, "truncated": 0,
                "completed_at": 0.0}
        recs = []
        for sid, cfg in series.items():
            release, symbols = cfg[0], list(cfg[1])
            obs, err = self.fetch_observations(sid)
            if err:
                info["errors"].append("%s:%s" % (sid, err))
                continue
            if not obs:
                info["errors"].append("%s:empty-observations" % sid)
                continue
            last = obs[-1]
            if not isinstance(last, dict):
                info["errors"].append("%s:row-shape" % sid)
                continue
            date, val = last.get("date"), last.get("value")
            if not isinstance(date, str) or not isinstance(val, str) \
                    or val.strip() in ("", "."):
                info["dropped"] += 1  # missing value: never fabricate
                continue
            obs_ns = _date_to_ns(date, today_s)
            if obs_ns is None:
                info["dropped"] += 1
                continue
            key = (sid, date, val)
            if key in self._seen:
                info["duplicates"] += 1
                continue
            if len(recs) >= MAX_RECORDS:
                info["truncated"] += 1
                continue
            self._seen[key] = 1
            if len(self._seen) > 4096:
                for k in list(self._seen)[:1024]:
                    del self._seen[k]
            recs.append({
                "source_id": SOURCE_ID,
                "symbols": symbols,
                "kind": KIND,
                "series_id": sid,
                "release": release,
                "date": date,
                "value": val,
                "observed_at_ns": obs_ns,
                "observed_at_estimated": True,  # day granularity, not
                "realtime_start": last.get("realtime_start", ""),  # an
                "realtime_end": last.get("realtime_end", ""),  # instant
                "provenance_url": SERIES_PAGE % sid,
            })
        info["records"] = len(recs)
        done = self.clock()
        info["completed_at"] = done
        if not info["errors"]:
            info["ok"] = True
            self.last_ok_ts = done
            self.last_error = ""
            info["stale"] = (done - now) > TTL_S
        else:
            self.failures += 1
            self.last_error = "; ".join(info["errors"][:3])
        if done - self.last_ok_ts > TTL_S:
            info["stale"] = True
        return recs, info

    def harvest(self, watchlist, epoch):
        recs, info = self.poll()
        stamps = {SOURCE_ID: {
            "ok": info["ok"], "stale": info["stale"],
            "checked_at_ns": int(self.clock() * 1000000000),
            "records": info["records"],
            "epoch": epoch}}
        return recs, stamps

    def heartbeat(self, info):
        ts = info.get("completed_at") or 0.0
        try:
            ts = float(ts)
        except (TypeError, ValueError):
            ts = 0.0
        if not (ts > 0) or ts != ts:
            ts = self.clock()
        return {"version": HEARTBEAT_VERSION, "ts": ts,
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
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(data)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
            tmp = None
        finally:
            if tmp is not None and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass

    @staticmethod
    def _valid_heartbeat(hb):
        try:
            keys = frozenset(("version", "ts", "cadence_s", "ttl_s",
                              "ok", "stale", "records", "error"))
            if not isinstance(hb, dict) or set(hb.keys()) != keys:
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
            return {"state": "invalid"}
        if now - ts > TTL_S:
            return {"state": "stale"}
        if hb["stale"]:
            return {"state": "stale"}
        if not hb["ok"]:
            return {"state": "failed"}
        return {"state": "healthy"}


def build(api_key=None, env=None, **kw):
    """Build an adapter. Key defaults to FRED_API_KEY from env;
    missing key raises ConfigError (fail closed, no requests)."""
    k = api_key if api_key is not None else key_from_env(env)
    return Adapter(k, **kw)
