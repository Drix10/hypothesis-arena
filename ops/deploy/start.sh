#!/bin/bash
# One-command start for the paper run (Alpaca PAPER, zero capital).
#   bash ops/deploy/start.sh [loop_dir] [--resume]    default loop_dir: ~/g0
#   bash ops/deploy/start.sh stop
# Order of work: preflight (keys, flat account), STAGE sign-off, build a copy of
# the repo on the Linux filesystem (~/ha), wait for the US session to open,
# emit candidates, start the loop and the forward ledgers.
# Logs: <loop_dir>/logs. Pid: <loop_dir>/loop.pid.
set -euo pipefail
cd "$(dirname "$0")/../.."
repo="$(pwd)"
build="$HOME/ha"
loop_bin="$build/kernel/g0_paper_loop"

if [ "${1:-}" = stop ]; then
    pkill -f "^$loop_bin " || true
    pkill -f "ops/forward_ledgers.py" || true
    pkill -f "collector/soak.py" || true
    echo stopped; exit 0
fi
dir="${1:-$HOME/g0}"
resume=0; [ "${2:-}" = --resume ] && resume=1

case "$dir" in /mnt/*) echo "keep the loop directory on the Linux filesystem (for example ~/g2), not $dir" >&2; exit 2;; esac
if pgrep -f "^$loop_bin " >/dev/null; then
    echo "a g0_paper_loop is already running. Stop it first: bash ops/deploy/start.sh stop" >&2; exit 2
fi
if [ -f "$dir/journal.jsonl" ] && [ "$resume" = 0 ]; then
    echo "$dir already holds a journal. Use a fresh directory (bash ops/deploy/start.sh ~/g3)," >&2
    echo "or continue this run with: bash ops/deploy/start.sh $dir --resume" >&2; exit 2
fi

envval() {  # KEY from .env: tolerates BOM, CRLF, export, spaces, quotes, trailing comments
    [ -f .env ] || return 0
    sed -e '1s/^\xEF\xBB\xBF//' -e 's/\r$//' .env \
        | sed -n -E "s/^(export[[:space:]]+)?$1[[:space:]]*=[[:space:]]*//p" | head -1 \
        | sed -E "s/[[:space:]]+#.*\$//; s/[[:space:]]+\$//; s/^\"(.*)\"\$/\1/; s/^'(.*)'\$/\1/"
}
export ALPACA_KEY_ID="${ALPACA_KEY_ID:-$(envval ALPACA_KEY_ID)}"
export ALPACA_SECRET="${ALPACA_SECRET:-$(envval ALPACA_SECRET)}"
[ -n "$ALPACA_KEY_ID" ] && [ -n "$ALPACA_SECRET" ] || { echo "ALPACA_KEY_ID/ALPACA_SECRET missing in .env" >&2; exit 2; }

echo "== preflight =="
alpaca_get() {
    curl -fsS -m 15 -H "APCA-API-KEY-ID: $ALPACA_KEY_ID" -H "APCA-API-SECRET-KEY: $ALPACA_SECRET" \
        "https://paper-api.alpaca.markets$1"
}
unreachable() { echo "Alpaca paper is not reachable or the keys are refused" >&2; exit 2; }
positions="$(alpaca_get /v2/positions)" || unreachable
orders="$(alpaca_get '/v2/orders?status=open&limit=500')" || unreachable
if [ "${ALLOW_POSITIONS:-0}" != 1 ]; then
    if [ "$positions" != "[]" ]; then
        echo "the paper account holds positions with no stop from this run. Close them (and cancel open orders)" >&2
        echo "in the Alpaca paper dashboard first, or run with ALLOW_POSITIONS=1 to accept that." >&2; exit 2
    fi
    if [ "$orders" != "[]" ]; then
        echo "the paper account has open or working orders. Cancel them in the Alpaca paper dashboard first," >&2
        echo "or run with ALLOW_POSITIONS=1 to accept that." >&2; exit 2
    fi
fi
echo "account reachable, no open positions or orders"

mkdir -p "$dir/logs" "$dir/backup"
[ -f "$dir/approved.json" ] || cp ops/deploy/approved.json.example "$dir/approved.json"
[ -f "$dir/STAGE" ] || bash scripts/sign-stage.sh "$dir"

echo "== build (copy in $build; a few minutes) =="
rm -f "$loop_bin"
mkdir -p "$build"
tar --exclude=.git --exclude=data -C "$repo" -cf - . | tar -C "$build" -xf -
if ! (cd "$build/kernel" && WITH_CURL=1 bash build.sh) >"$dir/logs/build.log" 2>&1; then
    tail -30 "$dir/logs/build.log" >&2; echo "build failed, see $dir/logs/build.log" >&2; exit 3
fi
tail -2 "$dir/logs/build.log"
[ -x "$loop_bin" ] || { echo "build produced no g0_paper_loop" >&2; exit 3; }

echo "== waiting for the US session, then emitting candidates =="
while true; do
    python3 ops/emit_candidates.py "$dir" --require-open >>"$dir/logs/emit.log" 2>&1 && break
    rc=$?
    if [ "$rc" -ne 3 ]; then tail -5 "$dir/logs/emit.log" >&2; echo "emitter failed, see $dir/logs/emit.log" >&2; exit 4; fi
    echo "market closed, checking again in 30s ($(date +%H:%M:%S))"; sleep 30
done
tail -1 "$dir/logs/emit.log"

setsid nohup "$loop_bin" "$dir" ops/deploy/session_calendar.json --ticks 0 --interval-s 60 \
    </dev/null >>"$dir/logs/loop.log" 2>&1 &
echo $! > "$dir/loop.pid"
sleep 5
kill -0 "$(cat "$dir/loop.pid")" 2>/dev/null || { tail -5 "$dir/logs/loop.log" >&2; echo "the loop exited at once" >&2; exit 5; }
echo "loop running (pid $(cat "$dir/loop.pid")). live view: python3 ops/monitor.py $dir"
# Forward shadow ledgers for the non-routed strategies (log-only, no orders).
setsid nohup python3 ops/forward_ledgers.py "$dir" --loop </dev/null >>"$dir/logs/ledgers.log" 2>&1 &
echo "strategy shadow ledgers running (log: $dir/logs/ledgers.log, data: $dir/ledgers/)"
# Optional: macro/filing collector (writes only repo data/, nothing reads it yet).
if [ "${WITH_COLLECTOR:-0}" = "1" ]; then
    setsid nohup python3 collector/soak.py --loop </dev/null >>"$dir/logs/collector.log" 2>&1 &
    echo "collector running (log: $dir/logs/collector.log)"
fi
