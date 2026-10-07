import datetime
import hashlib
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import weekly_replay as R
from research.strategy import candidate_wire as W

WEEK_END = datetime.date(2026, 10, 4)
LO, HI = R.week_bounds(WEEK_END)
TS = LO + 3 * R.DAY_NS


def write_run(d, cands, decisions, intents=1):
    with open(os.path.join(d, "candidates.jsonl"), "w") as f:
        f.writelines(cands)
    with open(os.path.join(d, "decisions.jsonl"), "w") as f:
        for x in decisions:
            f.write(json.dumps(x) + "\n")
    prev, lines = R.GENESIS, []
    for i in range(intents):
        body = "%d|%d|intent|i%d|%s|%s" % (i, TS + i, i, "a" * 64, prev)
        h = hashlib.sha256(body.encode()).hexdigest()
        lines.append(body + "|" + h)
        prev = h
    with open(os.path.join(d, "journal.jsonl"), "w") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))


def rewrite(path, old, new):
    with open(path) as f:
        text = f.read()
    with open(path, "w") as f:
        f.write(text.replace(old, new))


def decision(cid, symbol, proceed=True, reason="ok", qty=10, submit="submitted"):
    return {"ts_ns": TS + 5, "cid": cid, "symbol": symbol, "proceed": proceed,
            "reason": reason, "qty": qty if proceed else 0, "limiter": "x",
            "submit": submit if proceed else "none"}


class ReplayTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = self.tmp.name
        self.line = W.wire_line("passive_core", "VTI", TS, 100.0, 95.0, 110.0)
        self.cid = json.loads(self.line)["candidate"]["cid"]

    def tearDown(self):
        self.tmp.cleanup()

    def test_clean_week_reproduces(self):
        write_run(self.d, [self.line], [decision(self.cid, "VTI")])
        self.assertEqual(R.replay(self.d, WEEK_END), [])
        self.assertEqual(R.main(["x", self.d, "--week-ending", "2026-10-04"]), 0)

    def test_tampered_decision_is_reported(self):
        for bad in (decision(self.cid, "SPY"),
                    decision("f" * 64, "VTI"),
                    decision(self.cid, "VTI", qty=0),
                    decision(self.cid, "VTI", proceed=False, reason="x") | {"qty": 5}):
            write_run(self.d, [self.line], [bad])
            self.assertTrue(R.replay(self.d, WEEK_END), bad)
            self.assertEqual(R.main(["x", self.d, "--week-ending",
                                     "2026-10-04"]), 1)

    def test_rejected_candidate_must_carry_its_reason(self):
        bad = json.loads(self.line)
        bad["candidate"]["entry_px"] = "101.00"
        line = json.dumps(bad) + "\n"
        ok = {"ts_ns": TS, "cid": "", "symbol": "", "proceed": False,
              "reason": "cand-cid-mismatch", "qty": 0, "limiter": "",
              "submit": "none"}
        write_run(self.d, [line], [ok], intents=0)
        self.assertEqual(R.replay(self.d, WEEK_END), [])
        write_run(self.d, [line], [dict(ok, proceed=True, qty=3,
                                        submit="submitted")], intents=0)
        self.assertTrue(R.replay(self.d, WEEK_END))

    def test_missing_decision_and_missing_intent(self):
        write_run(self.d, [self.line], [])
        self.assertIn("no recorded decision", " ".join(R.replay(self.d, WEEK_END)))
        write_run(self.d, [self.line], [decision(self.cid, "VTI")], intents=0)
        self.assertIn("intent rows", " ".join(R.replay(self.d, WEEK_END)))

    def test_journal_tamper_is_reported(self):
        write_run(self.d, [self.line], [decision(self.cid, "VTI")], intents=2)
        p = os.path.join(self.d, "journal.jsonl")
        rewrite(p, "|intent|i0|", "|intent|iX|")
        self.assertIn("journal:", " ".join(R.replay(self.d, WEEK_END)))

    def test_corrupted_decision_row_is_reported(self):
        write_run(self.d, [self.line], [decision(self.cid, "VTI")])
        with open(os.path.join(self.d, "decisions.jsonl"), "a") as f:
            f.write("{not json\n")
        self.assertIn("undecodable", " ".join(R.replay(self.d, WEEK_END)))

    def test_missing_input_files_are_reported(self):
        self.assertEqual(len(R.replay(self.d, WEEK_END)), 3)
        write_run(self.d, [self.line], [decision(self.cid, "VTI")])
        os.remove(os.path.join(self.d, "decisions.jsonl"))
        self.assertIn("missing input: decisions.jsonl", R.replay(self.d, WEEK_END))

    def test_moved_timestamp_does_not_hide_tamper(self):
        bad = decision(self.cid, "ZZZ")
        bad["ts_ns"] = HI + R.DAY_NS
        write_run(self.d, [self.line], [bad])
        self.assertIn("symbol", " ".join(R.replay(self.d, WEEK_END)))


if __name__ == "__main__":
    unittest.main()
