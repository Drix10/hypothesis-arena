"""Human-run builder of the Connected Drift symbol list (plan/strategies.md,
Universe). Reads files the other fetchers wrote and downloads nothing: SEC
company_tickers.json, an EDGAR form.idx body of 10-K filers, reference.json and
(optional) SIP daily bars. Writes universe_symbols.txt for fetch_universe_bars
and a manifest with the filter counts."""
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


def listed_symbols(tickers, filers):
    """{symbol: cik} for the company_tickers rows whose CIK filed a 10-K."""
    ciks = {f["cik"] for f in filers}
    out = {}
    for row in tickers.values():
        sym = str(row.get("ticker", "")).strip().upper()
        if int(row["cik_str"]) in ciks and issuer_symbols.SYMBOL_RE.match(sym):
            out.setdefault(sym, int(row["cik_str"]))
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


def build(tickers, filers, as_of, reference=None, bars_dir=None):
    """(symbols, manifest). Without reference the market cap filters are not
    applied, without bars_dir the price and dollar volume filters are not; the
    manifest records which ran."""
    listed = listed_symbols(tickers, filers)
    counts = {"listed_10k_filers": len(listed)}
    keep = set(listed)
    caps = None
    if reference is not None:
        caps = market_caps(reference, as_of)
        counts["no_market_cap"] = len(keep - set(caps))
        keep &= set(caps)
        counts["below_cap"] = sum(caps[s] < MIN_CAP for s in keep)
        keep = {s for s in keep if caps[s] >= MIN_CAP}
        largest = set(sorted(keep, key=lambda s: (-caps[s], s))
                      [:EXCLUDE_LARGEST])
        counts["largest_excluded"] = len(largest)
        keep -= largest
    if bars_dir is not None:
        liq = {s: liquidity(bars_dir, s, as_of) for s in keep}
        counts["no_current_bars"] = sum(v is None for v in liq.values())
        counts["below_price"] = sum(
            v is not None and v[0] < MIN_PRICE for v in liq.values())
        counts["below_dollar_volume"] = sum(
            v is not None and v[0] >= MIN_PRICE and v[1] < MIN_DOLLAR_VOLUME
            for v in liq.values())
        keep = {s for s, v in liq.items() if v is not None
                and v[0] >= MIN_PRICE and v[1] >= MIN_DOLLAR_VOLUME}
    counts["short_eligible"] = (
        sum(caps[s] >= MIN_SHORT_CAP for s in keep) if caps is not None else None)
    counts["stocks"] = len(keep)
    symbols = sorted(keep | set(REQUIRED))
    manifest = {"as_of": as_of.isoformat(), "counts": counts,
                "filters": {"market_cap": caps is not None,
                            "price_and_dollar_volume": bars_dir is not None},
                "symbols": len(symbols)}
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
    ap.add_argument("--tickers", required=True, help="company_tickers.json")
    ap.add_argument("--filers", required=True, help="EDGAR form.idx body")
    ap.add_argument("--as-of", required=True, help="ISO date")
    ap.add_argument("--data", default=os.path.join("research", "data"))
    ap.add_argument("--bars", action="store_true",
                    help="apply the price and dollar volume filters to the "
                         "bars in --data")
    args = ap.parse_args(argv)
    as_of = _day(args.as_of)
    ref = None
    ref_path = os.path.join(args.data, "reference.json")
    if os.path.exists(ref_path):
        ds = _read_json(ref_path)
        if _day(ds["through"]) < as_of - datetime.timedelta(days=STALE_DAYS):
            raise UniverseError("dataset-stale:reference.json")
        ref = ds["data"]
    with open(args.filers, encoding="utf-8") as f:
        filers = customer_coverage_probe.parse_index(f.read())
    symbols, manifest = build(_read_json(args.tickers), filers, as_of, ref,
                              args.data if args.bars else None)
    _write(os.path.join(args.data, "universe_symbols.txt"),
           "".join(s + "\n" for s in symbols))
    _write(os.path.join(args.data, "universe_manifest.json"),
           json.dumps(manifest, indent=2, sort_keys=True) + "\n")
    log(json.dumps(manifest["counts"], sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
