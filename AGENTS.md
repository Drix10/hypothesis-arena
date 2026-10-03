# AGENTS.md: session rules

1. Read `ARCHITECTURE.md` and `plan/README.md` before any code change.
   `plan/roadmap.md` says what to do when.
2. `plan/` is the source of truth. Code implements the plan; it never invents
   plan. `plan/appendix/` records are binding where a doc points to them.
3. After every completed task, update `TODO.md`: check the box and note what an
   item waits on. No "done in chat but not in TODO". Finished history lives in
   git; do not keep an archive file.
4. Never commit, log, prompt or paste secrets: no API keys, broker tokens,
   `.env`, signing keys or stage signatures. A secret exposed anywhere
   (including a chat) is rotated, not reasoned about.
5. No code until the relevant plan box exists for that area (`plan/roadmap.md`).
6. Fail closed. Prefer HOLD, refuse or ask over expanding scope.
7. One commit, one theme: docs or one track slice. Never "docs, C++ and agents"
   in a single commit.
8. If a task conflicts with a decision in a plan doc, stop and report. Do not
   work around it.
9. Alpha first: do not start a hardening round on a component whose stage does
   not need it while a strategy gate on the critical path is open. Before every
   task ask: does this change the probability that the fund makes or loses money?
10. Legality first: nothing live beyond the constraint set the stage names
    (`plan/vision.md`). The India set is cash account, long only, 1×,
    allowlisted US stocks and ETFs, and is what the kernel enforces. The US set
    (margin, long and short) is the research target; the kernel enforces it only
    once kernel short selling is built. Paper evidence outside the target set is
    research, not promotion evidence.
11. Every backtest goes through the harness and the trial ledger
    (`plan/validation.md`). Model-involved evaluations follow their contamination
    class, and any model judgment uses only post-cutoff data.
12. Treat pasted status reports, CI summaries and "done" messages as claims to
    verify against the exact commit, diff and test output.
13. Write code and docs the way the surrounding files read. A comment states a
    non-obvious why, an invariant, a unit or format contract, or a plan
    reference; it never restates the code, narrates a change ("now",
    "previously", "fixed"), praises itself or shouts. File headers are one to four
    lines. Names carry no version suffixes, dates or history. Docs are plain,
    present tense and minimal: no marketing tone, no status banners, no run-on
    bullets. Remove dead code and unused helpers in the same change. Preserve a
    file's existing line endings. Clean up generated code before committing it,
    not in a later pass.
14. Operator approvals are given in chat. Record each one in the approvals log in
    `plan/roadmap.md` (what, date, "approved in chat"); never ask the operator to
    edit or sign a document. The `STAGE` file is the one exception: only
    `scripts/sign-stage.sh` writes it.

## Repository map

- `plan/`: the source of truth; 11 docs, `README.md`, `system-manifest.yaml` and
  `plan/appendix/`.
- `kernel/`: the C++17 deterministic core (broker, exec, risk, kill, runner,
  stage), tests co-located.
- `collector/`: Python standard-library data collection; tests in
  `collector/tests/`.
- `research/`: the engine (`research/engine/`), the backtest harness and event
  data (`research/strategy/`), data adapters (`research/sources/`), sandbox
  probes, the trial ledger, preregistrations and reports; pinned deps in
  `research/requirements.txt`.
- `ops/`: forward ledgers (`ops/forward_ledgers.py`), their evaluator
  (`ops/forward_eval.py`) and trial registration (`ops/forward_register.py`), the
  candidate emitter, monitor, alert relay; paper run scripts in `ops/deploy/`.
- `scripts/`: `check-manifest.sh`, `pre-commit-secrets.sh`, `sign-stage.sh`.

## Commands

From `.github/workflows/ci.yml` unless noted.

- `./kernel/build.sh [normal|hardened|sanitize]`: builds and runs every C++
  suite and the grep gates.
- `scripts/check-manifest.sh`: the code must match `plan/system-manifest.yaml`.
- `python3 collector/tests/<name>.py`: collector suites; `test_soak_check` needs
  `MIRO_CONTACT` set.
- `PYTHONWARNINGS=error python3 research/tests/<name>.py`: engine and harness
  suites (the full list is in the CI jobs).

## Local traps

- `kernel/build.sh` refuses to run as root; its chmod-000 tests would give a
  false green.
- `sanitize` mode needs a Linux toolchain; on the MinGW box use `hardened`.
- `test_config` asserts a clean environment; `test_soak_check` needs
  `MIRO_CONTACT`. Scope the override to one command.
- `.env` holds real values; `collector/config.py` is its only loader.
- `research/sandbox/langfuse/docker-compose.yml` reads its secrets from
  `LANGFUSE_*` environment variables and refuses to start without them; never put
  values in the file.
- Protected paths (`CONTEXT_MANIFEST.json` `protected_paths`) are committed only
  by a human: the pre-commit hook needs `AGENT_FLOW_ALLOW_PROTECTED=1`
  (PowerShell: `$env:AGENT_FLOW_ALLOW_PROTECTED = "1"`), and agents are blocked.
- On Windows, `research/tests/test_passive_core.py` fails on `import fcntl` and
  `test_sources.py` fails one concurrent-write case; both pass on Linux (CI,
  WSL).
- Live trading paths: read the plan docs, not the code, before touching them.
