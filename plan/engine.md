# Engine

The engine reads the world, builds a point-in-time map of how firms are
linked, detects events, reasons about where each event ripples, verifies
that reasoning, and writes typed features. It has no other output into the
trading tree. A separate offline research factory proposes and tests new
hypotheses. Neither can size, send, amend or cancel an order, and no model
output can relax a risk rule.

```
sources (data.md) -> harvest -> parse / extract -> resolve entities
                                                      |
                        +-----------------------------+----------------+
                        v                                              v
              link graph (below)                              event store (below)
                        |                                              |
                        +---------------------+------------------------+
                                              v
                 router -> hybrid retrieval -> brain -> verifier
                                              |
                                              v
                 emit: features.jsonl (typed, bounded) -> kernel context
```

## The one-way boundary

- The engine writes exactly one artifact class into the trading tree,
  `features.jsonl`, and nothing else: no broker keys, no journal, no `HALT`,
  no stage files, no `candidates.jsonl`. It runs as a separate OS user and
  filesystem permissions enforce this. The graph and event stores live in the
  engine's own home.
- Models never see account equity, position sizes or PnL, at most a masked
  view (an exposure bucket and an open-position count).
- Every feature carries `observed_at_ns` and `ingested_at_ns`. The kernel
  drops features observed after the snapshot or past their TTL, so lookahead
  is structurally impossible. Model-memory lookahead is controlled separately
  (`validation.md`, Contamination control).
- The strategy engine is the only reader that turns features into candidates,
  by the fixed rules in `strategies.md`.

## Link graph

A bitemporal store of firm-to-firm links. Every edge records when the world
asserted it (`valid_from`, `valid_to`) and when the engine learned it
(`known_at`). Queries are always "as of `t`"; rows are appended, never
overwritten.

Node: CIK, point-in-time ticker history, name and former names (EDGAR
submissions), industry (SIC and an ETF map).

Edge record:

```
edge_id | src_cik | dst_cik | source | type | weight |
valid_from | valid_to | known_at | evidence_ids | extractor | contamination_class
```

- `source`: `supply_chain`, `text_peer`, `news`, `ownership`, `learned`.
- `type`: customer, supplier, competitor, partner, licensor, text_peer,
  co_mention, common_owner, learned.
- `evidence_ids`: accession plus span offsets, news document ids, or the 13F
  accession.
- `extractor`: `deterministic` or `reader:<model pin>`.
- `contamination_class`: deterministic, extraction or judgment.

| Source | Built from | Cadence | Extractor |
|---|---|---|---|
| `supply_chain` | 10-K and 10-Q customer and supplier disclosures, 8-K material agreements | on acceptance | deterministic patterns first, reader tier for the rest |
| `text_peer` | 10-K Item 1 business descriptions | each 10-K | deterministic term vectors. An embedding model trained on later text can encode future knowledge, so an embedding variant is extraction class unless the model is chronologically consistent (for example ChronoBERT) |
| `news` | GDELT GKG organization lists | daily aggregate of 15-minute batches | deterministic name-to-CIK resolution |
| `ownership` | 13F holdings | quarterly | deterministic |
| `learned` | return lead-lag (`math.md`) | monthly | deterministic; research only until validated |

Weights and normalization are in `math.md`.

**Bounded growth.** Edges are stored as intervals: a new observation that
leaves an edge's weight bucket unchanged extends `valid_to` instead of
appending. News co-mentions are aggregated to trailing-window counts per firm
pair in a streaming pass with constant memory per 15-minute file; raw files
are deleted after aggregation and nothing older than 90 days is kept. Filing
documents are parsed with a 25 MB cap; larger documents are truncated to the
parsed sections and counted. Every store reports its size daily and growth
past the registered monthly budget alerts. Long-running engine processes show
flat RSS over a 24-hour soak.

### Link extraction by the reader tier

- Deterministic patterns run first (for example "customer X accounted for N%
  of revenue"). The reader handles what patterns miss.
- **Anonymization:** before the reader sees a filing, the filer's name and
  ticker become "the Company". The reader extracts counterparties as written,
  with the exact source span. This limits answers drawn from the model's
  memory of the firm (Glasserman-Lin; Huang et al. 2026).
- **Span verification:** the resolver finds every span verbatim in the filing
  and resolves the counterparty name to a CIK through EDGAR names and former
  names. No span, no edge; unresolved names are dropped and counted.
- **Snippets, not whole filings:** the reader sees only windows located by
  deterministic keyword search (customer, supplier, distributor, "accounted
  for", "% of revenue", competitor), about 2k tokens each, so a 10-K costs a
  few thousand tokens instead of 60-100k.
- **Precision audit:** before any edge source enters a strategy, a
  hand-labeled sample of 200 filings must show precision of at least 0.9;
  recall and coverage are reported. Name-to-CIK resolution is audited the
  same way for the news source, where short or common names ("Delta",
  "Apple") are ambiguous: a name with more than one candidate is dropped
  unless a ticker or location disambiguates it.
- Reader edges are extraction-class contamination.

## Event pipeline

Every event is one dated record (`math.md`, Shocks) with its evidence.

| Event type | Source | Trigger |
|---|---|---|
| `filing_material` | 8-K items 1.01, 1.02, 1.03, 2.01, 2.05, 2.06, 4.02, 5.02 | acceptance |
| `earnings` | 8-K item 2.02 plus XBRL actuals | acceptance; SUE computed |
| `price_shock` | SIP daily bars | abs(z) at least 3 with volume at least 2× its 20-day median |
| `news_burst` | GDELT GKG | burst score at least 3 from at least 3 independent outlets |
| `disaster` | GDELT events naming the firm, cross-checked against USGS and FEMA records | publication |
| `social_burst` | quarantined social sources (`data.md`) | never alone; attached only as corroboration to another event |

- **Echo tagging:** an event explained by a linked firm's event within 2 days
  is an echo (`math.md`, Event intensity) and does not reach the brain.
- Duplicates (same firm, same type, overlapping evidence) merge into one unit.
- At most 20 events a day reach the brain, ranked by standardized magnitude;
  ties go to the source firm with fewer trailing news mentions (spillover is
  strongest where attention is low; ranking by graph degree would favor
  mega-caps, where linked-firm news is priced fastest). The rest are logged
  as `skipped=capacity` and still feed the deterministic twin.

## Ripple reasoning

The models in this path read and propose; they hold no tools. Deterministic
code does retrieval before each call, so every model here is a
capability-free reader.

1. **Router.** A small pinned model classifies the event into exactly one
   intent: `supply_chain`, `competitive`, `demand`, `credit_contagion`,
   `regulatory`, `capital_flow` or `noise`. Output is the enum only; anything
   else is `noise` and stops the chain. The intent selects which edge types
   and document sections retrieval may use.
2. **Hybrid retrieval.** Graph channel: the source firm's two-hop
   neighborhood as of the event's availability time, ranked by link weight.
   Text channel: the event's primary documents (8-K text, press-release
   exhibits) and the latest relevant filing sections of the neighbors, ranked
   by embedding similarity. News events enter as GDELT metadata
   (organizations, themes, tone, outlet count, source URLs); the engine does
   not fetch publisher article text, whose terms and paywalls do not permit
   automated use. The fused score is `S = β · S_graph + (1 − β) · S_text` with
   `β` a fixed per-intent table, not learned. Context is capped at 12k tokens.
3. **Brain.** A pinned model receives the event, the retrieved context (firm
   names anonymized as Firm A, B, ... by default) and the skill file for the
   intent. It writes at most 5 hypotheses:

   ```json
   {"target": "Firm C", "direction": "up|down", "horizon": "5|21|63",
    "mechanism": "supply_disruption|demand_shift|competitive_gain|
                  competitive_loss|credit_contagion|capital_flow|regulatory",
    "path": ["edge_id", "..."], "evidence": ["evidence_id", "..."]}
   ```

   The schema has no size, price or order field.
4. **Verifier.** Deterministic checks first: every edge in `path` exists as of
   `t`, every evidence id resolves and its span matches, the target is in the
   strategy universe, enums are valid. Then an independent pinned model from
   a different family answers two fixed questions per hypothesis: does the
   cited evidence state the link, and is the mechanism consistent with the
   event text? A hypothesis passes only with two yes answers. The verifier
   never adds or edits hypotheses.
5. **Emit.** Passing hypotheses become `ripple_hypothesis` features with
   de-anonymized target symbols, `evidence = inference` and a computed
   `confidence_bucket` (verifier agreement × evidence count × edge weight),
   never a model's self-report.

Every call logs the model pin, prompt hash, retrieved-context hash, output and
verifier output. Replay never re-calls a model. Hypotheses are scored on
resolution (`math.md`, Event propagation) whether or not a strategy trades
them.

### Model cost budget

Token arithmetic decides what the engine can afford under the model-spend caps
in `stages.md` ($150 per 30 days in the paper and tiny stages):

| Path | Volume | Tokens a month (approx.) |
|---|---|---|
| Router, brain and verifier | up to 20 events a day × about 24k tokens | about 10M |
| Reader, forward filings | about 2,500 filings a month × about 5 snippets × 2k | about 25M |
| Reader, extraction-class backfill 2016-2026 (one-off) | about 65k 10-Ks × about 10k | about 650M, once |

- At open-weights prices (well under $1 per million input tokens) the forward
  paths fit the cap with room; at frontier prices they do not. Each role
  defaults to the cheapest model that passes its bake-off.
- The backfill is a one-off experiment budget approved in the roadmap
  approvals log before it runs, priced from the spend governor's table; it
  never shares the monthly research cap.
- The governor's per-call reservation applies to every call. A day that hits
  the cap degrades to the deterministic twin, never to unverified
  hypotheses.

## Security, framework and isolation

**Stack:** LangGraph orchestrates (durable checkpoints, resume after a crash,
`interrupt()` for human gates); smolagents `CodeAgent` is confined to the
research factory; SQLite checkpoints during paper trading, Postgres from the
scaled stage; OpenTelemetry to self-hosted Langfuse for per-run token and
cost attribution; Pydantic validation at every boundary. AG2 and CrewAI were
rejected. Self-modifying assistants reachable from chat apps (Hermes Agent,
OpenClaw) are banned from any host that can reach capital.

| Tier | Touches untrusted documents? | Capabilities | Output |
|---|---|---|---|
| **Reader** (extractor, router, brain, verifier model) | yes (filings, news, social text) | model call only: no tools, no code execution, no network, no file write | length-capped, schema-validated JSON (enums, bounded strings, spans). Any instruction inside a document is data |
| **Resolver and verifier code** | no | deterministic Python: re-derives every claimed fact from the canonical record by span; rejects anything unverifiable | verified records with provenance |
| **Orchestrator** | no | graph control, deterministic retrieval, read-only trusted local stores | node routing, budgets |
| **Emitter** (the only writer) | no | writes `features.jsonl` through the emit path | complete bundles |

Handoffs are typed, schema-validated records with allowlisted targets, never
parsed out of model text downstream of a reader. Schema validation runs on
every reader output before anything else sees it.

**Container spec** (research factory and sandboxed harvest workers): Docker
only, non-root, read-only root filesystem, dropped capabilities, CPU and RAM
limits, network egress limited to allow-listed endpoints through the egress
proxy. The prompt is never the network boundary; an unauthorized-destination
probe proves it. Import allowlist, exact: stdlib `json, re, datetime, urllib,
xml, html, math, statistics, collections, itertools, hashlib, base64` plus
`requests`, `bs4`, `lxml` (parser only), `pydantic`, `pandas` (no eval) and
`feedparser`. No `subprocess`, no `os.system`, no raw `socket`, no `pickle`,
no `yaml.load`.

**OS identities, no shared groups.**

| User | Runs | Owns |
|---|---|---|
| `mirotrade` | the C++ kernel and transport | journal, `HALT`, stage files, broker keys (mode 600) |
| `mirostrat` | the strategy engine | `candidates.jsonl` only |
| `miroresearch` | the engine | `features.jsonl`, `signals.jsonl`, the graph and event store; no read on other homes, no sudo, no docker group |
| `mirofactory` | the research factory | dataset copies only; no credentials except the research model key via the spend gate |
| `mirohuman` | manifest signing | no process runs as the operator |

`LocalPythonExecutor` is forbidden on any host that can reach trading
credentials, the journal, `HALT` or the stage files.

**Residual risks, named so they can be watched.**

1. Prompt injection through harvested text: readers have no capabilities,
   outputs are schema-capped and span-verified, and an injection can at most
   bias a hypothesis, which the verifier and the paired test then face.
2. Correlated model failure: one misreading hits many targets. Controls:
   per-target evidence, position limits, the 20-event daily cap and the
   deterministic twin as a standing comparison.
3. Temporal contamination: pinned cutoffs, anonymization, post-cutoff
   evaluation for judgment class.
4. Entity-resolution errors: unresolved names are dropped, never guessed, and
   the precision audit gates each edge source.
5. Sign-off fatigue: reviews are fixed checklists of at most 15 minutes.

## Runaway-loop limits

Per cycle, enforced by the orchestrator and by the process supervisor
independently:

| Limit | Value | On breach |
|---|---|---|
| Model calls per cycle | 40 | cycle aborted and `research_abort` logged; no partial bundle is ever published and the last complete bundle stands |
| Tool calls per cycle | 120 | same |
| Wall clock per cycle | 8 min | same |
| Tokens per cycle | 250k | same |
| Consecutive aborted cycles | 3 on one symbol pauses the symbol; a majority of the watchlist in a window degrades the plane | alert; last complete bundle stands; entries needing fresh features HOLD |
| Recursion depth | 25 | hard stop (LangGraph `recursion_limit`) |

An aborted cycle is not retried within the same interval. Reader calls are
counted per document and per event and capped per day by the spend governor
(`stages.md`). The durability, digest and trust rules for the budget ledger
are in `appendix/spend-ledger-integrity.md` and are binding.

## Feature contract

`features.jsonl` is the only thing that crosses into the kernel. It carries
typed feature records in complete bundles. One emit writes one bundle:
`research_epoch`, `bundle_id`, `watermarks`, the feature list and a commit
marker, staged as a temp file with fsync, then an atomic rename and a manifest
row (bundle id, epoch, feature count, entity-map hash, commit). The writer is
`research/engine/emit.py` and the reader is `collector/ctx_read.py`, which
checks the commit flag and the envelope, lineage and kind rules. A crash
mid-emit never exposes half a bundle. Watermarks are replay-critical: the
entity-map version and sha256, source watermarks and last-observation
timestamps; the reader hashes the actual map file and requires an exact
match. The kernel consumes the last complete bundle only. Prose is not a
feature; it goes to `research_digest.jsonl`, for human reading only.

Feature record:

```json
{
  "schema_version": "1",
  "research_epoch": 412, "bundle_id": "...", "commit": true,
  "feature_id": "edgar:0000320193:8-K:2026-09-18T20:14:02Z",
  "kind": "filing_event|macro_release|calendar_ahead|osint_event|sentiment_tail|regime_hint|link_signal|ripple_hypothesis",
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

Two kinds come from the graph strategies:

- `link_signal`: the per-symbol cross-sectional rank of the neutralized graph
  signal (`value.type = count`, `v` = rank, 1 = most positive, with the
  universe size in the bundle watermarks), `evidence = derived`, lineage = the
  link-matrix snapshot hash and the price rows it was computed from. An
  integer rank lets the strategy and the kernel pick the most extreme names
  without a float crossing the boundary.
- `ripple_hypothesis`: `value = {"direction": "up|down", "horizon": "5|21|63",
  "mechanism": <enum>, "source_event": <event_id>}`, `evidence = inference`,
  `canonical_hashes` = the verified evidence rows.
- Lifetimes: `link_signal` carries `ttl_s` = 432000 (5 days) and
  `ripple_hypothesis` 345600 (4 days), so a Friday or pre-holiday emission is
  still fresh at the next session. A feature that expires before its strategy
  acts means no trade (absent, never neutral), and the expiry is counted.

Rules on every record:

- **Bundle versus feature fields.** Bundle-level: `schema_version`,
  `research_epoch`, `bundle_id`, `commit`, `watermarks`, `history`,
  `features`. Feature-level: `feature_id`, `kind`, `symbols`, `observed_at_ns`,
  `ingested_at_ns`, `ttl_s`, `value`, `effect`, `evidence`,
  `confidence_bucket`, `source_id`, `provenance_url`, `canonical_hash`,
  `canonical_hashes`, `entity_ref`. The reader validates each level
  separately and rejects fields moved between levels.
- **Model outputs are advisory, never evidence.** A deterministic resolver
  recomputes `evidence`, `effect`, `observed_at_ns`, entity binding and
  `canonical_hash` from the canonical source record before anything is
  emitted. No model output can declare `evidence = source`.
- **Evidence levels.** `source`: a deterministic parser over a primary source.
  `derived`: a deterministic transform of source facts. `inference`:
  model-produced, CONTEXT-only until the producing rule (never the individual
  claim) earns promotion by a measured track record. `ripple_hypothesis` is
  read only by a strategy that pre-registered it (Event Ripple), in shadow
  until that strategy passes its gates.
- **`effect` comes from a deterministic interpretation table per kind**, never
  invented per record. The kernel derives a conflict flag from opposite
  trigger effects on one symbol.
- **`confidence_bucket` is computed**, never self-reported by a model.
- **No free-form floats and no prose.** The reader enforces an explicit field
  allowlist and rejects unknown fields.
- **Plausibility** (enforced by the reader, rejection reasons logged):
  1. *Entity binding:* every `symbols[]` entry resolves through the versioned
     map `collector/entity_map.json`, pinned by sha256 in the bundle
     watermarks. A map contradiction rejects.
  2. *Frozen-feed detection:* a source whose authoritative payload is
     identical across 3 consecutive polls is marked `stale`. The 3
     observations must span at least half the source's nominal cover, and
     undated history is rejected. Nominal covers: `edgar_8k` 45 min,
     `fed` and `ecb` 3 h, `treasury`, `bls` and `fred` 18 h.
  3. *Session-aware freshness:* timestamps are in America/New_York. Equity
     features timed 16:00-09:30 ET are rejected unless the kind is on the
     overnight allowlist: `calendar_ahead` (pre or blackout phase), scheduled
     `macro_release`, `ripple_hypothesis` and `link_signal`, which are
     consumed only at the next session.
- **Lineage.** Single source: `canonical_hash` is that row's hash. Several
  sources: `canonical_hashes` is the sorted list of input hashes and
  `canonical_hash = hex(sha256("‖".join(sorted_hashes)))`. Features without
  resolvable lineage are rejected.
- At most 64 features per snapshot, newest first; overflow is dropped and
  counted.
- Source health is reported per source as `healthy`, `stale`, `failed`,
  `not_scheduled`, `unavailable` or `na`. `not_scheduled` is never a negative
  signal.

## Research factory

Agents propose hypotheses, write the code and backtest it before a human sees
it; outputs pass the same thresholds as human research.

1. **Intake:** hypothesis cards, at most 3 a week, from the weekly reflection,
   `lessons.jsonl`, ripple-resolution statistics or a human: claim,
   mechanism, citations, data needed, expected sign and magnitude, how it
   could be wrong.
2. **Pre-registration:** drafted from the template in `strategies.md`; a
   validator checks completeness; a human approves before data is touched.
3. **Implementation:** a sandboxed CodeAgent writes strategy code against the
   harness API only (no network, trusted local datasets, read-only mounts).
   The harness loads data, applies costs, splits windows and computes
   statistics, so generated code cannot leak the holdout or choose its own
   costs.
4. **Gate:** the harness runs the backtest gate and writes the report and
   ledger rows. A failed pre-registration is never rerun with new parameters.
5. **Triage:** humans see gate-passing reports plus the weekly failure count.

The factory runs as `mirofactory` on dataset copies, its model calls are
category `experiment`, it also allows `numpy`, generated code has no network,
and model-derived signals follow the contamination rules in `validation.md`.

## Model selection and pinning

- Roles: `reader` (extraction), `router`, `brain`, `verifier`, `factory`. Each
  pins `model_id`, provider, revision, knowledge cutoff, temperature,
  reasoning mode, skill-file hash, tool-schema hash, container digest and
  dependency lock hash. An unpinned call is a build failure.
- The verifier comes from a different model family than the brain.
- Prefer open-weights models pinned by exact weights hash for the brain and
  verifier. A hosted model that is retired or silently updated restarts the
  judgment-class clock, and the Event Ripple test needs about a year of
  uninterrupted forward data. Weights that can be self-hosted keep the clock
  running if a provider drops the model.
- Selection is a measured bake-off per role on a fixed post-cutoff set: the
  reader on span-verified field accuracy; the router on intent accuracy
  against hand labels; the brain on ripple resolution; the verifier on catch
  rate for seeded false hypotheses; plus cost per task and latency. Not by
  reputation or leaderboard rank.
- Chronologically consistent models (He-Lv-Manela-Wu 2025: ChronoBERT,
  ChronoGPT, trained only on text available at each date) may run the brain on
  pre-cutoff history as research evidence. Their results never promote.
- Skills are versioned method files per intent, hashed into the role pin and
  drift-checked in CI.

## Done when

- Graph as-of queries return the same edge set for the same `t` after later
  edges are added (bitemporal test).
- Each edge source passes its precision audit and the placebo test
  (`math.md`, Edge validation) before a strategy uses it.
- The event pipeline's dedupe, echo tagging and daily cap are proven on
  fixtures.
- Bounded growth is proven: interval compaction, streaming news aggregation
  and document size caps; a 24-hour soak with flat RSS for every long-running
  engine process; a daily store-size report.
- Router, brain and verifier are proven capability-free: a document carrying
  tool calls, code, URLs and instructions yields only schema-valid JSON or a
  rejection, and the verifier rejects any hypothesis whose evidence span does
  not match.
- The graph runs 7 days unattended with checkpointing; `kill -9` at a random
  node resumes with no duplicate features.
- The runaway limits are proven by a forced runaway test.
- Isolation is proven: the engine user cannot write the journal, `HALT`, the
  stage files or `candidates.jsonl`, and cannot read broker credentials.
- A feature with a future `observed_at_ns` is dropped by the kernel.
- Egress is proven at the network layer for sandboxed workers.
- Bundle atomicity is proven under `kill -9` mid-emit.
- Langfuse shows per-node token and dollar attribution for a full day.

## Decisions

- LangGraph orchestrates the engine; CodeAgent runs only in the research
  factory, sandboxed, with no network.
- Every model in the live path is a capability-free reader; retrieval is
  deterministic code.
- The graph is bitemporal and append-only; every edge carries evidence and its
  contamination class.
- Brain output is a typed hypothesis with no size, price or order field; an
  independent verifier and deterministic span checks gate every one.
- The engine writes `features.jsonl` and a human-only digest; only the former
  crosses into the kernel.
- Models cannot size, order, veto, resume or promote.
- Pinned versions: `langgraph==1.1.6`, `smolagents==1.26.0`, self-hosted
  Langfuse with the `langfuse==4.15.4` client. Upgrades re-pin with measured
  regression results and a fresh paper window.
- Deterministic first: harvest, parse, normalize, resolve, fuse, retrieve and
  verify are code; models read, classify, hypothesize and draft.
