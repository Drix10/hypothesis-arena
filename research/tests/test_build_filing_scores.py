"""build_filing_scores: fixtures and an injected transport only."""
import datetime
import json
import os
import sys
import tempfile
import unittest
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import build_filing_scores as B
from research.strategy import composite
from research.strategy import run_connected_drift as R

NOW = datetime.datetime(2026, 10, 6, 12, 0, tzinfo=datetime.timezone.utc)
SUB = "https://data.sec.gov/submissions/CIK%010d.json"


def filing_text(risk, mdna, skip=()):
    items = [("1", "Business", "We make widgets."),
             ("1A", "Risk Factors", risk),
             ("2", "Properties", "One plant."),
             ("7", "Management Discussion", mdna),
             ("7A", "Market Risk", "Rates."),
             ("8", "Financial Statements", "See notes.")]
    return "\n".join("Item %s. %s\n%s\n" % (i, h, t) for i, h, t in items
                     if i not in skip)


def sub(cik, rows):
    cols = ("accessionNumber", "form", "filingDate", "acceptanceDateTime",
            "primaryDocument", "reportDate")
    return {"cik": str(cik), "filings": {"recent": {
        c: [r[i] for r in rows] for i, c in enumerate(cols)}}}


def row(acc, year, doc="d.htm", form="10-K"):
    return (acc, form, "%d-02-20" % year, "%d-02-20T21:30:05.000Z" % year,
            doc, "%d-12-31" % (year - 1))


BAD = filing_text("Risk.", "Results.", skip=("7",))
GOOD = {2019: filing_text("We face litigation risk from competitors.",
                          "Revenue grew on widget demand."),
        2020: filing_text("We face supply risk and a class action lawsuit.",
                          "Revenue fell as demand for gadgets weakened.")}
SUBS = {
    1: sub(1, [row("0000000001-19-000001", 2019),
               row("0000000001-20-000001", 2020),
               row("0000000001-21-000001", 2021)]),
    2: sub(2, [row("0000000002-19-000001", 2019),
               row("0000000002-20-000001", 2020)]),
    3: sub(3, [row("0000000003-20-000001", 2020)]),
}
PAGE = "CIK0000000001-submissions-001.json"
OLD = filing_text("We face litigation risk.", "Revenue grew on widgets.")
BODIES = {"0000000001-19-000001": GOOD[2019], "0000000001-20-000001": GOOD[2020],
          "0000000001-21-000001": GOOD[2020],
          "0000000002-19-000001": BAD, "0000000002-20-000001": BAD,
          "0000000003-20-000001": GOOD[2020]}


PAGES = {}


class Server:
    def __init__(self, clock):
        self.clock, self.calls, self.times = clock, [], []
        self.down, self.missing = (), ()

    def __call__(self, url, headers, timeout_s):
        self.calls.append(url)
        self.times.append(self.clock.t)
        if "contact=" not in headers["User-Agent"]:
            return 403, {}, b""
        if url in self.down:
            raise urllib.error.URLError("unreachable")
        if url.endswith(PAGE):
            return 200, {}, json.dumps(PAGES[PAGE]).encode()
        for cik, s in SUBS.items():
            if url == SUB % cik and cik not in self.missing:
                return 200, {}, json.dumps(s).encode()
        for acc, text in BODIES.items():
            if acc.replace("-", "") in url:
                body = text.encode()
                return 200, {"content-type": "text/plain",
                             "content-length": str(len(body))}, body
        return 404, {}, b""


class Clock:
    t = 0.0

    def mono(self):
        return self.t

    def sleep(self, s):
        self.t += s


class BuildTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        ciks = {"1": "AAA", "2": "BBB", "3": "CCC"}
        with open(os.path.join(self.dir, "reference.json"), "w") as f:
            json.dump({"through": "2026-10-06", "data": {"ciks": ciks}}, f)
        self.log = []

    def run_build(self, env=None, server=None, now=NOW):
        clock = Clock()
        self.server = server or Server(clock)
        self.server.clock = clock
        code = B.main(["--data", self.dir],
                      env={"MIRO_CONTACT": "ops@example.com"}
                      if env is None else env,
                      now=now, log=self.log.append, transport=self.server,
                      mono=clock.mono, sleep=clock.sleep)
        return code

    def failing(self, down=(), missing=()):
        server = Server(None)
        server.down, server.missing = down, missing
        return server

    def output(self):
        with open(os.path.join(self.dir, "filing_scores.json")) as f:
            return json.load(f)

    def summary(self):
        return json.loads(self.log[-1])

    def test_scores_known_at_acceptance_and_counts_skips(self):
        self.run_build()
        out = self.output()
        self.assertEqual(out["through"], "2026-10-06")
        self.assertEqual(list(out["data"]), ["AAA"])
        rows = out["data"]["AAA"]
        self.assertEqual([r["known_at"] for r in rows],
                         ["2020-02-20T21:30:05+00:00",
                          "2021-02-20T21:30:05+00:00"])
        self.assertGreater(rows[0]["delta"], 0)
        self.assertEqual(self.summary()["skips"],
                         {"no_prior": 2, "parse_failure": 2,
                          "fetch_failure": 0})

    def test_unparsed_symbol_is_absent_not_zero(self):
        self.run_build()
        self.assertNotIn("BBB", self.output()["data"])
        self.assertNotIn("CCC", self.output()["data"])

    def test_clean_run_exits_zero(self):
        self.assertEqual(self.run_build(), 0)

    def test_rerun_refetches_only_missing_filings(self):
        self.run_build()
        first = self.output()
        self.run_build()
        archive = [u for u in self.server.calls if "/Archives/" in u]
        self.assertEqual(archive, [])
        self.assertEqual(self.output(), first)

    def test_requests_are_paced_under_the_sec_limit(self):
        self.run_build()
        t = self.server.times
        self.assertGreater(len(t), 5)
        self.assertTrue(all(b - a >= 0.1 for a, b in zip(t, t[1:])))

    def test_missing_contact_fetches_nothing(self):
        self.assertEqual(self.run_build(env={}), 2)
        self.assertEqual(self.server.calls, [])
        self.assertFalse(os.path.exists(
            os.path.join(self.dir, "filing_scores.json")))

    def test_unsafe_document_name_is_a_fetch_failure(self):
        SUBS[3] = sub(3, [row("0000000003-20-000001", 2020, doc="../x.htm")])
        self.addCleanup(lambda: SUBS.update({3: sub(3, [
            row("0000000003-20-000001", 2020)])}))
        self.run_build()
        self.assertEqual(self.summary()["skips"]["fetch_failure"], 1)
        self.assertEqual(self.summary()["failed_symbols"], ["CCC"])

    def test_failed_first_run_writes_nothing(self):
        self.assertEqual(self.run_build(server=self.failing(missing=(1,))), 1)
        self.assertFalse(os.path.exists(
            os.path.join(self.dir, "filing_scores.json")))

    def test_partial_rerun_keeps_previous_rows_of_failed_symbols(self):
        self.run_build()
        first = self.output()
        later = NOW + datetime.timedelta(days=1)
        code = self.run_build(server=self.failing(missing=(1,)), now=later)
        out = self.output()
        self.assertEqual(code, 1)
        self.assertEqual(out["through"], "2026-10-07")
        self.assertEqual(out["data"], first["data"])
        self.assertEqual(self.summary()["failed_symbols"], ["AAA"])

    def test_network_error_on_submissions_is_a_fetch_failure(self):
        self.run_build()
        code = self.run_build(server=self.failing(down=(SUB % 1,)))
        self.assertEqual(code, 1)
        self.assertEqual(self.summary()["failed_symbols"], ["AAA"])
        self.assertIn("AAA", self.output()["data"])

    def test_history_pages_are_read_and_paced(self):
        SUBS[1]["filings"]["files"] = [
            {"name": PAGE, "filingFrom": "2014-01-01", "filingTo": "2018-12-31"}]
        PAGES[PAGE] = sub(1, [row("0000000001-18-000001", 2018)])["filings"]["recent"]
        BODIES["0000000001-18-000001"] = OLD
        self.addCleanup(SUBS[1]["filings"].pop, "files")
        self.addCleanup(PAGES.pop, PAGE)
        self.addCleanup(BODIES.pop, "0000000001-18-000001")
        self.assertEqual(self.run_build(), 0)
        known = [r["known_at"] for r in self.output()["data"]["AAA"]]
        self.assertEqual(known[0], "2019-02-20T21:30:05+00:00")
        self.assertEqual(len(known), 3)
        t = self.server.times
        self.assertTrue(all(b - a >= 0.1 for a, b in zip(t, t[1:])))

    def test_page_older_than_start_is_not_fetched(self):
        SUBS[1]["filings"]["files"] = [
            {"name": PAGE, "filingFrom": "2001-01-01", "filingTo": "2010-12-31"}]
        self.addCleanup(SUBS[1]["filings"].pop, "files")
        self.run_build()
        self.assertFalse(any(u.endswith(PAGE) for u in self.server.calls))

    def test_output_loads_in_the_runner(self):
        self.run_build()
        data = R.read_dataset(self.dir, "filing_scores.json", "2026-10-06")
        delta = data["AAA"][0]["delta"]
        raw = composite.filing_raw({"filings": data}, {"AAA"}, "2020-02-21")
        self.assertEqual(raw, {"AAA": -delta})
        self.assertEqual(composite.filing_raw({"filings": data}, {"AAA"},
                                              "2020-02-20"), {})


if __name__ == "__main__":
    unittest.main()
