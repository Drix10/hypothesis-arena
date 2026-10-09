"""Form 4 open-market purchases from SEC's quarterly insider-transaction sets.

`read_quarter` streams one quarter's zip into flat transaction rows;
`build_events` applies the opportunistic/routine split (Cohen, Malloy,
Pomorski 2012) and aggregates purchases per issuer per filing day."""
import csv
import datetime
import io
import re
import xml.etree.ElementTree as ET
import zipfile
from collections import defaultdict

ROUTINE_YEARS = 3
SESSION_OPEN = datetime.time(9, 30)
FILING_DAY_END = datetime.time(23, 59)
SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(?:[.-][A-Z])?$")
_OWNERSHIP = re.compile(r"<ownershipDocument>.*?</ownershipDocument>", re.S)
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


def _text(node, path):
    found = node.find(path)
    return (found.text or "").strip() if found is not None else ""


def read_filing(text, filing_date):
    """Rows of one Form 4 submission text, the same shape and filter as
    read_quarter. filing_date is the form.idx date. Raises ValueError when no
    well-formed ownershipDocument is present; a filing the quarterly sets would
    drop (other document type, unusable symbol) yields no rows."""
    m = _OWNERSHIP.search(text)
    if not m:
        raise ValueError("no ownershipDocument")
    try:
        doc = ET.fromstring(m.group(0))
        cik = "%010d" % int(_text(doc, "issuer/issuerCik"))
    except (ET.ParseError, ValueError):
        raise ValueError("malformed ownershipDocument") from None
    sym = _text(doc, "issuer/issuerTradingSymbol").strip("\"'").upper()
    if _text(doc, "documentType") != "4" or not SYMBOL_RE.match(sym):
        return []
    owners = []
    for o in doc.iterfind("reportingOwner"):
        rel = o.find("reportingOwnerRelationship")
        flag = lambda tag: _text(rel, tag).lower() in ("1", "true") \
            if rel is not None else False
        owners.append((_text(o, "reportingOwnerId/rptOwnerCik"),
                       flag("isOfficer") or flag("isDirector")))
    out = []
    for t in doc.iterfind("nonDerivativeTable/nonDerivativeTransaction"):
        code = _text(t, "transactionCoding/transactionCode")
        if code not in ("P", "S"):
            continue
        if "common" not in _text(t, "securityTitle/value").lower():
            continue
        try:
            td = datetime.date.fromisoformat(_text(t, "transactionDate/value")[:10])
            sh = float(_text(t, "transactionAmounts/transactionShares/value"))
            px = float(_text(t, "transactionAmounts/transactionPricePerShare/value"))
        except ValueError:
            continue
        if not (sh > 0 and px > 0):
            continue
        for owner, officer in owners:
            out.append({"filing_date": filing_date, "trans_date": td,
                        "cik": cik, "symbol": sym, "owner": owner,
                        "officer_or_director": officer, "code": code,
                        "shares": sh, "price": px})
    return out


def is_routine(history, year, month):
    """Traded in the same calendar month in each of the prior 3 years."""
    return all((year - k, month) in history for k in range(1, ROUTINE_YEARS + 1))


def has_history(first, day):
    """At least ROUTINE_YEARS of loaded history before `day`."""
    try:
        return first <= day.replace(year=day.year - ROUTINE_YEARS)
    except ValueError:      # Feb 29 minus whole years
        return first <= day.replace(year=day.year - ROUTINE_YEARS, day=28)


def entry_open(filing_date):
    """Open of the second weekday session after the filing day. The quarterly
    sets carry no acceptance time, so the filing is taken as accepted at the
    end of its day and a score is usable from the second session.
    lean: weekdays only, no exchange holiday calendar; swap in the session
    calendar when the composite builder needs exact fills."""
    d, n = filing_date, 0
    while n < 2:
        d += datetime.timedelta(days=1)
        n += d.weekday() < 5
    return datetime.datetime.combine(d, SESSION_OPEN)


def build_events(rows):
    """Officer/director purchases that are not routine, aggregated per issuer
    per filing date: dicts of date, symbol, cik, value, n_insiders,
    opportunistic, accepted, entry, sorted by date. `opportunistic` is true
    only when a contributing insider has at least ROUTINE_YEARS of loaded
    history and no calendar-month habit; shorter history is unclassified and
    never flagged."""
    hist = defaultdict(set)
    first = {}
    for r in rows:
        k = (r["cik"], r["owner"])
        hist[k].add((r["trans_date"].year, r["trans_date"].month))
        first[k] = min(first.get(k, r["trans_date"]), r["trans_date"])
    agg = {}
    for r in rows:
        if r["code"] != "P" or not r["officer_or_director"]:
            continue
        td = r["trans_date"]
        key = (r["cik"], r["owner"])
        if is_routine(hist[key], td.year, td.month):
            continue
        if r["filing_date"] < td:
            continue
        k = (r["filing_date"], r["cik"], r["symbol"])
        e = agg.setdefault(k, {"date": r["filing_date"].isoformat(),
                               "cik": r["cik"], "symbol": r["symbol"],
                               "value": 0.0, "owners": set(),
                               "opportunistic": False})
        e["opportunistic"] |= has_history(first[key], td)
        e["value"] += r["shares"] * r["price"]
        e["owners"].add(r["owner"])
    out = []
    for e in agg.values():
        e["n_insiders"] = len(e.pop("owners"))
        fd = datetime.date.fromisoformat(e["date"])
        e["accepted"] = datetime.datetime.combine(
            fd, FILING_DAY_END).isoformat(timespec="minutes")
        e["entry"] = entry_open(fd).isoformat(timespec="minutes")
        out.append(e)
    return sorted(out, key=lambda e: (e["date"], e["symbol"]))
