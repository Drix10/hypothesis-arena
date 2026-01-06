# Hypothesis Arena v5.0.0 - System Flow

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

## The 4 Analysts

| Analyst   | Focus              | Risk Tolerance | Special Role                                                    |
| --------- | ------------------ | -------------- | --------------------------------------------------------------- |
| **Jim**   | Technical Analysis | Moderate       | EMA crossovers, RSI, MACD patterns                              |
| **Ray**   | Macro & Funding    | Moderate       | Funding rates, market structure                                 |
| **Karen** | Risk Management    | Conservative   | **Extra weight** on risk concerns (advisory, not absolute veto) |
| **Quant** | Quantitative       | Aggressive     | Statistical edge, mean reversion                                |

## Action Types

Each analyst outputs ONE of these actions:

| Action   | Description                | When to Use                          |
| -------- | -------------------------- | ------------------------------------ |
| `BUY`    | Open/add to LONG position  | Bullish setup, entry criteria met    |
| `SELL`   | Open/add to SHORT position | Bearish setup, entry criteria met    |
| `HOLD`   | Do nothing                 | No clear edge, wait for better setup |
| `CLOSE`  | Close existing position    | Exit plan invalidated, take profits  |
| `REDUCE` | Reduce position size       | Partial profit taking, reduce risk   |

## Anti-Churn Rules

v5.0.0 implements strict anti-churn policies to prevent overtrading:

1. **Cooldown After Trade**: 15 minutes before same symbol can be traded again (configurable via `COOLDOWN_AFTER_TRADE_MS`)
2. **Cooldown Before Flip**: 30 minutes before direction can be reversed (configurable via `COOLDOWN_BEFORE_FLIP_MS`)
3. **Hysteresis**: Need 20% more confidence to close than to open (configurable via `HYSTERESIS_MULTIPLIER`)
4. **Daily Limit**: Maximum 10 trades per day (enforced via database count, resets at midnight UTC)
5. **Exit Plan Respect**: Don't close unless invalidation condition is met

## Technical Indicators

Calculated from WEEX candlestick data (no external APIs):

**Intraday (5-minute timeframe):**

- EMA 20, EMA 50
- RSI 7, RSI 14
- MACD (12, 26, 9)
- ATR 14

**Long-term (4-hour timeframe):**

- EMA 20, EMA 50, EMA 200
- RSI 14
- MACD
- Bollinger Bands (20, 2)
- Trend detection: Classified as `bullish` (EMA20 > EMA50 > EMA200), `bearish` (EMA20 < EMA50 < EMA200), or `neutral` (mixed). Trend strength (0-100) is calculated from EMA spread relative to price.

## Dynamic Leverage

Leverage is calculated dynamically (3x - 10x) based on market conditions. The `MAX_LEVERAGE` environment variable (default: 5) sets the **base leverage**, which is then adjusted up or down:

| Condition                                        | Adjustment |
| ------------------------------------------------ | ---------- |
| Confidence > 95%                                 | +2x        |
| Confidence > 85%                                 | +1x        |
| Confidence < 60%                                 | -1x        |
| High volatility (ATR > 5%)                       | -2x        |
| High adverse funding (> MAX_FUNDING_AGAINST_BPS) | -2x        |
| Strong trend alignment (strength > 80)           | +1x        |

**Volatility Classification (ATR-based):**

- Low: ATR < 2% of price
- Medium: ATR 2-5% of price
- High: ATR > 5% of price (triggers -2x leverage adjustment)

**Karen's Influence on Leverage:**
Karen (Risk Management analyst) doesn't directly adjust leverage. Instead, her conservative recommendations influence the Judge's final decision. If Karen flags high risk, the Judge may:

1. Select a more conservative analyst as winner
2. Apply risk adjustments to reduce leverage/allocation
3. Output HOLD if risk concerns outweigh opportunity

Karen's risk concerns receive 1.5x weight in the Judge's scoring, making her influence advisory but significant.

**Note:** Final leverage is always clamped to the 3-10x range regardless of adjustments. `MAX_LEVERAGE` in config is the starting point, not the absolute maximum.

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
│   │   ├── AntiChurnService.ts   # Cooldowns, hysteresis
│   │   └── LeverageService.ts    # Dynamic leverage
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
# TRADING_STYLE: 'scalp' (5-12h hold, 5% targets) or 'swing' (24-48h hold, 10% targets)
TRADING_STYLE=scalp|swing
MAX_LEVERAGE=5
MAX_CONCURRENT_POSITIONS=6

# Anti-Churn
COOLDOWN_AFTER_TRADE_MS=900000
COOLDOWN_BEFORE_FLIP_MS=1800000
MAX_TRADES_PER_DAY=10
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
