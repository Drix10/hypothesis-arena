"""Post-earnings-announcement-drift signal from SEC Financial Statement Data
Sets.

`read_quarter` streams one quarterly zip into filings carrying their EPS
facts. `build_quarters` turns filings into per-firm fiscal-quarter EPS with a
same-filing prior-year comparative (split-consistent) and derives Q4 as
annual minus Q1-Q3. `add_sue` standardizes the year-over-year change by the
stdev of the previous 8 changes. `rolling_pct` ranks each SUE among filings
accepted in the trailing 90 days (no future information). The event date is
the filing's acceptance date, which lags the press release for large firms."""
import bisect
import csv
import datetime
import io
import json
import re
import statistics
import zipfile
from collections import defaultdict, deque

TAGS = ("EarningsPerShareDiluted", "EarningsPerShareBasic")
FORMS = ("10-Q", "10-K")
MIN_HISTORY, N_HISTORY, MAX_HISTORY_DAYS = 6, 8, 1100
WINDOW_DAYS, MIN_POPULATION = 90, 300
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(?:[.-][A-Z])?$")
csv.field_size_limit(1 << 24)
UOMS = ("USD", "USD/shares")


def _d(s):
    try:
        return datetime.datetime.strptime(s.strip()[:8], "%Y%m%d").date()
    except ValueError:
        return None


def _accepted(s):
    try:
        return datetime.datetime.strptime(s.strip()[:16], "%Y-%m-%d %H:%M")
    except ValueError:
        return None


def _lines(z, name):
    with z.open(name) as f:
        yield from io.TextIOWrapper(f, encoding="utf-8", errors="replace",
                                    newline="")


def read_quarter(path):
    """Filings: dict(adsh, cik, name, sic, form, period, filed, accepted,
    eps={(tag, ddate, qtrs): value}). Only 10-Q/10-K, not superseded, with
    unsegmented USD per-share quarterly (1) or annual (4) EPS for the period or
    its prior-year comparative."""
    with zipfile.ZipFile(path) as z:
        subs = {}
        rd = csv.DictReader(_lines(z, "sub.txt"), delimiter="\t",
                            quoting=csv.QUOTE_NONE)
        for r in rd:
            per, acc = _d(r["period"]), _accepted(r["accepted"])
            if r["form"] not in FORMS or r["prevrpt"] == "1" or not per \
                    or not acc or not r["cik"].strip().isdigit():
                continue
            subs[r["adsh"]] = {"adsh": r["adsh"], "cik": str(int(r["cik"])),
                               "name": r["name"], "sic": r["sic"],
                               "form": r["form"], "period": per,
                               "filed": _d(r["filed"]), "accepted": acc,
                               "eps": {}}
        it = z.open("num.txt")
        head = next(it).decode().rstrip("\n").split("\t")
        ix = {k: head.index(k) for k in
              ("adsh", "tag", "ddate", "qtrs", "uom", "segments", "coreg",
               "value")}
        for line in it:
            if b"EarningsPerShare" not in line:
                continue
            f = line.decode("utf-8", "replace").rstrip("\n").split("\t")
            s = subs.get(f[ix["adsh"]])
            if s is None or f[ix["tag"]] not in TAGS \
                    or f[ix["uom"]] not in UOMS or f[ix["segments"]] \
                    or f[ix["coreg"]] or f[ix["qtrs"]] not in ("1", "4"):
                continue
            dd = _d(f[ix["ddate"]])
            if dd is None or not (dd == s["period"]
                                  or 350 <= (s["period"] - dd).days <= 380):
                continue
            try:
                v = float(f[ix["value"]])
            except ValueError:
                continue
            s["eps"].setdefault((f[ix["tag"]], dd, int(f[ix["qtrs"]])), v)
    return [s for s in subs.values() if s["eps"]]


def _pick(eps, period, qtrs):
    """(tag, current, prior-year comparative) for the first tag that has both;
    None when no tag has a current value and a comparative."""
    for tag in TAGS:
        cur = eps.get((tag, period, qtrs))
        if cur is None:
            continue
        prior = [(abs((period - d).days - 365), v) for (t, d, q), v in
                 eps.items() if t == tag and q == qtrs
                 and 350 <= (period - d).days <= 380]
        if prior:
            return tag, cur, min(prior)[1]
    return None


def _record(f, tag, cur, py, derived):
    return {"cik": f["cik"], "period": f["period"], "eps": cur, "eps_py": py,
            "tag": tag, "adsh": f["adsh"], "form": f["form"], "name": f["name"],
            "sic": f["sic"], "accepted": f["accepted"], "derived": derived}


def build_quarters(filings):
    """Per-cik fiscal-quarter records sorted by period. A 10-K without a
    direct quarterly value gets Q4 = annual - (Q1+Q2+Q3), for the value and
    its comparative, only when all three 10-Q quarters of that year exist on
    the same EPS tag."""
    direct, annual = defaultdict(dict), []
    for f in sorted(filings, key=lambda f: f["accepted"]):
        p = _pick(f["eps"], f["period"], 1)
        if p:
            direct[f["cik"]].setdefault(f["period"],
                                        _record(f, *p, False))
        if f["form"] == "10-K":
            a = _pick(f["eps"], f["period"], 4)
            if a:
                annual.append((f, a))
    out = direct
    for f, (tag, cur, py) in annual:
        recs = out[f["cik"]]
        if f["period"] in recs:
            continue
        qs = []
        for k in (1, 2, 3):
            target = f["period"] - datetime.timedelta(days=round(91.3 * k))
            near = [r for p, r in recs.items()
                    if abs((p - target).days) <= 20 and r["tag"] == tag
                    and not r["derived"] and r["form"] == "10-Q"]
            if not near:
                break
            qs.append(min(near, key=lambda r: abs((r["period"] - target).days)))
        if len(qs) == 3 and len({r["period"] for r in qs}) == 3:
            recs[f["period"]] = _record(
                f, tag, cur - sum(r["eps"] for r in qs),
                py - sum(r["eps_py"] for r in qs), True)
    return {c: [r[p] for p in sorted(r)] for c, r in out.items()}


def sue_value(change, past):
    """change / stdev(past changes); None with fewer than MIN_HISTORY past
    changes or zero dispersion."""
    if len(past) < MIN_HISTORY:
        return None
    sd = statistics.stdev(past)
    return change / sd if sd > 0 else None


def add_sue(recs):
    """Sets rec['sue'] (or None) using only earlier fiscal quarters: the last
    N_HISTORY changes within MAX_HISTORY_DAYS."""
    for i, r in enumerate(recs):
        r["change"] = r["eps"] - r["eps_py"]
        past = [x["change"] for x in recs[:i]
                if (r["period"] - x["period"]).days <= MAX_HISTORY_DAYS]
        r["sue"] = sue_value(r["change"], past[-N_HISTORY:])
    return recs


def rolling_pct(items, window=WINDOW_DAYS, min_population=MIN_POPULATION):
    """items: dicts with 'date' (ISO) and 'sue'. Sets item['pct'] to the share
    of SUEs accepted in (date - window, date] that lie below the item's own,
    or None when that population is below min_population. Filings of the same
    day are all known at that day's close, so ties on a date are pooled."""
    items.sort(key=lambda e: e["date"])
    pool, live = [], deque()
    i = 0
    while i < len(items):
        j = i
        while j < len(items) and items[j]["date"] == items[i]["date"]:
            j += 1
        day = datetime.date.fromisoformat(items[i]["date"])
        for e in items[i:j]:
            bisect.insort(pool, e["sue"])
            live.append((day, e["sue"]))
        cut = day - datetime.timedelta(days=window)
        while live and live[0][0] <= cut:
            _, v = live.popleft()
            del pool[bisect.bisect_left(pool, v)]
        for e in items[i:j]:
            e["pct"] = (bisect.bisect_left(pool, e["sue"]) / len(pool)
                        if len(pool) >= min_population else None)
        i = j
    return items


def read_symbols(paths):
    """Issuer cik -> [(filing_date, symbol)] from SEC insider-transaction
    zips (SUBMISSION.tsv, any form), symbols upper-cased and validated."""
    seen = defaultdict(set)
    for p in paths:
        with zipfile.ZipFile(p) as z:
            rd = csv.DictReader(_lines(z, "SUBMISSION.tsv"), delimiter="\t",
                                quoting=csv.QUOTE_NONE)
            for r in rd:
                sym = r["ISSUERTRADINGSYMBOL"].strip().strip("\"'").upper()
                try:
                    fd = datetime.datetime.strptime(
                        r["FILING_DATE"].strip(), "%d-%b-%Y").date()
                    cik = str(int(r["ISSUERCIK"]))
                except ValueError:
                    continue
                if SYMBOL_RE.match(sym):
                    seen[cik].add((fd, sym))
    return {c: sorted(v) for c, v in seen.items()}


def read_tickers(path):
    """company_tickers.json -> {cik: current symbol}."""
    with open(path) as f:
        return {str(int(v["cik_str"])): v["ticker"].upper()
                for v in json.load(f).values()
                if SYMBOL_RE.match(v["ticker"].upper())}


def symbol_for(cik, day, history, current):
    """Issuer symbol as of `day`: nearest Form-4 issuer symbol in time, else
    the current SEC ticker; None if neither."""
    h = history.get(cik)
    if h:
        return min(h, key=lambda x: abs((x[0] - day).days))[1]
    return current.get(cik)


def build_events(filings, history, current, start="2016-01-01",
                 min_population=MIN_POPULATION):
    """One event per filing with a SUE, a rolling percentile and a symbol:
    dicts of date (acceptance date), accepted, symbol, cik, sue, pct, period,
    form, adsh, derived. Returns (events, counts)."""
    quarters = build_quarters(filings)
    items, counts = [], {"firm_quarters": 0, "with_sue": 0, "no_symbol": 0}
    for recs in quarters.values():
        add_sue(recs)
        counts["firm_quarters"] += len(recs)
        for r in recs:
            if r["sue"] is None:
                continue
            counts["with_sue"] += 1
            acc = r["accepted"]
            sym = symbol_for(r["cik"], acc.date(), history, current)
            if sym is None:
                counts["no_symbol"] += 1
                continue
            items.append({"date": acc.date().isoformat(),
                          "accepted": acc.isoformat(timespec="minutes"),
                          "symbol": sym, "cik": r["cik"], "sue": r["sue"],
                          "period": r["period"].isoformat(), "form": r["form"],
                          "adsh": r["adsh"], "derived": r["derived"]})
    rolling_pct(items, min_population=min_population)
    events = [e for e in items if e["date"] >= start and e["pct"] is not None]
    return events, counts
