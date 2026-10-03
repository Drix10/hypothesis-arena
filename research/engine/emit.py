"""Atomic bundle writer.

One emit writes one complete bundle: unique temp + fsync + atomic
rename, plus a manifest row appended under the inter-process manifest
lock.
- The final filename appears only after os.replace() of a fully synced
  unique temp file in the same directory, so a crash never exposes half
  a bundle.
- The bundle_id check and the manifest append hold the same lock, so
  concurrent same-bundle emits converge to one row.
- latest_complete() returns the newest verified generation, scanning
  manifest order newest-first ("latest" = highest (research_epoch,
  manifest sequence)); a corrupt generation falls back to the prior one.
- read_latest() stages the exact verified bytes into a private snapshot
  and consumes that, so a filesystem swap after verification cannot
  change what the reader sees.
- bundle_id derives from (epoch, content sha); an identical re-emit
  rewrites the same file and skips the manifest row.
"""
import hashlib
import json
import os
import re
import tempfile

from . import locks
from . import schema

MANIFEST_NAME = "manifest.jsonl"
# Readers materialize only the tail (newest generations win); the writer
# rotates past MANIFEST_MAX_BYTES, keeping the newest half line-aligned.
MANIFEST_TAIL_BYTES = 1 << 20
MANIFEST_TAIL_ROWS = 4096
MANIFEST_MAX_BYTES = 1 << 20
_BID_RE = re.compile(r"rp-(\d+)-[0-9a-f]{64}")
_SHA_RE = re.compile(r"[0-9a-f]{64}")


def emit_bundle(outdir, epoch, features, watermarks, history=None):
    """Write one complete committed bundle. Returns (bundle_id, path).
    At most schema.MAX_FEATURES+1 items are drawn from `features`; more
    than MAX_FEATURES raises rather than truncating."""
    import itertools
    os.makedirs(outdir, exist_ok=True)
    if isinstance(features, (list, tuple)):
        feats = list(features)
    else:
        feats = list(itertools.islice(iter(features),
                                      schema.MAX_FEATURES + 1))
    if len(feats) > schema.MAX_FEATURES:
        raise ValueError("emit_bundle over cap: %d" % len(feats))
    # identity covers epoch, features, watermarks and history: a re-emit with
    # new watermarks must be a different bundle, else the manifest keeps the
    # old SHA and latest_complete() fails verification
    identity = {"epoch": epoch, "features": feats,
                "watermarks": dict(watermarks),
                "history": dict(history) if history is not None else None}
    content_sha = hashlib.sha256(schema.canon(identity)).hexdigest()
    bundle_id = schema.make_bundle_id(epoch, content_sha)
    bundle = schema.build_bundle(epoch, bundle_id, feats, watermarks,
                                 history)
    raw = schema.canon(bundle)
    final_name = "features-%d-%s.json" % (epoch, bundle_id)
    locks.atomic_write_bytes(outdir, final_name, raw)
    final = os.path.join(outdir, final_name)
    manifest = os.path.join(outdir, MANIFEST_NAME)
    row = {"bundle_id": bundle_id, "research_epoch": epoch,
           "feature_count": len(feats),
           "entity_map_sha256": watermarks.get("entity_map_sha256"),
           "commit": True, "path": os.path.basename(final),
           "sha256": hashlib.sha256(raw).hexdigest()}
    # check + append + rotate under one inter-process lock
    with locks.FileLock(manifest + ".lock", purpose="manifest"):
        if not _manifest_has_locked(manifest, bundle_id):
            with open(manifest, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            locks.fsync_dir(outdir)
        _rotate_manifest_locked(manifest)
    return bundle_id, final


def _manifest_has_locked(manifest, bundle_id):
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


def _valid_row(row):
    """Strict manifest-row check: bundle-ID format (epoch matching the
    row), SHA-256 formats, int epoch/feature-count, pinned entity-map
    hash, and the filename features-{epoch}-{bundle_id}.json. Failing
    rows are skipped; _verify_semantics checks the envelope."""
    if not isinstance(row, dict):
        return False
    if row.get("commit") is not True:
        return False
    bid = row.get("bundle_id")
    if not isinstance(bid, str):
        return False
    m = _BID_RE.fullmatch(bid)
    if m is None:
        return False
    sha = row.get("sha256")
    if not isinstance(sha, str) or _SHA_RE.fullmatch(sha) is None:
        return False
    epoch = row.get("research_epoch")
    if type(epoch) is not int or epoch < 0:
        return False
    if int(m.group(1)) != epoch:
        return False
    fc = row.get("feature_count")
    if type(fc) is not int or fc < 0:
        return False
    msha = row.get("entity_map_sha256")
    if not isinstance(msha, str) or _SHA_RE.fullmatch(msha) is None:
        return False
    if row.get("path") != "features-%d-%s.json" % (epoch, bid):
        return False
    return True


def _rotate_manifest_locked(manifest):
    """Rewrite the manifest keeping the newest half, line-aligned, once it
    exceeds MANIFEST_MAX_BYTES. Call with the manifest lock held."""
    try:
        size = os.path.getsize(manifest)
    except OSError:
        return
    if size <= MANIFEST_MAX_BYTES:
        return
    try:
        with open(manifest, "rb") as fh:
            fh.seek(max(0, size - (MANIFEST_MAX_BYTES // 2)))
            fh.readline()  # drop the partial first line
            tail = fh.read()
    except OSError:
        return
    if not tail:
        return
    d = os.path.dirname(os.path.abspath(manifest))
    fd, tmp = tempfile.mkstemp(dir=d, prefix="manifest.",
                               suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(tail)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, manifest)
        locks.fsync_dir(d)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _manifest_rows(outdir):
    """Newest manifest rows with relative sequence numbers, read from the
    bounded tail only. Malformed rows are skipped."""
    manifest = os.path.join(outdir, MANIFEST_NAME)
    try:
        size = os.path.getsize(manifest)
    except OSError:
        return []
    try:
        with open(manifest, "rb") as fh:
            if size > MANIFEST_TAIL_BYTES:
                fh.seek(size - MANIFEST_TAIL_BYTES)
                fh.readline()  # drop the partial first line
            chunk = fh.read(MANIFEST_TAIL_BYTES + 4096)
    except OSError:
        return []
    lines = chunk.decode("utf-8", "replace").split("\n")
    if len(lines) > MANIFEST_TAIL_ROWS:
        lines = lines[-MANIFEST_TAIL_ROWS:]
    rows = []
    for seq, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if _valid_row(row):
            rows.append((seq, row))
    return rows


def _verify_row(root, base, expected_sha):
    """Containment + hash verification. Returns the file bytes on success,
    else None; callers consume these bytes, not a re-opened path."""
    if not base or base.startswith(".") or "/" in base or "\\" in base:
        return None
    cand = os.path.join(root, os.path.basename(base))
    if os.path.islink(cand):
        return None
    if os.path.realpath(cand) != os.path.join(root,
                                              os.path.basename(base)):
        return None
    if os.path.dirname(os.path.realpath(cand)) != root:
        return None
    try:
        with open(cand, "rb") as fh:
            data = fh.read()
    except OSError:
        return None
    if hashlib.sha256(data).hexdigest() != expected_sha:
        return None
    return data


def latest_complete(outdir):
    """Path of the newest VERIFIED manifest-committed bundle.

    Scans newest-first by (research_epoch, manifest sequence) and returns
    the first generation whose file matches its sha256 and whose envelope
    (bundle_id/epoch/schema/commit) matches the row; None if none verifies.

    The path is for inspection only. Consume bundles through
    read_latest(), since the file can change after this returns.
    """
    root = os.path.realpath(outdir)
    rows = _manifest_rows(outdir)
    # newest first: highest epoch, then latest manifest sequence. Duplicate
    # bundle_ids are not pre-filtered so a corrupt row cannot shadow a valid one.
    rows.sort(key=lambda sr: (sr[1].get("research_epoch", -1), sr[0]),
              reverse=True)
    seen = set()
    for _seq, row in rows:
        bid = row.get("bundle_id")
        if bid in seen:
            continue
        data = _verify_row(root, row.get("path"), row.get("sha256"))
        if data is not None and _verify_semantics(data, row):
            seen.add(bid)
            return os.path.join(root, os.path.basename(row["path"]))
    return None


def committed_histories(outdir):
    """(bundle_id, history) of verified manifest-committed generations,
    newest first. Each needs a manifest row and the same SHA + envelope
    checks as latest_complete; orphan or mismatched files are ignored."""
    root = os.path.realpath(outdir)
    rows = _manifest_rows(outdir)
    rows.sort(key=lambda sr: (sr[1].get("research_epoch", -1), sr[0]),
              reverse=True)
    seen = set()
    out = []
    for _seq, row in rows:
        bid = row.get("bundle_id")
        if bid in seen:
            continue
        data = _verify_row(root, row.get("path"), row.get("sha256"))
        if data is None or not _verify_semantics(data, row):
            continue
        seen.add(bid)
        try:
            env = json.loads(data.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if not isinstance(env, dict):
            continue
        hist = env.get("history")
        if isinstance(hist, dict):
            out.append((bid, hist))
    return out


BUNDLE_SEMANTIC_MAX_BYTES = 4 << 20


def _verify_semantics(data, row):
    """Check the envelope parses (bounded) and its bundle_id, research_epoch,
    schema_version and commit match the manifest row."""
    if len(data) > BUNDLE_SEMANTIC_MAX_BYTES:
        return False
    try:
        env = json.loads(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return False
    if not isinstance(env, dict):
        return False
    return (env.get("bundle_id") == row.get("bundle_id") and
            type(env.get("research_epoch")) is int and
            env.get("research_epoch") == row.get("research_epoch")
            and env.get("schema_version") == "f2" and
            env.get("commit") is True)


def _stage_snapshot(data):
    """Write verified bytes to a private 0600 temp file; the caller
    consumes then unlinks it."""
    fd, path = tempfile.mkstemp(prefix="bundle-snap-", suffix=".json")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
    except BaseException:
        try:
            os.unlink(path)
        except OSError:
            pass
        raise
    return path


def read_latest(outdir, db_path, map_path, now_ts):
    """Manifest -> newest verified generation -> fixed ctx reader, over a
    private snapshot of the verified bytes. Returns the read_bundle()
    result dict, or None when no complete bundle exists."""
    # Local import: collector/ lives at repo root, not beside the plane.
    from collector import ctx_read
    root = os.path.realpath(outdir)
    rows = _manifest_rows(outdir)
    rows.sort(key=lambda sr: (sr[1].get("research_epoch", -1), sr[0]),
              reverse=True)
    seen = set()
    for _seq, row in rows:
        bid = row.get("bundle_id")
        if bid in seen:
            continue
        data = _verify_row(root, row.get("path"), row.get("sha256"))
        if data is None or not _verify_semantics(data, row):
            continue
        seen.add(bid)
        snap = _stage_snapshot(data)
        try:
            try:
                return ctx_read.read_bundle(snap, db_path, map_path,
                                            now_ts)
            except Exception:
                # a bad generation falls back to the older verified one
                continue
        finally:
            try:
                os.unlink(snap)
            except OSError:
                pass
    return None
