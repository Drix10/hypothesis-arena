import csv
import datetime
import io
import json
import math
import os
import sys
import tempfile
import unittest
import urllib.error
import urllib.parse
import zipfile
import zoneinfo

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import event_shadow as E
from ops import sleeve_shadow as S
from research.strategy import a_run_i1, fsds_fetch

os.environ.setdefault("ALPACA_KEY_ID", "test")
os.environ.setdefault("ALPACA_SECRET", "test")
NY = zoneinfo.ZoneInfo("America/New_York")
FWD = "2026-01-05"
NOW = datetime.datetime(2026, 1, 16, 22, 0, tzinfo=datetime.timezone.utc)
BASE = {"SPY": 400.0, "BIL": 91.0, "XYZ": 30.0, "ABC": 40.0}


def weekdays(start, end):
    d = start
    while d <= end:
        if d.weekday() < 5:
            yield d
        d += datetime.timedelta(days=1)


def alpaca(url, headers):
    """Fake SIP: daily and 30-minute bars for any symbol, weekdays only."""
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    sym, tf = q["symbols"][0], q["timeframe"][0]
    start, end = q["start"][0], q["end"][0]
    out, base = [], BASE.get(sym, 50.0)
    first = datetime.date(2024, 12, 1)
    for i, d in enumerate(weekdays(first, datetime.date(2026, 2, 27))):
        px = base * (1 + 0.004 * math.sin(i / 3.0) + 0.0002 * i * (sym == "BIL"))
        if tf == "1Day":
            slots = [(d.isoformat() + "T05:00:00Z", px, px * 1.001)]
        else:
            slots = []
            for k in range(13):
                t = datetime.datetime.combine(
                    d, datetime.time(9, 30), NY) + datetime.timedelta(minutes=30 * k)
                p = px * (1 + 0.0015 * math.sin(i * 1.7 + k * (1 if i % 3 else -1)))
                slots.append((t.astimezone(datetime.timezone.utc)
                              .strftime("%Y-%m-%dT%H:%M:%SZ"), p, p * 1.0004))
        for t, o, c in slots:
            if start <= t < end:
                out.append({"t": t, "o": o, "h": max(o, c) * 1.002,
                            "l": min(o, c) * 0.998, "c": c, "v": 1e6})
    return {"bars": {sym: out}, "next_page_token": None}


def submission(acc, accepted, owner, sym, cik, trans, shares, price,
               code="P", form="4"):
    return f"""<SEC-DOCUMENT>{acc}.txt
<SEC-HEADER>
<ACCEPTANCE-DATETIME>{accepted}
</SEC-HEADER>
<DOCUMENT><TYPE>4
<XML>
<?xml version="1.0"?>
<ownershipDocument><documentType>{form}</documentType>
<issuer><issuerCik>{cik}</issuerCik><issuerTradingSymbol>{sym}</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>{owner}</rptOwnerCik></reportingOwnerId>
<reportingOwnerRelationship><isDirector>1</isDirector></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable><nonDerivativeTransaction>
<securityTitle><value>Common Stock</value></securityTitle>
<transactionDate><value>{trans}</value></transactionDate>
<transactionCoding><transactionCode>{code}</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>{shares}</value></transactionShares>
<transactionPricePerShare><value>{price}</value></transactionPricePerShare></transactionAmounts>
</nonDerivativeTransaction></nonDerivativeTable></ownershipDocument>
</XML>
</DOCUMENT>
</SEC-DOCUMENT>
"""


def dera_zip(trades=()):
    """trades: (owner, issuer cik, symbol, 'YYYY-MM-DD', code)."""
    def tsv(head, rows):
        b = io.StringIO()
        w = csv.writer(b, delimiter="\t", lineterminator="\n")
        w.writerow(head)
        w.writerows(rows)
        return b.getvalue()
    subs, own, tr = [], [], []
    for n, (owner, cik, sym, day, code) in enumerate(trades):
        acc = f"A{n}"
        d = datetime.date.fromisoformat(day)
        subs.append([acc, "4", d.strftime("%d-%b-%Y"), cik, sym])
        own.append([acc, "Director", owner])
        tr.append([acc, code, "Common Stock", d.strftime("%d-%b-%Y"), "100", "10"])
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("SUBMISSION.tsv", tsv(["ACCESSION_NUMBER", "DOCUMENT_TYPE",
                                           "FILING_DATE", "ISSUERCIK",
                                           "ISSUERTRADINGSYMBOL"], subs))
        z.writestr("REPORTINGOWNER.tsv", tsv(["ACCESSION_NUMBER",
                                              "RPTOWNER_RELATIONSHIP",
                                              "RPTOWNERCIK"], own))
        z.writestr("NONDERIV_TRANS.tsv", tsv(["ACCESSION_NUMBER", "TRANS_CODE",
                                              "SECURITY_TITLE", "TRANS_DATE",
                                              "TRANS_SHARES",
                                              "TRANS_PRICEPERSHARE"], tr))
    return buf.getvalue()


class Edgar:
    """Fake EDGAR: daily index, submissions and quarterly zips."""

    def __init__(self, filings, routine=False, unpublished=(), fail=(),
                 no_index=()):
        # filings: (accession, YYYYMMDD filing date, submission text)
        self.filings, self.routine = filings, routine
        self.unpublished, self.fail, self.no_index = set(unpublished), set(fail), set(no_index)
        self.calls = []

    def __call__(self, url, headers):
        assert "User-Agent" in headers
        self.calls.append(url)
        nf = urllib.error.HTTPError(url, 404, "nf", {}, None)
        if "daily-index" in url:
            day = url.rsplit("form.", 1)[1][:8]
            if day in self.no_index:
                raise nf
            lines = ["Form Type   Company Name   CIK   Date Filed   File Name",
                     "-" * 60]
            for acc, d, _ in self.filings:
                if d == day:
                    lines.append(f"4           ACME CORP INC          1234567"
                                 f"     {d}  edgar/data/1234567/{acc}.txt")
                    lines.append(f"4/A         OTHER 3 CORP           7654321"
                                 f"     {d}  edgar/data/7654321/0000000000-26-999999.txt")
            return ("\n".join(lines) + "\n").encode()
        if url.endswith(".txt"):
            acc = url.rsplit("/", 1)[1][:-4]
            if acc in self.fail:
                raise urllib.error.HTTPError(url, 503, "busy", {}, None)
            for a, _, text in self.filings:
                if a == acc:
                    return text.encode()
            raise nf
        if "form345.zip" in url:
            name = url.rsplit("/", 1)[1]
            y, q = int(name[:4]), int(name[5])
            if (y, q) in self.unpublished or "/files/dera/" in url:
                raise nf
            trades = ()
            if self.routine and q == 1 and y in (2023, 2024, 2025):
                trades = (("0007654321", "0001234567", "XYZ", f"{y}-01-15", "S"),)
            return dera_zip(trades)
        raise nf


def filings():
    return [
        ("0001234567-26-000001", "20260106",
         submission("0001234567-26-000001", "20260106100000", "0007654321",
                    "XYZ", "0001234567", "2026-01-05", "1000", "30")),
        # accepted after the close: known only for the next session's decision
        ("0001234567-26-000002", "20260107",
         submission("0001234567-26-000002", "20260107163000", "0007654322",
                    "ABC", "0001234568", "2026-01-07", "1000", "40")),
        ("0001234567-26-000003", "20260107",   # sale: ignored
         submission("0001234567-26-000003", "20260107100000", "0007654323",
                    "XYZ", "0001234567", "2026-01-07", "5000", "30", code="S")),
    ]


def noop(_s):
    return None


def produce(d, now, edgar, **kw):
    logs = []
    out = E.produce(d, now, FWD, 100000.0, alpaca, edgar, noop, ua="test/1.0",
                    log=logs.append)
    return out, logs


def produce_full(d, now, edgar):
    """History downloads are capped per run, so E1 completes on a later run."""
    for _ in range(4):
        out, logs = produce(d, now, edgar)
        if "insider_tierA_opp_v1" in out:
            break
    return out, logs


class Parsing(unittest.TestCase):
    def test_form4_purchase_and_timestamp(self):
        acc, rows = E.parse_form4(filings()[0][2])
        self.assertEqual(acc, datetime.datetime(2026, 1, 6, 10, 0, 0))
        self.assertEqual(len(rows), 1)
        r = rows[0]
        self.assertEqual((r["symbol"], r["cik"], r["owner"], r["code"]),
                         ("XYZ", "0001234567", "0007654321", "P"))
        self.assertTrue(r["officer_or_director"])
        self.assertEqual(r["trans_date"], datetime.date(2026, 1, 5))

    def test_sales_amendments_and_garbage_are_not_purchases(self):
        self.assertEqual(E.parse_form4(filings()[2][2])[1], [])
        self.assertIsNone(E.parse_form4(submission(
            "a", "20260106100000", "1", "XYZ", "2", "2026-01-05", "1", "1",
            form="4/A")))
        self.assertIsNone(E.parse_form4("<html>not a filing</html>"))
        evil = filings()[0][2].replace("<?xml", "<!DOCTYPE x [<!ENTITY a 'b'>]><?xml")
        self.assertIsNone(E.parse_form4(evil))

    def test_index_keeps_only_form_4_once(self):
        text = ("4     A CORP   1   20260106  edgar/data/1/0000000001-26-000001.txt\n"
                "4     A CORP   9   20260106  edgar/data/9/0000000001-26-000001.txt\n"
                "4/A   B CORP   2   20260106  edgar/data/2/0000000002-26-000001.txt\n"
                "3     C CORP 3 20260106  edgar/data/3/0000000003-26-000001.txt\n")
        self.assertEqual(E.parse_index(text),
                         [("0000000001-26-000001",
                           "edgar/data/1/0000000001-26-000001.txt")])

    def test_effective_date_uses_acceptance_time_not_filing_date(self):
        f = datetime.datetime
        self.assertEqual(E.effective_date(f(2026, 1, 7, 15, 59, 59)),
                         datetime.date(2026, 1, 7))
        self.assertEqual(E.effective_date(f(2026, 1, 7, 16, 0, 0)),
                         datetime.date(2026, 1, 8))

    def test_client_retries_then_404_and_hard_failure(self):
        n = {"k": 0}

        def flaky(url, headers):
            n["k"] += 1
            if n["k"] < 3:
                raise urllib.error.URLError("reset")
            return b"ok"
        naps = []
        self.assertEqual(E.edgar_client("ua", flaky, naps.append)("u"), b"ok")
        self.assertTrue(naps)

        def gone(url, headers):
            raise urllib.error.HTTPError(url, 404, "nf", {}, None)
        with self.assertRaises(E.EdgarMissing):
            E.edgar_client("ua", gone, noop)("u")

        def down(url, headers):
            raise urllib.error.URLError("down")
        with self.assertRaises(E.EdgarError):
            E.edgar_client("ua", down, noop)("u")

    def test_history_zip_and_needed_quarters(self):
        keys = E.build_hist_from_zip(dera_zip(
            [("0007654321", "0001234567", "XYZ", "2025-01-15", "S")]))
        self.assertEqual(keys, ["0001234567|0007654321|2025|1"])
        self.assertEqual(E.needed_quarters(datetime.date(2026, 1, 6)),
                         {(y, 1) for y in (2023, 2024, 2025)} |
                         {(y, 4) for y in (2022, 2023, 2024)})


class E1Sleeve(unittest.TestCase):
    def test_opportunistic_purchase_enters_on_acceptance_and_is_not_partial(self):
        with tempfile.TemporaryDirectory() as d:
            ed = Edgar(filings())
            out, logs = produce(d, NOW, ed)   # first run: only 3 quarters cached
            self.assertNotIn("insider_tierA_opp_v1", out)
            self.assertIn("intraday_mom_pos_v1", out)   # I1 unaffected
            out, logs = produce_full(d, NOW, ed)
            rows = out["insider_tierA_opp_v1"][0]
            self.assertEqual(set(out) & set(E.E1_IDS.values()), set(E.E1_IDS.values()))
            self.assertEqual(rows[0]["date"], FWD)
            self.assertAlmostEqual(rows[0]["equity"], 100000.0, places=2)
            self.assertEqual(rows[-1]["date"], "2026-01-15")  # today's index is not final
            tg = {r["date"]: r["target"] for r in rows if r["target"]}
            self.assertEqual(tg["2026-01-06"], {"XYZ": 0.2})
            # accepted 16:30 on the 7th: not known at the 7th's close
            self.assertNotIn("2026-01-07", tg)
            self.assertEqual(tg["2026-01-08"], {"ABC": 0.2, "XYZ": 0.2})
            self.assertTrue(all(set(r) == {"date", "sleeve", "equity", "ret",
                                           "target"} for r in rows))
            self.assertTrue(all(r["date"] >= FWD for r in rows))
            self.assertTrue(all(r["target"] is None for r in
                                out["insider_tierA_cluster_v1"][0]))
            self.assertNotEqual(rows[-1]["equity"], 100000.0)

    def test_routine_trader_is_excluded(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = produce_full(d, NOW, Edgar(filings(), routine=True))
            tg = {r["date"]: r["target"]
                  for r in out["insider_tierA_opp_v1"][0] if r["target"]}
            self.assertNotIn("2026-01-06", tg)   # XYZ owner is routine in January
            self.assertIn("2026-01-08", tg)

    def test_no_lookahead_prefix_is_stable(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            full, _ = produce_full(a, NOW, Edgar(filings()))
            early = datetime.datetime(2026, 1, 9, 22, 0, tzinfo=datetime.timezone.utc)
            part, _ = produce_full(b, early, Edgar(filings()))
            pr, fr = (part["insider_tierA_opp_v1"][0],
                      full["insider_tierA_opp_v1"][0])
            self.assertLess(len(pr), len(fr))
            for x, y in zip(pr, fr):
                self.assertEqual(x, y)

    def test_missing_history_quarter_blocks_rows_instead_of_guessing(self):
        with tempfile.TemporaryDirectory() as d:
            out, logs = produce_full(d, NOW, Edgar(filings(), unpublished=[(2023, 4)]))
            self.assertFalse(set(E.E1_IDS.values()) & set(out))
            self.assertIn("intraday_mom_pos_v1", out)
            self.assertTrue(any("2023q4" in str(m) for m in logs))

    def test_failed_filing_fetch_cuts_rows_before_that_day(self):
        with tempfile.TemporaryDirectory() as d:
            ed = Edgar(filings(), fail={"0001234567-26-000002"})
            out, logs = produce_full(d, NOW, ed)
            rows = out["insider_tierA_opp_v1"][0]
            self.assertEqual(rows[-1]["date"], "2026-01-06")

    def test_recent_missing_index_stops_but_old_missing_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            ed = Edgar(filings(), no_index={"20260115", "20260109"})
            out, _ = produce_full(d, NOW, ed)
            rows = out["insider_tierA_opp_v1"][0]
            # 01-09 is 7 days old: treated as an SEC holiday; 01-15 is recent: wait
            self.assertEqual(rows[-1]["date"], "2026-01-14")

    def test_edgar_down_skips_e1_and_keeps_i1(self):
        def dead(url, headers):
            raise urllib.error.URLError("no route")
        with tempfile.TemporaryDirectory() as d:
            out = E.produce(d, NOW, FWD, 100000.0, alpaca, dead, noop,
                            ua="t", log=lambda m: None)
            self.assertFalse(set(E.E1_IDS.values()) & set(out))
            self.assertEqual(set(out), set(E.I1_IDS.values()))


class I1Sleeve(unittest.TestCase):
    def test_rows_schema_rebase_and_no_lookahead(self):
        with tempfile.TemporaryDirectory() as d:
            out, _ = produce(d, NOW, Edgar([]))
            for v, sid in E.I1_IDS.items():
                rows = out[sid][0]
                self.assertEqual(rows[0]["date"], FWD)
                self.assertEqual(rows[0]["equity"], 100000.0)
                self.assertEqual(rows[0]["ret"], 0.0)
                self.assertEqual(rows[-1]["date"], "2026-01-15")
                self.assertEqual(len({r["date"] for r in rows}), len(rows))
                eq = rows[0]["equity"]
                for r in rows[1:]:
                    self.assertAlmostEqual(r["equity"] / eq - 1, r["ret"], places=6)
                    eq = r["equity"]
            early = datetime.datetime(2026, 1, 12, 22, 0, tzinfo=datetime.timezone.utc)
            part, _ = produce(d, early, Edgar([]))
            for sid in E.I1_IDS.values():
                pr, fr = part[sid][0], out[sid][0]
                self.assertLess(len(pr), len(fr))
                self.assertEqual(pr, fr[:len(pr)])

    def test_session_without_intraday_bars_stops_the_ledger(self):
        real = alpaca

        def holed(url, headers):
            res = real(url, headers)
            if "30Min" in url:
                res["bars"]["SPY"] = [b for b in res["bars"]["SPY"] if
                                      datetime.datetime.fromisoformat(
                                          b["t"].replace("Z", "+00:00")
                                      ).astimezone(NY).date().isoformat() != "2026-01-13"]
            return res
        with tempfile.TemporaryDirectory() as d:
            out = E.produce(d, NOW, FWD, 100000.0, holed, Edgar([]), noop,
                            ua="t", log=lambda m: None)
            rows = out["intraday_mom_pos_v1"][0]
            self.assertEqual(rows[-1]["date"], "2026-01-12")

    def test_days_match_a_run_i1_read_days(self):
        rows = alpaca("x?symbols=SPY&timeframe=30Min&start=2025-06-02T00:00:00Z"
                      "&end=2025-07-30T00:00:00Z", {})["bars"]["SPY"]
        # a shortened session: after-hours-looking bars, thin 15:30 volume
        for b in rows:
            if b["t"].startswith("2025-06-10"):
                t = datetime.datetime.fromisoformat(b["t"].replace("Z", "+00:00")
                                                    ).astimezone(NY).time()
                if t == datetime.time(15, 30):
                    b["v"] = 1.0
        days, dropped, seen = E.days_from_rows(rows)
        with tempfile.TemporaryDirectory() as d:
            with open(os.path.join(d, "SPY_bars_30Min_all.jsonl"), "w") as f:
                for b in rows:
                    f.write(json.dumps(b) + "\n")
            old = a_run_i1.DATA
            a_run_i1.DATA = d
            try:
                ref_days, ref_dropped = a_run_i1.read_days()
            finally:
                a_run_i1.DATA = old
        self.assertEqual(days, ref_days)
        self.assertEqual(dropped, ref_dropped)
        self.assertEqual(dropped, ["2025-06-10"])


class Integrated(unittest.TestCase):
    def test_shadow_run_writes_chained_event_ledgers_and_verifies(self):
        specs = S.sleeve_specs()
        syms = sorted({s for u, _, _ in specs.values() for s in u})
        dates = [d.isoformat() for d in weekdays(datetime.date(2025, 1, 2),
                                                 datetime.date(2026, 1, 15))]
        prices = {s: {d: (50.0 + i * 0.01, 50.0 + i * 0.01 + 0.05)
                      for i, d in enumerate(dates)} for s in syms}
        old = (S.fetch_prices, S.FORWARD_START, fsds_fetch.user_agent)
        S.fetch_prices = lambda symbols, now, http_get=None: prices
        S.FORWARD_START = FWD
        fsds_fetch.user_agent = lambda: "test/1.0"
        try:
            with tempfile.TemporaryDirectory() as d:
                ed = Edgar(filings())
                for _ in range(3):
                    bad, summ = S.run(d, NOW, http_get=alpaca, edgar_get=ed, extras=False,
                                      sleep=noop)
                self.assertEqual(bad, [])
                for sid in list(E.E1_IDS.values()) + list(E.I1_IDS.values()):
                    self.assertIn(sid, summ)
                    rows, _ = S.read_log(os.path.join(d, "sleeves", sid + ".jsonl"))
                    self.assertEqual(rows[0]["date"], FWD)
                bad, _ = S.run(d, NOW, verify=True, http_get=alpaca,
                               edgar_get=ed, extras=False, sleep=noop)
                self.assertEqual(bad, [])
                n = len(S.read_log(os.path.join(
                    d, "sleeves", "intraday_mom_pos_v1.jsonl"))[0])
                S.run(d, NOW, http_get=alpaca, edgar_get=ed, extras=False, sleep=noop)
                self.assertEqual(n, len(S.read_log(os.path.join(
                    d, "sleeves", "intraday_mom_pos_v1.jsonl"))[0]))
        finally:
            S.fetch_prices, S.FORWARD_START, fsds_fetch.user_agent = old


if __name__ == "__main__":
    unittest.main()
