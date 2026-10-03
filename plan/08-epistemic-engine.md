# 08 - Epistemic Engine (`research_graph_version: g1` → g3)

The engine reads the world, builds a point-in-time map of how firms are
linked, detects events, reasons about where each event ripples, verifies
that reasoning, and writes typed features. It has no other output into the
trading tree. A separate offline research factory (§8.9) proposes and tests
new hypotheses. Neither can size, send, amend, or cancel an order, and no
model output can relax a risk rule.

```
 sources (doc 09) ─→ harvest ─→ parse / extract ─→ resolve entities
                                                     │
                     ┌───────────────────────────────┴──────────────┐
                     ▼                                              ▼
           Market Link Graph (§8.2)                   Event store (§8.3)
                     │                                              │
                     └──────────────┬───────────────────────────────┘
                                    ▼
          router → hybrid retrieval → brain → verifier   (§8.4)
                                    │
                                    ▼
             emit: features.jsonl (typed, bounded, f2/f3)  → ctx/ (C++)
```

## 8.1 The one-way boundary (locked, read this first)

- **R11:** the engine writes exactly one artifact class into the trading
  tree - `features.jsonl` - and nothing else: no broker keys, no journal,
  no `HALT`, no stage chain, no `candidates.jsonl`. Separate OS user,
  enforced by filesystem permissions. The graph and event stores live in
  the engine's own home.
- Models never see account equity, position sizes, or PnL; at most a
  masked view (`exposure_bucket`, `positions_open_count`).
- Every feature carries `observed_at_ns` and `ingested_at_ns`; `ctx/` drops
  future-observed or TTL-expired features (R12). Model-memory lookahead is
  controlled separately (doc 11 §11.0c).
- The sleeve engine (`mirostrat`) is the only reader that turns features
  into candidates, by the frozen rules of doc 02.

## 8.2 Market Link Graph (MLG)

A bitemporal store of firm-to-firm links: every edge records when the
world asserted it (`valid_from`, `valid_to`) and when the engine learned
it (`known_at`). Queries are always "as of `t`"; rows are appended, never
overwritten.

Node: CIK, ticker history (point in time), name and former names (EDGAR
submissions), industry (SIC and ETF map).

Edge record:

```
edge_id | src_cik | dst_cik | source (sc|tx|nw|ow|lr) |
type (customer|supplier|competitor|partner|licensor|text_peer|
      co_mention|common_owner|learned) |
weight | valid_from | valid_to | known_at |
evidence_ids (accession + span offsets | GDELT doc ids | 13F accession) |
extractor (det|reader:<pin>) | contamination_class (deterministic|extraction|judgment)
```

Edge sources (weights and normalization: doc 14 §14.3):

| Source | Built from | Cadence | Extractor |
|---|---|---|---|
| `sc` supply chain | 10-K/10-Q customer and supplier disclosures, 8-K material agreements | on acceptance | deterministic patterns first; reader tier for the rest (§8.2a) |
| `tx` text peers | 10-K Item 1 business descriptions | on each 10-K | deterministic term vectors (deterministic class); an embedding model trained on later text can encode future knowledge, so an embedding variant is extraction class unless it uses a chronologically consistent model (e.g. ChronoBERT) |
| `nw` news co-mention | GDELT GKG organization lists | daily aggregate of 15-min batches | deterministic name→CIK resolution |
| `ow` common ownership | 13F holdings | quarterly | deterministic |
| `lr` learned | return lead-lag (doc 14 §14.6) | monthly | deterministic; research only until validated |

Bounded growth (locked): edges are stored as intervals, not daily rows;
a new observation that leaves an edge's weight bucket unchanged extends
`valid_to` instead of appending. GDELT co-mentions are aggregated to
trailing-window counts per firm pair in a streaming pass (constant memory
per 15-minute file, raw files deleted after aggregation, never more than
90 days kept). Filing documents are parsed with a hard size cap (25 MB;
larger documents are truncated to the parsed sections and counted). Every
store reports its size daily; growth beyond the registered budget per
month alerts. Long-running engine processes show flat RSS over a 24 h
soak, like the kernel.

### 8.2a Link extraction by the reader tier

- Deterministic patterns run first (e.g. "customer X accounted for N% of
  revenue"). The reader tier handles what patterns miss.
- **Anonymization:** before the reader sees a filing, the filer's name and
  ticker are replaced by "the Company"; the reader extracts counterparties
  as written, with the exact source span. This limits answers drawn from
  the model's memory of the firm (Glasserman-Lin; Huang et al. 2026).
- **Span verification:** the resolver finds every span verbatim in the
  filing and resolves the counterparty name to a CIK through EDGAR names
  and former names. No span, no edge; unresolved names are dropped and
  counted.
- **Snippets, not whole filings:** the reader sees only windows located
  by deterministic keyword search (customer, supplier, distributor,
  "accounted for", "% of revenue/net sales", competitor), about 2k tokens
  each, so a 10-K costs a few thousand tokens instead of 60-100k.
- **Precision and recall audit:** before any edge source enters a sleeve,
  a hand-labeled sample of 200 filings must show precision ≥ 0.9; recall
  and coverage are reported. Name-to-CIK resolution is audited the same way
  for the GDELT `nw` source, where short or common names (e.g. "Delta",
  "Apple") are ambiguous: an organization name that maps to more than one
  candidate is dropped unless a ticker or location disambiguates it.
- Reader edges are extraction-class contamination (doc 11 §11.0c).

## 8.3 Event pipeline (Dynamic Event Units)

Every event is one dated record (doc 14 §14.2) with its evidence:

| Event type | Source | Trigger |
|---|---|---|
| `filing_material` | 8-K items 1.01, 1.02, 1.03, 2.01, 2.05, 2.06, 4.02, 5.02 | acceptance |
| `earnings` | 8-K item 2.02 + XBRL actuals | acceptance; SUE computed |
| `price_shock` | SIP daily bars | `|z| ≥ 3` with volume ≥ 2× its 20-day median |
| `news_burst` | GDELT GKG | burst score ≥ 3, ≥ 3 independent outlets |
| `disaster` | GDELT events naming the firm, cross-checked against USGS/FEMA records | publication |
| `social_burst` | quarantined social sources (doc 09 Tier C) | never alone; only attached as corroboration to another event |

- Echo tagging: an event explained by a linked firm's event within 2 days
  is an echo (doc 14 §14.8) and does not reach the brain.
- Duplicates (same firm, same type, overlapping evidence) merge into one
  unit.
- At most 20 events per day reach the brain, ranked by standardized
  magnitude; ties go to the source firm with fewer trailing news mentions
  (spillover is strongest where attention is low). Ranking by graph degree
  would favor mega-caps, where linked-firm news is priced fastest. The rest
  are logged with `skipped=capacity` and still feed the deterministic twin.

## 8.4 Ripple reasoning: router, retrieval, brain, verifier

The models in this path read and propose; they hold no tools. Retrieval
is done by deterministic code before each call, so every model here is a
capability-free reader (§8.5).

1. **Router.** A small pinned model classifies the event into exactly one
   intent: `supply_chain | competitive | demand | credit_contagion |
   regulatory | capital_flow | noise`. Output is the enum only; anything
   else is `noise` and stops the chain. The intent selects which edge types
   and document sections retrieval may use, so the brain never sees tools
   or data the intent does not need.
2. **Hybrid retrieval.** Graph channel: the source firm's two-hop
   neighborhood from the MLG as of the event's availability time, ranked
   by link weight. Text channel: the event's primary documents (8-K text,
   press-release exhibits) and the latest relevant filing sections of the
   neighbors, ranked by embedding similarity. News events enter as GDELT
   metadata (organizations, themes, tone, outlet count, source URLs); the
   engine does not fetch publisher article text, whose terms and paywalls
   do not permit automated use. Fused score `S = β · S_graph + (1 − β) · S_text`, with `β` a
   fixed per-intent table (not learned). Context is capped at 12k tokens.
3. **Brain.** A pinned model receives the event, the retrieved context
   (firm names anonymized as Firm A, B, … by default) and the skill file
   for the intent. It writes at most 5 hypotheses:

   ```json
   {"target": "Firm C", "direction": "up|down", "horizon": "5|21|63",
    "mechanism": "supply_disruption|demand_shift|competitive_gain|
                  competitive_loss|credit_contagion|capital_flow|regulatory",
    "path": ["edge_id", "..."], "evidence": ["evidence_id", "..."]}
   ```

   No size, no price, no order fields exist in the schema.
4. **Verifier.** Deterministic checks first: every edge in `path` exists as
   of `t`, every evidence id resolves and its span matches, the target is
   in the sleeve universe, enums are valid. Then an independent pinned
   model from a different model family answers two fixed questions per
   hypothesis: does the cited evidence state the link, and is the mechanism
   consistent with the event text? A hypothesis passes only with both
   answers yes. The verifier never adds or edits hypotheses.
5. **Emit.** Passing hypotheses become `ripple_hypothesis` features (f3)
   with de-anonymized target symbols, `evidence = inference`, and a
   computed `confidence_bucket` (verifier agreement × evidence count ×
   edge weight), never a model's self-report.

Every call logs the model pin, prompt hash, retrieved-context hash, output
and verifier output. Replay never re-calls a model. Hypotheses are scored
on resolution (doc 14 §14.5) whether or not a sleeve trades them.

## 8.4a Model cost budget (planning; measured in engine-reasoning and LLM-link steps)

Token arithmetic decides what the engine can afford under the doc 10 caps
($150 per 30 days at G0/G1):

| Path | Volume | Tokens/month (approx.) |
|---|---|---|
| Router + brain + verifier | ≤ 20 events/day × ~24k tokens | ~10M |
| Reader, forward filings | ~2,500 filings/month × ~5 snippets × 2k | ~25M |
| Reader, extraction class backfill 2016-2026 (one-off) | ~65k 10-Ks × ~10k | ~650M once |

- At open-weights prices (well under $1 per million input tokens) the
  forward paths fit the cap with room; at frontier prices they do not.
  Roles therefore default to the cheapest model that passes its bake-off.
- The backfill is a one-off `experiment` budget approved in the sign-off
  log before it runs, priced from the governor's table; it never shares
  the monthly research cap.
- The governor's per-call reservation (doc 10 §10.4.1) applies to every
  call; a day that hits the cap degrades to the deterministic twin, never
  to unverified hypotheses.

## 8.5 Security pattern, framework and isolation (locked)

**Stack:** LangGraph orchestrates (durable checkpoints, resume after
crash, `interrupt()` for human gates); smolagents `CodeAgent` is confined
to the research factory; SQLite checkpoints in paper, Postgres from G2;
OpenTelemetry to self-hosted Langfuse for per-run token/cost attribution;
Pydantic validation at every boundary. AG2 and CrewAI were rejected;
self-modifying assistants reachable from chat apps (Hermes Agent,
OpenClaw) are banned from any capital host.

| Tier | Touches untrusted docs? | Capabilities | Output |
|---|---|---|---|
| **Reader** (extract, router, brain, verifier model) | Yes (filings, news, social text) | model call only: no tools, no code execution, no network, no file write | length-capped, schema-validated JSON (enums, bounded strings, spans); any instruction inside a document is data |
| **Resolver/Verifier code** | No | deterministic Python: re-derives every claimed fact from the canonical record by span; rejects anything unverifiable | verified records with provenance |
| **Orchestrator** | No | graph control, deterministic retrieval, trusted local stores (read-only) | node routing, budgets |
| **Emitter** (only writer) | No | writes `features.jsonl` via the frozen emit path | complete bundles |

Handoffs are typed, schema-validated records with allowlisted targets,
never parsed out of model text downstream of a reader. Harness-side schema
validation runs on every reader output before anything else sees it.

**Container spec (locked; research factory and sandboxed harvest
workers):** `executor_type="docker"` only: non-root, read-only rootfs,
dropped capabilities, CPU/RAM limits, network egress limited to the
allow-listed endpoints through the egress proxy (the prompt is never the
network boundary; §8.8 proves it with an unauthorized-destination probe).
Import allowlist (locked, exact): stdlib `json, re, datetime, urllib, xml,
html, math, statistics, collections, itertools, hashlib, base64` +
`requests` + `bs4` + `lxml` (parser only) + `pydantic` + `pandas` (no eval)
+ `feedparser`. No `subprocess`, no `os.system`, no raw `socket`, no
`pickle`, no `yaml.load`.

**OS identities (locked), no shared groups:** `mirotrade` runs the C++
kernel and transport and owns journal/`HALT`/stage chain/broker keys
(mode 600). `mirostrat` runs the sleeve engine and owns
`candidates.jsonl` only. `miroresearch` runs the engine and owns
`features.jsonl`, `signals.jsonl`, the MLG and the event store; no read on
other homes, no sudo, no docker group. `mirojev` runs the optional JEV
sidecar. `mirofactory` runs the research factory on dataset copies with no
credentials except the research model key via the spend gate. `mirohuman`
signs manifests; no process runs as the operator. `LocalPythonExecutor` is
forbidden on any host that can reach trading credentials, the journal,
`HALT`, or the stage chain.

**Residual risks (named so they can be watched):**
1. Prompt injection via harvested text: readers have no capabilities;
   outputs are schema-capped and span-verified; an injection can at most
   bias a hypothesis, which the verifier and the paired test then face.
2. Correlated model failure: one misreading hits many targets. Controls:
   per-target evidence, R2 caps, the 20-event daily cap, the deterministic
   twin as a standing comparison.
3. Temporal contamination: pinned cutoffs, anonymization, post-cutoff
   evaluation for judgment class (doc 11 §11.0c).
4. Entity-resolution errors: unresolved names are dropped, never guessed;
   the precision audit gates each edge source.
5. Human sign-off fatigue: fixed ≤ 15-minute checklist reviews.

## 8.6 Runaway-loop limits (R15, hard)

Per cycle, per symbol, enforced by the orchestrator and by the process
supervisor independently:

| Limit | Value | On breach |
|---|---|---|
| LLM calls per cycle | 40 | Cycle aborted, `research_abort` logged; no partial bundle is ever published - the last complete bundle stands (§8.7). |
| Tool calls per cycle | 120 | Same |
| Wall clock per cycle | 8 min | Same |
| Tokens per cycle | 250k | Same |
| Consecutive aborted cycles | 3 same-symbol → symbol paused; majority-of-watchlist in-window → plane degraded | Alert; last complete bundle stands; entries needing fresh features HOLD |
| Recursion / graph depth | 25 | Hard stop (LangGraph `recursion_limit`) |

A cycle that aborts is not retried within the same interval. Reader calls
are counted per document and per event and capped per day by the spend
governor (doc 10 §10.4). The budget ledger's durability, digest, migration
and trust rules are in `appendix/08-ledger-integrity-and-trust-record.md`
and are binding.

## 8.7 Feature contract (locked - the only thing that crosses the boundary)

`features.jsonl` carries typed feature records in complete bundles. One
`emit` writes one bundle: `research_epoch` + `bundle_id` + `watermarks` +
feature list + `BUNDLE_COMMIT`, staged as temp + fsync + atomic rename with
a manifest row (bundle_id, research_epoch, feature count, map sha, commit).
The writer is `research/engine/emit.py`; the reader is
`collector/ctx_read.py`, which enforces the bundle-internal `commit is
True` flag plus the strict envelope/lineage/kind checks. Partial emit +
crash + restart never exposes half a bundle. Watermarks are replay-critical:
`{"entity_map_version", "entity_map_sha256", source watermarks,
last-observation timestamps}`; the reader hashes the actual map file and
requires an exact sha256 match. C++ consumes the last complete bundle only.
Prose is not a feature: it goes to `research_digest.jsonl` (human reading,
advisory only, never into JEV state - doc 03 §3.4).

f2 record:

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

f3 (lands with the graph sleeves; schema bump + manifest bump) adds two
kinds and keeps every f2 rule:
- `link_signal`: per-symbol cross-sectional rank of the neutralized graph
  signal (`value.type = count`, `v` = rank, 1 = most positive, with the
  universe size in the bundle watermarks), `evidence = derived`, lineage =
  the link-matrix snapshot hash and the price rows it was computed from.
  An integer rank lets the sleeve and the kernel pick the most extreme
  names without a float crossing the boundary.
- `ripple_hypothesis`: `value = {"direction": "up|down", "horizon":
  "5|21|63", "mechanism": <enum>, "source_event": <event_id>}`,
  `evidence = inference`, `canonical_hashes` = the verified evidence rows.

Hard rules on every record:
- **Bundle vs feature ownership.** Bundle-level: `schema_version`,
  `research_epoch`, `bundle_id`, `commit`, `watermarks`, `history`,
  `features`. Feature-level: `feature_id`, `kind`, `symbols`,
  `observed_at_ns`, `ingested_at_ns`, `ttl_s`, `value`, `effect`,
  `evidence`, `confidence_bucket`, `source_id`, `provenance_url`,
  `canonical_hash`, `canonical_hashes`, `entity_ref`. The reader validates
  each level separately and rejects cross-level smuggling.
- **Model outputs are advisory candidates, never evidence.** A
  deterministic resolver recomputes `evidence`, `effect`,
  `observed_at_ns`, entity binding and `canonical_hash` from the canonical
  source record before anything is emitted. No model output can declare
  `evidence=source` (R1).
- **Evidence levels.** `source` = deterministic parser over a primary
  source. `derived` = deterministic transform of source facts.
  `inference` = model-produced: CONTEXT-only until the producing *rule*
  earns promotion by measured track record (doc 11), never the individual
  claim. `ripple_hypothesis` is read only by a sleeve that pre-registered
  it (Event Ripple), in shadow until that sleeve passes its gates.
- **`effect` is assigned by a deterministic interpretation table per
  kind**, never invented per record. C++ derives `disagreement` from
  opposite TRIGGER effects (doc 03 §3.4).
- **`confidence_bucket` is computed**, never self-reported by a model.
- **No free-form floats** and **no prose**. The reader enforces an explicit
  field allowlist and rejects unknown fields.
- **Plausibility** (ctx-reader enforced, rejection reasons logged):
  1. *Entity binding* - every `symbols[]` entry resolves through the
     versioned map `collector/entity_map.json` (sha256-pinned in the bundle
     watermarks); map contradiction rejects.
  2. *Frozen-feed detection* (`plausibility_v1`):

     ```
     edgar_8k: 45 min | fed/ecb: 3 h | treasury/bls/fred: 18 h
     ```

     identical authoritative payload across `FROZEN_N = 3` consecutive
     polls marks the source `stale`; the N observations must span at least
     half the source's nominal cover; undated history is rejected.
  3. *Session-aware freshness* - timestamps in America/New_York. Equity
     features timed 16:00-09:30 ET are rejected unless the kind is in the
     overnight allowlist (`calendar_ahead` with phase pre/blackout,
     scheduled `macro_release`, `ripple_hypothesis` and `link_signal`, which
     are consumed only at the next session).
- **Lineage.** Single-source: `canonical_hash` is that row's hash.
  Multi-source: `canonical_hashes` is the sorted list of input hashes and
  `canonical_hash = hex(sha256("‖".join(sorted_hashes)))`. Features without
  resolvable lineage are rejected.
- Max 64 features per snapshot, newest first; overflow dropped, counted.
- Source health is `source_status` per source (healthy / stale / failed /
  not_scheduled / unavailable / na). `not_scheduled` is never a negative
  signal.

## 8.8 What "done" means

- [ ] MLG as-of queries reproduce the same edge set for the same `t` after
      later edges are added (bitemporal test).
- [ ] Each edge source passes its precision audit and the doc 14 §14.7
      placebo test before a sleeve uses it.
- [ ] Event pipeline: dedupe, echo tagging and the daily cap proven on
      fixtures.
- [ ] Bounded growth: interval compaction, streaming GDELT aggregation and
      document size caps proven; 24 h soak with flat RSS for every
      long-running engine process; daily store-size report.
- [ ] Router, brain and verifier proven capability-free: a document
      carrying tool calls, code, URLs and instructions yields only
      schema-valid JSON or a rejection; the verifier rejects any hypothesis
      whose evidence span does not match.
- [ ] Graph runs 7 days unattended with checkpointing; kill -9 at a random
      node resumes with no duplicate features.
- [ ] R15 limits proven by a forced runaway test.
- [ ] Isolation proven: the engine user cannot write the journal, `HALT`,
      the stage chain, or `candidates.jsonl`, and cannot read broker
      credentials.
- [ ] R12 proven: a future-`observed_at_ns` feature is dropped by `ctx/`.
- [ ] Egress proven at the network layer for sandboxed workers.
- [ ] Bundle atomicity proven under kill -9 mid-`emit`.
- [ ] Langfuse shows per-node token and dollar attribution for a full day.

## 8.9 Research factory

Agents propose hypotheses, write the code, and backtest before a human
sees them; outputs pass the same thresholds as human research.

1. **Intake** - hypothesis cards (≤ 3 per week, doc 11 §11.4) from the
   weekly reflection, `lessons.jsonl`, ripple-resolution statistics, or a
   human: claim, mechanism, citations, data needed, expected sign and
   magnitude, how it could be wrong.
2. **Pre-registration** - drafted from the doc 02 template; a validator
   checks completeness; a human approves before data is touched.
3. **Implementation** - a sandboxed CodeAgent writes sleeve code against
   the harness API only (no network, trusted local datasets, read-only
   mounts). The harness loads data, applies costs, splits windows and
   computes statistics, so generated code cannot leak the holdout or
   choose its own costs.
4. **Gate** - the harness runs the backtest gate and writes the report and ledger
   rows. A failed pre-registration is never rerun with new parameters.
5. **Triage** - humans see gate-passing reports plus the weekly failure
   count.

Factory rules: runs as `mirofactory` on dataset copies; model calls are
category `experiment`; the factory also allows `numpy`; generated code has
no network; LLM-derived signals follow doc 11 §11.0c.

## 8.10 Model selection and pinning

- Roles: `reader` (extraction), `router`, `brain`, `verifier`, `factory`,
  optional `jev`. Each pins `model_id`, provider, revision, knowledge
  cutoff, temperature, reasoning mode, skill-file hash, tool-schema hash,
  container digest, dependency lock hash (D3). An unpinned call is a build
  failure.
- The verifier comes from a different model family than the brain.
- Prefer open-weights models pinned by exact weights hash for the brain
  and verifier: a hosted model that is retired or silently updated restarts
  the judgment class clock (doc 11 §11.0c), and the Event Ripple test needs about a year of
  uninterrupted forward data. Weights that can be self-hosted keep the
  clock running even if a provider drops the model.
- Selection is a measured bake-off per role on a fixed post-cutoff set:
  reader on span-verified field accuracy; router on intent accuracy
  against hand labels; brain on ripple resolution (doc 14 §14.5); verifier
  on catch rate for seeded false hypotheses; plus cost per task and
  latency. Not by reputation or leaderboard rank.
- Chronologically consistent models (He-Lv-Manela-Wu 2025, ChronoBERT /
  ChronoGPT, trained only on text available at each date) may run the
  brain on pre-cutoff history as research evidence; their results never
  promote.
- Skills are versioned method files per intent, hashed into the role pin
  and drift-checked in CI.

## Locked decisions

- LangGraph orchestrates the engine; CodeAgent runs only in the research
  factory, sandboxed, with no network.
- Every model in the live path is a capability-free reader; retrieval is
  deterministic code.
- The MLG is bitemporal and append-only; every edge carries evidence and
  its contamination class.
- Brain output is a typed hypothesis with no size, price or order field;
  an independent verifier and deterministic span checks gate every one.
- The engine writes `features.jsonl` (+ the human-only digest); only the
  former crosses into C++.
- Models cannot size, order, veto, resume, or promote.
- Version pins (human-accepted): `langgraph==1.1.6`, `smolagents==1.26.0`,
  self-hosted Langfuse (`langfuse==4.15.4` client); upgrades re-pin with
  measured regression results and a fresh paper window.
- Deterministic-first: harvest, parse, normalize, resolve, fuse, retrieve
  and verify are code; models read, classify, hypothesize and draft.
