"""Point-in-time ticker map tests; fixtures only, no network."""
import datetime
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import ticker_map as tm

D = datetime.date
CIK = 1234


def ob(symbol, source, observed, known=None, cik=CIK):
    return tm.observation(cik, symbol, source, observed, known or observed)


class TickerMapTest(unittest.TestCase):
    def test_dei_beats_every_other_source(self):
        obs = [ob("DEI", "dei", D(2020, 1, 1)),
               ob("ACT", "corp_action", D(2020, 1, 1)),
               ob("F4", "form4", D(2020, 6, 1)),
               ob("OLD", "former_name", D(2020, 1, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2020, 6, 1)), "DEI")

    def test_corp_action_beats_form4_and_former_name(self):
        obs = [ob("ACT", "corp_action", D(2020, 1, 1)),
               ob("F4", "form4", D(2020, 6, 1)),
               ob("OLD", "former_name", D(2020, 1, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2020, 6, 1)), "ACT")

    def test_form4_beats_former_name_and_takes_nearest_date(self):
        obs = [ob("FAR", "form4", D(2019, 1, 1)),
               ob("NEAR", "form4", D(2020, 5, 25)),
               ob("OLD", "former_name", D(2020, 1, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2020, 6, 1)), "NEAR")

    def test_former_name_is_last_resort(self):
        obs = [ob("OLD", "former_name", D(2020, 1, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2020, 6, 1)), "OLD")

    def test_latest_dei_filing_before_date(self):
        obs = [ob("A", "dei", D(2020, 1, 1)), ob("B", "dei", D(2021, 1, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2020, 12, 31)), "A")

    def test_symbol_change(self):
        obs = [ob("OLD", "dei", D(2020, 1, 1)),
               ob("NEW", "corp_action", D(2021, 3, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2021, 2, 28)), "OLD")
        self.assertEqual(tm.ticker(obs, CIK, D(2021, 3, 1)), "NEW")

    def test_known_at_look_ahead_refused(self):
        late = ob("NEW", "dei", D(2020, 1, 1), known=D(2020, 3, 1))
        self.assertIsNone(tm.ticker([late], CIK, D(2020, 2, 1)))
        self.assertEqual(tm.ticker([late], CIK, D(2020, 3, 1)), "NEW")

    def test_unknown_observation_falls_through_to_lower_source(self):
        obs = [ob("DEI", "dei", D(2020, 1, 1), known=D(2020, 9, 1)),
               ob("OLD", "former_name", D(2020, 1, 1))]
        self.assertEqual(tm.ticker(obs, CIK, D(2020, 6, 1)), "OLD")

    def test_other_cik_ignored(self):
        obs = [ob("X", "dei", D(2020, 1, 1), cik=99)]
        self.assertIsNone(tm.ticker(obs, CIK, D(2020, 6, 1)))

    def test_unresolved_counted(self):
        obs = [ob("A", "dei", D(2020, 1, 1))]
        firm_dates = [(CIK, D(2020, 6, 1)), (CIK, D(2019, 6, 1)), (77, D(2020, 6, 1))]
        symbols, unresolved = tm.resolve(obs, firm_dates)
        self.assertEqual(unresolved, 2)
        self.assertEqual(symbols[(CIK, D(2020, 6, 1))], "A")
        self.assertIsNone(symbols[(77, D(2020, 6, 1))])

    def test_exclusion_limit(self):
        self.assertFalse(tm.exceeds_exclusion_limit(5, 100))
        self.assertTrue(tm.exceeds_exclusion_limit(6, 100))
        self.assertFalse(tm.exceeds_exclusion_limit(0, 0))

    def test_bad_input_refused(self):
        with self.assertRaises(tm.TickerMapError):
            tm.observation(CIK, "A", "bogus", D(2020, 1, 1), D(2020, 1, 1))
        with self.assertRaises(tm.TickerMapError):
            tm.observation(CIK, "", "dei", D(2020, 1, 1), D(2020, 1, 1))


if __name__ == "__main__":
    unittest.main()
