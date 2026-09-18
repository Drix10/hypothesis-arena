# AI Hedge Fund — Master Plan Index

One folder. Everything lives here. No code until the plan is complete.

## Files (read in order)

1. `01-vision-and-scope.md` — what we are building, what we are NOT building. Locked scope.
2. `02-twitter-alpha-system.md` — the X-Lists knowledge/signal feed (from Twitter-Gemini pipeline).
3. `03-jev-decision-layer.md` — JEV Decisions API: every question, threshold, mapping.
4. `04-cpp-hft-architecture.md` — the C++ system: processes, modules, data flow, latency budget.
5. `05-risk-and-determinism.md` — risk limits, vetoes, determinism, self-correction. Hard rules.
6. `06-execution-and-ops.md` — execution, journaling, ops rhythm, monitoring.
7. `07-build-roadmap.md` — phased build order with exit criteria per phase.

## Rules of this folder

- If it's not in here, we don't build it. New idea → add a doc section first, then build.
- Scope changes require editing `01-vision-and-scope.md` explicitly. No silent expansion.
- Each doc ends with "Locked decisions" — those are final unless revisited deliberately.
- `07-build-roadmap.md` is the only file that says what to do when. Everything else says what things are.
