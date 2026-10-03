# kernel/

C++17 deterministic core. Order path: `kernel/exec/`, `kernel/broker/`, `kernel/kill/`, `kernel/risk/`; a human edits these.

- `./kernel/build.sh` is the gate (normal, hardened, sanitize). Exit 0 is PASS; it refuses to run as root. `WITH_CURL=1` adds the libcurl transport.
- Ingest and risk code is zero-malloc; `kernel/ingest/test_noalloc.cpp` proves it. Do not add allocations there.
- `kernel/log/` writes a hash-chained journal before every order; `kernel/stage/` verifies the `STAGE` file.
- Stages are `PAPER`, `TINY`, `SCALED` and `FULL` (`plan/stages.md`).
- `kernel/risk/` still implements an earlier rule set (a three-position cap, forex, per-stage leverage). It differs from `plan/risk.md`; `TODO.md` lists the rewrite. Do not extend the forex paths.
- The kernel names rules by number. `plan/risk.md` names them:

| Code | Rule | Code | Rule |
|---|---|---|---|
| R1 | `max_positions` | R10 | `ai_spend` |
| R2 | `position_size`, `total_exposure` | R11 | `research_isolation` |
| R3 | `daily_fills` | R12 | `no_lookahead` |
| R4 | `flip_lock` | R14 | `conflicts_never_size_up` |
| R5 | `drawdown` | R15 | `research_caps` |
| R6 | `volatility` | R16 | `kill_switches` |
| R7 | `correlation` | R17 | `no_auto_promotion` |
| R9 | `sessions_and_compliance` | R18 | `account_rule` |
| R19 | `allowlist` | R20 | `short_controls` |
