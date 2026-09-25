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

## Addendum 18 — hosted rerun green on the round-7 tree (1a8d48d)
- Run 35716617708: plane SUCCESS, kernel SUCCESS, stdlib FAILURE
  at the same frozen-collector step (pre-existing, untouched per
  the freeze/zero-diff constraint). Awaiting the human re-audit
  of `ce70100`. Slice D NOT AUTHORIZED. Phase D NOT closed.

## Addendum 19 — re-audit round 8 fix pass (bb4733a, agent-side, NOT signed off)
- The human re-audit of `ce70100` verified the tier-chain,
  future-timestamp, ratio-order, and init closures (left
  untouched) but withheld sign-off on two P1s: digest-table
  deletion followed by row edits silently re-baselined authority
  on both ledgers (the missing-table backfill was a new
  trust-on-first-use event), and the .seen witness published
  after the sidecar (crash seam). Both closed in `bb4733a` with
  regressions (see TODO record): schema v3 makes the digest
  table mandatory and never rebuilt (digest-deleted); one-time
  migration only for provably pre-digest ledgers (pre-digest
  version AND pre-digest marker shape — a version reset alone
  cannot reach it, and the cycles-drop + version-reset variant is
  closed by the same gate); witness-first sidecar publication
  with init-crash resume proven. Residual: full marker forgery +
  version reset (documented coherent-forgery class, same as the
  round-7 triple-forgery scope). seen-deleted removed as
  unreachable. Auditor nit accepted as P2 non-blocking: a
  revisioned rev=0 row can pass chain predicates only toward
  more-restrictive states (unchanged).
- Batteries on the fix tree: plane 108 + hardening 116 + emit 19
  + isolation + sources + stdlib green locally; kernel `build.sh`
  exit 0; freeze-check PASS; kernel/collector zero-diff. Hosted
  rerun pending on push; the frozen-collector stdlib failure stays
  untouched. Slice D NOT AUTHORIZED. Phase D NOT closed — this
  record awaits the human re-audit of `bb4733a`.

## Addendum 20 — hosted rerun green on the round-8 tree (55e1eb0)
- Run 35741330249: plane SUCCESS, kernel SUCCESS, stdlib FAILURE
  at the same frozen-collector step (pre-existing, untouched per
  the freeze/zero-diff constraint). Awaiting the human re-audit
  of `bb4733a`. Slice D NOT AUTHORIZED. Phase D NOT closed.

## Addendum 21 — round-9 response: coherent-forgery P1 analyzed, model narrowed (docs-only, NOT signed off)
- The human re-audit of `bb4733a` verified all Round-8 closures
  (deletion gate, version resets, DROP+CREATE, witness ordering,
  crash resume) and left them untouched, but raised a new P1: a
  format-aware actor with SQLite write access can coherently
  rewrite rows AND digest (public algorithm) with no marker touch
  and no version reset, and the mirror then re-baselines the
  marker over the forgery. CONFIRMED agent-side with a throwaway
  PoC (15 lines, $149→$0 accepted; script deleted, not
  committed — committing a forgery-accepting test is forbidden,
  and a forgery-denying test is unimplementable, see below).
- Impossibility argument (why no code fix): legitimate crash lag
  (DB self-consistent, marker one commit behind — auto-recovery
  pinned by the hardening battery) and coherent forgery (DB
  self-consistent, marker pre-attack) are observationally
  identical given only (DB, marker). Any deterministic verifier
  that auto-recovers the first must accept the second. Closing
  it needs a non-readable secret or external anchor (HSM, TPM,
  remote log, OS key) — none in Phase-D scope — and same-disk
  key files, SQLite triggers, or extra same-permission sidecars
  are theater against a disk-write actor (readable secrets don't
  bind; triggers don't authenticate). That actor is
  host-compromise class (it can patch plane/*.py itself).
- Resolution taken (the auditor's accepted alternative): the
  threat model is explicitly narrowed and code/docs now agree
  exactly. Proven: rows↔digest mutual consistency, single-object
  deletion, crash atomicity, version/shape-gated migration vs
  non-coherent faults. Out of scope: coherent multi-object
  forgery, bottoming out at host/filesystem integrity (same root
  as frozen-code integrity). Residual corrected: rows+digest
  (NOT rows+digest+marker — Addendum 17's wording overclaimed;
  marker forgery is not required). Marker fields answered:
  lag-tolerant recovery mirror + shape tripwire (telemetry +
  baseline), NOT an authority root. No ledger behavior changed
  (no theater); the two residual comments corrected in source.
- CI evidence gap (auditor note, not a P1) closed: new
  independent `evidence` job runs isolation + sources even when
  the frozen collector loop fails; sources added to CI for the
  first time. Workflow only — kernel/collector untouched.
- Batteries: plane 108 + hardening 116 + emit 19 + isolation +
  sources + stdlib green locally; kernel `build.sh` exit 0;
  freeze-check PASS; kernel/collector zero-diff. Hosted rerun
  pending on push. Slice D NOT AUTHORIZED. Phase D NOT closed —
  awaiting human sign-off on the narrowed model (or a decision
  to fund a real anchor: HSM/TPM/remote witness).

## Addendum 22 — hosted run with the independent evidence job (4dcf137)
- Run 35747745650: plane SUCCESS, kernel SUCCESS, evidence
  SUCCESS (isolation + sources green independently), stdlib
  FAILURE at the same frozen-collector step (pre-existing,
  untouched). The CI-evidence gap is closed with proof. Awaiting
  human sign-off on the narrowed model. Slice D NOT AUTHORIZED.
  Phase D NOT closed.

## Addendum 23 — Round-9 sign-off recorded (human decision, NOT agent-signed)
- The human re-auditor ACCEPTED the Round-9 threat-model
  narrowing: the coherent rows+digest forgery is REAL, a code fix
  within the current trust model is IMPOSSIBLE without an
  independent trust anchor, and no code change / no theater was
  the correct response. Corrected boundary: rows↔content_digest
  = mutual-consistency / corruption detection; marker = recovery
  mirror + shape tripwire, not a trust anchor; host/filesystem
  integrity = outside this trust model. A real HSM/TPM/remote
  witness is a NEW security architecture (different trust model),
  unfunded — not a follow-up patch. Independent CI evidence
  CLOSED (hosted evidence job green). Round 9 is CLOSED and
  signed off under the narrowed model.
- Phase D is eligible to close pending remaining sign-off
  criteria/deployment boxes — NOT declared closed by this
  record. Slice D NOT AUTHORIZED.

## Addendum 24 — status confirmation recorded (human verification of 06da85c, NOT agent-signed)
- Verified against `06da85c`: record internally consistent.
  Round 9 CLOSED, narrowed threat model ACCEPTED, independent CI
  evidence CLOSED. Phase D NOT YET CLOSED — remaining
  deployment/operational exit boxes explicitly open (Linux
  isolation deployment, egress enforcement probe, image
  digest/SBOM/scan, model credentials/config, supervisor WALL_S
  kill path, Langfuse attribution, required source/config feeds,
  unattended operational evidence where applicable; plan/08 §8.6
  + plan/09 §9.4). Security-model question finished;
  deployment-readiness question not. PRE-D sequencing holds:
  Slice D NOT AUTHORIZED until the Phase-D gate is accepted. No
  code change warranted; `06da85c` remains the current clean
  documentation checkpoint. Carried state: Round 9 closed →
  Phase D open pending deployment evidence → Slice D
  unauthorized.

## Addendum 25 — Phase-D deployment/evidence pass (agent-executed, NOT signed off)
- From canonical `36c2862` (Round 9 closed, Phase D OPEN, Slice D
  NOT AUTHORIZED): seven deployment commits, one per theme, all
  runtime proof, no static-only closures. Box 1 OS isolation, Box 2
  egress enforcement (squid; tinyproxy rejected on evidence),
  Box 3 image SBOM+scan, Box 4 config fail-closed + placement,
  Box 5 WALL_S kill/reap on Linux, Box 6 Langfuse server healthy +
  ledger attribution, Box 7 Tier-A live probes + lessons +
  calendar gate, Box 8 kill-9 resume end-to-end with the full
  ambiguity→block→reconcile→fresh-cycle contract (plus two
  design confirmations: per-epoch budget threads, terminal
  aborted checkpoints — both fail-closed, unchanged). Full detail
  in `research-plane/DEPLOYMENT_EVIDENCE.md`.
- BLOCKED (external/human, not unattempted): live model key,
  FRED_API_KEY, broker credentials/feed, profit feed, calibration
  feed, 7-day elapsed time, registry credential. No live capital
  touched; kernel/collector zero-diff; freeze PASS; local battery
  249 green; hosted 35761650805 plane/kernel/evidence SUCCESS,
  frozen stdlib FAILURE. Slice D NOT AUTHORIZED. Phase D closable
  only after the BLOCKED externals land — this record does not
  close it.

## Addendum 26 — deployment audit response: accounting corrected + probes hardened (agent-executed, NOT signed off)
- Auditor verdict on `7df0865` (9 commits `36c2862..cea59b8`, not 8):
  deployment pass ACCEPTED as evidence collection; Boxes 1/2/3/5
  accepted with no rework; accounting tightened exactly as
  directed: Box 7 now carries the full Tier-A matrix (broker OPEN,
  EDGAR/calendar/Fed-ECB/Treasury/BLS PROVEN live, FRED-ALFRED/BEA
  BLOCKED on keys, earnings OPEN as a design gap); Box 8 kept
  partial (mechanism ≠ 7-day/wall-clock); registry push OPTIONAL;
  profit/calibration feeds FUTURE-STAGE (not Phase-D blockers).
- Deep re-verification of every deployment artifact (edge cases,
  flaws, leaks): fixed fixture-clobber hazard, non-reproducible
  proxy bring-up, Windows/bash temp split-brain, workdir leaks
  (cleanup + stray assert), far-future reader clock, dead code,
  overstated kill-probe docstring; verified zero stray processes,
  zero workdir leaks, only egress-proxy running by intent.
  Full battery 249 green + freeze PASS + kernel exit 0 after
  fixes; kernel/collector zero-diff vs `36c2862` confirmed by
  direct diff. Hosted 35765446507: plane/kernel/evidence SUCCESS,
  frozen stdlib FAILURE. Open design question flagged (not
  changed): mirohuman nologin vs plan §8.2. Slice D NOT
  AUTHORIZED. Phase D OPEN — blocked only by externals and
  elapsed evidence, no further code-hardening round indicated.

## Addendum 27 — earnings-calendar gap closed (agent-executed, NOT signed off)
- Auditor-scoped single item (`aa3c63d` verdict): `sources/earnings.py`
  (new, stdlib-only, EDGAR-derived 8-K Item 2.02 + 10-Q/10-K windows,
  ±3d veto, Unknown -> event-present -> no entry) + 6 fail-closed
  unit tests in `tests/test_sources.py` (offline fetchers) + live
  evidence `sandbox/earnings-deploy-evidence.json`.
- Runtime proof 2026-09-22: AAPL/MSFT submissions 200s zero-403
  (89/48 events, July-2026 earnings detected); gate verified
  True-on-earnings-day / False-on-quiet-day / True-on-unknown.
  Honest remainder: TTL/heartbeat production wiring OPEN
  (deployment wiring, not a contract gap). No frozen dir touched,
  no accepted mechanism modified, no live capital, fail-closed
  intact. Local battery 255 green (249+6) + freeze PASS; hosted
  35769648294 plane/kernel/evidence SUCCESS (evidence job covers
  the new tests), frozen stdlib FAILURE. `mirohuman` nologin
  accepted as NOT A BLOCKER per ruling (evidence note updated,
  script unchanged).

## Addendum 28 — earnings accounting correction (audit-directed, docs only)
- Earnings implementation ACCEPTED; record corrected: gate
  implementation + live probe = PROVEN, Tier-A operational wiring
  (poller + TTL + heartbeat per §9.4) = OPEN, therefore the
  earnings Tier-A source is NOT YET FULLY PROVEN. No code touched.
- Canonical remaining Phase-D items (six): broker access +
  operational proof; live model credential/traffic; FRED/ALFRED
  credential + vintage replay; BEA credential/config + proof;
  earnings TTL/heartbeat wiring; 7-day run + cadence-rate evidence.
  Profit/calibration feeds stay future-stage; registry optional;
  Slice D NOT AUTHORIZED; no further hardening rounds.

## Addendum 29 — repo hygiene pass (auditor-directed, no credential work)
- Env consolidation (`01b6e47`): canonical root `.env` + `.env.example`
  (now documents consumed OPENROUTER_API_KEY; broker/BEA keys stay out
  until a code path consumes them, per the file's own rule); sole
  loader `collector/config.py::_load_dotenv` (root file, allowlist,
  exported env wins); tracked `sandbox/provider.env.example` deleted
  + its gitignore rule removed; sandbox Python consumes root config
  via `collector.config.load()` — no second file, no second mechanism,
  nothing that can drift. Config suite passes; no secret in git.
- Dead-material audit: `/research` RETAINED — both memos are
  TODO-referenced HISTORICAL audit records, not scaffolding; deletion
  would break the TODO reference and destroy history. Full-tree audit
  found no other dead files (every dir referenced by code, CI, or docs).
- Test layout (operator-directed; tests kept, never deleted):
  `collector/tests/` (6 suites) + `kernel/tests/` (4 files) with
  `build.sh`, CI stdlib step, README, and the freeze p33 presence-pin
  following (gate intent preserved; risk/ingest subfolder precedent).
  Collector moves are HERE→parent one-liners; kernel moves are `../`
  includes. Freeze PASS + kernel build PASS from the new layout.
- `ARCHITECTURE.md` rewritten from the actual tree (all 100 named
  paths verified to exist; no stale v2/f1 literals): full directory
  map, per-component what/why/files/reads/writes/callers/failures,
  end-to-end + veto flows, authority boundaries, env/config flow,
  frozen-vs-active-vs-FUTURE, and the test-co-location rule.

## Addendum 30 — hygiene pass hosted confirmation
- Run 35773878605 on `78d5ad2`: plane SUCCESS, evidence SUCCESS,
  kernel SUCCESS (build.sh green from `kernel/tests/`), stdlib
  FAILURE at the same `collector suites` step. Log access 403
  (repo-admin only), so the CI loop was replicated exactly on Linux
  (system python3, new `collector/tests/` paths): 6/6 OK. The hosted
  stdlib failure is therefore the same pre-existing frozen-collector
  failure, not a path error from the CI edit. Frozen implementation
  untouched (moves were test files + path-following edits only).

## Addendum 31 — documentation consistency pass (auditor-directed, docs only)
- ARCHITECTURE.md made exhaustive (389 tracked files): per-file
  roles for plane/sources/collector/sandbox/kernel-auth-ingest-risk,
  per-test contracts, fixture/vector/row families with exact counts
  (36 / 11 / 200+22+4), evidence-artifact provenance, full plan map,
  env/config/storage/provider flows, money-ownership, FROZEN / ACTIVE
  / FUTURE / HISTORICAL per area. Two honesty corrections vs the
  prior version: collector is the production ingestion path while
  sources/ holds readiness probes + the earnings veto gate (no
  broader claim than the code supports); `config.load()` is
  implemented+tested but has no live sandbox consumer yet — the
  first live-provider probe will be the first.
- README fixed: research-plane IMPLEMENTED (was "Designed, not
  built"), P3.5 veto/ingest landed, repo map rewritten (old/ never
  existed; research-plane/research/.env now listed).
- TODO.md: 3.3 marked HISTORICAL design-lock, 5.2 marked SUPERSEDED
  as a gate item (current Phase-D credentials ONLY: OpenRouter,
  FRED/ALFRED, BEA, OANDA practice, Alpaca paper). No records
  destroyed; no new mandatory credentials invented.
- Sweeps clean: no stale research-plane claims, no old test paths
  outside history/plan, no live provider.env refs, no "100 paths"
  claim. kernel/collector byte-identical vs `e8b419e`. Freeze PASS;
  config + sources suites green. No contracts, code, or runtime
  behavior touched.

## Addendum 32 — Box 4 live provider proof (agent-executed, NOT signed off)
- Trigger met (key in root `.env` + authorized model ID): exact model
  slug verified on OpenRouter first (`meta/muse-spark-1.3-contributor`;
  operator wrote "spart", canonical is "spark"; $0.10/M + $0.20/M).
- Enabling fixes (all re-proven): squid allowlist gains exact
  `openrouter.ai`; proxy recreated with loopback publish (host-side
  shipped provider code through the SAME squid+allowlist; internal-net
  workers unaffected) — this exposed and fixed two latent defects in
  the accepted ensure block (MSYS path-mangling footgun, now
  self-exempting; bridge-attachment check that never attached — allows
  failed 503/HIER_NONE while denies passed). Egress 5/5 re-green.
- `collector/config.py` gains additive OPTIONAL `RESEARCH_MODEL_ID`
  (no-live-consumer yet + stale "keys do not exist" docstring
  corrected): the single-source-of-truth order required a canonical
  home for the model slug; config suite still green; freeze PASS.
  Flagged explicitly as the one frozen-collector touch this pass.
- Live run: reserve → invoke → 15+16 tokens ($0.000005 of $0.000038
  reserved) → span row in ledger → hold settled/released. Artifact
  `sandbox/live-provider-evidence.json`. Box 4 CLOSED on a real call.
  Box 6 stays IN PROGRESS (needs elapsed traffic, not one call).

## Addendum 33 — Box-4 evidence-label + frozen-zone bookkeeping (audit-directed, docs only)
- Box 4 ACCEPTED as LIVE PROVIDER + ACCOUNTING DEPLOYMENT PROOF
  (real auth, real Squid path, real tokens/spend/span/settle, no
  leakage; slug/pricing independently consistent). Corrected label:
  the probe directly exercises shipped `make_raw_provider` +
  `UsageTape` + `SpendGovernor` — it is NOT a full live
  `graph.run_cycle()` execution. Result unchanged, wording precise.
- Frozen-zone bookkeeping: `collector/config.py` (additive
  `RESEARCH_MODEL_ID`, Addendum 32) means `collector/` is no longer
  byte-identical to `e8b419e`. Scope held explicit: production
  implementation frozen; only the canonical loader extended; no
  behavior/polling change; config/sources suites + freeze green.
  Current ARCHITECTURE/TODO wording updated; historical records
  untouched. No hardening pass; no Slice D; G0_PAPER only.

## Addendum 34 — egress/FRED/broker/pricing wording corrections (audit-directed, docs only)
- HEAD note: auditor fetched `346cfae`; actual HEAD at audit time
  was `e00d4be` (Box-4 live commit, already pushed + hosted). No
  implementation change in `346cfae` itself — confirmed.
- Egress, stated exactly (ARCHITECTURE §5): sandbox workers → Squid
  only (proven); host-side probes (`tier_a.py`, `earnings.py`, live
  drivers) → DIRECT, never Squid. The prior chat-checklist sentence
  claiming all calls via Squid is retracted; no proxying added as
  scope creep (plan does not require it).
- FRED gate as shipped = auth/metadata readiness ONLY (GDP-series
  200 = key verified, not observation proof). The gated task is:
  real observation + ALFRED vintage replay (original realtime/
  vintage params, deterministic) + latency with N + bad-key
  fail-closed + redaction. FRED key format per provider docs:
  32-char lowercase alphanumeric (not "hex"); same key serves
  FRED + ALFRED endpoints.
- Broker qualifier: OANDA demo / Alpaca paper creation authorizes
  paper/demo probes ONLY — not the future G1 live
  broker/jurisdiction gate (plan §10.1). Paper-only restriction
  stays enforced in config + evidence. BEA UserID per provider
  docs: 36-char, registration + activation.
- Box-4 scope held: LIVE PROVIDER + ACCOUNTING DEPLOYMENT PROOF;
  pricing entry probe-constructed (production pricing config NOT
  proven); not a `graph.run_cycle()` proof. STAGE/HALT/promotion
  manifests stay locked concepts with absent runtime — credential
  work implements no Slice-D/kill-switch machinery.

## Addendum 35 — FRED/ALFRED operational proof (agent-executed, NOT signed off)
- Trigger met (FRED key in root `.env`, 32 chars). Pre-existing
  `tier_a.py` gate now reports `fred_macro: READY (key verified
  live)` — characterized honestly as auth/metadata readiness ONLY.
- New `sandbox/fred_vintage_probe.py` (+ artifact
  `fred-vintage-evidence.json`, +4 offline replay-predicate tests in
  `tests/test_sources.py`, 13/13 green): GDP observations live
  ($32,486.066 @ 2026-04-01, N=3, p50 ~500ms p99 ~844ms);
  realtime-period replay as-known-2020-01-01 byte-identical twice
  (pre-revision 2019 quarters); bad key 400-denied fail-closed;
  artifact secret-free (no api_key, no 32-char runs).
- Honest negative: dedicated `/alfred/*` endpoints 404 for this key
  (recorded, not hidden); the realtime-parameter mechanism on the
  FRED endpoint is the proven deterministic-replay path — same key,
  one credential, both mechanisms. No frozen code touched (probe +
  tests only). venv had vanished from the tree (untracked dir,
  external cause, tree itself clean) — rebuilt from pinned
  requirements, deps verified.

## Addendum 36 — stdlib flake fixed (test-only; production untouched)
- Hosted stdlib failure root-caused (run 35858925643, log-pulled by
  the auditor): `test_jev.py` single-flight, timing race around
  `sleep(1.0)` in the mock provider. Reproduced locally under CPU
  load (1/40). Production `jev.decide` verified correct by reading
  (whole money gate incl. provider call + cache write inside ONE
  `_spend_lock` hold; 60s lock timeout) — defect is test-only.
- Fix (`collector/tests/test_jev.py` only): deterministic
  orchestration — child A blocks in post_fn on a parent-owned
  RELEASE marker, READY proves A inside provider (lock held), child
  B (SF_TAG-distinct started marker) spawns strictly after, parent
  releases; bounded waits (60s markers, 120s join), exit-code +
  valid-JSON asserts, kill/reap on every failure path, markers
  cleaned. Invariant proved (exactly one call, one ANSWER + one
  CACHED) independent of interleaving.
- Proof: 100/100 consecutive on Linux under 4x CPU load + full
  stdlib 6/6 on Linux + freeze PASS. No production change; no CI
  weakening (no continue-on-error, no skips). Workflow "Five jobs"
  comment corrected to four.

## Addendum 37 — hosted CI fully green (no weakening anywhere)
- Run 35865034676 on `c0b1ebc`: stdlib SUCCESS + evidence SUCCESS +
  plane SUCCESS + kernel SUCCESS. First all-green hosted run.
- Two-part fix, both verified: (1) deterministic single-flight
  (`aa93274`, 100/100 Linux under load, production untouched);
  (2) CI-only scoped fixture (`c0b1ebc`): the new failure was
  `config-hygiene` (CI checkout has no `.env`/contact), fixed by
  `MIRO_CONTACT=ci-test@example.invalid` scoped to the soak_check
  command only — job-wide env would have broken `test_config`,
  which asserts a clean environment (caught in local CI
  replication, clean-checkout worktree, 6/6). No continue-on-error,
  no skips, no secret, no production change.

## Addendum 38 — BEA wired, auth proven, data pending activation
- Human completed BEA signup (name+email filled by agent via browser
  bridge; reCAPTCHA solved by human as required). UserID (36-char
  GUID) placed in gitignored root `.env` only; loader allowlist
  extended additively (`BEA_USER_ID` OPTIONAL in `collector/config.py`,
  `.env.example` template, docstring updated) — same disclosed pattern
  as `RESEARCH_MODEL_ID` (Addendum 32). No broker keys added.
- New `research-plane/sandbox/bea_probe.py` (mirrors fred probe:
  stdlib urllib, N=3, p50/p99, zero leakage, exit 0 iff all hold):
  GETDATASETLIST auth PROVEN (NIPA/NIUnderlyingDetail/MNE/FixedAssets/
  ITA/IIP, p50 ~0.9s); bad-UserID fail-closed PROVEN (Results.Error,
  denied=True); evidence `bea-evidence.json` leak-checked (0 hits).
- GetData BLOCKED with BEA error 20 ("dataset requested does not
  exist") on EVERY dataset incl. the documented Regional sample, while
  the list endpoint authenticates fine. Consistent with a key that is
  registered but not yet ACTIVATED: BEA requires an email activation
  step (`api/signup/activate.html`: "To activate your new key ...
  validate reCAPTCHA and click Activate"). No params-side cause found.
  State recorded honestly as PARTIAL; probe re-run pending the human
  activation click. No data faked, no retry-loop theater.

## Addendum 39 — OANDA practice BLOCKED (first-party evidence)
- Browser-driven division check (main Chrome via bridge):
  oanda.com geo-routes India -> bvi-en (OANDA Global Markets);
  demo application `hub.oanda.com/apply/demo/` with country=India
  answers verbatim: "Sorry, OANDA cannot accept new clients from your
  country of residence. You will be unable to open an account."
  Screenshot: `research-plane/sandbox/oanda-india-denial.png`.
- OANDA docs confirm v20 practice accounts exist "for all divisions
  except OANDA Global Markets". No PII submitted (blocked at the
  country gate; phone/password never entered anywhere).
- Consequence: NO OANDA practice token/account can exist for this
  operator. The FX-broker leg of the paper loop cannot proceed as
  planned; per fail-closed rules this is recorded BLOCKED, not worked
  around (no substitute FX API — plan calls for a broker sandbox, and
  a quotes feed would not satisfy execution/reconciliation). Human
  decision required: stocks-only G0 (Alpaca paper) vs alternative FX
  venue — agent does NOT invent plan here.

## Addendum 40 — Alpaca paper PROVEN (read-only, first run PASS)
- Human completed Alpaca signup + paper keypair generation; Key ID +
  secret placed in gitignored root `.env` only. Loader allowlist
  extended additively (`ALPACA_KEY_ID`/`ALPACA_SECRET` OPTIONAL in
  `collector/config.py`, `.env.example` template, OANDA-only wording
  kept for the still-unconsumed broker keys). Tracked files
  leak-checked (0 hits); loader confirms all three IDs visible.
- New `research-plane/sandbox/alpaca_paper_probe.py` (stdlib urllib,
  N=3, p50/p99, zero leakage; PAPER base pinned in code, never live;
  READ-ONLY — no order endpoint called): account ACTIVE + buying_power
  present (p50 ~0.8s); AAPL asset tradable/NASDAQ; IEX latest quote
  present (feed recorded honestly as iex, not disguised as SIP);
  bad-key 401 denied. `alpaca-paper-evidence.json` saved, leak-free.
- 5 canned predicate tests added to `test_sources.py` (BEA
  Results.Error denial shape + rows_identical; Alpaca base pin +
  account/bad-key shapes): 18/18 green. No production change.

## Addendum 41 — BEA post-activation re-probe (still error-20)
- Human confirmed email activation; probe re-run minutes later:
  dataset list still fine (p50 ~1.0s), bad-UserID still denied, but
  GetData/GetParameterList still BEA error 20 on EVERY dataset incl.
  the documented Regional sample. Activation-click therefore did NOT
  clear it within minutes.
- Standing hypotheses, in order: (a) server-side provisioning batch
  delay on fresh keys; (b) an undocumented per-key dataset grant.
  Params-side causes exhausted (case variants, documented sample shape,
  metadata vs data methods — all identical error). No further live
  hammering: re-probe scheduled after elapsed time (next session),
  single call, then contact developers@bea.gov only if still red.
  State stays PARTIAL; nothing promoted, nothing faked.

## Addendum 42 — BEA PROVEN (probe bug, not a key bug)
- Root cause of error-20 found in BEA's own samples (us-bea/beaapi +
  econ notebook): the data-method parameter is `datasetname`, not
  `dataset` (bea.R patch note confirms the rename for NIPA-class
  datasets; the API's error text misdirects). One-line probe fix;
  key and activation were fine all along.
- Full proof: dataset list (p50 ~0.9s) + NIPA T10101 50 rows
  (GDP 2.9 @2023, 2.8 @2024, p50 ~0.4s) + byte-identical replay +
  bad-UserID denied. Evidence saved, leak-checked (0 hits).

## Addendum 43 — operating constraints (human-directed, locked)
- LEGALITY (G0 beta): every active integration is compliant —
  EDGAR/FRED/BEA/BLS are public APIs used within terms (registered
  keys, contact-bearing UA, rate limits); Alpaca paper is the
  broker's own sandbox on paper-only creds; OpenRouter is metered
  commercial API use; no live capital, no client money, no order
  routing anywhere. FX exposure is research-only reference rates
  (ECB/Fed); zero forex transactions exist, consistent with RBI
  restrictions — and OANDA's own refusal confirms no offshore FX
  account was or will be opened through this project.
- FUTURE (multi-user fund): real money + outside users will require
  investment-adviser/broker licensing and exchange data-redistribution
  terms (Alpaca free feed is internal-use; SIP/full-exchange and
  vendor redistribution are paid). That is FUTURE-STAGE licensing
  work, NOT a G0 build item. No multi-user code is built now; the
  existing per-day accounting/attribution/ledger shape is preserved
  as-is so nothing forecloses it. No scope change from this note.

## Addendum 44 — paper-ready goal; OANDA out, alt-FX research track
- Human decision: future-fund work stays future; sole goal is 100%
  paper-trade readiness. US startup later; operating from India now,
  so OANDA is OUT (regulatory hard block, Addendum 39) — no
  reconsideration, no circumvention.
- FX leg proceeds as RESEARCH track only: vet alternative paper FX
  venues for (i) India-resident demo eligibility, (ii) free
  programmatic API on demo, (iii) $0 cost — recommendation first, no
  signup without explicit human approval per venue. No venue is
  chosen in this addendum.
- BUILD track: earnings TTL/heartbeat wiring (§9.4) proceeds now —
  fully in-repo, no external dependency.

## Addendum 45 — earnings TTL/heartbeat wiring CLOSED (Tier-A)
- `research-plane/sources/earnings.py` extended (stdlib only, frozen
  veto contract untouched): poller cycle (CADENCE_S=300, TTL_S=900 =
  3x cadence per §9.3), atomic heartbeat file with version, states
  {fresh, absent, invalid, stale} (FileNotFoundError=absent/fresh,
  unreadable=invalid->stale), and `gate()` for JEV: suppress with
  reason in {event, unknown, stale, invalid, absent}; only
  fresh+ok+event-free passes. Stale/missing is ABSENT, never neutral.
- 7 offline wiring tests (fake fetcher/clock/tmp file): 25/25 green.
- Live 2-cycle evidence: ok 2/2, p50 ~425ms, gate event-free (AAPL
  89 / MSFT 48 events seen, none within ±3d) — `sandbox/
  earnings-heartbeat-evidence.json`. Earnings source now FULLY PROVEN
  per §9.4 (implementation+probe were Addendum 27; wiring closes it).

## Addendum 46 — re-audit hardening round (probes + wording)
- Earnings (§1-3): strict heartbeat schema (exact keys, finite ts,
  skew-bounded future reject, pinned cadence/TTL, bool ok, bounded
  latency/events, exact row schema, dup/extra reject, 64KB read cap;
  malformed -> invalid, never raise); gate() final defensive
  suppress-unknown boundary; unique-tmp fsync writer + dir fsync
  (best-effort) + failure cleanup; SEC parallel-array validation
  (lengths/types/ISO dates/item shape). 17 adversarial/schema/
  concurrency tests; 39/39 green; live SEC shape re-verified.
- BEA (§6): get() now kind-tagged (data/denied/transport); bad-UserID
  requires structured invalid-UserID denial (`Invalid Request -
  Invalid API UserId.` observed); replay reframed as semantic rows
  (`rows_identical`, validated shape); evidence re-run PASS.
- Alpaca (§7): bad-key requires HTTP 401/403 (observed 401);
  transport flagged separately; account/asset/quote validators;
  evidence keeps readiness only (status/currency/buying-power — ids
  removed); re-run PASS.
- Runtime honesty (§4-5, §8, §11): full-tree search confirms NO
  production caller of earnings poll/gate/heartbeat, NO BEA/Alpaca
  production consumers (probe-only), H1 exec/router still future —
  recorded as: Tier-A sources PROVEN; production poller/consumer
  wiring OPEN (pending P3.5/H1); Alpaca API/account/data readiness
  PROVEN, execution connector OPEN. README + ARCHITECTURE use
  PROVEN/WIRED/EXECUTION-READY vocabulary; OANDA-out reflected.
  7-day run NOT started (correctly — execution path open).

## Addendum 47 — hosted CI green on final hardening commit
- Run 35898494106 on `a2f64df`: stdlib SUCCESS + evidence SUCCESS +
  plane SUCCESS + kernel SUCCESS. Local: 6/6 collector suites,
  sources 39/39, plane OK, hardening OK, kernel P3.1 PASS, freeze
  PASS. Temp residue checked (TemporaryDirectory; no .hb- leftovers
  after concurrency test).

## Addendum 48 — re-audit pass ACCEPTED (independent verification)
- Independent auditor verified chain `29e6b4a -> dc228e6 -> a2f64df
  -> d0343c5` + hosted run 35898494106 (all four jobs SUCCESS):
  heartbeat reader/writer, SEC validation, BEA/Alpaca probe
  predicates, and PROVEN/WIRED/EXECUTION-READY wording all accepted
  as closed. `d0343c5` docs-only, so CI on `a2f64df` covers the code.
- Explicitly NOT reopened: cadence/ttl type-exact ints, ask<bid
  reject (SHOULD-FIX nits, no safety impact on fail-closed posture).
- No-production-caller state for earnings poll/gate/heartbeat and
  Alpaca-execution-OPEN confirmed as documented, not accidental.
- Next substantive step per auditor: actual production
  data/execution path (P3.5/H1 scope) under existing authority
  boundary — NOT started; awaits human authorization.

## Addendum 49 — Slice E built (STAGE chain verify)
- `kernel/stage/stage.{hpp,cpp}` + `test_stage.cpp`, wired into
  `kernel/build.sh`: strict 5-field legacy parse (exact keys, no
  missing/extra/dup), known-stage vocabulary, checked capital (no
  atoll), calendar-validated ISO-8601 (leap rules), pipe-safe values,
  attest recompute vs predecessor (GENESIS bootstrap); anything
  unverifiable -> effective G0_PAPER + frozen reason. 15-case suite
  green normal+hardened; full kernel gate PASS.
- Slice D untouched (NOT AUTHORIZED): Slice E has no kill-switch
  dependency — verification is read-only and fails toward paper.
  H1 drill rows that require kill levels will be explicitly deferred
  with the dependency named, not silently skipped.

## Addendum 50 — Slice E audit fix (timezone grammar + status)
- MUST FIX 1: `ValidIso8601` numeric-offset tail rewritten — sign
  REQUIRED, strict `±HH:MM` / `±HHMM` shapes, HH 00–14 (14:xx
  rejected), MM 00–59. `+99:99`, bare `1234`, missing sign, bad
  colons all rejected; boundary offsets (`+14:00`, `-05:00`,
  `+0530`, `Z`, bare datetime) accepted. 13 new adversarial cases;
  suite green normal+hardened.
- MUST FIX 2: README/TODO now read P3.5 ACTIVE (A–C DONE, D NOT
  AUTHORIZED, E IMPLEMENTED pending acceptance, F+ OPEN).
- Escalation re-inspection: `effective` assigned only verified-file
  echo or G0_PAPER; stage.{hpp,cpp} is pure logic (no I/O, no env,
  no writes) — no indirect promotion path. Slice D absent/untouched.

## Addendum 51 — hosted CI green on Slice E fix commit
- Run 35904580571 on `b0c26b9`: stdlib + evidence + plane + kernel
  SUCCESS. (Prior run 35902488121 covered `38f23b2` likewise green,
  but acceptance requires the fix commit — now satisfied.)

## Addendum 52 — Slice E ACCEPTED; Slice F authorized
- Independent audit accepted Slice E (`b0c26b9` + docs-only
  `2c6191e`; hosted 35904580571 all-SUCCESS verified): timezone
  grammar, adversarial cases, fail-closed verifier, no promotion
  path, D untouched, status accurate.
- Architectural note carried (not a blocker): VerifyStageContents
  takes prev_attest from its caller — the eventual caller must source
  the predecessor from the authoritative chain. Owned by integration
  work (H1/cycle driver), not this slice.
- State: P3.5 A/B/C/E DONE, D NOT AUTHORIZED, F NEXT, G/H1 OPEN.
  Slice F proceeds under the same rule: feed machinery only, never a
  second authority for prices/stage/risk/execution; Alpaca paper-only;
  24h soak is evidence-gathering, never a gate bypass.

## Addendum 53 — Slice F built (feed machinery, no authority)
- `kernel/feed/feed.{hpp,cpp}` + `test_feed.cpp`, wired into
  `kernel/build.sh` (suite + heap-once allocation gate): 65536-tick
  ring (overwrite-oldest, monotonic writes, invalid-drop), venue-seq
  + poll-cadence gap detectors, deterministic backoff (1s<<n cap
  60s, saturating, no jitter), US-equities session marking (pure ET
  math incl. DST hour rules, caller-supplied holiday/early-close
  lists; unlisted days advisory-open with staleness as the real veto
  authority). Integers only, no floats.
- Two real defects caught by the suite before commit: 3MB stack
  member (heap-once fix) and a transition-day early-out swallowing
  the DST hour rule (both with regression tests). Suite green
  normal+hardened; full kernel gate PASS.
- Authority: no prices consumed, no veto/risk/execution logic — the
  ring records, downstream decides. 24h soak gate OPEN (needs an
  awake host; tracked, never a bypass). Slice D untouched.

## Addendum 54 — Slice F audit fix (gap detectors)
- MUST FIX 1 (PollGap): backward/duplicate timestamps now latch the
  gap WITHOUT moving the reference backwards; forward deltas use
  unsigned-exact differences (no signed-subtraction UB at INT64_MAX).
  Regressions: equal, +1 micro, exact-max, max+1, backward,
  backward-then-normal (proves reference preservation), INT64_MAX
  forward + duplicate.
- MUST FIX 2 (SeqGap): explicit UINT64_MAX overflow policy — latch +
  force re-init (never manufacture expected-0); zero/absent semantics
  unchanged, covered on both paths.
- Authority re-inspection: diff touches detectors + comments only; no
  veto/risk/stage/execution logic. Suite green normal+hardened, full
  kernel gate PASS, freeze PASS. Slice D untouched. F NOT claimed
  accepted (awaits fresh audit); Slice G NOT started.

## Addendum 55 — hosted CI green on Slice F fix commit
- Run 35908915502 on `9f966e0`: stdlib + evidence + plane + kernel
  SUCCESS.

## Addendum 56 — Slice F implementation ACCEPTED; soak OPEN
- Independent audit accepted `9f966e0` (+ docs-only `dd903827`;
  hosted 35908915502 all-SUCCESS verified): backward/dup latch with
  reference preservation, unsigned deltas, exact-threshold behavior,
  MAX overflow policy, zero semantics, no authority creep, D
  untouched.
- Carried constraints (not blockers): ring is single-threaded
  ("lock-free-shaped") — the production driver must not present it
  as thread-safe without the atomic ownership model; F 24h soak +
  reconnect evidence stays OPEN as an independent track (needs an
  awake host; never silently complete).
- State: P3.5 A/B/C/E DONE, D NOT AUTHORIZED, F IMPL-ACCEPTED +
  SOAK-OPEN, G NEXT, H1 OPEN. Slice G starts now.

## Addendum 57 — Slice G built (frozen Snapshot + context_hash)
- `kernel/ctx/snapshot.{hpp,cpp}` + `test_context.cpp`, wired into
  `kernel/build.sh`: 12-section Snapshot (marks/session/indicators/
  regime/sentiment/varcorr/portfolio/features/sources/stage/research/
  calib) with frozen vocabularies (regime trend|range|volatile,
  calib pass|insufficient|breach, Slice E stage set, feed session
  names), bounds/charset checks, present_mask coherence (set-but-
  empty is malformed; partial snapshots hash differently by
  construction), canonical JSON recipe with hand-written golden
  bytes, context_hash = sha256_hex(canonical).
- Unset provider sections are explicit (mask clear), never defaulted
  into authority; marks/session await F-driver fill, portfolio
  awaits H1. Suite: validation rejections, 10k-identical -> 1 hash,
  mutation sensitivity, golden — green normal+hardened; full kernel
  gate PASS, freeze PASS. Slice D untouched.

## Addendum 57 — Slice G audit fix (mask coherence + contracts)
- FIX 2 (mask): bidirectional coherence for all 12 sections —
  set+empty -> *-incoherent, clear+nondefault -> *-ghost; present
  zeros (flat book, zero flags/sentiment/brier-with-verdict) stay
  valid. 14 ghost + set-empty + present-zero tests.
- FIX 3: feature_bundle_hash lowercase-only (Slice C contract).
- FIX 4: duplicate mark/indicator/source names rejected + tests.
- FIX 5: var_corr_flags reserved bits (>0x3) rejected + tests.
- FIX 6: vocabulary gate now pins each exact definition line once +
  forbids stage literals outside Slice E (one gate self-trip caught:
  include comment tripped the count — comment fixed, gate kept).
- FIX 7 (resources): cycle-vs-tick boundary documented in
  snapshot.hpp; NEW wrapped-malloc proof `feed/test_noalloc_feed`
  (70k pushes + gap notes + backoff + session marks: 0 allocs) wired
  into build.sh; canonical output bounded (<=4KiB asserted).
  ContextHash stays off the tick path by documented contract.
- FIX 1 (change): CONTRACT GAP REPORTED, not invented. Searched
  plan/03/04/05 + jev_state + repo: no frozen unit/semantics for the
  §4.2.3 `change` field exists (jev `price_return_bucket` is a free
  string scalar, not a scale). Per the audit instruction the field
  was NOT added. H1 order-identity/replay binding must treat
  change-absence as a known snapshot limitation until the plan
  freezes the representation (doc edit required).
- Suite green normal+hardened, full kernel gate PASS, freeze PASS.
  Slice D untouched. No F/H1/poller/JEV changes.

## Addendum 58 — hosted CI green on Slice G fix commit
- Run 35915484245 on `db54d5a`: stdlib + evidence + plane + kernel
  SUCCESS.

## Addendum 59 — Slice G test closure (mechanical part)
- Set-empty rejection now explicit for all 9 non-integer sections
  (Bare()+solo-bit: marks/session/indicators/regime/features/
  sources/stage/research/calib); the 3 pure-integer sections
  (sentiment/varcorr/portfolio) assert set+zero VALID solo-bit, by
  the accepted present-zero design — there is no distinct empty
  state to reject for them.
- Noalloc timestamp comment corrected (Tuesday 2025-09-23).
- Suite green normal+hardened, full kernel gate PASS, freeze PASS.
- Three contract questions are NOT code-fixable and await a human
  protocol decision (see report): `change` representation, G
  SourceStatus vocabulary vs frozen JEV states, sentiment_d6[4]
  semantics. No invention applied.

## Addendum 60 — hosted CI green on Slice G test closure
- Run 35941951526 on `5b7e5aa`: stdlib + evidence + plane + kernel
  SUCCESS.

## Addendum 61 — Slice G v1 contract closure (audit rulings applied)
- Q1 (change): DEFERRED per ruling. Plan 04 sec. 4.2.3 amended: v1
  excludes `change` from Snapshot/context_hash; H1 must not infer
  it or treat absence as zero. No numeric representation invented.
- Q2 (source_status): G now uses exactly the frozen JEV vocabulary
  (healthy|stale|failed|not_scheduled|unavailable|na); the G-local
  fresh|stale|absent|invalid set is gone, with a build gate
  forbidding the retired literals. Tests: old spellings rejected,
  all six frozen states validate.
- Q3 (sentiment): `sentiment_d6[4]` + kSentiment REMOVED (11-section
  v1, mask 0x7FF); signal buckets deferred to a future typed schema.
  No numeric substitute introduced.
- Golden canonical bytes regenerated for the v1 shape (new
  context_hash 184e9826...); 9-of-9 set-empty + 2 integer
  set-zero-valid coverage preserved; ghost/mutation/10k/bounded
  green. Suite + full kernel gate PASS normal+hardened; freeze PASS.
  No F/D/H1/poller/JEV/research-plane changes.

## Addendum 62 — hosted CI green on Slice G v1 contract closure
- Run 35945952755 on `aad16ca`: stdlib + evidence + plane + kernel
  SUCCESS.

## Addendum 63 — Slice G v1 ACCEPTED, Plan 04 wording cleaned
- Independent re-audit ACCEPTED `aad16ca` (hosted 35945952755
  all-SUCCESS verified): change absent, H1 no-inference rule,
  sentiment removed, 0x7FF mask, frozen JEV source vocabulary with
  retired-literal gate, ghost/set-empty/zero semantics, golden
  regenerated, no out-of-scope changes.
- Plan 04 module description reworded to "full intended shape; v1
  contract below scopes the frozen subset" so the v1 paragraph is
  the single unambiguous statement (wording only, no semantics).
- Carried H1 integration constraint (not a G reopen): marks/
  indicators/sources vectors preserve supplied order with no
  semantic ordering rule — H1 must construct them deterministically;
  freeze a canonical ordering rule before any second producer
  assembles these arrays.
- Board: F IMPL-ACCEPTED + SOAK-OPEN, G v1 CLOSED, D NOT
  AUTHORIZED, poller/graph/f2/ingest track NEXT, H1 AFTER.

## Addendum 64 — production EDGAR source slice (implementation)
- NEW `research-plane/sources/edgar.py`: production adapter, NOT the
  tier_a evidence probe (untouched). Locked scope only: submissions
  recent-filings + single bounded companyfacts GET + ETag-cached
  CIK map; UA `MiroHedge/phase0 contact=<MIRO_CONTACT>`, missing
  contact raises ConfigError before any request; hard 10/s pacing
  via token bucket; per-request timeout; 2MB body cap; 3 retries w/
  injected jitter; 429 halves rate ONCE per episode + 1h throttle;
  8-K/10-Q/10-K/Form-4 filter; 7-day recent window; 64-record cap.
- Timestamps: observed_at_ns from regulator filingDate only;
  missing/invalid/future rows dropped+counted, never estimated;
  local time never substituted. Outage/empty -> ok=false/stale,
  never fabricated records. No secrets (keyless source), no broker
  access, errors carry no contact value (tested).
- Harvest-callable: harvest(watchlist, epoch) -> (recs, stamps)
  matching the graph envelope; fsync heartbeat (cadence 300/TTL
  900) with healthy/stale/failed/invalid states mirroring the
  earnings hardened pattern. No second persistence authority
  (CIK cache + heartbeat only, atomic renames).
- One suite-caught production fix: 429 re-doubled per retry (16x)
  -> now one halving per episode. One test-side float tolerance.
- Tests: 22/22 green (fake transport + fake clock, zero network).
  Full plane suite: 83 runnable green except 2 PRE-EXISTING Windows
  env failures (langgraph-absent import chain, PermissionError file
  tear) — identical with the slice stashed. Freeze PASS.
- Status: IMPLEMENTATION-COMPLETE, awaiting live operational
  evidence (soak, zero-403 record, measured p50/p99) + independent
  audit. No F/D/H1/poller-others/JEV/plan changes.

## Addendum 65 — hosted CI green on EDGAR source slice
- Run 35948979472 on `a2e6e57`: stdlib + evidence + plane + kernel
  SUCCESS (plane runs the venv-pinned suite incl. test_edgar).

## Addendum 66 — EDGAR audit-round-2 correction (single commit)
- BLOCKER 1 (urllib boundary): `_default_transport` now normalizes
  `urllib.error.HTTPError` into (status, headers, capped body); only
  genuine transport failures raise. Regression proves real 429/500
  HTTPError shapes end-to-end (mocked urlopen).
- BLOCKER 2 (CI): `test_edgar.py` wired into hosted CI stdlib job
  (direct-script invocation, verified locally in both styles).
- 429 episodes: one halving per episode on adapter state
  (`_on_429` new-episode only); `_pace` deterministically restores
  the ceiling rate after the hour. Cross-call + recovery tests.
  Two suite-caught issues fixed: 304-handler wiped stored
  validators (now ts-only refresh); recovery test re-armed with a
  200 route (a fresh post-window 429 correctly opens a new episode).
- Partial health: any requested-symbol error keeps ok=false +
  TTL-driven stale; records preserved, nothing fabricated.
- Caps: per-symbol 8-row omission REMOVED — full recent arrays
  scanned through the 7-day cutoff; global 64 cap overflow now
  counted as `truncated`, never silent.
- Arrays: `_recent_arrays` validates equal-length str lists for
  accession/form/date (+ present optional arrays) before indexing;
  misaligned payloads rejected as malformed.
- Conditional cache real: validators sent, 304 revalidates from
  cache, validators persist only after data commit; meta writes are
  atomic+fsync with unique tmp names (shared helper, also used by
  heartbeat tmp naming).
- SHOULD: `calendar.timegm` replaces the mktime round-trip; pacing
  measured at request-start instants.
- 31/31 EDGAR green; runnable plane 92 with only the pre-existing
  Windows file-lock failure; freeze PASS. Live SEC evidence (soak,
  zero-403, p50/p99) still OPEN — not claimed.

## Addendum 67 — hosted CI verifies the EDGAR suite (new step green)
- Run 35950609393 on `4db4939`: stdlib + evidence + plane + kernel
  SUCCESS, with the new evidence-job step `plane EDGAR adapter
  (stdlib only)` -> success. The 31-test adapter suite is now
  hosted-verified, not just locally green.

## Addendum 68 — EDGAR audit-round-3 correction (single commit)
- BLOCKER (overflow dedupe): accession enters `_seen` ONLY on emit;
  truncated rows stay eligible. Regression: 70-row poll emits 64 +
  truncates 6, second poll emits those 6 (duplicates only the 64
  already emitted). One suite-caught production fix: a clean poll
  whose own duration outlasts the TTL now reports stale (freshness
  from completion AND operation duration, TTL unchanged).
- Heartbeat reader strictly fail-closed (earnings pattern): exact
  8-key schema, int version, exact cadence/TTL, bool ok/stale, int
  records >= 0, str error <= 200, finite ts; ok+stale never healthy.
  12-case schema test incl. NaN/inf/wrong-type/extra-key/oversize.
- Files: every json.load(open()) + test direct-open replaced with
  `with` blocks; suite runs under PYTHONWARNINGS=error with zero
  ResourceWarnings.
- Atomic writes remove temp on all failure paths; pacing/throttle
  state runs on monotonic clock (injected fake clocks serve both;
  wall clock kept for source timestamps) — 10/s ceiling unchanged.
- 34/34 EDGAR green (both invocation styles); runnable plane 95
  with only the pre-existing Windows file-lock failure; freeze
  PASS. Live SEC evidence still OPEN — not claimed.

## Addendum 69 — hosted CI green on EDGAR round-3 correction
- Run 35953068725 on `8874a73`: stdlib + evidence + plane + kernel
  SUCCESS, EDGAR step success (34 tests hosted).

## Addendum 70 — EDGAR audit-round-4 correction (single commit)
- BLOCKER (acceptance time): `_acceptance_to_ns` parses the source's
  own acceptanceDateTime (strict `YYYY-MM-DDTHH:MM:SS[.ffffff]Z`,
  round-trip validated) and uses it as observed_at_ns when sane;
  rows without one carry filing-date midnight EXPLICITLY flagged
  `observed_at_estimated: True` (context-only downstream per doc 09
  R12, never TRIGGER); future acceptance (>now+skew) is DROPPED as
  not-yet-available, never estimated. Regression: pre-acceptance
  poll emits nothing; post-acceptance poll emits the exact second.
- Heartbeat authority: `completed_at` stamped in info at poll
  completion; `heartbeat()` uses that exact ts (fallback to now
  only for hand-made info). Delayed-write regression proves stale.
- Issuer binding: build-time pinned `entity_map` drives CIK solely
  (SEC ticker file never consulted, proven by URL capture); without
  a map the SEC-resolved CIK is carried visibly as
  `entity_ref: {"cik": "0000320193"}` — the exact shape the frozen
  resolver binds/rejects against the pinned map. Mismatch test:
  pinned foreign CIK requests only that CIK, emits nothing valid.
- Config: `contact_from_env({})` now means empty (None = process
  env); tested with cleared environ.
- 42/42 EDGAR green warnings-as-errors (both styles); runnable
  plane 103 with only the pre-existing Windows file-lock failure;
  freeze PASS. Live SEC evidence still OPEN — not claimed.

## Addendum 71 — hosted CI green on EDGAR round-4 correction
- Run 35955270740 on `39c8771`: stdlib + evidence + plane + kernel
  SUCCESS, EDGAR step success (42 tests hosted).

## Addendum 72 — EDGAR audit-round-5 correction (single commit)
- Heartbeat tmp cleanup: `write_heartbeat` removes its unique temp
  on EVERY failure path incl. `os.replace` failure (try/finally +
  tmp=None-on-commit, earnings pattern). Regression injects replace
  failure and proves zero orphans.
- Strict acceptance parser: explicit calendar ranges (month/day w/
  leap-year lengths, hour<=23, min/sec<=59 — leap-second 60 now
  rejected, not normalized) plus epoch round-trip validation before
  any value becomes authoritative. Adversarial sweep (sec 60, min
  61, hour 25, missing Z, Feb 30, month 13, garbage) proves every
  one falls back to flagged-estimated midnight, never to a shifted
  authoritative instant.
- Docs: module docstring now states acceptanceDateTime-preferred /
  midnight-estimated-fallback and acceptance-vs-availability
  semantics; entity_map comment pins mechanical derivation from
  the single collector/entity_map.json for future wiring.
- One self-caught edit slip repaired before green: a restore edit
  dropped the delayed-heartbeat def line (44-def count verified).
- 44/44 EDGAR green warnings-as-errors (both styles); runnable
  plane 105 with only the pre-existing Windows file-lock failure;
  freeze PASS. Live SEC evidence still OPEN — not claimed.

## Addendum 73 — hosted CI green on EDGAR round-5 correction
- Run 35956762723 on `e708b5e`: stdlib + evidence + plane + kernel
  SUCCESS, EDGAR step success (44 tests hosted).

## Addendum 74 — EDGAR round-6 correction (single commit)
- Cross-date acceptance: removed the `ns < filing_midnight_ns`
  rejection. After-hours acceptances carrying next-business-day
  filing dates stay authoritative (strict shape/calendar/round-trip
  + future policy unchanged; old events still bounded by the
  lookback cutoff, no calendar dependency invented). Regression:
  Fri 21:00 acceptance + Mon filing date emits the exact Friday
  instant with estimated=False.
- INTEGRATION GATE (recorded, not fixed here): estimated EDGAR
  timestamps MUST map to resolver published_ns=None + permanent
  context cap at canonical-wiring time; never copy an estimated
  instant into published_ns. Production CIK wiring must derive
  symbol->CIK mechanically from collector/entity_map.json.
- One self-caught edit slip repaired before green (placeholder def
  with a space + dropped neighbor def lines; def-count and
  per-test listing verified: 45 defs, 45 pass).
- 45/45 EDGAR green warnings-as-errors (both styles); runnable
  plane 106 with only the pre-existing Windows file-lock failure;
  freeze PASS. Live SEC evidence still OPEN — not claimed.

## Addendum 75 — hosted CI green on EDGAR round-6 correction
- Run 35958477959 on `e424362`: stdlib + evidence + plane + kernel
  SUCCESS, EDGAR step success (45 tests hosted).

## Addendum 76 — EDGAR round-7 correction (single commit)
- Pinned CIK covers companyfacts: `fetch_facts` rejects foreign
  CIKs (`cik-unmapped`) BEFORE any request when a map is
  configured; new `fetch_facts_for(symbol)` resolves through the
  pinned map (unknown/no-map are explicit errors, never fetches).
  Regression proves zero transport calls for foreign CIK +
  standalone behavior preserved without a map.
- HTTPError deterministic close: try/finally `e.close()` after
  bounded body/header extraction (CPython Windows finalization
  gap). Regressions with close-tracking fp prove close on both
  the normal 429 path and the body-read-failure path.
- No acceptance/estimated/resolver/entity-map changes. 47/47
  EDGAR green warnings-as-errors (both styles, def-count matched);
  runnable plane 108 with only the pre-existing Windows file-lock
  failure; freeze PASS. Live SEC evidence still OPEN — not claimed.

## Addendum 77 — hosted CI green on EDGAR round-7 correction
- Run 35959871294 on `27657b9`: stdlib + evidence + plane + kernel
  SUCCESS, EDGAR step success (47 tests hosted).

## Addendum 78 — FRED/ALFRED source slice (implementation)
- NEW `research-plane/sources/fred.py` + `tests/test_fred.py`
  (20/20 warnings-as-errors, both styles): observations-only scope
  + ALFRED realtime windows; FRED_API_KEY fail-closed (ConfigError,
  never a default); sentinel-key test proves the credential is in
  the query only, never errors/records/heartbeats/headers; 401/403
  reported as key-denied; conservative 1/s pace + episode throttle;
  HTTPError normalized + explicitly closed; "." values dropped;
  day-granularity observed flagged estimated (ALFRED realtime
  window carried); vintage fetch + replay-identical regression;
  completion-stamped strict heartbeat; harvest envelope; partial
  poll unhealthy; emit-before-seen dedupe; SERIES_CORE operating
  set documented as non-frozen config. Wired into hosted CI stdlib
  job beside EDGAR.
- One test-side fix: harvest-envelope test now routes all core
  series (harvest polls the full core set by design).
- Runnable plane 128 with only the pre-existing Windows file-lock
  failure; freeze PASS. Live FRED evidence (soak, p50/p99, live
  ALFRED replay) OPEN — not claimed. No EDGAR/resolver/JEV/kernel/
  plan changes. Treasury/BLS/BEA untouched — next slices.

## Addendum 79 — FRED 400 error-semantics correction
- HTTP 400 is generic Bad Request: key-denied is now classified
  ONLY on explicit api-key evidence in the error message (never
  from status alone, never logged). 401/403 stay key-denied per
  HTTP auth semantics. Regressions: ordinary 400 (missing
  series_id) reports plain HTTP 400 with no denial; key-evidence
  400 reports denied with no leakage. 429/500/retry/throttle
  untouched. 22/22 FRED green warnings-as-errors (both styles).
- Correction to Addendum 78: the "wired into hosted CI" claim was
  premature — the CI-wiring commit is local-only until a
  workflow-scope push lands it. No hosted FRED verification is
  claimed until a run checks out the CI commit and logs 20+/20+.

## Addendum 80 — FRED vintage/latest hardening (single commit)
- Vintage provenance: rows must carry their own valid YYYY-MM-DD
  realtime_start/end; missing/malformed rejected, never
  synthesized from request params. Mismatched returned windows are
  carried as returned (provider truth, not caller intent).
- Latest selection: explicit sort_order=asc requested AND max valid
  observation date selected deterministically; out-of-order rows
  cannot become latest. 24/24 FRED green warnings-as-errors.
- Runnable plane 132 with only the pre-existing Windows file-lock
  failure; freeze PASS. No EDGAR/resolver/JEV/kernel/plan changes.
  Hosted FRED suite still awaits the workflow-scope CI push.

## Addendum 81 — FRED CLOSED (hosted suite proof)
- `72ca59f` pushed (workflow-scope token); run 36013253054 on
  that exact SHA: stdlib + evidence + plane + kernel SUCCESS.
- Hosted evidence log proves the explicit step
  `python3 research-plane/tests/test_fred.py` -> `Ran 24 tests
  ... OK` (same log: isolation 3, sources 39, EDGAR 47, all OK).
- FRED implementation audit CLOSED. Remaining OPEN gates (not
  code defects): live soak, measured p50/p99, live ALFRED replay.

## Addendum 82 — Treasury source slice (implementation)
- NEW `research-plane/sources/treasury.py` + `tests/test_treasury.py`
  (13/13 warnings-as-errors, both styles): locked auctions_query
  scope only; keyless (MIRO_CONTACT UA preferred, fixed fallback);
  conservative 1/s monotonic pace + episode throttle; HTTPError
  normalized + closed; cusip+record_date PK dedupe with
  emit-before-seen + counted truncation; auction_date midnight
  flagged estimated; completion-stamped strict heartbeat with tmp
  cleanup; harvest envelope. Wired into hosted CI stdlib job.
- Runnable plane 145 with only the pre-existing Windows file-lock
  failure; freeze PASS. Live Treasury evidence OPEN — not claimed.
  No EDGAR/FRED/resolver/JEV/kernel/plan changes. BLS/BEA NEXT.

## Addendum 83 — hosted CI green on Treasury slice (first try w/ scope)
- Run 36015299638 on `f02cffd`: stdlib + evidence + plane + kernel
  SUCCESS, Treasury step success (13 tests hosted). Workflow-scope
  token confirmed working — no delivery split needed anymore.

## Addendum 84 — Treasury correction (single commit)
- BLOCKER (empty health): `data=[]` and all-rows-dropped now yield
  ok=False with last_ok_ts frozen; health requires >= 1 usable
  record. Partial success (>= 1 record) stays healthy with drops
  visible. Regressions: empty, all-invalid, mixed, last_ok-pinned.
- Page capacity matches cap: auctions_query page[size]=64 (was 20);
  URL asserted exactly. Truncation path genuinely reachable.
- Provenance corrected to treasury-securities-auctions-data, exact
  assertion. Strict YMD for both dates + 9-char alnum CUSIP;
  fixtures updated to valid CUSIPs; midnight stays estimated.
- 18/18 Treasury green warnings-as-errors (both styles, def-count
  matched); runnable plane 150 with only the pre-existing Windows
  failure; freeze PASS. Live Treasury evidence still OPEN.

## Addendum 85 - Treasury timestamp-authority correction
- record_date is the publication authority: observed_at_ns comes from
  record_date midnight (estimated), never auction_date. A future
  auction_date with current record_date now EMITS (announced auction
  is published information today); future record_date DROPS.
- auction_date is REQUIRED event metadata: the record_date fallback
  is removed; missing/empty/malformed auction_date is dropped, never
  synthesized. Preserved verbatim on emit.
- Duplicate-only steady-state polls stay healthy: health uses a
  usable-row count (new or already-seen), so unchanged datasets keep
  advancing last_ok_ts instead of aging into stale.
- 22/22 Treasury green warnings-as-errors (both styles); runnable
  plane 154 with only the pre-existing Windows failure; freeze PASS.
  Live Treasury evidence still OPEN. Treasury NOT CLOSED.

## Addendum 86 - Treasury closure (observability + accepted)
- Independent re-audit ACCEPTED Treasury implementation/correctness
  (record_date publication authority, required auction_date, usable-
  row steady-state health, page-64, exact provenance).
- Final hardening: nonempty/all-invalid payload now records explicit
  bounded no-usable-records in info errors, last_error, and heartbeat
  error (was: ok=false with blank reason). No fail-open/fail-closed,
  TTL, pacing, retry, dedupe, truncation, timestamp, or schema change.
- 23/23 Treasury green warnings-as-errors (both styles). Live soak +
  measured p50/p99 remain OPEN, unclaimed. No BLS/BEA work in scope.

## Addendum 87 - BLS source slice (implementation)
- NEW research-plane/sources/bls.py + tests/test_bls.py (15/15
  warnings-as-errors, both styles): locked empsit.rss scope only;
  keyless (MIRO_CONTACT UA preferred, fixed fallback); strict
  RFC-822 pubDate parsed to publication-day midnight estimated;
  future publication days dropped; guid PK dedupe (missing/empty
  guid drops, never link-fallback); empty-data and no-usable-records
  fail closed with explicit reasons; duplicate-only polls healthy via
  usable count; 1/s monotonic pace + episode throttle; HTTPError
  normalized + closed; 2MB cap; emit-before-seen dedupe with counted
  truncation; completion-stamped strict heartbeat + tmp cleanup;
  harvest envelope with values_pending. Symbols mirror pinned map
  NFP. Wired into hosted CI stdlib job. Live BLS evidence OPEN.
  No EDGAR/FRED/Treasury/resolver/JEV/kernel/plan changes.

## Addendum 88 - BLS adversarial audit hardening (agent self-audit)
- Probed 15-point checklist empirically. Three real defects found:
  (1) parsedate_to_datetime accepted non-RFC-822 shapes (missing
  weekday, 1-digit day, 2-digit year) despite the strict claim ->
  full-shape regex gate added, parsedate kept for semantic validity;
  (2) empty title/link rows were EMITTED despite headline+link
  contract -> both now required; (3) stdlib ET expands internal
  entities (proven: 80-char expansion in probe) -> DOCTYPE bodies
  rejected as malformed-xml.
- Verified clean, no change needed: no production consumer imports
  sources.bls (no f2 drift possible); kind macro_release within
  frozen schema allowlist; truncation/seen ordering + duplicate-only
  health + 429/pacing + HTTPError close + heartbeat/tmp already
  correct with tests; estimated flag preserved for resolver path.
- 5 new regressions (20/20 warnings-as-errors, both styles):
  strict-shape triple + valid control, headline+link triple,
  DOCTYPE rejection, SYMBOLS == pinned entity_map NFP (loaded, not
  asserted), _read_capped exact-MAX vs MAX+1 boundary.
- BLS code acceptance NOT claimed: pending hosted proof of this
  commit + independent re-audit. Live evidence OPEN.

## Addendum 89 - BLS weekday/TZ semantic strictness (re-audit fix)
- Re-audit proved the shape gate still accepted Foo weekdays,
  weekday/date mismatches, and arbitrary TZ tokens. Fixed narrowly:
  weekday token must equal the calendar weekday of the parsed date
  (explicit Mon..Sun table, locale-independent); TZ restricted to
  UT/GMT/Z/EST/EDT/CST/CDT/MST/MDT/PST/PDT or numeric +-HHMM with
  range-checked fields; naive datetimes rejected; clock fields
  range-checked (leap-second 60 rejected, matching EDGAR precedent).
- Regression test_weekday_tz_semantics: 4 adversarial rows drop,
  numeric-+0000 row emits with record-day midnight. No timestamp
  model, source, or schema change.
- 21/21 BLS green warnings-as-errors (both styles). BLS code
  acceptance NOT claimed: pending hosted proof + independent audit.
  Live evidence OPEN.

## Addendum 90 - BLS code ACCEPTED (independent re-audit)
- Independent re-audit of 7817f20 + hosted 36036667089 CLOSED BLS
  implementation/correctness: weekday/date consistency, constrained
  TZ forms, naive rejection, clock/leap checks all accepted.
- BLS code ACCEPTED. Live soak + measured p50/p99 remain OPEN
  operational evidence, running in parallel (never retro-blocking).

## Addendum 91 - BEA source slice (implementation)
- NEW research-plane/sources/bea.py + tests/test_bea.py (19/19
  warnings-as-errors, both styles): ONE locked GetData call
  (NIPA/T10101/Frequency=A, clock-derived Year prev,cur); keyed
  source fail-closed without BEA_USER_ID; key in query string only,
  proven absent from all errors/heartbeats; HTTP-200 nested
  Results.Error/BEAAPI.Error classified denied with bounded
  description (never denial-masked transport); strict 4-digit
  TimePeriod not future; SeriesCode-else-LineNumber identity never
  synthesized; DataValue finite-numeric (commas ok; (NA)/inf/nan
  dropped); period-Jan-1 midnight estimated; (table,series,period)
  PK dedupe; empty-data/no-usable-records fail closed; duplicate-only
  healthy via usable count; 1/s pace + episode throttle; HTTPError
  normalized + closed; 2MB cap; counted truncation; strict heartbeat
  + tmp cleanup; harvest envelope. Wired into hosted CI stdlib job.
  Probes run BEFORE tests: 10 envelope variants, year/value/series
  edges, key isolation, query lock, build fail-closed — all correct.
  Live BEA evidence OPEN. No EDGAR/FRED/Treasury/BLS/resolver/JEV/
  kernel/D/H1 changes. BEA code acceptance NOT claimed (re-audit).

## Addendum 92 - BEA credential/numeric correction (re-audit fixes)
- Re-audit found two real defects in 5b4eaa3:
  (1) APIErrorDescription copied verbatim into denied/last_error/
  heartbeat, so a provider error echoing BEA_USER_ID would leak the
  credential -> every exact credential occurrence now redacted to
  [REDACTED] at the poll() boundary (key still only in query).
  (2) DataValue float()-after-strip-commas silently repaired
  malformed source data ('1,2,3'->123, '1_000'->1000) -> strict
  grammar: signed decimals/scientific with valid thousands grouping
  only; float() kept for finiteness; original string preserved.
- 3 new regressions (22/22 warnings-as-errors, both styles):
  denied-description redaction across errors/last_error/heartbeat,
  key-in-exception-message non-leak (type-only errors proven), 30
  good/bad numeric vectors + end-to-end malformed drop. No source,
  schema, timestamp, or model change. BEA acceptance NOT claimed;
  live evidence OPEN.

## Addendum 93 - BEA downstream namespace registration (audit fix)
- Re-audit proved bea_nipa_gdp absent from the frozen downstream
  namespace (ctx_read SOURCE_IDS/KINDS/COVER, schema EMITTERS/TIER/
  TTL): adapter records could not traverse f2 admission. Verified
  against plans BEFORE changing: doc 09 Tier-A table lists BEA as
  TRIGGER macro (option 1 intended); manifest owns no source list;
  classify.py branches are collector-poll scoped (BEA not polled
  there) so untouched; no exact-set test assertions exist.
- Minimal analogous registration: ctx_read COVER 1080 + KINDS
  {macro_release} (annual values only; calendar_ahead stays
  kind-no-emitter by design); schema EMITTERS (macro_release,),
  TIER high (doc-09 Tier A), TTL 64800.
- Regressions: ctx suite bea-admitted (fresh-history bundle),
  bea-wrong-kind, unknown-source-still-rejected; BEA suite
  test_downstream_registry_admission (both registries + adapter
  kind matches registration). BEA behavior otherwise unchanged.
  BEA acceptance NOT claimed; live evidence OPEN.

## Addendum 94 - BEA code ACCEPTED (independent integration audit)
- Independent audit of 9ef8956 ACCEPTED BEA downstream integration:
  ctx_read + schema registration correct, resolver admission works,
  plan/09 Tier-A placement confirmed, manifest/sources.json/classify
  correctly untouched, regressions prove admission + rejections,
  hosted 36042332716 green. No new defect.
- BEA code ACCEPTED (implementation + correction + integration).
  Live soak + measured p50/p99 remain OPEN parallel evidence.
  Known blemish (not correctness): 9ef8956 baked a CRLF->LF flip of
  ctx_read.py; left as history per audit instruction, no rewrite.

## Addendum 95 - source->graph production seam (Track A wiring)
- ARCHITECTURE DECISION (explicit): plan/08 s8.3 governs -- graph
  harvest pulls doc-09 sources by invoking the five accepted
  adapters. New research-plane/plane/source_seam.py owns the single
  adapter singletons, per-source isolation, stamps, heartbeats, and
  the canonical mapping into resolver/f2/publish/ctx_read. Frozen P1
  collector untouched; one poll path per source inside Phase 2.5;
  credentials only in seam construction; seam never trades.
- Canonical mapping: published_ns = adapter instant ONLY when
  non-estimated (EDGAR authoritative acceptance); estimated ALWAYS
  None + R12 cap (evidence inference, CONTEXT-only, never TRIGGER).
  effect None (unknown; no directional invention); value
  presence-count; content_hash = sha256 of adapter bytes.
- Note: even authoritative EDGAR stays evidence=inference until a
  measured effect table exists (promotion gate) -- resolver requires
  a real effect for source evidence. No invention at wiring layer.
- 11/11 seam tests warnings-as-errors (both styles): per-source full
  chain harvest->canonical->resolver->publish-bundle->ctx_read,
  estimated cap, EDGAR authoritative high-confidence, malformed/
  unknown/wrong-kind rejected, outage = absence + failed heartbeats,
  singleton single-poll, missing keys fail-closed, EDGAR skip on
  forex-only watchlist. Plane 210 (only pre-existing Windows
  failure); ctx suite green; freeze PASS. Wired into hosted CI.
  Live soak/p50-p99 stay OPEN parallel. No kernel/D/H1/JEV change.

## Addendum 96 - seam production-boundary corrections (audit fixes)
- Exact audit findings closed, preferring seam fixes (no adapter
  semantic changes):
  1. PACING: build_seam now takes explicit sleeper/mono (production
     defaults time.sleep/time.monotonic; tests inject). Regression
     wires a stepped mono + recording sleeper and proves the second
     harvest actually waits; adapter mono identity asserted.
  2. REAL GRAPH PATH: new plane/runner.py (stdlib-safe lazy graph
     import) owns one seam + one app per process; build_runner binds
     seam.harvest into build_graph deps. tests/test_seam_graph.py
     (plane job, venv) proves real run_cycle -> seam adapters ->
     raw/stamps/history + cross-cycle adapter sharing.
  3. REAL PUBLISH PATH: test_production_publish_path runs fused
     parser candidates through publish.resolve_emit (real watermarks
     callback) and the emitted file through frozen ctx_read.
  4. LINEAGE PERSISTENCE: CanonicalStore.note() writes the shared
     canonical records table (same authority ctx_read checks; same
     keying; INSERT OR IGNORE + touch; verdict new, parser seam-v1,
     per-source adapter PKs, NULL-safe published). DDL pinned equal
     to classify.init_db by test. No test-seeded rows anywhere.
  5. HISTORY: harvest returns (recs, stamps, history) -- one bounded
     honest entry per source per poll, strictly increasing ts, only
     noted records; graph validation + bundle path carry it.
  6. HEARTBEAT FAILURE: write exceptions mark stamp heartbeat_error
     visibly; poll health still describes the poll. Regression uses
     a file-as-dir to force failure.
  7. ESTIMATED STRICTNESS: observed_at_estimated must be real bool
     (missing stays conservative); 'false'/0/1/None/etc. reject.
  8. SINGLETON: Runner owns seam+app for life; regression proves
     adapter identity + per-cycle polls across two real cycles.
- 16/16 seam + 2/2 graph tests warnings-as-errors (both styles for
  seam; graph via venv script + module modes). Plane 215 (only
  pre-existing Windows failure); ctx green; freeze PASS. Live
  soak/p50-p99 OPEN parallel. No kernel/D/H1/JEV change.

## Addendum 97 - seam production-boundary corrections v2 (audit fixes)
- Exact second-audit findings closed, seam-side (no adapter, no
  collector semantic changes):
  1. PRODUCTION COMPOSITION: new tracked caller
     plane/runner.py::build_production_runner (heartbeat sink
     required, MIRO_CANONICAL_DB-honoring lineage default, owned
     seam+app, caller-supplied LLM deps only). build_runner refuses
     heartbeat-less construction (ConfigError, regression-proven).
  2. ONE TRUE E2E: test_seam_graph.test_one_true_end_to_end runs
     production runner -> run_cycle -> owned seam -> store lookup ->
     publish.resolve_emit -> emitted bundle -> frozen ctx_read
     (accepted>0) + history present + every emitted (source_id,hash)
     row-proven in the authoritative lineage DB. Standalone
     publish-leg test reframed as a leg unit, not the chain.
  3. CANONICAL AUTHORITY: seam hashing REMOVED. Each adapter record
     is adapted to the frozen collector canonical shape, validated
     by frozen validate_record + temporal_violation, ingested by
     frozen ingest_signal into the SHARED records table; the
     RETURNED hash is the resolver/ctx canonical_hash (proven equal
     to classify.content_hash of the stored row). Same authority,
     same table, same hash contract.
  4. MIRO_CANONICAL_DB honored by seam default (resolution matches
     frozen collector rule; regression proves writes land in the
     scratch DB ctx_read reads).
  5. LINEAGE FAIL-CLOSED: persist/validate failure -> note() None ->
     record excluded from recs_all with visible lineage_dropped per
     source stamp; nothing publishable without lineage (regression
     with unwritable DB: recs empty, store empty, drops visible).
  6. HISTORY HONESTY: append strictly on newer ACTUAL poll ts; same
     instant repeats append nothing (regression: fixed clock, two
     polls, identical single-entry tails, sources healthy).
  7. HEARTBEAT SINK: production requires explicit dir (or composed
     default data/heartbeats); tests inject tmp dirs.
  8. LIFECYCLE: two REAL cycles share Runner/Seam/adapter identities
     with polls+1 each (tautology removed).
- 19/19 seam + 3/3 graph tests warnings-as-errors. Plane 218 (only
  pre-existing Windows failure); ctx green; freeze PASS. Live
  soak/p50-p99 OPEN parallel. No kernel/D/H1/JEV/collector-behavior
  change.

## Addendum 98 - seam production-boundary v3 (re-audit P0/P1/P2 fixes)
- P0 PRODUCTION PUBLISHER WIRING (the central defect): the graph's
  own emit node now publishes through seam-owned callbacks.
  build_runner binds THREE seam-owned deps (harvest, parser_extract,
  resolve_emit) and REFUSES caller-supplied ones (ConfigError each —
  regression-proven, so no test fake can silently override). The
  missing link the re-audit exposed: harvest stamps the authority
  hash ON each kept record, and seam.parser_extract converts adapter
  rec -> parser candidate carrying ONLY authority-resolved lineage
  (lineage-less input yields no candidate). publish.resolve_emit
  receives {outdir, map_path, canonical_for=store lookup,
  watermarks=seam watermarks}; the bundle path surfaces on the cycle
  output. No manual second publisher invocation exists anywhere.
- P0 ONE TRUE E2E: test_one_true_end_to_end runs
  build_production_runner -> Runner.run -> graph.run_cycle ->
  seam.harvest -> graph nodes (seam parser_extract) -> graph emit ->
  real publish.resolve_emit -> real emit_bundle -> frozen ctx_read
  (accepted>0), history present, every graph-produced feature hash ==
  classify.content_hash(stored raw_json). AST sentinel proves the
  test module binds no canonical_for/source_watermarks/_canon.
- P0 FRESH CALLER: production_graph_deps documents the caller side
  (GraphTest deps minus the three seam-owned); composition refuses
  all three overrides. Dependency split documented in runner.py.
- P1 RESTART CANONICAL: seam_canonical projection table in the same
  lineage DB, written in the same commit as the authority ingest,
  keyed by the authority hash; canonical_for falls back to it on
  memory miss (corrupt/absent -> None, fail closed). Regression:
  harvest -> wipe memory -> same hash resolves identically.
- P1 RESTART HISTORY: Seam.restore_from_bundles rebuilds bounded
  tails from durable accepted bundles (shape + monotonicity
  re-validated; single global merge = honest suffix). No bundles ->
  explicit warming (no frozen coverage claimed). Restart regression:
  3 fresh Runners at +5h steps over same DB+bundles; tails recover
  exactly ([ts0, ts0+5h, ts0+10h]); cycle-3 read gives accepted=5 /
  rejected=5 / {frozen-feed:4, ttl-expired:1, inference-capped:5} —
  the recovered tail trips frozen-feed for the 4 same-hash sources
  (span 10h >= 9h cover/2), the 10.5h-old filing layer-honestly
  ttl-expires past its 45min TTL.
- P2 DOCS: ARCHITECTURE.md reconciled (§4 composition/ownership/
  restart, §5 runner+seam entries, §8 dual production paths, §9
  FRED/BEA wiring moved FUTURE->SHIPPED-pending-acceptance, tests
  list current).
- Kept without regression: real sleep/monotonic, strict estimated
  flag, same-ts history, lineage fail-closed, heartbeat required,
  outage isolation, one adapter per Runner lifetime.
- 23/23 seam (stdlib) + 6/6 graph (plane) warnings-as-errors; plane
  222 (only pre-existing Windows tear failure, proven on pristine
  tree); ctx green; freeze PASS. Live soak/p50-p99 OPEN parallel.
  No kernel/D/H1/JEV/risk/sizing/collector-behavior change.

## Addendum 99 - seam restart/integrity closure (re-audit P1/P2 + WAE)
- P1 CHECKPOINT-RESUME WATERMARKS: Seam.watermarks(state) now vouches
  from the CURRENT cycle harvest state (graph-checkpointed stamps:
  ok + checked_at_ns shape-checked, epoch from state) with process
  memory as fallback only when no state is passed. Regression:
  harvest completes -> emit crashes (outdir replaced by a file) ->
  Runner memory discarded -> SAME thread_id resumes at the emit node
  via app.invoke(None) on a fresh Runner (empty _by_hash AND empty
  last_stamps) -> resumed emit publishes the original cycle's bundle
  (ctx accepted>0) with the fresh adapters at polls==0 (no second
  harvest, no manual publisher call). Memory-only watermarks would
  have published nothing.
- P1 VERIFIED-ONLY HISTORY: new plane.emit.committed_histories
  (manifest rows + file-SHA + envelope-semantics verification, the
  same chain as latest_complete; orphans/corrupt/mismatched files
  contribute nothing). restore_from_bundles consumes ONLY those
  generations AND binds every recovered hash to real records lineage
  (content_hash + source) per entry, fail-closed. Regressions:
  orphan file (valid shape, no manifest row) ignored; committed-
  then-corrupted file ignored; missing-file manifest row ignored;
  forged valid-shape hash inside a COMMITTED bundle dropped;
  verified committed generation recovered exactly.
- P1 PROJECTION CROSS-CHECK: seam_canonical gains tamper-evident
  canon_sha + raw_sha (same commit as the authority ingest; older
  two-column tables migrate via ADD COLUMN, old rows fail closed
  until re-noted). Every memory-miss fallback verifies: projection
  self-checksum + parse + hash identity + authority row present +
  authority-bytes checksum + classify.content_hash(raw)==hash +
  authority source == projection source_id. Regressions: valid
  resolves; tampered JSON fails; wrong-source fails; missing row
  fails; corrupt raw fails; wipe + valid DB recovers. Graph-produced
  features resolve through this path (e2e authority re-check kept).
- WAE HONESTY: fixed all unclosed-file ResourceWarnings in ACTIVE
  plane tests (test_plane 8 sites, test_emit 4, test_hardening 3;
  test-only with-blocks, no behavior change). Hosted CI now
  enforces PYTHONWARNINGS=error on the full evidence job and the
  full plane battery (stdlib job stays plain: frozen collector
  suites, accurately stated).
- Kept without regression: frozen authority hash, real pacing,
  strict estimated bool, lineage fail-closed, heartbeat required,
  healthy-only watermarking, honest same-ts history, one
  Runner/Seam/adapters per process, seam-owned callback refusal,
  graph-emit-only publishing, no kernel/D/H1/JEV/risk/sizing/
  collector-behavior changes (protected-area diff empty).
- 25/25 seam + 7/7 graph warnings-as-errors; evidence 185 clean
  (test_sources: only pre-existing Windows tear failure, proven on
  pristine tree, hosted Linux unaffected); ctx green; freeze PASS.
  Live soak + measured p50/p99 explicitly OPEN (parallel evidence).

## Addendum 100 - live soak round-1 (Track A operational evidence)
- Harness: research-plane/sandbox/source_soak.py polls the five
  ACCEPTED production adapters live (real pacing/backoff, 6 cycles,
  per-poll latency/ok/records/errors + heartbeat files). Evidence:
  research-plane/sandbox/soak-evidence-live.json. Exit 0 always.
- Results: EDGAR p50=94ms p99=125ms all-ok (1 filing then
  duplicate-steady-state); FRED p50=6016ms p99=6453ms all-ok (6
  series at the conservative 1/s pace); Treasury p50=2750ms
  p99=3266ms all-ok; BEA p50=984ms p99=1609ms all-ok; heartbeats
  healthy for all four.
- BLS: 6/6 live HTTP 403 from this egress (bot-filtered), adapter
  recorded bad-envelope/stale + heartbeat ok=False every cycle —
  fail-closed behavior PROVEN against a real live refusal (not a
  fixture). BLS p50/p99 stays OPEN pending an allowed egress; the
  frozen UA is NOT to be altered to evade the refusal.
- FRED/ALFRED vintage replay remains PROVEN per Box 7 (Addendum 35);
  this round covers the live observations path. Extended soak +
  outage/TTL behavior stay OPEN parallel evidence. No code-path
  changes (harness + evidence only).

## Addendum 101 - soak percentile correction (evidence-harness fix)
- Re-audit found source_soak.pct() used nearest-rank (6-sample p50
  picked the 4th ordered value, e.g. FRED 6016ms instead of the
  5984.5ms median). Fixed to documented linear interpolation
  (rank=q*(n-1), numpy linear method), same method for p50/p99,
  with --selftest regression (15 cases: empty/singleton/pair/odd/
  even/large/exact/interpolated/unsorted, 0 failures).
- Evidence regenerated from the corrected harness (same 6-cycle
  protocol, raw per-cycle samples preserved, n recorded, nothing
  hand-edited): EDGAR n=6 p50=94/p99=837.5 ok; FRED n=6 p50=6000/
  p99=6265.2 ok; Treasury n=6 p50=2711/p99=2887.7 ok; BEA n=6
  p50=992.5/p99=1029.4 ok; BLS n=6 still 6/6 live-403 (unchanged
  fail-closed evidence; its latency stats describe refused polls
  only, all_ok=False unambiguous). Frozen UA untouched.
- Seam stays CLOSED/ACCEPTED (6fdeda7): this is evidence-layer only.
  Extended soak + BLS egress + TTL/outage behavior stay OPEN.

## Addendum 102 - extended soak n=30 + live seam pass
- Extended soak (source_soak.py --cycles 30, corrected percentiles,
  soak-evidence-extended.json): 120/120 polls healthy with zero
  errors on EDGAR/FRED/Treasury/BEA (p50s 125/6008/2563/1016ms;
  p99s carry real long-tail samples, e.g. Treasury 7076.9ms);
  BLS 30/30 live-403, fail-closed every cycle, heartbeat unhealthy.
  n=30 is still probe-scale, not a long soak.
- Live seam pass (sandbox/seam_live_pass.py, seam-live-pass.json):
  ONE harvest through the real production seam (live transports,
  real pacing/creds): 85 live records (EDGAR 1, FRED 6, Treasury
  53, BEA 25, BLS 0) -> 85 fused parser candidates -> real
  publish.resolve_emit (64-feature cap: 21 over-cap dropped) ->
  emitted bundle -> frozen ctx_read: 63 accepted
  (inference-capped) + 1 ttl-expired. BLS absence blocked nothing:
  outage-is-absence proven on live data through the ACCEPTED path.
- Observed transient: the first live-pass attempt (immediately
  after the n=30 soak) showed FRED not-ok; the retry passed clean.
  Plausibly server-side pacing after consecutive runs; reported as
  observed + recovered, cause not proven. TTL/outage RECOVERY
  (healthy->stale->healthy) stays OPEN — nothing here forced a
  real recovery transition on a healthy source.
- FRED/ALFRED vintage replay re-verified live this round
  (fred_vintage_probe: observations + as-known-2020-01-01 replay
  byte-identical + bad-key denied = PASS).
- Harness-only + evidence files. Seam CLOSED/ACCEPTED; Phase D
  operational gate OPEN; H1 NOT AUTHORIZED, not started.

## Addendum 103 - healthy/stale/healthy runtime proof + asserted live pass
- Stale/recovery (research/sandbox/stale_recovery.py,
  stale-recovery.json): fault injected ONLY at the transport layer
  (real Treasury urllib transport vs TimeoutError switch); adapters,
  seam, pacing, lineage, publisher, reader all real; fresh seam per
  phase over shared lineage DB + outdir; invariants asserted
  in-script (exit 1 on violation).
  A healthy: 85 records, treasury ok, 32 treasury features, ctx 63
  accepted. B faulted x2: treasury stale, 0 records, ZERO treasury
  features, uncovered treasury history dropped from the bundle,
  31 accepted from unrelated sources, treasury heartbeat bad.
  C recovered: treasury ok again, 32 treasury features, ctx 63
  accepted, heartbeat good. Transport: 10 calls, 8 injected
  failures. Proven: stale-is-absent (never neutral/duplicated),
  outage cannot contribute, unrelated sources continue, recovery
  restores eligibility, heartbeat/TTL agree with seam state.
- Live pass hardened (seam_live_pass.py): now asserts non-empty
  emission, bundle-file existence, manifest commitment, 64-cap,
  accepted+rejected reconciliation, BLS-zero, and per-feature
  authority resolution (records row + source + content_hash);
  exit 1 on violation. Re-ran clean: invariants ok=True.
- Seam CLOSED/ACCEPTED; H1 untouched. Phase-D gate OPEN (BLS live
  egress, longer soak still needed).

## Addendum 104 - n=120 soak + tightened stale/recovery assertions
- Longer soak (research/sandbox/soak-evidence-n120.json): 120
  real-time polls per source, raw polls preserved, linear-
  interpolation p50/p99. EDGAR p50=125/p99=297 ok; FRED
  p50=6016/p99=7401.3 ok; Treasury p50=2578/p99=3226.3 ok; BEA
  p50=1032/p99=1725.3 ok; BLS refusal-only (120 live 403,
  fail-closed, hb=False). No fabrication, no backfill.
- stale_recovery.py tightened to match the addendum claims: asserts
  treasury ok/stale flags, reads back real heartbeat FILES per
  phase (ok/stale/records/error), asserts the emitted bundle's
  actual feature AND history source sets (stale treasury absent
  from both, not inferred), and asserts semantic recovery
  (C bundle composition == A baseline exactly). Labeled in-
  artifact as controlled transport-layer fault injection, NOT a
  natural outage. Also fixed a harness gap: seamb heartbeat/out
  scratch dirs are now created in-script (FileNotFoundError had
  left heartbeat reads empty). Re-ran: ok=True, no violations.
- Seam CLOSED/ACCEPTED; H1 untouched. Phase-D gate OPEN (BLS live
  egress still the outstanding item; natural-outage observation
  remains nice-to-have, never a substitute for this proof).

## Addendum 105 - H1 Authorization Packet v3 ACCEPTED (text only)
- v3 accepted as the final H1 authorization TEXT (human audit; no
  code, no plan edits). Resolves all v1/v2 findings: (a) sizing
  owned exclusively by risk/veto, router lifecycle-only consuming
  BuildEngineInputs; (b) kernel_state.hpp limited to the additive
  read-only ack/reconciliation visibility surface (universe, epoch,
  request_for, try_accept, validator binding, mutex/transitions,
  P3.3 semantics all excluded); (c) normal entry structurally
  protected-entry-only, protection repair recovery-only;
  (d) frozen §13.5 sequence respected with no override — H1
  spec/design may be prepared, implementation begins only when the
  sequence permits; (e) retry = one attempt + one query,
  reconcile-first, same identity, never a fresh entry on missing
  ack. Venue Alpaca-paper-stocks-only; no live capital/FX/JEV/
  research/collector changes; no confidence use.
- State established: H1 spec/design authorized to prepare; H1
  implementation BLOCKED on separate Slice D authorization; Slice D
  NOT authorized; live/paper execution NOT authorized. Next
  decision is Slice D. Repo verified pre-H1 (no kernel/exec,
  log, broker, kill in tree).

## Addendum 106 - Slice D implemented (authorized packet v2)
- Code: kernel/kill/switch.hpp + switch.cpp (EvaluateLevel with
  frozen HARD>MEDIUM>SOFT precedence + frozen reasons; EntriesAllowed
  with restart-flag friction; StepFlatten exact 4-state FSM with
  single issuance + true-closer recording + PROTECTION_ONLY; StepHard
  7-phase ordered machine with non-gating re-establish/flatten notes
  and unconfirmed-never-revokes; Serialize/ParseKill fixed "D1:d:d:d"
  string-in/out, caller owns the file). Reuses jev::risk::KillLevel
  (no second authority). Evaluation path: no I/O, clock, alloc,
  JEV, confidence, network, research (grep-gated + runtime-proven).
- Tests: test_kill 252 checks (trigger matrix, precedence, entry
  gate, FSM matrix incl. 20-cycle PENDING stability, 84-combo
  persistence round-trip, guards, HARD exact op order both paths,
  50-cycle unconfirmed hold, 112-combo revoke/exit invariant,
  100k-eval non-blocking) + test_noalloc_kill 0 allocs over 20k
  mixed-path iterations. Green normal+hardened via build.sh.
- Two implementation findings fixed: serialize length (8 chars, not
  7) and spend-tier clamp (exactly 3 escalates, out-of-range never
  a level — matches frozen tier vocabulary).
- No changes outside kernel/kill/* + additive build.sh lines.
  H1 NOT started; execution NOT started; next is H1 per §13.5.

## Addendum 107 - Slice D correction (FSM re-attempt + records)
- Finding (independent audit of f039374): FLATTEN_PENDING could
  never re-issue: no representation of terminal-failure vs
  in-flight. Fixed with minimum frozen state: FlattenStep gains
  prior_attempt_failed (broker-confirmed terminal failure,
  position still open). PENDING + failed + conditions allow ->
  exactly one re-issuance, still PENDING (caller clears the flag
  once the fresh order is in flight: deterministic, bounded, no
  per-cycle loop). PENDING + failed + bad conditions -> wait;
  failed + terminal venue -> PROTECTION_ONLY. Tie-breaks pinned:
  external close wins ties; confirmed-flat beats a stale failure
  flag; ACTIVE ignores a stray failure flag. 10 new regressions
  (in-flight quiet, one re-attempt, post-reattempt quiet,
  bad-conditions, terminal venue, failed->flat, failed->STOP_TP,
  restart reconcile, both tie-breaks, stray flag). Suite 262/262
  normal+hardened.
- Noalloc proof widened to traverse all flatten states x 32
  observation shapes, all hard phases, serialize + valid/malformed
  parse per iteration (20k, 0 allocs); evidence worded as the
  exercised-path proof it is.
- TODO cleaned: Slice D authorization consumed, H1-next-awaiting-
  authorization stated consistently (was stale/contradictory).
  No contract or plan change. H1 NOT started; no execution.

## Addendum 108 - H1 implemented (authorized packet v3)
- Code: kernel/exec/router.{hpp,cpp} (pure RouteStep machine: IDLE
  entry gate (kill/stale/stage/frozen/shape/scalar-vocabulary) ->
  JOURNAL_PENDING (no-row-no-send entries; emergency exception for
  EXIT) -> SENT_UNACKED -> QUERY_SENT (exactly one query) ->
  PROTECTED | PARTIAL_AWAIT (journal partial, cancel remainder) |
  CANCEL_SENT -> CANCELLED | UNKNOWN_FROZEN (+freeze flag, never
  "filled") | EXIT_SENT/EXIT_EMERGENCY -> CLOSED. One stable client
  ID minted once per intent (frozen recipe, 0x1F separators);
  missing ack reconciles via query, never mints fresh. Naked ack or
  filled-without-protection routes to cancel, never holds naked.
  Exits ignore kill/stale/stage gates. Drift ordering documented +
  patterned in-test (EXIT closes before ENTRY).
- kernel/log/journal.{hpp,cpp}: 9 frozen row kinds, hex64 chain,
  VerifyRow/VerifyChain (genesis/seq/prev rules), RedactionOk
  (280-char cap + credential-token scan).
- kernel/broker/: IAdapter (SubmitProtected/QueryOnce/Cancel/
  EstablishProtection-recovery-only); AlpacaPaperAdapter over
  injected HttpPost (unwired fails closed; bracket body hand-built;
  protection acked only when ALL legs confirm; repair is opposing
  OCO); MakeClientOrderId; PaperFillPrice (frozen adverse-spread,
  min 1bp, integer cents).
- Tests: router 40 (happy, journal-first, bad-intent/scale, all
  gates, exit survival, emergency, reject/naked/timeout/empty/
  partial/unknown paths, ID stability, crash-reconcile-first,
  duplicate quiet, drift pattern) + journal 23 (admission, tamper,
  chain breaks, all kinds, redaction) + broker 28 (ID recipe,
  fill model, bracket shape/ack mapping, query/cancel/repair) +
  noalloc-exec 0 (12 states x 32 obs, ID-mint excluded as
  documented cycle-path). Green normal+hardened via build.sh
  (new isolation gates: no answers/confidence/sizing/clock/
  network tokens in H1 files; heap gate on router core).
- Sizing stays upstream (router verifies frozen scalar vocabulary
  only); kernel_state.hpp untouched (no ack-surface needed yet —
  H1 drives through explicit inputs); Slice D/P3.x/collector/
  research/plan untouched. Live transport unwired (Phase 4);
  no execution, no credentials.

## Addendum 109 - H1 corrective pass (independent audit findings)
P0-1 protection-missing (safety): filled/partial without protection
  now routes to ESTABLISH_PROTECTION (REPAIR_SENT, recovery-only);
  repair-ok -> JOURNAL_REPAIR -> PROTECTED; repair-fail -> FLATTEN_NOW
  -> EXIT_SENT -> journaled exit (never holds naked, never fakes a
  cancel). CANCEL_SENT with filled qty but unconfirmed protection
  repairs instead of claiming PROTECTED. Corrupt PROTECTED without
  the flag fails closed (found by the new sweep, fixed). Invariant:
  13 states x pok x 64 obs combos prove PROTECTED implies confirmed
  protection. 17 new router regressions (76 total).
P0-2 transport/API: HttpTransport carries GET/POST/DELETE; lookup is
  GET /v2/orders:by_client_order_id?client_order_id=; cancel is
  DELETE /v2/orders/{UUID from the single query} (no hidden adapter
  state, restart-safe); exact method/path/query fake assertions.
P0-3 OCO repair: type limit (not market), stop-limit leg, side/price
  guards (long sells tp>stop; short buys stop>tp; inverted refused
  without transport touch); MarketClose added for exits/flatten.
P1-1 durability: SnapshotMachine/RestoreMachine strict fixed format
  (13 states round-trip + 10 malformed rejects); crash-resume drill
  (snapshot per step -> reload -> complete: same terminal/ID, one
  intent row); randomized convergence (25 seeds + partial reality:
  same terminal/trace/ID, chains verify).
P1-2 drills (test_drills 45): convergence, crash, six §6.2a rows
  (entries stop, exits alive; JEV-down via REAL Slice D level eval),
  journal-only summary (counts derivable, chain verifies),
  redaction/retention integration.
P1-3 edges: already-cancelled direct path; bad-state REJECT;
  silence-vs-notfound distinct; tie-breaks pinned.
No Slice D / P3.x / collector / research / plan changes. Transport
still unwired live (Phase 4); no execution. §6.5 rows closed at unit/
drill level here: kill/reconcile integration drill, randomized
ordering, crash durability, outage rows, summary/redaction paths.
Phase-4 operational rows (30-day run, live bracket-ack proof, real
transport, out-of-band receipt) stay H2.

## Addendum 110 - H1 second corrective (audit of f5dd11c)
P0-1 repair kind: JOURNAL_REPAIR now journals frozen "reconcile"
  (tenth kind reverted; regression proves FormatRow+VerifyRow accept
  the repair row). P0-2 UUIDs: broker_id grammar is 8-4-4-4-12
  lowercase-hex+hyphens-or-empty, enforced writer- and reader-side;
  crash-path ID fields zero-initialized; real-UUID round-trip +
  upper/hyphen/short/char rejects; empty UUID restores. P0-3 cancel:
  204-empty confirms, 422/500 refuse. transport_ok added to
  OrderQuery (adapter sets on authoritative 2xx; 404-absent cancels,
  transport failure re-issues the lookup same-identity, never a
  resend). cancel_failed vs silence (silence re-checks;
  UNKNOWN needs positive failure). Corrupt PROTECTED-without-flag
  fails closed (sweep-found). P1 ordering: 24 permutations of four
  distinct consistent events converge (no wrong terminal, identical
  trace/ID/fill, chains verify) + partial-reality convergence.
  Suites: router 83 + journal 23 + broker 41 + drills 74 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. H1 correctness/drill gate now complete at unit/
  drill level; Phase-4 operational rows (live wiring, 30-day run,
  out-of-band receipt) stay H2.

## Addendum 111 - H1 third corrective (audit of 73a4509)
P0-1 query truth table: 404 -> transport_ok+absent (router journals
  terminal cancel directly — no UUID exists to DELETE); 2xx+id ->
  found; 2xx-malformed/5xx/transport-fail -> unknown (reconcile).
  Regressions: query-404-absent, query-malformed, query-500-unknown
  (+ prior valid-order mapping).
P0-2 send ambiguity: OrderAck carries transport_ok +
  authoritative_reject. 422 -> terminal journaled cancel; transport
  failure / malformed 2xx -> QUERY_ONCE under the same client ID
  (ambiguous-reconcile; never CANCELLED on a missing POST reply).
P0-3 protection proof: strict legs-array rule (>= 2 top-level leg
  objects, >= 2 leg ids, tp+sl markers INSIDE the array;
  string-aware bracket match; unbalanced/non-array refused) for both
  submit-ack and query. Bare markers outside legs refused
  (regression); one-leg and unbalanced refused.
P0-4 bounded budget: kQueryMaxAttempts=3 persisted in machine +
  snapshot; every QUERY_ONCE emission consumes one; exhaustion ->
  JOURNAL_UNKNOWN + symbol freeze (never infinite, never a resend).
P1-5 identity ordering: RouteObs carries client_id; non-IDLE
  machines ignore foreign-tagged observations (exec:foreign-
  observation); 24 permutations of four distinct consistent events
  converge (no wrong terminal, identical trace/fill/ID, chains
  verify). Tie-break frozen: matching identity applies by receipt
  order; foreign never applies; broker sequence numbers reserved
  (not invented).
P1-6 snapshots: writer validates + serializes canonical cid/bid
  (garbage refused: snap-writer-refuses-garbage); restore applies
  the same grammar; attempts digit added (old scratch snapshots
  invalid by construction — runtime-only format).
Also: cancel_failed vs silence (silence re-checks); corrupt
  PROTECTED-without-flag fails closed (sweep-found, now 13x2x512).
Suites: router 86 + journal 23 + broker 47 + drills 75 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. Bounded query semantics: 1 initial + 2 transport-
  failure re-issues, same identity, then UNKNOWN+freeze.

## Addendum 112 - H1 fourth corrective (audit of 57cce89)
P0-1 retry-once: kQueryMaxAttempts=2 (1 initial + 1 retry, no third;
  frozen doc 06 one-send-one-query + Slice H1 retry-once). Exhaustion
  -> JOURNAL_UNKNOWN + freeze. Regressions: ambiguous-reconciles
  (attempts==1), exactly-one-retry (attempts==2), no-third-query,
  reconcile-exhausted, budget-snapshots/restores,
  restart-no-fresh-budget.
P0-2 authoritative shapes (single query, no hidden lookup): submit =
  POST /v2/orders bracket response (legs populated); reconcile = GET
  by_client_order_id Order entity (no nested param documented there:
  legs trusted ONLY when strictly proven, absence -> repair path).
  Documented in alpaca_paper.hpp + LegsProtected comment.
P0-3 POST UUID: OrderAck.broker_order_id captured from the accepted
  POST; router persists it (UUID-grammar validated, else reconcile
  via bad-ack-id) BEFORE any cancel path; snapshot/restart preserves;
  DELETE uses exactly it. E2E drill: e2e-post-naked ->
  e2e-cancel-sent -> e2e-uuid-kept -> e2e-snapshots/restores ->
  e2e-uuid-survives-restart -> e2e-delete-uses-uuid.
P1-4 legs proof: exactly 2 legs, distinct non-empty ids, TP=limit leg
  + SL=stop-family leg (type-bound roles), order-level TP/SL params.
  Refused: naked (markers, no legs), one-leg, unbalanced, duplicate
  ids, duplicate roles, three legs, untyped leg.
P1-5/6 identity + ordering: gate strict (matching applies;
  foreign/untagged ignored: gate-matching-applies/foreign-ignored/
  untagged-ignored); 24 perms run with real matching tags
  (Drive auto-tag = correct-caller model); duplicates idempotent
  (gate-duplicate-idempotent + 25 drill-converge seeds); receipt-order
  tie-break frozen for the REST snapshot class (no venue sequence
  metadata on this path; broker sequences reserved, never invented).
P1-7 4xx split: 400/422 authoritative_reject (terminal); 401/403
  auth_failure; 429 rate_limited; other-4xx/5xx/malformed ambiguous.
  Auth/rate reconcile within budget (auth-/rate-reconcile,
  query-auth/rate reasons), then freeze — never terminal CANCELLED.
  Regressions: send-400/422-authoritative, send-401/403-auth,
  send-429-rate, send-409-ambiguous, query-401-auth, query-429-rate.
P1-8 durability honesty: journal.hpp is a pure formatter/verifier;
  persistence (append/fsync/restart-load/90-day/daily-backup/
  summary-from-journal) is caller-owned, assigned to the G0 runner.
  No kernel file I/O added.
Suites: router 100 + journal 23 + broker 59 + drills 83 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. Query budget: 1 initial + 1 retry, same identity,
  then UNKNOWN+freeze.

## Addendum 113 - H1 fifth corrective (audit of 17a765c)
P0-1 reconcile shape: by-client-ID GET documents only client_order_id
  (no nested param; legs otherwise null). Single-query verdict is now
  three-state: legs strictly proven -> confirmed; order_class bracket
  + TP/SL object fields with legs null/absent -> bracket-held-as-unit
  (constructive: venue holds the bracket, null = unexpanded); simple
  class found-but-unprotected -> genuinely absent -> repair legitimate
  (no bracket exists to duplicate). Never routes unexpanded legs to
  duplicate OCO. Regressions: query-legs-null-bracket-held,
  query-simple-no-bracket, bracket-held-protected, simple-filled-repairs.
  Order-level proof is field-based (order_class bracket/oco +
  take_profit/stop_loss objects), never bare substrings.
P0-2 404 direct: QUERY_SENT !found+transport_ok (404-only shape) ->
  JOURNAL_CANCEL + CANCELLED immediately (absent-direct); no
  CANCEL_SENT, no confirmation requested, broker_id stays empty.
P0-3 query UUID: IsBrokerUuid shared (adapter.cpp) enforced on QUERY
  (and close-ack) paths; malformed id -> unknown. Regressions:
  query-id-short/upper/hyphen/slash/long.
P0-4 intent binding: machine persists intent_id + symbol + side (+
  kind); every non-IDLE step verifies IntentMatches, mismatch ->
  NONE exec:intent-mismatch (never terminal, never silent apply);
  snapshot v2 carries :intent:sym:side (IDLE none / non-IDLE full,
  coherence-enforced). Regressions: bind-same-applies,
  bind-intent-id/symbol/side/entry-exit-rejected, bind-snapshots/
  restores/restart-rejects/restart-applies. Send-once is structural
  (no send from non-IDLE) + budget persisted = frozen send/ack state.
P0-5 exits: MarketClose rides stable client_order_id; CloseResult
  captures UUID + transport_ok; EXIT_SENT definitive->CLOSED,
  ambiguous->QUERY (shared retry-once budget), 404->EXECUTE_EXIT
  re-issue (same ID); QUERY_SENT exit-kind resolves filled->CLOSED
  else re-issue; restart reconciles first (exitx-restart-waits-query).
  Emergency exception intact (executed-first path untouched).
  Regressions: exit-ambiguous-reconciles, exit-reconciled-closed,
  exit-absent-reissues, exitx-snapshots/restores, close-market-plain,
  close-ambiguous/malformed-reconciles.
P1-6 filled_qty: StrictQty requires "filled_qty":"<1-18 digits>";
  missing/non-numeric/negative/overflow -> unknown (never zero).
  Regressions: query-qty-missing/nonnumeric/negative/overflow.
P1-7 403: buying-power terminal (authoritative_reject, reason
  buying-power); 401 alone is auth_failure. Regression:
  send-403-buying-power (replaces 403-as-auth).
P1-8 cancel: CancelResult accepted (204/2xx+id) vs failed (422);
  accepted stays confirming (cancel-accepted-stays); only explicit
  final-canceled terminals (cancel-final-terminals); 422 -> UNKNOWN
  (cancel-refused-unknown). 204 never terminals alone.
P1-9 events: RouteObs event_id (32hex) + event_seq; machine persists
  last applied; exact duplicates collapse (exec:duplicate-event);
  receipt-order application with identity/seq preserved; 24 perms run
  with identity-bearing events + duplicate preserving identity
  (ev-applies/duplicate-collapses/distinct-applies; perm-* green).
Suites: router 135 + journal 23 + broker 72 + drills 83 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. Reconcile shape: by-client-ID Order entity;
  legs-null bracket = held-as-unit (protected); 404 = direct
  terminal; POST + QUERY UUIDs validated; binding every step.

## Addendum 114 - H1 sixth corrective (audit of 8d2d36f)
P0-1 POST qty: SubmitProtected parses filled_qty with the strict
  query grammar; missing/malformed -> ambiguous (UUID cleared, never
  silent zero). Accepted/naked + filled 30 -> ESTABLISH_PROTECTION
  with the real ack qty (naked-filled-repairs E2E); accepted/naked +
  zero -> CANCEL_REMAINDER. Regressions: post-fill-populated,
  post-qty-missing/malformed-ambiguous.
P0-2 close lifecycle: CloseState FILLED/PARTIAL/PENDING/DEAD/UNKNOWN
  from the status field (fill / partial_fill|partially_filled /
  accepted|pending_new|new|calculated / canceled|rejected|expired /
  else-unknown) + strict qty on FILLED/PARTIAL. Router: FILLED ->
  CLOSED with the ACK qty (never intent.qty); PARTIAL/PENDING ->
  reconcile (never CLOSED on a partial); DEAD -> same-ID re-issue;
  exit query needs filled >= close size for CLOSED (authoritative
  row qty), below-size re-queries within budget else freezes, 404 /
  cancelled-unfilled re-issues. Regressions: close-fill-executed,
  close-pending-waits x4, close-partial-reconciles, close-dead-
  reissues, close-ambiguous/malformed-reconciles, exit-pending/
  partial-reconciles, exit-dead-reissues, exit-query-partial-
  reconciles, exit-query-exhausted-freezes.
P0-3 byte-identity: o.next.kind assigned ONLY at the IDLE mint now;
  all gate rejections (untagged/foreign/mismatch) + stale/conflict/
  duplicate ignores return next byte-identical to m (proven by
  snapshot-bytes equality for intent_id/symbol/side/kind mismatch +
  foreign + untagged: ident-* family).
P0-4 sequence authority: caller-owned monotonic seq per machine
  (venue REST supplies none — owned by the G0 runner); router rules:
  exact redelivery collapses, older seq stale-ignored, same-seq
  different-id conflict first-wins, newer applies + advances
  high-water (persisted). Adversarial proof: fresh-then-stale and
  stale-then-fresh both end at the fresh fill (adv-stale-ignored);
  live-machine conflict ignored (adv-conflict-first-wins);
  ev-applies/duplicate-collapses/distinct-applies; 24 perms carry
  identity+sequence (duplicate preserves identity).
P1-1 legs shape: BracketHeld requires the exact "legs":null
  representation (+ bracket class + TP/SL objects); {} / string /
  bool / [] / omitted -> unknown (never constructive). Regressions:
  query-legs-object/string/bool/empty/omitted.
P1-2 Cancel boundary: IsBrokerUuid enforced before any transport
  touch (5 malformed IDs, zero DELETEs: cancel-id-*).
P1-3 budget: snapshot writer/reader accept exactly 0..2
  (kQueryMaxAttempts); 3/9 refuse both ways (snap-att-3/9-refused,
  snap-write-att-3-refused); round-trip covers 0..2.
P1-4 final qty: cancel_confirmed with machine fills requires the
  authoritative final qty for a PROTECTED claim (cancel_filled_qty;
  0..999999999); absent qty + filled machine -> repair (never stale
  assume). Regressions: cancel-no-qty-repairs,
  cancel-final-authoritative-qty (40 stale -> 100 authoritative),
  cancel-sent-protected-rests (with qty).
Suites: router 158 + journal 23 + broker 91 + drills 83 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. 204-accepted-vs-final-canceled handling preserved
  (directionally correct per current cancel API).

## Addendum 115 - H1 seventh corrective (audit of abd3d71)
P0-1 direct-fill gate: EXIT_SENT FILLED requires filled >=
  intent.qty (full completion means full); short "fill" (4 < 10)
  reconciles via QUERY (exec:exit-short-fill), never CLOSED.
  Regression: exit-short-fill-reconciles. (Malformed qty already
  UNKNOWN at the adapter.)
P0-2 exit sub-identity: DEFINITIVE death (DEAD ack /
  cancelled-unfilled query) burns the client ID — Alpaca rejects
  duplicate client_order_id, so recovery mints MintExitSubId
  (hash of intent#eN, same venue recipe; attributable via the
  unchanged bound intent_id). 404-absent keeps the SAME id
  (nothing exists to collide). exit_attempt persisted in machine +
  snapshot (no double-mint across restart; 9-attempt cap then
  freeze). Mint failure -> UNKNOWN+freeze (never reuse, never
  invent). E2E (fake transport): xid-first-post (X) -> xid-dead-
  mints (attempt 1, id changed) -> xid-second-post-new-id (Y,
  never X) -> xid-never-reused (X posted exactly once) ->
  xid-closed; exitd-snapshots/restores/id-survives;
  exit-cancelled-new-identity; exit-dead-attempt-2.
P0-3/P0-4 broker-native ordering: event_id is the VERBATIM venue
  identity (ULID 26-char stream ids pass through unchanged; hex32
  poll tags accepted; token [A-Za-z0-9_-] <=32, snapshot-persisted
  verbatim, never transformed). ULID-vs-ULID compares by broker
  time (48-bit timestamp, full-string tiebreak): older-after-newer
  is stale even when it ARRIVED later; exact redelivery collapses.
  Non-ULID ids keep caller-seq rules (single-source poll ordering
  only, explicitly not broker authority); cross-family applies
  (never false-stale). Proven with real Alpaca-shaped ULID
  fixtures: ulid-armed/newer-applies/snaps/stale-ignored/
  duplicate-collapses/tiebreak-distinct/decisive/persists-winner.
  Same-ms tiebreak is deterministic (lex-larger wins) with the
  winner persisted in state bytes.
P1-1 query status: ClassifyStatus normalizes 10 venue statuses to
  CloseState (fill/PARTIAL/PENDING/DEAD); unlisted (done_for_day,
  replaced, ...) -> UNKNOWN, never collapsed. Exit reconcile
  branches on close_state (DEAD-empty joins the burn-ID path).
  Regressions: query-status-0..9, query-status-unlisted.
P1-2 cancel seam: adapter.hpp documents the G0 production rule
  (cancel_confirmed ONLY from found+cancelled REST or terminal
  stream event, with its qty; bare 204 never terminals — router
  enforces, tests prove seam-no-bare-204 x3 + seam-rests).
Suites: router 174 + journal 23 + broker 102 + drills 93 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. Quantity invariant now holds on BOTH exit paths
  (direct ack + query); burned exit IDs are never resubmitted.

## Addendum 116 - H1 eighth corrective (audit of 104af95)
P0-1 status spelling: ClassifyStatus recognizes venue "filled"
  (terminal); bare trade-event "fill" is UNKNOWN (rejected, never
  an order status). All close/query fixtures use the real spelling.
  Regressions: close-fill-word-rejected, query-status-fill-word;
  close-fill-executed + query-status-0 now exercise "filled".
P0-2 DEAD partials: MarketClose parses strict qty BEFORE the DEAD
  branch — DEAD carries its authoritative cumulative fill; DEAD
  with missing/malformed qty is UNKNOWN (never assumed zero).
  Router folds every exit fill into persisted cumulative totals
  (exit_closed monotonic total, exit_counted current-order counted;
  overfill/contradiction freezes). Recovery targets remainder only
  via RouteOut.exit_qty (caller submits exactly it under the new
  sub-ID); restart re-derives intent.qty - exit_closed from the
  snapshot (no caller persistence needed, never recomputed upward).
  Flat (closed == requested) -> CLOSED with the authoritative total
  on all three paths (direct FILLED, DEAD-with-full, query).
  Regressions: close-dead-keeps-qty, close-dead-no-qty-unknown,
  exit-dead-partial-remainder (closed 40, Y for 60),
  exit-cancelled-partial-folds, px-* E2E (X posts 100 -> X canceled
  +40 -> Y posts exactly 60 -> CLOSED at exactly 100; X posted once;
  remaining + sub-ID survive every restart; Y UUID captured).
P0/P1-3 authority domains: ULID-vs-ULID = broker-time order;
  non-ULID = caller-seq rules (single-source only); no-event REST
  snapshots NEVER regress established state — fills monotonic vs
  the floor (entries: machine filled; exits: current-order
  counted), protection never unsets, terminals never un-terminal
  (exec:stale-snapshot, byte-identical ignore). No fake
  cross-family comparison exists. Proven: crafted QUERY_SENT floor
  40 + ULID high-water ignores later REST 30 (live + after
  snapshot/restore, ULID bytes preserved); newer ULID still
  applies over the floor. Regressions: xauth-stale-rest-ignored,
  xauth-restart-snaps/loads/keeps-ulid/stale-ignored,
  xauth-ulid-over-rest.
P1-4 UUID hygiene: sub-ID rotation clears broker_id (X dies with
  X); successful Y captures Y's UUID unconditionally when valid.
  Regression: exit-mint-clears-uuid, px-broker-id-is-y. Validator
  zero-fills ID tails (deterministic crash-path bytes; hardened
  -fanalyzer clean). Cancel final adopts monotonically
  (contradictory-lower final unattributed, never regresses).
Suites: router 185 + journal 23 + broker 106 + drills 111 +
  noalloc-exec 0, normal+hardened, freeze PASS. Slice D / P3.x /
  collector / research / plan untouched; transport unwired live;
  no execution. Quantity invariant holds on every exit path;
  burned IDs are never resubmitted; partials can never overshoot.
