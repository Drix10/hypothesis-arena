# Hypothesis Arena - AI-Native Quant Hedge Fund Infrastructure

## Table of Contents

1. [What We Do](#what-we-do)
2. [Philosophy & Vision](#philosophy--vision)
3. [Glossary](#glossary)
4. [Architecture Overview](#architecture-overview)
5. [Latency Budget & Performance Targets](#latency-budget--performance-targets)
6. [Production Workflows](#production-workflows)
   - [Master Intelligence Loop](#1-master-intelligence-loop)
   - [Strategy Agent Cycle](#2-strategy-agent-cycle)
   - [Post-Trade Reflection & Self-Improvement](#3-post-trade-reflection--self-improvement)
   - [Portfolio & Risk Oversight](#4-portfolio--risk-oversight)
   - [Daily Operational Rhythm](#5-daily-operational-rhythm)
7. [Core Components](#core-components)
8. [AI Agent System](#ai-agent-system)
9. [Technology Stack](#technology-stack)
10. [Data Infrastructure](#data-infrastructure)
11. [Execution Infrastructure](#execution-infrastructure)
12. [Deployment Architecture](#deployment-architecture)
13. [Security & Compliance](#security--compliance)
14. [Monitoring & Observability](#monitoring--observability)
15. [Evolution Path: Medium-Freq → HFT](#evolution-path-medium-freq--hft)

---

## What We Do

**Hypothesis Arena is a production-grade AI-native quant hedge fund infrastructure inspired by Abundance (Apoorva Mehta's $100M AI capital allocator).** We combine centralized market intelligence with distributed autonomous agents that research, debate, execute, and self-improve 24/7. Our system runs persistent AI agents with memory, tool-use, and reinforcement learning feedback loops — designed for systematic medium-frequency trading today with a clear path to sub-millisecond HFT execution.

**Core Capabilities:**

- **Autonomous Agent Council:** 4 specialized AI analysts (Statistical, ML Signals, Risk, Liquidity) + Judge with long-running memory and self-improvement
- **Centralized Intelligence:** Single Master Engine gathers all market data once, broadcasts to thousands of strategy agents (83% cost savings)
- **Multi-Asset Coverage:** Stocks, forex, crypto, commodities with unified risk management
- **Self-Improving System:** Post-trade reflection loop with reinforcement learning and model fine-tuning
- **Production-Grade:** Sub-second latency paths, FPGA-ready architecture, institutional risk controls

---

## Philosophy & Vision

### From SaaS Bot to AI-Native Quant Fund

We're building beyond a "trading bot" toward something closer to **Abundance**: a robust, self-improving system of agents that can handle massive data, run long-running strategies, and make consistent high-quality decisions.

**Key Principles:**

1. **Centralized Intelligence + Distributed Execution**
   - Master Engine gathers data once (cost-efficient, consistent)
   - Strategy Agents execute independently (scalable, isolated)
   - Hybrid model balances cost, consistency, and speed

2. **Persistent Agents with Memory**
   - Not stateless API calls — long-running agents with vector memory
   - Learn from past trades, adapt strategies, improve over time
   - Tool-use capability (code execution sandbox for custom quant calculations)

3. **Self-Improvement Loop**
   - Every trade generates feedback signal
   - Offline training on outcomes → fine-tune models → online deployment
   - Recursive improvement: agents write and test their own improvements

4. **Latency-Aware Architecture**
   - Start medium-frequency (seconds to minutes)
   - Every component designed for HFT evolution (sub-ms via FPGA/GPU offload)
   - Clear upgrade path without rewriting core logic

5. **Robustness & Measurability**
   - Agent supervision (watchdog + rollback)
   - Full audit trail + immutable decision ledger
   - Real-time attribution per agent, per strategy, per regime

---

## Glossary

**Core Concepts:**

- **Master Intelligence Engine:** Centralized system that gathers all market data, news, sentiment, and alternative data once per cycle and broadcasts to all strategy agents. Runs every 5 minutes (medium-freq) or sub-second (HFT path).

- **Strategy Agent:** Persistent AI agent (not stateless worker) that receives market context, maintains memory of past trades, runs analysis, and executes trades. Each agent has vector memory, tool-use capability, and learns from outcomes.

- **Agent Council:** The 4 specialized analysts (Jim, Ray, Karen, Quant) that debate every opportunity in parallel. Each is a long-running autonomous agent with domain expertise.

- **Judge Agent:** Meta-agent that evaluates all analyst recommendations, applies risk constraints, and makes final execution decisions. Has veto power and adjusts sizing.

- **Market Context:** Rich JSONB package containing: raw market data, technical indicators, order book depth, funding rates, news sentiment, social signals, regime detection, cross-asset correlations. Broadcast via Redis pub/sub.

- **Reflection Loop:** Post-trade analysis where agents examine outcomes, generate feedback signals, and trigger model fine-tuning. Runs after every trade + nightly batch.

- **Self-Improvement Cycle:** Offline training pipeline that takes trade outcomes → fine-tunes smaller models (distilled from Gemini/Claude) → deploys new versions after shadow testing.

- **Latency Path:** Execution route optimized for speed. Medium-freq (Node.js, <1s), Low-latency (Rust/C++, <50ms), HFT (FPGA offload, <100µs tick-to-trade).

- **Regime Detection:** ML-based classification of market state (trending, mean-reverting, high-vol, low-vol, risk-on, risk-off). Agents adapt strategies per regime.

- **Tool-Use:** Agent capability to execute Python/R code in sandboxed environment for custom quant calculations (Monte Carlo, optimization, backtesting).

**Latency Tiers:**

- **Medium-Frequency:** 1-60 second execution (current Node.js implementation)
- **Low-Latency:** 10-500ms execution (Rust/C++ + GPU inference)
- **HFT:** <100µs tick-to-trade (FPGA offload + co-location)

---

## Latency Budget & Performance Targets

### End-to-End Tick-to-Trade Breakdown (2026 SOTA)

| Stage                                | Current (5-min) | Realistic Quant Target | True HFT Target | How to Achieve                                              |
| ------------------------------------ | --------------- | ---------------------- | --------------- | ----------------------------------------------------------- |
| **Market Data Ingestion**            | ~seconds        | <50ms                  | <1ms            | Direct exchange feeds, co-location, FPGA/UDP multicast      |
| **Feature Calculation**              | ~seconds        | <20ms                  | <100µs          | GPU/FPGA offload, pre-computed indicators                   |
| **AI Analysis (4 Analysts + Judge)** | ~10-25s         | <500ms                 | <5ms            | ONNX/TensorRT, smaller distilled models, parallel inference |
| **Decision & Risk Check**            | ~seconds        | <10ms                  | <1ms            | Rule engine + lock-free data structures                     |
| **Order Execution**                  | ~seconds        | <50ms                  | <10µs           | DMA (Direct Market Access) + co-location                    |
| **Total Tick-to-Trade**              | Minutes         | <1 second              | <100µs          | Hybrid path: Node.js → Rust → FPGA                          |

### Performance Targets by Mode

**Medium-Frequency (Current Production):**

- Master Engine cycle: <60 seconds (target: 45s)
- Strategy Agent processing: <30 seconds (target: 22s)
- Broadcast latency: <1 second
- Trade execution: <5 seconds
- Uptime: 99.9%

**Low-Latency (6-Month Target):**

- Master Engine cycle: <5 seconds
- Strategy Agent processing: <500ms
- Broadcast latency: <10ms
- Trade execution: <50ms
- Uptime: 99.95%

**HFT (12-Month Target):**

- Market data to decision: <5ms
- Order placement: <10µs
- Co-located execution: <100µs tick-to-trade
- Uptime: 99.99%

---

---

## Production Workflows

These are the real, production-grade workflows that run 24/7 in a 2026 AI-native quant hedge fund. Directly inspired by Abundance's agent-heavy approach.

### 1. Master Intelligence Loop

**Frequency:** Every 5 minutes (medium-freq) or sub-second (HFT path)  
**Purpose:** Centralized data gathering and context creation  
**Latency Target:** <60s today → <50ms on HFT path

```
MASTER INTELLIGENCE LOOP (Every 5 Minutes)

Timer Trigger (5-min interval)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 1: RAW FEED INGESTION (Parallel)                     │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐       │
│  │  Exchange   │  │  Premium    │  │  Alternative│       │
│  │  Direct     │  │  Aggregator │  │    Data     │       │
│  │  Feeds      │  │  (Exegy,    │  │  Providers  │       │
│  │             │  │  Bloomberg) │  │             │       │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘       │
│         │                │                │               │
│         └────────────────┼────────────────┘               │
│                          │                                 │
└──────────────────────────┼─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 2: NORMALIZATION & TIMESTAMPING                      │
│                                                             │
│  • Nanosecond precision timestamps                          │
│  • Symbol normalization across exchanges                    │
│  • FPGA/UDP multicast for HFT path                         │
│  • Quality checks (stale data, outliers)                   │
│                                                             │
│  Output: Unified tick stream                               │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 3: FEATURE EXTRACTION (GPU-Accelerated)              │
│                                                             │
│  Technical Indicators:                                      │
│  ├─ RSI, MACD, EMA, Bollinger Bands                       │
│  ├─ Order book imbalance, depth analysis                   │
│  ├─ Funding rates, open interest (crypto)                  │
│  └─ Cross-asset correlations (rolling windows)            │
│                                                             │
│  Market Microstructure:                                     │
│  ├─ Bid-ask spread, liquidity metrics                     │
│  ├─ Trade flow toxicity                                    │
│  └─ VWAP, TWAP benchmarks                                 │
│                                                             │
│  Regime Detection:                                          │
│  └─ ML classifier (trending/mean-reverting/high-vol)      │
│                                                             │
│  Output: Feature vectors per symbol                        │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 4: ALTERNATIVE DATA LAYER (Parallel Scraping)        │
│                                                             │
│  News & Sentiment:                                          │
│  ├─ Reuters, Bloomberg, AP (via Playwright/Browserless)   │
│  ├─ Reddit, Twitter/X, StockTwits sentiment               │
│  ├─ Earnings transcripts, SEC filings                     │
│  └─ NLP sentiment scoring (FinBERT, custom models)        │
│                                                             │
│  Economic Data:                                             │
│  ├─ Fed, ECB, BoJ announcements                           │
│  ├─ Macro indicators (CPI, NFP, GDP)                      │
│  └─ Central bank policy signals                            │
│                                                             │
│  Exotic Data (Optional):                                    │
│  ├─ Satellite imagery (retail traffic, oil storage)       │
│  ├─ Credit card transaction data                          │
│  └─ Supply chain signals                                   │
│                                                             │
│  Output: Enriched context with sentiment scores            │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 5: CONTEXT PACKAGER                                  │
│                                                             │
│  Builds rich JSONB object:                                  │
│  {                                                          │
│    "timestamp": "2026-04-27T12:00:00.000Z",               │
│    "sequence": 12345,                                      │
│    "regime": "trending_bullish",                           │
│    "markets": {                                            │
│      "BTC/USD": {                                          │
│        "price": 67500.00,                                  │
│        "indicators": {...},                                │
│        "order_book": {...},                                │
│        "sentiment": 0.72                                   │
│      },                                                    │
│      ...                                                   │
│    },                                                      │
│    "correlations": {...},                                  │
│    "news_summary": [...],                                  │
│    "metadata": {                                           │
│      "cycle_time_ms": 45000,                              │
│      "data_points": 15000                                 │
│    }                                                       │
│  }                                                         │
│                                                             │
│  Compression: gzip for large contexts                      │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 6: REDIS BROADCAST                                   │
│                                                             │
│  Primary: Pub/Sub to "market:updates" channel              │
│  ├─ All strategy agents subscribed                         │
│  └─ Sub-millisecond fanout                                 │
│                                                             │
│  Backup: Cache in "market:context:latest" (5-min TTL)     │
│  └─ Polling fallback for missed broadcasts                 │
│                                                             │
│  Sequence Tracking:                                         │
│  └─ Agents detect gaps and request missing contexts        │
└──────────────────────────┬─────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE 7: PERSISTENCE & METRICS                             │
│                                                             │
│  Store in TimescaleDB/ClickHouse:                          │
│  ├─ Full context for backtesting                           │
│  ├─ Compressed historical ticks                            │
│  └─ Retention: 90 days hot, 2 years cold storage          │
│                                                             │
│  Update Metrics:                                            │
│  ├─ Cycle time (Prometheus histogram)                     │
│  ├─ Data quality score                                     │
│  ├─ Broadcast latency (P50, P95, P99)                     │
│  └─ Alert if cycle time > 60s                             │
└─────────────────────────────────────────────────────────────┘

END (Wait for next 5-min trigger)
```

**Key Implementation Details:**

- **Parallel Execution:** Stages 1, 3, 4 run in parallel (Promise.all)
- **Error Handling:** Retry with exponential backoff (max 3 attempts)
- **Circuit Breakers:** Skip failing data sources, continue with partial context
- **Monitoring:** Every stage emits metrics (latency, success rate, data quality)
- **Failover:** Hot standby Master Engine takes over via Redis distributed lock

**Code Structure:**

```typescript
// src/services/master/MasterIntelligenceEngine.ts
class MasterIntelligenceEngine {
  private cycleInterval = 300000; // 5 minutes

  async runCycle(): Promise<void> {
    const startTime = Date.now();

    // Stage 1-4: Parallel data gathering
    const [rawFeeds, altData] = await Promise.all([
      this.ingestRawFeeds(),
      this.gatherAlternativeData(),
    ]);

    // Stage 2-3: Sequential processing
    const normalized = await this.normalizeAndTimestamp(rawFeeds);
    const features = await this.extractFeatures(normalized);

    // Stage 5: Package context
    const context = this.packageContext(features, altData);

    // Stage 6-7: Broadcast and persist
    await Promise.all([
      this.broadcastToRedis(context),
      this.persistContext(context),
      this.updateMetrics(Date.now() - startTime),
    ]);
  }
}
```

### High-Level System Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MASTER INTELLIGENCE ENGINE                           │
│                                                                         │
│  ┌──────────────┐         Gathers Once        ┌──────────────────┐    │
│  │    Master    │ ─────────────────────────▶  │  Market Data     │    │
│  │    Engine    │                              │  News            │    │
│  │              │                              │  Sentiment       │    │
│  └──────────────┘                              │  Indicators      │    │
│         │                                      └──────────────────┘    │
└─────────┼───────────────────────────────────────────────────────────────┘
          │ Broadcast
          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      COMMUNICATION LAYER                                │
│                                                                         │
│                    ┌─────────────────────────┐                         │
│                    │   Redis Pub/Sub + Cache │                         │
│                    └─────────────────────────┘                         │
│                              │                                          │
└──────────────────────────────┼──────────────────────────────────────────┘
                               │ Subscribe
          ┌────────────────────┼────────────────────┐
          ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      TENANT WORKERS (1000s)                             │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐            │
│  │   Tenant     │    │   Tenant     │    │   Tenant     │            │
│  │   Worker 1   │    │   Worker 2   │    │   Worker N   │            │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘            │
└─────────┼───────────────────┼───────────────────┼──────────────────────┘
          │ Read/Write        │ Read/Write        │ Read/Write
          ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA LAYER                                      │
│                                                                         │
│                  ┌──────────────────────────┐                          │
│                  │  PostgreSQL Multi-Tenant │                          │
│                  └──────────────────────────┘                          │
└─────────────────────────────────────────────────────────────────────────┘

          │ Execute Trades    │ Execute Trades    │ Execute Trades
          ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      BROKER INTEGRATION                                 │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐            │
│  │  Broker API  │    │  Broker API  │    │  Broker API  │            │
│  │      1       │    │      2       │    │      N       │            │
│  └──────────────┘    └──────────────┘    └──────────────┘            │
└─────────────────────────────────────────────────────────────────────────┘
```

### System Components Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CORE COMPONENTS                                  │
│                                                                         │
│  ┌──────────────┐      ┌──────────────────┐      ┌────────────────┐   │
│  │    Master    │ ───▶ │  Communication   │ ───▶ │     Tenant     │   │
│  │    Engine    │      │      Layer       │      │    Workers     │   │
│  └──────────────┘      └──────────────────┘      └────┬───────┬───┘   │
│                                                        │       │        │
│                                                        ▼       ▼        │
│                                              ┌──────────────┐ ┌────────┐│
│                                              │  Data Layer  │ │ Broker ││
│                                              └──────────────┘ └────────┘│
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     SUPPORTING SERVICES                                 │
│                                                                         │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐         │
│  │  Monitoring  │ ···▶ │   Security   │ ···▶ │ AI Services  │         │
│  │              │      │              │      │              │         │
│  └──────────────┘      └──────────────┘      └──────────────┘         │
│         │                     │                      │                 │
│         └─────────────────────┴──────────────────────┘                 │
│                               │                                         │
│                               ▼                                         │
│                    (Supports Core Components)                           │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## End-to-End User Journey

### Complete Trading Cycle

```
USER                DASHBOARD           API              WORKER           AI            BROKER          DB
 │                      │                │                 │               │               │             │
 │                      │                │                 │               │               │             │
 │──── SETUP PHASE ────────────────────────────────────────────────────────────────────────────────────│
 │                      │                │                 │               │               │             │
 │  Create Account      │                │                 │               │               │             │
 ├─────────────────────▶│                │                 │               │               │             │
 │                      │ POST /signup   │                 │               │               │             │
 │                      ├───────────────▶│                 │               │               │             │
 │                      │                │ Create Tenant   │               │               │             │
 │                      │                ├────────────────────────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │  Configure Portfolio │                │                 │               │               │             │
 ├─────────────────────▶│                │                 │               │               │             │
 │                      │ POST /portfolio│                 │               │               │             │
 │                      ├───────────────▶│                 │               │               │             │
 │                      │                │ Store Settings  │               │               │             │
 │                      │                ├────────────────────────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │  Connect Broker      │                │                 │               │               │             │
 ├─────────────────────▶│                │                 │               │               │             │
 │                      │ POST /broker   │                 │               │               │             │
 │                      ├───────────────▶│                 │               │               │             │
 │                      │                │ Encrypt & Store │               │               │             │
 │                      │                ├────────────────────────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │                      │                │                 │               │               │             │
 │─── AUTONOMOUS TRADING PHASE (Every 5 Minutes) ─────────────────────────────────────────────────────│
 │                      │                │                 │               │               │             │
 │                      │                │  Receive Market │               │               │             │
 │                      │                │     Context     │               │               │             │
 │                      │                │                 ├──────────────▶│               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ Load Portfolio│               │             │
 │                      │                │                 ├──────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │                      │                │                 │ Run 4 Analysts│               │             │
 │                      │                │                 ├──────────────▶│               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │Recommendations│               │             │
 │                      │                │                 │◀──────────────┤               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ Judge Decision│               │             │
 │                      │                │                 ├──────────────▶│               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ [IF APPROVED] │               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ Execute Trade │               │             │
 │                      │                │                 ├──────────────────────────────▶│             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │               │  Confirmation │             │
 │                      │                │                 │◀──────────────────────────────┤             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ Store Trade   │               │             │
 │                      │                │                 ├────────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │                      │                │  Notify User    │               │               │             │
 │                      │                │◀────────────────┤               │               │             │
 │                      │                │                 │               │               │             │
 │                      │ Push Notification                │               │               │             │
 │                      │◀───────────────┤                 │               │               │             │
 │                      │                │                 │               │               │             │
 │ "Trade Executed:     │                │                 │               │               │             │
 │  BTC Long"           │                │                 │               │               │             │
 │◀─────────────────────┤                │                 │               │               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ [IF REJECTED] │               │             │
 │                      │                │                 │               │               │             │
 │                      │                │                 │ Log Decision  │               │             │
 │                      │                │                 ├────────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │                      │                │                 │               │               │             │
 │──── MONITORING PHASE ───────────────────────────────────────────────────────────────────────────────│
 │                      │                │                 │               │               │             │
 │  View Performance    │                │                 │               │               │             │
 ├─────────────────────▶│                │                 │               │               │             │
 │                      │ GET /trades    │                 │               │               │             │
 │                      ├───────────────▶│                 │               │               │             │
 │                      │                │ Query Trades    │               │               │             │
 │                      │                ├────────────────────────────────────────────────────────────▶│
 │                      │                │                 │               │               │             │
 │                      │                │ Trade History   │               │               │             │
 │                      │                │◀────────────────────────────────────────────────────────────┤
 │                      │                │                 │               │               │             │
 │                      │Performance Data│                 │               │               │             │
 │                      │◀───────────────┤                 │               │               │             │
 │                      │                │                 │               │               │             │
 │ Charts & Analytics   │                │                 │               │               │             │
 │◀─────────────────────┤                │                 │               │               │             │
 │                      │                │                 │               │               │             │
```

### User Interaction Points

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          USER ACTIONS                                   │
│                                                                         │
│    ┌──────────┐      ┌──────────┐      ┌──────────┐                   │
│    │ Sign Up  │ ───▶ │Configure │ ───▶ │ Connect  │                   │
│    │          │      │Portfolio │      │  Broker  │                   │
│    └──────────┘      └──────────┘      └────┬─────┘                   │
│         ▲                                    │                          │
│         │                                    │                          │
│         │                              ┌─────▼─────┐                   │
│    ┌────┴─────┐                        │  Monitor  │                   │
│    │  Adjust  │◀───────────────────────│Performance│                   │
│    │ Settings │                        └───────────┘                   │
│    └──────────┘                                                         │
└─────────────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   SYSTEM ACTIONS (AUTONOMOUS)                           │
│                                                                         │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐        │
│  │  Gather  │───▶│    AI    │───▶│  Judge   │───▶│ Execute  │───┐    │
│  │  Market  │    │ Analysis │    │ Decision │    │  Trade   │   │    │
│  │   Data   │    └──────────┘    └──────────┘    └──────────┘   │    │
│  └──────────┘                                                     │    │
│                                                                   │    │
│                                                    ┌──────────┐   │    │
│                                                    │  Track   │◀──┘    │
│                                                    │ Position │        │
│                                                    └────┬─────┘        │
└─────────────────────────────────────────────────────────┼──────────────┘
                                                          │
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      USER NOTIFICATIONS                                 │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐            │
│  │    Trade     │    │     Risk     │    │ Performance  │            │
│  │   Executed   │    │    Alert     │    │    Report    │            │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘            │
│         │                   │                    │                     │
│         └───────────────────┴────────────────────┘                     │
│                             │                                           │
│                             ▼                                           │
│                    (Back to Monitor)                                    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. Master Intelligence Engine

**Centralized market intelligence gathering and distribution**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   MASTER ENGINE COMPONENTS                              │
│                                                                         │
│                        ┌──────────────┐                                 │
│                        │  Scheduler   │                                 │
│                        │ (5-min cycle)│                                 │
│                        └──────┬───────┘                                 │
│                               │                                          │
│         ┌─────────────────────┼─────────────────────┐                  │
│         │                     │                     │                   │
│         ▼                     ▼                     ▼                   │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐            │
│  │    NEWS     │      │   PRICE     │      │   SOCIAL    │            │
│  │   SCRAPER   │      │  FETCHER    │      │  SENTIMENT  │            │
│  │             │      │             │      │  ANALYZER   │            │
│  │ Reuters,    │      │ Stocks,     │      │ Twitter,    │            │
│  │ Bloomberg,  │      │ Forex,      │      │ Reddit,     │            │
│  │ AP          │      │ Crypto      │      │ StockTwits  │            │
│  └──────┬──────┘      └──────┬──────┘      └──────┬──────┘            │
│         │                    │                     │                   │
│         │              ┌─────▼─────┐               │                   │
│         │              │ ECONOMIC  │               │                   │
│         │              │   DATA    │               │                   │
│         │              │           │               │                   │
│         │              │ Fed, ECB, │               │                   │
│         │              │   BoJ     │               │                   │
│         │              └─────┬─────┘               │                   │
│         │                    │                     │                   │
│         └────────────────────┼─────────────────────┘                   │
│                              │                                          │
│                              ▼                                          │
│                    ┌──────────────────┐                                │
│                    │    TECHNICAL     │                                │
│                    │   INDICATORS     │                                │
│                    │                  │                                │
│                    │ RSI, MACD, EMA,  │                                │
│                    │ Bollinger Bands  │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │   CORRELATION    │                                │
│                    │    ANALYSIS      │                                │
│                    │  (Cross-Asset)   │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │   VOLATILITY     │                                │
│                    │   CALCULATOR     │                                │
│                    │ (Historical &    │                                │
│                    │   Implied)       │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │    CONTEXT       │                                │
│                    │    PACKAGER      │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │      REDIS       │                                │
│                    │    PUBLISHER     │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │      CACHE       │                                │
│                    │     MANAGER      │                                │
│                    └──────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────┘
```

**Capabilities:**

- Real-time market data (stocks, forex, crypto, commodities)
- News aggregation (Reuters, Bloomberg, AP)
- Social sentiment analysis (Twitter, Reddit, StockTwits)
- Technical indicators (RSI, MACD, EMA, Bollinger Bands)
- Cross-asset correlation analysis
- Economic data integration

**Performance:**

- 5-minute update cycles
- <60 second data gathering
- <1 second broadcast latency
- 99.9% uptime with hot standby

### 2. Tenant Workers

**Personalized AI trading execution per user**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                   TENANT WORKER ARCHITECTURE                            │
│                                                                         │
│                    ┌──────────────────┐                                │
│                    │      REDIS       │                                │
│                    │   SUBSCRIBER     │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │    PORTFOLIO     │                                │
│                    │      LOADER      │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │      ASSET       │                                │
│                    │      FILTER      │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│                             ▼                                           │
│                    ┌──────────────────┐                                │
│                    │       RISK       │                                │
│                    │      MANAGER     │                                │
│                    └────────┬─────────┘                                │
│                             │                                           │
│         ┌───────────────────┼───────────────────┬───────────────┐     │
│         │                   │                   │               │     │
│         ▼                   ▼                   ▼               ▼     │
│  ┌──────────┐        ┌──────────┐        ┌──────────┐   ┌──────────┐│
│  │   JIM    │        │   RAY    │        │  KAREN   │   │  QUANT   ││
│  │Statistical│       │ML Signals│        │   Risk   │   │Liquidity ││
│  │ Analyst  │        │          │        │ Analyst  │   │  Expert  ││
│  └────┬─────┘        └────┬─────┘        └────┬─────┘   └────┬─────┘│
│       │                   │                   │               │      │
│       └───────────────────┼───────────────────┴───────────────┘      │
│                           │                                           │
│                           ▼                                           │
│                  ┌──────────────────┐                                │
│                  │      JUDGE       │                                │
│                  │ (Final Decision) │                                │
│                  └────────┬─────────┘                                │
│                           │                                           │
│                           ▼                                           │
│                  ┌──────────────────┐                                │
│                  │      TRADE       │                                │
│                  │    VALIDATOR     │                                │
│                  └────────┬─────────┘                                │
│                           │                                           │
│                           ▼                                           │
│                  ┌──────────────────┐                                │
│                  │    BROKER API    │                                │
│                  │      CLIENT      │                                │
│                  └────────┬─────────┘                                │
│                           │                                           │
│                           ▼                                           │
│                  ┌──────────────────┐                                │
│                  │     POSITION     │                                │
│                  │      TRACKER     │                                │
│                  └────────┬─────────┘                                │
│                           │                                           │
│                           ▼                                           │
│                  ┌──────────────────┐                                │
│                  │      TRADE       │                                │
│                  │      JOURNAL     │                                │
│                  └──────────────────┘                                │
└─────────────────────────────────────────────────────────────────────────┘
```

**Capabilities:**

- 4 AI analysts (Jim, Ray, Karen, Quant)
- Judge-based decision making
- Portfolio-specific filtering
- Risk limit enforcement
- Multi-broker execution
- Real-time position tracking

**Isolation:**

- Separate worker threads
- Encrypted broker credentials
- Row-level database security
- Resource limits per plan tier

### 3. Data Layer

**PostgreSQL 15 with Multi-Tenant Architecture**

```
DATABASE SCHEMA - Entity Relationships

┌──────────────┐
│   TENANTS    │
├──────────────┤
│ id (PK)      │
│ email        │
│ plan_tier    │
│ settings     │
│ created_at   │
└──────┬───────┘
       │ has (1:N)
       ├─────────────────────────────────────┐
       │                                     │
       ▼                                     ▼
┌──────────────┐                      ┌──────────────┐
│  PORTFOLIOS  │                      │   API_KEYS   │
├──────────────┤                      ├──────────────┤
│ id (PK)      │                      │ id (PK)      │
│ tenant_id(FK)│                      │ tenant_id(FK)│
│ name         │                      │ key_hash     │
│ allocation   │                      │ scopes[]     │
│ risk_profile │                      │ expires_at   │
│ active       │                      └──────────────┘
└──────┬───────┘
       │ contains (1:N)
       ├─────────────────────┐
       │                     │
       ▼                     ▼
┌──────────────┐      ┌──────────────┐
│  POSITIONS   │      │    TRADES    │
├──────────────┤      ├──────────────┤
│ id (PK)      │      │ id (PK)      │
│portfolio_id  │      │portfolio_id  │
│ symbol       │      │position_id   │
│ quantity     │      │ symbol       │
│ entry_price  │      │ side         │
│ current_price│      │ quantity     │
│unrealized_pnl│      │ price        │
└──────┬───────┘      │ ai_reasoning │
       │              │ executed_at  │
       │ generates    └──────────────┘
       │ (1:N)               ▲
       └─────────────────────┘

┌──────────────────┐
│  MARKET_CONTEXT  │  (GLOBAL - No tenant_id)
├──────────────────┤
│ id (PK)          │
│ sequence_number  │
│ data (JSONB)     │
│ created_at       │
└──────────────────┘
       │ influences
       └──────────────────▶ TRADES

KEY RELATIONSHIPS:
- TENANTS → PORTFOLIOS (1:N)
- TENANTS → API_KEYS (1:N)
- PORTFOLIOS → POSITIONS (1:N)
- PORTFOLIOS → TRADES (1:N)
- POSITIONS → TRADES (1:N)
- MARKET_CONTEXT → TRADES (influences, no FK)
```

**Tables:**

- Tenants (users, plans, API keys)
- Portfolios (allocations, risk profiles)
- Positions (current holdings, P&L)
- Trades (execution history, performance)
- Market Context (global, shared)

**Security:**

- Row-Level Security (RLS)
- Encrypted broker credentials
- API key hashing (SHA-256)
- Audit logging

### 4. Communication Layer

**Redis for Real-Time Distribution**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        REDIS ARCHITECTURE                               │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │                  PUB/SUB CHANNELS                         │         │
│  │                                                           │         │
│  │  ┌──────────────────────┐  ┌──────────────────────────┐ │         │
│  │  │   market:updates     │  │ market:context:latest    │ │         │
│  │  │  (Real-time          │  │  (Polling fallback)      │ │         │
│  │  │   broadcasts)        │  │                          │ │         │
│  │  └──────────────────────┘  └──────────────────────────┘ │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │                   CACHE STORAGE                           │         │
│  │                                                           │         │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │         │
│  │  │Tenant Configs│  │  Market Data │  │ Rate Limits  │   │         │
│  │  │  (No TTL)    │  │  (5-min TTL) │  │  (1-min TTL) │   │         │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────┐         │
│  │                 DISTRIBUTED LOCKS                         │         │
│  │                                                           │         │
│  │  ┌──────────────────┐      ┌──────────────────┐         │         │
│  │  │ Master Election  │      │ Trade Execution  │         │         │
│  │  └──────────────────┘      └──────────────────┘         │         │
│  └───────────────────────────────────────────────────────────┘         │
│                                                                         │
│  CONNECTIONS:                                                           │
│  • Master Engine ───▶ Pub/Sub + Cache                                  │
│  • Tenant Workers ───▶ Subscribe + Cache + Locks                       │
│  • Hot Standby ───▶ Master Election Lock                               │
└─────────────────────────────────────────────────────────────────────────┘
```

**Pub/Sub Channels:**

- `market:updates` - Real-time broadcasts
- `market:context:latest` - Polling fallback

**Caching:**

- Tenant configurations
- Market data (5-min TTL)
- Rate limiting counters
- Distributed locks

---

## Data Flow

### Complete System Flow

```
SYSTEM FLOW - Every 5 Minutes

MASTER ENGINE                REDIS PUB/SUB           TENANT WORKER           DATABASE            AI SERVICES         BROKER API
      │                            │                       │                     │                     │                  │
      │ Every 5 Minutes            │                       │                     │                     │                  │
      ├─ Gather Market Data        │                       │                     │                     │                  │
      ├─ Calculate Indicators      │                       │                     │                     │                  │
      ├─ Scrape News & Sentiment   │                       │                     │                     │                  │
      ├─ Package Context           │                       │                     │                     │                  │
      │                            │                       │                     │                     │                  │
      ├─ Publish Market Context ──▶│                       │                     │                     │                  │
      │                            ├─ Cache (5-min TTL)    │                     │                     │                  │
      │                            │                       │                     │                     │                  │
      │                            │ On Context Received   │                     │                     │                  │
      │                            ├─ Broadcast Context ──▶│                     │                     │                  │
      │                            │                       ├─ Load Portfolio ───▶│                     │                  │
      │                            │                       ├─ Filter Assets      │                     │                  │
      │                            │                       │                     │                     │                  │
      │                            │                       │ Parallel AI Analysis│                     │                  │
      │                            │                       ├─ Jim (Statistical) ─┼────────────────────▶│                  │
      │                            │                       ├─ Ray (ML Signals) ──┼────────────────────▶│                  │
      │                            │                       ├─ Karen (Risk) ──────┼────────────────────▶│                  │
      │                            │                       ├─ Quant (Liquidity) ─┼────────────────────▶│                  │
      │                            │                       │                     │                     │                  │
      │                            │                       │◀─ 4 Recommendations ┼─────────────────────┤                  │
      │                            │                       ├─ Judge Selects Best ┼────────────────────▶│                  │
      │                            │                       │◀─ Final Decision ────┼─────────────────────┤                  │
      │                            │                       │                     │                     │                  │
      │                            │                       │ [IF TRADE APPROVED] │                     │                  │
      │                            │                       ├─ Execute Trade ─────┼─────────────────────┼─────────────────▶│
      │                            │                       │◀─ Confirmation ──────┼─────────────────────┼──────────────────┤
      │                            │                       ├─ Store Trade ───────▶│                     │                  │
      │                            │                       ├─ Update Position ───▶│                     │                  │
      │                            │                       │                     │                     │                  │
      │                            │                       │ [IF TRADE REJECTED] │                     │                  │
      │                            │                       ├─ Log Decision ──────▶│                     │                  │
      │                            │                       │                     │                     │                  │
```

### Master Engine Cycle (Every 5 Minutes)

**Note:** The Master Engine broadcasts market context every 5 minutes (288 cycles/day). Tenant workers receive all broadcasts but only process them according to their plan tier's schedule:

- **Starter:** Processes every 60 minutes (24 cycles/day)
- **Pro:** Processes every 20 minutes (72 cycles/day)
- **Enterprise:** Processes every 10 minutes (144 cycles/day)

```
MASTER ENGINE CYCLE (Every 5 Minutes)

START
  │
  ▼
[5-Min Timer Triggered?] ─No─▶ [Wait]
  │                              │
  Yes                            │
  │◀───────────────────────────────┘
  ▼
[Gather Market Data]
  │
  ├─▶ [Scrape News: Reuters, Bloomberg, AP]
  ├─▶ [Fetch Prices: Stocks, Forex, Crypto]
  ├─▶ [Social Sentiment: Twitter, Reddit]
  └─▶ [Economic Data: Fed, ECB, BoJ]
  │
  ▼
[Calculate Indicators: RSI, MACD, EMA, BB]
  │
  ▼
[Cross-Asset Correlation Analysis]
  │
  ▼
[Package Market Context]
  │
  ▼
[Data Valid?] ─No─▶ [Log Error]
  │                    │
  Yes                  ▼
  │              [Retry Count < 3?] ─Yes─▶ [Back to Gather]
  │                    │
  │                    No
  │                    ▼
  │              [Alert PagerDuty]
  │                    │
  ▼                    ▼
[Add Sequence Number]  END
  │
  ▼
[Broadcast to Redis]
  │
  ▼
[Cache in Redis (5-min TTL)]
  │
  ▼
[Update Metrics]
  │
  ▼
END
```

### Tenant Worker Cycle (On Context Received)

**Note:** Workers receive broadcasts every 5 minutes but apply plan-based throttling before processing.

```
TENANT WORKER CYCLE

START (Context Received)
  │
  ▼
[Plan Tier Allows Processing?] ─No─▶ [Log Skip] ──▶ END
  │
  Yes
  │
  ▼
[Valid Sequence?] ─No─▶ [Gap Detected] ──▶ [Request Missing Contexts] ──▶ [Back to Valid Sequence]
  │
  Yes
  │
  ▼
[Load Portfolio & Risk Settings]
  │
  ▼
[Portfolio Active?] ─No─▶ [Log Skip] ──▶ END
  │
  Yes
  │
  ▼
[Filter Relevant Assets]
  │
  ▼
[Has Assets?] ─No─▶ END
  │
  Yes
  │
  ▼
[Run 4 AI Analysts in Parallel]
  ├─▶ [Jim: Statistical Analysis]
  ├─▶ [Ray: ML Signals Prediction]
  ├─▶ [Karen: Risk Assessment]
  └─▶ [Quant: Liquidity Analysis]
  │
  ▼
[Collect Recommendations]
  │
  ▼
[Judge Evaluates All Recommendations]
  │
  ▼
[Trade Approved?] ─No─▶ [Log Decision] ──▶ END
  │
  Yes
  │
  ▼
[Passes Risk Checks?] ─No─▶ [Log Decision] ──▶ END
  │
  Yes
  │
  ▼
[Position Limit OK?] ─No─▶ [Log Decision] ──▶ END
  │
  Yes
  │
  ▼
[Execute Trade via Broker API]
  │
  ▼
[Trade Confirmed?] ─No─▶ [Retry Count < 3?] ─Yes─▶ [Back to Execute]
  │                         │
  Yes                       No
  │                         ▼
  │                    [Log Failure]
  │                         │
  │                         ▼
  │                    [Alert User]
  │                         │
  ▼                         ▼
[Store Trade in Database]  END
  │
  ▼
[Update Position & Portfolio]
  │
  ▼
[Update Trade Journal]
  │
  ▼
[Notify User]
  │
  ▼
[Update Metrics]
  │
  ▼
END
```

---

## AI Analyst System

### Collaborative AI Decision Making

```
AI ANALYST COUNCIL - Collaborative Decision Making

Market Context Received
          │
          ▼
   [Filter Assets for Portfolio]
          │
          ▼
   [Run 4 Analysts in Parallel]
          │
    ┌─────┼─────┬─────┬─────┐
    │     │     │     │     │
    ▼     ▼     ▼     ▼     ▼
┌────────────────────────────────────────────────────────────┐
│              AI ANALYST COUNCIL                            │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │   JIM    │  │   RAY    │  │  KAREN   │  │  QUANT   │ │
│  │Statistical│ │ML Signals│  │   Risk   │  │Liquidity │ │
│  │ Analyst  │  │          │  │ Analyst  │  │  Expert  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │             │             │             │        │
│       ▼             ▼             ▼             ▼        │
│  Statistical    ML Predictions  Risk         Liquidity  │
│  Analysis       Price Targets   Assessment   Analysis   │
│  Mean Reversion Confidence      Volatility   Volume     │
│  Trend Strength Scores          Drawdown     Slippage   │
│                                 Limits       Estimates   │
└────┬─────────────┬─────────────┬─────────────┬───────────┘
     │             │             │             │
     └─────────────┴─────────────┴─────────────┘
                   │
                   ▼
            ┌──────────────┐
            │   JUDGE AI   │
            │              │
            │  Evaluates   │
            │     All      │
            │Recommendations│
            └──────┬───────┘
                   │
                   ▼
         [Best Trade Selected?]
                   │
         ┌─────────┴─────────┐
         │                   │
        Yes                 No
         │                   │
         ▼                   ▼
  [Final Recommendation] [No Action]
  [with Reasoning]       [Log Decision]
         │
         ▼
  [Risk Validation]
         │
         ▼
  [Execute Trade]
```

### Individual Analyst Workflows

#### Jim - Statistical Analyst

```
JIM - STATISTICAL ANALYST WORKFLOW

START (Receive Asset Data)
  │
  ▼
[Load Historical Price Data]
  │
  ▼
[Calculate Statistics]
  ├─▶ [Mean Reversion Analysis]
  ├─▶ [Trend Strength: ADX, Momentum]
  └─▶ [Volatility: Bollinger Bands]
  │
  ▼
[Statistical Score]
  │
  ▼
[Confidence > 70%?]
  │
  ├─ Yes ──▶ [Generate Recommendation]
  │            │
  │            ▼
  │         [Output: Action, Size, Reasoning]
  │            │
  └─ No ───▶ [Pass - No Signal]
               │
               ▼
            [Output]
               │
               ▼
         END (Return to Judge)
```

#### Ray - ML Signals Analyst

```
RAY - ML SIGNALS ANALYST WORKFLOW

START (Receive Asset Data)
  │
  ▼
[Extract Features: Price, Volume, Indicators]
  │
  ▼
[ML Model Prediction]
  │
  ▼
[Price Target Prediction]
  │
  ▼
[Probability Distribution]
  ├─▶ [Calculate Upside Potential]
  └─▶ [Calculate Downside Risk]
  │
  ▼
[Risk/Reward Ratio]
  │
  ▼
[Ratio > 2:1?]
  │
  ├─ Yes ──▶ [Generate Recommendation]
  │            │
  │            ▼
  │         [Output: Target, Stop, Confidence]
  │            │
  └─ No ───▶ [Pass - Poor R:R]
               │
               ▼
            [Output]
               │
               ▼
         END (Return to Judge)
```

#### Karen - Risk Analyst

```
KAREN - RISK ANALYST WORKFLOW

START (Receive Asset Data)
  │
  ▼
[Load Current Portfolio]
  │
  ▼
[Calculate Current Exposure]
  │
  ▼
[Correlation Analysis]
  │
  ▼
[Concentration Risk]
  │
  ▼
[Value at Risk (VaR) Calculation]
  │
  ▼
[Stress Test Scenarios]
  │
  ▼
[Within Risk Limits?]
  │
  ├─ Yes ──▶ [Approve Trade with Size Limit]
  │            │
  │            ▼
  │         [Position Sizing: Kelly Criterion]
  │            │
  │            ▼
  │         [Output: Max Size, Risk Score]
  │            │
  └─ No ───▶ [Reject - Too Risky]
               │
               ▼
            [Output]
               │
               ▼
         END (Return to Judge)
```

#### Quant - Liquidity Analyst

```
QUANT - LIQUIDITY ANALYST WORKFLOW

START (Receive Asset Data)
  │
  ▼
[Analyze Volume Profile]
  │
  ▼
[Order Book Depth]
  │
  ▼
[Bid-Ask Spread]
  │
  ▼
[Market Impact Estimation]
  │
  ▼
[Slippage Calculation]
  │
  ▼
[Total Trading Cost]
  │
  ▼
[Cost < 0.5%?]
  │
  ├─ Yes ──▶ [Approve Trade with Execution Plan]
  │            │
  │            ▼
  │         [Optimal Timing: VWAP Strategy]
  │            │
  │            ▼
  │         [Output: Execution Plan, Cost]
  │            │
  └─ No ───▶ [Reduce Size or Reject]
               │
               ▼
         [Optimal Timing: VWAP Strategy]
               │
               ▼
         [Output: Execution Plan, Cost]
               │
               ▼
         END (Return to Judge)
```

### Judge Decision Process

```
JUDGE DECISION PROCESS

START (Receive 4 Recommendations)
  │
  ▼
[Collect All Analyst Inputs]
  │
  ▼
[Evaluate Each Recommendation]
  │
  ▼
[Consensus Found?]
  │
  ├─ 3+ Agree ──▶ [Strong Signal] ──▶ [Score: 90-100]
  │                                      │
  ├─ 2 Agree ───▶ [Moderate Signal] ──▶ [Score: 70-89]
  │                                      │
  └─ No Agreement ▶ [Weak Signal] ────▶ [Score: <70]
                                         │
                                         ▼
                                    [Reject Trade]
                                         │
                                         ▼
                                    [Log Decision]
                                         │
                                         ▼
                                    [No Action]
                                         │
                                         ▼
                                       END
  │
  ▼
[Risk Check: Karen's Approval?]
  │
  ├─ Approved ──▶ [Liquidity Check: Quant's Approval?]
  │                 │
  │                 ├─ Approved ──▶ [Select Best Trade]
  │                 │                  │
  │                 │                  ▼
  │                 │             [Generate Detailed Reasoning]
  │                 │                  │
  │                 │                  ▼
  │                 │             [Final Decision with Confidence]
  │                 │                  │
  │                 │                  ▼
  │                 │                 END (Return to Worker)
  │                 │
  │                 └─ Rejected ──▶ [Reject Trade] ──▶ END
  │
  └─ Rejected ──▶ [Reject Trade] ──▶ END
```

---

## Technology Stack

### Backend

- **Runtime:** Node.js 20+ with TypeScript 5.3+
- **Framework:** Express.js (stateless, horizontally scalable)
- **Database:** PostgreSQL 15 (multi-tenant with RLS, 20 connection pool)
- **ORM:** Prisma 5+ (type-safe queries, automatic migrations)
- **Cache:** Redis 7+ (pub/sub + caching)
- **Queue:** BullMQ (job scheduling)

### AI & Analysis

- **Primary:** Google Gemini 1.5 Pro/Flash
- **Secondary:** OpenRouter (Claude, DeepSeek)
- **Scraping:** Playwright + Browserless
- **Indicators:** Custom technical analysis engine

### Infrastructure

- **Orchestration:** Kubernetes (DigitalOcean)
- **Monitoring:** Prometheus + Grafana
- **Logging:** Winston + LogDNA
- **Errors:** Sentry
- **Payments:** Stripe

---

## Pricing Tiers

**Note:** Master Engine broadcasts every 5 minutes (288 cycles/day). Plan tiers control how often tenant workers process these broadcasts.

### Starter - $199/month

- 24 trading cycles/day (processes every 60 minutes)
- Crypto markets only
- Max 3 concurrent positions
- Gemini Flash AI
- 512MB memory limit per worker

### Pro - $499/month

- 72 trading cycles/day (processes every 20 minutes)
- Stocks + Crypto markets
- Max 10 concurrent positions
- Gemini Pro AI
- 2GB memory limit per worker

### Enterprise - $1,499/month

- 144 trading cycles/day (processes every 10 minutes)
- All markets (stocks, forex, crypto, commodities)
- Max 50 concurrent positions
- Claude Opus AI
- 8GB memory limit per worker
- Priority support

---

## Deployment Architecture

### Kubernetes Infrastructure

```
KUBERNETES DEPLOYMENT ARCHITECTURE

┌─────────────────────────────────────────────────────────────────────────┐
│                          LOAD BALANCER                                  │
│                    ┌──────────────────────┐                             │
│                    │     Cloudflare       │                             │
│                    │  DDoS Protection     │                             │
│                    └──────────┬───────────┘                             │
└───────────────────────────────┼──────────────────────────────────────────┘
                                │
                ┌───────────────┼───────────────┐
                │               │               │
                ▼               ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      KUBERNETES CLUSTER                                 │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │              MASTER ENGINE POD                               │     │
│  │  ┌──────────────────┐      ┌──────────────────┐             │     │
│  │  │ Master Engine    │      │ Master Engine    │             │     │
│  │  │   (Primary)      │      │  (Hot Standby)   │             │     │
│  │  └────────┬─────────┘      └──────────────────┘             │     │
│  └───────────┼──────────────────────────────────────────────────┘     │
│              │                                                         │
│  ┌───────────┼──────────────────────────────────────────────────┐     │
│  │           │      TENANT WORKER PODS (Auto-Scaling)           │     │
│  │  ┌────────▼────────┐  ┌──────────────┐  ┌──────────────┐   │     │
│  │  │  Worker Pod 1   │  │Worker Pod 2  │  │Worker Pod N  │   │     │
│  │  │ (Tenants 1-100) │  │(Tenants      │  │(Tenants N...) │   │     │
│  │  │                 │  │ 101-200)     │  │              │   │     │
│  │  └─────────────────┘  └──────────────┘  └──────────────┘   │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                         │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                  API PODS (Stateless)                        │     │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │     │
│  │  │  API Pod 1   │  │  API Pod 2   │  │  API Pod N   │      │     │
│  │  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │     │
│  └─────────┼──────────────────┼──────────────────┼──────────────┘     │
└────────────┼──────────────────┼──────────────────┼────────────────────┘
             │                  │                  │
             ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         DATA SERVICES                                   │
│  ┌──────────────────┐              ┌──────────────────┐                │
│  │  Redis Cluster   │              │   PostgreSQL     │                │
│  │   (3 Nodes)      │              │ (Primary+Replica)│                │
│  └──────────────────┘              └──────────────────┘                │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      EXTERNAL SERVICES                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │  Broker APIs │  │   News APIs  │  │  Social APIs │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘

CONNECTIONS:
• Load Balancer ──▶ API Pods
• Master Engine (Primary) ──▶ Redis, News APIs, Social APIs
• Master Engine (Standby) ──▶ Redis (monitoring)
• Redis ──▶ Tenant Worker Pods
• Tenant Worker Pods ──▶ Database, Broker APIs
• API Pods ──▶ Database
```

### High Availability & Failover

```
HIGH AVAILABILITY & FAILOVER SEQUENCE

TIME  │  MASTER ENGINE 1 (Primary)  │  MASTER ENGINE 2 (Standby)  │  REDIS  │  TENANT WORKERS
──────┼─────────────────────────────┼─────────────────────────────┼─────────┼─────────────────
      │                             │                             │         │
T0    │ ──── NORMAL OPERATION ────────────────────────────────────────────────────────────────
      │                             │                             │         │
      │ Heartbeat + Lock ──────────▶│                             │         │
      │ Publish Context ───────────▶│                             │         │
      │                             │                             ├────────▶│ Broadcast
      │                             │                             │         │
T1    │ ──── PRIMARY FAILS ────────────────────────────────────────────────────────────────────
      │                             │                             │         │
      │ Connection Lost ─────X──────│                             │         │
      │                             │                             │         │
T2    │                             │ ──── STANDBY DETECTS FAILURE ─────────────────────────────
      │                             │                             │         │
      │                             │ Check Lock ────────────────▶│         │
      │                             │◀──── Lock Expired ──────────┤         │
      │                             │ Acquire Lock ──────────────▶│         │
      │                             │                             │         │
T3    │                             │ ──── STANDBY BECOMES PRIMARY ─────────────────────────────
      │                             │                             │         │
      │                             │ Heartbeat + Lock ──────────▶│         │
      │                             │ Publish Context ───────────▶│         │
      │                             │                             ├────────▶│ Broadcast
      │                             │                             │         │
      │                             │                             │         │
      │ ──── ZERO DOWNTIME FOR TENANT WORKERS ────────────────────────────────────────────────
      │                             │                             │         │

RESULT: Seamless failover with no data loss or service interruption
```

### Horizontal Scaling Strategy

```
HORIZONTAL SCALING STRATEGY

┌─────────────────────────────────────────────────────────────────────────┐
│                        SCALING TRIGGERS                                 │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │  CPU > 70%   │  │ Memory > 80% │  │Queue Depth   │                 │
│  │              │  │              │  │   > 100      │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                 │
│         │                 │                 │                          │
│         └─────────────────┼─────────────────┘                          │
│                           │                                             │
└───────────────────────────┼──────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      AUTO-SCALING                                       │
│                                                                         │
│              ┌──────────────────────────────┐                          │
│              │  Horizontal Pod Autoscaler   │                          │
│              └────────────┬─────────────────┘                          │
│                           │                                             │
└───────────────────────────┼──────────────────────────────────────────────┘
                            │
        ┌───────────────────┼───────────────────┬───────────────┐
        │                   │                   │               │
        ▼                   ▼                   ▼               ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        WORKER PODS                                      │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────┐  │
│  │  Worker 1    │  │  Worker 2    │  │  Worker 3    │  │Worker N  │  │
│  │ (100 tenants)│  │ (100 tenants)│  │ (100 tenants)│  │(100      │  │
│  │              │  │              │  │              │  │ tenants) │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

SCALING RULES:
• Each worker pod handles up to 100 tenants
• Scale up when CPU > 70%, Memory > 80%, or Queue Depth > 100
• Scale down when metrics drop below 50% for 10+ minutes
• Minimum: 2 pods (high availability)
• Maximum: 100 pods (10,000 tenants)
```

---

## Scalability

### Cost Efficiency

**Cost Structure:**

- **Fixed Infrastructure:** ~$125/month (DigitalOcean, PostgreSQL, Redis)
- **Variable Operational:** Scales with tenant count and activity

| Tenants | Data Cost/Day | AI Cost/Day | Total/Day | Cost/Tenant/Day |
| ------- | ------------- | ----------- | --------- | --------------- |
| 10      | $144          | $180        | $324      | $32.40          |
| 100     | $144          | $2,880      | $3,024    | $30.24          |
| 1,000   | $144          | $28,800     | $28,944   | $28.94          |

**Key Insight:** Infrastructure cost is fixed ($125/month). Data gathering cost is fixed per day ($144). Only AI analysis scales linearly with tenant count.

### Performance Targets

- **Master Engine:** <60s cycle time (broadcasts every 5 minutes)
- **Tenant Workers:** <30s processing time (throttled by plan tier)
- **Broadcast Latency:** <1s
- **Uptime:** 99.9% (hot standby failover)
- **Data Loss:** Zero (sequence numbers + gap recovery)
- **Worker Capacity:** 100 workers per node (horizontal scaling for more)

---

## Security Architecture

### Multi-Tenant Security Model

```
MULTI-TENANT SECURITY MODEL

┌─────────────────────────────────────────────────────────────────────────┐
│                          REQUEST FLOW                                   │
│                                                                         │
│  Client Request                                                         │
│       │                                                                 │
│       ▼                                                                 │
│  ┌──────────────────┐                                                  │
│  │  Load Balancer   │                                                  │
│  │    (TLS 1.3)     │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │    API Key       │                                                  │
│  │  Authentication  │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │  Rate Limiter    │                                                  │
│  │    (Redis)       │                                                  │
│  └────────┬─────────┘                                                  │
└───────────┼──────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      APPLICATION LAYER                                  │
│                                                                         │
│  ┌──────────────────┐                                                  │
│  │ Tenant Context   │                                                  │
│  │(AsyncLocalStorage)│                                                 │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │   API Handler    │                                                  │
│  └────────┬─────────┘                                                  │
└───────────┼──────────────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    DATA LAYER SECURITY                                  │
│                                                                         │
│  ┌──────────────────┐                                                  │
│  │  Row-Level       │                                                  │
│  │   Security       │                                                  │
│  │  (PostgreSQL)    │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │ Encryption Layer │                                                  │
│  │  (AES-256-GCM)   │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │    Database      │                                                  │
│  └──────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                    AUDIT & MONITORING                                   │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Audit Logger │  │Error Tracking│  │   Security   │                 │
│  │              │  │   (Sentry)   │  │   Metrics    │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘

SECURITY LAYERS:
1. Network: TLS 1.3, DDoS protection
2. Authentication: API key validation
3. Rate Limiting: Per-tenant limits
4. Context Isolation: AsyncLocalStorage
5. Data Access: Row-Level Security
6. Encryption: AES-256-GCM at rest
7. Audit: All actions logged
```

### Data Encryption Flow

```
DATA ENCRYPTION FLOW

┌─────────────────────────────────────────────────────────────────────────┐
│                          AT REST                                        │
│                                                                         │
│  Broker Credentials (Plain Text)                                       │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │   AES-256-GCM    │                                                  │
│  │   Encryption     │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │    Encrypted     │                                                  │
│  │     Storage      │                                                  │
│  └──────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                        IN TRANSIT                                       │
│                                                                         │
│  API Request                                                            │
│       │                                                                 │
│       ▼                                                                 │
│  ┌──────────────────┐                                                  │
│  │    TLS 1.3       │                                                  │
│  │   Encryption     │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │     Server       │                                                  │
│  └──────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                          IN USE                                         │
│                                                                         │
│  Load Encrypted Data                                                    │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │  Decrypt in      │                                                  │
│  │    Memory        │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │ Use Credentials  │                                                  │
│  └────────┬─────────┘                                                  │
│           │                                                             │
│           ▼                                                             │
│  ┌──────────────────┐                                                  │
│  │  Clear Memory    │                                                  │
│  └──────────────────┘                                                  │
└─────────────────────────────────────────────────────────────────────────┘

ENCRYPTION STANDARDS:
• At Rest: AES-256-GCM with per-tenant keys
• In Transit: TLS 1.3 with perfect forward secrecy
• In Use: Decrypt only when needed, clear immediately
• Key Management: HKDF for key derivation
```

### Row-Level Security (RLS)

```
ROW-LEVEL SECURITY (RLS) FLOW

CLIENT                API                CONTEXT            DATABASE
  │                    │                    │                   │
  │ Request with       │                    │                   │
  │ API Key            │                    │                   │
  ├───────────────────▶│                    │                   │
  │                    │                    │                   │
  │                    │ Validate API Key   │                   │
  │                    ├────────────────────┤                   │
  │                    │                    │                   │
  │                    │ Set Tenant ID      │                   │
  │                    ├───────────────────▶│                   │
  │                    │                    │                   │
  │                    │                    │ Query with        │
  │                    │                    │ Tenant Context    │
  │                    │                    ├──────────────────▶│
  │                    │                    │                   │
  │                    │                    │                   │ RLS POLICY APPLIED:
  │                    │                    │                   │ WHERE tenant_id =
  │                    │                    │                   │ current_tenant_id()
  │                    │                    │                   │
  │                    │                    │ Filtered Results  │
  │                    │                    │◀──────────────────┤
  │                    │                    │                   │
  │                    │ Filtered Results   │                   │
  │                    │◀───────────────────┤                   │
  │                    │                    │                   │
  │ Response           │                    │                   │
  │◀───────────────────┤                    │                   │
  │                    │                    │                   │

RESULT: User can ONLY see their own data

RLS BENEFITS:
• Database-level security (cannot be bypassed)
• Automatic filtering on all queries
• No application-level filtering needed
• Prevents data leakage between tenants
```

---

## Security

### Multi-Tenancy

- Row-Level Security (PostgreSQL RLS)
- Tenant context isolation (AsyncLocalStorage)
- Encrypted broker credentials (AES-256-GCM)
- API key hashing (SHA-256)

### Network

- TLS 1.3 for all connections
- Rate limiting (global + per-tenant)
- DDoS protection (Cloudflare)
- API key authentication

### Compliance

- GDPR (data export, deletion, consent)
- SOC 2 (access control, audit logging)
- Financial data retention (7 years)
- Trade execution audit trail

---

## Monitoring & Observability

### Monitoring Stack

```
MONITORING & OBSERVABILITY STACK

┌─────────────────────────────────────────────────────────────────────────┐
│                      APPLICATION METRICS                                │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │Master Engine │  │Tenant Worker │  │ API Metrics  │                 │
│  │   Metrics    │  │   Metrics    │  │              │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                 │
│         │                 │                 │                          │
└─────────┼─────────────────┼─────────────────┼───────────────────────────┘
          │                 │                 │
          ▼                 ▼                 ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   INFRASTRUCTURE METRICS                                │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Kubernetes   │  │    Redis     │  │  PostgreSQL  │                 │
│  │   Metrics    │  │   Metrics    │  │   Metrics    │                 │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                 │
│         │                 │                 │                          │
└─────────┼─────────────────┼─────────────────┼───────────────────────────┘
          │                 │                 │
          └─────────────────┼─────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                   COLLECTION & STORAGE                                  │
│                                                                         │
│                    ┌──────────────────┐                                │
│                    │   Prometheus     │                                │
│                    │ (Time-Series DB) │                                │
│                    └────────┬─────────┘                                │
└─────────────────────────────┼──────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                │             │             │
                ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │   Grafana    │  │Alert Manager │  │    Sentry    │                 │
│  │  Dashboards  │  │              │  │    Error     │                 │
│  │              │  │              │  │  Monitoring  │                 │
│  └──────────────┘  └──────┬───────┘  └──────────────┘                 │
│                            │                                            │
│                    ┌───────┴───────┐                                   │
│                    │               │                                    │
│                    ▼               ▼                                    │
│            ┌──────────────┐  ┌──────────────┐                         │
│            │  PagerDuty   │  │    Slack     │                         │
│            │              │  │              │                         │
│            └──────────────┘  └──────────────┘                         │
└─────────────────────────────────────────────────────────────────────────┘

MONITORING FLOW:
1. Applications & Infrastructure emit metrics
2. Prometheus collects and stores time-series data
3. Grafana visualizes metrics in dashboards
4. Alert Manager triggers alerts based on thresholds
5. PagerDuty notifies on-call engineers (critical)
6. Slack notifies team (warnings/info)
7. Sentry tracks application errors
```

### Key Metrics Dashboard

```
KEY METRICS DASHBOARD

┌─────────────────────────────────────────────────────────────────────────┐
│                        SYSTEM HEALTH                                    │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │   Uptime     │  │ P95 Latency  │  │  Error Rate  │                 │
│  │ 99.9% Target │  │  <2s Target  │  │  <5% Target  │                 │
│  │              │  │              │  │              │                 │
│  │   ✅ 99.95%  │  │   ✅ 1.2s    │  │   ✅ 2.1%    │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                       MASTER ENGINE                                     │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │  Cycle Time  │  │Data Quality  │  │Broadcast Lag │                 │
│  │  <60s Target │  │ 100% Target  │  │  <1s Target  │                 │
│  │              │  │              │  │              │                 │
│  │   ✅ 45s     │  │   ✅ 100%    │  │   ✅ 0.3s    │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                      TENANT WORKERS                                     │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ Processing   │  │Trade Success │  │ AI Cost/     │                 │
│  │     Time     │  │     Rate     │  │   Tenant     │                 │
│  │  <30s Target │  │  >95% Target │  │ Track Trend  │                 │
│  │              │  │              │  │              │                 │
│  │   ✅ 22s     │  │   ✅ 97.3%   │  │   $28.50     │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│                     BUSINESS METRICS                                    │
│                                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                 │
│  │ P&L per      │  │Active Tenants│  │   Revenue    │                 │
│  │   Tenant     │  │Track Growth  │  │  Track MRR   │                 │
│  │              │  │              │  │              │                 │
│  │   +$1,245    │  │     847      │  │   $425K      │                 │
│  └──────────────┘  └──────────────┘  └──────────────┘                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### Alert Flow

```
ALERT FLOW

Metric Threshold Exceeded
          │
          ▼
    [Severity?]
          │
    ┌─────┼─────┬─────┐
    │     │     │     │
    ▼     ▼     ▼     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CRITICAL      │  WARNING       │  INFO                                  │
│               │                │                                        │
│ • API error   │  • API latency │  • Deployment                          │
│   rate > 5%   │    P95 > 2s    │    completed                           │
│ • DB pool     │  • Browser pool│  • New tenant                          │
│   exhausted   │    util > 80%  │    signup                              │
│ • Worker      │  • Redis       │  • Performance                         │
│   crash > 10% │    unavailable │    milestone                           │
│ • Tenant loss │  • Disk < 20%  │                                        │
│   > $1000     │                │                                        │
│               │                │                                        │
│       ▼       │       ▼        │       ▼                                │
│  ┌─────────┐  │  ┌─────────┐  │  ┌─────────┐                          │
│  │PagerDuty│  │  │  Slack  │  │  │  Slack  │                          │
│  │Immediate│  │  │ #alerts │  │  │#monitoring│                         │
│  └────┬────┘  │  └────┬────┘  │  └─────────┘                          │
│       │       │       │        │                                        │
│       │       │       ▼        │                                        │
│       │       │  ┌─────────┐  │                                        │
│       │       │  │  Email  │  │                                        │
│       │       │  │  Team   │  │                                        │
│       │       │  └─────────┘  │                                        │
│       │       │                │                                        │
│       ▼       │                │                                        │
│  ┌─────────┐  │                │                                        │
│  │ On-Call │  │                │                                        │
│  │Engineer │  │                │                                        │
│  └────┬────┘  │                │                                        │
│       │       │                │                                        │
│       ▼       │                │                                        │
│  [Investigate]│                │                                        │
│       │       │                │                                        │
│       ▼       │                │                                        │
│  [Resolved?]  │                │                                        │
│       │       │                │                                        │
│  ┌────┴────┐  │                │                                        │
│  │         │  │                │                                        │
│ Yes       No  │                │                                        │
│  │         │  │                │                                        │
│  ▼         ▼  │                │                                        │
│[Close] [Escalate]              │                                        │
│          │     │                │                                        │
│          ▼     │                │                                        │
│    [Engineering│                │                                        │
│        Team]   │                │                                        │
│          │     │                │                                        │
│          └─────┘                │                                        │
└─────────────────────────────────────────────────────────────────────────┘

ALERT PRIORITIES:
• Critical: Immediate action required (PagerDuty)
• Warning: Action needed within hours (Slack + Email)
• Info: Informational only (Slack monitoring channel)
```

---

## Monitoring

### Metrics

- Master Engine cycle time
- Tenant worker processing time
- Broadcast latency
- Trade execution success rate
- P&L per tenant
- API error rates

### Alerts

- Master Engine failure (PagerDuty)
- High error rate (>5%)
- Slow performance (P95 >2s)
- Database connection pool exhaustion
- Redis unavailable

---

## Success Metrics

### Technical

- ✅ 99.9% uptime
- ✅ <60s Master Engine cycles
- ✅ <30s Tenant Worker processing
- ✅ <1s broadcast latency
- ✅ Zero data loss

### Business

- ✅ 83% cost reduction vs per-tenant model
- ✅ Support 1000+ tenants on single Master Engine
- ✅ Linear cost scaling
- ✅ 65% gross margin

### User Experience

- ✅ Real-time trade execution
- ✅ 24/7 autonomous trading
- ✅ Multi-asset support
- ✅ Institutional-grade risk management
- ✅ Transparent AI decision-making

---

**Architecture Version:** 2.0  
**Model:** Centralized Intelligence  
**Status:** Production-Ready  
**Last Updated:** April 20, 2026
