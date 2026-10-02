import importlib.util
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "deploy_check", os.path.join(HERE, "..", "..", "ops", "deploy", "check.py"))
C = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(C)


def jrow(seq, prev, this):
    return "|".join([str(seq), "t", "k", "p", "x", prev, this])


class FakeBroker:
    def __init__(self, pos, orders):
        self.data = {"/v2/positions": pos,
                     "/v2/orders?status=open&limit=100&nested=true": orders}

    def get(self, path):
        return self.data[path]


def sell(sym, qty, status="new", **kw):
    return dict(side="sell", symbol=sym, qty=str(qty), status=status, **kw)


class CheckTest(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.TemporaryDirectory()
        self.d = self.t.name
        with open(os.path.join(self.d, "loop.pid"), "w") as f:
            f.write(str(os.getpid()) + "\n")

    def tearDown(self):
        self.t.cleanup()

    def journal(self, lines):
        with open(os.path.join(self.d, "journal.jsonl"), "w") as f:
            f.write("\n".join(lines) + "\n")

    def run_check(self, broker=None):
        return C.check(self.d, broker)[0]

    def test_valid_journal_passes(self):
        self.journal([jrow(1, "g", "a"), jrow(2, "a", "b")])
        self.assertEqual(self.run_check(), [])

    def test_corrupted_row_between_valid_rows_fails(self):
        self.journal([jrow(1, "g", "a"), "garbage|row", jrow(2, "a", "b")])
        self.assertTrue(any("malformed" in f for f in self.run_check()))

    def test_blank_lines_ignored(self):
        self.journal([jrow(1, "g", "a"), "", "  ", jrow(2, "a", "b")])
        self.assertEqual(self.run_check(), [])

    def test_partial_cover_fails(self):
        self.journal([jrow(1, "g", "a")])
        b = FakeBroker([{"symbol": "SPY", "qty": "100"}], [sell("SPY", 1)])
        self.assertTrue(any("NO STOP" in f for f in self.run_check(b)))

    def test_full_cover_passes(self):
        self.journal([jrow(1, "g", "a")])
        b = FakeBroker([{"symbol": "SPY", "qty": "100"}], [sell("SPY", 100)])
        self.assertEqual(self.run_check(b), [])

    def test_nested_leg_and_split_cover(self):
        self.journal([jrow(1, "g", "a")])
        parent = dict(side="buy", symbol="SPY", qty="40", status="new",
                      legs=[sell("SPY", 40, "held")])
        b = FakeBroker([{"symbol": "SPY", "qty": "100"}], [parent, sell("SPY", 60)])
        self.assertEqual(self.run_check(b), [])

    def test_partially_filled_sell_counts_remaining(self):
        self.journal([jrow(1, "g", "a")])
        b = FakeBroker([{"symbol": "SPY", "qty": "100"}],
                       [sell("SPY", 100, "partially_filled", filled_qty="50")])
        self.assertTrue(any("NO STOP" in f for f in self.run_check(b)))

    def test_no_sell_fails(self):
        self.journal([jrow(1, "g", "a")])
        b = FakeBroker([{"symbol": "SPY", "qty": "5"}], [])
        self.assertTrue(any("NO STOP" in f for f in self.run_check(b)))


if __name__ == "__main__":
    unittest.main()
