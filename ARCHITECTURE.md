# ARCHITECTURE — hypothesis-arena as it actually exists

AI-assisted paper-trading fund (forex majors + US equities, no crypto).
Two execution substrates: a deterministic C++ kernel (`kernel/`, decides
under risk authority) and a Python research plane (`research-plane/`,
produces context features). A frozen Python collector (`collector/`)
polls free data sources. Paper-only: `G0_PAPER` is the only permitted
stage; no live capital, no Slice-D work (both NOT AUTHORIZED).

## 1. Top-level layout

```text
hypothesis-arena/
  .env / .env.example      canonical runtime config + template (see §9)
  AGENTS.md                session rules (plan is source of truth, etc.)
  ARCHITECTURE.md          this file
  README.md                operator quickstart
  TODO.md                  build ledger (checked boxes = done)
  plan/                    source of truth: 00-INDEX + docs 01–13,
                           system-manifest.yaml (freeze pins)
  scripts/freeze-check.sh  read-only gate: repo must match the manifest
  .github/workflows/ci.yml hosted CI: stdlib, evidence, plane, kernel
  collector/               frozen source poller (Python, stdlib-ish)
  collector/tests/         collector suites (mocked IO, no network)
  research-plane/plane/    research graph + spend/ledger machinery
  research-plane/sources/  Tier-A probes: tier_a.py, calendars.py,
                           earnings.py (veto gate)
  research-plane/tests/    plane battery: test_plane, test_hardening,
                           test_emit, test_isolation, test_sources
  research-plane/sandbox/  deployment evidence: identity/egress/image/
                           config/kill/Langfuse/feeds/resume probes
  research-plane/lessons/  lessons.jsonl (Tier-D weekly-agent output)
  research-plane/
    DEPLOYMENT_EVIDENCE.md per-box runtime proof log
    PHASE_E_AUDIT.md       audit addenda (rounds 1–9 + deployment)
  research/                HISTORICAL memos only (see §11)
  kernel/                  deterministic core: *.hpp + subdirs below
  kernel/tests/            P3 suites: test_p31/32/33.cpp, fuzz_p31.cpp
  kernel/build.sh          P3.1 gate: builds + runs every suite
  kernel/auth/             compile-time authority proofs (neg_* must
                           FAIL compilation; pos_authorized must pass)
  kernel/ingest/           features.cpp/hpp + test_features/noalloc
  kernel/risk/             veto.cpp/hpp + test_veto.cpp
  kernel/p33/              committed decision-table rows (r_*.json)
  kernel/fixtures/         committed P3.1 fixtures
  kernel/vectors/          committed P3.2 vectors (canon hex + hashes)
  kernel/gen_*.py          fixture/vector generators (build tooling)
  data/                    UNTRACKED runtime: canonical.db, classified/,
                           signals/, soak/, state/
```

## 2. Collector (`collector/`) — FROZEN

What: polls free sources (EDGAR, Fed/ECB RSS, Treasury, BLS, FRED-gated),
classifies into TRIGGER/CONTEXT/NULL, writes `data/signals/<day>.jsonl`.
Why: the only path by which outside data enters the system.

- `collect.py` — poller: UA-bearing fetch, per-source TTL/heartbeat,
  `needs_key` gating (`FRED_API_KEY`), 15-min REST reconcile posture.
  Reads: `sources.json`, `session_calendar.json`, `.env` (via config).
  Writes: `data/signals/`. Failures: per-source heartbeat marks
  stale/down, never a crash; `>50%` poll failure over 24h disables.
- `config.py` — THE config loader. `_load_dotenv()` reads repo-root
  `.env`, allowlisted KEYS only (`MIRO_CONTACT` required,
  `FRED_API_KEY`/`OPENROUTER_API_KEY` optional), fills only keys
  missing from the real environment (exported vars win). `load()`
  returns `CONFIG_OK` / `MISSING_REQUIRED_CONFIG` / skipped-optionals.
- `classify.py` / `pregrade.py` — source classification + grading.
- `jev.py` — JEV sidecar v3: pinned revision/provider, Ed25519
  sign/verify, spend ceiling, `OPENROUTER_API_KEY` absent →
  `jev_error:no-key` HOLD (never crash). Reads key from env only.
- `soak.py` / `soak_check.py` / `SOAK_REPORT.md` / `SOAK_MANIFEST.json`
  — soak harness + 133-cycle report (7-day target shortened on evidence).
- `ctx_read.py` / `entity_map.json` — entity resolution for readers.
- `audit.py` — collector self-audit helper.
- `tests/` — six suites, mocked IO, no network. Run:
  `python3 collector/tests/test_*.py`. Hosted CI `stdlib` job runs them.
- Frozen: zero-diff vs the Round-9 tree. CI `stdlib` failure is the
  pre-existing frozen-collector failure — documented, never fixed by
  touching frozen code.

## 3. Research plane (`research-plane/plane/`) — ACTIVE (hardened R1–R9)

What: 6-node LangGraph research cycle producing `features.jsonl` context
features plus the spend/ledger control plane. Why: context and
disconfirmation for the statistical layer; every dollar accounted.

- `graph.py` — `run_cycle(app, symbols, epoch, thread)`: the 6-node
  graph; per-epoch budget threads; aborted checkpoints are terminal
  (fail-closed, never auto-cleared). Checkpoints: LangGraph SQLite.
- `workers.py` — model workers; `make_raw_provider(cfg)` needs
  `model_id` + `egress_proxy` (+ `api_base`/`api_key`); no proxy →
  `ConfigBlocked`, never direct. OpenAI-compatible → OpenRouter works
  via `api_base=https://openrouter.ai/api/v1`.
- `timeout.py` — `run_in_process()`: streaming Pipe IPC, poll/read
  while child runs, bounded frames, `_kill_and_reap()` ladder
  (TERM → KILL), 7-day stale-thread rejection, IPC byte caps.
- `spend.py` — `SpendGovernor`: USD reservation/settle, tier-locked
  single-lock persist, `LedgerUnavailable` propagation, ratio journals.
- `budgets.py` / `attribution.py` — R15 `cycles` registry
  (`counters-deleted` deny), unknown-spend reconciliation
  (evidence-first synthetic spans, `reconcile-over-reservation` reject).
- `locks.py` — marker/state fail-closed FS layer: only
  `FileNotFoundError` is absent/fresh; `may_create_tables()`,
  historical roots, `marker-deleted`/`tier-state-unreadable` denies.
- `r15.py` / `digest.py` — content digests (schema v3, same-txn,
  `digest-mismatch`/`digest-deleted` denies, never rebuilt); `.seen`
  sidecar witness-first; 300s future-skew rejects.
- `emit.py` / `publish.py` / `retention.py` / `cadence.py` /
  `resolver.py` / `schema.py` — bundle emit + `read_latest`, bounded
  map loads, retention (failure raises), cadence gating, entity
  resolution, feature schema f2.
- `tests/` — 255-test battery (`test_plane` 108 + `test_hardening`
  116 + `test_emit` 19 + isolation + sources). Hosted CI `plane` job
  runs it with no external network (`.invalid` hosts only).
- `sandbox/` probes do NOT duplicate this logic; they drive the
  shipped constructors (config-probe, kill-probe) or reuse test
  fixtures (kill9 worker).

## 4. Sources (`research-plane/sources/`) — ACTIVE

- `tier_a.py` — Tier-A readiness probe: live EDGAR/Fed GETs with the
  frozen UA (3 samples, p50/p99), FRED→BLOCKED without key (never
  downgraded), calendar gate result. Writes evidence JSON; exit 0
  always (evidence, not a gate). Tested by `tests/test_sources.py`,
  also run in the hosted `evidence` job.
- `calendars.py` — fail-closed session gate: missing/corrupt calendar
  → `CalendarMissing` → zero session-gated records. Presence-gate
  only; session evaluation lives downstream in ctx logic.
- `earnings.py` — EDGAR-derived earnings veto gate (Tier-A veto side):
  symbol→CIK→submissions, 8-K Item 2.02 + 10-Q/10-K event windows,
  ±3-day veto; unknown/failure/empty → event-present → suppress.
  `__main__` live probe records p50/p99. TTL/heartbeat wiring OPEN.
- `sources.json` + `session_calendar.json` live in `collector/`
  (frozen config); `sandbox/tier-a-deploy-evidence.json` and
  `sandbox/earnings-deploy-evidence.json` are deployment measurements.

## 5. JEV decision layer — FROZEN contract

Question set v3, feature schema f2, strategy `baseline_v1`, exit profile
`exit_profile_v1`, research graph g1 (all pinned in
`plan/system-manifest.yaml` and policed by `scripts/freeze-check.sh`).
`collector/jev.py` (sidecar) ↔ `kernel/jev_validate.hpp` (validator):
the ONLY path from model answers to position size is the frozen §3.2
table (`kernel/decision_table.hpp` takes the typed object, never raw
JSON/strings — build-gated). No confidence accessor exists anywhere on
the kernel path (build-gated). R1–R17 live in
`plan/05-risk-and-determinism.md`.

## 6. Kernel (`kernel/`) — FROZEN implementation

What: pure deterministic C++17 evaluation: validate → veto → decide.
Why: the decision boundary must be reproducible bit-for-bit with no
heap, no network, no Python on the tick path. Zero-malloc contracts
are build-gated (vocabulary grep + wrapped-malloc counter → NOALLOC).

- `jev_validate.hpp` / `jev_state.hpp` / `kernel_state.hpp` /
  `decision_table.hpp` — validator, state, typed table.
- `tests/` — `test_p31.cpp` (39 checks), `test_p32.cpp` (37, committed
  vectors only), `test_p33.cpp` (committed `p33/` rows), `fuzz_p31.cpp`
  (20k). Fixtures in `fixtures/` + `vectors/` (canon hex + hashes).
- `auth/` — neg_* probes must FAIL compilation (authority boundary is
  compiler-enforced); `pos_authorized.cpp` is the healthy control.
- `ingest/features.cpp` — f2 validation/retention/rate window, no-alloc.
- `risk/veto.cpp` — veto execution; must never read model answers
  (token-gated, comments included).
- `build.sh` — the gate: normal + hardened modes, all suites, fuzz,
  every grep-gate above. Exit 0 = PASS. Hosted CI `kernel` job runs it.
- `gen_*.py` — fixture/vector generators (offline build tooling).

## 7. Risk / authorization boundaries (what must NEVER happen)

- No source outage may block an exit (exits are local, doc 06).
- OSINT never widens/narrows/moves stops; stops are the frozen exit
  profile (doc 03 §3.3).
- Non-price sources enter as CONTEXT/NULL; TRIGGER promotion needs
  measured edge + human sign-off (doc 11). No GEV layer is TRIGGER
  in v1. Estimated timestamps are CONTEXT-capped permanently.
- Service identities never execute as the human/control-plane operator
  (`mirohuman` stays nologin by ruling; research/trading run as
  `miroresearch`/`mirotrade`/`mirojev` under setpriv, private groups).
- Provider calls go through the egress proxy allowlist or they do not
  happen (`ConfigBlocked`). Direct egress from the sandbox net is
  unroutable (`--internal`).
- Unknown spend blocks; reconciliation needs evidence first; aborted
  checkpoints never auto-clear; digests are never rebuilt.
- No live capital (`G0_PAPER` only), no Slice D, no crypto, no FIX in v1.

## 8. Supervisor / process lifecycle

Production runs research cycles under a supervisor driving
`run_in_process` with `timeout_s=WALL_S=480s`: TERM → escalate KILL →
reap; missing result envelope after child exit is a loud `RuntimeError`,
never success. Proven on Linux by `sandbox/kill-probe.py` (4/4) and
end-to-end by `sandbox/kill9-resume.sh` (40-epoch SIGKILL → ambiguity
blocks → `reconcile_unknown` → fresh cycle → 40/40 exactly once).
The 7-day unattended run is OPEN (elapsed evidence, not mechanism).

## 9. Configuration / environment flow (single source of truth)

```text
.env.example (tracked template) → copy → .env (ignored, real values)
      │ collector/config.py::_load_dotenv() loads root .env,
      │ allowlisted KEYS only, exported environment wins
      ├── collector/* (MIRO_CONTACT, FRED_API_KEY, OPENROUTER_API_KEY)
      └── research-plane sandbox PYTHON via `collector.config.load()`
          (no second env file, no second loader — provider.env retired)
CI: no secrets (mocked IO / .invalid hosts). Docker: evidence-only
placeholder creds inside sandbox compose (labeled, production replaces).
```

## 10. Docker / isolation / egress

`sandbox/Dockerfile` builds `mirohedge/worker:sandbox-<date>` from a
digest-pinned `python:3.11-slim-bookworm` base (SBOM CycloneDX 194 pkgs
+ scout scan baselined, in `sandbox/`). Topology: worker on
`--internal` net + Squid proxy (`sandbox/egress-proxy/squid.conf`,
exact `dstdomain` allowlist) on both nets; worker runs with the doc-08
container flags (uid 65532, read-only, cap-drop, pids/memory/cpu
limits). `sandbox/egress-probe.sh` proves: allowlist transits,
non-allowlist dies 403 AT the proxy, direct egress has no route.
`sandbox/setup-identities.sh` creates the four OS identities + the
`/srv/mirohedge` tree (700 cred dirs) + deny/allow probes.

## 11. Persistence / storage

- Ledgers: SQLite (`spend`/`budgets` ledgers, schema v3, digest table
  mandatory) + marker files + `.seen` sidecars + ratio/tier journals.
- Graph checkpoints: LangGraph SQLite (`ckpt.sqlite3`).
- Bundles: `out/` committed bundles + `manifest` + `canonical.db`;
  readers resolve via `emit.read_latest`.
- Collector runtime (UNTRACKED, never committed): `data/canonical.db`,
  `data/classified/`, `data/signals/`, `data/soak/`, `data/state/`.
- Langfuse self-hosted stack (`sandbox/langfuse/docker-compose.yml`:
  postgres16 + redis7 + clickhouse24 + langfuse:2) for per-node
  token/dollar attribution; full-day live attribution needs the model key.

## 12. Feature generation (end-to-end)

```text
Tier-A/B source → collector/collect.py (poll, TTL, heartbeat, UA/keys)
  → classify (TRIGGER/CONTEXT/NULL) → data/signals/<day>.jsonl
  → research-plane graph.py run_cycle (LLM context via workers.py,
     spend-governed, checkpointed) → features.jsonl + emit bundles
  → kernel boundary: jev_validate → veto → decision_table
  → paper fills only (doc 06 §6.5 fill model; 10bp drag modeled)
Error paths: source DOWN → stale heartbeat, features expire, JEV shows
absent-not-neutral; calendar missing → zero entries; unknown spend →
block → reconcile-or-fresh-cycle; provider misconfig → ConfigBlocked.
```

Alternate/veto paths: earnings event → entry suppressed; session
closed → no entries; exits never gated by any source.

## 13. Tests and verification jobs

| Suite | Where | Runs |
|---|---|---|
| collector 6 suites | `collector/tests/` | local + CI `stdlib` |
| plane battery 255 | `research-plane/tests/` | local + CI `plane` |
| sources + isolation | `research-plane/tests/` | local + CI `evidence` |
| kernel gates + fuzz | `kernel/tests/` + `build.sh` | local + CI `kernel` |
| freeze pins | `scripts/freeze-check.sh` | local + CI + README quickstart |

Rule (operator): when implementation files change, update the
corresponding suite in the same area and run everything — tests live
beside their components (`collector/tests/`, `kernel/tests/`,
`research-plane/tests/`) and are never deleted.

## 14. CI structure (`.github/workflows/ci.yml`)

Four independent jobs: `stdlib` (collector suites, mocked IO),
`evidence` (isolation + sources, decoupled from the frozen collector
loop), `plane` (255-test battery, no external network), `kernel`
(gates + freeze pins). Known state: plane/kernel/evidence SUCCESS,
stdlib FAILURE = pre-existing frozen-collector failure (documented).

## 15. Deployment / evidence structure

`research-plane/sandbox/` holds one probe per box (identity, egress,
image, config, kill, Langfuse, feeds, kill9-resume) plus their JSON
artifacts; `DEPLOYMENT_EVIDENCE.md` is the per-box proof log;
`PHASE_E_AUDIT.md` is the audit trail (Rounds 1–9 + deployment
addenda). `research-plane/lessons/lessons.jsonl` carries the 12/12
graded Tier-D lessons.

## 16. Frozen vs active vs FUTURE

- FROZEN (zero-diff; change needs human contract-defect ruling):
  `kernel/` implementation, `collector/` implementation + config,
  `plan/` history, JEV contracts (v3/f2/baseline_v1/exit_profile_v1/g1).
- ACTIVE: `research-plane/plane` + `sources` + `tests` + `sandbox`
  evidence, `TODO.md`, this file, `README.md`, CI wiring, `.env.example`
  ( additive keys only when a code path consumes them).
- FUTURE / NOT IMPLEMENTED: Slice D (all of it), live capital past
  G0_PAPER, broker-feed pollers (OANDA practice + Alpaca paper —
  plan-locked, no code yet), FRED live wiring, BEA wiring, earnings
  TTL/heartbeat wiring, 7-day run, profit/calibration feeds (G-stage),
  registry publication (optional), Phase 4+ roadmap items.
- `research/` (two memos: `js-gap-analysis.md`,
  `p15-phase2-readiness.md`): RETAINED — referenced by TODO.md as the
  P1.5 reconciliation record and explicitly marked HISTORICAL there.
  They are audit trail, not dead scaffolding; deletion would break
  the TODO reference and destroy history. No other dead material was
  found in the full-tree audit (all dirs referenced by code/CI/docs).
