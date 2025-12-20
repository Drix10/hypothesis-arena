# Agent Trading System - Comprehensive Design Plan

## 🎯 Vision

Transform the Hypothesis Arena from a debate platform into a **live trading simulation** where 8 AI agents put their money where their mouth is. Each agent trades based on their investment thesis, and we track who actually makes profit.

---

## 📋 Executive Summary

**What:** Demo trading platform where AI agents execute trades based on their debate outcomes
**Why:** Prove which investment strategies actually work, not just which sound good
**How:** Paper trading with virtual portfolios, real market data, live P&L tracking

**Key Metrics:**

- Each agent starts with $100,000 virtual cash
- Track win rate, total return, Sharpe ratio, max drawdown
- Leaderboard shows best performing agents over time
- Historical performance visualization

**CRITICAL DISCLAIMER:** This is a simulation for educational purposes only. Past performance does not guarantee future results. Not financial advice.

---

## 🏗️ System Architecture

### High-Level Components

```
┌─────────────────────────────────────────────────────────────┐
│                    HYPOTHESIS ARENA                          │
│                                                              │
│  ┌──────────────┐      ┌──────────────┐                    │
│  │   Debate     │──────▶│   Trading    │                    │
│  │   System     │      │   Engine     │                    │
│  │  (Existing)  │      │    (New)     │                    │
│  └──────────────┘      └──────┬───────┘                    │
│                                │                             │
│                                ▼                             │
│                    ┌──────────────────────┐                 │
│                    │  Portfolio Manager   │                 │
│                    │  - 8 Agent Portfolios│                 │
│                    │  - Position Tracking │                 │
│                    │  - P&L Calculation   │                 │
│                    └──────────┬───────────┘                 │
│                                │                             │
│                                ▼                             │
│                    ┌──────────────────────┐                 │
│                    │   Market Data Feed   │                 │
│                    │  - Real-time prices  │                 │
│                    │  - Historical data   │                 │
│                    └──────────────────────┘                 │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## 🔧 Technical Stack

### Data Storage

**Option 1: LocalStorage (Recommended for MVP)**

- ✅ No backend needed
- ✅ Instant setup
- ✅ Works offline
- ❌ Limited to ~5-10MB
- ❌ Per-browser storage
- ❌ **CRITICAL:** Data loss on browser clear/incognito mode
- ❌ **CRITICAL:** No sync across devices

**Option 2: IndexedDB (Future)**

- ✅ Larger storage (~50MB+)
- ✅ Better performance
- ✅ Structured queries
- ❌ More complex API
- ❌ Still local-only, same data loss risks

**Decision:** Start with LocalStorage + mandatory export/backup functionality

**RISK MITIGATION:**

- Auto-export portfolio snapshots weekly
- Prominent "Export Data" button in UI
- Warning on first use about data persistence
- Consider cloud backup in Phase 5+

### Market Data

**Current:** FMP + Yahoo Finance (already integrated)

- Real-time quotes (15-20 min delay for free tier)
- Historical prices
- No additional cost
- **CRITICAL LIMITATION:** Delayed data means trades execute at stale prices

**EDGE CASE HANDLING:**

- Market hours: Only allow trades during market hours (9:30 AM - 4:00 PM ET)
- After-hours: Queue trades for next market open
- Weekends/Holidays: Display clear messaging, queue trades
- Price staleness: Show timestamp on last price update
- API failures: Graceful degradation, use cached prices with warning
- Delisted stocks: Handle positions in delisted/bankrupt companies
- Stock splits: Adjust position shares and cost basis automatically
- Dividends: Credit cash to portfolio (if data available)
- Ticker changes: Handle symbol changes (e.g., FB → META)

### Trading Simulation

**Library:** Custom implementation (no external library needed)

- Simple buy/sell logic
- Position tracking
- P&L calculation
- Commission simulation (optional)

### Charting

**Library:** Recharts (already in package.json)

- Portfolio value over time
- Individual agent performance
- Comparison charts

---

## 📊 Data Models

### Agent Portfolio

```typescript
interface AgentPortfolio {
  agentId: string;
  agentName: string;
  methodology: AnalystMethodology;

  // Account info
  initialCash: number; // $100,000
  currentCash: number; // Available cash
  totalValue: number; // Cash + positions value

  // Performance metrics
  totalReturn: number; // Percentage
  totalReturnDollar: number; // Dollar amount
  winRate: number; // % of profitable trades
  sharpeRatio: number | null; // Risk-adjusted return
  maxDrawdown: number; // Worst peak-to-trough decline

  // Positions
  positions: Position[];

  // Trade history
  trades: Trade[];

  // Performance history (daily snapshots)
  performanceHistory: PerformanceSnapshot[];

  // Metadata
  createdAt: number;
  updatedAt: number;
}

interface Position {
  ticker: string;
  shares: number;
  avgCostBasis: number; // Average price paid per share
  currentPrice: number; // Latest market price
  marketValue: number; // shares × currentPrice
  unrealizedPnL: number; // (currentPrice - avgCostBasis) × shares
  unrealizedPnLPercent: number;
  openedAt: number; // Timestamp
}

interface Trade {
  id: string;
  ticker: string;
  type: "BUY" | "SELL";
  shares: number;
  price: number;
  totalValue: number; // shares × price
  commission: number; // Optional: $0 for now
  timestamp: number;

  // Context
  thesisId?: string; // Link to investment thesis
  debateId?: string; // Link to debate
  recommendation: "strong_buy" | "buy" | "hold" | "sell" | "strong_sell";
  confidence: number;

  // Result (for closed positions)
  realizedPnL?: number;
  realizedPnLPercent?: number;
}

interface PerformanceSnapshot {
  timestamp: number;
  totalValue: number;
  cash: number;
  positionsValue: number;
  totalReturn: number;
  dailyReturn: number;
}
```

### Trading System State

```typescript
interface TradingSystemState {
  isEnabled: boolean;
  portfolios: Map<string, AgentPortfolio>;

  // Global settings
  initialCash: number; // $100,000
  commissionRate: number; // 0 for now

  // Leaderboard
  leaderboard: LeaderboardEntry[];

  // System metadata
  startDate: number;
  lastUpdated: number;
}

interface LeaderboardEntry {
  agentId: string;
  agentName: string;
  methodology: AnalystMethodology;
  totalReturn: number;
  totalValue: number;
  winRate: number;
  tradesCount: number;
  rank: number;
}
```

---

## 🎮 Trading Logic

### When Do Agents Trade?

**Trigger:** After debate tournament completes

**Decision Logic:**

```typescript
function determineTradeAction(
  thesis: InvestmentThesis,
  debate: StockDebate,
  currentPosition: Position | null
): TradeAction {
  // Agent won the debate → Strong signal
  const wonDebate = debate.winner === thesis.agentId;
  const confidence = thesis.confidence;
  const recommendation = thesis.recommendation;

  // Calculate position size based on confidence
  const maxPositionSize = 0.2; // Max 20% of portfolio per stock
  const positionSize = (confidence / 100) * maxPositionSize;

  // BUY logic
  if (recommendation === "strong_buy" && wonDebate && confidence > 70) {
    return {
      action: "BUY",
      sizePercent: positionSize,
      reason: "Won debate with strong buy thesis",
    };
  }

  if (recommendation === "buy" && wonDebate && confidence > 60) {
    return {
      action: "BUY",
      sizePercent: positionSize * 0.7, // Smaller position
      reason: "Won debate with buy thesis",
    };
  }

  // SELL logic
  if (currentPosition && recommendation === "sell" && wonDebate) {
    return {
      action: "SELL",
      sizePercent: 0.5, // Sell half
      reason: "Won debate with sell thesis",
    };
  }

  if (currentPosition && recommendation === "strong_sell" && wonDebate) {
    return {
      action: "SELL",
      sizePercent: 1.0, // Sell all
      reason: "Won debate with strong sell thesis",
    };
  }

  // HOLD
  return {
    action: "HOLD",
    reason: "No strong signal or lost debate",
  };
}
```

### Position Sizing Rules

1. **Max per position:** 20% of portfolio
2. **Max total invested:** 80% (keep 20% cash)
3. **Confidence scaling:** Higher confidence = larger position
4. **Debate outcome:** Only trade if won debate (or lost but very high confidence)

### Risk Management

1. **Stop Loss:** Sell if position down 15% (optional)
2. **Take Profit:** Sell half if position up 25% (optional)
3. **Rebalancing:** Monthly review of all positions (future)
4. **Diversification:** Max 5 positions per agent (future)

---

## 🎨 UI/UX Design

### New Pages/Sections

#### 1. Trading Dashboard (New Main Tab)

```
┌─────────────────────────────────────────────────────────┐
│  🏆 Leaderboard                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Rank │ Agent      │ Return │ Value    │ Trades │   │
│  │  1   │ 📈 Cathie  │ +15.2% │ $115,200 │   12   │   │
│  │  2   │ 💰 Warren  │ +12.8% │ $112,800 │    8   │   │
│  │  3   │ 📊 Peter   │  +8.4% │ $108,400 │   15   │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  📈 Portfolio Performance                               │
│  [Line chart showing all 8 agents over time]           │
│                                                         │
│  🎯 Recent Trades                                       │
│  [List of latest trades across all agents]             │
└─────────────────────────────────────────────────────────┘
```

#### 2. Agent Portfolio View (Click on agent)

```
┌─────────────────────────────────────────────────────────┐
│  📈 Cathie Wood - Growth Hunter                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Total Value: $115,200  (+15.2%)                 │   │
│  │ Cash: $45,000  |  Positions: $70,200            │   │
│  │ Win Rate: 66.7%  |  Trades: 12                  │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  📊 Current Positions                                   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ NVDA  │ 50 shares │ $140.00 │ $7,000 │ +12.5% │   │
│  │ TSLA  │ 30 shares │ $250.00 │ $7,500 │  -5.2% │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  📜 Trade History                                       │
│  [Chronological list of all trades]                    │
│                                                         │
│  📈 Performance Chart                                   │
│  [Portfolio value over time]                           │
└─────────────────────────────────────────────────────────┘
```

#### 3. Post-Analysis Trading View

After completing stock analysis, show:

```
┌─────────────────────────────────────────────────────────┐
│  ⚔️ Debate Complete - Trading Decisions                 │
│                                                         │
│  🏆 Winner: Cathie Wood (Growth Hunter)                │
│  📊 Recommendation: STRONG BUY (Confidence: 85%)       │
│                                                         │
│  💰 Trading Actions:                                    │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ✅ Cathie   │ BUY  │ 50 shares │ $7,000        │   │
│  │ ✅ Warren   │ BUY  │ 30 shares │ $4,200        │   │
│  │ ⏸️  Peter   │ HOLD │ -         │ -             │   │
│  │ ❌ Ray      │ PASS │ Lost debate               │   │
│  └─────────────────────────────────────────────────┘   │
│                                                         │
│  [View All Portfolios] [Continue]                      │
└─────────────────────────────────────────────────────────┘
```

---

## 🔄 User Flow

### Initial Setup

1. User enables trading feature (toggle in settings)
2. System initializes 8 portfolios with $100k each
3. Show welcome modal explaining the feature

### After Each Analysis

1. User analyzes a stock (existing flow)
2. Debate tournament completes
3. **NEW:** Trading decision screen appears
4. Show which agents are buying/selling/holding
5. Execute trades automatically
6. Show updated portfolio values
7. User can view detailed portfolios or continue

### Ongoing Usage

1. User can access Trading Dashboard anytime
2. View leaderboard, individual portfolios
3. See trade history, performance charts
4. Compare agent strategies

---

## 📈 Performance Metrics

### Agent-Level Metrics

**Basic:**

- Total Return (%)
- Total Return ($)
- Current Portfolio Value
- Win Rate (% profitable trades)
- Total Trades

**Advanced:**

- Sharpe Ratio (risk-adjusted return)
- Max Drawdown (worst decline)
- Average Win/Loss
- Best/Worst Trade
- Days Active

**Comparison:**

- Rank vs other agents
- Return vs S&P 500 (future)
- Volatility comparison

### System-Level Metrics

- Total trades executed
- Most traded stocks
- Best performing strategy
- Aggregate portfolio value

---

## 🗄️ Data Persistence

### LocalStorage Structure

```typescript
// Key: 'hypothesis-arena-trading'
{
  version: 1,
  isEnabled: true,
  initialCash: 100000,
  startDate: 1703001600000,

  portfolios: {
    'cathie-wood': { /* AgentPortfolio */ },
    'warren-buffett': { /* AgentPortfolio */ },
    // ... 8 agents
  },

  // Global trade history (for analytics)
  allTrades: [ /* Trade[] */ ],

  // Daily snapshots for system-wide metrics
  systemSnapshots: [ /* SystemSnapshot[] */ ]
}
```

### Data Size Estimation

- 8 portfolios × ~50KB each = 400KB
- 1000 trades × ~1KB each = 1MB
- 365 daily snapshots × ~2KB = 730KB
- **Total: ~2.1MB** (well within 5MB limit)

---

## 🚀 Implementation Phases

### Phase 1: Core Trading Engine (Week 1)

**Goal:** Basic buy/sell functionality

- [ ] Create data models (TypeScript interfaces)
- [ ] Implement portfolio manager service
- [ ] Add trade execution logic
- [ ] Integrate with existing debate system
- [ ] LocalStorage persistence
- [ ] Basic P&L calculation

**Deliverable:** Agents can execute trades after debates

---

### Phase 2: Portfolio UI (Week 2)

**Goal:** Visualize agent portfolios

- [ ] Trading Dashboard page
- [ ] Leaderboard component
- [ ] Agent portfolio detail view
- [ ] Trade history table
- [ ] Basic performance charts (Recharts)
- [ ] Post-analysis trading screen

**Deliverable:** Users can view all trading activity

---

### Phase 3: Performance Metrics (Week 3)

**Goal:** Advanced analytics

- [ ] Calculate Sharpe ratio
- [ ] Track max drawdown
- [ ] Win rate calculation
- [ ] Performance comparison charts
- [ ] Historical snapshots
- [ ] Export data (CSV)

**Deliverable:** Comprehensive performance analytics

---

### Phase 4: Polish & Features (Week 4)

**Goal:** Production-ready

- [ ] Risk management rules (stop loss, take profit)
- [ ] Position sizing optimization
- [ ] Mobile-responsive design
- [ ] Onboarding tutorial
- [ ] Settings panel (enable/disable, reset)
- [ ] Performance optimizations

**Deliverable:** Production-ready trading system

---

## 🎯 Success Metrics

### User Engagement

- % of users who enable trading
- Average time spent on trading dashboard
- Frequency of checking portfolios

### System Performance

- Trade execution success rate
- Data load times < 100ms
- No data loss incidents

### Feature Adoption

- % of analyses that result in trades
- Average trades per user session
- Leaderboard views

---

## 🔒 Risk Mitigation

### Technical Risks

**Risk:** LocalStorage data loss

- **Mitigation:** Export/import functionality, backup to file

**Risk:** Performance with large datasets

- **Mitigation:** Pagination, data archiving, IndexedDB migration

**Risk:** Price data accuracy

- **Mitigation:** Multiple data sources (FMP + Yahoo), validation

### UX Risks

**Risk:** Users confused by demo trading

- **Mitigation:** Clear "DEMO" labels, onboarding tutorial

**Risk:** Feature complexity overwhelming

- **Mitigation:** Progressive disclosure, optional feature

**Risk:** Unrealistic expectations

- **Mitigation:** Disclaimers, educational content

---

## 🎨 Design Principles

1. **Transparency:** Show all trades, reasoning, and outcomes
2. **Simplicity:** Start with core features, add complexity gradually
3. **Education:** Help users understand different strategies
4. **Fun:** Gamify with leaderboards, achievements (future)
5. **Realistic:** Use real market data, realistic constraints

---

## 📚 Technical Dependencies

### New Dependencies (None!)

- ✅ All functionality can be built with existing stack
- ✅ Recharts already installed for charts
- ✅ LocalStorage built into browser
- ✅ Market data already integrated

### Existing Dependencies to Leverage

- React + TypeScript
- Framer Motion (animations)
- Recharts (performance charts)
- Existing stock data services

---

## 🔮 Future Enhancements

### Phase 5+ (Future)

- [ ] Benchmark against S&P 500
- [ ] Options trading simulation
- [ ] Portfolio rebalancing
- [ ] Tax loss harvesting simulation
- [ ] Social features (share portfolios)
- [ ] Agent vs Agent challenges
- [ ] Historical backtesting
- [ ] Custom agent creation
- [ ] Real-time price updates (WebSocket)
- [ ] Mobile app

---

## 📊 Example Scenarios

### Scenario 1: Bullish Consensus

**Setup:** All 8 agents analyze NVDA, 6 say strong buy

**Outcome:**

- 6 agents buy NVDA (varying position sizes)
- 2 agents hold (lost debates or low confidence)
- Leaderboard shows who sized correctly

### Scenario 2: Split Decision

**Setup:** 4 bulls, 4 bears on TSLA

**Outcome:**

- Bulls buy if they won their debates
- Bears sell/short if they won
- Creates natural A/B test of strategies

### Scenario 3: Long-Term Tracking

**Setup:** User analyzes 20 stocks over 3 months

**Outcome:**

- Clear winner emerges (e.g., Value Investor)
- Some agents excel at certain sectors
- Users learn which strategies work

---

## 🎓 Educational Value

### What Users Learn

1. **Strategy Comparison:** See which investment approaches work
2. **Risk Management:** Understand position sizing, diversification
3. **Market Psychology:** Watch how confidence affects outcomes
4. **Long-term Thinking:** Track performance over time
5. **Debate Quality:** Good arguments ≠ good returns

### Insights Generated

- "Growth investing outperformed value in tech stocks"
- "High confidence doesn't always mean high returns"
- "Contrarian plays had 60% win rate"
- "Technical analysis worked better for volatile stocks"

---

## ✅ Definition of Done

### MVP (Phase 1-2) Complete When:

- ✅ Agents execute trades after debates
- ✅ Portfolios persist across sessions
- ✅ Users can view leaderboard
- ✅ Basic P&L tracking works
- ✅ Trade history visible
- ✅ No data loss or corruption

### Full Feature (Phase 1-4) Complete When:

- ✅ All performance metrics calculated
- ✅ Beautiful, responsive UI
- ✅ Onboarding tutorial complete
- ✅ Export/import functionality
- ✅ Mobile-friendly
- ✅ Production-ready performance

---

## 🚦 Go/No-Go Decision Points

### After Phase 1:

**Question:** Is the core trading logic working correctly?

- If YES → Proceed to Phase 2
- If NO → Debug and fix before UI work

### After Phase 2:

**Question:** Is the UI intuitive and engaging?

- If YES → Proceed to Phase 3
- If NO → Iterate on UX before adding complexity

### After Phase 3:

**Question:** Are metrics accurate and valuable?

- If YES → Proceed to Phase 4
- If NO → Refine calculations and displays

---

## 📝 Open Questions

1. **Commission fees?** Start with $0, add later?

   - **Decision:** $0 for MVP, add as optional setting

2. **Short selling?** Allow agents to short stocks?

   - **Decision:** Phase 5+, adds complexity

3. **Fractional shares?** Or whole shares only?

   - **Decision:** Whole shares for simplicity

4. **Rebalancing?** Automatic or manual?

   - **Decision:** Manual for MVP, auto in Phase 5+

5. **Historical data?** Backtest on past analyses?
   - **Decision:** Phase 5+, focus on forward-looking

---

## 🎯 Success Criteria

### Must Have (MVP)

- ✅ Trades execute correctly
- ✅ P&L calculated accurately
- ✅ Data persists reliably
- ✅ Leaderboard shows rankings
- ✅ No performance issues

### Should Have (Full Feature)

- ✅ Advanced metrics (Sharpe, drawdown)
- ✅ Beautiful charts
- ✅ Mobile responsive
- ✅ Export functionality

### Nice to Have (Future)

- ⏳ Backtesting
- ⏳ Social features
- ⏳ Custom agents
- ⏳ Real-time updates

---

## 📅 Timeline Estimate

**MVP (Phase 1-2):** 2 weeks
**Full Feature (Phase 1-4):** 4 weeks
**Polish & Launch:** +1 week

**Total:** ~5 weeks to production-ready feature

---

## 🎉 Launch Plan

### Soft Launch

1. Enable for beta users
2. Gather feedback
3. Fix bugs
4. Iterate on UX

### Public Launch

1. Blog post explaining feature
2. Demo video
3. Social media announcement
4. Monitor usage and performance

---

**Status:** 📋 Design Complete - Ready for Implementation
**Next Step:** Create requirements.md and begin Phase 1
**Owner:** Development Team
**Last Updated:** December 19, 2024
