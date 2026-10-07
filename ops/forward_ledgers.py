"""Forward shadow ledgers for every strategy that is not routed to the broker.

Log-only: no orders, no broker calls beyond the read-only SIP daily bars. Each
strategy runs through the same settled-cash engine and cost model the backtest gate
uses, decided at each close and filled at the next open. One append-only,
hash-chained line per strategy per session lands in <dir>/ledgers/<strategy>.jsonl.

Only sessions on or after FORWARD_START are recorded, so a backtest holdout
that ends before it is never reported. Earlier bars warm up the signal only.

    python3 ops/forward_ledgers.py <dir>            # append missing sessions
    python3 ops/forward_ledgers.py <dir> --verify   # replay must equal the log
    python3 ops/forward_ledgers.py <dir> --loop     # re-run every hour

Benchmark ledgers (BENCHMARKS) ride along in ledger_specs; ops/forward_eval.py
judges every other ledger against them (read-only, writes ledgers/eval.json).
A new strategy joins by adding its entry to ledger_specs after its backtest gate.

--verify is the fidelity gate: a logged row that a fresh replay cannot
reproduce means look-ahead or revised data, and exits 1.

Reads ALPACA_KEY_ID / ALPACA_SECRET from the environment or the repo .env."""
import datetime
import hashlib
import json
import os
import sys
import time
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from research.engine import link_store
from research.strategy import margin, portfolio, sip_fetch
from research.strategy import run_connected_drift as book

FORWARD_START = "2026-09-30"   # first session recorded
HISTORY_START = "2016-01-01T00:00:00Z"
CASH0 = 100000.0
SIP_DELAY_MIN = 16
TOL = 0.002  # whole-share rounding moves a replay by a few bp; look-ahead moves it far more

CORE_WEIGHTS = {"VTI": 0.6, "IEF": 0.4}

# Connected Drift Book ledgers at 1x and 2x modeled cost (cost_mult), signed and
# on margin. The ledger joins once research/data/reference.json exists and fails
# closed on a stale or missing dataset. The minimum is validation.md's shadow
# minimum for a monthly strategy: 3 rebalances, doubled because the run touched
# the scaler on the seen window.
CD = "connected_drift"
CD_2X = "connected_drift_2x_cost"
BOOK_COST_MULT = {CD: 1.0, CD_2X: 2.0}
SHADOW_MIN_REBALANCES = {CD: 6, CD_2X: 6}
DATA_DIR = book.DATA
MARGIN_RATE_ENV = "CONNECTED_DRIFT_MARGIN_RATE"  # the broker's published rate


class DataRefused(ValueError):
    """A ledger's inputs are missing or stale; its row is not written."""

# Benchmark / control ledgers (same engine, schema and chain as the strategies,
# plan/validation.md). Buy-and-hold: one allocation, no rebalance.
BENCH_CASH = "bench_cash_bil"
BENCH_SPY = "bench_spy"
BENCHMARKS = (BENCH_CASH, BENCH_SPY)


def hold_fn(weights):
    """Buy-and-hold: one initial allocation at the first decision where every
    symbol has a close, then no rebalancing (returns None forever after)."""
    done = []

    def fn(date, closes):
        if done:
            return None
        if any(not closes.get(s) for s in weights):
            return None
        done.append(date)
        return dict(weights)

    return fn


def core_fn():
    """60/40 benchmark: buy at the first decision, then hold (no rebalance)."""
    return hold_fn(CORE_WEIGHTS)


def book_universe(data_dir):
    """Symbols of the book's ledgers, or None before the reference dataset
    exists."""
    try:
        with open(os.path.join(data_dir, "reference.json"),
                  encoding="utf-8") as f:
            syms = sorted(json.load(f)["data"]["market_cap"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return sorted(set(syms) | set(book.SUPPORT))


def book_factory(data_dir):
    """factory(sessions, prices) -> the Book; the datasets must reach the last
    session."""
    def make(sessions, prices):
        need = sessions[-1]
        try:
            ref, filings, events = book._datasets(data_dir, need)
            vetoes = book.read_dataset(data_dir, "vetoes.json", need)
            store = book._store(data_dir)
        except (book.RunnerError, link_store.LinkStoreError) as e:
            raise DataRefused(str(e)) from None
        inputs = book.Inputs(prices, ref, store, filings, events, vetoes)
        return book.Book(sessions, prices, inputs)
    return make


def book_options(sid):
    try:
        rate = float(os.environ[MARGIN_RATE_ENV])
        return {"margin": margin.MarginTerms(margin_rate=rate),
                "cost_mult": BOOK_COST_MULT[sid]}
    except (KeyError, ValueError):
        raise DataRefused("margin-rate-required") from None


def ledger_specs(data_dir=None):
    """id -> (universe incl. cash leg, factory(sessions) -> target_fn, spec);
    a book ledger's factory also takes the prices. The book ledgers are in
    only when `data_dir` holds the reference dataset."""
    specs = _core_specs()
    universe = book_universe(data_dir) if data_dir else None
    if universe:
        for sid, mult in BOOK_COST_MULT.items():
            specs[sid] = (universe, book_factory(data_dir),
                          "connected_drift book at %gx cost" % mult)
    return specs


def _core_specs():
    return {
        "passive_core": (list(CORE_WEIGHTS), lambda s: core_fn(),
                            "60/40 buy and hold"),
        BENCH_CASH: (["BIL"], lambda s: hold_fn({"BIL": 1.0}),
                     "benchmark: 100% BIL buy and hold"),
        BENCH_SPY: (["SPY"], lambda s: hold_fn({"SPY": 1.0}),
                    "benchmark: SPY buy and hold"),
    }


def retrying(http_get, tries=3):
    def get(url, headers):
        for k in range(tries):
            try:
                return http_get(url, headers)
            except (urllib.error.URLError, OSError):
                if k == tries - 1:
                    raise
                time.sleep(2 ** k)
    return get


def fetch_prices(symbols, now, http_get=sip_fetch.default_http_get):
    """prices[sym][date] = (open, close), split+dividend adjusted, completed
    sessions only."""
    midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = min(midnight, now - datetime.timedelta(minutes=SIP_DELAY_MIN)
              ).strftime("%Y-%m-%dT%H:%M:%SZ")
    get = retrying(http_get)
    out = {}
    for s in symbols:
        rows, _ = sip_fetch.fetch(s, "bars", HISTORY_START, end, "1Day",
                                  "all", http_get=get, now=now)
        out[s] = {r["t"][:10]: (float(r["o"]), float(r["c"]))
                  for r in rows if r["o"] > 0 and r["c"] > 0}
    return out


def common_sessions(prices):
    dates = None
    for s in prices:
        ds = set(prices[s])
        dates = ds if dates is None else dates & ds
    return sorted(dates or ())


def replay(strategy, prices, spec_factory, symbols):
    """Rows for every session >= FORWARD_START, from a full-history run."""
    is_book = strategy in BOOK_COST_MULT
    # lean: a book name with no bars is dropped, not refused; refuse it when a
    # shadow ledger must hold every name.
    px = {s: prices[s] for s in symbols if prices[s] or not is_book}
    sessions = sorted(px["SPY"]) if is_book else common_sessions(px)
    if not sessions:
        return []
    if is_book:
        res = portfolio.run(sessions, px, spec_factory(sessions, px),
                            cash0=CASH0, **book_options(strategy))
    else:
        res = portfolio.run(sessions, px, spec_factory(sessions), cash0=CASH0)
    targets = {d: w for d, w in res["weights"]}
    idx = [i for i, d in enumerate(sessions) if d >= FORWARD_START]
    if not idx:
        return []
    base = res["equity"][idx[0]]
    rows, prev = [], None
    for i in idx:
        eq = CASH0 * res["equity"][i] / base
        rows.append({"date": sessions[i], "strategy": strategy,
                     "equity": round(eq, 4),
                     "ret": 0.0 if prev is None else round(eq / prev - 1, 8),
                     "target": targets.get(sessions[i])})
        prev = eq
    return rows


def _digest(prev, body):
    return hashlib.sha256((prev + json.dumps(body, sort_keys=True)).encode()
                          ).hexdigest()


def read_log(path):
    rows = []
    if os.path.exists(path):
        with open(path) as f:
            rows = [json.loads(ln) for ln in f if ln.strip()]
    prev = "GENESIS"
    for r in rows:
        body = {k: v for k, v in r.items() if k not in ("prev", "hash")}
        if r["prev"] != prev or r["hash"] != _digest(prev, body):
            raise ValueError("chain-broken:" + r.get("date", "?"))
        prev = r["hash"]
    return rows, prev


def append_rows(path, rows, new):
    """Append only sessions not yet logged; returns the number appended."""
    have = {r["date"] for r in rows}
    prev = rows[-1]["hash"] if rows else "GENESIS"
    n = 0
    with open(path, "a") as f:
        for r in new:
            if r["date"] in have:
                continue
            h = _digest(prev, r)
            f.write(json.dumps(dict(r, prev=prev, hash=h), sort_keys=True) + "\n")
            prev, n = h, n + 1
        f.flush()
        os.fsync(f.fileno())
    return n


def _settle(d, sid, fresh, spec, verify, bad, summary):
    """Fidelity-check the log against `fresh`, append what is missing."""
    path = os.path.join(d, "ledgers", sid + ".jsonl")
    rows, _ = read_log(path)
    by_date = {r["date"]: r for r in fresh}
    for r in rows:  # fidelity: the log must equal what a replay gives now
        f = by_date.get(r["date"])
        if f is None or abs(f["equity"] / r["equity"] - 1) > TOL:
            bad.append((sid, r["date"]))
    if not verify:
        append_rows(path, rows, fresh)
    rows, _ = read_log(path)
    summary[sid] = {"sessions": len(rows), "spec": spec,
                    "equity": rows[-1]["equity"] if rows else None}


def run(d, now, verify=False, http_get=sip_fetch.default_http_get,
        data_dir=None):
    specs = ledger_specs(data_dir)
    symbols = sorted({s for u, _, _ in specs.values() for s in u})
    prices = fetch_prices(symbols, now, http_get)
    os.makedirs(os.path.join(d, "ledgers"), exist_ok=True)
    bad, summary = [], {}
    for sid, (universe, factory, spec) in specs.items():
        try:
            fresh = replay(sid, prices, factory, universe)
        except DataRefused as e:
            summary[sid] = {"refused": str(e)}
            continue
        _settle(d, sid, fresh, spec, verify, bad, summary)
    write_status(d)
    return bad, summary


# Per-strategy kill limits: a strategy run at a 10% annual volatility target
# halves at -1.5x and freezes at -2x that volatility from its own peak. Shadow ledgers cannot be halted, so the state is reported
# (ledgers/status.json, monitor) for the operator and for promotion decisions.
SOFT_DD, HARD_DD = 0.15, 0.20


def write_status(d):
    sd = os.path.join(d, "ledgers")
    out = {}
    for name in sorted(os.listdir(sd)) if os.path.isdir(sd) else []:
        if not name.endswith(".jsonl"):
            continue
        try:
            rows, _ = read_log(os.path.join(sd, name))
        except (ValueError, OSError):
            continue
        if not rows:
            continue
        peak = max(r["equity"] for r in rows)
        dd = 1.0 - rows[-1]["equity"] / peak
        state = "hard" if dd >= HARD_DD else "soft" if dd >= SOFT_DD else "ok"
        out[name[:-6]] = {"date": rows[-1]["date"], "equity": rows[-1]["equity"],
                          "peak": peak, "drawdown": round(dd, 6), "state": state}
        need = SHADOW_MIN_REBALANCES.get(name[:-6])
        if need:
            n = sum(1 for r in rows if r["target"] is not None)
            out[name[:-6]].update(rebalances=n, shadow_min_rebalances=need)
    tmp = os.path.join(sd, "status.json.tmp")
    os.makedirs(sd, exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(out, f, sort_keys=True)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, os.path.join(sd, "status.json"))
    return out


def _evaluate(d):
    """Refresh ledgers/eval.json after write_status. Read-only w.r.t. the
    ledgers; any failure is logged and can never stop the loop."""
    try:
        from ops import forward_eval
        forward_eval.write_eval(d)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"forward_eval": "error: %r" % (e,)}), file=sys.stderr)


def _register_forward(d):
    """Once at loop start: open the global-ledger trials for every forward
    ledger before any result is computed (ops/forward_register.py, idempotent).
    Never raises; a refusal is one stderr line and the shadow run continues."""
    try:
        from ops import forward_register
        res = forward_register.register(d)
        if res["registered"]:
            print(json.dumps({"forward_register": {
                "registered": len(res["registered"])}}), file=sys.stderr)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"forward_register": "error: %r" % (e,)}),
              file=sys.stderr)


def main(argv, now=None):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit("usage: forward_ledgers.py <dir> [--verify|--loop]")
    sip_fetch.load_alpaca_env()
    if "--verify" not in argv:
        _register_forward(args[0])
    while True:
        n = now or datetime.datetime.now(datetime.timezone.utc)
        try:
            bad, summary = run(args[0], n, verify="--verify" in argv,
                               data_dir=DATA_DIR)
        except (ValueError, OSError, sip_fetch.SipError) as e:
            print(json.dumps({"error": str(e)}), file=sys.stderr)
            if "--loop" not in argv:
                return 2
        else:
            print(json.dumps({"ledgers": summary, "mismatch": bad}))
            if "--loop" in argv:
                _evaluate(args[0])
            if bad and "--loop" not in argv:
                return 1
        if "--loop" not in argv:
            return 0
        time.sleep(3600)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
