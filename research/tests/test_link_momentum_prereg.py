"""The Link Momentum filings pre-registration validates (plan/strategies.md, Link Momentum)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import prereg

PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                    "link_momentum.json")


class LinkMomentumPreregTest(unittest.TestCase):
    def setUp(self):
        with open(PATH, encoding="utf-8") as f:
            self.p = json.load(f)

    def test_validates(self):
        self.assertEqual(prereg.validate(self.p), [])

    def test_plan_constraints(self):
        self.assertEqual(self.p["constraint_set"], "us")
        self.assertEqual(self.p["contamination_class"], "deterministic")
        self.assertNotIn("llm", self.p)
        self.assertEqual([v["name"] for v in self.p["variants"]], ["filings"])
        for term in ("$500M", "5%", "3-month hold", "150% gross",
                     "0.5%, 2% and 5%", "2007"):
            self.assertIn(term, self.p["signal"])

    def test_open_questions_listed(self):
        self.assertTrue(self.p["open_questions"])


if __name__ == "__main__":
    unittest.main()
