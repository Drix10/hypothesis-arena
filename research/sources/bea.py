"""Production BEA NIPA source adapter (doc 09 Tier A).

Locked scope: ONE GetData call (datasetname=NIPA, TableName=T10101
headline GDP, Frequency=A) per poll. No dataset discovery, no crawl,
no table walk. Keyed source: BEA_USER_ID from env, fail-closed when
absent (build() raises); the key travels ONLY in the query string —
never in errors, records, heartbeats, headers, or logs (FRED lesson).

Envelope (probe-proven): HTTP 200 with BEAAPI.Results.Data on
success; call errors nest inside BEAAPI.Error / Results.Error with
HTTP still 200 (any non-200/exception is transport, never denial —
a network failure can never masquerade as auth proof).

Rows: TimePeriod must be a strict 4-digit year not in the future;
a series identity (SeriesCode else LineNumber) is required — never
synthesized. DataValue must parse numeric (commas allowed);
non-numeric markers like (NA) drop the row. observed_at_ns is the
period-year Jan-1 midnight, explicitly estimated (period reference,
not an authoritative instant — same contract class as Treasury).
PK dedupe key: (TableName, series, TimePeriod).

Symbols ["EURUSD","USDJPY","SPY"] are an operating default for
headline GDP (no pinned GDP map exists); change only deliberately.

Health (Treasury/BLS lessons built in): empty Data list or zero
usable rows => ok=False with explicit bounded reasons (empty-data /
no-usable-records), last_ok_ts frozen; duplicate-only steady-state
polls stay healthy via a usable-row count.
Rate: conservative 1 req/s operating pace. 3 retries, jittered
backoff, 429 halves once per episode with deterministic recovery.
Raw records only (harvest envelope); frozen f2 downstream.
Transport/clock/sleep/jitter injected; stdlib urllib, proxy via env.

Implementation-complete is NOT production-proven: live evidence
(soak, measured p50/p99) stays open.
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

SOURCE_ID = "bea_nipa_gdp"
KIND = "macro_release"

BASE = "https://apps.bea.gov/api/data"
DATASET = "NIPA"
TABLE = "T10101"
PROVENANCE = "https://www.bea.gov/data/gdp/gross-domestic-product"

UA_BASE = "MiroHedge/phase0"
SYMBOLS = ["EURUSD", "USDJPY", "SPY"]  # operating default, see doc

MIN_INTERVAL_S = 1.0
RETRIES = 3
BACKOFF_BASE_S = 15.0
THROTTLE_S = 3600.0
DEFAULT_TIMEOUT_S = 30
MAX_BODY_BYTES = 2 << 20
MAX_RECORDS = 64

CADENCE_S = 3600
TTL_S = 18 * 3600  # macro standard (cf. schema SOURCE_TTL_S siblings)
HEARTBEAT_VERSION = 1
HEARTBEAT_MAX_BYTES = 65536
SKEW_ALLOW_S = 300
ERR_BOUND = 120

_tmp_seq = [0]


def _next_tmp_seq():
    _tmp_seq[0] += 1
    return _tmp_seq[0]


class ConfigError(Exception):
    pass


def user_id_from_env(env=None):
    src = os.environ if env is None else env
    return src.get("BEA_USER_ID", "").strip()


def contact_from_env(env=None):
    src = os.environ if env is None else env
    return src.get("MIRO_CONTACT", "").strip()


def _utc_year(clock):
    return time.strftime("%Y", time.gmtime(clock()))


def _year_to_ns(year_s, max_year_s):
    if not isinstance(year_s, str) or not re.match(r"^\d{4}$", year_s):
        return None
    if year_s > max_year_s:
        return None
    try:
        return int(calendar.timegm(
            time.strptime(year_s, "%Y")) * 1000000000)
    except ValueError:
        return None


def _series_of(row):
    sc = row.get("SeriesCode")
    if isinstance(sc, str) and sc.strip():
        return sc.strip()
    ln = row.get("LineNumber")
    if isinstance(ln, str) and ln.strip():
        return ln.strip()
    if isinstance(ln, int) and ln >= 0:
        return str(ln)
    return None


def _value_ok(v):
    """Strict BEA numeric grammar (fail-closed, no normalization).

    Accepts signed decimals/scientific forms with commas ONLY in
    valid thousands grouping. float() alone silently repairs
    malformed source data ('1,2,3' -> 123, '1_000' -> 1000): that
    is corruption, so the shape is regex-gated first and float()
    only checks finiteness. The original string is preserved.
    """
    if not isinstance(v, str):
        return False
    s = v.strip()
    if not s or len(s) > 64:
        return False
    if not re.match(r"^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)"
                     r"(?:\.\d+)?(?:[eE][+-]?\d+)?$", s):
        return False
    try:
        f = float(s.replace(",", ""))
    except ValueError:
        return False
    return math.isfinite(f)


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
    def __init__(self, user_id, transport=None, clock=None, sleeper=None,
                 jitter=None, backoff_base_s=BACKOFF_BASE_S,
                 timeout_s=DEFAULT_TIMEOUT_S, mono=None, contact=None,
                 env=None):
        if not isinstance(user_id, str) or not user_id.strip():
            raise ConfigError("BEA_USER_ID missing: keyed source is "
                              "fail-closed without credentials")
        self.user_id = user_id.strip()
        c = (contact if contact is not None
             else contact_from_env(env))
        self.ua = "%s contact=%s" % (
            UA_BASE, c.strip() if c and c.strip()
            else "research-plane-bea")
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
        self._seen = {}
        self.last_ok_ts = 0.0
        self.last_error = ""
        self.polls = 0
        self.failures = 0

    def _query(self):
        y = _utc_year(self.clock)
        prev = "%04d" % (int(y) - 1)
        return {"UserID": self.user_id, "method": "GETDATA",
                "ResultFormat": "JSON", "datasetname": DATASET,
                "TableName": TABLE, "Frequency": "A",
                "Year": "%s,%s" % (prev, y)}

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

    def _get(self, query):
        # NOTE: the key lives in the query string only. Every error
        # path below returns fixed-shape reasons that never echo the
        # URL, params, or body.
        err = ""
        url = BASE + "?" + urllib.parse.urlencode(query)
        headers = {"User-Agent": self.ua, "Accept": "application/json"}
        for attempt in range(RETRIES + 1):
            self._pace()
            try:
                status, h, body = self.transport(
                    url, headers, self.timeout_s)
            except Exception as e:
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
            if status != 200:
                return status, h, None, "HTTP %d" % status
            if len(body) > MAX_BODY_BYTES:
                return status, h, None, "oversized: %d bytes" % len(body)
            try:
                return status, h, json.loads(body.decode("utf-8")), ""
            except Exception:
                return status, h, None, "malformed-json"
        return 0, {}, None, err or "transport failed"

    @staticmethod
    def _split_envelope(doc):
        """(data_list_or_None, denied_description_or_None, flaw).

        HTTP-200 BEA call errors nest inside the envelope: flaw is a
        fixed-vocabulary reason, never echoed content.
        """
        if not isinstance(doc, dict):
            return None, None, "malformed-envelope"
        api = doc.get("BEAAPI")
        if not isinstance(api, dict):
            return None, None, "malformed-envelope"
        res = api.get("Results")
        err_node = api.get("Error")
        if isinstance(res, dict) and err_node is None:
            err_node = res.get("Error")
        if err_node is not None:
            if isinstance(err_node, dict):
                desc = err_node.get("APIErrorDescription", "")
            else:
                desc = err_node
            desc = desc if isinstance(desc, str) else ""
            return None, desc.strip()[:ERR_BOUND] or "denied", "denied"
        if not isinstance(res, dict):
            return None, None, "malformed-envelope"
        data = res.get("Data")
        if not isinstance(data, list):
            return None, None, "malformed-envelope"
        return data, None, ""

    def poll(self, today=None):
        """Headline GDP rows. Never raises on provider failure."""
        max_year = (today or _utc_year(self.clock))[:4]
        now = self.clock()
        self.polls += 1
        usable = 0
        info = {"ok": False, "stale": True, "errors": [], "dropped": 0,
                "duplicates": 0, "records": 0, "truncated": 0,
                "completed_at": 0.0}
        _st, _h, doc, err = self._get(self._query())
        data, denied, flaw = (None, None, err) if err else \
            self._split_envelope(doc)
        if flaw:
            if flaw == "denied":
                # Provider error text is untrusted: it may echo the
                # credential (e.g. 'Invalid UserID <key>'). Redact
                # every exact occurrence before it can reach errors,
                # last_error, or the heartbeat.
                clean = (denied or "denied").replace(
                    self.user_id, "[REDACTED]")
                info["errors"].append("denied: %s" % clean)
            else:
                info["errors"].append(flaw)
            self.failures += 1
            self.last_error = "; ".join(info["errors"][:3])
            info["completed_at"] = self.clock()
            if info["completed_at"] - self.last_ok_ts > TTL_S:
                info["stale"] = True
            return [], info
        if not data:
            info["errors"].append("empty-data")
            self.failures += 1
            self.last_error = "empty-data"
            info["completed_at"] = self.clock()
            if info["completed_at"] - self.last_ok_ts > TTL_S:
                info["stale"] = True
            return [], info
        recs = []
        for row in data:
            if not isinstance(row, dict):
                info["dropped"] += 1
                continue
            tp = row.get("TimePeriod")
            series = _series_of(row)
            val = row.get("DataValue")
            if series is None or not _value_ok(val):
                info["dropped"] += 1
                continue
            obs_ns = _year_to_ns(tp, max_year)
            if obs_ns is None:
                info["dropped"] += 1
                continue
            usable += 1  # valid source row, new or already seen
            key = (TABLE, series, tp)
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
                "symbols": list(SYMBOLS),
                "kind": KIND,
                "table": TABLE,
                "series": series,
                "time_period": tp,
                "data_value": val.strip(),
                "observed_at_ns": obs_ns,
                "observed_at_estimated": True,
                "values_pending": False,
                "provenance_url": PROVENANCE,
            })
        info["records"] = len(recs)
        done = self.clock()
        info["completed_at"] = done
        if not info["errors"] and usable:
            info["ok"] = True
            self.last_ok_ts = done
            self.last_error = ""
            info["stale"] = (done - now) > TTL_S
        else:
            if not info["errors"]:
                info["errors"].append("no-usable-records")
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
            raise ValueError("heartbeat too large")
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


def build(transport=None, env=None, **kw):
    """Keyed source: fail-closed without BEA_USER_ID."""
    uid = kw.pop("user_id", None)
    if uid is None:
        uid = user_id_from_env(env)
    if not uid or not uid.strip():
        raise ConfigError("BEA_USER_ID missing")
    return Adapter(user_id=uid.strip(), transport=transport, **kw)
