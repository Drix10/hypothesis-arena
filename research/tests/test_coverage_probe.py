import csv
import io
import os
import sys
import tempfile
import unittest
import zipfile
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import coverage_probe as C

TODAY = date(2026, 10, 3)


def sub_zip(path, rows):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter="	")
    w.writerow(["adsh", "cik", "name", "form", "filed"])
    w.writerows(rows)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("sub.txt", buf.getvalue())


def frames(url):
    if "CY2016Q1I" in url:
        return {"data": [{"accn": "a", "val": 900000000},
                         {"accn": "c", "val": 100000000},
                         {"accn": "zzz", "val": 5}]}
    return None


def bars(first, last):
    out, d = [], first
    while d <= last:
        if d.weekday() < 5:
            out.append({"t": d.isoformat() + "T05:00:00Z"})
        d = date.fromordinal(d.toordinal() + 1)
    return out


class CoverageProbeTest(unittest.TestCase):
    def test_sample_is_seeded_and_ten_k_only(self):
        with tempfile.TemporaryDirectory() as d:
            for y in C.YEARS:
                for q in range(1, 5):
                    rows = [["a", "1", "ONE INC", "10-K", "%d0301" % y],
                            ["b", "2", "TWO CORP", "10-Q", "%d0301" % y]]
                    if (y, q) == (2017, 2):
                        rows.append(["c", "3", "THREE CO", "10-K", "20170601"])
                    sub_zip(os.path.join(d, f"{y}q{q}.zip"), rows)
            s1 = C.sample_firms(d, n=5, seed=1)
            self.assertEqual([f["cik"] for f in s1], ["1", "3"])
            self.assertEqual(s1[0]["filed"], date(2016, 3, 1))
            self.assertEqual([f["float"] for f in s1], [None, None])
            big = C.sample_firms(d, n=5, seed=1, min_float=C.MIN_FLOAT,
                                 get_json=frames)
            self.assertEqual([f["cik"] for f in big], ["1"])
            self.assertEqual(big[0]["float"], 9e8)
            self.assertEqual(s1, C.sample_firms(d, n=5, seed=1))
            os.remove(os.path.join(d, "2018q4.zip"))
            with self.assertRaises(FileNotFoundError):
                C.sample_firms(d)

    def test_listed_end(self):
        sub = {"filings": {"recent": {"form": ["10-K", "25-NSE"],
               "filingDate": ["2019-03-01", "2019-06-10"]}}}
        self.assertEqual(C.listed_end(sub, TODAY), date(2019, 6, 10))
        live = {"filings": {"recent": {"form": ["10-Q"],
                "filingDate": ["2026-08-01"]}}}
        self.assertEqual(C.listed_end(live, TODAY), TODAY)
        stale = {"filings": {"recent": {"form": ["10-K"],
                 "filingDate": ["2020-03-01"]}}}
        self.assertEqual(C.listed_end(stale, TODAY), date(2020, 3, 1))
        old25 = {"filings": {"recent": {"form": ["10-Q", "25"],
                 "filingDate": ["2026-08-01", "2015-10-23"]}}}
        self.assertEqual(C.listed_end(old25, TODAY), TODAY)
        self.assertIsNone(C.listed_end({}, TODAY))

    def test_candidates_order_and_name_match(self):
        firm = {"cik": "9", "name": "Acme Widgets, Inc."}
        sub = {"tickers": ["acme"], "name": "ACME WIDGETS INC",
               "formerNames": [{"name": "Old Acme Corp"}]}
        assets = [{"symbol": "OLDA", "name": "Old Acme Corporation"},
                  {"symbol": "ACME", "name": "Acme Widgets"},
                  {"symbol": "ZZZ", "name": "Other"}]
        got = C.candidates(firm, sub, {"9": "ACMW"}, assets)
        self.assertEqual(got, [("sec_current", "ACMW"),
                               ("sec_submissions", "ACME"),
                               ("asset_name", "OLDA")])

    def test_candidates_form4_history_nearest_first(self):
        firm = {"cik": "9", "name": "Gone Corp", "filed": date(2017, 3, 1)}
        hist = {"9": [(date(2016, 1, 5), "OLDX"), (date(2017, 2, 20), "GONE")]}
        got = C.candidates(firm, {}, {}, [], hist)
        self.assertEqual(got, [("form4_history", "GONE"),
                               ("form4_history", "OLDX")])

    def test_assess(self):
        s, e = date(2016, 3, 1), date(2018, 3, 1)
        full = C._days(bars(s, e))
        self.assertEqual(C.assess(full, s, e),
                         {"maps": True, "covers": True, "end_ok": True})
        early = C.assess(C._days(bars(s, date(2017, 1, 3))), s, e)
        self.assertEqual(early, {"maps": True, "covers": True,
                                 "end_ok": False})
        late = C.assess(C._days(bars(date(2017, 1, 3), e)), s, e)
        self.assertEqual((late["maps"], late["covers"]), (False, False))
        hole = [d for d in full
                if not date(2017, 1, 2) <= d <= date(2017, 3, 1)]
        got = C.assess(hole, s, e)
        self.assertEqual((got["maps"], got["covers"]), (True, False))
        self.assertEqual(C.assess([], s, e)["covers"], False)

    def test_probe_shares_and_trigger(self):
        f = date(2016, 3, 1)
        sample = [{"cik": str(i), "name": f"FIRM {i}", "filed": f}
                  for i in range(1, 6)]
        tick = {"1": ["AAA"], "2": ["BBB"], "3": ["CCC"], "5": ["EEE", "FFF"]}
        subs = {c: {"tickers": t, "filings": {"recent": {
            "form": ["10-K"], "filingDate": ["2026-09-01"]}}}
            for c, t in tick.items()}
        subs["4"] = {}
        end = date(2026, 10, 2)

        def get_bars(sym, start, stop):
            if sym == "AAA":
                return bars(start, stop)
            if sym == "BBB":
                return bars(start, date(2018, 1, 2))
            if sym == "EEE":
                return bars(start, date(2020, 6, 1))
            if sym == "FFF":
                return bars(date(2020, 6, 2), stop)
            return []
        rep = C.probe(sample, {}, [], lambda c: subs[c], get_bars, TODAY)
        self.assertEqual(rep["firms"], 5)
        self.assertEqual(rep["mapped_share"], 0.6)
        self.assertEqual(rep["covered_share"], 0.6)
        self.assertEqual(rep["end_unverified_share"], 0.2)
        self.assertTrue(rep["paid_data_trigger"])
        why = {r["cik"]: r.get("why") for r in rep["rows"]}
        self.assertEqual(why, {"1": None, "2": None, "3": "no-bars",
                               "4": "no-submissions", "5": None})
        self.assertEqual(rep["rows"][0]["end"], end.isoformat())
        ok = C.probe(sample[:1], {}, [], lambda c: subs[c], get_bars, TODAY)
        self.assertFalse(ok["paid_data_trigger"])
        self.assertTrue(ok["conclusive"])
        err = C.probe(sample[:1], {}, [], lambda c: subs[c],
                      lambda *a: None, TODAY)
        self.assertEqual(err["fetch_errors"], 1)
        self.assertFalse(err["conclusive"])
        self.assertEqual(err["rows"][0].get("why"), "fetch-error")


if __name__ == "__main__":
    unittest.main()
