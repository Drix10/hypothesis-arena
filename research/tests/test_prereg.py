import copy
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import prereg as P

BASE = {
    "schema": "prereg", "experiment_id": "etf-trend",
    "family": "trend", "hypothesis": "ETF trend persists net of cost",
    "strategy": "etf_trend", "universe": ["SPY", "TLT"],
    "signal": "sma200", "variants": [{"n": 100}, {"n": 200}],
    "cost_model": "costs",
    "split": {"scheme": "walk_forward", "n_splits": 4,
              "label_horizon_days": 5, "embargo_days": 5},
    "holdout": {"start": "2021-01-01", "end": "2024-01-01",
                "rule": "last 3y or 25%"},
    "decision": {"min_net_sharpe": 0.5, "max_drawdown_pct": 20,
                 "min_cost_multiple": 2, "min_days": 750,
                 "new_signal_tstat_min": 3.0},
    "created": "2020-06-01",
    "constraint_set": "us", "contamination_class": "deterministic",
}


class T(unittest.TestCase):
    def test_valid_and_hash_stable(self):
        self.assertEqual(P.validate(BASE), [])
        h = P.require_valid(BASE)
        self.assertEqual(h, P.prereg_hash(copy.deepcopy(BASE)))
        self.assertEqual(len(h), 64)

    def test_hash_changes_on_edit(self):
        b = copy.deepcopy(BASE)
        b["signal"] = "sma100"
        self.assertNotEqual(P.prereg_hash(b), P.prereg_hash(BASE))

    def test_missing_and_weak_rules_refused(self):
        b = copy.deepcopy(BASE)
        del b["holdout"]
        self.assertIn("missing:holdout", P.validate(b))
        b = copy.deepcopy(BASE)
        b["decision"]["min_cost_multiple"] = 1
        self.assertIn("bad-value:min_cost_multiple", P.validate(b))
        b = copy.deepcopy(BASE)
        b["decision"]["new_signal_tstat_min"] = 2.0
        self.assertTrue(P.validate(b))
        b = copy.deepcopy(BASE)
        b["cost_model"] = "cost_v1"
        self.assertIn("cost-model-version", P.validate(b))
        b = copy.deepcopy(BASE)
        b["variants"] = [{"n": 1}, {"n": 1}]
        self.assertTrue(P.validate(b))
        with self.assertRaises(P.PreregError):
            P.require_valid({})

    def test_malformed_thresholds_are_errors_not_exceptions(self):
        for k, v in (("min_days", 0), ("min_net_sharpe", -1),
                     ("max_drawdown_pct", 1e9), ("min_cost_multiple", "2"),
                     ("new_signal_tstat_min", True),
                     ("min_net_sharpe", float("nan"))):
            b = copy.deepcopy(BASE)
            b["decision"][k] = v
            self.assertIn("bad-value:" + k, P.validate(b))

    def test_contamination_boundary(self):
        b = copy.deepcopy(BASE)
        b["contamination_class"] = "extraction"
        b["llm"] = {"knowledge_cutoff": "2025-01-01",
                    "evidence_start": "2025-01-31"}
        self.assertTrue(any("contaminated" in e for e in P.validate(b)))
        b["llm"]["evidence_start"] = "2025-01-31"
        self.assertTrue(P.contamination_errors(b["llm"], "2025-01-30"))
        self.assertEqual(P.contamination_errors(b["llm"], "2025-01-31"), [])
        b["holdout"]["start"] = "2025-02-01"
        b["holdout"]["end"] = "2026-02-01"
        b["created"] = "2025-01-15"
        b["llm"]["evidence_start"] = "2025-02-01"
        self.assertEqual(P.validate(b), [])

    def test_llm_missing_cutoff_refused(self):
        b = copy.deepcopy(BASE)
        b["contamination_class"] = "extraction"
        b["llm"] = {"evidence_start": "2026-01-01"}
        self.assertIn("llm-knowledge-cutoff-missing-or-bad", P.validate(b))

    def test_constraint_set(self):
        b = copy.deepcopy(BASE)
        b["constraint_set"] = "india"
        self.assertIn("constraint-set", P.validate(b))
        del b["constraint_set"]
        self.assertIn("missing:constraint_set", P.validate(b))

    def test_contamination_class_required_and_known(self):
        b = copy.deepcopy(BASE)
        b["contamination_class"] = "vibes"
        self.assertIn("contamination-class", P.validate(b))
        del b["contamination_class"]
        self.assertIn("missing:contamination_class", P.validate(b))

    def test_model_classes_need_llm_block(self):
        for cls in ("extraction", "judgment"):
            b = copy.deepcopy(BASE)
            b["contamination_class"] = cls
            self.assertIn("missing:llm", P.validate(b))
            b["llm"] = {"knowledge_cutoff": "2020-01-01",
                        "evidence_start": "2020-03-01"}
            self.assertEqual(P.validate(b), [])

    def test_extraction_uses_30_day_check(self):
        b = copy.deepcopy(BASE)
        b["contamination_class"] = "extraction"
        b["llm"] = {"knowledge_cutoff": "2020-01-01",
                    "evidence_start": "2020-01-30"}
        self.assertTrue(any("contaminated" in e for e in P.validate(b)))

    def test_judgment_evidence_strictly_after_cutoff_plus_30(self):
        b = copy.deepcopy(BASE)
        b["contamination_class"] = "judgment"
        b["llm"] = {"knowledge_cutoff": "2020-01-01",
                    "evidence_start": "2020-01-31"}
        self.assertIn("contaminated:judgment-evidence-not-after-cutoff+30d",
                      P.validate(b))
        b["llm"]["evidence_start"] = "2020-02-01"
        self.assertEqual(P.validate(b), [])

    def test_deterministic_needs_no_llm_block(self):
        self.assertEqual(P.validate(BASE), [])


if __name__ == "__main__":
    unittest.main()
