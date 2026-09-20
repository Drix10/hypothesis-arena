"""D11 Tier-A readiness evidence (doc 09 sec. 9.4, stdlib only).

Runs what the environment allows, records blockers honestly, fakes
nothing:
- EDGAR 8-K atom + Fed monetary RSS: live GET with the frozen UA,
  3 samples each, p50/p99 latency, status/bytes. Network failure is
  recorded as DOWN with the error (evidence, not a pass).
- UA compliance: the exact UA string sent is recorded; EDGAR requires
  contact-bearing UA (doc 09 sec. 9.2) and zero 403s.
- FRED/ALFRED: key-gated -> BLOCKED (no key in env), never silently
  downgraded. ALFRED vintage replay needs the same key.
- Calendar: fail-closed gate result (missing -> CalendarMissing).
Usage: python3 research-plane/sources/tier_a.py [--out PATH]
Writes evidence JSON. Exit 0 always (evidence, not a gate); the
promotion gate reads the file, not the exit code.
"""
import json
import os
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from sources import calendars

UA = "MiroHedge/phase0 contact=research-plane-tier-a"
SOURCES_JSON = os.path.join(ROOT, "..", "collector", "sources.json")
CALENDAR = os.path.join(ROOT, "..", "collector", "session_calendar.json")


def measure(url, timeout=30):
    t0 = time.monotonic()
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA,
                                                   "Accept": "*/*"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(1 << 20)
            ms = (time.monotonic() - t0) * 1000.0
            return {"status": r.status, "latency_ms": round(ms, 1),
                    "bytes": len(body)}
    except Exception as e:
        ms = (time.monotonic() - t0) * 1000.0
        return {"status": "DOWN", "latency_ms": round(ms, 1),
                "error": "%s: %s" % (type(e).__name__, e)}


def pct(vals, q):
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * len(s)))]


def run():
    srcs = {s["name"]: s for s in json.load(open(SOURCES_JSON))}
    ev = {"ts": int(time.time()), "ua": UA, "polls": {}, "gates": {}}
    for name in ("edgar_8k", "fed_monetary"):
        samples = [measure(srcs[name]["url"]) for _ in range(3)]
        lats = [s["latency_ms"] for s in samples]
        ok = all(s.get("status") == 200 for s in samples)
        no403 = all(s.get("status") != 403 for s in samples)
        ev["polls"][name] = {"samples": samples, "p50_ms": pct(lats, 0.5),
                             "p99_ms": pct(lats, 0.99),
                             "all_200": ok, "zero_403": no403}
    fred_key = bool(os.environ.get("FRED_API_KEY"))
    ev["gates"]["fred_macro"] = ("READY" if fred_key else
                                 "BLOCKED: FRED_API_KEY not in env")
    ev["gates"]["alfred_vintage"] = ("READY" if fred_key else
                                     "BLOCKED: needs FRED_API_KEY")
    try:
        cal = calendars.load_calendar(CALENDAR)
        ev["gates"]["calendar"] = {
            "state": "LOADED", "version": cal.get("calendar_version"),
            "live_eligible": cal.get("live_eligible", False),
            "note": "seed: paper only until verified before G1"}
    except calendars.CalendarMissing as e:
        ev["gates"]["calendar"] = {"state": "FAIL-CLOSED", "error": str(e)}
    return ev


if __name__ == "__main__":
    out = sys.argv[sys.argv.index("--out") + 1] \
        if "--out" in sys.argv else os.path.join(
            ROOT, "sources", "tier_a_evidence.json")
    ev = run()
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(ev, fh, indent=2, sort_keys=True)
    print(json.dumps({k: (v if isinstance(v, dict) else v)
                      for k, v in ev.items() if k != "polls"}, indent=2))
    for name, p in ev["polls"].items():
        print("%s: p50=%s p99=%s all_200=%s zero_403=%s" %
              (name, p["p50_ms"], p["p99_ms"], p["all_200"], p["zero_403"]))
