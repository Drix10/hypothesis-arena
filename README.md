<div align="center">
  <br />
  
  # ⚔️ Hypothesis Arena
  
  **AI-Powered Autonomous Crypto Trading for WEEX Exchange**
  
  *4 AI analysts analyze in parallel, a judge picks the best recommendation, trades execute automatically*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
  [![Express](https://img.shields.io/badge/Express-4-000000?logo=express)](https://expressjs.com/)
  [![WEEX](https://img.shields.io/badge/WEEX-Futures-00D4AA)](https://www.weex.com/)
  
  **🏆 WEEX Hackathon 2025 Submission** | **v5.3.0**
  
</div>

---

## 🎯 What is Hypothesis Arena?

Hypothesis Arena is an autonomous AI-powered trading system for WEEX perpetual futures. Version 5.3.0 uses a **parallel analysis pipeline** where 4 AI analysts independently analyze market conditions enriched with sentiment, quantitative analysis, and regime detection, and a judge picks the best recommendation.

### Key Features

- **4 AI Analysts** - Technical, Macro, Risk, Quantitative specialists with ~150 lines of methodology each
- **Multi-Model Rotation** - Each analyst uses a different AI model per cycle via OpenRouter (DeepSeek, Gemini 2.0 Flash, Grok 4.1 Fast, MiMo v2) - set `MULTI_MODEL_ENABLED=true` (default)
- **Parallel Analysis** - All 4 analyze simultaneously (5 AI calls total)
- **AI Judge** - Picks best recommendation or HOLD if no consensus
- **Sentiment Analysis** - Fear & Greed Index, news sentiment from NewsData.io
- **Quant Analysis** - Z-scores, patterns, historical win rates, support/resistance
- **Regime Detection** - ADX/BB/ATR-based market regime classification (trending/ranging/volatile/quiet)
- **Funding Rate Percentile** - 7-day history tracking with persistence filter
- **Monte Carlo Simulation** - Fat-tailed (Student's t) with GARCH volatility clustering
- **Trade Journal** - Learning loop with pattern analysis and analyst performance tracking
- **Anti-Churn** - Cooldowns, hysteresis, daily limits prevent overtrading
- **Dynamic Leverage** - 10-20x based on conviction (see [FLOW.md](FLOW.md) for details)
- **Technical Indicators** - EMA, RSI, MACD, ATR, Bollinger Bands (5m and 4h timeframes)
- **Exit Plans** - Each trade has invalidation conditions
- **WEEX Compliance** - Full AI logging for hackathon requirements

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    v5.3.0 PARALLEL PIPELINE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN + ENRICHMENT              (~5 seconds)   │
│   • Fetch prices, funding rates for 8 coins                     │
│   • Calculate technical indicators (EMA, RSI, MACD, ATR, BB)    │
│   • Fetch sentiment (Fear & Greed, news)                        │
│   • Run quant analysis (z-scores, patterns, win rates)          │
│   • Detect market regime (trending/ranging/volatile/quiet)      │
│   • Build rich context for AI                                    │
│                                                                  │
│   STAGE 2: PARALLEL ANALYSIS                    (~10 seconds)   │
│   • Jim (Technical), Ray (Macro), Karen (Risk), Quant           │
│   • Each analyst uses a different AI model (multi-model)        │
│   • All 4 analyze independently in parallel                      │
│   • Each outputs: BUY/SELL/HOLD/CLOSE/REDUCE                    │
│                                                                  │
│   STAGE 3: JUDGE DECISION                        (~5 seconds)   │
│   • Compare 4 analyses on quality metrics                       │
│   • Pick winner OR HOLD if no consensus                         │
│   • Karen's risk concerns carry extra weight (advisory)         │
│   • Apply analyst weight adjustments from trade journal         │
│                                                                  │
│   STAGE 4: EXECUTION                             (~5 seconds)   │
│   • Place order with dynamic leverage                           │
│   • Set TP/SL, store exit plan                                  │
│   • Log to database + WEEX compliance                           │
│   • Update analyst portfolios                                    │
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
# =============================================================================
# AI PROVIDER (choose one)
# =============================================================================
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_key
# OR
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_openrouter_key
OPENROUTER_MODEL=deepseek/deepseek-chat  # Default model when multi-model disabled

# =============================================================================
# MULTI-MODEL ROTATION (v5.3.0)
# =============================================================================
# When enabled, each analyst uses a different AI model per cycle
# Models: DeepSeek, Gemini 2.0 Flash, Grok 4.1 Fast, Xiaomi MiMo v2
# All models accessed via OpenRouter (requires OPENROUTER_API_KEY)
MULTI_MODEL_ENABLED=true  # Set to 'false' to use single model for all analysts

# =============================================================================
# WEEX EXCHANGE (required)
# =============================================================================
WEEX_API_KEY=your_api_key
WEEX_SECRET_KEY=your_secret_key
WEEX_PASSPHRASE=your_passphrase

# =============================================================================
# TRADING MODE
# =============================================================================
DRY_RUN=true                    # true = simulation, false = live trading
COMPETITION_MODE=true           # true = aggressive settings for demo competitions
COMPETITION_MODE_ACK=I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS

# =============================================================================
# RISK MANAGEMENT
# =============================================================================
STARTING_BALANCE=1000           # Initial account balance for tracking
MIN_BALANCE_TO_TRADE=200        # Stop trading if balance drops below this
MIN_CONFIDENCE_TO_TRADE=50      # Minimum AI confidence to execute trade (0-100)
MAX_CONCURRENT_POSITIONS=3      # Maximum open positions at once
WEEKLY_DRAWDOWN_LIMIT_PERCENT=25

# =============================================================================
# ANTI-CHURN RULES
# =============================================================================
MAX_DAILY_TRADES=50             # Maximum trades per day
COOLDOWN_AFTER_TRADE_MS=300000  # 5 min cooldown after any trade
COOLDOWN_BEFORE_FLIP_MS=600000  # 10 min before reversing direction

# =============================================================================
# SENTIMENT & NEWS (optional - enriches AI context)
# =============================================================================
NEWSDATA_API_KEY=your_newsdata_key  # Free: 200 credits/day at newsdata.io
# Note: Fear & Greed Index is FREE, no key needed
```

### ⚠️ Important: DRY_RUN Mode

| Value            | Behavior                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| `true` (default) | **Simulation mode** - No real trades are executed. Safe for testing and development. |
| `false`          | **Live trading mode** - Real trades will be placed on WEEX with real funds.          |

---

## 🤖 The 4 Strategy Specialists

| Analyst   | Methodology Style     | Approach                                 | Edge                                                |
| --------- | --------------------- | ---------------------------------------- | --------------------------------------------------- |
| **Jim**   | Statistical Arbitrage | Mean Reversion & Pattern Recognition     | RSI/MACD divergence, Bollinger Bands, z-scores      |
| **Ray**   | ML-Driven Signals     | AI/ML & Regime Detection                 | Open Interest, Funding Rate, Liquidation analysis   |
| **Karen** | Multi-Strategy Risk   | Portfolio Optimization & Risk Management | Sharpe ratio, drawdown limits, correlation tracking |
| **Quant** | Liquidity & Arbitrage | Market Microstructure & Arbitrage        | Funding arbitrage, VWAP, order flow analysis        |

Each analyst has ~150 lines of deeply researched, crypto-specific methodology with standardized funding thresholds (±0.08% extreme, ±0.03% moderate).

---

## 📊 Services Overview

### Core Services

| Service                     | Description                                          |
| --------------------------- | ---------------------------------------------------- |
| **AutonomousTradingEngine** | Main trading engine orchestrating the full pipeline  |
| **CollaborativeFlow**       | Parallel analysis orchestration (4 analysts + judge) |
| **ContextBuilder**          | Builds rich context for AI with all market data      |
| **WeexClient**              | WEEX API client for trading operations               |

### Analysis Services

| Service                       | Description                                       |
| ----------------------------- | ------------------------------------------------- |
| **TechnicalIndicatorService** | EMA, RSI, MACD, ATR, Bollinger Bands calculation  |
| **QuantAnalysisService**      | Z-scores, patterns, support/resistance, win rates |
| **RegimeDetector**            | Market regime classification (ADX/BB/ATR rules)   |
| **MonteCarloService**         | Fat-tailed simulation with GARCH volatility       |
| **SentimentService**          | Fear & Greed Index, news sentiment analysis       |

### Trading Services

| Service                     | Description                                |
| --------------------------- | ------------------------------------------ |
| **AntiChurnService**        | Cooldowns, hysteresis, daily limits        |
| **TradingScheduler**        | Market-aware scheduling (US/EU/Asia hours) |
| **AnalystPortfolioService** | Virtual portfolios for P&L attribution     |
| **TradeJournalService**     | Learning loop with pattern analysis        |
| **AILogService**            | WEEX compliance logging                    |

---

## 🛡️ Anti-Churn Rules

| Rule                 | Default   | Purpose                           |
| -------------------- | --------- | --------------------------------- |
| Cooldown After Trade | 5 min     | Prevent rapid re-entry            |
| Cooldown Before Flip | 10 min    | Prevent direction whipsaw         |
| Hysteresis           | 1.2x      | Need 20% more confidence to close |
| Daily Limit          | 50 trades | Prevent overtrading               |
| Max Per Symbol/Hour  | 3 trades  | Symbol-specific rate limit        |
| Exit Plan Respect    | Always    | Don't close unless invalidated    |

---

## 📈 Technical Indicators

**Intraday (5m):** EMA9, EMA20, EMA50, RSI7, RSI14, MACD, ATR, Bollinger Bands

**Long-term (4h):** EMA20, EMA50, EMA200, RSI14, MACD, Bollinger Bands, Trend Detection

**Derivatives:** Open Interest, Funding Rate, VWAP

**Crypto-Specific Thresholds:**

- RSI: Oversold < 25, Overbought > 75 (crypto is more volatile)
- Funding: Extreme ±0.08%, Moderate ±0.03%

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
| `npm run lint`           | Run ESLint           |
| `npm run typecheck`      | TypeScript check     |
| `npx prisma migrate dev` | Run migrations       |
| `npx prisma studio`      | Database GUI         |

---

## 📁 Project Structure

```
src/
├── api/
│   ├── middleware/           # Error handling
│   └── routes/               # REST endpoints (autonomous, trading, portfolio, weex)
├── config/
│   ├── database.ts           # Prisma + Turso setup
│   └── index.ts              # Configuration
├── constants/
│   ├── analyst/              # Analyst profiles, risk limits, risk council
│   └── prompts/              # AI system prompts (analyst, judge)
├── services/
│   ├── ai/
│   │   ├── AIService.ts      # Centralized AI provider (Gemini/OpenRouter)
│   │   └── CollaborativeFlow.ts  # Parallel analysis orchestration
│   ├── autonomous/
│   │   ├── AutonomousTradingEngine.ts  # Main trading engine
│   │   └── TradingScheduler.ts         # Market-aware scheduling
│   ├── compliance/
│   │   └── AILogService.ts   # WEEX compliance logging
│   ├── context/
│   │   └── ContextBuilder.ts # Build rich context for AI
│   ├── indicators/
│   │   ├── IndicatorCalculator.ts      # EMA, RSI, MACD, ATR, BB
│   │   └── TechnicalIndicatorService.ts # Indicator orchestration
│   ├── journal/
│   │   └── TradeJournalService.ts      # Learning loop, pattern analysis
│   ├── portfolio/
│   │   └── AnalystPortfolioService.ts  # Virtual portfolios, P&L attribution
│   ├── quant/
│   │   ├── QuantAnalysisService.ts     # Z-scores, patterns, win rates
│   │   ├── MonteCarloService.ts        # Fat-tailed simulation
│   │   └── RegimeDetector.ts           # Market regime classification
│   ├── sentiment/
│   │   └── SentimentService.ts         # Fear & Greed, news sentiment
│   ├── trading/
│   │   └── AntiChurnService.ts         # Cooldowns, hysteresis
│   └── weex/
│       └── WeexClient.ts     # WEEX API client
├── shared/
│   ├── types/                # Market data, WEEX types
│   └── utils/                # Validation, WEEX utilities
├── types/
│   ├── analyst.ts            # Analyst/Judge schemas
│   └── context.ts            # Trading context types
├── utils/
│   ├── errors.ts             # Error classes
│   └── logger.ts             # Winston logger
└── server.ts                 # Express server
```

---

## 🔌 API Endpoints

### Engine Control

- `POST /api/autonomous/start` - Start trading engine
- `POST /api/autonomous/stop` - Stop trading engine
- `GET /api/autonomous/status` - Get engine status
- `GET /api/autonomous/events` - SSE event stream

### Trading

- `GET /api/trading/trades` - List trades
- `GET /api/trading/leaderboard` - Analyst leaderboard
- `GET /api/trading/analysts/:id/stats` - Analyst stats

### Portfolio

- `GET /api/portfolio` - Portfolio summary
- `GET /api/positions` - Current positions

### WEEX Proxy

- `GET /api/weex/tickers` - Market tickers
- `GET /api/weex/positions` - WEEX positions
- `GET /api/weex/account` - Account info

---

## 📋 Version History

| Version   | Date       | Changes                                                                          |
| --------- | ---------- | -------------------------------------------------------------------------------- |
| **5.3.0** | 2026-01-12 | Full integration - ALL 28 functions integrated, debug/admin API complete         |
| **5.2.0** | 2026-01-11 | Debug & Admin API endpoints for runtime inspection                               |
| **5.1.0** | 2026-01-11 | Regime detection, Monte Carlo simulation, funding rate percentile, trade journal |
| **5.0.2** | 2026-01-11 | Sentiment + Quant analysis services, Fear & Greed, NewsData.io (same-day hotfix) |
| **5.0.1** | 2026-01-08 | Quant firm edition: 4 analysts with 150-line methodologies                       |
| **5.0.0** | 2026-01-05 | Parallel analysis, anti-churn, dynamic leverage, exit plans                      |
| 4.0.0     | 2026-01-04 | 5-stage pipeline, ALL 4 analysts in debates                                      |
| 3.3.0     | 2026-01-03 | AI Judge, regime-adaptive trading                                                |

**v5.3.0 Highlights:**

- **100% Code Integration**: All 28 exported functions now integrated and accessible
- **Debug API Expansion**: Sentiment, Reddit sentiment, regime, Monte Carlo endpoints
- **Admin API Enhancement**: Clear funding history and regime history caches
- **Frontend Debug Panel**: Sentiment and Regime buttons for runtime inspection
- **Production Ready**: Full system integration complete

See [FLOW.md](FLOW.md) for detailed architecture.

---

## 📜 License

MIT License - see [LICENSE](LICENSE)

---

<div align="center">
  
  **Built for WEEX Hackathon 2025**
  
  ⭐ Star if useful • 🐛 Report bugs • 💡 Suggest features
  
</div>
