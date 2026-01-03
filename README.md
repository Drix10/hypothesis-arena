<div align="center">
  <br />
  
  # ⚔️ Hypothesis Arena
  
  **AI-Powered Collaborative Crypto Trading Platform for WEEX Exchange**
  
  *4 AI analysts collaborate through turn-by-turn debates on ONE shared portfolio, then execute trades on WEEX futures*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
  [![Express](https://img.shields.io/badge/Express-5-000000?logo=express)](https://expressjs.com/)
  [![WEEX](https://img.shields.io/badge/WEEX-Futures-00D4AA)](https://www.weex.com/)
  
  **🏆 WEEX Hackathon 2025 Submission**
  
</div>

---

## 🎯 What is Hypothesis Arena?

Hypothesis Arena is an AI-powered crypto trading platform where **4 specialized AI analysts collaborate through turn-by-turn debates** to make trading decisions on a **single shared portfolio**. The winning thesis from each debate cycle gets executed automatically on WEEX Exchange.

### Core Philosophy

> **Every decision is a debate. Every debate has a winner. Winners trade OR manage.**

### Key Features

- **4 AI Analysts** - Technical, Macro, Risk, Quantitative with regime-adaptive strategies
- **AI Judge** - Evaluates debate quality (data/logic/risk/catalyst), not word count
- **Turn-by-Turn Debates** - Structured debates with JSON schema enforcement
- **Collaborative Portfolio** - All analysts share ONE portfolio
- **Live WEEX Trading** - Execute futures trades with TP/SL on WEEX Exchange
- **Position Management** - AI can close/reduce positions via MANAGE action
- **3-Tier Circuit Breakers** - Yellow/Orange/Red alerts for risk protection
- **Risk Council Veto** - Karen has final approval/veto power

---

## 🏗️ System Architecture

### The 6-Stage Decision Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                   THE 6-STAGE DECISION PIPELINE                  │
│                   (OPTIMIZED - 40% Token Reduction)              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN          "What's happening?"             │
│      ↓ (WeexClient.ts)          Fetch data for 8 coins          │
│   STAGE 2: OPPORTUNITY SELECTION "Trade or Manage?"             │
│      ↓ (CollaborativeFlow.ts)   3-way debate (Ray, Jim, Quant) │
│      │                          Can select MANAGE action        │
│      ├─[MANAGE]→ Close Position → Log to DB → DONE              │
│      └─[LONG/SHORT]↓                                            │
│   STAGE 3: CHAMPIONSHIP         "ALL 4 analysts compete"        │
│      ↓ (CollaborativeFlow.ts)   4-way debate, turn-by-turn      │
│   STAGE 4: RISK COUNCIL         "Final safety check"            │
│      ↓ (CollaborativeFlow.ts)   Karen's veto power              │
│   STAGE 5: EXECUTION            "Pull the trigger"              │
│      ↓ (AutonomousTradingEngine.ts)                             │
│   STAGE 6: POSITION MANAGEMENT  "Monitor until exit"            │
│      (AutonomousTradingEngine.ts)                               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
hypothesis-arena/
├── src/                   # TypeScript backend source code
│   ├── api/              # REST API routes
│   ├── services/         # Business logic (AI, trading, WEEX)
│   ├── config/           # Database, environment
│   ├── constants/        # AI prompts, analyst profiles
│   └── utils/            # Logger, helpers
├── public/               # Frontend static files (HTML, CSS, JS)
├── dist/                 # Compiled backend JavaScript
├── migrations/           # Database migrations
├── weex/                 # WEEX API documentation
├── package.json          # Dependencies
├── tsconfig.json         # TypeScript config
├── .env                  # Configuration
└── README.md             # This file
```

**Single Port Architecture:** Both API (`/api/*`) and frontend static files are served on port 25655.

### Tech Stack

| Layer    | Technology                          |
| -------- | ----------------------------------- |
| Backend  | Express 5, TypeScript, SQLite/Turso |
| AI       | Gemini / OpenRouter / DeepSeek      |
| Exchange | WEEX Futures API                    |
| Frontend | Vanilla HTML/CSS/JS (polling-based) |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- SQLite (included) or Turso account for production
- AI API key (Gemini, OpenRouter, or DeepSeek)
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
# Edit .env with your API keys

# Run database migrations
npx prisma migrate dev
# Creates SQLite database at prisma/dev.db

# Start the server
npm run dev
# Server runs on http://localhost:25655
# Frontend served from http://localhost:25655
# API available at http://localhost:25655/api
```

### Environment Variables

See `.env.example` for all options. Key variables:

```env
# Database (SQLite local, Turso for production)
DATABASE_URL=file:./prisma/dev.db
# For Turso: DATABASE_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=your_token

# AI Provider (gemini, openrouter, or deepseek)
AI_PROVIDER=gemini
GEMINI_API_KEY=your_api_key
# OR
# OPENROUTER_API_KEY=your_api_key
# OPENROUTER_MODEL=deepseek/deepseek-chat-v3.1

# WEEX Exchange
WEEX_API_KEY=your_weex_api_key
WEEX_SECRET_KEY=your_weex_api_secret
WEEX_PASSPHRASE=your_weex_passphrase

# Server
PORT=25655
NODE_ENV=development
```

---

## 🤖 The 4 AI Analysts

| Analyst  | ID    | Methodology        | Focus                        |
| -------- | ----- | ------------------ | ---------------------------- |
| 📊 Jim   | jim   | Technical Analysis | RSI, MACD, chart patterns    |
| 🌍 Ray   | ray   | Macro Strategy     | Interest rates, correlations |
| 🛡️ Karen | karen | Risk Management    | Volatility, drawdown, vetoes |
| 🤖 Quant | quant | Quantitative       | Factor models, statistics    |

All analysts use **regime-adaptive trading** - they detect market conditions (trending/ranging/volatile) and adjust their TP/SL/hold time accordingly. Minimum 1.5:1 R/R enforced.

### Debate Participation

- **Stage 2 (Coin Selection):** Ray, Jim, Quant → AI Judge picks winner
- **Stage 3 (Championship):** All 4 analysts → AI Judge picks winner
- **Stage 4 (Risk Council):** Karen only (veto power)

### AI Judge System (v3.3.0)

Debates are evaluated by a dedicated AI Judge using a 4-criteria scoring rubric:

| Criterion      | Weight | Measures                         |
| -------------- | ------ | -------------------------------- |
| Data Quality   | 25%    | Specific numbers vs vague claims |
| Logic          | 25%    | Arguments follow from evidence   |
| Risk Awareness | 25%    | Acknowledges what could go wrong |
| Catalyst       | 25%    | Clear price driver with timeline |

The Judge replaces the old heuristic method (word count, data point counting) with actual argument quality evaluation.

---

## 🛡️ Risk Management

### Global Risk Limits

| Parameter                | Limit |
| ------------------------ | ----- |
| Max Leverage             | 5x    |
| Max Position Size        | 30%   |
| Max Stop Loss Distance   | 10%   |
| Drawdown Liquidation     | 50%   |
| Max Concurrent Positions | 5     |

### Trading Style Configuration

The system supports two trading styles, configurable via `TRADING_STYLE` env var:

| Parameter     | Scalping (Default) | Swing             |
| ------------- | ------------------ | ----------------- |
| Target Profit | 4%                 | 8%                |
| Stop Loss     | 2.5%               | 4%                |
| Max Hold Time | 8 hours            | 36 hours          |
| Min R/R Ratio | 1.6:1              | 2:1               |
| Profit Taking | +1.5% → breakeven  | +2.5% → breakeven |

**Scalping Philosophy:** High volume, quick profits, tight risk. We capture 4% moves with 2.5% stops for a 1.6:1 R/R ratio. Positions are closed within 8 hours to minimize funding drag.

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

## 🚪 Position Management (MANAGE Action)

In Stage 2, analysts can choose to MANAGE an existing position instead of opening a new trade.

### Trading Style: Scalping (Default)

The system is optimized for high-frequency scalping with configurable parameters:

| Trigger        | Scalp Action                      |
| -------------- | --------------------------------- |
| P&L > +1.5%    | Move stop to breakeven            |
| P&L > +2.5%    | Take 25% profits                  |
| P&L > +3.5%    | Take 50% profits                  |
| P&L > +4%      | Take 75% profits (target reached) |
| P&L < -2.5%    | Stop loss triggered               |
| Hold > 8 hours | Force review/close                |

### When MANAGE is Selected

| Trigger            | Action                       |
| ------------------ | ---------------------------- |
| P&L < -7%          | Close position immediately   |
| P&L > +4%          | Take profits (scalp target)  |
| P&L > +8%          | Take at least 50% profits    |
| Hold > 8 hours     | Close unless strong momentum |
| Thesis invalidated | Close position               |

### MANAGE Action Flow

1. **Position Lookup** - Case-insensitive symbol matching with partial match fallback
2. **Validation** - Verify position size, entry price, current price are valid
3. **Execution** - Close position via WEEX API
4. **Database Logging** - Record trade with `reason: 'MANAGE: Position closed by AI'`

### Position Health Assessment

The system evaluates each position on:

- **P&L Status**: PROFIT / LOSS / BREAKEVEN
- **P&L Severity**: CRITICAL (<-7%) / WARNING (<-2.5%) / HEALTHY
- **Hold Time**: FRESH (<4h) / MATURE (4-8h) / STALE (>8h for scalping)
- **Funding Impact**: FAVORABLE / NEUTRAL / ADVERSE
- **Thesis Status**: VALID / WEAKENING / INVALIDATED

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

| Command                  | Description                 |
| ------------------------ | --------------------------- |
| `npm run dev`            | Start server in development |
| `npm run build`          | Build for production        |
| `npm run start`          | Start production server     |
| `npx prisma migrate dev` | Run database migrations     |
| `npx prisma studio`      | Open database GUI           |
| `npm run typecheck`      | Type check without building |

---

## 📁 Project Structure

```
src/
├── api/routes/              # REST endpoints
├── config/                  # Database, environment
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
│   │   └── AIService.ts           # AI provider abstraction
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

| Version | Date       | Changes                                                                                          |
| ------- | ---------- | ------------------------------------------------------------------------------------------------ |
| 3.3.0   | 2026-01-04 | AI Judge System, Regime-Adaptive Trading, R/R fixes, Alpha Score gap fix, memory leak prevention |
| 3.2.0   | 2026-01-02 | Trading style config (scalp/swing), env-driven parameters, quant optimization                    |
| 3.1.1   | 2026-01-02 | Funding rate validation fix, documentation updates, production hardening                         |
| 3.0.1   | 2026-01-01 | SQLite database, polling instead of SSE, all issues fixed                                        |
| 3.0.0   | 2025-12-31 | MANAGE action for position management, improved edge cases                                       |
| 2.2.0   | 2025-12-28 | Exhaustive switch, extracted normalization, improved validation                                  |
| 2.1.2   | 2025-12-28 | Input validation, improved type guards, JSON repair fixes                                        |
| 2.1.0   | 2025-12-28 | Turn-by-turn debates, 6-stage pipeline (40% token reduction)                                     |

See [FLOW.md](FLOW.md) for detailed architecture documentation.

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  
  **Built for WEEX Hackathon 2025**
  
  Express 5 • AI-Powered • WEEX Futures API • SQLite/Turso
  
  ⭐ Star if you find this useful • 🐛 Report bugs • 💡 Suggest features
  
  [GitHub](https://github.com/drix10/hypothesis-arena) • [Issues](https://github.com/drix10/hypothesis-arena/issues)
  
</div>
