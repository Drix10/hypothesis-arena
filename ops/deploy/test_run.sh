#!/bin/bash
# run.sh stops the run when the supervisor dies, and only then.
# Uses a temp copy of run.sh with stub start.sh/check.py; nothing real is started.
set -um   # job control: background jobs keep default SIGINT handling
src="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/ops/deploy"
cp "$src/run.sh" "$tmp/ops/deploy/run.sh"
cat >"$tmp/ops/deploy/start.sh" <<'STUB'
#!/bin/bash
echo "$1" >>"$(dirname "$0")/calls.log"
STUB
cat >"$tmp/ops/deploy/check.py" <<'STUB'
import os, sys, time
mode = os.environ.get("CHECK_MODE", "hang")
if mode == "hang":
    time.sleep(60)
sys.exit(int(mode) if mode.isdigit() else 0)
STUB
fail=0
log="$tmp/ops/deploy/calls.log"
expect() {  # name want_stops want_rc got_rc
    local n; n="$(grep -c '^stop$' "$log" 2>/dev/null)"; n="${n:-0}"
    if [ "$n" = "$2" ] && { [ -z "$3" ] || [ "$3" = "$4" ]; }; then echo "PASS: $1"
    else echo "FAIL: $1 (stops=$n want $2, rc=$4 want ${3:-any})"; fail=1; fi
}
run() { : >"$log"; SETTLE_S=0 CHECK_MODE="$1" bash "$tmp/ops/deploy/run.sh" "$tmp/loop" 2>/dev/null; }
killed() {  # name settle_s signal
    : >"$log"
    SETTLE_S="$2" CHECK_MODE=hang bash "$tmp/ops/deploy/run.sh" "$tmp/loop" 2>/dev/null &
    local pid=$!
    sleep 1; kill -"$3" "$pid"; wait "$pid"; local rc=$?
    expect "$1" 1 "" "$rc"
}

run 0; expect "clean finish leaves the run alone" 0 0 $?
run 1; expect "FAIL stops exactly once" 1 1 $?
killed "SIGTERM during the watch stops the run once" 0 TERM
killed "SIGINT during the watch stops the run once" 0 INT
killed "SIGTERM during the settle sleep stops the run once" 30 TERM
exit $fail
