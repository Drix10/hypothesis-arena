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

## Addendum 3 — independent 26-finding end-to-end audit (closed)
- A third audit (against `a921934`) found the forced-boundary gaps:
  hypothesize/critique are now pure build/parse callables with the
  graph performing every provider call through required gated models;
  cycle identity is run-scoped (thread_id); the budget ledger is
  SQLite with leases and fail-closed corruption; the token ceiling is
  hard (downward max_tokens clamp + post-call breach abort);
  timeouts invalidate budget rows and executors clean up in finally;
  provider egress is pinned to the deployment proxy via explicit
  httpx transport (Client(proxy=...) was found silently ignored and
  is not used); the doc-10 spend governor (stage caps + tiers +
  pricing-required) gates every LLM node; attribution uses the doc-10
  category taxonomy with a separate outcome field and insert-gated
  mirrors; the thesis/digest/freshness ordering is digest-first;
  producer-side 16-symbol, watermark, and history validation;
  verify-before-seen manifests; constructed-and-verified strict
  checkpoint serde; single-run guard; iteration ceilings; raw-record
  validation; graph-stamped origin; leak-free locks. Closed in
  `aaa8ecd` with one regression proof each (see TODO record).
- plan/08 §8.4 corrected: partial in-memory/checkpoint state may
  exist, but NO partial bundle is published (was: ambiguous
  "partial features kept").
## Addendum 4 — independent 23-finding correction pass (closed agent-side, NOT signed off)
- A fourth audit (against `aaa8ecd`) found the money/boundary claims
  incomplete: no per-call dollar reservation, tier behavior/projection
  not matching the frozen doc-10 text, ambiguous spend recorded as $0,
  factory bypass structurally possible, token ceiling post-call only,
  ledger deletion/integrity gaps, accounting failures downgradable,
  thread-watchdog production boundary, plus 9 P1 publisher/validation
  gaps and 4 P2 storage/concurrency/evidence gaps. Closed across
  `790374d` (gate + ledgers), `851725a` (tiers + publisher), `c3ea793`
  (battery), `ab92bf0` (CI) — see TODO record for the per-finding
  disposition. Kernel/collector zero-diff throughout.
- Architecture after the pass: the graph holds NO model object (the
  module-level provider_factory runs only inside the spawned worker
  child); every call reserves TRUE token bounds (prompt utf-8 bytes
  under the documented byte-BPE assumption + 1500/step clamp + the
  agentic closed-form bound) and worst-case dollars (worst-leg
  pricing, single governor-owned table) BEFORE spawn; ambiguous
  outcomes settle FULL reservations as UNKNOWN_SPEND and deny future
  spend until supervisor `reconcile_unknown`; timeouts hard-kill and
  reap the child (no live workers, no late accounting — the child
  never held ledger authority); any post-call accounting failure
  aborts hard. Tiers implement the frozen §10.4 table exactly
  (T1 double-interval + critique-trigger-only + NULL-suspend; T2
  cheapest + 200-cap + watchlist-2 + SOFT-kill signal; T3 deny +
  MEDIUM-kill signal) on the 7-day projection with hourly journaled
  evaluation and 6-hour anti-flap. New frozen mechanism constants
  live in plan/10 §10.4.1.
- Trust boundaries stated plainly: provider factories and price
  tables are supervisor-owned config (a lying factory is a
  compromised deployment, same class as a lying price); markers
  distinguish fresh deploys from deleted authorities (supervisor
  fresh-start = delete DB + marker together); total directory wipe
  equals a new deployment (accepted, documented).
- Remaining DEPLOYMENT boxes (fail-closed without them): Docker
  daemon + egress-proxy probe, image SBOM/scan, model key, supervisor
  WALL_S kill, Langfuse tail, trailing-90d profit feed (ratio
  suspended without it), per-symbol calibration feed (watchlist-2
  falls back deterministic without it). CI workflow added
  (stdlib + plane + kernel); first hosted run pending on push.
  Slice D NOT AUTHORIZED. Phase D is NOT marked closed — this
  record awaits the human re-audit.

## Addendum 5 — 32-finding final hardening pass (closed agent-side, NOT signed off)
- A final audit (against `151000a`) found authorization/accounting/
  lifecycle defects beneath the prior claims: TOCTOU dollar race,
  model/pricing identity split, undercounted tool-growth bound with
  no per-call pre-provider fit proof, unsafe marker folding,
  crash-partial unknown states, unreconcilable zero-price blocks,
  swallowed post-call accounting, Queue.empty() IPC, pre-provider
  construction ordering, unbounded repr/IPC/result/generator/
  manifest/digest growth, fail-open tier defaults, row-counted
  ratio, implicit governors, driftable pricing, weak span identity,
  cross-lease settlement, publisher/reader trust, signal/hook
  semantics, journal/state splits, lifecycle proof, control-plane
  and numeric validation, dead helpers, stale docs, and local-only
  CI. Closed across `45996e9` (atomic spend + identity + markers +
  recovery), `1c4d0d2` (token budget + child-first validation +
  bounded outputs + deterministic IPC), `a2780ae` (producer ceilings
  + mandatory governor + sole pricing + signal durability),
  `cc1beac` (publisher/manifest/reader/digest + tier/ratio
  battery), `1af480a` (numerics/dead-code/lifecycle/CI) — every fix
  proven through the actual graph → worker → budget →
  attribution/spend → publish path with a live regression, never by
  isolated-helper test alone. Kernel/collector zero-diff throughout.
- Batteries: plane 105 + hardening 55 + emit 19 + isolation +
  sources green (venv), stdlib subset green on system python;
  kernel re-green normal+hardened (83/83, 161/161, 78/78, NOALLOC),
  freeze-check PASS, CTX/JEV pass, evidence pristine, diff-check
  clean. CI workflow now pins permissions + timeouts and runs the
  hardening suite; the first hosted run is pending (this push).
  Slice D NOT AUTHORIZED. Phase D is NOT marked closed — this
  record awaits the human re-audit against the shipped tree.

## Addendum 6 — hosted CI outcome + creation-race fix (d79253b)
- Hosted CI on `d79253b` (ubuntu-latest, CPython 3.11): **plane
  SUCCESS** (105 + 55 + 19, fully independent of local output),
  **kernel SUCCESS**, stdlib FAILURE at the collector step. The
  plane green verifies this entire pass on a hosted runner.
- The hosted plane failure on `ff1b3bc` was diagnosed via a WSL
  Ubuntu reproduction as a concurrent first-create race (two
  processes minting the ledger's init token; loser aborted) plus a
  Linux-flaky assertion — fixed by serializing first-creation on a
  dedicated create lock (data-lock -> create-lock order, no cycle),
  proven 8/8 on WSL Linux plus the hosted green. The local
  NameError seen mid-fix never reached any push.
- The stdlib/collector failure is PRE-EXISTING (identical at
  `151000a`, before this pass) and UNREPRODUCIBLE locally
  (Windows 3.11/3.13, WSL Ubuntu 3.12, standalone 3.11.13 all
  green): it lives in frozen collector code outside the authorized
  touch zone, and hosted logs need repo-admin access (403 for the
  integration). It is reported, not fixed: the human re-audit
  should pull the stdlib job log before signing anything that
  depends on the collector suites.

## Addendum 7 — human re-audit fix pass (5f54ee5, agent-side, NOT signed off)
- The human re-audit of the shipped `62e1019` tree confirmed: hosted
  plane + kernel SUCCESS, hosted stdlib FAILURE (frozen collector,
  pre-existing); the first-create race genuinely fixed. It withheld
  sign-off on five points, all closed in `5f54ee5` with one regression
  each (see TODO record): strict `record_unknown` (hold-usd equality,
  reserved/invoked state, unknown_holds identical-idempotent vs
  conflict-loud, rowcount-verified transitions) on one shared span-
  identity helper with the normal path (ts is metadata, excluded);
  tier journal + state under ONE lock acquisition (locked variants,
  same-file nesting would self-deadlock); pre-provider unwind
  failures abort with a both-sides snapshot (reservation preserved)
  plus a verified `mark_invoked` transition; `run_in_process` handoff
  moved from Queue (30 s post-death get) to a one-shot Pipe (10 s
  anomaly-only bound, Windows BrokenPipe fails loud).
- The new strictness exposed a REAL shipped bug the 32/32 claim
  missed: `record_unknown` stored symbol in the stage column and
  `'r'` in symbol (swapped INSERT). Fixed, with the column order now
  pinned by comment + test.
- Batteries on the fix tree: plane 105 + hardening 64 + emit 19 +
  isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted CI
  on `c5634f8` (run 35626652683): plane SUCCESS, kernel SUCCESS,
  stdlib FAILURE at the same frozen-collector step (pre-existing,
  untouched per the re-audit: document, do not fix for the badge). Slice D NOT AUTHORIZED. Phase D NOT closed —
  this record awaits the human re-audit of `5f54ee5`.

## Addendum 8 — re-audit round 2 fix pass (6fe44d5, agent-side, NOT signed off)
- The human re-audit of `5f54ee5`/`a7bbbde` confirmed the five prior
  fixes but withheld sign-off on eight points, all closed in
  `6fe44d5` with one regression each (see TODO record): the Pipe now
  polls/reads WHILE the child runs (a ~1 MB result streams through
  the finite buffer instead of deadlocking the child's send; an
  intact envelope proves completion so post-send teardown crashes do
  not convert accounted work to unknown spend; a missing envelope
  stays loud; an unkillable child never returns success); hold-only
  reconcile mints the synthetic unknown span FIRST (the ledger
  carries the reconciled dollars; the existing span-recovery test
  now asserts the final span evidence) and every transition is
  rowcount-verified; attested actual above the reservation
  hard-rejects before mutation (rollback keeps the hold blocking;
  the timeout test now attests $0 for not-billed, matching the
  contract); success-path settlement failure aborts with the hold
  retained; the R15 ledger keeps a cycle registry (a missing
  counters row for a recently seen cycle aborts as deleted
  authority; only prune-aged cycles recreate; additive table, old
  ledgers upgrade with empty memory); the ratio per-day record holds
  one lock across check+append; the duplicate timeout test is
  removed; the map pre-parse bound is truly 1 MiB+1; the
  pre-provider test asserts the retained reservation.
- Batteries on the fix tree: plane 105 + hardening 69 + emit +
  isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted CI
  on `349e89a` (run 35631946891): plane SUCCESS, kernel SUCCESS,
  stdlib FAILURE at the same frozen-collector step (pre-existing,
  untouched). Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `6fe44d5`.

## Addendum 9 — re-audit round 3 fix pass (c423e20, agent-side, NOT signed off)
- The human re-audit of `6fe44d5` confirmed the round-2 fixes (plus
  hosted plane/kernel green, stdlib frozen-collector red) but
  withheld sign-off on four points, all closed in `c423e20` with one
  regression each (see TODO record): R15 deletion detection now
  covers every reader — snapshot/check/settle/invalidate abort on a
  missing row for a recently seen cycle instead of minting zeros
  (the cycle estimate cannot read zeros over live state);
  old-ledger migration backfills the cycles registry from surviving
  counters rows inside the migration itself (upgraded deployments
  are protected immediately; additive table, fail-closed); tier
  evaluation holds ONE lock across load-compute-persist (locked
  persist/ratio variants, tier-first order so no lock cycle; a
  two-governor stale-writer regression plus a single-acquisition
  proof); the Pipe frame read is bounded by the call deadline (a
  mid-frame stall hits the kill path, the reader is joined
  post-kill, and the dead-child/exit race is settled with a short
  join so missing-vs-timeout labels stay exact) with partial-frame
  and 1 MB-streaming regressions.
- Batteries on the fix tree: plane 105 + hardening 73 + emit 19 +
  isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted CI
  on `82247b3` (run 35636651055, same code tree): plane SUCCESS,
  kernel SUCCESS, stdlib FAILURE at the same frozen-collector step
  (pre-existing, untouched). Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `c423e20`.

## Addendum 10 — re-audit round 4 fix pass (0dccc0b, agent-side, NOT signed off)
- The human re-audit of `c423e20` verified the round-3 fixes but
  withheld sign-off on ten points, all closed in `0dccc0b` with one
  regression each (see TODO record): Tier-2 research requires the
  durable signal_dir sentinel (hook-only no longer signallable);
  migration CREATE + backfill in a single transaction plus an
  idempotent present-but-empty-over-live heal (pruning makes that
  state illegitimate: 7d counters vs 30d registry); unreadable
  markers read as invalid (only FileNotFoundError is absent) and an
  unreadable tier state raises instead of initializing Tier 0;
  the ratio journal is read strictly (deleted/empty-with-tripwire,
  unreadable, malformed, and truncated-tail all deny; one trailing
  partial line tolerated as crash-mid-append and healed by the next
  append under the same lock) with the last journaled day tripwired
  in tier state across binding resets — and the record corrected:
  suspended days never journal; run_cycle refuses thread_ids whose
  checkpoint exceeds the 7d R15 window (same cycle_id never mints a
  second budget); generate text is byte-capped in the child before
  the envelope (parent check aligned to bytes); extract cleanup
  outcome rides the envelope with authoritative parent reclaim
  (reclaim failure is blocked evidence); emit records
  r15-budget-unreadable instead of swallowing the fail-closed read;
  the kill ladder begins at the deadline (0.25s settle grace for
  exact missing-vs-timeout labels; the 10s gentle join now applies
  only to the post-result reap — a 2s deadline resolves in ~2.3s,
  previously ~12.3s; the daemon-reader escape is documented as
  accepted residual).
- Forensic note (accepted without change): synthetic recovery spans
  keep epoch=0 / cycle=recovered / symbol=? because unknown_holds
  carries no cycle/symbol link; the dollars stay conservative and
  spend authority is unaffected.
- Batteries on the fix tree: plane 108 + hardening 82 + emit 19 +
  isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted
  rerun pending on push; the frozen-collector stdlib failure stays
  untouched. Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `0dccc0b`.

## Addendum 11 — hosted plane failure on the round-4 tree, diagnosed (3e3a18b)
- Hosted run 35643930706 (head `30be8a8`, round-4 code): kernel
  SUCCESS, stdlib the same pre-existing frozen-collector failure,
  plane FAILURE — one test,
  test_extract_cleanup_failure_reaps_and_blocks, with EMPTY blocked
  evidence (`'reap-failed' not found in ''`; log read via a signed-in
  browser session, API log download stays repo-admin-blocked).
- Diagnosis: the test depended on real docker state (assumed
  `docker rm -f` on a unique name always fails), so a real-daemon
  environment could resolve the reclaim cleanly and hide the path;
  worse, the empty blocked exposed a genuine visibility hole — the
  graph extract node turned AbortCycle into `aborted=True` with zero
  blocked entries (an aborted cycle with nothing to show). A third
  defect surfaced while reproducing: the round-3 partial-frame
  regression passed vacuously on Windows (os.write to a pipe HANDLE
  crashes the child instantly, so the deadline bound was never
  exercised).
- Closed in `3e3a18b`: extract-aborted blocked evidence on
  AbortCycle; hermetic reclaim failure via mock in the integration
  test; a _reap_container contract test (exact argv, nonzero-exit /
  missing-binary raise, empty-name no-op); the partial-frame test
  rewritten hermetically around a fake stalled conn (deadline bound
  + post-kill thread exit, no subprocess, no platform fd tricks).
- Batteries on the follow-up tree: plane 108 + hardening 83 + emit
  19 + isolation + sources + stdlib green locally in CI-identical
  script invocation; freeze-check PASS; kernel/collector zero-diff
  (untouched). Hosted rerun pending on push. Slice D NOT
  AUTHORIZED. Phase D NOT closed — awaiting the human re-audit of
  `0dccc0b`/`3e3a18b` and the hosted rerun.

## Addendum 12 — hosted rerun green on the follow-up tree (4370574)
- Run 35646920298: plane SUCCESS, kernel SUCCESS, stdlib FAILURE
  at the same frozen-collector step (pre-existing, untouched per
  the freeze/zero-diff constraint). The hermetic reclaim test
  passes on hosted, confirming the child-envelope → parent-reclaim
  → blocked-evidence chain on Linux; the real docker command stays
  covered by the argv unit test. Awaiting the human re-audit of
  `0dccc0b`/`3e3a18b`. Slice D NOT AUTHORIZED. Phase D NOT closed.

## Addendum 13 — re-audit round 5 fix pass (fb236d5, agent-side, NOT signed off)
- The human re-audit of `0dccc0b`/`3e3a18b` verified the round-4
  headline fixes but withheld sign-off on eight points plus a
  documentation note, all closed in `fb236d5` with regressions
  (see TODO record): established SQLite files never regrow tables
  (table-missing deny under a surviving marker/token/siblings;
  creation only on provable first init, pristine files, or the
  explicit v1→v2 cycles migration — locks.may_create_tables;
  unreadable catalogs deny); the cycles migration is now genuinely
  single-transaction (the stray pre-transaction CREATE is gone)
  with version-explicit detection (SCHEMA_VERSION 2: v1+table
  adopts, v1-without-table migrates, v2-without-table denies);
  stale-thread lookup failure rejects (only checkpointer-less apps
  proceed; the old test had encoded the bypass and now asserts the
  rejection); the extract reservation covers measured agent
  framing (32 KiB overhead over 9.3 KiB measured, proven against
  the exact generated messages; tape refusal stays the backstop);
  budget numerics fail closed (DDL CHECKs plus read-validation on
  every counters/lease row; corruption aborts, never normalizes);
  ratio rows must match the exact schema and the tier journal is
  strict with a tier_rev tripwire, under a state-first persist
  order (crash leaves restrictive state with at most an audit
  gap; legacy journal-first rows still recover); container reclaim
  runs before candidate-shape rejection; timeout_s is documented
  as prompt-termination plus bounded escalation; retention list
  failure raises; the trusted-config boundary
  (extract_workers/tool/executor factories) is recorded in plan
  08 §8.4 as deployment discipline, not a runtime guarantee.
- Interop found while verifying (fixed in-pass): the new DDL text
  moved a corruption-probe file offset, so the integrity test's
  probe loop now also catches undecodable mutations; one outdated
  migration test retired to the version gate.
- Batteries on the fix tree: plane 108 + hardening 96 + emit 19 +
  isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted
  rerun pending on push; the frozen-collector stdlib failure stays
  untouched. Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `fb236d5`.

## Addendum 14 — hosted rerun green on the round-5 tree (0229bd7)
- Run 35682744131: plane SUCCESS, kernel SUCCESS, stdlib FAILURE
  at the same frozen-collector step (pre-existing, untouched per
  the freeze/zero-diff constraint). Awaiting the human re-audit
  of `fb236d5`. Slice D NOT AUTHORIZED. Phase D NOT closed.

## Addendum 15 — re-audit round 6 fix pass (48d5bd2, agent-side, NOT signed off)
- The human re-audit of `fb236d5` verified the eight round-5
  closures but withheld sign-off on seven further points, all
  closed in `48d5bd2` with regressions (see TODO record):
  historical row integrity (attribution marker roots re-baselined
  post-commit under lock; R15 out-of-band registry sidecar;
  row-deletion and same-schema replacement deny on both ledgers;
  residue backfill removed as deletion cover; marker-absent over
  live rows denies; TOFU adoption documented); future start_wall
  denied on read and write; tier journal chain semantics with
  newer-than-state forgery denial and no non-legacy adoption;
  strictly increasing ratio days; single-transaction first init
  with pristine re-init; checkpoint-id presence for
  timestamp-less snapshots.
- Interop found while verifying (fixed in-pass): the round-3
  residue heal masked registry-only deletion (removed, test
  retired to the deny semantic); a file rewrite CRLF'd the test
  file (restored to LF, commit amended).
- Batteries on the fix tree: plane 108 + hardening 105 + emit 19
  + isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted
  rerun pending on push; the frozen-collector stdlib failure stays
  untouched. Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `48d5bd2`.

## Addendum 16 — hosted rerun green on the round-6 tree (86cd363)
- Run 35710113948: plane SUCCESS, kernel SUCCESS, stdlib FAILURE
  at the same frozen-collector step (pre-existing, untouched per
  the freeze/zero-diff constraint). Awaiting the human re-audit
  of `48d5bd2`. Slice D NOT AUTHORIZED. Phase D NOT closed.

## Addendum 17 — re-audit round 7 fix pass (ce70100, agent-side, NOT signed off)
- The human re-audit of `48d5bd2` verified three round-6 closures
  (future start_wall, init wedge, ratio ordering modulo a tail
  caveat) but withheld sign-off on three P1s (aggregate-only
  roots + crash seam + lax root numerics; .seen joint deletion;
  tier legacy bypass) and three P2s (tier/checkpoint future
  timestamps; ratio tail scope), plus a bookkeeping correction
  (six findings, not seven). All closed in `ce70100` with
  regressions (see TODO record): same-transaction in-DB content
  digests on both ledgers (seam closed by SQLite atomicity;
  marker mirrors adopt-on-consistent, strict slot validation);
  sidecar one-time-migration flag (seen-deleted only when the
  digest was reconstructed that open, sole sidecar loss
  re-adopts); tier legacy boundary (rev-less recovers only at
  rev 0 with no revisioned rows); future tier/checkpoint
  timestamps and naive-checkpoint rejection; ratio tail scope
  documented (64 KiB ≈ 3.5 yr at one row/day; streak soundness
  independent of ancient order). Coherent rows+digest+marker
  forgery is documented out-of-scope (keyless roots detect
  corruption and non-coherent tamper).
- Interop found while verifying (fixed in-pass): older
  out-of-band-edit tests retired to the digest-mismatch code
  (old deletion codes remain as backfill-evasion guards);
  prune-aging via the now_wall parameter; the conflict test
  plants digest-coherently.
- Batteries on the fix tree: plane 108 + hardening 113 + emit 19
  + isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted
  rerun pending on push; the frozen-collector stdlib failure stays
  untouched. Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `ce70100`.
