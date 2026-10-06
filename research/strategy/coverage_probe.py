"""Data coverage probe (plan/roadmap.md, plan/data.md): of a random sample of
10-K filers, the share with SIP daily bars across their listed life and the
share whose CIK maps to a ticker with bars on the filing date. Either share
below 95% meets the paid-data trigger; the cohort whose cover public float
reaches the strategy universe's floor governs, all filers are reported beside
it. Transports are injected; the report holds public issuer data only."""
import csv
import io
import json
import os
import random
import re
import sys
import urllib.error
import zipfile
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

N_FIRMS, SEED, MIN_SHARE = 300, 1, 0.95
MIN_FLOAT = 500e6  # the strategy universe's market-cap floor
FLOAT_YEARS = (2015, 2018)
FRAMES_URL = ("https://data.sec.gov/api/xbrl/frames/dei/"
              "EntityPublicFloat/USD/CY{}Q{}I.json")
YEARS = (2016, 2017, 2018)
GRACE_DAYS, MIN_BAR_RATIO, MAX_GAP_DAYS = 7, 0.9, 10
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(?:[.-][A-Z])?$")
END_FORMS = ("25", "25-NSE", "15-12B", "15-12G", "15-15D")
PERIODIC = ("10-K", "10-K405", "10-KT", "10-Q")
STALE_DAYS = 400
INSIDER_URL = ("https://www.sec.gov/files/structureddata/data/"
               "insider-transactions-data-sets/{}q{}_form345.zip")
csv.field_size_limit(1 << 24)


def _d(s):
    return datetime.strptime(s.strip()[:8], "%Y%m%d").date()


def norm(name):
    """Company name key: upper-case alphanumerics, corporate suffixes out."""
    s = re.sub(r"[^A-Z0-9 ]", " ", name.upper())
    s = re.sub(r"\b(INC|CORP|CORPORATION|CO|COMPANY|LTD|LLC|PLC|HOLDINGS|"
               r"THE)\b", " ", s)
    return " ".join(s.split())


def _zips(fsds_dir):
    for y in YEARS:
        for q in range(1, 5):
            path = os.path.join(fsds_dir, f"{y}q{q}.zip")
            if not os.path.exists(path):
                raise FileNotFoundError(path)
            yield path


def public_floats(adshs, get_json):
    """accession -> public float in USD from the 10-K cover (dei
    EntityPublicFloat), taken from the SEC frames API: one call per calendar
    quarter lists every filer's value with the accession that reported it."""
    out = {}
    for y in range(FLOAT_YEARS[0], FLOAT_YEARS[1] + 1):
        for q in range(1, 5):
            data = get_json(FRAMES_URL.format(y, q)) or {}
            for r in data.get("data") or []:
                if r.get("accn") in adshs:
                    out[r["accn"]] = float(r["val"])
    return out


def sample_firms(fsds_dir, n=N_FIRMS, seed=SEED, min_float=None,
                 get_json=None):
    """Random sample of CIKs with a 10-K filed in YEARS, each with its first
    such filing date and name: [{cik, name, filed, adsh, float}], sorted by
    cik. With `min_float` (and `get_json` for the frames API), only firms
    whose cover public float reaches it; firms without a float are not
    eligible."""
    first = {}
    for path in _zips(fsds_dir):
        with zipfile.ZipFile(path) as z:
            rd = csv.DictReader(
                io.TextIOWrapper(z.open("sub.txt"), "utf-8", "replace"),
                delimiter="\t", quoting=csv.QUOTE_NONE)
            for r in rd:
                if r["form"] != "10-K" or not r["cik"].strip().isdigit():
                    continue
                cik, filed = str(int(r["cik"])), _d(r["filed"])
                if cik not in first or filed < first[cik]["filed"]:
                    first[cik] = {"cik": cik, "name": r["name"],
                                  "filed": filed, "adsh": r["adsh"]}
    floats = {}
    if min_float is not None:
        floats = public_floats({f["adsh"] for f in first.values()}, get_json)
    for f in first.values():
        f["float"] = floats.get(f["adsh"])
    pool = sorted(c for c, f in first.items()
                  if min_float is None or (f["float"] or 0) >= min_float)
    pick = random.Random(seed).sample(pool, min(n, len(pool)))
    return [first[c] for c in sorted(pick)]


def listed_end(sub, today):
    """Last listed day from an EDGAR submissions record: today when a 10-K or
    10-Q is recent; otherwise a delisting or deregistration filing after the
    last periodic report, else the last filing. A Form 25 for one security
    class (notes, preferred) does not end a firm that still files."""
    rec = (sub.get("filings") or {}).get("recent") or {}
    forms, dates = rec.get("form") or [], rec.get("filingDate") or []
    pairs = [(f, date.fromisoformat(d)) for f, d in zip(forms, dates)]
    if not pairs:
        return None
    periodic = [d for f, d in pairs if f in PERIODIC]
    last = max(periodic) if periodic else None
    if last and (today - last).days <= STALE_DAYS:
        return today
    ends = [d for f, d in pairs
            if f in END_FORMS and (last is None or d >= last)]
    return min(ends) if ends else max(d for _, d in pairs)


def candidates(firm, sub, current, assets, history=None):
    """Ordered (source, symbol) candidates for a firm: the current SEC
    ticker, the submissions tickers, Form 4 issuer symbols nearest the filing
    date, then broker assets whose name matches the firm's name or a former
    name."""
    out = []
    t = current.get(firm["cik"])
    if t:
        out.append(("sec_current", t))
    out += [("sec_submissions", s.upper()) for s in sub.get("tickers") or []]
    near = sorted((history or {}).get(firm["cik"], []),
                  key=lambda x: abs((x[0] - firm["filed"]).days))
    out += [("form4_history", sym) for _, sym in near]
    names = {norm(firm["name"]), norm(sub.get("name") or "")}
    names |= {norm(x.get("name", "")) for x in sub.get("formerNames") or []}
    names.discard("")
    out += [("asset_name", a["symbol"]) for a in assets
            if norm(a.get("name") or "") in names]
    seen, uniq = set(), []
    for src, s in out:
        if SYMBOL_RE.match(s) and s not in seen:
            seen.add(s)
            uniq.append((src, s))
    return uniq


def weekdays(a, b):
    n, d = 0, a
    while d <= b:
        n += d.weekday() < 5
        d += timedelta(days=1)
    return n


def assess(days, start, end):
    """Judge a sorted list of bar dates against a listing from `start`:
    maps (bars begin at the filing date), covers (and the series is dense,
    with no gap above MAX_GAP_DAYS), end_ok (it reaches `end`). A series that
    stops early is not judged missing: the SEC data cannot tell a delisting
    from lost bars, so `end_ok` is reported apart from `covers`."""
    if not days:
        return {"maps": False, "covers": False, "end_ok": False}
    maps = (days[0] <= start + timedelta(days=GRACE_DAYS)
            and days[-1] >= start)
    gap = max((b - a).days for a, b in zip(days, days[1:])) \
        if len(days) > 1 else 0
    dense = (len(days) >= MIN_BAR_RATIO * weekdays(days[0], days[-1])
             and gap <= MAX_GAP_DAYS)
    return {"maps": maps, "covers": maps and dense,
            "end_ok": days[-1] >= end - timedelta(days=GRACE_DAYS)}


def _days(bars):
    return sorted({date.fromisoformat(b["t"][:10]) for b in bars})


def probe(sample, current, assets, get_sub, get_bars, today, history=None,
          max_tries=5):
    """One record per firm, then shares. `get_sub(cik)` is the EDGAR
    submissions record, `get_bars(symbol, start, end)` the SIP daily bars, or
    None when the fetch failed (counted, never read as missing coverage).
    One symbol must cover the firm; the union of the candidates' bars only
    extends the end check, so a rename is not read as a missing tail, while a
    reused symbol cannot fill a hole."""
    rows = []
    for firm in sample:
        sub = get_sub(firm["cik"])
        end = listed_end(sub, today)
        row = {"cik": firm["cik"], "name": firm["name"],
               "filed": firm["filed"].isoformat(), "symbol": None,
               "source": None, "maps": False, "covers": False,
               "end_unverified": False}
        if end is None:
            row["why"] = "no-submissions"
            rows.append(row)
            continue
        end = min(end, today - timedelta(days=1))
        row["end"] = end.isoformat()
        cands = candidates(firm, sub, current, assets, history)[:max_tries]
        if not cands:
            row["why"] = "no-candidate"
        pool = set()
        for src, sym in cands:
            got = get_bars(sym, firm["filed"], end)
            if got is None:
                row["fetch_error"] = True
                continue
            days = _days(got)
            pool.update(days)
            one = assess(days, firm["filed"], end)
            if one["maps"] and row["symbol"] is None:
                row.update(symbol=sym, source=src, maps=True)
            if one["covers"] and not row["covers"]:
                row.update(symbol=sym, source=src, maps=True, covers=True)
        allv = assess(sorted(pool), firm["filed"], end)
        row["end_unverified"] = row["covers"] and not allv["end_ok"]
        if not row["maps"] and cands:
            row["why"] = ("fetch-error" if row.get("fetch_error")
                          else "no-bars")
        elif row["maps"] and not row["covers"]:
            row["why"] = "gaps"
        rows.append(row)
    n = len(rows)

    def share(key):
        return sum(bool(r[key]) for r in rows) / n
    errors = sum(bool(r.get("fetch_error")) for r in rows)
    by_source = {}
    for r in rows:
        if r["source"]:
            by_source[r["source"]] = by_source.get(r["source"], 0) + 1
    return {"firms": n, "mapped_share": share("maps"),
            "covered_share": share("covers"),
            "end_unverified_share": share("end_unverified"),
            "fetch_errors": errors, "by_source": by_source,
            "paid_data_trigger": (share("maps") < MIN_SHARE
                                  or share("covers") < MIN_SHARE),
            "conclusive": errors == 0, "rows": rows}


def _live():
    import time
    import urllib.request
    from research.strategy import sec_financial_statements as sfs
    from research.strategy import sip_fetch
    sip_fetch.load_alpaca_env()
    ua, hdr = sfs.user_agent(), sip_fetch._headers()
    gap = {"sec": 0.0, "alpaca": 0.0}

    def paced(kind, interval):
        wait = gap[kind] - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        gap[kind] = time.monotonic() + interval

    def sec_json(url):
        paced("sec", 0.12)
        req = urllib.request.Request(url, headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)

    def get_sub(cik):
        try:
            return sec_json("https://data.sec.gov/submissions/CIK%010d.json"
                            % int(cik))
        except Exception:
            return {}

    def get_bars(symbol, start, end):
        for attempt in range(4):
            paced("alpaca", 0.33)
            try:
                rows, _ = sip_fetch.fetch(
                    symbol, "bars", start.isoformat() + "T00:00:00Z",
                    end.isoformat() + "T23:59:59Z", "1Day")
                return rows
            except Exception as e:
                if getattr(e, "code", None) in (400, 404, 422):
                    return []
                time.sleep(3 * (attempt + 1))
        return None

    assets = []
    for status in ("active", "inactive"):
        paced("alpaca", 0.33)
        req = urllib.request.Request(
            "https://paper-api.alpaca.markets/v2/assets?asset_class=us_equity"
            "&status=" + status, headers=hdr)
        with urllib.request.urlopen(req, timeout=120) as r:
            assets += [{"symbol": a["symbol"], "name": a.get("name")}
                       for a in json.load(r)]
    with open(os.path.join(sfs.OUT, "company_tickers.json"),
              encoding="utf-8") as f:
        current = {str(int(v["cik_str"])): v["ticker"].upper()
                   for v in json.load(f).values()}
    return get_sub, get_bars, assets, current, sec_json


if __name__ == "__main__":
    from research.strategy import sec_financial_statements as sfs
    os.makedirs(sfs.OUT, exist_ok=True)
    ua = sfs.user_agent()
    for y in YEARS:
        for q in range(1, 5):
            dest = os.path.join(sfs.OUT, f"{y}q{q}.zip")
            if not os.path.exists(dest) or not sfs._valid(dest):
                sfs._get(sfs.URL.format(y, q), ua, dest)
                print("fetched", dest, flush=True)
    tick = os.path.join(sfs.OUT, "company_tickers.json")
    if not os.path.exists(tick):
        sfs._get(sfs.TICKERS, ua, tick)
    from research.strategy import issuer_symbols
    ins = os.path.join(sfs.OUT, "..", "form345")
    os.makedirs(ins, exist_ok=True)
    paths = []
    for y in YEARS:
        for q in range(1, 5):
            dest = os.path.join(ins, f"{y}q{q}_form345.zip")
            if not os.path.exists(dest) or not zipfile.is_zipfile(dest):
                sfs._get(INSIDER_URL.format(y, q), ua, dest)
                print("fetched", dest, flush=True)
            paths.append(dest)
    history = issuer_symbols.read_symbols(paths)
    get_sub, get_bars, assets, current, sec_json = _live()

    def frames(url):
        try:
            return sec_json(url)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise

    rep = {}
    for cohort, floor in (("eligible", MIN_FLOAT), ("all", None)):
        firms = sample_firms(sfs.OUT, min_float=floor, get_json=frames)
        rep[cohort] = probe(firms, current, assets, get_sub, get_bars,
                            date.today(), history)
        print(cohort, {k: v for k, v in rep[cohort].items() if k != "rows"},
              flush=True)
    out = os.path.join(os.path.dirname(__file__), "..", "reports",
                       "coverage_probe.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=1, sort_keys=True)
