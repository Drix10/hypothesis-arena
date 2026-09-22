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
import sys
import time
import urllib.request

UA = "MiroHedge/phase0 contact=research-plane-earnings"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK%010d.json"
WINDOW_DAYS = 3


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
