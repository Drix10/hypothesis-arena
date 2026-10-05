"""The insider opportunistic buys pre-registration validates (plan/strategies.md, Research cards)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import prereg

PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                    "insider_opportunistic.json")


class InsiderOpportunisticPreregTest(unittest.TestCase):
    def setUp(self):
        with open(PATH, encoding="utf-8") as f:
            self.p = json.load(f)

    def test_validates(self):
        self.assertEqual(prereg.validate(self.p), [])

    def test_plan_constraints(self):
        self.assertEqual(self.p["constraint_set"], "us")
        self.assertEqual(self.p["contamination_class"], "deterministic")
        self.assertLessEqual(len(self.p["variants"]), 2)
        self.assertGreaterEqual(self.p["decision"]["min_cost_multiple"], 2.0)
        self.assertIn("second session", self.p["signal"])

    def test_open_questions_listed(self):
        self.assertTrue(self.p["open_questions"])


if __name__ == "__main__":
    unittest.main()
