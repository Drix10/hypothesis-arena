import copy
import datetime
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import backtest as B
from research.strategy import ledger as L
from research.strategy import prereg as P

PREREG = {
    "schema": "prereg", "experiment_id": "etf-trend",
    "family": "trend", "hypothesis": "ETF trend persists net of cost",
    "strategy": "etf_trend", "universe": ["SPY", "IEF"],
    "signal": "sma200", "variants": [{"n": 100}, {"n": 200}],
    "cost_model": "costs",
    "split": {"scheme": "walk_forward", "n_splits": 4,
              "label_horizon_days": 5, "embargo_days": 5},
    "holdout": {"start": "2021-01-01", "end": "2021-12-31",
                "rule": "last 3y or 25%"},
    "decision": {"min_net_sharpe": 0.5, "max_drawdown_pct": 20,
                 "min_cost_multiple": 2, "min_days": 20,
                 "new_signal_tstat_min": 3.0},
    "created": "2020-06-01",
    "constraint_set": "us", "contamination_class": "deterministic",
}


def bars(seed=1):
    """Weekday bars across 2020-2022 for three symbols; the out-of-window
    years use a different drift so a leak would change the result."""
    r = random.Random(seed)
    out = {s: {} for s in ("SPY", "IEF", "QQQ")}
    px = {s: 100.0 for s in out}
    d = datetime.date(2020, 1, 1)
    while d < datetime.date(2023, 1, 1):
        if d.weekday() < 5:
            for s in out:
                o = px[s]
                px[s] = o * (1.0 + r.gauss(0.0004, 0.008))
                out[s][d.isoformat()] = (o, px[s])
        d += datetime.timedelta(days=1)
    return out


def rotate(date, closes):
    month = int(date[5:7])
    return {"SPY": 0.5, "QQQ": 0.5} if month % 2 else {"IEF": 1.0}


def hold(date, closes):
    return {"SPY": 1.0} if len(closes["SPY"]) == 1 else None


class T(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = os.path.join(self.tmp.name, "ledger.jsonl")
        self.led = L.TrialLedger(self.path)

    def test_invalid_prereg_refused_before_ledger(self):
        bad = copy.deepcopy(PREREG)
        del bad["holdout"]
        with self.assertRaises(P.PreregError):
            B.run_backtest(bad, bars(), hold, self.led)
        self.assertFalse(os.path.exists(self.path))

    def test_failing_gate_still_ledgered_and_closed(self):
        rep = B.run_backtest(PREREG, bars(), hold, self.led)
        self.assertEqual(rep["verdict"], "FAIL")
        self.assertIn("transferability", rep["failed"])
        rows = self.led.rows()
        self.assertEqual([r["kind"] for r in rows], ["open", "close"])
        self.assertEqual(rows[0]["prereg_hash"], rep["prereg_hash"])
        self.assertEqual(rows[1]["verdict"], "fail")
        self.assertEqual(rep["trial"]["open_seq"], 0)
        self.assertEqual(self.led.unclosed(), [])

    def test_duplicate_prereg_refused_new_variant_allowed(self):
        B.run_backtest(PREREG, bars(), hold, self.led)
        with self.assertRaises(B.BacktestError):
            B.run_backtest(PREREG, bars(), hold, self.led)
        self.assertEqual(self.led.count_trials(), 1)
        rep = B.run_backtest(PREREG, bars(), hold, self.led, variant=1,
                              sr_var=0.01)
        self.assertEqual(rep["n_trials"], 2)
        with self.assertRaises(B.BacktestError):
            B.run_backtest(PREREG, bars(), hold, self.led, variant=5)

    def test_double_cost_run_costs_more(self):
        rep = B.run_backtest(PREREG, bars(), rotate, self.led)
        self.assertGreater(rep["cost_usd"]["1.0"], 0.0)
        self.assertGreater(rep["cost_usd"]["2.0"], rep["cost_usd"]["1.0"])

    def test_labels_and_seen_window_carried(self):
        rep = B.run_backtest(PREREG, bars(), hold, self.led)
        self.assertEqual(rep["contamination_class"], "deterministic")
        self.assertEqual(rep["constraint_set"], "us")
        self.assertNotIn("seen_window", rep)
        seen = copy.deepcopy(PREREG)
        seen["holdout"]["rule"] = "seen-window 2021"
        rep = B.run_backtest(seen, bars(), hold, self.led, sr_var=0.01)
        self.assertEqual(rep["seen_window"]["rule"], "seen-window 2021")
        self.assertIn("net_alpha_by_decade", rep["breadth"])

    def test_identical_input_identical_output(self):
        other = L.TrialLedger(os.path.join(self.tmp.name, "other.jsonl"))
        a = B.run_backtest(PREREG, bars(), rotate, self.led)
        b = B.run_backtest(PREREG, bars(), rotate, other)
        self.assertEqual(a, b)

    def test_only_holdout_window_is_used(self):
        seen = []

        def spy(date, closes):
            seen.append(date)
            return hold(date, closes)
        B.run_backtest(PREREG, bars(), spy, self.led)
        self.assertEqual(min(seen), "2021-01-01")
        self.assertLessEqual(max(seen), "2021-12-31")

    def test_crash_after_registration_closes_trial(self):
        def boom(date, closes):
            raise RuntimeError("x")
        with self.assertRaises(RuntimeError):
            B.run_backtest(PREREG, bars(), boom, self.led)
        rows = self.led.rows()
        self.assertEqual(rows[-1]["verdict"], "crashed")
        self.assertEqual(self.led.unclosed(), [])


if __name__ == "__main__":
    unittest.main()
