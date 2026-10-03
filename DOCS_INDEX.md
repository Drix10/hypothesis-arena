# Docs Index

> **Last full scan:** 2026-10-03
> **Total docs:** 30
> **Stale docs:** 0 (0%)

`plan/` is the source of truth; everything else describes the tree or the
work. Dates are each file's last commit.

---

## Active Docs

| Doc | Path | Status | Last Updated |
|-----|------|--------|-------------|
| Plan index and global decisions | `plan/00-INDEX.md` | current | 2026-10-03 |
| Vision, thesis, constraint sets | `plan/01-vision-and-scope.md` | current | 2026-10-03 |
| Strategy book (four sleeves) | `plan/02-strategy-book.md` | current | 2026-10-03 |
| JEV decision layer | `plan/03-jev-decision-layer.md` | current | 2026-10-03 |
| C++ deterministic core | `plan/04-cpp-deterministic-core.md` | current | 2026-10-03 |
| Risk and determinism (R1-R20) | `plan/05-risk-and-determinism.md` | current | 2026-10-03 |
| Execution and ops | `plan/06-execution-and-ops.md` | current | 2026-10-03 |
| Build roadmap and sign-off log | `plan/07-build-roadmap.md` | current | 2026-10-03 |
| Epistemic engine | `plan/08-epistemic-engine.md` | current | 2026-10-03 |
| Data sources and phases | `plan/09-osint-and-free-data.md` | current | 2026-10-03 |
| Capital gates and spend control | `plan/10-capital-gates-and-spend-control.md` | current | 2026-10-03 |
| Validation and promotion | `plan/11-calibration-and-self-improvement.md` | current | 2026-10-03 |
| Controls and benchmarks | `plan/12-statistical-baseline.md` | current | 2026-10-03 |
| Kernel build contract | `plan/13-cpp-kernel-build.md` | current | 2026-10-03 |
| Market link mathematics | `plan/14-market-link-mathematics.md` | current | 2026-10-03 |
| Codebase guide | `ARCHITECTURE.md` | current | 2026-10-03 |
| Project overview | `README.md` | current | 2026-10-03 |
| Open work ledger | `TODO.md` | current | 2026-10-03 |
| Session rules and repo map | `AGENTS.md` | current | 2026-10-03 |
| Claude Code entry (imports AGENTS.md) | `CLAUDE.md` | current | 2026-10-01 |
| Kernel module rules | `kernel/AGENTS.md` | current (re-verified 2026-10-03) | 2026-10-01 |
| Research module rules | `research/AGENTS.md` | current | 2026-10-03 |
| Paper run guide | `ops/deploy/README.md` | current | 2026-10-03 |

---

## Stale Docs (Needs Update)

None.

---

## Missing Docs

Areas with code but no module `AGENTS.md` (each is described in
`ARCHITECTURE.md`):

- `collector/` — frozen production poller and JEV sidecar (ARCHITECTURE §4).
- `ops/` — forward ledgers, evaluator, monitor, alert relay
  (ARCHITECTURE §6, `ops/deploy/README.md`).

---

## Archived Docs (records, read-only)

| Doc | Path | Superseded by |
|-----|------|---------------|
| X-lists signal system | `plan/appendix/02-x-lists-archive.md` | X is out of production; `plan/09` §9.1c tests X only as corroboration |
| Close ownership and recovery | `plan/appendix/06b-close-ownership-and-recovery-record.md` | still binding where `plan/06` §6.1b points to it |
| Ledger integrity and trust | `plan/appendix/08-ledger-integrity-and-trust-record.md` | still binding where `plan/08` §8.6 points to it |
| Collector environment-loading exception | `plan/appendix/09-collector-o7-exception.md` | historical; fix lives in `collector/config.py` |
| Retired-sleeve testing program | `plan/appendix/10-sleeve-integration-plan.md` | `plan/11` §11.2a; the retired sleeves' ledgers stopped 2026-10-03 |
| Retired-sleeve evidence review | `plan/appendix/11-sleeve-evidence-review.md` | `plan/01` §1.1 and `plan/02` |
| Alpha results review | `plan/reviews/2026-09-29-alpha-results.md` | `plan/02` §2.5 |

---

## Doc Lifecycle

1. **Draft** — written with the change it describes.
2. **Current** — matches the code; re-verified by `/repair-docs`.
3. **Stale** — the code moved after the doc; flagged by `/doctor`.
4. **Archived** — superseded; kept, never deleted.
