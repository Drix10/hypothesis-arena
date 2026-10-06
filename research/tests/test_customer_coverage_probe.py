import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.sources import edgar_filings
from research.strategy import customer_coverage_probe as P

INDEX = (
    "Form Type  Company Name   CIK   Date Filed  File Name\n"
    "-----------------------------------------------------\n"
    "10-K       ACME CORP                       1  2017-02-01  edgar/a.txt\n"
    "10-K/A     ACME CORP                       1  2017-03-01  edgar/b.txt\n"
    "10-Q       BETA INC                        2  2017-05-01  edgar/c.txt\n"
    "10-K       BETA HOLDINGS INC               2  2017-02-02  edgar/d.txt\n"
)
TICKERS = {"0": {"cik_str": 320193, "ticker": "AAPL", "title": "Apple Inc."},
           "1": {"cik_str": 789019, "ticker": "MSFT",
                 "title": "Microsoft Corp"}}
NAMED = "We sold products to Apple Inc. and Zeta Widgets in the year."
BARE = "We make widgets."


def two_year_sub(cik):
    return {"cik": cik, "filings": {"recent": {
        "accessionNumber": ["0-1-%d" % cik, "0-2-%d" % cik],
        "form": ["10-K", "10-K"],
        "filingDate": ["2017-02-01", "2022-02-01"],
        "acceptanceDateTime": ["x", "x"],
        "primaryDocument": ["d.htm", "d.htm"]}}}


class T(unittest.TestCase):
    def test_parse_index(self):
        self.assertEqual(P.parse_index(INDEX), [
            {"cik": 1, "name": "ACME CORP"},
            {"cik": 2, "name": "BETA HOLDINGS INC"}])

    def test_sample_is_seeded_and_capped(self):
        filers = [{"cik": i, "name": "n"} for i in range(30)]
        a = P.sample_filers(filers, 5, 1)
        self.assertEqual(a, P.sample_filers(list(reversed(filers)), 5, 1))
        self.assertEqual(len(a), 5)
        self.assertEqual(len(P.sample_filers(filers[:3], 5, 1)), 3)

    def test_plain_text(self):
        self.assertEqual(P.plain_text("<p>a&amp;b</p>\n<b>c</b>"), "a&b c")

    def run_probe(self, texts, get_sub):
        aliases, obs = P.alias_tables(TICKERS)
        return P.probe((2017, 2022), lambda y: INDEX, get_sub,
                       lambda f: texts[f["filing_date"][:4]],
                       aliases, obs, n=2)

    def test_shares(self):
        rep = self.run_probe({"2017": NAMED, "2022": BARE}, two_year_sub)
        y17, y22 = rep["years"]["2017"], rep["years"]["2022"]
        self.assertEqual((y17["filings"], y17["named_share"]), (2, 1.0))
        self.assertEqual((y17["mentions"], y17["resolved"]), (4, 2))
        self.assertEqual(y17["resolved_share"], 0.5)
        self.assertEqual((y22["named_share"], y22["resolved_share"]),
                         (0.0, None))
        self.assertTrue(rep["collapsed"])

    def test_collapse(self):
        rows = {2017: {"filings": 2, "named": 2},
                2022: {"filings": 2, "named": 0}}
        self.assertTrue(P.collapse(rows)["collapsed"])
        rows[2022]["named"] = 2
        self.assertFalse(P.collapse(rows)["collapsed"])

    def test_failures_are_skipped_not_zero(self):
        def get_sub(cik):
            raise edgar_filings.FilingError("down")
        row = self.run_probe({}, get_sub)["years"]["2017"]
        self.assertEqual((row["filings"], row["skipped"]), (0, 2))
        self.assertIsNone(row["named_share"])


if __name__ == "__main__":
    unittest.main()
