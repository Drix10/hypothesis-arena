#!/bin/bash
# kill9-resume.sh — Phase-D deployment box 8 (§8.6 kill + resume).
#
# Real kill -9 DURING a graph run, then resume on the same thread:
#  1. worker runs epochs 1..40 (real 6-node graph, fake models, SQLite
#     checkpoints) in the background;
#  2. driver kills -9 mid-run;
#  3. a fresh worker resumes the SAME thread for the remaining epochs;
#  4. kill9_verify.py asserts: every epoch completed exactly once,
#     span_ids unique (no duplicate features), manifest holds one
#     committed bundle per epoch, reader resolves latest.
# The 7-day duration is NOT reproduced here (time-blocked, recorded);
# the kill/resume/no-dupe mechanism is identical at any run length.
# Exits 0 only if all asserts hold.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
VENV="$HERE/../.venv/Scripts/python"
if [ ! -x "$VENV" ]; then VENV="python3"; fi
D="C:/Users/ggdri/AppData/Local/Temp/k9run-$$"
mkdir -p "$D"
PROG="$D/progress.log"
N=40
echo "workdir: $D"

"$VENV" "$HERE/kill9_worker.py" "$D" 1 $N "$PROG" > "$D/run1.log" 2>&1 &
WPID=$!
while ! grep -q READY "$D/run1.log" 2>/dev/null; do sleep 1; done
echo "worker ready (pid $WPID); killing in ~12s"
sleep 12
kill -9 $WPID 2>/dev/null
wait $WPID 2>/dev/null
echo "worker killed with SIGKILL"
LAST=$(tail -n 1 "$PROG" 2>/dev/null || echo 0)
[ -z "$LAST" ] && LAST=0
echo "last completed epoch before kill: $LAST"
NEXT=$((LAST + 1))
if [ "$NEXT" -gt $N ]; then echo "run finished before kill; retry"; exit 2; fi
"$VENV" "$HERE/kill9_worker.py" "$D" "$NEXT" $N "$PROG" > "$D/run2.log" 2>&1
RC=$?
echo "resume attempt 1 exit: $RC"
if [ $RC -eq 0 ]; then
  echo "PASS: killed run resumed to completion on the same thread"
else
  # The kill landed mid-attempt: the resume records the ambiguity as
  # unknown-spend and aborts (fail-closed). Supervisor reconciles,
  # then a FRESH cycle covers the killed epoch (poisoned-abort
  # checkpoints are terminal by design — never auto-cleared).
  if grep -q "unknown-spend-pending" "$D/run2.log"; then
    echo "PASS: killed epoch's ambiguous spend blocks resume (fail-closed)"
  else
    echo "FAIL: resume aborted without unknown-spend evidence"; tail -n 5 "$D/run2.log"; exit 1
  fi
  "$VENV" "$HERE/kill9_reconcile.py" "$D" || exit 1
  FRESH_EPOCH=$NEXT "$VENV" "$HERE/kill9_worker.py" "$D" "$NEXT" $N "$PROG" > "$D/run3.log" 2>&1
  RC=$?
  echo "fresh-cycle resume exit: $RC"
  [ $RC -eq 0 ] || { echo "FAIL: fresh cycle did not complete after reconcile"; tail -n 5 "$D/run3.log"; exit 1; }
fi
"$VENV" "$HERE/kill9_verify.py" "$D" $N
