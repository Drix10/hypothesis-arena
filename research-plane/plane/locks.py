"""Cross-process file primitives (stdlib only).

Single home for the patterns every writer needs:
- FileLock: blocking OS-native exclusive lock (fcntl/msvcrt) layered
  over a per-PURPOSE in-process RLock. Purposes are a FROZEN allowlist:
  subsystem writers must never serialize through one global lock (that
  trades a leak for global contention), and a per-path table would grow
  without bound in a long-lived process. Unknown purpose = ValueError
  at acquisition time (fail fast, nothing to grow).
- atomic_write_bytes: unique temp + file fsync + atomic replace +
  POSIX directory fsync (fail-closed).
- load_json_bounded: size-capped JSON load (fail-closed on oversize).
- Authority markers: init_marker_path/marker_state/write_marker. A
  durable SQLite authority (budget, attribution) is created together
  with a sidecar marker holding the same random init token that is
  also stored inside the DB. Marker states are TRI-STATE — absent /
  invalid (a missing file is absent; corrupt, oversized, or malformed
  content is INVALID, never silently absent): DB-absent + marker-
  absent is the only genuine first init; every other combination
  involving an invalid marker aborts. Marker healing is allowed only
  when the DB itself verifies AND carries a valid token.
  Supervisor fresh-start procedure: delete BOTH files (documented in
  PHASE_E_AUDIT.md). Total wipe of the directory is indistinguishable
  from a new deployment (accepted, documented).
"""
import json
import os
import secrets
import tempfile
import threading

# Frozen purpose allowlist. One RLock each; no per-path state.
_PURPOSES = ("spans", "manifest", "cadence", "digest", "tier",
             "budget", "attribution", "signal", "general")
_LOCKS = {p: threading.RLock() for p in _PURPOSES}


def _guard(purpose):
    try:
        return _LOCKS[purpose]
    except KeyError:
        raise ValueError("unknown lock purpose: %r" % (purpose,))


class FileLock:
    """Blocking mutual exclusion on a lock FILE.

    fcntl.flock on POSIX, msvcrt.locking on Windows. Blocking (with a
    generous timeout) because writer serialization must WAIT, not fail:
    check-then-act races (manifest append, span dedupe, cadence save)
    close only when the check and the act hold the same lock. A
    per-purpose threading lock is layered inside because two threads
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
    """POSIX directory fsync (fail-closed). Windows: documented skip."""
    if os.name == "nt":
        return
    fd = os.open(dirpath, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_bytes(dirpath, final_name, data):
    """Write data to dirpath/final_name atomically. Unique temp per
    invocation (no pid-collision between threads/processes). Returns
    the final path."""
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
    """Read + parse JSON, refusing oversized files BEFORE parsing
    (resource-exhaustion guard). Raises ValueError/OSError."""
    size = os.path.getsize(path)
    if size > max_bytes:
        raise ValueError("state file too large: %d > %d"
                         % (size, max_bytes))
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def init_marker_path(db_path):
    return db_path + ".init"


def write_marker(db_path, token):
    """Durably record the authority-init token beside the DB."""
    import time
    raw = json.dumps({"init_token": token,
                      "created_ts": int(time.time())},
                     sort_keys=True).encode("utf-8")
    atomic_write_bytes(os.path.dirname(os.path.abspath(db_path)),
                       os.path.basename(init_marker_path(db_path)), raw)


def marker_state(db_path):
    """Tri-state authority marker: (state, token_or_None).

    - ("absent", None): no marker file at all.
    - ("invalid", None): a marker file exists but is corrupt,
      oversized, malformed, or carries no usable token. INVALID is
      NEVER folded into absent: DB-absent + marker-invalid aborts
      (a deleted authority with a damaged marker must not look like
      a fresh deployment), and DB-present + marker-invalid aborts
      (an unverifiable authority is not healed blindly).
    - ("valid", token): well-formed marker with a non-empty token.
    """
    try:
        data = load_json_bounded(init_marker_path(db_path),
                                 max_bytes=1024)
    except OSError:
        return "absent", None
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
