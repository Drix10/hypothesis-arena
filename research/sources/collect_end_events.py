"""Human-run collector of research/data/end_events.json: the Form 25, Form 15 and
8-K (item 3.01, 2.01) filings that confirm a delisting (plan/math.md, Point-in-time
discipline), per symbol of reference.json, in the contract read by
strategy/delisting. SEC requests need MIRO_CONTACT and are paced by the adapter;
each cik is cached once fetched, so a rerun resumes. A failed fetch writes
nothing."""
import argparse
import datetime
import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
sys.path.insert(0, ROOT)

from sources import edgar, end_events, last_trade

DATA = os.path.join(ROOT, "data")
DOC_URL = "https://www.sec.gov/Archives/edgar/data/%d/%s/%s"
OLDER_URL = "https://data.sec.gov/submissions/%s"
ARCHIVE_NAME = re.compile(r"^CIK\d{10}-submissions-\d{3}\.json$")


def _get_json(adapter, url):
    _status, _headers, body, err = adapter._get(url)
    if err or body is None:
        raise OSError("%s: %s" % (url, err or "empty body"))
    return json.loads(body.decode("utf-8"))


def _primary_docs(block):
    forms = block.get("form") or []
    accs = block.get("accessionNumber") or []
    docs = block.get("primaryDocument") or []
    return {a: docs[i] for i, (f, a) in enumerate(zip(forms, accs))
            if f in last_trade.DELISTING_FORMS and i < len(docs)}


def _form25_text(adapter, cik, accession, doc):
    url = DOC_URL % (cik, accession.replace("-", ""), doc)
    _status, _headers, body, _err = adapter._get(url)
    return body.decode("utf-8", "replace") if body else None


def fetch_events(adapter, cik):
    """Serializable end events of one cik across its recent and archived
    submissions. A Form 25 whose document cannot be read stays unclassified, so
    last_trade ignores it."""
    sub = _get_json(adapter, edgar.SUBMISSIONS_URL % cik)
    blocks = [sub]
    for f in (sub.get("filings") or {}).get("files") or ():
        name = f.get("name") if isinstance(f, dict) else None
        if isinstance(name, str) and ARCHIVE_NAME.match(name):
            blocks.append(_get_json(adapter, OLDER_URL % name))
    events = []
    for block in blocks:
        docs = _primary_docs((block.get("filings") or {}).get("recent", block))
        texts = {a: _form25_text(adapter, cik, a, d) for a, d in docs.items()}
        events += end_events.build_events(block, texts)
    return [dict(e, date=e["date"].isoformat()) for e in events]


def _atomic_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def cached(cache_dir, cik, end):
    """Cached events for cik if fetched on or after `end`, else None."""
    path = os.path.join(cache_dir, "%010d.json" % cik)
    if not os.path.exists(path):
        return None
    with open(path, encoding="utf-8") as f:
        rec = json.load(f)
    return rec["events"] if rec.get("fetched", "") >= end else None


def collect(ciks, cache_dir, adapter, end, today, log):
    """({symbol: events}, {symbol: reason}) for `ciks` {cik: symbol}."""
    os.makedirs(cache_dir, exist_ok=True)
    found, failed = {}, {}
    for cik, sym in sorted(ciks.items(), key=lambda kv: kv[1]):
        events = cached(cache_dir, int(cik), end)
        if events is None:
            try:
                events = fetch_events(adapter, int(cik))
            except (OSError, ValueError) as e:
                failed[sym] = "fetch-failed: %s" % e
                continue
            _atomic_json(os.path.join(cache_dir, "%010d.json" % int(cik)),
                         {"fetched": today, "events": events})
            log("fetched %s" % sym)
        found[sym] = events
    return found, failed


def main(argv=None, env=None, log=print, today=None, **adapter_kw):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--end", help="ISO date the events must cover, default today")
    ap.add_argument("--cache", help="default <data>/end_events_cache")
    ap.add_argument("--yes", action="store_true",
                    help="start the SEC requests after the estimate")
    a = ap.parse_args(argv)
    contact = edgar.contact_from_env(env)
    if not contact:
        log("MIRO_CONTACT must be exported")
        return 2
    today = today or datetime.datetime.now(datetime.timezone.utc).date(
        ).isoformat()
    end = a.end or today
    try:
        with open(os.path.join(a.data, "reference.json"),
                  encoding="utf-8") as f:
            ciks = json.load(f)["data"]["ciks"]
    except (OSError, ValueError, KeyError) as e:
        log("reference.json unreadable: %s" % e)
        return 1
    cache = a.cache or os.path.join(a.data, "end_events_cache")
    todo = [c for c in ciks if cached(cache, int(c), end) is None]
    log("%d symbols, %d to fetch: about %d SEC requests or more" % (
        len(ciks), len(todo), len(todo)))
    if not a.yes:
        log("not fetching: pass --yes to start")
        return 2
    adapter = edgar.Adapter(contact, cache_dir=cache, **adapter_kw)
    found, failed = collect(ciks, cache, adapter, end, today, log)
    if failed:
        log(json.dumps(failed, sort_keys=True))
        log("not written: rerun to retry the failed fetches")
        return 1
    _atomic_json(os.path.join(a.data, "end_events.json"),
                 {"through": end, "data": found})
    log("wrote %d symbols through %s" % (len(found), end))
    return 0


if __name__ == "__main__":
    sys.exit(main(env=os.environ))
