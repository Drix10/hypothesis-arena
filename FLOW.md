# Hypothesis Arena - Collaborative AI Trading System

**STATUS: PRODUCTION READY ✅**  
**VERSION: 3.1.1**  
**LAST UPDATED: January 2, 2026**

## Implementation Status

- ✅ **Entry Mode:** Fully implemented and operational
- ✅ **Position Management (MANAGE Action):** Implemented - AI can close/manage existing positions
- ✅ **Production Ready:** TypeScript 0 errors, all edge cases handled
- ✅ **OPTIMIZED:** 40% token reduction (260k → 156k per cycle)
- 📋 **See:** `src/constants/prompts/managePrompts.ts` for position management prompts

## 🎯 Philosophy

**Every decision is a debate. Every debate has a winner. Winners trade OR manage.**

8 world-class AI analysts with unique methodologies collaborate on ONE shared portfolio.
Debates are the core decision mechanism - the winning thesis gets executed on WEEX Exchange.
**NEW:** Analysts can now choose to MANAGE existing positions instead of opening new ones.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   THE 6-STAGE DECISION PIPELINE                  │
│                   (OPTIMIZED - 40% Token Reduction)              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN          "What's happening?"             │
│      ↓                                                           │
│   STAGE 2: OPPORTUNITY SELECTION "Trade or Manage?"             │
│      ↓         ┌─────────────────────────────────┐              │
│                │  Can select MANAGE action       │              │
│                │  to close/adjust positions      │              │
│                └─────────────────────────────────┘              │
│      ↓                                                           │
│   [If MANAGE] → Close/Reduce Position → DONE                    │
│   [If LONG/SHORT] ↓                                             │
│   STAGE 3: CHAMPIONSHIP         "ALL 8 analysts compete"        │
│      ↓                                                           │
│   STAGE 4: RISK COUNCIL         "Final safety check"            │
│      ↓                                                           │
│   STAGE 5: EXECUTION            "Pull the trigger"              │
│      ↓                                                           │
│   STAGE 6: POSITION MANAGEMENT  "Monitor until exit"            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🤖 The 8 AI Analysts

| Analyst   | ID     | Methodology        | Focus                          |
| --------- | ------ | ------------------ | ------------------------------ |
| 🎩 Warren | warren | Value Investing    | Fundamentals, margin of safety |
| 🚀 Cathie | cathie | Growth Investing   | TAM expansion, disruption      |
| 📊 Jim    | jim    | Technical Analysis | RSI, MACD, chart patterns      |
| 🌍 Ray    | ray    | Macro Strategy     | Interest rates, correlations   |
| 📱 Elon   | elon   | Sentiment Analysis | Social sentiment, hype         |
| 🛡️ Karen  | karen  | Risk Management    | Volatility, drawdown, vetoes   |
| 🤖 Quant  | quant  | Quantitative       | Factor models, statistics      |
| 😈 Devil  | devil  | Contrarian         | Consensus challenges           |

---

## 📊 Stage 1: Market Scan

**Service:** `WeexClient.ts`  
**Duration:** ~5 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│  PARALLEL WEEX API CALLS (8 symbols):                           │
│                                                                  │
│  For each: BTC, ETH, SOL, DOGE, XRP, ADA, BNB, LTC             │
│  ├─ getTicker() → Current price, 24h high/low, volume          │
│  └─ getFundingRate() → Funding rate for futures                │
│                                                                  │
│  OUTPUT: Map<symbol, ExtendedMarketData>                        │
│  ├─ currentPrice, high24h, low24h                              │
│  ├─ volume24h, change24h                                       │
│  ├─ markPrice, indexPrice                                      │
│  ├─ bestBid, bestAsk                                           │
│  └─ fundingRate (undefined if unavailable)                     │
│                                                                  │
│  VALIDATION:                                                    │
│  ✓ Number.isFinite() guards on all numeric values              │
│  ✓ Fallback to currentPrice if high/low invalid                │
│  ✓ Warning logged if funding rate unavailable                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Stage 2: Opportunity Selection Debate

**Service:** `CollaborativeFlow.ts` → `runCoinSelectionDebate()`  
**Duration:** ~30 seconds  
**Participants:** Ray (Macro), Jim (Technical), Quant (Stats), Elon (Sentiment)

```
┌─────────────────────────────────────────────────────────────────┐
│  PORTFOLIO-AWARE OPPORTUNITY SELECTION                          │
│                                                                  │
│  NEW IN v3.0: Analysts see BOTH market data AND open positions │
│  They can choose to:                                            │
│  • LONG/SHORT: Open a new position on a coin                   │
│  • MANAGE: Close/reduce/adjust an existing position            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  POSITION DATA FETCHED (for MANAGE decisions):                  │
│                                                                  │
│  For each open position:                                        │
│  ├─ symbol, side (LONG/SHORT)                                  │
│  ├─ entryPrice, currentPrice (from live ticker)                │
│  ├─ unrealizedPnl, unrealizedPnlPercent                        │
│  ├─ holdTimeHours (from database trade history)                │
│  └─ fundingPaid (if available)                                 │
│                                                                  │
│  EDGE CASES HANDLED:                                            │
│  ✓ Current price fetched from WEEX ticker (not entry price)   │
│  ✓ Hold time calculated from actual trade entry in DB          │
│  ✓ Invalid entry prices skipped                                │
│  ✓ Future timestamps rejected                                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  4 ANALYSTS DEBATE (Turn-by-Turn)                               │
│                                                                  │
│  Each analyst receives:                                         │
│  ├─ Their full persona prompt                                  │
│  ├─ Market summary for all 8 coins                             │
│  ├─ Current portfolio positions with P&L                       │
│  └─ Task: "Rank TOP 3 opportunities (new trade OR manage)"     │
│                                                                  │
│  STRUCTURED OUTPUT (JSON Schema enforced):                      │
│  {                                                               │
│    "picks": [                                                   │
│      { "symbol": "cmt_solusdt", "action": "LONG",              │
│        "conviction": 9, "reason": "Breakout with volume" },    │
│      { "symbol": "cmt_ethusdt", "action": "MANAGE",            │
│        "conviction": 8, "reason": "+18% profit, lock gains" }, │
│      { "symbol": "cmt_btcusdt", "action": "SHORT",             │
│        "conviction": 6, "reason": "Bearish divergence" }       │
│    ]                                                            │
│  }                                                               │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  MANAGE ACTION DETECTION (Improved in v3.0):                    │
│                                                                  │
│  Specific patterns to avoid false positives:                    │
│  ├─ "close position", "close the LONG/SHORT position"          │
│  ├─ "reduce position", "exit position"                         │
│  ├─ "take profits on/from", "cut losses on/now"                │
│  ├─ "manage position", "close out"                             │
│  └─ action: "MANAGE" in JSON                                   │
│                                                                  │
│  NOT triggered by:                                              │
│  ✗ "close to resistance" (false positive avoided)              │
│  ✗ "take profits" without context                              │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  AGGREGATION LOGIC (aggregateCoinScores):                       │
│                                                                  │
│  Score = rank_weight × conviction                               │
│  • #1 pick = 3 × conviction                                    │
│  • #2 pick = 2 × conviction                                    │
│  • #3 pick = 1 × conviction                                    │
│                                                                  │
│  OUTPUT: { winner, coinSymbol, action, debate }                │
│  action: 'LONG' | 'SHORT' | 'MANAGE'                           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚪 MANAGE Action Flow (Position Management)

**Service:** `AutonomousTradingEngine.ts`  
**Prompts:** `src/constants/prompts/managePrompts.ts`  
**Duration:** ~5 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│  WHEN MANAGE ACTION IS SELECTED                                  │
│                                                                  │
│  1. POSITION LOOKUP (Case-insensitive + Partial Match)          │
│     ├─ Exact match: "cmt_btcusdt" === "cmt_btcusdt"            │
│     ├─ Partial match: "btcusdt" matches "cmt_btcusdt"          │
│     └─ Logs available positions if not found                   │
│                                                                  │
│  2. VALIDATION                                                   │
│     ├─ Position size must be > 0 and finite                    │
│     ├─ Entry price must be valid                               │
│     └─ Current price must be valid                             │
│                                                                  │
│  3. EXECUTION (Currently: CLOSE_FULL)                           │
│     ├─ Call weexClient.closeAllPositions(symbol)               │
│     ├─ Log success/failure                                     │
│     └─ Increment tradesExecuted counter                        │
│                                                                  │
│  4. DATABASE LOGGING (Only if close successful)                 │
│     INSERT INTO trades:                                         │
│     ├─ id: UUID                                                │
│     ├─ portfolio_id: from analyst state                        │
│     ├─ symbol: position symbol                                 │
│     ├─ side: 'SELL' (for LONG) or 'BUY' (for SHORT)           │
│     ├─ type: 'MARKET'                                          │
│     ├─ size: position size                                     │
│     ├─ price: current price                                    │
│     ├─ status: 'FILLED'                                        │
│     ├─ reason: 'MANAGE: Position closed by AI'                 │
│     └─ realized_pnl: unrealized P&L at close                   │
│                                                                  │
│  5. CYCLE COMPLETION                                            │
│     ├─ Update leaderboard                                      │
│     ├─ Complete cycle with "managed {symbol}"                  │
│     └─ Sleep before next cycle                                 │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  POSITION HEALTH ASSESSMENT (managePrompts.ts)                   │
│                                                                  │
│  assessPositionHealth() evaluates:                              │
│  ├─ pnlStatus: PROFIT | LOSS | BREAKEVEN                       │
│  ├─ pnlSeverity: CRITICAL (<-7%) | WARNING | HEALTHY           │
│  ├─ holdTimeStatus: FRESH (<1d) | MATURE | STALE (>5d)         │
│  ├─ fundingImpact: FAVORABLE | NEUTRAL | ADVERSE               │
│  └─ thesisStatus: VALID | WEAKENING | INVALIDATED              │
│                                                                  │
│  MANAGE TRADING RULES (Mandatory):                              │
│  🚨 P&L < -7%: MUST close immediately                          │
│  🚨 Thesis INVALIDATED: MUST close                             │
│  💰 P&L > +15%: Take at least 50% profits                      │
│  💰 P&L > +20%: Take at least 75% profits                      │
│  ⏰ Hold > 7 days: Close unless new catalyst                   │
│  💸 Funding > 0.05% against: Reduce hold time                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🏆 Stage 3: Championship Debate (ALL 8 Analysts)

**Service:** `CollaborativeFlow.ts` → `runChampionshipDebate()`  
**Duration:** ~60 seconds  
**Participants:** ALL 8 analysts compete

```
┌─────────────────────────────────────────────────────────────────┐
│  CHAMPIONSHIP DEBATE (OPTIMIZED - Replaces old Stages 3-4)      │
│                                                                  │
│  ALL 8 analysts compete in a single championship debate.        │
│  Each analyst uses their own methodology to analyze the coin.   │
│  Winner's thesis gets executed as a real trade.                 │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  8 ANALYSTS DEBATE (Turn-by-Turn)                               │
│                                                                  │
│  Each analyst receives:                                         │
│  ├─ Their full persona prompt with focus areas                 │
│  ├─ Detailed market data for selected coin                     │
│  ├─ Direction hint from Stage 2 (LONG/SHORT)                   │
│  ├─ Coin selector winner context                               │
│  └─ Judging criteria (data, logic, risk, catalyst)             │
│                                                                  │
│  STRUCTURED OUTPUT (AnalysisResult):                            │
│  {                                                               │
│    "recommendation": "STRONG_BUY",                              │
│    "confidence": 85,                                            │
│    "entry": 185.50,                                             │
│    "targets": { "bull": 220, "base": 200, "bear": 170 },       │
│    "stopLoss": 175,                                             │
│    "leverage": 4,                                               │
│    "positionSize": 8,                                           │
│    "thesis": "SOL showing strongest L1 growth metrics...",     │
│    "bullCase": ["TVL up 40%", "Dev activity high", ...],       │
│    "bearCase": ["Network congestion risk", ...],               │
│    "catalyst": "Jupiter airdrop driving activity",             │
│    "timeframe": "2-5 days"                                     │
│  }                                                               │
│                                                                  │
│  SCORING (Per Turn):                                            │
│  ├─ DATA (25%): Specific numbers vs vague claims               │
│  ├─ LOGIC (25%): Reasoning follows from data                   │
│  ├─ RISK (25%): Acknowledges what could go wrong               │
│  └─ CATALYST (25%): Clear price driver with timeline           │
│                                                                  │
│  CHAMPION SELECTION:                                            │
│  → Highest total score across all turns wins                   │
│  → Winner's thesis becomes the trade plan                      │
│                                                                  │
│  VALIDATION:                                                    │
│  ✓ Number.isFinite() guards on price targets                   │
│  ✓ Division by zero guards in range calculations               │
│  ✓ 60-second timeout with cleanup                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Stage 4: Risk Council

**Service:** `CollaborativeFlow.ts` → `runRiskCouncil()`  
**Service:** `CircuitBreakerService.ts` → `checkCircuitBreakers()`  
**Duration:** ~15 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│  CIRCUIT BREAKER CHECK (Before Risk Council)                    │
│                                                                  │
│  🟢 GREEN: Normal trading                                       │
│  🟡 YELLOW: BTC -10% in 4h OR Portfolio -10% in 24h            │
│     → Max leverage 3x, no new positions                        │
│  🟠 ORANGE: BTC -15% in 4h OR Portfolio -15% in 24h            │
│     → Max leverage 2x, close small positions                   │
│  🔴 RED: BTC -20% in 4h OR Portfolio -25% in 24h               │
│     → EMERGENCY: Close ALL positions immediately               │
│                                                                  │
│  VALIDATION:                                                    │
│  ✓ Array.isArray() check before accessing candles              │
│  ✓ Validates sorted candles array is not empty                 │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  KAREN'S RISK COUNCIL REVIEW                                    │
│                                                                  │
│  INPUT:                                                         │
│  ├─ Champion's winning thesis                                  │
│  ├─ Current market data                                        │
│  ├─ Account balance (from WEEX wallet - source of truth)       │
│  ├─ Current positions (from WEEX)                              │
│  └─ Recent P&L (24h and 7d)                                    │
│                                                                  │
│  KAREN'S CHECKLIST:                                             │
│  [ ] Position size ≤30% of account?                            │
│  [ ] Stop loss ≤10% from entry?                                │
│  [ ] Leverage ≤5x?                                             │
│  [ ] Not correlated with existing positions?                   │
│  [ ] Funding rate ≤0.1% against us? (warn at 0.05%)            │
│  [ ] 7d drawdown acceptable?                                   │
│                                                                  │
│  VETO TRIGGERS (MUST veto if ANY true):                        │
│  ✗ Stop loss >10% from entry                                   │
│  ✗ Position would exceed 30% of account                        │
│  ✗ Already have 3+ positions open                              │
│  ✗ 7d drawdown >10%                                            │
│  ✗ Funding rate >0.1% against position (warn at >0.05%)        │
│                                                                  │
│  STRUCTURED OUTPUT (RISK_COUNCIL_SCHEMA):                       │
│  {                                                               │
│    "approved": true,                                            │
│    "adjustments": {                                             │
│      "positionSize": 7,  // Reduced from 8                     │
│      "leverage": 4,      // Reduced from 5                     │
│      "stopLoss": 178     // Tightened                          │
│    },                                                           │
│    "warnings": ["SOL volatility elevated"],                    │
│    "vetoReason": null                                          │
│  }                                                               │
│                                                                  │
│  VALIDATION:                                                    │
│  ✓ Division by zero guards in risk calculations                │
│  ✓ Default to conservative veto on error                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚀 Stage 5: Execution

**Service:** `AutonomousTradingEngine.ts` → `executeCollaborativeTrade()`  
**Service:** `WeexClient.ts` → `placeOrder()`  
**Service:** `AILogService.ts` → `createLog()`  
**Duration:** ~5 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│  TRADE PARAMETER CALCULATION                                    │
│                                                                  │
│  From champion thesis + risk adjustments:                       │
│  ├─ Direction: LONG or SHORT (from recommendation)             │
│  ├─ Leverage: min(5, adjusted_leverage)                        │
│  ├─ Position %: (positionSize/10) × MAX_POSITION_SIZE_PERCENT  │
│  ├─ Position Value: accountBalance × (positionPercent/100)     │
│  ├─ Margin Required: positionValue / leverage                  │
│  └─ Size: positionValue / currentPrice                         │
│                                                                  │
│  VALIDATION:                                                    │
│  ✓ Guard for division by zero (leverage, price)                │
│  ✓ Number.isFinite() check on marginRequired                   │
│  ✓ Validates size is positive and finite                       │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  WEEX ORDER PLACEMENT                                           │
│                                                                  │
│  Order Parameters:                                              │
│  {                                                               │
│    symbol: "cmt_solusdt",                                       │
│    type: "1" (LONG) or "2" (SHORT),                            │
│    size: "0.38000000",                                          │
│    client_oid: "collab_cathie_1735142400000",                  │
│    order_type: "2" (FOK - Fill or Kill),                       │
│    match_price: "1" (Market price)                             │
│  }                                                               │
│                                                                  │
│  DRY RUN MODE:                                                  │
│  If config.autonomous.dryRun = true:                           │
│  → Log trade details but don't execute                         │
│  → Useful for testing without real money                       │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  POST-EXECUTION                                                  │
│                                                                  │
│  1. Save trade to database with:                               │
│     ├─ Champion attribution (who won the debate)               │
│     ├─ Coin selector attribution (who picked the coin)         │
│     └─ Risk adjuster attribution (Karen's modifications)       │
│                                                                  │
│  2. Upload AI decision log to WEEX (compliance)                │
│     ├─ Full decision chain                                     │
│     ├─ All analyst inputs                                      │
│     └─ Risk council decision                                   │
│                                                                  │
│  3. Update analyst state                                       │
│     ├─ Deduct margin from balance                              │
│     ├─ Add position to positions array                         │
│     └─ Update lastTradeTime                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Stage 6: Position Management

**Service:** `AutonomousTradingEngine.ts` → `updateLeaderboard()`  
**Continuous:** Every cycle

```
┌─────────────────────────────────────────────────────────────────┐
│  POSITION MONITORING (Every Cycle)                              │
│                                                                  │
│  For each analyst:                                              │
│  1. Fetch current positions from WEEX                          │
│  2. Calculate unrealized P&L                                   │
│  3. Update total value (balance + position value)              │
│  4. Update return percentage                                   │
│                                                                  │
│  LEADERBOARD UPDATE:                                            │
│  ├─ Sort analysts by total value                               │
│  ├─ Assign ranks 1-8                                           │
│  ├─ Calculate win rates                                        │
│  └─ Persist to database                                        │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  EMERGENCY CLOSE (Circuit Breaker RED)                          │
│                                                                  │
│  emergencyCloseAllPositions():                                  │
│  1. Collect all position symbols first (avoid mutation)        │
│  2. Close each position sequentially                           │
│  3. Clear positions array after all closed                     │
│                                                                  │
│  FIX APPLIED:                                                   │
│  ✓ No longer modifies array while iterating                    │
│  ✓ Collects symbols first, then closes                         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  CLEANUP (On Engine Stop)                                       │
│                                                                  │
│  cleanup():                                                     │
│  1. Clear sleep timeout                                        │
│  2. Clear trading locks                                        │
│  3. Wait for main loop to exit (with timeout)                  │
│                                                                  │
│  FIX APPLIED:                                                   │
│  ✓ Timeout in Promise.race now properly cleaned up             │
│  ✓ No orphaned timeout handles (memory leak fixed)             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ⏱️ Timing & Performance

```
┌─────────────────────────────────────────────────────────────────┐
│  CYCLE TIMING BREAKDOWN                                          │
│                                                                  │
│  Stage 1: Market Scan ................ ~5 seconds              │
│           (8 parallel WEEX API calls)                           │
│  Stage 2: Coin Selection ............. ~30 seconds             │
│           (4 parallel AI calls)                                │
│  Stage 3: Championship ............... ~60 seconds             │
│           (8 analysts, turn-by-turn)                           │
│  Stage 4: Risk Council ............... ~15 seconds             │
│           (1 AI call - Karen)                                  │
│  Stage 5: Execution .................. ~5 seconds              │
│           (WEEX API + DB + compliance)                          │
│  Stage 6: Position Management ........ Continuous              │
│           (Monitor and adjust)                                  │
│  ─────────────────────────────────────────────────             │
│  TOTAL CYCLE TIME: ~2 minutes                                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  GEMINI API USAGE PER CYCLE                                      │
│                                                                  │
│  Stage 2: 4 calls (Ray, Jim, Quant, Elon)                      │
│  Stage 3: 8+ calls (All analysts, turn-by-turn)                │
│  Stage 4: 1 call (Karen)                                       │
│  ─────────────────────────────────────────────────             │
│  TOTAL: 13+ AI API calls per cycle                             │
│                                                                  │
│  At 5-minute cycles: ~150 calls/hour                           │
│  Supports: Gemini, OpenRouter, DeepSeek                        │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  DYNAMIC CYCLE INTERVALS (TradingScheduler)                      │
│                                                                  │
│  Peak Hours (1.6x activity):                                    │
│  • US-Europe overlap: 13:00-17:00 UTC                          │
│  • Asia open: 00:00-04:00 UTC                                  │
│  → Cycle every 3 minutes                                       │
│                                                                  │
│  Normal Hours (1.0x activity):                                  │
│  → Cycle every 5 minutes (default)                             │
│                                                                  │
│  Off-Peak Hours (0.5x activity):                                │
│  • Weekend nights, low volume                                   │
│  → Cycle every 10 minutes                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🚨 Hard Rules (Non-Negotiable)

```
┌─────────────────────────────────────────────────────────────────┐
│  CIRCUIT BREAKERS (CircuitBreakerService)                        │
│                                                                  │
│  🟡 YELLOW ALERT                                                │
│     Trigger: BTC -10% in 4h OR Portfolio -10% in 24h           │
│     Action: Max leverage 3x, no new positions                  │
│                                                                  │
│  🟠 ORANGE ALERT                                                │
│     Trigger: BTC -15% in 4h OR Portfolio -15% in 24h           │
│     Action: Max leverage 2x, close positions <5 size           │
│                                                                  │
│  🔴 RED ALERT                                                   │
│     Trigger: BTC -20% in 4h OR Portfolio -25% in 24h           │
│     Action: CLOSE ALL POSITIONS IMMEDIATELY                    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  POSITION LIMITS (config.autonomous)                             │
│                                                                  │
│  • Max position size: 30% of portfolio                         │
│  • Max leverage: 5x (NEVER exceed)                             │
│  • Max concurrent positions: 3                                 │
│  • Min time between trades: 15 minutes                         │
│  • Min balance to trade: $10                                   │
│  • Min confidence to trade: 60%                                │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  STOP LOSS REQUIREMENTS                                          │
│                                                                  │
│  • Every position MUST have a stop loss                        │
│  • Max stop loss distance: 10% from entry                      │
│  • Stop loss cannot be moved further away                      │
│  • Stop loss CAN be tightened (trailing)                       │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  FUNDING RATE LIMITS (Basis Points Convention)                   │
│                                                                  │
│  • Stored as decimal: 0.0005 = 0.05% = 5 basis points (bps)   │
│  • Configured via MAX_FUNDING_AGAINST_BPS in .env (default: 5) │
│  • If funding >0.05% (5 bps) against position: Karen warns     │
│  • If funding >0.1% (10 bps) against position: Karen vetoes    │
│  • Track cumulative funding cost per position                  │
│  • 0 = no limit (not recommended for production)               │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🖥️ Frontend Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LIVE ARENA DASHBOARD (index.html + app.js)                     │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  HEADER                                                  │   │
│  │  ├─ Engine status indicator (running/stopped)           │   │
│  │  └─ Account balance display                             │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ENGINE CONTROLS                                         │   │
│  │  ├─ Start/Stop buttons                                  │   │
│  │  ├─ Current cycle number                                │   │
│  │  ├─ Next cycle countdown                                │   │
│  │  └─ Total trades counter                                │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  MAIN CONTENT SECTIONS                                   │   │
│  │                                                          │   │
│  │  📊 PORTFOLIO OVERVIEW                                   │   │
│  │  ├─ Current balance                                     │   │
│  │  ├─ Total P&L                                           │   │
│  │  └─ Win rate                                            │   │
│  │                                                          │   │
│  │  📈 OPEN POSITIONS                                       │   │
│  │  ├─ Symbol, side, size                                  │   │
│  │  ├─ Entry price, current price                          │   │
│  │  └─ Unrealized P&L                                      │   │
│  │                                                          │   │
│  │  ⚡ RECENT TRADES                                        │   │
│  │  ├─ Trade history (last 20)                             │   │
│  │  └─ Trade details with P&L                              │   │
│  │                                                          │   │
│  │  🎯 MARKET DATA                                          │   │
│  │  └─ Live prices for 8 coins                             │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  AUTO-REFRESH: Every 10 seconds (polling)                       │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📡 Real-Time Communication

```
┌─────────────────────────────────────────────────────────────────┐
│  POLLING-BASED UPDATES (Replaced SSE in v3.0.1)                 │
│                                                                  │
│  Frontend polls every 10 seconds:                               │
│  ├─ GET /api/status → Engine status                            │
│  ├─ GET /api/positions → Current positions                     │
│  ├─ GET /api/portfolio → Portfolio data                        │
│  └─ GET /api/activity → Recent trades                          │
│                                                                  │
│  Benefits:                                                      │
│  ✓ Simpler architecture (no WebSocket/SSE complexity)          │
│  ✓ Better compatibility with proxies/load balancers            │
│  ✓ Easier to debug and maintain                                │
│  ✓ Sufficient for 5-minute trading cycles                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔧 Services Map

```
┌─────────────────────────────────────────────────────────────────┐
│  CORE PIPELINE SERVICES                                          │
│                                                                  │
│  AutonomousTradingEngine (Orchestrator)                         │
│  ├── CollaborativeFlowService                                   │
│  │   ├── AIService (AI generation)                             │
│  │   ├── ArenaContextBuilder (context building)                │
│  │   └── ANALYST_PROFILES (constants)                          │
│  ├── WeexClient (exchange API)                                  │
│  ├── CircuitBreakerService (risk management)                   │
│  ├── TradingScheduler (timing optimization)                    │
│  └── AILogService (compliance logging)                         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  SUPPORTING SERVICES                                             │
│                                                                  │
│  Database → SQLite (local) or Turso (production)                │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🧭 Stage-to-Service Ownership

- Stage 1 — Market Scan: `WeexClient.getTicker`, `getFundingRate` (owner: Exchange data)
- Stage 2 — Coin Selection: `CollaborativeFlow.runCoinSelection` (owners: Ray, Jim, Quant, Elon)
- Stage 3 — Championship: `CollaborativeFlow.runChampionshipDebate` (all 8 analysts compete; turn-by-turn)
- Stage 4 — Risk Council: `CollaborativeFlow.runRiskCouncil` + `CircuitBreakerService.checkAll` (owner: Karen; respects `GLOBAL_RISK_LIMITS`)
- Stage 5 — Execution: `AutonomousTradingEngine.executeCollaborativeTrade` + `WeexClient.placeOrder` + compliance logging via `AILogService.createLog`/`weexClient.uploadAILog`
- Stage 6 — Position Management: `AutonomousTradingEngine.updateLeaderboard` (continuous monitoring)

---

## 📋 Structured Output Schemas

All AI outputs use structured JSON Schema enforcement for reliable, validated responses:

```
┌─────────────────────────────────────────────────────────────────┐
│  SCHEMA                        │ USED BY                        │
├────────────────────────────────┼────────────────────────────────┤
│  COIN_SELECTION_SCHEMA         │ Stage 2: runCoinSelection()   │
│  ├─ picks[]: symbol, direction, conviction, reason             │
│                                                                  │
│  DEBATE_TURN_SCHEMA            │ Stage 3: Championship debates │
│  ├─ argument, dataPointsReferenced[], strength                 │
│                                                                  │
│  SPECIALIST_ANALYSIS_SCHEMA    │ Stage 3: Champion's thesis    │
│  ├─ recommendation, confidence, targets, thesis                │
│  ├─ bullCase[], bearCase[], keyMetrics, catalyst               │
│                                                                  │
│  RISK_COUNCIL_SCHEMA           │ Stage 4: runRiskCouncil()     │
│  ├─ approved, adjustments{}, warnings[], vetoReason            │
│                                                                  │
│  ANALYSIS_RESPONSE_SCHEMA      │ AIService.generateAnalysis    │
│  ├─ recommendation, confidence, priceTarget, positionSize      │
│  ├─ bullCase[], bearCase[], catalysts[], summary               │
│                                                                  │
│  DEBATE_RESPONSE_SCHEMA        │ AIService.generateDebate      │
│  ├─ turns[], winner, scores{}, winningArguments[], summary     │
│                                                                  │
│  TRADING_DECISION_SCHEMA       │ AIService.tradingDecision     │
│  ├─ shouldTrade, action, confidence, riskAssessment            │
│  ├─ positionSizePercent, leverage, stopLoss, takeProfit        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘

Benefits of Structured Outputs:
✓ Guaranteed valid JSON (no parsing errors)
✓ Type-safe responses matching schema
✓ Enum validation (LONG/SHORT, BUY/SELL, etc.)
✓ Required field enforcement
✓ Consistent output format across all AI calls
```

---

## 📊 Summary

```
┌─────────────────────────────────────────────────────────────────┐
│                    HYPOTHESIS ARENA FLOW                         │
│                                                                  │
│  "8 AI analysts, 1 shared portfolio, debates decide trades"    │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  EVERY CYCLE (~5 minutes):                                      │
│                                                                  │
│  1. SCAN    → Fetch market data for 8 coins (WeexClient)       │
│  2. SELECT  → Ray, Jim, Quant, Elon pick best opportunity      │
│              NEW: Can select MANAGE to close positions         │
│     [If MANAGE] → Close position → Update DB → DONE            │
│     [If LONG/SHORT] ↓                                          │
│  3. CHAMPIONSHIP → ALL 8 analysts compete for execution        │
│  4. RISK    → Karen approves/vetoes/adjusts                    │
│  5. EXECUTE → Place trade on WEEX with compliance log          │
│  6. MANAGE  → Update leaderboard, monitor positions            │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  KEY PRINCIPLES:                                                │
│                                                                  │
│  ✓ Every analyst uses their FULL unique prompt                 │
│  ✓ Debates are the core decision mechanism                     │
│  ✓ Winner's thesis gets executed                               │
│  ✓ Karen has veto power for safety                             │
│  ✓ Circuit breakers protect against crashes                    │
│  ✓ One portfolio, collaborative decisions                      │
│  ✓ All AI decisions logged for WEEX compliance                 │
│  ✓ NEW: AI can manage existing positions (close/reduce)        │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  EDGE CASES HANDLED (v3.0.1):                                   │
│                                                                  │
│  ✓ Number.isFinite() guards on all calculations                │
│  ✓ Division by zero protection                                 │
│  ✓ Empty array handling                                        │
│  ✓ Timeout cleanup (no memory leaks)                           │
│  ✓ Array mutation during iteration fixed                       │
│  ✓ Null/undefined checks on all inputs                         │
│  ✓ Current price from ticker (not entry price)                 │
│  ✓ Hold time from DB (not hardcoded)                           │
│  ✓ Position size validation before close                       │
│  ✓ DB insert only after successful close                       │
│  ✓ Case-insensitive position symbol matching                   │
│  ✓ MANAGE pattern detection avoids false positives             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```
