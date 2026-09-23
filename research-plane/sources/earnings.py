"""EDGAR-derived earnings-event veto gate (doc 09 sec. 9.1 Tier A, veto side).

Free tier, no key. Derives earnings event windows from EDGAR:
  symbol -> CIK via www.sec.gov/files/company_tickers.json (keyless)
  -> data.sec.gov/submissions/CIK{cik:010d}.json recent filings:
     8-K with Item 2.02 (Results of Operations) plus 10-Q/10-K
     filings count as earnings event dates.

Frozen contract: TRIGGER veto-side, used only to SUPPRESS entries into
known events, never to predict. Unknown -> treat as event-present ->
no entry. So has_event() returns True (suppress) whenever anything is
unresolvable: unknown symbol, fetch failure, empty filing data.

Stdlib only. Network access is injectable (fetcher) so the fail-closed
posture is unit-testable offline; the __main__ probe exercises the
live path and records p50/p99 per doc 09 sec. 9.4.
"""
import json
import os
import sys
import time
import urllib.request

UA = "MiroHedge/phase0 contact=research-plane-earnings"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK%010d.json"
WINDOW_DAYS = 3

# Operational wiring (doc 09 sec. 9.3/9.4): EDGAR table row says source
# `stale` after 15 min. Poll cadence 5 min; missed heartbeat > 3x
# cadence == TTL, so one constant governs both. Heartbeats persist to
# a JSON file for cross-process JEV reads: FileNotFoundError =
# absent/fresh (never stale on first boot); unreadable = invalid ->
# stale (fail closed). Stale/missing is ABSENT, never neutral: the
# gate suppresses whenever the source is not provably fresh+event-free.
CADENCE_S = 300
TTL_S = 3 * CADENCE_S
HEARTBEAT_VERSION = 1


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA,
                                               "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def load_tickers(fetcher=fetch_json):
    """{SYMBOL: CIK int}. Raises on any failure (caller treats as unknown)."""
    raw = fetcher(TICKERS_URL)
    out = {}
    for row in raw.values():
        out[str(row["ticker"]).upper()] = int(row["cik_str"])
    return out


def recent_event_dates(cik, fetcher=fetch_json):
    """Earnings event dates (filingDate strings) for a CIK.

    Raises on any failure; empty list means no usable filing data
    (caller treats as unknown, NOT as event-free).
    """
    sub = fetcher(SUBMISSIONS_URL % cik)
    recent = sub.get("filings", {}).get("recent", {})
    forms = recent.get("form", [])
    dates = recent.get("filingDate", [])
    items = recent.get("items", [])
    found = []
    for form, date, item in zip(forms, dates, items):
        if form in ("10-Q", "10-K"):
            found.append(date)
        elif form == "8-K" and "2.02" in str(item):
            found.append(date)
    return found


def _within(date_s, asof_s, window_days):
    from datetime import date
    d = date.fromisoformat(date_s)
    a = date.fromisoformat(asof_s)
    return abs((d - a).days) <= window_days


def has_event(symbol, asof, fetcher=fetch_json,
              window_days=WINDOW_DAYS):
    """True = event risk present -> suppress entries for symbol on asof
    (YYYY-MM-DD). Unknown (unresolvable symbol, fetch failure, empty
    data, bad date) is True: fail closed, never assume event-free."""
    try:
        tickers = load_tickers(fetcher)
        cik = tickers[symbol.upper()]
        dates = recent_event_dates(cik, fetcher)
        if not dates:
            return True
        return any(_within(d, asof, window_days) for d in dates)
    except Exception:
        return True


def poll(symbols=("AAPL", "MSFT"), fetcher=fetch_json, now=None):
    """One poller cycle: per-symbol gate evaluation + heartbeat record.
    Returns {version, ts, cadence_s, ttl_s, ok, latency_ms, symbols:
    [{symbol, suppress, events_seen, error}]}. ok=False on ANY symbol
    failure (heartbeat records the outage; suppression stays fail-closed
    per symbol). fetcher takes a bare URL (fetch_json's timeout
    defaults); now= injectable for offline tests."""
    now = now if now is not None else time.time()
    t0 = time.monotonic()
    rows, ok = [], True
    try:
        tickers = load_tickers(fetcher)
    except Exception:
        tickers = None
    for sym in symbols:
        try:
            if tickers is None:
                raise RuntimeError("tickers-unavailable")
            cik = tickers[sym.upper()]
            dates = recent_event_dates(cik, fetcher)
            if not dates:
                raise RuntimeError("empty-filings")
            asof = time.strftime("%Y-%m-%d", time.gmtime(now))
            rows.append({"symbol": sym, "suppress": any(
                _within(d, asof, WINDOW_DAYS) for d in dates),
                "events_seen": len(dates), "error": None})
        except Exception as e:
            ok = False
            rows.append({"symbol": sym, "suppress": True,
                         "events_seen": 0,
                         "error": "%s" % type(e).__name__})
    ms = (time.monotonic() - t0) * 1000.0
    return {"version": HEARTBEAT_VERSION, "ts": now,
            "cadence_s": CADENCE_S, "ttl_s": TTL_S, "ok": ok,
            "latency_ms": round(ms, 1), "symbols": rows}


def write_heartbeat(path, hb):
    """Durable heartbeat for cross-process readers. Atomic replace so
    readers never see a torn file."""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(hb, fh)
    os.replace(tmp, path)
    return path


def read_heartbeat(path, now=None):
    """(heartbeat-or-None, state). state in {fresh, absent, invalid,
    stale}. absent = file never written (fresh boot, not a failure);
    invalid = unreadable/wrong-version (fail closed -> stale handling
    upstream); stale = age > TTL."""
    now = now if now is not None else time.time()
    try:
        with open(path, encoding="utf-8") as fh:
            hb = json.load(fh)
    except FileNotFoundError:
        return None, "absent"
    except Exception:
        return None, "invalid"
    if not isinstance(hb, dict) or hb.get("version") != HEARTBEAT_VERSION:
        return None, "invalid"
    if now - hb.get("ts", 0) > TTL_S:
        return hb, "stale"
    return hb, "fresh"


def gate(symbols=("AAPL", "MSFT"), heartbeat_path=None,
         fetcher=fetch_json, now=None):
    """Wired veto decision for JEV consumption. Returns
    {suppress: bool, reason: str} where reason in
    {event, unknown, stale, invalid, absent}. absent (never polled)
    suppresses: no evidence of event-free is not event-free."""
    now = now if now is not None else time.time()
    hb, state = read_heartbeat(heartbeat_path, now) \
        if heartbeat_path else (None, "absent")
    if state != "fresh" or not (hb or {}).get("ok", False):
        if state == "fresh":
            return {"suppress": True, "reason": "unknown"}
        return {"suppress": True, "reason": state}
    by_sym = {r["symbol"]: r for r in hb.get("symbols", [])}
    for sym in symbols:
        r = by_sym.get(sym)
        if r is None or r.get("error") or r.get("suppress"):
            return {"suppress": True,
                    "reason": "unknown" if r is None or r.get("error")
                    else "event"}
    return {"suppress": False, "reason": "event-free"}


def measure(symbols=("AAPL", "MSFT"), timeout=30):
    """Live probe: timed lookup per symbol + evidence record. Exit 0
    always (evidence, not a gate)."""
    lats, rows = [], []
    for sym in symbols:
        t0 = time.monotonic()
        try:
            tickers = load_tickers(
                lambda u: fetch_json(u, timeout))
            dates = recent_event_dates(
                tickers[sym], lambda u: fetch_json(u, timeout))
            ms = (time.monotonic() - t0) * 1000.0
            rows.append({"symbol": sym, "status": 200,
                         "latency_ms": round(ms, 1),
                         "events_seen": len(dates),
                         "latest": max(dates) if dates else None})
            lats.append(ms)
        except Exception as e:
            ms = (time.monotonic() - t0) * 1000.0
            rows.append({"symbol": sym, "status": "DOWN",
                         "latency_ms": round(ms, 1),
                         "error": "%s: %s" % (type(e).__name__, e)})
            lats.append(ms)
    lats.sort()
    return {"ts": int(time.time()), "ua": UA, "window_days": WINDOW_DAYS,
            "symbols": rows,
            "p50_ms": round(lats[len(lats) // 2], 1) if lats else None,
            "p99_ms": round(lats[-1], 1) if lats else None}


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else None
    ev = measure()
    print(json.dumps(ev, indent=1)[:1200])
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(ev, fh, indent=1)
        print("wrote", out)
