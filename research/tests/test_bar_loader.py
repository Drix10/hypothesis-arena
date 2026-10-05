import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import bar_loader as L
from research.strategy import sip_fetch as S

NOW = datetime(2026, 9, 28, 20, 0, tzinfo=timezone.utc)
START = "2026-01-02T00:00:00Z"
END = "2026-01-10T00:00:00Z"


def bar(t, o, c):
    return {"t": t, "o": o, "h": max(o, c), "l": min(o, c), "c": c, "v": 1}


def write(outdir, sym, rows, adjustment="split"):
    def get(url, headers):
        return {"bars": {sym: rows}, "next_page_token": None}
    S.write_dataset(sym, "bars", START, END, outdir, "1Day", adjustment,
                    http_get=get, headers={}, now=NOW)


class LoaderTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def test_normal_load(self):
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 10, 11),
                                bar("2026-01-05T05:00:00Z", 11, 12.5)])
        write(self.dir, "BBB", [bar("2026-01-02T05:00:00Z", 1, 2)])
        got = L.load_prices(self.dir, ["AAA", "BBB"], "2026-01-01",
                            "2026-01-31")
        self.assertEqual(got, {"AAA": {"2026-01-02": (10.0, 11.0),
                                       "2026-01-05": (11.0, 12.5)},
                               "BBB": {"2026-01-02": (1.0, 2.0)}})

    def test_window_clip_inclusive(self):
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 1, 2),
                                bar("2026-01-05T05:00:00Z", 3, 4),
                                bar("2026-01-06T05:00:00Z", 5, 6)])
        got = L.load_prices(self.dir, ["AAA"], "2026-01-05", "2026-01-05")
        self.assertEqual(got, {"AAA": {"2026-01-05": (3.0, 4.0)}})

    def test_tampered_file_refused(self):
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 1, 2)])
        path, _ = S.dataset_paths(self.dir, "AAA", "bars", "1Day", "split")
        with open(path, "ab") as f:
            f.write(b" ")
        with self.assertRaises(S.SipError):
            L.load_prices(self.dir, ["AAA"], "2026-01-01", "2026-01-31")

    def test_missing_symbol_refused(self):
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 1, 2)])
        with self.assertRaises(FileNotFoundError):
            L.load_prices(self.dir, ["AAA", "ZZZ"], "2026-01-01",
                          "2026-01-31")

    def test_session_date_is_new_york(self):
        # 00:30Z on the 6th is 19:30 on the 5th in New York.
        write(self.dir, "AAA", [bar("2026-01-06T00:30:00Z", 1, 2)])
        got = L.load_prices(self.dir, ["AAA"], "2026-01-01", "2026-01-31")
        self.assertEqual(list(got["AAA"]), ["2026-01-05"])

    def test_default_is_split_adjusted_and_raw_is_selectable(self):
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 1, 2)], "split")
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 3, 4)], "raw")
        write(self.dir, "AAA", [bar("2026-01-02T05:00:00Z", 5, 6)], "all")
        args = (self.dir, ["AAA"], "2026-01-01", "2026-01-31")
        self.assertEqual(L.load_prices(*args)["AAA"],
                         {"2026-01-02": (1.0, 2.0)})
        self.assertEqual(L.load_prices(*args, adjustment="raw")["AAA"],
                         {"2026-01-02": (3.0, 4.0)})

    def test_benchmark_symbols(self):
        self.assertEqual(L.benchmark_symbols(["QQQ", "SPY", "AAA", "AAA"]),
                         ["AAA", "IEF", "QQQ", "SPY"])
        self.assertEqual(L.benchmark_symbols([]), ["IEF", "SPY"])


if __name__ == "__main__":
    unittest.main()
