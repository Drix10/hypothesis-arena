# AGENTS.md: session rules (pi harness)

1. Read `ARCHITECTURE.md` + `plan/00-INDEX.md` before any code change.
   `plan/07-build-roadmap.md` explains why the plan looks the way it does.
2. `plan/` is source of truth. Code implements plan; it never invents plan.
   `plan/appendix/` records are binding where a doc points to them.
3. After every completed task: update `TODO.md` (check the box, add
   `[HUMAN]` or `[BLOCKED]` where needed). No "done in chat but not in TODO".
   Finished history lives in git; do not keep an archive file.
4. Never commit, log, prompt, or paste secrets: no API keys, broker tokens,
   `.env`, signing keys, or stage signatures. A secret exposed anywhere
   (including a chat) is rotated, not reasoned about.
5. No code until the relevant plan box exists for that area (doc 07).
6. Fail closed. Prefer HOLD / refuse / ask over expanding scope.
7. One commit, one theme: docs XOR one track slice. Never "docs + C++ +
   agents" in a single commit.
8. If a task conflicts with a plan locked decision: stop and report. Do not
   work around it.
9. Alpha-first (doc 06 AUDIT STOP RULE): do not start a hardening round
   on a component whose stage does not need it while a strategy gate on
   the critical path is open. Ask "does this change the probability the
   fund makes or loses money?" before every task.
10. Legality first: nothing live beyond cash-account, long-only, 1×,
    allowlisted US stocks/ETFs (doc 01 §1.2, R18/R19). Paper evidence that
    violates the live constraint set is research, not promotion evidence.
11. Every backtest goes through the harness and the trial ledger
    (doc 11 §11.0a). LLM-involved evaluations use only post-cutoff data
    (doc 11 §11.0c).
12. Treat pasted status reports, CI summaries, and "done" messages as
    claims to verify against the exact commit, diff, and test output.
13. Write code and docs the way the surrounding files read. A comment states
    a non-obvious why, an invariant, a unit or format contract, or a plan
    reference; it never restates the code, narrates a change ("now",
    "previously", "fixed"), praises itself, or shouts. File headers are one to
    four lines. Docs are plain, present tense and minimal: no marketing tone,
    no status banners, no run-on bullets. Remove dead code and unused helpers
    in the same change. Preserve a file's existing line endings. Clean up
    generated code before committing it, not in a later pass.
14. Operator approvals are given in chat. Record each one in the doc 07 sign-off
    log (what, date, "approved in chat"); never ask the operator to edit or sign
    a document. The STAGE file is the one exception: only
    `scripts/sign-stage.sh` writes it (rule 4, doc 10 §10.1).
