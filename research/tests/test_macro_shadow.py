import datetime
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import macro_shadow as M
from ops import sleeve_shadow as S

NOW = datetime.datetime(2026, 12, 2, 21, 0, tzinfo=datetime.timezone.utc)


def bdays(start, n):
    d = datetime.date.fromisoformat(start)
    out = []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out


def px(dates, drift):
    out, p = {}, 100.0
    for i, d in enumerate(dates):
        p *= 1 + drift + 0.002 * (((i * 5) % 7) - 3) / 3
        out[d] = (p, p * 1.001)
    return out


def fred(dates, slope):
    return [(d, str(3.0 + slope * i)) for i, d in enumerate(dates)] + \
        [("2020-01-01", ".")]


class Macro(unittest.TestCase):
    def setUp(self):
        self.dates = bdays("2025-01-02", 480)
        self.fwd = self.dates[330]
        self._old = S.FORWARD_START
        S.FORWARD_START = self.fwd

    def tearDown(self):
        S.FORWARD_START = self._old

    def prices(self, drift=0.0006):
        return {"VTI": px(self.dates, drift), "IEF": px(self.dates, 0.0001)}

    def go(self, prices, series, now=NOW):
        err = io.StringIO()
        with redirect_stderr(err):
            out = M.produce("/nonexistent", now, prices,
                            lambda *_a: series)
        return out, err.getvalue()

    def test_tilt_rule(self):
        self.assertEqual(M.tilt(-0.1, 0.05), 0.10)
        self.assertEqual(M.tilt(0.1, -0.05), -0.10)
        for a, b in ((0.1, 0.05), (-0.1, -0.05), (0.0, 0.05), (-0.1, 0.0)):
            self.assertEqual(M.tilt(a, b), 0.0)
        self.assertEqual(M.weights(0.1), {"VTI": 0.7, "IEF": 0.3})
        self.assertEqual(M.weights(-0.1), {"VTI": 0.5, "IEF": 0.5})

    def test_easing_and_rising_targets_and_schema(self):
        out, err = self.go(self.prices(), fred(self.dates, -0.002))
        rows, spec = out[M.SLEEVE_ID]
        self.assertEqual(err, "")
        self.assertEqual(rows[0]["date"], self.fwd)
        self.assertAlmostEqual(rows[0]["equity"], S.CASH0, places=2)
        self.assertEqual(set(rows[0]), {"date", "sleeve", "equity", "ret",
                                        "target"})
        tg = [r["target"] for r in rows if r["target"]]
        self.assertTrue(tg and all(t == {"VTI": 0.7, "IEF": 0.3} for t in tg))
        out, _ = self.go(self.prices(-0.0008), fred(self.dates, 0.002))
        tg = [r["target"] for r in out[M.SLEEVE_ID][0] if r["target"]]
        self.assertTrue(tg and all(t == {"VTI": 0.5, "IEF": 0.5} for t in tg))

    def test_decisions_only_at_month_end(self):
        out, _ = self.go(self.prices(), fred(self.dates, -0.002))
        for r in out[M.SLEEVE_ID][0]:
            if r["target"]:
                i = self.dates.index(r["date"])
                nxt = self.dates[i + 1] if i + 1 < len(self.dates) else None
                self.assertTrue(nxt is None or nxt[:7] != r["date"][:7])

    def test_no_lookahead_future_fred_and_prices_ignored(self):
        p, f = self.prices(), fred(self.dates, -0.002)
        full = self.go(p, f)[0][M.SLEEVE_ID][0]
        cut = self.dates[-40]
        p2 = {s: {d: v for d, v in q.items() if d <= cut} for s, q in p.items()}
        f2 = [x for x in f if x[0] <= cut]
        part = self.go(p2, f2, now=NOW)[0][M.SLEEVE_ID][0]
        for a, b in zip(part[:-5], full):
            self.assertAlmostEqual(a["equity"], b["equity"], places=4)
        # a corrupted future DGS2 tail must not change earlier targets
        f3 = f[:-16] + [(d, "99") for d, _ in f[-16:] if d != "2020-01-01"]
        alt = self.go(p, f3)[0][M.SLEEVE_ID][0]
        for a, b in zip(alt[:-20], full):
            self.assertEqual(a["target"], b["target"])

    def test_one_day_lag(self):
        s = M.clean_obs([("2025-06-26", "3.0"), ("2025-06-27", "3.1"),
                         ("2024-06-27", "4.0")])
        vti = M.Series([("2024-06-28", 100.0), ("2025-06-30", 110.0)])
        # decision on Mon 2025-06-30 uses Fri 06-27 (prev business day)
        t, why = M.decide(datetime.date(2025, 6, 30), s, vti, True)
        self.assertEqual((t, why), (0.10, "ok"))  # 3.1-4.0<0 and VTI up
        s2 = M.clean_obs([("2025-06-27", "3.1"), ("2025-06-30", "9.9"),
                          ("2024-06-27", "4.0")])
        self.assertEqual(M.decide(datetime.date(2025, 6, 30), s2, vti, True),
                         (0.10, "ok"))  # same-day obs 9.9 is not used

    def test_skips_never_partial(self):
        p = self.prices()

        def boom(*_a):
            raise OSError("net down")
        for fg in (boom, lambda *_a: [], lambda *_a: [("x", "y")]):
            err = io.StringIO()
            with redirect_stderr(err):
                out = M.produce("/x", NOW, p, fg)
            self.assertEqual(out, {})
            lines = err.getvalue().strip().splitlines()
            self.assertEqual(len(lines), 1)
            self.assertIn("macro_sleeve", json.loads(lines[0]))
        # stale FRED inside the forward window -> skipped, no rows
        stale = [x for x in fred(self.dates, -0.002)
                 if x[0] <= self.dates[100]]
        out, err = self.go(p, stale)
        self.assertEqual(out, {})
        self.assertEqual(len(err.strip().splitlines()), 1)
        out, err = self.go({"VTI": p["VTI"]}, fred(self.dates, 0.0))
        self.assertEqual(out, {})

    def test_missing_key_default_skips(self):
        old = os.environ.pop("FRED_API_KEY", None)
        from collector import config
        oldroot, config.ROOT = config.ROOT, tempfile.mkdtemp()
        try:
            err = io.StringIO()
            with redirect_stderr(err):
                out = M.produce("/x", NOW, self.prices())
        finally:
            config.ROOT = oldroot
            if old is not None:
                os.environ["FRED_API_KEY"] = old
        self.assertEqual(out, {})
        self.assertIn("FRED_API_KEY absent", err.getvalue())

    def test_ledger_chain_and_settle(self):
        out, _ = self.go(self.prices(), fred(self.dates, -0.002))
        rows, spec = out[M.SLEEVE_ID]
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "sleeves"))
            bad, summ = [], {}
            S._settle(d, M.SLEEVE_ID, rows, spec, False, bad, summ)
            S._settle(d, M.SLEEVE_ID, rows, spec, False, bad, summ)
            self.assertEqual(bad, [])
            self.assertEqual(summ[M.SLEEVE_ID]["sessions"], len(rows))
            logged, _ = S.read_log(os.path.join(d, "sleeves",
                                                M.SLEEVE_ID + ".jsonl"))
            self.assertEqual(len(logged), len(rows))
            self.assertEqual(logged[0]["prev"], "GENESIS")

    def test_event_flags_not_invented(self):
        self.assertIn("event_flags=unavailable", M.SPEC)


if __name__ == "__main__":
    unittest.main()
