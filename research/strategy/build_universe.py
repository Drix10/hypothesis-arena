"""Human-run builder of the Connected Drift symbol list (plan/strategies.md,
Universe). Reads files the other fetchers wrote and downloads nothing: an EDGAR
form.idx body of 10-K filers, reference.json (ciks, market_cap) and the SIP
daily bars on disk. Writes universe_symbols.txt for fetch_universe_bars and a
manifest with the filter counts."""
import argparse
import datetime
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import customer_coverage_probe, issuer_symbols, sip_fetch
from research.strategy.fetch_universe_bars import REQUIRED

MIN_PRICE = 5.0
MIN_DOLLAR_VOLUME = 10e6
MEDIAN_SESSIONS = 60
MIN_CAP = 500e6
MIN_SHORT_CAP = 1e9
EXCLUDE_LARGEST = 100
STALE_DAYS = 7  # matches run_connected_drift.STALE_DAYS


class UniverseError(ValueError):
    pass


def _day(s):
    return datetime.date.fromisoformat(s[:10])


def listed_symbols(ciks, filers):
    """{symbol: cik} for the reference.json ciks ({cik: symbol}) whose CIK
    filed a 10-K."""
    filed = {f["cik"] for f in filers}
    out = {}
    for cik, sym in sorted(ciks.items(), key=lambda kv: int(kv[0])):
        sym = str(sym).strip().upper()
        if int(cik) in filed and issuer_symbols.SYMBOL_RE.match(sym):
            out.setdefault(sym, int(cik))
    return out


def market_caps(reference, as_of):
    """{symbol: market cap} using the latest entry known strictly before
    as_of; a symbol with no such entry is absent."""
    out = {}
    for sym, series in reference["market_cap"].items():
        known = [e for e in series if _day(e["known_at"]) < as_of]
        if known:
            out[sym] = float(max(known, key=lambda e: e["known_at"])["value"])
    return out


def liquidity(outdir, sym, as_of):
    """(last close, 60-session median dollar volume) from the verified
    split-adjusted bars on or before as_of, or None when the dataset is
    missing, unverified or older than STALE_DAYS."""
    try:
        sip_fetch.verify_dataset(outdir, sym, "bars", "1Day", "split")
        path, _ = sip_fetch.dataset_paths(outdir, sym, "bars", "1Day", "split")
        with open(path, encoding="utf-8") as f:
            rows = [json.loads(ln) for ln in f if ln.strip()]
    except (OSError, ValueError):
        return None
    rows = sorted((r for r in rows if _day(r["t"]) <= as_of),
                  key=lambda r: r["t"])[-MEDIAN_SESSIONS:]
    if (len(rows) < MEDIAN_SESSIONS
            or (as_of - _day(rows[-1]["t"])).days > STALE_DAYS):
        return None
    return (float(rows[-1]["c"]),
            statistics.median(float(r["c"]) * float(r["v"]) for r in rows))


def build(reference, filers, as_of, bars_dir):
    """(symbols, manifest). A symbol without a market cap before as_of or
    without current verified bars is excluded and counted by reason."""
    listed = listed_symbols(reference["ciks"], filers)
    caps = market_caps(reference, as_of)
    counts = {"listed_10k_filers": len(listed)}
    keep = set(listed)
    counts["no_market_cap"] = len(keep - set(caps))
    keep &= set(caps)
    counts["below_cap"] = sum(caps[s] < MIN_CAP for s in keep)
    keep = {s for s in keep if caps[s] >= MIN_CAP}
    largest = set(sorted(keep, key=lambda s: (-caps[s], s))[:EXCLUDE_LARGEST])
    counts["largest_excluded"] = len(largest)
    keep -= largest
    liq = {s: liquidity(bars_dir, s, as_of) for s in keep}
    counts["no_current_bars"] = sum(v is None for v in liq.values())
    counts["below_price"] = sum(
        v is not None and v[0] < MIN_PRICE for v in liq.values())
    counts["below_dollar_volume"] = sum(
        v is not None and v[0] >= MIN_PRICE and v[1] < MIN_DOLLAR_VOLUME
        for v in liq.values())
    keep = {s for s, v in liq.items() if v is not None
            and v[0] >= MIN_PRICE and v[1] >= MIN_DOLLAR_VOLUME}
    counts["short_eligible"] = sum(caps[s] >= MIN_SHORT_CAP for s in keep)
    counts["stocks"] = len(keep)
    symbols = sorted(keep | set(REQUIRED))
    manifest = {"as_of": as_of.isoformat(), "counts": counts,
                "symbols": len(symbols),
                "ticker_resolution": "reference.json ciks"}
    return symbols, manifest


def _write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def main(argv=None, log=print):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--filers", required=True, help="EDGAR form.idx body")
    ap.add_argument("--as-of", required=True, help="ISO date")
    ap.add_argument("--data", default=os.path.join("research", "data"))
    args = ap.parse_args(argv)
    as_of = _day(args.as_of)
    try:
        ds = _read_json(os.path.join(args.data, "reference.json"))
    except OSError as e:
        raise UniverseError("dataset-missing:reference.json") from e
    if _day(ds["through"]) < as_of - datetime.timedelta(days=STALE_DAYS):
        raise UniverseError("dataset-stale:reference.json")
    with open(args.filers, encoding="utf-8") as f:
        filers = customer_coverage_probe.parse_index(f.read())
    symbols, manifest = build(ds["data"], filers, as_of, args.data)
    _write(os.path.join(args.data, "universe_symbols.txt"),
           "".join(s + "\n" for s in symbols))
    _write(os.path.join(args.data, "universe_manifest.json"),
           json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    log(json.dumps(manifest["counts"], sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
