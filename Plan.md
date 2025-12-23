# Hypothesis Arena - Monorepo Implementation Status

## Overview

Monorepo with backend + frontend for AI-powered investment analysis with real WEEX futures trading.

**Last Updated:** December 23, 2025

---

## ✅ Implementation Status

### Completed Features

| Component             | Status      | Notes                                 |
| --------------------- | ----------- | ------------------------------------- |
| Monorepo Structure    | ✅ Complete | npm workspaces configured             |
| Shared Package        | ✅ Complete | Types, utils, constants               |
| Backend Server        | ✅ Complete | Express with graceful shutdown        |
| Frontend App          | ✅ Complete | Vite + React 19                       |
| Database Config       | ✅ Complete | PostgreSQL with pool management       |
| Redis Config          | ✅ Complete | Caching with reconnection             |
| Auth System           | ✅ Complete | JWT with refresh tokens               |
| WEEX Client           | ✅ Complete | Signature, rate limiting              |
| Trading Service       | ✅ Complete | Order execution, portfolio management |
| WebSocket Manager     | ✅ Complete | Heartbeat, client management          |
| API Client (Frontend) | ✅ Complete | Timeout, retry, abort support         |
| Trading API           | ✅ Complete | Backend-only (paper trading removed)  |
| Database Migrations   | ✅ Complete | Initial schema                        |

### Recent Changes (December 23, 2025)

**Paper Trading Removal:**

- Removed all localStorage-based paper trading from frontend
- Frontend now only communicates with backend for trading operations
- Deleted: `packages/frontend/src/services/trading/` folder
- Deleted: `packages/frontend/src/hooks/useTradingSystem.ts`
- Deleted: `packages/frontend/src/types/trading.ts`
- Deleted: `packages/frontend/src/components/trading/` folder
- Simplified `tradingApi` to match actual backend endpoints

---

## Current Project Structure

```
hypothesis-arena/
├── package.json              # Root (workspaces)
├── .env                      # Environment variables
├── .env.example
├── Dockerfile
├── docs/                     # WEEX API documentation
│
├── packages/
│   ├── frontend/             # Vite React App
│   │   ├── package.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── components/
│   │       │   ├── analysis/     # RecommendationCard, AnalystCard, DebateView
│   │       │   ├── charts/       # PriceChart, TechnicalsCard, NewsCard
│   │       │   ├── common/       # ErrorBoundary
│   │       │   ├── layout/       # StockArena, TickerInput, StockHeader, etc.
│   │       │   └── sidebar/      # Watchlist, SavedAnalyses, AccuracyTracker
│   │       ├── services/
│   │       │   ├── api/          # client.ts, trading.ts, websocket.ts
│   │       │   ├── data/         # yahooFinance.ts
│   │       │   ├── stock/        # Analysis services
│   │       │   └── utils/
│   │       ├── types/
│   │       └── constants/
│   │
│   ├── backend/              # Express Server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── migrations/
│   │   │   └── 001_initial.sql
│   │   └── src/
│   │       ├── server.ts         # Main entry with graceful shutdown
│   │       ├── api/
│   │       │   ├── routes/       # auth, trading, portfolio
│   │       │   ├── middleware/   # auth, errorHandler
│   │       │   └── controllers/
│   │       ├── services/
│   │       │   ├── auth/         # AuthService
│   │       │   ├── trading/      # TradingService
│   │       │   ├── weex/         # WeexClient, WebSocketManager
│   │       │   ├── analysis/     # AnalysisService
│   │       │   └── compliance/   # AILogService
│   │       ├── config/           # database, redis, index
│   │       ├── utils/            # errors, logger
│   │       └── scripts/          # migrate.ts
│   │
│   └── shared/               # Shared Types & Utils
│       ├── package.json
│       └── src/
│           ├── index.ts
│           ├── types/
│           │   ├── trading.ts    # Trade, Portfolio, Position, etc.
│           │   ├── analysis.ts
│           │   ├── auth.ts
│           │   └── weex.ts
│           └── utils/
│               ├── constants.ts  # APPROVED_SYMBOLS
│               └── validation.ts # isApprovedSymbol
```

---

## API Routes (Implemented)

| Method | Endpoint                          | Description                | Status |
| ------ | --------------------------------- | -------------------------- | ------ |
| POST   | /api/auth/register                | Register user              | ✅     |
| POST   | /api/auth/login                   | Login                      | ✅     |
| POST   | /api/auth/refresh                 | Refresh token              | ✅     |
| GET    | /api/auth/me                      | Get current user           | ✅     |
| POST   | /api/auth/logout                  | Logout                     | ✅     |
| GET    | /api/portfolio/summary            | Get all portfolios summary | ✅     |
| GET    | /api/portfolio/:agentId           | Get single portfolio       | ✅     |
| GET    | /api/portfolio/:agentId/positions | Get positions (from WEEX)  | ✅     |
| POST   | /api/portfolio/create             | Create portfolio           | ✅     |
| POST   | /api/trading/execute              | Execute trade              | ✅     |
| GET    | /api/trading/orders               | Get orders                 | ✅     |
| GET    | /api/trading/order/:id            | Get single order           | ✅     |
| POST   | /api/trading/cancel               | Cancel order               | ✅     |

---

## Frontend API Client

```typescript
// packages/frontend/src/services/api/trading.ts
export const tradingApi = {
    executeTrade(decision: TradeDecision): Promise<Trade>
    getPortfolio(agentId: string): Promise<Portfolio>
    getPortfolioSummary(): Promise<PortfolioSummaryResponse>
    getPositions(agentId: string): Promise<Position[]>
    createPortfolio(agentName: string, initialBalance?: number): Promise<Portfolio>
};
```

---

## Quick Start Commands

```bash
# Development
npm install
npm run db:migrate
npm run dev

# Production
npm run build
npm start

# Docker
docker build -t hypothesis-arena .
docker run -p 3000:3000 --env-file .env hypothesis-arena
```

---

## Environment Variables

```env
# Server
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Database (Neon recommended)
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Redis (Upstash recommended)
REDIS_URL=rediss://default:xxx@xxx.upstash.io:6379

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRY=7d

# WEEX API
WEEX_API_KEY=
WEEX_SECRET_KEY=
WEEX_PASSPHRASE=
WEEX_BASE_URL=https://api-contract.weex.com
WEEX_WS_URL=wss://ws-contract.weex.com/v2/ws

# Gemini API
GEMINI_API_KEY=

# Frontend
VITE_API_URL=/api
VITE_WS_URL=/ws
```

---

## Database Schema (001_initial.sql)

```sql
-- Users
CREATE TABLE users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    username VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Portfolios
CREATE TABLE portfolios (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES users(id),
    agent_name VARCHAR(100) NOT NULL,
    initial_balance DECIMAL(20,8) DEFAULT 100000,
    current_balance DECIMAL(20,8) DEFAULT 100000,
    total_return DECIMAL(10,4) DEFAULT 0,
    win_rate DECIMAL(5,2) DEFAULT 0,
    sharpe_ratio DECIMAL(10,4),
    max_drawdown DECIMAL(10,4) DEFAULT 0,
    total_trades INTEGER DEFAULT 0,
    winning_trades INTEGER DEFAULT 0,
    losing_trades INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Positions
CREATE TABLE positions (
    id UUID PRIMARY KEY,
    portfolio_id UUID REFERENCES portfolios(id),
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL,
    size DECIMAL(20,8) NOT NULL,
    entry_price DECIMAL(20,8) NOT NULL,
    current_price DECIMAL(20,8),
    margin_mode VARCHAR(20) DEFAULT 'CROSS',
    leverage INTEGER DEFAULT 1,
    unrealized_pnl DECIMAL(20,8) DEFAULT 0,
    realized_pnl DECIMAL(20,8) DEFAULT 0,
    is_open BOOLEAN DEFAULT true,
    weex_position_id VARCHAR(100),
    opened_at TIMESTAMP DEFAULT NOW(),
    closed_at TIMESTAMP
);

-- Trades
CREATE TABLE trades (
    id UUID PRIMARY KEY,
    portfolio_id UUID REFERENCES portfolios(id),
    position_id UUID REFERENCES positions(id),
    symbol VARCHAR(50) NOT NULL,
    side VARCHAR(10) NOT NULL,
    type VARCHAR(20) NOT NULL,
    size DECIMAL(20,8) NOT NULL,
    price DECIMAL(20,8) NOT NULL,
    fee DECIMAL(20,8) DEFAULT 0,
    status VARCHAR(20) NOT NULL,
    reason TEXT,
    confidence DECIMAL(5,2),
    client_order_id VARCHAR(100),
    weex_order_id VARCHAR(100),
    executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);
```

---

## Shared Types (Key Interfaces)

```typescript
// packages/shared/src/types/trading.ts
export interface Portfolio {
  id: string;
  agentId: string;
  agentName: string;
  userId?: string;
  initialBalance: number;
  currentBalance: number;
  totalValue: number;
  totalReturn: number;
  totalReturnDollar: number;
  winRate: number;
  sharpeRatio: number | null;
  maxDrawdown: number;
  currentDrawdown: number;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  positions: Position[];
  trades: Trade[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "paused" | "liquidated";
}

export interface Trade {
  id: string;
  portfolioId: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: number;
  price: number;
  status: OrderStatus;
  // ... more fields
}

export interface Position {
  id: string;
  portfolioId: string;
  symbol: string;
  side: PositionSide;
  size: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
  leverage: number;
  // ... more fields
}
```

---

## Approved Trading Symbols

```typescript
// packages/shared/src/utils/constants.ts
export const APPROVED_SYMBOLS = [
  "btcusdt",
  "ethusdt",
  "solusdt",
  "bnbusdt",
  "xrpusdt",
  "dogeusdt",
  "adausdt",
  "avaxusdt",
  "dotusdt",
  "linkusdt",
  "maticusdt",
  "ltcusdt",
];
```

---

## Key Implementation Details

### Backend Server (server.ts)

- Express with helmet, compression, CORS
- Rate limiting (100 req/15min)
- WebSocket on `/ws` path
- Graceful shutdown with 30s timeout
- Health check endpoint with DB/Redis status

### API Client (client.ts)

- 30s default timeout
- Retry with exponential backoff (GET only)
- AbortController support
- Token refresh on 401
- Proper error handling with ApiError class

### WebSocket Manager

- Heartbeat every 30s
- Client timeout after 60s
- Subscription-based channels
- Proper cleanup on shutdown

### Database

- Connection pool (max 20, min 2)
- Idle timeout 30s
- Query logging for slow queries (>1s)
- Transaction helper with automatic rollback

### Redis

- Reconnection strategy (max 10 retries)
- Cache helpers (get, set, delete)
- Default TTL 300s

---

## WEEX API Implementation Status

### ✅ Implemented Endpoints

| Category              | Endpoint                                   | Method | Description |
| --------------------- | ------------------------------------------ | ------ | ----------- |
| **Market (Public)**   |                                            |        |             |
| Server Time           | `/capi/v2/market/time`                     | GET    | ✅          |
| Single Ticker         | `/capi/v2/market/ticker`                   | GET    | ✅          |
| All Tickers           | `/capi/v2/market/tickers`                  | GET    | ✅          |
| Orderbook Depth       | `/capi/v2/market/depth`                    | GET    | ✅          |
| Funding Rate          | `/capi/v2/market/fundingRate`              | GET    | ✅          |
| Trades                | `/capi/v2/market/trades`                   | GET    | ✅ NEW      |
| Candlesticks          | `/capi/v2/market/candles`                  | GET    | ✅ NEW      |
| Contracts Info        | `/capi/v2/market/contracts`                | GET    | ✅ NEW      |
| **Account (Private)** |                                            |        |             |
| Account List          | `/capi/v2/account/accounts`                | GET    | ✅          |
| Account Assets        | `/capi/v2/account/assets`                  | GET    | ✅ NEW      |
| All Positions         | `/capi/v2/account/position/allPosition`    | GET    | ✅          |
| Single Position       | `/capi/v2/account/position/singlePosition` | GET    | ✅          |
| Change Leverage       | `/capi/v2/account/leverage`                | POST   | ✅ NEW      |
| **Trading (Private)** |                                            |        |             |
| Place Order           | `/capi/v2/order/placeOrder`                | POST   | ✅          |
| Cancel Order          | `/capi/v2/order/cancel_order`              | POST   | ✅          |
| Get Order             | `/capi/v2/order/detail`                    | GET    | ✅          |
| Current Orders        | `/capi/v2/order/current`                   | GET    | ✅ NEW      |
| Order History         | `/capi/v2/order/history`                   | GET    | ✅ NEW      |
| Get Fills             | `/capi/v2/order/fills`                     | GET    | ✅ NEW      |
| Batch Orders          | `/capi/v2/order/batchOrders`               | POST   | ✅ NEW      |
| Batch Cancel          | `/capi/v2/order/batchCancelOrders`         | POST   | ✅ NEW      |
| Close All Positions   | `/capi/v2/order/closeAllPositions`         | POST   | ✅ NEW      |
| Upload AI Log         | `/capi/v2/order/uploadAiLog`               | POST   | ✅          |

### Backend Routes (NEW)

| Route                              | Method | Auth | Description              |
| ---------------------------------- | ------ | ---- | ------------------------ |
| `/api/weex/status`                 | GET    | No   | Test WEEX connection     |
| `/api/weex/tickers`                | GET    | No   | Get all approved tickers |
| `/api/weex/ticker/:symbol`         | GET    | No   | Get single ticker        |
| `/api/weex/depth/:symbol`          | GET    | No   | Get orderbook            |
| `/api/weex/candles/:symbol`        | GET    | No   | Get candlestick data     |
| `/api/weex/contracts`              | GET    | No   | Get contract info        |
| `/api/weex/account`                | GET    | Yes  | Get account info         |
| `/api/weex/assets`                 | GET    | Yes  | Get account assets       |
| `/api/weex/positions`              | GET    | Yes  | Get all positions        |
| `/api/weex/position/:symbol`       | GET    | Yes  | Get single position      |
| `/api/weex/orders`                 | GET    | Yes  | Get current orders       |
| `/api/weex/orders/history/:symbol` | GET    | Yes  | Get order history        |
| `/api/weex/fills/:symbol`          | GET    | Yes  | Get trade fills          |
| `/api/weex/leverage`               | POST   | Yes  | Change leverage          |
| `/api/weex/test-auth`              | POST   | Yes  | Test full auth flow      |

### Frontend Services (NEW)

```typescript
// packages/frontend/src/services/api/weex.ts
export const weexApi = {
    // Public
    getStatus(): Promise<WeexStatus>
    getTickers(): Promise<WeexTicker[]>
    getTicker(symbol): Promise<WeexTicker>
    getDepth(symbol, limit): Promise<WeexDepth>
    getCandles(symbol, interval, limit): Promise<WeexCandle[]>
    getContracts(): Promise<WeexContract[]>

    // Private (auth required)
    getAccount(): Promise<any[]>
    getAssets(): Promise<WeexAssets>
    getPositions(): Promise<WeexPosition[]>
    getPosition(symbol): Promise<WeexPosition>
    getCurrentOrders(symbol?): Promise<any[]>
    getOrderHistory(symbol, limit): Promise<any[]>
    getFills(symbol, limit): Promise<any[]>
    changeLeverage(symbol, leverage, marginMode?): Promise<any>
    testAuth(): Promise<WeexAuthTestResult>
};
```

---

## Architecture Notes

1. **Live Trading Only**: Paper trading has been removed. All trading goes through backend → WEEX.

2. **Authentication**: JWT-based with refresh tokens. Frontend stores tokens in localStorage.

3. **Database**: PostgreSQL for persistence, Redis for caching and rate limiting.

4. **WebSocket**: Used for real-time updates from WEEX and broadcasting to clients.

5. **Error Handling**: Centralized error handler with proper HTTP status codes.

---

**Status:** Production Ready (Core Features)  
**Version:** 2.0.0

## TODO / Future Work

- [ ] Analysis service routes (POST /api/analysis/create, GET /api/analysis/:id)
- [ ] Leaderboard endpoint (GET /api/leaderboard)
- [ ] WEEX WebSocket integration (real-time price streaming)
- [ ] Job scheduling (BullMQ)
- [ ] Frontend auth UI (login/register forms)
- [ ] Trading UI components
- [ ] Performance monitoring
- [ ] E2E tests

---
