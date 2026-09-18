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

## 8.3 Agent topology (locked)

One LangGraph graph, run as a supervised loop. Six nodes, all off the hot path.

| Node | Job | Output | Default on failure |
|---|---|---|---|
| `harvest` | Pull the free sources in doc 09 on their own cadences. Pure I/O, no LLM. | raw records + `observed_at_ns` | Source marked `stale`; never blocks |
| `extract` | smolagents `CodeAgent`: parse filings/calendars/OSINT into typed candidate features | candidate features | Drop + count |
| `fuse` | Deterministic Python (no LLM): join candidates to symbols, dedupe, bucket | joined features | Drop + count |
| `hypothesize` | LLM: write ≤500-char thesis per watchlist symbol (replaces the Gemini 5-min loop in doc 04) | `thesis_text` | Empty thesis — never a crash (doc 04 §4.1 already handles this) |
| `critique` | LLM: adversarial pass. Names the strongest disconfirming evidence and a regime-change check | `critique_text`, `disagreement` flag | `disagreement=true` (the safe value) |
| `emit` | Schema-validate, bound, write `features.jsonl` atomically | `features.jsonl` | Nothing written; last file ages out via TTL |

- The graph is **checkpointed after every node**. A crash resumes at the last
  completed node, not at the start of the cycle. This is the whole reason
  LangGraph was chosen.
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

## 8.4 Runaway-loop limits (R15, hard)

Per research cycle, per symbol, enforced by the orchestrator and by the process
supervisor independently:

| Limit | Value | On breach |
|---|---|---|
| LLM calls per cycle | 40 | Cycle aborted, partial features kept, `research_abort` logged |
| Tool calls per cycle | 120 | Same |
| Wall clock per cycle | 8 min | Same |
| Tokens per cycle | 250k | Same |
| Consecutive aborted cycles | 3 | Research plane paused, alert, entries continue on cached features until TTL, then HOLD |
| Recursion / graph depth | 25 | Hard stop (LangGraph `recursion_limit`) |

A cycle that aborts is not retried within the same interval. There is no
exponential-retry path that can spend money without bound — that is the failure
mode that kills unattended agent systems, and it is capped in three places.

## 8.5 Feature contract (the only thing that crosses the boundary)

```json
{
  "schema_version": "f1",
  "feature_id": "edgar:0000320193:8-K:2026-09-18T20:14:02Z",
  "kind": "filing_event|macro_release|calendar_ahead|osint_event|sentiment_tail|regime_hint",
  "symbols": ["AAPL"],
  "observed_at_ns": 0,
  "ingested_at_ns": 0,
  "ttl_s": 3600,
  "value": {"type": "enum|bucket|bool|count", "v": "..."},
  "confidence_bucket": "low|medium|high",
  "source_id": "edgar_submissions",
  "provenance_url": "https://...",
  "disagreement": false
}
```

Hard rules on this record:
- **No free-form floats.** Values are enums, booleans, counts, or buckets. A
  model-produced float is fake precision (this is the same reasoning that kept a
  numeric sentiment score out of doc 03 §3.4, and it holds here).
- **No prose** except `thesis_text`/`critique_text`, which are separately capped
  at 500 chars each and are advisory only (doc 03 §3.3 already says prose never
  overrides the table).
- Max 64 features per snapshot, newest first. Overflow is dropped, counted, and
  logged — never truncated mid-record.
- `ctx/` rejects any record failing schema, bounds, or R12 timestamp checks, and
  increments `features_rejected`. A rejection rate > 5% over an hour is an alert.

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
- Agents produce typed features and two capped prose fields. Nothing else.
- Agents cannot size, order, veto, resume, or promote. One-way boundary, enforced
  by OS permissions.
- Self-modifying / self-improving agent frameworks are banned from the trading
  host (D3, and the human-promote-only rule in doc 11).
