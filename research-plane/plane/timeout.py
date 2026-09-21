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

# After the child is verified dead, its one envelope is already in
# the OS pipe buffer — the parent's poll() returns immediately. The
# bound below covers only a genuine anomaly (dead child, no
# envelope), never normal delivery: there is no feeder-thread
# handoff to wait out.
RECEIVE_TIMEOUT_S = 10.0


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


def run_in_process(func, timeout_s, *args, **kwargs):
    """Run a PICKLABLE func in a child process with a hard kill at
    timeout_s. Raises CallTimeout (child terminated) or re-raises the
    child's exception repr as RuntimeError.

    Deterministic result handoff over a one-shot Pipe (no Queue, no
    empty() polling, no feeder thread): the child sends EXACTLY ONE
    envelope down the pipe and closes it; the parent reads ONLY after
    the child is verified dead — a dead child cannot send, so the
    pipe state is final: one envelope (success or child error) or a
    loud missing-result error. On timeout the child is terminated
    (SIGTERM), joined, escalated to SIGKILL when still alive, and
    verified gone; both pipe ends are closed so no fd/handle leaks
    accumulate across cycles.

    Reaping contract: on EVERY return path no live worker child of
    this call remains (terminate + join, then verify; a still-alive
    child after SIGTERM escalates to SIGKILL and raises)."""
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
        proc.join(timeout_s)
        if proc.is_alive():
            proc.terminate()
            proc.join(10)
        if proc.is_alive():
            try:
                proc.kill()
            except (AttributeError, ValueError):
                pass
            proc.join(10)
        if proc.is_alive():
            raise CallTimeout("child unkillable after %.1fs "
                              "(leaked worker)" % timeout_s)
        if proc.exitcode is not None and proc.exitcode < 0:
            # Killed by signal (our timeout kill or a crash): the
            # attempt is AMBIGUOUS — it may have been billed.
            raise CallTimeout("child killed (signal %d), attempt "
                              "ambiguous" % proc.exitcode)
        # The child is dead and the pipe is one-shot: poll() returns
        # at once when the envelope is there; a closed-without-send
        # pipe (Windows raises BrokenPipeError on poll, POSIX reads
        # EOF) or an expiry means the dead child sent nothing — loud,
        # never a silent default.
        try:
            got = parent_conn.poll(RECEIVE_TIMEOUT_S)
        except (EOFError, BrokenPipeError, OSError):
            got = False
        if got:
            try:
                status, payload = parent_conn.recv()
            except (EOFError, BrokenPipeError, OSError):
                raise RuntimeError("child exited without a result")
        else:
            raise RuntimeError("child exited without a result")
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
