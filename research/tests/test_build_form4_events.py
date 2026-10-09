import datetime
import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import build_form4_events as B
from research.strategy import run_connected_drift as R
from research.strategy import form4
from research.tests.test_form4 import make_zip

TODAY = datetime.date(2020, 4, 5)
CONTACT = "ops@example.com"

# (accession, filing date, transaction date); owner 111 of issuer 1 buys
Q1_2016 = ("A0", "12-JAN-2016", "04-JAN-2016")
Q1_2020 = ("A1", "05-MAR-2020", "04-MAR-2020")


def fixture_zip(path, buy=None):
    subs, owners, trans = [], [], []
    if buy:
        acc, filed, traded = buy
        subs.append([acc, filed, "4", "0000001", "ABC"])
        owners.append([acc, "111", "Officer"])
        trans.append([acc, "Common Stock", traded, "P", "100", "10"])
    make_zip(path, subs, owners, trans)


class FakeNet:
    """Opener serving fixture zips by URL; `gone` quarters answer 404 or the
    given status, and a status of None is a network error."""

    def __init__(self, tmp, gone=(), status=404):
        self.tmp, self.gone, self.urls, self.headers = tmp, set(gone), [], []
        self.status = status

    def __call__(self, url, headers, timeout_s):
        self.urls.append(url)
        self.headers.append(headers)
        name = url.rsplit("/", 1)[1]
        if name.split("_")[0] in self.gone:
            if self.status is None:
                raise urllib.error.URLError("connection reset")
            return self.status, None
        p = os.path.join(self.tmp, "src_" + name)
        buy = {"2016q1": Q1_2016, "2020q1": Q1_2020}.get(name.split("_")[0])
        fixture_zip(p, buy)
        with open(p, "rb") as f:
            return 200, io.BytesIO(f.read())


class Workdir(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.zips = os.path.join(self.tmp, "zips")
        self.data = os.path.join(self.tmp, "data")
        os.makedirs(self.data)
        self.out = os.path.join(self.data, B.OUT_NAME)
        self.logs, self.sleeps = [], []

    def run_build(self, net, contact=CONTACT, first=2016):
        return B.build(self.zips, self.out, first, contact, TODAY, net,
                       self.sleeps.append, self.logs.append)


class BuildTest(Workdir):

    def test_quarters_exclude_the_one_in_progress(self):
        qs = B.quarters(2016, TODAY)
        self.assertEqual((qs[0], qs[-1], len(qs)), ((2016, 1), (2020, 1), 17))
        self.assertEqual(B.quarters(2016, datetime.date(2020, 3, 31))[-1],
                         (2019, 4))

    def test_builds_dataset_the_runner_reads(self):
        net = FakeNet(self.tmp)
        self.assertEqual(self.run_build(net), 0)
        self.assertEqual(len(net.urls), 17)
        self.assertTrue(all(h["User-Agent"].endswith("contact=" + CONTACT)
                            for h in net.headers))
        self.assertEqual(len(self.sleeps), 17)
        events = R.read_dataset(self.data, B.OUT_NAME, "2020-03-31")
        self.assertEqual([(e["date"], e["opportunistic"]) for e in events],
                         [("2016-01-12", False), ("2020-03-05", True)])
        self.assertEqual(events[1], {
            "date": "2020-03-05", "cik": "0000001", "symbol": "ABC",
            "value": 1000.0, "n_insiders": 1, "opportunistic": True,
            "accepted": "2020-03-05T23:59", "entry": "2020-03-09T09:30"})

    def test_rerun_skips_downloaded_zips_and_is_stable(self):
        self.assertEqual(self.run_build(FakeNet(self.tmp)), 0)
        with open(self.out, "rb") as f:
            first = f.read()
        net = FakeNet(self.tmp)
        self.assertEqual(self.run_build(net), 0)
        self.assertEqual(net.urls, [])
        with open(self.out, "rb") as f:
            self.assertEqual(f.read(), first)

    def test_missing_quarter_is_reported_and_nothing_written(self):
        self.assertEqual(self.run_build(FakeNet(self.tmp, gone=["2018q2"])), 1)
        self.assertIn("2018q2: HTTP 404", self.logs)
        self.assertIn("missing quarters: 2018q2", self.logs)
        self.assertFalse(os.path.exists(self.out))
        self.assertFalse(os.path.exists(os.path.join(self.zips,
                                                     "2018q2_form345.zip")))
        # the next run fetches only the quarter that was missing
        net = FakeNet(self.tmp)
        self.assertEqual(self.run_build(net), 0)
        self.assertEqual(len(net.urls), 1)

    def test_unpublished_trailing_quarters_write_through_last_present(self):
        net = FakeNet(self.tmp, gone=["2019q4", "2020q1"])
        self.assertEqual(self.run_build(net), 0)
        self.assertIn("2019q4: HTTP 404", self.logs)
        self.assertIn("2020q1: HTTP 404", self.logs)
        warn = [m for m in self.logs if m.startswith("warning")]
        self.assertEqual(len(warn), 1)
        self.assertIn("2019q4 2020q1", warn[0])
        self.assertIn("through 2019-09-30", warn[0])
        events = R.read_dataset(self.data, B.OUT_NAME, "2019-09-30")
        self.assertEqual([e["date"] for e in events], ["2016-01-12"])
        # a rerun fetches only the quarters that were missing and refreshes through
        net = FakeNet(self.tmp)
        self.assertEqual(self.run_build(net), 0)
        self.assertEqual(len(net.urls), 2)
        events = R.read_dataset(self.data, B.OUT_NAME, "2020-03-31")
        self.assertEqual(len(events), 2)

    def test_stale_through_refuses_late_window_but_loads_earlier(self):
        net = FakeNet(self.tmp, gone=["2019q4", "2020q1"])
        self.assertEqual(self.run_build(net), 0)
        with self.assertRaises(R.RunnerError) as c:
            R.read_dataset(self.data, B.OUT_NAME, "2020-03-31")
        self.assertEqual(str(c.exception), "dataset-stale:" + B.OUT_NAME)
        self.assertEqual(len(R.read_dataset(self.data, B.OUT_NAME,
                                            "2019-09-30")), 1)

    def test_gap_before_a_present_quarter_writes_nothing(self):
        net = FakeNet(self.tmp, gone=["2019q3", "2020q1"])
        self.assertEqual(self.run_build(net), 1)
        self.assertFalse(os.path.exists(self.out))

    def test_non_404_failures_write_nothing(self):
        for status in (403, 429, 503, None):
            self.logs.clear()
            net = FakeNet(self.tmp, gone=["2020q1"], status=status)
            self.assertEqual(self.run_build(net), 1, status)
            self.assertFalse(os.path.exists(self.out))
            want = "HTTP %d" % status if status else "error:"
            self.assertTrue(any(m.startswith("2020q1: " + want)
                                for m in self.logs), (status, self.logs))

    def test_mixed_404_and_throttle_on_trailing_quarters_writes_nothing(self):
        net = FakeNet(self.tmp, gone=["2019q4"])
        orig = net.__call__

        def mixed(url, headers, timeout_s):
            if "2020q1" in url:
                return 429, None
            return orig(url, headers, timeout_s)
        self.assertEqual(self.run_build(mixed), 1)
        self.assertFalse(os.path.exists(self.out))

    def test_all_quarters_unpublished_writes_nothing(self):
        every = ["%dq%d" % yq for yq in B.quarters(2016, TODAY)]
        self.assertEqual(self.run_build(FakeNet(self.tmp, gone=every)), 1)
        self.assertFalse(os.path.exists(self.out))

    def test_no_contact_refuses_before_any_request(self):
        net = FakeNet(self.tmp)
        with self.assertRaises(B.BuildError):
            self.run_build(net, contact=" ")
        self.assertEqual(net.urls, [])

    def test_main_reports_failure_without_traceback(self):
        err = io.StringIO()
        real, sys.stderr = sys.stderr, err
        try:
            code = B.main(["--zips", self.zips, "--out", self.out],
                          env={}, today=TODAY, opener=FakeNet(self.tmp),
                          sleep=self.sleeps.append, log=self.logs.append)
        finally:
            sys.stderr = real
        self.assertEqual(code, 1)
        self.assertIn("MIRO_CONTACT missing", err.getvalue())

    def test_corrupt_zip_fails_closed(self):
        os.makedirs(self.zips)
        for y, q in B.quarters(2016, TODAY):
            with open(os.path.join(self.zips, B.zip_name(y, q)), "wb") as f:
                f.write(b"not a zip")
        err = io.StringIO()
        real, sys.stderr = sys.stderr, err
        try:
            code = B.main(["--zips", self.zips, "--out", self.out],
                          env={"MIRO_CONTACT": CONTACT}, today=TODAY)
        finally:
            sys.stderr = real
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(self.out))


def filing_text(cik="0000000001", symbol="ABC", owner="111", code="P",
                traded="2020-03-04", doc_type="4"):
    return ("<SEC-DOCUMENT>\n<XML>\n<?xml version=\"1.0\"?>\n"
            "<ownershipDocument><documentType>%s</documentType>"
            "<issuer><issuerCik>%s</issuerCik>"
            "<issuerTradingSymbol>%s</issuerTradingSymbol></issuer>"
            "<reportingOwner><reportingOwnerId><rptOwnerCik>%s</rptOwnerCik>"
            "</reportingOwnerId><reportingOwnerRelationship>"
            "<isDirector>0</isDirector><isOfficer>true</isOfficer>"
            "</reportingOwnerRelationship></reportingOwner>"
            "<nonDerivativeTable><nonDerivativeTransaction>"
            "<securityTitle><value>Common Stock</value></securityTitle>"
            "<transactionDate><value>%s</value></transactionDate>"
            "<transactionCoding><transactionCode>%s</transactionCode>"
            "</transactionCoding><transactionAmounts>"
            "<transactionShares><value>100</value></transactionShares>"
            "<transactionPricePerShare><value>10</value>"
            "</transactionPricePerShare></transactionAmounts>"
            "</nonDerivativeTransaction></nonDerivativeTable>"
            "</ownershipDocument>\n</XML>\n</SEC-DOCUMENT>\n"
            % (doc_type, cik, symbol, owner, traded, code))


def idx_line(cik, day, acc):
    return "4         Some Name Inc   %d  %s  edgar/data/%d/%s.txt\n" % (
        cik, day, cik, acc)


class FakeSec:
    """Transport serving form.idx bodies by (year, quarter) and filing texts by
    accession; `fail` maps a URL fragment to a status."""

    def __init__(self, idx, filings, fail=None):
        self.idx, self.filings, self.fail = idx, filings, fail or {}
        self.urls = []

    def __call__(self, url, headers, timeout_s):
        self.urls.append(url)
        for frag, status in self.fail.items():
            if frag in url:
                return status, {}, b""
        if url.endswith("form.idx"):
            y, q = url.split("/")[-3], url.split("/")[-2][3:]
            body = self.idx[(int(y), int(q))]
        else:
            body = self.filings[url.rsplit("/", 1)[1][:-4]]
        body = body.encode()
        return 200, {"content-type": "text/plain",
                     "content-length": str(len(body))}, body


ACC1, ACC2, ACC3 = ("0000000001-20-00000%d" % i for i in range(1, 4))


class FillTest(Workdir):
    def sec(self, **kw):
        idx = {(2020, 1): idx_line(1, "2020-03-05", ACC1)
               + idx_line(2, "2020-03-06", ACC2),
               (2020, 2): idx_line(1, "2020-04-02", ACC3)}
        filings = {ACC1: filing_text(), ACC2: filing_text(cik="0000000002"),
                   ACC3: filing_text(traded="2020-04-01")}
        return FakeSec(idx, filings, **kw)

    def run_fill(self, sec, ciks=frozenset({1})):
        return B.build(self.zips, self.out, 2016, CONTACT, TODAY,
                       FakeNet(self.tmp, gone=["2020q1"]), self.sleeps.append,
                       self.logs.append, xml_dir=os.path.join(self.tmp, "xml"),
                       ciks=ciks, transport=sec)

    def events(self):
        with open(self.out, encoding="utf-8") as f:
            return json.load(f)

    def test_gap_quarters_are_filled_from_filings(self):
        self.assertEqual(self.run_fill(self.sec()), 0)
        doc = self.events()
        self.assertEqual(doc["through"], "2020-04-02")
        self.assertEqual([e["date"] for e in doc["data"]],
                         ["2016-01-12", "2020-03-05", "2020-04-02"])
        self.assertIn("2020q1: 1 filings of the universe (1 fetched, "
                      "0 cached), 0 malformed, 1 rows; index through "
                      "2020-03-06", self.logs)

    def test_universe_filter_never_fetches_other_issuers(self):
        sec = self.sec()
        self.run_fill(sec)
        self.assertFalse(any(ACC2 in u for u in sec.urls))
        self.assertTrue(all(e["cik"] == "0000000001"
                            for e in self.events()["data"][1:]))

    def test_filing_rows_match_the_zip_path(self):
        with tempfile.TemporaryDirectory() as d:
            z = os.path.join(d, "q.zip")
            make_zip(z, [[ACC1, "05-MAR-2020", "4", "0000000001", "ABC"]],
                     [[ACC1, "111", "Officer"]],
                     [[ACC1, "Common Stock", "04-MAR-2020", "P", "100", "10"]])
            want = form4.build_events(form4.read_quarter(z))
        got = form4.build_events(form4.read_filing(
            filing_text(), datetime.date(2020, 3, 5)))
        self.assertEqual(got, want)
        self.assertEqual(list(got[0]), list(want[0]))

    def test_filing_filter_matches_the_zip_filter(self):
        day = datetime.date(2020, 3, 5)
        self.assertEqual(form4.read_filing(filing_text(code="A"), day), [])
        self.assertEqual(form4.read_filing(filing_text(doc_type="4/A"), day),
                         [])
        self.assertEqual(form4.read_filing(filing_text(symbol="BAD SYM"),
                                           day), [])
        self.assertEqual(len(form4.read_filing(filing_text(code="S"), day)), 1)

    def test_malformed_filing_is_counted_not_fatal(self):
        sec = self.sec()
        sec.filings[ACC1] = "<ownershipDocument><broken></ownershipDocument>"
        old, B.MAX_PARSE_FAIL_RATE = B.MAX_PARSE_FAIL_RATE, 0.5
        self.addCleanup(setattr, B, "MAX_PARSE_FAIL_RATE", old)
        self.assertEqual(self.run_fill(sec), 0)
        self.assertTrue(any("1 malformed" in m for m in self.logs))
        self.assertEqual([e["date"] for e in self.events()["data"]],
                         ["2016-01-12", "2020-04-02"])

    def test_malformed_rate_over_the_ceiling_writes_nothing(self):
        sec = self.sec()
        sec.filings[ACC1] = "no xml here"
        with self.assertRaises(B.BuildError):
            self.run_fill(sec)
        self.assertFalse(os.path.exists(self.out))

    def test_rerun_skips_cached_filings_and_ended_quarter_indexes(self):
        self.run_fill(self.sec())
        sec = self.sec()
        self.logs.clear()
        self.assertEqual(self.run_fill(sec), 0)
        self.assertEqual([u.rsplit("/", 2)[-2:] for u in sec.urls],
                         [["QTR2", "form.idx"]])
        self.assertIn("2020q2: 1 filings of the universe (0 fetched, "
                      "1 cached), 0 malformed, 1 rows; index through "
                      "2020-04-02", self.logs)

    def test_non_404_filing_error_writes_nothing(self):
        for status in (403, 429, 503):
            sec = self.sec(fail={ACC1.replace("-", ""): status})
            with self.assertRaises(B.BuildError):
                self.run_fill(sec)
            self.assertFalse(os.path.exists(self.out))

    def test_missing_filing_is_a_gap_not_a_skip(self):
        with self.assertRaises(B.BuildError):
            self.run_fill(self.sec(fail={ACC1.replace("-", ""): 404}))
        self.assertFalse(os.path.exists(self.out))

    def test_unpublished_trailing_index_shortens_coverage(self):
        self.assertEqual(self.run_fill(self.sec(fail={"QTR2": 404})), 0)
        self.assertEqual(self.events()["through"], "2020-03-06")
        self.assertIn("2020q2: index not published", self.logs)

    def test_index_error_other_than_404_writes_nothing(self):
        with self.assertRaises(B.BuildError):
            self.run_fill(self.sec(fail={"QTR1": 503}))
        self.assertFalse(os.path.exists(self.out))

    def test_universe_file_is_required(self):
        with self.assertRaises(B.BuildError):
            B.universe_ciks(self.data)
        with open(os.path.join(self.data, "universe_symbols.txt"), "w") as f:
            f.write("ABC\n")
        with open(os.path.join(self.data, "reference.json"), "w") as f:
            json.dump({"data": {"ciks": {"1": "ABC", "2": "XYZ"}}}, f)
        self.assertEqual(B.universe_ciks(self.data), {1})

    def test_help_documents_the_fill(self):
        out = io.StringIO()
        real, sys.stdout = sys.stdout, out
        try:
            with self.assertRaises(SystemExit):
                B.main(["--help"])
        finally:
            sys.stdout = real
        self.assertIn("--fill-from-filings", out.getvalue())


if __name__ == "__main__":
    unittest.main()
