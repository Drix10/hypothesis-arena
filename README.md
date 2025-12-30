<div align="center">
  <br />
  
  # ⚔️ Hypothesis Arena
  
  **AI-Powered Collaborative Crypto Trading Platform for WEEX Exchange**
  
  *8 AI analysts collaborate through turn-by-turn debates on ONE shared portfolio, then execute trades on WEEX futures*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19-61dafb?logo=react)](https://react.dev/)
  [![Express](https://img.shields.io/badge/Express-5-000000?logo=express)](https://expressjs.com/)
  [![Gemini](https://img.shields.io/badge/Gemini-3_Flash-4285F4?logo=google)](https://ai.google.dev/)
  [![WEEX](https://img.shields.io/badge/WEEX-Futures-00D4AA)](https://www.weex.com/)
  
  **🏆 WEEX Hackathon 2025 Submission**
  
</div>

---

## 🎯 What is Hypothesis Arena?

Hypothesis Arena is an AI-powered crypto trading platform where **8 specialized AI analysts collaborate through turn-by-turn debates** to make trading decisions on a **single shared portfolio**. The winning thesis from each debate cycle gets executed automatically on WEEX Exchange.

### Core Philosophy

> **Every decision is a debate. Every debate has a winner. Winners trade.**

### Key Features

- **8 AI Analysts** - Value, Growth, Technical, Macro, Sentiment, Risk, Quant, Contrarian
- **Turn-by-Turn Debates** - 40 debate turns per cycle across 4 debate stages (configurable)
- **Collaborative Portfolio** - All analysts share ONE portfolio (not 8 separate ones)
- **Live WEEX Trading** - Execute futures trades with TP/SL directly on WEEX Exchange
- **3-Tier Circuit Breakers** - Yellow/Orange/Red alerts based on BTC drops, funding rates, and drawdowns
- **Risk Council Veto** - Karen (Risk Manager) has final approval/veto power on all trades

---

## 🏗️ System Architecture

### The 8-Stage Decision Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                   THE 8-STAGE DECISION PIPELINE                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN          "What's happening?"             │
│      ↓ (WeexClient.ts)          Fetch data for 8 coins          │
│   STAGE 2: COIN SELECTION       "Which coin to trade?"          │
│      ↓ (CollaborativeFlow.ts)   4-way debate, 8 turns           │
│   STAGE 3: ANALYSIS APPROACH    "How to analyze it?"            │
│      ↓ (CollaborativeFlow.ts)   4-way debate, 8 turns           │
│   STAGE 4: RISK ASSESSMENT      "Position size & risk?"         │
│      ↓ (CollaborativeFlow.ts)   4-way debate, 8 turns           │
│   STAGE 5: CHAMPIONSHIP         "Best thesis wins"              │
│      ↓ (CollaborativeFlow.ts)   8-way debate, 16 turns          │
│   STAGE 6: RISK COUNCIL         "Final safety check"            │
│      ↓ (CollaborativeFlow.ts)   Karen's veto power              │
│   STAGE 7: EXECUTION            "Pull the trigger"              │
│      ↓ (AutonomousTradingEngine.ts)                             │
│   STAGE 8: POSITION MANAGEMENT  "Monitor until exit"            │
│      (AutonomousTradingEngine.ts)                               │
│                                                                  │
│   TOTAL: 40 debate turns per cycle | ~42 Gemini API calls       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
hypothesis-arena/
├── src/                   # TypeScript backend source code
│   ├── api/              # REST API routes
│   ├── services/         # Business logic (AI, trading, WEEX)
│   ├── config/           # Database, Redis, environment
│   ├── constants/        # AI prompts, analyst profiles
│   └── utils/            # Logger, helpers
├── public/               # Frontend static files (HTML, CSS, JS, React)
├── dist/                 # Compiled backend JavaScript
├── migrations/           # Database migrations
├── weex/                 # WEEX API documentation
├── scripts/              # Utility scripts
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
├── .env                  # Configuration
└── README.md             # This file
```

**Single Port Architecture:** Both API (`/api/*`) and frontend static files are served on port 25655.

### Tech Stack

| Layer    | Technology                                 |
| -------- | ------------------------------------------ |
| Backend  | Express 5, TypeScript, PostgreSQL (Neon)   |
| AI       | Google Gemini 2.5 Flash                    |
| Exchange | WEEX Futures API                           |
| Frontend | Simple HTML/CSS/JS (served from `/public`) |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database ([Neon](https://neon.tech) - free tier)
- Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey))
- WEEX API credentials ([WEEX](https://www.weex.com/api))

### Installation

```bash
# Clone repository
git clone https://github.com/drix10/hypothesis-arena.git
cd hypothesis-arena

# Install dependencies
npm install

# Setup environment
cp .env.example .env
# Edit .env with your API keys (DATABASE_URL, REDIS_URL, WEEX credentials, etc.)

# Run database migrations
npm run migrate

# Start the server
npm run dev
# Server runs on http://localhost:25655
# Frontend served from http://localhost:25655
# API available at http://localhost:25655/api
```

### Environment Variables

See `.env.example` for all options. Key variables:

```env
# Database (Neon PostgreSQL)
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require

# Redis (Upstash)
REDIS_URL=redis://default:pass@host:port

# AI
GEMINI_API_KEY=your_gemini_api_key

# WEEX Exchange
WEEX_API_KEY=your_weex_api_key
WEEX_SECRET_KEY=your_weex_api_secret
WEEX_PASSPHRASE=your_weex_passphrase

# Auth
JWT_SECRET=your_jwt_secret

# Server
PORT=25655
NODE_ENV=development
```

---

## 🤖 The 8 AI Analysts

| Analyst   | ID     | Methodology        | Focus                          | Debate Role                     |
| --------- | ------ | ------------------ | ------------------------------ | ------------------------------- |
| 🎩 Warren | warren | Value Investing    | Fundamentals, margin of safety | Stage 3 & 4, Championship       |
| 🚀 Cathie | cathie | Growth Investing   | TAM expansion, disruption      | Stage 3, Championship           |
| 📊 Jim    | jim    | Technical Analysis | RSI, MACD, chart patterns      | Stage 2, 3, Championship        |
| 🌍 Ray    | ray    | Macro Strategy     | Interest rates, correlations   | Stage 2, 4, Championship        |
| 📱 Elon   | elon   | Sentiment Analysis | Social sentiment, hype         | Stage 2, Championship           |
| 🛡️ Karen  | karen  | Risk Management    | Volatility, drawdown, vetoes   | Stage 4, 6 (Veto), Championship |
| 🤖 Quant  | quant  | Quantitative       | Factor models, statistics      | Stage 2, 3, Championship        |
| 😈 Devil  | devil  | Contrarian         | Consensus challenges           | Stage 4, Championship           |

### Debate Participation by Stage

- **Stage 2 (Coin Selection):** Ray, Jim, Quant, Elon (4 analysts, 8 turns)
- **Stage 3 (Analysis Approach):** Warren, Cathie, Jim, Quant (4 analysts, 8 turns)
- **Stage 4 (Risk Assessment):** Karen, Warren, Devil, Ray (4 analysts, 8 turns)
- **Stage 5 (Championship):** ALL 8 analysts (16 turns)
- **Stage 6 (Risk Council):** Karen only (final veto power)

---

## 🛡️ Risk Management

### Global Risk Limits

| Parameter                | Limit |
| ------------------------ | ----- |
| Max Leverage             | 5x    |
| Max Position Size        | 30%   |
| Max Stop Loss Distance   | 10%   |
| Drawdown Liquidation     | 50%   |
| Max Concurrent Positions | 3     |

### 3-Tier Circuit Breakers

| Alert     | BTC Drop (4h) | Portfolio Drawdown (24h) | Funding Rate | Action                |
| --------- | ------------- | ------------------------ | ------------ | --------------------- |
| 🟡 Yellow | -10%          | -5%                      | ±0.03%       | Reduce leverage to 3x |
| 🟠 Orange | -15%          | -10%                     | ±0.05%       | Reduce leverage to 2x |
| 🔴 Red    | -20%          | -15%                     | -            | Close ALL positions   |

### Risk Council Veto Triggers

Karen will automatically VETO trades if:

- Stop loss >10% from entry
- Position would exceed 30% of account
- Already have 3+ positions open
- 7-day drawdown >10%
- Funding rate >0.05% against position direction

---

## 📊 Supported Trading Pairs

WEEX-approved futures contracts:

| Symbol         | Asset    |
| -------------- | -------- |
| `cmt_btcusdt`  | Bitcoin  |
| `cmt_ethusdt`  | Ethereum |
| `cmt_solusdt`  | Solana   |
| `cmt_dogeusdt` | Dogecoin |
| `cmt_xrpusdt`  | XRP      |
| `cmt_adausdt`  | Cardano  |
| `cmt_bnbusdt`  | BNB      |
| `cmt_ltcusdt`  | Litecoin |

---

## 🛠️ Scripts

| Command                         | Description                 |
| ------------------------------- | --------------------------- |
| `npm run dev`                   | Start server in development |
| `npm run build`                 | Build for production        |
| `npm run start`                 | Start production server     |
| `npm run migrate`               | Run database migrations     |
| `npm run migrate:down`          | Rollback last migration     |
| `npm run migrate:create <name>` | Create new migration        |
| `npm run typecheck`             | Type check without building |

---

## 📁 Project Structure

```
src/
├── api/routes/              # REST endpoints
├── config/                  # Database, Redis, environment
├── constants/
│   ├── analyst/             # Analyst profiles, risk limits
│   └── prompts/             # 800+ line methodology prompts
│       ├── builders.ts      # Prompt builder functions
│       ├── debateContexts.ts
│       ├── debateHelpers.ts
│       └── promptHelpers.ts
├── services/
│   ├── ai/
│   │   ├── CollaborativeFlow.ts  # Turn-by-turn debate engine
│   │   └── GeminiService.ts      # Gemini API client
│   ├── autonomous/
│   │   ├── AutonomousTradingEngine.ts  # Main orchestration
│   │   └── TradingScheduler.ts         # Market-aware scheduling
│   ├── risk/
│   │   └── CircuitBreakerService.ts    # 3-tier circuit breakers
│   └── weex/
│       └── WeexClient.ts               # WEEX API client
├── shared/
│   ├── types/               # TypeScript type definitions
│   └── utils/               # Shared utilities
└── utils/                   # Logger, helpers

public/
├── index.html               # Frontend entry point
├── styles.css               # CSS styles
└── app.js                   # JavaScript logic
```

---

## 🔒 Security

- WEEX API signature verification (HMAC-SHA256)
- Rate limiting on all endpoints
- Input validation and sanitization
- All configuration via environment variables

---

## 📋 Version History

| Version | Date       | Changes                                                                 |
| ------- | ---------- | ----------------------------------------------------------------------- |
| 3.2.0   | 2025-12-28 | Exhaustive switch, extracted normalization, improved validation         |
| 3.1.2   | 2025-12-28 | Input validation, improved type guards, JSON repair fixes               |
| 3.1.1   | 2025-12-28 | Retry logic, backoff, cycle completion fixes                            |
| 3.1.0   | 2025-12-28 | Turn-by-turn debates, 8-stage pipeline, configurable turns (40 default) |

See [FLOW.md](FLOW.md) for detailed architecture documentation.

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  
  **Built for WEEX Hackathon 2025**
  
  Express 5 • Gemini 2.5 Flash • WEEX Futures API • React 19
  
  ⭐ Star if you find this useful • 🐛 Report bugs • 💡 Suggest features
  
  [GitHub](https://github.com/drix10/hypothesis-arena) • [Issues](https://github.com/drix10/hypothesis-arena/issues)
  
</div>
