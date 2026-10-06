"""End-to-end Connected Drift chain on synthetic data: prereg, composite
target, ETF Trend exposure scaler, backtest runner and trial ledger, with the
component correlation matrix and effective signal count reported before any
Sharpe (plan/strategies.md, Connected Drift)."""
import datetime
import json
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import backtest as B
from research.strategy import composite as C
from research.strategy import etf_trend as E
from research.strategy import ledger as L
from research.strategy import margin as M

PREREG_PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                           "connected_drift.json")
START, END = datetime.date(2019, 1, 1), datetime.date(2022, 12, 31)
N = 20
SYMS = ["S%02d" % i for i in range(N)]
NAMES = ("link", "filing", "insider")
INLINE_PREREG = {
    "schema": "prereg",
    "experiment_id": "connected_drift_chain",
    "family": "connected_drift",
    "created": "2026-10-04",
    "constraint_set": "us",
    "contamination_class": "deterministic",
    "hypothesis": "Synthetic chain check of the composite target.",
    "strategy": "connected_drift",
    "universe": SYMS + ["SPY", "IEF", "BIL"],
    "signal": "Equal-weighted link, filing change and insider z, gated and "
              "scaled by the ETF Trend exposure.",
    "variants": [{"name": "long_short", "short_side": True}],
    "cost_model": "costs",
    "split": {"scheme": "walk_forward", "n_splits": 2,
              "label_horizon_days": 21, "embargo_days": 0},
    "holdout": {"start": START.isoformat(), "end": END.isoformat(),
                "rule": "seen-window: synthetic data"},
    "decision": {"min_net_sharpe": 1e-06, "max_drawdown_pct": 20.0,
                 "min_cost_multiple": 2.0, "min_days": 1,
                 "new_signal_tstat_min": 3.0},
}


def load_prereg():
    if os.path.exists(PREREG_PATH):
        with open(PREREG_PATH, encoding="utf-8") as f:
            return json.load(f)
    return json.loads(json.dumps(INLINE_PREREG))


def make_bars(syms, seed=11):
    """Weekday (open, close) bars; SPY drifts up so the trend state is on."""
    r = random.Random(seed)
    px = {s: 100.0 for s in syms}
    out = {s: {} for s in syms}
    d = START
    while d <= END:
        if d.weekday() < 5:
            for s in syms:
                o = px[s]
                px[s] = o * (1.0 + r.gauss(0.0005 if s == "SPY" else 0.0002,
                                           0.008))
                out[s][d.isoformat()] = (o, px[s])
        d += datetime.timedelta(days=1)
    return out


def edge(i, j):
    return {"src_cik": "C%02d" % i, "dst_cik": "C%02d" % j,
            "source": "supply_chain", "weight": 1.0, "valid_from": 20180101,
            "valid_to": None, "known_at": 20180101}


def inputs(date):
    """As-of data for `date`, seeded by the date so repeated calls agree."""
    r = random.Random(date)
    day = datetime.date.fromisoformat(date)
    prior = (day - datetime.timedelta(days=5)).isoformat()
    return {
        "market_cap": {s: 2e9 * (1 + (i * 5) % 13) for i, s in enumerate(SYMS)},
        "beta": {s: 0.8 + 0.05 * ((i * 7) % 11) for i, s in enumerate(SYMS)},
        "returns": {s: r.gauss(0.0, 0.05) for s in SYMS},
        "industry": {s: "AB"[i % 2] for i, s in enumerate(SYMS)},
        "market_return": 0.01,
        "industry_returns": {"A": 0.02, "B": -0.01},
        "ciks": {"C%02d" % i: s for i, s in enumerate(SYMS)},
        "edges": [edge(i, (i + k) % N) for i in range(N) for k in (1, 3)],
        "filings": {s: [{"known_at": prior + "T10:00:00-04:00",
                         "delta": r.gauss(0.0, 1.0)}] for s in SYMS[:16]},
        "events": [{"date": prior, "symbol": s, "opportunistic": True,
                    "value": 1e5 * r.uniform(1, 8), "entry": prior}
                   for s in r.sample(SYMS, 8)],
        "vetoes": {n: (lambda s: False) for n in C.VETOES},
    }


class Exposure:
    """ETF Trend multiplier carrying its own rate-limit state."""

    def __init__(self, bars):
        self.bars = bars
        self.prev = None

    def __call__(self, date):
        self.prev = E.exposure_scale(self.bars, date, self.prev, "SPY")
        return self.prev


class ConnectedDriftChainTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.pre = load_prereg()
        self.pre["holdout"].update(start=START.isoformat(),
                                   end=END.isoformat())
        self.bars = make_bars(sorted(set(self.pre["universe"])
                                     | {"SPY", "IEF", "BIL"} | set(SYMS)))
        self.sessions = sorted(self.bars["SPY"])
        self.month_ends = [a for a, b in zip(self.sessions, self.sessions[1:])
                           if a[:7] != b[:7]]

    def target_fn(self):
        return C.CompositeTarget(self.sessions, inputs, 4,
                                 exposure=Exposure(self.bars))

    def run_chain(self, name="ledger.jsonl"):
        led = L.TrialLedger(os.path.join(self.tmp.name, name))
        rep = B.run_backtest(self.pre, self.bars, self.target_fn(), led,
                             margin=M.MarginTerms(margin_rate=0.08))
        return led, rep

    def correlation(self):
        cols = {n: [] for n in NAMES}
        for d in self.month_ends:
            comps = C.components(inputs(d), d)
            for s in SYMS:
                for n in NAMES:
                    cols[n].append(comps[n].get(s))
        corr = C.component_correlation([cols[n] for n in NAMES])
        return corr, C.effective_signal_count(corr)

    def test_chain_reports_signal_structure_before_sharpe(self):
        corr, eff = self.correlation()
        print("component correlation (%s)" % ", ".join(NAMES))
        for n, row in zip(NAMES, corr):
            print("  %-7s %s" % (n, " ".join("%+.3f" % v for v in row)))
        print("effective signal count: %.3f" % eff)
        led, rep = self.run_chain()
        print("sharpe: %s verdict: %s" % (rep["sharpe"], rep["verdict"]))
        self.assertGreater(eff, 1.0)
        self.assertLessEqual(eff, len(NAMES))
        self.assertEqual(rep["constraint_set"], "us")
        self.assertIn(rep["verdict"], ("PASS", "FAIL"))
        self.assertEqual([r["kind"] for r in led.rows()], ["open", "close"])
        self.assertLess(rep["trial"]["open_seq"], rep["trial"]["close_seq"])
        self.assertEqual(led.unclosed(), [])
        self.assertGreater(rep["cost_usd"]["1.0"], 0.0)

    def test_exposure_scaler_sizes_the_target(self):
        d = self.month_ends[-1]
        full = C.target(inputs(d), d, 4, exposure=1.0)
        half = C.target(inputs(d), d, 4, exposure=0.5)
        self.assertTrue(full)
        self.assertEqual({k: v / 2 for k, v in full.items()}, half)
        off = C.target(inputs(d), d, 4, exposure=0.0)
        self.assertEqual(set(off), set(full))
        self.assertFalse(any(off.values()))

    def test_duplicate_prereg_refused(self):
        led, _ = self.run_chain()
        with self.assertRaisesRegex(B.BacktestError, "duplicate-prereg"):
            B.run_backtest(self.pre, self.bars, self.target_fn(), led,
                           margin=M.MarginTerms(margin_rate=0.08))
        self.assertEqual(led.count_trials(), 1)

    def test_report_identical_across_fresh_ledgers(self):
        self.assertEqual(self.run_chain("a.jsonl")[1],
                         self.run_chain("b.jsonl")[1])


if __name__ == "__main__":
    unittest.main()
