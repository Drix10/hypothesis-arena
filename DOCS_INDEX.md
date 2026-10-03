# Docs Index

`plan/` is the source of truth; everything else describes the tree or the work.

## Active Docs

| Doc | Path |
|-----|------|
| Plan index and global decisions | `plan/README.md` |
| Vision, thesis, constraint sets | `plan/vision.md` |
| Strategies | `plan/strategies.md` |
| Engine | `plan/engine.md` |
| Data sources | `plan/data.md` |
| Market link mathematics | `plan/math.md` |
| Risk rules and determinism | `plan/risk.md` |
| Kernel | `plan/kernel.md` |
| Execution and operations | `plan/execution.md` |
| Stages, kill switches, spend control | `plan/stages.md` |
| Validation and promotion | `plan/validation.md` |
| Roadmap and approvals log | `plan/roadmap.md` |
| Codebase guide | `ARCHITECTURE.md` |
| Project overview | `README.md` |
| Open work checklist | `TODO.md` |
| Session rules and repo map | `AGENTS.md` |
| Claude Code entry (imports AGENTS.md) | `CLAUDE.md` |
| Kernel module rules | `kernel/AGENTS.md` |
| Research module rules | `research/AGENTS.md` |
| Paper run guide | `ops/deploy/README.md` |

## Missing Docs

Areas with code but no module `AGENTS.md` (each is described in `ARCHITECTURE.md`):

- `collector/`: the production poller (ARCHITECTURE section 4).
- `ops/`: forward ledgers, evaluator, monitor, alert relay (ARCHITECTURE section 6, `ops/deploy/README.md`).

## Appendix records

Binding implementation records in `plan/appendix/`, referenced from the plan docs.
