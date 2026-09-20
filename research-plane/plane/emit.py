"""D3 atomic bundle writer (doc 08 sec. 8.5, stdlib only).

One emit writes one complete bundle: temp file + fsync + atomic rename,
plus an fsynced manifest row. Crash-safe guarantees:
- A partial emit + crash + restart can never expose half a bundle: the
  final filename appears only after os.replace() of a fully-synced temp
  file in the same directory.
- The manifest is append-only JSONL; readers accept only rows with
  commit=true whose file exists with matching sha256.
- Idempotent re-emit: bundle_id derives from (epoch, content sha); an
  identical re-emit rewrites the same filename and skips the manifest
  row if the bundle_id is already present (resume never duplicates).
"""
import hashlib
import json
import os

from . import schema

MANIFEST_NAME = "manifest.jsonl"


def _fsync_file(fh):
    fh.flush()
    os.fsync(fh.fileno())


def _fsync_dir(dirpath):
    # Directory fsync is unavailable on Windows (PermissionError); the
    # crash guarantee there rests on file fsync + atomic os.replace.
    # Best-effort elsewhere: failure must never fail an emit.
    if os.name == "nt":
        return
    try:
        fd = os.open(dirpath, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def emit_bundle(outdir, epoch, features, watermarks, history=None):
    """Write one complete committed bundle. Returns (bundle_id, path)."""
    os.makedirs(outdir, exist_ok=True)
    feats = list(features)
    payload = {"epoch": epoch, "n": len(feats),
               "sha": hashlib.sha256(
                   schema.canon(feats)).hexdigest()}
    content_sha = hashlib.sha256(schema.canon(payload)).hexdigest()
    bundle_id = schema.make_bundle_id(epoch, content_sha)
    bundle = schema.build_bundle(epoch, bundle_id, feats, watermarks,
                                 history)
    raw = schema.canon(bundle)
    final = os.path.join(outdir, "features-%d-%s.json" % (epoch, bundle_id))
    tmp = final + ".tmp-%d" % os.getpid()
    with open(tmp, "wb") as fh:
        fh.write(raw)
        _fsync_file(fh)
    os.replace(tmp, final)
    _fsync_dir(outdir)
    manifest = os.path.join(outdir, MANIFEST_NAME)
    row = {"bundle_id": bundle_id, "research_epoch": epoch,
           "feature_count": len(feats),
           "entity_map_sha256": watermarks.get("entity_map_sha256"),
           "commit": True, "path": os.path.basename(final),
           "sha256": hashlib.sha256(raw).hexdigest()}
    if not _manifest_has(manifest, bundle_id):
        with open(manifest, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, sort_keys=True) + "\n")
            _fsync_file(fh)
        _fsync_dir(outdir)
    return bundle_id, final


def _manifest_has(manifest, bundle_id):
    try:
        with open(manifest, encoding="utf-8") as fh:
            for line in fh:
                try:
                    if json.loads(line).get("bundle_id") == bundle_id:
                        return True
                except ValueError:
                    continue
    except OSError:
        pass
    return False


def latest_complete(outdir):
    """Path of the last manifest-committed bundle whose file verifies.

    Returns None when no complete verifiable bundle exists (a runaway-
    aborted cycle that never reached emit publishes nothing).
    """
    manifest = os.path.join(outdir, MANIFEST_NAME)
    last = None
    try:
        with open(manifest, encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("commit") is True:
                    last = row
    except OSError:
        return None
    if not last:
        return None
    path = os.path.join(outdir, os.path.basename(last.get("path", "")))
    try:
        with open(path, "rb") as fh:
            digest = hashlib.sha256(fh.read()).hexdigest()
    except OSError:
        return None
    if digest != last.get("sha256"):
        return None
    return path
