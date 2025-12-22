/**
 * Analyst Service - ENHANCED
 * 
 * Generates investment theses from the 8 analyst agents using AI.
 * Each analyst receives relevant data and generates their unique perspective.
 * 
 * ENHANCEMENTS:
 * - Richer data formatting with contextual interpretation
 * - Better prompt engineering for higher quality outputs
 * - Improved parsing with validation
 */

import { GoogleGenAI, Type } from '@google/genai';
import {
    AnalystAgent,
    AnalystMethodology,
    InvestmentThesis,
    StockAnalysisData,
    PriceTarget
} from '../../types/stock';
import {
    ANALYST_PROFILES,
    THESIS_SYSTEM_PROMPTS,
    ANALYST_DATA_FOCUS,
    buildThesisPrompt,
    getAllAnalysts
} from '../../constants/analystPrompts';
import { logger } from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ThesisGenerationResult {
    analyst: AnalystAgent;
    thesis: InvestmentThesis | null;
    error: string | null;
}

interface ParsedThesis {
    recommendation: string;
    confidence: number;
    priceTarget: { bull: number; base: number; bear: number };
    bullCase: string[];
    bearCase: string[];
    keyMetrics: string[];  // Changed from Record<string, string> to string[]
    catalysts: string[];
    summary: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURED OUTPUT SCHEMAS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * JSON Schema for thesis generation - ensures structured, parseable output
 */
const THESIS_SCHEMA = {
    type: Type.OBJECT,
    properties: {
        recommendation: {
            type: Type.STRING,
            description: 'Investment recommendation',
            enum: ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL']
        },
        confidence: {
            type: Type.NUMBER,
            description: 'Confidence level from 0 to 100'
        },
        priceTarget: {
            type: Type.OBJECT,
            properties: {
                bull: { type: Type.NUMBER, description: 'Optimistic price target' },
                base: { type: Type.NUMBER, description: 'Base case price target' },
                bear: { type: Type.NUMBER, description: 'Pessimistic price target' }
            },
            required: ['bull', 'base', 'bear']
        },
        bullCase: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Key bullish arguments (3-5 points)'
        },
        bearCase: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Key bearish arguments/risks (3-5 points)'
        },
        keyMetrics: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Key metrics supporting the thesis as "metric: value" strings (e.g., "P/E: 25.3", "Revenue Growth: 15%")'
        },
        catalysts: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: 'Upcoming catalysts that could move the stock (1-3 points)'
        },
        summary: {
            type: Type.STRING,
            description: '2-3 sentence thesis summary'
        }
    },
    required: ['recommendation', 'confidence', 'priceTarget', 'bullCase', 'bearCase', 'summary']
};

// ═══════════════════════════════════════════════════════════════════════════════
// ENHANCED DATA FORMATTING FOR LLM CONSUMPTION
// ═══════════════════════════════════════════════════════════════════════════════

function formatMetric(value: number | null | undefined, decimals: number = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    return value.toFixed(decimals);
}

function formatPercent(value: number | null | undefined, isAlreadyPercent: boolean = false): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    const pct = isAlreadyPercent ? value : value * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
}

function formatLargeNumber(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    if (value >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
    if (value >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
    if (value >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
    if (value >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
    return '$' + value.toFixed(0);
}

function formatPrice(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
    return '$' + value.toFixed(2);
}

/** Get valuation context */
function getValuationContext(peRatio: number | null): string {
    if (peRatio === null) return '';
    if (peRatio < 0) return '(negative earnings)';
    if (peRatio < 10) return '(deep value)';
    if (peRatio < 15) return '(below market avg)';
    if (peRatio < 20) return '(market avg)';
    if (peRatio < 30) return '(growth premium)';
    if (peRatio < 50) return '(high growth)';
    return '(extreme valuation)';
}

/** Get RSI interpretation */
function getRSIContext(rsi: number): string {
    if (rsi < 20) return 'EXTREMELY OVERSOLD';
    if (rsi < 30) return 'OVERSOLD';
    if (rsi < 40) return 'Approaching oversold';
    if (rsi < 60) return 'Neutral';
    if (rsi < 70) return 'Approaching overbought';
    if (rsi < 80) return 'OVERBOUGHT';
    return 'EXTREMELY OVERBOUGHT';
}

/** Get trend context */
function getTrendContext(price: number, sma20: number, sma50: number, sma200: number): string {
    const contexts: string[] = [];

    // Short-term trend (20-day)
    if (sma20 > 0) {
        const pctFrom20 = ((price - sma20) / sma20) * 100;
        if (Math.abs(pctFrom20) > 3) {
            contexts.push(price > sma20
                ? `${pctFrom20.toFixed(1)}% above 20-MA (short-term bullish)`
                : `${Math.abs(pctFrom20).toFixed(1)}% below 20-MA (short-term bearish)`);
        }
    }

    // Long-term trend (200-day)
    if (sma200 > 0) {
        const pctFrom200 = ((price - sma200) / sma200) * 100;
        contexts.push(price > sma200
            ? `${pctFrom200.toFixed(1)}% above 200-MA (bullish)`
            : `${Math.abs(pctFrom200).toFixed(1)}% below 200-MA (bearish)`);
    }

    // Golden/Death Cross
    if (sma50 > 0 && sma200 > 0) {
        contexts.push(sma50 > sma200 ? 'Golden Cross active' : 'Death Cross active');
    }

    return contexts.join(' | ');
}

/** Safely get state from localStorage if in browser */
function getTradingState(): Record<string, any> | null {
    if (typeof window === 'undefined') return null;
    try {
        const state = localStorage.getItem('tradingSystemState');
        if (!state) return null;

        // FIX: Validate JSON structure before returning
        const parsed = JSON.parse(state);

        // Basic validation - ensure it's an object
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            logger.warn('Invalid trading state structure in localStorage');
            return null;
        }

        return parsed;
    } catch (e) {
        // FIX: Log the error for debugging
        logger.warn('Failed to parse trading state from localStorage:', e);
        return null;
    }
}

/** Format analyst's personal performance for the prompt */
function formatPerformanceContext(methodology: string): string {
    const state = getTradingState();
    if (!state) return '';

    const stats = state.stats?.[methodology];
    if (!stats) return '';

    // FIX: Validate all stats values before using them
    const winRate = typeof stats.winRate === 'number' && Number.isFinite(stats.winRate) ? stats.winRate : null;
    const wins = typeof stats.wins === 'number' && Number.isFinite(stats.wins) ? stats.wins : 0;
    const losses = typeof stats.losses === 'number' && Number.isFinite(stats.losses) ? stats.losses : 0;
    const avgReturn = typeof stats.avgReturn === 'number' && Number.isFinite(stats.avgReturn) ? stats.avgReturn : null;
    const sharpe = typeof stats.sharpe === 'number' && Number.isFinite(stats.sharpe) ? stats.sharpe : null;
    const totalTrades = typeof stats.totalTrades === 'number' && Number.isFinite(stats.totalTrades) ? stats.totalTrades : 0;

    // FIX: Safely find ranking
    let rank: string | number = 'N/A';
    if (Array.isArray(state.rankings)) {
        const rankEntry = state.rankings.find((r: any) => r?.methodology === methodology);
        if (rankEntry && typeof rankEntry.rank === 'number' && Number.isFinite(rankEntry.rank)) {
            rank = rankEntry.rank;
        }
    }

    return `═══ YOUR PERFORMANCE TRACK RECORD ═══
• WIN RATE: ${winRate !== null ? formatPercent(winRate, true) : 'N/A'} (${wins} wins / ${losses} losses)
• AVG RETURN: ${avgReturn !== null ? formatPercent(avgReturn, true) : 'N/A'}
• SHARPE RATIO: ${sharpe !== null ? formatMetric(sharpe) : 'N/A'}
• TOTAL TRADES: ${totalTrades}
• RANKING: ${rank} among 8 analysts
`;
}

/** Format current portfolio holdings for the prompt */
function formatPortfolioContext(methodology: string): string {
    const state = getTradingState();
    if (!state) return '';

    // Try to get analyst-specific portfolio first
    const analystPortfolio = state.portfolios?.[methodology];
    const portfolio = analystPortfolio || state.portfolio;

    if (!portfolio) return '';

    const holdings = portfolio.holdings || portfolio.positions || [];

    // FIX: Validate holdings is actually an array
    if (!Array.isArray(holdings) || holdings.length === 0) {
        return '• CURRENT PORTFOLIO: Cash Only (100% liquidity)';
    }

    // FIX: Filter out invalid holdings and safely access properties
    const validHoldings = holdings.filter((h: any) => h && typeof h.ticker === 'string');
    if (validHoldings.length === 0) {
        return '• CURRENT PORTFOLIO: Cash Only (100% liquidity)';
    }

    const totalValue = typeof portfolio.totalValue === 'number' && Number.isFinite(portfolio.totalValue) && portfolio.totalValue > 0
        ? portfolio.totalValue
        : null;

    const list = validHoldings.slice(0, 5).map((h: any) => {
        let weight = 0;
        if (typeof h.weight === 'number' && Number.isFinite(h.weight)) {
            weight = h.weight;
        } else if (typeof h.marketValue === 'number' && Number.isFinite(h.marketValue) && totalValue) {
            weight = h.marketValue / totalValue;
        }
        return `${h.ticker} (${formatPercent(weight, true)})`;
    }).join(', ');

    // FIX: Safely get cash and drawdown values
    const cash = portfolio.cash ?? portfolio.currentCash;
    const safeCash = typeof cash === 'number' && Number.isFinite(cash) ? cash : 0;
    const safeDrawdown = typeof portfolio.currentDrawdown === 'number' && Number.isFinite(portfolio.currentDrawdown)
        ? portfolio.currentDrawdown
        : 0;

    return `═══ YOUR PORTFOLIO STATUS ═══
• CURRENT TOP HOLDINGS: ${list}${validHoldings.length > 5 ? '...' : ''}
• PORTFOLIO CONCENTRATION: ${validHoldings.length} tickers
• CASH BALANCE: ${formatLargeNumber(safeCash)}
• TOTAL VALUE: ${totalValue ? formatLargeNumber(totalValue) : 'N/A'}
• CURRENT DRAWDOWN: ${formatPercent(safeDrawdown, true)}`;
}

/** Format historical price performance summary */
function formatHistoricalSummary(data: StockAnalysisData): string {
    const hist = data.historicalData?.data ?? [];
    if (hist.length < 5) return '';

    const currentPrice = data.quote?.price ?? 0;
    if (currentPrice <= 0) return '';

    // Calculate returns over different periods
    // FIX: Handle edge case where hist.length - 1 - idx could be negative
    const getReturn = (daysAgo: number): string => {
        const targetIdx = hist.length - 1 - daysAgo;
        if (targetIdx < 0 || targetIdx >= hist.length) return 'N/A';
        const dataPoint = hist[targetIdx];
        if (!dataPoint || typeof dataPoint.close !== 'number') return 'N/A';
        const oldPrice = dataPoint.close;
        if (oldPrice <= 0 || !Number.isFinite(oldPrice)) return 'N/A';
        const ret = ((currentPrice - oldPrice) / oldPrice) * 100;
        if (!Number.isFinite(ret)) return 'N/A';
        return `${ret >= 0 ? '+' : ''}${ret.toFixed(1)}%`;
    };

    // Calculate 52-week high/low from available data
    // FIX: Handle empty prices array to avoid Math.max/min returning Infinity/-Infinity
    const prices = hist
        .map(d => d?.close)
        .filter((p): p is number => typeof p === 'number' && p > 0 && Number.isFinite(p));

    if (prices.length === 0) return '';

    const high52w = Math.max(...prices);
    const low52w = Math.min(...prices);

    // FIX: Validate high/low are finite before calculations
    const fromHigh = Number.isFinite(high52w) && high52w > 0
        ? ((currentPrice - high52w) / high52w * 100).toFixed(1)
        : 'N/A';
    const fromLow = Number.isFinite(low52w) && low52w > 0
        ? ((currentPrice - low52w) / low52w * 100).toFixed(1)
        : 'N/A';

    // Calculate average volume trend
    // FIX: Handle case where slice returns empty array (division by actual count, not fixed number)
    const recentSlice = hist.slice(-20);
    const olderSlice = hist.slice(-60, -20);

    const recentVolSum = recentSlice.reduce((sum, d) => sum + (d?.volume || 0), 0);
    const olderVolSum = olderSlice.reduce((sum, d) => sum + (d?.volume || 0), 0);

    const recentVol = recentSlice.length > 0 ? recentVolSum / recentSlice.length : 0;
    const olderVol = olderSlice.length > 0 ? olderVolSum / olderSlice.length : 0;

    const volTrend = olderVol > 0 && Number.isFinite(recentVol) && Number.isFinite(olderVol)
        ? ((recentVol - olderVol) / olderVol * 100).toFixed(0)
        : 'N/A';

    return `═══ HISTORICAL PRICE PERFORMANCE ═══
• 1-WEEK RETURN: ${getReturn(5)}
• 1-MONTH RETURN: ${getReturn(21)}
• 3-MONTH RETURN: ${getReturn(63)}
• 6-MONTH RETURN: ${getReturn(126)}
• 52-WEEK RANGE: ${formatPrice(low52w)} - ${formatPrice(high52w)}
• FROM 52W HIGH: ${fromHigh}% | FROM 52W LOW: ${fromLow === 'N/A' ? 'N/A' : (parseFloat(fromLow) >= 0 ? '+' + fromLow : fromLow)}%
• VOLUME TREND (20d vs 60d): ${volTrend}%
`;
}

/** Format risk management context */
function formatRiskContext(methodology: string, ticker: string): string {
    const state = getTradingState();
    if (!state) return '';

    const portfolio = state.portfolios?.[methodology];
    if (!portfolio) return '';

    const position = portfolio.positions?.find((p: any) => p?.ticker === ticker);
    const rules = state.riskManagementRules;
    const sizingRules = state.positionSizingRules;

    if (!position) {
        // FIX: Validate all values before using them
        const maxPosPercent = typeof sizingRules?.maxPositionPercent === 'number' && Number.isFinite(sizingRules.maxPositionPercent)
            ? (sizingRules.maxPositionPercent * 100).toFixed(0)
            : '20';
        const maxInvested = typeof sizingRules?.maxTotalInvested === 'number' && Number.isFinite(sizingRules.maxTotalInvested)
            ? (sizingRules.maxTotalInvested * 100).toFixed(0)
            : '80';
        const stopLossPercent = typeof rules?.stopLossPercent === 'number' && Number.isFinite(rules.stopLossPercent)
            ? (rules.stopLossPercent * 100).toFixed(0)
            : '15';
        const takeProfitPercent = typeof rules?.takeProfitPercent === 'number' && Number.isFinite(rules.takeProfitPercent)
            ? (rules.takeProfitPercent * 100).toFixed(0)
            : '25';

        return `═══ RISK MANAGEMENT RULES ═══
• MAX POSITION SIZE: ${maxPosPercent}% of portfolio
• MAX TOTAL INVESTED: ${maxInvested}%
• STOP-LOSS: ${rules?.enableStopLoss ? `${stopLossPercent}%` : 'DISABLED'}
• TAKE-PROFIT: ${rules?.enableTakeProfit ? `${takeProfitPercent}%` : 'DISABLED'}
`;
    }

    // FIX: Validate position data before calculations
    const avgCostBasis = typeof position.avgCostBasis === 'number' && Number.isFinite(position.avgCostBasis) && position.avgCostBasis > 0
        ? position.avgCostBasis
        : null;

    const stopLossPercent = typeof rules?.stopLossPercent === 'number' && Number.isFinite(rules.stopLossPercent)
        ? rules.stopLossPercent
        : 0.15;
    const takeProfitPercent = typeof rules?.takeProfitPercent === 'number' && Number.isFinite(rules.takeProfitPercent)
        ? rules.takeProfitPercent
        : 0.25;

    const stopPrice = rules?.enableStopLoss && avgCostBasis
        ? avgCostBasis * (1 - stopLossPercent)
        : null;
    const targetPrice = rules?.enableTakeProfit && avgCostBasis
        ? avgCostBasis * (1 + takeProfitPercent)
        : null;

    // FIX: Safely format position values
    const shares = typeof position.shares === 'number' && Number.isFinite(position.shares) ? position.shares : 0;
    const unrealizedPnL = typeof position.unrealizedPnL === 'number' && Number.isFinite(position.unrealizedPnL)
        ? position.unrealizedPnL : 0;
    const unrealizedPnLPercent = typeof position.unrealizedPnLPercent === 'number' && Number.isFinite(position.unrealizedPnLPercent)
        ? position.unrealizedPnLPercent : 0;
    const drawdownFromHigh = typeof position.drawdownFromHigh === 'number' && Number.isFinite(position.drawdownFromHigh)
        ? position.drawdownFromHigh : 0;

    return `═══ EXISTING POSITION RISK ═══
• CURRENT POSITION: ${shares} shares @ ${avgCostBasis ? formatPrice(avgCostBasis) : 'N/A'} avg
• UNREALIZED P&L: ${formatLargeNumber(unrealizedPnL)} (${formatPercent(unrealizedPnLPercent, true)})
• DRAWDOWN FROM HIGH: ${formatPercent(drawdownFromHigh, true)}
• STOP-LOSS LEVEL: ${stopPrice ? formatPrice(stopPrice) : 'DISABLED'}
• TAKE-PROFIT LEVEL: ${targetPrice ? formatPrice(targetPrice) : 'DISABLED'}
`;
}

/**
 * Format stock data for a specific analyst's focus areas
 * ENHANCED: More structured, contextual, and actionable data
 */
function formatDataForAnalyst(
    data: StockAnalysisData,
    methodology: AnalystMethodology
): string {
    const focus = ANALYST_DATA_FOCUS[methodology];
    const sections: string[] = [];
    const price = data.quote?.price ?? 0;

    // Helper for Quant Factors
    const getQuantFactors = () => {
        const f = data.fundamentals;
        const t = data.technicals;

        // Value
        const pe = f?.peRatio ?? 0;
        const valueSignal = (pe > 0 && pe < 15) ? 'BULLISH' : (pe > 50) ? 'BEARISH' : 'NEUTRAL';

        // Quality
        const roe = f?.returnOnEquity ?? 0;
        const qualSignal = (roe > 0.15) ? 'BULLISH' : (roe < 0.05) ? 'BEARISH' : 'NEUTRAL';

        // Momentum
        const momSignal = (t?.trend === 'uptrend' || t?.trend === 'strong_uptrend') ? 'BULLISH' : 'BEARISH';

        // FIX: Safe calculation for vs SMA200 - avoid division by zero
        const sma200 = t?.sma200 ?? 0;
        const vsSma200 = sma200 > 0 && Number.isFinite(price) && Number.isFinite(sma200)
            ? formatPercent((price - sma200) / sma200)
            : 'N/A';

        // FIX: Safe volatility display
        const volatility = typeof t?.volatility === 'number' && Number.isFinite(t.volatility)
            ? t.volatility.toFixed(1)
            : 'N/A';
        const volRank = (t?.volatility ?? 0) > 40 ? 'High' : 'Low';

        return `═══ QUANT FACTOR MODEL ═══
• VALUE: ${valueSignal} (P/E: ${formatMetric(pe)}, P/B: ${formatMetric(f?.priceToBook)})
• QUALITY: ${qualSignal} (ROE: ${formatPercent(roe)}, Net Margin: ${formatPercent(f?.profitMargin)})
• MOMENTUM: ${momSignal} (RSI: ${t?.rsi14?.toFixed(1) ?? 'N/A'}, vs SMA200: ${vsSma200})
• VOLATILITY: ${volatility}% (Rank: ${volRank})
• STATISTICAL EDGE: ${(valueSignal === 'BULLISH' && momSignal === 'BULLISH') ? 'STRONG (Value + Momentum)' : 'NEUTRAL'}
`;
    };

    // Helper for Macro Context
    const getMacroContext = () => {
        const sector = data.profile?.sector || 'Unknown';
        const isCyclical = ['Technology', 'Consumer Cyclical', 'Financial Services', 'Basic Materials', 'Industrials'].includes(sector);
        const isDefensive = ['Utilities', 'Consumer Defensive', 'Healthcare'].includes(sector);
        const isRateSensitive = ['Utilities', 'Real Estate', 'Financial Services'].includes(sector);

        return `═══ MACRO & SECTOR CONTEXT ═══
• SECTOR: ${sector}
• CYCLICALITY: ${isCyclical ? 'Cyclical (Economy Dependent)' : isDefensive ? 'Defensive (Resilient)' : 'Neutral'}
• INFLATION SENSITIVITY: ${['Energy', 'Basic Materials', 'Real Estate'].includes(sector) ? 'HIGH (Real Asset)' : 'LOW'}
• RATE SENSITIVITY: ${isRateSensitive ? 'HIGH (Bond Proxy/Financial)' : 'MODERATE'}
• SUPPLY CHAIN EXPOSURE: ${['Technology', 'Industrials', 'Consumer Cyclical'].includes(sector) ? 'HIGH' : 'LOW'}
`;
    };

    // Helper for Value Context
    const getValueContext = () => {
        const f = data.fundamentals;
        const eps = f?.eps ?? 0;
        const bv = f?.bookValue ?? 0;
        const grahamNumber = (eps > 0 && bv > 0) ? Math.sqrt(22.5 * eps * bv) : 0;
        const priceToGraham = (grahamNumber > 0 && Number.isFinite(price)) ? price / grahamNumber : 0;

        // FIX: Safe FCF Yield calculation
        const fcf = f?.freeCashFlow ?? 0;
        const marketCap = data.quote?.marketCap ?? 0;
        const fcfYield = (marketCap > 0 && Number.isFinite(fcf) && Number.isFinite(marketCap))
            ? ((fcf / marketCap) * 100).toFixed(2) + '%'
            : 'N/A';

        return `═══ VALUE INVESTOR CONTEXT ═══
• INTRINSIC VALUE INPUTS:
  - EPS: ${formatPrice(eps)} | Book Value: ${formatPrice(bv)}
  - Graham Number (Rough Fair Value): ${grahamNumber > 0 ? formatPrice(grahamNumber) : 'N/A (Negative Earnings/Equity)'}
  - Price/Graham: ${grahamNumber > 0 ? priceToGraham.toFixed(2) + 'x' : 'N/A'} ${priceToGraham < 1 && priceToGraham > 0 ? '(UNDERVALUED)' : ''}
• MOAT INDICATORS:
  - Gross Margin: ${formatPercent(f?.grossMargin)} (${(f?.grossMargin ?? 0) > 0.5 ? 'WIDE MOAT Potential' : 'Review durability'})
  - ROE: ${formatPercent(f?.returnOnEquity)} (${(f?.returnOnEquity ?? 0) > 0.15 ? 'Excellent Returns' : 'Average'})
• SAFETY:
  - Debt/Equity: ${formatMetric(f?.debtToEquity)} (${(f?.debtToEquity ?? 0) < 0.5 ? 'Fortress Balance Sheet' : 'Leveraged'})
  - FCF Yield: ${fcfYield}
`;
    };

    // Helper for Growth Context
    const getGrowthContext = () => {
        const f = data.fundamentals;
        const revGrowth = (f?.revenueGrowth ?? 0) * 100;
        const netMargin = (f?.profitMargin ?? 0) * 100;
        const ruleOf40 = revGrowth + netMargin;

        return `═══ GROWTH INVESTOR CONTEXT ═══
• GROWTH TRAJECTORY:
  - Revenue Growth: ${revGrowth.toFixed(1)}% ${(revGrowth > 30) ? '(HYPERGROWTH 🚀)' : (revGrowth > 15) ? '(Solid Growth)' : '(Slowing/Mature)'}
  - PEG Ratio: ${formatMetric(f?.pegRatio)} ${(f?.pegRatio ?? 0) < 1.5 ? '(Growth at Reasonable Price)' : 'Premium Valuation'}
• RULE OF 40 SCORE: ${ruleOf40.toFixed(1)}
  - Status: ${ruleOf40 > 40 ? 'PASS (Efficient Growth)' : 'FAIL (Burn/Inefficient)'}
• INNOVATION FUNDAMENTALS:
  - R&D Intensity: Check income statement (High R&D = Innovation Investment)
  - Gross Margin Profile: ${formatPercent(f?.grossMargin)} (Software-like margins = >70%)
`;
    };

    // Helper for Technical Context
    const getTechnicalContext = () => {
        const t = data.technicals;
        const trend = (t?.trend ?? 'sideways').toUpperCase();
        const rsi = t?.rsi14 ?? 50;

        return `═══ TECHNICAL ANALYST CONTEXT ═══
• TREND DISCIPLINE: ${trend} (Strength: ${t?.trendStrength}/100)
• MOMENTUM CHECK:
  - RSI: ${rsi.toFixed(1)} (${getRSIContext(rsi)})
  - MACD Histogram: ${formatMetric(t?.macd?.histogram)} (${(t?.macd?.histogram ?? 0) > 0 ? 'Bullish Expansion' : 'Bearish Contraction'})
• VOLATILITY: ATR: ${formatPrice(t?.atr14)} | Volatility: ${formatMetric(t?.volatility)}%
• KEY LEVELS TO WATCH:
  - Support: ${t?.supportLevels?.[0] ? formatPrice(t.supportLevels[0]) : 'N/A'}
  - Resistance: ${t?.resistanceLevels?.[0] ? formatPrice(t.resistanceLevels[0]) : 'N/A'}
`;
    };

    // Helper for Sentiment Context
    const getSentimentContext = () => {
        const s = data.sentiment;
        const score = s?.overallScore ?? 0;

        // Defensive checks for extended properties
        const socialVolume = (s as any)?.socialVolume ?? 'Average';
        const buzzScore = (s as any)?.buzzScore ?? 'Normal';

        return `═══ SENTIMENT & PSYCHOLOGY CONTEXT ═══
• MARKET VIBE: ${score > 0.3 ? 'EUPHORIC' : score < -0.3 ? 'PANIC' : 'NEUTRAL'} (Score: ${score.toFixed(2)})
• ATTENTION ATTRIBUTE:
  - Social Volume: ${socialVolume}
  - Mention Buzz: ${buzzScore}
• CONTRARIAN SIGNAL: ${Math.abs(score) > 0.6 ? 'EXTREME (High reversal probability)' : 'MODERATE (Follow the trend)'}
`;
    };

    // Helper for Risk Context
    const getRiskContext = () => {
        const f = data.fundamentals;
        const t = data.technicals;
        const beta = (f as any)?.beta ?? 1.0;

        return `═══ RISK OFFICER CONTEXT ═══
• DOWNSIDE PROTECTION:
  - Debt/Equity: ${formatMetric(f?.debtToEquity)} (${(f?.debtToEquity ?? 0) > 1.5 ? 'WARNING: High Leverage' : 'Safety: Controlled Debt'})
  - Current Ratio: ${formatMetric(f?.currentRatio)} (${(f?.currentRatio ?? 0) < 1.0 ? 'LIQUIDITY CRUNCH RISK' : 'Healthy Liquidity'})
• VOLATILITY RISK:
  - Beta: ${formatMetric(beta)} (${beta > 1.5 ? 'Aggressive/Volatile' : 'Defensive/Stable'})
  - Max Expected Drawdown (Est): ${((t?.volatility ?? 0) * 0.5).toFixed(1)}% (1-std deviation event)
`;
    };

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 1: PRICE & MARKET DATA (Always included)
    // ═══════════════════════════════════════════════════════════════════════════
    const changePercent = data.quote?.changePercent ?? 0;
    const volumeRatio = (data.quote?.avgVolume ?? 0) > 0
        ? ((data.quote?.volume ?? 0) / data.quote.avgVolume).toFixed(2)
        : 'N/A';

    sections.push(
        `═══ CURRENT MARKET DATA ═══
Price: ${formatPrice(price)} (${formatPercent(changePercent, true)} today)
Market Cap: ${formatLargeNumber(data.quote?.marketCap)}
Volume: ${formatLargeNumber(data.quote?.volume)} (${volumeRatio}x avg)
Day Range: ${formatPrice(data.quote?.dayLow)} - ${formatPrice(data.quote?.dayHigh)}`
    );

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 2: COMPANY PROFILE
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('profile') || focus.secondary.includes('profile')) {
        const desc = data.profile?.description || '';
        const truncatedDesc = desc.length > 400 ? desc.slice(0, 400) + '...' : desc;
        const sector = data.profile?.sector || '(Not available)';
        const industry = data.profile?.industry || '(Not available)';
        const exchange = data.profile?.exchange || '(Not available)';

        sections.push(
            `═══ COMPANY PROFILE ═══
Name: ${data.profile?.name ?? data.profile?.ticker ?? 'Unknown'}
Sector: ${sector} | Industry: ${industry}
Employees: ${data.profile?.employees?.toLocaleString() ?? 'N/A'}
Exchange: ${exchange}

Description: ${truncatedDesc || 'No description available'}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 3: FUNDAMENTALS (Enhanced with context)
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('fundamentals') || focus.secondary.includes('fundamentals')) {
        const f = data.fundamentals;
        const peContext = getValuationContext(f?.peRatio ?? null);

        const fcfYield = (f?.freeCashFlow && data.quote?.marketCap && data.quote.marketCap > 0)
            ? ((f.freeCashFlow / data.quote.marketCap) * 100).toFixed(2) + '%'
            : 'N/A';

        sections.push(
            `═══ FUNDAMENTAL ANALYSIS ═══

VALUATION:
• P/E (TTM): ${formatMetric(f?.peRatio)} ${peContext}
• PEG Ratio: ${formatMetric(f?.pegRatio)} ${f?.pegRatio && f.pegRatio < 1 ? '(undervalued)' : f?.pegRatio && f.pegRatio > 2 ? '(expensive)' : ''}
• P/B: ${formatMetric(f?.priceToBook)}
• EV/EBITDA: ${formatMetric(f?.evToEbitda)}

PROFITABILITY:
• Gross Margin: ${formatPercent(f?.grossMargin)}
• Operating Margin: ${formatPercent(f?.operatingMargin)}
• Net Margin: ${formatPercent(f?.profitMargin)}
• ROE: ${formatPercent(f?.returnOnEquity)} ${f?.returnOnEquity && f.returnOnEquity > 0.15 ? '(excellent)' : ''}
• ROA: ${formatPercent(f?.returnOnAssets)}

GROWTH:
• Revenue Growth: ${formatPercent(f?.revenueGrowth)}
• Earnings Growth: ${formatPercent(f?.earningsGrowth)}

FINANCIAL HEALTH:
• Debt/Equity: ${formatMetric(f?.debtToEquity)} ${f?.debtToEquity && f.debtToEquity > 1 ? '(high leverage)' : ''}
• Current Ratio: ${formatMetric(f?.currentRatio)} ${f?.currentRatio && f.currentRatio < 1 ? '(liquidity risk)' : ''}
• FCF: ${formatLargeNumber(f?.freeCashFlow)}
• FCF Yield: ${fcfYield}

PER SHARE:
• EPS: ${formatPrice(f?.eps)}
• Book Value: ${formatPrice(f?.bookValue)}
• Dividend Yield: ${formatPercent(f?.dividendYield)}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 4: TECHNICAL ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('technicals') || focus.secondary.includes('technicals')) {
        const t = data.technicals;
        const rsi = t?.rsi14 ?? 50;
        const sma20 = t?.sma20 ?? 0;
        const sma50 = t?.sma50 ?? 0;
        const sma200 = t?.sma200 ?? 0;

        const rsiContext = getRSIContext(rsi);
        const trendContext = getTrendContext(price, sma20, sma50, sma200);

        const macdSignal = (t?.macd?.histogram ?? 0) > 0 ? 'BULLISH' : 'BEARISH';

        const bbPosition = t?.bollingerBands
            ? price < t.bollingerBands.lower ? 'BELOW lower band (oversold)'
                : price > t.bollingerBands.upper ? 'ABOVE upper band (overbought)'
                    : 'Within bands'
            : 'N/A';

        const supportLevels = t?.supportLevels ?? [];
        const resistanceLevels = t?.resistanceLevels ?? [];
        const signals = t?.signals ?? [];

        sections.push(
            `═══ TECHNICAL ANALYSIS ═══

TREND:
• Direction: ${(t?.trend ?? 'sideways').toUpperCase().replace('_', ' ')}
• Strength: ${t?.trendStrength ?? 50}/100
• ${trendContext}

MOVING AVERAGES:
• 20-day: ${formatPrice(sma20)} (${price > sma20 ? 'ABOVE' : 'BELOW'})
• 50-day: ${formatPrice(sma50)} (${price > sma50 ? 'ABOVE' : 'BELOW'})
• 200-day: ${formatPrice(sma200)} (${price > sma200 ? 'ABOVE' : 'BELOW'})

MOMENTUM:
• RSI(14): ${rsi.toFixed(1)} - ${rsiContext}
• MACD: ${macdSignal} (histogram: ${formatMetric(t?.macd?.histogram)})
• Stochastic: ${formatMetric(t?.stochastic?.k)}/${formatMetric(t?.stochastic?.d)}

VOLATILITY:
• Historical: ${formatMetric(t?.volatility)}% ${(t?.volatility ?? 0) > 40 ? '(HIGH)' : (t?.volatility ?? 0) < 20 ? '(LOW)' : ''}
• ATR(14): ${formatPrice(t?.atr14)}
• Bollinger: ${bbPosition}

KEY LEVELS:
• Support: ${supportLevels.length > 0 ? supportLevels.map(s => formatPrice(s)).join(', ') : 'None'}
• Resistance: ${resistanceLevels.length > 0 ? resistanceLevels.map(r => formatPrice(r)).join(', ') : 'None'}

SIGNALS:
${signals.length > 0 ? signals.map(s => `• ${s.indicator}: ${s.signal.toUpperCase()} (${s.strength}/100)`).join('\n') : '• No strong signals'}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // SPECIALIZED SECTIONS (QUANT & MACRO)
    // ═══════════════════════════════════════════════════════════════════════════════

    if (methodology === 'quant') {
        sections.push(getQuantFactors());
    }

    if (methodology === 'macro' || methodology === 'risk') {
        sections.push(getMacroContext());
    }

    if (methodology === 'value') {
        sections.push(getValueContext());
    }

    if (methodology === 'growth') {
        sections.push(getGrowthContext());
    }

    if (methodology === 'technical') {
        sections.push(getTechnicalContext());
    }

    if (methodology === 'sentiment' || methodology === 'contrarian') {
        sections.push(getSentimentContext());
    }

    if (methodology === 'risk') {
        sections.push(getRiskContext());
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // HISTORICAL PRICE PERFORMANCE (All analysts benefit from this context)
    // ═══════════════════════════════════════════════════════════════════════════════
    const historicalSummary = formatHistoricalSummary(data);
    if (historicalSummary) {
        sections.push(historicalSummary);
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // RISK MANAGEMENT & POSITION CONTEXT
    // ═══════════════════════════════════════════════════════════════════════════════
    const riskMgmtContext = formatRiskContext(methodology, data.ticker);
    if (riskMgmtContext) {
        sections.push(riskMgmtContext);
    }

    // NOTE: Performance and portfolio context are NOT appended here to avoid duplication.
    // They are computed separately and passed to buildThesisPrompt by generateSingleThesis.

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 5: SENTIMENT ANALYSIS
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('sentiment') || focus.secondary.includes('sentiment')) {
        const s = data.sentiment;
        const recentNews = s?.recentNews ?? [];
        const overallScore = s?.overallScore ?? 0;

        const sentimentInterpretation = overallScore > 0.3
            ? 'Strong positive - potential contrarian sell'
            : overallScore < -0.3
                ? 'Strong negative - potential contrarian buy'
                : 'Neutral';

        const newsBreakdown = recentNews.slice(0, 6).map((n, i) => {
            const icon = n.sentiment === 'positive' ? '📈' : n.sentiment === 'negative' ? '📉' : '➡️';
            return `${i + 1}. ${icon} ${n.title?.slice(0, 70)}... (${n.source})`;
        }).join('\n');

        sections.push(
            `═══ SENTIMENT ANALYSIS ═══

OVERALL:
• Score: ${overallScore.toFixed(2)} (-1 to +1)
• Classification: ${(s?.overallSentiment ?? 'neutral').toUpperCase().replace('_', ' ')}
• Interpretation: ${sentimentInterpretation}

NEWS BREAKDOWN:
• Total: ${s?.newsCount ?? 0} articles
• Positive: ${s?.positiveCount ?? 0} | Negative: ${s?.negativeCount ?? 0} | Neutral: ${s?.neutralCount ?? 0}

RECENT HEADLINES:
${newsBreakdown || 'No recent news'}`
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // SECTION 6: WALL STREET RATINGS
    // ═══════════════════════════════════════════════════════════════════════════
    if (focus.primary.includes('analystRatings') || focus.secondary.includes('analystRatings')) {
        const r = data.analystRatings;
        const totalRatings = (r?.strongBuy ?? 0) + (r?.buy ?? 0) + (r?.hold ?? 0) + (r?.sell ?? 0) + (r?.strongSell ?? 0);

        const upside = (r?.targetMean && price > 0)
            ? (((r.targetMean - price) / price) * 100).toFixed(1) + '%'
            : 'N/A';

        sections.push(
            `═══ WALL STREET RATINGS ═══

CONSENSUS: ${(r?.consensus ?? 'hold').toUpperCase().replace('_', ' ')}
Coverage: ${r?.numberOfAnalysts ?? 0} analysts (${totalRatings} total ratings)

PRICE TARGETS:
• Low: ${formatPrice(r?.targetLow)}
• Mean: ${formatPrice(r?.targetMean)} (${upside} from current)
• High: ${formatPrice(r?.targetHigh)}

DISTRIBUTION:
• Strong Buy: ${r?.strongBuy ?? 0} | Buy: ${r?.buy ?? 0}
• Hold: ${r?.hold ?? 0}
• Sell: ${r?.sell ?? 0} | Strong Sell: ${r?.strongSell ?? 0}`
        );
    }

    // Data quality notes - Enhanced with actionable context
    const warnings = data.dataQuality?.warnings ?? [];
    const dq = data.dataQuality;

    const qualityItems: string[] = [];
    if (dq) {
        if (!dq.hasQuote) qualityItems.push('⚠ CRITICAL: No quote data - analysis unreliable');
        if (!dq.hasFundamentals) qualityItems.push('⚠ Missing fundamentals - value metrics unavailable');
        if (!dq.hasTechnicals) qualityItems.push('⚠ Missing technicals - momentum signals unavailable');
        if (!dq.hasNews) qualityItems.push('ℹ No recent news - sentiment may be stale');
        if (!dq.hasAnalystRatings) qualityItems.push('ℹ No Wall Street coverage');
    }

    if (qualityItems.length > 0 || warnings.length > 0) {
        const allNotes = [...qualityItems, ...warnings.slice(0, 3).map(w => `⚠ ${w}`)];
        sections.push(`═══ DATA QUALITY NOTES ═══\n${allNotes.join('\n')}`);
    }

    return sections.join('\n\n');
}


// ═══════════════════════════════════════════════════════════════════════════════
// THESIS GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate thesis for a single analyst
 */
async function generateSingleThesis(
    ai: GoogleGenAI,
    analyst: AnalystAgent,
    stockData: StockAnalysisData,
    model: string = 'gemini-2.0-flash',
    maxRetries: number = 2
): Promise<ThesisGenerationResult> {
    let lastError: string = 'Unknown error';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const systemPrompt = THESIS_SYSTEM_PROMPTS[analyst.methodology];
            const dataContext = formatDataForAnalyst(stockData, analyst.methodology);
            const portfolioContext = formatPortfolioContext(analyst.methodology);
            const performanceContext = formatPerformanceContext(analyst.methodology);

            const userPrompt = buildThesisPrompt(
                stockData.ticker,
                stockData.profile?.name ?? stockData.ticker,
                dataContext,
                portfolioContext,
                performanceContext
            );

            // Use structured output with JSON schema for reliable parsing
            const response = await ai.models.generateContent({
                model,
                contents: userPrompt,
                config: {
                    systemInstruction: systemPrompt,
                    temperature: 0.7,
                    maxOutputTokens: 2500,
                    responseMimeType: 'application/json',
                    responseSchema: THESIS_SCHEMA
                }
            });

            const text = response.text || '';

            // Parse the structured JSON response
            const thesis = parseStructuredThesisResponse(
                text,
                analyst.id,
                stockData.ticker,
                stockData.quote?.price ?? 0
            );

            if (!thesis) {
                lastError = 'Failed to parse thesis response';
                if (attempt < maxRetries) {
                    logger.warn(`Thesis parsing failed for ${analyst.name}, retrying (${attempt + 1}/${maxRetries})...`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                    continue;
                }
                return {
                    analyst,
                    thesis: null,
                    error: lastError
                };
            }

            return { analyst, thesis, error: null };
        } catch (error) {
            lastError = error instanceof Error ? error.message : 'Unknown error';
            logger.error(`Thesis generation failed for ${analyst.name} (attempt ${attempt + 1}/${maxRetries + 1}):`, error);

            if (attempt < maxRetries) {
                // Exponential backoff
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
                continue;
            }
        }
    }

    return { analyst, thesis: null, error: lastError };
}

/**
 * Parse structured JSON thesis response from Gemini
 * Much simpler than the old text parsing since we get clean JSON
 */
function parseStructuredThesisResponse(
    jsonText: string,
    agentId: string,
    ticker: string,
    currentPrice: number
): InvestmentThesis | null {
    try {
        // Handle empty or invalid input
        if (!jsonText || jsonText.trim() === '' || jsonText.trim() === '{}') {
            logger.warn(`Empty or invalid thesis response for ${agentId}`);
            return null;
        }

        const parsed: ParsedThesis = JSON.parse(jsonText);

        // Validate that we got actual data
        if (!parsed || typeof parsed !== 'object') {
            logger.warn(`Invalid parsed thesis for ${agentId}: not an object`);
            return null;
        }

        // Normalize recommendation
        const recMap: Record<string, InvestmentThesis['recommendation']> = {
            'STRONG_BUY': 'strong_buy',
            'BUY': 'buy',
            'HOLD': 'hold',
            'SELL': 'sell',
            'STRONG_SELL': 'strong_sell'
        };
        const recommendation = recMap[parsed.recommendation] || 'hold';

        // Validate confidence (clamp to reasonable range)
        const confidence = Math.max(0, Math.min(100, parsed.confidence || 50));

        // Validate price targets with safe defaults
        const safePrice = currentPrice > 0 ? currentPrice : 100;

        const sanitizePrice = (price: unknown, fallback: number): number => {
            if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
                return price;
            }
            return fallback;
        };

        // Ensure price targets are logically consistent
        let bullTarget = sanitizePrice(parsed.priceTarget?.bull, safePrice * 1.3);
        let baseTarget = sanitizePrice(parsed.priceTarget?.base, safePrice * 1.1);
        let bearTarget = sanitizePrice(parsed.priceTarget?.bear, safePrice * 0.8);

        // Fix ordering if needed
        if (bearTarget > baseTarget) [bearTarget, baseTarget] = [baseTarget, bearTarget];
        if (baseTarget > bullTarget) [baseTarget, bullTarget] = [bullTarget, baseTarget];
        if (bearTarget > baseTarget) [bearTarget, baseTarget] = [baseTarget, bearTarget];

        const priceTarget: PriceTarget = {
            bull: bullTarget,
            base: baseTarget,
            bear: bearTarget,
            timeframe: '1Y'
        };

        // Validate arrays
        const bullCase = Array.isArray(parsed.bullCase)
            ? parsed.bullCase.filter(Boolean).slice(0, 5)
            : [];
        const bearCase = Array.isArray(parsed.bearCase)
            ? parsed.bearCase.filter(Boolean).slice(0, 5)
            : [];
        const catalysts = Array.isArray(parsed.catalysts)
            ? parsed.catalysts.filter(Boolean).slice(0, 3)
            : [];

        // Convert keyMetrics array to Record<string, string>
        // Format: ["P/E: 25.3", "Revenue Growth: 15%"] -> { "P/E": "25.3", "Revenue Growth": "15%" }
        const keyMetrics: Record<string, string> = {};
        if (Array.isArray(parsed.keyMetrics)) {
            for (const metric of parsed.keyMetrics) {
                if (typeof metric === 'string' && metric.includes(':')) {
                    const colonIndex = metric.indexOf(':');
                    const key = metric.slice(0, colonIndex).trim();
                    const value = metric.slice(colonIndex + 1).trim();
                    if (key && value) {
                        keyMetrics[key] = value;
                    }
                }
            }
        }

        return {
            agentId,
            ticker,
            recommendation,
            confidence,
            priceTarget,
            bullCase,
            bearCase,
            keyMetrics,
            catalysts,
            risks: bearCase, // Use bear case as risks
            summary: parsed.summary || '',
            detailedAnalysis: jsonText
        };
    } catch (error) {
        logger.error(`Failed to parse structured thesis response for ${agentId}:`, error);
        return null;
    }
}

/**
 * Generate theses for all 8 analysts
 */
export async function generateAllTheses(
    apiKey: string,
    stockData: StockAnalysisData,
    options: {
        model?: string;
        concurrency?: number;
        onProgress?: (completed: number, total: number, analyst: string) => void;
        onThesisComplete?: (thesis: InvestmentThesis) => void;
    } = {}
): Promise<{
    theses: InvestmentThesis[];
    errors: { analyst: string; error: string }[];
}> {
    const { model = 'gemini-2.0-flash', concurrency = 2, onProgress, onThesisComplete } = options;
    const ai = new GoogleGenAI({ apiKey });
    const analysts = getAllAnalysts();
    const results: ThesisGenerationResult[] = [];
    const errors: { analyst: string; error: string }[] = [];

    // Process in batches to avoid rate limits
    for (let i = 0; i < analysts.length; i += concurrency) {
        const batch = analysts.slice(i, i + concurrency);
        if (batch.length === 0) continue;  // Skip empty batches

        const batchResults = await Promise.all(
            batch.map(analyst => generateSingleThesis(ai, analyst, stockData, model))
        );

        // Push all results first
        for (const result of batchResults) {
            results.push(result);
            if (result.error) {
                errors.push({ analyst: result.analyst.name, error: result.error });
            }
        }

        // Then call thesis complete callbacks
        for (const result of batchResults) {
            if (onThesisComplete && result.thesis) {
                onThesisComplete(result.thesis);
            }
        }

        // Finally update progress with only successful analysts
        if (onProgress) {
            const successfulAnalysts = batchResults
                .filter(r => r.thesis !== null)
                .map(r => r.analyst.name);

            if (successfulAnalysts.length > 0) {
                const analystNames = successfulAnalysts.join(' & ');
                onProgress(results.length, analysts.length, analystNames);
            }
        }

        // Small delay between batches to avoid rate limits
        if (i + concurrency < analysts.length) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    const theses = results
        .filter(r => r.thesis !== null)
        .map(r => r.thesis as InvestmentThesis);

    return { theses, errors };
}

export async function generateThesisForAnalyst(
    apiKey: string,
    methodology: AnalystMethodology,
    stockData: StockAnalysisData,
    model: string = 'gemini-2.0-flash'
): Promise<InvestmentThesis | null> {
    const ai = new GoogleGenAI({ apiKey });
    const analyst = ANALYST_PROFILES[methodology];
    const result = await generateSingleThesis(ai, analyst, stockData, model);
    return result.thesis;
}


// ═══════════════════════════════════════════════════════════════════════════════
// THESIS ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Categorize analysts by their recommendation
 */
export function categorizeByRecommendation(theses: InvestmentThesis[]): {
    bulls: InvestmentThesis[];
    bears: InvestmentThesis[];
    neutral: InvestmentThesis[];
} {
    const bulls: InvestmentThesis[] = [];
    const bears: InvestmentThesis[] = [];
    const neutral: InvestmentThesis[] = [];

    for (const thesis of theses) {
        if (thesis.recommendation === 'strong_buy' || thesis.recommendation === 'buy') {
            bulls.push(thesis);
        } else if (thesis.recommendation === 'strong_sell' || thesis.recommendation === 'sell') {
            bears.push(thesis);
        } else {
            neutral.push(thesis);
        }
    }

    return { bulls, bears, neutral };
}

/**
 * Calculate consensus metrics from all theses
 */
export function calculateConsensus(theses: InvestmentThesis[]): {
    avgConfidence: number;
    avgPriceTarget: number;
    consensusRecommendation: InvestmentThesis['recommendation'];
    bullCount: number;
    bearCount: number;
    holdCount: number;
} {
    if (theses.length === 0) {
        return {
            avgConfidence: 0,
            avgPriceTarget: 0,
            consensusRecommendation: 'hold',
            bullCount: 0,
            bearCount: 0,
            holdCount: 0
        };
    }

    const { bulls, bears, neutral } = categorizeByRecommendation(theses);

    const avgConfidence = theses.reduce((sum, t) => sum + (t.confidence ?? 0), 0) / theses.length;
    const avgPriceTarget = theses.reduce((sum, t) => sum + (t.priceTarget?.base ?? 0), 0) / theses.length;

    let consensusRecommendation: InvestmentThesis['recommendation'] = 'hold';
    if (bulls.length > bears.length + neutral.length) {
        consensusRecommendation = bulls.some(t => t.recommendation === 'strong_buy') ? 'strong_buy' : 'buy';
    } else if (bears.length > bulls.length + neutral.length) {
        consensusRecommendation = bears.some(t => t.recommendation === 'strong_sell') ? 'strong_sell' : 'sell';
    }

    return {
        avgConfidence,
        avgPriceTarget,
        consensusRecommendation,
        bullCount: bulls.length,
        bearCount: bears.length,
        holdCount: neutral.length
    };
}

// Re-export for convenience
export { getAllAnalysts, getAnalystById, getAnalystByMethodology } from '../../constants/analystPrompts';
