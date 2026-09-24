"""Seam->real-graph wiring tests: production Runner binds the owned
seam into build_graph deps; real run_cycle harvest reaches adapters.

Runs in the plane job (pinned venv, langgraph) — NOT the stdlib
evidence job. Run locally with the research-plane .venv python.
"""
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

try:
    import test_plane as T
    import test_source_seam as SEAM_T
except ImportError:  # unittest module-style invocation
    from tests import test_plane as T
    from tests import test_source_seam as SEAM_T
from plane import runner


class TestSeamGraph(unittest.TestCase):
    def _runner(self, d, clock=None):
        clock = clock or SEAM_T.FakeClock()
        lineage_db = os.path.join(tempfile.mkdtemp(), "lineage.db")
        gt = T.GraphTest()
        deps, _c, _log, _led, _gov = gt._deps(d)
        deps.pop("harvest", None)
        seam_kwargs = {
            "env": {},
            "clock": clock.now,
            "sleeper": clock.sleep,
            "mono": clock.mono,
            "transports": SEAM_T.make_transports(),
            "contact": "seam-graph-test@example.invalid",
            "fred_key": "K-TEST",
            "bea_id": "B-TEST",
            "lineage_db_path": lineage_db,
        }
        return runner.build_runner(deps, seam_kwargs), clock

    def test_real_cycle_reaches_seam(self):
        d = tempfile.mkdtemp()
        r, _clock = self._runner(d)
        out = r.run(["AAPL", "SPY"], 3, "seamg1")
        self.assertFalse(out.get("aborted"), out.get("blocked"))
        raw = out.get("raw") or []
        srcs = {rec.get("source_id") for rec in raw
                if isinstance(rec, dict)}
        # All five owned adapters served the real harvest node.
        for sid in ("edgar_8k", "fred_macro", "treasury_auctions",
                    "bls_empsit", "bea_nipa_gdp"):
            self.assertIn(sid, srcs, sid)
            self.assertIn(sid, out.get("stamps", {}), sid)
            self.assertTrue(out["stamps"][sid]["ok"],
                            (sid, out["stamps"][sid]))
        self.assertIn("treasury_auctions", out.get("history", {}))

    def test_runner_shares_seam_across_cycles(self):
        d = tempfile.mkdtemp()
        r, _clock = self._runner(d)
        r.run(["AAPL"], 3, "seamg2a")
        polls1 = [s.adapter.polls for s in r.seam.sources]
        self.assertTrue(all(p >= 1 for p in polls1))
        out = r.run(["AAPL"], 4, "seamg2b")
        self.assertFalse(out.get("aborted"))
        polls2 = [s.adapter.polls for s in r.seam.sources]
        # One Runner owns one adapter per source for life: no
        # per-cycle reconstruction, pacing/dedupe state shared.
        self.assertEqual(polls2, [p + 1 for p in polls1])
        self.assertIs(r.seam, r.seam)


if __name__ == "__main__":
    unittest.main()
