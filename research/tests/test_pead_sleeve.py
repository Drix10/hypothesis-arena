import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import portfolio
from research.strategy.sleeves.pead import PeadSleeve


def days(n):
    return ["2020-%02d-%02d" % (1 + i // 28, 1 + i % 28) for i in range(n)]


def bars(sess, px=10.0, vol=1_000_000, drift=0.0, drop_at=None):
    raw, adj, p = {}, {}, px
    for i, d in enumerate(sess):
        c = p * (1 + drift)
        if drop_at is not None and i == drop_at:
            c = p * 0.5
        raw[d] = (p, c, vol)
        adj[d] = (p, max(p, c) * 1.005, min(p, c) * 0.995, c)
        p = c
    return raw, adj


def ev(d, sym, sue=2.0, pct=0.95):
    return {"date": d, "symbol": sym, "cik": "1", "sue": sue, "pct": pct}


def make(events, syms, **kw):
    sess = days(120)
    raw, adj = {}, {}
    for s, spec in syms.items():
        raw[s], adj[s] = bars(sess, **spec)
    args = dict(min_price=2.0, min_dollar_volume=2e6)
    args.update(kw)
    return sess, raw, adj, PeadSleeve(events, raw, adj, sess, **args)


def run(sl, sess, upto=None):
    out = {}
    for i, d in enumerate(sess[:upto]):
        w = sl.target_fn(d, {})
        if w is not None:
            out[i] = w
    return out


class Sleeve(unittest.TestCase):
    def test_enters_next_session_and_exits_after_20_sessions(self):
        sess, raw, adj, sl = make([ev(days(120)[60], "AAA")], {"AAA": {}})
        self.assertEqual(run(sl, sess), {60: {"AAA": 0.2}, 80: {}})
        self.assertEqual(sl.stats["entered"], 1)

    def test_hold_60(self):
        sess, raw, adj, sl = make([ev(days(120)[45], "AAA")], {"AAA": {}},
                                  hold=60)
        self.assertEqual(run(sl, sess), {45: {"AAA": 0.2}, 105: {}})

    def test_signal_thresholds(self):
        d = days(120)[60]
        sess, raw, adj, sl = make(
            [ev(d, "LOWSUE", sue=0.9), ev(d, "LOWPCT", pct=0.85),
             ev(d, "OK", sue=1.0, pct=0.9)],
            {"LOWSUE": {}, "LOWPCT": {}, "OK": {}})
        self.assertEqual(run(sl, sess, 61), {60: {"OK": 0.2}})
        self.assertEqual(sl.stats["ineligible"], 2)
        _, _, _, q = make([ev(d, "LOWPCT", pct=0.85)], {"LOWPCT": {}},
                          min_pct=0.8)
        self.assertEqual(run(q, sess, 61), {60: {"LOWPCT": 0.2}})

    def test_liquidity_and_price_filters(self):
        d = days(120)[60]
        sess, raw, adj, sl = make(
            [ev(d, "LOW"), ev(d, "PENNY"), ev(d, "OK")],
            {"LOW": {"vol": 1000}, "PENNY": {"px": 1.0}, "OK": {}})
        self.assertEqual(run(sl, sess, 61), {60: {"OK": 0.2}})
        self.assertEqual(sl.stats["ineligible"], 2)

    def test_slot_cap_prefers_larger_sue_and_counts_skips(self):
        d = days(120)[60]
        names = ["A%d" % k for k in range(7)]
        sess, raw, adj, sl = make(
            [ev(d, n, sue=1.0 + 0.1 * k) for k, n in enumerate(names)],
            {n: {} for n in names})
        w = run(sl, sess, 61)[60]
        self.assertEqual(sorted(w), ["A2", "A3", "A4", "A5", "A6"])
        self.assertEqual(sl.stats["skipped_full"], 2)

    def test_no_reentry_while_held(self):
        sess = days(120)
        _, _, _, sl = make([ev(sess[60], "AAA"), ev(sess[65], "AAA")],
                           {"AAA": {}})
        self.assertEqual(run(sl, sess), {60: {"AAA": 0.2}, 80: {}})
        self.assertEqual(sl.stats["entered"], 1)

    def test_missing_data_is_counted_not_traded(self):
        d = days(120)[60]
        sess, raw, adj, sl = make([ev(d, "GONE"), ev(d, "AAA")], {"AAA": {}})
        run(sl, sess, 61)
        self.assertEqual(sl.stats["no_data"], 1)
        self.assertEqual(sl.stats["entered"], 1)

    def test_never_eligible_symbols_are_ineligible_not_missing(self):
        d = days(120)[60]
        sess, raw, adj, sl = make([ev(d, "ILLIQ"), ev(d, "AAA")],
                                  {"AAA": {}}, never_eligible={"ILLIQ"})
        run(sl, sess, 61)
        self.assertEqual(sl.stats["no_data"], 0)
        self.assertEqual(sl.stats["ineligible"], 1)

    def test_catastrophe_stop_exits_early(self):
        d = days(120)[60]
        sess, raw, adj, sl = make([ev(d, "AAA")], {"AAA": {"drop_at": 65}})
        exits = [i for i, x in enumerate(sess) if sl.target_fn(x, {}) == {}]
        self.assertEqual(exits, [65])
        self.assertEqual(sl.stats["stopped"], 1)

    def test_runs_through_the_portfolio_engine(self):
        sess = days(120)
        raw, adj = bars(sess, drift=0.002)
        sl = PeadSleeve([ev(sess[60], "AAA")], {"AAA": raw}, {"AAA": adj},
                        sess, min_price=2.0, min_dollar_volume=2e6)
        prices = {"AAA": {d: (raw[d][0], raw[d][1]) for d in sess}}
        r = portfolio.run(sess, prices, sl.target_fn, spread_bps=50.0)
        self.assertEqual([t[2] for t in r["trades"]], ["BUY", "SELL"])
        self.assertGreater(r["equity"][-1], 100000.0)


if __name__ == "__main__":
    unittest.main()
