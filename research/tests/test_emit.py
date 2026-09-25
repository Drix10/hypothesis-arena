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
sys.path.insert(0, ROOT)  # research/: plane/

from collector import ctx_read
from plane import emit as emit_mod
from plane import publish, resolver, schema

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
           "effect": "bullish", "corroborated": True,
           "parser_confidence": "high"}
    rec.update(kw)
    return rec


def candidate(**kw):
    c = {"kind": "filing_event", "symbols": ["AAPL"],
         "value": {"type": "enum", "v": "8-K:item-2.02"},
         "effect": "bullish", "feature_id": "f1",
         "provenance_url": "https://example.invalid/x"}
    c.update(kw)
    return c


def _emit_same(args):
    outdir, epoch, feats, wm, hist = args
    return emit_mod.emit_bundle(outdir, epoch, feats, wm, hist)


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
        ok, out = resolver.resolve(candidate(), canonical(), MAP,
                         origin="parser")
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
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP,
                                         origin="parser")
        self.assertEqual(feat["confidence_bucket"], "high")
        ok, (feat2, _) = resolver.resolve(
            candidate(), canonical(corroborated=False), MAP)
        self.assertEqual(feat2["confidence_bucket"], "medium")

    def test_latest_complete_none_when_empty(self):
        self.assertIsNone(emit_mod.latest_complete(
            os.path.join(self.d, "empty")))

    def test_idempotent_reemit(self):
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP,
                                         origin="parser")
        outdir = os.path.join(self.d, "out2")
        b1, p1 = emit_mod.emit_bundle(outdir, 7, [feat],
                                      watermarks(self.msha))
        b2, p2 = emit_mod.emit_bundle(outdir, 7, [feat],
                                      watermarks(self.msha))
        self.assertEqual((b1, p1), (b2, p2))
        with open(os.path.join(outdir, "manifest.jsonl")) as _fh:
            man = _fh.read().strip()
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
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP,
                                         origin="parser")
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
        self.assertEqual(os.path.realpath(emit_mod.latest_complete(outdir)),
                         os.path.realpath(p2))
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

    def test_concurrent_same_bundle_emit_once(self):
        # Four processes, one bundle: exactly one manifest row, one id.
        import multiprocessing
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP,
                                         origin="parser")
        self.assertTrue(ok)
        outdir = os.path.join(self.d, "outC")
        wm = watermarks(self.msha)
        args = (outdir, 11, [feat], wm, None)
        ctx = multiprocessing.get_context("spawn")
        with ctx.Pool(4) as pool:
            got = pool.map(_emit_same, [args] * 4)
        self.assertEqual(len(set(g[0] for g in got)), 1)
        with open(os.path.join(outdir, "manifest.jsonl")) as _fh:
            rows = _fh.read().strip().splitlines()
        self.assertEqual(len(rows), 1)

    def test_corrupt_newest_falls_back(self):
        # good A, good B, then B's file is damaged: latest resolves B->A
        # instead of blacking out research.
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP,
                                         origin="parser")
        outdir = os.path.join(self.d, "outF")
        _, pa = emit_mod.emit_bundle(outdir, 1, [feat],
                                      watermarks(self.msha))
        _, pb = emit_mod.emit_bundle(outdir, 2, [feat],
                                      watermarks(self.msha))
        with open(pb, "wb") as fh:
            fh.write(b"damaged")
        self.assertEqual(os.path.realpath(emit_mod.latest_complete(outdir)),
                         os.path.realpath(pa))
        res = emit_mod.read_latest(outdir, self.dbp, self.mapp, NOW_S)
        self.assertIsNotNone(res)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_read_consumes_verified_snapshot(self):
        # The frozen reader consumes staged verified bytes: even if
        # every publication file is replaced between verification and
        # consumption, the result stands.
        ok, (feat, _) = resolver.resolve(candidate(), canonical(), MAP,
                                         origin="parser")
        outdir = os.path.join(self.d, "outT")
        emit_mod.emit_bundle(outdir, 3, [feat], watermarks(self.msha))
        real_read = ctx_read.read_bundle

        def _swap_then_read(path, db, mp, now):
            for name in os.listdir(outdir):
                if name.endswith(".json"):
                    with open(os.path.join(outdir, name), "wb") as fh:
                        fh.write(b"swapped")
            return real_read(path, db, mp, now)

        ctx_read.read_bundle = _swap_then_read
        try:
            res = emit_mod.read_latest(outdir, self.dbp, self.mapp,
                                       NOW_S)
        finally:
            ctx_read.read_bundle = real_read
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})

    def test_r12_future_dropped_by_ctx(self):
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

    def test_full_length_ids(self):
        ok, out = resolver.resolve(candidate(), canonical(), MAP,
                                   origin="parser")
        self.assertTrue(ok)
        feat, _capped = out
        res = publish.resolve_emit({
            "outdir": os.path.join(self.d, "out2"),
            "map_path": self.mapp,
            "canonical_for": lambda c: canonical(),
            "source_watermarks": lambda st: {
                "edgar_8k": {"last_observation_at": OBS_S,
                               "cursor": "g"}}},
            {"epoch": 412, "fused": [feat]})
        self.assertIsNotNone(res.get("emitted"))
        tail = res["emitted"].rsplit("-", 1)[-1]
        self.assertEqual(len(tail), 64)  # full sha, never 16
        with open(res["bundle_path"], encoding="utf-8") as _fh:
            env = json.loads(_fh.read())
        fid = env["features"][0]["feature_id"]
        self.assertTrue(fid.startswith("f-"))
        self.assertEqual(len(fid), 66)

    def test_strict_map_rejects(self):
        def _write(obj):
            p = os.path.join(self.d, "m%d.json" %
                             _write.n)
            _write.n += 1
            with open(p, "wb") as fh:
                fh.write(json.dumps(obj).encode())
            return p
        _write.n = 0
        bad_cik = dict(MAP)
        bad_cik["cik_to_ticker"] = {"ABC": "AAPL"}
        self.assertEqual(publish._load_map(_write(bad_cik))[1],
                         "map-cik-key")
        bad_ticker = dict(MAP)
        bad_ticker["cik_to_ticker"] = {"0000320193": "aapl"}
        self.assertEqual(publish._load_map(_write(bad_ticker))[1],
                         "map-cik-value")
        bad_keys = dict(MAP)
        bad_keys["evil"] = 1
        self.assertEqual(publish._load_map(_write(bad_keys))[1],
                         "map-keys")
        bad_macro = dict(MAP)
        bad_macro["macro_release_to_symbols"] = {"FOMC": "EURUSD"}
        self.assertEqual(publish._load_map(_write(bad_macro))[1],
                         "map-macro-value")
        bad_note = dict(MAP)
        bad_note["note"] = "n" * 1025
        self.assertEqual(publish._load_map(_write(bad_note))[1],
                         "map-note")
        info, err = publish._load_map(self.mapp)
        self.assertIsNone(err)
        self.assertEqual(info[0], self.msha)

    def test_semantic_invalid_bundle_skipped(self):
        ok, out = resolver.resolve(candidate(), canonical(), MAP,
                                   origin="parser")
        feat, _capped = out
        bid, good = self.emit_ok([feat])
        outdir = os.path.join(self.d, "out")
        # Evil generation: correct SHA in the manifest row, but the
        # envelope inside names a DIFFERENT bundle_id (and epoch).
        with open(good, encoding="utf-8") as _fh:
            env = json.loads(_fh.read())
        env["bundle_id"] = "rp-99-evil"
        evil_raw = json.dumps(env, sort_keys=True,
                              separators=(",", ":")).encode()
        with open(os.path.join(outdir, "features-99-evil.json"),
                  "wb") as fh:
            fh.write(evil_raw)
        with open(os.path.join(outdir, "manifest.jsonl"), "a",
                  encoding="utf-8") as fh:
            fh.write(json.dumps(
                {"bundle_id": "rp-99-row", "research_epoch": 99,
                 "feature_count": 1,
                 "entity_map_sha256": self.msha, "commit": True,
                 "path": "features-99-evil.json",
                 "sha256": hashlib.sha256(evil_raw).hexdigest()},
                sort_keys=True) + "\n")
        # Newest row is hash-valid but semantically void: the reader
        # falls back to the good generation instead of blessing it.
        self.assertEqual(emit_mod.latest_complete(outdir), good)
        res = emit_mod.read_latest(outdir, self.dbp, self.mapp, NOW_S)
        self.assertEqual(res["stats"]["reasons"], {"ok": 1})


if __name__ == "__main__":
    unittest.main()
