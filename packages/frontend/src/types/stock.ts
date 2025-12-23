/**
 * Stock Investment Arena - Type Definitions
 * 
 * Comprehensive types for financial data, analysis, and recommendations.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// PRICE & QUOTE DATA
// ═══════════════════════════════════════════════════════════════════════════════

export interface StockQuote {
    ticker: string;
    name: string;
    price: number;
    previousClose: number;
    open: number;
    dayHigh: number;
    dayLow: number;
    volume: number;
    avgVolume: number;
    change: number;
    changePercent: number;
    marketCap: number;
    timestamp: number;
}

export interface HistoricalDataPoint {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    adjustedClose: number;
}

export interface HistoricalData {
    ticker: string;
    period: '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' | 'MAX';
    data: HistoricalDataPoint[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNDAMENTAL DATA
// ═══════════════════════════════════════════════════════════════════════════════

export interface Fundamentals {
    // Valuation Metrics
    peRatio: number | null;           // Price to Earnings
    pegRatio: number | null;          // PEG Ratio
    priceToBook: number | null;       // Price to Book
    priceToSales: number | null;      // Price to Sales
    enterpriseValue: number | null;   // Enterprise Value
    evToRevenue: number | null;       // EV/Revenue
    evToEbitda: number | null;        // EV/EBITDA

    // Profitability
    profitMargin: number | null;      // Net Profit Margin
    operatingMargin: number | null;   // Operating Margin
    grossMargin: number | null;       // Gross Margin
    returnOnEquity: number | null;    // ROE
    returnOnAssets: number | null;    // ROA

    // Growth
    revenueGrowth: number | null;     // YoY Revenue Growth
    earningsGrowth: number | null;    // YoY Earnings Growth

    // Financial Health
    currentRatio: number | null;      // Current Assets / Current Liabilities
    quickRatio: number | null;        // Quick Ratio
    debtToEquity: number | null;      // Debt to Equity
    freeCashFlow: number | null;

    // Per Share Data
    eps: number | null;               // Earnings Per Share (TTM)
    bookValue: number | null;         // Book Value Per Share
    revenuePerShare: number | null;

    // Dividends
    dividendYield: number | null;
    dividendRate: number | null;
    payoutRatio: number | null;

    // Shares
    sharesOutstanding: number | null;
    floatShares: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

export interface TechnicalIndicators {
    // Moving Averages
    sma20: number;
    sma50: number;
    sma200: number;
    ema12: number;
    ema26: number;

    // Momentum
    rsi14: number;                    // Relative Strength Index (14-day)
    macd: {
        macdLine: number;
        signalLine: number;
        histogram: number;
    };
    stochastic: {
        k: number;
        d: number;
    };

    // Volatility
    bollingerBands: {
        upper: number;
        middle: number;
        lower: number;
        width: number;
    };
    atr14: number;                    // Average True Range (14-day)
    volatility: number;               // Historical volatility

    // Trend
    trend: 'strong_uptrend' | 'uptrend' | 'sideways' | 'downtrend' | 'strong_downtrend';
    trendStrength: number;            // 0-100

    // Support & Resistance
    supportLevels: number[];
    resistanceLevels: number[];

    // Signals
    signals: TechnicalSignal[];
}

export interface TechnicalSignal {
    indicator: string;
    signal: 'bullish' | 'bearish' | 'neutral';
    strength: number;                 // 0-100
    description: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEWS & SENTIMENT
// ═══════════════════════════════════════════════════════════════════════════════

export interface NewsItem {
    id: string;
    title: string;
    summary: string;
    source: string;
    url: string;
    publishedAt: string;
    sentiment: 'positive' | 'negative' | 'neutral';
    sentimentScore: number;           // -1 to 1
    relevance: number;                // 0-1
}

export interface SentimentAnalysis {
    overallScore: number;             // -1 to 1
    overallSentiment: 'very_bearish' | 'bearish' | 'neutral' | 'bullish' | 'very_bullish';
    newsCount: number;
    positiveCount: number;
    negativeCount: number;
    neutralCount: number;
    recentNews: NewsItem[];
    socialMentions?: number;
    socialSentiment?: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYST RATINGS
// ═══════════════════════════════════════════════════════════════════════════════

export interface AnalystRatings {
    consensus: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    targetPrice: number | null;
    targetHigh: number | null;
    targetLow: number | null;
    targetMean: number | null;
    numberOfAnalysts: number;
    strongBuy: number;
    buy: number;
    hold: number;
    sell: number;
    strongSell: number;
    lastUpdated: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANY PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

export interface CompanyProfile {
    ticker: string;
    name: string;
    description: string;
    sector: string;
    industry: string;
    website: string;
    employees: number | null;
    headquarters: string;
    founded: string | null;
    ceo: string | null;
    exchange: string;
    currency: string;
    country: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AGGREGATED STOCK DATA
// ═══════════════════════════════════════════════════════════════════════════════

export interface StockAnalysisData {
    ticker: string;
    fetchedAt: number;

    // Core Data
    quote: StockQuote;
    profile: CompanyProfile;
    fundamentals: Fundamentals;

    // Historical
    historicalData: HistoricalData;

    // Analysis
    technicals: TechnicalIndicators;
    sentiment: SentimentAnalysis;
    analystRatings: AnalystRatings;

    // Data Quality
    dataQuality: {
        hasQuote: boolean;
        hasFundamentals: boolean;
        hasTechnicals: boolean;
        hasNews: boolean;
        hasAnalystRatings: boolean;
        warnings: string[];
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYST AGENT TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export type AnalystMethodology =
    | 'value'
    | 'growth'
    | 'technical'
    | 'macro'
    | 'sentiment'
    | 'risk'
    | 'quant'
    | 'contrarian';

export interface AnalystAgent {
    id: string;
    name: string;
    title: string;
    methodology: AnalystMethodology;
    avatarEmoji: string;
    description: string;
    focusAreas: string[];
    biases: string[];                 // Known biases to acknowledge
}

export interface PriceTarget {
    bull: number;                     // Optimistic case
    base: number;                     // Base case
    bear: number;                     // Pessimistic case
    timeframe: '3M' | '6M' | '1Y' | '2Y';
}

export interface InvestmentThesis {
    agentId: string;
    ticker: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;               // 0-100
    priceTarget: PriceTarget;

    // Arguments
    bullCase: string[];               // Key bullish arguments
    bearCase: string[];               // Key bearish arguments (acknowledged risks)
    keyMetrics: Record<string, string>; // Metrics supporting thesis

    // Catalysts & Risks
    catalysts: string[];              // Upcoming events that could move price
    risks: string[];                  // Key risks to thesis

    // Summary
    summary: string;                  // 2-3 sentence thesis summary
    detailedAnalysis: string;         // Full analysis text
}

// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT & DEBATE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface StockDebate {
    matchId: string;
    ticker: string;
    round: 'quarterfinal' | 'semifinal' | 'final';

    bullAnalyst: AnalystAgent;
    bearAnalyst: AnalystAgent;

    bullThesis: InvestmentThesis;
    bearThesis: InvestmentThesis;

    dialogue: DebateTurn[];

    winner: 'bull' | 'bear' | null;
    winningArguments: string[];

    scores: DebateScores;
}

export interface DebateTurn {
    speakerId: string;
    position: 'bull' | 'bear';
    content: string;
    dataPointsReferenced: string[];
    argumentStrength: number;
    timestamp: number;
}

export interface DebateScores {
    bullScore: number;
    bearScore: number;

    // Breakdown
    dataQuality: { bull: number; bear: number };
    logicCoherence: { bull: number; bear: number };
    riskAcknowledgment: { bull: number; bear: number };
    catalystIdentification: { bull: number; bear: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FINAL RECOMMENDATION
// ═══════════════════════════════════════════════════════════════════════════════

export interface FinalRecommendation {
    ticker: string;
    generatedAt: number;

    // Verdict
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;               // 0-100
    consensusStrength: number;        // How much analysts agreed (0-100)

    // Price Targets
    priceTarget: PriceTarget;
    currentPrice: number;
    upside: number;                   // % upside to base case

    // Position Sizing
    suggestedAllocation: number;      // % of portfolio (0-10)
    riskLevel: 'low' | 'medium' | 'high' | 'very_high';

    // Key Points
    topBullArguments: string[];
    topBearArguments: string[];
    keyRisks: string[];
    keyCatalysts: string[];

    // Dissent
    dissentingViews: {
        agentName: string;
        position: string;
        reasoning: string;
    }[];

    // Summary
    executiveSummary: string;

    // Metadata
    analystsContributed: number;
    debatesCompleted: number;
    dataSourcesUsed: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// APP STATE
// ═══════════════════════════════════════════════════════════════════════════════

export enum StockArenaState {
    IDLE = 'IDLE',
    ENTERING_TICKER = 'ENTERING_TICKER',
    FETCHING_DATA = 'FETCHING_DATA',
    GENERATING_ANALYSTS = 'GENERATING_ANALYSTS',
    RUNNING_TOURNAMENT = 'RUNNING_TOURNAMENT',
    GENERATING_RECOMMENDATION = 'GENERATING_RECOMMENDATION',
    COMPLETE = 'COMPLETE',
    ERROR = 'ERROR'
}

export interface StockArenaSession {
    sessionId: string;
    state: StockArenaState;
    ticker: string | null;
    stockData: StockAnalysisData | null;
    analysts: AnalystAgent[];
    theses: InvestmentThesis[];
    debates: StockDebate[];
    recommendation: FinalRecommendation | null;
    error: string | null;
    startedAt: number;
    completedAt: number | null;
}
