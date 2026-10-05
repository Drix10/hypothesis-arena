import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from research.strategy import composite as C

DATE = "2024-04-30"
N = 16
SYMS = ["S%02d" % i for i in range(N)]


def edge(i, j, source="supply_chain", known_at=20240101):
    return {"edge_id": "e%d-%d" % (i, j), "src_cik": "C%02d" % i,
            "dst_cik": "C%02d" % j, "source": source, "type": "customer",
            "weight": 1.0, "valid_from": 20230101, "valid_to": None,
            "known_at": known_at, "evidence_ids": ["x"],
            "extractor": "deterministic",
            "contamination_class": "deterministic"}


def data(filings=True, events=True):
    ret = {s: ((i * 37) % 17 - 8) / 100.0 for i, s in enumerate(SYMS)}
    d = {"market_cap": {s: 2e9 * (1 + (i * 5) % 13)
                        for i, s in enumerate(SYMS)},
         "beta": {s: 0.8 + 0.05 * ((i * 7) % 11) for i, s in enumerate(SYMS)},
         "returns": ret,
         "industry": {s: "AB"[i % 2] for i, s in enumerate(SYMS)},
         "market_return": 0.01,
         "industry_returns": {"A": 0.02, "B": -0.01},
         "ciks": {"C%02d" % i: s for i, s in enumerate(SYMS)},
         "edges": [edge(i, (i + k) % N) for i in range(N) for k in (1, 3)],
         "filings": {}, "events": [],
         "vetoes": {n: (lambda s: False) for n in C.VETOES}}
    if filings:
        d["filings"] = {s: [{"known_at": "2024-04-10T10:00:00-04:00",
                             "delta": ((i * 11) % 13) / 13.0}]
                        for i, s in enumerate(SYMS[:12])}
    if events:
        d["events"] = [{"date": "2024-04-15", "symbol": s, "opportunistic": True,
                        "value": 1e5 * (1 + (i * 3) % 7),
                        "entry": "2024-04-17T09:30"}
                       for i, s in enumerate(SYMS[:10])]
    return d


class TestParts(unittest.TestCase):
    def test_winsorize_clips_tails(self):
        x = {str(i): float(i) for i in range(101)}
        x["hi"] = 1e6
        w = C.winsorize(x)
        self.assertLess(w["hi"], 1e6)
        self.assertEqual(w["50"], 50.0)

    def test_zscore_ties_and_symmetry(self):
        z = C.zscore({"a": 1.0, "b": 2.0, "c": 2.0, "d": 3.0})
        self.assertEqual(z["b"], z["c"])
        self.assertAlmostEqual(z["a"], -z["d"])

    def test_residual_unit_scale(self):
        keys = ["k%d" % i for i in range(12)]
        z = C.zscore({k: float((i * 5) % 12) for i, k in enumerate(keys)})
        ctl = {k: [float(i % 3), float((i * 7) % 5)]
               for i, k in enumerate(keys)}
        r = C.residualize(z, ctl)
        self.assertAlmostEqual(sum(v * v for v in r.values()) / 11, 1.0)
        self.assertEqual(C.residualize({"a": 1.0}, {"a": [1.0]}), {})


class TestComposite(unittest.TestCase):
    def test_missing_components_count_as_zero(self):
        d = data(filings=False, events=False)
        comps = C.components(d, DATE)
        self.assertEqual(comps["filing"], {})
        self.assertEqual(comps["insider"], {})
        s = C.composite(comps, SYMS)
        for k, z in comps["link"].items():
            self.assertAlmostEqual(s[k], z / 3.0)
        self.assertTrue(C.target(d, DATE, 3))

    def test_no_component_no_position(self):
        d = data(filings=False, events=False)
        d["edges"] = []
        self.assertEqual(C.target(d, DATE, 3), {})

    def test_missing_control_drops_symbol(self):
        d = data()
        del d["beta"]["S03"]
        for comp in C.components(d, DATE).values():
            self.assertNotIn("S03", comp)

    def test_gate_drops_contradicting_component(self):
        self.assertTrue(C.passes_gate([0.9, -0.9, 0.0], 0.5, 1.0))
        self.assertFalse(C.passes_gate([2.5, -1.5, 0.1], 0.4, 1.0))
        self.assertFalse(C.passes_gate([2.5, 0.5, 0.0], -0.1, 0.4))
        self.assertTrue(C.passes_gate([2.5, -1.5, 0.1], 0.4, 2.0))

    def test_gate_applies_in_target(self):
        d = data()
        comps = C.components(d, DATE)
        s = C.composite(comps, C._universe(d))
        free = C.target(d, DATE, 4, tau=1e9)
        gated = C.target(d, DATE, 4)
        self.assertLessEqual(set(gated), set(free))
        for k in set(free) - set(gated):
            self.assertFalse(C.passes_gate(
                [c.get(k, 0.0) for c in comps.values()], s[k], C.TAU_PROPOSED))

    def test_vetoed_short_is_dropped_long_is_not(self):
        d = data()
        free = C.target(d, DATE, 4, tau=1e9)
        short = next(k for k, w in free.items() if w < 0)
        long = next(k for k, w in free.items() if w > 0)
        for name in C.VETOES:
            v = dict(d["vetoes"], **{name: lambda s, t=short, u=long:
                                     s in (t, u)})
            out = C.target(dict(d, vetoes=v), DATE, 4, tau=1e9)
            self.assertNotIn(short, out)
            self.assertIn(long, out)

    def test_small_cap_and_missing_predicate_veto_short(self):
        d = data()
        short = next(k for k, w in C.target(d, DATE, 4, tau=1e9).items()
                     if w < 0)
        small = dict(d, market_cap=dict(d["market_cap"], **{short: 5e8}))
        self.assertTrue(C.short_vetoed(short, small))
        self.assertTrue(C.short_vetoed(short, dict(d, vetoes={})))
        self.assertFalse(C.short_vetoed(short, d))

    def test_late_filing_not_used(self):
        d = data()
        late = {"S00": [{"known_at": "2024-04-30T18:00:00-04:00",
                         "delta": 0.9}],
                "S01": [{"known_at": "2024-04-29T18:00:00-04:00",
                         "delta": 0.4}],
                "S02": [{"delta": 0.4}]}
        u = C._universe(d)
        out = C.filing_raw({"filings": late}, u, DATE)
        self.assertEqual(out, {"S01": -0.4})
        later = C.filing_raw({"filings": late}, u, "2024-05-01")
        self.assertEqual(later["S00"], -0.9)

    def test_late_event_and_edge_not_used(self):
        d = data()
        u = C._universe(d)
        ev = [{"date": "2024-04-29", "symbol": "S00", "opportunistic": True,
               "value": 1e5, "entry": "2024-05-01T09:30"},
              {"date": "2024-04-15", "symbol": "S01", "opportunistic": False,
               "value": 1e5, "entry": "2024-04-17T09:30"},
              {"date": "2024-04-15", "symbol": "S02", "opportunistic": True,
               "value": 1e5, "entry": "2024-04-17T09:30"}]
        self.assertEqual(list(C.insider_raw({"events": ev}, u, DATE)), ["S02"])
        d["edges"] = [edge(0, 1, known_at=20240501)]
        self.assertEqual(C.link_raw(d, u, DATE), {})

    def test_target_fn_month_end_and_exposure(self):
        d = data()
        sess = ["2024-04-29", DATE, "2024-05-01"]
        fn = C.CompositeTarget(sess, lambda day: d, 3, tau=1e9)
        self.assertIsNone(fn(sess[0], {}))
        w = fn(DATE, {})
        self.assertAlmostEqual(sum(abs(v) for v in w.values()), 1.0)
        half = C.CompositeTarget(sess, lambda day: d, 3, tau=1e9, exposure=0.5)(DATE, {})
        self.assertAlmostEqual(sum(abs(v) for v in half.values()), 0.5)
        none = C.CompositeTarget(sess, lambda day: None, 3)
        self.assertEqual(none(DATE, {}), {})
        self.assertEqual(C.CompositeTarget(
            sess, lambda day: d, 3, tau=1e9, exposure=lambda day: 0.0)(DATE, {}),
            {k: 0.0 for k in w})


class TestCorrelation(unittest.TestCase):
    def test_identical_components_count_one(self):
        a = [1.0, -2.0, 0.5, 3.0, -1.0]
        corr = C.component_correlation([a, [2 * x + 1 for x in a]])
        self.assertAlmostEqual(C.effective_signal_count(corr), 1.0)

    def test_independent_components_count_n(self):
        a = [1.0, -1.0, 1.0, -1.0]
        b = [1.0, 1.0, -1.0, -1.0]
        corr = C.component_correlation([a, b])
        self.assertAlmostEqual(C.effective_signal_count(corr), 2.0)

    def test_pairwise_complete(self):
        a = [1.0, 2.0, 3.0, 4.0, 5.0]
        b = [None, 2.0, 4.0, 6.0, None]
        corr = C.component_correlation([a, b])
        self.assertAlmostEqual(corr[0][1], 1.0)
        with self.assertRaises(C.CompositeError):
            C.component_correlation([a, [None, 1.0, None, 2.0, None]])


if __name__ == "__main__":
    unittest.main()
