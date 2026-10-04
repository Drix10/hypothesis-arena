"""Ken French factor parser tests; fixtures only, no network."""
import hashlib
import io
import os
import sys
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root (collector)
sys.path.insert(0, ROOT)

from sources import french_factors as ff

FF5_HEAD = ("Daily Fama-French 5 factors.\n\n"
            ",Mkt-RF,SMB,HML,RMW,CMA,RF\n")
MOM_HEAD = "Daily momentum.\n\n,Mom   \n"


def _zip(text):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("data.CSV", text)
    return buf.getvalue()


def _ff5(*rows):
    return _zip(FF5_HEAD + "".join(rows) + "\nCopyright 2026 Kenneth French\n")


GOOD = ("20240102,  -0.67,  0.50, 0.10, -0.20, 0.30, 0.021\n"
        "20240103,   1.00, -0.50, 0.00,  0.00, 0.00, 0.021\n")


class ParseTest(unittest.TestCase):
    def test_parse_and_percent_to_decimal(self):
        rows = ff.parse_zip(_ff5(GOOD), ff.FF5_COLUMNS)
        self.assertEqual([d for d, _ in rows], ["2024-01-02", "2024-01-03"])
        self.assertAlmostEqual(rows[0][1]["Mkt-RF"], -0.0067)
        self.assertAlmostEqual(rows[0][1]["RF"], 0.00021)
        self.assertAlmostEqual(rows[1][1]["Mkt-RF"], 0.01)

    def test_malformed_rows_fail(self):
        for bad in ("20240102,1,2,3\n",
                    "20240102,1,2,3,4,5,x\n",
                    "20240230,1,2,3,4,5,6\n",
                    "20240102,1,2,3,4,5,-99.99\n",
                    "2024-01-02,1,2,3,4,5,6\n"):
            with self.assertRaises(ff.FactorError, msg=bad):
                ff.parse_zip(_ff5(bad), ff.FF5_COLUMNS)

    def test_duplicate_date_fails(self):
        row = "20240102,1,2,3,4,5,6\n"
        with self.assertRaisesRegex(ff.FactorError, "duplicate"):
            ff.parse_zip(_ff5(row, row), ff.FF5_COLUMNS)

    def test_out_of_order_fails(self):
        with self.assertRaisesRegex(ff.FactorError, "out-of-order"):
            ff.parse_zip(_ff5("20240103,1,2,3,4,5,6\n",
                              "20240102,1,2,3,4,5,6\n"), ff.FF5_COLUMNS)

    def test_date_gap_fails_but_long_weekend_passes(self):
        ok = _ff5("20240112,1,2,3,4,5,6\n", "20240116,1,2,3,4,5,6\n")
        self.assertEqual(len(ff.parse_zip(ok, ff.FF5_COLUMNS)), 2)
        with self.assertRaisesRegex(ff.FactorError, "gap"):
            ff.parse_zip(_ff5("20240102,1,2,3,4,5,6\n",
                              "20240115,1,2,3,4,5,6\n"), ff.FF5_COLUMNS)

    def test_wrong_header_and_empty_fail(self):
        with self.assertRaises(ff.FactorError):
            ff.parse_zip(_zip(MOM_HEAD + "20240102, 1.0\n"), ff.FF5_COLUMNS)
        with self.assertRaisesRegex(ff.FactorError, "no data"):
            ff.parse_zip(_zip(FF5_HEAD), ff.FF5_COLUMNS)

    def test_not_a_zip_fails(self):
        with self.assertRaises(ff.FactorError):
            ff.parse_zip(b"nope", ff.FF5_COLUMNS)


class MergeFetchTest(unittest.TestCase):
    def setUp(self):
        self.ff5 = _ff5(GOOD)
        self.mom = _zip(MOM_HEAD + "20231229, 0.1\n20240102, 0.50\n"
                        "20240103, -0.25\n")

    def test_merge_adds_momentum(self):
        rows = ff.merge(ff.parse_zip(self.ff5, ff.FF5_COLUMNS),
                        ff.parse_zip(self.mom, ff.MOM_COLUMNS))
        self.assertAlmostEqual(rows[1][1]["Mom"], -0.0025)

    def test_merge_missing_momentum_fails(self):
        short = _zip(MOM_HEAD + "20240102, 0.50\n")
        with self.assertRaisesRegex(ff.FactorError, "missing"):
            ff.merge(ff.parse_zip(self.ff5, ff.FF5_COLUMNS),
                     ff.parse_zip(short, ff.MOM_COLUMNS))

    def test_fetch_manifest_and_user_agent(self):
        seen = []

        def transport(url, headers, timeout_s):
            seen.append(headers["User-Agent"])
            return 200, {}, self.ff5 if url == ff.FF5_URL else self.mom

        rows, manifest = ff.fetch(contact="a@b.c", transport=transport,
                                  clock=lambda: 0)
        self.assertEqual(len(rows), 2)
        self.assertTrue(all("contact=a@b.c" in ua for ua in seen))
        f = manifest["files"][0]
        self.assertEqual(f["url"], ff.FF5_URL)
        self.assertEqual(f["retrieved_at"], "1970-01-01T00:00:00Z")
        self.assertEqual(f["sha256"], hashlib.sha256(self.ff5).hexdigest())

    def test_fetch_http_error_fails(self):
        with self.assertRaises(ff.FactorError):
            ff.fetch(contact="a@b.c", clock=lambda: 0,
                     transport=lambda u, h, t: (503, {}, b""))


if __name__ == "__main__":
    unittest.main()
