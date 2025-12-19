/**
 * Stock Data Aggregator
 * 
 * Combines all data sources into a unified StockAnalysisData object.
 * Handles parallel fetching, error recovery, and data quality assessment.
 */

import {
    StockAnalysisData,
    StockQuote,
    CompanyProfile,
    Fundamentals,
    TechnicalIndicators,
    SentimentAnalysis,
    AnalystRatings
} from '../../types/stock';
import {
    getQuote,
    getHistoricalData,
    getFundamentals,
    getAnalystRatings,
    getCompanyProfile,
    validateTicker
} from './yahooFinance';
import { getSentimentAnalysis, NewsServiceOptions } from './newsService';
import { calculateTechnicalIndicators } from './technicalAnalysis';
import { logger } from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface AggregatorOptions {
    finnhubApiKey?: string;
    historicalPeriod?: '1M' | '3M' | '6M' | '1Y';
    skipNews?: boolean;
    skipTechnicals?: boolean;
}

interface FetchResult<T> {
    data: T | null;
    error: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely fetch data with error handling
 */
async function safeFetch<T>(
    fetcher: () => Promise<T>,
    name: string
): Promise<FetchResult<T>> {
    try {
        const data = await fetcher();
        return { data, error: null };
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`Failed to fetch ${name}: ${message}`);
        return { data: null, error: message };
    }
}

/**
 * Get default quote for error cases
 */
function getDefaultQuote(ticker: string): StockQuote {
    return {
        ticker: ticker.toUpperCase(),
        name: ticker.toUpperCase(),
        price: 0,
        previousClose: 0,
        open: 0,
        dayHigh: 0,
        dayLow: 0,
        volume: 0,
        avgVolume: 0,
        change: 0,
        changePercent: 0,
        marketCap: 0,
        timestamp: Date.now()
    };
}

/**
 * Get default profile for error cases
 */
function getDefaultProfile(ticker: string): CompanyProfile {
    return {
        ticker: ticker.toUpperCase(),
        name: ticker.toUpperCase(),
        description: '',
        sector: 'Unknown',
        industry: 'Unknown',
        website: '',
        employees: null,
        headquarters: '',
        founded: null,
        ceo: null,
        exchange: '',
        currency: 'USD',
        country: 'Unknown'
    };
}

/**
 * Get default fundamentals for error cases
 */
function getDefaultFundamentals(): Fundamentals {
    return {
        peRatio: null, forwardPE: null, pegRatio: null, priceToBook: null,
        priceToSales: null, enterpriseValue: null, evToRevenue: null, evToEbitda: null,
        profitMargin: null, operatingMargin: null, grossMargin: null,
        returnOnEquity: null, returnOnAssets: null,
        revenueGrowth: null, earningsGrowth: null,
        quarterlyRevenueGrowth: null, quarterlyEarningsGrowth: null,
        currentRatio: null, quickRatio: null, debtToEquity: null,
        totalDebt: null, totalCash: null, freeCashFlow: null,
        eps: null, epsForward: null, bookValue: null, revenuePerShare: null,
        dividendYield: null, dividendRate: null, payoutRatio: null, exDividendDate: null,
        sharesOutstanding: null, floatShares: null, shortRatio: null, shortPercentOfFloat: null
    };
}

/**
 * Get default analyst ratings for error cases
 */
function getDefaultRatings(): AnalystRatings {
    return {
        consensus: 'hold',
        targetPrice: null,
        targetHigh: null,
        targetLow: null,
        targetMean: null,
        numberOfAnalysts: 0,
        strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0,
        lastUpdated: new Date().toISOString()
    };
}

/**
 * Get default sentiment for error cases
 */
function getDefaultSentiment(): SentimentAnalysis {
    return {
        overallScore: 0,
        overallSentiment: 'neutral',
        newsCount: 0,
        positiveCount: 0,
        negativeCount: 0,
        neutralCount: 0,
        recentNews: []
    };
}

/**
 * Get default technicals for error cases
 */
function getDefaultTechnicals(): TechnicalIndicators {
    return {
        sma20: 0, sma50: 0, sma200: 0, ema12: 0, ema26: 0,
        rsi14: 50,
        macd: { macdLine: 0, signalLine: 0, histogram: 0 },
        stochastic: { k: 50, d: 50 },
        bollingerBands: { upper: 0, middle: 0, lower: 0, width: 0 },
        atr14: 0, volatility: 0,
        trend: 'sideways', trendStrength: 50,
        supportLevels: [], resistanceLevels: [], signals: []
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN AGGREGATOR
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch all stock data from multiple sources
 * Returns a comprehensive StockAnalysisData object
 */
export async function fetchAllStockData(
    ticker: string,
    options: AggregatorOptions = {}
): Promise<StockAnalysisData> {
    const {
        finnhubApiKey,
        historicalPeriod = '1Y',
        skipNews = false,
        skipTechnicals = false
    } = options;

    const normalizedTicker = ticker.toUpperCase().trim();
    const warnings: string[] = [];
    const MAX_WARNINGS = 20;

    logger.info(`Fetching all data for ${normalizedTicker}...`);

    // Helper to add warnings with bounds check
    let warningsTruncated = false;
    const addWarning = (msg: string) => {
        if (warnings.length < MAX_WARNINGS) {
            warnings.push(msg);
        } else if (!warningsTruncated) {
            warnings.push('Additional warnings truncated...');
            warningsTruncated = true;
        }
    };

    // Validate ticker first
    const isValid = await validateTicker(normalizedTicker);
    if (!isValid) {
        throw new Error(`Invalid ticker symbol: ${normalizedTicker}`);
    }

    // Fetch all data in parallel for performance
    const newsOptions: NewsServiceOptions = { finnhubApiKey };

    const [
        quoteResult,
        profileResult,
        fundamentalsResult,
        historicalResult,
        ratingsResult,
        sentimentResult
    ] = await Promise.all([
        safeFetch(() => getQuote(normalizedTicker), 'quote'),
        safeFetch(() => getCompanyProfile(normalizedTicker), 'profile'),
        safeFetch(() => getFundamentals(normalizedTicker), 'fundamentals'),
        safeFetch(() => getHistoricalData(normalizedTicker, historicalPeriod), 'historical'),
        safeFetch(() => getAnalystRatings(normalizedTicker), 'ratings'),
        skipNews
            ? Promise.resolve({ data: getDefaultSentiment(), error: null })
            : safeFetch(() => getSentimentAnalysis(normalizedTicker, newsOptions), 'sentiment')
    ]);

    // Track data quality
    const hasQuote = quoteResult.data !== null;
    const hasFundamentals = fundamentalsResult.data !== null;
    const hasNews = sentimentResult.data !== null && (sentimentResult.data.newsCount > 0);
    const hasAnalystRatings = ratingsResult.data !== null && (ratingsResult.data.numberOfAnalysts > 0);

    // Add warnings for missing data (with bounds check)
    if (quoteResult.error) addWarning(`Quote: ${quoteResult.error}`);
    if (profileResult.error) addWarning(`Profile: ${profileResult.error}`);
    if (fundamentalsResult.error) addWarning(`Fundamentals: ${fundamentalsResult.error}`);
    if (historicalResult.error) addWarning(`Historical: ${historicalResult.error}`);
    if (ratingsResult.error) addWarning(`Ratings: ${ratingsResult.error}`);
    if (sentimentResult.error) addWarning(`Sentiment: ${sentimentResult.error}`);

    // Calculate technicals from historical data
    let technicals: TechnicalIndicators;
    if (skipTechnicals || !historicalResult.data) {
        technicals = getDefaultTechnicals();
    } else {
        try {
            technicals = calculateTechnicalIndicators(historicalResult.data.data);
        } catch (error) {
            addWarning(`Technicals calculation failed`);
            technicals = getDefaultTechnicals();
        }
    }

    const hasTechnicals = technicals.sma20 > 0;

    // Build the aggregated result
    const result: StockAnalysisData = {
        ticker: normalizedTicker,
        fetchedAt: Date.now(),

        quote: quoteResult.data || getDefaultQuote(normalizedTicker),
        profile: profileResult.data || getDefaultProfile(normalizedTicker),
        fundamentals: fundamentalsResult.data || getDefaultFundamentals(),
        historicalData: historicalResult.data || {
            ticker: normalizedTicker,
            period: historicalPeriod,
            data: []
        },
        technicals,
        sentiment: sentimentResult.data || getDefaultSentiment(),
        analystRatings: ratingsResult.data || getDefaultRatings(),

        dataQuality: {
            hasQuote,
            hasFundamentals,
            hasTechnicals,
            hasNews,
            hasAnalystRatings,
            warnings
        }
    };

    logger.info(`Data fetch complete for ${normalizedTicker}. Quality: Quote=${hasQuote}, Fundamentals=${hasFundamentals}, Technicals=${hasTechnicals}, News=${hasNews}, Ratings=${hasAnalystRatings}`);

    return result;
}

/**
 * Quick fetch - only essential data (quote + profile)
 * Useful for ticker validation and basic display
 */
export async function fetchQuickData(ticker: string): Promise<{
    quote: StockQuote;
    profile: CompanyProfile;
}> {
    const normalizedTicker = ticker.toUpperCase().trim();

    const [quote, profile] = await Promise.all([
        getQuote(normalizedTicker),
        getCompanyProfile(normalizedTicker)
    ]);

    return { quote, profile };
}

/**
 * Refresh specific data types
 */
export async function refreshData(
    ticker: string,
    types: ('quote' | 'fundamentals' | 'news' | 'ratings')[]
): Promise<Partial<StockAnalysisData>> {
    const normalizedTicker = ticker.toUpperCase().trim();
    const result: Partial<StockAnalysisData> = {};

    const fetchers: Promise<void>[] = [];

    if (types.includes('quote')) {
        fetchers.push(
            getQuote(normalizedTicker)
                .then(data => { result.quote = data; })
                .catch(err => { logger.warn(`Failed to refresh quote: ${err.message}`); })
        );
    }

    if (types.includes('fundamentals')) {
        fetchers.push(
            getFundamentals(normalizedTicker)
                .then(data => { result.fundamentals = data; })
                .catch(err => { logger.warn(`Failed to refresh fundamentals: ${err.message}`); })
        );
    }

    if (types.includes('news')) {
        fetchers.push(
            getSentimentAnalysis(normalizedTicker)
                .then(data => { result.sentiment = data; })
                .catch(err => { logger.warn(`Failed to refresh news: ${err.message}`); })
        );
    }

    if (types.includes('ratings')) {
        fetchers.push(
            getAnalystRatings(normalizedTicker)
                .then(data => { result.analystRatings = data; })
                .catch(err => { logger.warn(`Failed to refresh ratings: ${err.message}`); })
        );
    }

    await Promise.all(fetchers);
    return result;
}

// Re-export for convenience
export { validateTicker, searchTickers } from './yahooFinance';
export { clearCache as clearYahooCache } from './yahooFinance';
export { clearNewsCache } from './newsService';
