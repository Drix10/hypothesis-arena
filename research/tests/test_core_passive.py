import datetime
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import candidate_wire as W
from research.strategy.sleeves import core_passive as C
from ops import emit_candidates as E

NOW = datetime.datetime(2026, 9, 29, 21, 0, tzinfo=datetime.timezone.utc)


def bars(n=40, base=100.0):
    return [(base + i * 0.1 + 1, base + i * 0.1 - 1, base + i * 0.1)
            for i in range(n)]


class Core(unittest.TestCase):
    def test_emits_unheld_symbols_once(self):
        b = {"VTI": bars(), "IEF": bars(base=90.0)}
        lines, keys = C.build(b, {"IEF"}, "2026-09", set(), 5)
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["candidate"]["symbol"], "VTI")
        again, _ = C.build(b, {"IEF"}, "2026-09", set(keys), 5)
        self.assertEqual(again, [])
        nxt, _ = C.build(b, {"IEF"}, "2026-10", set(keys), 5)
        self.assertEqual(len(nxt), 1)

    def test_missing_history_is_skipped_not_guessed(self):
        with self.assertRaises(W.WireError):
            C.build({"VTI": bars(5)}, set(), "2026-09", set(), 5)

    def test_wrapper_is_idempotent_and_writes_lines(self):
        pages = []

        def get(url, headers):
            pages.append(url)
            sym = "VTI" if "symbols=VTI" in url else "IEF"
            return {"bars": {sym: [{"h": h, "l": l, "c": c}
                                   for h, l, c in bars()]}}
        with tempfile.TemporaryDirectory() as d:
            os.environ.setdefault("ALPACA_KEY_ID", "x")
            os.environ.setdefault("ALPACA_SECRET", "y")
            orig = E.fetch_bars
            E.fetch_bars = lambda now: orig(now, http_get=get,
                                            headers={"k": "v"})
            try:
                E.main(["e", d], now=NOW)
                E.main(["e", d], now=NOW)
            finally:
                E.fetch_bars = orig
            with open(os.path.join(d, "candidates.jsonl")) as f:
                self.assertEqual(len(f.readlines()), 2)   # VTI + IEF, once
            self.assertTrue(all("feed=sip" in u for u in pages))


if __name__ == "__main__":
    unittest.main()
