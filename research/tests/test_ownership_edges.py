"""Common-ownership edge tests; fixtures only, no network."""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store as L
from research.engine import ownership_edges as O
from research.sources import form13f

A, B, C = "AAAAAAAA1", "BBBBBBBB1", "CCCCCCCC1"
ISSUERS = {A: "0000000001", B: "0000000002", C: "0000000003"}


def row(cik, cusip, value, period="2024-03-31", filed="2024-05-10", **kw):
    r = dict(cik=cik, period=period, filing_date=filed, cusip=cusip,
             issuer=cusip, value=value, shares=1, put_call="",
             discretion="SOLE")
    r.update(kw)
    return r


def fixture():
    # filer 10 holds A and B at 50% each; filer 11 holds A 25%, B 25%, C 50%.
    return [row("10", A, 100), row("10", B, 100),
            row("11", A, 50), row("11", B, 50), row("11", C, 100)]


class OwnershipEdgesTest(unittest.TestCase):
    def test_known_overlap(self):
        edges = O.ownership_edges(fixture(), ISSUERS, "2024-06-30",
                                  threshold=0.1)
        ab = [e for e in edges if e["edge_id"].endswith(A + ":" + B)][0]
        self.assertAlmostEqual(ab["weight"], 0.5 + 0.25)
        self.assertEqual((ab["src_cik"], ab["dst_cik"]),
                         ("0000000001", "0000000002"))
        self.assertEqual(ab["evidence_ids"], ["10:2024-03-31", "11:2024-03-31"])
        self.assertEqual((ab["source"], ab["type"], ab["extractor"],
                          ab["contamination_class"]),
                         ("ownership", "common_owner", "deterministic",
                          "deterministic"))
        self.assertEqual((ab["valid_from"], ab["known_at"]),
                         (20240331, 20240510))

    def test_threshold(self):
        low = O.ownership_edges(fixture(), ISSUERS, "2024-06-30", 0.1)
        self.assertEqual(len(low), 3)
        mid = O.ownership_edges(fixture(), ISSUERS, "2024-06-30", 0.75)
        self.assertEqual(len(mid), 1)
        self.assertEqual(O.ownership_edges(fixture(), ISSUERS, "2024-06-30",
                                           0.76), [])

    def test_accession_preferred(self):
        rows = [row("10", A, 1, accession="0001-24-1"),
                row("10", B, 1, accession="0001-24-1")]
        e = O.ownership_edges(rows, ISSUERS, "2024-06-30")[0]
        self.assertEqual(e["evidence_ids"], ["0001-24-1"])

    def test_filing_after_as_of_excluded(self):
        rows = fixture() + [row("12", A, 1, filed="2024-08-01"),
                            row("12", B, 1, filed="2024-08-01")]
        edges = O.ownership_edges(rows, ISSUERS, "2024-06-30", 0.1)
        ev = [i for e in edges for i in e["evidence_ids"]]
        self.assertNotIn("12:2024-03-31", ev)
        self.assertEqual(O.ownership_edges(rows[5:], ISSUERS, "2024-06-30"),
                         [])

    def test_known_at_never_after_as_of(self):
        rows = fixture() + [row("10", A, 100, period="2024-06-30",
                                filed="2024-08-01"),
                            row("10", B, 100, period="2024-06-30",
                                filed="2024-08-01")]
        for as_of in ("2024-05-10", "2024-06-30", "2024-09-01"):
            for e in O.ownership_edges(rows, ISSUERS, as_of, 0.1):
                self.assertLessEqual(e["known_at"], int(as_of.replace("-", "")))
        late = O.ownership_edges(rows, ISSUERS, "2024-09-01", 0.1)
        self.assertTrue(all(e["known_at"] == 20240801 for e in late
                            if "10:2024-06-30" in e["evidence_ids"]))

    def test_unshared_pairs_never_compared(self):
        rows = [row("10", A, 1), row("10", B, 1),
                row("11", C, 1), row("11", "DDDDDDDD1", 1)]
        issuers = dict(ISSUERS, DDDDDDDD1="0000000004")
        calls = []

        def counting(rs, a, b, as_of):
            calls.append((a, b))
            return form13f.overlap(rs, a, b, as_of)

        O.ownership_edges(rows, issuers, "2024-06-30", overlap_fn=counting)
        self.assertEqual(sorted(calls), [(A, B), (C, "DDDDDDDD1")])

    def test_deterministic(self):
        rows = fixture()
        one = O.ownership_edges(rows, ISSUERS, "2024-06-30", 0.1)
        two = O.ownership_edges(list(reversed(rows)), ISSUERS, "2024-06-30",
                                0.1)
        self.assertEqual(one, two)

    def test_same_issuer_cik_and_unmapped_skipped(self):
        issuers = {A: "0000000001", B: "0000000001"}
        self.assertEqual(O.ownership_edges(fixture(), issuers, "2024-06-30"),
                         [])
        self.assertEqual(O.ownership_edges(fixture(), {}, "2024-06-30"), [])

    def test_into_link_store(self):
        store = L.LinkStore([])
        edges = O.ownership_edges(fixture(), ISSUERS, "2024-06-30", 0.1)
        for e in edges:
            store.add(**e)
        got = store.edges(20240630, 20240630)
        self.assertEqual(got, sorted(edges, key=lambda e: e["edge_id"]))
        self.assertEqual(store.edges(20240630, 20240509), [])


if __name__ == "__main__":
    unittest.main()
