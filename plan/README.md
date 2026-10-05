# Plan

One folder holds the whole plan. If it is not in here, we do not build it.

The fund trades the slow spread of public information between linked firms. An
event at one company moves its suppliers, customers, peers and co-mentioned
firms over days to months, and the market prices those links late. An engine
builds the link graph from primary documents and global news; one strategy,
`connected_drift`, turns the graph signals into trades; deterministic code sizes,
risks, executes and exits them. Speed is not the edge; reading and connecting is.

## Files

Read in this order.

1. `vision.md`: thesis, operator path, constraint sets, venue, what we do not
   build.
2. `strategies.md`: the one strategy, `connected_drift`, its controls and portfolio
   construction.
3. `engine.md`: the link graph, isolation and feature contract; the event
   pipeline, ripple reasoning and research factory are parked.
4. `data.md`: every source, ranked and licensed, with failure defaults; free and
   paid data.
5. `math.md`: the quantitative models behind the engine and strategies.
6. `risk.md`: the hard risk rules per constraint set, determinism and
   self-correction.
7. `kernel.md`: the C++ kernel: processes, modules, data flow, latency budget,
   build order.
8. `execution.md`: order lifecycle, execution by strategy, the cost model,
   account operations, outages and monitoring.
9. `stages.md`: stages, jurisdiction check, kill switches, model spend control
   and the path to outside capital.
10. `validation.md`: the validation standard, trial ledger, contamination
    control, gates and promotion.
11. `roadmap.md`: what to do when, plus the approvals log.

Also: `system-manifest.yaml` (the fingerprint the code verifies against) and
`appendix/` (binding implementation records).

## Rules of this folder

- If it is not in here, we do not build it. A new idea starts as a doc section.
- Scope changes edit `vision.md` explicitly. No silent expansion.
- Each doc ends with its decisions. They are final unless revisited
  deliberately, with the reason written down and the approval recorded in the
  roadmap's approvals log.
- `roadmap.md` is the only file that says what to do when. Everything else says
  what things are.
- `engine.md`, `data.md`, `stages.md` and `validation.md` never weaken a rule in
  `risk.md`, `kernel.md` or `execution.md`.
- One-way rule: the engine feeds the kernel typed features and nothing else. It
  never sizes, orders, vetoes, resumes or promotes.
- Appendices are accepted implementation contracts. They are binding where a doc
  points to them and are not reading-order material.
- Docs state the plan as it is meant to be built. Whether code matches is
  tracked in `TODO.md`, not in the plan.

## Global decisions

- Deterministic code owns sizing, risk, execution and exits. A pre-registered
  strategy may take its direction from a verified model ripple hypothesis; the
  hypothesis is a typed feature, the strategy engine turns it into a candidate by
  fixed rules, and no model output sizes, orders or touches an exit.
- Alpha first. No engineering beyond what the current stage needs until a
  strategy has passed its gate. Audit reopening follows the audit stop rule in
  `execution.md`.
- Legality first. Live scope is what the operator may lawfully trade under the
  stage's constraint set (`vision.md`: the India set is cash, long only, 1× while
  India-resident; the US set is a US margin account, long and short, after the
  move). Paper evidence counts toward promotion only if produced under that same
  set.
- Every model-involved evaluation is contamination-controlled
  (`validation.md`): deterministic signals use history freely; span-verified,
  anonymized extraction may use history with a label; any model judgment of
  direction or outcome counts only after the model's knowledge cutoff plus an
  embargo.
- The risk rules are code constants. Any change is a doc edit and a fresh paper
  window.
- The engine writes `features.jsonl` only, enforced by the operating system. It
  has no broker keys and no access to the journal, `HALT` or stage files.
  Untrusted text is read only by a reader tier with no code execution and no
  network (`engine.md`).
- No code path promotes a stage. Demotion is automatic and unvetoable.
- Free data while the fund has no income; paid data on the trigger in
  `data.md`, and by the operator's decision once the fund earns.
  Every non-price source starts as CONTEXT or NULL. Social signals never trigger
  alone. Absent data is never neutral data.
- Controls are permanent: every strategy is scored against cash, a
  volatility-matched passive benchmark and the same strategy without its model
  component, net of all costs; promotion needs positive spanning alpha against the
  reference book (`validation.md`). A losing model layer is removed, not tuned.
- Exits survive everything: kills, outages, stale feeds, dead models, paused
  research. New risk stops; old risk stays managed; the system fails toward
  paper.
- Secrets never enter the repo, a log, a prompt or a chat. A secret that was
  exposed anywhere is rotated.
