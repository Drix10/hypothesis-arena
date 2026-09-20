# Phase E — dependency audit vs P3.5 D–H1 (pre-D gate, no code)

Question: did the pre-D research contracts (Phase B) or the Phase 2.5
plane (Phase D) change any interface a future slice depends on?

## D (kill/switch.cpp) needs: STAGE semantics, kill semantics, exit
## liveness, journal/exec contracts.
- Doc 10 untouched. Journal/exec untouched. Case 29 is table-test-only.
  §11.1a affects calibration measurement, never authorization.
  The plane writes features.jsonl only (frozen f2). VERDICT: no impact.

## E (STAGE chain) needs: D-compatible cycle boundaries, STAGE verify.
- Doc 10 §10.1 untouched. The plane never touches STAGE (R17; proven by
  write-confinement: every writer byte lands inside outdir).
  VERDICT: no impact.

## F (feed/broker.cpp) needs: broker/feed contracts, R6/R7 freshness,
## outage semantics.
- §13.7 assigns F the feed-gap injection gate (new test, no contract
  change). R6/R7 frozen text untouched. Tier-A evidence measured
  behavior, changed nothing. VERDICT: no impact.

## G (ctx/context.cpp) needs: bundle producer, ingest C, frozen context
## contract, research_revision, calibration state.
- The writer FILLS the previously missing producer slot against the
  unchanged frozen reader — gap closed, contract unchanged (round-trip
  proven through read_bundle). Ingest C untouched. research_revision
  untouched. Calibration state gains H (default infinity = zero
  behavior change) + a harness-time config identity (regime-def
  version, H, weighting-rule version). VERDICT: compatible; harness
  must carry the three identity fields when implemented.

## H1 (exec/router + log/journal) needs: snapshot, risk output, kill
## state, STAGE state, broker/feed state, journal contract.
- None of these interfaces were touched by Phase B or D.
  VERDICT: no impact.

## Frozen-behavior check
- `git diff` since pre-D shows zero changes under kernel/, collector/,
  plan/ from Phase D work (new research-plane/ tree only).
- No contract received a silent patch; none needed versioning.

## Open deployment boxes (not interface changes)
- OS users + setpriv isolation run, Docker egress-proxy probe, image
  digest pin + SBOM/scan, self-hosted Langfuse server tailing spans,
  FRED/ALFRED keys, Tier B/C harvest wiring, 7-day unattended run.

## Addendum — human re-audit of Phase D (17 findings, corrected)
- The original Phase E claim of "no design blockers" was overstated.
  The audit found the implementation weaker than the reported invariants
  in: bundle identity (watermarks/history now hashed), fsync
  fail-closedness, manifest/reader integration (read_latest added),
  symlink containment, worker completeness (real CodeAgent path wired;
  live Docker execution stays a deployment box), ConfigBlocked mapping,
  R15 at all LLM nodes, abort->no-emit enforcement, cadence durability,
  health-window semantics + recovery, attribution idempotency,
  resolver canonical kind, checkpoint caps, scanner scope wording,
  dependency pins, FRED verify-before-READY, calendar scope wording.
- All corrected in `6965b89` + `49ecb65` with regression coverage for
  each (changed-watermark re-emit, symlink entry, read_latest path,
  kind relabel, abort-no-publish, hypothesize cap trip, cadence
  restart, health recovery, span dedupe, caps, dynamic imports).
- Interface conclusion unchanged: no D–H1 contract changed.

## Addendum 2 — independent 32-finding end-to-end audit (closed)
- A second audit (run against `6965b89`+`49ecb65`) found the first
  pass had strengthened wrappers/tests without closing every
  end-to-end invariant. All 32 closed in `a921934` with one
  regression proof each (see TODO record): manifest/span/cadence
  concurrency, newest-valid fallback, snapshot consumption, real
  invocation-boundary metering (model+executor+tools), token
  reservation/reconciliation, timeout accounting + kill primitive,
  durable budgets, abort short-circuit, success-only cadence,
  ledger-schema attribution, retention + deserialization hardening,
  pre-materialization caps, producer-side 64-cap, lineage IDs,
  parser-confidence, map binding, canonical validation, correct
  smolagents controls, pre-execution scan, locked sandbox spec,
  pinned image, digest writer, trigger input, history propagation,
  supervisor health contract.
- Deliberately left as DEPLOYMENT boxes (no daemon/keys on this
  host): live Docker execution, egress-proxy deny probe, image
  SBOM/scan, model pricing table (usd recorded as 0.0/unpriced until
  wired), supervisor process kill at WALL_S (in-process watchdog is
  the secondary guard). The code fails closed (ConfigBlocked) on all
  of them; nothing claims to be operationally complete without them.
