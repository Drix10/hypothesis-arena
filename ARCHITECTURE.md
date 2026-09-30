# ARCHITECTURE: codebase guide

AI-assisted systematic fund: US-listed equities and ETFs, cash account, long
only. Forex is research-only (OANDA blocked, RBI LRS
prohibits forex and margin trading abroad). No crypto.

Status: plan frozen (alpha-first), P3.5 H1
built with the paper transport verified read-only, five sleeves backtested and
none past an economic gate, G0 not started, paper only.

`plan/` is the source of truth; this file describes the tree. It had 544
tracked files on 2026-09-28 and the per-family lists below predate the H1 and
strategy additions, so `git ls-files` wins where they differ.

Labels: FROZEN (no change without a human contract-defect ruling; `kernel/`
implementation and collector production code are byte-identical to the Round 9
baseline except the additive optional keys in `collector/config.py`, see
the git history) · ACTIVE (current work surface) ·
FUTURE (not implemented) · HISTORICAL (read-only audit trail).

## 1. Root files (7 tracked + 1 ignored companion)

Tracked: `.env.example`, `.gitattributes`, `.gitignore`, `AGENTS.md`,
`ARCHITECTURE.md`, `README.md`, `TODO.md`. Ignored, not counted: `.env`
(real values).

- `AGENTS.md` - session rules: read ARCHITECTURE and plan/00-INDEX first; plan
  is the source of truth; update TODO per task; no secrets; one commit, one
  theme; fail closed.
- `ARCHITECTURE.md` - this file.
- `README.md` - status table, quick start, repo map.
- `TODO.md` - the live build ledger. History lives in git.
- `.env` / `.env.example` - ACTIVE canonical config. `.env` is
  git-ignored real values; `.env.example` is the tracked template
  (`MIRO_CONTACT` required; provider, broker and BEA keys optional).
  Sole loader: `collector/config.py::_load_dotenv` (root file, allowlisted
  keys, exported environment wins); research Python reads it through
  `collector.config.load()`. Tested in `collector/tests/test_config.py`.
  There is no second env file or loader (`sandbox/provider.env` retired,
  `01b6e47`).
- `.gitignore` - ACTIVE. Ignores `.env`, data/, logs, build artifacts.
- `.gitattributes` - ACTIVE. Pins `*.sh` to LF.
- `scripts/freeze-check.sh` - read-only gate: the repo must match
  `plan/system-manifest.yaml` (versions, pins, risk rules, component
  presence). Exit 0 = PASS. `pre-commit-secrets.sh` (gitleaks hook) and
  `sign-stage.sh` (human STAGE sign-off) sit beside it.
- `.github/workflows/ci.yml` - six jobs on every push, pull request and
  manual dispatch: `stdlib` (collector suites), `evidence` (isolation,
  sources, five adapters, seam, harness suites), `plane` (plane, hardening,
  emit, seam-graph), `kernel` (`WITH_CURL=1 build.sh` + freeze-check),
  `kernel-sanitizer` (ASan+UBSan), `secrets` (gitleaks over full history).

## 2. plan/ (13 docs + manifest + appendix/ + reviews/)

The plan is built around a legal live scope, a strategy book, a validation
standard and the shortest path to paper. Where a note below conflicts with a
doc, the doc wins. Notes: doc 02 is the strategy book (X archive in
`appendix/02-x-lists-archive.md`), doc 03 JEV is an optional filter, doc 05
adds R18/R19, doc 06 §6.1b and doc 08 §8.4 internals moved to `appendix/`,
doc 10 adds the jurisdiction gate, doc 11 adds the trial ledger and
contamination control, doc 12 demotes `baseline_v1` to a negative control.

- `00-INDEX.md` - reading order + doc authority map. Read first.
- `01-vision-and-scope.md` - fund scope; locks the venue: Alpaca paper
  (US stocks and ETFs); broker WS + 15-min REST reconcile; no FIX. Forex is
  research-only.
- `02-strategy-book.md` - alpha system contract; X-lists tail
  DISABLED in v1 (§2.6).
- `03-jev-decision-layer.md` - JEV contract: one candidate-bound
  contract, 4 questions, exit profile v1, case 29.
- `04-cpp-deterministic-core.md` - kernel contract §4.2 broker-feed
  staleness, §4.5 ingest.
- `05-risk-and-determinism.md` - R1–R19 (code constants) + §5.1c DAG.
- `06-execution-and-ops.md` - ops: §6.4 HALT friction, §6.5 paper fill
  model (10bp drag), exits local and never source-gated.
- `07-build-roadmap.md` - phase sequencing incl. Phase-0 boxes and
  P3.5 (open; veto + ingest slices landed, sizing/execution not started).
- `08-agentic-research-plane.md` - research-plane contract: §8.2 OS
  identities, §8.3a cadence, §8.4 hardening, §8.5 schema f2, §8.6
  deployment exit boxes.
- `09-osint-and-free-data.md` - source contract: §9.1 Tier-A table
  (broker, EDGAR, FRED/ALFRED, Treasury/BLS/BEA, session calendars,
  earnings calendar) + Tier B/C/D posture; §9.4 "done" = poller + TTL
  + heartbeat + measured p50/p99 per Tier-A source.
- `10-capital-gates-and-spend-control.md` - G0/G1 $150, G2 $400,
  G3 $1000 + 60/80/100% tiers; stage definitions; G0_PAPER only.
- `11-calibration-and-self-improvement.md` - promotion needs measured
  edge + human sign-off; §11.1a regime/decay.
- `12-statistical-baseline.md` - `baseline_v1`, the primary edge.
- `13-cpp-kernel-build.md` - kernel build record; the JEV filter and §13.7 battle ladder.
- `system-manifest.yaml` - freeze pins (v3/f2/baseline_v1/
  exit_profile_v1/g1, JEV revision/provider). freeze-check enforces it.

## 3. kernel/ (tests co-located)

Root: `build.sh` (the gate: normal/hardened/sanitize modes, every suite
below, all grep-gates; exit 0 = PASS) · `jev_wire.hpp` (strict JSON,
canonical JSON, SHA-256/512, Ed25519 verify, Python-repr floats) ·
`jev_filter.hpp` (the candidate-bound answer validator and decision table;
single entry point for model answers).

- `tests/`: `test_jev_filter.cpp` - interop suite on the committed
  `jev_vectors/` only (never invokes Python; build-gated). Also
  `transport_faults.py`, `ws_faults.py`, `e2e_mock_venue.py`,
  `soak_mock.py` (mock-venue drills).
- `ingest/` (4): `features.hpp`/`features.cpp` - f2 validation,
  retention, rate window; zero-malloc (vocabulary grep + `FindAscii`
  discipline). `test_features.cpp` - rejection/boundary/retention/rate
  suite. `test_noalloc.cpp` - wrapped-malloc counter proof (0 allocs).
- `risk/` (3): `veto.hpp`/`veto.cpp` - `EvaluateVeto` (RiskSnapshot →
  HOLD/PROCEED + frozen reason; fixed-storage verdict, `__int128`
  widening; must never read model answers - token-gated incl.
  comments). `test_veto.cpp` - veto suite incl. composed veto+table
  rows and case-29 pending-risk isolation.
- `fixtures/`: Alpaca reply fixtures (`alpaca_account.json`,
  `alpaca_bars_hourly_sip.json`, `alpaca_bracket_reply.json`).
- `vectors/`: `c1_wire.jsonl` (candidate wire lines), `snapshot_v2_*`
  and `v2_canonical.hex` (context snapshot vectors).
- `jev_vectors/` (64): 32 signed answer artifacts with expectations
  (`<name>.artifact.json` + `<name>.expect.json`), generated by
  `research/strategy/gen_jev_vectors.py`, asserted identically in Python
  and C++. Presence and count pinned by freeze-check.

## 4. collector/ (FROZEN production code + additive config extension;
tests co-located)

Production ingestion path: the poller that turns outside data into
`data/signals/<day>.jsonl`. (Second live-access point:
`research/sources/` readiness probes + the earnings veto gate -
see §5. The collector is the production path; sources/ probes are
evidence and gating, not the poller.)

Reconciliation (Phase-2.5 seam, plan/08 §8.3 governs): the five
accepted research adapters (EDGAR/FRED/Treasury/BLS/BEA) ARE
the graph harvest implementation - pure I/O, no LLM - orchestrated
once by `research/plane/source_seam.py`, which owns the single
adapter singletons, stamps, heartbeats, and the canonical mapping
into resolver/f2. The tracked production composition is
`research/plane/runner.py::build_production_runner`: one
Runner owns one Seam + one graph app for the process lifetime and
binds ALL THREE seam-owned graph callbacks - `harvest`,
`parser_extract` (adapter rec → lineage-bound parser candidate),
and `resolve_emit` (`canonical_for` = seam store lookup,
`source_watermarks` = seam watermarks). The caller supplies only
unrelated deps (LLM providers, fuse, budgets, spend); supplying any
seam-owned callback is a ConfigError. The graph's own emit node is
the sole publisher caller; the emitted bundle path surfaces on the
cycle output. Restart/resume: memory is cache-only; canonical
lookup falls back to the durable seam_canonical projection (same
DB, same commit as the authority ingest; absent → fail closed) and
history tails recover from durable accepted bundles
(`restore_from_bundles`, shape/monotonicity re-validated,
bounded); no durable state → warming tail with no frozen-feed
coverage claimed. The frozen P1 collector path above is untouched
and keeps running; within Phase 2.5 there is exactly one poll path
per source. Nothing in the seam trades.

- `collect.py` - poller. UA-bearing fetch, per-source TTL/heartbeat,
  `needs_key` gating, stale→expire (absent ≠ neutral), >50% poll
  failure over 24h disables + alerts. Reads: `sources.json`,
  `session_calendar.json`, config. Writes: `data/signals/`.
- `config.py` - canonical env loader (see §1) + `load()` states
  (`CONFIG_OK` / `MISSING_REQUIRED_CONFIG` exit 2 / per-source
  `SKIPPED_OPTIONAL_CONFIG`).
- `classify.py` / `pregrade.py` - TRIGGER/CONTEXT/NULL classification
  + grading. Reads poller output. Writes: classified records.
- `jev.py` - JEV sidecar: candidate-bound state, pinned revision/provider, Ed25519
  sign/verify, spend ceiling, retry-once-HOLD; no key → HOLD.
- `ctx_read.py` - frozen bundle/feature reader (`read_latest`);
  validity owned here exclusively (research `schema.py` never
  re-validates). Also imported by plane emit + tests (import ≠ change).
- `entity_map.json` - entity resolution map (config).
- `sources.json` - source registry (incl. `needs_key: FRED_API_KEY`,
  keyless EDGAR/Fed/ECB/Treasury/BLS entries).
- `session_calendar.json` - session/holiday seed (fail-closed veto input).
- `soak.py` / `soak_check.py` - soak harness and its acceptance check.
- `audit.py` - collector self-audit helper.
- `tests/` (6): `test_collect` (poller/TTL/heartbeat/singleton);
  `test_config` (dotenv/config states); `test_ctx` (reader);
  `test_jev` (sign/verify, HOLD, ceiling); `test_pipeline` (28-check
  end-to-end); `test_soak_check` (soak gate). All mocked IO, no
  network. CI `stdlib` job. Failing hosted = pre-existing frozen
  failure (proven path-independent, Addendum 30).

## 5. research/ (ACTIVE)

### plane/ (18)

- `runner.py` - TRACKED production composition
  (`build_production_runner`): owns one Seam + graph app per
  process, binds the three seam-owned callbacks
  (harvest/parser_extract/resolve_emit), requires the heartbeat
  sink, resolves the MIRO_CANONICAL_DB-honoring lineage DB +
  bundle outdir + pinned map, restores durable history. Caller
  supplies unrelated deps only; seam-owned overrides refused.
- `source_seam.py` - Phase-2.5 harvest seam (plan/08 §8.3): five
  adapter singletons, real pacing (sleep/monotonic), stamps +
  heartbeats, frozen-collector canonical lineage (shared records
  table, authority hash), durable canonical projection +
  bundle-history recovery for restart, seam-owned watermarks +
  parser extract. Exactly one poll path per source.

- `graph.py` - 6-node `run_cycle`; per-epoch budget threads;
  single-run-per-process guard; aborted checkpoints terminal.
  Reads: budgets/spans/checkpoints. Writes: checkpoints, bundles.
  Failure: abort → emit publishes nothing.
- `workers.py` - model workers; `make_raw_provider` (model_id +
  egress_proxy + api_base/api_key; missing → `ConfigBlocked`, never
  direct; httpx transport-pinned proxy). OpenRouter via OpenAI-compat.
- `timeout.py` - `run_in_process` kill ladder (streaming Pipe IPC,
  bounded frames, TERM→KILL reap, stale-thread + IPC-cap rejects).
- `spend.py` - `SpendGovernor` (G0/G1 $150 tiers; reservation/settle,
  tier-locked single-lock persist, `LedgerUnavailable`).
- `budgets.py` - R15 `cycles` registry (`counters-deleted` deny).
- `attribution.py` - unknown-spend reconciliation (evidence-first,
  `reconcile-over-reservation` reject; per-node/model/day log).
- `locks.py` - marker/state FS layer (only FileNotFoundError =
  absent; `marker-deleted`/`tier-state-unreadable` denies; roots).
- `r15.py` - R15 caps + `.seen` sidecar (witness-first).
- `digest.py` - content digests, schema v3, same-txn
  (`digest-mismatch`/`digest-deleted`, never rebuilt).
- `emit.py` - atomic bundle emit (temp+fsync+rename+manifest) +
  `read_latest` (uses `collector.ctx_read`).
- `publish.py` - production publish (resolver+emit; bounded map loads).
- `retention.py` - retention (failure raises; 7-day prune).
- `cadence.py` - cadence/cost gating (5-min I/O cycles; per-symbol
  re-run rules; 30-min TTL; throttle doubling).
- `resolver.py` - deterministic evidence resolver (LLM advisory only;
  recomputes load-bearing fields from canonical records).
- `schema.py` - frozen f2 constants/builders (shape truth; validity
  owned by `collector/ctx_read.py`).
- `__init__.py` - package marker.

### sources/ (5)

Readiness probes + gates (evidence + veto logic; NOT the P1
production poller - that is `collector/collect.py`). The five
accepted adapters additionally serve as the Phase-2.5 graph harvest
implementation (see §4 reconciliation - exactly one poll path per
source, owned by the seam). Egress, stated exactly:
`sandbox/` worker containers egress ONLY via Squid (proven 5/5);
host-side probes here (`tier_a.py`, `earnings.py`, live-provider
probe driver) use DIRECT `urllib`/httpx from the build host and do
NOT transit Squid - the live-provider call itself runs its shipped
transport-pinned proxy path via loopback-published Squid. Two paths,
documented separately, never conflated.

- `tier_a.py` - Tier-A readiness probe (live EDGAR/Fed GETs p50/p99;
  FRED→BLOCKED w/o key; calendar gate). The FRED gate as shipped is
auth/metadata readiness ONLY (`/fred/series?series_id=GDP` 200 =
key verified live, NOT observation-data proof); real observation
retrieval + ALFRED vintage replay are the upcoming gated task.
Evidence JSON; exit 0 always.
- `calendars.py` - fail-closed session presence-gate
  (`CalendarMissing` → zero records). Evaluation downstream in ctx.
- `earnings.py` - EDGAR-derived earnings veto gate (8-K 2.02 + 10-Q/K
  windows, ±3d; unknown→suppress) + `__main__` live probe (p50/p99).
  Implementation+probe PROVEN; TTL/heartbeat wiring OPEN (§9.4).
- `__init__.py` - package marker.
- `tier_a_evidence.json` - committed Tier-A measurement (immutable
  audit evidence, not runtime input).

### tests/ (7 files + battery)

- `test_plane.py` (108) - graph/R15/cadence/attribution/workers.
- `test_hardening.py` (116) - fail-closed regressions, Rounds 1–9.
- `test_emit.py` (19) - bundles/manifest/reader.
- `test_isolation.py` - 4 protected paths denied (also a deployment
  probe via setpriv; CI `evidence` job).
- `test_sources.py` - calendar gate (3) + earnings veto (6);
  CI `evidence` job.
- `test_source_seam.py` (25) - harvest→authority→resolver→reader
  legs, stdlib evidence job.
- `test_seam_graph.py` (7) - tracked production Runner end-to-end
  + restart recovery, plane job (langgraph).

### sandbox/ (worker isolation machinery)

Direct children:

- `setup-identities.sh` - 4 OS identities + `/srv/mirohedge` tree +
  deny/allow probes (8/8) + repo isolation check (4/4).
- `egress-proxy/squid.conf` - exact `dstdomain` allowlist.
- `egress-probe.sh` - allowlist transits / non-allowlist 403s at proxy /
  direct egress unroutable (5/5) + idempotent proxy bring-up.
- `Dockerfile` - worker image (digest-pinned base).
- `config-probe.py` - fail-closed constructors (5/5, no mocks).
- `kill-probe.py` - WALL_S ladder on Linux (4/4).
- `kill9-resume.sh` + `kill9_worker.py` + `kill9_reconcile.py` +
  `kill9_verify.py` - 40-epoch SIGKILL→resume proof (both branches).
- `langfuse/docker-compose.yml` - self-hosted attribution stack
  (evidence-only placeholder creds; production replaces).

### research root

- `lessons/lessons.jsonl` - ACTIVE Tier-D output (12/12 graded).
- `requirements.txt` - ACTIVE pinned plane deps (`==` only).

## 6. data/ (UNTRACKED runtime, never committed)

`canonical.db`, `classified/`, `signals/`, `soak/`, `state/` -
collector/plane runtime outputs. Local-only by `.gitignore`.

## 7. Cross-component flows

Production (P1 frozen path): Tier-A/B source → `collector/collect.py`
(TTL/heartbeat/keys) → classify → `data/signals/<day>.jsonl` →
plane `graph.py` (LLM context via `workers.py`, spend-governed,
checkpointed) → emit bundles → kernel
`risk/veto` → optional `jev_filter` → paper fills
(doc 06 §6.5). Production (Phase-2.5 seam path, plan/08 §8.3): the
five accepted adapters → `source_seam.py` harvest (canonical lineage
via frozen classify into the shared records table) → graph nodes
(seam `parser_extract` binds authority lineage to candidates) →
graph emit (seam-bound `resolve_emit`: store lookup + watermarks)
→ emit bundle → frozen `ctx_read`. Gating overlay:
earnings veto + session calendar suppress entries; exits never gated.
Failure overlay: DOWN → stale heartbeat → features expire (absent ≠
neutral); calendar missing → zero entries; unknown spend → block →
reconcile/fresh-cycle; misconfig → `ConfigBlocked`; aborts publish
nothing; digests never rebuild.

Money-affecting ownership: reservation/settle = `spend.py` under tier
lock; size = frozen §3.2 table via typed object only; exits = local
(doc 06); stages = doc 10 (demotion automatic, promotion never by code);
spend ceilings = `jev.py` + doc 10 tiers; attribution = `attribution.py`
mirror (missing ledger raises, never $0).

## 8. Status ledger

- Plan: docs 00–13 rewritten 2026-09-28; approved by the operator in chat
  2026-09-29 (doc 07 sign-off log).
- Harness (`research/strategy/`): ledger, `cost_v2`, settlement, portfolio,
  benchmarks, statistics, gates, prereg, `sip_fetch`, `a_run`, sleeve
  modules under `sleeves/`; pre-registrations in `research/prereg/`,
  ledger in `research/ledger/`, gate reports in `research/reports/`;
  `ops/` holds the alert relay, the forward replication ledgers
  (`sleeve_shadow`, `event_shadow`, `macro_shadow`, `jev_twin`,
  `sleeve_eval`, `forward_register`) and the long-history track
  (`long_history_fetch`, `long_history_run`); see
  `plan/appendix/10-sleeve-integration-plan.md`.
- FROZEN: `kernel/` impl, collector production code (`config.py`
  carries the additive `RESEARCH_MODEL_ID` loader key per Addendum 32
  - the only exception), `plan/`, JEV
  contracts, `research/` memos, round addenda, evidence JSON artifacts.
- ACTIVE: `research/plane`, `sources`, `tests`, `sandbox`,
  `lessons.jsonl`, `requirements.txt`, `TODO.md`, `README.md`, this
  file, CI wiring, `.env.example` (additive consumed keys only).
- FUTURE: Slice D; live capital past G0_PAPER; production broker
  pollers + H1 execution (order router/journal/ack/reconcile);
  production earnings poller→graph consumer wiring (source-level
  TTL/heartbeat PROVEN); 7-day run; profit/calibration feeds
  (G-stage); registry publication (optional); P3.5 sizing/execution.
  (The five-adapter poller→feature seam - EDGAR/FRED/Treasury/BLS/
  BEA harvest→parser→resolve→bundle→ctx - is SHIPPED, pending audit
  acceptance; live soak/p50-p99 per source stays OPEN by design.)
- Current credentials (ONLY): OpenRouter, FRED/ALFRED, BEA, Alpaca
  paper - all to be rotated after the 2026-09-28 chat exposure (doc 07
  O6). OANDA practice BLOCKED (India ineligible, Addendum 39); forex is
  research-only (no FX venue search). No other keys exist.
