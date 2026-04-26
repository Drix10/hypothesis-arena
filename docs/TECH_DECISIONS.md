# Technology Stack - Centralized Intelligence Model

This document explains every technology choice for the Hypothesis Arena SaaS platform using the **Centralized Intelligence Model**.

---

## Architecture Decision: Centralized vs Distributed Intelligence

### The Core Question

**Should each tenant gather their own market data, or should we centralize it?**

### Decision: Centralized Intelligence

**Rationale:**

1. **Cost Efficiency:** Data gathering is expensive (scraping, API calls)
2. **Consistency:** All tenants see same market state at same time
3. **Scalability:** Cost grows linearly with data sources, not with tenants
4. **Performance:** One scraping operation vs N operations

**Trade-offs:**

- ✅ 83% cost reduction
- ✅ Simpler infrastructure
- ✅ Consistent data quality
- ❌ Single point of failure (mitigated with redundancy)
- ❌ Less personalization in data gathering (but AI analysis is still personalized)

**Cost Comparison:**

| Model           | Data Gathering | AI Analysis | Total/Cycle | Daily Cost (288 cycles) |
| --------------- | -------------- | ----------- | ----------- | ----------------------- |
| **Distributed** | 100 × $0.50    | 100 × $0.10 | $60         | $17,280                 |
| **Centralized** | 1 × $0.50      | 100 × $0.10 | $10.50      | $3,024                  |
| **Savings**     |                |             | **83%**     | **$14,256/day**         |

---

## Core Stack

### Runtime & Language

**Choice:** Node.js 20+ with TypeScript 5.3+

**Why:**

- Existing codebase is Node.js/TypeScript
- Excellent async/await for I/O-heavy operations
- Worker Threads for tenant isolation
- Massive ecosystem for trading, AI, scraping
- Type safety prevents runtime errors

**Alternatives Considered:**

- Python: Better for ML, but slower for concurrent operations
- Go: Faster, but complete rewrite + smaller ecosystem
- Rust: Best performance, but steep learning curve

---

## Architecture Components

### 1. Master Intelligence Engine

**Choice:** Single Node.js process with scheduled cycles

**Why:**

- Simplicity: One process to manage
- Efficiency: No coordination overhead
- Reliability: Easy to monitor and restart
- Cost: No multi-instance coordination needed

**Implementation Pattern:**

```typescript
class MasterIntelligenceEngine {
  async start() {
    setInterval(() => this.runCycle(), 300000); // 5 min
  }

  private async runCycle() {
    const context = await this.gatherAllData();
    await this.broadcastToTenants(context);
  }
}
```

**Scaling Strategy:**

- **Vertical:** Increase CPU/RAM for more data sources
- **Horizontal:** Not needed (single instance sufficient)
- **Redundancy:** Hot standby for failover

**Alternatives Considered:**

- Distributed scraping: More complex, unnecessary for MVP
- Microservices: Overkill for single responsibility
- Serverless: Cold starts unacceptable for real-time trading

---

### 2. Tenant Workers

**Choice:** Node.js Worker Threads (one per tenant)

**Why:**

- **Isolation:** Each tenant in separate thread
- **Efficiency:** Shared memory, lower overhead than processes
- **Resource Limits:** Can set CPU/memory per worker
- **Crash Isolation:** One tenant crash doesn't affect others

**Implementation:**

```typescript
const worker = new Worker("./TenantWorker.js", {
  workerData: { tenantId },
  resourceLimits: {
    maxOldGenerationSizeMb: 512, // Starter plan
  },
});
```

**Scaling:**

- 1-100 tenants: Single worker node (100 workers max per node)
- 100-1000 tenants: 10 worker nodes
- 1000-10,000 tenants: 100 worker nodes (horizontal scaling)
- Each node handles 100 tenant workers with resource isolation

**Alternatives Considered:**

- Separate processes: More isolation, but higher overhead
- Containers per tenant: Best isolation, but complex orchestration
- Shared workers: Cheaper, but crash affects multiple tenants

---

### 3. Communication Layer

**Choice:** Redis Pub/Sub + Polling

**Why:**

- **Pub/Sub:** Real-time updates to all workers
- **Polling:** Fallback if pub/sub misses message
- **Simple:** No complex message queue needed
- **Fast:** Sub-millisecond latency

**Implementation:**

```typescript
// Master publishes
await redis.publish("market:updates", JSON.stringify(context));
await redis.setex("market:context:latest", 600, JSON.stringify(context));

// Workers subscribe
subscriber.on("message", (channel, message) => {
  this.handleMarketUpdate(JSON.parse(message));
});

// Workers also poll as fallback
setInterval(() => this.pollMarketContext(), 60000);
```

**Alternatives Considered:**

- RabbitMQ: More features, but overkill
- Kafka: Best for high throughput, but complex
- WebSockets: Requires persistent connections
- Database polling: Too slow, high DB load

---

## Database

### Primary Database

**Choice:** PostgreSQL 15+

**Why:**

- **Row-Level Security:** Built-in tenant isolation
- **JSONB:** Flexible storage for market context
- **Performance:** Handles millions of rows
- **ACID:** Critical for financial data
- **Mature:** Battle-tested at scale

**Schema Design:**

```prisma
// Tenant-scoped tables (with RLS)
model Trade {
  tenantId String
  // ... RLS enforces tenant_id filtering
}

// Global tables (no RLS)
model MarketContext {
  // No tenantId - all tenants read this
  timestamp DateTime @unique
  markets Json
}
```

**Alternatives Considered:**

- MySQL: No RLS, weaker JSON support
- MongoDB: No ACID, harder tenant isolation
- TimescaleDB: Good for time-series, but adds complexity

### ORM

**Choice:** Prisma 5+

**Why:**

- Type-safe queries
- Automatic migrations
- Middleware for tenant scoping
- Connection pooling (configured at 20 connections)
- Excellent DX

**Configuration:**

```typescript
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// Connection pool: 20 connections
// Query timeout: 30 seconds
// Statement timeout: 30 seconds
```

**Alternatives Considered:**

- TypeORM: More flexible, less type-safe
- Drizzle: Newer, less mature
- Raw SQL: Maximum control, no type safety

---

## Caching & Queue

### Cache

**Choice:** Redis 7+

**Why:**

- In-memory speed (sub-millisecond)
- Pub/Sub for broadcasting
- Atomic operations for rate limiting
- TTL for automatic expiration
- Persistence (RDB + AOF)

**Use Cases:**

```typescript
// Market context broadcasting
await redis.publish("market:updates", context);

// Caching
await redis.setex("cache:tenant:123:config", 300, data);

// Rate limiting
const count = await redis.incr("ratelimit:tenant:123");
```

**Alternatives Considered:**

- Memcached: Simpler, but no pub/sub
- In-memory: Doesn't survive restarts
- Database: Too slow for real-time

### Queue

**Choice:** BullMQ (Redis-based)

**Why:**

- Built on Redis (one less service)
- Job priorities (Enterprise > Pro > Starter)
- Retry logic with exponential backoff
- Cron-like scheduling
- Bull Board for monitoring

**Use Cases:**

- Scheduled tasks (daily reports, cleanup)
- Async operations (email, webhooks)
- Background jobs (data exports)

**Alternatives Considered:**

- RabbitMQ: More features, separate service
- AWS SQS: Vendor lock-in, higher latency
- Temporal: Overkill for simple jobs

---

## Browser Automation

### Choice:\*\* Playwright + Browserless

**Why Playwright:**

- Modern API (async/await)
- Multi-browser support
- Stealth mode built-in
- Network interception
- Better maintained than Puppeteer

**Why Browserless:**

- Managed browser pool
- Handles browser lifecycle
- Scales horizontally
- Docker-based deployment

**Usage:**

```typescript
// Master Engine uses browser pool
const articles = await browserPool.scrapeNews(url);
```

**Note:** Only Master Engine scrapes - tenant workers do NOT

**Alternatives Considered:**

- Puppeteer: Older, less features
- Selenium: Too heavy, slower
- Cheerio: No JS execution

---

## AI Providers

### Primary AI

**Choice:** Google Gemini 1.5 Pro/Flash

**Why:**

- **Cost:** Flash is cheapest ($0.075/1M tokens)
- **Speed:** Flash is fastest (~2s response)
- **Context:** 1M token context window
- **Quality:** Pro is excellent for analysis
- **Caching:** Prompt caching reduces costs 90%

**Tier Strategy:**

- Starter: Gemini Flash (cheap, fast)
- Pro: Gemini Pro (better quality)
- Enterprise: Claude Opus (best quality)

### Secondary AI

**Choice:** OpenRouter (Claude, DeepSeek)

**Why:**

- Single API for multiple models
- Automatic fallback
- Cost tracking per model
- No vendor lock-in

**Alternatives Considered:**

- OpenAI GPT-4: More expensive, slower
- Anthropic Direct: No fallback
- Local LLMs: Too slow, need GPUs

---

## Frontend

### Framework

**Choice:** Next.js 14 (App Router)

**Why:**

- React-based (largest ecosystem)
- Server-side rendering
- API routes built-in
- File-based routing
- Excellent TypeScript support

### UI Library

**Choice:** shadcn/ui + TailwindCSS

**Why:**

- Copy-paste components (no npm bloat)
- Fully customizable
- Accessible by default
- TailwindCSS for rapid styling

### State Management

**Choice:** TanStack Query + Zustand

**Why TanStack Query:**

- Server state management
- Automatic caching
- Optimistic updates

**Why Zustand:**

- Client state management
- Minimal boilerplate
- TypeScript-first

---

## Monitoring & Observability

### Error Tracking

**Choice:** Sentry

**Why:**

- Best-in-class error tracking
- Source map support
- Release tracking
- Performance monitoring
- Free tier: 5K errors/month

### Metrics

**Choice:** Prometheus + Grafana

**Why:**

- Industry standard
- Pull-based (no agent)
- Powerful query language (PromQL)
- Beautiful dashboards
- Free and open-source

**Key Metrics:**

```typescript
// Master Engine
masterCycleTime.observe(duration);
masterDataPoints.set(count);

// Tenant Workers
activeWorkers.set(count);
tradesExecuted.inc({ tenant_id });
```

### Logging

**Choice:** Winston + LogDNA

**Why Winston:**

- Structured logging (JSON format)
- Multiple transports (console, file, remote)
- Configurable log levels
- Production-ready

**Why LogDNA:**

- Centralized log aggregation
- Real-time log streaming
- Powerful search and filtering
- 90-day retention
- Free tier: 500MB/day

**Configuration:**

```typescript
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});
```

**Alternatives Considered:**

- Papertrail: Similar features, chose LogDNA for better free tier
- Datadog: More expensive, overkill for MVP
- ELK Stack: Self-hosted complexity

---

## Payments

### Billing

**Choice:** Stripe

**Why:**

- Industry leader
- Subscription management
- Webhooks for automation
- Tax calculation
- Free to start (2.9% + $0.30)

**Features:**

- Subscriptions (recurring billing)
- Usage-based billing (performance fees)
- Customer portal (self-service)
- Webhooks (payment events)

---

## Deployment

### Containerization

**Choice:** Docker + Docker Compose

**Why:**

- Consistent environments
- Easy local development
- Portable across clouds

### Orchestration

**Choice:** Kubernetes (K8s)

**Why:**

- Auto-scaling
- Self-healing
- Rolling updates
- Service discovery
- Industry standard

**Deployment:**

```yaml
# Master Engine: 1 replica (singleton)
# API Servers: 3-20 replicas (auto-scale)
# Worker Managers: 2-5 replicas
# Browser Pool: 5-10 replicas
```

### Hosting

**Choice:** DigitalOcean Kubernetes

**Why:**

- Cheaper than AWS/GCP ($12/month control plane)
- Simpler than AWS
- Managed Kubernetes
- Predictable pricing

---

## Cost Breakdown

### Fixed Infrastructure Costs (Monthly)

| Service            | Tier          | Cost             |
| ------------------ | ------------- | ---------------- |
| **Infrastructure** |               |                  |
| DigitalOcean K8s   | 3 nodes (4GB) | $36              |
| PostgreSQL         | Managed (4GB) | $60              |
| Redis              | Managed (1GB) | $15              |
| Browserless        | 5 instances   | $0 (self-hosted) |
| **Services**       |               |                  |
| Stripe             | Base          | $0               |
| Sentry             | 5K errors     | $0 (free tier)   |
| LogDNA             | 500MB/day     | $0 (free tier)   |
| **Total Fixed**    |               | **~$125/month**  |

### Variable Operational Costs (Daily)

| Component          | Cost Structure               | Example (100 tenants) |
| ------------------ | ---------------------------- | --------------------- |
| Data Gathering     | $0.50/cycle × 288 cycles     | $144/day              |
| AI Analysis        | $0.10/tenant/cycle × tenants | $2,880/day            |
| **Total Variable** |                              | **$3,024/day**        |
| **Per Tenant**     |                              | **$30.24/day**        |

### Revenue Model (100 customers)

- **Revenue:** $10,000/month (avg $100/customer)
- **Fixed Costs:** $125/month
- **Variable Costs:** ~$500/month (scales with usage)
- **Profit:** $9,375/month (94% margin)
- **Break-even:** 2 customers

**Note:** Variable costs scale linearly with tenant count. Fixed infrastructure remains constant until scaling horizontally (1000+ tenants).

---

## Security Considerations

### Data Protection

- **Encryption at rest:** PostgreSQL encryption
- **Encryption in transit:** TLS 1.3
- **Secrets:** AES-256-GCM with HKDF
- **API keys:** SHA-256 hashing

### Access Control

- **Row-Level Security:** PostgreSQL RLS
- **API authentication:** API keys + JWT
- **Rate limiting:** Multi-layer
- **Audit logging:** All actions logged

### Market Context Security

**Q: Can tenants tamper with market context?**  
**A:** No - read-only access

```sql
GRANT SELECT ON market_context TO tenant_role;
GRANT INSERT, UPDATE ON market_context TO master_engine_role;
```

---

## Technology Evolution

Our technology choices reflect a commitment to cost efficiency, scalability, and reliability. The Centralized Intelligence Model architecture delivers 83% cost savings while maintaining institutional-grade performance and security standards.

**Key Architectural Decisions:**

| Component          | Technology Choice        | Primary Benefit           |
| ------------------ | ------------------------ | ------------------------- |
| Intelligence Model | Centralized Broadcasting | 83% cost reduction        |
| Worker Isolation   | Node.js Worker Threads   | Efficient multi-tenancy   |
| Communication      | Redis Pub/Sub            | Real-time distribution    |
| Master Engine      | Single Process           | Simplicity + reliability  |
| Database Security  | PostgreSQL RLS           | Built-in tenant isolation |

---

**Architecture:** Centralized Intelligence Model  
**Version:** 2.0  
**Last Updated:** April 2026
