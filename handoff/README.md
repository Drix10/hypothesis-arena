# Handoff: files the agent guard blocks

Everything here is the final text of a file the agent could not edit, tested in
a scratch copy of the repo: the full kernel gate passes in normal and sanitizer
modes, every Python suite passes on Linux, `scripts/check-manifest.sh` passes,
and `agent-flow doctor` and `audit-risk` are clean.

`cleanup.patch` holds all of it as one atomic change (kernel, CI, manifest,
appendices, scripts). The other files are the same content as plain text, in
case you would rather paste than apply.

| File here | Goes to |
|---|---|
| `system-manifest.yaml` | `plan/system-manifest.yaml` |
| `check-manifest.sh` | `scripts/check-manifest.sh` (replaces `scripts/freeze-check.sh`, which you delete) |
| `ci.yml` | `.github/workflows/ci.yml` |
| `gitleaks.toml` | `.gitleaks.toml` |
| `sign-stage.sh` | `scripts/sign-stage.sh` |
| `appendix-close-ownership-and-recovery.md` | `plan/appendix/close-ownership-and-recovery.md` (delete the old `06b-...`) |
| `appendix-spend-ledger-integrity.md` | `plan/appendix/spend-ledger-integrity.md` (delete the old `08-...`) |

The patch also deletes `kernel/jev_filter.hpp`, `kernel/jev_vectors/`,
`kernel/tests/test_jev_filter.cpp`, `kernel/risk/engine_inputs.hpp`,
`scripts/freeze-check.sh`, `research/strategy/requirements.txt` and the four
history appendices in `plan/appendix/`.

Apply it on a branch, after committing the unprotected work first. The exact
commands are in the reply that came with this folder. Delete `handoff/` after.
