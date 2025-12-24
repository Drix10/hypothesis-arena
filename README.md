<div align="center">
  <br />
  
  # ⚔️ Hypothesis Arena
  
  **AI-Powered Crypto Trading Platform for WEEX Exchange**
  
  *8 AI analysts debate crypto positions in tournament-style battles, then execute trades on WEEX futures*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev/)
  [![Express](https://img.shields.io/badge/Express-5-000000?logo=express)](https://expressjs.com/)
  [![Gemini](https://img.shields.io/badge/Gemini-2.0-4285F4?logo=google)](https://ai.google.dev/)
  [![WEEX](https://img.shields.io/badge/WEEX-Futures-00D4AA)](https://www.weex.com/)
  
  **🏆 WEEX Hackathon 2025 Submission**
  
</div>

---

## 🎯 What is Hypothesis Arena?

Hypothesis Arena is an AI-powered crypto trading platform that combines **tournament-style AI debates** with **live futures trading** on WEEX Exchange. Watch 8 specialized AI analysts battle it out over crypto positions, then execute winning strategies automatically.

### Core Features

- **8 AI Analysts** - Each with unique trading methodologies (Value, Growth, Technical, Macro, Sentiment, Risk, Quant, Contrarian)
- **Tournament Debates** - Quarterfinals → Semifinals → Championship battles
- **Live WEEX Trading** - Execute futures trades directly on WEEX Exchange
- **Real-Time Data** - Live prices, order books, and positions via WEEX API
- **Cinematic UI** - Glass morphism design with dramatic visual effects

---

## 🏗️ Architecture

```
hypothesis-arena/
├── packages/
│   ├── frontend/          # React 19 + Vite + TailwindCSS
│   ├── backend/           # Express 5 + PostgreSQL + Redis
│   └── shared/            # Shared types and utilities
├── docs/                  # WEEX API documentation
└── docker-compose.yml     # Production deployment
```

### Tech Stack

| Layer    | Technology                                                |
| -------- | --------------------------------------------------------- |
| Frontend | React 19, Vite, TailwindCSS, Framer Motion                |
| Backend  | Express 5, TypeScript, PostgreSQL (Neon), Redis (Upstash) |
| AI       | Google Gemini 2.0 Flash                                   |
| Exchange | WEEX Futures API                                          |
| Auth     | JWT with refresh tokens                                   |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database ([Neon](https://neon.tech) - free tier)
- Redis instance ([Upstash](https://upstash.com) - free tier)
- Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey))
- WEEX API credentials ([WEEX](https://www.weex.com/api))

### Installation

```bash
# Clone repository
git clone https://github.com/drix10/hypothesis-arena.git
cd hypothesis-arena

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your API keys

# Run database migrations
npm run db:migrate -w @hypothesis-arena/backend

# Start development (frontend + backend)
npm run dev
```

### Environment Variables

```env
# Database (Neon PostgreSQL)
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Redis (Upstash)
REDIS_URL=redis://default:pass@host:port

# AI
GEMINI_API_KEY=your_gemini_api_key

# WEEX Exchange
WEEX_API_KEY=your_weex_api_key
WEEX_API_SECRET=your_weex_api_secret
WEEX_PASSPHRASE=your_weex_passphrase

# Auth
JWT_SECRET=your_jwt_secret
JWT_REFRESH_SECRET=your_refresh_secret

# Server
PORT=3001
NODE_ENV=development
```

---

## 🤖 The 8 AI Analysts

| Analyst                 | Methodology        | Focus                                     | Trading Style           |
| ----------------------- | ------------------ | ----------------------------------------- | ----------------------- |
| 🎩 **Warren**           | Value Investing    | Fundamentals, moats, margin of safety     | Conservative, long-term |
| 🚀 **Cathie**           | Growth Investing   | TAM expansion, disruption, innovation     | Aggressive growth       |
| 📊 **Jim**              | Technical Analysis | RSI, MACD, chart patterns, momentum       | Swing trading           |
| 🌍 **Ray**              | Macro Strategy     | Interest rates, cycles, correlations      | Sector rotation         |
| 📱 **Elon**             | Sentiment Analysis | Social sentiment, news flow, hype         | Trend following         |
| 🛡️ **Karen**            | Risk Management    | Volatility, drawdown, downside protection | Defensive               |
| 🤖 **Quant**            | Quantitative       | Factor models, statistics, mean reversion | Data-driven             |
| 😈 **Devil's Advocate** | Contrarian         | Consensus challenges, crowded trades      | Counter-trend           |

---

## 📊 Supported Trading Pairs

WEEX-approved futures contracts:

- `cmt_btcusdt` - Bitcoin
- `cmt_ethusdt` - Ethereum
- `cmt_solusdt` - Solana
- `cmt_dogeusdt` - Dogecoin
- `cmt_xrpusdt` - XRP
- `cmt_adausdt` - Cardano
- `cmt_bnbusdt` - BNB
- `cmt_ltcusdt` - Litecoin

---

## ✨ Features

### 🏆 AI Battle Arena

- **Tournament Format** - 8 analysts compete in bracket-style debates
- **Scoring System** - Data quality, logic, risk awareness, catalyst identification
- **Champion Selection** - Winner's thesis drives trading decisions
- **Winning Arguments** - Key points that decided each battle

### 📈 Live Trading Dashboard

- **Real-Time Prices** - WebSocket + polling fallback
- **Order Book Depth** - Live bid/ask visualization
- **Position Management** - View and manage open positions
- **Trade Execution** - Long/Short with leverage up to 100x

### 🎨 Cinematic UI

- **Glass Morphism** - Frosted glass card effects
- **Animated Meters** - Circular progress indicators
- **Price Range Bars** - Bull/bear target visualization
- **Scanline Textures** - Command center aesthetic
- **Golden Accents** - Champion highlights

---

## 🛠️ Scripts

| Command              | Description                             |
| -------------------- | --------------------------------------- |
| `npm run dev`        | Start frontend + backend in development |
| `npm run build`      | Build all packages for production       |
| `npm run typecheck`  | TypeScript type checking                |
| `npm run db:migrate` | Run database migrations                 |
| `npm run db:seed`    | Seed database with test data            |

### Package-specific

```bash
# Frontend only
npm run dev -w @hypothesis-arena/frontend
npm run build -w @hypothesis-arena/frontend

# Backend only
npm run dev -w @hypothesis-arena/backend
npm run build -w @hypothesis-arena/backend
```

---

## 📁 Project Structure

```
packages/
├── frontend/src/
│   ├── components/
│   │   ├── arena/        # AI analysis & debate components
│   │   ├── trading/      # Order book, positions, trading panel
│   │   ├── layout/       # Header, sidebar, main arena
│   │   └── ui/           # Reusable UI components
│   └── services/api/     # WEEX API, WebSocket, auth client
│
├── backend/src/
│   ├── api/routes/       # REST endpoints
│   ├── services/
│   │   ├── ai/           # Gemini integration
│   │   ├── trading/      # Trade execution
│   │   └── weex/         # WEEX API client
│   └── db/               # PostgreSQL models & migrations
│
└── shared/src/
    └── types/            # Shared TypeScript interfaces
```

---

## 🔒 Security

- JWT authentication with refresh token rotation
- WEEX API signature verification (HMAC-SHA256)
- Rate limiting on all endpoints
- Input validation and sanitization
- Secure credential storage

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  
  **Built for WEEX Hackathon 2025**
  
  React 19 • Express 5 • Gemini 2.0 • WEEX Futures API
  
  ⭐ Star if you find this useful • 🐛 Report bugs • 💡 Suggest features
  
  [GitHub](https://github.com/drix10/hypothesis-arena) • [Issues](https://github.com/drix10/hypothesis-arena/issues)
  
</div>
