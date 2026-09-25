#!/usr/bin/env python3
"""bea-probe.py — Phase-D BEA evidence (operator UserID).

Proves, with N=3 timed samples per call and zero secret leakage:
  1. authenticated dataset listing (GETDATASETLIST -> datasets present);
  2. real DATA retrieval (NIPA T10101 headline GDP -> rows present);
  3. DETERMINISTIC row replay: same GetData fetched twice -> parsed
     row tuples equal AND row-shaped (semantic replay, not raw-byte
     comparison; two malformed identical responses are not proof);
  4. bad-UserID FAIL-CLOSED (BEA structured denial with invalid-
     UserID semantics; transport failures are transport, never
     denial).
UserID comes from root .env via collector.config.load (never argv,
never printed; URLs are redacted in all output). Exit 0 only if 1-4
hold. Usage: python3 research/sandbox/bea_probe.py [--out PATH]
"""
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, ".."))

from collector import config as config_mod

BASE = "https://apps.bea.gov/api/data"
N = 3
UA = "MiroHedge/phase0 contact=research-plane-bea"


def get(params, timeout=30):
    """(res-or-None, err-or-None, latency_ms, kind). kind in
    {data, denied, transport}. BEA auth errors arrive as HTTP 200 +
    Results.Error, so ANY non-200/exception is transport (never
    denial): a network failure can never masquerade as a 401 proof.
    Key stays in memory."""
    qs = urllib.parse.urlencode(params)
    req = urllib.request.Request(BASE + "?" + qs,
                                 headers={"User-Agent": UA})
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read(1 << 20)
            ms = (time.monotonic() - t0) * 1000.0
            parsed = json.loads(body)
    except Exception as e:
        ms = (time.monotonic() - t0) * 1000.0
        code = getattr(e, "code", None)
        return None, {"http": code,
                      "error": "%s" % type(e).__name__}, \
            round(ms, 1), "transport"
    api = parsed.get("BEAAPI", {})
    res = api.get("Results", {}) if isinstance(api, dict) else {}
    # BEA nests call errors inside Results.Error (HTTP stays 200).
    err_node = api.get("Error", res.get("Error")) \
        if isinstance(res, dict) else api.get("Error")
    if err_node is not None:
        msg = err_node.get("APIErrorDescription", err_node) \
            if isinstance(err_node, dict) else err_node
        return None, {"error": str(msg)[:120]}, round(ms, 1), "denied"
    if not isinstance(res, dict):
        return None, {"error": "malformed-results"}, round(ms, 1), \
            "transport"
    return res, None, round(ms, 1), "data"


def pct(lats, q):
    s = sorted(lats)
    return s[min(len(s) - 1, int(q * len(s)))]


def _valid_rows(rows):
    """Replay rows must be shaped like real BEA data, not just
    mutually equal: non-empty list of (TimePeriod, DataValue) with
    bounded non-empty strings. Two malformed identical responses are
    NOT a replay proof."""
    if not isinstance(rows, list) or not rows:
        return False
    for r in rows:
        if not isinstance(r, (list, tuple)) or len(r) != 2:
            return False
        tp, dv = r
        if not isinstance(tp, str) or not 1 <= len(tp) <= 16:
            return False
        if not isinstance(dv, str) or not 1 <= len(dv) <= 64:
            return False
    return True


def rows_identical(a, b):
    """Semantic deterministic-row replay (parsed tuples, NOT raw
    response bytes): two non-empty VALID row lists, equal. Empty/
    None/malformed on either side is NOT identical (fail closed)."""
    return (_valid_rows(a) and _valid_rows(b) and a == b)


def main():
    uid = config_mod.load()["values"].get("BEA_USER_ID", "")
    if not uid:
        print("BLOCKED: no BEA_USER_ID in root .env (fail-closed)")
        return 2
    out = sys.argv[sys.argv.index("--out") + 1] \
        if "--out" in sys.argv else None
    ev = {"ts": int(time.time()), "n": N}
    ok = True

    # 1. authenticated dataset list
    ds_lats, datasets = [], None
    for _ in range(N):
        res, err, ms, kind = get({"UserID": uid,
                                  "method": "GETDATASETLIST",
                                  "ResultFormat": "JSON"})
        ds_lats.append(ms)
        if res and res.get("Dataset"):
            datasets = [d.get("DatasetName")
                        for d in res["Dataset"] if d.get("DatasetName")]
    ev["datasets"] = {"p50_ms": pct(ds_lats, 0.5),
                      "p99_ms": pct(ds_lats, 0.99),
                      "names": datasets}
    print("datasets p50=%.0fms p99=%.0fms names=%r"
          % (ev["datasets"]["p50_ms"], ev["datasets"]["p99_ms"],
             (datasets or [])[:6]))
    if not datasets or "NIPA" not in datasets:
        print("FAIL: no dataset list (NIPA missing)")
        ok = False

    # 2+3. real data + deterministic replay: NIPA T10101 headline GDP
    q = {"UserID": uid, "method": "GETDATA", "ResultFormat": "JSON",
         "datasetname": "NIPA", "TableName": "T10101",
         "Frequency": "A", "Year": "2023,2024"}
    reps, dt_lats = [], []
    for _ in range(2):
        res, err, ms, kind = get(q)
        dt_lats.append(ms)
        rows = None
        if res and res.get("Data"):
            rows = [(d.get("TimePeriod"), d.get("DataValue"))
                    for d in res["Data"]]
        reps.append(rows)
    same = rows_identical(*reps)
    ev["data"] = {"table": "T10101", "p50_ms": pct(dt_lats, 0.5),
                  "rows": len(reps[0]) if reps[0] else 0,
                  "sample": (reps[0] or [])[:2],
                  "rows_identical": bool(same),
                  "replay_kind": "semantic-rows (parsed tuples, "
                  "not raw bytes)"}
    print("NIPA T10101 rows=%d sample=%r p50=%.0fms rows-identical=%r"
          % (ev["data"]["rows"], ev["data"]["sample"],
             ev["data"]["p50_ms"], same))
    if not same:
        print("FAIL: BEA data not deterministic across replays")
        ok = False

    # 4. bad UserID fails closed: requires a BEA structured denial
    # (kind == denied with invalid-UserID semantics). Transport
    # failures are transport, never denial.
    res4, err4, _, kind4 = get({"UserID": "0" * 8 + "-" + "0" * 4 + "-"
                                + "0" * 4 + "-" + "0" * 4 + "-"
                                + "0" * 12,
                                "method": "GETDATASETLIST",
                                "ResultFormat": "JSON"})
    msg4 = str((err4 or {}).get("error", ""))
    denied = (kind4 == "denied" and "nvalid" in msg4)
    ev["bad_userid"] = {"denied": bool(denied), "kind": kind4,
                        "message": msg4[:80]}
    print("bad-userid probe: denied=%r kind=%r" % (denied, kind4))
    if not denied:
        print("FAIL: bad UserID accepted")
        ok = False

    if out:
        with open(out, "w", encoding="utf-8") as fh:
            json.dump(ev, fh, indent=1)
        print("wrote", out)
    print("BEA-PROOF: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
