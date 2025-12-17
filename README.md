<div align="center">
  <br />
  
  # 🏆 Hypothesis Arena
  
  **AI-Powered Stock Investment Analysis**
  
  *8 AI analysts with different methodologies debate whether to buy, hold, or sell*
  
  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-blue?logo=typescript)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19.2-61dafb?logo=react)](https://react.dev/)
  [![Vite](https://img.shields.io/badge/Vite-6.2-646cff?logo=vite)](https://vitejs.dev/)
  
</div>

---

## 🎯 What is this?

Hypothesis Arena is an AI-powered stock analysis platform where 8 specialized analyst agents debate investment decisions. Each analyst has a unique methodology and perspective, creating a comprehensive view of any stock.

### The 8 Analysts

| Analyst                 | Methodology           | Focus                                                |
| ----------------------- | --------------------- | ---------------------------------------------------- |
| 🎩 **Warren**           | Value Investing       | P/E, P/B, FCF yield, moats, margin of safety         |
| 🚀 **Cathie**           | Growth Investing      | Revenue growth, TAM, disruption, innovation          |
| 📊 **Jim**              | Technical Analysis    | RSI, MACD, support/resistance, chart patterns        |
| 🌍 **Ray**              | Macro Strategy        | Interest rates, economic cycles, sector rotation     |
| 📱 **Elon**             | Sentiment Analysis    | News flow, social sentiment, analyst ratings         |
| 🛡️ **Karen**            | Risk Management       | Volatility, drawdown, debt, worst-case scenarios     |
| 🤖 **Quant**            | Quantitative Analysis | Factor exposures, statistics, correlations           |
| 😈 **Devil's Advocate** | Contrarian            | Consensus challenges, crowded trades, narrative gaps |

---

## ✨ Features

- **Real Market Data** - Live quotes, fundamentals, and technicals from Yahoo Finance (no API key needed)
- **Technical Indicators** - RSI, MACD, Bollinger Bands, SMA/EMA, support/resistance levels
- **News Sentiment** - Aggregated news with sentiment scoring
- **8 AI Perspectives** - Each analyst generates a unique thesis with price targets
- **Bull vs Bear Debates** - Multi-turn debates with data references and scoring
- **Consensus Recommendation** - Weighted by debate performance and confidence
- **Price Targets** - Bull/Base/Bear scenarios with confidence intervals
- **Risk Assessment** - Portfolio allocation suggestions based on risk level
- **Dissenting Views** - Minority opinions are preserved and highlighted

---

## 🚀 Quick Start

**Prerequisites:** Node.js 18+ and a Gemini API key ([get one free](https://aistudio.google.com/apikey))

```bash
git clone https://github.com/drix10/hypothesis-arena.git
cd hypothesis-arena
npm install
npm run dev
```

Open `http://localhost:5173` and enter your API key when prompted.

---

## 📊 How It Works

1. **Enter a Stock Ticker** - Search for any publicly traded stock (e.g., AAPL, MSFT, GOOGL)

2. **Data Collection** - The system fetches:

   - Current price and quote data
   - Company fundamentals (P/E, revenue, margins, etc.)
   - Technical indicators (RSI, MACD, moving averages)
   - Recent news and sentiment
   - Wall Street analyst ratings

3. **Thesis Generation** - Each of the 8 AI analysts generates their investment thesis based on their methodology

4. **Debate Tournament** - Bulls vs Bears debate in a tournament format:

   - Quarterfinals (4 matches)
   - Semifinals (2 matches)
   - Final (1 match)

5. **Final Recommendation** - A consensus recommendation is generated, weighted by:
   - Debate performance
   - Analyst confidence
   - Argument strength

---

## 🏗️ Architecture

```
src/
├── services/
│   ├── data/                   # Market data services
│   │   ├── yahooFinance.ts     # Yahoo Finance API
│   │   ├── newsService.ts      # News & sentiment
│   │   ├── technicalAnalysis.ts # RSI, MACD, etc.
│   │   └── stockDataAggregator.ts
│   └── stock/                  # Analysis services
│       ├── analystService.ts   # AI thesis generation
│       ├── stockTournamentService.ts # Debate tournament
│       └── recommendationService.ts  # Final synthesis
├── components/
│   └── stock/                  # UI components
│       ├── StockArena.tsx      # Main orchestration
│       ├── TickerInput.tsx     # Stock search
│       ├── StockHeader.tsx     # Price display
│       ├── AnalystCard.tsx     # Analyst thesis
│       ├── DebateView.tsx      # Debate visualization
│       └── RecommendationCard.tsx # Final verdict
├── constants/
│   └── analystPrompts.ts       # 8 analyst personalities
└── types/
    └── stock.ts                # Type definitions
```

---

## 📈 Output

The final recommendation includes:

- **Verdict** - Strong Buy / Buy / Hold / Sell / Strong Sell
- **Confidence** - 0-100% based on analyst consensus
- **Price Targets** - Bull, Base, Bear scenarios (12-month)
- **Upside/Downside** - Percentage to base case target
- **Risk Level** - Low / Medium / High / Very High
- **Suggested Allocation** - Portfolio percentage (0-10%)
- **Top Arguments** - Key bull and bear points
- **Key Risks** - Most cited risk factors
- **Catalysts** - Upcoming events that could move the stock
- **Dissenting Views** - Analysts who disagreed with consensus
- **Executive Summary** - 2-3 sentence conclusion

---

## 🛠️ Scripts

| Command           | Description              |
| ----------------- | ------------------------ |
| `npm run dev`     | Start development server |
| `npm run build`   | Build for production     |
| `npm run preview` | Preview production build |

---

## 🔒 Security

- API key stored in memory only (cleared on refresh)
- All API calls are client-side (no backend)
- Market data from public Yahoo Finance endpoints
- No personal data collected

---

## 📜 License

MIT License - see [LICENSE](LICENSE) for details.

---

<div align="center">
  
  **Built with React, TypeScript, Gemini 2.0, and Yahoo Finance**
  
  ⭐ Star if you find this useful
  
</div>
