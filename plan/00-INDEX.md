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
8. `08-agentic-research-plane.md` — the autonomous research plane: framework choice, agent topology, isolation boundary, runaway limits.
9. `09-osint-and-free-data.md` — every free information source, ranked by edge/latency/noise, with TRIGGER/CONTEXT/NULL classes.
10. `10-capital-gates-and-spend-control.md` — capital stages, kill-switch hierarchy, AI spend circuit breakers.
11. `11-calibration-and-self-improvement.md` — calibration scoring, shadow challengers, the promotion gate.

## Rules of this folder

- If it's not in here, we don't build it. New idea → add a doc section first, then build.
- Scope changes require editing `01-vision-and-scope.md` explicitly. No silent expansion.
- Each doc ends with "Locked decisions" — those are final unless revisited deliberately.
- `07-build-roadmap.md` is the only file that says what to do when. Everything else says what things are.
- Docs 01–07 describe the trading system. Docs 08–11 describe the autonomy around
  it: what researches, what may spend, what may escalate capital, and what may
  change the system. Nothing in 08–11 may weaken a rule in 01–07.
- One-way rule: the research plane (08) feeds the hot path (04) typed features and
  nothing else. It never sizes, orders, vetoes, resumes, or promotes.

## Global locked decisions (one page, no exceptions)

- C++ owns every decision that can lose money. Agents produce evidence, never orders.
- JEV (`typesafe/jev-1.13`, pinned, never floating) is the sole calibrator: 4
  questions, banded table, raw probability never acts alone.
- R1–R17 are code constants. Any change = doc edit + version bump + fresh paper window.
- Research writes `features.jsonl` only (R11, OS-enforced). No broker keys, no
  journal/`HALT`/`STAGE` access. `LocalPythonExecutor` forbidden near capital.
- No code path promotes a stage (R17). Demotion is automatic and unvetoable.
- Free data only. Every non-price source starts CONTEXT/NULL; TRIGGER needs
  measured hit-rate + human sign-off. Absent data is never neutral data.
- The statistical baseline is permanent. The AI layer beats it net of cost or is
  removed, not tuned.
- Exits survive everything: kills, outages, stale feeds, dead JEV, paused research.
  New risk stops; old risk stays managed; the system fails toward paper.
