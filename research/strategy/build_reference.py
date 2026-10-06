"""Human-run build of research/data/reference.json for connected_drift: ciks,
two-digit SIC industry, month-end market cap and 252-session beta to SPY, in the
contract read by run_connected_drift. SEC requests need MIRO_CONTACT; the
per-symbol SEC extract is cached, so a rerun resumes. Nothing is filled: a
symbol without shares or enough bars is omitted and counted by reason."""
import argparse
import collections
import datetime
import json
import math
import os
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, os.path.join(ROOT, ".."))
sys.path.insert(0, ROOT)

from sources import (edgar, shares_outstanding, ticker_map,
                     ticker_observations)
from research.strategy import bar_loader, fetch_universe_bars

BETA_SESSIONS = 252
BENCH = "SPY"
KEEP = (shares_outstanding.SHARES_CONCEPT, "TradingSymbol")
DATA = os.path.join(ROOT, "data")

_day = datetime.date.fromisoformat


def month_ends(sessions):
    """Last session of each month that a later session follows."""
    return [a for a, b in zip(sessions, sessions[1:]) if a[:7] != b[:7]]


def beta(closes, bench, window):
    """OLS slope of the symbol's daily returns on the benchmark's over the
    consecutive benchmark sessions `window`; None when the symbol lacks a close
    on any of them or the benchmark has no variance."""
    if any(d not in closes for d in window):
        return None
    pairs = list(zip(window, window[1:]))
    x = [bench[b] / bench[a] - 1.0 for a, b in pairs]
    y = [closes[b] / closes[a] - 1.0 for a, b in pairs]
    mx, my = sum(x) / len(x), sum(y) / len(y)
    var = sum((v - mx) ** 2 for v in x)
    if var <= 0:
        return None
    return sum((a - mx) * (b - my) for a, b in zip(x, y)) / var


def symbol_series(facts, closes, bench, months):
    """(market cap entries, beta entries) at the month-ends in `months`, each
    known_at the month-end. A month-end without a close, filed shares or enough
    aligned sessions has no entry.
    lean: cover-page shares are not split-adjusted and the bars are, so a
    month-end before a split understates market cap by the ratio; store raw
    bars to remove it."""
    days = sorted(bench)
    index = {d: i for i, d in enumerate(days)}
    caps, betas = [], []
    for m in months:
        if m in closes:
            try:
                sh = shares_outstanding.shares(facts, m)["value"]
                caps.append({"known_at": m, "value": sh * closes[m]})
            except shares_outstanding.SharesError:
                pass
        i = index[m]
        if i >= BETA_SESSIONS:
            b = beta(closes, bench, days[i - BETA_SESSIONS:i + 1])
            if b is not None and math.isfinite(b):
                betas.append({"known_at": m, "value": b})
    return caps, betas


def build(universe, records, bars, end):
    """(reference data, {symbol: omission reason}). `records` is {symbol:
    {cik, sic, facts}} from the SEC; `bars` is {symbol: {date: (open, close)}}
    including SPY."""
    bench = {d: c for d, (_, c) in bars[BENCH].items()}
    months = [m for m in month_ends(sorted(bench)) if m <= end]
    data = {"ciks": {}, "industry": {}, "market_cap": {}, "beta": {}}
    omitted = {}
    for sym in sorted(universe):
        rec = records.get(sym)
        if rec is None:
            omitted[sym] = "no-cik"
            continue
        cik = "%010d" % rec["cik"]
        sic = str(rec.get("sic") or "").zfill(4)
        obs, _ = ticker_observations.dei_observations(rec["facts"])
        listed = ticker_map.ticker(obs, rec["cik"], _day(end))
        if listed is not None and listed.replace("-", ".") != sym.replace(
                "-", "."):
            omitted[sym] = "ticker-mismatch"
        elif cik in data["ciks"]:
            omitted[sym] = "shared-cik"
        elif not sic.isdigit() or sic == "0000":
            omitted[sym] = "no-sic"
        elif sym not in bars:
            omitted[sym] = "no-bars"
        else:
            closes = {d: c for d, (_, c) in bars[sym].items()}
            caps, betas = symbol_series(rec["facts"], closes, bench, months)
            if not caps:
                omitted[sym] = "no-shares"
            elif not betas:
                omitted[sym] = "short-bars"
            else:
                data["ciks"][cik] = sym
                data["industry"][sym] = sic[:2]
                data["market_cap"][sym] = caps
                data["beta"][sym] = betas
    return data, omitted


def _prune(facts):
    dei = (facts.get("facts") or {}).get("dei") or {}
    return {"cik": facts.get("cik"),
            "facts": {"dei": {k: dei[k] for k in KEEP if k in dei}}}


def _get_json(adapter, url):
    _status, _headers, body, err = adapter._get(url)
    if err or body is None:
        raise OSError(err or "empty body")
    return json.loads(body.decode("utf-8"))


def fetch_record(adapter, cik):
    """{cik, sic, facts} from the submissions and companyfacts records."""
    sub = _get_json(adapter, edgar.SUBMISSIONS_URL % cik)
    facts = _get_json(adapter, edgar.COMPANYFACTS_URL % cik)
    return {"cik": cik, "sic": str(sub.get("sic") or ""),
            "facts": _prune(facts)}


def _atomic_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def load_records(universe, cache_dir, adapter, log):
    """({symbol: record}, {symbol: reason}); records are cached per symbol and
    only fetched when missing. A failed fetch is returned, never cached."""
    records, failed = {}, {}
    tickers, _state, err = adapter._load_tickers()
    if not tickers:
        raise OSError("company_tickers unavailable: %s" % err)
    os.makedirs(cache_dir, exist_ok=True)
    for sym in universe:
        path = os.path.join(cache_dir, sym + ".json")
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                records[sym] = json.load(f)
            continue
        cik = tickers.get(sym.upper()) or tickers.get(sym.upper().replace(
            ".", "-"))
        if cik is None:
            failed[sym] = "no-cik"
            continue
        try:
            records[sym] = fetch_record(adapter, cik)
        except (OSError, ValueError) as e:
            failed[sym] = "fetch-failed: %s" % e
            continue
        _atomic_json(path, records[sym])
        log("fetched %s" % sym)
    return records, failed


def main(argv=None, env=None, log=print, **adapter_kw):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("symbols_file", help="one symbol per line, # comments")
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--start", default=fetch_universe_bars.DEFAULT_START)
    ap.add_argument("--end", help="ISO date, default the last SPY session")
    ap.add_argument("--cache", help="default <data>/reference_cache")
    ap.add_argument("--yes", action="store_true",
                    help="start the SEC requests after the estimate")
    a = ap.parse_args(argv)
    contact = edgar.contact_from_env(env)
    if not contact:
        log("MIRO_CONTACT must be exported")
        return 2
    universe = [s for s in fetch_universe_bars.read_symbols(a.symbols_file)
                if s not in fetch_universe_bars.REQUIRED]
    cache = a.cache or os.path.join(a.data, "reference_cache")
    todo = [s for s in universe
            if not os.path.exists(os.path.join(cache, s + ".json"))]
    log("%d symbols, %d to fetch: about %d SEC requests" % (
        len(universe), len(todo), 2 * len(todo) + 1))
    if not a.yes:
        log("not fetching: pass --yes to start")
        return 2
    adapter = edgar.Adapter(contact, cache_dir=cache, **adapter_kw)
    records, failed = load_records(universe, cache, adapter, log)
    spy_days = sorted(bar_loader.load_prices(
        a.data, [BENCH], a.start, a.end or "9999-12-31")[BENCH])
    if not spy_days:
        log("no SPY bars on disk")
        return 1
    end = a.end or spy_days[-1]
    have = [s for s in universe if s in records]
    bars = {}
    for s in have + [BENCH]:
        try:
            bars.update(bar_loader.load_prices(a.data, [s], a.start, end))
        except FileNotFoundError:
            pass
    data, omitted = build(have, records, bars, end)
    omitted.update(failed)
    counts = collections.Counter(r.split(":")[0] for r in omitted.values())
    log(json.dumps({"symbols": len(data["market_cap"]),
                    "omitted": dict(sorted(counts.items()))}))
    if any(r.startswith("fetch-failed") for r in omitted.values()):
        log("not written: rerun to retry the failed fetches")
        return 1
    _atomic_json(os.path.join(a.data, "reference.json"),
                 {"through": end, "data": data})
    return 0


if __name__ == "__main__":
    sys.exit(main(env=os.environ))
