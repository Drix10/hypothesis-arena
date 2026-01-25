# Hypothesis Arena - System Flow

## Overview

Hypothesis Arena is an autonomous AI-powered trading system for WEEX perpetual futures. It uses a **parallel analysis pipeline** where 4 AI analysts independently analyze market conditions, and a judge picks the best recommendation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       PARALLEL PIPELINE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN + ENRICHMENT              (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Fetch prices, funding rates for approved coins              │
│   • Calculate technical indicators (EMA, RSI, MACD, ATR, BB)    │
│   • Fetch account state, positions, recent trades               │
│   • Fetch sentiment data (Fear & Greed, news, Reddit)           │
│   • Run quant analysis (z-scores, patterns, win rates)          │
│   • Run regime detection (ADX, BB, ATR rules)                   │
│   • Build rich context object for AI analysts                   │
│                                                                  │
│   STAGE 2: PARALLEL ANALYSIS (OPTIMIZED)        (~10 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   ┌─────────────────────────────────────────────────────────┐   │
│   │  COMBINED ANALYST CALL (Optimization)                   │   │
│   │  All 4 analysts run in 1 single LLM request             │   │
│   │                                                         │   │
│   │  Jim (Statistical Arbitrage) ──┐                        │   │
│   │  Ray (AI/ML Signals) ──────────┼──→ 4 recommendations   │   │
│   │  Karen (Multi-Strategy Risk) ──┤                        │   │
│   │  Quant (Liquidity & Arb) ──────┘                        │   │
│   │                                                         │   │
│   │  *Fallback: Retry individual analysts if combined fails │   │
│   └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│   STAGE 3: JUDGE DECISION                        (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Compare 4 analyses on thesis quality, risk/reward, etc.     │
│   • Pick winner OR output HOLD if no consensus                  │
│   • Apply risk adjustments to winner's recommendation           │
│   • Karen's risk concerns get 1.5x weight (advisory)            │
│                                                                  │
│   STAGE 4: EXECUTION + VALIDATION                (~5 seconds)   │
│   ─────────────────────────────────────────────────────────────  │
│   • Validate leverage with risk limits                          │
│   • Monte Carlo validation for high-confidence trades           │
│   • Place order with validated leverage                         │
│   • Set TP/SL, store exit plan                                  │
│   • Log to database + WEEX compliance                           │
│                                                                  │
│   TOTAL: ~25 seconds per cycle | AI CALLS: 2 (1 Combined+Judge) │
└─────────────────────────────────────────────────────────────────┘
```

## The 4 Analysts

| Analyst   | Style                 | Approach                             | Edge                                           |
| --------- | --------------------- | ------------------------------------ | ---------------------------------------------- |
| **Jim**   | Statistical Arbitrage | Mean Reversion & Pattern Recognition | RSI/MACD divergence, Bollinger Bands, z-scores |
| **Ray**   | ML-Driven Signals     | AI/ML & Regime Detection             | Open Interest, Funding Rate, Liquidations      |
| **Karen** | Multi-Strategy Risk   | Portfolio Optimization & Risk Mgmt   | Sharpe ratio, drawdown limits, correlation     |
| **Quant** | Liquidity & Arbitrage | Market Microstructure                | Funding arbitrage, VWAP, order flow            |

Each analyst has ~150 lines of crypto-specific methodology with standardized thresholds.

## Hybrid AI Mode

Split analysts across providers for diversity and resilience:

**Single Provider Mode** (`AI_HYBRID_MODE=false`): All analysts use same provider.

**Hybrid Mode** (`AI_HYBRID_MODE=true`):

- Combined Analyst Call (Jim/Ray/Karen/Quant) → Gemini (Strongest Model)
- Judge → Gemini or OpenRouter (DeepSeek/Claude) depending on config

Cross-provider fallback: If primary fails, automatically tries the other provider.

## Action Types

| Action   | Description                | When to Use                         |
| -------- | -------------------------- | ----------------------------------- |
| `BUY`    | Open/add to LONG position  | Bullish setup, entry criteria met   |
| `SELL`   | Open/add to SHORT position | Bearish setup, entry criteria met   |
| `HOLD`   | Do nothing                 | No clear edge                       |
| `CLOSE`  | Close existing position    | Exit plan invalidated, take profits |
| `REDUCE` | Reduce position size       | Partial profit taking, reduce risk  |

## Trade Quality Gates

1. **Minimum Confidence**: >= `MIN_CONFIDENCE_TO_TRADE` (default: 50%)
2. **Anti-Churn Rules**: Cooldowns and daily limits
3. **Risk Limits**: Position size, leverage, exposure limits
4. **Freshness Guard**: Skip stale candles older than 2× interval
5. **Inference Timeout**: 200ms per strategy with cached fallback to HOLD
6. **Monte Carlo Validation**: For confidence >65%, requires Sharpe >= 1.2

## Anti-Churn Rules

| Rule                 | Default   | Purpose                           |
| -------------------- | --------- | --------------------------------- |
| Cooldown After Trade | 5-15 min  | Prevent rapid re-entry            |
| Cooldown Before Flip | 10-30 min | Prevent direction whipsaw         |
| Hysteresis           | 1.2x      | Need 20% more confidence to close |
| Daily Limit          | 20-50     | Prevent overtrading               |
| Max Per Symbol/Hour  | 3         | Symbol-specific rate limit        |

## Technical Indicators

**Intraday (5m):** EMA 9/20/50, RSI 7/14, MACD, ATR 14, Bollinger Bands

**Long-term (4h):** EMA 20/50/200, RSI 14, MACD, Bollinger Bands, Trend Detection

**Derivatives:** Open Interest, Funding Rate, VWAP

**Crypto Thresholds:**

- RSI: Oversold < 25, Overbought > 75
- Funding: Extreme ±0.08%, Moderate ±0.03%
- Volatility Regime Gate: ATR% < 2% disables trend strategies; ATR% > 5% disables mean-reversion

## Sentiment Analysis

**Data Sources (all FREE):**

- Fear & Greed Index (alternative.me) - cached 1 hour
- NewsData.io (optional, 200 credits/day) - cached 30 min
- Reddit (r/cryptocurrency, r/bitcoin, r/ethereum) - cached 30 min

**Reddit Divergence Signals:**
| Signal | Interpretation | Action |
| --------- | ------------------------------------- | --------------------- |
| > +1.5 | Crowd fearful but price stable/rising | Contrarian LONG |
| < -1.5 | Crowd euphoric but price weak/falling | Contrarian SHORT |

## Quant Analysis

- **Statistical Metrics**: Z-score, percentile, volatility rank
- **Pattern Detection**: Support/resistance, trend strength
- **Correlation Risk**: Portfolio BTC correlation tracking
- **Funding Percentile**: 7-day ranking with persistence filter

| Z-Score | Signal            |
| ------- | ----------------- |
| < -2.0  | Long opportunity  |
| > +2.0  | Short opportunity |

## Regime Detection

| Regime       | Characteristics                | Strategy                  |
| ------------ | ------------------------------ | ------------------------- |
| **Trending** | ADX > 25, clear EMA structure  | Trend following           |
| **Ranging**  | ADX < 20, tangled EMAs         | Mean reversion            |
| **Volatile** | High ATR, expanding volatility | Reduced size, wider stops |
| **Quiet**    | Low volatility, low volume     | Wait for breakout         |

## Monte Carlo Validation

Fat-tailed simulation for trade validation:

- Student's t-distribution (df=3) for crypto fat tails
- GARCH(1,1) for volatility clustering
- Minimum Sharpe threshold: 1.2 for approval

## Correlation Risk Management

Prevents concentrated BTC exposure:

- Tracks pairwise correlations (30-day rolling)
- Apply 0.5x weight reduction when correlation > 0.7
- Cap aggregate directional exposure per symbol at 3x base capital
- Max 2 highly-correlated positions (>80% correlation)
- Warns if portfolio >85% correlated to BTC

## Dynamic Leverage

### Production Mode (5x–15x)

| Leverage | Position Size  | Stop Loss | Use Case                       |
| -------- | -------------- | --------- | ------------------------------ |
| 5-8x     | 20-30% account | 4-5%      | Conservative, larger positions |
| 8-12x    | 15-25% account | 3-4%      | Standard, medium positions     |
| 12-15x   | 10-20% account | 2.5-3%    | Moderate, smaller positions    |

### Competition Mode (15x–20x)

| Leverage | Position Size  | Stop Loss | Use Case                 |
| -------- | -------------- | --------- | ------------------------ |
| 15-16x   | 12-15% account | 2-2.5%    | Conservative             |
| 17-18x   | 10-14% account | 1.8-2%    | Moderate                 |
| 19-20x   | 10-12% account | 1.5%      | Optimal for competitions |

**Hard Limits:**

- Maximum leverage: 20x
- Maximum notional: 3x account balance per trade
- Stop loss inversely proportional to leverage

## Competition Mode

> ⚠️ **DEMO/PAPER TRADING ONLY** - Never use with real funds.

**Activation:**

```bash
COMPETITION_MODE=true
COMPETITION_MODE_ACK=I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS
WEEX_ACCOUNT_TYPE=demo
```

**Aggressive Settings:**
| Setting | Production | Competition |
| --------------------- | ---------- | ----------- |
| Max Daily Trades | 20 | 50 |
| Cooldown After Trade | 15 min | 5 min |
| Leverage Range | 5-15x | 15-20x |
| Max Position Size | 25% | 50% (hard cap, typical 10-15%) |
| Weekly Drawdown Limit | 10% | 25% |

## Cycle Flow

1. **Pre-checks**: Balance, positions, daily limits, weekly drawdown
2. **Pre-Stage-2 Optimization**: Skip analysis if limits reached or all positions profitable at max capacity
3. **Market Scan**: Fetch data for all coins
4. **Context Build**: Assemble context with indicators, sentiment, quant, regime
5. **Parallel Analysis**: 4 AI calls in parallel
6. **Judge Decision**: 1 AI call to pick winner
7. **Execution**: Place order if approved
8. **Logging**: Database + WEEX compliance
9. **Wait**: Sleep until next cycle (5 min default)

## Exit Plan Handling

Each trade includes an `exit_plan` specifying invalidation conditions:

- Stored in DB with each trade
- Passed to AI in context
- Analysts must NOT close unless exit plan is invalidated
- Hysteresis: Need 20% more confidence to close than to open

## Caching Strategy

| Service      | Cache TTL | Purpose                    |
| ------------ | --------- | -------------------------- |
| News         | 30 min    | Conserve API credits       |
| Fear & Greed | 1 hour    | Updates daily              |
| Reddit       | 30 min    | Rate limit protection      |
| Quant        | 5 min     | Aligned with trading cycle |
| **Prompt**   | Dynamic   | Provider Context Caching   |

## API Endpoints

### Engine Control

- `POST /api/autonomous/start` - Start engine
- `POST /api/autonomous/stop` - Stop engine
- `GET /api/autonomous/status` - Get status
- `GET /api/autonomous/events` - SSE stream

### Trading

- `GET /api/trading/trades` - List trades
- `GET /api/trading/leaderboard` - Analyst leaderboard

### Portfolio

- `GET /api/portfolio` - Portfolio summary
- `GET /api/positions` - Current positions

### WEEX Proxy

- `GET /api/weex/tickers` - Market tickers
- `GET /api/weex/positions` - WEEX positions
- `GET /api/weex/account` - Account info

### Debug

- `GET /api/autonomous/debug/sentiment` - Sentiment context
- `GET /api/autonomous/debug/regime/:symbol` - Market regime
- `POST /api/autonomous/debug/monte-carlo` - Run MC analysis

### Admin

- `POST /api/autonomous/admin/clear-caches` - Clear all caches
