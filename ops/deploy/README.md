# Paper run (local, WSL)

One runner, Alpaca paper only. The transport is hard-wired to
`paper-api.alpaca.markets`, so nothing here can touch a live account.

Python commands run from the repo root in WSL. The kernel builds and runs
from `~/ha` (next section).

## Quick path (the exact steps)

From the repo root in WSL, one terminal. Needs the packages in
Requirements and `ALPACA_KEY_ID` / `ALPACA_SECRET` in the repo `.env`
(`OPENROUTER_API_KEY` is optional and enables the log-only JEV shadow).

1. `git pull`
2. In the Alpaca paper dashboard, close any open positions and cancel open
   orders. The kernel refuses to buy a symbol it already holds, and positions
   from an older run carry no stop. `start.sh` checks this and refuses to
   start otherwise.
3. `bash ops/deploy/start.sh ~/g2` (use a new directory name for each run).
   It works in this order:
   - preflight: the paper account answers and holds no positions
   - asks you to type the STAGE phrase once for the new directory (be at the
     keyboard: it asks straight away)
   - builds a copy of the repo in `~/ha` and runs the kernel gate (a few
     minutes; a failed build stops the script)
   - waits for the US session to open (it checks every 30 s), then emits the
     month's candidates. The loop drops a candidate that arrives while the
     market is closed, so the emitter refuses to run outside the session
   - starts the loop in the background (`~/g2/loop.pid`, log in
     `~/g2/logs/loop.log`), then runs the JEV shadow once
4. Watch it: `python3 ops/monitor.py ~/g2` (Ctrl+C closes the view only). A
   position with no resting sell order shows `NO STOP` in red. The Alpaca paper
   dashboard shows the same orders and positions.
5. Stop it: `bash ops/deploy/start.sh stop`. The loop finishes its tick and
   releases its lock.

Keep one WSL window open and the laptop awake and plugged in for the whole
run. If the loop dies (reboot, WSL shut down), do not start a second one on
the same directory:

```bash
cat ~/g2/loop.pid; ps -p "$(cat ~/g2/loop.pid)"     # not running means it is gone
tail -5 ~/g2/logs/loop.log                          # why it stopped
ALLOW_POSITIONS=1 bash ops/deploy/start.sh ~/g2 --resume   # rebuilds, continues the same directory
```

The emitter writes at most one candidate per symbol per month (New York
month). Run it again by hand in the first session of each month while the loop
is running: `python3 ops/emit_candidates.py ~/g2 --require-open`.

The manual steps below do the same thing one command at a time.

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
mkdir -p ~/g2
[ -f ~/g2/approved.json ] || cp ops/deploy/approved.json.example ~/g2/approved.json
```

`approved.json` lists the approved sleeves (with their freshness window) and
the instrument allowlist. The runner refuses to start without a valid `STAGE`
in the loop directory. That file is written only by a human, in person:

```bash
bash scripts/sign-stage.sh ~/g2
```

## Run

Terminal 1, the loop (from `~/ha`):

```bash
kernel/g0_paper_loop ~/g2 ops/deploy/session_calendar.json --ticks 0 --interval-s 60
```

Terminal 2, the emitter, once per session day (US session, from the repo
root):

```bash
python3 ops/emit_candidates.py ~/g2
```

It writes at most one candidate per symbol per month. The loop consumes a
line on its next tick and holds it if the market is closed, so emit during
the session only.

Optional JEV shadow (needs `OPENROUTER_API_KEY`; logs only, blocks nothing):

```bash
python3 ops/jev_shadow.py ~/g2
```

One pass over new candidates; writes `~/g2/jev_shadow.jsonl` with what JEV
answered and the filter verdict it would have given (PASS or HOLD plus
reason). It never touches the journal, candidates or STAGE. Spend caps still
apply. With only the passive sleeve this shows the plumbing works, not
whether JEV helps.

Sleeve shadow ledgers (started automatically by `start.sh`, log-only): virtual
$100k books for the 60/40 core, trend (T1) and sector momentum (T2), one
hash-chained row per session in `~/g2/sleeves/`, shown in the monitor. They
place no orders. Check that history reproduces (the fidelity gate) any time:

```bash
python3 ops/sleeve_shadow.py ~/g2 --verify
```

The insider (E1) and intraday (I1) sleeves are in the same ledger. The first
E1 run downloads SEC quarterly insider data sets into `~/g2/event_cache` (up to
3 per hourly pass), so its rows start after about two passes. Pass `--no-events`
to skip them. PEAD is not wired (its registered signal has no forward data
source). Exit 1 means a logged row can no longer be reproduced (look-ahead or revised
data). Optional macro/filing collector (nothing reads its output yet):
`WITH_COLLECTOR=1 bash ops/deploy/start.sh ~/g2`. Plan and promotion rules: `plan/appendix/10-sleeve-integration-plan.md`.

On a Linux-native checkout, `bash ops/deploy/start.sh` automates the same
steps (build, first-run STAGE sign-off, loop, emitter, shadow);
`bash ops/deploy/start.sh stop` stops them.

## Live view

Terminal 3, the monitor (from the repo root). Read-only: it never writes to
the loop directory and never places orders.

```bash
python3 ops/monitor.py ~/g2
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
tail -f ~/g2/logs/loop.log
```

- Holidays come from `ops/deploy/session_calendar.json` (2026-2028). Extend
  it before the last listed year ends; the loop refuses to trade in a year
  with no listed holiday.
- Stop a foreground loop with Ctrl-C, a background one with
  `pkill -f g0_paper_loop`. Exit 2 (refused) or 3 (HARD stop) means: read
  `~/g2/journal.jsonl` and `~/g2/alerts.jsonl` before starting again.
- `ops/alert_relay.py` forwards `alerts.jsonl` to `ALERT_WEBHOOK_URL`. It is
  optional.
