# Hypothesis Arena - Collaborative AI Trading System

**STATUS: IMPLEMENTED** ✅  
**VERSION: 2.2.0**  
**LAST UPDATED: December 25, 2025**

## 🎯 Philosophy

**Every decision is a debate. Every debate has a winner. Winners trade.**

8 world-class AI analysts with unique methodologies collaborate on ONE shared portfolio.
Debates are the core decision mechanism - the winning thesis gets executed on WEEX Exchange.

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                   THE 7-STAGE DECISION PIPELINE                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   STAGE 1: MARKET SCAN          "What's happening?"             │
│      ↓                                                           │
│   STAGE 2: COIN SELECTION       "Where's the opportunity?"      │
│      ↓                                                           │
│   STAGE 3: SPECIALIST ANALYSIS  "Deep dive by experts"          │
│      ↓                                                           │
│   STAGE 4: TOURNAMENT           "Best thesis wins"              │
│      ↓                                                           │
│   STAGE 5: RISK COUNCIL         "Final safety check"            │
│      ↓                                                           │
│   STAGE 6: EXECUTION            "Pull the trigger"              │
│      ↓                                                           │
│   STAGE 7: POSITION MANAGEMENT  "Monitor until exit"            │
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

## 🎯 Stage 2: Coin Selection Debate

**Service:** `CollaborativeFlow.ts` → `runCoinSelection()`  
**Duration:** ~30 seconds  
**Participants:** Ray (Macro), Jim (Technical), Quant (Stats)

```
┌─────────────────────────────────────────────────────────────────┐
│  3 PARALLEL GEMINI API CALLS                                    │
│                                                                  │
│  Each analyst receives:                                         │
│  ├─ Their full persona prompt                                  │
│  ├─ Market summary for all 8 coins                             │
│  └─ Task: "Rank your TOP 3 trading opportunities"              │
│                                                                  │
│  STRUCTURED OUTPUT (JSON Schema enforced):                      │
│  {                                                               │
│    "picks": [                                                   │
│      { "symbol": "cmt_solusdt", "direction": "LONG",           │
│        "conviction": 9, "reason": "Breakout with volume" },    │
│      { "symbol": "cmt_btcusdt", "direction": "LONG",           │
│        "conviction": 7, "reason": "Holding 95k support" },     │
│      { "symbol": "cmt_ethusdt", "direction": "SHORT",          │
│        "conviction": 6, "reason": "Bearish divergence" }       │
│    ]                                                            │
│  }                                                               │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  AGGREGATION LOGIC (aggregateCoinScores):                       │
│                                                                  │
│  Score = rank_weight × conviction                               │
│  • #1 pick = 3 × conviction                                    │
│  • #2 pick = 2 × conviction                                    │
│  • #3 pick = 1 × conviction                                    │
│                                                                  │
│  Example:                                                       │
│  SOL: Ray #1 (9×3=27) + Jim #2 (8×2=16) + Quant #1 (9×3=27)   │
│       = 70 points → WINNER                                      │
│                                                                  │
│  EDGE CASE HANDLING:                                            │
│  ✓ Returns default {totalScore: 0} if no valid results         │
│  ✓ Validates picks is an array before processing               │
│  ✓ Clamps conviction to 1-10 range                             │
│  ✓ 60-second timeout with cleanup                              │
│                                                                  │
│  OUTPUT: { topCoin: AggregatedCoinScore, results: [] }         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔬 Stage 3: Specialist Deep Analysis

**Service:** `CollaborativeFlow.ts` → `runSpecialistAnalysis()`  
**Duration:** ~60 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│  SPECIALIST ASSIGNMENT (COIN_TYPE_MAP):                         │
│                                                                  │
│  ┌─ COIN TYPE → SPECIALISTS ─────────────────────────────────┐ │
│  │                                                            │ │
│  │  BTC/ETH (Blue chips):                                     │ │
│  │  → Warren (Value) + Ray (Macro) + Karen (Risk)            │ │
│  │                                                            │ │
│  │  SOL/ADA (L1 Growth):                                      │ │
│  │  → Cathie (Growth) + Quant (Stats) + Jim (Technical)      │ │
│  │                                                            │ │
│  │  DOGE/XRP (Momentum/Meme):                                 │ │
│  │  → Elon (Sentiment) + Devil (Contrarian) + Jim (Technical)│ │
│  │                                                            │ │
│  │  BNB/LTC (Utility):                                        │ │
│  │  → Warren (Value) + Quant (Stats) + Karen (Risk)          │ │
│  │                                                            │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  3 PARALLEL GEMINI API CALLS                                    │
│                                                                  │
│  Each specialist receives:                                      │
│  ├─ Their full persona prompt with focus areas                 │
│  ├─ Detailed market data for selected coin                     │
│  ├─ Direction hint from Stage 2 (LONG/SHORT)                   │
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
│  VALIDATION:                                                    │
│  ✓ Number.isFinite() guards on price targets                   │
│  ✓ Division by zero guards in range calculations               │
│  ✓ 60-second timeout with cleanup                              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## ⚔️ Stage 4: Championship Tournament

**Service:** `CollaborativeFlow.ts` → `runTournament()`  
**Duration:** ~45 seconds

```
┌─────────────────────────────────────────────────────────────────┐
│  TOURNAMENT BRACKET (Dynamic based on specialist count)         │
│                                                                  │
│  1 specialist  → Auto-champion (no debate)                      │
│  2 specialists → Single final match                             │
│  3 specialists → Semifinal (#1 vs #3) + Final (winner vs #2)   │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  DEBATE MATCH (runDebateMatch):                                 │
│                                                                  │
│  PROMPT TO GEMINI (as hedge fund CIO):                          │
│  "Judge this debate about {SYMBOL}/USDT.                        │
│                                                                  │
│   ANALYST A: {Full thesis from specialist A}                    │
│   ANALYST B: {Full thesis from specialist B}                    │
│                                                                  │
│   Score each on:                                                │
│   - DATA (25%): Specific numbers vs vague claims               │
│   - LOGIC (25%): Reasoning follows from data                   │
│   - RISK (25%): Acknowledges what could go wrong               │
│   - CATALYST (25%): Clear price driver with timeline"          │
│                                                                  │
│  STRUCTURED OUTPUT (TOURNAMENT_JUDGE_SCHEMA):                   │
│  {                                                               │
│    "winner": "cathie",                                          │
│    "scores": {                                                  │
│      "cathie": { "data": 22, "logic": 20, "risk": 18,          │
│                  "catalyst": 22, "total": 82 },                │
│      "quant":  { "data": 20, "logic": 18, "risk": 20,          │
│                  "catalyst": 17, "total": 75 }                 │
│    },                                                           │
│    "reasoning": "Clearer catalyst with Jupiter airdrop...",    │
│    "keyDifferentiator": "Specific TVL metrics"                 │
│  }                                                               │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  EXAMPLE BRACKET (3 specialists):                               │
│                                                                  │
│  SEMIFINAL: Cathie (85%) vs Jim (72%)                          │
│  → Winner: Cathie (82 vs 75)                                   │
│                                                                  │
│  FINAL: Cathie vs Quant (78%)                                  │
│  → 🏆 CHAMPION: Cathie                                          │
│  → Winning Thesis: LONG SOL @ 185.50, TP 200, SL 175           │
│                                                                  │
│  EDGE CASE HANDLING:                                            │
│  ✓ Sorts specialists by confidence before bracket              │
│  ✓ Falls back to highest confidence if debate fails            │
│  ✓ Improved error logging shows actual error message           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🛡️ Stage 5: Risk Council

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

## 🚀 Stage 6: Execution

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
│  3. Emit SSE event to frontend                                 │
│     → "tradeExecuted" event with trade details                 │
│                                                                  │
│  4. Update analyst state                                       │
│     ├─ Deduct margin from balance                              │
│     ├─ Add position to positions array                         │
│     └─ Update lastTradeTime                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Stage 7: Position Management

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
│           (3 parallel Gemini calls)                             │
│  Stage 3: Specialist Analysis ........ ~60 seconds             │
│           (3 parallel Gemini calls)                             │
│  Stage 4: Tournament ................. ~45 seconds             │
│           (1-2 sequential debates)                              │
│  Stage 5: Risk Council ............... ~15 seconds             │
│           (1 Gemini call)                                       │
│  Stage 6: Execution .................. ~5 seconds              │
│           (WEEX API + DB + compliance)                          │
│  ─────────────────────────────────────────────────             │
│  TOTAL CYCLE TIME: ~2.5 minutes                                │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  GEMINI API USAGE PER CYCLE                                      │
│                                                                  │
│  Stage 2: 3 calls (Ray, Jim, Quant)                            │
│  Stage 3: 3 calls (Specialists)                                │
│  Stage 4: 1-2 calls (Debates)                                  │
│  Stage 5: 1 call (Karen)                                       │
│  ─────────────────────────────────────────────────             │
│  TOTAL: 8-9 Gemini API calls per cycle                         │
│                                                                  │
│  At 5-minute cycles: ~100 calls/hour                           │
│  Model: gemini-2.5-flash                                       │
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
│  FUNDING RATE LIMITS                                             │
│                                                                  │
│  • If funding >0.05% against position: Karen warns             │
│  • If funding >0.1% against position: Karen vetoes             │
│  • Track cumulative funding cost per position                  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🖥️ Frontend Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  LIVE ARENA DASHBOARD (LiveArena.tsx)                           │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  HEADER                                                  │   │
│  │  ├─ WebSocket connection status (green/red indicator)   │   │
│  │  ├─ Auth status (Login/Logout button)                   │   │
│  │  └─ Account assets display                              │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  ENGINE STATUS BANNER (EngineStatusBanner.tsx)          │   │
│  │  ├─ Running/Stopped status with pulse indicator         │   │
│  │  ├─ Current cycle number                                │   │
│  │  ├─ Next cycle countdown                                │   │
│  │  ├─ Total trades today                                  │   │
│  │  ├─ Progress bar                                        │   │
│  │  └─ Start/Stop buttons                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  TAB NAVIGATION                                          │   │
│  │  🏆 Tournament | 📊 Leaderboard | ⚡ Trades | ⚔️ Debates │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  TAB CONTENT                                             │   │
│  │                                                          │   │
│  │  TOURNAMENT TAB:                                         │   │
│  │  ├─ AnalystGrid (8 analyst cards)                       │   │
│  │  └─ LiveTradeFeed (recent 5 trades)                     │   │
│  │                                                          │   │
│  │  LEADERBOARD TAB:                                        │   │
│  │  └─ Leaderboard (ranked analyst table)                  │   │
│  │                                                          │   │
│  │  TRADES TAB:                                             │   │
│  │  └─ LiveTradeFeed (all trades, max 50)                  │   │
│  │                                                          │   │
│  │  DEBATES TAB:                                            │   │
│  │  └─ Debate results (JSON display)                       │   │
│  │                                                          │   │
│  │  MANUAL TAB (auth required):                            │   │
│  │  └─ Manual trade form (symbol, side, size)              │   │
│  │                                                          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📡 Real-Time Communication

```
┌─────────────────────────────────────────────────────────────────┐
│  SERVER-SENT EVENTS (SSE)                                        │
│                                                                  │
│  Endpoint: GET /api/autonomous/events                           │
│                                                                  │
│  EVENT TYPES:                                                   │
│  ├─ "status" → Engine status update                            │
│  ├─ "cycleStart" → New cycle beginning                         │
│  ├─ "cycleComplete" → Cycle finished with stats                │
│  ├─ "coinSelected" → Stage 2 result                            │
│  ├─ "specialistAnalysis" → Stage 3 result                      │
│  ├─ "tournamentComplete" → Stage 4 result                      │
│  ├─ "riskCouncilDecision" → Stage 5 result                     │
│  ├─ "tradeExecuted" → Stage 6 result                           │
│  └─ "debatesComplete" → Tournament results                     │
│                                                                  │
│  FRONTEND HANDLING (autonomousApi.connectToEvents):             │
│  ├─ Auto-reconnect on disconnect                               │
│  ├─ Manual reconnect button on error                           │
│  └─ Events stored in liveEvents array (max 100)                │
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
│  │   ├── GeminiService (AI generation)                         │
│  │   ├── ArenaContextBuilder (context building)                │
│  │   └── ANALYST_PROFILES (constants)                          │
│  ├── WeexClient (exchange API)                                  │
│  ├── CircuitBreakerService (risk management)                   │
│  ├── TradingScheduler (timing optimization)                    │
│  ├── AILogService (compliance logging)                         │
│  └── WebSocketManager (SSE broadcasting)                       │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  SUPPORTING SERVICES                                             │
│                                                                  │
│  AuthService → JWT authentication                               │
│  Database Pool → PostgreSQL (Neon)                              │
│  Redis → Caching (Upstash)                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📋 Structured Output Schemas

All AI outputs use Gemini's JSON Schema enforcement for reliable, validated responses:

```
┌─────────────────────────────────────────────────────────────────┐
│  SCHEMA                        │ USED BY                        │
├────────────────────────────────┼────────────────────────────────┤
│  COIN_SELECTION_SCHEMA         │ Stage 2: runCoinSelection()   │
│  ├─ picks[]: symbol, direction, conviction, reason             │
│                                                                  │
│  SPECIALIST_ANALYSIS_SCHEMA    │ Stage 3: runSpecialistAnalysis│
│  ├─ recommendation, confidence, targets, thesis                │
│  ├─ bullCase[], bearCase[], keyMetrics, catalyst               │
│                                                                  │
│  TOURNAMENT_JUDGE_SCHEMA       │ Stage 4: runDebateMatch()     │
│  ├─ winner, scores{}, reasoning, keyDifferentiator             │
│                                                                  │
│  RISK_COUNCIL_SCHEMA           │ Stage 5: runRiskCouncil()     │
│  ├─ approved, adjustments{}, warnings[], vetoReason            │
│                                                                  │
│  ANALYSIS_RESPONSE_SCHEMA      │ GeminiService.generateAnalysis│
│  ├─ recommendation, confidence, priceTarget, positionSize      │
│  ├─ bullCase[], bearCase[], catalysts[], summary               │
│                                                                  │
│  DEBATE_RESPONSE_SCHEMA        │ GeminiService.generateDebate  │
│  ├─ turns[], winner, scores{}, winningArguments[], summary     │
│                                                                  │
│  TRADING_DECISION_SCHEMA       │ GeminiService.tradingDecision │
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
│  2. SELECT  → Ray, Jim, Quant pick best opportunity            │
│  3. ANALYZE → 3 specialists deep-dive the chosen coin          │
│  4. DEBATE  → Tournament determines best thesis                │
│  5. RISK    → Karen approves/vetoes/adjusts                    │
│  6. EXECUTE → Place trade on WEEX with compliance log          │
│  7. MANAGE  → Update leaderboard, monitor positions            │
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
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  EDGE CASES HANDLED (v2.2.0):                                   │
│                                                                  │
│  ✓ Number.isFinite() guards on all calculations                │
│  ✓ Division by zero protection                                 │
│  ✓ Empty array handling                                        │
│  ✓ Timeout cleanup (no memory leaks)                           │
│  ✓ Array mutation during iteration fixed                       │
│  ✓ Null/undefined checks on all inputs                         │
│                                                                  │
└───────
```
