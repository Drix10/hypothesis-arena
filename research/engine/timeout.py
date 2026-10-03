"""Bounded execution primitive (stdlib only).

run_in_process (multiprocessing) is the production invocation boundary.
Every provider call runs in a spawn-context child that is terminated
(SIGTERM, then SIGKILL) on expiry and reaped on every path. The child
holds no ledger authority, so a timed-out call cannot write late
accounting.
"""
import multiprocessing

# Grace for a result-delivered child to finish teardown before the kill
# ladder; the result wait itself is the caller's timeout_s.
REAP_GRACE_S = 10.0
# Grace between the result deadline and the kill ladder: an already-exited
# child reads as a missing result, not a timeout. The deadline overshoots by
# at most this plus reap time; join() returns as soon as the child exits.
SETTLE_GRACE_S = 0.25


class CallTimeout(Exception):
    pass


def _child_main(conn, func, args, kwargs):
    try:
        conn.send(("ok", func(*args, **kwargs)))
    except BaseException as e:  # noqa: BLE001 - shipped back, re-raised
        # bound the shipped error text so it cannot bloat IPC
        import reprlib
        fmt = reprlib.Repr()
        fmt.maxstring = 2000
        fmt.maxother = 2000
        try:
            err = fmt.repr(e)
        except Exception:
            err = "%s: <unrepresentable>" % type(e).__name__
        try:
            conn.send(("error", err))
        except BaseException:
            pass
    finally:
        try:
            conn.close()
        except OSError:
            pass


def _recv_envelope(conn, deadline_s):
    """Wait up to deadline_s for one envelope and read the whole frame under
    the same bound. Returns ("result", status, payload), ("none",) or
    ("none", thread). A child stalled mid-frame cannot hang recv() past the
    deadline; the caller kills it and treats the call as ambiguous. A dead
    child with nothing sent reads as immediate EOF."""
    import threading
    import time as _t
    end = _t.monotonic() + deadline_s
    try:
        if not conn.poll(max(0.0, end - _t.monotonic())):
            return ("none",)
    except (EOFError, BrokenPipeError, OSError):
        return ("none",)
    box = {}

    def _read():
        try:
            box["got"] = ("result", conn.recv())
        except BaseException as e:  # noqa: BLE001 - classified below
            box["got"] = ("error", e)
    th = threading.Thread(target=_read, daemon=True)
    th.start()
    th.join(max(0.0, end - _t.monotonic()))
    if th.is_alive():
        # frame stalled mid-send: no result; killing the child closes the
        # write end, which unblocks the reader (joined again after the kill)
        return ("none", th)
    got = box.get("got")
    if got is None or got[0] != "result":
        return ("none",)
    env = got[1]
    if (not isinstance(env, tuple)) or len(env) != 2:
        # a complete frame that is not our envelope: treated as missing
        return ("none",)
    return ("result", env[0], env[1])


def _kill_and_reap(proc, grace=REAP_GRACE_S):
    """SIGTERM, escalate to SIGKILL, verify. Returns True when no live
    worker remains. grace is the wait before the first signal: the result
    path waits for a clean exit; the timeout path passes 0 because the
    settle grace has already elapsed."""
    try:
        if grace > 0:
            proc.join(grace)
        if proc.is_alive():
            proc.terminate()
            proc.join(10)
        if proc.is_alive():
            try:
                proc.kill()
            except (AttributeError, ValueError):
                pass
            proc.join(10)
        return not proc.is_alive()
    except (OSError, ValueError):
        return not proc.is_alive()


def run_in_process(func, timeout_s, *args, **kwargs):
    """Run a picklable func in a child process, killed at timeout_s.

    timeout_s is the deadline at which termination begins (within
    SETTLE_GRACE_S), not a strict completion guarantee. After it: SIGTERM,
    then SIGKILL, each with a bounded join, ending in CallTimeout (also
    for a worker that cannot be killed). Raises CallTimeout, or re-raises
    the child's exception repr as RuntimeError.

    The result comes back over a one-shot Pipe read while the child runs,
    so a large result streams through the pipe buffer instead of blocking
    the child's send(). The frame read is bounded by the same deadline. No
    complete result at the deadline kills the child and raises CallTimeout
    (ambiguous: the attempt may have been billed). A dead child with no
    envelope raises a missing-result RuntimeError immediately. Callers
    treat both as ambiguous.

    An intact envelope proves the call completed: a teardown crash after a
    successful send does not turn accounted work into unknown spend.

    On every return path no worker child of this call remains (an
    unkillable child raises CallTimeout even with a result in hand), and
    both pipe ends are closed."""
    ctx = multiprocessing.get_context("spawn")
    parent_conn, child_conn = ctx.Pipe(duplex=False)
    proc = ctx.Process(target=_child_main,
                       args=(child_conn, func, args, kwargs))
    try:
        proc.start()
    except BaseException:
        parent_conn.close()
        child_conn.close()
        raise
    try:
        child_conn.close()
    except OSError:
        pass
    try:
        outcome = _recv_envelope(parent_conn, timeout_s)
        reader = outcome[1] if (outcome[0] == "none" and
                                len(outcome) == 2) else None
        if outcome[0] != "result":
            # no complete result: a short grace separates a dead child (EOF
            # readable) from a dying one; a live child is killed below, an
            # exited one is labeled missing rather than timed out
            proc.join(SETTLE_GRACE_S)
            if proc.is_alive():
                # deadline or stalled frame: kill now (grace=0); attempt is ambiguous
                dead = _kill_and_reap(proc, grace=0)
                if reader is not None:
                    # the write end is closed, so the stalled reader unblocks on
                    # EOF; join it. Accepted risk: where recv() does not unblock
                    # after the child dies, this daemon thread outlives the call
                    # (it never blocks the result)
                    reader.join(5)
                if not dead:
                    raise CallTimeout("child unkillable after %.1fs "
                                      "(leaked worker)" % timeout_s)
                raise CallTimeout("child timed out after %.1fs (no "
                                  "result)" % timeout_s)
            # child dead, nothing sent: missing result, ambiguous like a timeout
            _kill_and_reap(proc, grace=0)
            raise RuntimeError("child exited without a result")
        status, payload = outcome[1], outcome[2]
        # envelope in hand: reap the child; a leaked worker is an error even with a result
        if not _kill_and_reap(proc):
            raise CallTimeout("child unkillable after result "
                              "(leaked worker)")
    finally:
        try:
            parent_conn.close()
        except (OSError, ValueError):
            pass
        if proc.is_alive():
            try:
                proc.terminate()
            except (OSError, ValueError):
                pass
            proc.join(5)
    if status == "ok":
        return payload
    raise RuntimeError("child failed: %s" % payload)
