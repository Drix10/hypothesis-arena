"""collect_end_events on an injected SEC transport: Form 25, Form 15 and 8-K
events are written per symbol in the delisting contract, a rerun makes no
requests, and a failed fetch writes nothing. No network."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.sources import collect_end_events as C
from research.strategy import delisting

ENV = {"MIRO_CONTACT": "test@example.com"}
SUB = {"cik": "1", "filings": {"recent": {
    "form": ["10-K", "25", "8-K", "15-12B", "25"],
    "filingDate": ["2020-02-01", "2020-03-02", "2020-03-04", "2020-03-20",
                   "2020-03-05"],
    "accessionNumber": ["a-1", "a-2", "a-3", "a-4", "a-5"],
    "primaryDocument": ["k.htm", "f25.txt", "e.htm", "f15.htm", "f25b.txt"],
    "items": ["", "", "3.01,9.01", "", ""]},
    "files": [{"name": "CIK0000000001-submissions-001.json"},
              {"name": "../evil.json"}]}}
OLDER = {"form": ["25"], "filingDate": ["2010-05-01"],
         "accessionNumber": ["a-0"], "primaryDocument": ["old25.txt"],
         "items": [""]}
DOCS = {"f25.txt": "Description of class of securities: Common Stock",
        "f25b.txt": "Description of class of securities: 5% Notes due 2030",
        "old25.txt": "Title of class: Common Stock"}


class Net:
    def __init__(self, fail=()):
        self.urls, self.headers, self.fail = [], [], set(fail)

    def __call__(self, url, headers, timeout_s):
        self.urls.append(url)
        self.headers.append(headers)
        name = url.rsplit("/", 1)[1]
        if any(f in url for f in self.fail):
            return 500, {}, b""
        if name == "CIK0000000001.json":
            return 200, {}, json.dumps(SUB).encode()
        if name == "CIK0000000001-submissions-001.json":
            return 200, {}, json.dumps(OLDER).encode()
        return 200, {}, DOCS[name].encode()


class CollectTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        with open(os.path.join(self.dir, "reference.json"), "w") as f:
            json.dump({"through": "2020-04-01",
                       "data": {"ciks": {"0000000001": "ABC"}}}, f)
        self.logs = []

    def run_main(self, net, *extra, env=ENV):
        return C.main(["--data", self.dir, "--end", "2020-04-01", *extra],
                      env=env, log=self.logs.append, today="2020-04-02",
                      transport=net, sleeper=lambda s: None)

    def output(self):
        with open(os.path.join(self.dir, "end_events.json")) as f:
            return json.load(f)

    def test_events_written_in_the_delisting_contract(self):
        net = Net()
        self.assertEqual(self.run_main(net, "--yes"), 0)
        out = self.output()
        self.assertEqual(out["through"], "2020-04-01")
        by_acc = {e["accession"]: e for e in out["data"]["ABC"]}
        self.assertEqual(by_acc["a-2"]["security_class"], "common")
        self.assertEqual(by_acc["a-0"]["security_class"], "common")
        self.assertNotIn("security_class", by_acc["a-5"])
        self.assertEqual(by_acc["a-3"]["items"], ["3.01"])
        self.assertEqual(by_acc["a-4"]["form"], "15-12B")
        self.assertNotIn("a-1", by_acc)
        self.assertTrue(all("contact=test@example.com" in h["User-Agent"]
                            for h in net.headers))
        self.assertFalse(any("evil" in u for u in net.urls))

    def test_output_feeds_the_harness_end_resolution(self):
        self.run_main(Net(), "--yes")
        bars = {"ABC": {"2020-03-12": (1.0, 1.0), "2020-03-13": (1.0, 1.0)}}
        ends, unverified = delisting.session_ends(
            bars, self.output()["data"], "2020-04-01")
        self.assertEqual(ends, {"ABC": {"date": "2020-03-13",
                                        "type": "delisting"}})
        self.assertEqual(unverified, [])

    def test_rerun_resumes_from_cache(self):
        self.run_main(Net(), "--yes")
        net = Net()
        self.assertEqual(self.run_main(net, "--yes"), 0)
        self.assertEqual(net.urls, [])

    def test_failed_fetch_writes_nothing(self):
        self.assertEqual(self.run_main(Net(fail=["submissions-001"]), "--yes"), 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir,
                                                     "end_events.json")))
        self.assertEqual(self.run_main(Net(), "--yes"), 0)

    def test_refuses_without_contact_or_confirmation(self):
        net = Net()
        self.assertEqual(self.run_main(net, "--yes", env={}), 2)
        self.assertEqual(self.run_main(net), 2)
        self.assertEqual(net.urls, [])

    def test_unreadable_reference_fails_closed(self):
        os.remove(os.path.join(self.dir, "reference.json"))
        self.assertEqual(self.run_main(Net(), "--yes"), 1)


if __name__ == "__main__":
    unittest.main()
