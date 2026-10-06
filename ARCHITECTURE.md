# ARCHITECTURE: codebase guide

An AI-assisted systematic fund built around one strategy, the Connected Drift
Book: a long-short US equity composite of link propagation, section-level
filing text change and opportunistic insider buys, scaled by an ETF trend
state. An engine builds a point-in-time link graph from SEC filings and
ownership data, and a deterministic C++ kernel executes. US-listed equities and ETFs,
paper only. The kernel enforces a cash account, long only (the India set);
research targets a US margin account, long and short (the US set). No crypto.

`plan/` is the source of truth; this file describes the tree. `git ls-files`
lists every tracked file and wins over the lists below where they differ.

The kernel's risk module still implements an earlier rule set (three
positions, forex, stage caps) that differs from `plan/risk.md`; `TODO.md` lists
the rewrite.

## 1. Root files

`.env.example`, `.gitattributes`, `.gitignore`, `.gitleaks.toml`,
`.risk-baseline.json`, `AGENTS.md`, `ARCHITECTURE.md`, `CLAUDE.md`,
`CONTEXT_MANIFEST.json`, `DOCS_INDEX.md`, `README.md`, `TODO.md`. `.env` holds
real values and is git-ignored.

- `AGENTS.md`: session rules. `CLAUDE.md` imports it for Claude Code;
  `kernel/AGENTS.md` and `research/AGENTS.md` add module rules.
- `CONTEXT_MANIFEST.json`: protected paths, risk boundaries and the gates agents
  must pass; `.risk-baseline.json` is the accepted risk-surface baseline.
  `.agent-flow-runtime/` is the vendored CLI that the guard and pre-commit hooks
  run; `.claude/` holds its skills and hook wiring. `.github/CODEOWNERS` covers
  the protected paths.
- `.env` and `.env.example`: canonical config. `.env.example` is the tracked
  template (`MIRO_CONTACT` required; provider, broker and BEA keys optional). The
  sole loader is `collector/config.py::_load_dotenv` (root file, allowlisted
  keys, exported environment wins); research Python reads it through
  `collector.config.load()`.
- `scripts/check-manifest.sh`: a read-only gate that checks the code against
  `plan/system-manifest.yaml`. `pre-commit-secrets.sh` (the gitleaks hook) and
  `sign-stage.sh` (human `STAGE` sign-off) sit beside it.
- `.github/workflows/ci.yml`: the CI jobs (collector suites, evidence and
  harness suites, engine suites, the kernel build and its sanitizer build, secret
  scanning, agent-flow checks).

## 2. plan/

Eleven docs, `README.md`, `system-manifest.yaml` and `appendix/`. Read
`plan/README.md` first; the reading order and a summary of each file are there.
Where a note here conflicts with a doc, the doc wins.

## 3. kernel/ (C++17, tests co-located)

`build.sh` is the gate: normal, hardened and sanitizer modes, every suite and
all grep gates; exit 0 is PASS. It refuses to run as root. `WITH_CURL=1` adds
the libcurl transport.

- `wire.hpp`: strict and canonical JSON, SHA-256 and SHA-512, Ed25519 verify.
  The candidate gate and the context module use it.
- `ingest/`: `features` (validation, retention, rate window; zero-malloc) and
  `candidates` (id recompute, strategy approval, allowlist, freshness,
  long-only policy), each with a suite; `test_noalloc.cpp` proves zero
  allocations.
- `risk/`: `veto` (`EvaluateVeto`: a `RiskSnapshot` to HOLD or PROCEED with a
  fixed reason), `sizing`, `measure`, `engine_inputs.hpp`.
- `ctx/`: `context.cpp` and `snapshot.hpp`: the fixed snapshot and
  `context_hash`.
- `feed/`: feed state machines: tick recording, gap flags, reconnect schedule,
  session marking (pure logic, no I/O).
- `kill/`: `switch`: SOFT, MEDIUM and HARD kill levels.
- `stage/`: `STAGE` file verification and its hash chain.
- `log/`: `journal`: the hash-chained journal written before every order.
- `exec/`: `router` (order identity, intent and ack machine, reconcile),
  `decide` (the candidate gate, sizing and veto to an order intent), `moc_plan`
  (stop-before-MOC sequencing).
- `broker/`: the Alpaca paper adapter, the `http_curl` transport, `ws_stream`
  (`trade_updates`), `smoke_paper` and `live_drill` (live paper checks).
- `runner/`: `runner` (recovery, cycle, HALT), `main.cpp` (the read-only
  production entry), `paper_loop` and `paper_loop_main` (account, candidates,
  decide, submit), `account`, `approved` (the `approved.json` loader), `bars`,
  `calendar` (holidays, early closes), `events`, `settle` (T+1 book), `store`.
- `fixtures/`: Alpaca reply fixtures. `vectors/`: candidate wire lines and
  snapshot vectors.
- `tests/`: mock-venue drills (`transport_faults.py`, `ws_faults.py`,
  `e2e_mock_venue.py`, `soak_mock.py`).

## 4. collector/ (tests co-located)

Ingestion: the poller that turns outside data into `data/signals/<day>.jsonl`.
`research/sources/` holds the per-source adapters, readiness probes and the
earnings veto gate.

- `collect.py`: the poller. User-Agent-bearing fetch, per-source TTL and
  heartbeat, key gating, stale means expire (absent is not neutral), and more
  than 50% poll failure over 24 hours disables a source and alerts. Reads
  `sources.json` and config; writes `data/signals/`.
- `config.py`: the canonical env loader and `load()` states (`CONFIG_OK`,
  `MISSING_REQUIRED_CONFIG` exit 2, per-source `SKIPPED_OPTIONAL_CONFIG`).
- `classify.py`, `pregrade.py`: TRIGGER, CONTEXT and NULL classification and
  triage.
- `ctx_read.py`: the bundle and feature reader (`read_latest`); validity is owned
  here (`research/engine/schema.py` never re-validates).
- `soak.py`, `soak_check.py`, `audit.py`: the soak harness, its acceptance check
  and a self-audit helper.
- `entity_map.json`, `sources.json`: config.
- `tests/`: `test_collect`, `test_config`, `test_ctx`, `test_env_loading`,
  `test_pipeline`, `test_soak_check`. Mocked I/O, no network.

## 5. research/

### engine/

The source seam: the five adapters (EDGAR, FRED, Treasury, BLS, BEA) are the
harvest step, pure I/O with no model, orchestrated once by `source_seam.py`,
which owns the adapter singletons, stamps, heartbeats and the canonical mapping
into the resolver. `runner.py::build_production_runner` composes one runner (one
seam and one graph app per process) and binds the seam-owned graph callbacks
`harvest`, `parser_extract` and `resolve_emit`; supplying one from outside is a
`ConfigError`. The graph's emit node is the sole publisher. On restart, canonical
lookup falls back to the durable `seam_canonical` projection (absent means fail
closed) and history tails recover from durable accepted bundles. Nothing in the
engine trades.

- `runner.py`: production composition; resolves the lineage DB (honors
  `MIRO_CANONICAL_DB`), bundle outdir and pinned map.
- `source_seam.py`: the harvest seam: adapters with real pacing, stamps and
  heartbeats, canonical lineage, durable projection, watermarks, parser extract.
- `graph.py`: the six-node `run_cycle`; per-epoch budget threads; one run per
  process; aborted checkpoints are terminal; an abort publishes nothing.
- `workers.py`: model workers; `make_raw_provider` (missing config raises
  `ConfigBlocked`; proxy-pinned OpenRouter transport).
- `timeout.py`: the `run_in_process` kill ladder.
- `spend.py`: `SpendGovernor` (stage caps, reservation and settlement under a
  tier lock, `LedgerUnavailable`).
- `budgets.py`, `caps.py`: the research-caps cycle registry and caps.
- `attribution.py`: unknown-spend reconciliation and the per-node, per-model and
  per-day log.
- `locks.py`, `digest.py`: the marker and state layer and same-transaction
  content digests (never rebuilt).
- `emit.py`, `publish.py`, `retention.py`: atomic bundle emit, `read_latest` (uses
  `collector.ctx_read`), production publish, the 7-day prune.
- `cadence.py`: cadence and cost gating.
- `resolver.py`: the deterministic evidence resolver (the model is advisory only).
- `event_direction.py`: the deterministic event direction table.
- `schema.py`: feature constants and builders (validity owned by
  `collector/ctx_read.py`).

The link graph (`plan/engine.md`) has its store and three deterministic edge
builders. The event pipeline, router, brain and verifier are parked
(`plan/roadmap.md`, Parked).

- `link_store.py`: the bitemporal, append-only, hash-chained edge store.
  `LinkStore.add`, `supersede` and `retire` append; `edges(as_of_valid,
  as_of_known)` answers as-of queries; `verify` detects tampering. Times are
  integers, `YYYYMMDD` by convention across the edge builders.
- `text_peers.py`: `text_peer_edges` turns 10-K Item 1 text (from
  `sources/filing_sections`) into `text_peer` edges by TF-IDF cosine over one
  fiscal-year cohort. Quadratic in the cohort size.
- `ownership_edges.py`: `ownership_edges` turns 13F rows (from
  `sources/form13f`) into `common_owner` edges by holdings overlap, comparing
  only issuer pairs that share a filer.
- `customer_edges.py`: `coverage` reports per fiscal year the share of 10-Ks that
  disclose a customer; `edges` extracts customer and supplier edges with
  deterministic patterns, resolves names through `sources/ticker_map` and an
  alias table (an unresolved or ambiguous name gives no edge) and ages an edge
  out 18 months after its latest filing; `precision` scores a labeled set.

### sources/

Adapters `edgar.py`, `fred.py`, `treasury.py`, `bls.py`, `bea.py`, plus `tier_a.py`
(the Tier A readiness probe), `calendars.py` (the fail-closed session gate),
`earnings.py` (the EDGAR earnings veto gate, ±3 days, unknown means suppress) and
`tier_a_evidence.json` (a committed measurement, not runtime input). Host-side
probes use direct `urllib`; worker containers egress only through Squid.

Pure modules built on fixtures, with no collector wired to them yet:

- `edgar_filings`: lists a submissions JSON's 10-K, 10-Q and 8-K filings and
  fetches primary documents through an injected transport into a hashed manifest.
- `filing_sections`: Items 1, 1A, 2, 7, 7A and 8 of a 10-K with character offsets.
- `form13f`: the 13F information table parser and holdings overlap; the value
  unit follows the filing date (dollars from 2023-01-03).
- `shares_outstanding`: cover-page shares and public float from companyfacts JSON.
- `ticker_map`: the point-in-time CIK to ticker answer over dated observations;
  `ticker_observations` builds those observations from cover pages, Form 4
  rows, corporate actions and former names.
- `last_trade` and `end_events`: the dated last trading day of a delisted firm;
  `end_events` extracts Form 25, Form 15 and 8-K events from a submissions JSON.
- `french_factors`: daily Fama-French five factors and momentum as decimals.
- `gdelt_gkg`: GKG 2.1 parsing, exact-match organisation-to-CIK resolution, daily
  co-mention pair counts and the resolution rate.

In tests these import each other as `sources.x`; `research/strategy` code uses
`research.sources.x`. Use the second form in new code, so one module is not
loaded twice.

### strategy/ (the backtest harness)

- Harness: `ledger` (the hash-chained trial ledger), `costs`, `settlement`,
  `margin` (the US-set margin ledger), `portfolio` (cash account or margin
  account runs), `tranches` (monthly tranches over a caller's weights),
  `benchmarks`, `stats`, `gates` (strategy gates and the `breadth` report),
  `prereg`, `placebo` (degree-preserving rewiring test), `universe` (the
  point-in-time eligible universe from the sources modules), `backtest`
  (`run_backtest`: validates a prereg, opens the ledger trial before any
  result, runs the holdout at 1x and 2x cost, applies the gate and closes the
  trial; bars are passed in, with SPY and IEF required for the 60/40 benchmark).
- Strategy components: `etf_trend` (the trend signal as a `target_fn` and
  `exposure_scale`, the continuous rate-capped gross multiplier), `text_change`
  (Item 1A and MD&A similarity to the prior-year filing, with litigation and
  CEO/CFO sub-scores) and `composite` (winsorized, residualized z-scores of the
  link, filing and insider components, the equal-weight composite, the
  agreement gate, the short vetoes, `target` for the backtest runner, and
  `component_correlation` with `effective_signal_count`).
- Backtest data: `bar_loader` (verified on-disk SIP datasets into
  `prices[sym][date] = (open, close)`; `benchmark_symbols` adds SPY and IEF).
- Market data: `sip_fetch` (SIP datasets with manifests; `load_alpaca_env`) and
  `bulk_bars` (throttled many-symbol fetch).
- Event data: `form4` (insider filings, the routine-trade classifier and the
  opportunistic flag with entry times), `issuer_symbols` (cik to symbol lookups;
  `read_symbols` feeds the coverage probe) and
  `sec_financial_statements` (SEC financial-statement data sets).
- Candidates: `candidate_wire` (the writer for `candidates.jsonl`) and
  `passive_core` (the 60/40 passive core).

Records: `prereg/` (preregistrations), `ledger/` (the trial ledger and its
checkpoint), `reports/` (backtest gate reports), `lessons/lessons.jsonl` and
`requirements.txt` (pinned engine deps). `ledger/` and `reports/` start empty;
`prereg/` holds drafts (`etf_trend` and `connected_drift`), each with an
`open_questions` list that the operator answers before it is registered.

Not yet wired: `backtest` has only run on synthetic bars (the chain test); no real
SIP datasets are on disk for `bar_loader` to read, `composite` has run only on
fixtures, nothing feeds it real filings, 13F rows or Form 4 rows, and no
collector feeds the pure `sources/` modules.
`TODO.md` lists the next steps.

### sandbox/

Worker isolation and live probes: `setup-identities.sh` (OS identities and
deny and allow probes), `egress-proxy/squid.conf` and `egress-probe.sh`,
`Dockerfile`, `config-probe.py`, `kill-probe.py`, the `kill9_*` resume proof,
`langfuse/docker-compose.yml` (secrets from the environment), and live probes for
Alpaca paper, BEA, FRED vintages and the model provider.

### tests/

Suites for the engine (`test_engine`, `test_hardening`, `test_emit`,
`test_source_seam`, `test_seam_graph`, `test_event_direction`), isolation and
sources, each adapter, the harness (`test_stats`, `test_ledger`, `test_gates`,
`test_costs`, `test_settlement`, `test_portfolio`, `test_prereg`,
`test_candidate_wire`, `test_passive_core`, `test_tranches`, `test_placebo`,
`test_universe`, `test_etf_trend`, `test_etf_trend_chain`,
`test_composite`, `test_text_change`, `test_connected_drift_prereg`,
`test_connected_drift_chain`, `test_bar_loader`, `test_backtest`), the event data
modules (`test_form4`, `test_issuer_symbols`, `test_french_factors`,
`test_ticker_map`, `test_ticker_observations`, `test_shares_outstanding`,
`test_form13f`, `test_last_trade`, `test_end_events`, `test_filing_sections`,
`test_edgar_filings`, `test_gdelt_gkg`), the link graph (`test_link_store`, `test_text_peers`,
`test_ownership_edges`, `test_customer_edges`) and the ops tools (`test_forward_ledgers`,
`test_forward_eval`, `test_forward_register`, `test_alert_relay`,
`test_deploy_check`). CI job assignment is in `.github/workflows/ci.yml`.

## 6. ops/

The paper run and the forward ledgers; see `ops/deploy/README.md`.

- `deploy/`: `start.sh` (builds, asks for the sign-off phrase, starts the loop and
  the forward ledgers), `run.sh` (supervisor), `check.py` (run check),
  `session_calendar.json` (2026-2028, with early closes; also read by `research/sources/tier_a.py`), `approved.json.example`.
- `emit_candidates.py`: passive-core candidates from SIP daily bars.
- `forward_ledgers.py`: log-only virtual books for the passive core, the
  benchmarks and any strategy in shadow; `--verify` is the fidelity replay.
- `forward_eval.py`: the paired evaluator against benchmarks with checkpoints.
- `forward_register.py`: registers each forward ledger in the trial ledger.
- `monitor.py`: the live view. `alert_relay.py`: outbound-only alerts.

## 7. data/ (untracked runtime, never committed)

`canonical.db`, `classified/`, `signals/`, `soak/`, `state/`: collector and engine
runtime output, ignored by `.gitignore`.

## 8. Flows

Collector path: a Tier A or B source goes through `collector/collect.py`
(TTL, heartbeat, keys), then `classify`, then `data/signals/<day>.jsonl`. Engine
path: the five adapters, then the `source_seam.py` harvest (canonical lineage
through `classify` into the shared records table), the graph nodes, the emit
bundle (`resolve_emit`) and `ctx_read`. Paper loop: candidates
(`ops/emit_candidates.py`), `paper_loop`, decide, a journal row, an order on
Alpaca paper, and reconcile.

Gating: the earnings veto and the session calendar suppress entries; exits are
never gated. Failure: a down source leaves a stale heartbeat and features expire
(absent is not neutral); a missing calendar means zero entries; unknown spend
blocks until reconciled or a fresh cycle; misconfiguration raises
`ConfigBlocked`; an abort publishes nothing; digests are never rebuilt.

Money-affecting ownership: reservation and settlement are `spend.py` under the
tier lock; size comes from the risk module; exits are local (`plan/execution.md`);
stages are `plan/stages.md` (demotion automatic, promotion never by code);
attribution is the `attribution.py` mirror (a missing ledger raises, never reads
as $0).

## 9. Status

- Built: the kernel through the router and journal, the collector, the engine's
  source seam and research graph, the harness for the India set, the forward
  ledgers.
- Built on fixtures: the link graph, the three strategy components, the
  composite and the shorts harness. Not built: collectors that feed them real
  data, the `connected_drift` backtest, kernel short selling and the netting
  router. Parked: the event pipeline and ripple reasoning. No stage beyond
  paper.
- Credentials in use: OpenRouter, FRED/ALFRED, BEA and Alpaca paper. There is no
  FX venue and no other keys exist.
