"""fetch_french_factors on fixture zips and an injected transport: units,
header and coverage checks, the written contract, and the runner refusing a
missing, stale or malformed factors file. No network."""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from research.strategy import fetch_french_factors as F
from research.strategy import run_connected_drift as R
from sources import french_factors as ff
from test_french_factors import MOM_HEAD, _ff5, _zip

ENV = {"MIRO_CONTACT": "test@example.com"}
FF5 = _ff5("20160104,  -0.67,  0.50, 0.10, -0.20, 0.30, 0.021\n",
           "20160105,   1.00, -0.50, 0.00,  0.00, 0.00, 0.021\n")
MOM = _zip(MOM_HEAD + "20160104, 0.40\n20160105, -0.10\n"
           "\nCopyright 2026 Kenneth French\n")


def transport(ff5=FF5, mom=MOM):
    def get(url, headers, timeout_s):
        return 200, {}, ff5 if url == ff.FF5_URL else mom
    return get


class FetchTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name
        self.path = os.path.join(self.dir, "french_factors.json")
        self.log = []

    def run_main(self, *extra, env=ENV, **kw):
        return F.main(["--data", self.dir, *extra], env=env,
                      log=self.log.append, clock=lambda: 0.0,
                      transport=kw.pop("transport", transport()), **kw)

    def test_writes_contract_and_reports(self):
        self.assertEqual(self.run_main("--start", "2016-01-04"), 0)
        with open(self.path, encoding="utf-8") as f:
            ds = json.load(f)
        self.assertEqual(ds["through"], "2016-01-05")
        self.assertEqual(len(ds["data"]), 2)
        d, vals = ds["data"][0]
        self.assertEqual(d, "2016-01-04")
        self.assertAlmostEqual(vals["Mkt-RF"], -0.0067)
        self.assertAlmostEqual(vals["Mom"], 0.004)
        self.assertEqual(set(vals), set(F.NAMES))
        self.assertIn("rows 2", self.log)
        self.assertIn("first 2016-01-04", self.log)
        self.assertIn("last 2016-01-05", self.log)
        self.assertTrue(any(ln.startswith("largest gap 1 days")
                            for ln in self.log))

    def test_rerun_is_idempotent(self):
        self.run_main("--start", "2016-01-04")
        with open(self.path, "rb") as f:
            first = f.read()
        self.run_main("--start", "2016-01-04")
        with open(self.path, "rb") as f:
            self.assertEqual(f.read(), first)

    def test_requires_contact(self):
        self.assertEqual(self.run_main(env={}), 2)
        self.assertFalse(os.path.exists(self.path))

    def test_coverage_after_start_refused(self):
        self.assertEqual(self.run_main("--start", "2016-01-01"), 1)
        self.assertFalse(os.path.exists(self.path))
        self.assertIn("coverage starts 2016-01-04", self.log[-1])

    def test_unconverted_units_refused(self):
        rows = [("2016-01-04", dict.fromkeys(F.NAMES, 0.0))]
        rows[0][1]["SMB"] = 60.0
        with self.assertRaises(F.VerifyError):
            F.verify(rows, "2016-01-04")

    def test_missing_factor_refused(self):
        rows = [("2016-01-04", {"Mkt-RF": 0.0})]
        with self.assertRaises(F.VerifyError):
            F.verify(rows, "2016-01-04")

    def test_bad_download_refused_and_nothing_written(self):
        code = self.run_main("--start", "2016-01-04",
                             transport=transport(mom=_zip("junk\n")))
        self.assertEqual(code, 1)
        self.assertFalse(os.path.exists(self.path))

    def test_runner_reads_written_file(self):
        self.run_main("--start", "2016-01-04")
        rows = R.read_factors(self.dir, "2016-01-05")
        self.assertEqual(rows[0][0], "2016-01-04")


class RunnerFactorsTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = tmp.name

    def write(self, data, through="2018-12-31"):
        with open(os.path.join(self.dir, "french_factors.json"), "w") as f:
            json.dump({"through": through, "data": data}, f)

    def test_missing_refused(self):
        with self.assertRaisesRegex(R.RunnerError, "dataset-missing"):
            R.read_factors(self.dir, "2018-12-31")

    def test_stale_refused(self):
        self.write([["2018-01-02", dict.fromkeys(F.NAMES + ("RF",), 0.0)]],
                   through="2018-06-30")
        with self.assertRaisesRegex(R.RunnerError, "dataset-stale"):
            R.read_factors(self.dir, "2018-12-31")

    def test_malformed_refused(self):
        for data in ([], [["2018-01-02", {"Mkt-RF": 0.0}]],
                     [["2018-01-02", dict.fromkeys(F.NAMES + ("RF",), None)]]):
            self.write(data)
            with self.assertRaisesRegex(R.RunnerError, "dataset-malformed"):
                R.read_factors(self.dir, "2018-12-31")


if __name__ == "__main__":
    unittest.main()
