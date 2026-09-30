"""JEV paired A/B twin: log-only, idempotent, journal-before-use, anonymised.
Provider mocked via post_fn; no network, no spend."""
import datetime
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
from collector import jev
from ops import jev_twin as T
from ops import sleeve_shadow as S

TMP = tempfile.mkdtemp()
jev.CACHE_DIR = os.path.join(TMP, "cache")
jev.SPEND_DIR = os.path.join(TMP, "spend")
jev.CALL_LOG = os.path.join(TMP, "calls.jsonl")
jev.KEY_PATH = os.path.join(TMP, "keys", "k.json")
jev.RETRY_DELAY_S = 0
jev.keypair()

NOW = datetime.datetime(2026, 12, 2, 21, 0, tzinfo=datetime.timezone.utc)
SID = "sector_mom_v1"


def synth(symbols, start="2025-01-02", n=520, drift=0.0004):
    d = datetime.date.fromisoformat(start)
    dates = []
    while len(dates) < n:
        if d.weekday() < 5:
            dates.append(d.isoformat())
        d += datetime.timedelta(days=1)
    out = {}
    for k, s in enumerate(symbols):
        px, row = 50.0 + k * 10, {}
        for i, dt in enumerate(dates):
            px *= 1 + drift + 0.004 * (((i * 7 + k * 3) % 11) - 5) / 5
            row[dt] = (px, px * 1.001)
        out[s] = row
    return out, dates


def resp(enter=0.9, risk=0.1, fam="momentum"):
    return {"model": jev.REVISION, "provider": jev.PROVIDER,
            "answers": {
                "enter": {"type": "noul", "noul": enter},
                "edge_family": {"type": "choice", "choice": fam,
                                "probabilities": {fam: 0.8}},
                "conviction": {"type": "score", "score": "strong"},
                "latent_risk": {"type": "noul", "noul": risk}},
            "usage": {"cost": 0.00001}}


def slurp(path, mode="rb"):
    with open(path, mode) as f:
        return f.read()


class Poster:
    """Fake provider; veto_alias -> low enter for those symbols."""

    def __init__(self, veto=()):
        self.veto, self.calls, self.bodies = set(veto), 0, []

    def __call__(self, body, key):
        self.calls += 1
        self.bodies.append(json.dumps(body))
        v = body["state"]["symbol"] in self.veto
        return resp(enter=0.2 if v else 0.9), None


class Twin(unittest.TestCase):
    def setUp(self):
        self.specs = S.sleeve_specs()
        syms = sorted({s for u, _, _ in self.specs.values() for s in u})
        self.prices, self.dates = synth(syms)
        self.fwd = self.dates[300]
        self._old = S.FORWARD_START
        S.FORWARD_START = self.fwd
        self.d = tempfile.mkdtemp()
        os.makedirs(os.path.join(self.d, "sleeves"))
        self.wall_t = [1000.0]
        # cache/spend are shared across tests; a fresh cache dir per test
        jev.CACHE_DIR = os.path.join(self.d, "cache")

    def tearDown(self):
        S.FORWARD_START = self._old

    def wall(self):
        self.wall_t[0] += 1.0
        return self.wall_t[0]

    def go(self, post, **kw):
        return T.run(self.d, NOW, "k", prices=self.prices, post_fn=post,
                     wall=self.wall, **kw)

    def base(self):
        u, fac, spec = self.specs[SID]
        rows = S.replay(SID, self.prices, fac, u)
        S._settle(self.d, SID, rows, spec, False, [], {})
        return rows

    def jr(self):
        return T.read_decisions(os.path.join(self.d, T.DECISIONS))[0]

    def twin_rows(self, sid=SID):
        return S.read_log(os.path.join(self.d, "sleeves", sid + "__jev.jsonl"))[0]

    def test_all_approve_twin_equals_base_and_schema_chain(self):
        b = self.base()
        p = Poster()
        bad, summ = self.go(p)
        self.assertEqual(bad, [])
        self.assertGreater(p.calls, 3)
        tw = self.twin_rows()
        self.assertEqual(len(tw), len(b))
        for x, y in zip(tw, b):
            self.assertEqual(x["date"], y["date"])
            self.assertAlmostEqual(x["equity"], y["equity"], places=4)
            self.assertEqual(set(x), set(y) | {"prev", "hash"})
            self.assertEqual(x["sleeve"], SID + "__jev")
        S.read_log(os.path.join(self.d, "sleeves", SID + "__jev.jsonl"))
        self.assertTrue(all(r["class"] == "approve" for r in self.jr()))

    def test_veto_drops_add_to_bil_everything_else_same(self):
        self.base()
        self.go(Poster())
        jr = self.jr()
        victim = jr[0]
        T_ = Poster(veto={victim["alias"]})
        d2 = tempfile.mkdtemp()
        jev.CACHE_DIR = os.path.join(d2, "cache")
        T.run(d2, NOW, "k", prices=self.prices, post_fn=T_, wall=self.wall)
        vj = [x for x in T.read_decisions(os.path.join(d2, T.DECISIONS))[0]
              if x["class"] == "veto"]
        self.assertTrue(vj)
        self.assertTrue(all(x["alias"] == victim["alias"] for x in vj))
        tw = S.read_log(os.path.join(d2, "sleeves", SID + "__jev.jsonl"))[0]
        by = {x["date"]: x for x in self.twin_rows()}
        v0 = vj[0]
        row = next(x for x in tw if x["date"] == v0["date"])
        self.assertNotIn(v0["symbol"], row["target"])
        self.assertGreater(row["target"].get("BIL", 0), 0)
        self.assertNotEqual(tw[-1]["equity"], self.twin_rows()[-1]["equity"])
        # before the first veto the two twins are identical
        for x in tw:
            if x["date"] <= v0["date"]:
                self.assertAlmostEqual(x["equity"], by[x["date"]]["equity"],
                                       places=4)

    def test_idempotent_no_reask_and_files_unchanged(self):
        self.base()
        p = Poster()
        self.go(p)
        n = p.calls
        a = slurp(os.path.join(self.d, T.DECISIONS))
        b = slurp(os.path.join(self.d, "sleeves", SID + "__jev.jsonl"))
        self.go(p)
        self.assertEqual(p.calls, n)
        self.assertEqual(a, slurp(os.path.join(self.d, T.DECISIONS)))
        self.assertEqual(b, slurp(os.path.join(self.d, "sleeves",
                                               SID + "__jev.jsonl")))
        bad, _ = self.go(p, verify=True)
        self.assertEqual(bad, [])

    def test_journal_before_use_and_resume_after_crash(self):
        self.base()
        calls = []

        def wall():
            if len(calls) >= 2:
                raise RuntimeError("crash")
            calls.append(1)
            return self.wall()
        with self.assertRaises(RuntimeError):
            T.run(self.d, NOW, "k", prices=self.prices, post_fn=Poster(),
                  wall=wall)
        self.assertEqual(len(self.jr()), 2)   # journaled, chain intact
        p = Poster()
        self.go(p)
        allr = self.jr()
        self.assertEqual(p.calls + 2, len(allr))
        self.assertEqual(len({r["cid"] for r in allr}), len(allr))

    def test_provider_failure_pending_never_journaled_twin_truncated(self):
        self.base()
        bad_post = lambda body, key: (None, "http-500")
        self.go(bad_post)
        self.assertEqual(self.jr(), [])
        tw = self.twin_rows()
        self.assertLessEqual(len(tw), 2)   # nothing beyond first pending date
        self.assertLessEqual(tw[-1]["date"], self.dates[301])
        self.go(Poster())
        self.assertGreater(len(self.twin_rows()), 100)
        self.assertGreater(len(self.jr()), 3)

    def test_record_fields_and_pre_outcome_flag(self):
        self.go(Poster())
        for r in self.jr():
            self.assertEqual(r["model"], jev.MODEL)
            self.assertEqual(r["revision"], jev.REVISION)
            self.assertEqual(len(r["ctx_hash"]), 64)
            self.assertIn("answers", r)
            self.assertIn(r["verdict"], ("PASS_BASE", "HOLD",
                                         "PASS_ELEVATED_ELIGIBLE"))
            self.assertIsInstance(r["decided_at"], float)
            self.assertEqual(r["pre_outcome"], r["sessions_after"] == 0)
        self.assertTrue(any(not r["pre_outcome"] for r in self.jr()))

    def test_anonymised_prompts(self):
        p = Poster()
        self.go(p)
        names = set(self.prices) | {SID, "trend", "sector", "core_passive",
                                    "sector_mom_v1"}
        blob = " ".join(p.bodies)
        for n in names:
            if n == "BIL":
                continue
            self.assertNotIn('"%s"' % n, blob)
            self.assertNotIn("_" + n, blob) if "_" in n else None
        for r in self.jr():
            self.assertNotEqual(r["alias"], r["symbol"])

    def test_family_mismatch_is_veto_and_bad_artifact_is_invalid(self):
        self.base()
        fam = lambda body, key: (resp(fam="macro"), None)
        self.go(fam)
        self.assertTrue(all(r["class"] == "veto" and r["reason"] ==
                            "family_binding" for r in self.jr()))
        self.assertEqual(T.classify("HOLD", "unauthenticated"), "invalid")
        self.assertEqual(T.classify("PASS_BASE", "lean"), "approve")

    def test_tamper_detected_in_decisions(self):
        self.go(Poster())
        path = os.path.join(self.d, T.DECISIONS)
        lines = slurp(path, "r").splitlines()
        rec = json.loads(lines[1])
        rec["verdict"] = "PASS_BASE" if rec["verdict"] == "HOLD" else "HOLD"
        lines[1] = json.dumps(rec, sort_keys=True)
        with open(path, "w") as f:
            f.write("\n".join(lines) + "\n")
        with self.assertRaises(ValueError):
            T.read_decisions(path)

    def test_twin_targets_semantics(self):
        tg = [("d1", {"A": 0.5, "BIL": 0.5}), ("d2", {"A": 0.5, "B": 0.5}),
              ("d3", {"A": 0.6, "B": 0.4})]
        out = T.twin_targets(tg, {("d1", "A"), ("d3", "A")})
        self.assertEqual(out["d1"], {"BIL": 1.0})
        self.assertEqual(out["d2"], {"A": 0.5, "B": 0.5})
        self.assertAlmostEqual(out["d3"]["A"], 0.5)
        self.assertAlmostEqual(out["d3"]["BIL"], 0.1)
        self.assertEqual(T.target_changes(tg, "d2"),
                         [("d2", "B", 0.0, 0.5), ("d3", "A", 0.5, 0.6)])

    def test_report(self):
        self.base()
        self.go(Poster(veto=set()))
        rep = T.report(self.d, self.prices, reps=200)
        p = rep["paired"][SID]
        self.assertEqual(p["mean"], 0.0)   # no vetoes: identical ledgers
        self.assertEqual(rep["decisions"]["counts"]["veto"], 0)
        # now a run with vetoes in a fresh dir
        d2 = tempfile.mkdtemp()
        jev.CACHE_DIR = os.path.join(d2, "cache")
        alias = self.jr()[0]["alias"]
        T.run(d2, NOW, "k", prices=self.prices, post_fn=Poster({alias}),
              wall=self.wall)
        S._settle(d2, SID, S.replay(SID, self.prices, *self.specs[SID][1:2],
                                    self.specs[SID][0]), "s", False, [], {})
        rep = T.report(d2, self.prices, reps=200)
        self.assertGreater(rep["decisions"]["counts"]["veto"], 0)
        self.assertIsNotNone(rep["paired"][SID]["ci_lo"])
        self.assertIn("approve_minus_veto", rep["decisions"])
        self.assertIsNone(T.realized(self.prices, "VTI", self.dates[-1]))
        self.assertIsNotNone(T.realized(self.prices, "VTI", self.dates[10]))

    def test_no_key_does_nothing_exit_zero(self):
        old = jev.api_key
        jev.api_key = lambda: ""
        try:
            called = []
            rc = T.main(["x", self.d], now=NOW,
                        post_fn=lambda *a: called.append(1))
        finally:
            jev.api_key = old
        self.assertEqual(rc, 0)
        self.assertEqual(called, [])
        self.assertFalse(os.path.exists(os.path.join(self.d, "jev_twin")))
        bad, summ = T.run(self.d, NOW, "", prices=self.prices)
        self.assertEqual((bad, summ), ([], {}))


if __name__ == "__main__":
    unittest.main()
