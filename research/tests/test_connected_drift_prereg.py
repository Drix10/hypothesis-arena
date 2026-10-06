"""The Connected Drift pre-registration validates (plan/strategies.md, Connected Drift Book)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import prereg

PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                    "connected_drift.json")


class ConnectedDriftPreregTest(unittest.TestCase):
    def setUp(self):
        with open(PATH, encoding="utf-8") as f:
            self.p = json.load(f)

    def test_validates(self):
        self.assertEqual(prereg.validate(self.p), [])

    def test_plan_constraints(self):
        self.assertEqual(self.p["constraint_set"], "us")
        self.assertEqual(self.p["contamination_class"], "deterministic")
        self.assertNotIn("llm", self.p)
        for term in ("$500M", "$1B", "3-month hold", "150% gross",
                     "correlation matrix", "one standard deviation"):
            self.assertIn(term, self.p["signal"] + self.p["universe"][0])

    def test_variants_and_diagnostics(self):
        self.assertEqual(len(self.p["variants"]), 1)
        self.assertEqual(len(self.p["diagnostics"]), 9)
        names = {v["name"] for v in self.p["variants"]}
        self.assertFalse(names & set(self.p["diagnostics"]))

    def test_embargo_and_seen_window(self):
        self.assertEqual(self.p["split"]["embargo_days"], 63)
        self.assertIn("seen-window", self.p["holdout"]["rule"])

    def test_open_questions_listed(self):
        self.assertTrue(self.p["open_questions"])


if __name__ == "__main__":
    unittest.main()
