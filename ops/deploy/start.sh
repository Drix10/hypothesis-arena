#!/bin/bash
# One-command start for the G0 paper run (Alpaca PAPER, zero capital).
#   bash ops/deploy/start.sh [loop_dir]     default loop_dir: ~/g0
#   bash ops/deploy/start.sh stop           stop the loop, emitter and shadow
# Builds a copy of the repo on the Linux filesystem (~/ha; the Windows mount
# cannot pass the kernel's chmod self-test), loads keys from .env, asks you to
# sign STAGE on a fresh directory, then starts the loop and the one-shot
# emitter and shadow. Logs go to <loop_dir>/logs.
set -e
cd "$(dirname "$0")/../.."
repo="$(pwd)"
build="$HOME/ha"

if [ "$1" = stop ]; then
    pkill -f "g0_paper_loop" || true
    pkill -f ops/emit_candidates.py || true
    pkill -f ops/jev_shadow.py || true
    echo stopped; exit 0
fi
dir="${1:-$HOME/g0}"

if pgrep -f g0_paper_loop >/dev/null; then
    echo "a g0_paper_loop is already running. Stop it first: bash ops/deploy/start.sh stop" >&2; exit 2
fi
if [ -f "$dir/journal.jsonl" ] && [ "$2" != --resume ]; then
    echo "$dir already holds a journal. Use a fresh directory (bash ops/deploy/start.sh ~/g1)," >&2
    echo "or continue this run with: bash ops/deploy/start.sh $dir --resume" >&2; exit 2
fi

envval() { grep -m1 "^$1=" .env 2>/dev/null | cut -d= -f2- | tr -d '\r"'; }
export ALPACA_KEY_ID="${ALPACA_KEY_ID:-$(envval ALPACA_KEY_ID)}"
export ALPACA_SECRET="${ALPACA_SECRET:-$(envval ALPACA_SECRET)}"
export OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-$(envval OPENROUTER_API_KEY)}"
[ -n "$ALPACA_KEY_ID" ] && [ -n "$ALPACA_SECRET" ] || { echo "ALPACA_KEY_ID/ALPACA_SECRET missing in .env" >&2; exit 2; }

echo "== build (copy in $build) =="
mkdir -p "$build"
tar --exclude=.git --exclude=data -C "$repo" -cf - . | tar -C "$build" -xf -
(cd "$build/kernel" && WITH_CURL=1 bash build.sh) 2>&1 | tail -5
[ -x "$build/kernel/g0_paper_loop" ] || { echo "build failed: no g0_paper_loop" >&2; exit 3; }

mkdir -p "$dir/logs"
[ -f "$dir/approved.json" ] || cp ops/deploy/approved.json.example "$dir/approved.json"
[ -f "$dir/STAGE" ] || bash scripts/sign-stage.sh "$dir"

nohup "$build/kernel/g0_paper_loop" "$dir" ops/deploy/session_calendar.json --ticks 0 --interval-s 60 >>"$dir/logs/loop.log" 2>&1 &
python3 ops/emit_candidates.py "$dir" >>"$dir/logs/emit.log" 2>&1 || echo "emitter failed, see $dir/logs/emit.log" >&2
if [ -n "$OPENROUTER_API_KEY" ]; then
    python3 ops/jev_shadow.py "$dir" >>"$dir/logs/shadow.log" 2>&1 || echo "shadow failed, see $dir/logs/shadow.log" >&2
fi
sleep 5
echo "running. live view: python3 ops/monitor.py $dir"
