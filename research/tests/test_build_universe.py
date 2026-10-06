import datetime
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import build_universe as B
from research.strategy import fetch_universe_bars, sip_fetch

AS_OF = datetime.date(2026, 9, 28)
# cik, symbol, market cap, close, volume
FIRMS = (
    (1, "BIG", 900e9, 100.0, 1_000_000),
    (2, "OKAY", 5e9, 20.0, 1_000_000),
    (3, "MID", 7e8, 20.0, 1_000_000),
    (4, "SMALL", 1e8, 20.0, 1_000_000),
    (5, "PENNY", 5e9, 2.0, 1_000_000),
    (6, "THIN", 5e9, 20.0, 100),
    (7, "NOBAR", 5e9, 20.0, 1_000_000),
    (8, "NOCAP", None, 20.0, 1_000_000),
    (9, "NOFILE", 5e9, 20.0, 1_000_000),
)
CIKS = {"%010d" % c: s for c, s, *_ in FIRMS}
INDEX = "".join("10-K        %s   %d   20260301   edgar/data/%d/x.txt\n"
                % (s, c, c) for c, s, *_ in FIRMS if s != "NOFILE")


def write_bars(outdir, sym, close, vol, end="2026-09-25"):
    day = datetime.date.fromisoformat(end)
    rows = []
    for i in range(70):
        d = day - datetime.timedelta(days=i)
        rows.append({"t": d.isoformat() + "T04:00:00Z", "o": close,
                     "h": close, "l": close, "c": close, "v": vol})
    rows.reverse()
    q = {"start": rows[0]["t"], "end": "2026-09-26T00:00:00Z",
         "adjustment": "split"}
    path, man = sip_fetch.dataset_paths(outdir, sym, "bars", "1Day", "split")
    sip_fetch._atomic_write(path, sip_fetch.serialize(rows))
    m = sip_fetch.manifest(sym, "bars", q, rows)
    sip_fetch._atomic_write(man, json.dumps(m).encode())


def reference():
    caps = {s: [{"known_at": "2026-06-01", "value": cap}]
            for _, s, cap, *_ in FIRMS if cap is not None}
    caps["OKAY"].append({"known_at": "2026-09-28", "value": 1e6})
    return {"through": "2026-09-27",
            "data": {"ciks": CIKS, "industry": {}, "market_cap": caps,
                     "beta": {}}}


class BuildUniverseTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name
        self.filers = os.path.join(self.dir, "form.idx")
        with open(self.filers, "w") as f:
            f.write(INDEX)
        for _, s, _, close, vol in FIRMS:
            if s != "NOBAR":
                write_bars(self.dir, s, close, vol)
        with open(os.path.join(self.dir, "reference.json"), "w") as f:
            json.dump(reference(), f)
        self.lines = []

    def run_cli(self):
        with mock.patch.object(B, "EXCLUDE_LARGEST", 1):
            return B.main(["--filers", self.filers,
                           "--as-of", "2026-09-28", "--data", self.dir], log=self.lines.append)

    def symbols(self):
        return fetch_universe_bars.read_symbols(
            os.path.join(self.dir, "universe_symbols.txt"))

    def test_all_filters(self):
        self.assertEqual(self.run_cli(), 0)
        # OKAY's 1e6 cap entry is dated as_of, so not yet known.
        self.assertEqual(self.symbols(),
                         ["BIL", "IEF", "MID", "OKAY", "SPY", "VTI"])
        with open(os.path.join(self.dir, "universe_manifest.json")) as f:
            m = json.load(f)
        self.assertEqual(m["counts"], {
            "listed_10k_filers": 8, "no_market_cap": 1, "below_cap": 1,
            "largest_excluded": 1, "no_current_bars": 1, "below_price": 1,
            "below_dollar_volume": 1, "short_eligible": 1, "stocks": 2})

    def test_symbols_always_include_etfs_and_feed_fetcher(self):
        self.run_cli()
        syms = self.symbols()
        for s in ("SPY", "VTI", "IEF", "BIL"):
            self.assertIn(s, syms)
        self.assertEqual(syms, sorted(set(syms)))
        self.assertNotIn("BIG", syms)
        self.assertNotIn("SMALL", syms)
        self.assertNotIn("PENNY", syms)

    def test_manifest_states_ticker_resolution(self):
        self.run_cli()
        with open(os.path.join(self.dir, "universe_manifest.json")) as f:
            self.assertEqual(json.load(f)["ticker_resolution"],
                             "reference.json ciks")

    def test_missing_reference_refused(self):
        os.remove(os.path.join(self.dir, "reference.json"))
        with self.assertRaises(B.UniverseError):
            self.run_cli()

    def test_stale_bars_excluded(self):
        write_bars(self.dir, "MID", 20.0, 1_000_000, end="2026-08-01")
        self.assertIsNone(B.liquidity(self.dir, "MID", AS_OF))

    def test_tampered_bars_excluded(self):
        path, _ = sip_fetch.dataset_paths(self.dir, "MID", "bars", "1Day",
                                          "split")
        with open(path, "a") as f:
            f.write("\n")
        self.assertIsNone(B.liquidity(self.dir, "MID", AS_OF))

    def test_stale_reference_refused(self):
        ref = reference()
        ref["through"] = "2026-01-01"
        with open(os.path.join(self.dir, "reference.json"), "w") as f:
            json.dump(ref, f)
        with self.assertRaises(B.UniverseError):
            self.run_cli()

    def test_rerun_is_identical(self):
        self.run_cli()
        with open(os.path.join(self.dir, "universe_symbols.txt")) as f:
            first = f.read()
        self.run_cli()
        with open(os.path.join(self.dir, "universe_symbols.txt")) as f:
            self.assertEqual(f.read(), first)


if __name__ == "__main__":
    unittest.main()
