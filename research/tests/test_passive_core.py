import datetime
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import passive_core as C
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
        self.assertEqual(C.build({"VTI": bars(5), "IEF": []}, set(),
                                 "2026-09", set(), 5), ([], []))

    def test_wrapper_writes_once_per_month(self):
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

    def test_month_key_is_new_york_time_and_end_respects_sip_delay(self):
        # 2026-10-01 00:05 UTC is still 2026-09-30 evening in New York.
        late = datetime.datetime(2026, 10, 1, 0, 5,
                                 tzinfo=datetime.timezone.utc)
        seen = []

        def get(url, headers):
            seen.append(url)
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
                E.main(["e", d], now=late)
            finally:
                E.fetch_bars = orig
            with open(os.path.join(d, "emitted.json")) as f:
                keys = json.load(f)
            self.assertTrue(all(k.endswith(":2026-09") for k in keys), keys)
        self.assertTrue(all("end=2026-10-01T00%3A05" not in u for u in seen))

    def test_require_open_refuses_when_closed(self):
        with tempfile.TemporaryDirectory() as d:
            os.environ.setdefault("ALPACA_KEY_ID", "x")
            os.environ.setdefault("ALPACA_SECRET", "y")
            rc = E.main(["e", d, "--require-open"], now=NOW,
                        is_open=lambda: False)
            self.assertEqual(rc, 3)
            self.assertFalse(os.path.exists(os.path.join(d, "candidates.jsonl")))

    def test_transient_error_is_retried(self):
        calls = []

        def flaky(url, headers):
            calls.append(1)
            if len(calls) < 3:
                raise OSError("reset")
            return {"ok": True}
        orig_sleep, E.time.sleep = E.time.sleep, lambda s: None
        try:
            self.assertEqual(E.retrying(flaky)("u", {}), {"ok": True})
        finally:
            E.time.sleep = orig_sleep
        self.assertEqual(len(calls), 3)


if __name__ == "__main__":
    unittest.main()
