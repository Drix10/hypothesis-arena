"""build_link_store on fixtures with injected transports: the three edge sources,
the collapsed-coverage skip, bitemporal snapshots, the 13F cache and pacing,
and that run_connected_drift loads the written store."""
import contextlib
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store
from research.strategy import build_link_store as B
from research.strategy import customer_coverage_probe as ccp
from research.strategy import real_filing_probe as rfp
from research.strategy import run_connected_drift as R

TICKERS = {str(i): {"cik_str": i, "ticker": t, "title": n}
           for i, (t, n) in enumerate((("ALPH", "Alpha Inc"),
                                       ("BETA", "Beta Corp"),
                                       ("GAMM", "Gamma Holdings")), 1)}
CHIPS = "semiconductor wafer fabrication foundry chips lithography " * 6
FOOD = "grocery dairy produce bakery frozen foods retail stores " * 6


def tenk(item1, extra=""):
    return ("Item 1. Business\n%s\n%s\nItem 1A. Risk Factors\nrisks here\n"
            "Item 2. Properties\nleased offices\nItem 7. MD&A\nresults\n"
            "Item 7A. Market Risk\nrates\nItem 8. Financials\nstatements\n"
            % (item1, extra))


def write_corpus(data_dir, filings):
    """filings: (cik, accession, filing_date, text)."""
    root = os.path.join(data_dir, "filings")
    os.makedirs(root)
    with open(os.path.join(root, "manifest.jsonl"), "w") as m:
        for cik, acc, date, text in filings:
            folder = os.path.join(root, "%010d" % cik, acc)
            os.makedirs(folder)
            body = text.encode()
            with open(os.path.join(folder, "10k.txt"), "wb") as f:
                f.write(body)
            m.write(json.dumps({
                "cik": cik, "accession": acc, "form": "10-K",
                "filing_date": date, "primary_document": "10k.txt",
                "sha256": hashlib.sha256(body).hexdigest()}) + "\n")


CORPUS = [
    (1, "0000000001-23-000001", "2023-02-10",
     tenk(CHIPS, "We sold chips to Beta Corp in 2022.")),
    (2, "0000000002-23-000001", "2023-02-20", tenk(CHIPS)),
    (3, "0000000003-23-000001", "2023-03-01", tenk(FOOD)),
    (1, "0000000001-24-000001", "2024-02-12", tenk(CHIPS)),
    (2, "0000000002-24-000001", "2024-02-22", tenk(CHIPS)),
    (3, "0000000003-24-000001", "2024-03-02", tenk(FOOD)),
]


def info_table(holdings):
    rows = "".join(
        "<infoTable><nameOfIssuer>%s</nameOfIssuer><cusip>%s</cusip>"
        "<value>%d</value><shrsOrPrnAmt><sshPrnamt>10</sshPrnamt>"
        "<sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>"
        "<investmentDiscretion>SOLE</investmentDiscretion></infoTable>"
        % h for h in holdings)
    return ("<informationTable xmlns='x'>%s</informationTable>" % rows).encode()


def f13(cik, accession, date, period, holdings):
    folder = accession.replace("-", "")
    return {
        "idx": "13F-HR   Fund %d LP   %d   %s   edgar/data/%d/%s.txt"
               % (cik, cik, date, cik, accession),
        rfp.FOLDER_URL % (cik, folder): json.dumps({"directory": {"item": [
            {"name": "primary_doc.xml"}, {"name": "infotable.xml"}]}}).encode(),
        rfp.TABLE_URL % (cik, folder, "primary_doc.xml"):
            ("<edgarSubmission><periodOfReport>%s</periodOfReport>"
             "</edgarSubmission>" % period).encode(),
        rfp.TABLE_URL % (cik, folder, "infotable.xml"): info_table(holdings),
    }


HOLD = [("ALPHA INC", "111111111", 500), ("BETA CORP", "222222222", 500)]
FILINGS_13F = {
    (2024, 1): [f13(11, "0000000011-24-000001", "2024-02-14", "12-31-2023",
                    HOLD),
                f13(12, "0000000012-24-000001", "2024-02-15", "12-31-2023",
                    HOLD)],
    (2024, 2): [f13(11, "0000000011-24-000002", "2024-05-14", "03-31-2024",
                    HOLD[:1] + [("GAMMA HOLDINGS", "333333333", 500)])],
}


class Net:
    """Transport over the fixtures; counts calls and rejects unknown URLs."""

    def __init__(self):
        self.calls = []
        self.pages = {ccp.TICKERS_URL: json.dumps(TICKERS).encode()}
        for qtr in range(1, 5):
            found = FILINGS_13F.get((2024, qtr), [])
            self.pages[ccp.INDEX_URL.format(2024, qtr)] = "\n".join(
                f["idx"] for f in found).encode()
            for f in found:
                self.pages.update({k: v for k, v in f.items() if k != "idx"})

    def __call__(self, url, headers, timeout):
        self.calls.append((url, headers["User-Agent"]))
        if url not in self.pages:
            return 404, {}, b""
        return 200, {}, self.pages[url]


def write_report(path, collapsed):
    with open(path, "w") as f:
        json.dump({"collapsed": collapsed}, f)


class BuildLinkStoreTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = os.path.join(self.tmp.name, "data")
        os.makedirs(self.data)
        write_corpus(self.data, CORPUS)
        self.report = os.path.join(self.tmp.name, "coverage.json")
        write_report(self.report, False)
        self.net = Net()
        self.sec = B.Sec("ops@example.org", self.net, sleep=lambda s: None)
        self.addCleanup(self.tmp.cleanup)

    def build(self):
        return B.build(self.data, self.sec, 2024, 2024, self.report)

    def store(self):
        return link_store.LinkStore(
            os.path.join(self.data, "link_store.jsonl"))

    def test_all_three_sources_and_no_edge_before_public(self):
        rep = self.build()
        self.assertEqual(rep["used"], ["supply_chain", "text_peer",
                                       "ownership"])
        rows = self.store().rows()
        self.assertEqual(rep["rows"], len(rows))
        self.assertEqual({r["source"] for r in rows},
                         {"supply_chain", "text_peer", "ownership"})
        cust = [r for r in rows if r["source"] == "supply_chain"]
        self.assertEqual([(r["src_cik"], r["dst_cik"], r["type"])
                          for r in cust],
                         [("0000000001", "0000000002", "customer")])
        self.assertEqual(cust[0]["known_at"], 20230210)
        self.assertEqual(cust[0]["valid_to"], 20240810)
        edges = self.store()
        self.assertEqual(edges.edges(20230209, 20230209), [])
        self.assertEqual(
            [e["source"] for e in edges.edges(20230211, 20230211)],
            ["supply_chain"])

    def test_text_peer_cohorts_end_when_the_next_one_is_known(self):
        self.build()
        peers = [r for r in self.store().rows() if r["source"] == "text_peer"]
        # 2023 cohort known at its last filing, 20230301; 2024 at 20240302
        first = [e for e in self.store().edges(20230301, 20230301)
                 if e["source"] == "text_peer"]
        self.assertEqual({(e["src_cik"], e["dst_cik"]) for e in first},
                         {("0000000001", "0000000002"),
                          ("0000000002", "0000000001")})
        self.assertTrue(all(r["known_at"] >= 20230301 for r in peers))
        later = [e for e in self.store().edges(20240302, 20240302)
                 if e["source"] == "text_peer"]
        self.assertEqual(len(later), 2)
        self.assertTrue(all(e["valid_from"] == 20240302 for e in later))
        self.assertTrue(all("-24-" in e["edge_id"] for e in
                            self.store().edges(20240601, 20240601)
                            if e["source"] == "text_peer"))

    def test_ownership_snapshots_supersede_by_known_time(self):
        self.build()
        own = lambda a, k: [e for e in self.store().edges(a, k)
                            if e["source"] == "ownership"]
        # Q4 2023 filings: two funds hold alpha and beta, known 20240215
        first = own(20240216, 20240216)
        self.assertEqual([(e["src_cik"], e["dst_cik"]) for e in first],
                         [("0000000001", "0000000002")])
        self.assertAlmostEqual(first[0]["weight"], 1.0)
        self.assertEqual(own(20240214, 20240214), [])
        # Q1 2024: fund 11 now holds alpha and gamma, so alpha-beta is held by
        # fund 12 alone and its weight is superseded when that is known
        later = own(20240520, 20240520)
        self.assertEqual([(e["dst_cik"], e["weight"]) for e in later],
                         [("0000000002", 0.5), ("0000000003", 0.5)])
        self.assertEqual(own(20240516, 20240216)[0]["weight"], 1.0)

    def test_collapsed_coverage_skips_source_a(self):
        write_report(self.report, True)
        rep = self.build()
        self.assertEqual(rep["used"], ["text_peer", "ownership"])
        self.assertEqual(len(rep["skipped"]), 1)
        self.assertNotIn("supply_chain",
                         {r["source"] for r in self.store().rows()})

    def test_undetermined_or_missing_coverage_is_an_error(self):
        write_report(self.report, None)
        with self.assertRaises(B.BuildError):
            self.build()
        os.remove(self.report)
        with self.assertRaises(B.BuildError):
            self.build()
        self.assertFalse(os.path.exists(
            os.path.join(self.data, "link_store.jsonl")))

    def test_corpus_hash_mismatch_is_an_error(self):
        path = os.path.join(self.data, "filings", "0000000001",
                            "0000000001-23-000001", "10k.txt")
        with open(path, "a") as f:
            f.write("tampered")
        with self.assertRaises(B.BuildError):
            self.build()

    def test_rerun_is_idempotent_and_uses_the_13f_cache(self):
        self.build()
        with open(os.path.join(self.data, "link_store.jsonl"), "rb") as f:
            first = f.read()
        fetched = [u for u, _ in self.net.calls if "infotable" in u]
        self.assertEqual(len(fetched), 3)
        self.net.calls.clear()
        self.build()
        with open(os.path.join(self.data, "link_store.jsonl"), "rb") as f:
            self.assertEqual(f.read(), first)
        self.assertEqual([u for u, _ in self.net.calls if "infotable" in u],
                         [])

    def test_requests_are_paced_and_carry_the_contact(self):
        now, sleeps = [0.0], []
        sec = B.Sec("ops@example.org", self.net, mono=lambda: now[0],
                    sleep=lambda s: (sleeps.append(s), now.__setitem__(
                        0, now[0] + s)))
        for _ in range(3):
            sec.get(ccp.TICKERS_URL)
        self.assertEqual(len(sleeps), 2)
        self.assertAlmostEqual(sleeps[0], 1.0 / B.REQ_PER_S)
        self.assertTrue(all("contact=ops@example.org" in ua
                            for _, ua in self.net.calls))
        with self.assertRaises(B.BuildError):
            B.Sec(" ")

    def test_failed_13f_fetch_is_retried_not_cached(self):
        filing = {"cik": 11, "accession": "0000000011-24-000001",
                  "date": "2024-02-14"}
        sec = B.Sec("c", lambda u, h, t: (500, {}, b""), sleep=lambda s: None)
        cache = os.path.join(self.tmp.name, "cache")
        self.assertEqual(B.filing_rows(sec, filing, cache), ([], "failed"))
        self.assertFalse(os.path.exists(cache))

    def test_runner_loads_the_store(self):
        self.build()
        store = R._store(self.data)
        self.assertIsInstance(store, link_store.LinkStore)
        edges = store.edges(20240601, 20240601)
        self.assertEqual({e["source"] for e in edges},
                         {"supply_chain", "text_peer", "ownership"})
        self.assertEqual(store.verify(), len(store.rows()))

    def test_main_prints_sources_and_refuses_without_contact(self):
        os.environ["MIRO_CONTACT"] = "ops@example.org"
        self.addCleanup(os.environ.pop, "MIRO_CONTACT", None)
        argv = ["--data", self.data, "--report", self.report,
                "--first-year", "2024", "--last-year", "2024"]
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(B.main(argv, self.net, lambda s: None), 0)
        self.assertIn("sources used: supply_chain, text_peer, ownership",
                      out.getvalue())
        del os.environ["MIRO_CONTACT"]
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            self.assertEqual(B.main(argv, self.net, lambda s: None), 1)
        self.assertIn("MIRO_CONTACT", err.getvalue())


if __name__ == "__main__":
    unittest.main()
