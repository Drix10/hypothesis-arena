<div align="center">
  <br />
  
  # ⚔️ Hypothesis Arena
  
  **AI-Powered Autonomous Crypto Trading for WEEX Exchange**
  
  *4 AI analysts analyze in parallel, a judge picks the best recommendation, trades execute automatically*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
  [![Express](https://img.shields.io/badge/Express-5-000000?logo=express)](https://expressjs.com/)
  [![WEEX](https://img.shields.io/badge/WEEX-Futures-00D4AA)](https://www.weex.com/)
  
  **🏆 WEEX Hackathon 2025 Submission**
  
</div>

---

## 🎯 What is Hypothesis Arena?

Hypothesis Arena is an autonomous AI-powered trading system for WEEX perpetual futures. Version 5.0.0 uses a **parallel analysis pipeline** where 4 AI analysts independently analyze market conditions, and a judge picks the best recommendation.

### Key Features

- **4 AI Analysts** - Technical, Macro, Risk, Quantitative specialists
- **Parallel Analysis** - All 4 analyze simultaneously (5 AI calls total)
- **AI Judge** - Picks best recommendation or HOLD if no consensus
- **Anti-Churn** - Cooldowns, hysteresis, daily limits prevent overtrading
- **Dynamic Leverage** - 3-10x based on confidence and volatility
- **Technical Indicators** - EMA, RSI, MACD, ATR, Bollinger Bands
- **Exit Plans** - Each trade has invalidation conditions
- **WEEX Compliance** - Full AI logging for hackathon requirements

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    v5.0.0 PARALLEL PIPELINE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN                           (~5 seconds)   │
│   • Fetch prices, funding rates for 8 coins                     │
│   • Calculate technical indicators                               │
│   • Build rich context for AI                                    │
│                                                                  │
│   STAGE 2: PARALLEL ANALYSIS                    (~10 seconds)   │
│   • Jim (Technical), Ray (Macro), Karen (Risk), Quant           │
│   • All 4 analyze independently in parallel                      │
│   • Each outputs: BUY/SELL/HOLD/CLOSE/REDUCE                    │
│                                                                  │
│   STAGE 3: JUDGE DECISION                        (~5 seconds)   │
│   • Compare 4 analyses on quality metrics                       │
│   • Pick winner OR HOLD if no consensus                         │
│   • Karen's risk concerns carry extra weight (advisory)         │
│                                                                  │
│   STAGE 4: EXECUTION                             (~5 seconds)   │
│   • Place order with dynamic leverage                           │
│   • Set TP/SL, store exit plan                                  │
│   • Log to database + WEEX compliance                           │
│                                                                  │
│   TOTAL: ~25 seconds (was ~60 seconds in v4.0.0)                │
│   AI CALLS: 5 (was 8-10 in v4.0.0)                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- AI API key (Gemini or OpenRouter)
- WEEX API credentials

### Installation

```bash
# Clone and install
git clone <repository-url>
cd hypothesis-arena
npm install

# Setup environment
cp .env.example .env
# Edit .env with your API keys

# Run database migrations
npx prisma migrate dev

# Start the server
npm run dev
# Server: http://localhost:25655
```

### Key Environment Variables

```env
# AI Provider
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
# OR
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key

# WEEX Exchange
WEEX_API_KEY=your_key
WEEX_SECRET_KEY=your_secret
WEEX_PASSPHRASE=your_passphrase

# Trading
# TRADING_STYLE: 'scalp' (5-12h hold, 5% targets) or 'swing' (24-48h hold, 10% targets)
TRADING_STYLE=scalp
# MAX_LEVERAGE: Base leverage for dynamic calculation (3-10x range)
# This is the starting point - actual leverage adjusts based on confidence/volatility
# The system will NEVER exceed 10x regardless of this setting
MAX_LEVERAGE=5
DRY_RUN=false
```

---

## 🤖 The 4 AI Analysts

| Analyst   | Focus              | Risk Tolerance | Special Role                                |
| --------- | ------------------ | -------------- | ------------------------------------------- |
| **Jim**   | Technical Analysis | Moderate       | EMA, RSI, MACD patterns                     |
| **Ray**   | Macro & Funding    | Moderate       | Funding rates, market structure             |
| **Karen** | Risk Management    | Conservative   | Risk concerns carry extra weight (advisory) |
| **Quant** | Quantitative       | Aggressive     | Statistical edge, mean reversion            |

---

## 🛡️ Anti-Churn Rules (v5.0.0)

| Rule                 | Default   | Purpose                           |
| -------------------- | --------- | --------------------------------- |
| Cooldown After Trade | 15 min    | Prevent rapid re-entry            |
| Cooldown Before Flip | 30 min    | Prevent direction whipsaw         |
| Hysteresis           | 1.2x      | Need 20% more confidence to close |
| Daily Limit          | 10 trades | Prevent overtrading               |
| Exit Plan Respect    | Always    | Don't close unless invalidated    |

---

## 📊 Technical Indicators

Calculated from WEEX candlestick data (no external APIs):

**Intraday (5m):** EMA20, EMA50, RSI7, RSI14, MACD, ATR

**Long-term (4h):** EMA20, EMA50, EMA200, RSI14, MACD, Bollinger Bands

---

## 📈 Supported Trading Pairs

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

| Command                  | Description          |
| ------------------------ | -------------------- |
| `npm run dev`            | Development server   |
| `npm run build`          | Build for production |
| `npm run start`          | Production server    |
| `npx prisma migrate dev` | Run migrations       |
| `npx prisma studio`      | Database GUI         |

---

## 📁 Project Structure

```
src/
├── api/routes/           # REST endpoints
├── config/               # Configuration
├── constants/
│   ├── analyst/          # Analyst profiles, risk limits
│   └── prompts/          # AI system prompts
├── services/
│   ├── ai/               # CollaborativeFlow (parallel analysis)
│   ├── autonomous/       # Trading engine, scheduler
│   ├── compliance/       # WEEX AI logging
│   ├── context/          # Context builder
│   ├── indicators/       # Technical indicators
│   ├── portfolio/        # Virtual portfolios
│   ├── trading/          # Anti-churn, leverage
│   └── weex/             # WEEX API client
├── shared/               # Types, utilities
├── types/                # TypeScript definitions
└── utils/                # Logger, errors
```

---

## 📋 Version History

| Version   | Date       | Changes                                                     |
| --------- | ---------- | ----------------------------------------------------------- |
| **5.0.0** | 2026-01-05 | Parallel analysis, anti-churn, dynamic leverage, exit plans |
| 4.0.0     | 2026-01-04 | 5-stage pipeline, ALL 4 analysts in debates                 |
| 3.3.0     | 2026-01-03 | AI Judge, regime-adaptive trading                           |
| 3.0.0     | 2025-12-31 | MANAGE action, position management                          |

See [FLOW.md](FLOW.md) for detailed architecture.

---

## 📜 License

MIT License - see [LICENSE](LICENSE)

---

<div align="center">
  
  **Built for WEEX Hackathon 2025**
  
  ⭐ Star if useful • 🐛 Report bugs • 💡 Suggest features
  
</div>
