"""Bounded execution primitive (stdlib only).

run_in_process (multiprocessing) is the PRODUCTION invocation
boundary. Every provider call runs in a spawn-context child that
is terminated (SIGTERM, escalated to SIGKILL) on expiry and
reaped on every path — no live worker survives a timeout, and no
timed-out thread can write late accounting (the child held no
ledger authority at all). (A thread-based secondary bound was
removed: no production path used it, and an unkillable abandoned
thread is not a boundary.)
"""
import multiprocessing

# Grace to let a result-delivered child finish teardown before the
# kill ladder. The RESULT wait itself is the caller's timeout_s
# (poll below) — this bound covers only post-delivery reaping.
REAP_GRACE_S = 10.0


class CallTimeout(Exception):
    pass


def _child_main(conn, func, args, kwargs):
    try:
        conn.send(("ok", func(*args, **kwargs)))
    except BaseException as e:  # noqa: BLE001 - shipped back, re-raised
        # Bound the shipped error text (a hostile exception message
        # must not bloat IPC).
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


def _kill_and_reap(proc):
    """SIGTERM, escalate to SIGKILL, verify. Returns True when no
    live worker remains."""
    try:
        proc.join(REAP_GRACE_S)
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
    """Run a PICKLABLE func in a child process with a hard kill at
    timeout_s. Raises CallTimeout (child terminated) or re-raises the
    child's exception repr as RuntimeError.

    Result handoff over a one-shot Pipe, read WHILE the child runs
    (no Queue, no empty() polling, no feeder thread): the parent
    polls the pipe for up to timeout_s, so a large valid result
    streams through the finite OS pipe buffer concurrently instead
    of blocking the child's send() against a parent that only reads
    after death. Deadline with no result → kill + CallTimeout
    (ambiguous: the attempt may have been billed). A dead child with
    no envelope (all write ends closed, nothing sent) reads as
    immediate EOF — loud missing-result RuntimeError, never a wait
    to the deadline and never a silent default.

    An intact envelope proves the call completed, so no
    signal-ambiguity is attached to it: teardown crashes after a
    successful send do not convert accounted work into unknown
    spend. A missing envelope stays conservative (the callers treat
    both CallTimeout and the loud RuntimeError as ambiguous).

    Reaping contract: on EVERY return path no live worker child of
    this call remains (an unkillable child raises CallTimeout even
    with a result in hand — a leaked worker is never returned as
    success). Both pipe ends are closed so no fd/handle leaks
    accumulate across cycles."""
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
        if parent_conn.poll(timeout_s):
            try:
                status, payload = parent_conn.recv()
            except (EOFError, BrokenPipeError, OSError):
                # All write ends closed with nothing sent: the dead
                # child produced no result.
                raise RuntimeError("child exited without a result")
            # Envelope in hand: the call provably completed. Reap
            # the tearing-down child; a leaked worker is fatal even
            # with a result (never return success over one).
            if not _kill_and_reap(proc):
                raise CallTimeout("child unkillable after result "
                                  "(leaked worker)")
        else:
            # Deadline, no result: the child may be blocked or slow —
            # either way it must die, and the attempt is ambiguous.
            if not _kill_and_reap(proc):
                raise CallTimeout("child unkillable after %.1fs "
                                  "(leaked worker)" % timeout_s)
            raise CallTimeout("child timed out after %.1fs (no "
                              "result)" % timeout_s)
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
