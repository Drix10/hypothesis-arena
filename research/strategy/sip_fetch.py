"""SIP research datasets. Alpaca Basic serves SIP history only with an end
at least 15 minutes in the past; newer ends are refused. Transport is
injectable so tests never touch the network. Each dataset is a JSONL file
plus a manifest (source, endpoint, query, range, feed, adjustment, rows,
sha256 of the file bytes, fetch time); a run that cannot name its manifest
hashes is void."""
import hashlib
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

BASE = "https://data.alpaca.markets"
FEED = "sip"
DELAY = timedelta(minutes=15)
KINDS = {"bars": "/v2/stocks/bars", "quotes": "/v2/stocks/quotes"}
ADJUSTMENTS = ("raw", "split", "dividend", "all")
MAX_PAGES = 1000


class SipError(ValueError):
    pass


def _utc(s):
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        raise SipError("bad-timestamp")
    if d.tzinfo is None:
        raise SipError("naive-timestamp")
    return d.astimezone(timezone.utc)


def check_end(end, now=None):
    """Return `end` if it is at least 15 minutes old, else refuse."""
    now = now or datetime.now(timezone.utc)
    if _utc(end) > now - DELAY:
        raise SipError("end-within-sip-delay")
    return end


def build_query(symbol, kind, start, end, timeframe=None, adjustment="raw"):
    if kind not in KINDS:
        raise SipError("kind")
    if adjustment not in ADJUSTMENTS:
        raise SipError("adjustment")
    if not symbol or not symbol.replace(".", "").isalnum():
        raise SipError("symbol")
    if _utc(start) >= _utc(end):
        raise SipError("empty-range")
    q = {"symbols": symbol, "start": start, "end": end, "feed": FEED,
         "limit": "10000", "sort": "asc"}
    if kind == "bars":
        if not timeframe:
            raise SipError("timeframe")
        q["timeframe"] = timeframe
        q["adjustment"] = adjustment
    return q


def load_alpaca_env():
    """Copy the Alpaca data keys from the repo .env (via collector.config,
    the only loader) into the environment unless already exported."""
    from collector.config import load
    for n, v in load()["values"].items():
        if n in ("ALPACA_KEY_ID", "ALPACA_SECRET"):
            os.environ.setdefault(n, v)


def default_http_get(url, headers):
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def _headers():
    k, s = os.environ.get("ALPACA_KEY_ID"), os.environ.get("ALPACA_SECRET")
    if not k or not s:
        raise SipError("no-credentials")
    return {"APCA-API-KEY-ID": k, "APCA-API-SECRET-KEY": s}


def fetch(symbol, kind, start, end, timeframe=None, adjustment="raw",
          http_get=default_http_get, headers=None, now=None):
    """Paginated fetch -> (rows, query). Rows are the raw provider dicts."""
    check_end(end, now)
    q = build_query(symbol, kind, start, end, timeframe, adjustment)
    hdr = headers if headers is not None else _headers()
    rows, token, pages = [], None, 0
    while True:
        qq = dict(q)
        if token:
            qq["page_token"] = token
        payload = http_get(BASE + KINDS[kind] + "?" +
                           urllib.parse.urlencode(qq), hdr)
        rows.extend((payload.get(kind) or {}).get(symbol, []))
        token = payload.get("next_page_token")
        pages += 1
        if not token:
            return rows, q
        if pages >= MAX_PAGES:
            raise SipError("pagination-runaway")


def serialize(rows):
    return "".join(json.dumps(r, sort_keys=True, separators=(",", ":")) + "\n"
                   for r in rows).encode()


def content_hash(rows):
    return hashlib.sha256(serialize(rows)).hexdigest()


def manifest(symbol, kind, q, rows, fetched_utc=None):
    """Manifest carrying no credential material by construction."""
    return {"source": "alpaca-market-data-v2", "endpoint": KINDS[kind],
            "symbol": symbol, "kind": kind, "query": dict(q),
            "range": {"start": q["start"], "end": q["end"]},
            "feed": FEED, "adjustment": q.get("adjustment"),
            "rows": len(rows), "sha256": content_hash(rows),
            "fetched_utc": fetched_utc or
            datetime.now(timezone.utc).isoformat()}


def _atomic_write(path, data):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def dataset_paths(outdir, symbol, kind, timeframe, adjustment):
    tag = f"{symbol}_{kind}_{timeframe or 'tick'}_{adjustment}"
    return (os.path.join(outdir, tag + ".jsonl"),
            os.path.join(outdir, tag + ".manifest.json"))


def write_dataset(symbol, kind, start, end, outdir, timeframe=None,
                  adjustment="raw", **kw):
    rows, q = fetch(symbol, kind, start, end, timeframe, adjustment, **kw)
    os.makedirs(outdir, exist_ok=True)
    data_path, man_path = dataset_paths(outdir, symbol, kind, timeframe,
                                        adjustment)
    m = manifest(symbol, kind, q, rows)
    _atomic_write(data_path, serialize(rows))
    _atomic_write(man_path, json.dumps(m, indent=2, sort_keys=True).encode())
    return m


def verify_dataset(outdir, symbol, kind, timeframe, adjustment):
    """Return the manifest iff the data file still hashes to it."""
    data_path, man_path = dataset_paths(outdir, symbol, kind, timeframe,
                                        adjustment)
    with open(man_path) as f:
        m = json.load(f)
    with open(data_path, "rb") as f:
        digest = hashlib.sha256(f.read()).hexdigest()
    if digest != m.get("sha256") or m.get("feed") != FEED \
            or m.get("symbol") != symbol or m.get("adjustment") != adjustment:
        raise SipError("dataset-manifest-mismatch:" + symbol)
    return m
