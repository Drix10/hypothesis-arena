#!/bin/bash
# Start a fresh paper run and babysit it: check every 5 minutes, and on a FAIL
# stop everything and print the reason. Nothing to type or read while it runs.
#   bash ops/deploy/run.sh [loop_dir]          default ~/g0-YYYYmmdd-HHMM
# Flatten the account first if needed: bash ops/deploy/reset_paper.sh
# If this supervisor is killed (EXIT/INT/TERM) before the watch ends, the run is stopped.
set -uo pipefail
cd "$(dirname "$0")/../.."
dir="${1:-$HOME/g0-$(date +%Y%m%d-%H%M)}"
bash ops/deploy/start.sh "$dir" || exit $?

settled=0       # 1 once the watch has ended and the run is handled (or deliberately left running)
child=
cleanup() {
    [ -n "$child" ] && kill "$child" 2>/dev/null
    if [ "$settled" -eq 0 ]; then
        settled=1
        bash ops/deploy/start.sh stop
        echo "supervisor ended early: run stopped. Evidence is in $dir (journal.jsonl, alerts.jsonl, logs/)." >&2
    fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Background + wait: bash runs a trap right away during wait, not after a foreground child ends.
sleep "${SETTLE_S:-120}" &      # let the first entries settle before judging
child=$!
wait "$child"
python3 ops/deploy/check.py "$dir" --watch 300 &
child=$!
wait "$child"
rc=$?
child=
settled=1
if [ "$rc" -ne 0 ]; then
    bash ops/deploy/start.sh stop
    echo "run stopped: the FAIL above is the bug to fix. Evidence is in $dir (journal.jsonl, alerts.jsonl, logs/)." >&2
fi
exit $rc
