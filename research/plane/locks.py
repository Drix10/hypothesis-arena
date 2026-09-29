"""Cross-process file primitives (stdlib only).

- FileLock: blocking OS-native exclusive lock (fcntl/msvcrt) over a
  per-purpose in-process RLock. Purposes are a fixed allowlist, so
  writers do not share one global lock and no per-path table grows in a
  long-lived process. An unknown purpose raises ValueError.
- atomic_write_bytes: unique temp + fsync + atomic replace + dir fsync.
- load_json_bounded: size-capped JSON load.
- Authority markers (init_marker_path/marker_state/write_marker): a
  durable SQLite authority (budget, attribution) is created together
  with a sidecar marker holding the same random init token stored in
  the DB. Marker state is absent (file missing), invalid (corrupt,
  oversized, malformed or unreadable) or valid. DB-absent + marker-absent
  is the only genuine first init; any other combination involving an
  invalid marker aborts. The marker is healed only when the DB verifies
  and carries a valid token.
  Supervisor fresh start: delete both files (see PHASE_E_AUDIT.md). A
  wipe of the whole directory looks like a new deployment (accepted).
"""
import json
import os
import secrets
import tempfile
import threading

# Purpose allowlist, one RLock each. "create" serializes ledger
# first-creation across processes (check-then-mint must be atomic). Lock
# order is always data-lock -> create-lock, never the reverse.
_PURPOSES = ("spans", "manifest", "cadence", "digest", "tier",
             "budget", "attribution", "signal", "create",
             "general")
_LOCKS = {p: threading.RLock() for p in _PURPOSES}


def _guard(purpose):
    try:
        return _LOCKS[purpose]
    except KeyError:
        raise ValueError("unknown lock purpose: %r" % (purpose,))


class FileLock:
    """Blocking mutual exclusion on a lock FILE.

    fcntl.flock on POSIX, msvcrt.locking on Windows. Blocks (with a generous timeout) because writers must wait, not
    fail: check-then-act races close only when both hold the same lock.
    A per-purpose threading lock is layered inside because two threads
    may share an OS lock description on some platforms.
    """

    def __init__(self, path, purpose="general", timeout=120.0):
        self.path = path
        self.purpose = purpose
        self.timeout = timeout
        self.fh = None

    def __enter__(self):
        import time
        guard = _guard(self.purpose)
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        if not guard.acquire(timeout=self.timeout):
            raise TimeoutError("lock busy: %s" % self.path)
        try:
            self.fh = open(self.path, "a+b")
        except OSError:
            guard.release()
            raise
        try:
            if os.name == "nt":
                import msvcrt
                end = time.monotonic() + self.timeout
                while True:
                    try:
                        self.fh.seek(0)
                        msvcrt.locking(self.fh.fileno(), msvcrt.LK_NBLCK,
                                       1)
                        return self
                    except OSError:
                        if time.monotonic() >= end:
                            raise TimeoutError(
                                "lock busy: %s" % self.path)
                        time.sleep(0.02)
            else:
                import fcntl
                import select
                end = time.monotonic() + self.timeout
                while True:
                    try:
                        fcntl.flock(self.fh.fileno(),
                                    fcntl.LOCK_EX | fcntl.LOCK_NB)
                        return self
                    except (OSError, IOError):
                        if time.monotonic() >= end:
                            raise TimeoutError(
                                "lock busy: %s" % self.path)
                        select.select([], [], [], 0.02)
        except BaseException:
            try:
                self.fh.close()
            except OSError:
                pass
            self.fh = None
            guard.release()
            raise

    def __exit__(self, *exc):
        try:
            if self.fh is not None:
                try:
                    if os.name == "nt":
                        import msvcrt
                        self.fh.seek(0)
                        msvcrt.locking(self.fh.fileno(),
                                       msvcrt.LK_UNLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(self.fh.fileno(), fcntl.LOCK_UN)
                finally:
                    self.fh.close()
        finally:
            self.fh = None
            _guard(self.purpose).release()
        return False


def fsync_dir(dirpath):
    """POSIX directory fsync. Skipped on Windows."""
    if os.name == "nt":
        return
    fd = os.open(dirpath, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_bytes(dirpath, final_name, data):
    """Write data to dirpath/final_name atomically via a unique temp
    file. Returns the final path."""
    os.makedirs(dirpath, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=dirpath, prefix=final_name + ".",
                               suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, os.path.join(dirpath, final_name))
        fsync_dir(dirpath)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return os.path.join(dirpath, final_name)


def load_json_bounded(path, max_bytes=65536):
    """Read + parse JSON, refusing files over max_bytes before parsing.
    Raises ValueError/OSError."""
    size = os.path.getsize(path)
    if size > max_bytes:
        raise ValueError("state file too large: %d > %d"
                         % (size, max_bytes))
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def init_marker_path(db_path):
    return db_path + ".init"


def write_marker(db_path, token, roots=None):
    """Durably record the authority-init token beside the DB.
    roots replaces the marker's historical-integrity roots; None keeps
    the current ones (a token-heal must not drop the deletion-detection
    baseline). The marker stays under 1 KiB: roots are fixed-schema
    aggregates, not row sets."""
    import time
    if roots is None:
        try:
            roots = marker_roots(db_path)
        except (FileNotFoundError, ValueError):
            # nothing preservable; stale roots must not survive a new token.
            # Heal paths reach here only with a valid or absent marker.
            roots = {}
    body = {"init_token": token,
            "created_ts": int(time.time()),
            "roots": roots}
    raw = json.dumps(body, sort_keys=True).encode("utf-8")
    if len(raw) > 1024:
        raise ValueError("marker roots overflow: %d bytes"
                         % len(raw))
    atomic_write_bytes(os.path.dirname(os.path.abspath(db_path)),
                       os.path.basename(init_marker_path(db_path)),
                       raw)


def marker_body(db_path):
    """Parsed marker dict, or {} when provably absent. Raises ValueError
    on corrupt, oversized or unreadable content (callers deny)."""
    try:
        data = load_json_bounded(init_marker_path(db_path),
                                 max_bytes=1024)
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError("marker body not a dict")
    return data


def marker_roots(db_path):
    """Historical-integrity roots in the marker ({} when absent or
    predating roots; the caller then verifies the live DB before
    adopting). Malformed roots raise ValueError."""
    roots = marker_body(db_path).get("roots", {})
    if not isinstance(roots, dict):
        raise ValueError("marker roots not a dict")
    return roots


def merge_marker_roots(db_path, update, exact=()):
    """Max-accumulate numeric root stats into the marker (atomic rewrite;
    token and other fields kept). Stats are monotonic, so concurrent
    mergers converge, and a crash between the DB commit and this bump
    only lags the baseline (the next verify re-adopts from the DB).
    Keys in `exact` are overwritten instead (mirrors of in-DB truth, so
    a tampered-high value is replaced). Requires a token-bearing marker;
    ValueError otherwise."""
    body = marker_body(db_path)
    if not isinstance(body.get("init_token"), str) or \
            not body["init_token"]:
        raise ValueError("merge needs a token-bearing marker")
    roots = body.get("roots", {})
    if not isinstance(roots, dict):
        raise ValueError("marker roots not a dict")
    for table, stats in update.items():
        slot = roots.get(table)
        if not isinstance(slot, dict):
            slot = {}
            roots[table] = slot
        for key, val in stats.items():
            if type(val) is str:
                # content digests are order-free; last write wins and any
                # divergence is re-mirrored on the next mutation
                slot[key] = val
                continue
            if type(val) not in (int, float):
                raise ValueError("root stat not numeric: %r" %
                                 ((table, key),))
            old = slot.get(key)
            if key in exact or type(old) not in (int, float) \
                    or val > old:
                slot[key] = val
    body["roots"] = roots
    raw = json.dumps(body, sort_keys=True).encode("utf-8")
    if len(raw) > 1024:
        raise ValueError("marker roots overflow: %d bytes"
                         % len(raw))
    atomic_write_bytes(os.path.dirname(os.path.abspath(db_path)),
                       os.path.basename(init_marker_path(db_path)),
                       raw)


def may_create_tables(have, exists, mstate):
    """True only when creating missing tables cannot reset an established
    authority: a first init (no file, no marker) or a pristine file (none
    of the required tables, no marker). With a surviving marker, token or
    sibling tables, a missing table is deletion or corruption."""
    if not exists and mstate == "absent":
        return True
    if exists and mstate == "absent" and not have:
        return True
    return False


def marker_state(db_path):
    """Authority marker state: (state, token_or_None).

    - ("absent", None): the file is missing (FileNotFoundError only).
    - ("invalid", None): corrupt, oversized, malformed, no usable token,
      or unreadable. An unreadable marker with a missing DB must not
      look like a fresh deployment (that would reset spend), so
      DB-absent + invalid aborts, as does DB-present + invalid.
    - ("valid", token): well-formed marker with a non-empty token.
    """
    try:
        data = load_json_bounded(init_marker_path(db_path),
                                 max_bytes=1024)
    except FileNotFoundError:
        return "absent", None
    except OSError:
        # unreadable (permissions, I/O, directory in the way) is invalid, not absent
        return "invalid", None
    except ValueError:
        return "invalid", None
    if not isinstance(data, dict):
        return "invalid", None
    token = data.get("init_token")
    if not isinstance(token, str) or not token:
        return "invalid", None
    return "valid", token


def fresh_token():
    return secrets.token_hex(16)
