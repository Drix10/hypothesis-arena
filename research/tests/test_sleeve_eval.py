import datetime
import hashlib
import io
import contextlib
import json
import os
import random
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from ops import sleeve_eval as E
from ops import sleeve_shadow as S
from research.strategy import stats

STRONG, MID, WEAK = "alpha_v1", "beta_v1", "gamma_v1"
B_SPY, B_CASH = S.BENCH_SPY, S.BENCH_CASH
BOOT = 300   # fast bootstrap in tests; decisions are far from the boundary
# Test-only ledger families, mapped like a promoted sleeve would be.
TEST_MAP = {k: (B_SPY, "test family %s, scored against SPY buy-and-hold" % k)
            for k in ("alpha", "beta", "gamma", "delta")}
_SAVED = {}


def setUpModule():
    _SAVED.update(E.MAPPING)
    E.MAPPING.update(TEST_MAP)


def tearDownModule():
    E.MAPPING.clear()
    E.MAPPING.update(_SAVED)


def dates(n, start="2026-09-30"):
    d, out = datetime.date.fromisoformat(start), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += datetime.timedelta(days=1)
    return out


def noise(n, seed, sd=0.004, mu=0.0003):
    rng = random.Random(seed)
    return [mu + rng.gauss(0, sd) for _ in range(n)]


def write(d, sid, rets, start="2026-09-30"):
    """Ledger whose first row is the rebase row (ret 0.0); len(rets) rows."""
    rows, eq = [], S.CASH0
    for i, (dt, r) in enumerate(zip(dates(len(rets), start), rets)):
        r = 0.0 if i == 0 else r
        eq *= 1.0 + r
        rows.append({"date": dt, "sleeve": sid, "equity": round(eq, 4),
                     "ret": round(r, 8), "target": None})
    os.makedirs(os.path.join(d, "sleeves"), exist_ok=True)
    S.append_rows(os.path.join(d, "sleeves", sid + ".jsonl"), [], rows)


def bench_set(d, n, seed=1):
    write(d, B_CASH, [0.0001] * n)
    b = noise(n, seed)
    write(d, B_SPY, b)
    return b


def ev(d):
    return E.evaluate(d, boot_b=BOOT)


class Eval(unittest.TestCase):
    def setUp(self):
        self._t = tempfile.TemporaryDirectory()
        self.d = self._t.name

    def tearDown(self):
        self._t.cleanup()

    def with_active(self, sid, n, active, seed=1):
        bench = bench_set(self.d, n, seed)
        write(self.d, sid, [b + a for b, a in zip(bench, active)])

    def test_positive_active_is_significant_but_continue_before_two_years(self):
        n = 300
        self.with_active(STRONG, n, noise(n, 5, sd=0.001, mu=0.001))
        e = ev(self.d)["ledgers"][STRONG]
        p = e["paired"]
        self.assertEqual(e["benchmark"], B_SPY)
        self.assertGreater(p["active_ann"], 0.15)
        self.assertGreater(p["t_hac"], 3)
        self.assertGreater(p["ci95_active_ann"][0], 0)
        self.assertGreater(p["ir_ann"], 0)
        self.assertEqual(e["checkpoint"]["state"], "CONTINUE")
        self.assertEqual(e["checkpoint"]["evidence"], "EVIDENCE-INSUFFICIENT")
        self.assertIsInstance(e["power"]["sessions_needed"], int)
        self.assertAlmostEqual(
            e["power"]["sessions_needed"],
            (1.645 / p["ir_ann"]) ** 2 * 252, delta=1.0)

    def test_negative_active_kill_futile_only_from_126_sessions(self):
        for n, want in ((125, "CONTINUE"), (126, "KILL-FUTILE")):
            with tempfile.TemporaryDirectory() as d:
                self.d = d
                self.with_active(STRONG, n, noise(n, 6, sd=0.0005, mu=-0.002))
                e = ev(d)["ledgers"][STRONG]
                self.assertEqual(e["sessions"], n)
                self.assertLess(e["paired"]["ci95_active_ann"][1], 0)
                self.assertEqual(e["checkpoint"]["state"], want, n)
                self.assertEqual(e["power"]["sessions_needed"], "n/a")

    def test_zero_active_is_undefined_not_significant(self):
        n = 100
        self.with_active(STRONG, n, [0.0] * n)
        e = ev(self.d)["ledgers"][STRONG]
        p = e["paired"]
        self.assertEqual(p["active_ann"], 0.0)
        self.assertIsNone(p["t_hac"])          # zero variance: no t-stat
        self.assertEqual(p["p_one_sided"], 1.0)
        self.assertIsNone(p["ir_ann"])
        self.assertEqual(e["power"]["sessions_needed"], "n/a")
        self.assertEqual(e["checkpoint"]["state"], "CONTINUE")
        json.dumps(ev(self.d), allow_nan=False)

    def test_warmup_below_60_sessions_no_judgement_even_if_extreme(self):
        for n, want in ((59, "WARMUP"), (60, "CONTINUE")):
            with tempfile.TemporaryDirectory() as d:
                self.d = d
                self.with_active(STRONG, n, [0.01] * n)   # huge, constant
                e = ev(d)["ledgers"][STRONG]
                self.assertEqual(e["checkpoint"]["state"], want)
        with tempfile.TemporaryDirectory() as d:
            self.d = d
            self.with_active(STRONG, 40, noise(40, 2, sd=0.0005, mu=-0.01))
            self.assertEqual(ev(d)["ledgers"][STRONG]["checkpoint"]["state"],
                             "WARMUP")   # futility needs >= 126 sessions

    def test_level_statistics(self):
        n = 121
        self.with_active(STRONG, n, [0.0] * n)
        r = ev(self.d)["ledgers"][STRONG]["returns"]
        rows, _ = S.read_log(os.path.join(self.d, "sleeves", STRONG + ".jsonl"))
        rets = [x["ret"] for x in rows[1:]]
        self.assertEqual(r["n_returns"], 120)
        self.assertAlmostEqual(r["cum_return"], rows[-1]["equity"] / S.CASH0 - 1,
                               places=6)
        self.assertAlmostEqual(r["ann_vol"], stats.stdev(rets) * 252 ** 0.5)
        self.assertAlmostEqual(r["max_drawdown"], stats.max_drawdown(rets))
        self.assertAlmostEqual(
            r["sharpe_excess_cash"],
            stats.sharpe([x - 0.0001 for x in rets], 252))
        self.assertAlmostEqual(r["ann_return"],
                               (1 + r["cum_return"]) ** (252 / 120) - 1)

    def test_pooled_holm_ordering_and_matches_stats_holm(self):
        n = 300
        bench = bench_set(self.d, n)
        for sid, mu, seed in ((STRONG, 0.0012, 31), (MID, 0.0004, 32),
                              (WEAK, 0.0, 33)):
            write(self.d, sid, [b + a for b, a in zip(
                bench, noise(n, seed, sd=0.002, mu=mu))])
        write(self.d, "delta_x", noise(n, 9))           # weak, still pooled
        res = ev(self.d)
        h = res["holm"]["pooled"]
        self.assertEqual(sorted(h["ledgers"]),
                         sorted([STRONG, MID, WEAK, "delta_x"]))
        self.assertEqual(h["m"], 4)                     # benchmarks excluded
        ps, adj = h["p"], h["adjusted"]
        order = sorted(range(4), key=lambda i: ps[i])
        for rank, i in enumerate(order):                # Holm step-down
            lower = max(min(1.0, (4 - k) * ps[j])
                        for k, j in enumerate(order[:rank + 1]))
            self.assertAlmostEqual(adj[i], lower)
        self.assertEqual([a < 0.05 for a in adj], h["reject"])
        self.assertEqual(h["reject"], stats.holm(ps, 0.05))
        strong = h["ledgers"].index(STRONG)
        self.assertLess(adj[strong], 0.05)
        self.assertLessEqual(ps[strong], min(ps))
        self.assertGreaterEqual(adj[strong], ps[strong])
        # pooling makes it harder than a single test: adj = m * p when smallest
        self.assertAlmostEqual(adj[strong], min(1.0, 4 * ps[strong]))

    def test_unevaluable_ledger_keeps_family_size_fixed(self):
        n = 200
        bench_set(self.d, n)
        write(self.d, STRONG, [b + 0.002 for b in noise(n, 1)])
        write(self.d, "mystery_v1", noise(n, 4))       # no mapping
        res = ev(self.d)
        self.assertEqual(res["ledgers"]["mystery_v1"]["checkpoint"]["state"],
                         "NO-MAPPING")
        h = res["holm"]["pooled"]
        self.assertEqual(h["m"], 2)
        self.assertEqual(h["p"][h["ledgers"].index("mystery_v1")], 1.0)

    def test_missing_benchmark(self):
        write(self.d, STRONG, noise(100, 1))
        e = ev(self.d)["ledgers"][STRONG]
        self.assertEqual(e["checkpoint"]["state"], "NO-BENCHMARK")
        self.assertIsNone(e["paired"])

    def test_eligible_needs_504_sessions_and_all_conditions(self):
        n = 520
        bench = bench_set(self.d, n)
        write(self.d, STRONG, [b + a for b, a in
                                zip(bench, noise(n, 5, sd=0.001, mu=0.001))])
        e = ev(self.d)["ledgers"][STRONG]
        self.assertEqual(e["checkpoint"]["state"], "ELIGIBLE-FOR-REVIEW")
        self.assertEqual(e["checkpoint"]["evidence"], "REVIEW-CRITERIA-MET")
        self.assertIn("MAY review", e["checkpoint"]["reasons"][0])
        self.assertIn("never a promotion", E.NOTICE)
        # 503 sessions: same edge, not yet
        with tempfile.TemporaryDirectory() as d:
            bench = bench_set(d, 503)
            write(d, STRONG, [b + a for b, a in
                               zip(bench, noise(503, 5, sd=0.001, mu=0.001))])
            self.assertEqual(ev(d)["ledgers"][STRONG]["checkpoint"]["state"],
                             "CONTINUE")
        # deeper drawdown than the benchmark blocks eligibility
        with tempfile.TemporaryDirectory() as d:
            bench = bench_set(d, n)
            act = noise(n, 5, sd=0.001, mu=0.0015)
            for i in range(1, 16):
                act[i] = -0.03
            write(d, STRONG, [b + a for b, a in zip(bench, act)])
            r = ev(d)["ledgers"][STRONG]
            self.assertFalse(r["paired"]["dd_ok"])
            self.assertEqual(r["checkpoint"]["state"], "CONTINUE")
            self.assertTrue(any("drawdown" in x for x in r["checkpoint"]["reasons"]))
        # not significant after pooling: weak edge
        with tempfile.TemporaryDirectory() as d:
            bench = bench_set(d, n)
            write(d, STRONG, [b + a for b, a in
                               zip(bench, noise(n, 5, sd=0.004, mu=0.0))])
            self.assertNotEqual(ev(d)["ledgers"][STRONG]["checkpoint"]["state"],
                                "ELIGIBLE-FOR-REVIEW")

    def test_chain_tamper_is_loud_and_excluded(self):
        n = 200
        self.with_active(STRONG, n, [0.001] * n)
        write(self.d, MID, noise(n, 11))
        p = os.path.join(self.d, "sleeves", STRONG + ".jsonl")
        with open(p) as f:
            lines = f.read().splitlines()
        r = json.loads(lines[5])
        r["equity"] += 1
        lines[5] = json.dumps(r, sort_keys=True)
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        res = ev(self.d)
        self.assertFalse(res["fidelity"]["ok"])
        self.assertIn(STRONG, res["fidelity"]["chain_failures"])
        self.assertTrue(res["fidelity"]["chain_failures"][STRONG]
                        .startswith("chain-broken:"))
        self.assertEqual(res["ledgers"][STRONG]["checkpoint"]["state"],
                         "CHAIN-BROKEN")
        self.assertIsNone(res["ledgers"][STRONG]["paired"])
        self.assertEqual(res["ledgers"][MID]["checkpoint"]["state"],
                         "CONTINUE")                    # others still judged
        self.assertEqual(res["holm"]["pooled"]["m"], 2)  # family not shrunk
        table = E.format_table(res)
        self.assertIn("FIDELITY FAILURE", table)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = E.main(["x", self.d])
        self.assertEqual(rc, 3)
        self.assertIn("FIDELITY FAILURE", buf.getvalue())

    def test_broken_benchmark_marks_dependents(self):
        n = 100
        self.with_active(STRONG, n, [0.001] * n)
        p = os.path.join(self.d, "sleeves", B_SPY + ".jsonl")
        with open(p) as f:
            lines = f.read().splitlines()
        lines[3] = lines[3].replace('"equity": ', '"equity": 1')
        with open(p, "w") as f:
            f.write("\n".join(lines) + "\n")
        res = ev(self.d)
        self.assertFalse(res["fidelity"]["ok"])
        self.assertEqual(res["ledgers"][STRONG]["checkpoint"]["state"],
                         "NO-BENCHMARK")

    def test_cli_json_writes_atomic_eval_and_never_touches_ledgers(self):
        n = 130
        self.with_active(STRONG, n, noise(n, 1, sd=0.001, mu=0.0005))
        sd = os.path.join(self.d, "sleeves")

        def snap():
            out = {}
            for f in sorted(os.listdir(sd)):
                if f.endswith(".jsonl"):
                    with open(os.path.join(sd, f), "rb") as fh:
                        out[f] = hashlib.sha256(fh.read()).hexdigest()
            return out
        before = snap()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = E.main(["x", self.d, "--json"])
        self.assertEqual(rc, 0)
        out = json.loads(buf.getvalue())
        with open(os.path.join(sd, "eval.json")) as f:
            disk = json.load(f)
        self.assertEqual(out, disk)
        self.assertEqual(before, snap())
        self.assertFalse(os.path.exists(os.path.join(sd, "eval.json.tmp")))
        self.assertEqual(set(out["benchmarks"]), set(S.BENCHMARKS))
        self.assertNotIn(B_SPY, out["ledgers"])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(E.main(["x", self.d]), 0)
        self.assertIn(STRONG, buf.getvalue())
        self.assertIn("never a promotion", buf.getvalue())
        # deterministic
        self.assertEqual(ev(self.d), ev(self.d))

    def test_mapping(self):
        self.assertEqual(E.benchmark_for("core_passive_v1")[0], B_SPY)
        self.assertEqual(E.benchmark_for("alpha_v1")[0], B_SPY)
        self.assertIsNone(E.benchmark_for("zzz")[0])
        self.assertTrue(all(len(v[1]) > 20 for v in E.MAPPING.values()))
        self.assertTrue(all(v[0] in S.BENCHMARKS or v[0] == "core_passive_v1"
                            for v in E.MAPPING.values()))

    def test_shadow_hook_never_stops_the_loop(self):
        old = E.write_eval
        E.write_eval = lambda d, **kw: 1 / 0
        try:
            buf = io.StringIO()
            with contextlib.redirect_stderr(buf):
                S._evaluate(self.d)          # must not raise
            self.assertIn("sleeve_eval", buf.getvalue())
        finally:
            E.write_eval = old
        n = 70
        self.with_active(STRONG, n, [0.0] * n)
        S._evaluate(self.d)
        self.assertTrue(os.path.exists(os.path.join(self.d, "sleeves", "eval.json")))

    def test_empty_dir(self):
        res = ev(self.d)
        self.assertEqual(res["ledgers"], {})
        self.assertTrue(res["fidelity"]["ok"])


class Monitor(unittest.TestCase):
    def test_eval_line(self):
        from ops import monitor
        with tempfile.TemporaryDirectory() as d:
            n = 70
            bench_set(d, n)
            write(d, STRONG, [b + 0.001 for b in noise(n, 1)])
            E.write_eval(d, boot_b=BOOT)
            out = []
            monitor.panel_sleeves(d, out)
            txt = "\n".join(out)
            self.assertIn("EVAL CONTINUE", txt)
            self.assertIn("t=", txt)
            self.assertIn("EVAL BENCHMARK", txt)
            os.remove(os.path.join(d, "sleeves", "eval.json"))
            out = []
            monitor.panel_sleeves(d, out)
            self.assertIn("EVAL n/a", "\n".join(out))


if __name__ == "__main__":
    unittest.main()
