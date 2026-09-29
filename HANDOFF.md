# Handoff to a local Claude Code session

State on 2026-09-29, `main` at `fc4b774` (PR #1 merged). 30 of 57 roadmap boxes
are done; `TODO.md` is the source of truth for the rest.

## What exists

- **Kernel** (`kernel/`): candidate validator, sizing, veto with R18/R19, always-take
  decision path, settlement book, Snapshot v2, libcurl Alpaca paper transport,
  WebSocket trade updates, OTO stop-only and MOC adapter shapes, paper decision
  loop (`g0_paper_loop`), journal size cap. Full gate green.
- **Drills that run without a market**: transport fault suite (31 checks),
  WebSocket suite (11 + 13), loop drills against a loopback mock venue (24),
  compressed soak (`kernel/tests/soak_mock.py`).
- **Research** (`research/strategy/`): trial ledger (N=19), harness, five sleeves
  measured (T1, E1, E2-det, T2, I1), all failed the A-gate. Passive core sleeve
  and emitter for the plumbing run (`ops/`).
- **Deploy package** (`ops/deploy/`): systemd units, `approved.json.example`,
  2026-2028 session calendar. `scripts/sign-stage.sh` is human-run.

## Set up locally

Requirements: Linux or WSL2 (the gate needs a non-root user), `g++` 11+,
`libcurl4-openssl-dev`, Python 3.11, git.

```bash
git clone https://github.com/Drix10/hypothesis-arena && cd hypothesis-arena
cp .env.example .env   # then fill keys (see below)
chmod 600 .env
```

`.env` is gitignored. Put fresh paper keys there (`ALPACA_KEY_ID`,
`ALPACA_SECRET`) plus `OPENROUTER_API_KEY`, `FRED_API_KEY`, `BEA_USER_ID`,
`MIRO_CONTACT` if you run the collector or the research fetchers. Rotate every key
that was pasted in chat first (TODO O6).

Verify the checkout (all must pass):

```bash
WITH_CURL=1 bash kernel/build.sh          # as a non-root user; ends "P3.1 GATE (normal): PASS"
bash kernel/build.sh sanitize             # ASan and UBSan
bash scripts/freeze-check.sh              # FREEZE-CHECK: PASS
git clean -fdq -n kernel                  # dry run: lists build binaries only; never delete sources
for t in research/tests/test_*.py; do PYTHONWARNINGS=error python3 $t || echo "FAIL $t"; done
```

`.github/workflows/ci.yml` lists the exact CI commands; hosted CI is the
reference result. Some tests need the pinned dependencies in `research/requirements.txt` and
`research/strategy/requirements.txt`.

## What is left

**Needs an open US session and your paper account**

1. Run the live drill once during market hours (13:30-20:00 UTC):

   ```bash
   g++ -std=c++17 -O1 -o /tmp/drill kernel/broker/live_drill.cpp kernel/broker/http_curl.cpp \
       kernel/broker/alpaca_paper.cpp kernel/broker/adapter.cpp kernel/broker/ws_stream.cpp -lcurl
   (set -a; . ./.env; set +a; /tmp/drill)
   ```

   It buys 1 SPY share with an OTO stop, tries a sell and an MOC while the stop leg
   reserves the share, and flattens. Record the output. It decides whether Alpaca
   accepts a sell with a resting stop; if it rejects, the exit path must cancel the
   stop first (router change), and the trend profile stays on brackets until then.
   Then update K1, K5, K10 in `TODO.md` and `plan/06-execution-and-ops.md`.
2. Run the loop drills on live paper the same way (the mock versions are in
   `kernel/tests/e2e_mock_venue.py`).

**Needs a machine that stays on**

3. K9: 24 hour soak of `g0_paper_loop` on paper, then the 30 day passive-core run
   (`ops/deploy/README.md`).

**Needs you**

4. Sign the freeze-v3 text (R4), rotate credentials (O6), write `approved.json`,
   sign STAGE with `scripts/sign-stage.sh` (G0-STAGE). Nothing trades without it.

**Engineering, not started**

5. Track P (research plane): deferred because no sleeve passed an A-gate. Needs
   Docker workers and an LLM budget to verify.
6. A0/A1/A6-A9, G0a shadow, G1-P port: blocked on a sleeve that passes. New alpha
   needs new information (pre-2016 prices, ticker history mapping, measured
   fills and quotes), not more variants on the same data.
7. K-exit closes when K1, K5, K10 are done.

## Rules for the local session

Follow `AGENTS.md`. In particular:

- Never print, log or commit `.env` contents. Never create or sign a STAGE file.
- One commit, one theme; docs and code in separate commits. Update `TODO.md` after
  each task.
- `git clean` deletes untracked sources: `git add` new files first, and clean only
  build binaries.
- Run `kernel/build.sh` as a non-root user; the chmod-000 tests are meaningless as root.
- Backtests go through the harness and the trial ledger. A sleeve run is one look at
  its holdout; a dry run must not print performance.
- The system libcurl has no WebSocket support, so `kernel/broker/ws_stream.cpp` carries
  its own framing; do not swap in `curl_ws_*`.
- Live scope is cash account, long only, 1x, allowlisted US stocks and ETFs.

## Starter prompt for Claude Code

Paste this in a session opened at the repository root:

```text
You are continuing work on this repo. Read HANDOFF.md, AGENTS.md, ARCHITECTURE.md
and plan/00-INDEX.md first, then TODO.md.

1. Verify the checkout: run `WITH_CURL=1 bash kernel/build.sh` as a non-root user,
   `bash kernel/build.sh sanitize`, `bash scripts/freeze-check.sh`, and every
   research/tests/test_*.py with PYTHONWARNINGS=error. Report exact pass counts and
   any failure with its output. Fix real failures with a minimal change.
2. If the US market is open, build and run kernel/broker/live_drill.cpp as described
   in HANDOFF.md. Never print the contents of .env. Record the findings in
   TODO.md (K1, K5, K10) and plan/06-execution-and-ops.md. If Alpaca rejects a
   sell while the OTO stop is live, implement the router change (cancel the stop,
   then close) with a drill in kernel/exec/test_drills.cpp and a loop scenario in
   kernel/tests/e2e_mock_venue.py.
3. Then pick the next open item in TODO.md that is not marked [HUMAN] or [BLOCKED]
   and that passes the alpha-first check in AGENTS.md rule 9. Work in small
   commits, one theme each, gate green before every commit, TODO.md updated.
4. Do not sign STAGE, write approved.json, or touch credentials. Stop and ask when
   a task needs a human step.
```
