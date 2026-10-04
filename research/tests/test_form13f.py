"""13F parser and overlap tests; fixtures only, no network."""
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)

from sources import form13f as f13


def _row(cusip="037833100", name="APPLE INC", value="1000", shares="10",
         put_call=None, discretion="SOLE"):
    pc = "<putCall>%s</putCall>" % put_call if put_call else ""
    return ("<infoTable><nameOfIssuer>%s</nameOfIssuer><cusip>%s</cusip>"
            "<value>%s</value><shrsOrPrnAmt><sshPrnamt>%s</sshPrnamt>"
            "<sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>%s"
            "<investmentDiscretion>%s</investmentDiscretion></infoTable>"
            % (name, cusip, value, shares, pc, discretion))


def _doc(*rows):
    return ('<informationTable xmlns="http://www.sec.gov/edgar/document/'
            'thirteenf/informationtable">%s</informationTable>' % "".join(rows))


def _parse(doc, period="2024-03-31", filed="2024-05-10"):
    return f13.parse_information_table(doc, "1234", period, filed)


class ParseTest(unittest.TestCase):
    def test_row_fields(self):
        r = _parse(_doc(_row()))[0]
        self.assertEqual(r, {
            "cik": "1234", "period": "2024-03-31", "filing_date": "2024-05-10",
            "cusip": "037833100", "issuer": "APPLE INC", "value": 1000,
            "shares": 10, "put_call": "", "discretion": "SOLE"})

    def test_value_in_thousands_before_2023(self):
        r = _parse(_doc(_row(value="5")), period="2022-12-31")[0]
        self.assertEqual(r["value"], 5000)

    def test_value_in_dollars_from_2023(self):
        r = _parse(_doc(_row(value="5")), period="2023-03-31")[0]
        self.assertEqual(r["value"], 5)

    def test_option_rows_dropped(self):
        rows = _parse(_doc(_row(), _row(cusip="594918104", put_call="Put"),
                           _row(cusip="88160R101", put_call="CALL")))
        self.assertEqual([r["cusip"] for r in rows], ["037833100"])

    def test_doctype_rejected(self):
        doc = '<!DOCTYPE x [<!ENTITY e "v">]>' + _doc(_row())
        with self.assertRaises(f13.Form13fError):
            _parse(doc)

    def test_entity_without_doctype_rejected(self):
        with self.assertRaises(f13.Form13fError):
            _parse('<!ENTITY e "v">' + _doc(_row()))

    def test_malformed_rows_refused(self):
        bad = [_row(cusip="SHORT"), _row(value="1.5"), _row(shares="-3"),
               _row(name=""), _row(discretion="XXX"),
               _row(put_call="STRADDLE")]
        for row in bad:
            with self.assertRaises(f13.Form13fError, msg=row):
                _parse(_doc(_row(), row))

    def test_bad_inputs_refused(self):
        for doc in ("<informationTable", _doc()):
            with self.assertRaises(f13.Form13fError):
                _parse(doc)
        with self.assertRaises(f13.Form13fError):
            _parse(_doc(_row()), period="2024-3-31")


def _h(cik, period, filed, cusip, value):
    return {"cik": cik, "period": period, "filing_date": filed,
            "cusip": cusip, "value": value}


A, B, C = "AAAAAAAAA", "BBBBBBBBB", "CCCCCCCCC"


class OverlapTest(unittest.TestCase):
    def setUp(self):
        q = ("2024-03-31", "2024-05-10")
        self.rows = [
            # filer 1: A 50%, B 25%, C 25% -> min(.5,.25) = .25
            _h("1", *q, A, 200), _h("1", *q, B, 100), _h("1", *q, C, 100),
            # filer 2: A 20%, B 80% -> .2
            _h("2", *q, A, 20), _h("2", *q, B, 80),
            # filer 3 holds only A
            _h("3", *q, A, 50),
        ]

    def test_known_overlap(self):
        self.assertAlmostEqual(
            f13.overlap(self.rows, A, B, "2024-06-01"), 0.25 + 0.2)

    def test_symmetric_and_disjoint(self):
        self.assertEqual(f13.overlap(self.rows, A, B, "2024-06-01"),
                         f13.overlap(self.rows, B, A, "2024-06-01"))
        self.assertEqual(f13.overlap(self.rows, A, "ZZZZZZZZZ", "2024-06-01"), 0)

    def test_lookahead_filing_excluded(self):
        self.assertEqual(f13.overlap(self.rows, A, B, "2024-05-09"), 0)

    def test_latest_filing_per_filer_used(self):
        later = ("2024-06-30", "2024-08-09")
        rows = self.rows + [_h("2", *later, A, 50), _h("2", *later, B, 50)]
        self.assertAlmostEqual(f13.overlap(rows, A, B, "2024-09-01"), 0.25 + 0.5)
        # before the new filing is public the old quarter still applies
        self.assertAlmostEqual(f13.overlap(rows, A, B, "2024-08-08"), 0.45)


if __name__ == "__main__":
    unittest.main()
