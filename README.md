<div align="center">
  <br />

  # 🏦 MiroHedge

  **AI Hedge Fund — X/Twitter Knowledge → Calibrated Decisions → C++ Execution**

  *Curated X Lists feed sentiment, JEV calibrates every call, a C++ core trades forex + US stocks at sub-millisecond local latency*

  [![C++](https://img.shields.io/badge/C++-17+-blue?logo=cplusplus)](https://isocpp.org/)
  [![Python](https://img.shields.io/badge/Python-Sidecar-yellow?logo=python)](https://www.python.org/)
  [![JEV](https://img.shields.io/badge/JEV-1.13_calibrated-7B2CBF)](https://openrouter.ai/)
  [![Mode](https://img.shields.io/badge/Capital-Paper_only-00D4AA)](./plan/01-vision-and-scope.md)

  **📜 Plan-first repo — no code until the spec in `plan/` is frozen**

</div>

---

## What is MiroHedge?

A systematic trading fund for **forex majors + US-listed stocks** (no crypto in v1):

1. **X List sidecar** collects curated knowledge/sentiment into `signals.jsonl`
2. **Gemini thesis loop** writes prose context every 5 min (advisory only, never in hot path)
3. **JEV decision layer** answers 4 typed questions per cycle — calibrated, no prose
4. **C++ core** snapshots, risk-gates, and executes — or holds, with a journal row either way

Two inputs, one output — plus a box they operate inside: **BUY / SELL / HOLD + size + stop**. Paper capital until 30 clean days + human sign-off.

- **Input A (slow, rich):** the agentic research plane — free OSINT, SEC filings, macro releases, X-List sentiment, fused into typed features (docs 08, 09)
- **Input B (fast, thin):** broker quotes / trades / account state (forex majors + US-listed stocks)
- **Input C (governing):** the stage file, risk constants, spend counters (doc 10)

**The primary edge is statistical, not linguistic.** Indicators, regime detection, and the risk table do the work; JEV gates; research supplies context and disconfirmation. If the AI layer can't beat the plain statistical baseline net of its own cost, it gets removed, not tuned (doc 11).

### Who decides what

| Layer | Job | Technology |
|---|---|---|
| Thesis text | Write the "why" in prose | Gemini / LLM (5-min loop, out of hot path) |
| Routing, ranking, gating | Calibrated yes/no, pick-winner, conviction | JEV `typesafe/jev-1.13` via OpenRouter Decisions API |
| Snapshot, risk, execution | Fast, deterministic, auditable | C++ from scratch |
| Knowledge feed | Curated signals from X Lists | Sidecar (API/RSS, never Selenium in C++) |
| Research, OSINT fusion, hypotheses | Typed features + capped prose, never orders | Research plane: LangGraph + smolagents, sandboxed (doc 08) |
| Capital stage, kill switches, spend | Permit or forbid; never expand | `STAGE` file + C++ constants + human signature (doc 10) |
| Calibration + promotion | Score answers, judge challengers | Offline harness + human sign-off (doc 11) |

> Hot path never blocks on prose LLM. Hot path may read cached JEV answers.
> Risk gates are local and unconditional — they run even if JEV is down (default: **HOLD**).

---

## 🌿 Branches

| Branch | What lives here | Status |
|---|---|---|
| **`main`** (you are here) | MiroHedge AI fund — this README + the locked spec in `plan/` + the future C++ build | Active spec, Phase 0 |
| **`arena`** | Hypothesis Arena — autonomous crypto trading bot for WEEX (4 AI analysts + AI judge, WEEX Hackathon 2026 submission) | Archived lineage, runs as-is |

Other branches (`stock`, `weex`) are legacy lineage. New fund work happens on `main`.

---

## Quick Start (Phase 0 — freeze the spec)

```bash
# Clone the fund, not the bot
git clone https://github.com/Drix10/hypothesis-arena.git
cd hypothesis-arena
git checkout main

# Read the spec in order (this is the build — no code before Phase 0 exits)
cat plan/00-INDEX.md
cat plan/01-vision-and-scope.md
cat plan/02-twitter-alpha-system.md
cat plan/03-jev-decision-layer.md
cat plan/04-cpp-hft-architecture.md
cat plan/05-risk-and-determinism.md
cat plan/06-execution-and-ops.md
cat plan/07-build-roadmap.md
```

### Phase-0 exit requirements

```env
OPENROUTER_API_KEY=your_key          # Decisions endpoint access confirmed
# + every X list ID verified, TRIGGER vs CONTEXT classified
# + 20 hand-worked JEV cases, frozen sizing/VaR/fill numbers
# + venue + feed names written into plan/01 before any code
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│   SIGNAL + RESEARCH PLANE (off hot path)                               │
│   • X Lists → filter → dedupe → signals.jsonl                           │
│   • LangGraph + smolagents → typed features.jsonl (bounded, TTL'd)      │
│   • STAGE file (human-signed) + spend counters govern everything        │
├─────────────────────────────────────────────────────────────────┤
│   C++ CORE (per-symbol decision cycle, 60 s staggered)          │
│   • feed/   broker quotes → lock-free ring, gap detection       │
│   • ctx/    frozen Snapshot + SHA-256 context_hash              │
│   • JEV     1 batched call: enter / analyst / conviction / veto │
│   • risk/   veto.cpp: R1–R9 + decision table, pure functions    │
├─────────────────────────────────────────────────────────────────┤
│   EXECUTION (journal-before-order, always)                      │
│   • exec/   sizing from conviction, 1.5×ATR stops, 2R targets   │
│   • journal append-only hash-chained row per decision           │
│   • exits local + immediate — never gated on network/JEV/WS     │
└─────────────────────────────────────────────────────────────────┘
```

### The 4 JEV questions (one batched call per cycle)

| Question | Type | Decides |
|---|---|---|
| **enter** | yes/no | Edge + timing align now? |
| **analyst** | choice | Whose thesis wins — jim / ray / karen / quant? |
| **conviction** | score | flat / lean / strong / max → sizes 0% / 5% / 10–15% / ≤25% |
| **veto** | yes/no | VaR, correlation, drawdown, or exposure breach? |

`veto > 0.5` → HOLD, unconditionally. `karen` wins → HOLD (judge voted risk).
`max` needs consensus proof (top P ≥ 0.6, runner-up ≤ 0.3) or it downgrades.

---

## Risk Management (hard rules — a violation halts paper)

| Rule | Limit |
|---|---|
| Positions | Max 3 concurrent, max 2 same direction, 1 per symbol |
| Exposure | Single ≤ 25% notional/equity, total ≤ 75% |
| Churn | Max 20 trades/day, max 3/symbol/hour, flip-lock 2 h |
| Drawdown | > 10% from peak → HALT entries until review |
| Volatility | > 3× 20-day baseline → halve sizes |
| Correlation | > 0.9 same direction → close newest |
| Sessions | Stocks 09:30–16:00 ET only, PDT counted locally, forex needs open venue feed |
| Leverage | Forex ≤ 5×, stocks ≤ 2× (1× cash) — unlocks only after Phase-5 review |
| Autonomy (R10–R17) | AI spend breaker, plane isolation, no lookahead, calibration floor, conflict→HOLD, runaway caps, kill hierarchy, no auto-escalation |

### Latency budget (local, excl. network/API)

| Stage | Budget |
|---|---|
| WS tick → ring buffer | < 20 µs |
| Snapshot build | < 200 µs |
| Risk veto (local) | < 50 µs |
| JEV answer read (cached) | < 100 µs |
| Order intent → socket | < 200 µs |
| **Total local** | **< 1 ms** |

---

## Capital stages (never auto-promoted, auto-demoted on any trip)

| | G0_PAPER | G1_TINY | G2_SCALED | G3_FULL |
|---|---|---|---|---|
| Capital | paper only | ≤ 2% (forex only, 1 symbol) | ≤ 25%, ≤ 3 symbols | 100%, ≤ 5 symbols |
| AI spend cap | $150/30d | $150/30d | $400/30d + 20%-of-profit ratio | $1,000/30d + ratio |
| Kill levels | SOFT / MEDIUM / HARD — none reachable by an agent, exits survive all three |

Details: [`plan/10-capital-gates-and-spend-control.md`](./plan/10-capital-gates-and-spend-control.md).

## Build Roadmap (phases 0–7, mapped to stages G0→G3)

| Phase | Work | Exit |
|---|---|---|
| **0 — Freeze spec** | Verify list IDs, classify TRIGGER/CONTEXT, 20 JEV cases, freeze numbers, name venues | Zero TBDs outside "tune later" |
| **1 — Signal sidecar** | Collector → `signals.jsonl` + SQLite + dedupe | 7-day soak, <10% noise |
| **2 — JEV sidecar** | `jev.py`: stdin state → batched call → answers + log | 20 cases green, cache hits > 50% |
| **2.5 — Research plane** | LangGraph graph, Docker sandbox, Tier A pollers, isolation + R12 tests | Docs 08 §8.6 / 09 §9.4 boxes checked |
| **3 — C++ core** | `core` + `risk` first, then `ingest`, `kill`, `feed`, `ctx`, `exec`, `journal` | Soak + hash-stability + veto suite green |
| **4 — Paper loop (G0)** | Full loop + research attached, baseline + calibration harness live | 30 clean days, spend in cap, human sign-off |
| **5 — G1_TINY** | Human-signed STAGE, 1 forex symbol, 0.25× limits, daily review | G1→G2 criteria + signature |
| **6 — G2_SCALED** | Postgres checkpoints, shadow challengers, 20% spend ratio live | 60 days, ≥100 trades, DD < 5% |
| **7 — G3_FULL** | Full limits, deposit-and-walk-away verified | 30 intervention-free days, ongoing weekly review |

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
├── 00-INDEX.md               # map of the spec
├── 01-vision-and-scope.md    # what we build, what we NEVER build
├── 02-twitter-alpha-system.md# X-Lists knowledge/signal feed
├── 03-jev-decision-layer.md  # 4 questions, decision table, consensus
├── 04-cpp-hft-architecture.md# C++ core: modules, data rules, latency
├── 05-risk-and-determinism.md# R1–R9, stops, determinism, self-correction
├── 06-execution-and-ops.md   # order lifecycle, journal, kill switch
├── 07-build-roadmap.md       # the only to-do list (phases 0–7)
├── 08-agentic-research-plane.md # LangGraph + smolagents, isolation, runaway caps
├── 09-osint-and-free-data.md  # free sources ranked, TRIGGER/CONTEXT/NULL
├── 10-capital-gates-and-spend-control.md # stages, kill hierarchy, spend caps
└── 11-calibration-and-self-improvement.md # Brier scoring, shadow challengers, promotion gate
```

> If it's not in `plan/`, we don't build it. New idea → doc section first, then build.
> Each doc ends with "Locked decisions" — final unless revisited deliberately.

---

## Success criteria (phase 1)

- Paper-trade 30 days, every decision logged with context hash, JEV answers, risk verdict, fill or HOLD reason
- Determinism: same logged context replayed → same decision (proven by replay test)
- Risk: zero trades violating `plan/05-risk-and-determinism.md` — one violation = halt
- Latency: context snapshot → order intent < 1 ms local (excludes network calls)
- Calibration: JEV `enter` and `veto` beat base rate on Brier over ≥ 200 decisions (doc 11)
- Autonomy: 30 days with no required human intervention, every intervention logged with cause
- Cost: AI spend within stage cap, cost per closed trade reported daily (doc 10)
- Isolation: research plane can't write journal, `HALT`, or `STAGE` — proven by test
