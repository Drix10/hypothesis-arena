# Multi-Tenant SaaS Architecture - Centralized Intelligence Model

## Overview

This document details the complete architecture for Hypothesis Arena's production-grade multi-tenant SaaS platform using a **Centralized Intelligence Model** that delivers 83% cost efficiency compared to traditional per-tenant architectures.

## Architecture Philosophy

### Centralized Intelligence Model

**Our Approach:**

- **ONE Master Engine** gathers ALL market data once
- **ONE scraping operation** for news, sentiment, and market intelligence
- Master broadcasts comprehensive "Market Context" to all tenants
- Each tenant runs AI analysis on shared context with their portfolio
- Result: Fixed data cost + linear AI scaling = 83% cost efficiency

**Cost Structure:**

```
Single data gathering: $0.50/cycle (shared across all tenants)
Per-tenant AI analysis: $0.10/cycle (scales linearly)
100 tenants: $10.50/cycle × 288 cycles/day = $3,024/day
Cost per tenant: $30.24/day
```

**Key Benefits:**

- 83% more cost-efficient than per-tenant data gathering
- Consistent market intelligence across all users
- Linear cost scaling with tenant growth
- Simplified infrastructure and maintenance

---

## System Architecture

### Current (Single-Tenant)

```
User → Node.js Server → WEEX API
                      → AI Providers (Gemini/OpenRouter)
                      → SQLite DB
                      → Redis (optional)
```

### Target (Multi-Tenant SaaS with Centralized Intelligence)

```
                    ┌─────────────────────────┐
                    │  MASTER ENGINE          │
                    │  (Single Instance)      │
                    │                         │
                    │  - Scrape ALL markets   │
                    │  - Gather ALL news      │
                    │  - Calculate indicators │
                    │  - Package context      │
                    └────────┬────────────────┘
                             │
                             │ Broadcast via Redis
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
        ┌─────────┐    ┌─────────┐    ┌─────────┐
        │Tenant A │    │Tenant B │    │Tenant C │
        │Worker   │    │Worker   │    │Worker   │
        │         │    │         │    │         │
        │- Get    │    │- Get    │    │- Get    │
        │  Context│    │  Context│    │  Context│
        │- Run AI │    │- Run AI │    │- Run AI │
        │- Execute│    │- Execute│    │- Execute│
        └─────────┘    └─────────┘    └─────────┘
```

---

## Core Components

### 1. Master Intelligence Engine

**Purpose:** Centralized data gathering and context creation

**Responsibilities:**

- Scrape world news (Reuters, Bloomberg, AP, etc.)
- Fetch market prices (stocks, forex, crypto, commodities)
- Calculate technical indicators (RSI, MACD, EMA, etc.)
- Gather social sentiment (Twitter, Reddit, StockTwits)
- Analyze cross-asset correlations
- Package into "Market Context" object
- Broadcast to all tenant workers

**Implementation:**

```typescript
// src/services/master/MasterIntelligenceEngine.ts

export class MasterIntelligenceEngine {
  private browserPool: BrowserPoolService;
  private redis: Redis;
  private isRunning = false;
  private cycleInterval = 300000; // 5 minutes

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Master engine already running");
    }

    this.isRunning = true;
    console.log(
      "Master Intelligence Engine started - Broadcasting every 5 minutes",
    );

    // Run immediately, then on interval
    await this.runCycle();
    setInterval(() => this.runCycle(), this.cycleInterval);
  }

  private async runCycle(): Promise<void> {
    const startTime = Date.now();
    console.log(`[Master] Starting cycle at ${new Date().toISOString()}`);

    try {
      // Stage 1: Gather ALL market data
      const marketData = await this.gatherMarketData();

      // Stage 2: Gather ALL intelligence
      const intelligence = await this.gatherIntelligence();

      // Stage 3: Calculate indicators
      const indicators = await this.calculateIndicators(marketData);

      // Stage 4: Analyze correlations
      const correlations = await this.analyzeCorrelations(marketData);

      // Stage 5: Package Market Context
      const marketContext: MarketContext = {
        timestamp: new Date().toISOString(),
        version: "1.0",
        markets: marketData,
        intelligence,
        indicators,
        correlations,
        metadata: {
          cycleTime: Date.now() - startTime,
          dataPoints: this.countDataPoints(marketData),
        },
      };

      // Stage 6: Broadcast to Redis
      await this.broadcastContext(marketContext);

      // Stage 7: Store in database for historical analysis
      await this.storeContext(marketContext);

      console.log(`[Master] Cycle completed in ${Date.now() - startTime}ms`);
    } catch (error) {
      console.error("[Master] Cycle failed:", error);
      // Don't crash - log and continue to next cycle
    }
  }

  private async gatherMarketData(): Promise<MarketData> {
    // Fetch prices from multiple sources in parallel
    const [stocks, forex, crypto, commodities] = await Promise.all([
      this.fetchStockPrices(),
      this.fetchForexPrices(),
      this.fetchCryptoPrices(),
      this.fetchCommodityPrices(),
    ]);

    return { stocks, forex, crypto, commodities };
  }

  private async gatherIntelligence(): Promise<Intelligence> {
    // Scrape news and sentiment in parallel
    const [news, sentiment, economic] = await Promise.all([
      this.scrapeWorldNews(),
      this.gatherSocialSentiment(),
      this.fetchEconomicData(),
    ]);

    return { news, sentiment, economic };
  }

  private async broadcastContext(context: MarketContext): Promise<void> {
    // Store in Redis with 10-minute TTL
    await this.redis.setex(
      "market:context:latest",
      600,
      JSON.stringify(context),
    );

    // Publish to pub/sub channel for real-time updates
    await this.redis.publish("market:updates", JSON.stringify(context));

    console.log(`[Master] Broadcasted context to all tenants`);
  }

  private async scrapeWorldNews(): Promise<NewsArticle[]> {
    const sources = [
      "https://www.reuters.com/markets",
      "https://www.bloomberg.com/markets",
      "https://www.cnbc.com/world-markets",
    ];

    const articles = await Promise.all(
      sources.map((url) => this.browserPool.scrapeNews(url)),
    );

    return articles.flat();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    console.log("Master Intelligence Engine stopped");
  }
}

// Market Context structure
export interface MarketContext {
  timestamp: string;
  version: string;
  markets: MarketData;
  intelligence: Intelligence;
  indicators: Indicators;
  correlations: Correlations;
  metadata: {
    cycleTime: number;
    dataPoints: number;
  };
}

export interface MarketData {
  stocks: Record<string, AssetPrice>;
  forex: Record<string, AssetPrice>;
  crypto: Record<string, AssetPrice>;
  commodities: Record<string, AssetPrice>;
}

export interface AssetPrice {
  symbol: string;
  price: number;
  change24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  timestamp: string;
}

export interface Intelligence {
  news: NewsArticle[];
  sentiment: SentimentData;
  economic: EconomicData;
}
```

### 2. Tenant Worker

**Purpose:** Execute trades for individual tenants based on shared market context

**Responsibilities:**

- Subscribe to Market Context from Master Engine
- Load tenant's portfolio and risk settings
- Filter context to tenant's asset universe
- Run 4 AI analysts on filtered context
- Judge picks best recommendation
- Apply tenant's risk limits
- Execute trade via tenant's broker
- Update tenant's portfolio

**Implementation:**

```typescript
// src/services/tenant/TenantWorker.ts

export class TenantWorker {
  private tenantId: string;
  private redis: Redis;
  private isRunning = false;
  private lastContextTimestamp: string | null = null;

  constructor(tenantId: string) {
    this.tenantId = tenantId;
    this.redis = RedisConnectionManager.getClient();
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error(`Worker for tenant ${this.tenantId} already running`);
    }

    this.isRunning = true;
    console.log(`[Tenant ${this.tenantId}] Worker started`);

    // Subscribe to market updates
    const subscriber = this.redis.duplicate();
    await subscriber.subscribe("market:updates");

    subscriber.on("message", async (channel, message) => {
      if (channel === "market:updates") {
        await this.handleMarketUpdate(JSON.parse(message));
      }
    });

    // Also poll Redis every minute as fallback
    setInterval(() => this.pollMarketContext(), 60000);
  }

  private async handleMarketUpdate(context: MarketContext): Promise<void> {
    // Prevent duplicate processing
    if (context.timestamp === this.lastContextTimestamp) {
      return;
    }

    this.lastContextTimestamp = context.timestamp;

    console.log(
      `[Tenant ${this.tenantId}] Received market context: ${context.timestamp}`,
    );

    try {
      // Check if tenant should process this cycle based on plan tier
      const shouldProcess = await this.shouldProcessCycle(context.timestamp);
      if (!shouldProcess) {
        console.log(
          `[Tenant ${this.tenantId}] Skipping cycle due to plan tier throttling`,
        );
        return;
      }

      await this.processTradingCycle(context);
    } catch (error) {
      console.error(`[Tenant ${this.tenantId}] Cycle failed:`, error);
      // Log error but don't crash worker
    }
  }

  private async shouldProcessCycle(timestamp: string): Promise<boolean> {
    // Load tenant's plan tier and last processing time
    const tenant = await this.loadTenantConfig();
    const lastProcessedAt = await this.getLastProcessedTime();

    // Calculate minimum interval based on plan tier
    const intervals = {
      STARTER: 60 * 60 * 1000, // 60 minutes
      PRO: 20 * 60 * 1000, // 20 minutes
      ENTERPRISE: 10 * 60 * 1000, // 10 minutes
    };

    const minInterval = intervals[tenant.planTier] || intervals.STARTER;
    const now = new Date(timestamp).getTime();

    // Allow processing if enough time has passed
    return !lastProcessedAt || now - lastProcessedAt >= minInterval;
  }

  private async processTradingCycle(
    globalContext: MarketContext,
  ): Promise<void> {
    // Step 1: Load tenant configuration
    const tenant = await this.loadTenantConfig();

    if (!tenant.isActive) {
      console.log(`[Tenant ${this.tenantId}] Inactive, skipping cycle`);
      return;
    }

    // Step 2: Load tenant's portfolio
    const portfolio = await this.loadPortfolio();

    // Step 3: Filter market context to tenant's universe
    const filteredContext = this.filterContextToPortfolio(
      globalContext,
      portfolio,
    );

    // Step 4: Check if tenant should trade (plan limits, schedule, etc.)
    const canTrade = await this.checkTradingEligibility(tenant);

    if (!canTrade) {
      console.log(`[Tenant ${this.tenantId}] Not eligible to trade`);
      return;
    }

    // Step 5: Run AI analysis
    const analysis = await this.runAIAnalysis(filteredContext, portfolio);

    // Step 6: Apply risk limits
    const decision = await this.applyRiskLimits(analysis, tenant, portfolio);

    // Step 7: Execute trade if decision is not HOLD
    if (decision.action !== "HOLD") {
      await this.executeTrade(decision, tenant);
    }

    // Step 8: Update metrics
    await this.updateMetrics(tenant, decision);
  }

  private filterContextToPortfolio(
    context: MarketContext,
    portfolio: Portfolio,
  ): MarketContext {
    // Filter to only assets in tenant's universe
    const filteredMarkets: MarketData = {
      stocks: {},
      forex: {},
      crypto: {},
      commodities: {},
    };

    // If tenant trades stocks, include stock data
    if (portfolio.assetClasses.includes("stocks")) {
      for (const symbol of portfolio.symbols.stocks || []) {
        if (context.markets.stocks[symbol]) {
          filteredMarkets.stocks[symbol] = context.markets.stocks[symbol];
        }
      }
    }

    // Same for other asset classes
    if (portfolio.assetClasses.includes("crypto")) {
      for (const symbol of portfolio.symbols.crypto || []) {
        if (context.markets.crypto[symbol]) {
          filteredMarkets.crypto[symbol] = context.markets.crypto[symbol];
        }
      }
    }

    // Return filtered context
    return {
      ...context,
      markets: filteredMarkets,
    };
  }

  private async runAIAnalysis(
    context: MarketContext,
    portfolio: Portfolio,
  ): Promise<AnalysisResult> {
    // Run 4 analysts in parallel (same as current system)
    const [jim, ray, karen, quant] = await Promise.all([
      this.runJimAnalyst(context, portfolio),
      this.runRayAnalyst(context, portfolio),
      this.runKarenAnalyst(context, portfolio),
      this.runQuantAnalyst(context, portfolio),
    ]);

    // Judge picks best recommendation
    const decision = await this.runJudge([jim, ray, karen, quant]);

    return decision;
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    console.log(`[Tenant ${this.tenantId}] Worker stopped`);
  }
}
```

### 3. Worker Manager

**Purpose:** Manage lifecycle of tenant workers

```typescript
// src/services/tenant/TenantWorkerManager.ts

export class TenantWorkerManager {
  private workers = new Map<string, Worker>();
  private readonly MAX_WORKERS_PER_NODE = 100; // 100 workers per node, scale horizontally for more

  async startTenant(tenantId: string): Promise<void> {
    // Check if already running
    if (this.workers.has(tenantId)) {
      console.log(`Worker for tenant ${tenantId} already running`);
      return;
    }

    // Check capacity
    if (this.workers.size >= this.MAX_WORKERS_PER_NODE) {
      throw new Error(
        "Worker capacity reached on this node - scale horizontally",
      );
    }

    // Get tenant's plan for resource limits
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { planTier: true },
    });

    const limits = PLAN_LIMITS[tenant?.planTier || "STARTER"];

    // Spawn worker thread
    const worker = new Worker("./TenantWorker.js", {
      workerData: { tenantId },
      resourceLimits: {
        maxOldGenerationSizeMb: limits.memoryLimitMB,
        maxYoungGenerationSizeMb: Math.floor(limits.memoryLimitMB / 4),
      },
    });

    // Set up monitoring
    const workerInfo: WorkerInfo = {
      worker,
      tenantId,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    worker.on("message", (msg) => {
      if (msg.type === "heartbeat") {
        workerInfo.lastHeartbeat = Date.now();
      }
    });

    worker.on("error", (err) => {
      console.error(`Worker error for tenant ${tenantId}:`, err);
      this.restartWorker(tenantId);
    });

    worker.on("exit", (code) => {
      console.warn(`Worker exited for tenant ${tenantId} with code ${code}`);
      this.workers.delete(tenantId);
    });

    this.workers.set(tenantId, workerInfo);

    console.log(`Started worker for tenant ${tenantId}`);
  }

  async stopTenant(tenantId: string): Promise<void> {
    const workerInfo = this.workers.get(tenantId);
    if (!workerInfo) return;

    await workerInfo.worker.terminate();
    this.workers.delete(tenantId);

    console.log(`Stopped worker for tenant ${tenantId}`);
  }

  async stopAll(): Promise<void> {
    const promises = Array.from(this.workers.keys()).map((tenantId) =>
      this.stopTenant(tenantId),
    );
    await Promise.all(promises);
  }

  getWorkerCount(): number {
    return this.workers.size;
  }

  getWorkerStatus(tenantId: string): WorkerStatus | null {
    const workerInfo = this.workers.get(tenantId);
    if (!workerInfo) return null;

    return {
      tenantId,
      uptime: Date.now() - workerInfo.startedAt,
      lastHeartbeat: workerInfo.lastHeartbeat,
      isHealthy: Date.now() - workerInfo.lastHeartbeat < 60000,
    };
  }
}
```

---

## Data Models

### Core Tables

```prisma
// prisma/schema.prisma

model Tenant {
  id              String   @id @default(cuid())
  name            String
  email           String   @unique
  planTier        PlanTier @default(STARTER)
  status          TenantStatus @default(TRIAL)
  apiKeyHash      String   @unique

  // Billing
  stripeCustomerId     String?  @unique
  stripeSubscriptionId String?
  trialEndsAt          DateTime?

  // Metadata
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  lastActiveAt    DateTime?

  // Relations
  portfolio       Portfolio?
  brokerConfigs   BrokerConfig[]
  trades          Trade[]
  positions       Position[]
  auditLogs       AuditLog[]

  @@index([status, planTier])
  @@index([apiKeyHash])
  @@index([email])
}

model Portfolio {
  id                String @id @default(cuid())
  tenantId          String @unique
  tenant            Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  // Asset allocation
  assetClasses      String[] // ["stocks", "forex", "crypto", "commodities"]

  // Symbols by asset class
  symbols           Json // { stocks: ["AAPL", "TSLA"], crypto: ["BTC", "ETH"], ... }

  // Risk settings
  maxPositionSizePercent Float @default(20.0) @db.Real
  stopLossPercent   Float @default(2.5) @db.Real
  takeProfitPercent Float @default(5.0) @db.Real
  maxDrawdownPercent Float @default(10.0) @db.Real
  maxConcurrentPositions Int @default(3) @db.SmallInt
  maxDailyTrades    Int @default(20) @db.SmallInt

  // AI settings
  aiProvider        String @default("gemini") @db.VarChar(50)
  aiModel           String @default("gemini-1.5-pro") @db.VarChar(100)
  minConfidence     Int @default(50) @db.SmallInt

  // Schedule
  tradingSchedule   Json? // { enabled: true, timezone: "UTC", hours: [9-17] }

  isActive          Boolean @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([tenantId, isActive])

  @@check(maxConcurrentPositions >= 1 AND maxConcurrentPositions <= 50)
  @@check(maxDailyTrades >= 1 AND maxDailyTrades <= 1000)
  @@check(maxPositionSizePercent >= 1 AND maxPositionSizePercent <= 100)
}

model MarketContext {
  id                String @id @default(cuid())
  timestamp         DateTime @unique
  version           String @default("1.0")

  // Market data (JSONB for flexibility)
  markets           Json
  intelligence      Json
  indicators        Json
  correlations      Json

  // Metadata
  cycleTime         Int // milliseconds
  dataPoints        Int

  createdAt         DateTime @default(now())

  @@index([timestamp(sort: Desc)])

  // NOTE: No tenant_id - this is GLOBAL data
  // All tenants read from this table
}

model Trade {
  id                String @id @default(cuid())
  tenantId          String
  tenant            Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  // Trade details
  symbol            String @db.VarChar(50)
  assetClass        AssetClass
  action            TradeAction
  side              TradeSide
  quantity          Float @db.Real
  entryPrice        Float @db.Real
  exitPrice         Float? @db.Real

  // P&L
  realizedPnl       Float? @db.Real
  realizedPnlPercent Float? @db.Real

  // Metadata
  analystWinner     String? @db.VarChar(50)
  confidence        Int @db.SmallInt
  reasoning         String? @db.Text

  // Status
  status            TradeStatus @default(PENDING)
  openedAt          DateTime @default(now())
  closedAt          DateTime?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt

  @@index([tenantId, openedAt(sort: Desc)])
  @@index([tenantId, status])
  @@index([tenantId, assetClass])
  @@index([tenantId, symbol])

  @@check(quantity > 0)
  @@check(entryPrice > 0)
  @@check(confidence >= 0 AND confidence <= 100)
}

enum AssetClass {
  STOCK
  FOREX
  CRYPTO
  COMMODITY
  INDEX
}

enum PlanTier {
  STARTER
  PRO
  ENTERPRISE
}

enum TenantStatus {
  TRIAL
  ACTIVE
  SUSPENDED
  CANCELLED
}
```

---

## Multi-Tenancy Strategy

### 1. Row-Level Security (RLS)

```sql
-- Enable RLS on tenant-scoped tables
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY tenant_isolation ON trades
  USING (tenant_id = current_setting('app.current_tenant')::UUID);

-- market_context table has NO RLS - it's global
-- All tenants can read from it
```

### 2. Prisma Middleware

```typescript
import { AsyncLocalStorage } from "async_hooks";

const tenantContext = new AsyncLocalStorage<string>();

export function setTenantContext(tenantId: string): void {
  tenantContext.enterWith(tenantId);
}

export function getTenantContext(): string {
  const tenantId = tenantContext.getStore();
  if (!tenantId) {
    throw new Error("Tenant context not set");
  }
  return tenantId;
}

// Prisma middleware
prisma.$use(async (params, next) => {
  const tenantId = getTenantContext();

  // Skip for global tables
  if (params.model === "MarketContext") {
    return next(params);
  }

  // Apply tenant scoping for tenant tables
  if (TENANT_SCOPED_MODELS.includes(params.model)) {
    if (
      ["findMany", "findFirst", "findUnique", "update", "delete"].includes(
        params.action,
      )
    ) {
      params.args.where = {
        AND: [params.args.where || {}, { tenantId }],
      };
    }

    if (params.action === "create") {
      params.args.data = { ...params.args.data, tenantId };
    }
  }

  return next(params);
});
```

---

## Resource Allocation by Plan Tier

```typescript
export const PLAN_LIMITS = {
  STARTER: {
    // Trading
    maxConcurrentPositions: 3,
    maxDailyTrades: 20,
    assetClasses: ["crypto"], // Crypto only

    // AI
    aiCallsPerHour: 60,
    aiModel: "gemini-1.5-flash",

    // Resources
    memoryLimitMB: 512,
  },

  PRO: {
    maxConcurrentPositions: 10,
    maxDailyTrades: 100,
    assetClasses: ["stocks", "crypto"], // Stocks + Crypto

    aiCallsPerHour: 300,
    aiModel: "gemini-1.5-pro",

    memoryLimitMB: 2048,
  },

  ENTERPRISE: {
    maxConcurrentPositions: 50,
    maxDailyTrades: -1, // unlimited
    assetClasses: ["stocks", "forex", "crypto", "commodities"], // All

    aiCallsPerHour: -1,
    aiModel: "claude-3-opus",

    memoryLimitMB: 8192,
  },
} as const;
```

---

## Security Considerations

### 1. Tenant Isolation

- **Database:** RLS on all tenant tables
- **Workers:** Separate worker thread per tenant
- **Broker Keys:** Encrypted per-tenant
- **Market Context:** Global (read-only for all)

### 2. Market Context Security

**Q: Can tenants tamper with market context?**  
**A:** No - market_context table is read-only for tenants

```sql
-- Only Master Engine can write
GRANT SELECT ON market_context TO tenant_role;
GRANT INSERT, UPDATE ON market_context TO master_engine_role;
```

### 3. Worker Isolation

Each tenant worker:

- Runs in separate thread
- Has resource limits (CPU, memory)
- Cannot access other tenants' data
- Crash doesn't affect others

---

## Performance Optimization

### 1. Caching Strategy

```typescript
// Master Engine caches expensive operations
class MasterIntelligenceEngine {
  private cache = new Map<string, CachedData>();

  private async fetchStockPrices(): Promise<Record<string, AssetPrice>> {
    const cacheKey = "stocks:prices";
    const cached = this.cache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    const data = await this.fetchFromAPI();
    this.cache.set(cacheKey, {
      data,
      expiresAt: Date.now() + 60000, // 1 min
    });

    return data;
  }
}
```

### 2. Efficient Broadcasting

```typescript
// Use Redis pub/sub for real-time updates
await redis.publish("market:updates", JSON.stringify(context));

// Also store in Redis for polling fallback
await redis.setex("market:context:latest", 600, JSON.stringify(context));
```

### 3. Worker Efficiency

```typescript
// Workers only process new contexts
private lastContextTimestamp: string | null = null;

private async handleMarketUpdate(context: MarketContext): Promise<void> {
  if (context.timestamp === this.lastContextTimestamp) {
    return; // Skip duplicate
  }

  this.lastContextTimestamp = context.timestamp;
  await this.processTradingCycle(context);
}
```

---

## Monitoring & Observability

### Key Metrics

**Master Engine:**

- Cycle time (target: <60 seconds)
- Data points gathered
- Broadcast latency
- Error rate

**Tenant Workers:**

- Active workers count
- Worker health (heartbeat)
- Trades executed per tenant
- AI analysis time

**System:**

- Redis pub/sub lag
- Database query performance
- Memory usage per worker

---

## Implementation Roadmap

### Phase 1: Core Infrastructure

- Master Intelligence Engine implementation
- Data gathering services (news, prices, sentiment)
- Redis broadcasting infrastructure
- Market Context packaging and distribution

### Phase 2: Tenant Workers

- Tenant Worker implementation
- Worker Manager for lifecycle management
- Redis subscription and polling
- Multi-tenant testing and validation

### Phase 3: Database & Security

- PostgreSQL schema with Row-Level Security
- Prisma middleware for tenant isolation
- Encrypted broker credential storage
- Multi-tenant isolation testing

### Phase 4: Broker Integration

- Broker adapter implementation
- Paper trading validation
- Error handling and retry logic
- Failover testing

### Phase 5: Testing & Validation

- Load testing (100+ concurrent tenants)
- Security penetration testing
- Performance profiling and optimization
- Chaos engineering scenarios

### Phase 6: Production Readiness

- API documentation
- Deployment automation
- Monitoring and alerting
- Operational runbooks

---

**Architecture:** Centralized Intelligence Model  
**Cost Efficiency:** 83% more efficient than per-tenant model  
**Scalability:** Supports 1000+ tenants on single Master Engine  
**Version:** 2.0
