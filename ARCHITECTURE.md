# ARCHITECTURE: codebase guide

AI-assisted systematic fund that trades the slow spread of news between
linked firms: an engine builds a point-in-time link graph from SEC filings,
global news and ownership data, an LLM reasons about where events ripple,
and a deterministic C++ kernel executes. US-listed equities and ETFs, paper
only. The kernel enforces a cash account, long only (the India set);
research targets a US margin account, long and short (the US set). No crypto.

Status: plan freeze v4. The kernel (through build slice H1) runs with a
verified Alpaca paper transport; further kernel hardening is parked. The
five earlier sleeves failed their backtest gates and are retired. The
engine's link graph and the four new sleeves are designed (plan/02, 08, 14)
and not yet built. Paper trading through the kernel has not started.

`plan/` is the source of truth; this file describes the tree. `git ls-files`
lists every tracked file (410 on 2026-10-03) and wins over the lists below
where they differ.

Labels: FROZEN (no change without a human contract-defect ruling), ACTIVE
(current work surface), FUTURE (not implemented), HISTORICAL (read-only audit
trail).

## 1. Root files

Tracked: `.env.example`, `.gitattributes`, `.gitignore`, `.gitleaks.toml`,
`.risk-baseline.json`, `AGENTS.md`, `ARCHITECTURE.md`, `CLAUDE.md`,
`CONTEXT_MANIFEST.json`, `README.md`, `TODO.md`. `.env` holds real values and
is git-ignored.

- `AGENTS.md` - session rules. `CLAUDE.md` imports it for Claude Code;
  `kernel/AGENTS.md` and `research/AGENTS.md` add module rules.
- `CONTEXT_MANIFEST.json` - agent-flow: protected paths, risk boundaries and
  the gates agents must pass; `.risk-baseline.json` is the accepted risk-surface
  baseline. `.agent-flow-runtime/` is the vendored agent-flow CLI the guard and
  pre-commit hooks run; `.claude/` holds its skills and hook wiring.
  `.github/CODEOWNERS` covers the protected paths.
- `README.md` - status table, quick start, repo map.
- `TODO.md` - the live build ledger. History lives in git.
- `.env` / `.env.example` - canonical config. `.env.example` is the tracked
  template (`MIRO_CONTACT` required; provider, broker and BEA keys optional).
  Sole loader: `collector/config.py::_load_dotenv` (root file, allowlisted
  keys, exported environment wins); research Python reads it through
  `collector.config.load()`. Tested in `collector/tests/test_config.py`.
- `.gitignore` ignores `.env`, data, logs and build artifacts. `.gitattributes`
  pins `*.sh` to LF. `.gitleaks.toml` configures secret scanning.
- `scripts/freeze-check.sh` - read-only gate: the repo must match
  `plan/system-manifest.yaml` (versions, pins, risk rules, component
  presence). Exit 0 is PASS. `pre-commit-secrets.sh` (gitleaks hook) and
  `sign-stage.sh` (human STAGE sign-off) sit beside it.
- `.github/workflows/ci.yml` - seven jobs on every push, pull request and
  manual dispatch: `stdlib` (collector suites), `evidence` (isolation,
  sources, adapters, seam, strategy and ops suites), `plane` (engine, hardening,
  emit, seam-graph, event direction), `kernel` (`WITH_CURL=1 build.sh` + freeze-check),
  `kernel-sanitizer` (ASan+UBSan), `secrets` (gitleaks over full history), `agent-flow` (doctor +
  audit-risk against the baseline).

## 2. plan/ (14 docs + manifest + appendix/ + reviews/)

The plan covers the thesis, the legal live scope, the engine, the
strategy book, the validation standard and the path to paper. Where a note
here conflicts with a doc, the doc wins.

- `00-INDEX.md` - thesis in one paragraph, reading order, global locked
  decisions. Read first.
- `01-vision-and-scope.md` - linked-firm diffusion thesis and its evidence,
  operator path, constraint sets India/US, venue (Alpaca), latency tiers.
- `02-strategy-book.md` - sleeves Link Momentum link momentum, Filing Change filing change, Event Ripple
  LLM ripple events (with deterministic twin), ETF Trend long-short;
  controls; record of retired sleeves and the X archive pointer.
- `03-jev-decision-layer.md` - JEV: an optional filter, one candidate-bound
  contract, 4 questions, exit profile v1, case 29.
- `04-cpp-deterministic-core.md` - kernel contract (§4.2 modules, account
  ledger, ingest side policy, §4.5 done boxes).
- `05-risk-and-determinism.md` - R1-R20 per constraint set (code
  constants) and the §5.1c DAG.
- `06-execution-and-ops.md` - execution by sleeve, short-side rules,
  `cost_v2`/`cost_v3`, account operations, outage playbook; §6.1b in
  `appendix/`.
- `07-build-roadmap.md` - critical path, Checkpoint 1 decision rules, tracks A/P/K,
  stages, firewall, sign-off log.
- `08-epistemic-engine.md` - Market Link Graph, event pipeline, router /
  retrieval / brain / verifier, isolation, feature contract f2/f3, research
  factory, model pinning.
- `09-osint-and-free-data.md` - source tiers (EDGAR, GDELT, quarantined
  social), license matrix, research datasets, free and paid data phases, ingestion
  rules.
- `10-capital-gates-and-spend-control.md` - stage chain, India/US
  jurisdiction gates, stage table, kill switches, AI spend control, path to
  outside capital (§10.6).
- `11-calibration-and-self-improvement.md` - trial ledger, statistics,
  contamination classes (deterministic, extraction, judgment), transferability, calibration, sleeve gates
  (`val_v2` spanning test), AI paired delta.
- `12-statistical-baseline.md` - `baseline_v1` (negative control) and the
  benchmark set with the reference book.
- `13-cpp-kernel-build.md` - kernel build contract: JEV filter, slices,
  §13.7 battle-testing ladder, §13.8 remaining scope (MOC smoke test, stop-before-close fix, 24-hour soak, live-paper drills,
  kernel short selling).
- `14-market-link-mathematics.md` - shocks, link matrix, propagation,
  lead-lag networks, edge validation, Hawkes intensity, portfolio
  construction, `cost_v3`, evaluation and decay statistics.
- `system-manifest.yaml` - freeze pins (f2/baseline_v1/exit profiles/g1,
  constraint sets, JEV revision/provider). freeze-check enforces it.
- `appendix/` - binding implementation records (06b close ownership, 08
  ledger integrity, 09 collector O7 exception, 02 X archive) and the
  retired-sleeve testing program (`10-sleeve-integration-plan.md`,
  `11-sleeve-evidence-review.md`).
- `reviews/` - dated status records (`2026-09-29-alpha-results.md`).

## 3. kernel/ (C++17, tests co-located)

`build.sh` is the gate: normal, hardened and sanitizer modes, every suite,
all grep-gates; exit 0 is PASS. It refuses to run as root. `WITH_CURL=1`
adds the libcurl transport.

- `jev_wire.hpp`, `jev_filter.hpp` - strict/canonical JSON, SHA-256/512,
  Ed25519 verify, Python-repr floats; the candidate-bound answer validator
  and decision table, the only entry for model answers.
- `jev_vectors/` - 32 signed answer artifacts (`<name>.artifact.json` +
  `<name>.expect.json`) generated by `research/strategy/gen_jev_vectors.py`
  and asserted identically in Python and C++. Count pinned by freeze-check.
- `ingest/` - `features` (f2 validation, retention, rate window; zero-malloc)
  and `candidates` (CID recompute, sleeve approval, allowlist, freshness,
  long-only policy), each with a suite; `test_noalloc.cpp` proves zero
  allocations.
- `risk/` - `veto` (`EvaluateVeto`: RiskSnapshot to HOLD/PROCEED with a frozen
  reason; never reads model answers), `sizing`, `measure`, `engine_inputs.hpp`.
- `ctx/` - `context.cpp`, `snapshot.hpp`: frozen Snapshot and `context_hash`.
- `feed/` - feed state machines: tick recording, gap flags, reconnect schedule, session marking (pure logic, no I/O).
- `kill/` - `switch`: SOFT/MEDIUM/HARD kill levels.
- `stage/` - STAGE file verification and hash chain.
- `log/` - `journal`: hash-chained journal written before every order.
- `exec/` - `router` (order identity, intent/ack machine, reconcile),
  `decide` (the no-filter path: candidate gate, sizing, veto to OrderIntent),
  `moc_plan` (stop-before-MOC sequencing).
- `broker/` - Alpaca paper adapter, `http_curl` transport, `ws_stream`
  (`trade_updates`), `smoke_paper` and `live_drill` (live paper checks).
- `runner/` - `runner` (recovery, cycle, HALT), `main.cpp` (read-only
  production entry), `paper_loop` and `paper_loop_main` (`g0_paper_loop`:
  account, candidates, Decide, SubmitIntent), `account`, `approved`
  (approved.json loader), `bars`, `calendar` (holidays, early closes),
  `events`, `settle` (T+1 book), `store`.
- `fixtures/` - Alpaca reply fixtures. `vectors/` - candidate wire lines and
  snapshot v2 vectors.
- `tests/` - `test_jev_filter.cpp` (interop suite on the committed vectors;
  never invokes Python) and mock-venue drills: `transport_faults.py`,
  `ws_faults.py`, `e2e_mock_venue.py`, `soak_mock.py`.

## 4. collector/ (FROZEN production code; tests co-located)

Production ingestion: the poller that turns outside data into
`data/signals/<day>.jsonl`. `research/sources/` holds the per-source
adapters, readiness probes and the earnings veto gate.

- `collect.py` - poller. UA-bearing fetch, per-source TTL/heartbeat,
  `needs_key` gating, stale to expire (absent is not neutral), more than 50%
  poll failure over 24h disables and alerts. Reads `sources.json`,
  `session_calendar.json` and config; writes `data/signals/`.
- `config.py` - canonical env loader and `load()` states (`CONFIG_OK`,
  `MISSING_REQUIRED_CONFIG` exit 2, per-source `SKIPPED_OPTIONAL_CONFIG`).
- `classify.py`, `pregrade.py` - TRIGGER/CONTEXT/NULL classification and grading.
- `jev.py` - JEV sidecar: candidate-bound state, pinned revision/provider,
  Ed25519 sign/verify, spend ceiling, retry-once-HOLD; no key means HOLD.
- `ctx_read.py` - bundle/feature reader (`read_latest`); validity is owned
  here (`research/engine/schema.py` never re-validates).
- `soak.py`, `soak_check.py`, `audit.py` - soak harness, its acceptance check
  and a self-audit helper.
- `entity_map.json`, `sources.json`, `session_calendar.json` - config.
- `tests/` - `test_collect`, `test_config`, `test_ctx`, `test_jev`,
  `test_env_loading`, `test_pipeline`, `test_soak_check`. Mocked IO, no
  network; CI `stdlib` job.

## 5. research/

### engine/ (ACTIVE; the epistemic engine of plan/08)

The source seam (plan/08): the five adapters (EDGAR/FRED/Treasury/BLS/BEA)
are the harvest step, pure I/O with no LLM, orchestrated once by
`source_seam.py`, which owns the adapter singletons, stamps, heartbeats and
the canonical mapping into resolver/f2. `runner.py::build_production_runner`
composes one Runner (one seam + one graph app per process) and binds the
seam-owned graph callbacks `harvest`, `parser_extract` and `resolve_emit`;
supplying one of them from outside is a ConfigError. The graph's emit node
is the sole publisher. On restart, canonical lookup falls back to the
durable `seam_canonical` projection (absent means fail closed) and history
tails recover from durable accepted bundles. Nothing in the engine trades.

- `runner.py` - production composition; resolves the lineage DB (honors
  `MIRO_CANONICAL_DB`), bundle outdir and pinned map.
- `source_seam.py` - harvest seam: adapters with real pacing, stamps and
  heartbeats, canonical lineage, durable projection, watermarks, parser
  extract.
- `graph.py` - 6-node `run_cycle`; per-epoch budget threads; single run per
  process; aborted checkpoints are terminal; an abort publishes nothing.
- `workers.py` - model workers; `make_raw_provider` (missing config raises
  `ConfigBlocked`; proxy-pinned OpenRouter transport).
- `timeout.py` - `run_in_process` kill ladder.
- `spend.py` - `SpendGovernor` (G0/G1 $150 caps; reservation/settle under a
  tier lock; `LedgerUnavailable`).
- `budgets.py`, `r15.py` - R15 cycle registry and caps.
- `attribution.py` - unknown-spend reconciliation and per-node/model/day log.
- `locks.py`, `digest.py` - marker/state layer and same-transaction content
  digests (never rebuilt).
- `emit.py`, `publish.py`, `retention.py` - atomic bundle emit,
  `read_latest` (uses `collector.ctx_read`), production publish, 7-day prune.
- `cadence.py` - cadence and cost gating.
- `resolver.py` - deterministic evidence resolver (LLM advisory only).
- `event_direction.py` - deterministic event direction table
  (`event_direction_v1`).
- `schema.py` - f2 constants and builders (validity owned by
  `collector/ctx_read.py`).

The link graph, event pipeline, router, brain and verifier of plan/08 are
not built yet (plan/07 §7.2).

### sources/ (ACTIVE)

Adapters `edgar.py`, `fred.py`, `treasury.py`, `bls.py`, `bea.py`, plus
`tier_a.py` (Tier-A readiness probe), `calendars.py` (fail-closed session
gate), `earnings.py` (EDGAR earnings veto gate, ±3 days, unknown means
suppress) and `tier_a_evidence.json` (committed measurement, not runtime
input). Host-side probes use direct `urllib`; worker containers egress only
through Squid.

### strategy/ (ACTIVE; the backtest harness)

- Harness: `ledger` (hash-chained trial ledger), `costs`/`costs_v2`,
  `settlement`, `backtest`, `portfolio`, `benchmarks`, `stats`, `gates`,
  `prereg`, `data`, `universe`.
- Market data: `sip_fetch` (SIP datasets with manifests;
  `load_alpaca_env`), `bulk_bars` (throttled many-symbol fetch).
- Event data for the engine: `form4` (insider filings),
  `earnings_surprise` (SUE from SEC statements),
  `sec_financial_statements` (SEC financial-statement data sets).
- Candidates and JEV: `candidate`/`candidate_wire`, `jev_filter`,
  `gen_jev_vectors`.
- Controls: `baseline_v1` (frozen negative control), `sleeves/core_passive`
  (60/40 passive core).

Records: `prereg/` (pre-registrations, including retired sleeves'),
`ledger/` (trials and checkpoint), `reports/` (backtest gate reports),
`lessons/lessons.jsonl`, `requirements.txt` (pinned engine deps).

### sandbox/ (worker isolation and live probes)

`setup-identities.sh` (OS identities and deny/allow probes),
`egress-proxy/squid.conf` and `egress-probe.sh`, `Dockerfile`,
`config-probe.py`, `kill-probe.py`, the `kill9_*` resume proof,
`langfuse/docker-compose.yml` (secrets from the environment), and live
probes for Alpaca paper, BEA, FRED vintages and the model provider.

### tests/

Suites for the engine (`test_engine`, `test_hardening`, `test_emit`,
`test_source_seam`, `test_seam_graph`, `test_event_direction`), isolation
and sources, each adapter, the harness (`test_stats`, `test_ledger`,
`test_gates`, `test_costs_v2`, `test_settlement`, `test_portfolio`,
`test_prereg` and others), the event data modules (`test_form4`,
`test_earnings_surprise`), the JEV filter, and the ops tools
(`test_forward_ledgers`, `test_forward_eval`, `test_forward_register`,
`test_alert_relay`, `test_deploy_check`). CI job assignment is in
`.github/workflows/ci.yml`.

## 6. ops/ (ACTIVE)

Paper run and forward ledgers; see `ops/deploy/README.md`.

- `deploy/` - `start.sh` (builds, asks for the sign-off phrase, starts the
  loop and the forward ledgers), `run.sh` (supervisor), `check.py` (run
  check), `session_calendar.json` (2026-2028, with early closes),
  `approved.json.example`.
- `emit_candidates.py` - passive-core candidates from SIP daily bars.
- `forward_ledgers.py` - log-only virtual books for the passive core, the
  benchmarks and any sleeve in shadow; `--verify` is the fidelity replay.
- `forward_eval.py` - paired evaluator against benchmarks with checkpoints.
- `forward_register.py` - registers each forward ledger in the trial ledger.
- `monitor.py` - live view. `alert_relay.py` - outbound-only alerts.

## 7. data/ (untracked runtime, never committed)

`canonical.db`, `classified/`, `signals/`, `soak/`, `state/`: collector and
engine runtime output, ignored by `.gitignore`.

## 8. Cross-component flows

Collector path: Tier-A/B source, `collector/collect.py` (TTL/heartbeat/keys),
classify, `data/signals/<day>.jsonl`. Engine path (plan/08): the five
adapters, `source_seam.py` harvest (canonical lineage through `classify`
into the shared records table), graph nodes, emit bundle (`resolve_emit`),
`ctx_read`. Paper loop: candidates (`ops/emit_candidates.py`),
`g0_paper_loop`, Decide, journal row, order on Alpaca paper, reconcile.

Gating: the earnings veto and session calendar suppress entries; exits are
never gated. Failure: a down source leaves a stale heartbeat and features
expire (absent is not neutral); a missing calendar means zero entries;
unknown spend blocks until reconciled or a fresh cycle; misconfiguration
raises `ConfigBlocked`; an abort publishes nothing; digests are never rebuilt.

Money-affecting ownership: reservation/settle is `spend.py` under the tier
lock; size comes from the frozen §3.2 table via the typed object only; exits
are local (plan/06); stages are plan/10 (demotion automatic, promotion never
by code); spend ceilings are `jev.py` and the plan/10 tiers; attribution is
the `attribution.py` mirror (a missing ledger raises, never reads as $0).

## 9. Status

- FROZEN: `kernel/` implementation and the JEV contracts, collector
  production code (`config.py` carries the additive `RESEARCH_MODEL_ID`
  loader key, the only exception), `plan/` (edited only by
  operator-approved doc edits), evidence JSON artifacts.
- ACTIVE: `research/engine`, `sources`, `strategy`, `sandbox`, `tests`,
  `ops/`, `TODO.md`, `README.md`, this file, CI wiring, `.env.example`
  (additive consumed keys only).
- NOT BUILT: the link graph, event pipeline and ripple reasoning; shorts in
  the harness and the kernel; the netting router; capital past G0_PAPER.
- Credentials in use: OpenRouter, FRED/ALFRED, BEA, Alpaca paper (rotated
  2026-09-30). OANDA practice is blocked (India ineligible); there is no FX
  venue. No other keys exist.
