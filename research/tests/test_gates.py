import datetime
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
    def test_strong_strategy_passes_and_weak_fails(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        good2 = [x - 0.0006 for x in good]
        cash = [0.0001] * n
        passive = series(0.0003, 0.010, n, 2)
        rep = G.backtest_gate(good, good2, cash, passive, 1, None, tstat=4.0,
                       transfer_ok=True, participation_ok=True)
        self.assertEqual(rep["failed"], [], rep["failed"])
        self.assertEqual(rep["verdict"], "PASS")
        bad = series(-0.0002, 0.005, n, 3)
        rep = G.backtest_gate(bad, bad, cash, passive, 1, None, tstat=4.0,
                       transfer_ok=True, participation_ok=True)
        self.assertEqual(rep["verdict"], "FAIL")
        self.assertIn("net_sharpe_ci_lower_gt_0", rep["failed"])

    def test_missing_evidence_fails_closed(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        rep = G.backtest_gate(good, good, [0.0001] * n, series(0.0003, 0.01, n, 2),
                       1, None)
        self.assertIn("transferability", rep["failed"])
        self.assertIn("participation_caps", rep["failed"])
        self.assertIn("tstat_ge_3_new_signal", rep["failed"])

    def test_many_trials_deflates(self):
        n = 1500
        good = series(0.0006, 0.005, n, 1)
        rep = G.backtest_gate(good, good, [0.0] * n, series(0.0003, 0.01, n, 2),
                       500, 0.05 ** 2, tstat=4.0, transfer_ok=True,
                       participation_ok=True)
        self.assertIn("dsr_ge_0.95", rep["failed"])

    def test_ai_and_event_conditions(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        rep = G.backtest_gate(good, good, [0.0] * n, series(0.0003, 0.01, n, 2), 1,
                       None, tstat=4.0, transfer_ok=True,
                       participation_ok=True, is_event_strategy=True,
                       excluded_event_frac=0.09, model_component=True)
        self.assertIn("excluded_events_le_5pct", rep["failed"])
        self.assertIn("paired_no_model_variant_exists", rep["failed"])

    def test_sharpe_conditions_use_excess_over_cash(self):
        n = 1500
        r = random.Random(7)
        cash = [0.00016] * n            # T-bill yield only, no skill
        noise = [r.gauss(0.0, 0.0005) for _ in range(n)]
        strategy = [c + x for c, x in zip(cash, noise)]
        rep = G.backtest_gate(strategy, strategy, cash, series(0.0003, 0.01, n, 2), 1,
                       None, tstat=4.0, transfer_ok=True,
                       participation_ok=True)
        self.assertIn("net_sharpe_ci_lower_gt_0", rep["failed"])
        self.assertIn("excess_over_cash_ci_lower_gt_0", rep["failed"])

    def test_length_mismatch_is_an_error_not_a_truncation(self):
        n = 100
        x = series(0.001, 0.005, n, 1)
        with self.assertRaises(G.GateError):
            G.backtest_gate(x, x[:5], [0.0] * n, x, 1, None)
        with self.assertRaises(G.GateError):
            G.backtest_gate(x, x, [0.0] * 50, x, 1, None)

    def test_prereg_decision_thresholds_are_enforced(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        good2 = [x - 0.0006 for x in good]
        kw = dict(tstat=4.0, transfer_ok=True, participation_ok=True)
        dec = dict(min_net_sharpe=0.5, max_drawdown_pct=25.0,
                   min_cost_multiple=2.0)
        rep = G.backtest_gate(good, good2, [0.0001] * n, series(0.0003, 0.01, n, 2),
                       1, None, decision=dec, cost_multiple=2.0, **kw)
        self.assertEqual(rep["failed"], [])
        rep = G.backtest_gate(good, good2, [0.0001] * n, series(0.0003, 0.01, n, 2),
                       1, None, decision=dict(dec, min_net_sharpe=50.0),
                       cost_multiple=2.0, **kw)
        self.assertIn("net_sharpe_ge_prereg_min", rep["failed"])
        rep = G.backtest_gate(good, good2, [0.0001] * n, series(0.0003, 0.01, n, 2),
                       1, None, decision=dec, cost_multiple=None, **kw)
        self.assertIn("cost_multiple_ge_prereg", rep["failed"])

    def test_breadth_decades_and_correlation(self):
        n = 40
        dates = ["%d-01-%02d" % (1999 + i // 20, i % 20 + 1) for i in range(n)]
        ret = [0.001 if i % 2 else -0.0005 for i in range(n)]
        r = random.Random(5)
        other = [r.gauss(0, 0.01) for _ in range(n)]
        b = G.breadth(ret, [0.0] * n, dates=dates,
                      promoted={"same": ret, "other": other})
        dec = b["net_alpha_by_decade"]
        self.assertEqual([dec["1990"]["n"], dec["2000"]["n"]], [20, 20])
        self.assertAlmostEqual(dec["1990"]["annual_net_alpha"], 0.00025 * 252)
        self.assertAlmostEqual(b["promoted_correlation"]["same"], 1.0)
        self.assertLess(abs(b["promoted_correlation"]["other"]), 0.5)

    def test_effective_signals(self):
        self.assertAlmostEqual(G.effective_signals([[1, 1], [1, 1]]), 1.0)
        self.assertAlmostEqual(G.effective_signals([[1, 0], [0, 1]]), 2.0)
        r = random.Random(11)
        a = [r.gauss(0, 0.01) for _ in range(5000)]
        c = [r.gauss(0, 0.01) for _ in range(5000)]
        same = G.breadth(a, [0.0] * 5000, promoted={"a": a})
        self.assertAlmostEqual(same["effective_signals"], 1.0)
        ind = G.breadth(a, [0.0] * 5000, promoted={"c": c})
        self.assertAlmostEqual(ind["effective_signals"], 2.0, places=1)

    def test_factor_alpha_recovers_known_alpha(self):
        n = 300
        r = random.Random(3)
        start = datetime.date(2001, 1, 1)
        dates = [(start + datetime.timedelta(days=i)).isoformat()
                 for i in range(n)]
        rows, ret = [], []
        for d in dates:
            f = {k: r.gauss(0, 0.01) for k in G.FACTOR_NAMES}
            f["RF"] = 0.0001
            rows.append((d, f))
            ret.append(0.0003 + 0.0001 + 0.8 * f["Mkt-RF"] + 0.3 * f["HML"]
                       - 0.2 * f["Mom"])
        out = G.breadth(ret, [0.0] * n, dates=dates, factors=rows)["factor_alpha"]
        self.assertAlmostEqual(out["alpha"], 0.0003, places=9)
        self.assertAlmostEqual(out["loadings"]["Mkt-RF"], 0.8, places=6)
        self.assertEqual(out["n"], n)

    def test_breadth_inputs_fail_closed(self):
        x = series(0.001, 0.005, 10, 1)
        with self.assertRaises(G.GateError):
            G.breadth(x, [0.0] * 10, promoted={"short": x[:5]})
        with self.assertRaises(G.GateError):
            G.breadth(x, [0.0] * 10, factors=[])
        with self.assertRaises(G.GateError):
            G.breadth(x, [0.0] * 10, promoted={"flat": [0.0] * 10})

    def test_breadth_is_additive_in_the_gate_report(self):
        n = 1500
        good = series(0.0012, 0.005, n, 1)
        kw = dict(tstat=4.0, transfer_ok=True, participation_ok=True)
        base = G.backtest_gate(good, good, [0.0001] * n, good, 1, None, **kw)
        rep = G.backtest_gate(good, good, [0.0001] * n, good, 1, None,
                              promoted={"p": series(0.0, 0.01, n, 9)}, **kw)
        self.assertNotIn("breadth", base)
        self.assertEqual({k: v for k, v in rep.items() if k != "breadth"}, base)
        self.assertIn("effective_signals", rep["breadth"])

    def test_render_is_valid_json_with_infinite_values(self):
        import json
        json.loads(G.render({"need": float("inf"), "x": [float("nan")]}))

    def test_shadow_gate_flags_understated_modeled_cost(self):
        base = dict(kind="daily", sessions=100, trades=40, rebalances=0,
                    shadow_ret=[0.01], band_lo=0.0, band_hi=0.05,
                    unexplained_anomalies=0)
        ok = G.shadow_gate(modeled_cost_usd=100, live_cost_est_usd=100, **base)
        self.assertEqual(ok["failed"], [])
        low = G.shadow_gate(modeled_cost_usd=1, live_cost_est_usd=100, **base)
        self.assertIn("modeled_cost_within_1.5x_live", low["failed"])
        zero = G.shadow_gate(modeled_cost_usd=0, live_cost_est_usd=100, **base)
        self.assertIn("modeled_cost_within_1.5x_live", zero["failed"])

    def test_shadow_gate(self):
        ok = G.shadow_gate("daily", 70, 40, 0, [0.001] * 70, -0.05, 0.2, 100.0,
                      90.0, 0)
        self.assertEqual(ok["verdict"], "PASS")
        bad = G.shadow_gate("daily", 50, 40, 0, [0.001] * 50, 0.5, 0.6, 100.0,
                       50.0, 1)
        self.assertEqual(set(bad["failed"]), {
            "min_sessions_60", "inside_tracking_band",
            "modeled_cost_within_1.5x_live", "zero_unexplained_anomalies"})
        m = G.shadow_gate("monthly", 0, 0, 3, [0.01], -0.1, 0.1, 1.0, 1.0, 0)
        self.assertEqual(m["verdict"], "PASS")
        self.assertIn('"gate": "shadow"', G.render(m))
        with self.assertRaises(ValueError):
            G.shadow_gate("weekly", 0, 0, 0, [], 0, 0, 0, 0, 0)


if __name__ == "__main__":
    unittest.main()
