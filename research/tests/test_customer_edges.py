"""Customer and supplier edge tests. Stdlib only, fixtures only."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import customer_edges as C
from research.engine import link_store as L
from research.sources import ticker_map as T

D = datetime.date
OBS = [T.observation(cik, sym, "dei", D(2015, 1, 1), D(2015, 1, 2))
       for cik, sym in ((1, "AAA"), (2, "APPL"), (3, "APHR"), (4, "TSM"))]
OBS.append(T.observation(5, "LATE", "dei", D(2022, 1, 1), D(2022, 1, 2)))
ALIASES = {"apple": [2], "apple hospitality": [3],
           "taiwan semiconductor": [4], "late": [5], "delta": [2, 3]}
FILER = 1


def filing(text, filed=20200301, acc="a1", year=2019):
    return {"cik": FILER, "accession": acc, "text": text, "filed": filed,
            "year": year}


class MentionsTest(unittest.TestCase):
    def test_accounted_for_share(self):
        ms = C.mentions("Apple Inc. accounted for 23% of our revenue.")
        self.assertEqual([(m["name"], m["share"]) for m in ms],
                         [("Apple Inc", 0.23)])

    def test_list_after_sold_to(self):
        ms = C.mentions("We sold our products to Apple, Delta and Foo Corp.")
        self.assertEqual([m["name"] for m in ms],
                         ["Apple", "Delta", "Foo Corp"])


class EdgesTest(unittest.TestCase):
    def test_share_weight_and_known_at(self):
        es = C.edges([filing("Apple Inc. accounted for 23% of our revenue.")],
                     ALIASES, OBS)
        self.assertEqual(len(es), 1)
        e = es[0]
        self.assertEqual((e["src_cik"], e["dst_cik"], e["type"]),
                         ("0000000001", "0000000002", "customer"))
        self.assertEqual(e["weight"], 0.23)
        self.assertEqual(e["known_at"], 20200301)
        self.assertEqual(e["valid_to"], 20210901)

    def test_weight_one_without_share(self):
        es = C.edges([filing("We purchase wafers from Taiwan Semiconductor.")],
                     ALIASES, OBS)
        self.assertEqual([(e["type"], e["weight"]) for e in es],
                         [("supplier", 1)])

    def test_ambiguous_name_yields_no_edge(self):
        self.assertEqual(C.edges([filing("We sold units to Delta.")],
                                 ALIASES, OBS), [])

    def test_unknown_name_yields_no_edge(self):
        self.assertEqual(C.edges([filing("We sold units to Zorbax.")],
                                 ALIASES, OBS), [])

    def test_anonymised_customer_yields_no_edge(self):
        self.assertEqual(C.edges(
            [filing("Customer A accounted for 12% of revenue.")],
            ALIASES, OBS), [])

    def test_name_not_yet_in_ticker_map_yields_no_edge(self):
        self.assertEqual(C.edges([filing("We sold units to Late Co.")],
                                 ALIASES, OBS), [])
        later = filing("We sold units to Late Co.", filed=20220601)
        self.assertEqual(len(C.edges([later], ALIASES, OBS)), 1)

    def test_self_reference_yields_no_edge(self):
        self.assertEqual(C.edges([filing("We sold units to AAA.")],
                                 {"aaa": [1]}, OBS), [])

    def test_month_end_aging_clamps(self):
        self.assertEqual(C._add_months(20200831, 18), 20220228)

    def test_edges_load_into_link_store(self):
        es = C.edges([filing("Apple Inc. accounted for 23% of our revenue. "
                             "We purchase wafers from Taiwan Semiconductor.")],
                     ALIASES, OBS)
        store = L.LinkStore([])
        for e in es:
            store.add(**e)
        self.assertEqual(len(store.rows()), 2)


class CoverageTest(unittest.TestCase):
    def test_share_per_year(self):
        fs = [filing("Apple Inc. accounted for 10% of revenue.", year=2019),
              filing("Customer A accounted for 12% of revenue.", year=2019),
              filing("We make widgets.", year=2022),
              filing("We make gadgets.", year=2022),
              filing("We sold units to Foo.", year=2022)]
        cov = C.coverage(fs)
        self.assertEqual(cov[2019], {"filings": 2, "covered": 2, "share": 1.0})
        self.assertEqual(cov[2022]["covered"], 1)
        self.assertAlmostEqual(cov[2022]["share"], 1 / 3)


class PrecisionTest(unittest.TestCase):
    def test_fixture_precision(self):
        a = filing("Apple Inc. accounted for 23% of our revenue.")
        a["expected"] = {(2, "customer")}
        b = filing("We sold units to Delta and Apple Hospitality.", acc="a2")
        b["expected"] = {(3, "customer")}
        c = filing("We purchase wafers from Foo.", acc="a3")
        c["expected"] = {(4, "supplier")}
        r = C.precision([a, b, c], ALIASES, OBS)
        self.assertEqual((r["emitted"], r["true_positive"], r["expected"]),
                         (2, 2, 3))
        self.assertEqual(r["precision"], 1.0)
        self.assertAlmostEqual(r["recall"], 2 / 3)

    def test_no_edges_gives_no_precision(self):
        r = C.precision([dict(filing("Nothing."), expected=set())], ALIASES,
                        OBS)
        self.assertIsNone(r["precision"])


if __name__ == "__main__":
    unittest.main()
