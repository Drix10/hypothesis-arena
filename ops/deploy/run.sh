#!/bin/bash
# Start a fresh paper run and babysit it: check every 5 minutes, and on a FAIL
# stop everything and print the reason. Nothing to type or read while it runs.
#   bash ops/deploy/run.sh [loop_dir]          default ~/g0-YYYYmmdd-HHMM
# Flatten the account first if needed: bash ops/deploy/reset_paper.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
dir="${1:-$HOME/g0-$(date +%Y%m%d-%H%M)}"
bash ops/deploy/start.sh "$dir" || exit $?
sleep 120                       # let the first entries settle before judging
python3 ops/deploy/check.py "$dir" --watch 300
rc=$?
if [ "$rc" -ne 0 ]; then
    bash ops/deploy/start.sh stop
    echo "run stopped: the FAIL above is the bug to fix. Evidence is in $dir (journal.jsonl, alerts.jsonl, logs/)." >&2
fi
exit $rc
