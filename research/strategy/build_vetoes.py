"""Human-run build of research/data/vetoes.json for connected_drift (plan/
strategies.md Short vetoes): distress, no_borrow, crowded and forced_seller, a
bool per reference.json symbol, True vetoes the short. An input that is missing
or unreadable vetoes and is listed under `unavailable`. Alpaca keys come from
ALPACA_KEY_ID and ALPACA_SECRET only; FINRA short interest is a public file."""
import argparse
import csv
import datetime
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store
from research.sandbox import alpaca_short_probe
from research.sources import edgar_filings, shares_outstanding

DATA = os.path.join(os.path.dirname(__file__), "..", "data")
FINRA_URL = "https://cdn.finra.org/equity/otcmarket/biweekly/shrt%s.csv"
FINRA_LOOKBACK_DAYS = 45
MAX_FLOAT_SHORT = 0.20  # plan/risk.md crowding filter
MAX_DAYS_TO_COVER = 10.0
Z_DISTRESS = 1.8  # plan/strategies.md Registered values
# lean: the plan names no forced-seller measure; a firm whose strongest
# common-owner overlap reaches this share is vetoed. Register the measure and
# threshold before the holdout run.
FORCED_SELLER_OVERLAP = 0.5
ALPACA_INTERVAL_S = 0.31  # under the 200 requests per minute limit
INPUTS = ("filing_text", "altman_z", "alpaca_asset", "finra_short_interest",
          "shares_outstanding", "ownership_edges")
_GOING_CONCERN = re.compile(
    r"substantial doubt[^.]{0,250}going concern"
    r"|going concern[^.]{0,250}substantial doubt")
_TAGS = re.compile(r"<[^>]+>")
_REVENUE = ("Revenues", "SalesRevenueNet",
            "RevenueFromContractWithCustomerExcludingAssessedTax")


def _day(iso):
    return int(iso.replace("-", ""))


def going_concern(raw):
    """True when the filing text states substantial doubt about the ability to
    continue as a going concern.
    lean: boilerplate mentions that also carry both phrases veto; a false veto
    only drops a short, so refine with a section parser if the hit rate is high."""
    text = " ".join(html.unescape(_TAGS.sub(" ", raw)).lower().split())
    return bool(_GOING_CONCERN.search(text))


def latest_filing_text(filings_dir, cik, end):
    """Text of the latest 10-K of `cik` filed on or before `end` from the
    edgar_filings manifest, or None when there is none or it cannot be read."""
    try:
        with open(os.path.join(filings_dir, edgar_filings.MANIFEST_NAME),
                  encoding="utf-8") as f:
            rows = [json.loads(ln) for ln in f if ln.strip()]
        rows = [r for r in rows if r["cik"] == cik and r["form"] == "10-K"
                and r["filing_date"] <= end]
        if not rows:
            return None
        r = max(rows, key=lambda r: (r["filing_date"], r["accession"]))
        path = os.path.join(filings_dir, "%010d" % cik, r["accession"],
                            r["primary_document"])
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except (OSError, ValueError, KeyError, TypeError):
        return None


def altman_z(v, market_cap):
    """Altman Z from the balance and income values `v` (tag: USD) and the
    market value of equity, or None when an input is missing or a divisor is
    not positive."""
    try:
        rev = next(v[t] for t in _REVENUE if t in v)
        ta, tl = v["Assets"], v["Liabilities"]
        wc = v["AssetsCurrent"] - v["LiabilitiesCurrent"]
        re_, ebit = (v["RetainedEarningsAccumulatedDeficit"],
                     v["OperatingIncomeLoss"])
    except (KeyError, StopIteration):
        return None
    if not (ta > 0 and tl > 0 and market_cap > 0):
        return None
    return (1.2 * wc / ta + 1.4 * re_ / ta + 3.3 * ebit / ta
            + 0.6 * market_cap / tl + rev / ta)


def _rows(zf, name):
    with zf.open(name) as raw:
        yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8"),
                                  delimiter="\t", quoting=csv.QUOTE_NONE)


def fsds_values(fsds_dir, ciks, end):
    """{cik: {tag: value}} from the latest 10-K of each cik in the SEC
    Financial Statement Data Sets under `fsds_dir` filed on or before `end`:
    balance values at the period end and four-quarter flows. A cik without a
    10-K there is absent."""
    zips = sorted(n for n in os.listdir(fsds_dir) if n.endswith(".zip")) \
        if os.path.isdir(fsds_dir) else []
    want, day = {}, end.replace("-", "")
    for n in zips:
        with zipfile.ZipFile(os.path.join(fsds_dir, n)) as z:
            for r in _rows(z, "sub.txt"):
                try:
                    cik = int(r["cik"])
                except ValueError:
                    continue
                if (cik in ciks and r["form"] == "10-K"
                        and r["filed"] <= day
                        and (cik not in want
                             or (r["filed"], r["adsh"]) > want[cik][0])):
                    want[cik] = ((r["filed"], r["adsh"]), r["period"], n)
    out = {}
    for n in zips:
        picks = {k[0][1]: (cik, k[1]) for cik, k in want.items()
                 if k[2] == n}
        if not picks:
            continue
        with zipfile.ZipFile(os.path.join(fsds_dir, n)) as z:
            for r in _rows(z, "num.txt"):
                hit = picks.get(r["adsh"])
                if (hit is None or r["ddate"] != hit[1] or r["uom"] != "USD"
                        or r["segments"] or r["coreg"]
                        or r["qtrs"] not in ("0", "4") or not r["value"]):
                    continue
                try:
                    out.setdefault(hit[0], {})[r["tag"]] = float(r["value"])
                except ValueError:
                    continue
    return out


def distress(text, z):
    """(veto, text available). A filing text that cannot be read vetoes."""
    if text is None:
        return True, False
    return going_concern(text) or (z is not None and z < Z_DISTRESS), True


def asset_flags(transport, sym):
    """(shortable, easy_to_borrow) from the broker, or None when the answer is
    not a 200 with both flags as booleans."""
    status, body = transport("GET", alpaca_short_probe.PAPER,
                             "/v2/assets/" + sym)
    if status != 200 or not isinstance(body, dict):
        return None
    flags = (body.get("shortable"), body.get("easy_to_borrow"))
    return flags if all(isinstance(f, bool) for f in flags) else None


def _finra_get(url):
    req = urllib.request.Request(
        url, headers={"User-Agent": alpaca_short_probe.UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read(64 << 20)
    except urllib.error.HTTPError as e:
        return e.code, b""
    except (urllib.error.URLError, OSError):
        return None, b""


def short_interest(get, end):
    """({symbol: (short shares, days to cover)}, settlement date) from the
    newest FINRA file settled on or before `end`, or ({}, None). Values that
    are not numbers are None."""
    day = datetime.date.fromisoformat(end)
    for back in range(FINRA_LOOKBACK_DAYS):
        d = (day - datetime.timedelta(days=back)).strftime("%Y%m%d")
        status, body = get(FINRA_URL % d)
        if status != 200:
            continue
        out = {}
        reader = csv.DictReader(io.StringIO(body.decode("utf-8", "replace")),
                                delimiter="|", quoting=csv.QUOTE_NONE)
        for r in reader:
            out[(r.get("symbolCode") or "").strip().upper()] = (
                _num(r.get("currentShortPositionQuantity")),
                _num(r.get("daysToCoverQuantity")))
        return out, d
    return {}, None


def _num(s):
    try:
        v = float(s)
    except (TypeError, ValueError):
        return None
    return v if v == v and v >= 0 else None


def crowded(entry, shares):
    """True when either measure is above its limit, or a measure is missing and
    the other does not already veto.
    lean: shares outstanding stand in for float, which understates the short
    share of float; store a float share count to remove it."""
    if entry is None:
        return True
    short, dtc = entry
    pct = short / shares if short is not None and shares else None
    if (pct is not None and pct > MAX_FLOAT_SHORT) or (
            dtc is not None and dtc > MAX_DAYS_TO_COVER):
        return True
    return pct is None or dtc is None


def forced_sellers(store, ciks, end):
    """({symbol: veto}, symbols with no ownership edge). The veto is the
    strongest common-owner overlap with another firm at or above
    FORCED_SELLER_OVERLAP; a symbol with no 13F edge known by `end` has no
    measure and vetoes."""
    day = _day(end)
    best = {}
    for e in store.edges(day, day):
        if e["source"] != "ownership":
            continue
        for k in (e["src_cik"], e["dst_cik"]):
            best[k] = max(best.get(k, 0.0), e["weight"])
    out, unknown = {}, []
    for cik, sym in ciks.items():
        if cik in best:
            out[sym] = best[cik] >= FORCED_SELLER_OVERLAP
        else:
            out[sym] = True
            unknown.append(sym)
    return out, unknown


def _market_cap(ref, sym, end):
    rows = [r for r in ref["market_cap"].get(sym, ()) if r["known_at"] <= end]
    return max(rows, key=lambda r: r["known_at"])["value"] if rows else None


def _read_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _shares(cache, sym, end):
    try:
        facts = _read_json(os.path.join(cache, sym + ".json"))["facts"]
        return shares_outstanding.shares(facts, end)["value"]
    except (OSError, ValueError, KeyError, TypeError,
            shares_outstanding.SharesError):
        return None


def build(data_dir, end, transport, finra_get, sleep=time.sleep):
    """({"data": {veto: {symbol: bool}}, "unavailable": {input: [symbol]}},
    FINRA settlement date). Reads reference.json, the filing corpus, FSDS
    zips, the reference cache and the link store under `data_dir`."""
    ref = _read_json(os.path.join(data_dir, "reference.json"))["data"]
    ciks = {int(c): s for c, s in ref["ciks"].items()}
    by_sym = {s: c for c, s in ciks.items()}
    unavailable = {k: [] for k in INPUTS}
    values = fsds_values(os.path.join(data_dir, "fsds"), set(ciks), end)
    store = link_store.LinkStore(os.path.join(data_dir, "link_store.jsonl"))
    forced, no_edge = forced_sellers(
        store, {"%010d" % c: s for c, s in ciks.items()}, end)
    unavailable["ownership_edges"] = sorted(no_edge)
    interest, settled = short_interest(finra_get, end)
    out = {"distress": {}, "no_borrow": {}, "crowded": {},
           "forced_seller": forced}
    for sym in sorted(by_sym):
        cik = by_sym[sym]
        cap = _market_cap(ref, sym, end)
        z = altman_z(values[cik], cap) if cik in values and cap else None
        out["distress"][sym], have_text = distress(
            latest_filing_text(os.path.join(data_dir, "filings"), cik, end),
            z)
        for ok, name in ((have_text, "filing_text"), (z is not None,
                                                      "altman_z")):
            if not ok:
                unavailable[name].append(sym)
        flags = asset_flags(transport, sym)
        sleep(ALPACA_INTERVAL_S)
        out["no_borrow"][sym] = flags is None or not all(flags)
        if flags is None:
            unavailable["alpaca_asset"].append(sym)
        shares = _shares(os.path.join(data_dir, "reference_cache"), sym, end)
        entry = interest.get(sym.upper()) or interest.get(
            sym.upper().replace("-", "."))
        out["crowded"][sym] = crowded(entry, shares)
        if shares is None:
            unavailable["shares_outstanding"].append(sym)
        if entry is None or None in entry:
            unavailable["finra_short_interest"].append(sym)
    return {"data": out, "unavailable": {
        k: sorted(v) for k, v in unavailable.items() if v}}, settled


def _atomic_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, sort_keys=True)
    os.replace(tmp, path)


def main(argv=None, env=None, now=None, log=print, transport=None,
         finra_get=None, sleep=time.sleep):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--end", help="ISO date, default today (UTC)")
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    kid, secret = env.get("ALPACA_KEY_ID"), env.get("ALPACA_SECRET")
    if not kid or not secret:
        log("ALPACA_KEY_ID and ALPACA_SECRET must be exported")
        return 2
    end = a.end or (now or datetime.datetime.now(datetime.timezone.utc)
                    ).date().isoformat()
    try:
        built, settled = build(
            a.data, end, transport or alpaca_short_probe.http_transport(
                kid, secret), finra_get or _finra_get, sleep)
    except (OSError, ValueError, KeyError, TypeError,
            link_store.LinkStoreError, zipfile.BadZipFile) as e:
        log("not written: %s: %s" % (type(e).__name__, e))
        return 1
    _atomic_json(os.path.join(a.data, "vetoes.json"),
                 {"through": end, "data": built["data"],
                  "unavailable": built["unavailable"]})
    log(json.dumps({"symbols": len(built["data"]["distress"]),
                    "finra_settlement": settled,
                    "unavailable": {k: len(v) for k, v in
                                    built["unavailable"].items()}},
                   sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
