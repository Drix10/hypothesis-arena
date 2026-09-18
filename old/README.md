# AI-Native Hedge Fund System

> Self-improving agents that research, debate, execute, and learn from outcomes — 24/7.

Not a trading bot. A production-grade capital allocation engine where AI agents make systematic investment decisions based on conviction, not price movements.

---

## What This Does

**Persistent agents with memory** continuously analyze markets, build conviction-weighted theses, execute trades, and improve from outcomes. Every trade generates feedback that fine-tunes the system. Agents run continuously, not on-demand.

**Start medium-frequency** (seconds to minutes) with every component designed to scale to true HFT (sub-millisecond) via FPGA/GPU offload.

---

## Core Workflows

### 1. Master Intelligence Loop

**Every 5 minutes** — Centralized data gathering, broadcast to all agents

```
Raw Feeds → Normalize → Extract Features → Alternative Data → Package → Broadcast
```

- **Input:** Exchange feeds, news, social sentiment, economic data
- **Output:** Rich market context (price, volume, sentiment, regime, correlations)
- **Latency:** <60s today → <50ms on HFT path
- **Staleness Protection:** Agents verify data age before decisions, emergency price refresh at execution

### 2. Strategy Agent Cycle

**Per agent, throttled by plan** — 4 analysts debate in parallel, Judge picks winner

```
Context → Load Portfolio → 4 Analysts (Parallel) → Judge → Risk Check → Execute
```

**The 4 Analysts:**

- **Jim (Statistical)** — Mean reversion, z-scores, regime detection
- **Ray (ML Signals)** — Price targets, funding rates, liquidation heatmaps
- **Karen (Risk)** — VaR, drawdown limits, stress tests, portfolio correlation
- **Quant (Liquidity)** — Slippage models, order book depth, VWAP execution

**Output:** BUY/SELL/HOLD with conviction score, position size, exit plan  
**Latency:** <30s today → <500ms optimized

### 3. Post-Trade Reflection

**After every trade** — Agents analyze outcomes, fine-tune models

```
Trade Closed → Capture Outcome → Reflection → Feedback → Fine-tune → Shadow Test → Deploy
```

- **Captures:** P&L, slippage, Sharpe ratio, regime at trade time
- **Analyzes:** What worked? What failed? Which analyst was most accurate?
- **Improves:** Fine-tune models, update prompts, refine risk parameters
- **Frequency:** Real-time for high-conviction trades, batch nightly

### 4. Global Risk Oversight

**Continuous + daily** — Real-time monitoring, circuit breakers, attribution

```
Every 1 min: Check exposure, VaR, correlation → Circuit breakers if needed
Daily: Attribution report per agent, per strategy, per regime
```

- **Monitors:** Aggregate exposure, cross-agent correlation, liquidity stress
- **Protects:** Auto-pause if drawdown >10%, volatility >3x, correlation >0.9
- **Reports:** Daily attribution, performance by agent/strategy/regime

---

## Daily Operations

| Time (UTC)       | What Happens                   | Output                          |
| ---------------- | ------------------------------ | ------------------------------- |
| **00:00**        | Master Intelligence Cycle      | Fresh context broadcast         |
| **Continuous**   | Strategy Agent Cycles          | Trades + journal entries        |
| **Every 15 min** | Real-time Risk Sweep           | Alerts if limits breached       |
| **04:00**        | Post-Trade Reflection Batch    | Model improvements queued       |
| **08:00**        | Daily Attribution Report       | Human review + investor summary |
| **12:00**        | Offline Research & Backtesting | New alpha ideas tested          |
| **23:55**        | Nightly Model Fine-tune        | Deploy next day (shadow mode)   |

---

## Four Core Properties

Every design decision maps to one of these principles:

### 1. Reliability

**The system behaves correctly on the objective.**

- Risk veto power (Karen can override any trade)
- Circuit breakers (auto-pause on drawdown/volatility/correlation)
- Multi-agent consensus (3/4 agreement for high conviction)
- Monte Carlo validation (stress test before execution)
- Immutable audit trail (tamper-proof decision log)

### 2. Determinism

**The system behaves reproducibly under equivalent inputs.**

- Sequence numbers (detect missing data)
- Idempotent execution (same input → same output)
- Version pinning (no mid-cycle updates)
- Nanosecond timestamps (reproducible ordering)
- Snapshot isolation (consistent portfolio state)

### 3. Self-Correction

**The system recovers from drift without human intervention.**

- Gap recovery (auto-request missing contexts)
- Position reconciliation (sync with broker every 15 min)
- Drift detection (pause if diverges >30% from backtest)
- Watchdog supervision (auto-restart if hung >60s)
- Anti-churn logic (prevent flip-flopping)

### 4. Evolution

**The system improves from experience without forgetting.**

- Reflection loop (structured feedback after every trade)
- Incremental fine-tuning (no catastrophic forgetting)
- Shadow testing (new versions run in parallel)
- Canary deployment (gradual rollout with auto-rollback)
- Vector memory (2-year retention, archived to cold storage, optimized similarity search)

---

## Tech Stack Evolution

### Phase 1: Medium-Frequency (Current)

- **Core:** Node.js + TypeScript
- **Database:** PostgreSQL + TimescaleDB
- **Cache:** Redis (pub/sub, caching)
- **Vector DB:** Pinecone or Weaviate
- **LLM:** GPT-4, Claude 3.5 Sonnet, Gemini 1.5 Pro
- **Broker:** Alpaca (paper trading)

### Phase 2: Low-Latency (6 Months)

- **Hot Paths:** Rust/C++ (feature extraction, portfolio optimization)
- **Inference:** ONNX Runtime + TensorRT (sub-ms model inference)
- **GPU:** NVIDIA H100/A100 (parallel feature calculation)
- **Data:** Direct exchange feeds (co-location)
- **Broker:** Interactive Brokers (DMA via FIX)

### Phase 3: HFT (12 Months)

- **Execution:** FPGA (Xilinx Alveo, Intel Stratix) for tick-to-trade
- **Networking:** Kernel bypass (DPDK, efvi), Solarflare NICs
- **Co-location:** Equinix NY4, LD4, TY3
- **Connectivity:** Microwave/fiber for inter-market arbitrage

---

## Performance Targets

| Metric              | Current | Target (6mo) | HFT Target |
| ------------------- | ------- | ------------ | ---------- |
| Master Engine Cycle | 60s     | <5s          | <50ms      |
| Agent Processing    | 30s     | <500ms       | <5ms       |
| Tick-to-Trade       | Minutes | <1s          | <100µs     |
| Sharpe Ratio        | 1.5+    | 2.0+         | 2.5+       |
| Agent Agreement     | 60%     | 75%          | 85%+       |

---

## Current Status

**Phase:** Infrastructure setup  
**Next:** Master Engine + Worker skeleton with reflection loop

### This Week

- **Day 1:** Master Engine (centralized data gathering)
- **Day 2:** Broker integration + market data pipeline
- **Day 3:** Multi-tenant DB with Row-Level Security
- **Day 4:** Tenant Workers + Agent framework
- **Day 5:** Risk engine + circuit breakers
- **Day 6:** Reflection loop (stub)
- **Day 7:** Demo + latency measurements

---

## Why This Matters

Capital allocation drives what gets built. Better allocation → more human progress.

AI can process more information, connect more dots, and evaluate more possibilities than humans alone. What was once locked in individual judgment becomes an optimizable system.

This isn't just better trading. It's a new approach to one of the most important problems: **how we decide what gets funded**.
