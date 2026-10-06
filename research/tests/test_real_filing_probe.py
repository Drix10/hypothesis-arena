import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.sources import edgar_filings
from research.strategy import real_filing_probe as P

INDEX = (
    "Form Type  Company Name   CIK   Date Filed  File Name\n"
    "-----------------------------------------------------\n"
    "10-K       ACME CORP                       1  2024-02-01  edgar/a.txt\n"
    "10-K       BETA INC                        2  2024-02-02  edgar/b.txt\n"
    "13F-HR     FUND ONE LP                     7  2024-11-05  "
    "edgar/data/7/0000000007-24-000001.txt\n"
    "13F-HR/A   FUND ONE LP                     7  2024-11-06  "
    "edgar/data/7/0000000007-24-000002.txt\n"
)
BODY = "x" * 3000


def filing_text(heads):
    return "".join("Item %s.\n%s\n" % (i, heads.get(i, BODY))
                   for i in ("1", "1A", "2", "7", "7A", "8"))


def sub(cik):
    return {"cik": cik, "filings": {"recent": {
        "accessionNumber": ["0-1-%d" % cik], "form": ["10-K"],
        "filingDate": ["2024-02-01"], "acceptanceDateTime": ["x"],
        "primaryDocument": ["d.htm"]}}}


def row(cusip, put_call="", shares="10", unit="SH"):
    return ("<infoTable><nameOfIssuer>A</nameOfIssuer><cusip>%s</cusip>"
            "<value>5</value><shrsOrPrnAmt><sshPrnamtType>%s</sshPrnamtType>"
            "<sshPrnamt>%s</sshPrnamt></shrsOrPrnAmt>"
            "<investmentDiscretion>SOLE</investmentDiscretion>%s</infoTable>"
            % (cusip, unit, shares, put_call))


class T(unittest.TestCase):
    def test_section_row_flags_short_and_dominant(self):
        ok = P.section_row(filing_text({}))
        self.assertTrue(ok["parsed"])
        self.assertFalse(ok["item_1a"]["suspect"])
        short = P.section_row(filing_text({"1A": "see below"}))
        self.assertTrue(short["item_1a"]["suspect"])
        self.assertFalse(short["mdna"]["suspect"])
        big = P.section_row(filing_text({"7": "y" * 60000}))
        self.assertTrue(big["mdna"]["suspect"])

    def test_missing_heading_reported(self):
        r = P.section_row("Item 1. Business\n" + BODY)
        self.assertFalse(r["parsed"])
        self.assertFalse(r["item_1a"]["found"])
        self.assertIn("missing heading", r["reason"])

    def test_probe_sections_counts_skips(self):
        def get_sub(cik):
            if cik == 2:
                raise edgar_filings.FilingError("down")
            return sub(cik)
        rep = P.probe_sections(2024, lambda y: INDEX, get_sub,
                               lambda f: filing_text({"1A": "short"}), n=2)
        self.assertEqual((rep["filings"], rep["skipped"]), (1, 1))
        self.assertEqual(rep["suspect"], 1)

    def test_parse_index_13f(self):
        self.assertEqual(P.parse_index_13f(INDEX), [
            {"cik": 7, "accession": "0000000007-24-000001",
             "date": "2024-11-05"}])

    def test_fetch_table_skips_primary_doc(self):
        seen = []
        got = P.fetch_table(
            INDEX,
            lambda u: {"directory": {"item": [
                {"name": "primary_doc.xml"}, {"name": "info.xml"},
                {"name": "x.htm"}]}},
            lambda u: seen.append(u) or b"<x/>")
        self.assertEqual(got[0]["cik"], 7)
        self.assertTrue(seen[0].endswith("/000000000724000001/info.xml"))
        self.assertIsNone(P.fetch_table(
            INDEX, lambda u: {"directory": {"item": []}}, lambda u: b""))

    def test_table_report(self):
        xml = ("<informationTable>" + row("037833100") + row("bad")
               + row("594918104", "<putCall>Put</putCall>")
               + row("594918104", unit="PRN", shares="x")
               + "</informationTable>")
        rep = P.table_report(xml.encode(), 7, "2024-11-05")
        self.assertEqual((rep["rows"], rep["parsed"], rep["options"]),
                         (4, 1, 1))
        self.assertEqual(rep["failures"], {"bad cusip": 1, "bad shares": 1})
        self.assertEqual(rep["share_units"], {"SH": 3, "PRN": 1})

    def test_bad_xml_is_a_failure(self):
        rep = P.table_report(b"<a>", 7, "2024-11-05")
        self.assertEqual(rep["failures"], {"unparseable xml": 1})


if __name__ == "__main__":
    unittest.main()
