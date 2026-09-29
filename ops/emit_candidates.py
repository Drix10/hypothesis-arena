"""Writes candidates.jsonl lines for the core passive sleeve from SIP daily
bars. Run once per session after the close; at most one emission per symbol and month.

    python3 ops/emit_candidates.py <loop_dir>

Reads ALPACA_KEY_ID / ALPACA_SECRET from the environment or the repo .env."""
import datetime
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from research.strategy import sip_fetch
from research.strategy.sleeves import core_passive

HISTORY_DAYS = 60
DELAY_MIN = 20


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
    end = (now - datetime.timedelta(minutes=DELAY_MIN)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    start = (now - datetime.timedelta(days=HISTORY_DAYS)).strftime(
        "%Y-%m-%dT%H:%M:%SZ")
    out = {}
    for sym in core_passive.SYMBOLS:
        rows, _ = sip_fetch.fetch(sym, "bars", start, end, "1Day", "raw",
                                  http_get=http_get, headers=headers, now=now)
        out[sym] = [(r["h"], r["l"], r["c"]) for r in rows]
    return out


def main(argv, now=None):
    if len(argv) != 2:
        raise SystemExit("usage: emit_candidates.py <loop_dir>")
    d = argv[1]
    now = now or datetime.datetime.now(datetime.timezone.utc)
    from research.strategy import a_run
    a_run._load_env()
    bars = fetch_bars(now)
    state_path = os.path.join(d, "emitted.json")
    emitted = load_state(state_path)
    held = set()  # the kernel's veto refuses a collision; no broker read here
    lines, keys = core_passive.build(bars, held, now.strftime("%Y-%m"),
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
