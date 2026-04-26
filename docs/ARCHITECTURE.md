# Hypothesis Arena - System Architecture

## Table of Contents

1. [What We Do](#what-we-do)
2. [Glossary](#glossary)
3. [Architecture Overview](#architecture-overview)
   - [High-Level System Architecture](#high-level-system-architecture)
   - [System Components Overview](#system-components-overview)
4. [End-to-End User Journey](#end-to-end-user-journey)
5. [Core Components](#core-components)
   - [Master Intelligence Engine](#1-master-intelligence-engine)
   - [Tenant Workers](#2-tenant-workers)
   - [Data Layer](#3-data-layer)
   - [Communication Layer](#4-communication-layer)
6. [Data Flow](#data-flow)
   - [Complete System Flow](#complete-system-flow)
   - [Master Engine Cycle](#master-engine-cycle-every-5-minutes)
   - [Tenant Worker Cycle](#tenant-worker-cycle-on-context-received)
7. [AI Analyst System](#ai-analyst-system)
   - [Collaborative AI Decision Making](#collaborative-ai-decision-making)
   - [Individual Analyst Workflows](#individual-analyst-workflows)
   - [Judge Decision Process](#judge-decision-process)
8. [Technology Stack](#technology-stack)
9. [Pricing Tiers](#pricing-tiers)
10. [Deployment Architecture](#deployment-architecture)
11. [Scalability](#scalability)
12. [Security Architecture](#security-architecture)
13. [Monitoring & Observability](#monitoring--observability)
14. [Success Metrics](#success-metrics)

---

## What We Do

**Hypothesis Arena is an AI-powered autonomous trading platform that democratizes institutional-grade trading strategies for retail investors.** Our platform uses a collaborative AI system where four specialized analysts (Statistical, ML Signals, Risk, and Liquidity) debate market opportunities, with a judge selecting the best trade. We support stocks, forex, crypto, and commodities across multiple brokers, delivering 24/7 automated trading with institutional-level risk management.

---

## Glossary

**Key Terms:**

- **Master Engine Cycle:** The 5-minute interval at which the Master Engine gathers market data and broadcasts to all tenants (288 cycles/day)
- **Trading Cycle:** The plan-specific interval at which a tenant worker processes market context and potentially executes trades
  - Starter: Every 60 minutes (24 trading cycles/day)
  - Pro: Every 20 minutes (72 trading cycles/day)
  - Enterprise: Every 10 minutes (144 trading cycles/day)
- **Market Context:** The comprehensive package of market data, news, sentiment, and indicators broadcast by the Master Engine
- **Tenant Worker:** An isolated worker thread that processes market context for a single tenant according to their plan tier
- **Broadcast:** The act of publishing market context via Redis pub/sub to all tenant workers
- **Throttling:** Plan-based filtering that determines whether a tenant worker should process a received broadcast

**Important:** All tenant workers receive every Master Engine broadcast (every 5 minutes), but only process them according to their plan tier's trading cycle frequency.

---

## Architecture Overview

Hypothesis Arena uses a **Centralized Intelligence Model** where one Master Engine gathers all market data and broadcasts it to thousands of tenant workers. This architecture delivers 83% cost savings compared to per-tenant data gathering while ensuring consistent, real-time market intelligence across all users.

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
