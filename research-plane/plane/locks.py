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
# "create" serializes ledger first-creation across processes (a
# dedicated lock file per DB: creation check-then-mint must be
# atomic, and it must never nest inside the spans/budget locks on
# the SAME file — lock ORDER is always data-lock -> create-lock,
# never the reverse, so no hold-and-wait cycle exists).
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


def write_marker(db_path, token, roots=None):
    """Durably record the authority-init token beside the DB.
    roots (optional) replaces the historical-integrity roots
    carried by the marker; None preserves whatever roots the
    current marker holds (token-heal rewrites must not drop the
    deletion-detection baseline). The 1 KiB cap stands: roots are
    fixed-schema aggregates, never row sets (row sets live in
    dedicated sidecars, not the marker)."""
    import time
    if roots is None:
        try:
            roots = marker_roots(db_path)
        except (FileNotFoundError, ValueError):
            # Absent or corrupt body: nothing preservable. (An
            # explicit re-publish carries a new token; stale roots
            # must not survive it. Heal paths only reach here with
            # a valid or absent marker — corrupt markers deny
            # before any heal.)
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
    """Parsed marker dict, or {} when provably absent. Raises
    ValueError on corrupt/oversized/unreadable content
    (fail-closed: callers deny — an unreadable trust root is not
    an absent one)."""
    try:
        data = load_json_bounded(init_marker_path(db_path),
                                 max_bytes=1024)
    except FileNotFoundError:
        return {}
    if not isinstance(data, dict):
        raise ValueError("marker body not a dict")
    return data


def marker_roots(db_path):
    """Historical-integrity roots carried by the marker ({} when
    the marker predates roots — trust-on-first-use adoption by the
    caller verifies the live DB first; {} also when absent). Roots
    present but malformed raise ValueError: edited roots are never
    adopted, never verified against."""
    roots = marker_body(db_path).get("roots", {})
    if not isinstance(roots, dict):
        raise ValueError("marker roots not a dict")
    return roots


def merge_marker_roots(db_path, update, exact=()):
    """Max-accumulate numeric root stats into the marker (atomic
    rewrite; token and sibling fields preserved). Every stat is
    monotonic by construction (maxima, counts, high-waters), so
    concurrent mergers converge instead of losing updates, and a
    crash between the DB commit and this bump only lags the
    baseline (the next verify adopts it from in-DB truth — never a
    false deny). Keys listed in exact are overwritten instead of
    max-accumulated (mirror copies of in-DB truth: count, cents,
    created, closed — a tampered-high marker value must be
    replaced by truth, not kept by max). Requires a token-bearing
    marker (bumping a tokenless file would mint a trust root over
    an unproven authority): ValueError otherwise."""
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
                # Content digests: set-semantics (no ordering).
                # Concurrent mirrors compute from the same DB
                # truth, so last-wins converges in practice; any
                # divergence is re-mirrored on the next mutation.
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
    """True only when (re)creating missing SQLite tables cannot
    reset an established money authority: a provable first init
    (the file did not exist and no marker claims it), or a pristine
    file (present but holding NONE of the required tables with no
    marker — a crash-interrupted first init or total annihilation,
    both correctly a fresh authority). Anything else — a marker or
    token survivor, or surviving sibling tables — means the schema
    is established and a missing table is deletion or corruption,
    never a creation case."""
    if not exists and mstate == "absent":
        return True
    if exists and mstate == "absent" and not have:
        return True
    return False


def marker_state(db_path):
    """Tri-state authority marker: (state, token_or_None).

    - ("absent", None): no marker file at all.
    - ("invalid", None): a marker file exists but is corrupt,
      oversized, malformed, carries no usable token, OR cannot be
      read at all (permissions, I/O failure). Only a PROVABLY
      missing file (FileNotFoundError) is absent: an unreadable
      marker with a missing DB must not look like a fresh
      deployment (that is the spend-reset the marker exists to
      prevent). DB-absent + marker-invalid aborts
      (a deleted authority with a damaged marker must not look like
      a fresh deployment), and DB-present + marker-invalid aborts
      (an unverifiable authority is not healed blindly).
    - ("valid", token): well-formed marker with a non-empty token.
    """
    try:
        data = load_json_bounded(init_marker_path(db_path),
                                 max_bytes=1024)
    except FileNotFoundError:
        return "absent", None
    except OSError:
        # Unreadable (permissions, I/O error, directory in the
        # way): NOT absent — fail closed as invalid.
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
