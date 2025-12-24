# Hypothesis Arena - Monorepo Implementation Status

## Overview

Monorepo with backend + frontend for AI-powered crypto trading analysis with real WEEX futures trading.
**8 AI analysts debate tournament-style, then execute trades on WEEX Exchange.**

**Last Updated:** December 24, 2025  
**WEEX Hackathon Deadline:** January 5, 2025

---

## ✅ Implementation Status

### Completed Features

| Component              | Status      | Notes                                         |
| ---------------------- | ----------- | --------------------------------------------- |
| Monorepo Structure     | ✅ Complete | npm workspaces configured                     |
| Shared Package         | ✅ Complete | Types, utils, constants                       |
| Backend Server         | ✅ Complete | Express 5 with graceful shutdown              |
| Frontend App           | ✅ Complete | Vite + React 19 + Cinematic UI                |
| Database Config        | ✅ Complete | PostgreSQL (Neon) with pool management        |
| Redis Config           | ✅ Complete | Caching with reconnection (Upstash)           |
| Auth System            | ✅ Complete | JWT with refresh tokens                       |
| WEEX Client            | ✅ Complete | Signature, rate limiting, all endpoints       |
| WebSocket Manager      | ✅ Complete | Heartbeat, client management, security        |
| API Client (Frontend)  | ✅ Complete | Timeout, retry, abort support                 |
| Trading API            | ✅ Complete | Order execution, portfolio management         |
| Analysis API           | ✅ Complete | 8 analysts, debates, tournaments, signals     |
| AI Service (Gemini)    | ✅ Complete | Full tournament system with trading decisions |
| Database Migrations    | ✅ Complete | Initial schema                                |
| Frontend UI Components | ✅ Complete | Glass morphism, cinematic command center      |

### Recent Changes (December 24, 2025)

**Frontend Modularization:**

- Reorganized into `arena/`, `trading/`, `layout/`, `ui/` component folders
- Cinematic command center styling with glass morphism
- Removed all stock-related files (now crypto-only)

**Code Quality Fixes:**

- Added NaN/null guards throughout frontend components
- Fixed WebSocket security (UUID client IDs, input validation, max clients)
- Fixed Redis race condition in shutdown
- Improved logging (proper logger usage, dev/prod modes)

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
│   │   └── src/
│   │       ├── App.tsx
│   │       ├── index.css         # Cinematic styles
│   │       ├── components/
│   │       │   ├── arena/        # AnalystCard, ChampionCard, DebateCard, AnalysisSummary
│   │       │   ├── trading/      # OrderBook, PositionsPanel, TradingPanel
│   │       │   ├── layout/       # LiveArena, Header, MarketSidebar, AuthModal
│   │       │   ├── ui/           # CircularMeter, PriceRangeBar, ScoreBar, GlassCard
│   │       │   └── common/       # ErrorBoundary
│   │       ├── services/
│   │       │   ├── api/          # client, weex, trading, analysis, websocket
│   │       │   └── utils/        # logger
│   │       └── types/
│   │
│   ├── backend/              # Express Server
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── migrations/
│   │   │   └── 001_initial.sql
│   │   └── src/
│   │       ├── server.ts
│   │       ├── api/
│   │       │   ├── routes/       # auth, trading, portfolio, weex, analysis
│   │       │   └── middleware/   # auth, errorHandler
│   │       ├── services/
│   │       │   ├── ai/           # GeminiService (full tournament system)
│   │       │   ├── auth/         # AuthService
│   │       │   ├── trading/      # TradingService
│   │       │   ├── weex/         # WeexClient, WebSocketManager
│   │       │   ├── analysis/     # AnalysisService
│   │       │   └── compliance/   # AILogService
│   │       ├── config/           # database, redis, index
│   │       ├── constants/        # analystPrompts (8 analysts)
│   │       └── utils/            # errors, logger
│   │
│   └── shared/               # Shared Types & Utils
│       ├── package.json
│       └── src/
│           ├── types/            # trading, analysis, auth, weex
│           └── utils/            # constants, validation
```

---

## API Routes (All Implemented)

### Auth Routes

| Method | Endpoint           | Auth | Description      |
| ------ | ------------------ | ---- | ---------------- |
| POST   | /api/auth/register | No   | Register user    |
| POST   | /api/auth/login    | No   | Login            |
| POST   | /api/auth/refresh  | No   | Refresh token    |
| GET    | /api/auth/me       | Yes  | Get current user |
| POST   | /api/auth/logout   | Yes  | Logout           |

### Portfolio Routes

| Method | Endpoint                          | Auth | Description             |
| ------ | --------------------------------- | ---- | ----------------------- |
| GET    | /api/portfolio/summary            | Yes  | Get all portfolios      |
| GET    | /api/portfolio/:agentId           | Yes  | Get single portfolio    |
| GET    | /api/portfolio/:agentId/positions | Yes  | Get positions from WEEX |
| POST   | /api/portfolio/create             | Yes  | Create portfolio        |

### Trading Routes

| Method | Endpoint               | Auth | Description      |
| ------ | ---------------------- | ---- | ---------------- |
| POST   | /api/trading/execute   | Yes  | Execute trade    |
| GET    | /api/trading/orders    | Yes  | Get orders       |
| GET    | /api/trading/order/:id | Yes  | Get single order |
| POST   | /api/trading/cancel    | Yes  | Cancel order     |

### WEEX Routes (Public)

| Method | Endpoint                  | Auth | Description          |
| ------ | ------------------------- | ---- | -------------------- |
| GET    | /api/weex/status          | No   | Test WEEX connection |
| GET    | /api/weex/tickers         | No   | Get all tickers      |
| GET    | /api/weex/ticker/:symbol  | No   | Get single ticker    |
| GET    | /api/weex/depth/:symbol   | No   | Get orderbook        |
| GET    | /api/weex/candles/:symbol | No   | Get candlesticks     |
| GET    | /api/weex/contracts       | No   | Get contract info    |

### WEEX Routes (Private)

| Method | Endpoint                         | Auth | Description         |
| ------ | -------------------------------- | ---- | ------------------- |
| GET    | /api/weex/account                | Yes  | Get account info    |
| GET    | /api/weex/assets                 | Yes  | Get account assets  |
| GET    | /api/weex/positions              | Yes  | Get all positions   |
| GET    | /api/weex/position/:symbol       | Yes  | Get single position |
| GET    | /api/weex/orders                 | Yes  | Get current orders  |
| GET    | /api/weex/orders/history/:symbol | Yes  | Get order history   |
| GET    | /api/weex/fills/:symbol          | Yes  | Get trade fills     |
| POST   | /api/weex/leverage               | Yes  | Change leverage     |
| POST   | /api/weex/test-auth              | Yes  | Test full auth      |

### Analysis Routes (AI-Powered)

| Method | Endpoint                       | Auth     | Description                 |
| ------ | ------------------------------ | -------- | --------------------------- |
| GET    | /api/analysis/analysts         | No       | Get all 8 analyst personas  |
| GET    | /api/analysis/status           | No       | Check AI service status     |
| POST   | /api/analysis/generate         | Optional | Generate single analysis    |
| POST   | /api/analysis/generate-all     | Optional | Generate all 8 analyses     |
| POST   | /api/analysis/debate           | Optional | Generate debate between 2   |
| POST   | /api/analysis/signal           | Yes      | Generate trading signal     |
| POST   | /api/analysis/tournament       | Optional | Run full tournament         |
| GET    | /api/analysis/history          | Yes      | Get analysis history        |
| POST   | /api/analysis/trading-decision | Yes      | Generate executable order   |
| POST   | /api/analysis/extended         | Optional | Analysis with extended data |

---

## The 8 AI Analysts

| Analyst   | ID     | Methodology        | Focus                          |
| --------- | ------ | ------------------ | ------------------------------ |
| 🎩 Warren | warren | Value Investing    | Fundamentals, margin of safety |
| 🚀 Cathie | cathie | Growth Investing   | TAM expansion, disruption      |
| 📊 Jim    | jim    | Technical Analysis | RSI, MACD, chart patterns      |
| 🌍 Ray    | ray    | Macro Strategy     | Interest rates, correlations   |
| 📱 Elon   | elon   | Sentiment Analysis | Social sentiment, hype         |
| 🛡️ Karen  | karen  | Risk Management    | Volatility, drawdown           |
| 🤖 Quant  | quant  | Quantitative       | Factor models, statistics      |
| 😈 Devil  | devil  | Contrarian         | Consensus challenges           |

---

## Approved Trading Pairs (WEEX)

```typescript
export const APPROVED_SYMBOLS = [
  "cmt_btcusdt", // Bitcoin
  "cmt_ethusdt", // Ethereum
  "cmt_solusdt", // Solana
  "cmt_dogeusdt", // Dogecoin
  "cmt_xrpusdt", // XRP
  "cmt_adausdt", // Cardano
  "cmt_bnbusdt", // BNB
  "cmt_ltcusdt", // Litecoin
] as const;
```

---

## Quick Start Commands

```bash
# Install dependencies
npm install

# Run database migrations
npm run db:migrate

# Development (frontend + backend)
npm run dev

# Production build
npm run build
npm start

# Type checking
npm run typecheck

# Clean all node_modules and dist
npm run clean
```

---

## Environment Variables

```env
# Server
NODE_ENV=development
PORT=3000
LOG_LEVEL=info

# Database (Neon PostgreSQL)
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Redis (Upstash)
REDIS_URL=rediss://default:xxx@xxx.upstash.io:6379

# JWT
JWT_SECRET=your-secret-key
JWT_EXPIRY=7d
JWT_REFRESH_EXPIRY=30d

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

## Frontend Features

### UI Components

- **Glass morphism** cards with backdrop blur
- **Animated circular meters** for confidence/upside
- **Price range bars** with bull/bear/current markers
- **Score bars** for debate breakdowns
- **Scanline textures** for command center aesthetic
- **Golden accents** for champions

### Main Views

- **LiveArena** - Main dashboard with tabs
- **Market tab** - Order book visualization
- **Positions tab** - Open positions from WEEX
- **Analysis tab** - 8 AI analyst cards + champion
- **Debate tab** - Tournament bracket visualization
- **Trade tab** - Order entry form

---

## Architecture Notes

1. **Live Trading Only**: All trading goes through backend → WEEX API
2. **Tournament System**: 8 analysts → quarterfinals → semifinals → final → champion
3. **AI Compliance**: All AI decisions logged for WEEX compliance
4. **Real-time Data**: WebSocket + polling fallback for market data
5. **Security**: JWT auth, rate limiting, input validation, HMAC signatures

---

## TODO / Future Work

- [ ] WEEX WebSocket integration (real-time price streaming from exchange)
- [ ] Leaderboard endpoint (GET /api/leaderboard)
- [ ] Job scheduling (BullMQ for scheduled analysis)
- [ ] Performance monitoring (metrics endpoint)
- [ ] E2E tests
- [ ] Mobile responsive improvements

---

**Status:** Production Ready  
**Version:** 2.0.0
