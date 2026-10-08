import datetime
import io
import os
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import build_form4_events as B
from research.strategy import run_connected_drift as R
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


class BuildTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
