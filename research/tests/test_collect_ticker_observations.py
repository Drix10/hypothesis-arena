"""collect_ticker_observations on injected SEC and Alpaca transports: the four
observation sources are written as JSONL the point-in-time map resolves, a rerun
makes no SEC requests, and a failed fetch writes nothing. No network."""
import datetime
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.sources import collect_ticker_observations as C
from research.sources import ticker_map
from research.tests.test_form4 import make_zip

ENV = {"MIRO_CONTACT": "test@example.com", "ALPACA_KEY_ID": "k",
       "ALPACA_SECRET": "s"}
D = datetime.date
SUB = {"cik": "0000000001",
       "formerNames": [{"name": "Old Widgets, Inc.",
                        "to": "2015-04-10T00:00:00.000Z"}],
       "filings": {"recent": {"form": ["8-K"], "filingDate": ["2015-04-14"]}}}
FACTS = {"cik": 1, "facts": {"dei": {"TradingSymbol": {"units": {"pure": [
    {"end": "2016-12-31", "val": "OWC", "filed": "2017-02-01"}]}}}}}
ACTIONS = {"corporate_actions": {"name_changes": [
    {"old_symbol": "OWC", "new_symbol": "WDG", "process_date": "2018-06-01"}]}}
ASSETS = [{"symbol": "OWC", "name": "Old Widgets Inc. Common Stock"}]


class SecNet:
    def __init__(self, fail=()):
        self.urls, self.fail = [], set(fail)

    def __call__(self, url, headers, timeout_s):
        self.urls.append(url)
        if any(f in url for f in self.fail):
            return 500, {}, b""
        body = FACTS if "companyfacts" in url else SUB
        return 200, {}, json.dumps(body).encode()


class Alpaca:
    def __init__(self):
        self.urls, self.headers = [], []

    def __call__(self, url, headers):
        self.urls.append(url)
        self.headers.append(headers)
        if "corporate-actions" in url:
            return ACTIONS
        return ASSETS if url.endswith("active") else []


class CollectTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        os.makedirs(os.path.join(self.dir, "form4_zips"))
        with open(os.path.join(self.dir, "reference.json"), "w") as f:
            json.dump({"through": "2020-04-01",
                       "data": {"ciks": {"0000000001": "WDG"}}}, f)
        make_zip(os.path.join(self.dir, "form4_zips", "2019q1_form345.zip"),
                 [["A1", "05-MAR-2019", "4", "0000001", "WDG"],
                  ["A2", "05-MAR-2019", "4", "0000009", "OTH"]],
                 [["A1", "111", "Officer"], ["A1", "112", "Director"],
                  ["A2", "113", "Officer"]],
                 [["A1", "Common Stock", "04-MAR-2019", "P", "100", "10"],
                  ["A2", "Common Stock", "04-MAR-2019", "P", "100", "10"]])
        self.logs = []

    def run_main(self, sec, alpaca, *extra, env=ENV):
        return C.main(["--data", self.dir, "--end", "2020-04-01", *extra],
                      env=env, log=self.logs.append, today="2020-04-02",
                      http_get=alpaca, transport=sec, sleeper=lambda s: None)

    def observations(self):
        with open(os.path.join(self.dir, C.OUT_NAME)) as f:
            return [json.loads(line) for line in f]

    def test_four_sources_written_and_resolved(self):
        alpaca = Alpaca()
        self.assertEqual(self.run_main(SecNet(), alpaca, "--yes"), 0)
        rows = self.observations()
        self.assertEqual(sorted(r["source"] for r in rows),
                         ["corp_action", "dei", "form4", "former_name"])
        self.assertTrue(all(r["cik"] == 1 for r in rows))
        obs = [ticker_map.observation(
            r["cik"], r["symbol"], r["source"],
            D.fromisoformat(r["observed_date"]), D.fromisoformat(r["known_at"]))
            for r in rows]
        self.assertEqual(ticker_map.ticker(obs, 1, D(2015, 5, 1)), "OWC")
        self.assertEqual(ticker_map.ticker(obs, 1, D(2017, 6, 1)), "OWC")
        self.assertEqual(ticker_map.ticker(obs, 1, D(2019, 12, 1)), "WDG")
        self.assertEqual(alpaca.headers[0]["APCA-API-KEY-ID"], "k")

    def test_rerun_resumes_from_cache_and_is_idempotent(self):
        self.run_main(SecNet(), Alpaca(), "--yes")
        first = self.observations()
        sec = SecNet()
        self.assertEqual(self.run_main(sec, Alpaca(), "--yes"), 0)
        self.assertEqual(sec.urls, [])
        self.assertEqual(self.observations(), first)

    def test_failed_fetch_writes_nothing(self):
        self.assertEqual(self.run_main(SecNet(fail=["companyfacts"]),
                                       Alpaca(), "--yes"), 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, C.OUT_NAME)))

    def test_refuses_without_credentials_or_confirmation(self):
        sec = SecNet()
        self.assertEqual(self.run_main(sec, Alpaca(), "--yes",
                                       env={"MIRO_CONTACT": "a@b.c"}), 2)
        self.assertEqual(self.run_main(sec, Alpaca(), "--yes", env={
            "ALPACA_KEY_ID": "k", "ALPACA_SECRET": "s"}), 2)
        self.assertEqual(self.run_main(sec, Alpaca()), 2)
        self.assertEqual(sec.urls, [])

    def test_missing_form4_zips_fail_closed(self):
        os.remove(os.path.join(self.dir, "form4_zips", "2019q1_form345.zip"))
        self.assertEqual(self.run_main(SecNet(), Alpaca(), "--yes"), 1)


if __name__ == "__main__":
    unittest.main()
