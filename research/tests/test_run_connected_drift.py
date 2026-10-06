"""run_connected_drift on synthetic on-disk datasets: the dry run opens no
trial, --register refuses before the ledger on missing data, a touched holdout,
stale data, an unapproved prereg or an incomplete book, and the printed matrix
is composite's."""
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

from research.engine import link_store
from research.strategy import composite as C
from research.strategy import ledger as L
from research.strategy import run_connected_drift as R
from research.strategy import sip_fetch

NOW = dt(2019, 6, 1, 20, 0, tzinfo=timezone.utc)
START, END = datetime.date(2016, 1, 1), datetime.date(2018, 12, 31)
HOLDOUT = {"start": "2018-07-01", "end": "2018-12-31", "rule": "synthetic"}
SYMS = ["S%02d" % i for i in range(14)]
INDUSTRY = {s: "AB"[i % 2] for i, s in enumerate(SYMS)}
CAP = {s: 2e9 * (1 + (i * 5) % 13) for i, s in enumerate(SYMS)}
BETA = {s: 0.8 + 0.05 * ((i * 7) % 11) for i, s in enumerate(SYMS)}
CIKS = {"C%02d" % i: s for i, s in enumerate(SYMS)}
ROADMAP_OK = ("## Approvals log\n\n- Other. Approved in chat, 2026-10-02.\n"
              "- `connected_drift` registration values: gate 1.0.\n"
              "  Approved in chat, 2026-10-06.\n")


def make_closes():
    r = random.Random(5)
    out, px, d = {}, {s: 100.0 for s in SYMS + ["SPY", "IEF", "BIL"]}, START
    while d <= END:
        if d.weekday() < 5:
            for s in px:
                px[s] *= 1.0 + r.gauss(0.0003, 0.01)
                out.setdefault(s, {})[d.isoformat()] = px[s]
        d += datetime.timedelta(days=1)
    return out


CLOSES = make_closes()


def write_bars(data_dir, closes):
    for sym, series in closes.items():
        rows = [{"t": d + "T05:00:00Z", "o": c, "h": c, "l": c, "c": c, "v": 1}
                for d, c in series.items()]
        sip_fetch.write_dataset(
            sym, "bars", "2016-01-01T00:00:00Z", "2018-12-31T00:00:00Z",
            data_dir, "1Day", "split",
            http_get=lambda url, headers, rows=rows: {
                "bars": {sym: rows}, "next_page_token": None},
            headers={}, now=NOW)


def write_json(data_dir, name, data, through="2018-12-31"):
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
                      type=typ, weight=1.0 + (i % 3), valid_from=20150101,
                      valid_to=None, known_at=20150101, evidence_ids=["x"],
                      extractor="deterministic",
                      contamination_class="deterministic")


def fixture_datasets():
    r = random.Random(9)
    filings, events = {}, []
    for s in SYMS[:12]:
        filings[s] = [{"known_at": "%d-%02d-10T10:00:00-04:00" % (y, m),
                       "delta": r.gauss(0.0, 1.0)}
                      for y in (2016, 2017, 2018) for m in (2, 5, 8, 11)]
    d = START
    while d < END:
        for s in r.sample(SYMS, 4):
            events.append({"date": d.isoformat(), "symbol": s,
                           "opportunistic": True, "value": 1e5 * r.uniform(1, 9),
                           "entry": (d + datetime.timedelta(days=2)).isoformat()})
        d += datetime.timedelta(days=20)
    return filings, events


def expected_matrix(months):
    """composite's own correlation from hand-built as-of inputs."""
    filings, events = fixture_datasets()
    cols = {n: [] for n in R.NAMES}
    for d in months:
        ret = {}
        for s in SYMS + ["SPY"]:
            days = sorted(CLOSES[s])
            i = days.index(d)
            ret[s] = CLOSES[s][d] / CLOSES[s][days[i - R.RETURN_SESSIONS]] - 1
        inds = {k: [ret[s] for s in SYMS if INDUSTRY[s] == k] for k in "AB"}
        edges = []
        for i in range(len(SYMS)):
            for k, source in ((1, "supply_chain"), (3, "text_peer")):
                edges.append({"src_cik": "C%02d" % i,
                              "dst_cik": "C%02d" % ((i + k) % len(SYMS)),
                              "source": source, "weight": 1.0 + (i % 3),
                              "valid_from": 20150101, "valid_to": None,
                              "known_at": 20150101})
        data = {"market_cap": CAP, "beta": BETA,
                "returns": {s: ret[s] for s in SYMS}, "industry": INDUSTRY,
                "market_return": ret["SPY"],
                "industry_returns": {k: sum(v) / len(v)
                                     for k, v in inds.items()},
                "ciks": CIKS, "edges": edges, "filings": filings,
                "events": events}
        comps = C.components(data, d)
        for s in SYMS:
            for name in R.NAMES:
                cols[name].append(comps[name].get(s))
    corr = C.component_correlation([cols[n] for n in R.NAMES])
    return corr, C.effective_signal_count(corr)


class RunnerTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = os.path.join(tmp.name, "data")
        os.makedirs(self.dir)
        self.ledger = os.path.join(tmp.name, "trials.jsonl")
        self.roadmap = os.path.join(tmp.name, "roadmap.md")
        with open(self.roadmap, "w") as f:
            f.write(ROADMAP_OK)
        with open(R.PREREG, encoding="utf-8") as f:
            self.pre = json.load(f)
        self.pre["holdout"] = dict(HOLDOUT)
        self.prereg_path = os.path.join(tmp.name, "prereg.json")
        with open(self.prereg_path, "w") as f:
            json.dump(self.pre, f)
        write_bars(self.dir, CLOSES)
        filings, events = fixture_datasets()
        write_json(self.dir, "reference.json",
                   {"ciks": CIKS, "industry": INDUSTRY, "market_cap": CAP,
                    "beta": BETA})
        write_json(self.dir, "filing_scores.json", filings)
        write_json(self.dir, "form4_events.json", events)
        write_json(self.dir, "vetoes.json", {n: {} for n in C.VETOES})
        write_store(self.dir)

    def run_cli(self, *extra):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = R.main(["--data", self.dir, "--prereg", self.prereg_path,
                           "--ledger", self.ledger, *extra])
        return code, out.getvalue(), err.getvalue()

    def register(self):
        orig, R.ROADMAP = R.ROADMAP, self.roadmap
        try:
            return self.run_cli("--register", "--margin-rate", "0.08")
        finally:
            R.ROADMAP = orig

    def test_dry_run_opens_no_ledger_row(self):
        code, out, _ = self.run_cli()
        self.assertEqual(code, 0)
        self.assertIn("effective signal count", out)
        self.assertEqual(L.TrialLedger(self.ledger).rows(), [])
        self.assertFalse(os.path.exists(self.ledger))

    def test_printed_matrix_matches_composite(self):
        pre = self.pre
        end = R.eval_end(pre)
        sessions = [d for d in sorted(CLOSES["SPY"]) if d <= end]
        months = [d for d in R._month_ends(sessions, R.EVAL_START, end)
                  if sessions.index(d) >= R.RETURN_SESSIONS]
        corr, eff = expected_matrix(months)
        _, out, _ = self.run_cli()
        lines = out.splitlines()
        head = next(i for i, ln in enumerate(lines)
                    if ln.startswith("component correlation"))
        rows = [ln.split()[1:] for ln in lines[head + 1:head + 4]]
        self.assertEqual(rows, [["%+.3f" % v for v in row] for row in corr])
        self.assertIn("effective signal count: %.3f" % eff, out)

    def test_dry_run_excludes_holdout_bars(self):
        _, out, _ = self.run_cli()
        self.assertIn("2016-01-01..2018-06-30", out)

    def test_register_refuses_incomplete_book(self):
        code, _, err = self.register()
        self.assertEqual(code, 1)
        self.assertIn("book-incomplete:single-name cap 6%", err)
        self.assertIn("point-in-time market_cap and beta", err)
        self.assertFalse(os.path.exists(self.ledger))

    def test_register_refuses_on_missing_data(self):
        os.remove(os.path.join(self.dir, "form4_events.json"))
        code, _, err = self.register()
        self.assertEqual(code, 1)
        self.assertIn("dataset-missing:form4_events.json", err)
        self.assertFalse(os.path.exists(self.ledger))

    def test_register_refuses_on_missing_bars(self):
        sym = sip_fetch.dataset_paths(self.dir, "S03", "bars", "1Day",
                                      "split")
        for p in sym:
            os.remove(p)
        code, _, err = self.register()
        self.assertEqual(code, 1)
        self.assertIn("dataset-missing:bars:S03", err)
        self.assertFalse(os.path.exists(self.ledger))

    def test_register_refuses_stale_dataset(self):
        write_json(self.dir, "reference.json",
                   {"ciks": CIKS, "industry": INDUSTRY, "market_cap": CAP,
                    "beta": BETA}, through="2018-06-30")
        code, _, err = self.register()
        self.assertEqual(code, 1)
        self.assertIn("dataset-stale:reference.json", err)
        self.assertFalse(os.path.exists(self.ledger))

    def test_register_refuses_touched_holdout(self):
        led = L.TrialLedger(self.ledger)
        led.open_trial(trial_id="t", hypothesis_card_id="x", prereg_hash="a" * 64,
                       family="f", variant="{}", dataset_hashes=["b" * 64],
                       code_hash="c" * 64, cost_model="costs",
                       window={"start": "2018-09-01", "end": "2018-10-01"},
                       split_scheme="walk_forward", runner="r")
        code, _, err = self.register()
        self.assertEqual(code, 1)
        self.assertIn("holdout-touched", err)
        self.assertEqual(led.count_trials(), 1)

    def test_register_refuses_unapproved_prereg(self):
        with open(self.roadmap, "w") as f:
            f.write("## Approvals log\n\n- Other. Approved in chat, "
                    "2026-10-02.\n")
        code, _, err = self.register()
        self.assertEqual(code, 1)
        self.assertIn("prereg-not-approved", err)
        self.assertFalse(os.path.exists(self.ledger))

    def test_register_requires_margin_rate(self):
        code, _, err = self.run_cli("--register")
        self.assertEqual(code, 1)
        self.assertIn("margin-rate-required", err)

    def test_approval_must_not_predate_prereg(self):
        with open(self.roadmap, "w") as f:
            f.write("## Approvals log\n\n- `connected_drift` registration "
                    "values: x. Approved in chat, 2026-10-01.\n")
        self.assertFalse(R.approved(self.pre, self.roadmap))


if __name__ == "__main__":
    unittest.main()
