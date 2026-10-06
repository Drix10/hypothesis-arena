"""Human-run build of research/data/filing_scores.json (plan/data.md EDGAR
corpus, plan/math.md Text change): 10-K and 10-Q filings of the reference.json
universe, Items 1A and 7 scored against the prior-year filing by
text_change.score. known_at is the SEC acceptance time. The SEC contact string
comes from MIRO_CONTACT only; filing bodies are cached under data/filings, so a
rerun fetches only what is missing."""
import argparse
import collections
import datetime
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.sources import edgar_filings, filing_sections
from research.strategy import text_change

SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK%010d.json"
FORMS = ("10-K", "10-Q")
DEFAULT_START = "2014-01-01"  # a year before the evaluation window, for priors
MIN_INTERVAL_S = 0.125  # one request at a time, at most 8 per second overall
SKIPS = ("no_prior", "parse_failure", "fetch_failure")
_HTML = re.compile(r"<(html|body|div|p|table)\b", re.IGNORECASE)


def _paced(transport, mono, sleep):
    """transport spaced MIN_INTERVAL_S apart, so submissions and filing
    requests share one limit."""
    next_ok = [0.0]

    def call(url, headers, timeout_s):
        wait = next_ok[0] - mono()
        if wait > 0:
            sleep(wait)
        next_ok[0] = mono() + MIN_INTERVAL_S
        return transport(url, headers, timeout_s)

    return call


def _submissions(fetcher, cik):
    status, _, body = fetcher.transport(
        SUBMISSIONS_URL % cik,
        {"User-Agent": fetcher.ua, "Accept": "application/json"},
        fetcher.timeout_s)
    if status != 200:
        raise edgar_filings.FilingError("HTTP %d for submissions" % status)
    try:
        return json.loads(body)
    except ValueError:
        raise edgar_filings.FilingError("submissions: not JSON") from None


def _stamp(s):
    """acceptanceDateTime as an ISO 8601 string with an offset, or None."""
    try:
        t = datetime.datetime.fromisoformat(
            s[:-1] + "+00:00" if s.endswith("Z") else s)
    except (AttributeError, ValueError):
        return None
    return t.isoformat() if t.tzinfo else None


def _period(s):
    try:
        return datetime.date.fromisoformat(s).isoformat()
    except (TypeError, ValueError):
        return None


def _body(fetcher, cache, filing):
    """Filing text from the cache, fetched first when absent. fetch refuses an
    unsafe name before any request."""
    doc, acc = filing["primary_document"], filing["accession"]
    path = os.path.join(cache, "%010d" % filing["cik"], acc, doc)
    if (doc != os.path.basename(doc) or not acc.replace("-", "").isdigit()
            or not os.path.exists(path)):
        fetcher.fetch(filing)
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read()


def score_filer(sub, fetcher, cache, start, skips):
    """Score rows of one filer, oldest first. A filing that cannot be fetched or
    parsed is counted in `skips` and enters no history."""
    periods = dict(zip(sub["filings"]["recent"]["accessionNumber"],
                       sub["filings"]["recent"].get("reportDate", ())))
    parsed = []
    for f in edgar_filings.list_filings(sub, FORMS, start=start):
        try:
            raw = _body(fetcher, cache, f)
        except (edgar_filings.FilingError, OSError):
            skips["fetch_failure"] += 1
            continue
        accepted, period = (_stamp(f["accepted_datetime"]),
                            _period(periods.get(f["accession"])))
        res = filing_sections.parse(raw, html=bool(_HTML.search(raw)))
        if res.reason or accepted is None or period is None:
            skips["parse_failure"] += 1
            continue
        parsed.append(text_change.Filing(str(f["cik"]), f["form"], period,
                                         accepted, res))
    rows = []
    for filing in parsed:
        row = text_change.score(filing, parsed)
        if row is None:
            skips["no_prior"] += 1
        else:
            rows.append(row)
    return sorted(rows, key=lambda r: r["known_at"])


def read_universe(data_dir):
    """{symbol: [cik]} from reference.json."""
    try:
        with open(os.path.join(data_dir, "reference.json"),
                  encoding="utf-8") as f:
            ciks = json.load(f)["data"]["ciks"]
        out = {}
        for cik, sym in ciks.items():
            out.setdefault(sym, []).append(int(cik))
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        raise edgar_filings.FilingError("reference.json: missing or "
                                        "malformed ciks") from None
    return out


def main(argv=None, env=None, now=None, log=print, transport=None, mono=None,
         sleep=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--data", default=os.path.join(
        os.path.dirname(__file__), "..", "data"))
    a = ap.parse_args(argv)
    env = os.environ if env is None else env
    now = now or datetime.datetime.now(datetime.timezone.utc)
    cache = os.path.join(a.data, "filings")
    skips = collections.Counter({k: 0 for k in SKIPS})
    failed, data = [], {}
    try:
        universe = read_universe(a.data)
        mono, sleep = mono or time.monotonic, sleep or time.sleep
        fetcher = edgar_filings.Fetcher(
            env.get("MIRO_CONTACT", ""), cache, mono=mono, sleep=sleep,
            clock=lambda: now.timestamp(),
            transport=_paced(transport or edgar_filings._default_transport,
                             mono, sleep))
    except edgar_filings.FilingError as e:
        log(str(e))
        return 2
    for sym in sorted(universe):
        rows = []
        try:
            for cik in universe[sym]:
                rows += score_filer(_submissions(fetcher, cik), fetcher, cache,
                                    a.start, skips)
        except (edgar_filings.FilingError, KeyError, TypeError):
            failed.append(sym)
            continue
        if rows:
            data[sym] = rows
        log("%s: %d scores" % (sym, len(rows)))
    out = os.path.join(a.data, "filing_scores.json")
    with open(out + ".tmp", "w", encoding="utf-8", newline="\n") as f:
        json.dump({"through": now.date().isoformat(), "data": data}, f,
                  sort_keys=True)
    os.replace(out + ".tmp", out)
    log(json.dumps({"symbols": len(universe), "scored_symbols": len(data),
                    "skips": dict(skips), "submissions_failed": failed},
                   sort_keys=True))
    return 1 if failed or skips["fetch_failure"] else 0


if __name__ == "__main__":
    sys.exit(main())
