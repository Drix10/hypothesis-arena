# Paper run (local, WSL)

One runner, Alpaca paper only. The transport is hard-wired to
`paper-api.alpaca.markets`, so nothing here can touch a live account.

Python commands run from the repo root in WSL. The kernel builds and runs
from `~/ha` (next section).

## Requirements

Ubuntu 24.04 in WSL (g++ 13, libcurl). Ubuntu 22.04 does not build: its
g++ 11 and libcurl 7.81 fail on `settle.hpp` and the transport.

```bash
sudo apt install -y g++ libcurl4-openssl-dev python3
```

## Build tree

The repo folder sits on a Windows mount where `chmod` is not a read
barrier, so one fail-closed self-test trips there. Build on the Linux
filesystem instead (from the repo root):

```bash
mkdir -p ~/ha && git archive HEAD | tar -x -C ~/ha
cd ~/ha/kernel && WITH_CURL=1 bash build.sh
```

Run the build as a normal user; `build.sh` refuses root. It must print
`KERNEL GATE (normal): PASS`. Re-sync `~/ha` the same way after every
`git pull`.

## Keys and loop directory

The loop reads `ALPACA_KEY_ID` and `ALPACA_SECRET` from the environment
only. Keep the loop directory on the Linux filesystem: the runner takes a
directory lock that Windows-mounted folders handle unreliably.

```bash
export ALPACA_KEY_ID=$(grep -m1 '^ALPACA_KEY_ID=' .env | cut -d= -f2- | tr -d '\r"')
export ALPACA_SECRET=$(grep -m1 '^ALPACA_SECRET=' .env | cut -d= -f2- | tr -d '\r"')
mkdir -p ~/g0
[ -f ~/g0/approved.json ] || cp ops/deploy/approved.json.example ~/g0/approved.json
```

`approved.json` lists the approved sleeves (with their freshness window) and
the instrument allowlist. The runner refuses to start without a valid `STAGE`
in the loop directory. That file is written only by a human, in person:

```bash
bash scripts/sign-stage.sh ~/g0
```

## Run

Terminal 1, the loop (from `~/ha`):

```bash
kernel/g0_paper_loop ~/g0 ops/deploy/session_calendar.json --ticks 0 --interval-s 60
```

Terminal 2, the emitter, once per session day (US session, from the repo
root):

```bash
python3 ops/emit_candidates.py ~/g0
```

It writes at most one candidate per symbol per month. The loop consumes a
line on its next tick and holds it if the market is closed, so emit during
the session only.

Optional JEV shadow (needs `OPENROUTER_API_KEY`; logs only, blocks nothing):

```bash
python3 ops/jev_shadow.py ~/g0
```

One pass over new candidates; writes `~/g0/jev_shadow.jsonl` with what JEV
answered and the filter verdict it would have given (PASS or HOLD plus
reason). It never touches the journal, candidates or STAGE. Spend caps still
apply. With only the passive sleeve this shows the plumbing works, not
whether JEV helps.

On a Linux-native checkout, `bash ops/deploy/start.sh` automates the same
steps (build, first-run STAGE sign-off, loop, emitter, shadow);
`bash ops/deploy/start.sh stop` stops them.

## Live view

Terminal 3, the monitor (from the repo root). Read-only: it never writes to
the loop directory and never places orders.

```bash
python3 ops/monitor.py ~/g0
```

Refreshes every 3 s; Ctrl-C closes it without touching the loop. Flags:
`--once` prints one frame and exits, `--interval N` sets the refresh,
`--no-broker` skips the Alpaca panel.

One screen shows: loop liveness, seconds since the last tick, tick totals
and any error lines; incoming candidates with entry, stop, take-profit and
risk per share; kernel decisions with proceed/hold, veto reason, quantity
and size limiter; the order journal with its hash-chain check, row counts
and latest rows; JEV shadow verdicts, marked log-only; and the Alpaca paper
account (market state, equity, cash, buying power, positions with P/L,
recent orders). The broker panel reads keys from the environment or the repo
`.env`.

## Watch and stop

```bash
tail -f ~/g0/logs/loop.log
```

- Holidays come from `ops/deploy/session_calendar.json` (2026-2028). Extend
  it before the last listed year ends; the loop refuses to trade in a year
  with no listed holiday.
- Stop a foreground loop with Ctrl-C, a background one with
  `pkill -f g0_paper_loop`. Exit 2 (refused) or 3 (HARD stop) means: read
  `~/g0/journal.jsonl` and `~/g0/alerts.jsonl` before starting again.
- `ops/alert_relay.py` forwards `alerts.jsonl` to `ALERT_WEBHOOK_URL`. It is
  optional.
