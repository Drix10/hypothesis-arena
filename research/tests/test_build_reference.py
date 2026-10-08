"""build_reference on synthetic bars and an injected SEC transport: beta and
market cap are point in time, a symbol without shares or enough bars is
omitted by reason, a rerun makes no SEC requests until it builds past the
fetch date, and the output loads in run_connected_drift. No network."""
import datetime
import json
import os
import random
import sys
import tempfile
import unittest
from datetime import datetime as dt, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.sources import edgar
from research.strategy import build_reference as B
from research.strategy import run_connected_drift as R
from research.strategy import sip_fetch

NOW = dt(2018, 1, 1, 20, 0, tzinfo=timezone.utc)
START, END = datetime.date(2016, 1, 1), datetime.date(2017, 9, 29)
ENV = {"MIRO_CONTACT": "test@example.com"}
# symbol: (cik, sic, TradingSymbol, share rows)
SHARES = [{"val": 1000, "end": "2015-12-31", "filed": "2016-02-10",
           "accn": "a-1", "form": "10-K"}]


def sec(symbol, cik, sic="3571", listed=None, shares=SHARES):
    dei = {"TradingSymbol": {"units": {"pure": [
        {"end": "2015-12-31", "val": listed or symbol, "filed": "2016-02-10"}]}},
        "EntityPublicFloat": {"units": {"USD": []}}}
    if shares:
        dei["EntityCommonStockSharesOutstanding"] = {
            "units": {"shares": shares}}
    return {"cik": cik, "sic": sic,
            "facts": {"cik": cik, "facts": {"dei": dei}}}


SECS = {"AAA": sec("AAA", 1), "BBB": sec("BBB", 2, sic="7372"),
        "NOSH": sec("NOSH", 3, shares=None), "NOSIC": sec("NOSIC", 4, sic=""),
        "MISM": sec("MISM", 5, listed="OTHER"), "SHORT": sec("SHORT", 6),
        "NOBAR": sec("NOBAR", 7)}


def make_closes():
    r = random.Random(3)
    spy, a, b, short = {}, {}, {}, {}
    px = [100.0, 100.0, 100.0, 100.0]
    d = START
    while d <= END:
        if d.weekday() < 5:
            ret = r.gauss(0.0004, 0.01)
            px[0] *= 1 + ret
            px[1] *= 1 + 2 * ret
            px[2] *= 1 + 0.5 * ret + r.gauss(0, 0.004)
            px[3] *= 1 + ret
            day = d.isoformat()
            spy[day], a[day], b[day] = px[0], px[1], px[2]
            if d >= datetime.date(2017, 6, 1):
                short[day] = px[3]
        d += datetime.timedelta(days=1)
    return {"SPY": spy, "AAA": a, "BBB": b, "NOSH": a, "NOSIC": a,
            "MISM": a, "SHORT": short}


CLOSES = make_closes()


def write_bars(data_dir):
    for sym, series in CLOSES.items():
        rows = [{"t": d + "T05:00:00Z", "o": c, "h": c, "l": c, "c": c, "v": 1}
                for d, c in series.items()]
        sip_fetch.write_dataset(
            sym, "bars", "2016-01-01T00:00:00Z", "2017-09-30T00:00:00Z",
            data_dir, "1Day", "split",
            http_get=lambda url, headers, rows=rows, sym=sym: {
                "bars": {sym: rows}, "next_page_token": None},
            headers={}, now=NOW)


class Transport:
    def __init__(self):
        self.urls = []

    def __call__(self, url, headers, timeout_s):
        self.urls.append(url)
        assert "test@example.com" in headers["User-Agent"]
        if url == edgar.TICKERS_URL:
            body = {str(i): {"cik_str": v["cik"], "ticker": s}
                    for i, (s, v) in enumerate(SECS.items())}
        else:
            cik = int(url.rsplit("CIK", 1)[1][:10])
            sym = next(s for s, v in SECS.items() if v["cik"] == cik)
            body = (SECS[sym] if url.startswith("https://data.sec.gov/sub")
                    else SECS[sym]["facts"])
        return 200, {}, json.dumps(body).encode()


class Stub:
    def edges(self, a, b):
        return []


class BuildReferenceTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = os.path.join(tmp.name, "data")
        os.makedirs(self.dir)
        write_bars(self.dir)
        self.symbols = os.path.join(tmp.name, "symbols.txt")
        with open(self.symbols, "w") as f:
            f.write("AAA\nBBB # comment\nNOSH\nNOSIC\nMISM\nSHORT\nNOBAR\n"
                    "ZZZ\nSPY\n")
        self.logs = []

    def run_main(self, transport, *extra, env=ENV, today=None):
        return B.main([self.symbols, "--data", self.dir, "--yes", *extra],
                      env=env, log=self.logs.append, today=today,
                      transport=transport, sleeper=lambda s: None)

    def reference(self):
        with open(os.path.join(self.dir, "reference.json")) as f:
            return json.load(f)

    def test_beta_is_the_slope_to_spy(self):
        days = sorted(CLOSES["SPY"])[:B.BETA_SESSIONS + 1]
        self.assertAlmostEqual(
            B.beta(CLOSES["AAA"], CLOSES["SPY"], days), 2.0, places=9)
        self.assertIsNone(B.beta({}, CLOSES["SPY"], days))
        flat = {d: 1.0 for d in days}
        self.assertIsNone(B.beta(CLOSES["AAA"], flat, days))

    def test_output_and_omissions_by_reason(self):
        self.assertEqual(self.run_main(Transport()), 0)
        ref = self.reference()
        self.assertEqual(ref["through"], "2017-09-29")
        data = ref["data"]
        self.assertEqual(set(data["market_cap"]), {"AAA", "BBB"})
        self.assertEqual(data["ciks"], {"0000000001": "AAA",
                                        "0000000002": "BBB"})
        self.assertEqual(data["industry"], {"AAA": "35", "BBB": "73"})
        cap = data["market_cap"]["AAA"]
        self.assertEqual(cap[0], {"known_at": "2016-02-29",
                                  "value": 1000 * CLOSES["AAA"]["2016-02-29"]})
        beta = data["beta"]["AAA"]
        self.assertEqual(beta[0]["known_at"], "2016-12-30")
        self.assertAlmostEqual(beta[0]["value"], 2.0, places=9)
        self.assertEqual([e["known_at"][:7] for e in beta[:2]],
                         ["2016-12", "2017-01"])
        self.assertLess(abs(data["beta"]["BBB"][-1]["value"] - 0.5), 0.2)
        summary = json.loads(self.logs[-1])
        self.assertEqual(summary["omitted"], {
            "no-bars": 1, "no-cik": 1, "no-shares": 1, "no-sic": 1,
            "short-bars": 1, "ticker-mismatch": 1})

    def test_rerun_resumes_from_the_cache(self):
        first = Transport()
        self.run_main(first)
        self.assertEqual(len(first.urls), 1 + 2 * len(SECS))
        again = Transport()
        self.assertEqual(self.run_main(again), 0)
        self.assertEqual(again.urls, [])

    def test_later_build_refetches_records_fetched_before_its_end(self):
        first = Transport()
        self.run_main(first, "--end", "2017-06-30", today="2017-07-01")
        self.assertEqual(self.reference()["through"], "2017-06-30")
        again = Transport()
        self.assertEqual(self.run_main(again, today="2017-10-02"), 0)
        self.assertEqual(len([u for u in again.urls if "CIK" in u]),
                         2 * len(SECS))
        self.assertEqual(self.reference()["through"], "2017-09-29")
        with open(os.path.join(self.dir, "reference_cache", "AAA.json")) as f:
            self.assertEqual(json.load(f)["fetched"], "2017-10-02")

    def test_failed_fetch_writes_nothing(self):
        class Down(Transport):
            def __call__(self, url, headers, timeout_s):
                if "CIK0000000002" in url:
                    return 500, {}, b""
                return super().__call__(url, headers, timeout_s)
        self.assertEqual(self.run_main(Down()), 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir,
                                                     "reference.json")))
        self.assertEqual(self.run_main(Transport()), 0)
        self.assertIn("BBB", self.reference()["data"]["market_cap"])

    def test_body_over_the_poller_cap_fits_the_build_cap(self):
        class Big(Transport):
            def __call__(self, url, headers, timeout_s):
                st, h, body = super().__call__(url, headers, timeout_s)
                if "companyfacts" in url:
                    pad = " " * (edgar.MAX_BODY_BYTES + 1)
                    body = body + pad.encode()
                return st, h, body
        self.assertEqual(self.run_main(Big()), 0)
        self.assertIn("AAA", self.reference()["data"]["market_cap"])

    def test_default_transport_reads_up_to_its_limit(self):
        class Resp:
            def __init__(self, n):
                self.left = n

            def read(self, k):
                k = min(k, self.left)
                self.left -= k
                return b"x" * k
        n = edgar.MAX_BODY_BYTES + 5
        self.assertEqual(len(edgar._read_capped(Resp(n), 2 * n)), n)
        self.assertEqual(len(edgar._read_capped(Resp(n))),
                         edgar.MAX_BODY_BYTES + 1)

    def test_404_is_omitted_as_no_facts_and_the_file_is_written(self):
        class Gone(Transport):
            def __call__(self, url, headers, timeout_s):
                if "CIK0000000002" in url:
                    return 404, {}, b""
                return super().__call__(url, headers, timeout_s)
        self.assertEqual(self.run_main(Gone()), 0)
        self.assertEqual(set(self.reference()["data"]["market_cap"]), {"AAA"})
        self.assertEqual(json.loads(self.logs[-1])["omitted"]["no-facts"], 1)
        self.assertIn("no-facts: 1, first BBB (no-facts)", self.logs)

    def test_503_blocks_the_write_and_prints_its_error(self):
        class Down(Transport):
            def __call__(self, url, headers, timeout_s):
                if "CIK0000000002" in url:
                    return 503, {}, b""
                return super().__call__(url, headers, timeout_s)
        self.assertEqual(self.run_main(Down()), 1)
        self.assertFalse(os.path.exists(os.path.join(self.dir,
                                                     "reference.json")))
        self.assertTrue(any("http-5xx: 1, first BBB (fetch-failed: HTTP 503)"
                            in m for m in self.logs))

    def test_refuses_without_contact_or_yes(self):
        t = Transport()
        self.assertEqual(self.run_main(t, env={}), 2)
        self.assertEqual(B.main([self.symbols, "--data", self.dir], env=ENV,
                                log=self.logs.append, transport=t), 2)
        self.assertEqual(t.urls, [])

    def test_output_loads_in_the_runner(self):
        self.run_main(Transport())
        for name, data in (("filing_scores.json", {}),
                           ("form4_events.json", [])):
            with open(os.path.join(self.dir, name), "w") as f:
                json.dump({"through": "2017-09-29", "data": data}, f)
        ref, filings, events = R._datasets(self.dir, "2017-09-29")
        bars, missing = R.load_bars(self.dir, ["AAA", "BBB", "SPY"],
                                    "2016-01-01", "2017-09-29")
        self.assertEqual(missing, [])
        got = R.Inputs(bars, ref, Stub(), filings, events)("2017-09-28")
        self.assertAlmostEqual(got["beta"]["AAA"], 2.0, places=9)
        self.assertEqual(got["market_cap"]["AAA"],
                         1000 * CLOSES["AAA"]["2017-08-31"])
        self.assertEqual(got["industry"]["BBB"], "73")
        self.assertEqual(got["ciks"]["0000000001"], "AAA")


if __name__ == "__main__":
    unittest.main()
