# Backend Migration & WEEX API Integration Plan

## Executive Summary

Transform Hypothesis Arena from a browser-based paper trading system to a production-grade backend system with real futures trading on WEEX exchange. This plan covers architecture, API integration, database design, deployment, and compliance.

---

## Phase 1: Backend Architecture Setup (Weeks 1-2)

### 1.1 Technology Stack

**Backend Framework:**

- Node.js 20+ with Express.js or NestJS
- TypeScript for type safety
- PostgreSQL for persistent storage
- Redis for caching and job queues
- Docker for containerization

**Key Libraries:**

- `axios` - HTTP client for WEEX API
- `bull` - Job queue for scheduled tasks
- `passport` - Authentication
- `joi` - Request validation
- `winston` - Logging
- `dotenv` - Environment management

**Infrastructure:**

- AWS EC2 or DigitalOcean for hosting
- AWS RDS for PostgreSQL
- AWS ElastiCache for Redis
- GitHub Actions for CI/CD
- PM2 for process management

### 1.2 Project Structure

```
hypothesis-arena-backend/
├── src/
│   ├── api/
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── analysis.ts
│   │   │   ├── trading.ts
│   │   │   ├── portfolio.ts
│   │   │   ├── weex.ts
│   │   │   └── ai-logs.ts
│   │   ├── controllers/
│   │   ├── middleware/
│   │   └── validators/
│   ├── services/
│   │   ├── weex/
│   │   │   ├── WeexClient.ts
│   │   │   ├── OrderService.ts
│   │   │   ├── AccountService.ts
│   │   │   └── WebSocketManager.ts
│   │   ├── analysis/
│   │   │   ├── AnalysisService.ts
│   │   │   ├── DebateService.ts
│   │   │   └── GeminiService.ts
│   │   ├── trading/
│   │   │   ├── AutoTradeExecutor.ts
│   │   │   ├── PositionManager.ts
│   │   │   ├── RiskManager.ts
│   │   │   └── PortfolioCalculator.ts
│   │   ├── auth/
│   │   │   ├── AuthService.ts
│   │   │   └── JWTService.ts
│   │   └── storage/
│   │       ├── UserRepository.ts
│   │       ├── AnalysisRepository.ts
│   │       ├── TradeRepository.ts
│   │       └── PortfolioRepository.ts
│   ├── jobs/
│   │   ├── AnalysisScheduler.ts
│   │   ├── TradeExecutor.ts
│   │   ├── PortfolioUpdater.ts
│   │   └── AILogProcessor.ts
│   ├── models/
│   │   ├── User.ts
│   │   ├── Analysis.ts
│   │   ├── Trade.ts
│   │   ├── Portfolio.ts
│   │   ├── Position.ts
│   │   ├── AILog.ts
│   │   └── WeexAccount.ts
│   ├── config/
│   │   ├── database.ts
│   │   ├── redis.ts
│   │   ├── weex.ts
│   │   └── gemini.ts
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── errors.ts
│   │   └── validators.ts
│   ├── middleware/
│   │   ├── auth.ts
│   │   ├── errorHandler.ts
│   │   └── requestLogger.ts
│   └── app.ts
├── migrations/
├── tests/
├── docker-compose.yml
├── Dockerfile
├── .env.example
└── package.json
```

### 1.3 Environment Configuration

```env
# Server
NODE_ENV=production
PORT=3000
LOG_LEVEL=info

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=hypothesis_arena
DB_USER=postgres
DB_PASSWORD=secure_password

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# JWT
JWT_SECRET=your_jwt_secret
JWT_EXPIRY=7d

# WEEX API
WEEX_API_KEY=your_api_key
WEEX_SECRET_KEY=your_secret_key
WEEX_PASSPHRASE=your_passphrase
WEEX_BASE_URL=https://api-contract.weex.com
WEEX_WS_URL=wss://ws-contract.weex.com/v2/ws

# Gemini API
GEMINI_API_KEY=your_gemini_key

# FMP API
FMP_API_KEY=your_fmp_key

# Trading Config
MAX_DAILY_TRADES=20
MAX_POSITION_SIZE=0.2
MAX_TOTAL_INVESTED=0.8
CIRCUIT_BREAKER_THRESHOLD=0.15
DRAWDOWN_PAUSE_THRESHOLD=0.3
DRAWDOWN_LIQUIDATE_THRESHOLD=0.8

# Compliance
ENABLE_AI_LOG_SUBMISSION=true
REQUIRE_AI_LOGS=true
```

---

## Phase 2: Database Schema Design (Week 1-2)

### 2.1 Core Tables

**Users Table**

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  username VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  last_login TIMESTAMP,
  subscription_tier VARCHAR(50) DEFAULT 'free'
);
```

**WEEX Accounts Table**

```sql
CREATE TABLE weex_accounts (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  api_key VARCHAR(255) NOT NULL,
  secret_key VARCHAR(255) NOT NULL,
  passphrase VARCHAR(255) NOT NULL,
  account_id VARCHAR(255) UNIQUE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  last_sync TIMESTAMP,
  UNIQUE(user_id, account_id)
);
```

**Portfolios Table**

```sql
CREATE TABLE portfolios (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  weex_account_id UUID REFERENCES weex_accounts(id),
  agent_name VARCHAR(100) NOT NULL,
  initial_balance DECIMAL(20, 8) NOT NULL,
  current_balance DECIMAL(20, 8) NOT NULL,
  total_return DECIMAL(10, 4),
  win_rate DECIMAL(5, 2),
  sharpe_ratio DECIMAL(10, 4),
  max_drawdown DECIMAL(10, 4),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  trading_mode VARCHAR(50) DEFAULT 'paper' -- 'paper' or 'live'
);
```

**Positions Table**

```sql
CREATE TABLE positions (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL, -- 'LONG' or 'SHORT'
  size DECIMAL(20, 8) NOT NULL,
  entry_price DECIMAL(20, 8) NOT NULL,
  current_price DECIMAL(20, 8),
  margin_mode VARCHAR(20) NOT NULL, -- 'SHARED' or 'ISOLATED'
  leverage DECIMAL(5, 2) DEFAULT 1,
  unrealized_pnl DECIMAL(20, 8),
  realized_pnl DECIMAL(20, 8) DEFAULT 0,
  opened_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  is_open BOOLEAN DEFAULT true,
  weex_position_id VARCHAR(255)
);
```

**Trades Table**

```sql
CREATE TABLE trades (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  position_id UUID REFERENCES positions(id),
  symbol VARCHAR(50) NOT NULL,
  side VARCHAR(10) NOT NULL, -- 'BUY' or 'SELL'
  type VARCHAR(20) NOT NULL, -- 'MARKET', 'LIMIT', 'TRIGGER'
  size DECIMAL(20, 8) NOT NULL,
  price DECIMAL(20, 8) NOT NULL,
  fee DECIMAL(20, 8),
  status VARCHAR(50) NOT NULL, -- 'PENDING', 'FILLED', 'CANCELED', 'FAILED'
  reason VARCHAR(255),
  analysis_id UUID,
  confidence DECIMAL(5, 2),
  executed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  weex_order_id VARCHAR(255),
  client_order_id VARCHAR(255) UNIQUE
);
```

**Analyses Table**

```sql
CREATE TABLE analyses (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  symbol VARCHAR(50) NOT NULL,
  status VARCHAR(50) NOT NULL, -- 'PENDING', 'COMPLETED', 'FAILED'
  recommendation VARCHAR(50), -- 'strong_buy', 'buy', 'hold', 'sell', 'strong_sell'
  confidence DECIMAL(5, 2),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP,
  debate_results JSONB,
  theses JSONB,
  market_data JSONB
);
```

**AI Logs Table**

```sql
CREATE TABLE ai_logs (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  trade_id UUID REFERENCES trades(id),
  stage VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  input JSONB NOT NULL,
  output JSONB NOT NULL,
  explanation TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  verified BOOLEAN DEFAULT false,
  verification_notes TEXT
);
```

**Performance Metrics Table**

```sql
CREATE TABLE performance_metrics (
  id UUID PRIMARY KEY,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id),
  date DATE NOT NULL,
  portfolio_value DECIMAL(20, 8),
  daily_return DECIMAL(10, 4),
  cumulative_return DECIMAL(10, 4),
  sharpe_ratio DECIMAL(10, 4),
  max_drawdown DECIMAL(10, 4),
  win_rate DECIMAL(5, 2),
  trades_count INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(portfolio_id, date)
);
```

### 2.2 Indexes

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_weex_accounts_user_id ON weex_accounts(user_id);
CREATE INDEX idx_portfolios_user_id ON portfolios(user_id);
CREATE INDEX idx_positions_portfolio_id ON positions(portfolio_id);
CREATE INDEX idx_positions_symbol ON positions(symbol);
CREATE INDEX idx_trades_portfolio_id ON trades(portfolio_id);
CREATE INDEX idx_trades_symbol ON trades(symbol);
CREATE INDEX idx_trades_created_at ON trades(created_at);
CREATE INDEX idx_analyses_user_id ON analyses(user_id);
CREATE INDEX idx_analyses_symbol ON analyses(symbol);
CREATE INDEX idx_ai_logs_user_id ON ai_logs(user_id);
CREATE INDEX idx_performance_metrics_portfolio_id ON performance_metrics(portfolio_id);
CREATE INDEX idx_performance_metrics_date ON performance_metrics(date);
```

---

## Phase 3: WEEX API Integration (Weeks 2-4)

### 3.1 WEEX Client Implementation

**WeexClient.ts** - Core API wrapper

- Signature generation (HMAC SHA256)
- Request/response handling
- Error handling and retries
- Rate limiting
- Timestamp synchronization

**Key Methods:**

- `getServerTime()` - Sync timestamp
- `getContracts()` - Get available trading pairs
- `getAccountInfo()` - Get account details
- `getPositions()` - Get open positions
- `getOrders()` - Get order history
- `placeOrder()` - Place new order
- `cancelOrder()` - Cancel order
- `getTicker()` - Get market data
- `getDepth()` - Get order book
- `getCandles()` - Get K-line data
- `getFundingRate()` - Get funding rates

### 3.2 WebSocket Integration

**WebSocketManager.ts** - Real-time data streaming

- Connection management
- Ping/Pong handling
- Subscription management
- Data parsing and validation
- Reconnection logic

**Subscriptions:**

- Public channels: ticker, depth, trades, candles
- Private channels: account, positions, orders, fills

### 3.3 Order Management Service

**OrderService.ts**

```typescript
interface OrderRequest {
  symbol: string;
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT" | "TRIGGER";
  size: number;
  price?: number;
  triggerPrice?: number;
  clientOrderId: string;
  marginMode: 1 | 3; // 1=Cross, 3=Isolated
}

interface OrderResponse {
  orderId: string;
  clientOrderId: string;
  status: string;
  filledQty: number;
  filledValue: number;
  fee: number;
}
```

**Key Features:**

- Order validation
- Position sizing
- Risk checks
- Slippage protection
- Order tracking
- Execution logging

### 3.4 Account Management Service

**AccountService.ts**

- Get account balance
- Get collateral info
- Get positions
- Adjust margin
- Change leverage
- Get account settings

### 3.5 Error Handling & Retries

**Retry Strategy:**

- Exponential backoff (1s, 2s, 4s, 8s, 16s)
- Max 5 retries
- Circuit breaker pattern
- Graceful degradation

**Error Codes:**

- 40001-40022: Authentication/validation errors
- 50003-50007: Trading errors
- 429: Rate limit exceeded
- 500+: Server errors

---

## Phase 4: Trading System Implementation (Weeks 3-5)

### 4.1 Auto Trade Executor

**AutoTradeExecutor.ts**

```typescript
interface TradeDecision {
  symbol: string;
  action: "BUY" | "SELL" | "HOLD";
  confidence: number;
  targetPrice?: number;
  stopLoss?: number;
  takeProfit?: number;
  size: number;
  reason: string;
}
```

**Execution Flow:**

1. Receive trade decision from analysis
2. Validate decision (confidence, risk limits)
3. Check market conditions
4. Calculate position size
5. Place order on WEEX
6. Track execution
7. Log AI decision
8. Update portfolio

### 4.2 Position Manager

**PositionManager.ts**

- Open positions
- Close positions
- Adjust positions
- Track P&L
- Handle liquidations
- Manage margin

### 4.3 Risk Manager

**RiskManager.ts**

```typescript
interface RiskLimits {
  maxPositionSize: number; // 20% per stock
  maxTotalInvested: number; // 80%
  maxDailyTrades: number; // 20
  maxLeverage: number; // 100x
  drawdownPauseThreshold: number; // 30%
  drawdownLiquidateThreshold: number; // 80%
  circuitBreakerThreshold: number; // 15% in 24h
}
```

**Risk Checks:**

- Position size validation
- Leverage limits
- Drawdown monitoring
- Circuit breaker
- Margin requirements
- Liquidation protection

### 4.4 Portfolio Calculator

**PortfolioCalculator.ts**

- Calculate total value
- Calculate P&L (realized + unrealized)
- Calculate metrics (Sharpe, Sortino, max drawdown)
- Calculate win rate
- Generate performance reports

---

## Phase 5: Analysis & Debate System (Weeks 4-6)

### 5.1 Analysis Service

**AnalysisService.ts**

- Fetch market data
- Generate analyst theses
- Run debate tournament
- Calculate consensus
- Generate recommendation

### 5.2 Debate Service

**DebateService.ts**

- Tournament bracket logic
- Scoring system
- Round management
- Winner determination
- Confidence calculation

### 5.3 Gemini Integration

**GeminiService.ts**

- Generate theses
- Debate arguments
- Analyze sentiment
- Generate explanations
- Validate outputs

---

## Phase 6: Job Scheduling & Automation (Weeks 5-6)

### 6.1 Analysis Scheduler

**AnalysisScheduler.ts**

- Scheduled analysis runs
- Watchlist scanning
- Market hours validation
- Queue management
- Retry logic

### 6.2 Trade Executor Job

**TradeExecutor.ts**

- Execute pending trades
- Monitor order status
- Handle fills
- Update positions
- Log trades

### 6.3 Portfolio Updater

**PortfolioUpdater.ts**

- Update portfolio values
- Calculate metrics
- Generate snapshots
- Archive old data
- Cleanup

### 6.4 AI Log Processor

**AILogProcessor.ts**

- Validate AI logs
- Store logs
- Generate compliance reports
- Track AI involvement
- Verify authenticity

---

## Phase 7: API Endpoints (Weeks 6-7)

### 7.1 Authentication Endpoints

```
POST /api/auth/register
POST /api/auth/login
POST /api/auth/refresh
POST /api/auth/logout
GET /api/auth/me
```

### 7.2 WEEX Account Endpoints

```
POST /api/weex/connect
GET /api/weex/accounts
GET /api/weex/account/:id
DELETE /api/weex/account/:id
POST /api/weex/sync
```

### 7.3 Analysis Endpoints

```
POST /api/analysis/create
GET /api/analysis/:id
GET /api/analysis/history
POST /api/analysis/compare
GET /api/analysis/accuracy
```

### 7.4 Trading Endpoints

```
POST /api/trading/execute
GET /api/trading/orders
GET /api/trading/order/:id
POST /api/trading/cancel
GET /api/trading/history
```

### 7.5 Portfolio Endpoints

```
GET /api/portfolio/summary
GET /api/portfolio/positions
GET /api/portfolio/performance
GET /api/portfolio/metrics
GET /api/portfolio/leaderboard
```

### 7.6 AI Log Endpoints

```
POST /api/ai-logs/upload
GET /api/ai-logs/:id
GET /api/ai-logs/history
GET /api/ai-logs/compliance
```

---

## Phase 8: Frontend Updates (Weeks 7-8)

### 8.1 API Integration

- Replace localStorage with API calls
- Add authentication flow
- Implement real-time updates via WebSocket
- Add error handling
- Implement loading states

### 8.2 New Components

- WEEX account connection
- Live trading mode toggle
- Real-time position updates
- Live order tracking
- Real-time leaderboard

### 8.3 Settings & Configuration

- API key management
- Trading preferences
- Risk limits
- Notification settings
- Data export

---

## Phase 9: Testing & QA (Weeks 8-9)

### 9.1 Unit Tests

- Service logic
- Calculations
- Validations
- Error handling

### 9.2 Integration Tests

- API endpoints
- Database operations
- WEEX API integration
- Job execution

### 9.3 End-to-End Tests

- Full trading flow
- Analysis to execution
- Portfolio updates
- AI log submission

### 9.4 Load Testing

- Concurrent users
- High-frequency trading
- WebSocket connections
- Database queries

---

## Phase 10: Deployment & Monitoring (Weeks 9-10)

### 10.1 Infrastructure Setup

- AWS EC2 instance
- RDS PostgreSQL
- ElastiCache Redis
- S3 for backups
- CloudWatch for monitoring

### 10.2 CI/CD Pipeline

- GitHub Actions
- Automated tests
- Build process
- Deployment automation
- Rollback strategy

### 10.3 Monitoring & Logging

- Application logs (Winston)
- Error tracking (Sentry)
- Performance monitoring (New Relic)
- Uptime monitoring
- Alert system

### 10.4 Backup & Recovery

- Daily database backups
- S3 backup storage
- Recovery procedures
- Disaster recovery plan

---

## Phase 11: Compliance & Security (Weeks 10-11)

### 11.1 Security Measures

- API key encryption
- JWT token management
- Rate limiting
- Input validation
- SQL injection prevention
- CORS configuration
- HTTPS enforcement

### 11.2 Compliance

- AI log verification
- Audit trails
- Data retention policies
- GDPR compliance
- Terms of service
- Privacy policy

### 11.3 API Key Management

- Secure storage (encrypted)
- Key rotation
- Access logging
- Revocation capability

---

## Phase 12: Documentation & Training (Week 11-12)

### 12.1 API Documentation

- OpenAPI/Swagger specs
- Endpoint documentation
- Error codes
- Rate limits
- Authentication

### 12.2 Developer Guide

- Setup instructions
- Architecture overview
- Code examples
- Troubleshooting

### 12.3 User Guide

- Getting started
- Trading guide
- Risk management
- FAQ

---

## Implementation Timeline

| Phase | Duration    | Key Deliverables                 |
| ----- | ----------- | -------------------------------- |
| 1     | Weeks 1-2   | Backend setup, project structure |
| 2     | Weeks 1-2   | Database schema, migrations      |
| 3     | Weeks 2-4   | WEEX API integration, WebSocket  |
| 4     | Weeks 3-5   | Trading system, risk management  |
| 5     | Weeks 4-6   | Analysis system, debate engine   |
| 6     | Weeks 5-6   | Job scheduling, automation       |
| 7     | Weeks 6-7   | API endpoints, controllers       |
| 8     | Weeks 7-8   | Frontend updates, integration    |
| 9     | Weeks 8-9   | Testing, QA, bug fixes           |
| 10    | Weeks 9-10  | Deployment, monitoring           |
| 11    | Weeks 10-11 | Security, compliance             |
| 12    | Weeks 11-12 | Documentation, training          |

**Total Duration: 12 weeks (3 months)**

---

## Risk Mitigation

| Risk                  | Severity | Mitigation                                         |
| --------------------- | -------- | -------------------------------------------------- |
| WEEX API changes      | High     | Version API, maintain compatibility layer          |
| Data loss             | Critical | Daily backups, redundancy, recovery tests          |
| Trading errors        | Critical | Extensive testing, circuit breakers, manual review |
| Performance issues    | High     | Load testing, caching, optimization                |
| Security breach       | Critical | Encryption, monitoring, incident response          |
| Compliance violations | High     | Audit trails, legal review, documentation          |

---

## Success Criteria

- ✅ Backend fully operational with 99.9% uptime
- ✅ WEEX API fully integrated and tested
- ✅ All 8 agents trading autonomously
- ✅ Real-time portfolio tracking
- ✅ AI log submission working
- ✅ Compliance requirements met
- ✅ Performance metrics calculated accurately
- ✅ Zero critical bugs in production
- ✅ Full test coverage (>80%)
- ✅ Documentation complete

---

## Post-Launch Roadmap

### Phase 13: Advanced Features (Months 4-6)

- Multi-exchange support
- Advanced order types
- Portfolio optimization
- Machine learning improvements
- Mobile app
- API for third-party integrations

### Phase 14: Scaling (Months 6-12)

- Microservices architecture
- Kubernetes deployment
- Global infrastructure
- Multi-currency support
- Enterprise features

---

## Appendix: Key Files to Create

1. `src/services/weex/WeexClient.ts` - Core WEEX API wrapper
2. `src/services/weex/WebSocketManager.ts` - Real-time data
3. `src/services/trading/AutoTradeExecutor.ts` - Trade execution
4. `src/services/trading/RiskManager.ts` - Risk controls
5. `src/jobs/AnalysisScheduler.ts` - Scheduled analysis
6. `src/jobs/TradeExecutor.ts` - Trade job
7. `src/models/` - All database models
8. `src/api/routes/` - All API endpoints
9. `migrations/` - Database migrations
10. `docker-compose.yml` - Local development
11. `.env.example` - Environment template

---

**Document Version:** 1.0  
**Last Updated:** December 23, 2025  
**Status:** Ready for Implementation

---

# CRITICAL ANALYSIS & FIXES

## 🚨 Critical Issues Identified

### Issue 1: WEEX Competition Constraints Not Addressed

**Problem:** The plan doesn't account for WEEX competition-specific rules:

- Only 8 approved trading pairs allowed
- AI log submission is MANDATORY
- Only approved UIDs can trade
- Manual trading is PROHIBITED

**Fix:** Add competition compliance layer

```typescript
// src/services/compliance/CompetitionComplianceService.ts
const APPROVED_SYMBOLS = [
  "cmt_btcusdt",
  "cmt_ethusdt",
  "cmt_solusdt",
  "cmt_dogeusdt",
  "cmt_xrpusdt",
  "cmt_adausdt",
  "cmt_bnbusdt",
  "cmt_ltcusdt",
];

interface ComplianceCheck {
  isApprovedSymbol(symbol: string): boolean;
  isApprovedUID(uid: string): Promise<boolean>;
  validateAIInvolvement(trade: Trade): boolean;
  requireAILogBeforeTrade(tradeId: string): Promise<void>;
}
```

### Issue 2: Timestamp Synchronization Critical for WEEX

**Problem:** WEEX rejects requests if timestamp deviates >30 seconds from server time. Plan mentions sync but doesn't detail implementation.

**Fix:** Implement robust timestamp sync

```typescript
// src/services/weex/TimestampSyncService.ts
class TimestampSyncService {
  private serverOffset: number = 0;
  private lastSync: number = 0;
  private syncInterval: number = 60000; // 1 minute

  async syncWithServer(): Promise<void> {
    const localBefore = Date.now();
    const serverTime = await this.weexClient.getServerTime();
    const localAfter = Date.now();
    const latency = (localAfter - localBefore) / 2;
    this.serverOffset = serverTime.timestamp - localBefore - latency;
    this.lastSync = Date.now();
  }

  getTimestamp(): number {
    if (Date.now() - this.lastSync > this.syncInterval) {
      this.syncWithServer(); // Non-blocking, use cached offset
    }
    return Date.now() + this.serverOffset;
  }

  isTimestampValid(timestamp: number): boolean {
    const serverTime = this.getTimestamp();
    return Math.abs(serverTime - timestamp) < 30000; // 30 seconds
  }
}
```

### Issue 3: Rate Limiting Not Properly Implemented

**Problem:** WEEX has specific rate limits:

- 1000 requests/10 seconds per IP
- 1000 requests/10 seconds per UID
- Place/Cancel Order: 10 requests/second
- Different weights per endpoint

**Fix:** Implement proper rate limiter

```typescript
// src/services/weex/RateLimiter.ts
interface RateLimitConfig {
  ipLimit: number; // 1000
  uidLimit: number; // 1000
  windowMs: number; // 10000
  orderLimit: number; // 10 per second
}

class WeexRateLimiter {
  private ipBucket: TokenBucket;
  private uidBucket: TokenBucket;
  private orderBucket: TokenBucket;
  private requestQueue: PriorityQueue<QueuedRequest>;

  async executeWithRateLimit<T>(
    request: () => Promise<T>,
    weight: number,
    isOrderRequest: boolean
  ): Promise<T> {
    // Check all buckets
    await this.ipBucket.consume(weight);
    await this.uidBucket.consume(weight);
    if (isOrderRequest) {
      await this.orderBucket.consume(1);
    }
    return request();
  }

  // Endpoint weights from WEEX docs
  getEndpointWeight(endpoint: string): number {
    const weights: Record<string, number> = {
      "/capi/v2/market/time": 1,
      "/capi/v2/market/contracts": 10,
      "/capi/v2/market/tickers": 40,
      "/capi/v2/order/placeOrder": 2,
      "/capi/v2/order/batchOrders": 5,
      "/capi/v2/account/assets": 5,
      // ... all endpoints
    };
    return weights[endpoint] || 1;
  }
}
```

### Issue 4: WebSocket Reconnection Logic Incomplete

**Problem:** Plan mentions reconnection but doesn't handle:

- Ping/Pong timeout (5 missed = disconnect)
- Subscription restoration after reconnect
- Message ordering during reconnect
- Backpressure handling

**Fix:** Robust WebSocket manager

```typescript
// src/services/weex/WebSocketManager.ts
class WebSocketManager {
  private ws: WebSocket | null = null;
  private pingInterval: NodeJS.Timer | null = null;
  private missedPongs: number = 0;
  private subscriptions: Set<string> = new Set();
  private messageBuffer: Message[] = [];
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;
  private reconnectDelay: number = 1000;

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url, { headers: this.getAuthHeaders() });

    this.ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.startPingPong();
      this.resubscribeAll();
    });

    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.event === "ping") {
        this.handlePing(msg);
      } else if (msg.event === "pong") {
        this.missedPongs = 0;
      } else {
        this.processMessage(msg);
      }
    });

    this.ws.on("close", () => this.handleDisconnect());
    this.ws.on("error", (err) => this.handleError(err));
  }

  private handlePing(msg: any): void {
    this.ws?.send(JSON.stringify({ event: "pong", time: msg.time }));
  }

  private startPingPong(): void {
    this.pingInterval = setInterval(() => {
      this.missedPongs++;
      if (this.missedPongs >= 5) {
        this.ws?.close();
        this.handleDisconnect();
      }
    }, 30000);
  }

  private async handleDisconnect(): Promise<void> {
    if (this.pingInterval) clearInterval(this.pingInterval);

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
      this.reconnectAttempts++;
      await sleep(delay);
      await this.connect();
    } else {
      this.emit("maxReconnectAttemptsReached");
    }
  }

  private async resubscribeAll(): Promise<void> {
    for (const channel of this.subscriptions) {
      await this.subscribe(channel);
    }
  }
}
```

### Issue 5: Order State Machine Missing

**Problem:** Orders have complex state transitions that aren't tracked:

- pending → open → filled/canceled
- Partial fills
- Trigger orders: untriggered → triggered → filled
- Race conditions between local state and WEEX state

**Fix:** Implement order state machine

```typescript
// src/services/trading/OrderStateMachine.ts
enum OrderState {
  CREATED = "created",
  SUBMITTED = "submitted",
  PENDING = "pending",
  OPEN = "open",
  PARTIALLY_FILLED = "partially_filled",
  FILLED = "filled",
  CANCELING = "canceling",
  CANCELED = "canceled",
  FAILED = "failed",
  UNTRIGGERED = "untriggered",
  TRIGGERED = "triggered",
}

const validTransitions: Record<OrderState, OrderState[]> = {
  [OrderState.CREATED]: [OrderState.SUBMITTED, OrderState.FAILED],
  [OrderState.SUBMITTED]: [OrderState.PENDING, OrderState.FAILED],
  [OrderState.PENDING]: [
    OrderState.OPEN,
    OrderState.FILLED,
    OrderState.CANCELED,
    OrderState.FAILED,
  ],
  [OrderState.OPEN]: [
    OrderState.PARTIALLY_FILLED,
    OrderState.FILLED,
    OrderState.CANCELING,
    OrderState.CANCELED,
  ],
  [OrderState.PARTIALLY_FILLED]: [
    OrderState.FILLED,
    OrderState.CANCELING,
    OrderState.CANCELED,
  ],
  [OrderState.CANCELING]: [OrderState.CANCELED, OrderState.FILLED],
  [OrderState.UNTRIGGERED]: [OrderState.TRIGGERED, OrderState.CANCELED],
  [OrderState.TRIGGERED]: [OrderState.PENDING, OrderState.FAILED],
  // Terminal states
  [OrderState.FILLED]: [],
  [OrderState.CANCELED]: [],
  [OrderState.FAILED]: [],
};

class OrderStateMachine {
  private state: OrderState;
  private history: StateTransition[] = [];

  transition(newState: OrderState, metadata?: any): boolean {
    if (!validTransitions[this.state].includes(newState)) {
      this.logInvalidTransition(this.state, newState);
      return false;
    }
    this.history.push({
      from: this.state,
      to: newState,
      timestamp: Date.now(),
      metadata,
    });
    this.state = newState;
    return true;
  }
}
```

### Issue 6: Funding Fee Settlement Not Handled

**Problem:** WEEX settles funding fees every 8 hours (00:00, 08:00, 16:00 UTC). Plan doesn't account for:

- Funding fee impact on positions
- Settlement timing
- Funding rate prediction for position management

**Fix:** Add funding fee service

```typescript
// src/services/trading/FundingFeeService.ts
class FundingFeeService {
  private settlementTimes = ["00:00", "08:00", "16:00"]; // UTC

  async getCurrentFundingRate(symbol: string): Promise<FundingRate> {
    return this.weexClient.getCurrentFundingRate(symbol);
  }

  getNextSettlementTime(): Date {
    const now = new Date();
    const utcHour = now.getUTCHours();

    for (const time of this.settlementTimes) {
      const [hour] = time.split(":").map(Number);
      if (utcHour < hour) {
        const next = new Date(now);
        next.setUTCHours(hour, 0, 0, 0);
        return next;
      }
    }
    // Next day 00:00
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
    return next;
  }

  calculateExpectedFundingFee(position: Position, fundingRate: number): number {
    // Funding Fee = Position Value × Funding Rate
    const positionValue = position.size * position.currentPrice;
    return positionValue * fundingRate;
  }

  shouldCloseBeforeSettlement(
    position: Position,
    fundingRate: number
  ): boolean {
    const expectedFee = this.calculateExpectedFundingFee(position, fundingRate);
    const timeToSettlement =
      this.getNextSettlementTime().getTime() - Date.now();

    // If funding rate is against us and settlement is within 30 minutes
    if (timeToSettlement < 30 * 60 * 1000) {
      if (
        (position.side === "LONG" && fundingRate > 0) ||
        (position.side === "SHORT" && fundingRate < 0)
      ) {
        // Consider closing if fee > expected profit
        return Math.abs(expectedFee) > position.unrealizedPnl * 0.5;
      }
    }
    return false;
  }
}
```

### Issue 7: Liquidation Risk Not Properly Managed

**Problem:** Plan mentions liquidation but doesn't detail:

- Liquidation price calculation
- Margin call handling
- Auto-deleveraging (ADL) scenarios
- Position size limits based on liquidation risk

**Fix:** Comprehensive liquidation management

```typescript
// src/services/trading/LiquidationManager.ts
class LiquidationManager {
  calculateLiquidationPrice(position: Position): number {
    const { side, entryPrice, leverage, marginMode } = position;

    // Simplified formula - actual WEEX formula may differ
    const maintenanceMarginRate = 0.005; // 0.5%

    if (side === "LONG") {
      return entryPrice * (1 - 1 / leverage + maintenanceMarginRate);
    } else {
      return entryPrice * (1 + 1 / leverage - maintenanceMarginRate);
    }
  }

  calculateDistanceToLiquidation(
    position: Position,
    currentPrice: number
  ): number {
    const liqPrice = this.calculateLiquidationPrice(position);
    return Math.abs(currentPrice - liqPrice) / currentPrice;
  }

  isAtRisk(position: Position, currentPrice: number): boolean {
    const distance = this.calculateDistanceToLiquidation(
      position,
      currentPrice
    );
    return distance < 0.05; // Within 5% of liquidation
  }

  async handleMarginCall(position: Position): Promise<void> {
    const options = [
      { action: "ADD_MARGIN", priority: 1 },
      { action: "REDUCE_POSITION", priority: 2 },
      { action: "CLOSE_POSITION", priority: 3 },
    ];

    // Check available margin
    const account = await this.weexClient.getAccountInfo();
    const availableMargin = parseFloat(account.available);

    if (availableMargin > position.marginSize * 0.5) {
      await this.addMargin(position, availableMargin * 0.3);
    } else {
      await this.reducePosition(position, 0.5); // Reduce by 50%
    }
  }

  calculateSafePositionSize(
    symbol: string,
    side: "LONG" | "SHORT",
    leverage: number,
    availableMargin: number,
    maxRiskPercent: number = 0.02 // 2% max risk
  ): number {
    const ticker = await this.weexClient.getTicker(symbol);
    const currentPrice = parseFloat(ticker.last);

    // Position size where liquidation = maxRiskPercent loss
    const maxLoss = availableMargin * maxRiskPercent;
    const liqDistance = 1 / leverage;
    const maxPositionValue = maxLoss / liqDistance;

    return maxPositionValue / currentPrice;
  }
}
```

### Issue 8: Database Transaction Safety Missing

**Problem:** Plan doesn't address:

- Atomic operations for trade execution
- Rollback on partial failures
- Concurrent access to same portfolio
- Idempotency for retries

**Fix:** Add transaction management

```typescript
// src/services/storage/TransactionManager.ts
class TransactionManager {
  async executeTradeTransaction(
    trade: TradeRequest,
    portfolio: Portfolio
  ): Promise<TradeResult> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Lock portfolio row for update
      const lockedPortfolio = await client.query(
        "SELECT * FROM portfolios WHERE id = $1 FOR UPDATE",
        [portfolio.id]
      );

      // Validate trade is still valid
      if (!this.validateTrade(trade, lockedPortfolio.rows[0])) {
        throw new Error("Trade validation failed");
      }

      // Execute on WEEX
      const weexResult = await this.weexClient.placeOrder(trade);

      // Record trade
      const tradeRecord = await client.query(
        `INSERT INTO trades (id, portfolio_id, symbol, side, size, price, status, weex_order_id, client_order_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (client_order_id) DO NOTHING
         RETURNING *`,
        [
          uuid(),
          portfolio.id,
          trade.symbol,
          trade.side,
          trade.size,
          weexResult.price,
          weexResult.status,
          weexResult.orderId,
          trade.clientOrderId,
        ]
      );

      // Update portfolio
      await client.query(
        `UPDATE portfolios SET current_balance = current_balance - $1, updated_at = NOW()
         WHERE id = $2`,
        [trade.size * weexResult.price, portfolio.id]
      );

      await client.query("COMMIT");
      return { success: true, trade: tradeRecord.rows[0] };
    } catch (error) {
      await client.query("ROLLBACK");

      // Check if WEEX order was placed despite error
      if (trade.clientOrderId) {
        const weexOrder = await this.weexClient.getOrderByClientId(
          trade.clientOrderId
        );
        if (weexOrder) {
          // Order exists on WEEX, need to reconcile
          await this.reconcileOrder(weexOrder, portfolio);
        }
      }

      throw error;
    } finally {
      client.release();
    }
  }
}
```

### Issue 9: AI Log Timing Requirements

**Problem:** AI logs must be submitted for compliance, but plan doesn't specify:

- When to submit (before/after trade?)
- What happens if submission fails?
- How to link logs to trades?

**Fix:** AI log workflow

```typescript
// src/services/compliance/AILogWorkflow.ts
class AILogWorkflow {
  async executeTradeWithAILog(
    decision: TradeDecision,
    analysis: Analysis
  ): Promise<TradeResult> {
    // 1. Generate AI log BEFORE trade
    const aiLog = this.generateAILog(decision, analysis);

    // 2. Store locally first (for recovery)
    const localLogId = await this.storeLocalLog(aiLog);

    // 3. Execute trade
    let tradeResult: TradeResult;
    try {
      tradeResult = await this.tradeExecutor.execute(decision);
    } catch (error) {
      // Trade failed, still submit AI log for audit
      aiLog.output.tradeResult = { success: false, error: error.message };
      await this.submitAILog(aiLog);
      throw error;
    }

    // 4. Update AI log with trade result
    aiLog.orderId = tradeResult.orderId;
    aiLog.output.tradeResult = {
      success: true,
      orderId: tradeResult.orderId,
      filledPrice: tradeResult.price,
      filledSize: tradeResult.size,
    };

    // 5. Submit to WEEX
    const submitResult = await this.submitAILog(aiLog);

    if (!submitResult.success) {
      // Log submission failed - critical for compliance
      await this.alertComplianceFailure(aiLog, submitResult.error);
      // Queue for retry
      await this.queueForRetry(aiLog);
    }

    // 6. Mark local log as submitted
    await this.markLogSubmitted(localLogId, submitResult);

    return tradeResult;
  }

  private generateAILog(decision: TradeDecision, analysis: Analysis): AILog {
    return {
      orderId: null, // Will be set after trade
      stage: "Order Execution",
      model: "Gemini-2.0-flash",
      input: {
        symbol: decision.symbol,
        marketData: analysis.marketData,
        theses: analysis.theses,
        debateResults: analysis.debateResults,
        confidence: decision.confidence,
      },
      output: {
        action: decision.action,
        size: decision.size,
        reason: decision.reason,
        targetPrice: decision.targetPrice,
        stopLoss: decision.stopLoss,
        takeProfit: decision.takeProfit,
      },
      explanation: this.generateExplanation(decision, analysis),
    };
  }

  private generateExplanation(
    decision: TradeDecision,
    analysis: Analysis
  ): string {
    // Must be <500 words, clear, and demonstrate AI involvement
    return `
      Analysis of ${decision.symbol} conducted using Gemini-2.0-flash model.
      
      Market Context: ${analysis.marketData.summary}
      
      AI Analysis Process:
      1. Generated ${
        analysis.theses.length
      } investment theses from different perspectives
      2. Conducted debate tournament with ${
        analysis.debateResults.rounds
      } rounds
      3. Winner: ${analysis.debateResults.winner} with confidence ${
      decision.confidence
    }
      
      Decision Rationale:
      ${decision.reason}
      
      Risk Assessment:
      - Stop Loss: ${decision.stopLoss || "Not set"}
      - Take Profit: ${decision.takeProfit || "Not set"}
      - Position Size: ${decision.size} (${(decision.size * 100).toFixed(
      2
    )}% of portfolio)
      
      This trade was generated autonomously by AI analysis without manual intervention.
    `.trim();
  }
}
```

### Issue 10: Market Hours Not Considered

**Problem:** WEEX crypto futures trade 24/7, but:

- Funding settlements at specific times
- Liquidity varies by time
- Volatility spikes at certain hours
- Maintenance windows

**Fix:** Market conditions service

```typescript
// src/services/market/MarketConditionsService.ts
class MarketConditionsService {
  private maintenanceWindows: TimeWindow[] = [];

  async isOptimalTradingTime(symbol: string): Promise<TradingCondition> {
    const now = new Date();
    const hour = now.getUTCHours();

    // Check maintenance
    if (this.isMaintenanceWindow(now)) {
      return { canTrade: false, reason: "Maintenance window" };
    }

    // Check liquidity (typically lower 00:00-06:00 UTC)
    const depth = await this.weexClient.getDepth(symbol, 15);
    const spreadPercent = this.calculateSpread(depth);

    if (spreadPercent > 0.1) {
      // >0.1% spread
      return { canTrade: true, warning: "Low liquidity, wider spreads" };
    }

    // Check funding settlement proximity
    const fundingService = new FundingFeeService();
    const timeToSettlement =
      fundingService.getNextSettlementTime().getTime() - now.getTime();

    if (timeToSettlement < 5 * 60 * 1000) {
      // Within 5 minutes
      return { canTrade: false, reason: "Funding settlement imminent" };
    }

    // Check volatility
    const volatility = await this.calculateRecentVolatility(symbol);
    if (volatility > 0.05) {
      // >5% in last hour
      return { canTrade: true, warning: "High volatility detected" };
    }

    return { canTrade: true };
  }

  private calculateSpread(depth: Depth): number {
    const bestAsk = parseFloat(depth.asks[0][0]);
    const bestBid = parseFloat(depth.bids[0][0]);
    return (bestAsk - bestBid) / bestBid;
  }
}
```

---

## 🔧 Edge Cases & Solutions

### Edge Case 1: Partial Order Fills

**Scenario:** Order for 1 BTC filled only 0.7 BTC, then market moves.

**Solution:**

```typescript
class PartialFillHandler {
  async handlePartialFill(order: Order, fill: Fill): Promise<void> {
    const remainingSize = order.size - order.filledSize;

    if (remainingSize > 0) {
      // Option 1: Wait for full fill (limit orders)
      if (order.type === "LIMIT") {
        const waitTime = 5 * 60 * 1000; // 5 minutes
        setTimeout(() => this.checkAndHandleUnfilled(order), waitTime);
      }

      // Option 2: Cancel remaining and accept partial (market conditions changed)
      const currentPrice = await this.getCurrentPrice(order.symbol);
      const priceDeviation = Math.abs(currentPrice - order.price) / order.price;

      if (priceDeviation > 0.02) {
        // >2% price move
        await this.cancelRemainingOrder(order);
        await this.recordPartialFill(order);
      }
    }
  }

  async checkAndHandleUnfilled(order: Order): Promise<void> {
    const currentOrder = await this.weexClient.getOrder(order.orderId);

    if (currentOrder.status === "open") {
      // Still unfilled, decide action
      const decision = await this.decideUnfilledAction(currentOrder);

      switch (decision) {
        case "CANCEL":
          await this.weexClient.cancelOrder(order.orderId);
          break;
        case "MODIFY":
          // Cancel and replace at new price
          await this.weexClient.cancelOrder(order.orderId);
          await this.placeNewOrder(order, decision.newPrice);
          break;
        case "WAIT":
          // Continue waiting
          setTimeout(() => this.checkAndHandleUnfilled(order), 5 * 60 * 1000);
          break;
      }
    }
  }
}
```

### Edge Case 2: WebSocket Disconnection During Trade

**Scenario:** WebSocket disconnects while waiting for order confirmation.

**Solution:**

```typescript
class OrderConfirmationService {
  private pendingConfirmations: Map<string, PendingOrder> = new Map();

  async waitForConfirmation(
    clientOrderId: string,
    timeout: number = 30000
  ): Promise<OrderConfirmation> {
    return new Promise((resolve, reject) => {
      const pending: PendingOrder = {
        clientOrderId,
        resolve,
        reject,
        timeout: setTimeout(() => this.handleTimeout(clientOrderId), timeout),
        createdAt: Date.now(),
      };

      this.pendingConfirmations.set(clientOrderId, pending);
    });
  }

  private async handleTimeout(clientOrderId: string): Promise<void> {
    const pending = this.pendingConfirmations.get(clientOrderId);
    if (!pending) return;

    // WebSocket might be down, fall back to REST API
    try {
      const order = await this.weexClient.getOrderByClientId(clientOrderId);

      if (order) {
        pending.resolve({ success: true, order });
      } else {
        // Order not found - might not have been submitted
        pending.reject(new Error("Order not found after timeout"));
      }
    } catch (error) {
      pending.reject(error);
    } finally {
      this.pendingConfirmations.delete(clientOrderId);
    }
  }

  // Called when WebSocket reconnects
  async reconcilePendingOrders(): Promise<void> {
    for (const [clientOrderId, pending] of this.pendingConfirmations) {
      try {
        const order = await this.weexClient.getOrderByClientId(clientOrderId);
        if (order) {
          clearTimeout(pending.timeout);
          pending.resolve({ success: true, order });
        }
      } catch (error) {
        // Continue checking others
      }
    }
  }
}
```

### Edge Case 3: Duplicate Order Prevention

**Scenario:** Network timeout causes retry, but original order was actually placed.

**Solution:**

```typescript
class IdempotentOrderService {
  private orderCache: LRUCache<string, Order>;

  generateClientOrderId(
    portfolioId: string,
    symbol: string,
    side: string,
    timestamp: number
  ): string {
    // Deterministic ID based on inputs
    const hash = crypto
      .createHash("sha256")
      .update(`${portfolioId}-${symbol}-${side}-${timestamp}`)
      .digest("hex")
      .substring(0, 32);
    return `${timestamp}_${hash}`;
  }

  async placeOrderIdempotent(request: OrderRequest): Promise<Order> {
    const clientOrderId = request.clientOrderId;

    // Check cache first
    const cached = this.orderCache.get(clientOrderId);
    if (cached) {
      return cached;
    }

    // Check database
    const existing = await this.db.query(
      "SELECT * FROM trades WHERE client_order_id = $1",
      [clientOrderId]
    );

    if (existing.rows.length > 0) {
      return existing.rows[0];
    }

    // Check WEEX (in case we crashed after placing but before recording)
    try {
      const weexOrder = await this.weexClient.getOrderByClientId(clientOrderId);
      if (weexOrder) {
        // Record it and return
        await this.recordOrder(weexOrder);
        return weexOrder;
      }
    } catch (error) {
      // Order doesn't exist on WEEX, safe to place
    }

    // Place new order
    const order = await this.weexClient.placeOrder(request);
    this.orderCache.set(clientOrderId, order);
    await this.recordOrder(order);

    return order;
  }
}
```

### Edge Case 4: Price Slippage Protection

**Scenario:** Market order executes at much worse price than expected.

**Solution:**

```typescript
class SlippageProtection {
  private maxSlippagePercent: number = 0.5; // 0.5%

  async executeWithSlippageProtection(
    request: OrderRequest
  ): Promise<OrderResult> {
    const ticker = await this.weexClient.getTicker(request.symbol);
    const expectedPrice =
      request.side === "BUY"
        ? parseFloat(ticker.best_ask)
        : parseFloat(ticker.best_bid);

    // For market orders, use limit order with slippage buffer
    if (request.type === "MARKET") {
      const slippageBuffer = (expectedPrice * this.maxSlippagePercent) / 100;
      const limitPrice =
        request.side === "BUY"
          ? expectedPrice + slippageBuffer
          : expectedPrice - slippageBuffer;

      // Convert to IOC limit order
      const modifiedRequest: OrderRequest = {
        ...request,
        type: "LIMIT",
        orderType: "IOC", // Immediate or Cancel
        price: limitPrice,
      };

      const result = await this.weexClient.placeOrder(modifiedRequest);

      // Check actual slippage
      if (result.status === "filled") {
        const actualSlippage =
          Math.abs(result.avgPrice - expectedPrice) / expectedPrice;
        if (actualSlippage > this.maxSlippagePercent / 100) {
          await this.logSlippageEvent(request, expectedPrice, result.avgPrice);
        }
      }

      return result;
    }

    return this.weexClient.placeOrder(request);
  }
}
```

### Edge Case 5: Concurrent Agent Trades

**Scenario:** Multiple agents try to trade same symbol simultaneously.

**Solution:**

```typescript
class ConcurrentTradeManager {
  private symbolLocks: Map<string, Mutex> = new Map();
  private portfolioLocks: Map<string, Mutex> = new Map();

  async executeTradeWithLock(
    portfolioId: string,
    symbol: string,
    tradeFn: () => Promise<TradeResult>
  ): Promise<TradeResult> {
    // Get or create locks
    const symbolLock = this.getOrCreateLock(this.symbolLocks, symbol);
    const portfolioLock = this.getOrCreateLock(
      this.portfolioLocks,
      portfolioId
    );

    // Acquire both locks (deadlock prevention: always acquire in same order)
    const locks = [symbolLock, portfolioLock].sort((a, b) =>
      a.id.localeCompare(b.id)
    );

    for (const lock of locks) {
      await lock.acquire();
    }

    try {
      // Re-validate conditions after acquiring lock
      const canTrade = await this.validateTradeConditions(portfolioId, symbol);
      if (!canTrade.valid) {
        throw new Error(canTrade.reason);
      }

      return await tradeFn();
    } finally {
      for (const lock of locks.reverse()) {
        lock.release();
      }
    }
  }

  private async validateTradeConditions(
    portfolioId: string,
    symbol: string
  ): Promise<ValidationResult> {
    // Check if another trade for same symbol is pending
    const pendingTrades = await this.db.query(
      `SELECT * FROM trades 
       WHERE portfolio_id = $1 AND symbol = $2 AND status = 'pending'`,
      [portfolioId, symbol]
    );

    if (pendingTrades.rows.length > 0) {
      return { valid: false, reason: "Pending trade exists for this symbol" };
    }

    return { valid: true };
  }
}
```

### Edge Case 6: API Key Rotation During Active Trading

**Scenario:** User rotates API keys while trades are in progress.

**Solution:**

```typescript
class APIKeyManager {
  private activeKeys: Map<string, WeexCredentials> = new Map();
  private pendingRotations: Map<string, RotationRequest> = new Map();

  async rotateKeys(
    userId: string,
    newCredentials: WeexCredentials
  ): Promise<RotationResult> {
    // Check for active operations
    const activeOps = await this.getActiveOperations(userId);

    if (activeOps.length > 0) {
      // Queue rotation for after operations complete
      this.pendingRotations.set(userId, {
        newCredentials,
        requestedAt: Date.now(),
        waitingFor: activeOps.map((op) => op.id),
      });

      return {
        status: "QUEUED",
        message: `Rotation queued. ${activeOps.length} operations in progress.`,
        estimatedCompletion: this.estimateCompletion(activeOps),
      };
    }

    // No active operations, rotate immediately
    return this.performRotation(userId, newCredentials);
  }

  private async performRotation(
    userId: string,
    newCredentials: WeexCredentials
  ): Promise<RotationResult> {
    const oldCredentials = this.activeKeys.get(userId);

    // Validate new credentials
    const validation = await this.validateCredentials(newCredentials);
    if (!validation.valid) {
      return { status: "FAILED", error: validation.error };
    }

    // Update in database (encrypted)
    await this.db.query(
      `UPDATE weex_accounts 
       SET api_key = $1, secret_key = $2, passphrase = $3, updated_at = NOW()
       WHERE user_id = $4`,
      [
        this.encrypt(newCredentials.apiKey),
        this.encrypt(newCredentials.secretKey),
        this.encrypt(newCredentials.passphrase),
        userId,
      ]
    );

    // Update in memory
    this.activeKeys.set(userId, newCredentials);

    // Reconnect WebSocket with new credentials
    await this.wsManager.reconnectWithNewCredentials(userId, newCredentials);

    return { status: "SUCCESS" };
  }
}
```

### Edge Case 7: Database Connection Pool Exhaustion

**Scenario:** High load exhausts database connections.

**Solution:**

```typescript
class DatabasePoolManager {
  private pool: Pool;
  private waitingQueries: PriorityQueue<QueuedQuery>;
  private maxWaitTime: number = 5000;

  constructor() {
    this.pool = new Pool({
      max: 20, // Max connections
      min: 5, // Min connections
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      maxUses: 7500, // Recycle connections
    });

    this.pool.on("error", (err) => {
      console.error("Unexpected pool error", err);
      this.handlePoolError(err);
    });
  }

  async query<T>(
    sql: string,
    params: any[],
    priority: "HIGH" | "NORMAL" | "LOW" = "NORMAL"
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const client = await this.pool.connect();
      try {
        const result = await client.query(sql, params);
        return result.rows as T;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error.message.includes("timeout") || error.message.includes("pool")) {
        // Pool exhausted, queue the query
        if (priority === "HIGH") {
          // For critical queries, wait and retry
          await this.waitForConnection();
          return this.query(sql, params, priority);
        } else {
          throw new Error("Database pool exhausted. Please try again later.");
        }
      }
      throw error;
    }
  }

  private async waitForConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        const stats = await this.pool.totalCount;
        if (stats < this.pool.options.max) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("Timeout waiting for database connection"));
      }, this.maxWaitTime);
    });
  }
}
```

### Edge Case 8: Gemini API Rate Limits

**Scenario:** Analysis requests exceed Gemini rate limits.

**Solution:**

```typescript
class GeminiRateLimiter {
  private requestsPerMinute: number = 60;
  private tokensPerMinute: number = 1000000;
  private requestBucket: TokenBucket;
  private tokenBucket: TokenBucket;
  private queue: PriorityQueue<QueuedRequest>;

  async generateWithRateLimit(
    prompt: string,
    priority: "HIGH" | "NORMAL" | "LOW" = "NORMAL"
  ): Promise<string> {
    const estimatedTokens = this.estimateTokens(prompt);

    // Check if we can proceed
    const canProceed =
      (await this.requestBucket.tryConsume(1)) &&
      (await this.tokenBucket.tryConsume(estimatedTokens));

    if (!canProceed) {
      if (priority === "HIGH") {
        // Wait for capacity
        await this.waitForCapacity(estimatedTokens);
      } else {
        // Queue for later
        return this.queueRequest(prompt, priority);
      }
    }

    try {
      const result = await this.gemini.generateContent(prompt);
      return result.response.text();
    } catch (error) {
      if (error.status === 429) {
        // Rate limited, back off
        const retryAfter = error.headers?.["retry-after"] || 60;
        await sleep(retryAfter * 1000);
        return this.generateWithRateLimit(prompt, priority);
      }
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}
```

### Edge Case 9: Position Reconciliation

**Scenario:** Local position state differs from WEEX state.

**Solution:**

```typescript
class PositionReconciliationService {
  async reconcilePositions(portfolioId: string): Promise<ReconciliationResult> {
    // Get local positions
    const localPositions = await this.db.query(
      "SELECT * FROM positions WHERE portfolio_id = $1 AND is_open = true",
      [portfolioId]
    );

    // Get WEEX positions
    const weexPositions = await this.weexClient.getAllPositions();

    const discrepancies: Discrepancy[] = [];

    // Check each local position
    for (const local of localPositions.rows) {
      const weex = weexPositions.find(
        (p) => p.symbol === local.symbol && p.side === local.side
      );

      if (!weex) {
        // Position exists locally but not on WEEX
        discrepancies.push({
          type: "MISSING_ON_EXCHANGE",
          local,
          weex: null,
          action: "CLOSE_LOCAL",
        });
      } else if (Math.abs(parseFloat(weex.size) - local.size) > 0.0001) {
        // Size mismatch
        discrepancies.push({
          type: "SIZE_MISMATCH",
          local,
          weex,
          action: "UPDATE_LOCAL",
        });
      }
    }

    // Check for positions on WEEX not in local
    for (const weex of weexPositions) {
      const local = localPositions.rows.find(
        (p) => p.symbol === weex.symbol && p.side === weex.side
      );

      if (!local) {
        discrepancies.push({
          type: "MISSING_LOCALLY",
          local: null,
          weex,
          action: "CREATE_LOCAL",
        });
      }
    }

    // Apply fixes
    for (const disc of discrepancies) {
      await this.applyFix(disc, portfolioId);
    }

    return {
      discrepanciesFound: discrepancies.length,
      discrepancies,
      fixesApplied: discrepancies.length,
    };
  }

  private async applyFix(
    discrepancy: Discrepancy,
    portfolioId: string
  ): Promise<void> {
    switch (discrepancy.action) {
      case "CLOSE_LOCAL":
        await this.db.query(
          "UPDATE positions SET is_open = false, closed_at = NOW() WHERE id = $1",
          [discrepancy.local.id]
        );
        break;

      case "UPDATE_LOCAL":
        await this.db.query(
          `UPDATE positions 
           SET size = $1, current_price = $2, unrealized_pnl = $3, updated_at = NOW()
           WHERE id = $4`,
          [
            discrepancy.weex.size,
            discrepancy.weex.markPrice,
            discrepancy.weex.unrealizePnl,
            discrepancy.local.id,
          ]
        );
        break;

      case "CREATE_LOCAL":
        await this.db.query(
          `INSERT INTO positions (id, portfolio_id, symbol, side, size, entry_price, 
           current_price, margin_mode, leverage, unrealized_pnl, weex_position_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            uuid(),
            portfolioId,
            discrepancy.weex.symbol,
            discrepancy.weex.side,
            discrepancy.weex.size,
            discrepancy.weex.open_value / discrepancy.weex.size,
            discrepancy.weex.markPrice,
            discrepancy.weex.margin_mode,
            discrepancy.weex.leverage,
            discrepancy.weex.unrealizePnl,
            discrepancy.weex.id,
          ]
        );
        break;
    }
  }
}
```

### Edge Case 10: Graceful Shutdown

**Scenario:** Server needs to restart while trades are in progress.

**Solution:**

```typescript
class GracefulShutdownManager {
  private isShuttingDown: boolean = false;
  private activeOperations: Set<string> = new Set();
  private shutdownTimeout: number = 30000; // 30 seconds

  constructor() {
    process.on("SIGTERM", () => this.initiateShutdown("SIGTERM"));
    process.on("SIGINT", () => this.initiateShutdown("SIGINT"));
  }

  registerOperation(operationId: string): void {
    if (this.isShuttingDown) {
      throw new Error("Server is shutting down. Cannot start new operations.");
    }
    this.activeOperations.add(operationId);
  }

  completeOperation(operationId: string): void {
    this.activeOperations.delete(operationId);

    if (this.isShuttingDown && this.activeOperations.size === 0) {
      this.finalizeShutdown();
    }
  }

  private async initiateShutdown(signal: string): Promise<void> {
    console.log(`Received ${signal}. Initiating graceful shutdown...`);
    this.isShuttingDown = true;

    // Stop accepting new requests
    this.httpServer.close();

    // Stop job schedulers
    await this.jobScheduler.pause();

    // Wait for active operations
    if (this.activeOperations.size > 0) {
      console.log(
        `Waiting for ${this.activeOperations.size} operations to complete...`
      );

      const timeout = setTimeout(() => {
        console.log("Shutdown timeout reached. Forcing shutdown...");
        this.forceShutdown();
      }, this.shutdownTimeout);

      // Wait for operations to complete
      await this.waitForOperations();
      clearTimeout(timeout);
    }

    this.finalizeShutdown();
  }

  private async waitForOperations(): Promise<void> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.activeOperations.size === 0) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  private async finalizeShutdown(): Promise<void> {
    console.log("Finalizing shutdown...");

    // Close WebSocket connections gracefully
    await this.wsManager.closeAll();

    // Close database connections
    await this.db.end();

    // Close Redis connections
    await this.redis.quit();

    console.log("Shutdown complete.");
    process.exit(0);
  }

  private forceShutdown(): void {
    console.log("Force shutdown. Some operations may be incomplete.");

    // Log incomplete operations for recovery
    for (const opId of this.activeOperations) {
      console.log(`Incomplete operation: ${opId}`);
    }

    process.exit(1);
  }
}
```
