"""Point-in-time universe tests; fixtures only, no network."""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", ".."))

from research.sources import ticker_map as tm
from research.strategy import universe as U

D = datetime.date
AS_OF = D(2021, 6, 1)
END = D(2022, 1, 1)


def facts(value, filed="2021-03-01"):
    return {"facts": {"dei": {"EntityPublicFloat": {"units": {"USD": [
        {"val": value, "end": "2020-12-31", "filed": filed,
         "accn": "a-" + filed, "form": "10-K"}]}}}}}


def days(first, last):
    return [first + datetime.timedelta(days=i)
            for i in range((last - first).days + 1)]


def obs(cik, symbol, known=D(2020, 1, 1)):
    return tm.observation(cik, symbol, "dei", D(2020, 1, 1), known)


def build(ciks, observations, fx, bars, events=None, **kw):
    return U.universe(AS_OF, ciks, observations, fx, bars, events or {}, END,
                      **kw)


def classes(out):
    return {r["cik"]: r["class"] for r in out["records"]}


LIVE = days(D(2021, 1, 1), END)


class UniverseTest(unittest.TestCase):
    def test_each_classification(self):
        observations = [obs(1, "AAA"), obs(2, "BBB"), obs(4, "DDD"),
                        obs(5, "EEE"), obs(6, "FFF")]
        fx = {1: facts(900e6), 2: facts(100e6), 3: facts(900e6),
              4: facts(900e6), 5: facts(900e6)}
        gone = days(D(2021, 1, 1), D(2021, 3, 1))
        bars = {"AAA": LIVE, "BBB": LIVE, "DDD": gone, "EEE": gone}
        events = {"DDD": [{"form": "25", "date": D(2021, 3, 5),
                           "accession": "x", "security_class": "common"}]}
        out = build([1, 2, 3, 4, 5, 6], observations, fx, bars, events)
        self.assertEqual(classes(out), {
            1: U.ELIGIBLE, 2: U.BELOW_FLOOR, 3: U.UNRESOLVED,
            4: U.DELISTED_BEFORE, 5: U.NO_BARS, 6: U.UNRESOLVED})
        self.assertEqual([r["cik"] for r in out["universe"]], [1])
        self.assertEqual(out["universe"][0]["symbol"], "AAA")
        self.assertEqual(out["counts"], {
            U.ELIGIBLE: 1, U.BELOW_FLOOR: 1, U.UNRESOLVED: 2,
            U.NO_BARS: 1, U.DELISTED_BEFORE: 1})

    def test_symbol_without_bars_is_no_bars(self):
        out = build([1], [obs(1, "AAA")], {1: facts(900e6)}, {})
        self.assertEqual(classes(out), {1: U.NO_BARS})

    def test_float_at_floor_is_eligible(self):
        out = build([1], [obs(1, "AAA")], {1: facts(500e6)}, {"AAA": LIVE})
        self.assertEqual(classes(out), {1: U.ELIGIBLE})

    def test_floor_is_a_parameter(self):
        out = build([1], [obs(1, "AAA")], {1: facts(900e6)}, {"AAA": LIVE},
                    min_float=1e9)
        self.assertEqual(classes(out), {1: U.BELOW_FLOOR})

    def test_fact_filed_after_as_of_is_ignored(self):
        fx = {1: facts(900e6, filed="2021-06-02")}
        out = build([1], [obs(1, "AAA")], fx, {"AAA": LIVE})
        self.assertEqual(classes(out), {1: U.UNRESOLVED})
        self.assertIsNone(out["records"][0]["public_float"])

    def test_late_restatement_does_not_change_float(self):
        fx = {1: facts(900e6)}
        rows = fx[1]["facts"]["dei"]["EntityPublicFloat"]["units"]["USD"]
        rows.append({"val": 1e6, "end": "2020-12-31", "filed": "2021-06-02",
                     "accn": "late", "form": "10-K/A"})
        out = build([1], [obs(1, "AAA")], fx, {"AAA": LIVE})
        self.assertEqual(out["records"][0]["public_float"], 900e6)

    def test_observation_known_after_as_of_is_ignored(self):
        o = [obs(1, "AAA", known=D(2021, 6, 2))]
        out = build([1], o, {1: facts(900e6)}, {"AAA": LIVE})
        self.assertEqual(classes(out), {1: U.UNRESOLVED})

    def test_end_event_dated_after_as_of_is_ignored(self):
        bars = {"AAA": days(D(2021, 1, 1), D(2021, 5, 1))}
        events = {"AAA": [{"form": "25", "date": D(2021, 6, 2),
                           "accession": "x", "security_class": "common"}]}
        out = build([1], [obs(1, "AAA")], {1: facts(900e6)}, bars, events)
        self.assertEqual(classes(out), {1: U.NO_BARS})

    def test_bars_starting_after_as_of_are_not_bars(self):
        bars = {"AAA": days(D(2021, 6, 2), END)}
        out = build([1], [obs(1, "AAA")], {1: facts(900e6)}, bars)
        self.assertEqual(classes(out), {1: U.NO_BARS})

    def test_void_flag_on_both_sides_of_limit(self):
        # 20 candidates: 1 excluded is exactly 5%, 2 excluded is 10%.
        def run(excluded):
            ciks = list(range(1, 21))
            observations = [obs(c, "S%d" % c) for c in ciks if c > excluded]
            fx = {c: facts(900e6) for c in ciks}
            bars = {"S%d" % c: LIVE for c in ciks}
            return build(ciks, observations, fx, bars)
        at_limit, over = run(1), run(2)
        self.assertEqual(at_limit["excluded_share"], 0.05)
        self.assertFalse(at_limit["void"])
        self.assertEqual(over["excluded_share"], 0.10)
        self.assertTrue(over["void"])

    def test_below_floor_leaves_the_denominator(self):
        observations = [obs(1, "AAA"), obs(3, "CCC")]
        fx = {1: facts(900e6), 3: facts(1e6)}
        out = build([1, 2, 3], observations, fx, {"AAA": LIVE, "CCC": LIVE})
        self.assertEqual(out["excluded_share"], 0.5)

    def test_empty_candidates(self):
        out = build([], [], {}, {})
        self.assertEqual(out["universe"], [])
        self.assertEqual(out["excluded_share"], 0.0)
        self.assertFalse(out["void"])

    def test_bad_as_of_refused(self):
        with self.assertRaises(ValueError):
            U.universe("2021-06-01", [], [], {}, {}, {}, END)


if __name__ == "__main__":
    unittest.main()
