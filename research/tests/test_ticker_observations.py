"""Ticker observation builder tests; fixtures only, no network."""
import datetime
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from sources import ticker_map as tm
from sources import ticker_observations as to

D = datetime.date


def facts(*rows):
    return {"cik": 1234, "facts": {"dei": {"TradingSymbol": {
        "units": {"pure": [{"end": e, "val": v, "filed": f}
                           for e, v, f in rows]}}}}}


class DeiTest(unittest.TestCase):
    def test_symbol_facts(self):
        obs, skipped = to.dei_observations(
            facts(("2020-12-31", "abc", "2021-02-15")))
        self.assertEqual(obs, [tm.Observation(
            1234, "ABC", "dei", D(2020, 12, 31), D(2021, 2, 15))])
        self.assertEqual(skipped, 0)

    def test_malformed_facts_skipped_and_counted(self):
        obs, skipped = to.dei_observations(facts(
            ("2020-12-31", "ABC", "2021-02-15"),
            ("2020-12-31", "ABC", None),
            ("2020-13-45", "ABC", "2021-02-15"),
            ("2020-12-31", "", "2021-02-15"),
            ("2020-12-31", 7, "2021-02-15")))
        self.assertEqual(len(obs), 1)
        self.assertEqual(skipped, 4)

    def test_missing_cik_skips_every_fact(self):
        data = facts(("2020-12-31", "ABC", "2021-02-15"))
        del data["cik"]
        self.assertEqual(to.dei_observations(data), ([], 1))

    def test_no_dei_section(self):
        self.assertEqual(to.dei_observations({"cik": 1, "facts": {}}), ([], 0))


class Form4Test(unittest.TestCase):
    def test_rows(self):
        rows = [{"filing_date": D(2020, 3, 2), "cik": "0001234", "symbol": "ABC"},
                {"filing_date": None, "cik": "1234", "symbol": "ABC"},
                {"filing_date": D(2020, 3, 2), "cik": "x", "symbol": "ABC"},
                {"filing_date": D(2020, 3, 2), "cik": "1234", "symbol": " "}]
        obs, skipped = to.form4_observations(rows)
        self.assertEqual(obs, [tm.Observation(
            1234, "ABC", "form4", D(2020, 3, 2), D(2020, 3, 2))])
        self.assertEqual(skipped, 3)


def change(old, new, effective, process):
    return {"old_symbol": old, "new_symbol": new,
            "effective_date": effective, "process_date": process}


class CorpActionTest(unittest.TestCase):
    CIKS = {"NEW": 1234, "OLD": 1234}

    def test_new_symbol_only(self):
        obs, skipped = to.corp_action_observations(
            [change("OLD", "NEW", "2021-06-01", "2021-06-03")], self.CIKS)
        self.assertEqual(obs, [tm.Observation(
            1234, "NEW", "corp_action", D(2021, 6, 1), D(2021, 6, 3))])
        self.assertEqual(skipped, 0)

    def test_old_symbol_cik_is_enough(self):
        obs, _ = to.corp_action_observations(
            [change("OLD", "NEW", "2021-06-01", "2021-06-03")], {"OLD": 1234})
        self.assertEqual(len(obs), 1)

    def test_malformed_and_unmapped_skipped(self):
        obs, skipped = to.corp_action_observations([
            change("OLD", "NEW", "2021-06-01", None),
            change("OLD", "NEW", "June 1", "2021-06-03"),
            change("OLD", None, "2021-06-01", "2021-06-03"),
            change("ZZZ", "YYY", "2021-06-01", "2021-06-03")], self.CIKS)
        self.assertEqual((obs, skipped), ([], 4))


SUBMISSIONS = {
    "cik": "0001234",
    "formerNames": [
        {"name": "Old Widgets, Inc.", "from": "1999-01-01T00:00:00.000Z",
         "to": "2015-04-10T00:00:00.000Z"},
        {"name": "Unlisted Ltd", "from": "1990-01-01T00:00:00.000Z",
         "to": "1998-12-31T00:00:00.000Z"}],
    "filings": {"recent": {
        "form": ["10-K", "8-K", "8-K"],
        "filingDate": ["2015-03-01", "2015-04-14", "2016-01-05"]}}}
ASSETS = [{"symbol": "OWC", "name": "Old Widgets Inc. Common Stock"},
          {"symbol": "XYZ", "name": "Other Corp"}]


class FormerNameTest(unittest.TestCase):
    def test_matched_name(self):
        obs, skipped = to.former_name_observations(SUBMISSIONS, ASSETS)
        self.assertEqual(obs, [tm.Observation(
            1234, "OWC", "former_name", D(2015, 4, 10), D(2015, 4, 14))])
        self.assertEqual(skipped, 0)

    def test_unmatched_name_yields_nothing_and_is_not_a_skip(self):
        obs, skipped = to.former_name_observations(SUBMISSIONS, [ASSETS[1]])
        self.assertEqual((obs, skipped), ([], 0))

    def test_no_reporting_filing_is_skipped(self):
        subs = dict(SUBMISSIONS, filings={"recent": {
            "form": ["8-K"], "filingDate": ["2015-04-01"]}})
        self.assertEqual(to.former_name_observations(subs, ASSETS), ([], 1))

    def test_ambiguous_match_is_skipped(self):
        assets = ASSETS + [{"symbol": "OWC2", "name": "Old Widgets Inc"}]
        self.assertEqual(
            to.former_name_observations(SUBMISSIONS, assets), ([], 1))

    def test_malformed_entry_skipped(self):
        subs = dict(SUBMISSIONS, formerNames=[{"name": "Old Widgets", "to": "?"},
                                              {"to": "2015-04-10"}])
        self.assertEqual(to.former_name_observations(subs, ASSETS), ([], 2))


class EndToEndTest(unittest.TestCase):
    def test_symbol_change_resolves_across_the_change(self):
        obs, _ = to.dei_observations(facts(("2020-12-31", "OLD", "2021-02-15")))
        acts, _ = to.corp_action_observations(
            [change("OLD", "NEW", "2021-06-01", "2021-06-03")], {"NEW": 1234})
        obs += acts
        self.assertEqual(tm.ticker(obs, 1234, D(2021, 5, 1)), "OLD")
        # Effective but not yet processed: the change is not known.
        self.assertEqual(tm.ticker(obs, 1234, D(2021, 6, 2)), "OLD")
        self.assertEqual(tm.ticker(obs, 1234, D(2021, 6, 3)), "NEW")
        self.assertEqual(tm.ticker(obs, 1234, D(2021, 12, 1)), "NEW")


if __name__ == "__main__":
    unittest.main()
