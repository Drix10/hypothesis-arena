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
# Dying-window grace between the result deadline and the kill
# ladder: an already-exited child must read as a missing result
# (not a timeout), but the kill must still begin promptly — the
# hard deadline overshoots by at most this plus reap time, never
# by seconds. join() returns the instant the child exits, so the
# fast path costs nothing.
SETTLE_GRACE_S = 0.25


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


def _recv_envelope(conn, deadline_s):
    """Wait up to deadline_s for exactly one envelope, then read the
    whole frame under the same bound. Returns ("result", status,
    payload) or ("none",) or ("none", thread): a child that stalls
    mid-frame (partial bytes readable, frame never completed) must
    not hang recv() past the hard deadline — the caller kills and
    treats it as ambiguous. A dead child with nothing sent reads as
    immediate EOF (loud missing result, no wait to the deadline)."""
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
        # Frame stalled mid-send: no result. The caller kills the
        # child (closing the write end unblocks the reader, which
        # then exits on EOF — joined again after the kill).
        return ("none", th)
    got = box.get("got")
    if got is None or got[0] != "result":
        return ("none",)
    env = got[1]
    if (not isinstance(env, tuple)) or len(env) != 2:
        # A complete frame that is not our envelope: no usable
        # result (the caller treats it as missing, loud).
        return ("none",)
    return ("result", env[0], env[1])


def _kill_and_reap(proc, grace=REAP_GRACE_S):
    """SIGTERM, escalate to SIGKILL, verify. Returns True when no
    live worker remains. grace is the gentle window granted BEFORE
    the first signal: the result path (child provably done, tearing
    down) waits for a clean exit; the timeout path passes 0 — the
    settle grace already gave a dying child its chance, so the
    kill begins at the deadline instead of seconds later."""
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
    """Run a PICKLABLE func in a child process with a prompt kill at
    timeout_s. timeout_s is NOT a strict wall-clock completion
    guarantee — it is the deadline at which termination begins
    (within SETTLE_GRACE_S, just enough to tell an exited child
    from a live one for exact missing-vs-timeout labels). After the
    deadline: bounded escalation (SIGTERM, then SIGKILL, each with
    a bounded join), ending in CallTimeout — or, for a truly
    unkillable worker, a leaked-worker CallTimeout, never a silent
    success. A normally terminable child therefore resolves just
    past the deadline; an uncatchable one takes the escalation
    ladder. Raises CallTimeout (child terminated) or re-raises the
    child's exception repr as RuntimeError.

    Result handoff over a one-shot Pipe, read WHILE the child runs
    (no Queue, no empty() polling, no feeder thread): the parent
    waits up to timeout_s for the envelope, so a large valid result
    streams through the finite OS pipe buffer concurrently instead
    of blocking the child's send() against a parent that only reads
    after death. The frame read itself is bounded by the same
    deadline: a child stalled mid-frame cannot hang recv() past it.
    Deadline with no (complete) result → kill + CallTimeout
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
        outcome = _recv_envelope(parent_conn, timeout_s)
        reader = outcome[1] if (outcome[0] == "none" and
                                len(outcome) == 2) else None
        if outcome[0] != "result":
            # No (complete) result. Settle the race between a dead
            # child (EOF already readable) and a dying one with a
            # bounded grace — then the kill begins immediately, so
            # the hard deadline overshoots by SETTLE_GRACE_S at
            # most. A live child afterwards is killed below; an
            # exited one is labeled missing (not timed out).
            proc.join(SETTLE_GRACE_S)
            if proc.is_alive():
                # Deadline with no result, or a frame stalled
                # mid-send: the child may be blocked or slow —
                # either way it must die NOW (grace=0: no second
                # wait before the first signal), and the attempt is
                # ambiguous.
                dead = _kill_and_reap(proc, grace=0)
                if reader is not None:
                    # The write end is now closed: the stalled reader
                    # unblocks on EOF — join it so no thread debt
                    # accumulates across cycles. Residual risk
                    # (accepted, documented): on a platform where
                    # recv() does not unblock after the child dies,
                    # this daemon thread outlives the call — it never
                    # blocks the result, and the reaped child
                    # guarantees no live worker.
                    reader.join(5)
                if not dead:
                    raise CallTimeout("child unkillable after %.1fs "
                                      "(leaked worker)" % timeout_s)
                raise CallTimeout("child timed out after %.1fs (no "
                                  "result)" % timeout_s)
            # The child is already dead and sent nothing: loud
            # missing result (callers treat it as ambiguous, same
            # conservatism as a timeout, without mislabeling it).
            _kill_and_reap(proc, grace=0)
            raise RuntimeError("child exited without a result")
        status, payload = outcome[1], outcome[2]
        # Envelope in hand: the call provably completed. Reap
        # the tearing-down child; a leaked worker is fatal even
        # with a result (never return success over one).
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
