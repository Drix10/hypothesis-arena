#!/usr/bin/env python3
"""alpaca-paper-probe.py — Phase-D Alpaca paper evidence (operator key).

Scope: API/account/data READINESS only (NOT execution readiness — no
order lifecycle exists yet; H1 remains OPEN per plan/13). Proves,
with N=3 timed samples per call and zero secret leakage:
  1. authenticated PAPER account read (paper-api /v2/account ->
     paper account, buying_power present, live orders untouched);
  2. authenticated asset read (/v2/assets/AAPL -> tradable symbol);
  3. market-data read (data.alpaca /v2/stocks/AAPL/quotes/latest ->
     quote present; free plan = IEX feed, recorded honestly);
  4. bad-key FAIL-CLOSED (requires actual HTTP 401/403; transport
     failures are transport, never denial).
Keys come from root .env via collector.config.load (never argv, never
printed; secret never in URLs). PAPER base only — the base URL is
pinned in code, not configurable. READ-ONLY: no order endpoints are
called anywhere in this file. Exit 0 only if 1-4 hold.
Usage: python3 research-plane/sandbox/alpaca_paper_probe.py [--out PATH]
"""
import json
import math
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from collector import config as config_mod

PAPER = "https://paper-api.alpaca.markets"  # pinned; never live
DATA = "https://data.alpaca.markets"
N = 3
UA = "MiroHedge/phase0 contact=research-plane-alpaca"


def get(base, path, kid, secret, timeout=30):
    """(parsed-or-None, error-dict-or-None, latency_ms). Secret in memory."""
    req = urllib.request.Request(
        base + path,
        headers={"APCA-API-KEY-ID": kid,
                 "APCA-API-SECRET-KEY": secret,
                 "User-Agent": UA})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(1 << 20)
            ms = (time.monotonic() - t0) * 1000.0
            return json.loads(body), None, round(ms, 1)
    except urllib.error.HTTPError as e:
        ms = (time.monotonic() - t0) * 1000.0
        try:
            err = json.loads(e.read(1 << 16))
        except Exception:
            err = {}
        return None, {"http": e.code,
                      "message": str(err.get("message", ""))[:80]}, \
            round(ms, 1)
    except Exception as e:
        ms = (time.monotonic() - t0) * 1000.0
        return None, {"error": "%s" % type(e).__name__}, round(ms, 1)


def pct(lats, q):
    s = sorted(lats)
    return s[min(len(s) - 1, int(q * len(s)))]


def _finite_pos(x):
    try:
        f = float(x)
    except (TypeError, ValueError):
        return False
    return math.isfinite(f) and f > 0


def _valid_account(body):
    """Expected paper-account shape: non-empty id, string status +
    currency, buying_power a valid positive numeric string."""
    if not isinstance(body, dict):
        return False
    if not body.get("id") or not isinstance(body["id"], str):
        return False
    if not isinstance(body.get("status"), str) or not body["status"]:
        return False
    if not isinstance(body.get("currency"), str) or not body["currency"]:
        return False
    return _finite_pos(body.get("buying_power"))


def _valid_asset(body):
    if not isinstance(body, dict):
        return False
    return (body.get("symbol") == "AAPL"
            and body.get("tradable") is True
            and isinstance(body.get("status"), str)
            and isinstance(body.get("exchange"), str))


def _valid_quote(body):
    """Latest-quote shape: numeric bid/ask > 0, parseable sane
    timestamp (2020..now+1d). Malformed-but-present is not a quote."""
    if not isinstance(body, dict):
        return False
    q = body.get("quote", {})
    if not isinstance(q, dict):
        return False
    if not _finite_pos(q.get("ap")) or not _finite_pos(q.get("bp")):
        return False
    try:
        ts = datetime.fromisoformat(str(q.get("t", "")).replace(
            "Z", "+00:00"))
        epoch = ts.timestamp()
    except Exception:
        return False
    now = time.time()
    return 1577836800 <= epoch <= now + 86400


def main():
    vals = config_mod.load()["values"]
    kid, secret = vals.get("ALPACA_KEY_ID", ""), vals.get("ALPACA_SECRET", "")
    if not kid or not secret:
        print("BLOCKED: no Alpaca paper keypair in root .env (fail-closed)")
        return 2
    out = sys.argv[sys.argv.index("--out") + 1] \
        if "--out" in sys.argv else None
    ev = {"ts": int(time.time()), "n": N, "base": PAPER,
          "orders_called": False}
    ok = True

    # 1. paper account (read-only). Evidence keeps readiness only:
    # status/currency/buying-power — no account id/number persisted.
    a_lats, acct = [], None
    for _ in range(N):
        body, err, ms = get(PAPER, "/v2/account", kid, secret)
        a_lats.append(ms)
        if _valid_account(body):
            acct = {"status": body["status"],
                    "currency": body["currency"],
                    "buying_power": body["buying_power"]}
    ev["account"] = {"p50_ms": pct(a_lats, 0.5),
                     "p99_ms": pct(a_lats, 0.99), "fields": acct}
    print("account p50=%.0fms p99=%.0fms status=%r buying_power=%r"
          % (ev["account"]["p50_ms"], ev["account"]["p99_ms"],
             (acct or {}).get("status"), (acct or {}).get("buying_power")))
    if acct is None:
        print("FAIL: no paper account read")
        ok = False

    # 2. asset read
    s_lats, asset = [], None
    for _ in range(N):
        body, err, ms = get(PAPER, "/v2/assets/AAPL", kid, secret)
        s_lats.append(ms)
        if _valid_asset(body):
            asset = {"symbol": "AAPL",
                     "status": body["status"],
                     "tradable": True,
                     "exchange": body["exchange"]}
    ev["asset"] = {"p50_ms": pct(s_lats, 0.5),
                   "p99_ms": pct(s_lats, 0.99), "fields": asset}
    print("asset AAPL p50=%.0fms tradable=%r exchange=%r"
          % (ev["asset"]["p50_ms"], (asset or {}).get("tradable"),
             (asset or {}).get("exchange")))
    if asset is None:
        print("FAIL: no asset read")
        ok = False

    # 3. market-data quote (free plan = IEX; recorded, not disguised)
    q_lats, quote = [], None
    for _ in range(N):
        body, err, ms = get(DATA, "/v2/stocks/AAPL/quotes/latest?feed=iex",
                            kid, secret)
        q_lats.append(ms)
        q = (body or {}).get("quote", {})
        if _valid_quote(body):
            quote = {"t": q.get("t"), "ap": q.get("ap"),
                     "bp": q.get("bp"), "feed": "iex"}
    ev["quote"] = {"p50_ms": pct(q_lats, 0.5),
                   "p99_ms": pct(q_lats, 0.99), "fields": quote}
    print("quote AAPL p50=%.0fms %r" % (ev["quote"]["p50_ms"], quote))
    if quote is None:
        print("FAIL: no market-data quote")
        ok = False

    # 4. bad key fails closed: requires an actual HTTP 401/403.
    # Transport failures (timeout/DNS/TLS) are transport, never
    # denial — a network outage must not become a 401 proof.
    b4, e4, _ = get(PAPER, "/v2/account", "PKBAD", "bad")
    http4 = (e4 or {}).get("http")
    denied = (b4 is None and http4 in (401, 403))
    ev["bad_key"] = {"denied": bool(denied),
                     "message": str((e4 or {}).get("message", ""))[:80],
                     "http": http4,
                     "transport": bool(b4 is None
                                        and http4 not in (401, 403))}
    print("bad-key probe: denied=%r http=%r" % (denied, (e4 or {}).get("http")))
    if not denied:
        print("FAIL: bad key accepted")
        ok = False

    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(ev, fh, indent=1)
        print("wrote", out)
    print("ALPACA-PAPER-PROOF: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
