"""Backtest prices from on-disk SIP daily-bar datasets. Every dataset is
verified against its manifest before use; nothing here fetches."""
import json
import os
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import sip_fetch

NY = ZoneInfo("America/New_York")
BENCHMARK = ("SPY", "IEF")


def benchmark_symbols(universe):
    """The universe plus the 60/40 benchmark legs, de-duplicated, sorted."""
    return sorted(set(universe) | set(BENCHMARK))


def _session_date(stamp):
    return sip_fetch._utc(stamp).astimezone(NY).date().isoformat()


def load_prices(outdir, symbols, start, end, *, timeframe="1Day",
                adjustment="split"):
    """{symbol: {iso_session_date: (open, close)}} for dates in [start, end].
    start and end are inclusive ISO dates. adjustment "split" (default)
    serves signals; "raw" serves total-return accounting, with dividends
    supplied separately to portfolio.run ("all" would double-count them).
    A missing dataset raises
    FileNotFoundError; a hash or manifest mismatch raises SipError."""
    prices = {}
    for sym in symbols:
        m = sip_fetch.verify_dataset(outdir, sym, "bars", timeframe,
                                     adjustment)
        data_path, _ = sip_fetch.dataset_paths(outdir, sym, "bars", timeframe,
                                               adjustment)
        with open(data_path) as f:
            rows = [json.loads(line) for line in f if line.strip()]
        if len(rows) != m.get("rows"):
            raise sip_fetch.SipError("dataset-manifest-mismatch:" + sym)
        series = {}
        for r in rows:
            day = _session_date(r["t"])
            if start <= day <= end:
                series[day] = (float(r["o"]), float(r["c"]))
        prices[sym] = series
    return prices
