"""Writes candidates.jsonl lines for the core passive sleeve from SIP daily
bars: at most one candidate per symbol and month (month in New York time).
The loop decides each candidate once and drops one that arrives while the
session is closed, so run this during the session; --require-open refuses to
emit when the market is closed.

    python3 ops/emit_candidates.py <loop_dir> [--require-open]

Reads ALPACA_KEY_ID / ALPACA_SECRET from the environment or the repo .env."""
import datetime
import fcntl
import json
import os
import sys
import time
import urllib.error
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from research.strategy import sip_fetch
from research.strategy.sleeves import core_passive

HISTORY_DAYS = 60
SIP_DELAY_MIN = 16  # the SIP feed refuses an end within 15 minutes of now
CLOCK_URL = "https://paper-api.alpaca.markets/v2/clock"
NY = ZoneInfo("America/New_York")


def retrying(http_get, tries=3):
    """Retry transient network/provider errors with 1s, 2s backoff."""
    def get(url, headers):
        for i in range(tries):
            try:
                return http_get(url, headers)
            except (urllib.error.URLError, OSError, ValueError):
                if i == tries - 1:
                    raise
                time.sleep(2 ** i)
    return get


def market_is_open(http_get=sip_fetch.default_http_get, headers=None):
    hdr = headers if headers is not None else sip_fetch._headers()
    return bool(retrying(http_get)(CLOCK_URL, hdr).get("is_open"))


def load_state(path):
    try:
        with open(path) as f:
            return set(json.load(f))
    except (OSError, ValueError):
        return set()


def save_state(path, keys):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sorted(keys), f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def fetch_bars(now, http_get=sip_fetch.default_http_get, headers=None):
    # Completed sessions only: today's daily bar is still forming.
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = min(midnight, now - datetime.timedelta(minutes=SIP_DELAY_MIN)
              ).strftime("%Y-%m-%dT%H:%M:%SZ")
    start = (now - datetime.timedelta(days=HISTORY_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    out = {}
    http_get = retrying(http_get)
    for sym in core_passive.SYMBOLS:
        rows, _ = sip_fetch.fetch(sym, "bars", start, end, "1Day", "raw",
                                  http_get=http_get, headers=headers, now=now)
        out[sym] = [(r["h"], r["l"], r["c"]) for r in rows]
    return out


def main(argv, now=None, is_open=market_is_open):
    args = [a for a in argv[1:] if a != "--require-open"]
    if len(args) != 1:
        raise SystemExit("usage: emit_candidates.py <loop_dir> [--require-open]")
    d = args[0]
    now = now or datetime.datetime.now(datetime.timezone.utc)
    from research.strategy import a_run
    a_run._load_env()
    if "--require-open" in argv and not is_open():
        print("market is closed: nothing emitted (the loop would drop it)",
              file=sys.stderr)
        return 3
    with open(os.path.join(d, "emitted.json.lock"), "w") as lk:
        fcntl.flock(lk, fcntl.LOCK_EX)  # one emitter at a time
        return _emit(d, now)


def _emit(d, now):
    bars = fetch_bars(now)
    state_path = os.path.join(d, "emitted.json")
    emitted = load_state(state_path)
    held = set()  # the kernel's veto refuses a collision; no broker read here
    month = now.astimezone(NY).strftime("%Y-%m")
    lines, keys = core_passive.build(bars, held, month,
                                     emitted, int(now.timestamp() * 1e9))
    # State first: a crash between the two loses a candidate for this month
    # (fail closed) rather than emitting a second buy under a new cid.
    save_state(state_path, emitted | set(keys))
    with open(os.path.join(d, "candidates.jsonl"), "a") as f:
        f.writelines(lines)
        f.flush()
        os.fsync(f.fileno())
    print(json.dumps({"emitted": keys}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
