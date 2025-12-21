# Autonomous Trading System - Integration Plan

## Overview

This document tracks the detailed implementation progress of the Autonomous Trading System as outlined in `Plan.md`. It maps existing code to planned features and tracks completion status.

---

## 📊 Current Codebase Inventory

### Services Layer

| File                         | Purpose                       | Status     | Notes                                      |
| ---------------------------- | ----------------------------- | ---------- | ------------------------------------------ |
| `tradingService.ts`          | Main trading orchestrator     | ✅ Exists  | Core trade execution, portfolio management |
| `positionSizingService.ts`   | Calculate safe position sizes | ✅ Exists  | Confidence-based sizing, limits            |
| `performanceCalculator.ts`   | Sharpe, drawdown, win rate    | ✅ Exists  | Full metrics suite                         |
| `marketHoursService.ts`      | Market open/close detection   | ✅ Exists  | Holiday support                            |
| `priceValidationService.ts`  | Stale/suspicious price checks | ✅ Exists  | Age validation                             |
| `tradingSystemLock.ts`       | Prevent race conditions       | ✅ Exists  | Async lock pattern                         |
| `corporateActionsService.ts` | Splits, dividends handling    | ✅ Exists  | Basic implementation                       |
| `autoTradeExecutor.ts`       | Auto-execute after analysis   | ❌ Missing | **Phase 1**                                |
| `positionReviewService.ts`   | Review existing positions     | ❌ Missing | **Phase 2**                                |
| `exitStrategyService.ts`     | Stop-loss, take-profit        | ❌ Missing | **Phase 2**                                |
| `analysisScheduler.ts`       | Scheduled analysis queue      | ❌ Missing | **Phase 3**                                |
| `agentPerformanceTracker.ts` | Track agent accuracy          | ❌ Missing | **Phase 4**                                |
| `confidenceAdjuster.ts`      | Dynamic confidence multiplier | ❌ Missing | **Phase 4**                                |

### Analysis Services

| File                        | Purpose               | Status    | Notes                  |
| --------------------------- | --------------------- | --------- | ---------------------- |
| `analystService.ts`         | Generate AI theses    | ✅ Exists | 8 agents, Gemini API   |
| `stockTournamentService.ts` | Run debate tournament | ✅ Exists | Quarterfinals → Finals |
| `recommendationService.ts`  | Final recommendation  | ✅ Exists | Weighted consensus     |
| `stockDataAggregator.ts`    | Fetch all stock data  | ✅ Exists | FMP + Yahoo fallback   |
| `yahooFinance.ts`           | Yahoo Finance API     | ✅ Exists | Quote, historical      |
| `technicalAnalysis.ts`      | Calculate indicators  | ✅ Exists | RSI, MACD, BB, etc.    |
| `newsService.ts`            | Fetch news sentiment  | ✅ Exists | Basic sentiment        |

### Components

| File                          | Purpose                  | Status     | Notes                           |
| ----------------------------- | ------------------------ | ---------- | ------------------------------- |
| `StockArena.tsx`              | Main orchestration       | ✅ Exists  | Manual flow, needs auto-execute |
| `PostAnalysisTradingView.tsx` | Trade confirmation modal | ✅ Exists  | **Remove for Phase 1**          |
| `TradingDashboard.tsx`        | Portfolio overview       | ✅ Exists  | Agent portfolios                |
| `AccuracyTracker.tsx`         | Prediction accuracy      | ✅ Exists  | Recently enhanced               |
| `Leaderboard.tsx`             | Agent rankings           | ✅ Exists  | Basic leaderboard               |
| `AutonomousDashboard.tsx`     | Unified autonomous view  | ❌ Missing | **Phase 5**                     |
| `AutoTradingSettings.tsx`     | Config toggles           | ❌ Missing | **Phase 1**                     |

### Types

| File            | Purpose                 | Status      | Notes                |
| --------------- | ----------------------- | ----------- | -------------------- |
| `trading.ts`    | Trading types           | ✅ Complete | All models defined   |
| `stock.ts`      | Analysis types          | ✅ Complete | Thesis, debate, etc. |
| `autonomous.ts` | Autonomous config types | ❌ Missing  | **Phase 1**          |

---

## 🔧 Phase 1: Auto-Execute After Analysis

### Goal

Remove manual "Execute Trades" confirmation. Trades execute automatically after debate tournament.

### Tasks

| Task                                        | File(s)                                           | Status  | Priority |
| ------------------------------------------- | ------------------------------------------------- | ------- | -------- |
| Create `AutonomousTradingConfig` type       | `src/types/autonomous.ts`                         | ⬜ TODO | P0       |
| Create `AutoTradeExecutor` service          | `src/services/trading/autoTradeExecutor.ts`       | ⬜ TODO | P0       |
| Add auto-execute toggle to settings         | `src/components/settings/AutoTradingSettings.tsx` | ⬜ TODO | P0       |
| Store config in localStorage                | `src/services/storageService.ts`                  | ⬜ TODO | P0       |
| Modify `StockArena.tsx` to auto-execute     | `src/components/layout/StockArena.tsx`            | ⬜ TODO | P0       |
| Add circuit breaker (3 consecutive losses)  | `src/services/trading/autoTradeExecutor.ts`       | ⬜ TODO | P1       |
| Add price freshness validation (<5% move)   | `src/services/trading/autoTradeExecutor.ts`       | ⬜ TODO | P1       |
| Add confidence floor setting (default 60%)  | `src/types/autonomous.ts`                         | ⬜ TODO | P1       |
| Remove/hide `PostAnalysisTradingView` modal | `src/components/layout/StockArena.tsx`            | ⬜ TODO | P2       |

### Implementation Details

**AutoTradeExecutor Service:**

```typescript
// src/services/trading/autoTradeExecutor.ts
interface AutoExecuteResult {
  executed: Trade[];
  skipped: { agentId: string; reason: string }[];
  errors: string[];
}

class AutoTradeExecutor {
  async executePostAnalysis(
    theses: InvestmentThesis[],
    debates: StockDebate[],
    stockData: StockAnalysisData,
    config: AutonomousTradingConfig
  ): Promise<AutoExecuteResult>;

  private validatePriceFreshness(
    analysisPrice: number,
    currentPrice: number
  ): boolean;
  private checkCircuitBreaker(state: TradingSystemState): boolean;
}
```

**Config Type:**

```typescript
// src/types/autonomous.ts
interface AutonomousTradingConfig {
  enabled: boolean;
  autoExecuteAfterAnalysis: boolean;
  minimumConfidenceToTrade: number; // 0-100, default 60
  requireDebateWin: boolean; // default true
  maxPriceDeviation: number; // default 0.05 (5%)
  circuitBreakerLosses: number; // default 3
}
```

**StockArena.tsx Changes:**

- After `generateFinalRecommendation()`, check if auto-execute enabled
- If enabled, call `autoTradeExecutor.executePostAnalysis()`
- Show toast notification with results
- Skip `PostAnalysisTradingView` modal

### Acceptance Criteria

- [ ] Toggle in settings to enable/disable auto-trading
- [ ] Trades execute automatically when analysis completes (if enabled)
- [ ] Only debate winners with confidence > threshold trade
- [ ] Circuit breaker halts trading after 3 consecutive losses
- [ ] Price validation rejects trades if price moved >5% since analysis
- [ ] Toast notification shows execution summary

---

## 🔧 Phase 2: Portfolio Position Management

### Goal

Agents actively manage existing positions with stop-loss and take-profit rules.

### Tasks

| Task                                     | File(s)                                         | Status  | Priority |
| ---------------------------------------- | ----------------------------------------------- | ------- | -------- |
| Create `ExitStrategyService`             | `src/services/trading/exitStrategyService.ts`   | ⬜ TODO | P0       |
| Create `PositionReviewService`           | `src/services/trading/positionReviewService.ts` | ⬜ TODO | P0       |
| Add stop-loss logic (default -15%)       | `exitStrategyService.ts`                        | ⬜ TODO | P0       |
| Add take-profit logic (default +25%)     | `exitStrategyService.ts`                        | ⬜ TODO | P1       |
| Add position review on app open          | `src/App.tsx` or `StockArena.tsx`               | ⬜ TODO | P1       |
| Add agent-specific exit strategies       | `exitStrategyService.ts`                        | ⬜ TODO | P2       |
| Add cooldown period (24h re-entry block) | `positionReviewService.ts`                      | ⬜ TODO | P2       |
| Add position size limits (max 25%)       | `positionSizingService.ts`                      | ⬜ TODO | P1       |

### Implementation Details

**ExitStrategyService:**

```typescript
// src/services/trading/exitStrategyService.ts
interface ExitDecision {
  action: "HOLD" | "TRIM" | "EXIT";
  reason: "stop_loss" | "take_profit" | "thesis_invalid" | "time_based";
  sellPercent: number; // 0-1
}

class ExitStrategyService {
  evaluatePosition(
    position: Position,
    currentPrice: number,
    rules: RiskManagementRules
  ): ExitDecision;

  // Agent-specific strategies (Phase 2 enhancement)
  evaluateForAgent(
    position: Position,
    agentMethodology: AnalystMethodology,
    currentPrice: number
  ): ExitDecision;
}
```

**PositionReviewService:**

```typescript
// src/services/trading/positionReviewService.ts
interface PositionReview {
  ticker: string;
  agentId: string;
  currentPrice: number;
  unrealizedPnL: number;
  daysSinceEntry: number;
  exitDecision: ExitDecision;
}

class PositionReviewService {
  async reviewAllPositions(
    state: TradingSystemState,
    priceData: Map<string, number>
  ): Promise<PositionReview[]>;

  async executeExits(
    reviews: PositionReview[],
    state: TradingSystemState
  ): Promise<Trade[]>;
}
```

### Acceptance Criteria

- [ ] Stop-loss triggers at -15% (configurable)
- [ ] Take-profit triggers at +25% (configurable)
- [ ] Position review runs on app open
- [ ] Cooldown prevents re-entry within 24h of exit
- [ ] No single position exceeds 25% of portfolio

---

## 🔧 Phase 3: Scheduled Analysis Engine

### Goal

System proactively analyzes stocks from watchlist without user input.

### Tasks

| Task                                   | File(s)                                      | Status  | Priority |
| -------------------------------------- | -------------------------------------------- | ------- | -------- |
| Create `AnalysisScheduler` service     | `src/services/analysis/analysisScheduler.ts` | ⬜ TODO | P0       |
| Create analysis queue with persistence | `src/services/analysis/analysisQueue.ts`     | ⬜ TODO | P0       |
| Add watchlist auto-scan trigger        | `analysisScheduler.ts`                       | ⬜ TODO | P1       |
| Add portfolio holdings review trigger  | `analysisScheduler.ts`                       | ⬜ TODO | P1       |
| Add rate limiting (max 1/5min, 20/day) | `analysisScheduler.ts`                       | ⬜ TODO | P0       |
| Add queue UI component                 | `src/components/trading/AnalysisQueue.tsx`   | ⬜ TODO | P2       |
| Add "missed analyses" notification     | `analysisScheduler.ts`                       | ⬜ TODO | P2       |
| Persist queue to localStorage          | `storageService.ts`                          | ⬜ TODO | P1       |

### Implementation Details

**AnalysisScheduler:**

```typescript
// src/services/analysis/analysisScheduler.ts
interface AnalysisJob {
  id: string;
  ticker: string;
  priority: number; // 1-10
  source: "watchlist" | "portfolio" | "manual";
  scheduledAt: number;
  status: "pending" | "running" | "completed" | "failed";
}

class AnalysisScheduler {
  private queue: AnalysisJob[] = [];
  private lastAnalysisTime: number = 0;
  private dailyCount: number = 0;

  scheduleWatchlistScan(): void;
  schedulePortfolioReview(): void;
  scheduleTickerAnalysis(ticker: string, priority: number): void;

  async processNext(): Promise<void>;
  async runScheduledTasks(): Promise<void>;

  // Rate limiting
  private canRunAnalysis(): boolean;
  private getRateLimitStatus(): { canRun: boolean; nextAvailable: number };
}
```

### Acceptance Criteria

- [ ] Watchlist stocks analyzed automatically (if enabled)
- [ ] Rate limiting prevents API abuse (max 20/day)
- [ ] Queue persists across browser sessions
- [ ] Queue UI shows pending/completed analyses
- [ ] "Missed analyses" shown when app reopens

---

## 🔧 Phase 4: Agent Performance Feedback Loop

### Goal

Agents learn from track record. Better agents get more influence.

### Tasks

| Task                                      | File(s)                                            | Status  | Priority |
| ----------------------------------------- | -------------------------------------------------- | ------- | -------- |
| Create `AgentPerformanceTracker`          | `src/services/feedback/agentPerformanceTracker.ts` | ⬜ TODO | P0       |
| Create `ConfidenceAdjuster`               | `src/services/feedback/confidenceAdjuster.ts`      | ⬜ TODO | P0       |
| Track prediction accuracy per agent       | `agentPerformanceTracker.ts`                       | ⬜ TODO | P0       |
| Track debate win rate per agent           | `agentPerformanceTracker.ts`                       | ⬜ TODO | P1       |
| Implement confidence multiplier formula   | `confidenceAdjuster.ts`                            | ⬜ TODO | P0       |
| Apply multiplier to position sizing       | `positionSizingService.ts`                         | ⬜ TODO | P1       |
| Add cold start protection (min 10 trades) | `confidenceAdjuster.ts`                            | ⬜ TODO | P1       |
| Add manual reset option                   | `confidenceAdjuster.ts`                            | ⬜ TODO | P2       |

### Implementation Details

**AgentPerformanceTracker:**

```typescript
// src/services/feedback/agentPerformanceTracker.ts
interface AgentPerformance {
  agentId: string;
  totalPredictions: number;
  correctPredictions: number;
  predictionAccuracy: number;
  totalTrades: number;
  winningTrades: number;
  tradingWinRate: number;
  debatesWon: number;
  debatesLost: number;
  debateWinRate: number;
  confidenceMultiplier: number; // 0.5 - 1.5
  lastUpdated: number;
}

class AgentPerformanceTracker {
  getPerformance(agentId: string): AgentPerformance;
  recordPrediction(agentId: string, wasCorrect: boolean): void;
  recordDebateResult(agentId: string, won: boolean): void;
  recalculateMultipliers(): void;
}
```

**ConfidenceAdjuster:**

```typescript
// src/services/feedback/confidenceAdjuster.ts
class ConfidenceAdjuster {
  calculateMultiplier(performance: AgentPerformance): number {
    // Base: 1.0
    let multiplier = 1.0;

    // Prediction accuracy impact (±20%)
    if (performance.totalPredictions >= 10) {
      multiplier += (performance.predictionAccuracy - 50) / 250;
    }

    // Trading win rate impact (±15%)
    if (performance.totalTrades >= 5) {
      multiplier += (performance.tradingWinRate - 50) / 333;
    }

    // Debate performance impact (±10%)
    if (performance.debatesWon + performance.debatesLost >= 10) {
      multiplier += (performance.debateWinRate - 50) / 500;
    }

    return Math.max(0.5, Math.min(1.5, multiplier));
  }

  adjustPositionSize(baseSize: number, agentId: string): number;
  resetAgent(agentId: string): void;
}
```

### Acceptance Criteria

- [ ] Each agent has tracked performance metrics
- [ ] Confidence multiplier calculated from performance
- [ ] Position sizing adjusted by multiplier
- [ ] Cold start protection (no adjustment until 10+ trades)
- [ ] Manual reset option available

---

## 🔧 Phase 5: Unified Dashboard

### Goal

Single view showing autonomous system status, agent leaderboard, recent trades.

### Tasks

| Task                                   | File(s)                                          | Status  | Priority |
| -------------------------------------- | ------------------------------------------------ | ------- | -------- |
| Create `AutonomousDashboard` component | `src/components/trading/AutonomousDashboard.tsx` | ⬜ TODO | P0       |
| Create `AgentLeaderboard` component    | `src/components/trading/AgentLeaderboard.tsx`    | ⬜ TODO | P0       |
| Create `RecentTradesLog` component     | `src/components/trading/RecentTradesLog.tsx`     | ⬜ TODO | P1       |
| Create `AnalysisQueueView` component   | `src/components/trading/AnalysisQueueView.tsx`   | ⬜ TODO | P1       |
| Add system status indicators           | `AutonomousDashboard.tsx`                        | ⬜ TODO | P1       |
| Add today's activity summary           | `AutonomousDashboard.tsx`                        | ⬜ TODO | P2       |
| Add notification system                | `src/services/notificationService.ts`            | ⬜ TODO | P2       |

### Acceptance Criteria

- [ ] Dashboard shows system on/off status
- [ ] Agent leaderboard with rankings, returns, accuracy
- [ ] Recent trades log with agent, ticker, action, time
- [ ] Analysis queue with pending items
- [ ] Toast notifications for trades and analyses

---

## 📈 Progress Tracking

### Overall Status

| Phase                        | Status         | Progress | Target |
| ---------------------------- | -------------- | -------- | ------ |
| Phase 1: Auto-Execute        | ⬜ Not Started | 0%       | Week 1 |
| Phase 2: Position Management | ⬜ Not Started | 0%       | Week 2 |
| Phase 3: Scheduled Analysis  | ⬜ Not Started | 0%       | Week 3 |
| Phase 4: Feedback Loop       | ⬜ Not Started | 0%       | Week 4 |
| Phase 5: Dashboard           | ⬜ Not Started | 0%       | Week 4 |

### Legend

- ⬜ TODO - Not started
- 🔄 In Progress - Currently working
- ✅ Complete - Done and tested
- ⏸️ Blocked - Waiting on dependency

---

## 🔗 Dependencies Map

```
Phase 1 (Auto-Execute)
    └── Phase 2 (Position Management) - needs auto-execute foundation
        └── Phase 3 (Scheduled Analysis) - needs position management
            └── Phase 4 (Feedback Loop) - needs historical data from phases 1-3
                └── Phase 5 (Dashboard) - needs all data sources
```

---

## 📝 Notes & Decisions

### Decision Log

| Date       | Decision                      | Rationale                |
| ---------- | ----------------------------- | ------------------------ |
| 2024-12-21 | Use Gemini only (no multi-AI) | Simplicity, user request |
| 2024-12-21 | Browser-based (no backend)    | MVP scope, can add later |
| 2024-12-21 | localStorage for persistence  | Simple, no auth needed   |

### Known Limitations

1. **Browser Tab Closure** - Scheduled tasks stop when tab closes
2. **localStorage Limits** - 5-10MB max, need pruning strategy
3. **No Real Trading** - Paper trading only, no broker integration
4. **Single User** - No multi-user support

### Future Enhancements (Post-MVP)

- [ ] Backend server for 24/7 autonomy
- [ ] Real broker integration (Alpaca API)
- [ ] Multi-user with authentication
- [ ] Advanced order types (limit, stop-limit)
- [ ] Market regime detection
- [ ] Agent-specific exit strategies

---

## 🧪 Testing Checklist

### Phase 0 Tests (Validation - RECOMMENDED)

- [ ] Collect 50-100 manual analyses
- [ ] Measure debate winner accuracy vs subsequent price movements
- [ ] Validate LLM predictions have signal before building autonomy
- [ ] Implement basic logging and dry-run mode

### Phase 1 Tests

- [ ] Auto-execute toggle persists across sessions
- [ ] Trades only execute for debate winners
- [ ] Circuit breaker triggers after 3 losses
- [ ] Price validation rejects stale prices
- [ ] Confidence threshold respected

### Phase 2 Tests

- [ ] Stop-loss triggers at correct level
- [ ] Take-profit triggers at correct level
- [ ] Cooldown prevents rapid re-entry
- [ ] Position limits enforced

### Phase 3 Tests

- [ ] Rate limiting works (max 20/day)
- [ ] Queue persists across sessions
- [ ] Watchlist scan triggers correctly
- [ ] Browser tab closure mitigation: Queue persists, shows "missed analyses" on reopen

### Phase 4 Tests

- [ ] Performance metrics calculated correctly
- [ ] Multiplier stays in 0.5-1.5 range
- [ ] Cold start protection works

### Phase 5 Tests

- [ ] Dashboard loads without errors
- [ ] Leaderboard sorts correctly
- [ ] Recent trades show real-time updates

---

## 🔗 Alignment with Plan.md

This integration plan implements the vision outlined in `Plan.md` with the following key alignments:

- **Phase 0 Validation** (from Plan.md Critical Analysis): Added recommendation to validate debate winner accuracy before building full autonomy
- **Browser Limitations** (from Plan.md): Acknowledged in Phase 3 with mitigation strategy for tab closure
- **Agent-Specific Exit Strategies** (from Plan.md): Noted as Phase 2 enhancement to respect agent philosophies
- **Confidence Adjustment** (from Plan.md): Implements Bayesian approach recommended in critical analysis

### Key Architectural Decisions

| Decision                      | Rationale                                                                 | Source         |
| ----------------------------- | ------------------------------------------------------------------------- | -------------- |
| Use Gemini only (no multi-AI) | Simplicity, user request                                                  | User feedback  |
| Browser-based (no backend)    | MVP scope, can add later                                                  | Plan.md        |
| localStorage for persistence  | Simple, no auth needed                                                    | Plan.md        |
| Phase 0 validation first      | Validate signal before building autonomy (from Plan.md critical analysis) | Plan.md review |

---

_Last Updated: December 21, 2024_
