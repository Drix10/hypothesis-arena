"""Bounded execution primitives (stdlib only).

Two distinct guarantees, honestly separated:
- run_with_timeout (threads): bounds SECONDARY time only (tool
  steps inside the worker child). A hung tool raises promptly, but
  the abandoned thread cannot be killed — the child process death
  is the real kill.
- run_in_process (multiprocessing): the PRODUCTION invocation
  boundary. Every provider call runs in a spawn-context child that
  is terminated (SIGTERM, escalated to SIGKILL) on expiry and
  reaped on every path — no live worker survives a timeout, and no
  timed-out thread can write late accounting (the child held no
  ledger authority at all).
"""
import multiprocessing
import threading


class CallTimeout(Exception):
    pass


def run_with_timeout(func, timeout_s, *args, **kwargs):
    """Run func in a daemon thread; raise CallTimeout after timeout_s.
    The attempt is the caller's to charge BEFORE calling this (a timed-
    out attempt counts as spent — fail-closed, like ambiguous
    transport)."""
    box = {}
    done = threading.Event()

    def _target():
        try:
            box["result"] = func(*args, **kwargs)
        except BaseException as e:  # noqa: BLE001 - re-raised below
            box["error"] = e
        finally:
            done.set()

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    if not done.wait(timeout_s):
        raise CallTimeout("call exceeded %.1fs" % timeout_s)
    if "error" in box:
        raise box["error"]
    return box.get("result")


def _child_main(queue, func, args, kwargs):
    try:
        queue.put(("ok", func(*args, **kwargs)))
    except BaseException as e:  # noqa: BLE001 - shipped back, re-raised
        queue.put(("error", repr(e)))


def run_in_process(func, timeout_s, *args, **kwargs):
    """Run a PICKLABLE func in a child process with a hard kill at
    timeout_s. Raises CallTimeout (child terminated) or re-raises the
    child's exception repr as RuntimeError.

    Deterministic result handoff (no Queue.empty() polling): the child
    puts EXACTLY ONE envelope; the parent reads it with get_nowait()
    ONLY after the child is verified dead — a dead child cannot put,
    so the queue state is final: one envelope (success or child
    error) or a loud missing-result error. On timeout the child is
    terminated (SIGTERM), joined, escalated to SIGKILL when still
    alive, and verified gone; the queue is drained-or-closed so no
    fd/handle leaks accumulate across cycles.

    Reaping contract: on EVERY return path no live worker child of
    this call remains (terminate + join, then verify; a still-alive
    child after SIGTERM escalates to SIGKILL and raises). The queue
    is closed so no fd/handle leaks accumulate across cycles."""
    import queue as _queue_mod
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_child_main,
                       args=(queue, func, args, kwargs))
    proc.start()
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
        # The child is dead: its exactly-one envelope is either in
        # the pipe (the feeder delivers it imminently) or never
        # coming. A bounded get() distinguishes the two WITHOUT
        # polling empty() and WITHOUT blocking forever: success and
        # child-error envelopes both arrive; anything else is loud.
        try:
            status, payload = queue.get(timeout=30)
        except _queue_mod.Empty:
            raise RuntimeError("child exited without a result")
    finally:
        try:
            queue.close()
            queue.join_thread()
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
