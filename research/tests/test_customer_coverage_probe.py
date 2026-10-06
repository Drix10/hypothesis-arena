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


class T(unittest.TestCase):
    def test_parse_index(self):
        self.assertEqual(P.parse_index(INDEX), [
            {"cik": 1, "name": "ACME CORP", "file": "edgar/a.txt"},
            {"cik": 2, "name": "BETA HOLDINGS INC", "file": "edgar/d.txt"}])

    def test_sample_is_seeded_and_capped(self):
        filers = [{"cik": i, "name": "n"} for i in range(30)]
        a = P.sample_filers(filers, 5, 1)
        self.assertEqual(a, P.sample_filers(list(reversed(filers)), 5, 1))
        self.assertEqual(len(a), 5)
        self.assertEqual(len(P.sample_filers(filers[:3], 5, 1)), 3)

    def test_plain_text(self):
        self.assertEqual(P.plain_text("<p>a&amp;b</p>\n<b>c</b>"), "a&b c")

    def run_probe(self, get_text, years=(2017, 2022)):
        aliases, obs = P.alias_tables(TICKERS)
        return P.probe(years, lambda y: INDEX, get_text, aliases, obs, n=2)

    def test_shares(self):
        texts = {"edgar/a.txt": NAMED, "edgar/d.txt": BARE}
        rep = self.run_probe(texts.__getitem__, years=(2017,))
        y17 = rep["years"]["2017"]
        self.assertEqual((y17["filings"], y17["named_share"]), (2, 0.5))
        self.assertEqual((y17["mentions"], y17["resolved"]), (2, 1))
        self.assertEqual(y17["resolved_share"], 0.5)
        self.assertFalse(rep["incomplete"])

    def test_collapse(self):
        rows = {2017: {"filings": 2, "named": 2},
                2022: {"filings": 2, "named": 0}}
        self.assertTrue(P.collapse(rows)["collapsed"])
        rows[2022]["named"] = 2
        self.assertFalse(P.collapse(rows)["collapsed"])

    def test_skips_counted_by_reason(self):
        def get_text(f):
            if f == "edgar/a.txt":
                raise OSError("down")
            return " "
        rep = self.run_probe(get_text, years=(2017,))
        row = rep["years"]["2017"]
        self.assertEqual((row["filings"], row["fetch_failed"],
                          row["empty_text"]), (0, 1, 1))
        self.assertIsNone(row["named_share"])

    def test_all_skipped_year_is_incomplete(self):
        def get_text(f):
            raise edgar_filings.FilingError("down")
        rep = self.run_probe(get_text)
        self.assertTrue(rep["incomplete"])
        self.assertIsNone(rep["collapsed"])


if __name__ == "__main__":
    unittest.main()
