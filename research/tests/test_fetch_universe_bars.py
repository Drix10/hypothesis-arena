import datetime
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import bar_loader, fetch_universe_bars as F

NOW = datetime.datetime(2026, 9, 28, 20, 0, tzinfo=datetime.timezone.utc)
ENV = {"ALPACA_KEY_ID": "k", "ALPACA_SECRET": "s"}


class Transport:
    def __init__(self):
        self.calls = []

    def __call__(self, url, headers):
        sym = url.split("symbols=")[1].split("&")[0]
        self.calls.append(sym)
        return {"bars": {sym: [{"t": "2026-09-25T04:00:00Z", "o": 1.0,
                                "h": 2.0, "l": 1.0, "c": 2.0, "v": 1}]},
                "next_page_token": None}


class FetchUniverseTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = os.path.join(self._tmp.name, "data")
        self.syms = os.path.join(self._tmp.name, "syms.txt")
        with open(self.syms, "w") as f:
            f.write("aaa  # comment\n\nSPY\n")
        self.lines = []

    def run_cli(self, *extra, transport=None, env=ENV):
        argv = [self.syms, "--start", "2026-01-01", "--end", "2026-09-28",
                "--out", self.out, *extra]
        return F.main(argv, env=env, now=NOW, log=self.lines.append,
                      http_get=transport)

    def test_refuses_without_yes_and_prints_estimate(self):
        t = Transport()
        self.assertEqual(self.run_cli(transport=t), 2)
        self.assertEqual(t.calls, [])
        self.assertFalse(os.path.exists(self.out))
        self.assertIn("5 symbols, 0 current, 5 to fetch: about 5 requests, "
                      "0.0 minutes", self.lines[0])

    def test_refuses_without_credentials(self):
        t = Transport()
        self.assertEqual(self.run_cli("--yes", transport=t, env={}), 2)
        self.assertEqual(t.calls, [])

    def test_fetch_loads_and_resumes(self):
        t = Transport()
        self.assertEqual(self.run_cli("--yes", transport=t), 0)
        self.assertEqual(sorted(t.calls), ["AAA", "BIL", "IEF", "SPY", "VTI"])
        got = bar_loader.load_prices(self.out, ["AAA", "VTI"], "2026-01-01",
                                     "2026-09-28")
        self.assertEqual(got["AAA"], {"2026-09-25": (1.0, 2.0)})
        t2 = Transport()
        self.assertEqual(self.run_cli("--yes", transport=t2), 0)
        self.assertEqual(t2.calls, [])
        self.assertTrue(any("5 current, 0 to fetch" in x for x in self.lines))

    def test_stale_symbol_is_refetched(self):
        self.run_cli("--yes", transport=Transport())
        t = Transport()
        F.main([self.syms, "--start", "2026-01-01", "--out", self.out,
                "--yes", "--end", "2026-10-28"], env=ENV,
               now=NOW + datetime.timedelta(days=30), log=self.lines.append,
               http_get=t)
        self.assertEqual(len(t.calls), 5)


if __name__ == "__main__":
    unittest.main()
