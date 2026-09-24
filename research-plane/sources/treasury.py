"""Production Treasury FiscalData source adapter (doc 09 Tier A).

Locked scope: api.fiscaldata.treasury.gov auction results
(auctions_query, latest-first) only. No key, no crawl, no mirror.
UA carries MIRO_CONTACT when configured (polite, SEC-style); the
source does not require it, so absence warns instead of blocking.

Timestamps: record_date is the PUBLICATION date and the sole source
of observed_at_ns (midnight, explicitly estimated: day-granularity,
never an authoritative instant). auction_date is EVENT metadata and
may be future (announced auctions) while record_date is current;
a future auction_date is never a future observation. cusip+record_date
is the PK dedupe key.

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
import urllib.request

SOURCE_ID = "treasury_auctions"
KIND = "macro_release"

BASE = ("https://api.fiscaldata.treasury.gov/services/api/"
        "fiscal_service/v1/accounting/od/auctions_query"
        "?sort=-record_date&page%5Bsize%5D=64")
PROVENANCE = ("https://fiscaldata.treasury.gov/datasets/"
              "treasury-securities-auctions-data/")

UA_BASE = "MiroHedge/phase0"
SYMBOLS = ["EURUSD", "USDJPY", "SPY"]  # operating config, not frozen

MIN_INTERVAL_S = 1.0
RETRIES = 3
BACKOFF_BASE_S = 15.0
THROTTLE_S = 3600.0
DEFAULT_TIMEOUT_S = 30
MAX_BODY_BYTES = 2 << 20
MAX_RECORDS = 64

CADENCE_S = 3600
TTL_S = 18 * 3600  # frozen schema SOURCE_TTL_S[treasury_auctions]
HEARTBEAT_VERSION = 1
HEARTBEAT_MAX_BYTES = 65536
SKEW_ALLOW_S = 300

_tmp_seq = [0]


def _next_tmp_seq():
    _tmp_seq[0] += 1
    return _tmp_seq[0]


def contact_from_env(env=None):
    src = os.environ if env is None else env
    return src.get("MIRO_CONTACT", "").strip()


def _valid_ymd(s):
    if not isinstance(s, str) or not re.match(
            r"^\d{4}-\d{2}-\d{2}$", s):
        return False
    try:
        time.strptime(s, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def _valid_cusip(s):
    """Treasury CUSIP: 9-character alphanumeric identifier."""
    if not isinstance(s, str) or len(s) != 9:
        return False
    return all(c.isalnum() and c.isascii() for c in s)


def _utc_today():
    return time.strftime("%Y-%m-%d", time.gmtime())


def _date_to_ns(date_s, today_s):
    if not isinstance(date_s, str) or not re.match(
            r"^\d{4}-\d{2}-\d{2}$", date_s):
        return None
    if date_s > today_s:
        return None
    try:
        return int(calendar.timegm(
            time.strptime(date_s, "%Y-%m-%d")) * 1000000000)
    except ValueError:
        return None


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
    def __init__(self, transport=None, clock=None, sleeper=None,
                 jitter=None, backoff_base_s=BACKOFF_BASE_S,
                 timeout_s=DEFAULT_TIMEOUT_S, mono=None, contact=None,
                 env=None):
        c = (contact if contact is not None
             else contact_from_env(env))
        self.ua = "%s contact=%s" % (
            UA_BASE, c.strip() if c and c.strip()
            else "research-plane-treasury")
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

    def _get(self, url):
        err = ""
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

    def poll(self, today=None):
        """Latest auction results. Never raises on provider failure."""
        today_s = today or _utc_today()
        now = self.clock()
        self.polls += 1
        usable = 0
        info = {"ok": False, "stale": True, "errors": [], "dropped": 0,
                "duplicates": 0, "records": 0, "truncated": 0,
                "completed_at": 0.0}
        _st, _h, body, err = self._get(BASE)
        if err or not isinstance(body, dict):
            info["errors"].append(err or "bad-envelope")
            self.failures += 1
            self.last_error = "; ".join(info["errors"][:3])
            info["completed_at"] = self.clock()
            if info["completed_at"] - self.last_ok_ts > TTL_S:
                info["stale"] = True
            return [], info
        data = body.get("data")
        if not isinstance(data, list):
            info["errors"].append("missing-data")
            self.failures += 1
            self.last_error = "missing-data"
            info["completed_at"] = self.clock()
            return [], info
        if not data:
            # Empty provider payload is NOT healthy: freshness must
            # never reset on zero usable source content.
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
            cusip = row.get("cusip")
            rec_date = row.get("record_date")
            auc_date = row.get("auction_date")
            if not _valid_cusip(cusip):
                info["dropped"] += 1  # malformed identifier: never
                continue  # a dedupe key, never emitted unvalidated
            if not _valid_ymd(rec_date):
                info["dropped"] += 1
                continue
            # auction_date is REQUIRED event metadata: never
            # synthesized, but may be future (announced auction).
            if not _valid_ymd(auc_date):
                info["dropped"] += 1
                continue
            # record_date is the publication date and the sole
            # availability authority; future => not yet published.
            obs_ns = _date_to_ns(rec_date, today_s)
            if obs_ns is None:
                info["dropped"] += 1
                continue
            usable += 1  # valid source row, new or already seen
            key = (cusip, rec_date)
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
                "cusip": cusip,
                "record_date": rec_date,
                "auction_date": auc_date,
                "security_type": row.get("security_type", "")
                if isinstance(row.get("security_type", ""), str) else "",
                "observed_at_ns": obs_ns,
                "observed_at_estimated": True,
                "provenance_url": PROVENANCE,
            })
        info["records"] = len(recs)
        done = self.clock()
        info["completed_at"] = done
        # Content health: >= 1 USABLE row (new or already-seen
        # duplicate) keeps the source fresh. Zero usable rows never
        # resets freshness, even with clean transport. Partial
        # success stays healthy with drops visible.
        if not info["errors"] and usable:
            info["ok"] = True
            self.last_ok_ts = done
            self.last_error = ""
            info["stale"] = (done - now) > TTL_S
        else:
            if not info["errors"]:
                # Nonempty payload, zero usable rows: fail closed AND
                # say so. (Empty data returns early as empty-data.)
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


def build(transport=None, **kw):
    """Keyless source: build never fails on credentials."""
    return Adapter(transport=transport, **kw)
