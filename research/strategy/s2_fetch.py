"""S2 dataset fetch: Alpaca hourly bars -> 1h Bar jsonl + manifest (stdlib only).

Reads keys from the canonical root .env via collector.config (never prints
them). Writes data/s2_raw/<sym>_1h.jsonl (gitignored) + dataset manifest
with content hashes. Conservative, paginated, IEX feed (documented limit:
no SIP without subscription; costs therefore use the 1bp floor leg and the
report flags them as a lower bound).
"""
import hashlib
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

NY = ZoneInfo("America/New_York")


def _env():
    from collector.config import load
    cfg = load()
    d = {}

    def pick(*names):
        for n in names:
            v = getattr(cfg, n, None) or os.environ.get(n)
            if v:
                return v
        return None

    d["key"] = pick("ALPACA_KEY_ID", "ALPACA_API_KEY")
    d["secret"] = pick("ALPACA_SECRET", "ALPACA_SECRET_KEY")
    base = pick("ALPACA_BASE_URL") or "https://data.alpaca.markets"
    if not d["key"] or not d["secret"]:
        raise SystemExit("S2 fetch BLOCKED: no Alpaca keys in .env")
    return d, base


def fetch_bars(symbol, start, end, feed="iex"):
    (creds, base) = _env()
    out = []
    token = None
    while True:
        q = (f"/v2/stocks/bars?symbols={symbol}&timeframe=1H&start={start}"
             f"&end={end}&limit=10000&sort=asc&feed={feed}&adjustment=split")
        if token:
            q += f"&page_token={token}"
        req = urllib.request.Request(
            base + q,
            headers={"APCA-API-KEY-ID": creds["key"],
                     "APCA-API-SECRET-KEY": creds["secret"]})
        with urllib.request.urlopen(req, timeout=60) as r:
            payload = json.load(r)
        bars = (payload.get("bars") or {}).get(symbol, [])
        out.extend(bars)
        token = payload.get("next_page_token")
        if not token:
            break
        time.sleep(0.5)
    return out


def to_1h_bars(raw):
    """Keep NYSE-session hourly bars (local open 09:30..15:00), drop the rest."""
    kept = []
    for b in raw:
        ts = datetime.fromisoformat(b["t"].replace("Z", "+00:00"))
        loc = ts.astimezone(NY)
        if not ((loc.hour == 9 and loc.minute == 30) or
                (10 <= loc.hour <= 15 and loc.minute == 0)):
            continue
        dv = float(b.get("v", 0) or 0) * float(b["c"])
        kept.append({"ts_ns": int(ts.timestamp() * 1e9),
                     "o": float(b["o"]), "h": float(b["h"]),
                     "l": float(b["l"]), "c": float(b["c"]),
                     "dollar_volume": dv, "spread_bps": 0.0})
    kept.sort(key=lambda x: x["ts_ns"])
    return kept


def write_dataset(symbols, start, end, outdir="data/s2_raw", feed="iex"):
    os.makedirs(outdir, exist_ok=True)
    manifest = {"source": "alpaca-market-data-v2", "feed": feed,
                "timeframe": "1H", "adjustment": "split",
                "retrieval_utc": datetime.now(timezone.utc).isoformat(),
                "window": {"start": start, "end": end},
                "calendar": "America/New_York session filter 09:30-16:00, "
                            "hourly opens 09:30..15:00 kept, others dropped",
                "spread_note": "OHLC source carries no spread: spread_bps=0 "
                               "-> paper_fill_v1 1bp floor leg applies; "
                               "reported costs are a LOWER BOUND",
                "symbols": {}}
    for sym in symbols:
        raw = fetch_bars(sym, start, end, feed)
        bars = to_1h_bars(raw)
        path = os.path.join(outdir, f"{sym}_1h.jsonl")
        with open(path, "w") as f:
            for b in bars:
                f.write(json.dumps(b) + "\n")
        h = hashlib.sha256(open(path, "rb").read()).hexdigest()
        manifest["symbols"][sym] = {"raw_bars": len(raw),
                                    "kept_1h_bars": len(bars),
                                    "sha256": h}
        print(f"{sym}: raw={len(raw)} kept={len(bars)} sha={h[:16]}")
        time.sleep(1.0)
    mp = os.path.join(outdir, "dataset_manifest.json")
    json.dump(manifest, open(mp, "w"), indent=2)
    print("manifest:", mp)
    return manifest


if __name__ == "__main__":
    syms = sys.argv[1:] or ["AAPL", "MSFT"]
    write_dataset(syms, "2023-01-01T00:00:00Z", "2025-01-01T00:00:00Z")
