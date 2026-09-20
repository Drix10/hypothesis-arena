# 08 — Agentic Research Plane

The research plane is the slow, rich half of the system. It reads the world and
writes **typed, bounded features** into the context the hot path freezes. It has
no other output. It cannot size, send, amend, or cancel an order, and no agent
output can ever relax a risk rule.

This doc defines the framework choice, the agent topology, the contract with the
hot path, the isolation boundary, and the failure defaults.

## 8.1 The one-way boundary (locked, read this first)

```
   OSINT + market + filings + X-lists   (doc 09)
                  │
                  ▼
        ┌───────────────────────┐
        │  RESEARCH PLANE       │   LangGraph orchestrator + smolagents workers
        │  (Python, sandboxed)  │   unprivileged user, no broker credentials
        └──────────┬────────────┘
                   │  writes ONLY: features.jsonl (typed, schema-checked)
                   ▼
        ┌───────────────────────┐
        │  ctx/ (C++)           │   validates, bounds, stamps, freezes
        └──────────┬────────────┘
                   ▼
            Snapshot → JEV → risk/ → exec/
```

- **R11 (new, doc 05):** the research plane writes exactly one artifact class —
  `features.jsonl` — and nothing else in the trading tree. It has no broker keys,
  no write access to the journal, no write access to `HALT`, no write access to
  the stage file (doc 10), and runs as a separate OS user. Enforced by filesystem
  permissions, not by convention.
- Agents never see account equity, position sizes, or PnL. They receive a
  *masked* portfolio view (`exposure_bucket`, `positions_open_count`) so their
  reasoning cannot be anchored on capital. Removing the anchor also removes a
  whole class of "we're down, size up" pathology.
- Every feature carries `observed_at_ns` (when the source published) and
  `ingested_at_ns` (when we saw it). `ctx/` drops any feature whose
  `observed_at_ns` is in the future relative to the snapshot, or whose
  `ingested_at_ns` is older than the feature's declared TTL. This is the
  anti-lookahead rule (R12) and it is structural, not a review step.

## 8.2 Framework choice (locked): LangGraph orchestrator + smolagents workers

**Chosen stack**

| Layer | Choice | Why |
|---|---|---|
| Orchestration, state, resume | **LangGraph** (MIT, OSS, no LangChain/LangSmith required) | Durable execution with checkpointers; thread-scoped state snapshots; resume-after-crash; `interrupt()` for human gates; time-travel replay of a run. This is the only candidate whose core abstraction is *durable state*, which is what a 24/7 unattended research loop actually needs. |
| Leaf research workers | **smolagents** (Apache-2.0) `CodeAgent` | Actions are Python, not JSON tool-call chains: multiple lookups collapse into one step, which is the single biggest token lever available for free. Runs under a sandbox (Docker) with a pinned import allowlist. |
| Checkpoint store | **SQLite** (`SqliteSaver`) in paper, **Postgres** (`PostgresSaver`) from tiny-live onward | Paper needs zero ops; live needs async + concurrent writers. Checkpoints pruned at 30 days. |
| Observability | **OpenTelemetry → self-hosted Langfuse** (OSS) | Full traces, per-run token and cost attribution, no vendor lock, no LangSmith subscription. Cost attribution is load-bearing for doc 10. |
| Structured output | Pydantic models, validated at the plane boundary | A feature that fails validation is dropped and counted, never coerced. |

**Ranking (evaluated against the six criteria in the brief, plus two the brief implies)**

Scores are 1–5, higher is better. "Sec" = security posture for a process sitting
next to trading capital.

| Framework | State durability | Tool reliability | Observability | Token eff. | Multi-agent | Prod. stability | Sec | License | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| **LangGraph** | **5** — checkpointers (InMemory/SQLite/Postgres), durable execution, resume from exact pre-failure state, time travel | 4 — explicit graph edges; retries are yours to define | 4 — OTel + Langfuse/LangSmith; graph structure is inspectable | 3 — JSON tool-calling overhead unless paired with code agents | 4 — supervisor/subgraph patterns, deterministic edges | 4 — widest production deployment of the candidates | 4 | MIT | **CHOSEN — orchestrator** |
| **smolagents** | 2 — `agent.memory` is in-process; no durable checkpoint | 4 — code execution is expressive; sandbox required | 3 — OTel instrumentation available | **5** — code actions, ~30% fewer steps than JSON tool-calling per HF's own claim | 3 — managed-agent hierarchies, simple | 4 — small, stable, Apache-2.0 | 3 (needs Docker sandbox; `LocalPythonExecutor` is explicitly best-effort only) | Apache-2.0 | **CHOSEN — leaf workers, under LangGraph** |
| **AG2 (v1.0)** | 3 — `KnowledgeStore` (Memory/Disk) persists facts, not execution state | 4 — typed channels, Hub audit trail | 3 | 3 | **5** — richest coordination model (conversation/consulting/discussion/workflow channels) | 2 — v1.0 is an explicit breaking redesign, "not a drop-in upgrade from Classic"; classic moved to a separate repo | 4 | Apache-2.0 | Rejected v1 — coordination richness we don't need, churn we can't absorb |
| **CrewAI** | 2 — Flows manage state; checkpointing is mentioned but under-specified; no documented durable resume or determinism story | 3 | 2 — real tracing lives in the commercial AMP tier | 3 | 4 — role-based crews are ergonomic | 3 | 4 | MIT (core) | Rejected — observability behind a paid tier violates the free-only constraint; no documented durable resume |
| **Hermes Agent** | 3 — session store + FTS5 history | 3 | 2 | 2 | 2 | 3 | **1** — chat-gateway agent (Telegram/Discord/Slack/WhatsApp/email) with broad execution backends; **writes and self-improves its own skills at runtime** | MIT | **Rejected on principle** — a self-modifying agent reachable from a messaging app is a remote-code-execution path into the trading host, and runtime self-modification is a direct violation of D3 (pinned versions) and the human-promote-only rule |
| **OpenClaw** | 3 — persistent memory across sessions | 3 | 2 | 2 | 2 | 3 | **1** — personal assistant running on your machine with full system access by default, driven from 30+ chat channels | MIT | **Rejected on principle** — same reason; it is an assistant, not an embeddable research library |

**Why not "the best multi-agent framework"**: coordination richness is not the
binding constraint. The binding constraints are (a) surviving a crash mid-research
without corrupting state, (b) knowing exactly what every token was spent on, and
(c) never letting a research process touch capital. LangGraph wins (a) and,
with Langfuse, (b); the isolation boundary in §8.1 handles (c) regardless of
framework. smolagents is bolted on purely for (d) token efficiency, and is
sandboxed because code-writing agents are a security surface.

**Rejected on principle, restated in one line:** Hermes Agent and OpenClaw are
autonomous assistants with host access and inbound chat control. Neither belongs
on a machine that can move money.

**Container spec (locked — "runs in Docker" is not a spec):** smolagents
`CodeAgent` runs with `executor_type="docker"` only: non-root user, read-only
rootfs, dropped capabilities, explicit CPU/RAM limits, and network egress limited
to the Phase-0 allow-listed endpoints (source APIs + the model provider, nothing
else). Import allowlist (LOCKED 2026-09-18, exact — nothing else imports): stdlib
`json, re, datetime, urllib, xml, html, math, statistics, collections,
itertools, hashlib, base64` + `requests` + `bs4` (BeautifulSoup) + `lxml`
(parser only) + `pydantic` + `pandas` (frames parsing, no eval) + `feedparser`
(RSS). No `subprocess`, no `os.system`, no `socket` raw, no `pickle`, no
`yaml.load` (safe_load only if yaml ever added — it is not on the list).

OS isolation design (LOCKED 2026-09-18, enforced at build, proven by the §8.6
isolation test): three users, no shared groups. `mirotrade` runs the C++ core
and owns journal/HALT/STAGE/broker keys (mode 600, group `mirotrade`).
`miroresearch` runs the plane + sidecars and owns `features.jsonl` +
`signals.jsonl` only; no read on `mirotrade` home, no sudo, no docker group
(the container runtime is driven by the supervisor, not by the agent user).
`mirojev` runs the JEV sidecar only: read-only snapshot in, Ed25519-signed
answers out (doc 03 §3.5); no research tools, no network except the provider.
`mirohuman` (you) writes `PROMOTION_MANIFEST` files; the process never runs as
you. Credentials live in `mirotrade` home or the sidecar env owned by
`miroresearch` — never in git, never world-readable, inventoried in the
Phase-1 credential-placement note. (No X session exists anywhere in v1: X is
out of the production path, doc 02.)
`LocalPythonExecutor` is **forbidden** on any host or container that can reach
trading credentials, the journal, `HALT`, or `STAGE` — upstream documents it as
best-effort sandboxing with known escapes, which is not sandboxing.

## 8.3 Agent topology (locked)

`research_graph_version: g1` (matches `plan/system-manifest.yaml`).
One LangGraph graph, run as a supervised loop. Six nodes, all off the hot path.

| Node | Job | Output | Default on failure |
|---|---|---|---|
| `harvest` | Pull the doc-09 sources on their cadences (EDGAR, FRED/ALFRED, official macro feeds, calendars; NO X in v1). Pure I/O, no LLM. | raw records + `observed_at_ns` | Source marked `stale`; never blocks |
| `extract` | smolagents `CodeAgent`: parse filings/calendars/OSINT into typed candidate features | candidate features | Drop + count |
| `fuse` | Deterministic Python (no LLM): join candidates to symbols, dedupe, bucket | joined features | Drop + count |
| `hypothesize` | LLM: write ≤500-char thesis per watchlist symbol into the research digest (never into JEV state) | digest entry | Empty thesis — never a crash |
| `critique` | LLM: adversarial pass. Names the strongest disconfirming evidence and a regime-change check | `critique_text`, `disagreement` flag | `disagreement=true` (the safe value) |
| `emit` | Schema-validate, bound, write `features.jsonl` atomically | `features.jsonl` | Nothing written; last file ages out via TTL |

- The graph is **checkpointed after every node**. A crash resumes at the last
  completed node, not at the start of the cycle. This is the whole reason
  LangGraph was chosen.
- Checkpoints alone are not recovery. Durability = checkpoint + an **external
  process supervisor** (systemd unit or equivalent watchdog) that detects the
  crash and restarts the plane with the same thread_id. No supervisor, no
  durability claim — an unobserved crash is just a silent halt.
- Nodes with external side effects must be **idempotent** (idempotency keys on
  every write; re-executed nodes converge, never duplicate). Side-effecting
  nodes are enumerated in Phase 0; any new one needs its key design reviewed.
- Checkpoint retention is 30 days, mandatory, then pruned. Replay older than
  retention is unsupported and must fail loudly, not silently.
- `critique` disagreeing with `hypothesize` sets `state.disagreement=true`, which
  is an input to JEV and a hard input to R14: **conflicting agent conclusions
  never produce a larger position; they produce HOLD or nothing.**
- Agents never vote on entry. They produce evidence; JEV scores it; the table in
  doc 03 §3.2 sizes it; doc 05 vetoes it.

## 8.3a Cadence and cost-gating (locked — closes the gap between §8.3 and doc 10)

The topology in §8.3 says what each node does; this says how often it runs and
why that does not blow the spend caps in doc 10 §10.4.

- **Base cadence: 5 minutes**, matching the thesis-refresh cadence doc 04 §4.1
  already assumes. `harvest` / `extract` / `fuse` run every cycle for the whole
  watchlist — they are pure I/O plus deterministic code, not LLM calls, so
  running them often is nearly free.
- **`hypothesize` and `critique` are gated, not unconditional.** Per symbol,
  they re-run only when: (a) a new TRIGGER-eligible feature has landed for that
  symbol since the last thesis, or (b) the existing thesis is older than a
  30-minute staleness TTL, whichever comes first. A quiet symbol gets a thesis
  refresh roughly twice an hour; a symbol with active TRIGGER features gets one
  every time something changes, capped by R15 below.
- **Why this matters for cost:** the R15 ceiling (40 LLM calls/cycle/symbol) is
  a safety ceiling for a burst — e.g. an NFP print firing every macro symbol at
  once — not the steady-state rate. Steady state, worst case 5 watchlist
  symbols: 5 × 2 refreshes/hour × 2 calls (hypothesize + critique) = 20 LLM
  calls/hour minimum, rising with feature activity but bounded well below the
  R15 ceiling except during genuine bursts. This is the number doc 10 §10.4's
  spend caps were sized against, and it is why JEV (4 calls/cycle, cached 60 s)
  is cheap relative to research even before any throttling.
- **Tier-1 throttle (doc 10 §10.4) now has a concrete meaning:** "research
  cycle interval doubled" means the 30-minute staleness TTL becomes 60 minutes
  and the 5-minute harvest cadence becomes 10 minutes. It is a parameter change,
  not a vague slowdown.
- **"Consecutive aborted cycles" (R15) is counted per symbol, not pooled across
  the plane.** Three consecutive aborts *for one symbol* pause research for
  that symbol only — its features age out on their normal TTL and it trades on
  whatever was last valid, same as any other stale-source case (§9.3). The
  whole plane pauses only if a majority of watchlist symbols are aborting
  simultaneously, which is treated as a systemic failure (e.g. the sandbox or
  the LLM provider is down) rather than a per-symbol data problem.

## 8.3b Known residual risks (named so they can be watched, not solved by prose)

1. **Prompt injection via harvested content.** Filings, web pages, and posts are
   attacker-influenced text fed to `hypothesize`/`critique`. Mitigations, in
   order: schema validation drops anything that is not typed data (injection
   cannot become a number because numbers only come from enums/buckets/counts);
   the `critique` node is explicitly tasked to distrust single-source claims;
   prose never sizes (doc 03 §3.3); R15 bounds a compromised loop's spend. What
   is *not* claimed: that any of this stops a clever injection from biasing a
   thesis. Thesis bias that survives must still pass JEV bands, consensus, and
   R1–R9 — that defense in depth is the actual control.
2. **Correlated model failure.** One bad JEV regime read can hit every symbol at
   once (same model, same macro weather). Blast-radius controls: per-symbol
   slow keys (a shared thesis does not force shared answers), R2 exposure caps
   bound total loss, R13 sliced by regime catches the regime where it breaks,
   and the `veto` question is scored independently of `enter`. No averaging
   across symbols is ever used to dilute a veto.
3. **Feature schema evolution.** `schema_version` (`f1`, `f2`…) is bumped on any
   change; `ctx/` rejects unknown versions loudly. Journal rows keep the raw
   feature bytes so old rows stay readable; replay pins the schema version it
   was recorded with. A version bump forces the same fresh-paper-window rule as
   any limit change.
4. **Human sign-off fatigue.** G1's daily review is the highest-fatigue gate in
   the system and fatigue approves things. Control: the review is a fixed
   ≤15-minute checklist (drill states, R-trips, spend tier, calibration delta),
   not an open-ended read-through — checklist frozen in Phase 0. Skipped or
   rubber-stamped reviews are a promotion blocker, verified from the sign-off
   log, not trusted on assertion.

## 8.4 Runaway-loop limits (R15, hard)

Per research cycle, per symbol, enforced by the orchestrator and by the process
supervisor independently:

| Limit | Value | On breach |
|---|---|---|
| LLM calls per cycle | 40 | Cycle aborted, partial features kept, `research_abort` logged |
| Tool calls per cycle | 120 | Same |
| Wall clock per cycle | 8 min | Same |
| Tokens per cycle | 250k | Same |
| Consecutive aborted cycles | 3 same-symbol → symbol paused; majority-of-watchlist in-window → plane degraded | Alert; last complete bundle stands (never partials); entries needing fresh research HOLD |
| Recursion / graph depth | 25 | Hard stop (LangGraph `recursion_limit`) |

A cycle that aborts is not retried within the same interval. There is no
exponential-retry path that can spend money without bound — that is the failure
mode that kills unattended agent systems, and it is capped in three places.

## 8.5 Feature contract v2 (locked — the only thing that crosses the boundary)

`features.jsonl` carries typed feature records in complete bundles. One
`emit` writes one bundle: `research_epoch` + `bundle_id` + `watermarks` +
feature list + `BUNDLE_COMMIT`. Watermarks are replay-critical metadata, not
decoration: `{"entity_map_version", "entity_map_sha256", source watermarks,
last-observation timestamps}`. The reader hashes the actual map file and
requires an exact sha256 match — version strings alone are not pinning. C++ consumes the last *complete* bundle
only — a runaway-aborted cycle that never reaches `emit` publishes nothing,
so partial epochs can never mix (R15). Thesis/critique prose is NOT a feature:
it goes to `research_digest.jsonl` (human + critique-node reading, advisory
only, never into JEV state — doc 03 §3.4).

```json
{
  "schema_version": "f2",
  "research_epoch": 412, "bundle_id": "...", "commit": true,
  "feature_id": "edgar:0000320193:8-K:2026-09-18T20:14:02Z",
  "kind": "filing_event|macro_release|calendar_ahead|osint_event|sentiment_tail|regime_hint",
  "symbols": ["AAPL"],
  "observed_at_ns": 0, "ingested_at_ns": 0, "ttl_s": 3600,
  "value": {"type": "enum|bucket|bool|count", "v": "..."},
  "effect": "bullish|bearish|risk_up|risk_down|neutral|unknown",
  "evidence": "source|derived|inference",
  "confidence_bucket": "low|medium|high",
  "source_id": "edgar_submissions", "provenance_url": "https://...",
  "canonical_hash": "sha256 of the canonical SQLite content row",
  "canonical_hashes": ["..."]
}
```

Hard rules on this record:
- **Bundle vs feature ownership (explicit).** Bundle-level: `schema_version`,
  `research_epoch`, `bundle_id`, `commit`, `watermarks`, `history`, `features`.
  Feature-level: `feature_id`, `kind`, `symbols`, `observed_at_ns`,
  `ingested_at_ns`, `ttl_s`, `value`, `effect`, `evidence`,
  `confidence_bucket`, `source_id`, `provenance_url`, `canonical_hash`,
  `canonical_hashes`, `entity_ref`. The §8.5 example shows both levels
  together for readability; the reader validates each level separately and
  rejects cross-level smuggling.
- **Evidence levels, not vibes.** `source` = deterministic parser over a
  primary source (only these are TRIGGER-eligible). `derived` = deterministic
  transform of source facts. `inference` = model-produced: CONTEXT-only until
  the producing *rule* earns promotion by measured track record — never the
  individual claim. Schema-valid but fabricated is still fabricated; levels
  are what stop it reaching entries.
- **`effect` is assigned by a deterministic interpretation table per kind**
  (frozen with the schema), never invented per-record. C++ derives
  `disagreement` from opposite TRIGGER effects (doc 03 §3.4).
- **`confidence_bucket` is computed** (source reliability × timestamp quality ×
  parser confidence × corroboration), never self-reported by the model.
- **No free-form floats.** Values are enums, booleans, counts, or buckets.
- **No prose** in this file, at all. The reader enforces an explicit f2
  field allowlist (required + `feature_id`/`canonical_hashes`/`entity_ref`)
  and rejects unknown fields — a prose-key denylist alone cannot guarantee
  "no prose", so unknown keys fail closed. Prose lives in the digest.
- **Plausibility, not just shape.** Schema validation proves structure; these
  three semantic checks prove the record means what it claims (all P1.5
  ctx-reader enforced, rejection reasons logged):
  1. *Entity binding* — every `symbols[]` entry must resolve through the
     versioned map `collector/entity_map.json` (`map_version`, sha256-pinned
     in the bundle watermarks; EDGAR CIK↔ticker, macro release↔symbols).
     The reader replays the exact pinned version — never a newer map.
     Features may carry `entity_ref` (e.g. `{"cik": ...}`); when present,
     map contradiction (CIK resolves to a different ticker than claimed)
     rejects. Without a ref, P1.5 enforces resolvability; full upstream
     contradiction validation arrives with the research plane.
     Unmapped or contradictory binding → reject (TRIGGER) or cap at
     CONTEXT (derived).
  2. *Frozen-feed detection* — nominal covers are explicit, never derived
     from polling cadence (`plausibility_v1`):

     ```
     edgar_8k: 45 min | fed/ecb: 3 h | treasury/bls/fred: 18 h
     ```

     identical authoritative payload across `FROZEN_N = 3` consecutive polls
     marks the source `stale`, never fresh. The bundle carries dated poll
     history (`{"h", "ts"}` entries); the reader requires the N identical
     observations to span at least half the source's nominal cover.
     Undated history is rejected (`history-undated`).
  3. *Session-aware freshness* — timestamps in America/New_York (IANA).
     Equity features timed 16:00–09:30 ET are rejected UNLESS kind is in
     the overnight allowlist (`calendar_ahead` with phase pre/blackout,
     scheduled `macro_release`, forex any open `session`). Scheduled
     pre-market releases pass; unscheduled overnight equity events reject.
  A perfectly deterministic system deciding from wrong-but-valid data is the
  failure these rules exist to prevent.
- **Lineage.** Every feature carries `canonical_hash` chaining to the exact
  canonical row(s) (SQLite `content_hash`) it derives from. Single-source:
  `canonical_hash` IS that row's hash and `canonical_hashes` holds just it.
  Multi-source derived: `canonical_hashes` is the sorted list of all input
  hashes and `canonical_hash = hex(sha256("‖".join(sorted_hashes)))`.
  The combination rule is part of f2, not implementation choice.
  Research-plane features without resolvable lineage are rejected like
  schema failures.
- Max 64 features per snapshot, newest first. Overflow dropped, counted, logged.
- `ctx/` rejects any record failing schema, bounds, or R12 timestamp checks, and
  increments `features_rejected`. The rejection rate is computed per bundle;
  operational >5%/hour alerting is deferred to Phase 2.5 (the stub reader does
  not run continuously).
- Source health is `source_status` per source (healthy/stale/failed/
  not_scheduled/unavailable/na — doc 03 §3.4), not a single absent-list.
  `not_scheduled` (nothing expected) is never a negative signal.

## 8.6 What "done" means

- [ ] Graph runs 7 days unattended with SQLite checkpointing; kill -9 at a random
      node resumes correctly and produces no duplicate features.
- [ ] R15 limits proven by a forced runaway test (a tool stubbed to loop).
- [ ] Isolation proven: the research-plane user cannot write the journal, the
      `HALT` file, the stage file, or read broker credentials. Tested, not assumed.
- [ ] R12 proven: a feature with a future `observed_at_ns` is dropped by `ctx/`.
- [ ] Langfuse shows per-node token + dollar attribution for a full day.
- [ ] `features.jsonl` schema frozen and consumed by a stub `ctx/` reader.
- [ ] Cadence gating proven: a quiet symbol refreshes on the 30-min TTL, not
      every 5-min cycle; a symbol with a fresh TRIGGER feature refreshes
      immediately; measured steady-state LLM-call rate matches the §8.3a estimate
      within 2×.

## Locked decisions

- LangGraph orchestrates; smolagents does leaf extraction inside a Docker sandbox.
- Observability is self-hosted Langfuse + OpenTelemetry. No paid tier, ever, for
  core operation.
- Agents produce validated feature bundles (`features.jsonl`) plus the human-only
  digest (`research_digest.jsonl`). Only the former may cross into C++; the
  latter never enters the trading boundary. Nothing else.
- Agents cannot size, order, veto, resume, or promote. One-way boundary, enforced
  by OS permissions.
- Self-modifying / self-improving agent frameworks are banned from the trading
  host (D3, and the human-promote-only rule in doc 11).
- `LocalPythonExecutor` is forbidden wherever trading credentials, journal, `HALT`,
  or `STAGE` are reachable. Recovery requires checkpoint + external supervisor +
  idempotent nodes — checkpoints alone are not durability.
- Version pins (LOCKED 2026-09-18, human-accepted):
  `langgraph==1.1.6`, `smolagents==1.26.0`, self-hosted Langfuse (`langfuse==4.15.4`
  client). Rationale recorded (not hype): 1.1.6 is the tested pin, not a
  best-version claim — upgrades re-pin with measured regression results,
  never release announcements. Any upgrade is a D3 version bump
  with a fresh paper window, never a silent pip update.
- Research models are pinned per node at build (no provider is chosen until the
  key exists): `research_model_id`, provider, revision, temperature, reasoning
  mode, tool-schema hash, system-prompt hash, container image digest,
  dependency lock hash. An unpinned research call is a build failure (D3).
- Deterministic-first topology: harvest/parse/normalize/fuse are deterministic
  code; LLM nodes are hypothesize/critique only. The LLM never parses, joins,
  maps symbols, validates timestamps, or classifies — code does that.
- The §8.2 framework scores are selection judgment, not benchmarks. §8.6 proves
  the workload (crash recovery, duplicates, tokens, wall time, sandbox escape
  tests) with measurements.
- Sandbox build requirements (Phase 2.5 implements, listed so the image is not
  improvised): immutable digest + SBOM + vuln scan, seccomp + AppArmor,
  no Docker socket, no host mounts (read-only binds only), PID/fd/process
  limits, CPU/RAM/disk quotas, DNS/egress via a fetch proxy — generated code
gets tool functions (SEC/FRED/RSS fetchers, parser, validator), not general
  HTTP.
