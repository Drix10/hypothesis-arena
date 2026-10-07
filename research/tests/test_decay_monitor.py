import datetime
import json
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import decay_monitor as D
from ops import forward_eval as E
from ops import forward_ledgers as S

SID = "alpha"
BOOT = 200
_SAVED = {}


def setUpModule():
    _SAVED.update(E.MAPPING)
    E.MAPPING[SID] = (S.BENCH_SPY, "test family")


def tearDownModule():
    E.MAPPING.clear()
    E.MAPPING.update(_SAVED)


def month_ends(n, start=(2026, 9)):
    """One row per month (the rebase row first) plus a partial trailing month."""
    y, m = start
    out = []
    for _ in range(n + 2):
        out.append(datetime.date(y, m, 28).isoformat())
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def write(d, sid, rets):
    rows, eq = [], S.CASH0
    for i, (dt, r) in enumerate(zip(month_ends(len(rets) - 2), rets)):
        r = 0.0 if i == 0 else r
        eq *= 1.0 + r
        rows.append({"date": dt, "strategy": sid, "equity": round(eq, 4),
                     "ret": r, "target": None})
    os.makedirs(os.path.join(d, "ledgers"), exist_ok=True)
    S.append_rows(os.path.join(d, "ledgers", sid + ".jsonl"), [], rows)


def series(n, seed, mu, sd=0.01):
    rng = random.Random(seed)
    return [mu + rng.gauss(0, sd) for _ in range(n)]


def build(d, strat, expected=0.01, n=None):
    n = n or len(strat)
    write(d, S.BENCH_CASH, [0.0] * n)
    spy = series(n, 1, 0.005)
    write(d, S.BENCH_SPY, spy)
    write(d, SID, strat)
    os.makedirs(os.path.join(d, "ledgers"), exist_ok=True)
    if expected is not None:
        with open(os.path.join(d, "ledgers", D.EXPECTED_FILE), "w") as f:
            json.dump({SID: expected}, f)


class DecayMonitor(unittest.TestCase):
    def run_one(self, strat, **kw):
        with tempfile.TemporaryDirectory() as d:
            build(d, strat, **kw)
            res = D.write_decay(d, boot_b=BOOT)
            with open(os.path.join(d, "ledgers", D.OUT_FILE)) as f:
                self.assertEqual(json.load(f), res)
        self.assertEqual(sorted(res), [SID])
        return res[SID]

    def test_stable_series_no_signal(self):
        e = self.run_one(series(40, 2, 0.012, 0.01), expected=0.01)
        self.assertEqual((e["state"], e["signal"]), ("monitored", "none"))
        self.assertEqual(e["months"], D.WINDOW_MONTHS)
        self.assertIn("DECAY NONE", e["line"])

    def test_decaying_series_pauses(self):
        strat = series(24, 2, 0.012) + series(16, 3, -0.004)
        e = self.run_one(strat, expected=0.012)
        self.assertEqual(e["signal"], "pause")
        self.assertTrue(e["cusum_tripped"])

    def test_negative_alpha_demotes(self):
        spy = series(40, 1, 0.005)
        strat = [0.0] + [r - 0.04 + 0.0005 * (i % 3) for i, r in enumerate(spy[1:])]
        e = self.run_one(strat, expected=0.0)
        self.assertEqual(e["signal"], "demote")
        self.assertLess(e["alpha_ci"][1], 0.0)

    def test_short_history_fails_closed(self):
        e = self.run_one(series(20, 2, 0.012))
        self.assertEqual((e["state"], e["signal"]), ("insufficient", "none"))
        self.assertTrue(e["reason"].startswith("short-history"))

    def test_missing_expectation_fails_closed(self):
        e = self.run_one(series(40, 2, -0.02), expected=None)
        self.assertEqual((e["state"], e["signal"], e["reason"]),
                         ("insufficient", "none", "no-expectation"))

    def test_missing_benchmark_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            write(d, S.BENCH_CASH, [0.0] * 40)
            write(d, SID, series(40, 2, 0.01))
            res = D.evaluate(d, boot_b=BOOT)
        self.assertEqual(res[SID]["reason"], "no-benchmark")

    def test_broken_chain_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            build(d, series(40, 2, 0.01))
            p = os.path.join(d, "ledgers", SID + ".jsonl")
            with open(p) as f:
                txt = f.read().replace('"ret": 0.0,', '"ret": 0.5,', 1)
            with open(p, "w") as f:
                f.write(txt)
            res = D.evaluate(d, boot_b=BOOT)
        self.assertEqual((res[SID]["state"], res[SID]["signal"]),
                         ("insufficient", "none"))

    def test_monitor_line(self):
        from ops import monitor
        out = []
        with tempfile.TemporaryDirectory() as d:
            build(d, series(40, 2, 0.012))
            D.write_decay(d, boot_b=BOOT)
            monitor.panel_ledgers(d, out)
        self.assertTrue(any("DECAY" in ln for ln in out))


if __name__ == "__main__":
    unittest.main()
