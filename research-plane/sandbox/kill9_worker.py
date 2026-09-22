#!/usr/bin/env python3
"""kill9_worker.py — Phase-D deployment box 8 (kill -9 resume demo).

Builds the real 6-node graph with the repo's fake models/executors (no
model key needed) and runs run_cycle for epochs [START..END] on one
thread, fsync-appending each completed epoch to a progress file.
Same thread resumes after a kill -9: LangGraph SQLite checkpoints
continue at the last completed node; span_id UNIQUE + idempotent
appends guarantee no duplicate features.

Usage: kill9_worker.py <dir> <start_epoch> <end_epoch> <progress_file>
Prints READY once the app is built (driver starts its kill timer then).
Exit nonzero with the failing epoch on stdout if a cycle aborts.
"""
import os
import sys

TESTS = os.path.dirname(os.path.abspath(__file__))
TESTS = os.path.join(os.path.dirname(TESTS), "tests")
sys.path.insert(0, TESTS)
ROOT = os.path.dirname(TESTS)
sys.path.insert(0, ROOT)

import test_plane as T  # noqa: E402
from plane import graph as G  # noqa: E402


def main():
    d, start, end, prog = (sys.argv[1], int(sys.argv[2]),
                           int(sys.argv[3]), sys.argv[4])
    # FRESH_EPOCH: run this epoch under a fresh thread (post-reconcile
    # fresh cycle for the killed epoch; the poisoned-abort checkpoint
    # is terminal by design — fail-closed is never auto-cleared).
    fresh = int(os.environ.get("FRESH_EPOCH", "-1"))
    prefix = os.environ.get("THREAD_PREFIX", "k9")
    t = T.GraphTest()
    if not os.path.exists(os.path.join(d, "entity_map.json")):
        T._fixtures(d)
    app, deps, calls, log, gov = t._app(d, script="thesis-AAPL")
    print("READY", flush=True)
    for e in range(start, end + 1):
        # One thread per epoch (production: cycle_id per run). A single
        # thread across epochs would exhaust its LLM_CALLS budget by
        # design (fail-closed); resume reuses the interrupted epoch's
        # own thread, which is exactly the §8.6 resume property.
        tag = "k9r" if e == fresh else prefix
        out = G.run_cycle(app, ["AAPL"], e, "%s-%d" % (tag, e))
        if out.get("aborted") or not out.get("emitted"):
            print("ABORT epoch %d blocked=%r" % (e, out.get("blocked")),
                  flush=True)
            sys.exit(3)
        with open(prog, "a", encoding="utf-8") as fh:
            fh.write("%d\n" % e)
            fh.flush()
            os.fsync(fh.fileno())
    print("DONE %d..%d" % (start, end), flush=True)


if __name__ == "__main__":
    main()
