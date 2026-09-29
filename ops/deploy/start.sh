#!/bin/bash
# One-command start for the G0 paper run (Alpaca PAPER, zero capital).
#   bash ops/deploy/start.sh [loop_dir]      (default: ~/g0)
# Builds the kernel, loads keys from .env, signs STAGE on first run (interactive),
# then runs the loop, candidate emitter and (if OPENROUTER_API_KEY is set) the
# JEV shadow in the background. Logs: <loop_dir>/logs. Stop: bash ops/deploy/start.sh stop
set -e
cd "$(dirname "$0")/../.."
root="$(pwd)"
dir="${1:-$HOME/g0}"
if [ "$1" = stop ]; then dir="${2:-$HOME/g0}"; pkill -f "$root/kernel/g0_paper_loop" || true
    pkill -f ops/emit_candidates.py || true; pkill -f ops/jev_shadow.py || true; echo stopped; exit 0; fi

envval() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r"'; }
export ALPACA_KEY_ID="${ALPACA_KEY_ID:-$(envval ALPACA_KEY_ID)}"
export ALPACA_SECRET="${ALPACA_SECRET:-$(envval ALPACA_SECRET)}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$(envval OPENROUTER_API_KEY)}"
[ -n "$ALPACA_KEY_ID" ] && [ -n "$ALPACA_SECRET" ] || { echo "ALPACA_KEY_ID/ALPACA_SECRET missing in .env" >&2; exit 2; }

(cd kernel && WITH_CURL=1 bash build.sh) 2>&1 | tail -5
mkdir -p "$dir/logs"
[ -f "$dir/approved.json" ] || cp ops/deploy/approved.json.example "$dir/approved.json"
[ -f "$dir/STAGE" ] || bash scripts/sign-stage.sh "$dir"

nohup kernel/g0_paper_loop "$dir" ops/deploy/session_calendar.json --ticks 0 --interval-s 60 >"$dir/logs/loop.log" 2>&1 &
nohup python3 ops/emit_candidates.py "$dir" >"$dir/logs/emit.log" 2>&1 &
if [ -n "$OPENROUTER_API_KEY" ]; then
    nohup python3 ops/jev_shadow.py "$dir" >"$dir/logs/shadow.log" 2>&1 &
fi
sleep 5
echo "running. watch: tail -f $dir/logs/loop.log"
