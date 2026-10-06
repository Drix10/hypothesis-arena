"""Builds research/data/link_store.jsonl from real data (plan/math.md link
matrix, plan/data.md). Edge sources: customer and supplier edges (a) from the
10-K corpus on disk, text peers (b) from 10-K Item 1 text, common ownership (c)
from 13F information tables. Each source keeps its own weights; composite
equal-weights the sources present. A human runs it: it touches the network for
13F filings and company_tickers.json, paced, with the SEC contact string from
MIRO_CONTACT."""
import argparse
import datetime
import hashlib
import json
import os
import random
import re
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import customer_edges, link_store, ownership_edges
from research.engine import text_peers
from research.sources import edgar_filings, filing_sections, form13f
from research.strategy import customer_coverage_probe as ccp
from research.strategy import real_filing_probe as rfp

ROOT = os.path.join(os.path.dirname(__file__), "..")
DATA = os.path.join(ROOT, "data")
REPORT = os.path.join(ROOT, "reports", "customer_coverage.json")
PER_QUARTER = 300
REQ_PER_S = 5
TIMEOUT_S = 60
_HTML = re.compile(r"<(html|body|div|p|table)\b", re.IGNORECASE)
_PERIOD = re.compile(r"<(?:\w+:)?periodOfReport>\s*([0-9-]{10})\s*<")


class BuildError(Exception):
    pass


def _day(iso):
    return int(iso.replace("-", ""))


def _cik(value):
    return "%010d" % int(value)


def read_corpus(filings_dir):
    """10-K filings from the edgar_filings manifest: [{cik, accession, text,
    item1_text, filed}], filed a YYYYMMDD integer. item1_text is None when the
    section parser finds no complete item set. A body whose sha256 differs from
    the manifest is an error."""
    path = os.path.join(filings_dir, edgar_filings.MANIFEST_NAME)
    try:
        with open(path, encoding="utf-8") as f:
            manifest = [json.loads(line) for line in f if line.strip()]
    except (OSError, ValueError):
        raise BuildError("corpus-manifest-unreadable") from None
    out, seen = [], set()
    for row in sorted(manifest, key=lambda r: (r["filing_date"],
                                               r["accession"])):
        if row["form"] != "10-K" or row["accession"] in seen:
            continue
        seen.add(row["accession"])
        body = os.path.join(filings_dir, _cik(row["cik"]), row["accession"],
                            row["primary_document"])
        with open(body, "rb") as f:
            data = f.read()
        if hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise BuildError("corpus-hash-mismatch:" + row["accession"])
        raw = data.decode("utf-8", errors="replace")
        res = filing_sections.parse(raw, html=bool(_HTML.search(raw)))
        out.append({"cik": int(row["cik"]), "accession": row["accession"],
                    "text": ccp.plain_text(raw),
                    "item1_text": res.section_text("1") if res.sections
                    else None,
                    "filed": _day(row["filing_date"])})
    if not out:
        raise BuildError("corpus-empty")
    return out


def customer_collapsed(report_path):
    """The coverage report's `collapsed` flag; anything but a boolean is an
    error, so an incomplete probe never decides silently."""
    try:
        with open(report_path, encoding="utf-8") as f:
            flag = json.load(f)["collapsed"]
    except (OSError, ValueError, KeyError, TypeError):
        raise BuildError("customer-coverage-unreadable") from None
    if not isinstance(flag, bool):
        raise BuildError("customer-coverage-undetermined")
    return flag


def diff(open_edges, edges, at):
    """Rows that turn `open_edges` ({edge_id: row}, updated in place) into the
    snapshot `edges` made known at day `at`: new edges are added, a changed
    weight is superseded and an edge missing from the snapshot is ended."""
    out, seen = [], set()
    for e in edges:
        seen.add(e["edge_id"])
        old = open_edges.get(e["edge_id"])
        if old is None:
            row = e
        elif old["weight"] != e["weight"]:
            row = dict(old, weight=e["weight"], known_at=at,
                       evidence_ids=e["evidence_ids"])
        else:
            continue
        open_edges[e["edge_id"]] = row
        out.append(row)
    for edge_id in sorted(set(open_edges) - seen):
        out.append(dict(open_edges.pop(edge_id), valid_to=at, known_at=at))
    return out


def text_peer_rows(corpus):
    """Text-peer rows, one cohort per filing year (each firm's latest 10-K with
    a parsed Item 1). A cohort is known and valid from its last filing date,
    when its tf-idf weights exist, and the previous cohort's edges end then."""
    cohorts = {}
    for f in corpus:
        if f["item1_text"]:
            cohorts.setdefault(f["filed"] // 10000, {})[f["cik"]] = f
    out, open_edges = [], {}
    for year in sorted(cohorts):
        firms = [{"cik": _cik(f["cik"]), "accession": f["accession"],
                  "item1_text": f["item1_text"], "filed": f["filed"]}
                 for f in cohorts[year].values()]
        at = max(f["filed"] for f in firms)
        out += diff(open_edges, text_peers.text_peer_edges(firms, at, at), at)
    return out


def issuer_map(rows, aliases, observations):
    """{cusip: cik} for cusips whose issuer names resolve to exactly one firm;
    a name that resolves to nothing is ignored, a conflict drops the cusip."""
    found = {}
    for r in rows:
        as_of = datetime.date.fromisoformat(r["filing_date"])
        cik = customer_edges.resolve_name(r["issuer"], aliases, observations,
                                          as_of)
        if cik is not None:
            found.setdefault(r["cusip"], set()).add(cik)
    return {c: next(iter(s)) for c, s in found.items() if len(s) == 1}


def ownership_rows(rows, issuers):
    """Common-ownership rows, one snapshot per calendar quarter of filing taken
    at that quarter's last filing date, so snapshots run in known-time order
    whatever period a late filer reports. A new edge is known at its snapshot:
    whether it clears the threshold depends on every filing made by then."""
    at_by_quarter = {}
    for r in rows:
        d = r["filing_date"]
        q = (d[:4], (int(d[5:7]) - 1) // 3)
        at_by_quarter[q] = max(at_by_quarter.get(q, ""), d)
    out, open_edges = [], {}
    for as_of in sorted(at_by_quarter.values()):
        at = _day(as_of)
        snap = [dict(e, known_at=at) for e in
                ownership_edges.ownership_edges(rows, issuers, as_of)]
        out += diff(open_edges, snap, at)
    return out


class Sec:
    """Paced SEC GETs with the fair-access contact in the User-Agent.
    transport(url, headers, timeout_s) -> (status, headers, body)."""

    def __init__(self, contact, transport=None, mono=time.monotonic,
                 sleep=time.sleep):
        if not contact or not contact.strip():
            raise BuildError("MIRO_CONTACT missing")
        self.ua = "%s contact=%s" % (edgar_filings.UA_BASE, contact.strip())
        self.transport = transport or edgar_filings._default_transport
        self.mono, self.sleep = mono, sleep
        self._next_ok = 0.0

    def get(self, url):
        wait = self._next_ok - self.mono()
        if wait > 0:
            self.sleep(wait)
        self._next_ok = self.mono() + 1.0 / REQ_PER_S
        try:
            status, _, body = self.transport(
                url, {"User-Agent": self.ua, "Accept": "*/*"}, TIMEOUT_S)
        except OSError as e:
            raise edgar_filings.FilingError("transport failed: %s" % e)
        if status != 200:
            raise edgar_filings.FilingError("HTTP %d for %s" % (status, url))
        return body


def _period(primary_doc):
    m = _PERIOD.search(primary_doc.decode("utf-8", errors="replace"))
    if not m:
        raise form13f.Form13fError("no periodOfReport")
    p = m.group(1)
    return p if p[4] == "-" else "%s-%s-%s" % (p[6:], p[:2], p[3:5])


def filing_rows(sec, filing, cache_dir):
    """(rows, status) for one 13F-HR index entry, status one of cached,
    fetched, skipped, failed. A filing with no information table or an
    unparseable one is cached as skipped; a failed fetch is retried next run."""
    cache = os.path.join(cache_dir, filing["accession"] + ".json")
    if os.path.exists(cache):
        with open(cache, encoding="utf-8") as f:
            return json.load(f)["rows"], "cached"
    folder = filing["accession"].replace("-", "")
    rows, why = [], "no information table"
    try:
        items = json.loads(sec.get(rfp.FOLDER_URL % (filing["cik"], folder))
                           )["directory"]["item"]
        name = rfp.table_name(items)
        if name:
            period = _period(sec.get(rfp.TABLE_URL % (
                filing["cik"], folder, "primary_doc.xml")))
            rows = form13f.parse_information_table(
                sec.get(rfp.TABLE_URL % (filing["cik"], folder, name)),
                filing["cik"], period, filing["date"])
    except edgar_filings.FilingError:
        return [], "failed"
    except (KeyError, TypeError, ValueError) as e:
        why = str(e)[:120]
    os.makedirs(cache_dir, exist_ok=True)
    tmp = cache + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"rows": rows, "reason": why if not rows else ""}, f)
    os.replace(tmp, cache)
    return rows, "fetched" if rows else "skipped"


def fetch_13f(sec, first_year, last_year, cache_dir, per_quarter=PER_QUARTER):
    """(rows, status counts) over every quarter's 13F-HR filings, a seeded
    sample of `per_quarter` filers per quarter so a rerun asks for the same
    filings and the cache answers.
    lean: a sample, not every filer, to bound the request count; raise
    per_quarter once the paced run time is acceptable."""
    rows, counts = [], {}
    for year in range(first_year, last_year + 1):
        for qtr in range(1, 5):
            index = sec.get(ccp.INDEX_URL.format(year, qtr)).decode("latin-1")
            pool = sorted(rfp.parse_index_13f(index),
                          key=lambda f: f["accession"])
            random.Random(year * 10 + qtr).shuffle(pool)
            for filing in pool[:per_quarter]:
                got, status = filing_rows(sec, filing, cache_dir)
                rows += got
                counts[status] = counts.get(status, 0) + 1
    return rows, counts


def write_store(path, edges):
    """Hash-chained store file, replaced atomically and re-verified. Rows are
    chained here because LinkStore.add re-verifies the whole chain per row."""
    prev, lines = link_store.GENESIS, []
    for seq, e in enumerate(edges):
        link_store._validate(e)
        row = dict(e, seq=seq, prev=prev)
        row["digest"] = prev = link_store._digest(row)
        lines.append(link_store._canon(row).decode("ascii") + "\n")
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="ascii", newline="\n") as f:
        f.writelines(lines)
    os.replace(tmp, path)
    return link_store.LinkStore(path).verify()


def build(data_dir, sec, first_year, last_year, report_path=REPORT,
          per_quarter=PER_QUARTER):
    """Write link_store.jsonl; returns {used, skipped, rows}."""
    collapsed = customer_collapsed(report_path)
    corpus = read_corpus(os.path.join(data_dir, "filings"))
    aliases, observations = ccp.alias_tables(
        json.loads(sec.get(ccp.TICKERS_URL)))
    holdings, counts = fetch_13f(sec, first_year, last_year,
                                 os.path.join(data_dir, "form13f"),
                                 per_quarter)
    if not holdings:
        raise BuildError("form13f-empty:%s" % counts)
    edges, used, skipped = [], [], []
    if collapsed:
        skipped.append("supply_chain (coverage collapsed)")
    else:
        edges += customer_edges.edges(
            [{"cik": f["cik"], "accession": f["accession"], "text": f["text"],
              "filed": f["filed"]} for f in corpus], aliases, observations)
        used.append("supply_chain")
    edges += text_peer_rows(corpus)
    used.append("text_peer")
    edges += ownership_rows(holdings, issuer_map(holdings, aliases,
                                                 observations))
    used.append("ownership")
    n = write_store(os.path.join(data_dir, "link_store.jsonl"), edges)
    return {"used": used, "skipped": skipped, "rows": n, "form13f": counts}


def main(argv=None, transport=None, sleep=time.sleep):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--data", default=DATA)
    ap.add_argument("--report", default=REPORT)
    ap.add_argument("--first-year", type=int, required=True)
    ap.add_argument("--last-year", type=int, required=True)
    ap.add_argument("--per-quarter", type=int, default=PER_QUARTER)
    args = ap.parse_args(argv)
    try:
        sec = Sec(os.environ.get("MIRO_CONTACT", ""), transport, sleep=sleep)
        rep = build(args.data, sec, args.first_year, args.last_year,
                    args.report, args.per_quarter)
    except (BuildError, edgar_filings.FilingError, link_store.LinkStoreError,
            form13f.Form13fError, OSError, ValueError, KeyError) as e:
        print("refused: %s" % e, file=sys.stderr)
        return 1
    print("sources used: %s" % ", ".join(rep["used"]))
    for s in rep["skipped"]:
        print("source skipped: %s" % s)
    print("13F filings: %s; link store rows: %d" % (rep["form13f"], rep["rows"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
