import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from research.strategy import portfolio
from research.strategy.sleeves.insider import InsiderSleeve


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


def ev(d, sym, value=50000.0, n=1):
    return {"date": d, "symbol": sym, "cik": "1", "value": value,
            "n_insiders": n}


def make(events, syms, **kw):
    sess = days(120)
    raw, adj = {}, {}
    for s, spec in syms.items():
        raw[s], adj[s] = bars(sess, **spec)
    args = dict(min_price=2.0, min_dollar_volume=2e6)
    args.update(kw)
    return sess, raw, adj, InsiderSleeve(events, raw, adj, sess, **args)


class Sleeve(unittest.TestCase):
    def test_enters_next_session_and_exits_after_hold(self):
        sess, raw, adj, sl = make([ev(days(120)[60], "AAA")], {"AAA": {}})
        out = {}
        for i, d in enumerate(sess):
            w = sl.target_fn(d, {})
            if w is not None:
                out[i] = w
        self.assertEqual(out, {60: {"AAA": 0.2}, 81: {}})  # exit decided at close 81, sold open 82
        self.assertEqual(sl.stats["entered"], 1)

    def test_liquidity_price_value_and_cluster_filters(self):
        d = days(120)[60]
        sess, raw, adj, sl = make(
            [ev(d, "LOW"), ev(d, "PENNY"), ev(d, "SMALLV", value=1000.0),
             ev(d, "SOLO", n=1), ev(d, "OK", n=2)],
            {"LOW": {"vol": 1000}, "PENNY": {"px": 1.0}, "SMALLV": {},
             "SOLO": {}, "OK": {}}, min_insiders=2)
        for x in sess[:61]:
            w = sl.target_fn(x, {})
        self.assertEqual(w, {"OK": 0.2})

    def test_slot_cap_prefers_larger_value_and_counts_skips(self):
        d = days(120)[60]
        names = ["A%d" % k for k in range(7)]
        sess, raw, adj, sl = make(
            [ev(d, n, value=30000.0 + 1000 * k) for k, n in enumerate(names)],
            {n: {} for n in names})
        for x in sess[:61]:
            w = sl.target_fn(x, {})
        self.assertEqual(len(w), 5)
        self.assertNotIn("A0", w)
        self.assertEqual(sl.stats["skipped_full"], 2)

    def test_missing_data_is_counted_not_traded(self):
        d = days(120)[60]
        sess, raw, adj, sl = make([ev(d, "GONE"), ev(d, "AAA")], {"AAA": {}})
        for x in sess[:61]:
            sl.target_fn(x, {})
        self.assertEqual(sl.stats["no_data"], 1)
        self.assertEqual(sl.stats["entered"], 1)

    def test_never_eligible_symbols_are_ineligible_not_missing(self):
        d = days(120)[60]
        sess, raw, adj, sl = make([ev(d, "ILLIQ"), ev(d, "AAA")],
                                  {"AAA": {}}, never_eligible={"ILLIQ"})
        for x in sess[:61]:
            sl.target_fn(x, {})
        self.assertEqual(sl.stats["no_data"], 0)
        self.assertEqual(sl.stats["ineligible"], 1)

    def test_catastrophe_stop_exits_early(self):
        d = days(120)[60]
        sess, raw, adj, sl = make([ev(d, "AAA")], {"AAA": {"drop_at": 65}})
        exits = [i for i, x in enumerate(sess)
                 if sl.target_fn(x, {}) == {}]
        self.assertEqual(exits, [65])
        self.assertEqual(sl.stats["stopped"], 1)

    def test_runs_through_the_portfolio_engine(self):
        sess = days(120)
        raw, adj = bars(sess, drift=0.002)
        sl = InsiderSleeve([ev(sess[60], "AAA")], {"AAA": raw}, {"AAA": adj},
                           sess, min_price=2.0, min_dollar_volume=2e6)
        prices = {"AAA": {d: (raw[d][0], raw[d][1]) for d in sess}}
        r = portfolio.run(sess, prices, sl.target_fn, spread_bps=50.0)
        sides = [t[2] for t in r["trades"]]
        self.assertEqual(sides, ["BUY", "SELL"])
        self.assertGreater(r["equity"][-1], 100000.0)


if __name__ == "__main__":
    unittest.main()
