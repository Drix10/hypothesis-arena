# System Architecture

> Complete technical design for a self-improving AI hedge fund system.

---

## Table of Contents

1. [Design Principles](#design-principles-four-core-properties)
2. [Master Intelligence Loop](#1-master-intelligence-loop-every-5-minutes)
3. [Strategy Agent Cycle](#2-strategy-agent-cycle-per-agent-throttled)
4. [Post-Trade Reflection](#3-post-trade-reflection-loop-after-every-trade)
5. [Global Risk Oversight](#4-global-risk-oversight-continuous--daily)
6. [Daily Operations](#5-daily-operational-rhythm-what-actually-runs)
7. [Latency Budget](#latency-budget-end-to-end)
8. [Tech Stack](#technology-stack-evolution)

---

## Design Principles: Four Core Properties

Every implementation decision maps to one of these four properties.

### 1. RELIABILITY

> The system behaves correctly on the objective.

```
┌─────────────────────────────────────────────────────────────┐
│                   RELIABILITY MECHANISMS                     │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ✓ Risk Veto Power (Karen Agent)                            │
│    • Can override any trade if risk too high                 │
│    • VaR > 5% → REJECT                                       │
│    • Correlation > 0.9 → REJECT                              │
│    • Stress test fails → REJECT                              │
│                                                               │
│  ✓ Circuit Breakers (Global Risk Engine)                    │
│    • Drawdown > 10% → HALT all agents                        │
│    • Volatility > 3x normal → REDUCE positions 50%          │
│    • Correlation > 0.9 → CLOSE same-direction positions     │
│    • Liquidity dries up → EMERGENCY EXIT                    │
│                                                               │
│  ✓ Multi-Agent Consensus (Judge)                            │
│    • High conviction (>0.8) requires 3/4 analyst agreement  │
│    • Medium conviction (0.5-0.8) requires 2/4 agreement     │
│    • Low conviction (<0.5) → auto HOLD                      │
│                                                               │
│  ✓ Monte Carlo Validation (Before Execution)                │
│    • Simulate 10,000 scenarios                               │
│    • Check 95th percentile loss                              │
│    • If worst-case > 5% → REJECT                             │
│                                                               │
│  ✓ Immutable Audit Trail (Compliance)                       │
│    • Every decision logged with reasoning                    │
│    • Hash chain: SHA-256 with previous hash + timestamp     │
│    • Stored in append-only PostgreSQL table                  │
│    • Daily backup to S3 with versioning enabled              │
│    • Weekly hash verification (detect tampering)             │
│    • Access: Read-only for managers/auditors, system writes  │
│    • Encryption: AES-256 at rest, TLS 1.3 in transit        │
│    • Retention: 5 years (SEC requirement)                    │
│    • Post-mortem analysis for failures                       │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**Result:** System cannot execute trades that violate risk limits, even if all agents agree.

---

### 2. DETERMINISM

> The system behaves reproducibly under equivalent inputs for a given model version.

```
┌─────────────────────────────────────────────────────────────┐
│                  DETERMINISM MECHANISMS                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ✓ Sequence Numbers (Gap Detection)                         │
│    • Every context broadcast: seq = N                        │
│    • Agent expects: seq = last_processed + 1                 │
│    • If gap detected → request missing contexts from cache  │
│    • Ensures no missed data                                  │
│                                                               │
│  ✓ Idempotent Execution (No Randomness)                     │
│    • Same context + same portfolio + same model version      │
│      → same decision                                         │
│    • No random seeds in models                               │
│    • Deterministic tie-breaking (alphabetical order)         │
│    • Model version hash included in audit log                │
│    • Can replay any decision with original model version     │
│    • Reproducible for debugging                              │
│                                                               │
│  ✓ Version Pinning (No Mid-Cycle Updates)                   │
│    • Agent version locked per deployment                     │
│    • Model weights frozen during cycle                       │
│    • Updates only between cycles                             │
│    • Prevents non-deterministic behavior                     │
│                                                               │
│  ✓ Nanosecond Timestamps (Reproducible Ordering)            │
│    • All events timestamped with ns precision                │
│    • Deterministic ordering even at high frequency           │
│    • Critical for HFT path                                   │
│                                                               │
│  ✓ Snapshot Isolation (Portfolio State)                     │
│    • Portfolio state snapshotted at decision time            │
│    • Not at execution time (may have changed)                │
│    • Ensures decision based on consistent state              │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**Result:** Given same inputs, system produces identical outputs. Critical for debugging and compliance.

---

### 3. SELF-CORRECTION

> The system recovers from drift without human intervention.

```
┌─────────────────────────────────────────────────────────────┐
│                SELF-CORRECTION MECHANISMS                    │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ✓ Gap Recovery (Missing Context)                           │
│    • Agent detects sequence gap (expected 105, got 107)     │
│    • Requests missing contexts from Redis cache             │
│    • Processes in order before continuing                   │
│    • Auto-recovery without human intervention                │
│                                                               │
│  ✓ Position Reconciliation (Every 15 min)                   │
│    • Acquire reconciliation lock (prevents concurrent trades)│
│    • Fetch positions from broker (source of truth)           │
│    • Compare with local state + pending orders               │
│    • If discrepancy > 1% AND no pending → sync to broker    │
│    • If pending orders exist → defer reconciliation 30s     │
│    • Release lock, alert if discrepancy persists            │
│                                                               │
│  ✓ Drift Detection (Backtest Divergence)                    │
│    • Compare live decisions vs backtest expectations         │
│    • If divergence > 30% → auto-pause agent                 │
│    • Alert ops team for investigation                        │
│    • Prevents silent degradation                             │
│                                                               │
│  ✓ Watchdog Supervision (Hang Detection)                    │
│    • If agent doesn't respond in 60s → assume hung           │
│    • Before restart: Check for pending orders at broker      │
│    • If pending: Wait for fill/cancel (max 5 min), sync     │
│    • Auto-restart with reconciled state                      │
│    • Continue from where it left off                         │
│    • Alert ops team if reconciliation fails                  │
│                                                               │
│  ✓ Anti-Churn Logic (Flip-Flop Prevention)                  │
│    • Detect: BUY → SELL → BUY in < 1 hour                   │
│    • Force HOLD for 2 hours                                  │
│    • Prevents oscillation from noisy signals                 │
│    • Reduces transaction costs                               │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**Result:** System automatically recovers from common failure modes without human intervention.

---

### 4. EVOLUTION

> The system improves from experience without forgetting what it already knows.

```
┌─────────────────────────────────────────────────────────────┐
│                   EVOLUTION MECHANISMS                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ✓ Reflection Loop (After Every Trade)                      │
│    • Capture: P&L, slippage, Sharpe, regime                 │
│    • Analyze: "Why did this work/fail?"                     │
│    • Generate: Structured feedback (JSON)                   │
│    • Store: In training dataset for offline learning        │
│                                                               │
│  ✓ Incremental Fine-Tuning (No Catastrophic Forgetting)     │
│    • Fine-tune on new outcomes (last 1000 trades)           │
│    • LoRA (Low-Rank Adaptation) for efficient updates       │
│    • Retain base model, only update adapter weights         │
│    • Test on historical data to ensure no regression        │
│    • Each model version is deterministic within itself      │
│                                                               │
│  ✓ Shadow Testing (Before Promotion)                        │
│    • New agent version runs in parallel (paper mode)         │
│    • Version tracking: v{major}.{minor}.{patch}-{git-sha}   │
│    • Metadata: model version, git SHA, training data hash   │
│    • Compare: Sharpe, drawdown, win rate vs production      │
│    • Duration: 1 week minimum                                │
│    • Promote only if better (no regression)                 │
│    • Automatic rollback if performance degrades             │
│                                                               │
│  ✓ Canary Deployment (Gradual Rollout)                      │
│    • 10% of decisions use new model (1 week)                │
│    • 50% of decisions use new model (1 week)                │
│    • 100% if no issues detected                             │
│    • Auto-rollback if performance degrades                  │
│                                                               │
│  ✓ Knowledge Retention (Vector Memory)                      │
│    • All past trades stored in vector DB                    │
│    • Retention: 2 years active, 5 years archived (S3)       │
│    • Similarity search with HNSW index (sub-100ms)          │
│    • Monthly cleanup of duplicate/low-value embeddings      │
│    • Agents learn from all past experiences                 │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**Result:** System continuously improves from experience while maintaining all historical knowledge.

---

## 1. Master Intelligence Loop (Every 5 Minutes)

**Purpose:** Centralized data gathering and context creation. Fetch once, broadcast to thousands.

```
┌──────────────────────────────────────────────────────────┐
│                  TIMER (Every 5 min)                      │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│         STAGE 1: RAW FEED INGESTION (Parallel)           │
│  • Exchange Direct Feeds (WebSocket/UDP multicast)       │
│  • Premium Aggregators (Exegy, Bloomberg Terminal API)   │
│  • Alternative Data (News, social, economic calendars)   │
│  Latency: <10s                                           │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        STAGE 2: NORMALIZATION & TIMESTAMPING             │
│  • Nanosecond precision timestamps                       │
│  • Symbol normalization across exchanges                 │
│  • Quality checks (stale data, outliers)                 │
│  Latency: <2s                                            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│      STAGE 3: FEATURE EXTRACTION (GPU-Accelerated)       │
│  • Technical indicators (RSI, MACD, EMA, Bollinger)      │
│  • Order book imbalance, depth analysis                  │
│  • Funding rates, open interest                          │
│  • Cross-asset correlations (rolling windows)            │
│  Latency: <15s (GPU offload for HFT path)               │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│      STAGE 4: ALTERNATIVE DATA LAYER (Parallel)          │
│  • News scraping (Reuters, Bloomberg, AP)                │
│  • Social sentiment (Reddit, Twitter/X, StockTwits)      │
│  • NLP sentiment scoring (FinBERT, custom models)        │
│  • Economic data (Fed, ECB, BoJ announcements)           │
│  Latency: <20s (parallel scraping with timeout)          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│             STAGE 5: CONTEXT PACKAGER                    │
│  • Build rich JSONB object with all data                 │
│  • Add sequence number for gap detection                 │
│  • Compress with gzip for large contexts                 │
│  Latency: <5s                                            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│             STAGE 6: REDIS BROADCAST                     │
│  • Publish to "market:updates" channel (pub/sub)         │
│  • Cache in "market:context:latest" (5-min TTL)          │
│  • Sequence tracking for gap detection                   │
│  Latency: <1s (sub-millisecond fanout)                   │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        STAGE 7: PERSISTENCE & METRICS                    │
│  • Store in TimescaleDB/ClickHouse for backtesting       │
│  • Update Prometheus metrics (cycle time, data quality)  │
│  • Alert if cycle time > 60s                             │
│  Latency: <5s (async, non-blocking)                      │
└──────────────────────────────────────────────────────────┘
```

**Total Latency:** <60s (target: 45s) → <50ms on HFT path

**High Availability:**

- Hot standby Master Engine monitors primary via Redis lock
- Failover <5s if primary fails
- Agents continue receiving broadcasts seamlessly

---

## 2. Strategy Agent Cycle (Per Agent, Throttled)

**Purpose:** Persistent agents analyze, debate, and execute trades based on conviction.

```
┌──────────────────────────────────────────────────────────┐
│          REDIS BROADCAST RECEIVED (from Master)           │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│             THROTTLING CHECK (Plan-Based)                │
│  • Starter: Every 60 min                                 │
│  • Pro: Every 20 min                                     │
│  • Enterprise: Every 10 min                              │
│  • HFT: Every 10 sec or less                             │
│  Skip cycle if too soon since last process               │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        LOAD PORTFOLIO + MEMORY (Vector Search)           │
│  • Current positions, exposure, unrealized P&L           │
│  • VaR, drawdown, correlation matrix                     │
│  • Vector memory: Past trades, outcomes, regimes         │
│  Latency: <2s                                            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        ASSET FILTER (Whitelist + Liquidity Gate)         │
│  • Only symbols in tenant's whitelist                    │
│  • Filter out low-liquidity assets (volume < threshold)  │
│  • Apply sector/exposure limits                          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        PARALLEL ANALYST COUNCIL (4 Agents)               │
│                                                           │
│  ┌────────────────┐  ┌────────────────┐                 │
│  │  JIM           │  │  RAY           │                 │
│  │  (Statistical) │  │  (ML Signals)  │                 │
│  │  • Z-scores    │  │  • Price target│                 │
│  │  • Mean revert │  │  • Funding rate│                 │
│  │  • Regime      │  │  • Liq heatmap │                 │
│  │  Conv: 0-1     │  │  Conv: 0-1     │                 │
│  └────────────────┘  └────────────────┘                 │
│                                                           │
│  ┌────────────────┐  ┌────────────────┐                 │
│  │  KAREN         │  │  QUANT         │                 │
│  │  (Risk)        │  │  (Liquidity)   │                 │
│  │  • VaR calc    │  │  • Slippage    │                 │
│  │  • Drawdown    │  │  • Order book  │                 │
│  │  • Stress test │  │  • VWAP plan   │                 │
│  │  Conv: 0-1     │  │  Conv: 0-1     │                 │
│  └────────────────┘  └────────────────┘                 │
│                                                           │
│  • True parallel execution (Promise.all)                 │
│  • Timeout per analyst: 8s (fail fast)                   │
│  • If timeout → use last known recommendation            │
│  • Cache common calculations (indicators, VaR)           │
│  Latency: 5-8s (95th percentile)                         │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│           JUDGE AGENT (Consensus + Risk Check)           │
│  • PRIORITY ORDER (highest to lowest):                   │
│    1. Karen VETO (risk limits) → REJECT (absolute)       │
│    2. Quant VETO (liquidity) → REJECT (absolute)         │
│    3. Multi-agent consensus → APPROVE if thresholds met  │
│    4. Confidence threshold → HOLD if below minimum       │
│  • Karen/Quant vetoes cannot be overridden by consensus  │
│  • Log veto reason for post-trade analysis               │
│  Latency: 5-10s                                          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│                  DECISION GATE                           │
│  • HOLD / No edge → Log + end cycle                      │
│  • APPROVED → Continue to execution                      │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        RISK & SIZE VALIDATOR (Final Check)               │
│  • Dynamic leverage (based on volatility)                │
│  • Position cap (% of portfolio)                         │
│  • Monte Carlo simulation (fat-tail risk)                │
│  • Anti-churn check (don't flip-flop)                    │
│  Latency: <2s                                            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│            EXECUTION AGENT (Broker Adapter)              │
│  • Broker API with retry logic (3 attempts, exp backoff) │
│  • Timeout: 30s per attempt (90s total)                  │
│  • Failure handling:                                     │
│    - API timeout → SKIP CYCLE, alert ops                 │
│    - Order rejected → Log reason, HOLD                   │
│    - Partial fill → Accept partial, adjust tracking      │
│    - Network partition → Switch to backup broker         │
│  • Health check every 60s (ping broker API)              │
│  • Automatic broker failover if primary down >5 min      │
│  Latency: <5s (broker-dependent)                         │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        CONFIRMATION & JOURNAL (Audit Trail)              │
│  • Store trade + exit plan + AI reasoning                │
│  • Immutable audit log (for compliance)                  │
│  • Push notification to user                             │
│  • Update dashboard                                      │
└──────────────────────────────────────────────────────────┘
```

**Total Latency:** <30s (target: 22s) → <500ms on optimized path

---

## 3. Post-Trade Reflection Loop (After Every Trade)

**Purpose:** Self-improvement. Agents learn from outcomes and fine-tune models.

```
┌──────────────────────────────────────────────────────────┐
│            TRADE EXECUTED + CLOSED (Trigger)              │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│            OUTCOME CAPTURE (Structured Data)             │
│  • P&L (realized, %)                                     │
│  • Slippage (expected vs actual)                         │
│  • Realized Sharpe ratio                                 │
│  • Regime at time of trade (bull/bear/sideways)          │
│  • Analyst recommendations (what each agent said)        │
│  • Judge decision (why this trade was chosen)            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        REFLECTION AGENT (Root Cause Analysis)            │
│  • "Why did this work/fail?"                             │
│  • "What would we change?"                               │
│  • "Which analyst was most accurate?"                    │
│  • "Was the sizing correct?"                             │
│  • "Did we exit at the right time?"                      │
│  Output: Structured feedback (JSON)                      │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        FEEDBACK TO ANALYSTS (Model Fine-Tuning)          │
│  • Update agent prompts (if pattern detected)            │
│  • Fine-tune smaller models (distilled → ONNX)           │
│  • Adjust risk parameters (if drawdown exceeded)         │
│  • Update sizing logic (if slippage too high)            │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        REINFORCEMENT SIGNAL (RLHF-Style Reward)          │
│  • Reward to Judge (if trade was profitable)             │
│  • Penalty to Judge (if trade was unprofitable)          │
│  • Update sizing logic (PPO or similar RL algorithm)     │
│  • Store in training dataset for offline learning        │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        OFFLINE RESEARCH LOOP (Nightly/Weekly)            │
│  • Synthetic data generation for edge cases:             │
│    - Flash crashes (10% drop in 5 min)                   │
│    - Liquidity crises (order book depth <10% normal)     │
│    - Correlation breakdowns (divergence events)          │
│    - Black swan events (6-sigma moves)                   │
│  • Backtest new variants (what if different stops?)      │
│  • Hyperparameter tuning (grid search on risk params)    │
│  • Generate new alpha ideas (agents propose strategies)  │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│        VERSION CONTROL (Shadow Testing)                  │
│  • New agent version deployed in shadow mode (paper)     │
│  • Run in parallel with production for 1 week            │
│  • Compare performance (Sharpe, drawdown, win rate)      │
│  • If better, promote to production (canary → full)      │
└──────────────────────────────────────────────────────────┘
```

**Frequency:**

- Real-time for high-conviction trades (>0.8 conviction)
- Batch processing for low-conviction trades (nightly)
- Full model retrain: Weekly

---

## 4. Global Risk Oversight (Continuous + Daily)

**Purpose:** Real-time risk monitoring, circuit breakers, performance attribution.

```
┌──────────────────────────────────────────────────────────┐
│           EVERY 1 MINUTE (Real-Time Risk Sweep)           │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│           GLOBAL RISK ENGINE (Aggregate Metrics)         │
│  • Total exposure (long + short)                         │
│  • Cross-agent correlation (are all agents long BTC?)    │
│  • Liquidity stress (can we exit all positions in 1hr?)  │
│  • VaR (95% confidence, 1-day horizon)                   │
│  • Current drawdown (from peak)                          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│            CIRCUIT BREAKERS (Priority Order)             │
│  • PRIORITY 1: Liquidity crisis → EMERGENCY EXIT (all)   │
│  • PRIORITY 2: Drawdown > 10% → HALT new trades          │
│  • PRIORITY 3: Volatility > 3x → REDUCE positions 50%   │
│  • PRIORITY 4: Correlation > 0.9 → CLOSE same-direction │
│  • Execute highest priority action only                  │
│  • Re-evaluate after 5 minutes                           │
│  • Require manual approval to resume normal trading      │
│  Alert: PagerDuty + Slack + SMS                          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│           DAILY ATTRIBUTION REPORT (EOD)                 │
│  • Per-analyst performance (Jim: +2.3%, Ray: -0.5%)      │
│  • Per-strategy Sharpe ratio                             │
│  • Regime contribution (bull: +5%, bear: -2%)            │
│  • Slippage analysis (expected vs actual)                │
│  • Top winners/losers (which trades made/lost most)      │
│  Output: PDF report + dashboard                          │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│           HUMAN REVIEW GATE (Fund Manager)               │
│  • Dashboard flags outliers (unusual trades, drawdown)   │
│  • Manual override capability (pause specific agent)     │
│  • Compliance check (did we follow risk limits?)         │
│  • Investor communication (monthly letter)               │
└────────────────────┬─────────────────────────────────────┘
                     │
                     ▼
┌──────────────────────────────────────────────────────────┐
│            AUDIT LOG (Immutable Record)                  │
│  • Every decision + reasoning stored                     │
│  • Blockchain-style hash chain (tamper-proof)            │
│  • Regulatory compliance (MiFID II, SEC)                 │
│  • Investor transparency (show all trades + rationale)   │
└──────────────────────────────────────────────────────────┘
```

---

## 5. Daily Operational Rhythm (What Actually Runs)

| Time (UTC)       | Workflow                       | Who/What Runs It       | Output                          |
| ---------------- | ------------------------------ | ---------------------- | ------------------------------- |
| **00:00–00:05**  | Master Intelligence Cycle      | Master Engine          | Fresh context broadcast         |
| **Continuous**   | Tenant Worker Cycles           | All strategy agents    | Trades + journal entries        |
| **Every 15 min** | Real-time Risk Sweep           | Global Risk Engine     | Alerts if needed                |
| **04:00**        | Post-Trade Reflection Batch    | Reflection + RL Agents | Model improvements queued       |
| **08:00**        | Daily Attribution + Report     | Oversight Dashboard    | Human review + investor summary |
| **12:00**        | Offline Research & Backtesting | Research Agents        | New alpha ideas tested          |
| **23:55**        | Nightly Model Fine-tune        | Training Pipeline      | Deployed next day (shadow mode) |

---

## Latency Budget (End-to-End)

| Stage                            | Current (5-min) | Realistic Quant Target | True HFT Target | How to Achieve                   |
| -------------------------------- | --------------- | ---------------------- | --------------- | -------------------------------- |
| Market Data Ingestion            | ~seconds        | <50ms                  | <1ms            | Co-location + FPGA/UDP multicast |
| Feature Calculation              | ~seconds        | <20ms                  | <100µs          | GPU/FPGA offload                 |
| AI Analysis (4 Analysts + Judge) | ~10-25s         | <500ms                 | <5ms            | ONNX/TensorRT + smaller models   |
| Decision & Risk Check            | ~seconds        | <10ms                  | <1ms            | Rule engine + lock-free          |
| Order Execution                  | ~seconds        | <50ms                  | <10µs           | DMA + co-location                |
| **Total Tick-to-Trade**          | **Minutes**     | **<1 second**          | **<100µs**      | **Hybrid path**                  |

---

## Technology Stack Evolution

### Phase 1 (Current - Medium-Frequency)

- **Core:** Node.js + TypeScript
- **Database:** PostgreSQL + TimescaleDB
- **Cache:** Redis (pub/sub, caching)
- **Vector DB:** Pinecone or Weaviate
- **LLM:** GPT-4, Claude 3.5 Sonnet, Gemini 1.5 Pro
- **Broker:** Alpaca (paper trading)

### Phase 2 (6 Months - Low-Latency)

- **Hot Paths:** Rust/C++ (feature extraction, portfolio optimization)
- **Inference:** ONNX Runtime + TensorRT (sub-ms model inference)
- **GPU:** NVIDIA H100/A100 (parallel feature calculation)
- **Data:** Direct exchange feeds (co-location)
- **Broker:** Interactive Brokers (DMA via FIX)

### Phase 3 (12 Months - HFT)

- **Execution:** FPGA (Xilinx Alveo, Intel Stratix) for tick-to-trade
- **Networking:** Kernel bypass (DPDK, efvi), Solarflare NICs
- **Co-location:** Equinix NY4, LD4, TY3
- **Connectivity:** Microwave/fiber for inter-market arbitrage

---

## Disaster Recovery Plan

### RTO/RPO Targets

- **RTO (Recovery Time Objective):** 15 minutes
- **RPO (Recovery Point Objective):** 5 minutes (max data loss)

### Backup Strategy

- **Database:** Continuous streaming replication to standby
- **Redis:** AOF persistence + hourly snapshots to S3
- **Vector DB:** Daily full backup + incremental every 6h
- **Code:** Git + Docker images in ECR
- **Secrets:** AWS Secrets Manager with cross-region replication

### Failure Scenarios

**Scenario 1: Primary Database Failure**

- Automatic failover to standby (30s)
- Agents reconnect automatically
- Max data loss: 5 minutes (last checkpoint)

**Scenario 2: Redis Cluster Failure**

- Agents switch to direct database queries (degraded mode)
- Performance impact: 2-3x slower cycles
- Restore Redis from latest snapshot (5-10 min)

**Scenario 3: Complete Data Center Outage**

- Failover to secondary region (AWS us-west-2)
- DNS update (5 min propagation)
- Restore from latest backups
- Manual verification before resuming trading

**Scenario 4: Vector DB Data Loss**

- Rebuild from trade history (2-4 hours)
- Use cold start mode during rebuild
- Gradual ramp after rebuild complete

---

## Cost Estimates (Monthly)

### LLM Costs (Claude 3.5 Sonnet)

- Cycles: 144/day (10-min intervals) × 5 LLM calls = 720 calls/day
- Input: 2000 tokens/call × 720 × 30 = 43.2M tokens/month
- Output: 500 tokens/call × 720 × 30 = 10.8M tokens/month
- Cost: (43.2M × $3/1M) + (10.8M × $15/1M) = $129.6 + $162 = **$292/month**

### Infrastructure

- Database (RDS): $200/month
- Redis (ElastiCache): $150/month
- Vector DB (Pinecone): $300/month
- Compute (EC2): $400/month
- S3 + Backups: $50/month
- **Total Infrastructure: $1,100/month**

### Total Monthly Cost: **~$1,400/month**

### Cost Optimization

- Cache common prompts → Save 30%
- Batch low-priority analyses → Save 20%
- Use smaller models for simple tasks → Save 15%
- **Optimized: ~$900/month**
