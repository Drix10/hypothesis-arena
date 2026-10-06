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

N_PER_YEAR, SEED = 30, 1
YEARS = tuple(range(2016, 2026))
PRE_YEARS, POST_YEARS = (2016, 2019), (2021, 2025)
COLLAPSE_RATIO = 0.5  # lean: judgment threshold, the plan names no number
INDEX_URL = "https://www.sec.gov/Archives/edgar/full-index/{}/QTR{}/form.idx"
ARCHIVE_URL = "https://www.sec.gov/Archives/"
MAX_BYTES = 8 * 1024 * 1024
TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_TAG = re.compile(r"<[^>]+>")


def parse_index(text):
    """10-K filers from an EDGAR form.idx body: [{cik, name, file}], one per cik.
    Columns are fixed-width but the name holds spaces, so the three trailing
    fields (cik, date, file name) are split off the right."""
    out = {}
    for line in text.splitlines():
        if not line.startswith("10-K "):
            continue
        parts = line[5:].rsplit(None, 3)
        if len(parts) == 4 and parts[1].isdigit():
            out.setdefault(int(parts[1]), (parts[0].strip(), parts[3]))
    return [{"cik": c, "name": n, "file": f}
            for c, (n, f) in sorted(out.items())]


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


def probe(years, get_index, get_text, aliases, observations,
          n=N_PER_YEAR, seed=SEED):
    """`get_index(year)` is the year's form.idx text, `get_text(file_name)` the
    plain text of that index row's filing. A failed fetch or an empty text is
    counted in the year's `fetch_failed` / `empty_text` and never read as a
    filing without customers. A year with more than half its sample skipped
    makes the report `incomplete`, and `collapsed` is then None. The fiscal
    year is the filing year."""
    rows, incomplete = {}, False
    for y in years:
        texts, failed, empty = [], 0, 0
        sample = sample_filers(parse_index(get_index(y)), n, seed)
        for f in sample:
            try:
                text = get_text(f["file"])
            except (OSError, edgar_filings.FilingError):
                failed += 1
                continue
            if text.strip():
                texts.append(text)
            else:
                empty += 1
        rows[y] = _year_row(texts, aliases, observations, date(y, 12, 31))
        rows[y].update(fetch_failed=failed, empty_text=empty)
        incomplete |= not sample or 2 * (failed + empty) > len(sample)
    summary = collapse(rows)
    if incomplete:
        summary["collapsed"] = None
    return {"years": {str(y): r for y, r in rows.items()},
            "incomplete": incomplete, **summary}


def _live(contact):
    if not contact.strip():
        raise edgar_filings.FilingError("MIRO_CONTACT missing")
    ua = "%s contact=%s" % (edgar_filings.UA_BASE, contact.strip())
    last = [0.0]

    def sec_get(url, limit=None):
        wait = last[0] - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        last[0] = time.monotonic() + 0.12
        req = urllib.request.Request(url, headers={"User-Agent": ua})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read(limit)

    def get_index(year):
        return "".join(sec_get(INDEX_URL.format(year, q)).decode("latin-1")
                       for q in range(1, 5))

    def get_text(file_name):
        raw = sec_get(ARCHIVE_URL + file_name, MAX_BYTES)
        return plain_text(raw.decode("utf-8", errors="replace"))

    return sec_get, get_index, get_text


if __name__ == "__main__":
    contact = os.environ.get("MIRO_CONTACT", "")
    if not contact.strip():
        sys.exit("MIRO_CONTACT missing: export the SEC contact string")
    root = os.path.join(os.path.dirname(__file__), "..")
    sec_get, get_index, get_text = _live(contact)
    aliases, obs = alias_tables(json.loads(sec_get(TICKERS_URL)))
    rep = probe(YEARS, get_index, get_text, aliases, obs)
    print({k: v for k, v in rep.items() if k != "years"}, flush=True)
    out = os.path.join(root, "reports", "customer_coverage.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(rep, f, indent=1, sort_keys=True)
