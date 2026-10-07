"""build_vetoes on fixture files and injected Alpaca and FINRA transports:
each veto follows its rule, an unavailable input vetoes and is listed, missing
keys refuse, and the output loads in run_connected_drift. No network."""
import json
import os
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.engine import link_store
from research.strategy import build_vetoes as B
from research.strategy import composite
from research.strategy import run_connected_drift as R

END = "2018-12-31"
ENV = {"ALPACA_KEY_ID": "k", "ALPACA_SECRET": "s"}
GOOD_Z = {"Assets": 1000.0, "Liabilities": 400.0, "AssetsCurrent": 500.0,
          "LiabilitiesCurrent": 200.0, "RetainedEarningsAccumulatedDeficit":
          300.0, "OperatingIncomeLoss": 100.0, "Revenues": 800.0}
BAD_Z = dict(GOOD_Z, RetainedEarningsAccumulatedDeficit=-900.0,
             OperatingIncomeLoss=-300.0)
CLEAN = "<html><body>Our results were strong.</body></html>"
GOING = ("<p>There is substantial doubt about our ability to continue as a "
         "<b>going</b> concern.</p>")
# symbol: (cik, shares, 10-K text, Alpaca flags, FINRA (short, days to cover),
# FSDS values)
FIRMS = {
    "GOOD": (1, 1000, CLEAN, (True, True), (10, 2.0), GOOD_Z),
    "GOING": (2, 1000, GOING, (True, True), (10, 2.0), GOOD_Z),
    "LOWZ": (3, 1000, CLEAN, (True, True), (10, 2.0), BAD_Z),
    "HARD": (4, 1000, CLEAN, (True, False), (10, 2.0), GOOD_Z),
    "SHORTY": (5, 1000, CLEAN, (True, True), (300, 2.0), GOOD_Z),
    "SLOW": (6, 1000, CLEAN, (True, True), (10, 11.0), GOOD_Z),
    "NOFIN": (7, 1000, CLEAN, (True, True), (10, 2.0), None),
    "NOTEXT": (8, 1000, None, (True, True), (10, 2.0), GOOD_Z),
    "NOFINRA": (9, 1000, CLEAN, (True, True), None, GOOD_Z),
    "NOSHARES": (10, None, CLEAN, (True, True), (10, 2.0), GOOD_Z),
    "NOASSET": (11, 1000, CLEAN, None, (10, 2.0), GOOD_Z),
}
OWNED = {cik: 0.1 for cik in range(1, 12)}
OWNED[10] = 0.9  # NOSHARES: concentrated common ownership
del OWNED[11]  # NOASSET: no ownership edge known


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def fsds_zip(path):
    sub = ["adsh\tcik\tform\tfiled\tperiod"]
    num = ["adsh\ttag\tddate\tqtrs\tuom\tsegments\tcoreg\tvalue"]
    for cik, vals in ((f[0], f[5]) for f in FIRMS.values()):
        if vals is None:
            continue
        sub.append("a%d\t%d\t10-K\t20180301\t20171231" % (cik, cik))
        sub.append("old%d\t%d\t10-K\t20160301\t20151231" % (cik, cik))
        for tag, v in vals.items():
            q = "4" if tag in ("OperatingIncomeLoss", "Revenues") else "0"
            num.append("a%d\t%s\t20171231\t%s\tUSD\t\t\t%s" % (cik, tag, q, v))
            num.append("old%d\t%s\t20151231\t%s\tUSD\t\t\t1" % (cik, tag, q))
        num.append("a%d\tAssets\t20171231\t0\tUSD\tseg\t\t5" % cik)
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("sub.txt", "\n".join(sub) + "\n")
        z.writestr("num.txt", "\n".join(num) + "\n")


def write_data(d):
    ref = {"ciks": {"%010d" % f[0]: s for s, f in FIRMS.items()},
           "industry": {}, "beta": {},
           "market_cap": {s: [{"known_at": "2018-11-30", "value": 500.0}]
                          for s in FIRMS}}
    write(os.path.join(d, "reference.json"),
          json.dumps({"through": END, "data": ref}))
    rows = []
    for s, (cik, shares, text, *_rest) in FIRMS.items():
        if shares is not None:
            write(os.path.join(d, "reference_cache", s + ".json"), json.dumps(
                {"cik": cik, "facts": {"facts": {"dei": {
                    "EntityCommonStockSharesOutstanding": {"units": {
                        "shares": [{"val": shares, "end": "2017-12-31",
                                    "filed": "2018-03-01", "accn": "x",
                                    "form": "10-K"}]}}}}}}))
        for acc, filed, body in (("0000000000-18-%06d" % cik, "2018-03-01",
                                  text),
                                 ("0000000000-19-%06d" % cik, "2019-03-01",
                                  GOING)):
            if body is None:
                continue
            write(os.path.join(d, "filings", "%010d" % cik, acc, "k.htm"),
                  body)
            rows.append({"cik": cik, "accession": acc, "form": "10-K",
                         "filing_date": filed, "primary_document": "k.htm"})
    write(os.path.join(d, "filings", "manifest.jsonl"),
          "".join(json.dumps(r) + "\n" for r in rows))
    os.makedirs(os.path.join(d, "fsds"))
    fsds_zip(os.path.join(d, "fsds", "2018q1.zip"))
    store = link_store.LinkStore(os.path.join(d, "link_store.jsonl"))
    for cik, w in OWNED.items():
        store.add(edge_id="o%d" % cik, src_cik="%010d" % cik,
                  dst_cik="%010d" % 99, source="ownership",
                  type="common_owner", weight=w, valid_from=20180101,
                  valid_to=None, known_at=20180201, evidence_ids=["x"],
                  extractor="deterministic",
                  contamination_class="deterministic")


def alpaca(method, base, path, body=None):
    flags = FIRMS[path.rsplit("/", 1)[1]][3]
    if flags is None:
        return 404, {"message": "not found"}
    return 200, {"shortable": flags[0], "easy_to_borrow": flags[1]}


def finra(url):
    if url.endswith("shrt20181231.csv"):
        return 404, b""
    if not url.endswith("shrt20181230.csv"):
        raise AssertionError(url)
    lines = ["symbolCode|currentShortPositionQuantity|daysToCoverQuantity"]
    lines += ["%s|%s|%s" % ((s,) + f[4]) for s, f in FIRMS.items()
              if f[4] is not None]
    return 200, "\n".join(lines).encode()


class BuildVetoes(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        write_data(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def run_main(self, env=ENV, **kw):
        logs = []
        kw.setdefault("transport", alpaca)
        kw.setdefault("finra_get", finra)
        rc = B.main(["--data", self.dir, "--end", END], env=env,
                    log=logs.append, sleep=lambda s: None, **kw)
        return rc, logs

    def output(self):
        with open(os.path.join(self.dir, "vetoes.json")) as f:
            return json.load(f)

    def test_each_veto_follows_its_rule(self):
        rc, _ = self.run_main()
        self.assertEqual(rc, 0)
        v = self.output()["data"]
        self.assertEqual(sorted(v), sorted(composite.VETOES))
        vetoed = {n: {s for s, x in m.items() if x} for n, m in v.items()}
        self.assertEqual(vetoed["distress"], {"GOING", "LOWZ", "NOTEXT"})
        self.assertEqual(vetoed["no_borrow"], {"HARD", "NOASSET"})
        self.assertEqual(vetoed["crowded"],
                         {"SHORTY", "SLOW", "NOFINRA", "NOSHARES"})
        self.assertEqual(vetoed["forced_seller"], {"NOSHARES", "NOASSET"})
        for m in v.values():
            self.assertEqual(sorted(m), sorted(FIRMS))
            self.assertTrue(all(isinstance(x, bool) for x in m.values()))

    def test_unavailable_inputs_are_listed(self):
        self.run_main()
        un = self.output()["unavailable"]
        self.assertEqual(un["filing_text"], ["NOTEXT"])
        self.assertEqual(un["altman_z"], ["NOFIN"])
        self.assertEqual(un["alpaca_asset"], ["NOASSET"])
        self.assertEqual(un["finra_short_interest"], ["NOFINRA"])
        self.assertEqual(un["shares_outstanding"], ["NOSHARES"])
        self.assertEqual(un["ownership_edges"], ["NOASSET"])

    def test_no_finra_file_vetoes_every_short(self):
        rc, _ = self.run_main(finra_get=lambda url: (404, b""))
        self.assertEqual(rc, 0)
        self.assertTrue(all(self.output()["data"]["crowded"].values()))

    def test_missing_ownership_edges_veto(self):
        os.remove(os.path.join(self.dir, "link_store.jsonl"))
        self.run_main()
        self.assertTrue(all(self.output()["data"]["forced_seller"].values()))

    def test_missing_keys_refuse_before_any_request(self):
        def boom(*a, **k):
            raise AssertionError("request")
        rc, _ = self.run_main(env={}, transport=boom, finra_get=boom)
        self.assertEqual(rc, 2)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "vetoes.json")))

    def test_missing_reference_writes_nothing(self):
        os.remove(os.path.join(self.dir, "reference.json"))
        rc, _ = self.run_main()
        self.assertEqual(rc, 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "vetoes.json")))

    def test_rerun_is_identical(self):
        self.run_main()
        first = self.output()
        self.run_main()
        self.assertEqual(self.output(), first)

    def test_going_concern_needs_both_phrases(self):
        self.assertTrue(B.going_concern(GOING))
        self.assertFalse(B.going_concern("<p>a going concern basis</p>"))

    def test_output_loads_in_the_runner(self):
        self.run_main()
        data = R.read_dataset(self.dir, "vetoes.json", END)
        inp = R.Inputs({}, {"market_cap": {}, "beta": {}, "ciks": {},
                            "industry": {}}, None, {}, [], data)
        self.assertEqual(sorted(inp.vetoes), sorted(composite.VETOES))
        self.assertIs(inp.vetoes["distress"]("GOOD"), False)
        self.assertIs(inp.vetoes["distress"]("GOING"), True)
        self.assertIs(inp.vetoes["distress"]("UNLISTED"), True)


if __name__ == "__main__":
    unittest.main()
