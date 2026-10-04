"""End-event extraction tests; fixtures only, no network."""
import os
import sys
import unittest
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)

from sources import end_events, last_trade

RECENT = {"filings": {"recent": {
    "form": ["10-K", "8-K", "25", "8-K", "15-12B", "25-NSE", "4"],
    "filingDate": ["2020-01-10", "2020-02-20", "2020-02-24", "2020-03-01",
                   "2020-03-05", "2020-03-06", "2020-03-07"],
    "accessionNumber": ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
    "items": ["", "5.02,9.01", "", "3.01,9.01", "", "", ""],
    "primaryDocument": ["k.htm", "e.htm", "x.htm", "e2.htm", "f.htm", "n.htm", "4.xml"],
}}}
OLD = {"form": ["15-15D", "8-K", "8-K"],
       "filingDate": ["2019-05-01", "2019-04-01", "2019-03-01"],
       "accessionNumber": ["o1", "o2", "o3"],
       "items": ["", "2.01", "7.01"],
       "primaryDocument": ["a", "b", "c"]}
COMMON_DOC = "<p>Title of each class of securities: Common Stock, par value $0.01</p>"


class BuildTest(unittest.TestCase):
    def test_forms_and_items(self):
        ev = end_events.build_events(RECENT)
        self.assertEqual([e["accession"] for e in ev], ["a3", "a4", "a5", "a6"])
        by = {e["accession"]: e for e in ev}
        self.assertEqual(by["a4"]["items"], ["3.01"])
        self.assertEqual(by["a4"]["date"], date(2020, 3, 1))
        self.assertNotIn("security_class", by["a3"])

    def test_old_filings_file(self):
        ev = end_events.build_events(OLD)
        self.assertEqual([(e["form"], e["accession"]) for e in ev],
                         [("15-15D", "o1"), ("8-K", "o2")])
        self.assertEqual(ev[1]["items"], ["2.01"])

    def test_class_from_dict_and_callable(self):
        for src in ({"a3": COMMON_DOC}, {"a3": COMMON_DOC}.get):
            by = {e["accession"]: e for e in end_events.build_events(RECENT, src)}
            self.assertEqual(by["a3"]["security_class"], "common")
            self.assertNotIn("security_class", by["a6"])

    def test_preferred_class_left_unset(self):
        doc = "Title of each class of securities: Preferred Stock"
        by = {e["accession"]: e for e in
              end_events.build_events(RECENT, {"a3": doc})}
        self.assertNotIn("security_class", by["a3"])


class ParseTest(unittest.TestCase):
    def test_classes(self):
        p = end_events.parse_form25_class
        self.assertEqual(p(COMMON_DOC), "common")
        self.assertEqual(p("Description of class of securities: Ordinary Shares"), "common")
        self.assertIsNone(p("Title of each class of securities: Series A Preferred Stock"))
        self.assertIsNone(p("Title of each class of securities: 5.0% Senior Notes due 2030"))
        self.assertIsNone(p("Title of each class of securities: Warrants to purchase Common Stock"))
        self.assertIsNone(p("Title of each class of securities: Depositary Shares"))

    def test_unreadable(self):
        self.assertIsNone(end_events.parse_form25_class("garbled ###"))
        self.assertIsNone(end_events.parse_form25_class(""))
        self.assertIsNone(end_events.parse_form25_class(None))


class EndToEndTest(unittest.TestCase):
    bars = [date(2020, 3, 2), date(2020, 3, 3), date(2020, 3, 4)]

    def test_confirmed_from_builder(self):
        ev = end_events.build_events(RECENT, {"a3": COMMON_DOC})
        r = last_trade.resolve(self.bars, ev, date(2024, 12, 31))
        self.assertEqual(r["status"], "confirmed")
        self.assertEqual(r["event"]["accession"], "a3")
        self.assertEqual(r["event"]["type"], "delisting")

    def test_unknown_class_fails_closed(self):
        ev = [e for e in end_events.build_events(RECENT) if e["form"] == "25"]
        r = last_trade.resolve(self.bars, ev, date(2024, 12, 31))
        self.assertEqual(r["status"], "unverified")


if __name__ == "__main__":
    unittest.main()
