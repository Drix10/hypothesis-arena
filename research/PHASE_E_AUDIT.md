# Phase E audit trail (condensed)

The full text (131 addenda, 3229 lines) is in git history: `git show 81e04b2:research/PHASE_E_AUDIT.md`.
This file keeps the findings, fixes, evidence identifiers and open items. Commit and CI run
ids are those recorded in the original addenda. "Hosted" means GitHub Actions.

## 1. Interface audit (pre-D gate)

Phase B research contracts and the Phase D plane did not change any interface that kernel
slices D, E, F, G or H1 depend on. The plane writes `features.jsonl` (frozen f2) only, never
touches STAGE (R17), and `git diff` since pre-D showed no change under `kernel/`,
`collector/` or `plan/`. The "no design blockers" claim was later found overstated for the
plane implementation itself; see section 2.

## 2. Research plane hardening (Rounds 1-9, Addenda 1-24)

Nine independent audit rounds against the plane; each finding closed with one regression.
Main fix areas, by round:

| Rounds (closing commit) | Fixed |
|---|---|
| 1-3 (`6965b89`+`49ecb65`, `a921934`, `aaa8ecd`) | bundle identity (hashed watermarks/history), fsync fail-closed, `read_latest`, symlink containment, R15 at every LLM node, abort means no emit, cadence durability, run-scoped thread ids, SQLite budget ledger with leases, hard token ceiling, provider egress pinned via explicit httpx transport, doc-10 spend governor gates every LLM node |
| 4 (`790374d`, `851725a`, `c3ea793`, `ab92bf0`) | per-call dollar reservation on worst-case pricing, ambiguous outcomes settle as `UNKNOWN_SPEND` and block until `reconcile_unknown`, timeouts hard-kill and reap the child, tiers implement the frozen doc 10 s10.4 table (constants in doc 10 s10.4.1), CI workflow added |
| 5 (`45996e9`..`1af480a`) | TOCTOU dollar race, model/pricing identity, marker folding, bounded repr/IPC/result growth, mandatory governor, sole pricing table, signal durability, pinned CI permissions |
| 6 (`d79253b`) | first-create race on the ledger fixed with a dedicated create lock; hosted plane green |
| 7 (`5f54ee5`) | strict `record_unknown`; tier journal and state under one lock; one-shot Pipe replaces Queue for the child handoff. Found a shipped bug: `record_unknown` stored symbol in the stage column (swapped INSERT) |
| 8 (`6fe44d5`) | Pipe read while child runs; hold-only reconcile mints the synthetic span first; actual above reservation hard-rejects; R15 cycle registry detects deleted rows |
| 9 (`c423e20`) | R15 deletion detection on every reader; migration backfill in one transaction; single lock across tier load-compute-persist; Pipe frame read bounded by the call deadline |
| 10-13 (`0dccc0b`, `3e3a18b`, `fb236d5`) | durable signal sentinel for Tier-2; unreadable markers read as invalid; strict ratio journal; kill ladder starts at the deadline; established SQLite files never regrow tables; schema v2; extract reservation covers measured framing (32 KiB over 9.3 KiB); hermetic reclaim test after a hosted failure exposed a blocked-evidence hole (run 35643930706) |
| 14-19 (`48d5bd2`, `ce70100`, `bb4733a`) | row-level integrity on both ledgers (in-DB content digests, same transaction), digest table mandatory and never rebuilt (schema v3), witness-first `.seen` publication, tier chain semantics, future-timestamp rejection |

Round 9 outcome (Addendum 21, accepted by the human in Addendum 23, checked against `06da85c`
in Addendum 24):

- A format-aware actor with SQLite write access can rewrite rows and digest coherently, and
  the marker mirror then re-baselines over the forgery. Confirmed with a throwaway PoC (not
  committed).
- No code fix exists under the current trust model: crash lag and coherent forgery are
  observationally identical given only (DB, marker). Closing it needs an external anchor (HSM,
  TPM, remote log), which is unfunded and would be a new security architecture.
- Accepted threat model: rows and `content_digest` give mutual-consistency and corruption
  detection; the marker is a recovery mirror plus shape tripwire, not a trust root; host and
  filesystem integrity are out of scope. This is why `research/plane/locks.py` states that a
  total directory wipe is indistinguishable from a new deployment.
- CI gap closed: independent `evidence` job (isolation + sources) runs even when the
  collector loop fails (run 35747745650).

## 3. CI history

- The hosted `stdlib` job failed from Addendum 6 until Addendum 37 on a frozen-collector
  step. Root cause (run 35858925643): a timing race in the `test_jev.py` single-flight test
  (`sleep(1.0)` in a mock provider). Fixed test-only with deterministic marker orchestration
  (`aa93274`, 100/100 on Linux under 4x CPU load); production `jev.decide` unchanged.
- A second stdlib failure (`config-hygiene`, no `.env` in CI) was fixed with a step-scoped
  `MIRO_CONTACT=ci-test@example.invalid` (`c0b1ebc`). First all-green hosted run: 35865034676.
- Addendum 127-129 later recorded a date-sensitive `collector/tests/test_pipeline.py` case
  (hardcoded 2026-09-18 record against the 7-day archaeology rule) as UNRESOLVED and not
  weakened; a human decision on relative test dates is pending. Later addenda report hosted
  runs as "workflow failure, stdlib step" for that reason.
- Addendum 130: hosted kernel job failed on Linux only (run 36312765807, head `5a819f1`) for
  a lost `#include <dirent.h>` in `store.cpp`, plus a race test (LK2/JX) with no rendezvous.
  Both fixed and proven on a Linux toolchain.

## 4. Deployment evidence (Addenda 25-48)

Per-box proof is in `research/DEPLOYMENT_EVIDENCE.md`. Outcomes recorded here:

| Item | Result |
|---|---|
| Boxes 1, 2, 3, 5 (isolation, egress, image, WALL_S kill) | PROVEN 2026-09-22 |
| Box 4 live provider | PROVEN as provider + accounting proof (not a full `run_cycle`); model `meta/muse-spark-1.3-contributor`; 15+16 tokens, $0.000005 of $0.000038 reserved (Addendum 32) |
| FRED/ALFRED | PROVEN: observations, realtime-parameter replay byte-identical, bad key denied; `/alfred/*` endpoints 404 for this key, replay uses FRED realtime parameters |
| BEA | PROVEN. Earlier "error 20" was a probe bug: the data-method parameter is `datasetname`, not `dataset` (Addenda 38-42) |
| Alpaca paper | PROVEN read-only; feed recorded as IEX |
| OANDA practice | BLOCKED: India ineligible (first-party denial, Addendum 39); forex is research-only |
| Earnings gate | implementation, probe and TTL/heartbeat wiring PROVEN (Addenda 27, 45, 46) |
| Box 6 Langfuse, Box 8 kill-9 resume | PARTIAL: mechanism proven, elapsed-time evidence open |

Env consolidation (`01b6e47`): one root `.env`, one loader `collector/config.py::_load_dotenv`.
Additive optional keys added there: `RESEARCH_MODEL_ID`, `BEA_USER_ID`, `ALPACA_KEY_ID`,
`ALPACA_SECRET` (the only edits to frozen collector code).

## 5. Kernel slices (Addenda 49-63)

- Slice E (`kernel/stage/`), accepted at `b0c26b9`: strict STAGE chain verify; anything
  unverifiable resolves to G0_PAPER. Fixed the ISO-8601 numeric-offset grammar.
- Slice F (`kernel/feed/`), implementation accepted at `9f966e0`: 65536-tick ring, gap
  detectors (backward/duplicate timestamps latch without moving the reference; UINT64_MAX
  policy), deterministic backoff, ET session marking. The 24 h soak and reconnect evidence are
  still open. The ring is single-threaded.
- Slice G (`kernel/ctx/`), v1 accepted at `aad16ca`: 11-section Snapshot, mask 0x7FF,
  `context_hash = sha256_hex(canonical)`. Deferred by ruling: the `change` field and
  `sentiment_d6` are excluded from v1; source status uses the frozen JEV vocabulary.
  Carried constraint: mark/indicator/source array order needs a frozen canonical ordering
  before a second producer exists.
- Slice D (`kernel/kill/`, Addenda 106-107): kill evaluation with HARD>MEDIUM>SOFT
  precedence, flatten FSM (fixed: PENDING could never re-issue), 262 checks.

## 6. Source adapters (Addenda 64-94)

Five adapters accepted after 2-7 audit rounds each. Test counts and hosted runs:
EDGAR 47 (`27657b9`, run 35959871294), FRED 24 (`72ca59f`, run 36013253054), Treasury 23,
BLS 21 (`7817f20`, run 36036667089), BEA 22 (`9ef8956`, run 36042332716).

Defects fixed that are worth remembering:

- EDGAR: HTTPError shape normalization, 429 re-doubling per retry, overflow dedupe, source
  `acceptanceDateTime` preferred with flagged midnight estimate as fallback, pinned CIK map
  covers companyfacts.
- FRED: HTTP 400 is not key-denial without explicit key evidence; vintage rows must carry
  their own realtime window.
- Treasury: `record_date` is the publication authority; empty payload is unhealthy; duplicate-only
  polls stay healthy.
- BLS: strict RFC-822 parsing (weekday/date consistency, constrained TZ), DOCTYPE rejected.
- BEA: provider error text redacted for the credential; strict numeric grammar; source
  registered in the downstream f2 namespace (`ctx_read` COVER 1080, schema TTL 64800).
- Integration gate recorded: estimated EDGAR timestamps map to `published_ns=None` with a
  permanent context cap.

## 7. Source-to-graph seam (Addenda 95-104)

`research/plane/source_seam.py` and `research/plane/runner.py::build_production_runner`
(plan/08 s8.3): one Runner owns one Seam and one graph app; it binds the three seam-owned
callbacks (`harvest`, `parser_extract`, `resolve_emit`) and refuses caller overrides.
Canonical lineage goes through the frozen `validate_record` and `ingest_signal` into the
shared records table; the returned hash is the canonical hash. Restart recovery uses the
durable `seam_canonical` projection (with checksums) and verified committed bundle history.
Estimated timestamps never become `published_ns`. Runner and seam behaviour is covered by
`research/tests/test_source_seam.py` and `test_seam_graph.py`.

Live evidence (harness `research/sandbox/source_soak.py`, corrected to linear-interpolation
percentiles in Addendum 101):

- n=120 soak (`soak-evidence-n120.json`): EDGAR p50/p99 125/297 ms, FRED 6016/7401 ms,
  Treasury 2578/3226 ms, BEA 1032/1725 ms, all ok. BLS refused live (403) on every poll from
  this egress; fail-closed behaviour proven against a real refusal. The frozen user agent is
  not altered to evade it.
- Live seam pass (`seam-live-pass.json`): 85 records to 85 candidates to a 64-feature bundle;
  63 accepted (inference-capped) + 1 ttl-expired.
- Controlled transport-fault run (`stale-recovery.json`): a stale Treasury source contributes
  zero features and recovers to the baseline composition.

## 8. H1 execution layer (Addenda 105-131)

Built: `kernel/exec/` (pure RouteStep machine), `kernel/log/journal`, `kernel/broker/`
(Alpaca paper adapter over an injected transport), then the caller-owned runner
`kernel/runner/` (store, SSE events, recovery, cycle, daily ops). Ten router corrective
rounds followed (Addenda 109-118), then eight runner rounds (119-131). The router core has
had no diff since Addendum 118.

Invariants established, each with regressions and crash/restart proofs:

- Protection: PROTECTED implies confirmed protection; a filled entry without protection
  repairs or flattens, never holds naked. Bracket legs are trusted only when strictly proven.
- Identity: one stable client id per intent; a missing ack reconciles by query and never
  mints a fresh entry; a definitively dead exit burns its id and re-mints a sub-id for the
  remainder only. Intent binding, permanent intent ids, and per-book orphan coverage at
  recovery.
- Quantity: exit fills fold into cumulative totals; partials can never overshoot; stream
  `filled_qty` is cumulative; no-event REST snapshots never regress established state;
  `done_for_day`, `calculated` and `replaced` are quarantined (freeze, never DEAD).
- Query budget: one send, one query, one retry, then UNKNOWN and symbol freeze.
- Kill paths: HARD closes the signed broker quantity uncovered by reconciled exits with
  write-ahead chain rows; MEDIUM has a single close owner and a certified-flat teardown;
  exits bypass freeze and stage gates.
- Durability: journal is a pure formatter; the runner owns fsync, atomic writes, retention,
  backup and day-roll verification. OS-level directory lock (flock) with one owner; refusal
  writes nothing shared. Absent versus corrupt files are distinguished everywhere.
- A nondeterministic client-id bug (unbounded NUL-terminated inputs) was found and fixed in
  Addendum 129.

Latest counts recorded (Addendum 131, both modes, freeze PASS): runner 1042 local / 1045 Linux,
broker 126, router 209, drills 120, kill 262. Transport was null throughout this audit; the
libcurl transport and paper loop landed afterwards (see `TODO.md` K1, K13).

## 9. Open items at the end of this record

- P3.5 remained OPEN: independent re-audit of the round-5 head was required; see `TODO.md` K1-K10.
- The collector date-sensitive `test_pipeline.py` case: human decision pending (Addendum 127).
- Box 6 (Langfuse attribution day) and Box 8 (7-day unattended run) need elapsed time.
- BLS live egress: refused (403) from the audited host.
- Slice F 24 h soak and reconnect evidence.
- Frozen-collector findings tracked as `TODO.md` O7.
- The coherent-forgery boundary in section 2 stays out of scope unless an external trust
  anchor is funded.
