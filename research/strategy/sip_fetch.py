"""SIP research datasets (doc 09 §9.1a, freeze v3 A0.2). Stdlib only.

Alpaca Basic: SIP history is only available with an end >= 15 minutes in
the past; the fetcher clamps/refuses anything newer. Transport is injected
(`http_get(url, headers) -> dict`) so tests never touch the network; the
default transport reads credentials from the environment and never logs
or writes them. Every dataset is a manifest (source, endpoint, query,
range, feed, adjustment, rows, content hash, fetch time); a run that
cannot name its manifest hashes is void.
"""
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


def clamp_end(end, now=None):
    """Return end unchanged if >= 15 min old, else refuse (fail closed)."""
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
    clamp_end(end, now)
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


def content_hash(rows):
    blob = "\n".join(json.dumps(r, sort_keys=True, separators=(",", ":"))
                     for r in rows)
    return hashlib.sha256(blob.encode()).hexdigest()


def manifest(symbol, kind, q, rows, fetched_utc=None):
    """Manifest carrying no credential material by construction."""
    return {"source": "alpaca-market-data-v2", "endpoint": KINDS[kind],
            "symbol": symbol, "kind": kind, "query": dict(q),
            "range": {"start": q["start"], "end": q["end"]},
            "feed": FEED, "adjustment": q.get("adjustment"),
            "rows": len(rows), "sha256": content_hash(rows),
            "fetched_utc": fetched_utc or
            datetime.now(timezone.utc).isoformat()}


def write_dataset(symbol, kind, start, end, outdir, timeframe=None,
                  adjustment="raw", **kw):
    rows, q = fetch(symbol, kind, start, end, timeframe, adjustment, **kw)
    os.makedirs(outdir, exist_ok=True)
    tag = f"{symbol}_{kind}_{timeframe or 'tick'}_{adjustment}"
    path = os.path.join(outdir, tag + ".jsonl")
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, sort_keys=True, separators=(",", ":"))
                    + "\n")
    m = manifest(symbol, kind, q, rows)
    with open(os.path.join(outdir, tag + ".manifest.json"), "w") as f:
        json.dump(m, f, indent=2, sort_keys=True)
    return m
