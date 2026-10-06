"""Human-run fetch of split-adjusted SIP daily bars to research/data/ for the
Connected Drift and ETF Trend universe. Credentials come from the environment
only. Prints the request estimate and fetches nothing without --yes."""
import argparse
import datetime
import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import bulk_bars, passive_core, sip_fetch

REQUIRED = tuple(sorted({"SPY", "VTI", "IEF", "BIL"} | set(passive_core.SYMBOLS)))
ADJUSTMENT = "split"
STALE_DAYS = 7  # matches run_connected_drift.STALE_DAYS
BARS_PER_PAGE = 10000
SESSIONS_PER_DAY = 5 / 7
DEFAULT_START = "2016-01-01"


def read_symbols(path):
    with open(path, encoding="utf-8") as f:
        syms = {ln.split("#")[0].strip().upper() for ln in f}
    syms.discard("")
    return sorted(syms | set(REQUIRED))


def _day(s):
    return datetime.date.fromisoformat(s[:10])


def window(start, end, now):
    """(start, end) ISO timestamps; the end is capped at the SIP delay."""
    cap = now - sip_fetch.DELAY - datetime.timedelta(minutes=5)
    stop = datetime.datetime.combine(_day(end) + datetime.timedelta(days=1),
                                     datetime.time(), datetime.timezone.utc)
    stop = min(stop, cap)
    return start + "T00:00:00Z", stop.strftime("%Y-%m-%dT%H:%M:%SZ")


def is_current(outdir, sym, start, end):
    """True for a verified dataset covering [start, end] within STALE_DAYS."""
    try:
        m = sip_fetch.verify_dataset(outdir, sym, "bars", "1Day", ADJUSTMENT)
    except (OSError, ValueError):
        return False
    rng = m.get("range") or {}
    try:
        return (_day(rng["start"]) <= _day(start) and _day(rng["end"]) >=
                _day(end) - datetime.timedelta(days=STALE_DAYS))
    except (KeyError, ValueError, TypeError):
        return False


def estimate(todo, start, end):
    """(requests, minutes): one request per page per symbol, throttled."""
    days = (_day(end) - _day(start)).days
    pages = max(1, math.ceil(days * SESSIONS_PER_DAY / BARS_PER_PAGE))
    n = len(todo) * pages
    return n, n * bulk_bars.MIN_INTERVAL_S / 60


def _drop_stale(outdir, sym):
    _, man = sip_fetch.dataset_paths(outdir, sym, "bars", "1Day", ADJUSTMENT)
    if os.path.exists(man):
        os.remove(man)  # fetch_all skips any dataset that still verifies


def main(argv=None, env=None, now=None, log=print, **fetch_kw):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("symbols_file", help="one symbol per line, # comments")
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", help="ISO date, default today (UTC)")
    ap.add_argument("--out", default=os.path.join(
        os.path.dirname(__file__), "..", "data"))
    ap.add_argument("--yes", action="store_true",
                    help="start fetching after the estimate")
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    now = now or datetime.datetime.now(datetime.timezone.utc)
    end = a.end or now.date().isoformat()
    start_ts, end_ts = window(a.start, end, now)
    syms = read_symbols(a.symbols_file)
    todo = [s for s in syms if not is_current(a.out, s, start_ts, end_ts)]
    reqs, minutes = estimate(todo, start_ts, end_ts)
    log(f"{len(syms)} symbols, {len(syms) - len(todo)} current, "
        f"{len(todo)} to fetch: about {reqs} requests, {minutes:.1f} minutes")
    if not a.yes:
        log("not fetching: pass --yes to start")
        return 2
    key, secret = env.get("ALPACA_KEY_ID"), env.get("ALPACA_SECRET")
    if not key or not secret:
        log("ALPACA_KEY_ID and ALPACA_SECRET must be exported")
        return 2
    for s in todo:
        _drop_stale(a.out, s)
    done, failed = bulk_bars.fetch_all(
        todo, ADJUSTMENT, a.out, start_ts, end_ts, log=log, load_env=False,
        headers={"APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret},
        now=now, **fetch_kw)
    log(json.dumps({"fetched": done, "failed": failed}))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
