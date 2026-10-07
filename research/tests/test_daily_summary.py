import datetime
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import daily_summary as D
from ops import forward_ledgers as S
from research.engine import attribution
from research.strategy import candidate_wire as W
import test_weekly_replay as T

DAY = datetime.date(2026, 10, 2)
NOW = datetime.datetime(2026, 10, 3, 8, tzinfo=datetime.timezone.utc)
LO, _ = D.day_bounds(DAY)


def build(d, spend_usd=2.5, with_spend=True):
    line = W.wire_line("passive_core", "VTI", LO + 10, 100.0, 95.0, 110.0)
    cid = json.loads(line)["candidate"]["cid"]
    T.TS = LO + 100
    T.write_run(d, [line], [dict(T.decision(cid, "VTI"), ts_ns=LO + 100)])
    os.makedirs(os.path.join(d, "ledgers"))
    S.append_rows(os.path.join(d, "ledgers", "passive_core.jsonl"), [], [
        {"date": DAY.isoformat(), "strategy": "passive_core", "equity": 100100.0,
         "ret": 0.001, "target": {"VTI": 0.6, "IEF": 0.4}}])
    with open(os.path.join(d, "alerts.jsonl"), "w") as f:
        f.write(json.dumps({"ts_ns": LO + 200, "level": "MEDIUM",
                            "code": "unprotected-position",
                            "detail": "long VTI has no working sell order"}) + "\n")
    if with_spend:
        attribution.append_span(os.path.join(d, D.SPEND_FILE), 1, "n", "m",
                                usd=spend_usd, ts=int(NOW.timestamp()) - 3600)


def run(d):
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = D.main(["x", d, "--date", DAY.isoformat()], now=NOW)
    return rc, buf.getvalue()


class SummaryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_net_page_on_fixture_run(self):
        build(self.d)
        rc, page = run(self.d)
        self.assertEqual(rc, 0, page)
        for want in ("submitted 1", "costs: $", "model spend: $2.50 of $150.00",
                     "net return +0.1000%", "unprotected-position",
                     "divergence from passive_core: shadow-only ['IEF']",
                     "chain intact"):
            self.assertIn(want, page)
        self.assertNotIn("gross", page.lower())
        saved = os.path.join(self.d, "summaries", DAY.isoformat() + ".txt")
        with open(saved) as f:
            self.assertEqual(f.read(), page)
        self.assertEqual(run(self.d), (0, page))

    def test_missing_spend_is_unavailable_not_zero(self):
        build(self.d, with_spend=False)
        rc, page = run(self.d)
        self.assertEqual(rc, 1)
        self.assertIn("model spend: UNAVAILABLE", page)

    def test_missing_inputs_are_unavailable_not_zero(self):
        build(self.d)
        os.remove(os.path.join(self.d, "alerts.jsonl"))
        rc, page = run(self.d)
        self.assertEqual(rc, 1)
        self.assertIn("alerts.jsonl: UNAVAILABLE", page)

    def test_broken_journal_fails(self):
        build(self.d)
        p = os.path.join(self.d, "journal.jsonl")
        T.rewrite(p, "|intent|", "|fill|")
        rc, page = run(self.d)
        self.assertEqual(rc, 1)
        self.assertIn("CHAIN FAILED", page)


if __name__ == "__main__":
    unittest.main()
