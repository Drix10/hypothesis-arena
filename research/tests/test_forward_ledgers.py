import datetime
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import forward_ledgers as S

NOW = datetime.datetime(2026, 12, 2, 21, 0, tzinfo=datetime.timezone.utc)


def synth(symbols, start="2025-01-02", n=520, drift=0.0004):
    d = datetime.date.fromisoformat(start)
    dates = []
    while len(dates) < n:
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d += datetime.timedelta(days=1)
    out = {}
    for k, s in enumerate(symbols):
        px, row = 50.0 + k * 10, {}
        for i, dt in enumerate(dates):
            px *= 1 + drift + 0.004 * (((i * 7 + k * 3) % 11) - 5) / 5
            row[dt] = (px, px * 1.001)
        out[s] = row
    return out, dates


class Shadow(unittest.TestCase):
    def setUp(self):
        self.specs = S.sleeve_specs()
        syms = sorted({s for u, _, _ in self.specs.values() for s in u})
        self.prices, self.dates = synth(syms)
        self.fwd = self.dates[300]
        self._old = S.FORWARD_START
        S.FORWARD_START = self.fwd

    def tearDown(self):
        S.FORWARD_START = self._old

    def test_only_forward_sessions_recorded_and_rebased(self):
        u, fac, _ = self.specs["core_passive_v1"]
        rows = S.replay("core_passive_v1", self.prices, fac, u)
        self.assertEqual(rows[0]["date"], self.fwd)
        self.assertAlmostEqual(rows[0]["equity"], S.CASH0, places=2)
        self.assertTrue(all(r["date"] >= self.fwd for r in rows))

    def test_replay_is_deterministic_and_prefix_stable(self):
        u, fac, _ = self.specs["core_passive_v1"]
        full = S.replay("s", self.prices, fac, u)
        cut = {s: {d: v for d, v in p.items() if d <= full[-40]["date"]}
               for s, p in self.prices.items()}
        part = S.replay("s", cut, fac, u)
        for a, b in zip(part, full):  # no look-ahead: earlier rows unchanged
            self.assertAlmostEqual(a["equity"], b["equity"], places=4)

    def test_log_chain_append_once_and_tamper_detected(self):
        u, fac, _ = self.specs["core_passive_v1"]
        rows = S.replay("core", self.prices, fac, u)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "core.jsonl")
            self.assertEqual(S.append_rows(p, [], rows), len(rows))
            have, _ = S.read_log(p)
            self.assertEqual(S.append_rows(p, have, rows), 0)
            with open(p) as f:
                lines = f.read().splitlines()
            r = json.loads(lines[1])
            r["equity"] += 1
            lines[1] = json.dumps(r, sort_keys=True)
            with open(p, "w") as f:
                f.write("\n".join(lines) + "\n")
            with self.assertRaises(ValueError):
                S.read_log(p)

    def test_run_then_verify_and_detects_rewritten_history(self):
        def fake(symbols, now, http_get=None):
            return self.prices
        old = S.fetch_prices
        S.fetch_prices = fake
        try:
            with tempfile.TemporaryDirectory() as d:
                bad, summ = S.run(d, NOW)
                self.assertEqual(bad, [])
                self.assertEqual(set(summ), set(self.specs))
                bad, _ = S.run(d, NOW, verify=True)
                self.assertEqual(bad, [])
                for s in self.prices["VTI"]:  # provider revises history
                    o, c = self.prices["VTI"][s]
                    self.prices["VTI"][s] = (o * 1.3, c * 1.3) if s > self.dates[350] else (o, c)
                bad, _ = S.run(d, NOW, verify=True)
                self.assertTrue(bad)
        finally:
            S.fetch_prices = old

    def test_benchmark_ledgers_are_buy_and_hold_same_schema(self):
        self.assertTrue(set(S.BENCHMARKS) <= set(self.specs))
        self.assertEqual(self.specs[S.BENCH_CASH][0], ["BIL"])
        self.assertEqual(self.specs[S.BENCH_SPY][0], ["SPY"])
        self.assertIn("SPY", self.prices)
        for sid in S.BENCHMARKS:
            u, fac, _ = self.specs[sid]
            rows = S.replay(sid, self.prices, fac, u)
            self.assertEqual(rows[0]["date"], self.fwd)
            self.assertEqual(set(rows[0]), {"date", "sleeve", "equity", "ret",
                                            "target"})
            # one initial allocation in history, never a rebalance target
            px = {s: self.prices[s] for s in u}
            sessions = S.common_sessions(px)
            res = S.portfolio.run(sessions, px, fac(sessions), cash0=S.CASH0)
            self.assertEqual(len(res["weights"]), 1, sid)
            self.assertAlmostEqual(sum(res["weights"][0][1].values()), 1.0)
            self.assertTrue(all(r["target"] is None for r in rows), sid)

    def test_run_writes_benchmark_ledgers(self):
        old = S.fetch_prices
        S.fetch_prices = lambda symbols, now, http_get=None: self.prices
        try:
            with tempfile.TemporaryDirectory() as d:
                bad, summ = S.run(d, NOW)
                self.assertEqual(bad, [])
                for sid in S.BENCHMARKS:
                    self.assertIn(sid, summ)
                    rows, _ = S.read_log(os.path.join(d, "sleeves", sid + ".jsonl"))
                    self.assertTrue(rows)
        finally:
            S.fetch_prices = old

    def test_status_flags_drawdown_states(self):
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sleeves"))
            for name, eqs in (("a", [100000, 90000]), ("b", [100000, 84000]),
                              ("c", [100000, 79000])):
                rows = [{"date": "2026-10-0%d" % (i + 1), "sleeve": name,
                         "equity": e, "ret": 0.0, "target": None}
                        for i, e in enumerate(eqs)]
                S.append_rows(os.path.join(d, "sleeves", name + ".jsonl"), [], rows)
            st = S.write_status(d)
            self.assertEqual([st[k]["state"] for k in "abc"],
                             ["ok", "soft", "hard"])
            with open(os.path.join(d, "sleeves", "status.json")) as f:
                self.assertEqual(json.load(f)["c"]["state"], "hard")


if __name__ == "__main__":
    unittest.main()
