"""XBRL shares-outstanding reader tests; fixtures only, no network."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)

from sources import shares_outstanding as so


def _fact(val, end, filed, accn, form="10-Q"):
    return {"val": val, "end": end, "filed": filed, "accn": accn,
            "form": form}


def _facts(shares=(), flt=()):
    dei = {}
    if shares:
        dei[so.SHARES_CONCEPT] = {"units": {"shares": list(shares)}}
    if flt:
        dei[so.FLOAT_CONCEPT] = {"units": {"USD": list(flt)}}
    return {"cik": 320193, "facts": {"dei": dei}}


Q1 = _fact(1000, "2024-04-19", "2024-05-02", "0001-24-000001")
Q2 = _fact(1100, "2024-07-19", "2024-08-02", "0001-24-000002")


class AsOfTest(unittest.TestCase):
    def test_refuses_lookahead(self):
        with self.assertRaisesRegex(so.SharesError, "no dei"):
            so.shares(_facts([Q1]), "2024-05-01")
        got = so.shares(_facts([Q1]), "2024-05-02")
        self.assertEqual(got["value"], 1000)

    def test_prefers_latest_filed(self):
        f = _facts([Q2, Q1])
        self.assertEqual(so.shares(f, "2024-08-01")["value"], 1000)
        got = so.shares(f, "2024-08-02")
        self.assertEqual(got["value"], 1100)
        self.assertEqual(got["accession"], "0001-24-000002")
        self.assertEqual(got["form"], "10-Q")
        self.assertEqual(got["end"], "2024-07-19")
        self.assertFalse(got["restated"])

    def test_public_float(self):
        f = _facts(flt=[_fact(5e8, "2023-06-30", "2024-02-01", "a", "10-K")])
        self.assertEqual(so.public_float(f, "2024-03-01")["value"], 5e8)


class ClassesTest(unittest.TestCase):
    def test_two_classes_sum(self):
        f = _facts([_fact(600, "2024-04-19", "2024-05-02", "a"),
                    _fact(400, "2024-04-19", "2024-05-02", "a")])
        got = so.shares(f, "2024-06-01")
        self.assertEqual(got["value"], 1000)
        self.assertEqual(got["classes"], 2)


class RestatedTest(unittest.TestCase):
    def test_restated_cover_date_flagged_and_latest_wins(self):
        f = _facts([Q1, _fact(990, "2024-04-19", "2024-06-10", "b", "10-Q/A")])
        got = so.shares(f, "2024-07-01")
        self.assertEqual(got["value"], 990)
        self.assertTrue(got["restated"])
        self.assertEqual(so.shares(f, "2024-06-01")["value"], 1000)
        self.assertFalse(so.shares(f, "2024-06-01")["restated"])

    def test_same_value_refiling_not_restated(self):
        f = _facts([Q1, _fact(1000, "2024-04-19", "2024-06-10", "b")])
        self.assertFalse(so.shares(f, "2024-07-01")["restated"])

    def test_input_order_does_not_matter(self):
        a = _fact(1, "2024-04-19", "2024-05-02", "a")
        b = _fact(2, "2024-04-19", "2024-05-02", "b")
        self.assertEqual(so.shares(_facts([a, b]), "2024-06-01"),
                         so.shares(_facts([b, a]), "2024-06-01"))


class MalformedTest(unittest.TestCase):
    def test_bad_facts_refused(self):
        bad = (_fact(-1, "2024-04-19", "2024-05-02", "a"),
               _fact("1000", "2024-04-19", "2024-05-02", "a"),
               _fact(True, "2024-04-19", "2024-05-02", "a"),
               _fact(float("nan"), "2024-04-19", "2024-05-02", "a"),
               _fact(float("inf"), "2024-04-19", "2024-05-02", "a"),
               _fact(None, "2024-04-19", "2024-05-02", "a"),
               _fact(1, "2024-13-19", "2024-05-02", "a"),
               _fact(1, "2024-04-19", "20240502", "a"),
               _fact(1, "2024-04-19", "2024-05-02", ""),
               _fact(1, "2024-04-19", "2024-05-02", "a", None),
               "not a dict")
        for b in bad:
            with self.assertRaises(so.SharesError, msg=repr(b)):
                so.shares(_facts([Q1, b]), "2024-06-01")

    def test_malformed_never_skipped_even_if_future(self):
        bad = _fact(-5, "2024-09-19", "2024-10-02", "z")
        with self.assertRaises(so.SharesError):
            so.shares(_facts([Q1, bad]), "2024-06-01")

    def test_missing_concept_and_bad_as_of(self):
        with self.assertRaises(so.SharesError):
            so.shares({"facts": {}}, "2024-06-01")
        with self.assertRaises(so.SharesError):
            so.shares(_facts(flt=[Q1]), "2024-06-01")
        with self.assertRaises(so.SharesError):
            so.shares(_facts([Q1]), "June 1")


if __name__ == "__main__":
    unittest.main()
