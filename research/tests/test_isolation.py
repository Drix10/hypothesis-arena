"""D6 isolation proof (doc 08 sec. 8.6, boundary-model level).

What this proves on ANY host (no daemon, no root needed):
1. The writer confines every byte it creates to the supervisor-owned
   output directory: filenames are internally generated
   (features-<epoch>-<hex>), never derived from untrusted input, so no
   bundle content can redirect a write to journal/HALT/STAGE/creds.
2. The worker import gate rejects every non-allowlisted import (tested
   in test_plane.py): generated code cannot import subprocess/socket/
   os/pickle even before the container firewall sees it.
3. The manifest/reader chain never follows a path outside outdir
   (basenames only).

What remains a LINUX DEPLOYMENT box (explicit, not assumed):
4. OS users (setup-identities.sh) + the setpriv isolation run.
5. Docker egress-proxy probe (non-allowlisted destination dies at the
   proxy, counted) + image-digest pin + SBOM/vuln scan.
Run: python3 tests/test_isolation.py --tree <dir>
"""
import argparse
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from plane import emit as emit_mod
from plane import schema


class ConfinementTest(unittest.TestCase):
    def test_all_writes_stay_in_outdir(self):
        d = tempfile.mkdtemp()
        outdir = os.path.join(d, "owned")
        before = set()
        for root, _, files in os.walk(d):
            before |= {os.path.join(root, f) for f in files}
        feats = [schema.build_feature(
            "filing_event", ["AAPL"], {"type": "enum", "v": "x"},
            "unknown", "inference", "low", "edgar_8k", "a" * 64,
            100, 100, 60, feature_id="evil-../../-attempt")]
        wm = {"entity_map_version": "v", "entity_map_sha256": "s",
              "sources": {}}
        emit_mod.emit_bundle(outdir, 1, feats, wm)
        after = set()
        for root, _, files in os.walk(d):
            after |= {os.path.join(root, f) for f in files}
        new = after - before
        self.assertTrue(new)
        for p in new:
            self.assertTrue(os.path.abspath(p).startswith(
                os.path.abspath(outdir) + os.sep), p)

    def test_manifest_never_escapes(self):
        d = tempfile.mkdtemp()
        outdir = os.path.join(d, "o")
        os.makedirs(outdir)
        # A manifest row pointing outside (tampered/crashed state) is
        # never followed: latest_complete only resolves basenames inside.
        with open(os.path.join(outdir, "manifest.jsonl"), "w") as fh:
            fh.write(json.dumps(
                {"bundle_id": "evil", "commit": True,
                 "path": "../outside.json", "sha256": "0" * 64}) + "\n")
        self.assertIsNone(emit_mod.latest_complete(outdir))

    def test_missing_file_falls_back(self):
        d = tempfile.mkdtemp()
        outdir = os.path.join(d, "o")
        os.makedirs(outdir)
        with open(os.path.join(outdir, "manifest.jsonl"), "w") as fh:
            fh.write(json.dumps(
                {"bundle_id": "gone", "commit": True,
                 "path": "features-1-gone.json", "sha256": "0" * 64}) + "\n")
        self.assertIsNone(emit_mod.latest_complete(outdir))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--tree", default=None)
    args, rest = parser.parse_known_args()
    if args.tree:
        # Deployment-mode self-check: the CURRENT user must not be able
        # to write the protected paths (run under miroresearch via
        # setpriv; success = PermissionError on each).
        protected = ["journal", "stage", "creds/broker", "creds/jev"]
        denied = 0
        for rel in protected:
            p = os.path.join(args.tree, rel, ".probe")
            try:
                with open(p, "w") as fh:
                    fh.write("x")
                os.remove(p)
                print("ISOLATION FAIL: writable: %s" % rel)
            except (PermissionError, OSError):
                denied += 1
        print("isolation: %d/%d protected paths denied" % (denied,
                                                           len(protected)))
        sys.exit(0 if denied == len(protected) else 1)
    unittest.main(argv=[sys.argv[0]] + rest)
