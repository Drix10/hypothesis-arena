import datetime
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import issuer_symbols as S

D = datetime.date


def tsv(cols, rows):
    return "\t".join(cols) + "\n" + "".join("\t".join(r) + "\n" for r in rows)


class Symbols(unittest.TestCase):
    def test_nearest_in_time_then_current_fallback(self):
        h = {"1": [(D(2016, 1, 1), "OLD"), (D(2020, 1, 1), "NEW")]}
        cur = {"1": "CUR", "2": "TWO"}
        self.assertEqual(S.symbol_for("1", D(2017, 1, 1), h, cur), "OLD")
        self.assertEqual(S.symbol_for("1", D(2019, 6, 1), h, cur), "NEW")
        self.assertEqual(S.symbol_for("2", D(2019, 6, 1), h, cur), "TWO")
        self.assertIsNone(S.symbol_for("3", D(2019, 6, 1), h, cur))

    def test_read_symbols_validates_and_normalizes(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "2020q1_form345.zip")
            with zipfile.ZipFile(p, "w") as z:
                z.writestr("SUBMISSION.tsv", tsv(
                    ["ACCESSION_NUMBER", "FILING_DATE", "ISSUERCIK",
                     "ISSUERTRADINGSYMBOL"],
                    [["a", "05-JAN-2020", "0000000010", "abc"],
                     ["b", "06-JAN-2020", "0000000011", "N/A"],
                     ["c", "07-JAN-2020", "0000000012", "BRK-B"]]))
            h = S.read_symbols([p])
        self.assertEqual(h, {"10": [(D(2020, 1, 5), "ABC")],
                             "12": [(D(2020, 1, 7), "BRK-B")]})

    def test_read_tickers_validates_and_normalizes(self):
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "company_tickers.json")
            with open(p, "w") as f:
                json.dump({"0": {"cik_str": 10, "ticker": "abc"},
                           "1": {"cik_str": 11, "ticker": "TOOLONGX"},
                           "2": {"cik_str": 12, "ticker": "brk-b"}}, f)
            self.assertEqual(S.read_tickers(p),
                             {"10": "ABC", "12": "BRK-B"})


if __name__ == "__main__":
    unittest.main()
