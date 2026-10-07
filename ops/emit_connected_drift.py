"""Month-end emitter for the Connected Drift Book (plan/strategies.md,
plan/execution.md): builds the target book from the datasets in research/data/
and writes one candidate per name that enters the book to candidates.jsonl.
Stale or missing data, an unapproved strategy or a short history is a HOLD:
nothing is written and the exit code is 3. Run by a human; reads no network.

    python3 ops/emit_connected_drift.py <loop_dir> [--data DIR]
                                        [--constraint-set india|us]

Under india (the default, what the kernel enforces) only longs are emitted and
the strategy is not target-set evidence; shorts need us."""
import argparse
import datetime
import fcntl
import json
import os
import sys
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ops.emit_candidates import load_state, save_state
from research.engine import link_store
from research.strategy import bar_loader, composite, sip_fetch, tranches
from research.strategy import candidate_wire as W
from research.strategy import run_connected_drift as R

STRATEGY = "connected_drift"
EXIT_RULE = "exit_link"
CONSTRAINT_SETS = ("india", "us")
REPLAY_MONTHS = 12  # tranche stack (3) and the scaler's rate cap need warm-up
ATR_DAYS = 20
TP_MULT = 1.5  # the exit is the signal; tp is a far wire placeholder
NY = ZoneInfo("America/New_York")
HOLD_ERRORS = (R.RunnerError, composite.CompositeError, tranches.TrancheError,
               link_store.LinkStoreError, W.WireError, OSError, ValueError)

_day = datetime.date.fromisoformat


class Hold(Exception):
    pass


def require_approved(loop_dir):
    try:
        with open(os.path.join(loop_dir, "approved.json"),
                  encoding="utf-8") as f:
            ids = {s["id"] for s in json.load(f)["strategies"]}
    except (OSError, ValueError, KeyError, TypeError):
        raise Hold("approved-list-unreadable") from None
    if STRATEGY not in ids:
        raise Hold("strategy-not-approved")


def month_end(sessions, today):
    """The last session of the latest completed month, if it is recent."""
    done = [d for d in sessions if d[:7] < today[:7]]
    if not done:
        raise Hold("no-completed-month")
    if (_day(today) - _day(done[-1])).days > R.STALE_DAYS:
        raise Hold("stale-month-end")
    return done[-1]


def build_book(data_dir, today, start=R.EVAL_START):
    """(as-of month end, book at it, book one month earlier)."""
    ref, filings, events = R._datasets(data_dir, today)
    vetoes = R.read_dataset(data_dir, "vetoes.json", today)
    store = R._store(data_dir)
    bars, missing = R.load_bars(data_dir, sorted(set(ref["market_cap"])
                                                 | set(R.SUPPORT)), start, today)
    if missing:
        raise Hold("bars-missing:" + ",".join(missing[:5]))
    asof = month_end(sorted(bars["SPY"]), today)
    bars = {s: {d: v for d, v in b.items() if d <= asof}
            for s, b in bars.items()}
    # Tranches and the Book read month ends off the session list, so the month
    # after `asof` closes it.
    nxt = (_day(asof).replace(day=1) + datetime.timedelta(days=32)
           ).replace(day=1).isoformat()
    sessions = sorted(bars["SPY"]) + [nxt]
    book = R.Book(sessions, bars, R.Inputs(bars, ref, store, filings, events,
                                           vetoes))
    prev, now = {}, {}
    for m in R._month_ends(sessions, start, asof)[-REPLAY_MONTHS:]:
        prev, now = now, book(m, {})
    return asof, now, prev


def entries(now, prev):
    """Names that enter the book or flip side; the wire carries no weight, the
    kernel sizes and a held name needs no candidate."""
    return sorted(s for s, x in now.items()
                  if x and prev.get(s, 0.0) * x <= 0.0)


def _bars(data_dir, sym, asof):
    path, _ = sip_fetch.dataset_paths(data_dir, sym, "bars", "1Day", "split")
    with open(path) as f:
        rows = [r for r in map(json.loads, filter(str.strip, f))
                if bar_loader._session_date(r["t"]) <= asof]
    rows = sorted(rows, key=lambda r: r["t"])[-(ATR_DAYS + 1):]
    return [r["h"] for r in rows], [r["l"] for r in rows], [r["c"] for r in rows]


def candidate_line(data_dir, sym, side, asof, now_ns):
    hi, lo, cl = _bars(data_dir, sym, asof)
    entry, stop = cl[-1], W.atr_stop(hi, lo, cl)
    if side == "SELL":
        stop, tp = 2.0 * entry - stop, entry / TP_MULT
    else:
        tp = entry * TP_MULT
    return W.wire_line(STRATEGY, sym, now_ns, entry, stop, tp, side=side,
                       exit_rule=EXIT_RULE)


def emit(loop_dir, data_dir, constraint_set, now):
    require_approved(loop_dir)
    today = now.astimezone(NY).date().isoformat()
    asof, book, prev = build_book(data_dir, today)
    if not book:
        raise Hold("empty-book")
    state_path = os.path.join(loop_dir, "connected_drift_emitted.json")
    emitted = load_state(state_path)
    now_ns = int(now.timestamp() * 1e9)
    lines, keys, shorts = [], [], []
    for sym in entries(book, prev):
        side = "BUY" if book[sym] > 0 else "SELL"
        key = "%s:%s:%s" % (STRATEGY, sym, asof[:7])
        if key in emitted or (side == "SELL" and constraint_set != "us"):
            continue
        lines.append(candidate_line(data_dir, sym, side, asof, now_ns))
        keys.append(key)
        if side == "SELL":
            shorts.append(sym)
    # State first: a crash between the two loses this month's candidates (fail
    # closed) rather than emitting them twice under a new cid.
    save_state(state_path, emitted | set(keys))
    with open(os.path.join(loop_dir, "candidates.jsonl"), "a") as f:
        f.writelines(lines)
        f.flush()
        os.fsync(f.fileno())
    return {"asof": asof, "constraint_set": constraint_set,
            "target_set_evidence": constraint_set == "us",
            "emitted": keys, "shorts": shorts}


def main(argv, now=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("loop_dir")
    ap.add_argument("--data", default=R.DATA)
    ap.add_argument("--constraint-set", choices=CONSTRAINT_SETS,
                    default="india")
    args = ap.parse_args(argv[1:])
    now = now or datetime.datetime.now(datetime.timezone.utc)
    try:
        with open(os.path.join(args.loop_dir, "connected_drift.lock"),
                  "w") as lk:
            fcntl.flock(lk, fcntl.LOCK_EX)  # one emitter at a time
            out = emit(args.loop_dir, args.data, args.constraint_set, now)
    except Hold as e:
        print(json.dumps({"hold": str(e)}), file=sys.stderr)
        return 3
    except HOLD_ERRORS as e:
        print(json.dumps({"hold": "%s: %s" % (type(e).__name__, e)}),
              file=sys.stderr)
        return 3
    print(json.dumps(out, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
