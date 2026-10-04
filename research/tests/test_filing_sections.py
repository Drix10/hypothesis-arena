"""Filing section parser tests: fixtures only."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import filing_sections

ITEMS = [
    ("1", "Business", "We sell widgets."),
    ("1A", "Risk Factors", "Demand may fall."),
    ("2", "Properties", "One office."),
    ("7", "Management's Discussion and Analysis", "Revenue rose."),
    ("7A", "Quantitative and Qualitative Disclosures About Market Risk", "Rates matter."),
    ("8", "Financial Statements", "See notes."),
    ("9", "Changes in Accountants", "None."),
]


def body(items=ITEMS):
    return "".join(f"Item {n}. {t}\n{b}\n\n" for n, t, b in items)


def toc(items=ITEMS):
    return "TABLE OF CONTENTS\n" + "".join(
        f"Item {n}. {t}   {i + 3}\n" for i, (n, t, _) in enumerate(items)) + "\n"


class FilingSectionsTest(unittest.TestCase):
    def test_normal(self):
        r = filing_sections.parse("ANNUAL REPORT\n" + body())
        self.assertEqual(r.reason, "")
        self.assertEqual(list(r.sections), list(filing_sections.WANTED))
        self.assertIn("Demand may fall.", r.section_text("1A"))
        self.assertNotIn("Revenue", r.section_text("1A"))

    def test_toc_first_is_skipped(self):
        text = toc() + body()
        r = filing_sections.parse(text)
        self.assertEqual(r.reason, "")
        self.assertGreater(r.sections["1"][0], text.index("Item 9. Changes in Accountants   "))
        self.assertIn("We sell widgets.", r.section_text("1"))

    def test_missing_1a(self):
        r = filing_sections.parse(body([i for i in ITEMS if i[0] != "1A"]))
        self.assertEqual(r.sections, {})
        self.assertIn("Item 1A", r.reason)

    def test_toc_only_item_fails_closed(self):
        r = filing_sections.parse(toc() + body([i for i in ITEMS if i[0] != "1A"]))
        self.assertEqual(r.sections, {})
        self.assertEqual(r.reason, "headings out of order")

    def test_out_of_order(self):
        items = list(ITEMS)
        items[3], items[4] = items[4], items[3]
        r = filing_sections.parse(body(items))
        self.assertEqual(r.sections, {})
        self.assertEqual(r.reason, "headings out of order")

    def test_blank_section(self):
        items = [(n, t, "" if n == "2" else b) for n, t, b in ITEMS]
        r = filing_sections.parse("".join(f"Item {n}.\n{b}\n" for n, _, b in items))
        self.assertEqual(r.sections, {})
        self.assertEqual(r.reason, "blank section: Item 2")

    def test_offsets_reproduce_text(self):
        text = toc() + body()
        r = filing_sections.parse(text)
        for n, t, b in ITEMS:
            if n in r.sections:
                s, e = r.sections[n]
                self.assertEqual(text[s:e], f"Item {n}. {t}\n{b}\n\n")

    def test_cross_reference_mid_line_ignored(self):
        items = [(n, t, b + " See Item 7 below." if n == "1" else b) for n, t, b in ITEMS]
        r = filing_sections.parse(body(items))
        self.assertEqual(r.reason, "")
        self.assertIn("See Item 7 below.", r.section_text("1"))

    def test_html(self):
        html = "<html><style>x{}</style><body>" + "".join(
            f"<p>Item&nbsp;{n}. {t}</p><div>{b}</div>" for n, t, b in ITEMS) + "</body></html>"
        r = filing_sections.parse(html, html=True)
        self.assertEqual(r.reason, "")
        self.assertNotIn("x{}", r.text)
        self.assertIn("One office.", r.section_text("2"))
        s, e = r.sections["8"]
        self.assertEqual(r.text[s:e], r.section_text("8"))


if __name__ == "__main__":
    unittest.main()
