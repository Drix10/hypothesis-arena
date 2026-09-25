"""Live source soak (Track A operational evidence, doc 09 sec. 9.4).

Polls the five ACCEPTED production adapters against live hosts with
their real pacing/backoff, N cycles each, and records per-poll
latency/ok/records/errors + heartbeat files. Evidence JSON only;
exit 0 always (evidence, not a gate). Secrets never printed.

Usage: python3 research-plane/sandbox/source_soak.py [--cycles N]
  [--out PATH]
Env (root .env via collector.config, the sole loader):
  MIRO_CONTACT (EDGAR fail-closed), FRED_API_KEY, BEA_USER_ID.
"""
import json
import os
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from collector import config as cfg_mod
from sources import bea as bea_mod
from sources import bls as bls_mod
from sources import edgar as edgar_mod
from sources import fred as fred_mod
from sources import treasury as treasury_mod


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return round(s[min(len(s) - 1, int(q * len(s)))], 1)


def main(argv):
    cycles = 6
    out = None
    for i, a in enumerate(argv):
        if a == "--cycles" and i + 1 < len(argv):
            cycles = max(1, int(argv[i + 1]))
        if a == "--out" and i + 1 < len(argv):
            out = argv[i + 1]
    cfg = cfg_mod.load()
    if cfg["status"] != "CONFIG_OK":
        print("config not ok: %s" % (cfg["missing_required"],))
        return 1
    env = cfg["values"]
    with open(os.path.join(ROOT, "..", "collector",
                           "entity_map.json"),
              encoding="utf-8") as fh:
        sym_to_cik = {}
        for cik, ticker in json.load(fh).get("cik_to_ticker",
                                             {}).items():
            if isinstance(ticker, str) and ticker.strip():
                try:
                    sym_to_cik[ticker.strip().upper()] = int(cik)
                except (TypeError, ValueError):
                    continue
    hbdir = tempfile.mkdtemp(prefix="soak-hb-")
    specs = [
        ("edgar_8k", lambda: edgar_mod.Adapter(
            env["MIRO_CONTACT"], entity_map=sym_to_cik),
         lambda a: a.poll(["AAPL"])),
        ("fred_macro", lambda: fred_mod.Adapter(
            env.get("FRED_API_KEY", "")),
         lambda a: a.poll()),
        ("treasury_auctions", lambda: treasury_mod.Adapter(
            contact=env["MIRO_CONTACT"], env=env),
         lambda a: a.poll()),
        ("bls_empsit", lambda: bls_mod.Adapter(
            contact=env["MIRO_CONTACT"], env=env),
         lambda a: a.poll()),
        ("bea_nipa_gdp", lambda: bea_mod.Adapter(
            env.get("BEA_USER_ID", ""),
            contact=env["MIRO_CONTACT"], env=env),
         lambda a: a.poll()),
    ]
    ev = {"ts": int(time.time()), "cycles": cycles,
          "watchlist": ["AAPL", "SPY"], "sources": {}}
    for sid, make, poll in specs:
        try:
            adapter = make()
        except Exception as e:
            ev["sources"][sid] = {
                "blocked": "%s" % type(e).__name__}
            print("%s: BLOCKED (%s)" % (sid, type(e).__name__))
            continue
        samples = []
        polls = []
        for _ in range(cycles):
            t0 = time.monotonic()
            try:
                recs, info = poll(adapter)
                ms = (time.monotonic() - t0) * 1000.0
                polls.append({"ms": round(ms, 1),
                              "ok": bool(info.get("ok", False)),
                              "stale": bool(info.get("stale", True)),
                              "records": int(info.get("records", 0)),
                              "errors": [str(e) for e in
                                         info.get("errors", [])][:3]})
                samples.append(ms)
            except Exception as e:
                ms = (time.monotonic() - t0) * 1000.0
                polls.append({"ms": round(ms, 1), "ok": False,
                              "stale": True, "records": 0,
                              "errors": ["%s" % type(e).__name__]})
                samples.append(ms)
        try:
            hb = adapter.heartbeat(info)
            hbp = os.path.join(hbdir, sid + ".json")
            adapter.write_heartbeat(hbp, hb)
            hb_ok = hb.get("ok", False)
        except Exception as e:
            hb_ok = "heartbeat-error:%s" % type(e).__name__
        ev["sources"][sid] = {"polls": polls,
                              "p50_ms": pct(samples, 0.5),
                              "p99_ms": pct(samples, 0.99),
                              "all_ok": all(p["ok"] for p in polls),
                              "heartbeat_ok": hb_ok}
        print("%s: p50=%s p99=%s all_ok=%s hb=%s" % (
            sid, ev["sources"][sid]["p50_ms"],
            ev["sources"][sid]["p99_ms"],
            ev["sources"][sid]["all_ok"], hb_ok))
    out = out or os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "soak-evidence-%d.json" % ev["ts"])
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(json.dumps(ev, indent=2, sort_keys=True))
    print("wrote %s" % out)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
