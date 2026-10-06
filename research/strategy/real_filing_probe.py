"""Real-data check of the 10-K section parser and the 13F reader (plan/data.md
EDGAR corpus precision check): per sampled 10-K, whether filing_sections finds
Item 1A and MD&A and how long they are; for one 13F information table, how many
rows form13f parses and why the rest fail. Transports are injected; the SEC
contact string comes from MIRO_CONTACT only. The report holds public data."""
import collections
import json
import os
import random
import re
import sys
import xml.etree.ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.sources import edgar_filings, filing_sections, form13f
from research.strategy import customer_coverage_probe as ccp

N_FILINGS, SEED, YEAR = 20, 1, 2024
F13_YEAR, F13_QTR, F13_TRIES = 2024, 4, 5
MIN_SECTION, MAX_SHARE = 2000, 0.6
ITEMS = {"1A": "item_1a", "7": "mdna"}
FOLDER_URL = "https://www.sec.gov/Archives/edgar/data/%d/%s/index.json"
TABLE_URL = "https://www.sec.gov/Archives/edgar/data/%d/%s/%s"
_HTML = re.compile(r"<(html|body|div|p|table)\b", re.IGNORECASE)


def section_row(raw):
    """Sections found in one filing body: per tracked item its length and
    whether it is suspect (under MIN_SECTION characters or over MAX_SHARE of
    the filing, the sign that a late cross-reference heading won)."""
    res = filing_sections.parse(raw, html=bool(_HTML.search(raw)))
    row = {"chars": len(res.text), "parsed": bool(res.sections),
           "reason": res.reason}
    for item, key in ITEMS.items():
        span = res.sections.get(item)
        size = span[1] - span[0] if span else None
        row[key] = {"found": span is not None, "chars": size,
                    "suspect": size is not None and (
                        size < MIN_SECTION or size > MAX_SHARE * len(res.text))}
    return row


def probe_sections(year, get_index, get_sub, get_raw, n=N_FILINGS, seed=SEED):
    """`get_raw(filing)` is the filing body as fetched. A filer with no 10-K in
    its recent filings, or whose fetch fails, is counted in `skipped`."""
    rows, skipped = [], 0
    for f in ccp.sample_filers(ccp.parse_index(get_index(year)), n, seed):
        try:
            found = edgar_filings.list_filings(
                get_sub(f["cik"]), forms=("10-K",),
                start="%d-01-01" % year, end="%d-12-31" % year)
            if not found:
                skipped += 1
                continue
            row = section_row(get_raw(found[0]))
        except edgar_filings.FilingError:
            skipped += 1
            continue
        rows.append({"cik": f["cik"], "accession": found[0]["accession"],
                     **row})
    return {"year": year, "filings": len(rows), "skipped": skipped,
            "parsed": sum(r["parsed"] for r in rows),
            "suspect": sum(r[k]["suspect"] for r in rows
                           for k in ITEMS.values()),
            "rows": rows}


def parse_index_13f(text):
    """13F-HR filings from an EDGAR form.idx body: [{cik, accession, date}].
    The name holds spaces, so the three trailing fields are split off the
    right."""
    out = []
    for line in text.splitlines():
        if not line.startswith("13F-HR "):
            continue
        parts = line[7:].rsplit(None, 3)
        if len(parts) == 4 and parts[1].isdigit():
            acc = parts[3].rsplit("/", 1)[-1].removesuffix(".txt")
            out.append({"cik": int(parts[1]), "accession": acc,
                        "date": parts[2]})
    return out


def fetch_table(index_text, get_json, get_bytes, seed=SEED, tries=F13_TRIES):
    """First seeded 13F-HR filing whose folder lists an information table XML
    (a combination report has none): (filing, xml bytes), or None."""
    pool = sorted(parse_index_13f(index_text), key=lambda f: f["accession"])
    random.Random(seed).shuffle(pool)
    for f in pool[:tries]:
        folder = f["accession"].replace("-", "")
        try:
            items = get_json(FOLDER_URL % (f["cik"], folder))["directory"]["item"]
            names = [i["name"] for i in items
                     if i["name"].lower().endswith(".xml")
                     and i["name"].lower() != "primary_doc.xml"]
            if names:
                return f, get_bytes(TABLE_URL % (f["cik"], folder, names[0]))
        except (edgar_filings.FilingError, KeyError, TypeError, ValueError):
            continue
    return None


def _reason(exc):
    return re.sub(r"\s+['\"].*$", "", str(exc))


def table_report(xml_bytes, cik, filing_date):
    """Row-by-row parse of one information table. A put/call row parses to
    nothing and counts as an option. The period is the filing date: the
    statistics do not read it."""
    out = {"rows": 0, "parsed": 0, "options": 0, "failures": {},
           "share_units": {}}
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        out["failures"] = {"unparseable xml": 1}
        out["reason"] = str(exc)
        return out
    fails, units = collections.Counter(), collections.Counter()
    for elem in root.iter():
        if form13f._local(elem.tag) != "infoTable":
            continue
        out["rows"] += 1
        for child in elem.iter():
            if form13f._local(child.tag) == "sshPrnamtType":
                units[(child.text or "").strip()] += 1
        try:
            got = form13f.parse_information_table(
                ET.tostring(elem), cik, filing_date, filing_date)
        except form13f.Form13fError as exc:
            fails[_reason(exc)] += 1
            continue
        out["parsed"] += len(got)
        out["options"] += not got
    out["failures"], out["share_units"] = dict(fails), dict(units)
    return out


def _live(contact, out_dir):
    fetcher = edgar_filings.Fetcher(contact, out_dir)
    sec_get, get_index, get_sub, _ = ccp._live(contact, out_dir)

    def get_raw(filing):
        row = fetcher.fetch(filing)
        path = os.path.join(out_dir, "%010d" % row["cik"], row["accession"],
                            row["primary_document"])
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()

    def get_bytes(url):
        try:
            return sec_get(url)
        except OSError:
            raise edgar_filings.FilingError("fetch failed")

    def get_json(url):
        return json.loads(get_bytes(url))

    return sec_get, get_index, get_sub, get_raw, get_json, get_bytes


if __name__ == "__main__":
    contact = os.environ.get("MIRO_CONTACT", "")
    if not contact.strip():
        sys.exit("MIRO_CONTACT missing: export the SEC contact string")
    root = os.path.join(os.path.dirname(__file__), "..")
    sec_get, get_index, get_sub, get_raw, get_json, get_bytes = _live(
        contact, os.path.join(root, "data", "filings"))
    rep = {"sections": probe_sections(YEAR, get_index, get_sub, get_raw)}
    print({k: v for k, v in rep["sections"].items() if k != "rows"},
          flush=True)
    idx = sec_get(ccp.INDEX_URL.format(F13_YEAR, F13_QTR)).decode("latin-1")
    got = fetch_table(idx, get_json, get_bytes)
    if got:
        filing, xml = got
        rep["form13f"] = {"cik": filing["cik"],
                          "accession": filing["accession"],
                          **table_report(xml, filing["cik"], filing["date"])}
        print(rep["form13f"], flush=True)
    else:
        rep["form13f"] = None
    out = os.path.join(root, "reports", "real_filing_probe.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=1, sort_keys=True)
