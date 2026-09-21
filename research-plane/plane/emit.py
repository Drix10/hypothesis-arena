"""D3 atomic bundle writer (doc 08 sec. 8.5, stdlib only).

One emit writes one complete bundle: unique temp + fsync + atomic
rename, plus a manifest row appended under the inter-process manifest
lock. Crash-safe guarantees:
- A partial emit + crash + restart can never expose half a bundle: the
  final filename appears only after os.replace() of a fully-synced
  UNIQUE temp file in the same directory (no pid-collision between
  threads/processes).
- Exactly-once manifest insertion: the check (bundle_id present?) and
  the append hold the SAME manifest lock, so concurrent processes can
  never both insert. Concurrent same-bundle emits converge to one row.
- latest_complete() resolves the NEWEST independently VERIFIED
  generation, scanning manifest order newest-first: one corrupt/missing
  generation falls back to the prior good one instead of blacking out
  research. "Latest" = highest (research_epoch, manifest sequence).
- TOCTOU: verification reads file bytes and hashes them; read_latest()
  stages those EXACT bytes into a private unique snapshot and consumes
  the snapshot, so a filesystem swap between verify and read cannot
  change what the frozen reader consumes. (Deployment still restricts
  publication-dir writes to the writer identity; the snapshot makes
  the primitive atomic regardless.)
- Idempotent re-emit: bundle_id derives from (epoch, content sha); an
  identical re-emit rewrites the same filename and skips the manifest
  row if the bundle_id is already present (resume never duplicates).
"""
import hashlib
import json
import os
import tempfile

from . import locks
from . import schema

MANIFEST_NAME = "manifest.jsonl"


def emit_bundle(outdir, epoch, features, watermarks, history=None):
    """Write one complete committed bundle. Returns (bundle_id, path)."""
    os.makedirs(outdir, exist_ok=True)
    feats = list(features)
    # Bundle identity covers EVERYTHING published: epoch, features,
    # watermarks, and history. Same features with different watermarks
    # (new cursor, new observation) are a DIFFERENT bundle — otherwise a
    # re-emit would overwrite the file while the manifest keeps the old
    # SHA and latest_complete() would verify-fail into None.
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
    # Check + append under ONE inter-process lock: exactly-once even
    # for concurrent same-bundle emits across processes.
    with locks.FileLock(manifest + ".lock"):
        if not _manifest_has_locked(manifest, bundle_id):
            with open(manifest, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(row, sort_keys=True) + "\n")
                fh.flush()
                os.fsync(fh.fileno())
            locks.fsync_dir(outdir)
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


def _manifest_rows(outdir):
    """All manifest rows in append order with sequence numbers.
    Malformed rows are skipped (never crash the reader); row FIELDS
    are type-validated before any sort/path processing so hostile
    manifest data fails closed per-row instead of provoking
    exceptions."""
    manifest = os.path.join(outdir, MANIFEST_NAME)
    rows = []
    try:
        with open(manifest, encoding="utf-8") as fh:
            for seq, line in enumerate(fh):
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if (isinstance(row, dict) and row.get("commit") is True
                        and isinstance(row.get("bundle_id"), str)
                        and row.get("bundle_id")
                        and isinstance(row.get("path"), str)
                        and isinstance(row.get("sha256"), str)
                        and type(row.get("research_epoch")) is int):
                    rows.append((seq, row))
    except OSError:
        pass
    return rows


def _verify_row(root, base, expected_sha):
    """Containment + hash verification. Returns file BYTES on success,
    None otherwise. Reading the bytes IS the verification: callers
    consume exactly these bytes, never a re-opened pathname."""
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

    Scans newest-first by (research_epoch, manifest sequence) and
    returns the first generation whose file exists with matching
    sha256. A corrupt/missing newest generation falls back to the
    prior good one; None only when NO verifiable bundle exists.

    NOTE: the returned pathname is for inspection/legacy callers. For
    consumption use read_latest(), which stages verified bytes into a
    private snapshot (TOCTOU-closed). The pathname may change under a
    hostile filesystem between this return and a later open.
    """
    root = os.path.realpath(outdir)
    rows = _manifest_rows(outdir)
    # Newest-first: highest epoch, then latest manifest sequence.
    # Duplicate bundle_ids are NOT pre-filtered: a corrupt first row
    # must not poison a valid duplicate (seen marks only VERIFIED
    # generations).
    rows.sort(key=lambda sr: (sr[1].get("research_epoch", -1), sr[0]),
              reverse=True)
    seen = set()
    for _seq, row in rows:
        bid = row.get("bundle_id")
        if bid in seen:
            continue
        data = _verify_row(root, row.get("path"), row.get("sha256"))
        if data is not None:
            seen.add(bid)
            return os.path.join(root, os.path.basename(row["path"]))
    return None


def _stage_snapshot(data):
    """Private unique snapshot of already-verified bytes. Mode 0600
    temp file; the caller consumes then unlinks it."""
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
    """Load-bearing publication path: manifest -> newest verified
    generation -> frozen ctx reader, consuming a private snapshot of
    the verified bytes (TOCTOU-closed). Returns the read_bundle()
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
        if data is None:
            continue
        seen.add(bid)
        snap = _stage_snapshot(data)
        try:
            return ctx_read.read_bundle(snap, db_path, map_path, now_ts)
        finally:
            try:
                os.unlink(snap)
            except OSError:
                pass
    return None
