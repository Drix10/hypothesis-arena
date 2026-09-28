import os
import random
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import gates as G


def series(mu, sd, n, seed):
    r = random.Random(seed)
    return [r.gauss(mu, sd) for _ in range(n)]


class T(unittest.TestCase):
    def test_strong_sleeve_passes_and_weak_fails(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        good2 = [x - 0.0006 for x in good]
        cash = [0.0001] * n
        passive = series(0.0003, 0.010, n, 2)
        rep = G.a_gate(good, good2, cash, passive, 1, None, tstat=4.0,
                       transfer_ok=True, participation_ok=True)
        self.assertEqual(rep["failed"], [], rep["failed"])
        self.assertEqual(rep["verdict"], "PASS")
        bad = series(-0.0002, 0.005, n, 3)
        rep = G.a_gate(bad, bad, cash, passive, 1, None, tstat=4.0,
                       transfer_ok=True, participation_ok=True)
        self.assertEqual(rep["verdict"], "FAIL")
        self.assertIn("net_sharpe_ci_lower_gt_0", rep["failed"])

    def test_missing_evidence_fails_closed(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        rep = G.a_gate(good, good, [0.0001] * n, series(0.0003, 0.01, n, 2),
                       1, None)
        self.assertIn("transferability", rep["failed"])
        self.assertIn("participation_caps", rep["failed"])
        self.assertIn("tstat_ge_3_new_signal", rep["failed"])

    def test_many_trials_deflates(self):
        n = 1500
        good = series(0.0006, 0.005, n, 1)
        rep = G.a_gate(good, good, [0.0] * n, series(0.0003, 0.01, n, 2),
                       500, 0.05 ** 2, tstat=4.0, transfer_ok=True,
                       participation_ok=True)
        self.assertIn("dsr_ge_0.95", rep["failed"])

    def test_ai_and_event_conditions(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        rep = G.a_gate(good, good, [0.0] * n, series(0.0003, 0.01, n, 2), 1,
                       None, tstat=4.0, transfer_ok=True,
                       participation_ok=True, is_event_sleeve=True,
                       excluded_event_frac=0.09, ai_component=True)
        self.assertIn("excluded_events_le_5pct", rep["failed"])
        self.assertIn("paired_no_ai_variant_exists", rep["failed"])

    def test_b_gate(self):
        ok = G.b_gate("daily", 70, 40, 0, [0.001] * 70, -0.05, 0.2, 100.0,
                      90.0, 0)
        self.assertEqual(ok["verdict"], "PASS")
        bad = G.b_gate("daily", 50, 40, 0, [0.001] * 50, 0.5, 0.6, 100.0,
                       50.0, 1)
        self.assertEqual(set(bad["failed"]), {
            "min_sessions_60", "inside_tracking_band",
            "modeled_cost_within_1.5x_live", "zero_unexplained_anomalies"})
        m = G.b_gate("monthly", 0, 0, 3, [0.01], -0.1, 0.1, 1.0, 1.0, 0)
        self.assertEqual(m["verdict"], "PASS")
        self.assertIn('"gate": "B"', G.render(m))
        with self.assertRaises(ValueError):
            G.b_gate("weekly", 0, 0, 0, [], 0, 0, 0, 0, 0)


if __name__ == "__main__":
    unittest.main()
