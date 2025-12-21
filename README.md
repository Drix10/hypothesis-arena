<div align="center">
  <br />
  
  # 🏆 Hypothesis Arena
  
  **AI-Powered Stock Investment Analysis & Agent Trading System**
  
  *8 AI analysts debate investment decisions, then compete with real portfolios*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19.2-61dafb?logo=react)](https://react.dev/)
  [![Vite](https://img.shields.io/badge/Vite-6.2-646cff?logo=vite)](https://vitejs.dev/)
  [![Gemini](https://img.shields.io/badge/Gemini-2.0-4285F4?logo=google)](https://ai.google.dev/)
  
</div>

---

## 🎯 What is Hypothesis Arena?

Hypothesis Arena is a sophisticated AI-powered platform that combines **investment analysis** with **autonomous agent trading**. Watch 8 specialized AI analysts debate stock picks, then see them put their money where their mouth is by managing real portfolios.

### Two Core Systems

#### 1. **Analysis Engine** - AI Debate Tournament

8 AI analysts with different methodologies analyze any stock, generate investment theses, and debate in a tournament format to reach consensus.

#### 2. **Trading System** - Agent Competition Arena

Each analyst manages a $100,000 portfolio, executing trades based on their debate performance. Track rankings, performance metrics, and see who's the best investor.

---

## 🤖 The 8 AI Analysts

| Analyst                 | Methodology        | Focus                           | Trading Style                 |
| ----------------------- | ------------------ | ------------------------------- | ----------------------------- |
| 🎩 **Warren**           | Value Investing    | P/E, P/B, FCF yield, moats      | Conservative, long-term holds |
| 🚀 **Cathie**           | Growth Investing   | Revenue growth, TAM, disruption | Aggressive growth bets        |
| 📊 **Jim**              | Technical Analysis | RSI, MACD, chart patterns       | Momentum trading              |
| 🌍 **Ray**              | Macro Strategy     | Interest rates, economic cycles | Sector rotation               |
| 📱 **Elon**             | Sentiment Analysis | News flow, social sentiment     | Trend following               |
| 🛡️ **Karen**            | Risk Management    | Volatility, drawdown, downside  | Defensive positioning         |
| 🤖 **Quant**            | Quantitative       | Factor exposures, statistics    | Data-driven trades            |
| 😈 **Devil's Advocate** | Contrarian         | Consensus challenges            | Counter-trend plays           |

---

## ✨ Features

### 📊 Stock Analysis System

- **Real Market Data** - Live quotes, fundamentals, and technicals via FMP API with Yahoo Finance fallback
- **Technical Indicators** - RSI, MACD, Bollinger Bands, SMA/EMA, Stochastic, support/resistance
- **News Sentiment** - Aggregated news with AI-powered sentiment scoring
- **AI-Generated Theses** - Each analyst creates unique investment thesis with price targets
- **Debate Tournament** - Bulls vs Bears compete in quarterfinals, semifinals, and finals
- **Consensus Recommendation** - Weighted by debate performance and confidence
- **Interactive Charts** - Candlestick and line charts with multiple timeframes (1M/3M/6M/1Y)

### 🏆 Agent Trading System

#### Portfolio Management

- **8 Autonomous Traders** - Each analyst manages independent $100,000 portfolio
- **Real-Time Execution** - Trades execute based on debate outcomes and confidence
- **Position Tracking** - Live positions with cost basis, P&L, and performance metrics
- **Trade History** - Complete audit trail of all buy/sell decisions

#### Risk Management

- **Position Sizing** - Max 20% per stock, 80% total invested, 5% cash reserve
- **Position Limits** - Max 10 positions per agent
- **Drawdown Protection** - Auto-pause at 30% drawdown, liquidate at 80%
- **Market Hours Validation** - NYSE calendar with holiday detection
- **Price Validation** - Stale price detection (>30 min), suspicious movement alerts

#### Performance Analytics

- **Leaderboard** - Real-time rankings by total return, Sharpe ratio, win rate
- **Performance Metrics**: Total Return, Win Rate, Sharpe Ratio, Volatility, Max Drawdown, Profit Factor
- **Performance Charts** - Interactive portfolio value over time
- **Trade Analytics** - Recent trades with filters and sorting

#### Data Management

- **Persistent Storage** - All portfolios saved in localStorage with automatic trimming
- **Import/Export** - Download trading data as JSON for backup
- **Data Validation** - Comprehensive validation on import to prevent corruption
- **Memory Management** - Automatic cleanup of old trades/logs to prevent storage bloat

### 💾 Portfolio Tools

- **Save Analyses** - Store up to 50 analyses in localStorage
- **Watchlist** - Track up to 100 stocks with custom notes
- **Compare Stocks** - Side-by-side comparison of up to 4 saved analyses
- **Accuracy Tracker** - Track historical prediction accuracy
- **Export Data** - Download analysis and trading data as JSON

---

## 🚀 Quick Start

### Prerequisites

- Node.js 18+
- Gemini API key (required) - [Get free key](https://aistudio.google.com/apikey)
- FMP API key (optional) - [Get free key](https://financialmodelingprep.com/developer/docs/)

### Installation

```bash
git clone https://github.com/drix10/hypothesis-arena.git
cd hypothesis-arena
npm install
npm run dev
```

Open `http://localhost:5173`

### API Keys Setup

#### Option 1: Web UI (Recommended)

1. Open the app
2. Enter your **Gemini API key** (required)
3. Optionally enter your **FMP API key** (uses demo key if empty)
4. Click "Enter the Arena"

Keys are stored in memory only and cleared on page refresh.

#### Option 2: Environment Variables (Developers)

Create a `.env` file:

```env
# Gemini API Key (Required)
VITE_GEMINI_API_KEY=your_gemini_key_here

# FMP API Key (Optional - has fallback)
VITE_FMP_API_KEY=your_fmp_key_here
```

Restart dev server: `npm run dev`

---

## 📈 How It Works

### Analysis Flow

1. **Enter Stock Ticker** - Search any publicly traded stock (e.g., AAPL, MSFT, GOOGL)
2. **Data Collection** - Fetches price, fundamentals, technicals, news, and analyst ratings
3. **Thesis Generation** - Each of 8 AI analysts generates investment thesis
4. **Debate Tournament** - Quarterfinals, Semifinals, Final (3 rounds each with scoring)
5. **Consensus Recommendation** - Weighted by debate performance and confidence

### Trading Flow

1. **Trade Decision Generation** - Winners trade based on recommendation, losers hold
2. **Position Sizing** - Calculated based on confidence, cash, positions, and risk limits
3. **Trade Execution** - Market hours validated, price checked, limits enforced, trade recorded
4. **Portfolio Update** - Positions updated, metrics recalculated, performance snapshot created

---

## 🛠️ Scripts

| Command             | Description              |
| ------------------- | ------------------------ |
| `npm run dev`       | Start development server |
| `npm run build`     | Build for production     |
| `npm run preview`   | Preview production build |
| `npm run typecheck` | Check TypeScript types   |

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  
  **Built with React, TypeScript, Gemini 2.0, and Financial Modeling Prep**
  
  ⭐ Star if you find this useful • 🐛 Report bugs • 💡 Suggest features
  
  [GitHub](https://github.com/drix10/hypothesis-arena) • [Issues](https://github.com/drix10/hypothesis-arena/issues)
  
</div>
