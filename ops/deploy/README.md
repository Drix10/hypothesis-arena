# Paper run (local, WSL)

One runner, Alpaca paper only. The transport is hard-wired to
`paper-api.alpaca.markets`, so nothing here can touch a live account.

## Requirements

Ubuntu 24.04 in WSL (g++ 13, libcurl 7.85 or newer). Ubuntu 22.04 does not
build: its g++ 11 and libcurl 7.81 fail on `settle.hpp` and the transport.

```bash
sudo apt install -y g++ libcurl4-openssl-dev python3
```

## Build

Run as a normal user; `build.sh` refuses root.

```bash
cd /mnt/c/Users/ggdri/Downloads/hypothesis-arena/kernel
WITH_CURL=1 bash build.sh
```

It must print `P3.1 GATE (normal): PASS`.

## Keys and loop directory

The loop reads `ALPACA_KEY_ID` and `ALPACA_SECRET` from the environment only.
Keep the loop directory on the Linux filesystem, not under `/mnt/c`: the runner
takes a directory lock that Windows-mounted folders handle unreliably.

```bash
cd /mnt/c/Users/ggdri/Downloads/hypothesis-arena
export ALPACA_KEY_ID=$(grep -m1 '^ALPACA_KEY_ID=' .env | cut -d= -f2- | tr -d '\r"')
export ALPACA_SECRET=$(grep -m1 '^ALPACA_SECRET=' .env | cut -d= -f2- | tr -d '\r"')
mkdir -p ~/g0
cp ops/deploy/approved.json.example ~/g0/approved.json
```

`approved.json` lists the approved sleeves (with their freshness window) and
the instrument allowlist. The runner refuses to start without a valid `STAGE`
in the loop directory: copy the signed file there, or write one with
`bash scripts/sign-stage.sh ~/g0`.

## Run

Terminal 1, the loop:

```bash
kernel/g0_paper_loop ~/g0 ops/deploy/session_calendar.json --ticks 0 --interval-s 60
```

Terminal 2, once per session day (US session 19:00-01:30 IST):

```bash
python3 ops/emit_candidates.py ~/g0
```

It writes at most one candidate per symbol per month. The loop consumes a line
on its next tick and holds it if the market is closed, so emit during the
session only.

Optional JEV shadow (needs `OPENROUTER_API_KEY`; logs only, blocks nothing):

```bash
python3 ops/jev_shadow.py ~/g0
```

One pass over new candidates; writes `~/g0/jev_shadow.jsonl` with what JEV
answered and a hypothetical `would_block`. It never touches the journal,
candidates or STAGE. Spend caps still apply. With only the passive sleeve
this shows the plumbing works, not whether JEV helps.

- Holidays come from `ops/deploy/session_calendar.json` (2026-2028). Extend it
  before the last listed year ends; the loop refuses to trade in a year with no
  listed holiday.
- Stop with Ctrl-C. Exit 2 (refused) or 3 (HARD stop) means: read
  `~/g0/journal.jsonl` and `~/g0/alerts.jsonl` before starting again.
- `ops/alert_relay.py` forwards `alerts.jsonl` to `ALERT_WEBHOOK_URL`. It is
  optional.
