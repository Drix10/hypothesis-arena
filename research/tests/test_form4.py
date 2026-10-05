import datetime
import io
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import form4 as I

D = datetime.date


def tsv(cols, rows):
    return "\t".join(cols) + "\n" + "".join("\t".join(r) + "\n" for r in rows)


def make_zip(path, subs, owners, trans):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("SUBMISSION.tsv", tsv(
            ["ACCESSION_NUMBER", "FILING_DATE", "DOCUMENT_TYPE", "ISSUERCIK",
             "ISSUERTRADINGSYMBOL"], subs))
        z.writestr("REPORTINGOWNER.tsv", tsv(
            ["ACCESSION_NUMBER", "RPTOWNERCIK", "RPTOWNER_RELATIONSHIP"],
            owners))
        z.writestr("NONDERIV_TRANS.tsv", tsv(
            ["ACCESSION_NUMBER", "SECURITY_TITLE", "TRANS_DATE", "TRANS_CODE",
             "TRANS_SHARES", "TRANS_PRICEPERSHARE"], trans))


class ReadQuarter(unittest.TestCase):
    def test_filters_and_normalizes(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "q.zip")
            make_zip(p, [
                ["A1", "05-MAR-2020", "4", "0000001", '"ABC"'],
                ["A2", "05-MAR-2020", "4/A", "0000001", "ABC"],
                ["A3", "05-MAR-2020", "4", "0000002", "BAD SYM"],
                ["A4", "05-MAR-2020", "4", "0000003", "XYZ"]],
                [["A1", "111", "Officer"], ["A2", "111", "Officer"],
                 ["A3", "112", "Director"], ["A4", "113", "TenPercentOwner"]],
                [["A1", "Common Stock", "04-MAR-2020", "P", "100", "10.5"],
                 ["A1", "Preferred", "04-MAR-2020", "P", "100", "10.5"],
                 ["A1", "Common Stock", "04-MAR-2020", "A", "100", "10.5"],
                 ["A1", "Common Stock", "04-MAR-2020", "P", "0", "10.5"],
                 ["A2", "Common Stock", "04-MAR-2020", "P", "100", "10.5"],
                 ["A3", "Common Stock", "04-MAR-2020", "P", "100", "10.5"],
                 ["A4", "Common Stock", "04-MAR-2020", "P", "100", "10.5"]])
            rows = I.read_quarter(p)
        self.assertEqual(len(rows), 2)      # A1 and A4 only
        a1 = [r for r in rows if r["cik"] == "0000001"][0]
        self.assertEqual((a1["symbol"], a1["shares"], a1["price"]),
                         ("ABC", 100.0, 10.5))
        self.assertTrue(a1["officer_or_director"])
        a4 = [r for r in rows if r["cik"] == "0000003"][0]
        self.assertFalse(a4["officer_or_director"])


def row(owner, td, fd, code="P", cik="1", sym="ABC", od=True, sh=100, px=10):
    return {"filing_date": fd, "trans_date": td, "cik": cik, "symbol": sym,
            "owner": owner, "officer_or_director": od, "code": code,
            "shares": float(sh), "price": float(px)}


class BuildEvents(unittest.TestCase):
    def test_routine_trader_is_excluded_and_new_trader_is_kept(self):
        hist = [row("r", D(y, 6, 10), D(y, 6, 11), code=c)
                for y in (2017, 2018, 2019) for c in ("P",)]
        rows = hist + [row("r", D(2020, 6, 9), D(2020, 6, 10)),
                       row("n", D(2020, 6, 9), D(2020, 6, 10))]
        ev = [e for e in I.build_events(rows) if e["date"] >= "2020"]
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["n_insiders"], 1)   # only the opportunistic one

    def test_sells_count_toward_routine_history(self):
        hist = [row("r", D(y, 6, 10), D(y, 6, 11), code="S")
                for y in (2017, 2018, 2019)]
        ev = I.build_events(hist + [row("r", D(2020, 6, 9), D(2020, 6, 10))])
        self.assertEqual(ev, [])   # history is sells only: nothing to buy-event

    def test_two_year_pattern_is_not_routine(self):
        hist = [row("r", D(y, 6, 10), D(y, 6, 11)) for y in (2018, 2019)]
        ev = I.build_events(hist + [row("r", D(2020, 6, 9), D(2020, 6, 10))])
        self.assertTrue(any(e["date"] == "2020-06-10" for e in ev))

    def test_aggregates_per_issuer_day_and_drops_non_officers(self):
        rows = [row("a", D(2020, 2, 3), D(2020, 2, 4), sh=100, px=10),
                row("b", D(2020, 2, 3), D(2020, 2, 4), sh=50, px=20),
                row("c", D(2020, 2, 3), D(2020, 2, 4), od=False)]
        ev = I.build_events(rows)
        self.assertEqual(len(ev), 1)
        self.assertEqual(ev[0]["n_insiders"], 2)
        self.assertAlmostEqual(ev[0]["value"], 2000.0)

    def test_filing_before_transaction_is_dropped(self):
        ev = I.build_events([row("a", D(2020, 2, 5), D(2020, 2, 4))])
        self.assertEqual(ev, [])


class OpportunisticFlag(unittest.TestCase):
    def history(self, owner, years, month, code="P"):
        return [row(owner, D(y, month, 10), D(y, month, 11), code=code)
                for y in years]

    def event(self, rows, date):
        return [e for e in I.build_events(rows) if e["date"] == date][0]

    def test_non_habitual_insider_with_long_history_is_flagged(self):
        rows = self.history("o", (2016, 2017, 2018), 3) + [
            row("o", D(2020, 6, 9), D(2020, 6, 10))]
        self.assertTrue(self.event(rows, "2020-06-10")["opportunistic"])

    def test_habitual_insider_produces_no_event(self):
        rows = self.history("h", (2017, 2018, 2019), 6) + [
            row("h", D(2020, 6, 9), D(2020, 6, 10))]
        self.assertFalse([e for e in I.build_events(rows)
                          if e["date"] == "2020-06-10"])

    def test_short_history_is_unclassified_and_not_flagged(self):
        rows = self.history("s", (2018, 2019), 3) + [
            row("s", D(2020, 6, 9), D(2020, 6, 10))]
        self.assertFalse(self.event(rows, "2020-06-10")["opportunistic"])
        lone = [row("s", D(2020, 6, 9), D(2020, 6, 10))]
        self.assertFalse(I.build_events(lone)[0]["opportunistic"])

    def test_history_boundary_is_three_whole_years(self):
        first = D(2017, 6, 9)
        self.assertTrue(I.has_history(first, D(2020, 6, 9)))
        self.assertFalse(I.has_history(first, D(2020, 6, 8)))
        self.assertTrue(I.has_history(D(2017, 2, 28), D(2020, 2, 29)))

    def test_event_flag_needs_a_classified_contributor(self):
        rows = self.history("o", (2016, 2017, 2018), 3) + [
            row("o", D(2020, 6, 9), D(2020, 6, 10)),
            row("n", D(2020, 6, 9), D(2020, 6, 10))]
        e = self.event(rows, "2020-06-10")
        self.assertEqual(e["n_insiders"], 2)
        self.assertTrue(e["opportunistic"])

    def test_sales_never_produce_a_flagged_event(self):
        rows = self.history("o", (2016, 2017, 2018), 3) + [
            row("o", D(2020, 6, 9), D(2020, 6, 10), code="S")]
        self.assertFalse([e for e in I.build_events(rows)
                          if e["date"] == "2020-06-10"])

    def test_entry_is_second_session_open_after_acceptance(self):
        e = I.build_events([row("a", D(2020, 6, 9), D(2020, 6, 10))])[0]
        self.assertEqual(e["accepted"], "2020-06-10T23:59")
        self.assertEqual(e["entry"], "2020-06-12T09:30")   # Wed filing, Fri

    def test_entry_skips_weekend(self):
        e = I.build_events([row("a", D(2020, 6, 10), D(2020, 6, 11))])[0]
        self.assertEqual(e["entry"], "2020-06-15T09:30")   # Thu filing, Mon
        e = I.build_events([row("a", D(2020, 6, 11), D(2020, 6, 12))])[0]
        self.assertEqual(e["entry"], "2020-06-16T09:30")   # Fri filing, Tue


if __name__ == "__main__":
    unittest.main()
