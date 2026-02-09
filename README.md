<div align="center">
  <br />
  
  # ⚔️ Hypothesis Arena
  
  **AI-Powered Autonomous Crypto Trading for WEEX Exchange**
  
  *4 AI analysts analyze in parallel, a judge picks the best recommendation, trades execute automatically*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-18+-green?logo=node.js)](https://nodejs.org/)
  [![WEEX](https://img.shields.io/badge/WEEX-Futures-00D4AA)](https://www.weex.com/)
  
  **🏆 WEEX Hackathon 2026 Submission**
  
</div>

---

## What is Hypothesis Arena?

An autonomous trading system for WEEX perpetual futures using a **parallel AI analysis pipeline**:

1. **4 AI Analysts** analyze market conditions independently
2. **AI Judge** picks the best recommendation
3. **Trades execute automatically** with risk management

<p align="center">
  <img src="https://media.licdn.com/dms/image/v2/D5622AQEodSENZNjSxg/feedshare-shrink_2048_1536/B56Zt9jmtiK8A0-/0/1767338045324?e=1772064000&v=beta&t=7zbiXKq5rBOulXJgCd6D7w0asbnqvyMzO2BEidsdR-U" 
       alt="Screenshot or diagram description" 
       width="800" />
</p>

### Core Features

| Feature                | Description                                                          |
| ---------------------- | -------------------------------------------------------------------- |
| **4 AI Analysts**      | Jim (Statistical), Ray (ML/Signals), Karen (Risk), Quant (Liquidity) |
| **Hybrid AI Mode**     | Split analysts across Gemini + OpenRouter for diversity              |
| **Parallel Analysis**  | Combined 4-in-1 call + parallel fallback (~25 sec total)             |
| **Prompt Caching**     | Optimized context caching for reduced latency/cost                   |
| **Sentiment Analysis** | Fear & Greed, news, Reddit social sentiment                          |
| **Quant Analysis**     | Z-scores, patterns, correlation tracking                             |
| **Regime Detection**   | Trending/ranging/volatile/quiet classification                       |
| **Monte Carlo**        | Fat-tailed simulation for trade validation                           |
| **Anti-Churn**         | Cooldowns, hysteresis, daily limits                                  |
| **Dynamic Leverage**   | 5-20x based on confidence and mode                                   |
| **Signal De-Overlap**  | Correlation penalty and exposure caps per symbol                     |
| **Freshness Guard**    | Skip stale candles beyond 2× interval                                |
| **Volatility Gate**    | ATR% regime filters for trend vs mean-reversion                      |
| **Strategy Kill-Switch** | Auto-disable on drawdown, Sharpe, or error thresholds              |

---

## Quick Start

```bash
# Install
git clone <repository-url>
cd hypothesis-arena
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Database
npx prisma migrate dev

# Run
npm run dev
# Server: http://localhost:25655
```

### Required Environment Variables

```env
# AI Provider (pick one or use hybrid mode)
AI_PROVIDER=gemini
GEMINI_API_KEY=your_key
# OR
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_key

# Hybrid Mode (use both)
AI_HYBRID_MODE=true
GEMINI_API_KEY=your_gemini_key
OPENROUTER_API_KEY=your_openrouter_key

# WEEX Exchange
WEEX_API_KEY=your_api_key
WEEX_SECRET_KEY=your_secret_key
WEEX_PASSPHRASE=your_passphrase

# Trading
DRY_RUN=true                    # true = simulation, false = live
STARTING_BALANCE=1000
MIN_CONFIDENCE_TO_TRADE=50
MAX_CONCURRENT_POSITIONS=3
```

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│   STAGE 1: MARKET SCAN                           (~5 seconds)   │
│   • Prices, funding rates, technical indicators                 │
│   • Sentiment (Fear & Greed, news, Reddit)                      │
│   • Quant analysis, regime detection                            │
├─────────────────────────────────────────────────────────────────┤
│   STAGE 2: PARALLEL ANALYSIS                  (~25 sec total)   │
│   • COMBINED ANALYST CALL (Optimization)                        │
│   • All 4 analysts run in 1 single LLM request (or fallback)    │
├─────────────────────────────────────────────────────────────────┤
│   STAGE 3: JUDGE DECISION                        (~5 seconds)   │
│   • Compare analyses, pick winner or HOLD                       │
│   • Apply risk adjustments                                      │
├─────────────────────────────────────────────────────────────────┤
│   STAGE 4: EXECUTION                             (~5 seconds)   │
│   • Validate leverage, Monte Carlo check                        │
│   • Place order, set TP/SL, log to database                     │
└─────────────────────────────────────────────────────────────────┘
```

---

## The 4 Analysts

| Analyst   | Style                 | Edge                                           |
| --------- | --------------------- | ---------------------------------------------- |
| **Jim**   | Statistical Arbitrage | RSI/MACD divergence, Bollinger Bands, z-scores |
| **Ray**   | ML-Driven Signals     | Open Interest, Funding Rate, Liquidations      |
| **Karen** | Multi-Strategy Risk   | Sharpe ratio, drawdown limits, correlation     |
| **Quant** | Liquidity & Arbitrage | Funding arbitrage, VWAP, order flow            |

---

## Trading Pairs

| Symbol         | Asset    | Symbol        | Asset    |
| -------------- | -------- | ------------- | -------- |
| `cmt_btcusdt`  | Bitcoin  | `cmt_xrpusdt` | XRP      |
| `cmt_ethusdt`  | Ethereum | `cmt_adausdt` | Cardano  |
| `cmt_solusdt`  | Solana   | `cmt_bnbusdt` | BNB      |
| `cmt_dogeusdt` | Dogecoin | `cmt_ltcusdt` | Litecoin |

---

## Risk Management

### Anti-Churn Rules

| Rule                 | Default   | Purpose                           |
| -------------------- | --------- | --------------------------------- |
| Cooldown After Trade | 5-15 min  | Prevent rapid re-entry            |
| Cooldown Before Flip | 10-30 min | Prevent whipsaw                   |
| Hysteresis           | 1.2x      | Need 20% more confidence to close |
| Daily Limit          | 20-50     | Prevent overtrading               |

### Leverage Limits

| Mode        | Leverage | Position Size | Stop Loss |
| ----------- | -------- | ------------- | --------- |
| Production  | 5-15x    | 10-30%        | 2.5-5%    |
| Competition | 15-20x   | 10-15%        | 1.5-2.5%  |

---

## Competition Mode

> ⚠️ **DEMO TRADING ONLY** - Never use with real funds.

```env
COMPETITION_MODE=true
COMPETITION_MODE_ACK=I_ACCEPT_DEMO_ONLY_AGGRESSIVE_SETTINGS
WEEX_ACCOUNT_TYPE=demo
```

Enables aggressive settings: 50 trades/day, 20x leverage, 50% max position size (typical recommended: 10-15%).

---

## API Endpoints

| Endpoint                     | Description          |
| ---------------------------- | -------------------- |
| `POST /api/autonomous/start` | Start trading engine |
| `POST /api/autonomous/stop`  | Stop trading engine  |
| `GET /api/autonomous/status` | Get engine status    |
| `GET /api/trading/trades`    | List trades          |
| `GET /api/portfolio`         | Portfolio summary    |
| `GET /api/weex/account`      | Account info         |

---

## Scripts

| Command             | Description          |
| ------------------- | -------------------- |
| `npm run dev`       | Development server   |
| `npm run build`     | Build for production |
| `npm run start`     | Production server    |
| `npx prisma studio` | Database GUI         |

---

## Project Structure

```
src/
├── services/
│   ├── ai/                 # AIService, CollaborativeFlow
│   ├── autonomous/         # TradingEngine, Scheduler
│   ├── indicators/         # EMA, RSI, MACD, ATR, BB
│   ├── quant/              # QuantAnalysis, MonteCarlo, Regime
│   ├── sentiment/          # Fear&Greed, News, Reddit
│   └── weex/               # WEEX API client
├── constants/
│   ├── analyst/            # Profiles, risk limits
│   └── prompts/            # AI system prompts
├── api/routes/             # REST endpoints
└── config/                 # Configuration
```

---

## Documentation

See [FLOW.md](FLOW.md) for detailed system architecture, trading logic, and configuration options.

---

## License

MIT License - see [LICENSE](LICENSE)

---

<div align="center">
  
  **Built for WEEX Hackathon 2026**
  
</div>

