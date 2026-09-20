<div align="center">
  <br />

  # MiroHedge

  **Autonomous AI Hedge Fund: free public information in, calibrated decisions out, C++ execution**

  *A research plane reads the world, JEV calibrates every call, a C++ core trades forex and US stocks. Autonomous in research, decision, and execution. Never autonomous in capital escalation.*

  [![C++](https://img.shields.io/badge/C++-17+-blue?logo=cplusplus)](https://isocpp.org/)
  [![Python](https://img.shields.io/badge/Python-LangGraph_+_smolagents-yellow?logo=python)](./plan/08-agentic-research-plane.md)
  [![JEV](https://img.shields.io/badge/JEV-v3_calibrated-7B2CBF)](./plan/03-jev-decision-layer.md)
  [![Stage](https://img.shields.io/badge/Capital-G0_PAPER_only-00D4AA)](./plan/10-capital-gates-and-spend-control.md)

  **Status: Phase 0 closed (freeze v2, signed). P1.3/P1.4/P1.5 + Phase 2 done. P3.1 ACCEPTED/FROZEN (102/102 + 20k fuzz). P3.2 ACCEPTED/FROZEN (37/37 interop). P3.3 NOT AUTHORIZED.**

</div>

---

## What is MiroHedge?

A systematic trading fund for **forex majors and US-listed stocks** (no crypto in v1):

1. **Research plane** turns free OSINT, SEC filings, macro releases, and official feeds into typed, bounded features (X disabled in v1)
2. **JEV decision layer** answers 4 typed questions per cycle. Calibrated probabilities, no prose
3. **C++ core** freezes a hashed snapshot, applies risk gates R1 through R17, and executes. Or holds, with a journal row either way

Three inputs, one output, inside a box:

- **Input A (slow, rich):** the agentic research plane (docs 08, 09)
- **Input B (fast, thin):** broker quotes, trades, and account state
- **Input C (governing):** the stage file, risk constants, spend counters (doc 10)
- **Output:** BUY / SELL / HOLD plus size plus stop, executed or paper-logged

**The edge is statistical, not linguistic.** Indicators, regime detection, and the risk table do the work. JEV is the gate. Research adds context and disconfirmation. If the AI layer cannot beat the plain statistical baseline net of its own cost, it gets removed, not tuned (doc 11).

### Who decides what

| Layer | Job | Technology |
|---|---|---|
| Research, OSINT fusion, hypotheses | Typed, validated, bounded features only; prose → research_digest.jsonl, outside the trading boundary | LangGraph + smolagents, sandboxed, off hot path (doc 08) |
| Routing, ranking, gating | Calibrated edge/family/conviction/latent-risk (v3) | JEV `typesafe/jev-1.13` via OpenRouter Decisions API (doc 03) |
| Snapshot, risk, execution | Fast, deterministic, auditable | C++ from scratch (doc 04) |
| Capital stage, kill switches, spend | Permit or forbid, never expand | `STAGE` file + C++ constants + human signature (doc 10) |
| Calibration + promotion | Score answers, judge challengers | Offline harness + human sign-off (doc 11) |

> Hot path never blocks on prose LLM. Hot path may read cached JEV answers.
> Risk gates are local and unconditional. They run even if JEV is down (default: **HOLD**).
> Agents never size, send, or see equity/PnL. The boundary is OS permissions, not convention.

---

## Branches

| Branch | What lives here | Status |
|---|---|---|
| **`main`** (you are here) | MiroHedge AI fund: this README, the locked spec in `plan/`, the collector build | P3.1/P3.2 frozen, P3.3 NOT authorized |
| **`arena`** | Hypothesis Arena: autonomous crypto trading bot for WEEX (4 AI analysts plus AI judge, WEEX Hackathon 2026 submission) | Archived lineage, runs as-is |

Other branches (`stock`, `weex`) are legacy lineage. New fund work happens on `main`.

---

## Quick start

```bash
git clone https://github.com/Drix10/hypothesis-arena.git
cd hypothesis-arena
git checkout main

bash scripts/freeze-check.sh          # must print FREEZE-CHECK: PASS
python3 collector/collect.py          # poll sources -> data/signals/<day>.jsonl
python3 collector/classify.py data/signals/<day>.jsonl   # -> data/classified/
python3 collector/test_pipeline.py    # 16+ checks, all must pass
```

Contact for SEC UA: `MIRO_CONTACT` env. FRED key: `FRED_API_KEY` env (skipped cleanly without).

---

## System Architecture

```
+-----------------------------------------------------------------+
|   RESEARCH PLANE (Python, separate OS user, off hot path)       |
|   * harvest > extract > fuse > hypothesize > critique > emit    |
|   * writes ONLY features.jsonl (typed, bounded, TTL'd)          |
|   * STAGE file (human-signed) + spend counters govern all       |
+-----------------------------------------------------------------+
|   C++ CORE (per-symbol decision cycle, 60 s staggered)          |
|   * feed/    broker quotes > lock-free ring, gap detection      |
|   * ingest/  validate features, enforce R12 timestamp rule      |
|   * ctx/     frozen Snapshot + SHA-256 context_hash             |
|   * JEV      1 batched call: enter / edge_family / conviction / latent_risk|
|   * risk/    veto.cpp: R1-R17 + decision table + stage multiplier|
|   * kill/    SOFT / MEDIUM / HARD, pure C++, exits survive all  |
+-----------------------------------------------------------------+
|   EXECUTION (journal-before-order, always)                      |
|   * exec/   risk-budget sizing, broker-native SL/TP, exit_profile_v1 |
|   * journal append-only hash-chained row per decision           |
|   * exits local + immediate, never gated on network/JEV/WS      |
+-----------------------------------------------------------------+
```

Trust flows one way: research to ctx to risk to exec. Nothing upstream can relax a downstream rule.

### The 4 JEV questions, v3 (one batched call per cycle; richness goes in the state, never in more questions)

| Question | Type | Decides |
|---|---|---|
| **enter** | yes/no | Edge + timing align now? |
| **edge_family** | choice | Which strategy family fits: mean_reversion / momentum / macro / execution? (fit only, never success odds) |
| **conviction** | score | flat / lean / strong / max: budget gate only, never sizes |
| **latent_risk** | yes/no | Material risk the deterministic engine missed? (additive HOLD only) |

Row 0 is the deterministic engine (any R-breach holds, no model involved). Above the edge bands:

- `latent_risk > 0.5` goes HOLD, additively. `disagreement == true` goes HOLD (R14, opposite TRIGGER effects, never averaged)
- Event blackout (BINARY/HIGH tiers) goes HOLD. Calibration `gate == breach` goes HOLD (R13 in-band; the `vs_baseline` comparison is descriptive, only the deterministic gate controls)
- `execution` family or `flat` goes HOLD. `max` needs the §3.3 gate (enter high, latent low, calibration ok, directional family) or it downgrades. Family probabilities never size.

State now carries typed `features` (max 16 in payload; enums, bools, counts, buckets; no model floats; effect + evidence level each), `source_status` (failed is not the same as not-scheduled), `disagreement`, event tiers, `calibration`, and `stage`. No raw texts, no prose in JEV state.

---

## Research plane (doc 08)

| Layer | Choice | Why |
|---|---|---|
| Orchestration, state, resume | **LangGraph** (MIT) | Durable checkpoints after every node, resume-after-crash, `interrupt()` for human gates |
| Leaf workers | **smolagents** `CodeAgent` (Apache-2.0) | Code actions take about 30% fewer steps; runs in Docker, pinned import allowlist |
| Checkpoints | SQLite (paper), Postgres (live) | Zero ops early, concurrent writers later |
| Observability | Self-hosted Langfuse + OpenTelemetry | Per-node token and dollar attribution, load-bearing for spend caps |

Six nodes: `harvest`, `extract`, `fuse`, `hypothesize`, `critique`, `emit`. Base cadence 5 min. The LLM nodes only re-run on new features or a 30-min staleness TTL. Runaway caps per cycle per symbol (R15): at most 40 LLM calls, 120 tool calls, 250k tokens, 8 min wall clock, depth 25. Three same-symbol aborts pause the symbol; majority-in-window aborts degrade the plane.

---

## Data sources (doc 09: free tiers only, none load-bearing except broker feed + session calendar)

| Tier | Sources | Class |
|---|---|---|
| **A: real, usable** | Broker feed, SEC EDGAR, FRED/ALFRED, Treasury/BLS/BEA, session calendars, EDGAR-derived earnings calendar (X disabled in v1) | TRIGGER-eligible |
| **B: situational** | USGS quakes, NASA FIRMS fires, weather, launch schedules, official macro/geopolitical RSS | CONTEXT by default. Risk-off first, entries never until promoted |
| **C: declared nulls** | AISStream, OpenSky, CelesTrak and other globe layers | NULL or excluded. No globe layer is TRIGGER-class in v1 |
| **D: lessons, not signals** | Public agentic-trading systems, graded accept/hype | `lessons.jsonl`, human-reviewed weekly, never auto-live |

Every non-price source starts CONTEXT or NULL. Promotion to TRIGGER needs measured hit-rate plus human sign-off. Estimated timestamps stay CONTEXT-capped forever (R12).

---

## Risk Management (hard rules: a violation halts paper and demotes live)

| Rule | Limit |
|---|---|
| Positions (R1-R2) | Max 3 concurrent, max 2 same direction, 1 per symbol. Single at most 25%, total at most 75% notional/equity |
| Churn (R3-R4) | Max 20 trades/day, max 3/symbol/hour, flip-lock 2 h |
| Drawdown / vol / corr (R5-R7) | Over 10% off peak goes HALT. Over 3x vol baseline halves sizes. Over 0.9 corr blocks entries (prevention, not cleanup) |
| Sessions / compliance (R9) | Stocks 09:30-16:00 America/New_York only, day-trade counting via effective-date-aware broker adapter, forex needs open venue feed |
| Leverage (sec 5.2) | Forex at most 5x, stocks at most 2x (1x cash). Unlocks only after Phase-5 review + doc edit |
| Spend breaker (R10) | Hourly 30-day projection vs stage cap: 60% trim, 80% cheap + SOFT, 100% MEDIUM + demote. Research throttles, JEV never does |
| Isolation (R11) | Research writes `features.jsonl` only. No broker keys, no journal/`HALT`/`STAGE` writes. Proven by test |
| No lookahead (R12) | Future or TTL-expired features dropped structurally in `ingest/` |
| Calibration floor (R13) | Brier worse than base rate by over 0.02 across 200 decisions (at least 20 outcomes) sets `gate == breach`: halts entries + demotes |
| Conflict (R14) | `disagreement == true` goes HOLD. No averaging, no tie-break toward action |
| Runaway caps (R15) | Per-cycle LLM/tool/token/time/depth ceilings. 3 aborts pause the plane |
| Kill hierarchy (R16) | SOFT / MEDIUM / HARD. None agent-reachable, exits survive all three |
| No auto-escalation (R17) | No code path promotes. Demotion is automatic and unvetoable |

Self-correction S1-S10: feed gaps, 15-min reconcile, divergence pause, session-aware watchdog, JEV streaks, stale-research-as-absent, rejection-rate trips, provider-outage defaults, broker-outage goes HARD, lost spend counters assumed high. Determinism D1-D5: same hash + version gives same decision, no RNG, pinned versions (including agent prompts/topology), snapshot-narrowed execution, replay from logged features, never agent re-runs.

### Latency budget (local, excludes network/API)

| Stage | Budget |
|---|---|
| WS tick to ring buffer | < 20 us |
| Snapshot build | < 200 us |
| Risk veto (local) | < 50 us |
| Feature ingest + validate (per cycle, off tick) | < 500 us |
| JEV answer read (cached) | < 100 us |
| Order intent to socket | < 200 us |
| **Total local** | **< 1 ms** |

The budget buys auditability, not latency alpha. Retail round-trips run tens to hundreds of ms, and that never justifies FPGA or colocation spend.

---

## Capital stages (never auto-promoted, auto-demoted on any trip)

| | G0_PAPER | G1_TINY | G2_SCALED | G3_FULL |
|---|---|---|---|---|
| Capital | paper only | up to 2% (forex only, 1 symbol) | up to 25%, up to 3 symbols | 100%, up to 5 symbols |
| R-multiplier / leverage | 1.0 | 0.25, forex at most 1x | 0.5, forex at most 2x / stocks at most 1x | 1.0, per sec 5.2 |
| AI spend cap | $150/30d | $150/30d | $400/30d + 20%-of-profit ratio | $1,000/30d + ratio |
| Review | weekly | **daily** | weekly | weekly |

Promotion criteria are necessary, never sufficient. Then a human signs `STAGE` with the process stopped. Demotion triggers: any R-trip, R5 drawdown, daily-loss breach, R13, D1 failure, journal break, spend tier 3. Kill levels: SOFT stops entries; MEDIUM flattens-or-holds-stops conditionally + demotes; HARD revokes credentials and exits. Details: [`plan/10-capital-gates-and-spend-control.md`](./plan/10-capital-gates-and-spend-control.md).

---

## Calibration + promotion gate (doc 11)

Every JEV answer is scored against realized outcomes. HOLDs included, through 25% stratified counterfactual sampling. Brier, log-loss, and 10-bin reliability curves, sliced per regime, against a base-rate baseline. Challengers (at most 3) run permanent shadow on identical snapshots with their own cost tags. An R-breach disqualifies on the spot. Promotion needs: at least 200 decisions + 100 closed simulated trades, forward-only evidence, declared search budget, net-of-all-costs results, a beaten non-LLM baseline, and a human signature. Then a fresh paper window. The AI layer must beat the statistical baseline or be removed.

## Build Roadmap (phases 0-7, mapped to stages G0 to G3)

| Phase | Work | Exit |
|---|---|---|
| **0: Freeze spec** | Grouped boxes: feed, decision layer, research plane, sources, capital/kill/spend, calibration, risk + venue | Zero TBDs outside "tune later" |
| **1: Signal sidecar** | Collector to `signals.jsonl` + SQLite + dedupe | 7-day soak, under 10% noise |
| **2: JEV sidecar** | `jev.py`: stdin state to batched call to answers + log | 20 cases green, cache hits over 50% |
| **2.5: Research plane** | LangGraph graph, Docker sandbox, Tier A pollers, isolation + R12 tests | Docs 08 sec 8.6 / 09 sec 9.4 boxes checked |
| **3: C++ core** | `core` + `risk` first, then `ingest`, `kill`, `feed`, `ctx`, `exec`, `journal` | Soak + hash-stability + veto suite green |
| **4: Paper loop (G0)** | Full loop + research attached, baseline + calibration harness live | 30 clean days, spend in cap, human sign-off |
| **5: G1_TINY** | Human-signed STAGE, 1 forex symbol, 0.25x limits, daily review | G1 to G2 criteria + signature |
| **6: G2_SCALED** | Postgres checkpoints, shadow challengers, 20% spend ratio live | 60 days, at least 100 trades, DD under 5% |
| **7: G3_FULL** | Full limits, deposit-and-walk-away verified | 30 intervention-free days, ongoing weekly review |

Full checklist with per-phase boxes: [`plan/07-build-roadmap.md`](./plan/07-build-roadmap.md).

---

## Explicitly OUT of scope (do not build)

1. No Selenium in the trading system. Ever.
2. No LinkedIn/blog syndication in the fund.
3. No FPGA/GPU in phase 1. CPU C++ first, measure, then decide.
4. No new venues in phase 1. Phase-0 brokers only.
5. No portfolio UI / investor dashboard in phase 1. Logs + journal files only.
6. No auto fine-tuning of models with live capital. Shadow + human promote only.
7. No leverage above the risk table. No exceptions, no "just this once".
8. No paid data subscriptions for core operation (doc 09).
9. No self-modifying agents, no online learning on the live path (doc 11).
10. No chat-gateway agent frameworks on the trading host (doc 08).
11. No automatic capital escalation. Ever (doc 10).

## Plan docs (read in order)

```
plan/
+-- 00-INDEX.md               # map of the spec + one-way trust rule
+-- 01-vision-and-scope.md    # autonomy definition, 3 inputs, statistical-edge-first
+-- 02-twitter-alpha-system.md# signal spec + X history (X disabled v1)
+-- 03-jev-decision-layer.md  # v2: 4 questions, new HOLD rows, richer state
+-- 04-cpp-deterministic-core.md# 3 processes, ingest/kill modules, latency budget
+-- 05-risk-and-determinism.md# R1-R17, S1-S10, D1-D5: the hard rules
+-- 06-execution-and-ops.md   # order lifecycle, outage playbook, ops rhythm
+-- 07-build-roadmap.md       # the only to-do list (phases 0-7)
+-- 08-agentic-research-plane.md # LangGraph + smolagents, isolation, runaway caps
+-- 09-osint-and-free-data.md  # free sources ranked, TRIGGER/CONTEXT/NULL
+-- 10-capital-gates-and-spend-control.md # stages, kill hierarchy, spend caps
+-- 11-calibration-and-self-improvement.md # Brier scoring, shadow challengers, promotion gate
+-- 12-statistical-baseline.md # frozen champion the AI must beat
+-- system-manifest.yaml # canonical build fingerprint
```

> `plan/` is the spec. Each doc ends with "Locked decisions".
> Docs 08-11 never weaken a rule in 01-07.

---

## Success criteria (phase 1)

- Paper-trade 30 days, every decision logged with context hash, JEV answers, risk verdict, fill or HOLD reason
- Determinism: same logged context replayed gives same decision (proven by replay test)
- Risk: zero trades violating `plan/05-risk-and-determinism.md`. One violation is halt
- Latency: context snapshot to order intent under 1 ms local (excludes network calls)
- Calibration: JEV `enter` and `latent_risk` beat point-in-time base rate on Brier over at least 200 decisions (doc 11)
- Autonomy: 30 days with no required human intervention, every intervention logged with cause
- Cost: AI spend within stage cap, cost per closed trade reported daily (doc 10)
- Isolation: research plane cannot write journal, `HALT`, or `STAGE`. Proven by test
