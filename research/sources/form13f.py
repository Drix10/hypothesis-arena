"""13F-HR information table parser and common-ownership overlap.

Parses the information table XML into equity holding rows and fails closed on
DOCTYPE or entity declarations and on any malformed row. Values are dollars:
filings filed before VALUE_DOLLARS_FILED_FROM report thousands.
"""
import re
import xml.etree.ElementTree as ET

# The SEC moved the value column from thousands to dollars for filings made on
# or after 2023-01-03, whatever the period of report.
VALUE_DOLLARS_FILED_FROM = "2023-01-03"

_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_CUSIP_RE = re.compile(r"^[0-9A-Z]{9}$")
_DISCRETION = ("SOLE", "DFND", "OTR")
_OPTIONS = ("PUT", "CALL")


class Form13fError(ValueError):
    pass


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _fields(elem):
    """Local-name -> stripped text for the children of elem, one level deep."""
    out = {}
    for child in elem:
        name = _local(child.tag)
        if name in out:
            raise Form13fError("duplicate field %s" % name)
        out[name] = (child.text or "").strip()
    return out


def _int(text, what):
    if not re.match(r"^\d+$", text or ""):
        raise Form13fError("bad %s %r" % (what, text))
    return int(text)


def _check_date(text, what):
    if not _DATE_RE.match(text or ""):
        raise Form13fError("bad %s %r" % (what, text))


def parse_information_table(xml_bytes, cik, period, filing_date):
    """Equity holding rows of one filing; put/call option rows are dropped."""
    _check_date(period, "period")
    _check_date(filing_date, "filing date")
    if not re.match(r"^\d{1,10}$", str(cik)):
        raise Form13fError("bad cik %r" % (cik,))
    if isinstance(xml_bytes, str):
        xml_bytes = xml_bytes.encode("utf-8")
    upper = xml_bytes.upper()
    if b"<!DOCTYPE" in upper or b"<!ENTITY" in upper:
        raise Form13fError("DOCTYPE or entity declaration")
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise Form13fError("unparseable xml: %s" % exc)
    tables = [e for e in root.iter() if _local(e.tag) == "infoTable"]
    if not tables:
        raise Form13fError("no infoTable rows")
    scale = 1 if filing_date >= VALUE_DOLLARS_FILED_FROM else 1000
    rows = []
    for elem in tables:
        f = _fields(elem)
        amount = None
        for child in elem:
            if _local(child.tag) == "shrsOrPrnAmt":
                amount = _fields(child)
        if amount is None:
            raise Form13fError("missing shrsOrPrnAmt")
        cusip = f.get("cusip", "").upper()
        if not _CUSIP_RE.match(cusip):
            raise Form13fError("bad cusip %r" % f.get("cusip"))
        if not f.get("nameOfIssuer"):
            raise Form13fError("missing issuer name")
        discretion = f.get("investmentDiscretion", "")
        if discretion not in _DISCRETION:
            raise Form13fError("bad discretion %r" % discretion)
        put_call = f.get("putCall", "").upper()
        if put_call and put_call not in _OPTIONS:
            raise Form13fError("bad putCall %r" % put_call)
        value = _int(f.get("value"), "value") * scale
        shares = _int(amount.get("sshPrnamt"), "shares")
        if put_call:
            continue
        rows.append({
            "cik": str(int(cik)),
            "period": period,
            "filing_date": filing_date,
            "cusip": cusip,
            "issuer": f["nameOfIssuer"],
            "value": value,
            "shares": shares,
            "put_call": "",
            "discretion": discretion,
        })
    return rows


def _latest_holdings(rows, as_of):
    """Per filer, rows of the latest period filed on or before as_of."""
    best = {}
    for r in rows:
        if r["filing_date"] > as_of:
            continue
        key = (r["period"], r["filing_date"])
        if r["cik"] not in best or key > best[r["cik"]]:
            best[r["cik"]] = key
    return [r for r in rows
            if r["cik"] in best
            and (r["period"], r["filing_date"]) == best[r["cik"]]]


def overlap(rows, cusip_a, cusip_b, as_of):
    """Sum over filers holding both issuers of min(share_a, share_b).

    A share is the issuer's value over the filer's total reported value, taken
    from the filer's latest filing with filing_date <= as_of.
    """
    totals = {}
    held = {}
    for r in _latest_holdings(rows, as_of):
        totals[r["cik"]] = totals.get(r["cik"], 0) + r["value"]
        if r["cusip"] in (cusip_a, cusip_b):
            slot = held.setdefault(r["cik"], {})
            slot[r["cusip"]] = slot.get(r["cusip"], 0) + r["value"]
    score = 0.0
    for cik, slot in held.items():
        if cusip_a in slot and cusip_b in slot and totals[cik] > 0:
            score += min(slot[cusip_a], slot[cusip_b]) / totals[cik]
    return score
