"""Text-peer edge tests. Stdlib only."""
import math
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store as L
from research.engine import text_peers as T

BANK_A = ("We are a regional bank holding company offering commercial loans, "
          "deposits and mortgage lending to small business customers.")
BANK_B = ("The company is a regional bank holding company offering "
          "commercial loans, deposits and mortgage lending to small "
          "business customers through branches.")
MINER = ("We explore and mine copper and gold ore deposits and operate "
         "smelting facilities in remote territories.")


def filing(cik, text, filed=100):
    return {"cik": cik, "accession": "acc-" + cik, "item1_text": text,
            "filed": filed}


def cohort():
    return [filing("0000000001", BANK_A, 100),
            filing("0000000002", BANK_B, 150),
            filing("0000000003", MINER, 120)]


class TextPeersTest(unittest.TestCase):
    def test_tokenise_lowercases_and_drops_stopwords(self):
        self.assertEqual(T.tokenise("The Bank, and a LOAN-book."),
                         ["bank", "loan", "book"])

    def test_near_identical_firms_are_peers_unrelated_is_not(self):
        edges = T.text_peer_edges(cohort(), 0, 0)
        pairs = {(e["src_cik"], e["dst_cik"]) for e in edges}
        self.assertEqual(pairs, {("0000000001", "0000000002"),
                                 ("0000000002", "0000000001")})
        self.assertTrue(all(e["weight"] > 0.8 for e in edges))

    def test_idf_uses_only_the_passed_cohort(self):
        toks = [T.tokenise(BANK_A), T.tokenise(MINER)]
        w = T.idf(toks)
        self.assertAlmostEqual(w["bank"], math.log(3 / 2) + 1)
        self.assertNotIn("silicon", w)
        both = T.idf(toks + [T.tokenise("silicon bank")])
        self.assertNotEqual(w["bank"], both["bank"])

    def test_known_at_never_before_either_filing(self):
        for floor in (0, 120, 500):
            for e in T.text_peer_edges(cohort(), floor, 0):
                self.assertGreaterEqual(e["known_at"], 150)
                self.assertGreaterEqual(e["known_at"], floor)
        self.assertEqual(T.text_peer_edges(cohort(), 0, 0)[0]["known_at"], 150)

    def test_one_direction_when_only_one_ranks_the_other(self):
        fs = [filing("0000000001", BANK_A),
              filing("0000000002", BANK_B),
              filing("0000000004", BANK_B)]
        edges = T.text_peer_edges(fs, 0, 0, k=1)
        pairs = [(e["src_cik"], e["dst_cik"]) for e in edges]
        self.assertEqual(pairs, [("0000000001", "0000000002"),
                                 ("0000000002", "0000000004"),
                                 ("0000000004", "0000000002")])

    def test_deterministic_regardless_of_input_order(self):
        a = T.text_peer_edges(cohort(), 0, 0)
        b = T.text_peer_edges(list(reversed(cohort())), 0, 0)
        self.assertEqual(a, b)

    def test_threshold_and_duplicate_cik(self):
        self.assertEqual(T.text_peer_edges(cohort(), 0, 0, threshold=1.1), [])
        with self.assertRaises(ValueError):
            T.text_peer_edges([filing("1", BANK_A), filing("1", BANK_B)], 0, 0)

    def test_edges_round_trip_through_link_store(self):
        store = L.LinkStore([])
        edges = T.text_peer_edges(cohort(), 0, 10)
        for e in edges:
            store.add(**e)
        self.assertEqual(store.edges(10, 149), [])
        got = store.edges(10, 150)
        self.assertEqual(got, sorted(edges, key=lambda e: e["edge_id"]))
        self.assertEqual(got[0]["evidence_ids"],
                         ["acc-0000000001", "acc-0000000002"])


if __name__ == "__main__":
    unittest.main()
