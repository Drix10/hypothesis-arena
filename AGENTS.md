# AGENTS.md: session rules (pi harness)

1. Read `ARCHITECTURE.md` + `plan/00-INDEX.md` before any code change.
2. `plan/` is source of truth. Code implements plan; it never invents plan.
3. After every completed task: update `TODO.md` (check the box, add `[HUMAN]`
   or `[BLOCKED]` where needed). No "done in chat but not in TODO".
4. Never commit secrets: no API keys, X cookies, broker tokens, `.env`,
   or `STAGE` signatures. `old/.env`-style accidents must stay impossible.
5. No code until the relevant Phase-0 boxes in `plan/07-build-roadmap.md`
   are closed for that area.
6. Fail closed. Prefer HOLD / refuse / ask over expanding scope.
7. One commit, one theme: docs XOR one phase slice. Never "docs + C++ +
   agents" in a single commit.
8. If a task conflicts with `ARCHITECTURE.md` §6 or §8: stop and report.
   Do not work around it.
