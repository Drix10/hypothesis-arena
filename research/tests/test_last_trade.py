"""Last-trading-day resolver tests; fixtures only, no network."""
import os
import sys
import unittest
from datetime import date

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)

from sources import last_trade

BARS = [date(2020, 3, 2), date(2020, 3, 3), date(2020, 3, 4)]
END = date(2024, 12, 31)


def _ev(form, d, accession="0001-20-000001", **kw):
    return {"form": form, "date": d, "accession": accession, **kw}


class ResolveTest(unittest.TestCase):
    def test_confirmed_by_common_form_25(self):
        r = last_trade.resolve(
            BARS, [_ev("25", date(2020, 3, 9), security_class="common")], END)
        self.assertEqual(r["status"], "confirmed")
        self.assertEqual(r["last_bar_date"], date(2020, 3, 4))
        self.assertEqual(r["event"], {"type": "delisting",
                                      "date": date(2020, 3, 9),
                                      "accession": "0001-20-000001"})

    def test_confirmed_by_form_15_and_acquisition(self):
        r = last_trade.resolve(BARS, [_ev("15-12B", date(2020, 3, 5))], END)
        self.assertEqual(r["event"]["type"], "deregistration")
        r = last_trade.resolve(
            BARS, [_ev("8-K", date(2020, 3, 4), items=["2.01", "9.01"])], END)
        self.assertEqual(r["event"]["type"], "acquisition")

    def test_unverified_without_event(self):
        r = last_trade.resolve(BARS, [], END)
        self.assertEqual(r, {"last_bar_date": date(2020, 3, 4), "event": None,
                             "status": "unverified"})

    def test_unverified_when_event_too_late(self):
        r = last_trade.resolve(
            BARS, [_ev("15-12G", date(2020, 3, 15))], END)
        self.assertEqual(r["status"], "unverified")
        r = last_trade.resolve(
            BARS, [_ev("15-12G", date(2020, 3, 14))], END)
        self.assertEqual(r["status"], "confirmed")

    def test_active_when_bars_reach_data_end(self):
        r = last_trade.resolve(
            BARS + [END], [_ev("15-12B", date(2025, 1, 2))], END)
        self.assertEqual(r["status"], "active")
        self.assertIsNone(r["event"])

    def test_preferred_or_unstated_class_form_25_does_not_count(self):
        for kw in ({"security_class": "preferred"}, {"security_class": "bond"},
                   {}):
            r = last_trade.resolve(
                BARS, [_ev("25", date(2020, 3, 5), **kw)], END)
            self.assertEqual(r["status"], "unverified")

    def test_form_25_before_last_bar_window(self):
        common = {"security_class": "common"}
        r = last_trade.resolve(BARS, [_ev("25", date(2020, 2, 23), **common)], END)
        self.assertEqual(r["status"], "confirmed")
        r = last_trade.resolve(BARS, [_ev("25", date(2020, 1, 24), **common)], END)
        self.assertEqual(r["status"], "unverified")
        self.assertIsNone(r["event"])

    def test_acquisition_after_last_bar_window(self):
        r = last_trade.resolve(
            BARS, [_ev("8-K", date(2020, 3, 7), items=["2.01"])], END)
        self.assertEqual(r["status"], "confirmed")
        r = last_trade.resolve(
            BARS, [_ev("8-K", date(2020, 4, 3), items=["2.01"])], END)
        self.assertEqual(r["status"], "unverified")

    def test_item_3_01_long_before_last_bar_does_not_confirm(self):
        r = last_trade.resolve(
            BARS, [_ev("8-K", date(2018, 9, 4), items=["3.01"])], END)
        self.assertEqual(r["status"], "unverified")

    def test_earliest_event_wins(self):
        r = last_trade.resolve(BARS, [
            _ev("15-12B", date(2020, 3, 9), accession="b"),
            _ev("15-12B", date(2020, 3, 6), accession="a")], END)
        self.assertEqual(r["event"]["accession"], "a")
        r = last_trade.resolve(BARS, [
            _ev("15-12B", date(2020, 3, 6), accession="b"),
            _ev("25", date(2020, 2, 25), accession="a",
                security_class="common")], END)
        self.assertEqual(r["event"]["accession"], "a")

    def test_unrelated_8k_ignored(self):
        r = last_trade.resolve(
            BARS, [_ev("8-K", date(2020, 3, 5), items=["5.02"])], END)
        self.assertEqual(r["status"], "unverified")

    def test_empty_bars_rejected(self):
        with self.assertRaises(ValueError):
            last_trade.resolve([], [], END)


if __name__ == "__main__":
    unittest.main()
