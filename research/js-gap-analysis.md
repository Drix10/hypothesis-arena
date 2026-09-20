# Jane Street gap analysis (post-P1.4 research memo, no code)

Read: Real-world ML pt1 (full), Battle-tested (core sections), Datafetcher
project summary, Incremental (risk-computation sections), market-data teach-in
index. Not a copy guide: steal principles, not scale. Status of each item is
against hypothesis-arena at P1.4-close (C++ core not yet built).

## 1. Satisfied (keep enforcing)

- **Replayability as auditability.** Our rule ("cannot replay the information,
  cannot audit the decision") matches their Datafetcher/replayability
  philosophy. Proven: replay-determinism check passes on isolated re-runs.
- **Deterministic classification before models.** Their "domain knowledge
  before models" maps to our rules_v1-first pipeline. No LLM in P1.3 stands.
- **Data quality over model cleverness.** Malformed/schema gate, header-anchored
  items, amendment honesty contract — this is their "clean the data" step,
  and we treat it as load-bearing, as they recommend.
- **Record conservation.** inputs = unique + dupes + revisions, checked per
  audit. Their "missing data is gone forever" warning is why signals.jsonl is
  append-only and SQLite is truth.

## 2. Specified but unimplemented (scheduled work, now pressure-tested)

- **Battle-testing ladder.** Our P1.3 tests (replay, concurrent-write,
  future-timestamp matrix) are their unit/state-machine tier. Missing tiers
  for the C++ core build: simulated networking (delay/drop packets),
  QuickCheck-style randomized event orderings, version-skew, fuzz on parsers,
  chaos restarts. Phase 3 must include the simulated-network tier, not just
  veto unit tests.
- **Incremental risk computation.** R1-R17 are specified as constants/table;
  their Incremental lesson is that portfolio-risk is a DAG over
  market+portfolio+config state that must update efficiently per tick. Our
  C++ risk/ module should be structured as that DAG from day one, not as a
  flat checklist that later needs rewriting.
- **Production feedback as dangerous data.** Their warning (own trades become
  training data; market adapts) must be written into doc 11 explicitly:
  HOLD counterfactuals exist, but live fills must be tagged as
  self-influenced outcomes in calibration, never neutral market truth.

## 3. Genuinely missing (new work items)

- **Wrong-data detection.** Their footnote-1 class (valid-looking data, wrong
  stock / outside market hours / frozen feed presented as live) is NOT covered
  by our schema gate, which validates shape, not market plausibility. P1.5/Phase 2
  needs a plausibility tier: session-aware freshness, cross-source corroboration
  for TRIGGER promotion, frozen-feed detection (identical values across TTL).
- **Regime/change treatment.** They model regime change explicitly; our
  calibration slices per regime but nothing detects regime shifts or decays
  old evidence (their sequence-weighting work is the pointer). Baseline_v1 is
  static. Add: evidence half-life / regime tags before any live sizing.
- **Model-mistake containment.** Their deploy question ("ensure a predictive
  model's mistakes aren't catastrophic") is our R-gates for JEV, but there is
  no stated bound on correlated JEV error (all 4 answers wrong together).
  Add a joint-error stress case to the 28-case suite.
- **Data lineage for research features.** Provenance covers signals; when the
  research plane starts emitting features.jsonl, each feature needs the same
  hash-chained lineage back to canonical rows, or replayability breaks at the
  exact layer where LLM prose enters.

## Priority (impact order)

1. Plausibility tier (data integrity) — before research plane emits features.
2. Self-influenced outcome tagging (statistical validity) — before calibration
   scores its first live fills.
3. Incremental risk DAG shape (execution correctness) — at C++ core start.
4. Battle-testing ladder (operational reliability) — alongside Phase 3.
5. Regime/weighting + joint-error case (portfolio risk) — before G1.

## Explicit non-goals

No OCaml, no Antithesis-scale infra, no 2.3TB/day pipeline. Our scale is
official-data polls + broker feed; the principles transfer, the tooling does not.
