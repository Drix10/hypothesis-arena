import calendar
import datetime
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import earnings_surprise as P

D = datetime.date
SUB = ["adsh", "cik", "name", "sic", "form", "period", "filed", "accepted",
       "prevrpt"]
NUM = ["adsh", "tag", "version", "ddate", "qtrs", "uom", "segments", "coreg",
       "value", "footnote"]


def tsv(cols, rows):
    return "\t".join(cols) + "\n" + "".join("\t".join(r) + "\n" for r in rows)


def sub(adsh, form, period, acc="2020-05-01 17:20:00.0", cik="10", prev="0"):
    return [adsh, cik, "ACME", "3570", form, period, acc[:10].replace("-", ""),
            acc, prev]


def num(adsh, ddate, qtrs, value, tag="EarningsPerShareDiluted",
        uom="USD", seg="", coreg=""):
    return [adsh, tag, "us-gaap/2019", ddate, str(qtrs), uom, seg, coreg,
            str(value), ""]


def qend(i):
    y, m = 2016 + i // 4, 3 * (i % 4) + 3
    return D(y, m, calendar.monthrange(y, m)[1])


def make_zip(path, subs, nums):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("sub.txt", tsv(SUB, subs))
        z.writestr("num.txt", tsv(NUM, nums))


def filing(adsh, period, eps, tag="EarningsPerShareDiluted", form="10-Q",
           acc=None, cik="10"):
    return {"adsh": adsh, "cik": cik, "name": "ACME", "sic": "1", "form": form,
            "period": period, "filed": period, "accepted": acc or
            datetime.datetime.combine(period, datetime.time(9, 0)),
            "eps": eps}


class Read(unittest.TestCase):
    def test_parses_eps_and_filters(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "2020q2.zip")
            make_zip(p, [sub("a1", "10-Q", "20200331"),
                         sub("a2", "8-K", "20200331"),
                         sub("a3", "10-Q", "20200331", prev="1"),
                         sub("a4", "10-K", "20191231",
                             acc="2020-02-20 06:10:00.0")],
                     [num("a1", "20200331", 1, 0.5),
                      num("a1", "20190331", 1, 0.4),
                      num("a1", "20200331", 1, 0.45,
                          tag="EarningsPerShareBasic"),
                      num("a1", "20200331", 2, 0.9),
                      num("a1", "20200331", 1, 9.9, uom="CNY"),
                      num("a1", "20200331", 1, 9.9, seg="Prod=A;"),
                      num("a1", "20200331", 1, 9.9, coreg="SUB"),
                      num("a1", "20180331", 1, 9.9),
                      num("a1", "20200331", 1, 9.9, tag="Revenues"),
                      num("a2", "20200331", 1, 1.0),
                      num("a3", "20200331", 1, 1.0),
                      num("a4", "20191231", 4, 2.0)])
            fs = {f["adsh"]: f for f in P.read_quarter(p)}
        self.assertEqual(sorted(fs), ["a1", "a4"])
        self.assertEqual(fs["a1"]["eps"], {
            ("EarningsPerShareDiluted", D(2020, 3, 31), 1): 0.5,
            ("EarningsPerShareDiluted", D(2019, 3, 31), 1): 0.4,
            ("EarningsPerShareBasic", D(2020, 3, 31), 1): 0.45})
        self.assertEqual(fs["a1"]["cik"], "10")
        self.assertEqual(fs["a4"]["accepted"],
                         datetime.datetime(2020, 2, 20, 6, 10))


class Quarters(unittest.TestCase):
    def test_diluted_preferred_and_basic_fallback(self):
        dil, bas = "EarningsPerShareDiluted", "EarningsPerShareBasic"
        f = filing("x", D(2020, 3, 31), {
            (dil, D(2020, 3, 31), 1): 0.5, (dil, D(2019, 3, 31), 1): 0.4,
            (bas, D(2020, 3, 31), 1): 0.6, (bas, D(2019, 3, 31), 1): 0.5})
        g = filing("y", D(2020, 6, 30), {
            (dil, D(2020, 6, 30), 1): 0.5,
            (bas, D(2020, 6, 30), 1): 0.6, (bas, D(2019, 6, 30), 1): 0.5})
        r = P.build_quarters([f, g])["10"]
        self.assertEqual([(x["tag"], x["eps"], x["eps_py"]) for x in r],
                         [(dil, 0.5, 0.4), (bas, 0.6, 0.5)])

    def test_q4_derived_from_annual(self):
        t = "EarningsPerShareDiluted"
        qs = [filing("q%d" % k, D(2019, m, 30 if m in (6, 9) else 31),
                     {(t, D(2019, m, 30 if m in (6, 9) else 31), 1): e,
                      (t, D(2018, m, 30 if m in (6, 9) else 31), 1): e - 0.1})
              for k, (m, e) in enumerate([(3, 1.0), (6, 1.1), (9, 1.2)])]
        k = filing("k", D(2019, 12, 31), {
            (t, D(2019, 12, 31), 4): 5.0, (t, D(2018, 12, 31), 4): 4.4},
            form="10-K")
        r = P.build_quarters(qs + [k])["10"]
        q4 = r[-1]
        self.assertTrue(q4["derived"])
        self.assertEqual(q4["period"], D(2019, 12, 31))
        self.assertAlmostEqual(q4["eps"], 5.0 - 3.3)
        self.assertAlmostEqual(q4["eps_py"], 4.4 - 3.0)
        self.assertEqual(q4["adsh"], "k")

    def test_q4_skipped_when_a_quarter_is_missing_or_tag_differs(self):
        t, b = "EarningsPerShareDiluted", "EarningsPerShareBasic"

        def q(m, d, tag=t):
            return filing("q%d" % m, D(2019, m, d), {
                (tag, D(2019, m, d), 1): 1.0, (tag, D(2018, m, d), 1): 0.9})
        k = filing("k", D(2019, 12, 31), {
            (t, D(2019, 12, 31), 4): 5.0, (t, D(2018, 12, 31), 4): 4.4},
            form="10-K")
        self.assertEqual(len(P.build_quarters(
            [q(3, 31), q(6, 30), k])["10"]), 2)
        self.assertEqual(len(P.build_quarters(
            [q(3, 31), q(6, 30), q(9, 30, b), k])["10"]), 3)

    def test_direct_q4_value_is_used_over_derivation(self):
        t = "EarningsPerShareDiluted"
        k = filing("k", D(2019, 12, 31), {
            (t, D(2019, 12, 31), 1): 1.5, (t, D(2018, 12, 31), 1): 1.0,
            (t, D(2019, 12, 31), 4): 5.0, (t, D(2018, 12, 31), 4): 4.4},
            form="10-K")
        r = P.build_quarters([k])["10"]
        self.assertEqual([(x["eps"], x["derived"]) for x in r], [(1.5, False)])


class Sue(unittest.TestCase):
    def test_value(self):
        past = [0.1, 0.3, 0.2, 0.4, 0.0, 0.2]
        sd = (sum((x - 0.2) ** 2 for x in past) / 5) ** 0.5
        self.assertAlmostEqual(P.sue_value(0.5, past), 0.5 / sd)

    def test_insufficient_history_and_zero_dispersion(self):
        self.assertIsNone(P.sue_value(1.0, [0.1, 0.2, 0.3, 0.4, 0.5]))
        self.assertIsNone(P.sue_value(1.0, [0.2] * 8))

    def test_add_sue_uses_only_prior_quarters(self):
        recs = []
        for i in range(10):
            per = qend(i)
            recs.append({"period": per, "eps": 1.0 + 0.1 * (i % 3),
                         "eps_py": 1.0})
        P.add_sue(recs)
        self.assertEqual([r["sue"] is None for r in recs],
                         [True] * 6 + [False] * 4)
        first = recs[6]["sue"]
        recs[7]["eps"] = 99.0
        P.add_sue(recs)
        self.assertEqual(recs[6]["sue"], first)

    def test_history_older_than_window_is_ignored(self):
        recs = [{"period": D(2010 + i, 6, 30), "eps": 1.0 + 0.1 * (i % 2),
                 "eps_py": 1.0} for i in range(8)]
        P.add_sue(recs)
        self.assertTrue(all(r["sue"] is None for r in recs))


class Percentile(unittest.TestCase):
    def items(self, spec):
        return [{"date": d, "sue": s} for d, s in spec]

    def test_rank_uses_only_trailing_window_and_same_day(self):
        it = self.items([("2020-01-01", 1.0), ("2020-01-02", 2.0),
                         ("2020-01-02", 3.0), ("2020-06-01", 0.5),
                         ("2020-06-01", 4.0)])
        P.rolling_pct(it, window=90, min_population=1)
        pct = [e["pct"] for e in it]
        self.assertEqual(pct, [0.0, 1 / 3, 2 / 3, 0.0, 0.5])

    def test_future_filings_do_not_change_earlier_ranks(self):
        base = self.items([("2020-01-01", 1.0), ("2020-01-05", 2.0),
                           ("2020-01-09", 1.5)])
        P.rolling_pct(base, min_population=1)
        ext = self.items([("2020-01-01", 1.0), ("2020-01-05", 2.0),
                          ("2020-01-09", 1.5), ("2020-01-10", 9.0),
                          ("2020-01-11", -9.0)])
        P.rolling_pct(ext, min_population=1)
        self.assertEqual([e["pct"] for e in base],
                         [e["pct"] for e in ext[:3]])

    def test_window_boundary_and_min_population(self):
        it = self.items([("2020-01-01", 5.0), ("2020-03-31", 1.0)])
        P.rolling_pct(it, window=90, min_population=1)
        self.assertEqual(it[1]["pct"], 0.0)
        it = self.items([("2020-01-01", 5.0), ("2020-03-30", 1.0)])
        P.rolling_pct(it, window=90, min_population=1)
        self.assertEqual(it[1]["pct"], 0.0)
        it = self.items([("2020-01-01", 5.0), ("2020-03-29", 9.0)])
        P.rolling_pct(it, window=90, min_population=3)
        self.assertEqual([e["pct"] for e in it], [None, None])


class Symbols(unittest.TestCase):
    def test_nearest_in_time_then_current_fallback(self):
        h = {"1": [(D(2016, 1, 1), "OLD"), (D(2020, 1, 1), "NEW")]}
        cur = {"1": "CUR", "2": "TWO"}
        self.assertEqual(P.symbol_for("1", D(2017, 1, 1), h, cur), "OLD")
        self.assertEqual(P.symbol_for("1", D(2019, 6, 1), h, cur), "NEW")
        self.assertEqual(P.symbol_for("2", D(2019, 6, 1), h, cur), "TWO")
        self.assertIsNone(P.symbol_for("3", D(2019, 6, 1), h, cur))

    def test_read_symbols_validates_and_normalizes(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "2020q1_form345.zip")
            with zipfile.ZipFile(p, "w") as z:
                z.writestr("SUBMISSION.tsv", tsv(
                    ["ACCESSION_NUMBER", "FILING_DATE", "ISSUERCIK",
                     "ISSUERTRADINGSYMBOL"],
                    [["a", "05-JAN-2020", "0000000010", "abc"],
                     ["b", "06-JAN-2020", "0000000011", "N/A"],
                     ["c", "07-JAN-2020", "0000000012", "BRK-B"]]))
            h = P.read_symbols([p])
        self.assertEqual(h, {"10": [(D(2020, 1, 5), "ABC")],
                             "12": [(D(2020, 1, 7), "BRK-B")]})


class Events(unittest.TestCase):
    def filings(self):
        t = "EarningsPerShareDiluted"
        fil = []
        for cik, step, jump in (("10", 0.1, 5.0), ("11", 0.05, 1.0)):
            for i in range(9):
                per = qend(i)
                py = D(per.year - 1, per.month, per.day)
                cur = 1.0 + (jump if i == 8 else step * (i % 2))
                fil.append(filing("%s-%d" % (cik, i), per,
                                  {(t, per, 1): cur, (t, py, 1): 1.0},
                                  cik=cik))
        return fil

    def test_events_carry_acceptance_date_symbol_and_rank(self):
        ev, c = P.build_events(self.filings(), {}, {"10": "AAA", "11": "BBB"},
                               min_population=1)
        self.assertEqual(c["firm_quarters"], 18)
        self.assertEqual(c["with_sue"], 6)
        last = [e for e in ev if e["date"] == "2018-03-31"]
        self.assertEqual([(e["symbol"], e["pct"]) for e in
                          sorted(last, key=lambda e: e["symbol"])],
                         [("AAA", 0.5), ("BBB", 0.0)])
        self.assertEqual(last[0]["accepted"], "2018-03-31T09:00")
        self.assertEqual(len(ev), 6)

    def test_start_symbol_and_population_filters(self):
        ev, c = P.build_events(self.filings(), {}, {"10": "AAA"},
                               min_population=1, start="2018-01-01")
        self.assertEqual([e["symbol"] for e in ev], ["AAA"])
        self.assertEqual(c["no_symbol"], 3)
        ev, _ = P.build_events(self.filings(), {}, {"10": "AAA", "11": "BBB"})
        self.assertEqual(ev, [])


if __name__ == "__main__":
    unittest.main()
