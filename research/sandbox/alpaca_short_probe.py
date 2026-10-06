#!/usr/bin/env python3
"""Alpaca short-selling verification probe (paper account, human-run).

Reports the paper balance and margin multiplier, shortable and
easy_to_borrow flags for a 20-name sample, whether a 1-share test short of a
liquid ETF is accepted, and whether a fractional short is accepted. Places at
most one 1-share and one fractional sell order, cancels each, and refuses to
run unless the base URL is the paper endpoint. Keys come from the environment
only (ALPACA_KEY_ID, ALPACA_SECRET), never argv, .env or the report.
Usage: python3 research/sandbox/alpaca_short_probe.py [--out PATH]
"""
import json
import os
import sys
import urllib.error
import urllib.request

PAPER = "https://paper-api.alpaca.markets"
ETF = "SPY"
SAMPLE = ["AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "TSLA", "JPM",
          "XOM", "JNJ", "PG", "KO", "WMT", "DIS", "INTC", "F", "SPY", "QQQ",
          "IWM", "GLD"]
UA = "MiroHedge/phase0 contact=research-plane-alpaca"


def http_transport(kid, secret):
    """transport(method, base, path, body) -> (status, parsed-or-None)."""
    def call(method, base, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            base + path, data=data, method=method,
            headers={"APCA-API-KEY-ID": kid, "APCA-API-SECRET-KEY": secret,
                     "User-Agent": UA, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read(1 << 20)
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read(1 << 16))
            except ValueError:
                return e.code, None
    return call


def _order(transport, base, symbol, qty):
    """Submit one market sell, cancel it if it was accepted."""
    status, body = transport("POST", base, "/v2/orders", {
        "symbol": symbol, "qty": str(qty), "side": "sell",
        "type": "market", "time_in_force": "day"})
    body = body if isinstance(body, dict) else {}
    if status not in (200, 201) or not body.get("id"):
        return {"accepted": False, "http": status,
                "message": str(body.get("message", ""))[:120]}
    cstatus, _ = transport("DELETE", base, "/v2/orders/" + body["id"])
    return {"accepted": True, "http": status, "order_status": body.get("status"),
            "cancel_http": cstatus}


def run(transport, base=PAPER, sample=None, etf=ETF):
    if base != PAPER:
        raise ValueError("refusing to run: not the paper endpoint")
    ev = {"base": base, "orders_placed": 0}
    status, acct = transport("GET", base, "/v2/account", None)
    if status != 200 or not isinstance(acct, dict):
        raise RuntimeError("account read failed: http %s" % status)
    ev["account"] = {k: acct.get(k) for k in (
        "status", "currency", "cash", "equity", "buying_power", "multiplier",
        "shorting_enabled")}

    flags = []
    for sym in (sample or SAMPLE):
        s, a = transport("GET", base, "/v2/assets/" + sym, None)
        a = a if s == 200 and isinstance(a, dict) else {}
        flags.append({"symbol": sym, "http": s,
                      "shortable": a.get("shortable"),
                      "easy_to_borrow": a.get("easy_to_borrow"),
                      "fractionable": a.get("fractionable")})
    ev["assets"] = flags

    ev["short_1_share"] = dict(_order(transport, base, etf, 1), symbol=etf)
    ev["orders_placed"] += 1
    ev["short_fractional"] = dict(_order(transport, base, etf, 0.5),
                                  symbol=etf)
    ev["orders_placed"] += 1
    return ev


def main():
    kid, secret = os.environ.get("ALPACA_KEY_ID", ""), \
        os.environ.get("ALPACA_SECRET", "")
    if not kid or not secret:
        print("BLOCKED: set ALPACA_KEY_ID and ALPACA_SECRET (paper keys)")
        return 2
    out = sys.argv[sys.argv.index("--out") + 1] \
        if "--out" in sys.argv else None
    ev = run(http_transport(kid, secret))
    text = json.dumps(ev, indent=1)
    if out:
        with open(out, "w", encoding="utf-8") as fh:
            fh.write(text)
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
