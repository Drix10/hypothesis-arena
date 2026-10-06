"""Issuer cik to trading symbol lookups from SEC insider-transaction zips and
company_tickers.json."""
import csv
import datetime
import io
import json
import re
import zipfile
from collections import defaultdict

SYMBOL_RE = re.compile(r"^[A-Z]{1,5}(?:[.-][A-Z])?$")
csv.field_size_limit(1 << 24)


def _lines(z, name):
    with z.open(name) as f:
        yield from io.TextIOWrapper(f, encoding="utf-8", errors="replace",
                                    newline="")


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
