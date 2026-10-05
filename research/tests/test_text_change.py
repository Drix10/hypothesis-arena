import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.sources import filing_sections as FS
from research.strategy import text_change as T

RISK = ("Our supplier base is concentrated. A lawsuit could harm us. "
        "The CEO and CFO may depart.\n")
MDA = "Revenue grew on higher volume. Margins were stable.\n"


def doc(risk=RISK, mda=MDA, skip=()):
    items = [("1", "Business text here.\n"), ("1A", risk), ("2", "Properties.\n"),
             ("7", mda), ("7A", "Market risk.\n"), ("8", "Statements.\n")]
    return "".join("Item %s.\n%s" % (i, t) for i, t in items if i not in skip)


def filing(period, accepted, text=None, cik="1", form="10-K"):
    return T.Filing(cik, form, period, accepted, FS.parse(text or doc()))


PRIOR = filing("2023-12-31", "2024-02-20T16:05:00-05:00")


class TextChangeTest(unittest.TestCase):
    def test_identical_text_scores_zero_delta(self):
        s = T.score(filing("2024-12-31", "2025-02-20T16:05:00-05:00"), [PRIOR])
        self.assertAlmostEqual(s["delta"], 0.0)
        self.assertEqual(s["known_at"], "2025-02-20T16:05:00-05:00")

    def test_changed_text_scores_higher(self):
        new = doc(risk="Cyber attacks threaten operations. Regulators may fine us.\n",
                  mda="Costs rose sharply on freight.\n")
        s = T.score(filing("2024-12-31", "2025-02-20T16:05:00-05:00", new), [PRIOR])
        self.assertGreater(s["delta"], 0.5)
        self.assertLessEqual(s["delta"], 1.0)

    def test_sub_scores(self):
        new = doc(risk="Our supplier base is concentrated. A class action could "
                       "harm us. The CEO may depart.\n")
        s = T.score(filing("2024-12-31", "2025-02-20T16:05:00-05:00", new), [PRIOR])
        self.assertGreater(s["litigation"], 0)
        self.assertGreater(s["officer"], 0)

    def test_sub_score_missing_language_is_none(self):
        plain = doc(risk="Supply is concentrated.\n")
        p = filing("2023-12-31", "2024-02-20T16:05:00-05:00", plain)
        c = filing("2024-12-31", "2025-02-20T16:05:00-05:00", plain)
        s = T.score(c, [p])
        self.assertIsNone(s["litigation"])
        self.assertIsNone(s["officer"])

    def test_missing_section_gives_none(self):
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00", doc(skip=("1A",)))
        self.assertIsNone(T.score(cur, [PRIOR]))

    def test_missing_prior_section_gives_none(self):
        p = filing("2023-12-31", "2024-02-20T16:05:00-05:00", doc(skip=("7",)))
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        self.assertIsNone(T.score(cur, [p]))

    def test_first_year_filer_gives_none(self):
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        self.assertIsNone(T.score(cur, []))

    def test_other_filer_or_form_is_not_a_counterpart(self):
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        other = filing("2023-12-31", "2024-02-20T16:05:00-05:00", cik="2")
        q = filing("2023-12-31", "2024-02-20T16:05:00-05:00", form="10-Q")
        self.assertIsNone(T.score(cur, [other, q]))

    def test_prior_gap_must_be_about_a_year(self):
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        near = filing("2024-09-30", "2024-11-05T16:05:00-05:00")
        self.assertIsNone(T.score(cur, [near]))

    def test_history_accepted_later_is_ignored(self):
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        late = filing("2023-12-31", "2025-02-20T16:05:00-05:00")
        later = filing("2023-12-31", "2025-03-01T09:00:00-05:00")
        self.assertIsNone(T.score(cur, [late, later]))

    def test_score_ignores_later_history(self):
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        newer = filing("2024-12-31", "2025-06-01T09:00:00-04:00",
                       doc(risk="Entirely different words appear here.\n"))
        self.assertEqual(T.score(cur, [PRIOR]), T.score(cur, [PRIOR, newer]))

    def test_latest_accepted_prior_is_used(self):
        amended = filing("2023-12-31", "2024-03-15T09:00:00-04:00",
                         doc(risk="Cyber attacks threaten operations.\n"))
        cur = filing("2024-12-31", "2025-02-20T16:05:00-05:00")
        self.assertGreater(T.score(cur, [PRIOR, amended])["delta"], 0.0)

    def test_naive_datetime_is_refused(self):
        with self.assertRaises(T.TextChangeError):
            T.score(filing("2024-12-31", "2025-02-20T16:05:00"), [PRIOR])


if __name__ == "__main__":
    unittest.main()
