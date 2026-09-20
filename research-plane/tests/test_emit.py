"""Phase 2.5 plane tests: emit (D3) + resolver (D4).

Every emitted bundle round-trips through the FROZEN reader
(collector/ctx_read.read_bundle) against a scratch canonical.db +
pinned entity map. The reader is the single source of truth for
validity; these tests never re-implement its checks.
"""
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, ".."))  # repo root: collector/
sys.path.insert(0, ROOT)  # research-plane/: plane/

from collector import ctx_read
from plane import emit as emit_mod
from plane import resolver, schema

# Fixed Monday 2026-01-05 15:00 UTC = 10:00 America/New_York (in session).
OBS_S = 1767625200
OBS_NS = OBS_S * 10 ** 9
NOW_S = OBS_S + 100
HEXA = "a" * 64
MAP = {"map_version": "entity-v1-test",
       "cik_to_ticker": {"0000320193": "AAPL"},
       "macro_release_to_symbols": {"FOMC": ["EURUSD"]}}


def write_map(d):
    raw = json.dumps(MAP, sort_keys=True).encode()
    p = os.path.join(d, "entity_map.json")
    with open(p, "wb") as fh:
        fh.write(raw)
    return p, hashlib.sha256(raw).hexdigest()


def write_db(d, content_hash=HEXA, source="edgar_8k"):
    p = os.path.join(d, "canonical.db")
    con = sqlite3.connect(p)
    con.execute("CREATE TABLE records (content_hash TEXT, source TEXT)")
    con.execute("INSERT INTO records VALUES (?, ?)", (content_hash, source))
    con.commit()
    con.close()
    return p


def watermarks(map_sha, sources=("edgar_8k",)):
    return {"entity_map_version": MAP["map_version"],
            "entity_map_sha256": map_sha,
            "sources": {s: {"last_observation_at": OBS_S,
                            "cursor": "test-cursor-1"} for s in sources}}


def canonical(source_id="edgar_8k", **kw):
    rec = {"source_id": source_id, "kind": "filing_event",
           "content_hash": HEXA,
           "published_ns": OBS_NS, "ingested_ns": OBS_NS,
           "symbols": ["AAPL"],
           "value": {"type": "enum", "v": "8-K:item-2.02"},
           "effect": "bullish", "corroborated": True}
    rec.update(kw)
    return rec


def candidate(**kw):
    c = {"kind": "filing_event", "symbols": ["AAPL"],
         "value": {"type": "enum", "v": "8-K:item-2.02"},
         "effect": "bullish", "feature_id": "f1",
         "provenance_url": "https://example.invalid/x"}
    c.update(kw)
    return c


class EmitTest(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.mapp, self.msha = write_map(self.d)
        self.dbp = write_db(self.d)

    def emit_ok(self, feats, history=None, wm=None):
        bid, path = emit_mod.emit_bundle(
            os.path.join(self.d, "out"), 412, feats,
            wm or watermarks(self.msha), history)
        return bid, path

    def test_roundtrip_source(self):
        ok, out = resolver.resolve(candidate(), canonical(), MAP)
        self.assertTrue(ok)
        feat, capped = out
        self.assertFalse(capped)
        self.assertEqual(feat["evidence"], "source")
        bid, path = self.emit_ok([feat])
        res = ctx_read.read_bundle(path, self.dbp, self.mapp, NOW_S)
        for k in ("accepted", "rejected"):
            self.assertEqual(res["stats"][k], 1 if k == "accepted" else 0)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_roundtrip_inference_capped(self):
        ok, out = resolver.resolve(candidate(effect="bearish"),
                                   canonical(), MAP)
        self.assertTrue(ok)
        feat, _ = out
        self.assertEqual(feat["evidence"], "inference")
        _, path = self.emit_ok([feat])
        res = ctx_read.read_bundle(path, self.dbp, self.mapp, NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"inference-capped": 1})

    def test_resolver_rejects_unmapped(self):
        ok, reason = resolver.resolve(candidate(symbols=["ZZZZ"]),
                                      canonical(), MAP)
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("entity-unmapped"))

    def test_resolver_contradiction(self):
        ok, reason = resolver.resolve(
            candidate(entity_ref={"cik": "0000320193"}, symbols=["AAPL"]),
            canonical(), MAP)
        self.assertTrue(ok)  # consistent ref passes
        ok, reason = resolver.resolve(
            {"kind": "filing_event", "symbols": ["AAPL"],
             "value": {"type": "enum", "v": "x"}, "effect": "bullish",
             "entity_ref": {"cik": "0000999999"}},
            canonical(), {"cik_to_ticker": {"0000320193": "AAPL",
                                            "0000999999": "ZZZZ"},
                          "macro_release_to_symbols": {}})
        self.assertFalse(ok)
        self.assertEqual(reason, "contradiction")

    def test_resolver_no_published_ts_caps(self):
        ok, out = resolver.resolve(candidate(), canonical(published_ns=None),
                                   MAP)
        self.assertTrue(ok)
        feat, capped = out
        self.assertTrue(capped)
        self.assertEqual(feat["evidence"], "inference")  # not identical

    def test_resolver_confidence_computed(self):
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP)
        self.assertEqual(feat["confidence_bucket"], "high")
        ok, (feat2, _) = resolver.resolve(
            candidate(), canonical(corroborated=False), MAP)
        self.assertEqual(feat2["confidence_bucket"], "medium")

    def test_latest_complete_none_when_empty(self):
        self.assertIsNone(emit_mod.latest_complete(
            os.path.join(self.d, "empty")))

    def test_idempotent_reemit(self):
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP)
        outdir = os.path.join(self.d, "out2")
        b1, p1 = emit_mod.emit_bundle(outdir, 7, [feat],
                                      watermarks(self.msha))
        b2, p2 = emit_mod.emit_bundle(outdir, 7, [feat],
                                      watermarks(self.msha))
        self.assertEqual((b1, p1), (b2, p2))
        man = open(os.path.join(outdir, "manifest.jsonl")).read().strip()
        self.assertEqual(len(man.splitlines()), 1)

    def test_partial_never_visible(self):
        # A crashed emit leaves only .tmp debris: latest_complete is None
        # and the reader never sees a half bundle.
        outdir = os.path.join(self.d, "out3")
        os.makedirs(outdir)
        with open(os.path.join(outdir, "features-9-x.json.tmp-1"), "wb") as fh:
            fh.write(b'{"half": true')
        self.assertIsNone(emit_mod.latest_complete(outdir))

    def test_kind_relabel_never_source(self):
        # fed source emits two kinds: relabeling macro_release as
        # calendar_ahead with identical fields must not earn source.
        can = canonical(source_id="fed_monetary", kind="macro_release",
                        symbols=["EURUSD"],
                        value={"type": "enum", "v": "hike-25"},
                        effect="risk_up", content_hash="b" * 64)
        cand = {"kind": "calendar_ahead", "symbols": ["EURUSD"],
                "value": {"type": "enum", "v": "hike-25"},
                "effect": "risk_up", "feature_id": "k1"}
        fmap = {"cik_to_ticker": {},
                "macro_release_to_symbols": {"FOMC": ["EURUSD"]}}
        ok, out = resolver.resolve(cand, can, fmap)
        self.assertTrue(ok)
        self.assertEqual(out[0]["evidence"], "inference")

    def test_changed_watermarks_new_identity(self):
        # Same epoch + same features, new cursor: different bundle_id,
        # both manifest rows, latest resolves to the NEWER bytes.
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP)
        self.assertTrue(ok)
        outdir = os.path.join(self.d, "outW")
        b1, p1 = emit_mod.emit_bundle(outdir, 5, [feat],
                                      watermarks(self.msha))
        wm2 = watermarks(self.msha)
        wm2["sources"]["edgar_8k"] = {"last_observation_at": OBS_S + 10,
                                        "cursor": "test-cursor-2"}
        b2, p2 = emit_mod.emit_bundle(outdir, 5, [feat], wm2)
        self.assertNotEqual(b1, b2)
        self.assertNotEqual(p1, p2)
        self.assertEqual(emit_mod.latest_complete(outdir), p2)
        res = emit_mod.read_latest(outdir, self.dbp, self.mapp, NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_symlink_entry_rejected(self):
        # In-tree symlink to an outside file: never followed.
        outdir = os.path.join(self.d, "outS")
        os.makedirs(outdir)
        outside = os.path.join(self.d, "secret.json")
        with open(outside, "w") as fh:
            fh.write('{"x": 1}')
        link = os.path.join(outdir, "features-1-evil.json")
        try:
            os.symlink(outside, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        with open(os.path.join(outdir, "manifest.jsonl"), "w") as fh:
            fh.write('{"bundle_id": "evil", "commit": true, '
                     '"path": "features-1-evil.json", '
                     '"sha256": "' + "0" * 64 + '"}\n')
        self.assertIsNone(emit_mod.latest_complete(outdir))

    def test_r12_future_dropped_by_ctx(self):
        # D7 integration proof: a future-dated feature travels the real
        # writer -> real frozen reader path and is dropped there.
        fut = (NOW_S + 3600) * 10 ** 9
        feat = schema.build_feature(
            "filing_event", ["AAPL"],
            {"type": "enum", "v": "8-K:item-2.02"}, "bullish",
            "source", "high", "edgar_8k", HEXA, fut, fut, 3600,
            feature_id="fut1", hashes=[HEXA])
        _, path = self.emit_ok([feat])
        res = ctx_read.read_bundle(path, self.dbp, self.mapp, NOW_S)
        self.assertEqual(res["stats"]["accepted"], 0)
        self.assertEqual(res["stats"]["reasons"],
                         {"future-timestamp": 1})


if __name__ == "__main__":
    unittest.main()
