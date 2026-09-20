"""Bounded execution primitives (stdlib only).

Two distinct guarantees, honestly separated:
- run_with_timeout (threads): bounds ACCOUNTING time. A hung call
  raises TimeoutError promptly and the attempt stays charged, but the
  abandoned thread cannot be killed — a hung C/network call keeps its
  thread. This is the in-process watchdog, not preemption.
- run_in_process (multiprocessing): TRUE preemption for picklable
  callables — the child is terminated on expiry. The supervisor owns
  running untrusted/hanging provider boundaries in a supervised child
  process and terminating it; this helper is that tested primitive.
  Agent graphs and model clients are not picklable, so the production
  rule is: the supervisor launches each worker bundle in its own
  process (systemd unit / container) with a wall-clock kill at
  R15 WALL_S, and the in-process budget is the secondary guard.
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
    child's exception repr as RuntimeError."""
    ctx = multiprocessing.get_context("spawn")
    queue = ctx.Queue()
    proc = ctx.Process(target=_child_main,
                       args=(queue, func, args, kwargs))
    proc.start()
    proc.join(timeout_s)
    if proc.is_alive():
        proc.terminate()
        proc.join(10)
        raise CallTimeout("child exceeded %.1fs (terminated)"
                          % timeout_s)
    if queue.empty():
        raise RuntimeError("child exited without a result")
    status, payload = queue.get()
    if status == "ok":
        return payload
    raise RuntimeError("child failed: %s" % payload)
