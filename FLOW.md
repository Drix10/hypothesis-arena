# Hypothesis Arena v5.3.0 - System Flow

## Overview

Hypothesis Arena is an autonomous AI-powered trading system for WEEX perpetual futures. Version 5.x uses a **parallel analysis pipeline** where 4 AI analysts independently analyze market conditions, and a judge picks the best recommendation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    v5.3.0 PARALLEL PIPELINE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN + ENRICHMENT              (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Fetch prices, funding rates for approved coins              │
│     (Configured via APPROVED_SYMBOLS env var)                   │
│   • Calculate technical indicators (EMA, RSI, MACD, ATR, BB)    │
│   • Fetch account state, positions, recent trades               │
│   • Fetch sentiment data (Fear & Greed, news sentiment)         │
│   • Run quant analysis (z-scores, patterns, win rates)          │
│   • Run regime detection (ADX, BB, ATR rules)                   │
│   • Build rich context object for AI analysts                   │
│                                                                  │
│   STAGE 2: PARALLEL ANALYSIS                    (~10 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  4 analysts receive IDENTICAL full context              │   │
│   │  (includes sentiment + quant + regime analysis)         │   │
│   │  Each responds INDEPENDENTLY in parallel                │   │
│   │                                                          │   │
│   │  Jim (Statistical Arbitrage) ──┐                        │   │
│   │  Ray (AI/ML Signals) ──────────┼──→ 4 recommendations   │   │
│   │  Karen (Multi-Strategy Risk) ──┤                        │   │
│   │  Quant (Liquidity & Arb) ──────┘                        │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   STAGE 3: JUDGE DECISION                        (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Compare 4 analyses on: thesis quality, risk/reward ratio,   │
│     confidence level, alignment with market conditions          │
│   • Pick winner OR output HOLD if no consensus                  │
│   • Minimum confidence to trade: MIN_CONFIDENCE_TO_TRADE (50%)  │
│   • Apply risk adjustments to winner's recommendation           │
│   • Karen's risk concerns get 1.5x weight in scoring (advisory) │
│   • Analyst weight adjustments from trade journal performance   │
│                                                                  │
│   STAGE 4: EXECUTION + VALIDATION (v5.3.0)       (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Validate leverage with risk limits:                         │
│     - isLeverageAutoApproved() - confidence-based approval      │
│     - getMaxLeverageForExposure() - portfolio exposure limits   │
│     - getRequiredStopLossPercent() - leverage-appropriate SL    │
│   • Confirmation signals (advisory, don't block trades):        │
│     - Per-symbol sentiment check                                │
│   • Monte Carlo validation for high-confidence trades           │
│   • Place order with validated leverage (10-20x)                │
│   • Set TP/SL based on winner's recommendation                  │
│   • Store exit_plan for future reference                        │
│   • Log to database + WEEX compliance                           │
│   • Record trade journal entry for learning loop                │
│   • Auto-generate lessons when positions close                  │
│                                                                  │
│   TOTAL: ~25 seconds per cycle (was ~60 seconds in v4.0.0)      │
│   AI CALLS: 5 (was 8-10 in v4.0.0)                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## The 4 Quant Analysts (COMPETITION MODE - QUANTITATIVE EDITION)

Inspired by modern quantitative trading methodologies, each analyst brings a distinct approach:

| Analyst   | Methodology Style     | Approach                                 | Edge                                                |
| --------- | --------------------- | ---------------------------------------- | --------------------------------------------------- |
| **Jim**   | Statistical Arbitrage | Mean Reversion & Pattern Recognition     | RSI/MACD divergence, Bollinger Bands, z-scores      |
| **Ray**   | ML-Driven Signals     | AI/ML & Regime Detection                 | Open Interest, Funding Rate, Liquidation analysis   |
| **Karen** | Multi-Strategy Risk   | Portfolio Optimization & Risk Management | Sharpe ratio, drawdown limits, correlation tracking |
| **Quant** | Liquidity & Arbitrage | Market Microstructure & Arbitrage        | Funding arbitrage, VWAP, order flow analysis        |

## Multi-Model Rotation (v5.3.0)

Each analyst uses a different AI model per cycle, randomly assigned from a pool of 4 models. This provides:

- **Diversity**: Different models have different strengths and biases
- **Resilience**: If one model fails, others continue working
- **Fair comparison**: No single model dominates all analysts

**Model Pool:**

| Model                         | Provider   | Strengths                  | Priority     |
| ----------------------------- | ---------- | -------------------------- | ------------ |
| `deepseek/deepseek-chat`      | OpenRouter | Strong reasoning, reliable | 0 (fallback) |
| `google/gemini-2.0-flash-001` | OpenRouter | Fast, reliable             | 1            |
| `x-ai/grok-4.1-fast`          | OpenRouter | Fast reasoning             | 2            |
| `xiaomi/mimo-v2-flash`        | OpenRouter | Fast, cost-effective       | 3            |

**Configuration:**

```bash
# Enable multi-model rotation (default: true)
MULTI_MODEL_ENABLED=true

# Fallback model when multi-model disabled
OPENROUTER_MODEL=deepseek/deepseek-chat
```

**Behavior:**

- At the start of each cycle, models are shuffled using Fisher-Yates algorithm
- Each analyst gets a unique model (no duplicates when 4+ models available)
- If a model fails, automatic fallback to the most reliable model (DeepSeek)
- Models with 3+ recent failures are temporarily skipped (auto-reset after 5 minutes)
- Set `MULTI_MODEL_ENABLED=false` to use single model for all analysts
  **Key Features:**

- Each analyst has ~150 lines of deeply researched, crypto-specific methodology
- Standardized funding rate thresholds (±0.08% extreme, ±0.03% moderate)
- Handles missing data gracefully (skips signals if indicators unavailable)
- Validates all trade parameters (R:R ratios, TP/SL placement, leverage limits)
- HOLD is valid when no clear edge exists per their specific methodology

## Action Types

Each analyst outputs ONE of these actions:

| Action   | Description                | When to Use                          |
| -------- | -------------------------- | ------------------------------------ |
| `BUY`    | Open/add to LONG position  | Bullish setup, entry criteria met    |
| `SELL`   | Open/add to SHORT position | Bearish setup, entry criteria met    |
| `HOLD`   | Do nothing                 | No clear edge, wait for better setup |
| `CLOSE`  | Close existing position    | Exit plan invalidated, take profits  |
| `REDUCE` | Reduce position size       | Partial profit taking, reduce risk   |

## Trade Quality Gates

Before executing any trade, the system checks:

1. **Minimum Confidence**: Trade must have confidence >= `MIN_CONFIDENCE_TO_TRADE` (default: 50%)
2. **Anti-Churn Rules**: Cooldowns and daily limits must be respected
3. **Risk Limits**: Position size, leverage, and exposure limits
4. **Monte Carlo Validation**: For setups with confidence >65%, Monte Carlo simulation is mandatory:
   - If MC Sharpe >= 1.2: Trade proceeds
   - If MC Sharpe < 1.2: Trade is blocked (insufficient edge)
   - If MC simulation errors: Only the MC simulation is retried (not the entire trade flow)
     - Max retry attempts: 3
     - Backoff strategy: Exponential backoff (30s, 60s, 120s)
     - Worst-case timing: ~3.5 minutes for 3 failed attempts (30s + 60s + 120s)
     - Cycle behavior during MC retry: The specific trade is blocked while MC retries;
       other trades and position management continue asynchronously. The ~25s cycle
       estimate assumes MC succeeds on first attempt. With retries, that specific
       trade decision may extend to ~4 minutes while the rest of the cycle proceeds.
     - Terminal behavior: If all retries exhausted, setup is marked as "validation error",
       error is logged with full details, execution is blocked, and an alert is surfaced
       for manual review

## Anti-Churn Rules (COMPETITION MODE - Reduced)

v5.x implements minimal anti-churn policies for competition:

1. **Cooldown After Trade**: 5 minutes before same symbol can be traded again (configurable via `COOLDOWN_AFTER_TRADE_MS`)
2. **Cooldown Before Flip**: 10 minutes before direction can be reversed (configurable via `COOLDOWN_BEFORE_FLIP_MS`)
3. **Hysteresis**: Need 20% more confidence to close than to open
4. **Daily Limit**: Maximum 50 trades per day (configurable via `MAX_DAILY_TRADES`)
5. **Exit Plan Respect**: Don't close unless invalidation condition is met

## Technical Indicators

Calculated from WEEX candlestick data (no external APIs):

**Intraday (5-minute timeframe):**

- EMA 9, EMA 20, EMA 50
- RSI 7, RSI 14
- MACD (12, 26, 9)
- ATR 14
- Bollinger Bands (20, 2)

**Long-term (4-hour timeframe):**

- EMA 20, EMA 50, EMA 200
- RSI 14
- MACD
- Bollinger Bands (20, 2)
- Trend detection: Classified as `bullish` (EMA20 > EMA50 > EMA200), `bearish` (EMA20 < EMA50 < EMA200), or `neutral` (mixed). Trend strength (0-100) is calculated from EMA spread relative to price.

**Derivatives Data:**

- Open Interest (OI) - Total outstanding contracts
- Funding Rate - 8-hour payment between longs/shorts
- VWAP - Volume-weighted average price

**Crypto-Specific Thresholds:**

- RSI: Oversold < 25 (not 30), Overbought > 75 (not 70) - crypto is more volatile
- Funding: Extreme at ±0.08%, Moderate at ±0.03%
- OI Divergence: Price rising + OI falling = weak rally (65% accuracy)

## Sentiment Analysis Service

Provides market sentiment data to AI analysts (cached, non-blocking):

**Data Sources:**

- **Fear & Greed Index** (alternative.me) - FREE, no API key required

  - Updates daily, cached for 1 hour (`CACHE_TTL.FEAR_GREED`)
  - Values: 0-100 with classification breakpoints:
    - 0-20: "Extreme Fear" (strong contrarian BUY signal)
    - 21-40: "Fear" (moderate contrarian BUY signal)
    - 41-60: "Neutral" (no signal)
    - 61-80: "Greed" (moderate contrarian SELL signal)
    - 81-100: "Extreme Greed" (strong contrarian SELL signal)

- **NewsData.io** - FREE tier (200 credits/day, requires API key registration at https://newsdata.io/register)
  - Crypto news with text-based sentiment analysis
  - Cached for 30 minutes (`CACHE_TTL.NEWS`) to conserve API credits
  - Covers BTC, ETH, and general crypto news
  - **Optional**: If `NEWSDATA_API_KEY` is not set, news sentiment is disabled and the system operates without crypto news data (Fear & Greed Index still works)

**Context Fields:**

```typescript
sentiment: {
  fear_greed_index: number | null,      // 0-100
  fear_greed_classification: string,    // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  market_sentiment: number,             // -1 to 1 (weighted BTC/ETH sentiment)
  sentiment_trend: string,              // "improving" | "declining" | "stable"
  btc_sentiment: { score, sentiment, news_count, positive_count, negative_count },
  eth_sentiment: { score, sentiment, news_count, positive_count, negative_count },
  contrarian_signal: { signal: number, reason: string },
  recent_headlines: string[],
}
```

## Quant Analysis Service

Provides statistical analysis on all trading pairs BEFORE AI analysts make decisions:

**Analysis Types:**

- **Statistical Metrics**: Mean, std dev, z-score, percentile, volatility rank
- **Pattern Detection**: Support/resistance, trend direction/strength, volume profile
- **Probability Metrics**: Historical win rates at current conditions, optimal TP/SL levels
- **Cross-Asset Analysis**: BTC dominance, correlation matrix, market regime
- **Funding Rate Percentile Analysis** (v5.1.0): 7-day percentile ranking with persistence filter

**Key Signals:**

| Z-Score  | Interpretation | Signal            |
| -------- | -------------- | ----------------- |
| < -2.0   | Oversold       | Long opportunity  |
| > +2.0   | Overbought     | Short opportunity |
| -1 to +1 | Normal range   | No edge           |

**Funding Rate Signals:**

| Percentile | Direction     | Signal                                      |
| ---------- | ------------- | ------------------------------------------- |
| > 95th     | Long crowded  | Contrarian SHORT (if persistent 2+ periods) |
| < 5th      | Short crowded | Contrarian LONG (if persistent 2+ periods)  |
| 5-95th     | Normal        | No signal                                   |

## Regime Detection Service (v5.1.0)

Implements simplified 4-state regime detection per quant advisor recommendations:

**Regime Types:**

| Regime       | Characteristics                | Recommended Strategy                    |
| ------------ | ------------------------------ | --------------------------------------- |
| **Trending** | ADX > 25, clear EMA structure  | Trend following - buy dips/sell rallies |
| **Ranging**  | ADX < 20, tangled EMAs         | Mean reversion - fade extremes          |
| **Volatile** | High ATR, expanding volatility | Reduced size, wider stops, or sit out   |
| **Quiet**    | Low volatility, low volume     | Wait for breakout or skip               |

**Trading Difficulty Assessment:**

| Difficulty | Conditions                         | Production Leverage | Competition Leverage |
| ---------- | ---------------------------------- | ------------------- | -------------------- |
| Easy       | Clear trend, normal volatility     | 12-15x              | 15-18x               |
| Moderate   | Mixed signals                      | 8-12x               | 12-15x               |
| Hard       | High volatility, weak trends       | 5-10x               | 10-12x               |
| Extreme    | Very high volatility, tangled EMAs | 5x max, HOLD rec.   | 10x max, HOLD rec.   |

See "Production Mode" (5-15x) and "Competition Mode" (10-20x) sections below for full leverage limits.

**Potential impact:** +8–15% improvement in risk-adjusted returns. _Disclaimer: This estimate is based on backtesting and simulations only. Past performance does not guarantee future results. Actual results vary with market conditions, implementation, and operational factors._

## Monte Carlo Service (v5.1.0)

Fat-tailed Monte Carlo simulation for trade validation:

**Features:**

- Student's t-distribution (df=5) for crypto fat tails
- GARCH(1,1) for volatility clustering
- Trading costs subtraction (0.06% per trade)
- Minimum Sharpe threshold: 1.2 for trade approval

**Usage:**

- Run only on high-confidence setups (>65%)
- Validates both long and short scenarios
- Returns expected value, win rate, VaR, and Sharpe ratio

**Potential impact:** Critical safety net, +0.3–0.5 Sharpe lift. _Disclaimer: This estimate is based on backtesting and simulations only. Past performance does not guarantee future results. Actual results vary with market conditions, implementation, and operational factors._

## Trade Journal Service (included in v5.1.0)

Systematic analysis of past performance for continuous improvement:

**Features:**

- Enhanced trade logging with entry context (regime, z-score, funding, sentiment)
- Pattern performance analysis across all trades
- Auto-generated lessons from trade outcomes
- Analyst-specific win rate tracking over rolling 50 trades
- Weight adjustments for underperforming analysts (±20%)

**Potential impact:** +0.1–0.3 Sharpe, +3–8% win rate long-term. _Disclaimer: This estimate is based on backtesting and simulations only. Past performance does not guarantee future results. Actual results vary with market conditions, implementation, and operational factors._

## Dynamic Leverage

Leverage is set by AI analysts based on conviction. The system enforces a **3x notional exposure limit**:

**Formula**: `allocation_usd * leverage <= 3 * account_balance`

### Production Mode (Default): Leverage Range 5x–15x

| Leverage Range | Position Size  | Stop Loss Requirement | Use Case                       |
| -------------- | -------------- | --------------------- | ------------------------------ |
| 5-8x           | 20-30% account | 4-5% from entry       | Conservative, larger positions |
| 8-12x          | 15-25% account | 3-4% from entry       | Standard, medium positions     |
| 12-15x         | 10-20% account | 2.5-3% from entry     | Moderate, smaller positions    |

### Competition Mode: Leverage Range 10x–20x

| Leverage Range | Position Size  | Stop Loss Requirement | Use Case                                 |
| -------------- | -------------- | --------------------- | ---------------------------------------- |
| 10-12x         | 15-25% account | 3-4% from entry       | Standard, medium positions               |
| 12-15x         | 10-20% account | 2.5-3% from entry     | Moderate, smaller positions              |
| 15-18x         | 5-15% account  | 2-2.5% from entry     | Aggressive, smaller positions            |
| 18-20x         | 5-10% account  | 1.5-2% from entry     | Maximum, minimal positions (tight stops) |

**Hard Limits (Both Modes):**

- Maximum leverage: 20x (absolute cap, enforced in code)
- Maximum notional exposure: 3x account balance per trade
- Never combine max leverage (20x) with max position size (50%)
- Stop loss must be inversely proportional to leverage to cap max loss at ~30%

## Competition Mode

> ⚠️ **CRITICAL WARNING: DEMO/PAPER TRADING ONLY**
>
> Competition mode is designed **EXCLUSIVELY** for demo money competitions and paper trading.
> **NEVER enable Competition Mode with real funds.** The aggressive settings can result in
> rapid, significant losses that may exceed your risk tolerance.
>
> **The system does NOT automatically detect whether you are connected to a demo or live account.**
> It is YOUR responsibility to verify your account type before enabling Competition Mode.
>
> **WEEX API Limitation:** The WEEX API does not provide a programmatic way to distinguish
> between demo and live accounts. The system cannot verify your account type automatically.
>
> **v5.3.0 Safeguard:** Competition mode now REQUIRES `WEEX_ACCOUNT_TYPE=demo` or `WEEX_ACCOUNT_TYPE=test`
> to be explicitly set. The system will fail fast at startup if this is missing or set to `live`.
> See `src/constants/analyst/riskLimits.ts` for implementation details.
>
> **⚠️ IMPORTANT: This is a USER-TRUST check, NOT a verified API check.** The WEEX API does not provide
> a way to programmatically verify whether an account is demo or live. Setting `WEEX_ACCOUNT_TYPE=demo`
> is a self-declaration that YOU must verify manually. The system trusts your declaration.
>
> **Recommended Manual Verification:** Before enabling competition mode, manually confirm:
>
> - Your WEEX account ID matches your expected demo account
> - Your visible balance matches expected demo funds (not real money)
> - You are logged into the correct WEEX environment (demo vs production)

Competition mode enables aggressive settings for demo money competitions:

**Activation:**

```bash
# In .env file - ALL THREE variables are required for competition mode
COMPETITION_MODE=true
COMPETITION_MODE_ACK=I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS
WEEX_ACCOUNT_TYPE=demo  # Required: must be "demo" or "test" (v5.3.0)
```

**Startup Behavior:**

When Competition Mode is enabled, the system will:

1. Fail fast if `WEEX_ACCOUNT_TYPE` is not set to `demo` or `test`
2. Fail fast if `WEEX_ACCOUNT_TYPE=live` (blocks competition mode entirely)
3. Log a prominent warning at startup reminding you to verify your account type
4. Require the exact acknowledgment string to proceed
5. Apply aggressive trading parameters

**Aggressive Settings (vs Production Defaults):**

| Setting               | Production | Competition | Risk                                            |
| --------------------- | ---------- | ----------- | ----------------------------------------------- |
| Max Daily Trades      | 20         | 50          | 2.5× more trades = 2.5× more fees and exposure  |
| Cooldown After Trade  | 15 min     | 5 min       | Faster re-entry can compound losses             |
| Cooldown Before Flip  | 30 min     | 10 min      | Rapid direction changes increase whipsaw risk   |
| Leverage Range        | 5-15x      | 10-20x      | Higher leverage amplifies both gains AND losses |
| Max Position Size     | 25%        | 50%         | Larger positions = larger potential drawdowns   |
| Weekly Drawdown Limit | 10%        | 25%         | Allows deeper drawdowns before stopping         |

**Risks of Competition Mode:**

1. **Rapid Capital Depletion**: 50 trades/day at 20x leverage with 50% position sizes can deplete an account within hours during adverse conditions
2. **Amplified Losses**: 20x leverage means a 5% adverse move = 100% loss on that position
3. **Compounding Errors**: Short cooldowns allow the system to compound mistakes quickly
4. **No Safety Net**: The system trusts your acknowledgment - it will execute aggressively

**Pre-Activation Checklist:**

Before setting `COMPETITION_MODE=true`, verify:

- [ ] You are connected to a **DEMO/TESTNET** account (check WEEX account settings)
- [ ] **MANUAL VERIFICATION**: Your account ID matches your expected demo account ID
- [ ] **MANUAL VERIFICATION**: Your visible balance matches expected demo funds (not real money)
- [ ] You understand all aggressive settings listed above
- [ ] You accept that this mode can rapidly deplete demo funds
- [ ] You have set `COMPETITION_MODE_ACK=I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS`
- [ ] You have set `WEEX_ACCOUNT_TYPE=demo` (or `test`) to confirm this is a demo account

See `.env.example` for the authoritative default values for both modes.

## File Structure

```
src/
├── api/
│   ├── middleware/
│   │   └── errorHandler.ts
│   └── routes/
│       ├── autonomous.ts      # Engine control endpoints
│       ├── index.ts           # API router
│       ├── portfolio.ts       # Portfolio endpoints
│       ├── trading.ts         # Trading endpoints
│       └── weex.ts            # WEEX proxy endpoints
├── config/
│   ├── database.ts            # Prisma + Turso setup
│   └── index.ts               # Configuration
├── constants/
│   ├── analyst/
│   │   ├── index.ts           # Analyst exports
│   │   ├── profiles.ts        # Analyst personas (Jim, Ray, Karen, Quant)
│   │   ├── riskCouncil.ts     # Risk council configuration
│   │   ├── riskLimits.ts      # Global risk limits
│   │   └── types.ts           # TypeScript types
│   └── prompts/
│       ├── analystPrompt.ts   # System prompts for each analyst
│       └── judgePrompt.ts     # System prompt for the judge AI
├── services/
│   ├── ai/
│   │   ├── AIService.ts       # Centralized AI provider (Gemini/OpenRouter)
│   │   └── CollaborativeFlow.ts    # Parallel analysis orchestration
│   ├── autonomous/
│   │   ├── AutonomousTradingEngine.ts  # Main trading engine
│   │   └── TradingScheduler.ts         # Market-aware scheduling
│   ├── compliance/
│   │   └── AILogService.ts     # WEEX compliance logging
│   ├── context/
│   │   └── ContextBuilder.ts   # Build rich context for AI
│   ├── indicators/
│   │   ├── IndicatorCalculator.ts      # EMA, RSI, MACD, etc.
│   │   └── TechnicalIndicatorService.ts # Indicator orchestration
│   ├── journal/
│   │   ├── index.ts            # Journal service exports
│   │   └── TradeJournalService.ts      # Trade journal & learning loop
│   ├── portfolio/
│   │   └── AnalystPortfolioService.ts  # Virtual portfolios
│   ├── quant/
│   │   ├── index.ts            # Quant service exports
│   │   ├── MonteCarloService.ts        # Fat-tailed Monte Carlo simulation
│   │   ├── QuantAnalysisService.ts     # Statistical analysis, patterns
│   │   └── RegimeDetector.ts           # Market regime classification
│   ├── sentiment/
│   │   ├── index.ts            # Sentiment service exports
│   │   └── SentimentService.ts # Fear & Greed, news sentiment
│   ├── trading/
│   │   └── AntiChurnService.ts   # Cooldowns, hysteresis
│   └── weex/
│       └── WeexClient.ts       # WEEX API client
├── shared/
│   ├── types/
│   │   ├── market.ts           # Market data types
│   │   └── weex.ts             # WEEX API types
│   └── utils/
│       ├── validation.ts       # Input validation
│       └── weex.ts             # WEEX utilities
├── types/
│   ├── analyst.ts              # Analyst/Judge schemas
│   └── context.ts              # Trading context types
├── utils/
│   ├── errors.ts               # Error classes
│   └── logger.ts               # Winston logger
└── server.ts                   # Express server
```

## API Endpoints

### Engine Control

- `POST /api/autonomous/start` - Start trading engine
- `POST /api/autonomous/stop` - Stop trading engine
- `GET /api/autonomous/status` - Get engine status
- `GET /api/autonomous/events` - SSE event stream

### Debug (v5.3.0)

- `GET /api/autonomous/debug/journal/:tradeId` - Get specific journal entry
- `GET /api/autonomous/debug/journal?limit=20` - List recent journal entries
- `GET /api/autonomous/debug/tracked-trades` - List all tracked trades
- `GET /api/autonomous/debug/tracked-trades/:tradeId` - Get specific tracked trade
- `GET /api/autonomous/debug/sentiment` - Get sentiment context with formatted output
- `GET /api/autonomous/debug/reddit-sentiment` - Get Reddit sentiment with formatted output
- `GET /api/autonomous/debug/regime/:symbol` - Get market regime for a symbol
- `POST /api/autonomous/debug/monte-carlo` - Run full Monte Carlo analysis (long + short)
- `POST /api/autonomous/debug/monte-carlo/raw` - Run raw Monte Carlo simulation (single direction)

### Admin (v5.3.0)

- `POST /api/autonomous/admin/clear-caches` - Clear ALL caches (sentiment, quant, funding, regime)
- `POST /api/autonomous/admin/clear-journal` - Clear trade journal (testing only)
- `POST /api/autonomous/admin/clear-tracked-trades` - Clear tracked trades (testing only)

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

## Configuration

Key environment variables (see `.env.example` in project root):

```bash
# AI Provider
AI_PROVIDER=gemini|openrouter
AI_TEMPERATURE=0.8
GEMINI_API_KEY=your_gemini_api_key
OPENROUTER_API_KEY=your_openrouter_api_key

# Trading
MAX_CONCURRENT_POSITIONS=3

# Approved Symbols Whitelist
# APPROVED_SYMBOLS: Comma-separated list of trading symbols the app will allow
# Format: Comma-separated symbol strings (e.g., "BTC,ETH,SOL")
# Parsing: Each symbol is trimmed and uppercased (e.g., " btc , eth " → ["BTC", "ETH"])
# Example: APPROVED_SYMBOLS=BTC,ETH,SOL,DOGE,XRP,ADA,BNB,LTC
# Default: If unset, defaults to BTC,ETH,SOL,DOGE,XRP,ADA,BNB,LTC (8 coins)
APPROVED_SYMBOLS=BTC,ETH,SOL,DOGE,XRP,ADA,BNB,LTC

# Anti-Churn (COMPETITION MODE - reduced cooldowns)
COOLDOWN_AFTER_TRADE_MS=300000
COOLDOWN_BEFORE_FLIP_MS=600000
MAX_DAILY_TRADES=50
MAX_TRADES_PER_SYMBOL_PER_HOUR=3
HYSTERESIS_MULTIPLIER=1.2

# Risk
WEEKLY_DRAWDOWN_LIMIT_PERCENT=10
MAX_FUNDING_AGAINST_BPS=5

# Competition Mode (optional)
COMPETITION_MODE=true
COMPETITION_MODE_ACK=I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS

# Sentiment Service (optional)
NEWSDATA_API_KEY=your_newsdata_api_key
```

## Cycle Flow

1. **Pre-checks**: Balance, positions, daily limits, weekly drawdown
2. **Pre-Stage-2 Optimization**: Skip expensive analysis if limits reached
3. **Market Scan**: Fetch data for all 8 coins
4. **Context Build**: Assemble rich context with indicators, sentiment, quant, regime
5. **Parallel Analysis**: 4 AI calls in parallel (each receives full enriched context)
6. **Judge Decision**: 1 AI call to pick winner (with analyst weight adjustments)
7. **Execution**: Place order if approved
8. **Logging**: Database + WEEX compliance + trade journal
9. **Wait**: Sleep until next cycle (5 minutes default)

## Exit Plan Handling

Each trade includes an `exit_plan` field that specifies invalidation conditions:

- **Stored in DB**: Exit plans are persisted with each trade record
- **Passed to AI**: Active trades with exit plans are included in context
- **Respected by AI**: Analysts MUST NOT recommend closing unless the exit plan is invalidated
- **Hysteresis**: Need 20% more confidence to close than the original entry confidence

**Invalidation Criteria:** An exit plan is considered invalidated when:

1. The specified price level is breached (TP/SL hit)
2. The stated thesis condition becomes false
3. Time-based expiry is reached (if specified)
4. A fundamental change occurs that contradicts the entry thesis

## Caching Strategy

| Service                  | Cache TTL  | Purpose                                                   |
| ------------------------ | ---------- | --------------------------------------------------------- |
| Sentiment (News)         | 30 minutes | Conserve NewsData.io credits                              |
| Sentiment (Fear & Greed) | 1 hour     | Updates daily                                             |
| Quant Analysis           | 5 minutes  | Aligned with trading cycle                                |
| Contract Specs           | 30 minutes | Preemptively refresh before external 1-hour expiry window |

All caches include:

- Race condition protection (prevents duplicate API calls)
- Graceful degradation if APIs unavailable
- Cleanup timers with `unref()` to not block process exit
- LRU eviction with max size limits
