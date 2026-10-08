"""Human-run build of research/data/reference.json for connected_drift: ciks,
two-digit SIC industry, month-end market cap and 252-session beta to SPY, in the
contract read by run_connected_drift. SEC requests need MIRO_CONTACT; the
per-symbol SEC extract is cached until the build runs past its fetch date, so
a rerun resumes. Nothing is filled: a
symbol without shares or enough bars is omitted and counted by reason."""
import argparse
import collections
import datetime
import functools
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
# SEC companyfacts for large filers exceeds the poller's 2 MiB body cap.
MAX_BODY_BYTES = 256 << 20

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


class NoFacts(Exception):
    """SEC has no record for the CIK (HTTP 404): permanent, not a fetch fault."""


def failure_class(reason):
    """Class of a `load_records` failure reason, for the printed summary."""
    if not reason.startswith("fetch-failed"):
        return reason
    if "HTTP 429" in reason:
        return "http-429"
    if "HTTP 5" in reason:
        return "http-5xx"
    if "HTTP " in reason:
        return "http-other"
    if "oversized" in reason:
        return "oversized"
    if "imeout" in reason or "timed out" in reason:
        return "timeout"
    if "bad json" in reason:
        return "bad-json"
    return "network"


def _get_json(adapter, url):
    status, _headers, body, err = adapter._get(url)
    if status == 404:
        raise NoFacts(err)
    if err or body is None:
        raise OSError(err or "empty body")
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError as e:
        raise OSError("bad json: %s" % e)


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


def cached(cache_dir, sym, end):
    """The cached record for `sym` if it was fetched on or after `end`, else
    None: an older record lacks shares filed after its fetch, so a build
    through a later date refetches it."""
    path = os.path.join(cache_dir, sym + ".json")
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        rec = json.load(f)
    return rec if rec.get("fetched", "") >= end else None


def load_records(universe, cache_dir, adapter, log, end, today):
    """({symbol: record}, {symbol: reason}); records are cached per symbol,
    stamped with the fetch date `today`, and fetched when missing or older than
    `end`. A failed fetch is returned, never cached."""
    records, failed = {}, {}
    tickers, _state, err = adapter._load_tickers()
    if not tickers:
        raise OSError("company_tickers unavailable: %s" % err)
    os.makedirs(cache_dir, exist_ok=True)
    for sym in universe:
        rec = cached(cache_dir, sym, end)
        if rec is not None:
            records[sym] = rec
            continue
        cik = tickers.get(sym.upper()) or tickers.get(sym.upper().replace(
            ".", "-"))
        if cik is None:
            failed[sym] = "no-cik"
            continue
        try:
            records[sym] = dict(fetch_record(adapter, cik), fetched=today)
        except NoFacts:
            failed[sym] = "no-facts"
            continue
        except (OSError, ValueError) as e:
            failed[sym] = "fetch-failed: %s" % e
            continue
        _atomic_json(os.path.join(cache_dir, sym + ".json"), records[sym])
        log("fetched %s" % sym)
    return records, failed


def main(argv=None, env=None, log=print, today=None, **adapter_kw):
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
    spy_days = sorted(bar_loader.load_prices(
        a.data, [BENCH], a.start, a.end or "9999-12-31")[BENCH])
    if not spy_days:
        log("no SPY bars on disk")
        return 1
    end = a.end or spy_days[-1]
    cache = a.cache or os.path.join(a.data, "reference_cache")
    todo = [s for s in universe if cached(cache, s, end) is None]
    log("%d symbols, %d to fetch: about %d SEC requests" % (
        len(universe), len(todo), 2 * len(todo) + 1))
    if not a.yes:
        log("not fetching: pass --yes to start")
        return 2
    adapter_kw.setdefault("transport", functools.partial(
        edgar._default_transport, limit=MAX_BODY_BYTES))
    adapter = edgar.Adapter(contact, cache_dir=cache,
                            max_body_bytes=MAX_BODY_BYTES, **adapter_kw)
    today = today or datetime.datetime.now(datetime.timezone.utc).date(
        ).isoformat()
    records, failed = load_records(universe, cache, adapter, log, end, today)
    have = [s for s in universe if s in records]
    bars = {}
    for s in have + [BENCH]:
        try:
            bars.update(bar_loader.load_prices(a.data, [s], a.start, end))
        except FileNotFoundError:
            pass
    data, omitted = build(have, records, bars, end)
    omitted.update(failed)
    first = {}
    for sym, r in failed.items():
        first.setdefault(failure_class(r), (sym, r))
    for cls, (sym, r) in sorted(first.items()):
        n = sum(failure_class(v) == cls for v in failed.values())
        log("%s: %d, first %s (%s)" % (cls, n, sym, r))
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
