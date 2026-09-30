"""Forward shadow ledgers for every sleeve that is not routed to the broker.

Log-only: no orders, no broker calls beyond the read-only SIP daily bars. Each
sleeve runs through the same settled-cash engine and cost_v2 model the A-gate
uses, decided at each close and filled at the next open. One append-only,
hash-chained line per sleeve per session lands in <dir>/sleeves/<sleeve>.jsonl.

Only sessions on or after FORWARD_START are recorded, so the frozen
pre-registered holdouts (all end before it) are never reported. Earlier bars
warm up the signal only.

    python3 ops/sleeve_shadow.py <dir>            # append missing sessions
    python3 ops/sleeve_shadow.py <dir> --verify   # replay must equal the log
    python3 ops/sleeve_shadow.py <dir> --loop     # re-run every hour

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

from research.strategy import portfolio, sip_fetch
from research.strategy.sleeves import sector_mom, trend

FORWARD_START = "2026-09-30"   # first session recorded (after every holdout)
HISTORY_START = "2016-01-01T00:00:00Z"
CASH0 = 100000.0
SIP_DELAY_MIN = 16
TOL = 0.002  # whole-share rounding moves a replay by a few bp; look-ahead moves it far more
ROOT = os.path.join(os.path.dirname(__file__), "..")
PREREG = os.path.join(ROOT, "research", "prereg")

CORE_WEIGHTS = {"VTI": 0.6, "IEF": 0.4}


def core_fn():
    """60/40 benchmark: buy at the first decision, then hold (no rebalance)."""
    done = []

    def fn(date, closes):
        if done:
            return None
        if any(not closes.get(s) for s in CORE_WEIGHTS):
            return None
        done.append(date)
        return dict(CORE_WEIGHTS)

    return fn


def _prereg(name):
    with open(os.path.join(PREREG, name)) as f:
        return json.load(f)


def sleeve_specs():
    """id -> (universe incl. cash leg, factory(sessions) -> target_fn, spec)."""
    t1, t2 = _prereg("t1_trend_etf_v1.json"), _prereg("t2_sector_mom_v1.json")
    v1, v2 = t1["variants"][0], t2["variants"][0]
    return {
        "core_passive_v1": (list(CORE_WEIGHTS), lambda s: core_fn(),
                            "60/40 buy and hold"),
        "trend_etf_v1": (t1["universe"] + [trend.CASH_LEG],
                         lambda s: trend.make_target_fn(
                             s, t1["universe"], variant=v1),
                         f"t1:{v1}"),
        "sector_mom_v1": (t2["universe"] + [sector_mom.CASH_LEG],
                          lambda s: sector_mom.make_target_fn(
                              s, t2["universe"], variant=v2),
                          f"t2:{v2}"),
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


def replay(sleeve, prices, spec_factory, symbols):
    """Rows for every session >= FORWARD_START, from a full-history run."""
    px = {s: prices[s] for s in symbols}
    sessions = common_sessions(px)
    if not sessions:
        return []
    res = portfolio.run(sessions, px, spec_factory(sessions), cash0=CASH0)
    targets = {d: w for d, w in res["weights"]}
    idx = [i for i, d in enumerate(sessions) if d >= FORWARD_START]
    if not idx:
        return []
    base = res["equity"][idx[0]]
    rows, prev = [], None
    for i in idx:
        eq = CASH0 * res["equity"][i] / base
        rows.append({"date": sessions[i], "sleeve": sleeve,
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


def run(d, now, verify=False, http_get=sip_fetch.default_http_get):
    specs = sleeve_specs()
    symbols = sorted({s for u, _, _ in specs.values() for s in u})
    prices = fetch_prices(symbols, now, http_get)
    os.makedirs(os.path.join(d, "sleeves"), exist_ok=True)
    bad, summary = [], {}
    for sid, (universe, factory, spec) in specs.items():
        path = os.path.join(d, "sleeves", sid + ".jsonl")
        rows, _ = read_log(path)
        fresh = replay(sid, prices, factory, universe)
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
    return bad, summary


def main(argv, now=None):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        raise SystemExit("usage: sleeve_shadow.py <dir> [--verify|--loop]")
    from research.strategy import a_run
    a_run._load_env()
    while True:
        n = now or datetime.datetime.now(datetime.timezone.utc)
        try:
            bad, summary = run(args[0], n, verify="--verify" in argv)
        except (ValueError, OSError, sip_fetch.SipError) as e:
            print(json.dumps({"error": str(e)}), file=sys.stderr)
            if "--loop" not in argv:
                return 2
        else:
            print(json.dumps({"sleeves": summary, "mismatch": bad}))
            if bad and "--loop" not in argv:
                return 1
        if "--loop" not in argv:
            return 0
        time.sleep(3600)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
