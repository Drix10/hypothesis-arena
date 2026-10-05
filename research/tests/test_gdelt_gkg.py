"""GDELT GKG co-mention reader tests; fixtures only, no network."""
import datetime
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import gdelt_gkg as g

TABLE = [(1, "Apple Inc."), (2, "Microsoft Corp"), (3, "Alpha Corp"),
         (5, "Old Beta Inc"), (5, "Beta Inc"),
         (6, "Gamma Inc"), (7, "Alpha Holdings"), (8, "Alpha Holdings")]
DAY = datetime.date(2024, 1, 2)


def line(rid, orgs, date="20240102030000", themes="TAX,1;ECON,5"):
    f = [""] * 15
    f[0], f[1], f[3] = rid, date, "example.com"
    f[4] = "http://example.com/" + rid
    f[8], f[14] = themes, orgs
    return "\t".join(f)


def run(*lines, table=TABLE):
    rows, bad = g.parse("\n".join(lines))
    return g.aggregate(rows, g.name_index(table), bad)


class GkgTest(unittest.TestCase):
    def test_parse_fields_and_known_at(self):
        rows, bad = g.parse(line("r1", "Apple Inc,10;Microsoft,40"))
        self.assertEqual(bad, 0)
        r = rows[0]
        self.assertEqual(r.known_at, datetime.datetime(2024, 1, 2, 3, 0, 0))
        self.assertEqual(r.organizations, ["Apple Inc", "Microsoft"])
        self.assertEqual(r.themes, ["TAX", "ECON"])
        self.assertEqual(r.url, "http://example.com/r1")

    def test_empty_themes_and_orgs_allowed(self):
        rows, bad = g.parse(line("r1", "", themes=""))
        self.assertEqual((bad, rows[0].organizations, rows[0].themes),
                         (0, [], []))

    def test_malformed_lines_skipped_and_counted(self):
        text = "\n".join([
            "too\tfew",
            line("r2", "Apple Inc,10", date="2024-01-02"),
            line("r3", "Apple Inc"),
            line("r4", "Apple Inc,x"),
            "",
            line("ok", "Apple Inc,1;Microsoft Corp,2"),
        ])
        rows, bad = g.parse(text)
        self.assertEqual((len(rows), bad), (1, 4))

    def test_malformed_count_reaches_aggregate(self):
        agg = run("junk", line("ok", "Apple Inc,1"))
        self.assertEqual((agg.malformed, agg.documents), (1, 1))

    def test_exact_normalized_and_former_name(self):
        agg = run(line("r1", "APPLE INC.,1;Old Beta Inc,2"))
        self.assertEqual(agg.pairs_by_day[DAY], {(1, 5): 1})

    def test_ambiguous_and_unknown(self):
        agg = run(line("r1", "Alpha Holdings,1;Apple Inc,2;Nobody Ltd,3"))
        self.assertEqual((agg.ambiguous, agg.unknown, agg.resolved), (1, 1, 1))
        self.assertEqual(agg.pairs_by_day, {})

    def test_no_fuzzy_match(self):
        agg = run(line("r1", "Appel,1;Micro Soft,2"))
        self.assertEqual((agg.resolved, agg.unknown), (0, 2))

    def test_pairs_dedupe_within_document_and_sum_across(self):
        agg = run(
            line("r1", "Apple Inc,1;Microsoft Corp,2;Apple Inc,3;Gamma Inc,4"),
            line("r2", "Microsoft Corp,1;Apple Inc,2"))
        self.assertEqual(agg.pairs_by_day[DAY],
                         {(1, 2): 2, (1, 6): 1, (2, 6): 1})

    def test_single_resolved_org_makes_no_pair(self):
        agg = run(line("r1", "Apple Inc,1;Apple Inc,2"))
        self.assertEqual(agg.pairs_by_day, {})

    def test_pairs_split_by_day(self):
        agg = run(line("r1", "Apple Inc,1;Gamma Inc,2"),
                  line("r2", "Apple Inc,1;Gamma Inc,2", date="20240103235959"))
        self.assertEqual(sorted(agg.pairs_by_day),
                         [DAY, datetime.date(2024, 1, 3)])

    def test_bulk_cap(self):
        table = [(i, "Firm%d Inc" % i) for i in range(1, 23)]
        at_cap = ";".join("Firm%d Inc,%d" % (i, i) for i in range(1, 21))
        over = at_cap + ";Firm21 Inc,99"
        agg = run(line("r1", at_cap), line("r2", over), table=table)
        self.assertEqual(agg.bulk_documents, 1)
        self.assertEqual(sum(agg.pairs_by_day[DAY].values()), 20 * 19 // 2)
        self.assertEqual(agg.resolved, 41)

    def test_resolution_rate(self):
        agg = run(line(
            "r1", "Apple Inc,1;Microsoft Corp,2;Nobody,3;Alpha Holdings,4"))
        self.assertEqual((agg.mentions, agg.resolved), (4, 2))
        self.assertEqual(g.resolution_rate(agg), 0.5)
        self.assertIsNone(g.resolution_rate(run()))

    def test_name_index_marks_ambiguity(self):
        index = g.name_index(TABLE)
        self.assertIsNone(index["ALPHA HOLDINGS"])
        self.assertEqual(index["APPLE"], 1)


if __name__ == "__main__":
    unittest.main()
