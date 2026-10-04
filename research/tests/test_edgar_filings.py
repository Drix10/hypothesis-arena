"""EDGAR filing fetcher tests; fixtures and a fake transport, no network."""
import hashlib
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)

from sources import edgar_filings
from sources.edgar_filings import FilingError, Fetcher, list_filings

SUBMISSIONS = {"cik": "320193", "filings": {"recent": {
    "accessionNumber": ["0000320193-24-000010", "0000320193-24-000005",
                        "0000320193-23-000106", "0000320193-24-000001",
                        "0000320193-24-000002"],
    "form": ["10-Q", "8-K", "10-K", "4", "10-K"],
    "filingDate": ["2024-05-03", "2024-02-01", "2023-11-03", "2024-01-05",
                   "2024-02-02"],
    "acceptanceDateTime": ["2024-05-03T16:30:00.000Z",
                           "2024-02-01T21:05:11.000Z",
                           "2023-11-03T18:08:27.000Z",
                           "2024-01-05T22:00:00.000Z",
                           "2024-02-02T10:00:00.000Z"],
    "primaryDocument": ["q.htm", "e.htm", "k.htm", "x.xml", ""],
}}}

BODY = b"<html>annual report</html>"


class Clock:
    def __init__(self):
        self.t = 100.0
        self.sleeps = []

    def mono(self):
        return self.t

    def sleep(self, s):
        self.sleeps.append(s)
        self.t += s


class Transport:
    def __init__(self, status=200, ctype="text/html; charset=utf-8",
                 body=BODY, length=None):
        self.status, self.body = status, body
        self.headers = {"content-type": ctype,
                        "content-length": str(len(body) if length is None
                                              else length)}
        self.calls = []

    def __call__(self, url, headers, timeout_s):
        self.calls.append((url, headers))
        return self.status, self.headers, self.body


class Base(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.clock = Clock()

    def fetcher(self, transport, **kw):
        return Fetcher("ops@example.com", self.dir, transport=transport,
                       mono=self.clock.mono, sleep=self.clock.sleep,
                       clock=lambda: 1700000000.0, **kw)

    def k10(self):
        return list_filings(SUBMISSIONS, forms=("10-K",))[0]

    def manifest(self):
        path = os.path.join(self.dir, edgar_filings.MANIFEST_NAME)
        if not os.path.exists(path):
            return []
        with open(path, encoding="utf-8") as f:
            return [json.loads(line) for line in f]


class ListTest(unittest.TestCase):
    def test_default_forms_sorted_and_skips_blank_document(self):
        got = list_filings(SUBMISSIONS)
        self.assertEqual([f["accession"] for f in got],
                         ["0000320193-23-000106", "0000320193-24-000005",
                          "0000320193-24-000010"])
        self.assertEqual(got[0]["cik"], 320193)

    def test_form_and_date_filters(self):
        got = list_filings(SUBMISSIONS, forms=("8-K", "10-Q"),
                           start="2024-02-01", end="2024-04-30")
        self.assertEqual([f["form"] for f in got], ["8-K"])

    def test_ragged_columns_refused(self):
        bad = {"cik": 1, "filings": {"recent": {
            **SUBMISSIONS["filings"]["recent"], "form": ["10-K"]}}}
        with self.assertRaises(FilingError):
            list_filings(bad)


class FetchTest(Base):
    def doc_path(self):
        return os.path.join(self.dir, "0000320193", "0000320193-23-000106",
                            "k.htm")

    def test_success_writes_document_and_manifest_row(self):
        t = Transport()
        row = self.fetcher(t).fetch(self.k10())
        with open(self.doc_path(), "rb") as f:
            self.assertEqual(f.read(), BODY)
        self.assertEqual(self.manifest(), [row])
        self.assertEqual(set(row), set(edgar_filings.MANIFEST_KEYS))
        self.assertEqual(row["sha256"], hashlib.sha256(BODY).hexdigest())
        self.assertEqual(row["byte_length"], len(BODY))
        self.assertEqual(row["source_url"], "https://www.sec.gov/Archives/"
                         "edgar/data/320193/000032019323000106/k.htm")
        self.assertIn("contact=ops@example.com", t.calls[0][1]["User-Agent"])

    def test_refetch_identical_adds_no_row(self):
        f = self.fetcher(Transport())
        f.fetch(self.k10())
        f.fetch(self.k10())
        self.assertEqual(len(self.manifest()), 1)

    def test_hash_mismatch_refuses_overwrite(self):
        self.fetcher(Transport()).fetch(self.k10())
        with self.assertRaisesRegex(FilingError, "sha256 differs"):
            self.fetcher(Transport(body=b"changed")).fetch(self.k10())
        self.assertEqual(len(self.manifest()), 1)
        with open(self.doc_path(), "rb") as f:
            self.assertEqual(f.read(), BODY)

    def test_truncated_body_refused_and_nothing_written(self):
        with self.assertRaisesRegex(FilingError, "truncated"):
            self.fetcher(Transport(length=len(BODY) + 5)).fetch(self.k10())
        self.assertEqual(os.listdir(self.dir), [])

    def test_non_200_refused(self):
        with self.assertRaisesRegex(FilingError, "HTTP 403"):
            self.fetcher(Transport(status=403)).fetch(self.k10())
        self.assertEqual(os.listdir(self.dir), [])

    def test_unexpected_content_type_refused(self):
        with self.assertRaisesRegex(FilingError, "content type"):
            self.fetcher(Transport(ctype="application/pdf")).fetch(self.k10())

    def test_unsafe_document_name_refused(self):
        bad = {**self.k10(), "primary_document": "../x.htm"}
        with self.assertRaises(FilingError):
            self.fetcher(Transport()).fetch(bad)

    def test_missing_contact_and_excess_rate_refused(self):
        with self.assertRaises(FilingError):
            Fetcher("  ", self.dir)
        with self.assertRaises(FilingError):
            Fetcher("a@b.c", self.dir, req_per_s=11)


class RateLimitTest(Base):
    def test_waits_between_requests_on_fake_clock(self):
        f = self.fetcher(Transport(), req_per_s=5)
        for filing in list_filings(SUBMISSIONS):
            f.fetch(filing)
        self.assertEqual(len(self.clock.sleeps), 2)
        for s in self.clock.sleeps:
            self.assertAlmostEqual(s, 0.2)

    def test_no_wait_once_interval_has_elapsed(self):
        f = self.fetcher(Transport())
        filings = list_filings(SUBMISSIONS)
        f.fetch(filings[0])
        self.clock.t += 1.0
        f.fetch(filings[1])
        self.assertEqual(self.clock.sleeps, [])


if __name__ == "__main__":
    unittest.main()
