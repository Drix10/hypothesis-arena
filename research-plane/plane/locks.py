"""Cross-process file primitives (stdlib only).

Single home for the three patterns every writer needs:
- FileLock: blocking OS-native exclusive lock (fcntl/msvcrt).
- atomic_write_bytes: unique temp + file fsync + atomic replace +
  POSIX directory fsync (fail-closed: any error raises, the final
  name never appears half-written).
- load_json_bounded: size-capped JSON load (fail-closed on oversize).
"""
import json
import os
import tempfile
import threading

# One process-wide guard, not one entry per path: the in-process layer
# only serializes same-process threads (the OS lock serializes
# processes). A per-path table would retain an entry for every path
# ever seen — an unbounded leak in a long-lived process. A single
# RLock holds no per-path state at all, so there is nothing to grow.
_PROC = threading.RLock()


class FileLock:
    """Blocking mutual exclusion on a lock FILE.

    fcntl.flock on POSIX, msvcrt.locking on Windows. Blocking (with a
    generous timeout) because writer serialization must WAIT, not fail:
    check-then-act races (manifest append, span dedupe, cadence save)
    close only when the check and the act hold the same lock. A
    same-process threading lock is layered inside because two threads
    may share an OS lock description on some platforms.
    """

    def __init__(self, path, timeout=120.0):
        self.path = path
        self.timeout = timeout
        self.fh = None

    def __enter__(self):
        import time
        d = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(d, exist_ok=True)
        if not _PROC.acquire(timeout=self.timeout):
            raise TimeoutError("lock busy: %s" % self.path)
        try:
            self.fh = open(self.path, "a+b")
        except OSError:
            self._proc.release()
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
            _PROC.release()
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
            _PROC.release()
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
