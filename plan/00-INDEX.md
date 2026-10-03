# AI Hedge Fund - Master Plan Index (freeze v4, 2026-10-02)

One folder. Everything lives here. If it is not in here, we do not build it.

The fund trades the slow spread of public information between linked
firms: an event at one company moves its suppliers, customers, peers and
co-mentioned firms over days to months, and the market prices those
links late. An AI engine builds the link graph from primary documents
and global news, finds the ripples, and proposes trades; deterministic
code sizes, risks, executes and exits them. Speed is not the edge;
reading and connecting is.

## Files (read in order)

1. `01-vision-and-scope.md` - thesis, operator path, constraint sets C1/C2,
   latency tiers, what we do not build.
2. `02-strategy-book.md` - the sleeves (L1-L4), controls, and the record
   of retired sleeves.
3. `03-jev-decision-layer.md` - the optional calibrated filter (JEV), one
   candidate-bound contract.
4. `04-cpp-deterministic-core.md` - the C++ kernel: processes, modules,
   data flow, latency budget, account ledger.
5. `05-risk-and-determinism.md` - R1-R20 hard rules per constraint set,
   measurement definitions, determinism contract, self-correction.
6. `06-execution-and-ops.md` - order lifecycle, execution by sleeve, cost
   model, settlement and margin operations, monitoring.
7. `07-build-roadmap.md` - the only document that says what to do when.
8. `08-epistemic-engine.md` - the Market Link Graph, event pipeline,
   ripple reasoning, verifier, isolation, feature contract, research
   factory.
9. `09-osint-and-free-data.md` - every source, ranked and licensed, with
   failure defaults; social-signal quarantine; data phases D1/D2.
10. `10-capital-gates-and-spend-control.md` - stages, jurisdiction gates,
    kill switches, AI spend control, path to outside capital.
11. `11-calibration-and-self-improvement.md` - validation standard,
    trial ledger, contamination control, calibration, promotion gate.
12. `12-statistical-baseline.md` - controls and benchmarks: frozen
    `baseline_v1` (negative control), cash, passive, reference book.
13. `13-cpp-kernel-build.md` - kernel build contract: boundary validator,
    slices, battle-testing ladder.
14. `14-market-link-mathematics.md` - the quantitative models: graph,
    shocks, propagation, lead-lag estimation, edge validation, portfolio
    construction, capacity.

Also: `system-manifest.yaml` (fingerprint code verifies against),
`appendix/` (frozen implementation records), `reviews/` (dated result
records; never authority).

## Rules of this folder

- If it is not in here, we do not build it. New idea → doc section first.
- Scope changes require editing doc 01 explicitly. No silent expansion.
- Each doc ends with "Locked decisions". They are final unless revisited
  deliberately, with the reason written down and the approval recorded in
  the doc 07 sign-off log.
- Doc 07 is the only file that says what to do when. Everything else says
  what things are.
- Docs 01-07 and 14 describe the trading system. Docs 08-11 describe the
  engine and the autonomy around it. Nothing in 08-11 may weaken a rule in
  01-07.
- One-way rule: the engine feeds the kernel typed features and nothing
  else. It never sizes, orders, vetoes, resumes, or promotes.
- Appendices are frozen records of accepted implementation contracts.
  They are binding where a doc points to them; they are not reading-order
  material.

## Global locked decisions

- Deterministic code owns sizing, risk, execution and exits. A
  pre-registered sleeve may take its direction from a verified LLM ripple
  hypothesis (doc 02 L3, doc 08 §8.4); the hypothesis is a typed feature,
  the sleeve engine turns it into a candidate by frozen rules, and no
  model output sizes, orders, or touches an exit.
- Alpha-first. No engineering beyond what the current stage needs until a
  sleeve has passed its gate (doc 11). Audit reopening follows the doc 06
  AUDIT STOP RULE classes only.
- Legality first. Live scope is what the operator may lawfully trade under
  the stage's constraint set (doc 01 §1.2: C1 cash, long only, 1× while
  India-resident; C2 US margin, long and short, after the move). Paper
  evidence counts toward promotion only if produced under that same set.
- Every LLM-involved evaluation is contamination-controlled (doc 11
  §11.0c): deterministic signals use history freely; span-verified,
  anonymized extraction may use history with a label; any LLM judgment of
  direction or outcome counts only after the model's knowledge cutoff plus
  an embargo.
- JEV (`typesafe/jev-1.13`, pinned, never floating): one contract,
  candidate-bound, optional. It is not required on the champion path.
- R1-R20 are code constants. Any change = doc edit + version bump + fresh
  paper window.
- The engine writes `features.jsonl` only (R11, OS-enforced). No broker
  keys, no journal/`HALT`/`STAGE` access. Untrusted text is read only by a
  reader tier with no code execution and no network (doc 08).
- No code path promotes a stage (R17). Demotion is automatic and unvetoable.
- Free data for core operation; paid data only on the doc 09 §9.1b
  trigger. Every non-price source starts CONTEXT/NULL. Social signals never
  trigger alone. Absent data is never neutral data.
- Controls are permanent: every sleeve is scored against cash, a
  vol-matched passive benchmark and the same sleeve without AI, net of all
  costs (doc 12); promotion needs positive spanning alpha against the
  reference book (doc 11 §11.3a). A losing AI layer is removed, not tuned.
- Exits survive everything: kills, outages, stale feeds, dead models,
  paused research. New risk stops; old risk stays managed; the system
  fails toward paper.
- Secrets never enter the repo, a log, a prompt, or a chat. A secret that
  was exposed anywhere is rotated.
