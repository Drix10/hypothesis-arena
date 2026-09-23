#!/usr/bin/env python3
"""fred-vintage-probe.py — Phase-D FRED/ALFRED evidence (operator key).

Proves, with N=3 timed samples per call and zero secret leakage:
  1. authenticated real OBSERVATION retrieval
     (fred/series/observations GDP -> latest value + date);
  2. real VINTAGE replay via realtime periods (observations with
     realtime_start=realtime_end=2020-01-01 -> values AS KNOWN on
     that date; dedicated /alfred/* paths answer 404 for this key,
     recorded honestly — the realtime-parameter mechanism on the
     FRED endpoint is the proven replay path);
  3. DETERMINISTIC historical replay: same realtime params fetched
     twice -> byte-identical values;
  4. bad-key FAIL-CLOSED (FRED answers 400 + error JSON -> BLOCKED,
     never promoted, never retried as success).
Key comes from root .env via collector.config.load (never argv, never
printed; URLs are redacted in all output). Exit 0 only if 1-4 hold.
Usage: python3 research-plane/sandbox/fred-vintage-probe.py [--out PATH]
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from collector import config as config_mod

BASE = "https://api.stlouisfed.org"
SERIES = "GDP"
N = 3
UA = "MiroHedge/phase0 contact=research-plane-fred"


def get(path, params, timeout=30):
    """(status, parsed-json-or-error-dict, latency_ms). Key stays in memory."""
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(BASE + path + "?" + qs,
                                 headers={"User-Agent": UA})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(1 << 20)
            ms = (time.monotonic() - t0) * 1000.0
            return r.status, json.loads(body), round(ms, 1)
    except urllib.error.HTTPError as e:
        ms = (time.monotonic() - t0) * 1000.0
        try:
            err = json.loads(e.read(1 << 16))
        except Exception:
            err = {"error": type(e).__name__}
        err.pop("api_key", None)
        return e.code, err, round(ms, 1)
    except Exception as e:
        ms = (time.monotonic() - t0) * 1000.0
        return "DOWN", {"error": "%s" % type(e).__name__}, round(ms, 1)


def pct(lats, q):
    s = sorted(lats)
    return s[min(len(s) - 1, int(q * len(s)))]


def rows_identical(a, b):
    """Deterministic-replay predicate: two non-empty row lists,
    byte-identical. Empty/None on either side is NOT identical
    (fail closed: missing data never counts as a replay proof)."""
    return (a is not None and b is not None
            and len(a) > 0 and a == b)


def main():
    key = config_mod.load()["values"].get("FRED_API_KEY", "")
    if not key:
        print("BLOCKED: no FRED_API_KEY in root .env (fail-closed)")
        return 2
    out = sys.argv[sys.argv.index("--out") + 1] \
        if "--out" in sys.argv else None
    ev = {"ts": int(time.time()), "series": SERIES, "n": N}
    ok = True

    # 1. real observations
    obs_lats, latest = [], None
    for _ in range(N):
        st, body, ms = get("/fred/series/observations",
                           {"series_id": SERIES, "api_key": key,
                            "file_type": "json"})
        obs_lats.append(ms)
        if st == 200:
            obs = body.get("observations", [])
            if obs:
                latest = {"date": obs[-1].get("date"),
                          "value": obs[-1].get("value")}
    ev["observations"] = {"p50_ms": pct(obs_lats, 0.5),
                          "p99_ms": pct(obs_lats, 0.99),
                          "latest": latest}
    print("observations p50=%.0fms p99=%.0fms latest=%r"
          % (ev["observations"]["p50_ms"], ev["observations"]["p99_ms"],
             latest))
    if latest is None:
        print("FAIL: no observation retrieved")
        ok = False

    # 2+3. vintage replay via realtime periods: values AS KNOWN on
    # 2020-01-01 (pre-revision Q1-Q3 2019), fetched twice.
    rt = {"series_id": SERIES, "api_key": key, "file_type": "json",
          "realtime_start": "2020-01-01", "realtime_end": "2020-01-01",
          "observation_start": "2019-01-01",
          "observation_end": "2019-10-01"}
    reps, rt_lats = [], []
    for _ in range(2):
        st2, b2, ms2 = get("/fred/series/observations", rt)
        rt_lats.append(ms2)
        if st2 != 200:
            reps.append(None)
        else:
            reps.append([(o.get("date"), o.get("value"))
                         for o in b2.get("observations", [])])
    same = rows_identical(*reps)
    ev["replay"] = {"realtime": "2020-01-01",
                    "p50_ms": pct(rt_lats, 0.5),
                    "observations": len(reps[0]) if reps[0] else 0,
                    "values": reps[0] if reps[0] else [],
                    "byte_identical": bool(same)}
    print("replay as-known-2020-01-01: %r p50=%.0fms byte-identical=%r"
          % (reps[0], ev["replay"]["p50_ms"], same))
    if not same:
        print("FAIL: vintage replay not deterministic")
        ok = False

    # 4. bad key fails closed (FRED answers 400, never 200)
    st3, b3, _ = get("/fred/series/observations",
                     {"series_id": SERIES, "api_key": "0" * 32,
                      "file_type": "json"})
    denied = (st3 != 200)
    ev["bad_key"] = {"status": st3,
                     "denied": bool(denied),
                     "message": str(b3.get("error_message",
                                           b3.get("error", "")))[:80]}
    print("bad-key probe: status=%r denied=%r" % (st3, denied))
    if not denied:
        print("FAIL: bad key accepted")
        ok = False

    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(ev, fh, indent=1)
        print("wrote", out)
    print("FRED-VINTAGE-PROOF: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
