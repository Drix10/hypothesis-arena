# Hypothesis Arena v5.0.1 - System Flow

#

# Document version: v5.0.1 (matches README.md release notes)

# System core version: v5.0.0 (parallel analysis pipeline)

## Overview

Hypothesis Arena is an autonomous AI-powered trading system for WEEX perpetual futures. Version 5.0.0 uses a **parallel analysis pipeline** where 4 AI analysts independently analyze market conditions, and a judge picks the best recommendation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    v5.0.0 PARALLEL PIPELINE                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN                           (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Fetch prices, funding rates for 8 approved coins:           │
│     BTC, ETH, SOL, DOGE, XRP, ADA, BNB, LTC                     │
│     (Configured in ContextBuilder.TRADING_SYMBOLS)              │
│   • Calculate technical indicators (EMA, RSI, MACD, ATR, BB)    │
│   • Fetch account state, positions, recent trades               │
│   • Build rich context object for AI analysts                   │
│                                                                  │
│   STAGE 2: PARALLEL ANALYSIS                    (~10 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   ┌─────────────────────────────────────────────────┐           │
│   │  4 analysts receive IDENTICAL full context      │           │
│   │  Each responds INDEPENDENTLY in parallel        │           │
│   │                                                  │           │
│   │  Jim (Technical) ──┐                            │           │
│   │  Ray (Macro) ──────┼──→ 4 recommendations       │           │
│   │  Karen (Risk) ─────┤                            │           │
│   │  Quant ────────────┘                            │           │
│   └─────────────────────────────────────────────────┘           │
│                                                                  │
│   STAGE 3: JUDGE DECISION                        (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Compare 4 analyses on: thesis quality, risk/reward ratio,   │
│     confidence level, alignment with market conditions          │
│   • Pick winner OR output HOLD if no consensus                  │
│   • Minimum confidence to trade: MIN_CONFIDENCE_TO_TRADE (50%)  │
│   • Apply risk adjustments to winner's recommendation           │
│   • Karen's risk concerns get 1.5x weight in scoring (advisory) │
│                                                                  │
│   STAGE 4: EXECUTION                             (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Place order with dynamic leverage (3-10x)                   │
│   • Set TP/SL based on winner's recommendation                  │
│   • Store exit_plan for future reference                        │
│   • Log to database + WEEX compliance                           │
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

**Key Features:**

- Each analyst has ~150 lines of deeply researched, crypto-specific methodology
- Standardized funding rate thresholds (±0.08% extreme, ±0.03% moderate)
- Handles missing data gracefully (skips signals if indicators unavailable)
- Validates all trade parameters (R:R ratios, TP/SL placement, leverage limits)
- HOLD is valid when no clear edge exists per their specific methodology

**Methodology Highlights:**

- **Jim**: 8-point statistical scoring system, RSI divergence (65% accuracy), Bollinger Band squeeze detection
- **Ray**: OI+Price matrix analysis, regime classification (trending/ranging/choppy), BTC correlation rules
- **Karen**: A+/A/B/C setup quality grading, position management tables, correlation exposure tracking
- **Quant**: Funding arbitrage tables with annualized rates, liquidation hunting strategy, VWAP mean reversion

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

## Anti-Churn Rules (COMPETITION MODE - Reduced)

v5.0.0 implements minimal anti-churn policies for competition:

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

## Dynamic Leverage (COMPETITION MODE)

Leverage is set by AI analysts (5x - 20x) based on conviction. The system enforces a **3x notional exposure limit**:

**Formula**: `allocation_usd * leverage <= 3 * account_balance`

| Leverage Range | Position Size     | Stop Loss Requirement | Use Case                                 |
| -------------- | ----------------- | --------------------- | ---------------------------------------- |
| 5-7x           | Up to 40% account | 4-5% from entry       | Conservative, larger positions           |
| 8-10x          | 15-25% account    | 3-4% from entry       | Standard, medium positions               |
| 12-15x         | 5-15% account     | 2-3% from entry       | Aggressive, smaller positions            |
| 16-20x         | 5-10% account     | 1.5-2% from entry     | Maximum, minimal positions (tight stops) |

**Hard Limits:**

- Maximum leverage: 20x (absolute cap, enforced in code)
- Maximum notional exposure: 3x account balance per trade
- Never combine max leverage (20x) with max position size (50%)
- Stop loss must be inversely proportional to leverage to cap max loss at ~30%

**Example** ($1000 account):

- ✓ OK: 10x leverage × $200 allocation = $2000 notional (2x account)
- ✓ OK: 15x leverage × $150 allocation = $2250 notional (2.25x account)
- ✗ EXCEEDS: 20x leverage × $200 allocation = $4000 notional (4x account)
- ✓ CORRECT: 20x leverage × $150 max allocation = $3000 notional (3x account)

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
│   │   ├── index.ts           # Analyst exports (re-exports from other files)
│   │   ├── profiles.ts        # Analyst personas (Jim, Ray, Karen, Quant definitions)
│   │   ├── riskCouncil.ts     # Risk council configuration
│   │   ├── riskLimits.ts      # Global risk limits (max leverage, position sizes)
│   │   └── types.ts           # TypeScript types for analyst module
│   └── prompts/
│       ├── analystPrompt.ts   # System prompts for each analyst persona
│       └── judgePrompt.ts     # System prompt for the judge AI
├── services/
│   ├── ai/
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
│   ├── portfolio/
│   │   └── AnalystPortfolioService.ts  # Virtual portfolios
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
# AI
AI_PROVIDER=gemini|openrouter
AI_TEMPERATURE=0.8

# Trading
# Note: MAX_LEVERAGE is enforced at 20x in code (ABSOLUTE_MAX_LEVERAGE in riskLimits.ts)
MAX_CONCURRENT_POSITIONS=3

# Anti-Churn (COMPETITION MODE - reduced cooldowns)
COOLDOWN_AFTER_TRADE_MS=300000
COOLDOWN_BEFORE_FLIP_MS=600000
MAX_DAILY_TRADES=50
MAX_TRADES_PER_SYMBOL_PER_HOUR=3
HYSTERESIS_MULTIPLIER=1.2

# Risk
WEEKLY_DRAWDOWN_LIMIT_PERCENT=10
# MAX_FUNDING_AGAINST_BPS: Maximum adverse funding rate before reducing leverage.
# When position is AGAINST funding direction (e.g., LONG when funding is positive),
# and funding rate exceeds this threshold, leverage is reduced by -2x.
# Value is in basis points (bps): 5 bps = 0.05% per 8-hour period.
# Comparison: funding_rate > MAX_FUNDING_AGAINST_BPS triggers the penalty.
MAX_FUNDING_AGAINST_BPS=5
```

## Cycle Flow

1. **Pre-checks**: Balance, positions, daily limits
2. **Market Scan**: Fetch data for all 8 coins
3. **Context Build**: Assemble rich context with indicators
4. **Parallel Analysis**: 4 AI calls in parallel
5. **Judge Decision**: 1 AI call to pick winner
6. **Execution**: Place order if approved
7. **Logging**: Database + WEEX compliance
8. **Wait**: Sleep until next cycle (5 minutes default)

## Exit Plan Handling

Each trade includes an `exit_plan` field that specifies invalidation conditions:

- **Stored in DB**: Exit plans are persisted with each trade record
- **Passed to AI**: Active trades with exit plans are included in context
- **Respected by AI**: Analysts MUST NOT recommend closing unless the exit plan is invalidated
- **Hysteresis**: Need 20% more confidence to close than the original entry confidence

**Invalidation Criteria:** An exit plan is considered invalidated when:

1. The specified price level is breached (TP/SL hit)
2. The stated thesis condition becomes false - AI analysts evaluate this by comparing the current market context against the stored `entry_thesis` and `exit_plan` fields. For example, if the thesis was "bullish while above EMA50" and the current `market_data[].intraday.price_vs_ema50` shows "below", the AI recognizes the invalidation. The AI receives the full `TradingContext` object which includes `account.active_trades[].entry_thesis` and `account.active_trades[].exit_plan` for each open position.
3. Time-based expiry is reached (if specified in the plan, checked via `hold_time_hours` in context)
4. A fundamental change occurs that contradicts the entry thesis (AI evaluates this from market data changes)

**AI Safeguards for Exit Plan Respect:**

- The Judge prompt explicitly instructs: "Do NOT close positions unless the exit_plan invalidation condition is met"
- Anti-churn hysteresis requires 20% higher confidence to close than the original entry confidence
- Each analyst receives the full `active_trades` array with `exit_plan` and `entry_thesis` fields
- The system logs warnings if an analyst recommends CLOSE without clear invalidation reasoning
- Cooldown periods (15-30 minutes) prevent rapid open/close cycles that might bypass exit plans
