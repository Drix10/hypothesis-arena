"""Form 4 open-market purchases from SEC's quarterly insider-transaction sets.

`read_quarter` streams one quarter's zip into flat transaction rows;
`build_events` applies the opportunistic/routine split (Cohen, Malloy,
Pomorski 2012) and aggregates purchases per issuer per filing day."""
import csv
import datetime
import io
import re
import zipfile
from collections import defaultdict

ROUTINE_YEARS = 3
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(?:[.-][A-Z])?$")
csv.field_size_limit(1 << 24)


def _date(s):
    try:
        return datetime.datetime.strptime(s.strip(), "%d-%b-%Y").date()
    except ValueError:
        return None


def _tsv(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8",
                                                   newline=""),
                                  delimiter="\t")


def read_quarter(path):
    """Rows: dict(filing_date, trans_date, cik, symbol, owner, officer_or_director,
    code, shares, price). Only form 4 common-stock P/S transactions."""
    with zipfile.ZipFile(path) as z:
        subs = {}
        for r in _tsv(z, "SUBMISSION.tsv"):
            if r["DOCUMENT_TYPE"].strip() != "4":
                continue
            fd = _date(r["FILING_DATE"])
            sym = r["ISSUERTRADINGSYMBOL"].strip().strip("\"'").upper()
            if fd and SYMBOL_RE.match(sym):
                subs[r["ACCESSION_NUMBER"]] = (fd, r["ISSUERCIK"], sym)
        owners = defaultdict(list)
        for r in _tsv(z, "REPORTINGOWNER.tsv"):
            if r["ACCESSION_NUMBER"] in subs:
                owners[r["ACCESSION_NUMBER"]].append(
                    (r["RPTOWNER_RELATIONSHIP"], r["RPTOWNERCIK"]))
        out = []
        for r in _tsv(z, "NONDERIV_TRANS.tsv"):
            acc = r["ACCESSION_NUMBER"]
            if acc not in subs or r["TRANS_CODE"] not in ("P", "S"):
                continue
            if "common" not in r["SECURITY_TITLE"].lower():
                continue
            td = _date(r["TRANS_DATE"])
            try:
                sh, px = float(r["TRANS_SHARES"]), float(r["TRANS_PRICEPERSHARE"])
            except ValueError:
                continue
            if td is None or not (sh > 0 and px > 0):
                continue
            fd, cik, sym = subs[acc]
            for rel, owner in owners.get(acc, []):
                out.append({"filing_date": fd, "trans_date": td, "cik": cik,
                            "symbol": sym, "owner": owner,
                            "officer_or_director": ("Officer" in rel
                                                    or "Director" in rel),
                            "code": r["TRANS_CODE"], "shares": sh,
                            "price": px})
        return out


def is_routine(history, year, month):
    """Traded in the same calendar month in each of the prior 3 years."""
    return all((year - k, month) in history for k in range(1, ROUTINE_YEARS + 1))


def build_events(rows):
    """Opportunistic officer/director purchases, aggregated per issuer per
    filing date: dicts of date, symbol, cik, value, n_insiders, sorted by date."""
    hist = defaultdict(set)
    for r in rows:
        hist[(r["cik"], r["owner"])].add((r["trans_date"].year,
                                          r["trans_date"].month))
    agg = {}
    for r in rows:
        if r["code"] != "P" or not r["officer_or_director"]:
            continue
        td = r["trans_date"]
        if is_routine(hist[(r["cik"], r["owner"])], td.year, td.month):
            continue
        if r["filing_date"] < td:
            continue
        k = (r["filing_date"], r["cik"], r["symbol"])
        e = agg.setdefault(k, {"date": r["filing_date"].isoformat(),
                               "cik": r["cik"], "symbol": r["symbol"],
                               "value": 0.0, "owners": set()})
        e["value"] += r["shares"] * r["price"]
        e["owners"].add(r["owner"])
    out = []
    for e in agg.values():
        e["n_insiders"] = len(e.pop("owners"))
        out.append(e)
    return sorted(out, key=lambda e: (e["date"], e["symbol"]))
