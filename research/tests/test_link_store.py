"""Link-graph store tests. Stdlib only."""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store as L


def edge(eid="e1", **kw):
    f = dict(edge_id=eid, src_cik="0000000001", dst_cik="0000000002",
             source="supply_chain", type="customer", weight=0.5,
             valid_from=10, valid_to=None, known_at=20,
             evidence_ids=["acc-1:0-40"], extractor="deterministic",
             contamination_class="deterministic")
    f.update(kw)
    return f


def ids(store, v, k):
    return [e["edge_id"] for e in store.edges(v, k)]


class LinkStoreTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.TemporaryDirectory()
        self.addCleanup(self.d.cleanup)
        self.p = os.path.join(self.d.name, "links.jsonl")
        self.s = L.LinkStore(self.p)

    def test_late_known_edge_invisible_to_earlier_known_time(self):
        self.s.add(**edge(valid_from=10, known_at=50))
        self.assertEqual(ids(self.s, 30, 49), [])
        self.assertEqual(ids(self.s, 30, 50), ["e1"])

    def test_valid_window_is_half_open(self):
        self.s.add(**edge(valid_from=10, valid_to=30, known_at=20))
        self.assertEqual(ids(self.s, 9, 100), [])
        self.assertEqual(ids(self.s, 10, 100), ["e1"])
        self.assertEqual(ids(self.s, 30, 100), [])

    def test_retired_edge_gone_after_valid_to_visible_before(self):
        self.s.add(**edge())
        self.s.retire("e1", valid_to=40, known_at=60,
                      evidence_ids=["acc-2:0-9"])
        self.assertEqual(ids(self.s, 50, 100), [])
        self.assertEqual(ids(self.s, 39, 100), ["e1"])
        self.assertEqual(ids(self.s, 50, 59), ["e1"])

    def test_supersede_appends_and_later_known_wins(self):
        self.s.add(**edge(weight=0.5))
        n = self.s.verify()
        self.s.supersede("e1", known_at=70, evidence_ids=["acc-3:1-5"],
                         weight=0.9)
        self.assertEqual(self.s.verify(), n + 1)
        self.assertEqual(self.s.edges(15, 69)[0]["weight"], 0.5)
        self.assertEqual(self.s.edges(15, 70)[0]["weight"], 0.9)
        self.assertEqual(self.s.rows()[0]["weight"], 0.5)

    def test_in_memory_lines(self):
        lines = []
        s = L.LinkStore(lines)
        s.add(**edge())
        self.assertEqual(len(lines), 1)
        self.assertEqual(ids(s, 15, 25), ["e1"])
        lines[0] = lines[0].replace("0.5", "0.6")
        with self.assertRaises(L.LinkStoreError):
            s.verify()

    def _two_rows(self):
        self.s.add(**edge("e1"))
        self.s.add(**edge("e2"))
        with open(self.p, "rb") as fh:
            return fh.read().split(b"\n")[:-1]

    def _write(self, lines):
        with open(self.p, "wb") as fh:
            fh.write(b"\n".join(lines) + b"\n")

    def test_tampered_row_detected(self):
        a, b = self._two_rows()
        self._write([a.replace(b'"weight":0.5', b'"weight":0.7'), b])
        with self.assertRaises(L.LinkStoreError):
            self.s.verify()

    def test_reordered_rows_detected(self):
        a, b = self._two_rows()
        self._write([b, a])
        with self.assertRaises(L.LinkStoreError):
            self.s.verify()

    def test_truncation_detected_against_head(self):
        a, _ = self._two_rows()
        head = self.s.head()
        self._write([a])
        self.assertEqual(self.s.verify(), 1)
        with self.assertRaises(L.LinkStoreError):
            self.s.verify(head)

    def test_torn_tail_detected(self):
        self.s.add(**edge())
        with open(self.p, "ab") as fh:
            fh.write(b"{")
        with self.assertRaises(L.LinkStoreError):
            self.s.verify()

    def test_rejections(self):
        bad = [dict(evidence_ids=[]), dict(evidence_ids=[""]),
               dict(contamination_class="unknown"),
               dict(extractor="reader:"), dict(extractor="human"),
               dict(source="rumor"), dict(type="friend"),
               dict(valid_to=10), dict(weight=float("nan")),
               dict(known_at="2020-01-01")]
        for kw in bad:
            with self.assertRaises(L.LinkStoreError, msg=kw):
                self.s.add(**edge(**kw))
        with self.assertRaises(L.LinkStoreError):
            self.s.add(**{k: v for k, v in edge().items()
                          if k != "evidence_ids"})
        self.assertEqual(self.s.verify(), 0)

    def test_reader_extractor_accepted(self):
        self.s.add(**edge(extractor="reader:model-pin-1",
                          contamination_class="extraction"))
        self.assertEqual(self.s.verify(), 1)

    def test_edge_id_reuse_and_unknown_rejected(self):
        self.s.add(**edge())
        with self.assertRaises(L.LinkStoreError):
            self.s.add(**edge())
        with self.assertRaises(L.LinkStoreError):
            self.s.retire("nope", 40, 60, ["x"])
        with self.assertRaises(L.LinkStoreError):
            self.s.retire("e1", 5, 60, ["x"])
        with self.assertRaises(L.LinkStoreError):
            self.s.retire("e1", 40, 60, [])


if __name__ == "__main__":
    unittest.main()
