# AI Hedge Fund - Master Plan Index (freeze v3, 2026-09-28)

One folder. Everything lives here. If it is not in here, we do not build it.

Freeze v3 keeps every safety contract and adds three things: a legally
tradable scope for the operator, a measurable alpha pipeline, and the
shortest path into the paper loop.

## Files (read in order)

1. `01-vision-and-scope.md` - what we build, what we do not, operator
   jurisdiction, venue, latency tiers (why this is not HFT and what is).
2. `02-strategy-book.md` - strategy book: alpha sleeves. The filename is
   legacy; the X-lists archive is `appendix/02-x-lists-archive.md`.
3. `03-jev-decision-layer.md` - JEV: the single candidate-bound
   contract; JEV is an optional challenger-grade filter.
4. `04-cpp-deterministic-core.md` - the C++ kernel: processes, modules,
   data flow, latency budget, always-take path, cash-account ledger.
5. `05-risk-and-determinism.md` - R1–R19 hard rules, measurement
   definitions, determinism contract, self-correction.
6. `06-execution-and-ops.md` - order lifecycle, execution by sleeve, TCA,
   cash settlement, ops rhythm, monitoring.
7. `07-build-roadmap.md` - the only document that says what to do when.
8. `08-agentic-research-plane.md` - live research plane (reader tier) +
   offline research factory; isolation; runaway limits; feature contract.
9. `09-osint-and-free-data.md` - every free source, ranked, licensed,
   with failure defaults; research datasets (SIP history, FRED, EDGAR).
10. `10-capital-gates-and-spend-control.md` - stages, jurisdiction gate,
    kill switches, AI spend control.
11. `11-calibration-and-self-improvement.md` - validation standard,
    trial ledger, contamination control, calibration, promotion gate.
12. `12-statistical-baseline.md` - controls and benchmarks: frozen
    `baseline_v1` (negative control), cash, passive vol-matched.
13. `13-cpp-kernel-build.md` - Phase-3 build record + P3.5 remaining scope.

Also: `system-manifest.yaml` (fingerprint code verifies against),
`appendix/` (implementation records, frozen; `appendix/10-sleeve-integration-plan.md`
is the live operating plan for sleeve tiers and g2 gates),
`reviews/` (result reviews; never authority).

## Rules of this folder

- If it is not in here, we do not build it. New idea → doc section first.
- Scope changes require editing doc 01 explicitly. No silent expansion.
- Each doc ends with "Locked decisions". They are final unless revisited
  deliberately, with the reason written down.
- Doc 07 is the only file that says what to do when. Everything else says
  what things are.
- Docs 01–07 describe the trading system. Docs 08–11 describe the autonomy
  around it. Nothing in 08–11 may weaken a rule in 01–07.
- One-way rule: the research plane feeds the kernel typed features and
  nothing else. It never sizes, orders, vetoes, resumes, or promotes.
- Appendices are frozen records of accepted implementation contracts.
  They are binding where a doc points to them; they are not reading-order
  material.

## Global locked decisions

- Deterministic code owns every decision that can lose money. Agents
  produce evidence, research, and code proposals, never orders.
- Alpha-first. No engineering beyond what the current stage needs
  until a strategy sleeve has passed its gate (doc 11). Audit reopening
  follows the doc 06 AUDIT STOP RULE classes only.
- Legality first. Live scope is what the operator may lawfully trade:
  US-listed equities and ETFs, cash account, long only, 1× (doc 01,
  R18/R19, doc 10 jurisdiction gate). Paper evidence counts toward
  promotion only if produced under that same constraint set.
- LLMs are used where evidence says they can help: the offline research
  factory, typed extraction from primary documents, and (optionally) a
  calibrated filter that must prove a paired delta. No LLM output
  originates direction at the execution boundary.
- LLM evidence is time-gated: any evaluation involving a model's output
  uses only data after that model's pinned knowledge cutoff plus an
  embargo (doc 11). Data timestamps are guarded by R12; model memory is
  guarded by this rule.
- JEV (`typesafe/jev-1.13`, pinned, never floating): one contract,
  candidate-bound. JEV is not required on the champion path.
- R1–R19 are code constants. Any change = doc edit + version bump +
  fresh paper window.
- Research writes `features.jsonl` only (R11, OS-enforced). No broker keys,
  no journal/`HALT`/`STAGE` access. Untrusted text is read only by a
  reader tier with no code execution and no network (doc 08).
- No code path promotes a stage (R17). Demotion is automatic and unvetoable.
- Free data only for core operation. Every non-price source starts
  CONTEXT/NULL. Absent data is never neutral data.
- Controls are permanent: every sleeve is scored against cash, a
  vol-matched passive benchmark, and the same sleeve without AI, net of
  all costs (doc 12). A losing AI layer is removed, not tuned.
- Exits survive everything: kills, outages, stale feeds, dead JEV,
  paused research. New risk stops; old risk stays managed; the system
  fails toward paper.
- Secrets never enter the repo, a log, a prompt, or a chat. A secret that
  was exposed anywhere is rotated.
