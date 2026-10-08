"""EDGAR filing full-text fetcher (plan/data.md EDGAR corpus).

Lists a company's 10-K, 10-Q and 8-K filings from a submissions JSON passed in,
fetches primary documents through an injected transport, and writes each under
a caller-given directory with a row in an append-only JSONL manifest. Fails
closed: any error raises FilingError and nothing is written.
"""
import hashlib
import json
import os
import time
import urllib.error
import urllib.request

UA_BASE = "MiroHedge/phase0"
ARCHIVE_URL = "https://www.sec.gov/Archives/edgar/data/%d/%s/%s"
FORMS = ("10-K", "10-Q", "8-K")
MAX_REQ_PER_S = 10
DEFAULT_REQ_PER_S = 5
DEFAULT_TIMEOUT_S = 30
MAX_BODY_BYTES = 64 << 20
CONTENT_TYPES = ("text/html", "text/plain", "application/xhtml+xml",
                 "application/xml", "text/xml")
MANIFEST_NAME = "manifest.jsonl"
MANIFEST_KEYS = ("cik", "accession", "form", "filing_date",
                 "accepted_datetime", "primary_document", "source_url",
                 "retrieved_at", "sha256", "byte_length")


class FilingError(Exception):
    pass


def list_filings(submissions, forms=FORMS, start=None, end=None):
    """Filings from submissions['filings']['recent'], sorted by filing date
    then accession. start and end are inclusive YYYY-MM-DD bounds."""
    try:
        cik = int(submissions["cik"])
        recent = submissions["filings"]["recent"]
        cols = [recent[k] for k in ("accessionNumber", "form", "filingDate",
                                    "acceptanceDateTime", "primaryDocument")]
    except (KeyError, TypeError, ValueError):
        raise FilingError("submissions: missing cik or filings.recent")
    if len({len(c) for c in cols}) != 1:
        raise FilingError("submissions: ragged filings.recent columns")
    out = []
    for acc, form, fdate, accepted, doc in zip(*cols):
        if form not in forms or not doc:
            continue
        if (start and fdate < start) or (end and fdate > end):
            continue
        out.append({"cik": cik, "accession": acc, "form": form,
                    "filing_date": fdate, "accepted_datetime": accepted,
                    "primary_document": doc})
    return sorted(out, key=lambda f: (f["filing_date"], f["accession"]))


def _read_capped(r):
    body = r.read(MAX_BODY_BYTES + 1)
    if len(body) > MAX_BODY_BYTES:
        raise FilingError("oversized body")
    return body


def _default_transport(url, headers, timeout_s):
    """Stdlib urllib; non-2xx is normalized to (status, headers, body)."""
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as r:
            return r.status, {k.lower(): v for k, v in r.getheaders()}, \
                _read_capped(r)
    except urllib.error.HTTPError as e:
        return e.code, {}, b""


class Fetcher:
    """transport(url, headers, timeout_s) -> (status, lowercase headers, body).
    mono and sleep pace requests; clock stamps retrieved_at (epoch seconds)."""

    def __init__(self, contact, out_dir, transport=None, mono=None,
                 sleep=None, clock=None, req_per_s=DEFAULT_REQ_PER_S,
                 timeout_s=DEFAULT_TIMEOUT_S):
        if not contact or not contact.strip():
            raise FilingError("MIRO_CONTACT missing: refusing to fetch "
                              "without SEC fair-access contact")
        if not 0 < req_per_s <= MAX_REQ_PER_S:
            raise FilingError("req_per_s must be in (0, %d]" % MAX_REQ_PER_S)
        self.ua = "%s contact=%s" % (UA_BASE, contact.strip())
        self.out_dir = out_dir
        self.transport = transport or _default_transport
        self.mono = mono or time.monotonic
        self.sleep = sleep or time.sleep
        self.clock = clock or time.time
        self.interval = 1.0 / req_per_s
        self.timeout_s = timeout_s
        self._next_ok = 0.0

    def _pace(self):
        wait = self._next_ok - self.mono()
        if wait > 0:
            self.sleep(wait)
        self._next_ok = self.mono() + self.interval

    def _get(self, url):
        self._pace()
        try:
            status, headers, body = self.transport(
                url, {"User-Agent": self.ua, "Accept": "*/*"},
                self.timeout_s)
        except Exception as e:
            raise FilingError("transport failed: %s: %s"
                              % (type(e).__name__, str(e)[:200]))
        if status != 200:
            raise FilingError("HTTP %d for %s" % (status, url))
        ctype = headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype not in CONTENT_TYPES:
            raise FilingError("unexpected content type %r" % ctype)
        if ("content-length" not in headers
                and headers.get("transfer-encoding", "").lower() == "chunked"):
            return body  # urllib raises IncompleteRead on a cut chunked body
        try:
            declared = int(headers["content-length"])
        except (KeyError, ValueError):
            raise FilingError("missing or bad content-length")
        if declared != len(body):
            raise FilingError("truncated body: %d of %d bytes"
                              % (len(body), declared))
        return body

    def fetch(self, filing):
        """Fetch one list_filings() entry; returns its manifest row. Re-fetching
        identical content writes nothing; differing content raises."""
        doc = filing["primary_document"]
        acc = filing["accession"]
        if (not doc or doc != os.path.basename(doc) or doc in (".", "..")
                or "\\" in doc):
            raise FilingError("unsafe primary document name %r" % doc)
        if not acc.replace("-", "").isdigit():
            raise FilingError("bad accession %r" % acc)
        url = ARCHIVE_URL % (filing["cik"], acc.replace("-", ""), doc)
        body = self._get(url)
        digest = hashlib.sha256(body).hexdigest()
        folder = os.path.join(self.out_dir, "%010d" % filing["cik"], acc)
        path = os.path.join(folder, doc)
        row = {"cik": filing["cik"], "accession": acc,
               "form": filing["form"], "filing_date": filing["filing_date"],
               "accepted_datetime": filing["accepted_datetime"],
               "primary_document": doc, "source_url": url,
               "retrieved_at": self.clock(), "sha256": digest,
               "byte_length": len(body)}
        if os.path.exists(path):
            with open(path, "rb") as f:
                if hashlib.sha256(f.read()).hexdigest() != digest:
                    raise FilingError("refusing to overwrite %s: sha256 "
                                      "differs" % path)
            return row
        os.makedirs(folder, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, path)
        with open(os.path.join(self.out_dir, MANIFEST_NAME), "a",
                  encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(row, sort_keys=True) + "\n")
        return row
