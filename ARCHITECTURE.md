# ARCHITECTURE — hypothesis-arena, exhaustive codebase guide

AI-assisted paper-trading fund (forex majors + US equities, no crypto).
Status: `Round 9: CLOSED · Deployment: ACCEPTED + hardened ·
Phase D: OPEN · Slice D: NOT AUTHORIZED · G0_PAPER only`.
`plan/` is source of truth; this file describes the tree as it exists
(389 tracked files). Labels: FROZEN (zero-diff without a human
contract-defect ruling) · ACTIVE (current work surface) · FUTURE (not
implemented) · HISTORICAL (audit trail, read-only).

Verify this document: `git ls-files | wc -l` (= 389) and the per-family
counts in §3. Family file lists follow exact name patterns; every
non-family file is named explicitly.

## 1. Root files (11)

- `AGENTS.md` — ACTIVE session rules: read ARCHITECTURE + plan/00-INDEX
  first; plan is source of truth; TODO updated per task; no secrets;
  one-commit-one-theme; fail closed.
- `ARCHITECTURE.md` — this file (ACTIVE).
- `README.md` — ACTIVE operator quickstart + status table + repo map.
- `TODO.md` — ACTIVE build ledger. Checked boxes = done. Contains
  HISTORICAL entries (P1.x–P3.x, Rounds 1–9, deployment boxes) AND the
  current Phase-D gate entry — read the dates/commits to tell them apart.
- `.env` / `.env.example` — ACTIVE canonical config. `.env` is
  git-ignored real values; `.env.example` is the tracked template
  (`MIRO_CONTACT` required; `FRED_API_KEY` / `OPENROUTER_API_KEY`
  optional; broker/BEA keys stay out until a code path consumes them).
  Sole loader: `collector/config.py::_load_dotenv` (root file,
  allowlisted KEYS, exported environment wins). Designated consumer for
  sandbox/research-plane Python: `collector.config.load()`. HONEST
  STATUS: the loader is implemented + tested
  (`collector/tests/test_config.py`); today the only production
  consumer is the collector itself (`collect.py` via config,
  `jev.py` reading `OPENROUTER_API_KEY` from env). No sandbox probe
  calls `config.load()` yet — the first live-provider probe will be
  the first consumer. There is no second env file and no second loader
  (`sandbox/provider.env` retired, `01b6e47`).
- `.gitignore` — ACTIVE. Ignores `.env`, data/, logs, build artifacts.
- `.gitattributes` — ACTIVE. Pins `*.sh` to LF.
- `scripts/freeze-check.sh` — ACTIVE read-only gate: repo must match
  `plan/system-manifest.yaml` (versions, pins, risk rules, component
  presence incl. `kernel/tests/test_p33.cpp`). Exit 0 = PASS.
- `.github/workflows/ci.yml` — ACTIVE. Four independent jobs: `stdlib`
  (collector suites from `collector/tests/`, mocked IO), `evidence`
  (isolation + sources), `plane` (255-test battery, no external net),
  `kernel` (build.sh + freeze pins). Known state: plane/kernel/evidence
  SUCCESS; stdlib FAILURE = pre-existing frozen-collector failure.

## 2. plan/ (15 files, FROZEN history + ACTIVE source of truth)

- `00-INDEX.md` — reading order + doc authority map. Read first.
- `01-vision-and-scope.md` — fund scope; locks venues: OANDA v20
  practice (forex) + Alpaca paper (stocks); broker WS + 15-min REST
  reconcile; no FIX in v1.
- `02-twitter-alpha-system.md` — alpha system contract; X-lists tail
  DISABLED in v1 (§2.6).
- `03-jev-decision-layer.md` — JEV contract: question set v3, 4
  questions, exit profile v1, case 29.
- `04-cpp-deterministic-core.md` — kernel contract §4.2 broker-feed
  staleness, §4.5 ingest.
- `05-risk-and-determinism.md` — R1–R17 (code constants) + §5.1c DAG.
- `06-execution-and-ops.md` — ops: §6.4 HALT friction, §6.5 paper fill
  model (10bp drag), exits local and never source-gated.
- `07-build-roadmap.md` — phase sequencing incl. Phase-0 boxes and
  P3.5 (open; veto + ingest slices landed, sizing/execution not started).
- `08-agentic-research-plane.md` — research-plane contract: §8.2 OS
  identities, §8.3a cadence, §8.4 hardening, §8.5 schema f2, §8.6
  deployment exit boxes.
- `09-osint-and-free-data.md` — source contract: §9.1 Tier-A table
  (broker, EDGAR, FRED/ALFRED, Treasury/BLS/BEA, session calendars,
  earnings calendar) + Tier B/C/D posture; §9.4 "done" = poller + TTL
  + heartbeat + measured p50/p99 per Tier-A source.
- `10-capital-gates-and-spend-control.md` — G0/G1 $150, G2 $400,
  G3 $1000 + 60/80/100% tiers; stage definitions; G0_PAPER only.
- `11-calibration-and-self-improvement.md` — promotion needs measured
  edge + human sign-off; §11.1a regime/decay.
- `12-statistical-baseline.md` — `baseline_v1`, the primary edge.
- `13-cpp-kernel-build.md` — kernel build record; P3.1/P3.2 frozen,
  P3.3 accepted; §13.7 battle ladder. (File paths inside are
  HISTORICAL: `kernel/test_p*.cpp` now live in `kernel/tests/`.)
- `system-manifest.yaml` — freeze pins (v3/f2/baseline_v1/
  exit_profile_v1/g1, JEV revision/provider). freeze-check enforces it.

## 3. kernel/ (FROZEN implementation; tests co-located, never deleted)

Root (8 files): `build.sh` (the gate: normal/hardened modes, every
suite below, fuzz, all grep-gates; exit 0 = PASS) ·
`jev_validate.hpp` (validator; single entry `validate_jev()`) ·
`jev_state.hpp` (`JEVStateV3`; friendship pinned: exactly KernelState +
validator) · `kernel_state.hpp` (`KernelState`) ·
`decision_table.hpp` (typed-input-only table; no raw strings, no
confidence accessor — both build-gated) · `gen_fixtures.py`,
`gen_p33.py`, `gen_vectors.py` (offline fixture/vector generators).

- `tests/` (4): `test_p31.cpp` — validator suite (canonical bytes,
  mutation/key-mismatch failures, UTF-8/nesting/float edges; L-table
  tail 0x00/0x10). `test_p32.cpp` — interop suite on committed
  `vectors/` only (never invokes Python — build-gated). `test_p33.cpp`
  — replay/table suite on committed `p33/` rows only (same rule).
  `fuzz_p31.cpp` — 20k-iteration fuzzer. Includes use `../` headers;
  fixtures resolve from the kernel root at run time.
- `auth/` (7): `pos_authorized.cpp` (healthy control: must compile +
  exit 0) + `neg_accessor/aggregate/assign/construct/friendleak/mutate`
  `.cpp` (each must FAIL compilation for its documented reason —
  the authority boundary is compiler-enforced, build-gated).
- `ingest/` (4): `features.hpp`/`features.cpp` — f2 validation,
  retention, rate window; zero-malloc (vocabulary grep + `FindAscii`
  discipline). `test_features.cpp` — rejection/boundary/retention/rate
  suite. `test_noalloc.cpp` — wrapped-malloc counter proof (0 allocs).
- `risk/` (3): `veto.hpp`/`veto.cpp` — `EvaluateVeto` (RiskSnapshot →
  HOLD/PROCEED + frozen reason; fixed-storage verdict, `__int128`
  widening; must never read model answers — token-gated incl.
  comments). `test_veto.cpp` — veto suite incl. composed veto+table
  rows and case-29 pending-risk isolation.
- `fixtures/` (36): `valid.json` + `state_canon.json` (good controls);
  `bad_*.json` (31 malformed-answer mutations: model/revision/schema/
  provider/qversion/signature/dkey/conviction/family/enter/epoch/date/
  symbol/top-shape/statehash/prob-key/created/expires/leap/float-edge
  variants); `conf_bool.json`, `conf_huge.json` (confidence quarantine);
  `created_unix.txt`, `float_edges.txt` (boundary inputs);
  `decision_key.txt`, `trusted_key.txt`, `pubkey_mutated.json`
  (key/signature controls). Consumed by `tests/test_p31.cpp`; produced
  by `gen_fixtures.py`.
- `vectors/` (11): P3.2 committed pairs — `v1_*` + `v2_*` families,
  each `{payload.json, canonical.hex, response_hash.txt}` plus
  `v1_artifact.json`, `v1_signature.txt`, `v2_signature.txt`,
  `v1_state_canon.json`, `pubkey.txt`. Contract: sha256(canonical hex)
  == response hash, byte-equal C++ reproduction, signature scope =
  payload only. Consumed by `tests/test_p32.cpp`; produced by
  `gen_vectors.py`.
- `p33/` (226): `r_000.json`–`r_199.json` (200 committed
  decision-table rows); `t_*.json` (22 table/boundary cases:
  blackout, bound E50/L50/E79/E80 (+lean), calib, disagree, exec_high,
  flat, latent, lean_base, max_downgrade ×2, max_elevated, midband
  exec/lean, noedge, strong_base, symbol_xxx, veto); `state_vector.json`
  + `state_vector_canon.hex` + `state_vector_hash.txt` +
  `state_vector_dkey.txt` (committed state + hash chain). Consumed by
  `tests/test_p33.cpp` + `risk/test_veto.cpp`; produced by `gen_p33.py`.
  Presence pinned by freeze-check.

## 4. collector/ (FROZEN implementation + config; tests co-located)

Production ingestion path: the poller that turns outside data into
`data/signals/<day>.jsonl`. (Second live-access point:
`research-plane/sources/` readiness probes + the earnings veto gate —
see §5. The collector is the production path; sources/ probes are
evidence and gating, not the poller.)

- `collect.py` — poller. UA-bearing fetch, per-source TTL/heartbeat,
  `needs_key` gating, stale→expire (absent ≠ neutral), >50% poll
  failure over 24h disables + alerts. Reads: `sources.json`,
  `session_calendar.json`, config. Writes: `data/signals/`.
- `config.py` — canonical env loader (see §1) + `load()` states
  (`CONFIG_OK` / `MISSING_REQUIRED_CONFIG` exit 2 / per-source
  `SKIPPED_OPTIONAL_CONFIG`).
- `classify.py` / `pregrade.py` — TRIGGER/CONTEXT/NULL classification
  + grading. Reads poller output. Writes: classified records.
- `jev.py` — JEV sidecar v3: pinned revision/provider, Ed25519
  sign/verify, spend ceiling, retry-once-HOLD; no key → HOLD.
- `ctx_read.py` — frozen bundle/feature reader (`read_latest`);
  validity owned here exclusively (research-plane `schema.py` never
  re-validates). Also imported by plane emit + tests (import ≠ change).
- `entity_map.json` — entity resolution map (config).
- `sources.json` — source registry (incl. `needs_key: FRED_API_KEY`,
  keyless EDGAR/Fed/ECB/Treasury/BLS entries).
- `session_calendar.json` — session/holiday seed (fail-closed veto input).
- `soak.py` / `soak_check.py` / `SOAK_REPORT.md` (133-cycle report) /
  `SOAK_MANIFEST.json` — soak harness + evidence.
- `audit.py` — collector self-audit helper.
- `tests/` (6): `test_collect` (poller/TTL/heartbeat/singleton);
  `test_config` (dotenv/config states); `test_ctx` (reader);
  `test_jev` (sign/verify, HOLD, ceiling); `test_pipeline` (28-check
  end-to-end); `test_soak_check` (soak gate). All mocked IO, no
  network. CI `stdlib` job. Failing hosted = pre-existing frozen
  failure (proven path-independent, Addendum 30).

## 5. research-plane/ (ACTIVE)

### plane/ (16)

- `graph.py` — 6-node `run_cycle`; per-epoch budget threads;
  single-run-per-process guard; aborted checkpoints terminal.
  Reads: budgets/spans/checkpoints. Writes: checkpoints, bundles.
  Failure: abort → emit publishes nothing.
- `workers.py` — model workers; `make_raw_provider` (model_id +
  egress_proxy + api_base/api_key; missing → `ConfigBlocked`, never
  direct; httpx transport-pinned proxy). OpenRouter via OpenAI-compat.
- `timeout.py` — `run_in_process` kill ladder (streaming Pipe IPC,
  bounded frames, TERM→KILL reap, stale-thread + IPC-cap rejects).
- `spend.py` — `SpendGovernor` (G0/G1 $150 tiers; reservation/settle,
  tier-locked single-lock persist, `LedgerUnavailable`).
- `budgets.py` — R15 `cycles` registry (`counters-deleted` deny).
- `attribution.py` — unknown-spend reconciliation (evidence-first,
  `reconcile-over-reservation` reject; per-node/model/day log).
- `locks.py` — marker/state FS layer (only FileNotFoundError =
  absent; `marker-deleted`/`tier-state-unreadable` denies; roots).
- `r15.py` — R15 caps + `.seen` sidecar (witness-first).
- `digest.py` — content digests, schema v3, same-txn
  (`digest-mismatch`/`digest-deleted`, never rebuilt).
- `emit.py` — atomic bundle emit (temp+fsync+rename+manifest) +
  `read_latest` (uses `collector.ctx_read`).
- `publish.py` — production publish (resolver+emit; bounded map loads).
- `retention.py` — retention (failure raises; 7-day prune).
- `cadence.py` — cadence/cost gating (5-min I/O cycles; per-symbol
  re-run rules; 30-min TTL; throttle doubling).
- `resolver.py` — deterministic evidence resolver (LLM advisory only;
  recomputes load-bearing fields from canonical records).
- `schema.py` — frozen f2 constants/builders (shape truth; validity
  owned by `collector/ctx_read.py`).
- `__init__.py` — package marker.

### sources/ (5)

Readiness probes + gates (evidence + veto logic; NOT the production
poller — that is `collector/collect.py`).

- `tier_a.py` — Tier-A readiness probe (live EDGAR/Fed GETs p50/p99;
  FRED→BLOCKED w/o key; calendar gate). Evidence JSON; exit 0 always.
- `calendars.py` — fail-closed session presence-gate
  (`CalendarMissing` → zero records). Evaluation downstream in ctx.
- `earnings.py` — EDGAR-derived earnings veto gate (8-K 2.02 + 10-Q/K
  windows, ±3d; unknown→suppress) + `__main__` live probe (p50/p99).
  Implementation+probe PROVEN; TTL/heartbeat wiring OPEN (§9.4).
- `__init__.py` — package marker.
- `tier_a_evidence.json` — committed Tier-A measurement (immutable
  audit evidence, not runtime input).

### tests/ (5 files + battery)

- `test_plane.py` (108) — graph/R15/cadence/attribution/workers.
- `test_hardening.py` (116) — fail-closed regressions, Rounds 1–9.
- `test_emit.py` (19) — bundles/manifest/reader.
- `test_isolation.py` — 4 protected paths denied (also a deployment
  probe via setpriv; CI `evidence` job).
- `test_sources.py` — calendar gate (3) + earnings veto (6);
  CI `evidence` job.

### sandbox/ (15 + subdirs: deployment evidence machinery)

- `setup-identities.sh` — 4 OS identities + `/srv/mirohedge` tree +
  deny/allow probes (8/8) + repo isolation check (4/4).
- `egress-proxy/squid.conf` — exact `dstdomain` allowlist.
- `egress-probe.sh` — allowlist transits / non-allowlist 403s at proxy /
  direct egress unroutable (5/5) + idempotent proxy bring-up.
- `Dockerfile` — worker image (digest-pinned base).
- `image-sbom.cyclonedx.json` (194 pkgs) + `image-scan.txt`
  (3C/14H/13M/40L baseline) — immutable audit evidence.
- `config-probe.py` — fail-closed constructors (5/5, no mocks).
- `kill-probe.py` — WALL_S ladder on Linux (4/4).
- `kill9-resume.sh` + `kill9_worker.py` + `kill9_reconcile.py` +
  `kill9_verify.py` — 40-epoch SIGKILL→resume proof (both branches).
- `langfuse/docker-compose.yml` — self-hosted attribution stack
  (evidence-only placeholder creds; production replaces).
- `tier-a-deploy-evidence.json` + `earnings-deploy-evidence.json` —
  immutable measurement artifacts (not runtime inputs).

### research-plane root (4)

- `DEPLOYMENT_EVIDENCE.md` — ACTIVE per-box proof log (current gate
  statuses live here).
- `PHASE_E_AUDIT.md` — HISTORICAL + ACTIVE audit trail (Round 1–9
  addenda frozen as history; newest addendum = current record).
- `lessons/lessons.jsonl` — ACTIVE Tier-D output (12/12 graded).
- `requirements.txt` — ACTIVE pinned plane deps (`==` only).

## 6. research/ (2, HISTORICAL — RETAINED)

- `js-gap-analysis.md` — P1.5 Jane-Street gap analysis (DONE, no code).
- `p15-phase2-readiness.md` — reconciliation memo (its "not
  implemented" statements describe P1.4-close state, not today).
  Retained: TODO.md references both as the reconciliation record;
  deletion would break the reference and destroy audit trail.

## 7. data/ (UNTRACKED runtime, never committed)

`canonical.db`, `classified/`, `signals/`, `soak/`, `state/` —
collector/plane runtime outputs. Local-only by `.gitignore`.

## 8. Cross-component flows

Production: Tier-A/B source → `collector/collect.py` (TTL/heartbeat/
keys) → classify → `data/signals/<day>.jsonl` → plane `graph.py`
(LLM context via `workers.py`, spend-governed, checkpointed) →
`features.jsonl` + emit bundles → kernel `jev_validate` → `risk/veto`
→ `decision_table` → paper fills (doc 06 §6.5). Gating overlay:
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

## 9. Status ledger (current)

- FROZEN: `kernel/` impl, `collector/` impl+config, `plan/`, JEV
  contracts, `research/` memos, round addenda, evidence JSON artifacts.
- ACTIVE: `research-plane/plane`, `sources`, `tests`, `sandbox`,
  `lessons.jsonl`, `requirements.txt`, `TODO.md`, `README.md`, this
  file, CI wiring, `.env.example` (additive consumed keys only).
- FUTURE: Slice D; live capital past G0_PAPER; broker pollers (OANDA
  practice + Alpaca paper); FRED/BEA live wiring; earnings TTL/
  heartbeat; 7-day run; profit/calibration feeds (G-stage); registry
  publication (optional); P3.5 sizing/execution.
- Current Phase-D credentials (ONLY): OpenRouter, FRED/ALFRED, BEA,
  OANDA practice, Alpaca paper. No other mandatory keys exist.
