# 08 - Agentic Research Plane (freeze v3)

Two planes, one boundary:

- **Live research plane** - reads the world on a schedule and writes
  typed, bounded features into the context the kernel freezes. It has
  no other output into the trading tree.
- **Research factory** (§8.7) - offline. Agents propose hypotheses,
  write pre-registrations, write and run backtest code on trusted local
  datasets, and draft reports for human triage. It never touches live
  state, credentials, or the trading tree.

Neither can size, send, amend, or cancel an order, and no agent output can
relax a risk rule.

## 8.1 The one-way boundary (locked, read this first)

```
   EDGAR + FRED/ALFRED + official releases + market data   (doc 09)
                  │
                  ▼
        ┌───────────────────────┐
        │  LIVE RESEARCH PLANE  │   LangGraph orchestrator; reader tier for
        │  (Python, sandboxed)  │   untrusted text; unprivileged user
        └──────────┬────────────┘
                   │  writes ONLY: features.jsonl (typed, schema-checked)
                   ▼
        ┌───────────────────────┐
        │  ctx/ (C++)           │   validates, bounds, stamps, freezes
        └──────────┬────────────┘
                   ▼
   Snapshot + candidate (sleeve engine) → risk/ → exec/
```

- **R11:** the research plane writes exactly one artifact class -
  `features.jsonl` - and nothing else in the trading tree: no broker keys,
  no journal, no `HALT`, no stage chain, no `candidates.jsonl`. Separate OS
  user, enforced by filesystem permissions.
- Agents never see account equity, position sizes, or PnL; at most a
  masked view (`exposure_bucket`, `positions_open_count`).
- Every feature carries `observed_at_ns` and `ingested_at_ns`; `ctx/` drops
  future-observed or TTL-expired features (R12). Model-memory lookahead is
  controlled separately (doc 11 §11.0c).

## 8.2 Framework choice (locked) + the v3 security pattern

**Stack:** LangGraph orchestrates (durable checkpoints, resume after
crash, `interrupt()` for human gates); smolagents `CodeAgent` is confined
to the research factory; SQLite checkpoints in paper, Postgres from G2;
OpenTelemetry to self-hosted Langfuse for per-run token/cost attribution;
Pydantic validation at every boundary.

**Ranking (selection judgment, not benchmarks):** LangGraph chosen
(orchestrator: durability 5, observability 4); smolagents chosen for
code-writing work under a Docker sandbox (token efficiency 5, durability
2); AG2 v1.0 rejected (breaking redesign churn); CrewAI rejected
(observability behind a paid tier, no documented durable resume); Hermes
Agent and OpenClaw rejected on principle: self-modifying assistants
reachable from chat apps are a remote-code-execution path into a capital
host and violate D3.

**Security pattern for untrusted text (adopted from the
`anthropics/financial-services` managed-agent cookbooks - earnings-reviewer,
kyc-screener, gl-reconciler):**

| Tier | Touches untrusted docs? | Capabilities | Output |
|---|---|---|---|
| **Reader** | Yes (filings, press releases) | model call only: no tools, no code execution, no network, no file write | length-capped, schema-validated JSON (enums, bounded strings, numbers with source spans); any instruction inside a document is data |
| **Resolver/Verifier** | No | deterministic Python: re-derives every claimed number from the canonical record text/XBRL by span; rejects anything unverifiable | `inference`-level candidates with verified provenance |
| **Orchestrator** | No | graph control, trusted local stores (read-only) | node routing, budgets |
| **Emitter** (only writer) | No | writes `features.jsonl` via the frozen emit path | complete bundles |

Handoffs between agents are typed tool calls or schema-validated records
with allowlisted targets, never parsed out of model text that sits
downstream of a reader (the financial-services orchestrator documents that
injection path). Harness-side schema validation runs on every reader
output before anything else sees it.

The reader replaces a model-written-Python `extract` agent: code with
network egress running over attacker-influenceable filings is a larger
surface than the job needs. The deterministic parser is the authority and
the LLM output is advisory, so the reader reads and does not act.

**Container spec (locked; applies to the research factory and to any
sandboxed harvest worker):** smolagents `CodeAgent` runs with
`executor_type="docker"` only: non-root user, read-only rootfs, dropped
capabilities, explicit CPU/RAM limits, and network egress limited to the
Phase-0 allow-listed endpoints (source APIs + the model provider, nothing
else). The prompt is never the network boundary: enforcement lives in the
sandbox firewall/proxy (container netns + egress proxy with an exact
destination allowlist), and §8.6 proves it with an unauthorized-destination
probe (a worker attempting a non-allowlisted host must fail at the network
layer, counted). Import allowlist (locked, exact - nothing else imports): stdlib
`json, re, datetime, urllib, xml, html, math, statistics, collections,
itertools, hashlib, base64` + `requests` + `bs4` (BeautifulSoup) + `lxml`
(parser only) + `pydantic` + `pandas` (frames parsing, no eval) + `feedparser`
(RSS). No `subprocess`, no `os.system`, no `socket` raw, no `pickle`, no
`yaml.load` (safe_load only if yaml ever added - it is not on the list).

OS isolation design (locked), no shared groups:
`mirotrade` runs the C++ kernel and transport and owns journal/`HALT`/stage
chain/broker keys (mode 600). `mirostrat` runs the deterministic
sleeve engine and owns `candidates.jsonl` only; no credentials, no
network except the market-data read path. `miroresearch` runs the live
plane and owns `features.jsonl` + `signals.jsonl` only; no read on other
homes, no sudo, no docker group (the supervisor drives containers).
`mirojev` runs the optional JEV sidecar: read-only snapshot in,
Ed25519-signed artifact out, owns the JEV credential + signing key.
`mirofactory` runs the research factory on a copy of research
datasets; no credentials of any kind except the research model key via
the spend-governed gate, no path into `/srv/mirohedge` trading dirs.
`mirohuman` (you) signs manifests; no process runs as you. Credentials
live in the owning identity's home, never in git, never world-readable.
`LocalPythonExecutor` is forbidden on any host or container that can
reach trading credentials, the journal, `HALT`, or the stage chain.

## 8.3 Agent topology - live plane (`research_graph_version: g1` → g2)

`research_graph_version: g1` is the running graph (matches
`plan/system-manifest.yaml`). The reader-tier `extract` and verifier
`critique` semantics below are g2; the manifest bumps to g2 in the same
commit that lands them (doc 07 P1).

| Node | Job | Output | Default on failure |
|---|---|---|---|
| `harvest` | Pull doc-09 sources on their cadences. Pure I/O, no LLM. | raw records + `observed_at_ns` | Source `stale`; never blocks |
| `extract` (g2: reader tier) | Deterministic parser first (authoritative); for kinds with a registered reader skill (e.g. 8-K EX-99.1 guidance, doc 02 E2), the reader tier produces capped JSON, then the resolver verifies every field by source span | verified `inference` candidates + parser `source` candidates | Drop + count |
| `fuse` | Deterministic: join to symbols, dedupe, bucket | joined features | Drop + count |
| `hypothesize` | LLM: falsifiable thesis per watchlist symbol into the digest (never into kernel state): claim, 3–5 pillars, explicit invalidation triggers, catalyst dates (thesis-tracker structure) | digest entry | Empty thesis - never a crash |
| `critique` (g2: verifier) | Re-verifies each pillar's factual claims against canonical records (gl-reconciler critic pattern); names the strongest disconfirming evidence; flags pillars whose facts do not verify | `critique_text`, `critique_disagreement` advisory flag | `critique_disagreement=true` |
| `emit` | Schema-validate, bound, write `features.jsonl` atomically | `features.jsonl` | Nothing written; last file ages out via TTL |

- Checkpointed after every node; a crash resumes at the last completed
  node. Durability = checkpoint + external supervisor + idempotent nodes.
- Checkpoint retention 30 days; older replay fails loudly.
- `critique_disagreement` is advisory research metadata. It is NEVER
  `state.disagreement`: only the deterministic R14 computation may set
  that field.
- Agents never vote on entry. Sleeves (doc 02) originate candidates;
  features only inform sleeves that pre-registered them.

## 8.3a Cadence and cost-gating (locked)

Base cadence 5 minutes for harvest/extract/fuse (I/O + deterministic
code). `hypothesize`/`critique` re-run per symbol only on a new
TRIGGER-eligible feature or a 30-minute staleness TTL. Tier-1 throttle
doubles both (TTL 60 min, harvest 10 min). R15 counters are per symbol;
the plane pauses only on majority-of-watchlist aborts. Reader-tier calls
are counted per filing, not per cycle, and are capped per day by the
spend governor's research category (doc 10 §10.4).

## 8.3b Known residual risks (named so they can be watched)

1. **Prompt injection via harvested content.** Mitigations in order: the
   reader tier has no capabilities to abuse; outputs are schema-capped;
   every number is span-verified deterministically; numbers only become
   features through enums/buckets/counts; prose never sizes; R15 bounds
   spend. Residual: an injection can still bias a thesis.
2. **Correlated model failure.** One model misreading a regime hits every
   symbol. Controls: per-symbol evidence, R2 caps, per-regime calibration
   slices, and `latent_risk` scored independently of `enter` (sleeves
   with `filter = jev` only). No cross-symbol averaging dilutes a HOLD.
3. **Temporal contamination of LLM outputs.** A model that has seen the
   future in training can "predict" it. Controls: pinned knowledge
   cutoff per model, post-cutoff-only evaluation, forward shadow as the
   primary evidence (doc 11 §11.0c).
4. **Feature schema evolution.** `schema_version` bumps on any change;
   `ctx/` rejects unknown versions loudly; replay pins recorded versions.
5. **Human sign-off fatigue.** Fixed ≤ 15-minute checklist reviews;
   rubber-stamped reviews are a promotion blocker.

## 8.4 Runaway-loop limits (R15, hard)

Per research cycle, per symbol, enforced by the orchestrator and by the
process supervisor independently:

| Limit | Value | On breach |
|---|---|---|
| LLM calls per cycle | 40 | Cycle aborted, `research_abort` logged; NO partial bundle is ever published - the last complete bundle stands (§8.5). |
| Tool calls per cycle | 120 | Same |
| Wall clock per cycle | 8 min | Same |
| Tokens per cycle | 250k | Same |
| Consecutive aborted cycles | 3 same-symbol → symbol paused; majority-of-watchlist in-window → plane degraded | Alert; last complete bundle stands; entries needing fresh research HOLD |
| Recursion / graph depth | 25 | Hard stop (LangGraph `recursion_limit`) |

A cycle that aborts is not retried within the same interval. The budget
ledger's durability, digest, migration, trust-model, and trusted-config
rules are in `appendix/08-ledger-integrity-and-trust-record.md` and are
binding (coherent multi-object forgery bottoms out at host integrity).

## 8.5 Feature contract v2 (locked - the only thing that crosses the boundary)

`features.jsonl` carries typed feature records in complete bundles. One
`emit` writes one bundle: `research_epoch` + `bundle_id` + `watermarks` +
feature list + `BUNDLE_COMMIT`, staged as temp + fsync + atomic rename with
a manifest row (bundle_id, research_epoch, feature count, map sha, commit).
The writer is `research/plane/emit.py`, which appends the manifest row and
resolves the latest complete generation. The P1.5 reader
(`collector/ctx_read.py`) does not consume the manifest; it enforces the
bundle-internal `commit is True` flag plus the strict envelope/lineage/kind
checks, and is not manifest-backed. Partial emit + crash + restart never
exposes half a bundle (R6). Watermarks are replay-critical metadata:
`{"entity_map_version", "entity_map_sha256", source watermarks,
last-observation timestamps}`. The reader hashes the actual map file and
requires an exact sha256 match; version strings alone are not pinning. C++
consumes the last complete bundle only - a runaway-aborted cycle that never
reaches `emit` publishes nothing, so partial epochs never mix (R15).
Thesis/critique prose is not a feature:
it goes to `research_digest.jsonl` (human + critique-node reading, advisory
only, never into JEV state - doc 03 §3.4).

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
  "source_id": "edgar_8k", "provenance_url": "https://...",
  "canonical_hash": "sha256 of the canonical SQLite content row",
  "canonical_hashes": ["..."]
}
```

Hard rules on this record:
- **Bundle vs feature ownership.** Bundle-level: `schema_version`,
  `research_epoch`, `bundle_id`, `commit`, `watermarks`, `history`, `features`.
  Feature-level: `feature_id`, `kind`, `symbols`, `observed_at_ns`,
  `ingested_at_ns`, `ttl_s`, `value`, `effect`, `evidence`,
  `confidence_bucket`, `source_id`, `provenance_url`, `canonical_hash`,
  `canonical_hashes`, `entity_ref`. The example above shows both levels
  together; the reader validates each level separately and
  rejects cross-level smuggling.
- **LLM outputs are advisory candidates, never evidence.** `extract`
  / `hypothesize` / `critique` may propose `source`-shaped records, but a
  deterministic resolver recomputes `evidence`, `effect`, `observed_at_ns`,
  entity binding, and `canonical_hash` from the canonical source record
  before anything is emitted: facts actually present become deterministic
  `source` features, everything else stays `inference`/CONTEXT. No LLM
  output can directly declare `evidence=source` (R1).
- **Evidence levels.** `source` = deterministic parser over a
  primary source (only these are TRIGGER-eligible). `derived` = deterministic
  transform of source facts. `inference` = model-produced: CONTEXT-only until
  the producing *rule* earns promotion by measured track record - never the
  individual claim. Levels, not schema validity, keep fabricated
  records from reaching entries.
- **`effect` is assigned by a deterministic interpretation table per kind**
  (frozen with the schema), never invented per-record. C++ derives
  `disagreement` from opposite TRIGGER effects (doc 03 §3.4).
- **`confidence_bucket` is computed** (source reliability × timestamp quality ×
  parser confidence × corroboration), never self-reported by the model.
- **No free-form floats.** Values are enums, booleans, counts, or buckets.
- **No prose** in this file. The reader enforces an explicit f2
  field allowlist (required + `feature_id`/`canonical_hashes`/`entity_ref`)
  and rejects unknown fields: a prose-key denylist alone cannot guarantee
  no prose, so unknown keys fail closed. Prose lives in the digest.
- **Plausibility.** Schema validation proves structure; these three
  semantic checks prove the record means what it claims (all P1.5
  ctx-reader enforced, rejection reasons logged):
  1. *Entity binding* - every `symbols[]` entry must resolve through the
     versioned map `collector/entity_map.json` (`map_version`, sha256-pinned
     in the bundle watermarks; EDGAR CIK↔ticker, macro release↔symbols).
     The reader replays the exact pinned version - never a newer map.
     Features may carry `entity_ref` (e.g. `{"cik": ...}`); when present,
     map contradiction (CIK resolves to a different ticker than claimed)
     rejects. Without a ref, the reader enforces resolvability only.
     Unmapped or contradictory binding → reject (TRIGGER) or cap at
     CONTEXT (derived).
  2. *Frozen-feed detection* - nominal covers are explicit, not derived
     from polling cadence (`plausibility_v1`):

     ```
     edgar_8k: 45 min | fed/ecb: 3 h | treasury/bls/fred: 18 h
     ```

     identical authoritative payload across `FROZEN_N = 3` consecutive polls
     marks the source `stale`, never fresh. The bundle carries dated poll
     history (`{"h", "ts"}` entries); the reader requires the N identical
     observations to span at least half the source's nominal cover.
     Undated history is rejected (`history-undated`).
  3. *Session-aware freshness* - timestamps in America/New_York (IANA).
     Equity features timed 16:00–09:30 ET are rejected UNLESS kind is in
     the overnight allowlist (`calendar_ahead` with phase pre/blackout,
     scheduled `macro_release`, forex any open `session`). Scheduled
     pre-market releases pass; unscheduled overnight equity events reject.
- **Lineage.** Every feature carries `canonical_hash` chaining to the exact
  canonical row(s) (SQLite `content_hash`) it derives from. Single-source:
  `canonical_hash` IS that row's hash and `canonical_hashes` holds just it.
  Multi-source derived: `canonical_hashes` is the sorted list of all input
  hashes and `canonical_hash = hex(sha256("‖".join(sorted_hashes)))`.
  The combination rule is part of f2.
  Research-plane features without resolvable lineage are rejected like
  schema failures.
- Max 64 features per snapshot, newest first. Overflow dropped, counted, logged.
- `ctx/` rejects any record failing schema, bounds, or R12 timestamp checks, and
  increments `features_rejected`. The rejection rate is computed per bundle;
  operational >5%/hour alerting is deferred to Phase 2.5 (the reader does
  not run continuously).
- Source health is `source_status` per source (healthy/stale/failed/
  not_scheduled/unavailable/na - doc 03 §3.4), not a single absent-list.
  `not_scheduled` (nothing expected) is never a negative signal.

## 8.6 What "done" means (live plane)

- [ ] Graph runs 7 days unattended with SQLite checkpointing; kill -9 at a
      random node resumes correctly with no duplicate features.
- [ ] R15 limits proven by a forced runaway test.
- [ ] Isolation proven: the research user cannot write the journal,
      `HALT`, the stage chain, or `candidates.jsonl`, and cannot read
      broker credentials. Tested, not assumed.
- [ ] R12 proven: a future-`observed_at_ns` feature is dropped by `ctx/`.
- [ ] Egress proven at the network layer for sandboxed workers.
- [ ] Bundle atomicity proven under kill -9 mid-`emit`.
- [ ] Langfuse shows per-node token + dollar attribution for a full day.
- [ ] Reader tier proven capability-free: a document containing tool
      calls, code, URLs, and instructions produces only schema-valid JSON
      or a rejection - never an action; the verifier rejects any number
      without a matching source span.
- [ ] Cadence gating proven against the §8.3a estimate within 2×.

## 8.7 Research factory (v3)

The factory is where AI is used in this fund: agents propose signals,
write the code, and backtest before a human sees them; outputs pass the
same thresholds as human research.

Loop (every step logged to the trial ledger, doc 11 §11.0a):
1. **Intake** - hypothesis cards from the weekly reflection (≤ 3 per
   week, doc 11 §11.4), from `lessons.jsonl` (doc 09 Tier D), or from a
   human. Each card: claim, mechanism, citations, data needed, expected
   sign and magnitude range, how it could be wrong.
2. **Pre-registration** - the agent drafts a pre-registration from the
   doc 02 template; a deterministic validator checks completeness (spec,
   variants, windows, holdout, cost model, kill criteria); a human
   approves before any data is touched.
3. **Implementation** - a sandboxed CodeAgent writes the sleeve code
   against the harness API only (no network, trusted local datasets,
   read-only mounts, import allowlist below). The harness - not the agent -
   loads data, applies costs, splits windows, and computes statistics, so
   generated code cannot leak the holdout or choose its own costs.
4. **Gate** - the harness runs the A-gate (doc 11 §11.3a) and writes the
   report + trial-ledger rows. The agent cannot rerun a failed
   pre-registration with different parameters; that is a new card.
5. **Triage** - humans see only gate-passing reports plus a weekly count
   of failures (the failure count is part of the evidence).

Factory rules:
- Runs as `mirofactory`, on dataset copies, with no credentials except the
  research-model key behind the spend gate (category `experiment`).
- Import allowlist (locked, exact): stdlib `json, re, datetime,
  urllib, xml, html, math, statistics, collections, itertools, hashlib,
  base64` + `requests` + `bs4` + `lxml` (parser only) + `pydantic` +
  `pandas` (no eval) + `feedparser`; the factory also allows `numpy`.
  No `subprocess`, no `os.system`, no raw `socket`, no `pickle`, no
  `yaml.load`. Factory code has no network at all (the fetch tools live in
  the harness, not in generated code).
- LLM-derived signals are evaluated only on post-cutoff data (doc 11).
- The factory cannot write anywhere near the trading tree; promotion of
  a factory sleeve is the doc 11 path like any other.

## 8.8 Model selection and pinning (v3)

- Roles and pins: `reader` (extraction), `thesis` (hypothesize),
  `verifier` (critique), `factory` (code/pre-registration drafting), and
  optional `jev`. Each role pins `model_id`, provider, revision,
  knowledge cutoff date, temperature, reasoning mode, skill-file hash,
  tool-schema hash, container image digest, dependency lock hash (D3).
  An unpinned call is a build failure.
- Selection is a measured bake-off per role on a fixed, post-cutoff
  evaluation set: accuracy (reader: span-verified field accuracy; verifier:
  catch rate on seeded false claims), cost per task under the governor's
  pricing table, and latency. Candidates include the currently authorized
  research model and other provider-available models (e.g. Anthropic
  Claude Haiku/Sonnet-class for reader/verifier roles). Models are not chosen
  by reputation or leaderboard rank.
- **Skills as pinned method files:** each LLM role's method (e.g.
  earnings guidance extraction, falsifiable-thesis structure, macro-rates
  context, catalyst calendar) is a versioned skill file adapted from the
  `financial-services` skill structure, hashed into the role pin, and
  drift-checked in CI. Paid-data steps in the source skills are replaced
  by free-data equivalents (FRED/Treasury/EDGAR) or removed.

## Locked decisions

- LangGraph orchestrates the live plane; smolagents CodeAgent runs only in
  the research factory, in a Docker sandbox with no network.
- Untrusted text is read only by a capability-free reader tier whose
  output is schema-capped and deterministically verified.
- Observability is self-hosted Langfuse + OpenTelemetry. No paid tier for
  core operation.
- Agents produce validated feature bundles (`features.jsonl`) plus the
  human-only digest (`research_digest.jsonl`). Only the former may cross
  into C++. The factory produces reports and pre-registrations only.
- Agents cannot size, order, veto, resume, or promote.
- Self-modifying / self-improving agent frameworks are banned from any
  capital host (D3, doc 11).
- Version pins (locked, human-accepted): `langgraph==1.1.6`,
  `smolagents==1.26.0`, self-hosted Langfuse (`langfuse==4.15.4` client).
  Upgrades re-pin with measured regression results, never release
  announcements; any upgrade is a D3 version bump with a fresh paper
  window.
- Research models are pinned per role with their knowledge cutoff (§8.8).
- Deterministic-first: harvest/parse/normalize/fuse/verify are code; LLMs
  read, hypothesize, draft, and write factory code - never parse
  authoritatively, join, map symbols, validate timestamps, or classify.
