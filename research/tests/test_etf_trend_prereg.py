"""The ETF Trend pre-registration validates (plan/strategies.md, ETF Trend)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import prereg

PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                    "etf_trend.json")
LEVERAGED_OR_INVERSE = {"UPRO", "TQQQ", "SPXL", "SSO", "QLD", "TMF", "SDS",
                        "SH", "SQQQ", "SPXU", "TBT", "UVXY"}


class EtfTrendPreregTest(unittest.TestCase):
    def setUp(self):
        with open(PATH, encoding="utf-8") as f:
            self.p = json.load(f)

    def test_validates(self):
        self.assertEqual(prereg.validate(self.p), [])

    def test_plan_constraints(self):
        self.assertLessEqual(len(self.p["variants"]), 2)
        self.assertIn("BIL", self.p["universe"])
        self.assertFalse(LEVERAGED_OR_INVERSE & set(self.p["universe"]))
        self.assertEqual(set(self.p["rationale"]), set(self.p["universe"]))
        self.assertTrue(self.p["holdout"]["rule"].startswith("seen-window"))
        self.assertEqual(self.p["holdout"]["start"][:4], "2016")

    def test_open_questions_listed(self):
        self.assertTrue(self.p["open_questions"])


if __name__ == "__main__":
    unittest.main()
