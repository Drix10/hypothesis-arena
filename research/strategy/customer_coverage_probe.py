"""Customer-edge coverage probe (plan/data.md EDGAR coverage check): per filing
year 2016-2025, of a random sample of 10-K filers, the share whose text names a
customer and the share of named customers that resolve to one CIK. If the
2021-2025 share collapses against 2016-2019, connected_drift is registered
without edge (a). Transports are injected; the report holds public data only."""
import html
import json
import os
import random
import re
import sys
import time
import urllib.request
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import customer_edges
from research.sources import edgar_filings, ticker_map

N_PER_YEAR, SEED = 10, 1
YEARS = tuple(range(2016, 2026))
PRE_YEARS, POST_YEARS = (2016, 2019), (2021, 2025)
COLLAPSE_RATIO = 0.5  # lean: judgment threshold, the plan names no number
INDEX_URL = "https://www.sec.gov/Archives/edgar/full-index/{}/QTR{}/form.idx"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK%010d.json"
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_TAG = re.compile(r"<[^>]+>")


def parse_index(text):
    """10-K filers from an EDGAR form.idx body: [{cik, name}], one per cik.
    Columns are fixed-width but the name holds spaces, so the three trailing
    fields (cik, date, file name) are split off the right."""
    out = {}
    for line in text.splitlines():
        if not line.startswith("10-K "):
            continue
        parts = line[5:].rsplit(None, 3)
        if len(parts) == 4 and parts[1].isdigit():
            out.setdefault(int(parts[1]), parts[0].strip())
    return [{"cik": c, "name": n} for c, n in sorted(out.items())]


def sample_filers(filers, n=N_PER_YEAR, seed=SEED):
    pool = sorted(filers, key=lambda f: f["cik"])
    return random.Random(seed).sample(pool, min(n, len(pool)))


def plain_text(raw):
    """Filing body with tags dropped and whitespace collapsed."""
    return " ".join(html.unescape(_TAG.sub(" ", raw)).split())


def alias_tables(tickers):
    """(aliases, observations) from the SEC company_tickers.json values. The
    map is current only, so a customer since delisted does not resolve; that
    understates resolution for early years."""
    aliases, obs = {}, []
    for v in tickers.values():
        key = customer_edges.normalise_name(v["title"])
        if key:
            aliases.setdefault(key, []).append(int(v["cik_str"]))
        obs.append(ticker_map.observation(v["cik_str"], v["ticker"], "dei",
                                          date.min, date.min))
    return aliases, obs


def _year_row(texts, aliases, observations, as_of):
    named = mentions = resolved = 0
    for text in texts:
        found = [m for m in customer_edges.mentions(text)
                 if m["relation"] == "customer"]
        named += bool(found)
        mentions += len(found)
        resolved += sum(customer_edges.resolve_name(
            m["name"], aliases, observations, as_of) is not None
            for m in found)
    n = len(texts)
    return {"filings": n, "named": named, "mentions": mentions,
            "resolved": resolved,
            "named_share": named / n if n else None,
            "resolved_share": resolved / mentions if mentions else None}


def _pooled(rows, lo, hi):
    sel = [r for y, r in rows.items() if lo <= y <= hi]
    n = sum(r["filings"] for r in sel)
    return sum(r["named"] for r in sel) / n if n else None


def collapse(rows):
    """Pooled named share before and after the 2020 amendments, and whether
    the later share is under COLLAPSE_RATIO of the earlier one; None when
    either side has no filings or the earlier share is zero."""
    pre, post = _pooled(rows, *PRE_YEARS), _pooled(rows, *POST_YEARS)
    return {"pre_share": pre, "post_share": post,
            "collapsed": (None if not pre or post is None
                          else post < COLLAPSE_RATIO * pre)}


def probe(years, get_index, get_sub, get_text, aliases, observations,
          n=N_PER_YEAR, seed=SEED):
    """`get_index(year)` is the year's form.idx text, `get_sub(cik)` the EDGAR
    submissions record, `get_text(filing)` the plain filing text. A filer
    with no 10-K in its recent filings, or whose fetch fails, is counted in
    `skipped` and never read as a filing without customers. The fiscal year
    is the filing year."""
    rows = {}
    for y in years:
        texts, skipped = [], 0
        for f in sample_filers(parse_index(get_index(y)), n, seed):
            try:
                found = edgar_filings.list_filings(
                    get_sub(f["cik"]), forms=("10-K",),
                    start="%d-01-01" % y, end="%d-12-31" % y)
                if not found:
                    skipped += 1
                    continue
                texts.append(get_text(found[0]))
            except edgar_filings.FilingError:
                skipped += 1
        rows[y] = _year_row(texts, aliases, observations, date(y, 12, 31))
        rows[y]["skipped"] = skipped
    return {"years": {str(y): r for y, r in rows.items()}, **collapse(rows)}


def _live(contact, out_dir):
    fetcher = edgar_filings.Fetcher(contact, out_dir)
    last = [0.0]

    def sec_get(url):
        wait = last[0] - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        last[0] = time.monotonic() + 0.12
        req = urllib.request.Request(url, headers={"User-Agent": fetcher.ua})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()

    def get_index(year):
        return "".join(sec_get(INDEX_URL.format(year, q)).decode("latin-1")
                       for q in range(1, 5))

    def get_sub(cik):
        try:
            return json.loads(sec_get(SUBMISSIONS_URL % cik))
        except OSError:
            raise edgar_filings.FilingError("submissions fetch failed")

    def get_text(filing):
        row = fetcher.fetch(filing)
        path = os.path.join(out_dir, "%010d" % row["cik"], row["accession"],
                            row["primary_document"])
        with open(path, encoding="utf-8", errors="replace") as f:
            return plain_text(f.read())

    return sec_get, get_index, get_sub, get_text


if __name__ == "__main__":
    contact = os.environ.get("MIRO_CONTACT", "")
    if not contact.strip():
        sys.exit("MIRO_CONTACT missing: export the SEC contact string")
    root = os.path.join(os.path.dirname(__file__), "..")
    sec_get, get_index, get_sub, get_text = _live(
        contact, os.path.join(root, "data", "filings"))
    aliases, obs = alias_tables(json.loads(sec_get(TICKERS_URL)))
    rep = probe(YEARS, get_index, get_sub, get_text, aliases, obs)
    print({k: v for k, v in rep.items() if k != "years"}, flush=True)
    out = os.path.join(root, "reports", "customer_coverage.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=1, sort_keys=True)
