import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import candidate_wire as W
from research.strategy.candidate_wire import ID_FIELDS, candidate_id

TS = 1_800_000_000_000_000_000 - 60 * 10**9


class Wire(unittest.TestCase):
    def rec(self, **kw):
        a = dict(strategy="etf_trend", symbol="VTI", snapshot_ts_ns=TS,
                 entry=250.5, stop=230.0, tp=999.0)
        a.update(kw)
        return W.wire_record(**a)

    def test_shape_and_cid_over_the_wire_strings(self):
        r = self.rec()
        self.assertEqual(set(r), {"schema", "created_ns", "candidate"})
        c = r["candidate"]
        self.assertEqual(len(c), 13)
        self.assertEqual(c["entry_px"], "250.50")
        self.assertEqual(c["cid"],
                         candidate_id(**{k: c[k] for k in ID_FIELDS}))
        self.assertTrue(all(isinstance(v, str) for v in c.values()))

    def test_prices_are_rounded_to_cents(self):
        c = self.rec(entry=250.123, stop=230.999)["candidate"]
        self.assertEqual((c["entry_px"], c["stop_px"]), ("250.12", "231.00"))

    def test_refusals(self):
        for bad in (dict(side="HOLD"), dict(side="SELL"), dict(stop=260.0), dict(tp=200.0),
                    dict(entry=0), dict(stop=-1), dict(symbol="A|B"),
                    dict(snapshot_ts_ns=-1), dict(entry=True)):
            with self.assertRaises(W.WireError):
                self.rec(**bad)

    def test_sell_to_close_ordering(self):
        c = self.rec(side="SELL", stop=260.0, tp=100.0)["candidate"]
        self.assertEqual((c["proposed_side"], c["stop_px"], c["tp_px"]),
                         ("SELL", "260.00", "100.00"))

    def test_line_is_single_compact_json(self):
        line = W.wire_line("etf_trend", "VTI", TS, 250.5, 230.0, 999.0)
        self.assertTrue(line.endswith("\n") and line.count("\n") == 1)
        self.assertEqual(json.loads(line)["schema"], "c1")

    def test_atr_stop(self):
        n = 30
        closes = [100.0 + i * 0.1 for i in range(n)]
        highs = [c + 1.0 for c in closes]
        lows = [c - 1.0 for c in closes]
        stop = W.atr_stop(highs, lows, closes)
        self.assertAlmostEqual(stop, closes[-1] - 3.0 * 2.0, places=6)
        with self.assertRaises(W.WireError):
            W.atr_stop(highs[:10], lows[:10], closes[:10])
        with self.assertRaises(W.WireError):
            W.atr_stop([1000.0] * n, [0.0] * n, [1.0] * n)


if __name__ == "__main__":
    unittest.main()
