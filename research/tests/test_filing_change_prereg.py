"""The Filing Change pre-registration validates (plan/strategies.md, Filing Change)."""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import prereg

PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                    "filing_change.json")


class FilingChangePreregTest(unittest.TestCase):
    def setUp(self):
        with open(PATH, encoding="utf-8") as f:
            self.p = json.load(f)

    def test_validates(self):
        self.assertEqual(prereg.validate(self.p), [])

    def test_plan_constraints(self):
        self.assertLessEqual(len(self.p["variants"]), 2)
        self.assertEqual(self.p["constraint_set"], "us")
        self.assertEqual(self.p["contamination_class"], "deterministic")
        self.assertNotIn("llm", self.p)

    def test_open_questions_listed(self):
        self.assertTrue(self.p["open_questions"])


if __name__ == "__main__":
    unittest.main()
