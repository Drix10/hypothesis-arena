"""ops/emit_connected_drift on synthetic on-disk datasets: wire format and
exit_link, long/short by constraint set, HOLD on unapproved, stale or missing
data, idempotence per month, and the book's forward shadow ledgers."""
import contextlib
import datetime
import io
import json
import os
import random
import sys
import tempfile
import unittest
from datetime import datetime as dt, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ops import emit_connected_drift as E
from ops import forward_ledgers as S
from research.engine import link_store
from research.strategy import candidate_wire as W
from research.strategy import composite as C
from research.strategy import run_connected_drift as R
from research.strategy import sip_fetch

NOW = dt(2019, 10, 2, 14, 0, tzinfo=timezone.utc)
FETCH_NOW = dt(2019, 10, 1, 20, 0, tzinfo=timezone.utc)
START, END = datetime.date(2017, 1, 2), datetime.date(2019, 9, 30)
ASOF = "2019-09-30"
SYMS = ["S%02d" % i for i in range(60)]
INDUSTRY = {s: "ABC"[i % 3] for i, s in enumerate(SYMS)}
CAP = {s: 2e9 * (1 + (i * 5) % 13) for i, s in enumerate(SYMS)}
BETA = {s: 0.8 + 0.05 * ((i * 7) % 11) for i, s in enumerate(SYMS)}
JSON_DATASETS = ("reference.json", "filing_scores.json", "form4_events.json",
                 "vetoes.json")
CIKS = {"C%02d" % i: s for i, s in enumerate(SYMS)}


def make_closes():
    r = random.Random(5)
    out, px, d = {}, {s: 100.0 for s in SYMS + ["SPY", "IEF", "BIL"]}, START
    while d <= END:
        if d.weekday() < 5:
            for s in px:
                px[s] *= 1.0 + r.gauss(0.0004, 0.01)
                out.setdefault(s, {})[d.isoformat()] = px[s]
        d += datetime.timedelta(days=1)
    return out


CLOSES = make_closes()


def write_bars(data_dir):
    for sym, series in CLOSES.items():
        rows = [{"t": d + "T05:00:00Z", "o": c, "h": c * 1.01, "l": c * 0.99,
                 "c": c, "v": 1} for d, c in series.items()]
        sip_fetch.write_dataset(
            sym, "bars", "2017-01-01T00:00:00Z", "2019-09-30T00:00:00Z",
            data_dir, "1Day", "split",
            http_get=lambda url, headers, rows=rows: {
                "bars": {sym: rows}, "next_page_token": None},
            headers={}, now=FETCH_NOW)


def write_json(data_dir, name, data, through="2019-10-01"):
    with open(os.path.join(data_dir, name), "w") as f:
        json.dump({"through": through, "data": data}, f)


def write_store(data_dir):
    store = link_store.LinkStore(os.path.join(data_dir, "link_store.jsonl"))
    n = 0
    for i in range(len(SYMS)):
        for k, source, typ in ((1, "supply_chain", "customer"),
                               (3, "text_peer", "text_peer")):
            n += 1
            store.add(edge_id="e%d" % n, src_cik="C%02d" % i,
                      dst_cik="C%02d" % ((i + k) % len(SYMS)), source=source,
                      type=typ, weight=1.0 + (i % 3), valid_from=20160101,
                      valid_to=None, known_at=20160101, evidence_ids=["x"],
                      extractor="deterministic",
                      contamination_class="deterministic")


def write_datasets(data_dir):
    r = random.Random(9)
    pit = lambda v: {s: [{"known_at": "2016-01-01", "value": x}]
                     for s, x in v.items()}
    write_bars(data_dir)
    write_json(data_dir, "reference.json",
               {"ciks": CIKS, "industry": INDUSTRY, "market_cap": pit(CAP),
                "beta": pit(BETA)})
    write_json(data_dir, "filing_scores.json", {
        s: [{"known_at": "%d-%02d-10T10:00:00-04:00" % (y, m),
             "delta": r.gauss(0.0, 1.0)}
            for y in (2017, 2018, 2019) for m in (2, 5, 8, 11)]
        for s in SYMS})
    events, d = [], START
    while d < END:
        for s in r.sample(SYMS, 12):
            events.append({"date": d.isoformat(), "symbol": s,
                           "opportunistic": True,
                           "value": 1e5 * r.uniform(1, 9),
                           "entry": (d + datetime.timedelta(days=2)
                                     ).isoformat()})
        d += datetime.timedelta(days=10)
    write_json(data_dir, "form4_events.json", events)
    write_json(data_dir, "vetoes.json",
               {n: {s: False for s in SYMS} for n in C.VETOES})
    write_store(data_dir)


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.data = os.path.join(cls.tmp.name, "data")
        os.makedirs(cls.data)
        write_datasets(cls.data)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.loop = tmp.name
        self.approve([E.STRATEGY])

    def approve(self, ids):
        with open(os.path.join(self.loop, "approved.json"), "w") as f:
            json.dump({"strategies": [{"id": i, "window_s": 86400}
                                      for i in ids], "allowlist": []}, f)

    def emit(self, *extra, data=None, now=NOW):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = E.main(["emit", self.loop, "--data", data or self.data,
                           *extra], now=now)
        return code, out.getvalue(), err.getvalue()

    def lines(self):
        path = os.path.join(self.loop, "candidates.jsonl")
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return [json.loads(ln) for ln in f]


class EmitTest(Base):
    def test_long_only_under_india_in_wire_format(self):
        code, out, _ = self.emit()
        self.assertEqual(code, 0)
        res = json.loads(out)
        self.assertEqual(res["asof"], ASOF)
        self.assertFalse(res["target_set_evidence"])
        self.assertEqual(res["shorts"], [])
        recs = self.lines()
        self.assertTrue(recs)
        self.assertEqual(len(recs), len(res["emitted"]))
        for rec in recs:
            c = rec["candidate"]
            self.assertEqual(rec["schema"], W.SCHEMA)
            self.assertEqual((c["side"], c["exit_rule"], c["strategy_id"]),
                             ("BUY", "exit_link", "connected_drift"))
            self.assertEqual(c["cid"], W.candidate_id(
                **{k: c[k] for k in W.ID_FIELDS}))
            self.assertLess(float(c["stop_px"]), float(c["entry_px"]))
            self.assertGreater(float(c["tp_px"]), float(c["entry_px"]))

    def test_us_set_adds_shorts_with_stop_above_entry(self):
        code, out, _ = self.emit("--constraint-set", "us")
        self.assertEqual(code, 0)
        res = json.loads(out)
        self.assertTrue(res["target_set_evidence"])
        self.assertTrue(res["shorts"])
        sells = [r["candidate"] for r in self.lines()
                 if r["candidate"]["side"] == "SELL"]
        self.assertEqual(sorted(c["symbol"] for c in sells),
                         sorted(res["shorts"]))
        for c in sells:
            self.assertGreater(float(c["stop_px"]), float(c["entry_px"]))
            self.assertLess(float(c["tp_px"]), float(c["entry_px"]))

    def test_second_run_in_the_month_emits_nothing(self):
        self.emit()
        first = self.lines()
        code, out, _ = self.emit()
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["emitted"], [])
        self.assertEqual(self.lines(), first)

    def test_entries_are_new_names_and_side_flips(self):
        self.assertEqual(
            E.entries({"A": 0.02, "B": -0.02, "C": 0.01, "D": 0.03},
                      {"A": 0.01, "B": 0.02, "D": 0.0}), ["B", "C", "D"])


class HoldTest(Base):
    def assertHold(self, **kw):
        code, out, err = self.emit(**kw)
        self.assertEqual(code, 3)
        self.assertEqual(out, "")
        self.assertIn("hold", err)
        self.assertEqual(self.lines(), [])
        self.assertFalse(os.path.exists(
            os.path.join(self.loop, "connected_drift_emitted.json")))
        return err

    def test_unapproved_strategy(self):
        self.approve(["passive_core"])
        self.assertIn("strategy-not-approved", self.assertHold())

    def test_missing_approved_list(self):
        os.remove(os.path.join(self.loop, "approved.json"))
        self.assertIn("approved-list-unreadable", self.assertHold())

    def test_stale_dataset(self):
        d = self.copy_data()
        write_json(d, "filing_scores.json", {}, through="2019-08-01")
        self.assertIn("dataset-stale:filing_scores.json",
                      self.assertHold(data=d))

    def test_missing_dataset(self):
        d = self.copy_data()
        os.remove(os.path.join(d, "vetoes.json"))
        self.assertIn("dataset-missing:vetoes.json", self.assertHold(data=d))

    def test_stale_month_end(self):
        late = dt(2019, 10, 20, 14, 0, tzinfo=timezone.utc)
        d = self.copy_data(through="2019-10-19")
        self.assertIn("stale-month-end", self.assertHold(data=d, now=late))

    def copy_data(self, through=None):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        for n in os.listdir(self.data):
            with open(os.path.join(self.data, n), "rb") as f:
                raw = f.read()
            if through and n in JSON_DATASETS:
                ds = json.loads(raw)
                ds["through"] = through
                raw = json.dumps(ds).encode()
            with open(os.path.join(tmp.name, n), "wb") as g:
                g.write(raw)
        return tmp.name


class ShadowLedgerTest(Base):
    def setUp(self):
        super().setUp()
        self.prices = {s: {d: (c, c) for d, c in series.items()}
                       for s, series in CLOSES.items()}
        self.old_start = S.FORWARD_START
        S.FORWARD_START = "2019-03-01"
        self.addCleanup(setattr, S, "FORWARD_START", self.old_start)
        self.old_env = os.environ.get(S.MARGIN_RATE_ENV)
        os.environ[S.MARGIN_RATE_ENV] = "0.08"
        self.addCleanup(self.restore_env)

    def restore_env(self):
        if self.old_env is None:
            os.environ.pop(S.MARGIN_RATE_ENV, None)
        else:
            os.environ[S.MARGIN_RATE_ENV] = self.old_env

    def test_book_ledgers_join_only_with_the_dataset(self):
        self.assertNotIn(S.CD, S.ledger_specs())
        self.assertNotIn(S.CD, S.ledger_specs(self.loop))
        specs = S.ledger_specs(self.data)
        self.assertIn(S.CD, specs)
        self.assertIn(S.CD_2X, specs)
        self.assertIn("SPY", specs[S.CD][0])
        self.assertEqual(S.SHADOW_MIN_REBALANCES[S.CD], 6)

    def rows(self, sid):
        u, fac, _ = S.ledger_specs(self.data)[sid]
        return S.replay(sid, self.prices, fac, u)

    def test_replay_rows_and_double_cost_never_beats_single(self):
        one, two = self.rows(S.CD), self.rows(S.CD_2X)
        self.assertEqual(one[0]["date"], "2019-03-01")
        self.assertTrue(any(r["target"] for r in one))
        self.assertLessEqual(two[-1]["equity"], one[-1]["equity"])

    def test_missing_margin_rate_refuses(self):
        del os.environ[S.MARGIN_RATE_ENV]
        with self.assertRaises(S.DataRefused):
            self.rows(S.CD)

    def test_stale_dataset_refuses_the_ledger_not_the_run(self):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        write_json(d.name, "reference.json",
                   {"ciks": CIKS, "industry": INDUSTRY,
                    "market_cap": {s: [] for s in SYMS}, "beta": {}},
                   through="2019-01-01")
        u, fac, _ = S.ledger_specs(d.name)[S.CD]
        with self.assertRaises(S.DataRefused):
            S.replay(S.CD, self.prices, fac, u)

    def test_status_counts_rebalances_against_the_minimum(self):
        rows = self.rows(S.CD)
        path = os.path.join(self.loop, "ledgers")
        os.makedirs(path)
        S.append_rows(os.path.join(path, S.CD + ".jsonl"), [], rows)
        st = S.write_status(self.loop)[S.CD]
        self.assertEqual(st["shadow_min_rebalances"], 6)
        self.assertEqual(st["rebalances"],
                         sum(1 for r in rows if r["target"] is not None))


if __name__ == "__main__":
    unittest.main()
