"""End-to-end ETF Trend chain on synthetic bars: prereg, signal, backtest
runner and trial ledger (plan/strategies.md, ETF Trend)."""
import datetime
import json
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import backtest as B
from research.strategy import etf_trend as E
from research.strategy import ledger as L
from research.strategy import margin as M

PREREG_PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                           "etf_trend.json")
START, END = datetime.date(2019, 1, 1), datetime.date(2022, 12, 31)
DOWN = "TLT"


def load_prereg():
    with open(PREREG_PATH, encoding="utf-8") as f:
        return json.load(f)


def make_bars(universe, seed=7):
    """Weekday (open, close) bars; equities drift up, DOWN trends down."""
    r = random.Random(seed)
    syms = sorted(set(universe) | {"SPY", "IEF"})
    px = {s: 100.0 for s in syms}
    out = {s: {} for s in syms}
    d = START
    while d <= END:
        if d.weekday() < 5:
            for s in syms:
                drift = -0.0008 if s == DOWN else 0.0004
                o = px[s]
                px[s] = o * (1.0 + r.gauss(drift, 0.008))
                out[s][d.isoformat()] = (o, px[s])
        d += datetime.timedelta(days=1)
    return out


class EtfTrendChainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pre = load_prereg()
        self.pre["holdout"].update(start=START.isoformat(),
                                   end=END.isoformat())
        self.bars = make_bars(self.pre["universe"])
        self.sessions = sorted(self.bars["SPY"])
        self.terms = M.MarginTerms(margin_rate=0.08)

    def ledger(self, name="ledger.jsonl"):
        return L.TrialLedger(os.path.join(self.tmp.name, name))

    def run_chain(self, ledger, variant=0):
        var = self.pre["variants"][variant]
        fn = E.EtfTrend(self.sessions, self.pre["universe"],
                        long_only=not var["short_side"])
        return B.run_backtest(self.pre, self.bars, fn, ledger,
                              variant=variant, margin=self.terms)

    def test_chain_runs_and_ledgers_the_trial(self):
        led = self.ledger()
        rep = self.run_chain(led)
        self.assertEqual(rep["constraint_set"], "us")
        self.assertEqual(rep["contamination_class"], "deterministic")
        self.assertTrue(rep["seen_window"]["rule"].startswith("seen-window"))
        self.assertIn(rep["verdict"], ("PASS", "FAIL"))
        self.assertIsInstance(rep["failed"], list)
        self.assertEqual([r["kind"] for r in led.rows()], ["open", "close"])
        self.assertLess(rep["trial"]["open_seq"], rep["trial"]["close_seq"])
        self.assertEqual(led.unclosed(), [])

    def test_double_cost_costs_more(self):
        rep = self.run_chain(self.ledger())
        self.assertGreater(rep["cost_usd"]["1.0"], 0.0)
        self.assertGreater(rep["cost_usd"]["2.0"], rep["cost_usd"]["1.0"])

    def test_duplicate_prereg_refused(self):
        led = self.ledger()
        self.run_chain(led)
        with self.assertRaisesRegex(B.BacktestError, "duplicate-prereg"):
            self.run_chain(led)
        self.assertEqual(led.count_trials(), 1)

    def test_report_identical_across_fresh_ledgers(self):
        a = self.run_chain(self.ledger("a.jsonl"))
        b = self.run_chain(self.ledger("b.jsonl"))
        self.assertEqual(a, b)

    def test_long_only_variant_runs(self):
        self.assertFalse(self.pre["variants"][1]["short_side"])
        rep = self.run_chain(self.ledger(), variant=1)
        self.assertIn(rep["verdict"], ("PASS", "FAIL"))
        self.assertGreater(rep["cost_usd"]["1.0"], 0.0)

    def test_prereg_file_keeps_its_holdout(self):
        self.assertEqual(load_prereg()["holdout"]["start"], "2016-01-01")


if __name__ == "__main__":
    unittest.main()
