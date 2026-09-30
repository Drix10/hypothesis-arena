"""Track L long-history harness: French CSV parsing edge cases, the engine
against hand-computed paths and portfolio.run's target log, look-ahead
truncation, sub-period statistics, decay, the prereg binding, fetch (fake
transport) and the CLI end to end. Synthetic data only."""
import contextlib
import datetime
import io
import json
import math
import os
import random
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ops import long_history_fetch as F
from ops import long_history_run as R
from research.strategy import ledger as LG
from research.strategy import long_history as L
from research.strategy import portfolio, prereg, stats
from research.strategy.sleeves import trend

REAL_LEDGER_DIR = os.path.join(os.path.dirname(__file__), "..", "ledger")


def snapshot_real_ledger():
    out = {}
    if os.path.isdir(REAL_LEDGER_DIR):
        for n in sorted(os.listdir(REAL_LEDGER_DIR)):
            with open(os.path.join(REAL_LEDGER_DIR, n), "rb") as f:
                out[n] = f.read()
    return out


REAL_BEFORE = snapshot_real_ledger()
PREREG_PATH = os.path.join(os.path.dirname(__file__), "..", "prereg",
                           "l1_long_history_v1.json")

FIX = """This file was created by CMPT_IND_RETS_DAILY using the 202508 CRSP database.
The 1-month TBill return is from Ibbotson and Associates, Inc.

  Average Value Weighted Returns -- Daily
,Agric,Food ,Soda ,Beer
19260701,    0.32,   -0.35, -99.99,   0.05
19260702,    0.02,    0.65, -99.99,  -0.60
19260706,   -0.53,    0.15,  -999,   0.10

  Average Equal Weighted Returns -- Daily
,Agric,Food ,Soda ,Beer
19260701,    0.10,    0.20, -99.99,   0.30
19260702,    0.11,    0.21, -99.99,   0.31

  Annual Factors: January-December
,Agric,Food ,Soda ,Beer
1927,  12.30,   8.10, -99.99,  3.00
1928,  -2.00,   4.00,   1.00,  2.00

Copyright 2025 Kenneth R. French
"""


def weekdays(start, end):
    d = datetime.date.fromisoformat(start)
    stop = datetime.date.fromisoformat(end)
    while d <= stop:
        if d.weekday() < 5:
            yield d.isoformat()
        d += datetime.timedelta(days=1)


def synth(names, start="1968-01-01", end="2022-12-30", seed=1, mu=0.02,
          persist=True):
    """(dates, {name: percent returns}, rf percent) with a slowly moving
    monthly drift so trend has something to find."""
    rng = random.Random(seed)
    dates = list(weekdays(start, end))
    cols = {n: [] for n in names}
    drift = {n: mu for n in names}
    month = None
    for d in dates:
        if d[:7] != month:
            month = d[:7]
            for n in names:
                drift[n] = (0.6 * drift[n] + 0.4 * rng.gauss(mu, 0.08)
                            if persist else mu)
        for n in names:
            cols[n].append(round(rng.gauss(drift[n], 1.0), 2))
    rf = [round(0.01 + 0.002 * rng.random(), 4) for _ in dates]
    return dates, cols, rf


def french_text(dates, cols, title="Average Value Weighted Returns -- Daily"):
    names = list(cols)
    out = ["This file was created by TEST.", "", "  " + title,
           "," + ",".join(names)]
    for i, d in enumerate(dates):
        out.append(d.replace("-", "") + "," + ",".join(
            "%8.2f" % cols[n][i] for n in names))
    out += ["", "Copyright 2025 Kenneth R. French", ""]
    return "\n".join(out)


def factors_text(dates, rf):
    out = ["  ", ",Mkt-RF,SMB,HML,RF"]
    for d, r in zip(dates, rf):
        out.append("%s,0.10,0.00,0.00,%.4f" % (d.replace("-", ""), r))
    out += ["", "Copyright 2025 Kenneth R. French", ""]
    return "\n".join(out)


def make_zip(path, member, text):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED) as z:
        z.writestr(member, text)


class ParseTest(unittest.TestCase):
    def setUp(self):
        self.blocks = L.parse_french_text(FIX)

    def test_blocks_and_footers(self):
        self.assertEqual([b["freq"] for b in self.blocks],
                         ["daily", "daily", "annual"])
        vw, ew, ann = self.blocks
        self.assertIn("Value Weighted", vw["title"])
        self.assertIn("Equal Weighted", ew["title"])
        self.assertIn("Annual", ann["title"])
        self.assertEqual(vw["columns"], ["Agric", "Food", "Soda", "Beer"])
        self.assertEqual(vw["dates"], ["1926-07-01", "1926-07-02",
                                       "1926-07-06"])
        self.assertEqual(ann["dates"], ["1927", "1928"])
        self.assertFalse(any(b["orphan"] for b in self.blocks))

    def test_missing_sentinels_and_percent(self):
        vw = self.blocks[0]
        r = L.block_returns(vw)
        self.assertEqual(r["Soda"], [None, None, None])  # -99.99 and -999
        self.assertAlmostEqual(r["Agric"][0], 0.0032)
        self.assertAlmostEqual(r["Food"][2], 0.0015)

    def test_select_block(self):
        b = L.select_block(self.blocks, "daily", "value weighted")
        self.assertEqual(b["rows"][0][0], 0.32)
        e = L.select_block(self.blocks, "daily", "equal weighted")
        self.assertEqual(e["rows"][0][0], 0.10)
        self.assertEqual(L.select_block(self.blocks, "daily", nth=1), e)
        self.assertEqual(L.select_block(self.blocks, "annual")["dates"][0],
                         "1927")
        with self.assertRaises(L.FrenchParseError):
            L.select_block(self.blocks, "monthly")
        with self.assertRaises(L.FrenchParseError):
            L.select_block(self.blocks, "daily", "no such title")  # 2 daily
        with self.assertRaises(L.FrenchParseError):
            L.select_block(self.blocks, "daily", nth=5)
        one = [self.blocks[0]]
        self.assertIs(L.select_block(one, "daily", "no such title"), one[0])

    def test_annual_directly_after_daily_is_orphan_block(self):
        txt = ("\n  Average Value Weighted Returns -- Daily\n"
               ",A,B\n19260701,1.0,2.0\n19260702,1.5,2.5\n"
               "1927,  5.0,  6.0\n1928,  7.0,  8.0\n")
        bl = L.parse_french_text(txt)
        self.assertEqual([(b["freq"], b["orphan"]) for b in bl],
                         [("daily", False), ("annual", True)])
        self.assertEqual(L.select_block(bl, "daily")["dates"],
                         ["1926-07-01", "1926-07-02"])
        with self.assertRaises(L.FrenchParseError):
            L.select_block(bl, "annual")  # orphans are never selected

    def test_date_formats_bom_crlf_trailing_commas(self):
        txt = ("﻿ Title\r\n,A,B,\r\n2020-01-02,1.0,2.0,\r\n"
               "2020/01/03,1.5,-99.99,\r\n20200106,2.0,3.0\r\n")
        b = L.parse_french_text(txt)[0]
        self.assertEqual(b["dates"], ["2020-01-02", "2020-01-03",
                                      "2020-01-06"])
        self.assertEqual(b["columns"], ["A", "B"])
        self.assertIsNone(b["rows"][1][1])

    def test_monthly_block(self):
        b = L.parse_french_text("t\n,A\n192607,1.0\n192608,2.0\n")[0]
        self.assertEqual((b["freq"], b["dates"]), ("monthly",
                                                   ["1926-07", "1926-08"]))

    def test_empty_and_nan_fields_are_missing(self):
        b = L.parse_french_text(",A,B,C\n20200102,,NaN,1.0\n")[0]
        self.assertEqual(b["rows"][0], [None, None, 1.0])

    def test_malformed_inputs_fail_closed(self):
        bad = {
            "data-before-header": "20200102,1.0,2.0\n",
            "ragged-row": ",A,B\n20200102,1.0\n",
            "bad-value": ",A,B\n20200102,1.0,abc\n",
            "bad-date": ",A\n19260732,1.0\n",
            "bad-date-month": ",A\n192613,1.0\n",
            "non-increasing": ",A\n20200103,1.0\n20200102,1.0\n",
            "duplicate": ",A\n20200102,1.0\n20200102,1.0\n",
            "duplicate-columns": ",A,A\n20200102,1.0,2.0\n",
        }
        for name, txt in bad.items():
            with self.assertRaises(L.FrenchParseError, msg=name):
                L.parse_french_text(txt)

    def test_text_only_and_empty(self):
        self.assertEqual(L.parse_french_text(""), [])
        self.assertEqual(L.parse_french_text("hello\n1927 was a year\n"), [])

    def test_read_zip_and_plain_and_latin1(self):
        with tempfile.TemporaryDirectory() as d:
            z = os.path.join(d, "a.zip")
            make_zip(z, "49_Industry_Portfolios_daily.CSV", FIX)
            self.assertEqual(L.read_french_text(z), FIX)
            p = os.path.join(d, "a.csv")
            with open(p, "wb") as f:
                f.write("caf\xe9\n,A\n20200102,1.0\n".encode("latin-1"))
            self.assertIn("caf\xe9", L.read_french_text(p))
            nz = os.path.join(d, "n.zip")
            with zipfile.ZipFile(nz, "w") as zf:
                zf.writestr("readme.pdf", "x")
            with self.assertRaises(L.LongHistoryError):
                L.read_french_text(nz)

    def test_index_csv(self):
        pts = L.parse_index_csv("Date,Close,Volume\n2020-01-02,10,1\n"
                                "20200103,11,2\n")
        self.assertEqual(pts, [("2020-01-02", 10.0), ("2020-01-03", 11.0)])
        for txt in ("", "a,b\n1,2\n", "date,close\n2020-01-02,10\n",
                    "date,close\n2020-01-02,10\n2020-01-02,11\n",
                    "date,close\n2020-01-02,10\n2020-01-03,-1\n",
                    "date,close\n2020-01-02,10\n2020-01-03,x\n",
                    "date,close\n2020-01-02,10\nfoo,11\n"):
            with self.assertRaises(L.LongHistoryError, msg=txt):
                L.parse_index_csv(txt)


class PrepareTest(unittest.TestCase):
    def blocks(self, ind_txt, fac_txt):
        ind = L.select_block(L.parse_french_text(ind_txt), "daily")
        fac = L.select_block(L.parse_french_text(fac_txt), "daily")
        return ind, fac

    def test_levels_universe_and_rf(self):
        ind_txt = (",A,B,C\n20200102,1.0,2.0,-99.99\n20200103,-1.0,0.0,1.0\n"
                   "20200106,2.0,1.0,1.0\n")
        fac_txt = (",Mkt-RF,SMB,HML, RF\n20200102,0,0,0,0.01\n"
                   "20200103,0,0,0,0.02\n20200106,0,0,0,0.01\n")
        ind, fac = self.blocks(ind_txt, fac_txt)
        p = L.prepare_french(ind, fac, min_universe=2)
        self.assertEqual(p["universe"], ["A", "B"])
        self.assertEqual(p["info"]["dropped_industries"],
                         [{"name": "C", "n_missing": 1,
                           "first_valid": "2020-01-03"}])
        self.assertAlmostEqual(p["levels"]["A"][2], 100 * 1.01 * 0.99 * 1.02)
        self.assertAlmostEqual(p["levels"][L.CASH][1], 100 * 1.0001 * 1.0002)
        with self.assertRaises(L.LongHistoryError):
            L.prepare_french(ind, fac, min_universe=3)

    def test_calendar_alignment(self):
        rows = ["%s,1.0,1.0" % d.replace("-", "")
                for d in list(weekdays("2019-01-01", "2020-06-30"))]
        rf_rows = ["%s,0,0,0,0.01" % d.replace("-", "")
                   for d in list(weekdays("2019-01-01", "2020-06-30"))]
        head_i, head_f = ",A,B\n", ",Mkt-RF,SMB,HML,RF\n"
        gap = rf_rows[:200] + rf_rows[201:]
        ind, fac = self.blocks(head_i + "\n".join(rows),
                               head_f + "\n".join(gap))
        p = L.prepare_french(ind, fac, min_universe=2)
        self.assertEqual(p["info"]["industry_dates_not_in_rf"], 1)
        self.assertEqual(len(p["sessions"]), len(rows) - 1)
        # the industry day missing from RF is compounded across, not lost
        self.assertAlmostEqual(p["levels"]["A"][-1], 100 * 1.01 ** len(rows))
        ind, fac = self.blocks(head_i + "\n".join(rows),
                               head_f + "\n".join(rf_rows[:100]))
        with self.assertRaises(L.LongHistoryError):
            L.prepare_french(ind, fac, min_universe=2)

    def test_rf_missing_value_drops_that_date(self):
        ind, fac = self.blocks(
            ",A,B\n20200102,1,1\n20200103,1,1\n20200106,1,1\n",
            ",Mkt-RF,RF\n20200102,0,0.01\n20200103,0,-99.99\n"
            "20200106,0,0.01\n")
        p = L.prepare_french(ind, fac, min_universe=2, max_mismatch=0.5)
        self.assertEqual(p["sessions"], ["2020-01-02", "2020-01-06"])

    def test_no_rf_column(self):
        ind, fac = self.blocks(",A,B\n20200102,1,1\n", ",X,Y\n20200102,0,0\n")
        with self.assertRaises(L.LongHistoryError):
            L.prepare_french(ind, fac, min_universe=2)

    def test_custom(self):
        ds = list(weekdays("2000-01-01", "2010-12-31"))
        rf = {d: 100.0 + i * 0.01 for i, d in enumerate(ds)}
        s = {"X": [(d, 10.0 + i) for i, d in enumerate(ds)],
             "Y": [(d, 5.0 + i) for i, d in enumerate(ds) if i % 7]}
        p = L.prepare_custom(rf, s)
        self.assertEqual(len(p["sessions"]),
                         len({d for i, d in enumerate(ds) if i % 7}))
        self.assertEqual(p["universe"], ["X", "Y"])
        with self.assertRaises(L.LongHistoryError):
            L.prepare_custom(rf, {"X": s["X"][:10]})
        with self.assertRaises(L.LongHistoryError):
            L.prepare_custom(rf, {L.CASH: s["X"]})


def flat_levels(n, growth):
    return {s: [100.0 * g ** i for i in range(n)] for s, g in growth.items()}


class EngineTest(unittest.TestCase):
    SESS = ["2020-01-0%d" % d for d in range(1, 7)]

    def fn_at(self, idx, target):
        def fn(date, closes):
            return dict(target) if date == self.SESS[idx] else None
        return fn

    def test_cost_first_day_then_none(self):
        lv = flat_levels(6, {"A": 1.01, L.CASH: 1.0001})
        r = L.run_engine(self.SESS, lv, self.fn_at(1, {"A": 1.0}), 10.0)
        want = [0.0, 0.0001, 0.01 - 0.001, 0.01, 0.01, 0.01]
        for a, b in zip(r["returns"], want):
            self.assertAlmostEqual(a, b, places=12)
        self.assertEqual(r["turnover"], [0, 0, 1.0, 0, 0, 0])
        self.assertEqual(r["weights"], [(self.SESS[1], {"A": 1.0})])

    def test_delay_shifts_one_session(self):
        lv = flat_levels(6, {"A": 1.01, L.CASH: 1.0001})
        r = L.run_engine(self.SESS, lv, self.fn_at(1, {"A": 1.0}), 10.0, 1)
        self.assertAlmostEqual(r["returns"][2], 0.0001, places=12)
        self.assertAlmostEqual(r["returns"][3], 0.009, places=12)

    def test_cash_leg_is_free_and_idle_weight_is_cash(self):
        lv = flat_levels(6, {"A": 1.01, L.CASH: 1.0001})
        r = L.run_engine(self.SESS, lv,
                         self.fn_at(1, {"A": 0.5, L.CASH: 0.25}), 10.0)
        self.assertAlmostEqual(r["turnover"][2], 0.5)
        want = 0.5 * 0.01 + 0.5 * 0.0001 - 0.0005
        self.assertAlmostEqual(r["returns"][2], want, places=12)

    def test_drift_turnover_at_rebalance(self):
        lv = {"A": [100, 100, 110, 110, 110, 110],
              "B": [100.0] * 6, L.CASH: [100.0] * 6}
        tgt = {"A": 0.5, "B": 0.5}

        def fn(date, closes):
            return dict(tgt) if date in self.SESS[1:3] else None
        r = L.run_engine(self.SESS, lv, fn, 10.0)
        self.assertAlmostEqual(r["returns"][2], 0.05 - 0.001, places=12)
        wa = 0.5 * 1.1 / 1.05
        self.assertAlmostEqual(r["turnover"][3],
                               abs(0.5 - wa) + abs(0.5 - (1 - wa)))
        self.assertAlmostEqual(r["returns"][3], -r["turnover"][3] * 0.001,
                               places=12)

    def test_all_cash_earns_rf_exactly(self):
        lv = flat_levels(6, {"A": 1.01, L.CASH: 1.0003})
        r = L.run_engine(self.SESS, lv, lambda d, c: None)
        for i in range(1, 6):
            self.assertAlmostEqual(r["returns"][i], 0.0003, places=12)

    def test_bad_inputs(self):
        lv = flat_levels(6, {"A": 1.01, L.CASH: 1.0001})
        for tgt in ({"A": 1.2}, {"Z": 0.5}, {"A": -0.1}, {"A": float("nan")}):
            with self.assertRaises(L.LongHistoryError, msg=str(tgt)):
                L.run_engine(self.SESS, lv, self.fn_at(1, tgt))
        with self.assertRaises(L.LongHistoryError):
            L.run_engine(self.SESS, {"A": [1.0] * 6}, lambda d, c: None)
        with self.assertRaises(L.LongHistoryError):
            L.run_engine(self.SESS, {"A": [1.0] * 5, L.CASH: [1.0] * 6},
                         lambda d, c: None)


def random_levels(n_sessions, syms, seed):
    rng = random.Random(seed)
    sess, y, m, d = [], 2000, 1, 1
    while len(sess) < n_sessions:
        sess.append("%04d-%02d-%02d" % (y, m, d))
        d += 1
        if d > 21:
            d, m = 1, m + 1
            if m > 12:
                m, y = 1, y + 1
    lv = {}
    for s in syms:
        x, lv[s] = 100.0, []
        mu = rng.uniform(-0.0004, 0.0008)
        for _ in sess:
            x *= 1.0 + rng.gauss(mu, 0.01)
            lv[s].append(x)
    x, lv[L.CASH] = 100.0, []
    for _ in sess:
        x *= 1.0001
        lv[L.CASH].append(x)
    return sess, lv


class NoLookAheadAndReuseTest(unittest.TestCase):
    UNI = ["A", "B", "C", "D", "E", "F"]

    def test_targets_match_portfolio_run(self):
        sess, lv = random_levels(900, self.UNI, 3)
        prices = {s: {d: (v[i], v[i]) for i, d in enumerate(sess)}
                  for s, v in lv.items()}
        for name in L.RULES:
            ref = portfolio.run(sess, prices,
                                L.make_rule_fn(name, sess, self.UNI),
                                cash0=1e7)
            mine = L.run_engine(sess, lv, L.make_rule_fn(name, sess,
                                                         self.UNI))
            self.assertTrue(ref["weights"], name)
            self.assertEqual(ref["weights"], mine["weights"], name)

    def test_truncation_and_future_perturbation_leave_the_past(self):
        sess, lv = random_levels(1200, self.UNI, 4)
        cut = 700  # mid-month: 700 % 21 != 20
        self.assertEqual(sess[cut][:7], sess[cut + 1][:7])
        rng = random.Random(9)
        for name in L.RULES:
            full = L.run_engine(sess, lv, L.make_rule_fn(name, sess, self.UNI))
            sub_s = sess[:cut + 1]
            sub_l = {s: v[:cut + 1] for s, v in lv.items()}
            sub = L.run_engine(sub_s, sub_l,
                               L.make_rule_fn(name, sub_s, self.UNI))
            self.assertEqual(full["returns"][:cut + 1], sub["returns"], name)
            pert = {s: v[:cut + 1] + [x * rng.uniform(0.5, 2.0)
                                      for x in v[cut + 1:]]
                    for s, v in lv.items()}
            pert[L.CASH] = lv[L.CASH]
            alt = L.run_engine(sess, pert, L.make_rule_fn(name, sess,
                                                          self.UNI))
            self.assertEqual(full["returns"][:cut + 1],
                             alt["returns"][:cut + 1], name)
            self.assertEqual([w for w in full["weights"] if w[0] <= sess[cut]],
                             [w for w in alt["weights"]
                              if w[0] <= sess[cut]], name)

    def test_signal_uses_month_end_and_applies_next_session(self):
        sess, lv = random_levels(600, self.UNI, 5)
        flags = trend.month_end_flags(sess)
        r = L.run_engine(sess, lv, L.make_rule_fn("ts_ma10", sess, self.UNI))
        self.assertTrue(all(d in flags for d, _ in r["weights"]))
        for i, t in enumerate(r["turnover"]):
            if t > 0:
                self.assertIn(sess[i - 1], flags)


class StatsTest(unittest.TestCase):
    def test_to_monthly(self):
        m, v = L.to_monthly(["2020-01-02", "2020-01-03", "2020-02-03"],
                            [0.1, 0.1, -0.5])
        self.assertEqual(m, ["2020-01", "2020-02"])
        self.assertAlmostEqual(v[0], 0.21)
        self.assertAlmostEqual(v[1], -0.5)

    def test_fast_sharpe_matches_stats(self):
        rng = random.Random(1)
        xs = [rng.gauss(0.01, 0.04) for _ in range(200)]
        self.assertAlmostEqual(L._sr(xs), stats.sharpe(xs, 12.0), places=12)
        self.assertEqual(L._sr([0.01] * 30), 0.0)

    def test_period_metrics(self):
        rng = random.Random(2)
        exc = [rng.gauss(0.006, 0.04) for _ in range(300)]
        daily = [rng.gauss(0.0003, 0.01) for _ in range(6000)]
        m = L.period_metrics(exc, daily, turnover=[0.01] * 6000, boot=100)
        self.assertEqual(m["n_months"], 300)
        self.assertAlmostEqual(m["sharpe"], stats.sharpe(exc, 12.0))
        self.assertAlmostEqual(m["ann_excess_return"], stats.mean(exc) * 12)
        self.assertAlmostEqual(m["ann_vol"], stats.stdev(exc) * math.sqrt(12))
        self.assertAlmostEqual(m["max_drawdown"], stats.max_drawdown(daily))
        self.assertAlmostEqual(m["ann_traded_weight"], 60.0 / 25.0)
        lo, hi = m["sharpe_ci95"]
        self.assertLess(lo, m["sharpe"])
        self.assertGreater(hi, m["sharpe"])
        self.assertEqual(L.period_metrics(exc[:10], daily)["status"],
                         "insufficient-months")
        self.assertNotIn("sharpe_ci95", L.period_metrics(exc, daily, boot=0))

    def test_active_metrics_deterministic(self):
        rng = random.Random(3)
        act = [rng.gauss(0.001, 0.02) for _ in range(200)]
        a = L.active_metrics(act, boot=100)
        self.assertEqual(a, L.active_metrics(act, boot=100))
        self.assertAlmostEqual(a["ann_active_return"], stats.mean(act) * 12)
        self.assertLess(a["ann_active_ci95"][0], a["ann_active_return"])

    def test_decay_ratio(self):
        rng = random.Random(4)
        pre = [rng.gauss(0.01, 0.03) for _ in range(400)]
        post = [rng.gauss(0.004, 0.03) for _ in range(150)]
        d = L.decay(pre, post, boot=300, seed=1)
        self.assertAlmostEqual(d["ratio"], stats.sharpe(post, 12.0) /
                               stats.sharpe(pre, 12.0))
        self.assertAlmostEqual(d["decay_pct"], 1.0 - d["ratio"])
        self.assertAlmostEqual(d["sharpe_diff"], d["sharpe_post"] -
                               d["sharpe_pre"])
        lo, hi = d["ratio_ci95"]
        self.assertLess(lo, hi)
        self.assertLess(d["sharpe_diff_ci95"][0], d["sharpe_diff_ci95"][1])
        self.assertEqual(d, L.decay(pre, post, boot=300, seed=1))
        same = L.decay(pre, pre, boot=0)
        self.assertAlmostEqual(same["ratio"], 1.0)
        self.assertAlmostEqual(same["sharpe_diff"], 0.0)

    def test_decay_undefined_when_pre_not_positive(self):
        rng = random.Random(5)
        pre = [rng.gauss(-0.005, 0.03) for _ in range(300)]
        post = [rng.gauss(0.01, 0.03) for _ in range(100)]
        d = L.decay(pre, post, boot=100)
        self.assertIsNone(d["ratio"])
        self.assertIsNone(d["decay_pct"])
        self.assertIsNotNone(d["sharpe_diff_ci95"])
        self.assertTrue(d["ratio_unstable"])
        self.assertEqual(L.decay(pre[:5], post)["status"],
                         "insufficient-months")


class StudyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.names = ["I%02d" % i for i in range(14)]
        dates, cols, rf = synth(cls.names)
        cls.dates = dates
        ind = L.select_block(L.parse_french_text(french_text(dates, cols)),
                             "daily", "value weighted")
        fac = L.select_block(L.parse_french_text(factors_text(dates, rf)),
                             "daily")
        cls.prep = L.prepare_french(ind, fac)
        cls.study = L.build_study(cls.prep, boot=30)

    def test_structure(self):
        s = self.study
        self.assertEqual(set(s["rules"]), set(L.RULES))
        self.assertEqual(set(s["periods"]), {p for p, _, _ in L.PERIODS})
        self.assertEqual(s["eval_window"]["first"][:7], "1969-03")
        for r, res in s["rules"].items():
            for p, _, _ in L.PERIODS:
                self.assertIn("sharpe", res["periods"][p], (r, p))
                self.assertIn("ann_active_ci95",
                              res["active_vs_ew_monthly"][p])
                self.assertIn("sharpe", res["stress_2x_cost"][p])
                self.assertIn("sharpe", res["delay_1_session"][p])
            self.assertEqual(set(res["decay"]), set(L.DECAY_WINDOWS))
            self.assertEqual(set(res["decay_active"]), set(L.DECAY_WINDOWS))
        for b in L.BENCHES:
            self.assertIn("max_drawdown", s["benchmarks"][b]["full"])
        json.dumps(s, allow_nan=False)

    def test_periods_partition_the_sample(self):
        s = self.study["periods"]
        self.assertEqual(s["pre_1999"]["sessions"] +
                         s["1999_2011"]["sessions"] +
                         s["2012_latest"]["sessions"], s["full"]["sessions"])
        self.assertEqual(s["post_1999"]["sessions"],
                         s["1999_2011"]["sessions"] +
                         s["2012_latest"]["sessions"])
        self.assertEqual(self.study["eval_window"]["last"], "2022-12-30")

    def test_month_counts_add_up(self):
        res = self.study["rules"]["ts_ma10"]["periods"]
        self.assertEqual(res["pre_1999"]["n_months"] +
                         res["post_1999"]["n_months"],
                         res["full"]["n_months"])

    def test_deterministic(self):
        again = L.build_study(self.prep, boot=30)
        self.assertEqual(again, self.study)

    def test_cost_stress_lowers_sharpe(self):
        for r, res in self.study["rules"].items():
            self.assertLess(res["stress_2x_cost"]["full"]["sharpe"],
                            res["periods"]["full"]["sharpe"], r)

    def test_downtrend_trend_rules_sit_in_cash(self):
        dates, cols, rf = synth(self.names, start="1968-01-01",
                                end="1998-12-31", seed=7, mu=-0.06,
                                persist=False)
        ind = L.select_block(L.parse_french_text(french_text(dates, cols)),
                             "daily")
        fac = L.select_block(L.parse_french_text(factors_text(dates, rf)),
                             "daily")
        prep = L.prepare_french(ind, fac)
        s = L.build_study(prep, rules=["ts_ma10", "ts_mom12"], boot=0,
                          robustness=False)
        bench = s["benchmarks"]["ew_monthly"]["full"]
        self.assertLess(bench["ann_excess_return"], -0.05)
        for r in ("ts_ma10", "ts_mom12"):
            m = s["rules"][r]["periods"]["full"]
            self.assertGreater(m["ann_excess_return"],
                               bench["ann_excess_return"] + 0.03, r)
            self.assertLess(m["max_drawdown"], bench["max_drawdown"], r)

    def test_short_history_refused(self):
        dates, cols, rf = synth(self.names, start="2020-01-01",
                                end="2020-12-31")
        ind = L.select_block(L.parse_french_text(french_text(dates, cols)),
                             "daily")
        fac = L.select_block(L.parse_french_text(factors_text(dates, rf)),
                             "daily")
        with self.assertRaises(L.LongHistoryError):
            L.build_study(L.prepare_french(ind, fac), boot=0)

    def test_small_universe_skips_cross_section(self):
        lv = {k: v for k, v in self.prep["levels"].items()
              if k in ("I00", "I01", L.CASH)}
        prep = {"sessions": self.prep["sessions"], "levels": lv,
                "universe": ["I00", "I01"], "info": {}}
        s = L.build_study(prep, boot=0, robustness=False)
        self.assertEqual(set(s["rules"]), {"ts_ma10", "ts_mom12"})

    def test_eval_end_drops_partial_last_month(self):
        sess = list(weekdays("2016-01-01", "2021-03-10"))
        s0 = L.eval_start_index(sess)
        self.assertEqual(sess[s0], "2017-03-01")
        end = L.eval_end_index(sess, s0)
        self.assertEqual(sess[end - 1], "2021-02-26")
        sess2 = list(weekdays("2016-01-01", "2021-03-31"))
        self.assertEqual(L.eval_end_index(sess2, L.eval_start_index(sess2)),
                         len(sess2))


class CriteriaAndPreregTest(unittest.TestCase):
    def load(self):
        with open(PREREG_PATH) as f:
            return json.load(f)

    def test_prereg_valid_and_bound_to_module(self):
        pre = self.load()
        self.assertEqual(prereg.validate(pre), [])
        self.assertEqual(L.check_prereg(pre), [])
        self.assertEqual(len(prereg.require_valid(pre)), 64)
        self.assertEqual([v["id"] for v in pre["variants"]], list(L.RULES))
        self.assertEqual(pre["created"], "2026-09-30")

    def test_prereg_drift_is_detected(self):
        for key, val in (("cost_bp_per_side", 5.0), ("top_k", 4),
                         ("bootstrap_b", 100),
                         ("periods", {"full": [None, None]}),
                         ("rules", {"ts_ma10": ["trend", "ma5"]}),
                         ("warmup_month_ends", 13)):
            pre = self.load()
            pre[key] = val
            self.assertIn("prereg-mismatch:" + key, L.check_prereg(pre))

    def test_criteria_thresholds(self):
        dec = self.load()["decision"]

        def rep(pre_s, pre_t, post_s, post_t, dd, s2, lo):
            return {"rules": {"r": {
                "periods": {"pre_1999": {"sharpe": pre_s, "hac_t": pre_t},
                            "post_1999": {"sharpe": post_s, "hac_t": post_t,
                                          "max_drawdown": dd}},
                "stress_2x_cost": {"post_1999": {"sharpe": s2}},
                "active_vs_ew_monthly": {"post_1999": {
                    "ann_active_ci95": [lo, 0.1]}}}}}
        c = L.evaluate_criteria(rep(0.5, 3.1, 0.4, 2.1, 0.3, 0.2, 0.01),
                                dec)["r"]
        self.assertTrue(all(c.values()), c)
        c = L.evaluate_criteria(rep(0.5, 2.9, 0.2, 2.1, 0.6, -0.1, -0.01),
                                dec)["r"]
        self.assertFalse(any(c.values()), c)
        c = L.evaluate_criteria(rep(None, None, 0.4, None, None, None, 0.0),
                                dec)["r"]
        self.assertFalse(any(c.values()), c)


def fake_opener(table, calls):
    def op(req, timeout=None):
        calls.append((req.full_url, req.get_header("User-agent"), timeout))
        return io.BytesIO(table[req.full_url])
    return op


class FetchTest(unittest.TestCase):
    @staticmethod
    def payload(n=60_000):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w", zipfile.ZIP_STORED) as z:
            z.writestr("x.CSV", "a" * n)
        return b.getvalue()

    def opener(self, table, calls):
        return fake_opener(table, calls)

    def test_fetch_writes_manifest_and_skips_verified(self):
        good = self.payload()
        names = ["a.zip", "b.zip"]
        table = {F.BASE + n: good for n in names}
        calls = []
        now = datetime.datetime(2026, 9, 30, 12, 0, 0,
                                tzinfo=datetime.timezone.utc)
        with tempfile.TemporaryDirectory() as d:
            sleeps = []
            m = F.fetch_all(d, names, opener=self.opener(table, calls),
                            sleep=sleeps.append, now=now)
            self.assertEqual(len(calls), 2)
            self.assertIn("hypothesis-arena", calls[0][1])
            self.assertEqual(calls[0][2], F.TIMEOUT_S)
            self.assertEqual(sleeps, [1.0])
            ent = m["files"]["a.zip"]
            self.assertEqual(ent["sha256"], F.sha256_bytes(good))
            self.assertEqual(ent["fetched_utc"], "2026-09-30T12:00:00Z")
            self.assertEqual(F.load_manifest(d), m)
            self.assertEqual(F.verify_file(d, "a.zip")["bytes"], len(good))
            F.fetch_all(d, names, opener=self.opener(table, calls))
            self.assertEqual(len(calls), 2)  # verified files not refetched
            F.fetch_all(d, names, force=True,
                        opener=self.opener(table, calls),
                        sleep=lambda s: None)
            self.assertEqual(len(calls), 4)
            with open(os.path.join(d, "a.zip"), "ab") as f:
                f.write(b"x")
            with self.assertRaises(F.FetchError):
                F.verify_file(d, "a.zip")
            with self.assertRaises(F.FetchError):
                F.verify_file(d, "c.zip")
            self.assertFalse([n for n in os.listdir(d)
                              if n.endswith(".part")])

    def test_sanity_failures_write_nothing(self):
        html = b"<html>" + b"x" * 60_000
        cases = {"tiny": b"PK", "html": html, "empty-zip": self.empty_zip()}
        for label, raw in cases.items():
            with tempfile.TemporaryDirectory() as d:
                op = self.opener({F.BASE + "a.zip": raw}, [])
                with self.assertRaises(F.FetchError, msg=label):
                    F.fetch_all(d, ["a.zip"], opener=op,
                                sleep=lambda s: None)
                self.assertEqual(os.listdir(d), [])
        with self.assertRaises(F.FetchError):
            F.check_payload("big", b"x" * (F.MAX_BYTES + 1))

    def empty_zip(self):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w", zipfile.ZIP_STORED) as z:
            z.writestr("readme.pdf", "a" * 60_000)
        return b.getvalue()

    def test_retry_and_http_errors(self):
        import urllib.error
        url = F.BASE + "a.zip"
        seq = [urllib.error.URLError("boom"),
               urllib.error.HTTPError(url, 503, "x", {}, None)]
        good = self.payload()

        def op(req, timeout=None):
            if seq:
                raise seq.pop(0)
            return io.BytesIO(good)
        sleeps = []
        self.assertEqual(F.download(url, op, sleeps.append), good)
        self.assertEqual(sleeps, [2.0, 4.0])
        nf = urllib.error.HTTPError(url, 404, "nf", {}, None)
        n = []

        def op404(req, timeout=None):
            n.append(1)
            raise nf
        with self.assertRaises(F.FetchError):
            F.download(url, op404, lambda s: None)
        self.assertEqual(len(n), 1)  # 404 is not retried

    def test_manifest_load_rules(self):
        with tempfile.TemporaryDirectory() as d:
            m = F.load_manifest(d)
            self.assertEqual(m["files"], {})
            with open(os.path.join(d, F.MANIFEST), "w") as f:
                f.write('{"schema": "other"}')
            with self.assertRaises(F.FetchError):
                F.load_manifest(d)


class CliTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        d = cls.tmp.name
        names = ["I%02d" % i for i in range(14)]
        dates, cols, rf = synth(names, seed=11)
        ind_zip = os.path.join(d, "src_ind.zip")
        fac_zip = os.path.join(d, "src_fac.zip")
        make_zip(ind_zip, "49_Industry_Portfolios_daily.CSV",
                 french_text(dates, cols))
        make_zip(fac_zip, "F-F_Research_Data_Factors_daily.CSV",
                 factors_text(dates, rf))
        with open(ind_zip, "rb") as f:
            ind_b = f.read()
        with open(fac_zip, "rb") as f:
            fac_b = f.read()
        cls.data = os.path.join(d, "data")
        table = {F.BASE + F.FILES["industries"]: ind_b,
                 F.BASE + F.FILES["factors"]: fac_b}
        F.fetch_all(cls.data, list(F.FILES.values()),
                    opener=fake_opener(table, []),
                    sleep=lambda s: None)
        cls.custom = []
        for sym, seed in (("AAA", 1), ("BBB", 2)):
            rng = random.Random(seed)
            x, lines = 100.0, ["date,close"]
            for dd in dates:
                x *= 1.0 + rng.gauss(0.0003, 0.01)
                lines.append("%s,%.4f" % (dd, x))
            p = os.path.join(d, sym + ".csv")
            with open(p, "w") as f:
                f.write("\n".join(lines))
            cls.custom.append(p)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def run_cli(self, *extra, out="report.json", ledger="none"):
        out_path = os.path.join(self.tmp.name, out)
        buf = io.StringIO()
        err = io.StringIO()
        led = ["--no-ledger"] if ledger == "none" else (
            ["--ledger", os.path.join(self.tmp.name, ledger)]
            if ledger else [])
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(err):
            code = R.main(["--dir", self.data, "--out", out_path,
                           "--boot", "20"] + led + list(extra),
                          today=datetime.date(2026, 9, 30))
        return code, buf.getvalue(), err.getvalue(), out_path

    def test_end_to_end_with_custom_hook(self):
        args = []
        for p in self.custom:
            args += ["--custom-csv", p]
        code, out, err, path = self.run_cli(*args, out="e2e.json")
        self.assertEqual(code, 0, err)
        with open(path) as f:
            rep = json.load(f)
        self.assertEqual(rep["schema"], "long_history_report_v1")
        self.assertEqual(len(rep["prereg_hash"]), 64)
        self.assertEqual(rep["generated"], "2026-09-30")
        self.assertEqual(rep["bootstrap_b_used"], 20)
        self.assertFalse(rep["prereg_conformant"])  # smoke boot != 2000
        self.assertEqual(rep["void_reason"], [])
        self.assertEqual(set(rep["criteria"]), set(L.RULES))
        self.assertEqual(len(rep["data"]["universe"]), 14)
        self.assertEqual(set(rep["data"]["files"]), set(F.FILES.values()))
        self.assertEqual(set(rep["custom_trend"]["study"]["rules"]),
                         {"ts_ma10", "ts_mom12"})  # 2 symbols: no top-3
        self.assertIn("exploratory", rep["custom_trend"]["status"])
        self.assertIn("L1 long history", out)
        self.assertIn("decay xs_mom12_1", out)
        self.assertIn("wrote", out)

    def test_refuses_overwrite_tamper_and_missing_manifest(self):
        code, _, _, path = self.run_cli(out="ow.json")
        self.assertEqual(code, 0)
        code, _, err, _ = self.run_cli(out="ow.json")
        self.assertEqual(code, 2)
        self.assertIn("refusing to overwrite", err)
        code, _, _, _ = self.run_cli("--force", out="ow.json")
        self.assertEqual(code, 0)
        with tempfile.TemporaryDirectory() as empty:
            buf, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(buf), \
                    contextlib.redirect_stderr(err):
                code = R.main(["--dir", empty, "--out",
                               os.path.join(empty, "x.json")])
            self.assertEqual(code, 2)
            self.assertIn("not in manifest", err.getvalue())

    def ledger_rows(self, name):
        return LG.TrialLedger(os.path.join(self.tmp.name, name)).rows()

    def test_ledger_open_close_checkpoint_and_one_shot(self):
        name = "t1/trials.jsonl"
        code, out, err, path = self.run_cli(out="l1.json", ledger=name)
        self.assertEqual(code, 0, err)
        led = LG.TrialLedger(os.path.join(self.tmp.name, name))
        cp = os.path.join(self.tmp.name, "t1", "checkpoint.json")
        self.assertEqual(led.verify(cp), 6)
        rows = led.rows()
        self.assertEqual([r["kind"] for r in rows], ["open"] * 3 + ["close"] * 3)
        pre = self.load_prereg()
        for r in rows[:3]:
            self.assertEqual(r["hypothesis_card_id"], "l1_long_history_v1")
            self.assertEqual(r["prereg_hash"], prereg.prereg_hash(pre))
            self.assertEqual(r["family"], pre["family"])
            self.assertEqual(r["split_scheme"], "publication_date_split")
            self.assertEqual(r["cost_model_version"], R.COST_MODEL)
            self.assertEqual(r["runner"], "ops.long_history_run")
            self.assertEqual(len(r["dataset_hashes"]), 2)
            self.assertEqual(r["window"]["start"][:4], "1968")
            self.assertEqual(r["window"]["end"], "2022-12-30")
        self.assertEqual([r["variant"] for r in rows[:3]], list(L.RULES))
        for r in rows[3:]:
            self.assertIn(r["verdict"], LG.CLOSE_VERDICTS)
            self.assertIn("sharpe_post_1999", r["metrics"])
        with open(path) as f:
            rep = json.load(f)
        self.assertEqual(rep["ledger"]["status"], "recorded")
        self.assertEqual(rep["ledger"]["n_trials_before"], 0)
        self.assertEqual(rep["ledger"]["n_trials_after"], 3)
        # same vintage again: refused, ledger unchanged
        code, _, err, _ = self.run_cli(out="l2.json", ledger=name)
        self.assertEqual(code, 2)
        self.assertIn("vintage-already-run", err)
        self.assertEqual(led.verify(cp), 6)
        # --force opens new trials, N grows
        code, _, err, path = self.run_cli("--force", out="l3.json",
                                          ledger=name)
        self.assertEqual(code, 0, err)
        self.assertEqual(led.count_trials(), 6)
        self.assertEqual(led.verify(cp), 12)
        ids = [r["trial_id"] for r in led.rows() if r["kind"] == "open"]
        self.assertEqual(len(set(ids)), 6)
        self.assertEqual(led.unclosed(), [])
        with open(path) as f:
            self.assertTrue(json.load(f)["ledger"]["forced_rerun"])

    def load_prereg(self):
        with open(PREREG_PATH) as f:
            return json.load(f)

    def test_broken_ledger_or_checkpoint_refuses(self):
        name = "t2/trials.jsonl"
        base = os.path.join(self.tmp.name, "t2")
        code, _, err, _ = self.run_cli(out="b1.json", ledger=name)
        self.assertEqual(code, 0, err)
        path, cp = os.path.join(base, "trials.jsonl"), \
            os.path.join(base, "checkpoint.json")
        with open(path, "rb") as f:
            good = f.read()
        with open(cp, "rb") as f:
            good_cp = f.read()
        try:
            # truncated tail vs checkpoint
            with open(path, "wb") as f:
                f.write(good[:good.rindex(b"\n", 0, len(good) - 1) + 1])
            code, _, err, _ = self.run_cli("--force", out="b2.json",
                                           ledger=name)
            self.assertEqual(code, 2)
            self.assertIn("truncated-vs-checkpoint", err)
            # rewritten row breaks the chain
            with open(path, "wb") as f:
                f.write(good.replace(b'"variant":"ts_ma10"',
                                     b'"variant":"ts_maXX"', 1))
            code, _, err, _ = self.run_cli("--force", out="b3.json",
                                           ledger=name)
            self.assertEqual(code, 2)
            self.assertIn("ledger-digest-mismatch", err)
            # missing checkpoint on a non-empty ledger
            with open(path, "wb") as f:
                f.write(good)
            os.remove(cp)
            code, _, err, _ = self.run_cli("--force", out="b4.json",
                                           ledger=name)
            self.assertEqual(code, 2)
            self.assertIn("checkpoint-missing", err)
        finally:
            with open(path, "wb") as f:
                f.write(good)
            with open(cp, "wb") as f:
                f.write(good_cp)
        self.assertEqual(len(self.ledger_rows(name)), 6)

    def test_smoke_run_never_touches_real_ledger(self):
        code, _, err, _ = self.run_cli(ledger=None, out="s1.json")
        self.assertEqual(code, 2)
        self.assertIn("smoke run needs", err)
        code, _, err, _ = self.run_cli("--ledger", R.LEDGER, ledger=None,
                                       out="s2.json")
        self.assertEqual(code, 2)
        self.assertIn("never the real ledger", err)
        code, out, err, path = self.run_cli(out="s3.json")  # --no-ledger
        self.assertEqual(code, 0, err)
        with open(path) as f:
            rep = json.load(f)
        self.assertIn("skipped", rep["ledger"]["status"])
        self.assertIn("ledger: skipped", out)
        self.assertEqual(snapshot_real_ledger(), REAL_BEFORE)

    def test_crash_closes_trials_as_crashed(self):
        name = "t3/trials.jsonl"
        real = L.build_study

        def boom(*a, **k):
            raise L.LongHistoryError("boom")
        L.build_study = boom
        try:
            code, _, err, _ = self.run_cli(out="c1.json", ledger=name)
        finally:
            L.build_study = real
        self.assertEqual(code, 2)
        rows = self.ledger_rows(name)
        self.assertEqual([r.get("verdict") for r in rows[3:]],
                         ["crashed"] * 3)
        self.assertEqual(LG.TrialLedger(os.path.join(
            self.tmp.name, name)).verify(os.path.join(
                self.tmp.name, "t3", "checkpoint.json")), 6)

    def test_custom_runs_open_their_own_trials(self):
        name = "t4/trials.jsonl"
        args = []
        for p in self.custom:
            args += ["--custom-csv", p]
        code, _, err, path = self.run_cli(*args, out="cu.json", ledger=name)
        self.assertEqual(code, 0, err)
        rows = [r for r in self.ledger_rows(name) if r["kind"] == "open"]
        self.assertEqual(len(rows), 5)
        cust = [r for r in rows
                if r["hypothesis_card_id"] == "l1_long_history_v1:custom"]
        self.assertEqual([r["variant"] for r in cust],
                         ["custom:ts_ma10", "custom:ts_mom12"])
        self.assertEqual(len(cust[0]["dataset_hashes"]), 4)
        with open(path) as f:
            rep = json.load(f)
        self.assertEqual(rep["ledger"]["n_trials_after"], 5)
        self.assertIn("criteria", rep["custom_trend"])

    def test_drifted_prereg_is_refused(self):
        with open(PREREG_PATH) as f:
            pre = json.load(f)
        pre["cost_bp_per_side"] = 5.0
        p = os.path.join(self.tmp.name, "bad_prereg.json")
        with open(p, "w") as f:
            json.dump(pre, f)
        code, _, err, path = self.run_cli("--prereg", p, out="bad.json")
        self.assertEqual(code, 2)
        self.assertIn("prereg-mismatch:cost_bp_per_side", err)
        self.assertFalse(os.path.exists(path))

    def test_short_sample_is_void(self):
        with tempfile.TemporaryDirectory() as d:
            names = ["I%02d" % i for i in range(14)]
            dates, cols, rf = synth(names, start="1990-01-01",
                                    end="2012-12-31", seed=3)
            zi, zf = (os.path.join(d, "i.zip"), os.path.join(d, "f.zip"))
            make_zip(zi, "a.CSV", french_text(dates, cols))
            make_zip(zf, "b.CSV", factors_text(dates, rf))
            with open(zi, "rb") as a, open(zf, "rb") as b:
                table = {F.BASE + F.FILES["industries"]: a.read(),
                         F.BASE + F.FILES["factors"]: b.read()}
            F.fetch_all(d, list(F.FILES.values()),
                        opener=fake_opener(table, []),
                        sleep=lambda s: None)
            out = os.path.join(d, "v.json")
            lpath = os.path.join(d, "led", "trials.jsonl")
            buf, err = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(buf), \
                    contextlib.redirect_stderr(err):
                code = R.main(["--dir", d, "--out", out, "--boot", "10",
                               "--ledger", lpath])
            self.assertEqual(code, 3, err.getvalue())
            with open(out) as f:
                rep = json.load(f)
            self.assertIsNone(rep["criteria"])
            self.assertIn("pre_1999", rep["void_reason"][0])
            self.assertIn("VOID", buf.getvalue())
            closes = [r for r in LG.TrialLedger(lpath).rows()
                      if r["kind"] == "close"]
            self.assertEqual([r["verdict"] for r in closes], ["void"] * 3)


class ZzRealLedgerUntouchedTest(unittest.TestCase):
    def test_real_ledger_files_unchanged(self):
        self.assertEqual(snapshot_real_ledger(), REAL_BEFORE)


def tearDownModule():
    assert snapshot_real_ledger() == REAL_BEFORE, "real ledger was touched"


if __name__ == "__main__":
    unittest.main()
