#!/usr/bin/env python3
"""kill-probe.py — Phase-D deployment box 5 (supervisor WALL_S kill/reap).

Proves the shipped kill ladder (plane/timeout.py::run_in_process, the
primitive the production supervisor drives with timeout_s=WALL_S=480s)
with SHORT deadlines (the ladder is deadline-parameterized; the
mechanism is identical at any value):
  1. SIGTERM-ignoring runaway -> CallTimeout in bounded time (a child
     that ignores TERM can only die by KILL: bounded return PROVES
     the SIGKILL escalation fired, no exit-code access needed).
  2. Cooperative sleeper -> prompt CallTimeout (TERM path).
  3. Fast child -> result returned, no kill.
  4. Every path leaves no live child (reaped: is_alive False).
Exits 0 only if all hold. LINUX ONLY (POSIX signals are vacuous on
Windows) — run on the deployment host with system python3.
"""
import os
import signal
import sys
import time

if os.name != "posix":
    print("SKIP: POSIX-only probe")
    sys.exit(0)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from plane import timeout as timeout_mod

PASS, FAIL = 0, 0


def ok(desc):
    global PASS
    print("PASS: %s" % desc)
    PASS += 1


def no(desc):
    global FAIL
    print("FAIL: %s" % desc)
    FAIL += 1


def trap_and_sleep():
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    time.sleep(300)
    return "should-never-return"


def sleep_300():
    time.sleep(300)
    return "should-never-return"


def fast():
    return "done-42"


def main():

    t0 = time.monotonic()
    try:
        timeout_mod.run_in_process(trap_and_sleep, 3)
        no("trapper returned (must CallTimeout)")
    except timeout_mod.CallTimeout:
        dt = time.monotonic() - t0
        if dt < 30:
            ok("trapper CallTimeout in %.1fs (bounded escalation)" % dt)
        else:
            no("trapper took %.1fs (ladder too slow)" % dt)
    except Exception as e:  # noqa: BLE001
        no("trapper wrong exc: %r" % e)

    # 2. Cooperative sleeper dies on TERM.
    t0 = time.monotonic()
    try:
        timeout_mod.run_in_process(sleep_300, 3)
        no("sleeper returned (must CallTimeout)")
    except timeout_mod.CallTimeout:
        dt = time.monotonic() - t0
        if dt < 15:
            ok("sleeper CallTimeout in %.1fs (prompt TERM)" % dt)
        else:
            no("sleeper took %.1fs" % dt)
    except Exception as e:  # noqa: BLE001
        no("sleeper wrong exc: %r" % e)

    # 3. Fast child unaffected.
    try:
        out = timeout_mod.run_in_process(fast, 30)
        if out == "done-42":
            ok("fast child returns result, no kill")
        else:
            no("fast child wrong result: %r" % out)
    except Exception as e:  # noqa: BLE001
        no("fast child raised: %r" % e)

    # 4. No live worker children remain (reaped on every path).
    import multiprocessing
    live = multiprocessing.active_children()
    if not live:
        ok("no live worker children remain")
    else:
        no("leaked children: %r" % live)

    print("---")
    print("PASS=%d FAIL=%d" % (PASS, FAIL))
    sys.exit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
