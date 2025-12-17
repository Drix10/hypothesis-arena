/**
 * Yahoo Finance Data Service
 * 
 * Fetches stock data from Yahoo Finance via public API endpoints.
 * No API key required - uses the same endpoints as the Yahoo Finance website.
 */

import {
    StockQuote,
    HistoricalData,
    HistoricalDataPoint,
    Fundamentals,
    AnalystRatings,
    CompanyProfile
} from '../../types/stock';
import { logger } from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

// Yahoo Finance API endpoints (public, no key needed)
const YAHOO_QUOTE_URL = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YAHOO_QUOTESUMMARY_URL = 'https://query1.finance.yahoo.com/v10/finance/quoteSummary';

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100; // Prevent unbounded growth
const cache = new Map<string, { data: unknown; timestamp: number }>();

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function getCached<T>(key: string): T | null {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        return cached.data as T;
    }
    cache.delete(key);
    return null;
}

function setCache(key: string, data: unknown): void {
    // Evict oldest entries if cache is full
    if (cache.size >= MAX_CACHE_SIZE) {
        const oldestKey = cache.keys().next().value;
        if (oldestKey) cache.delete(oldestKey);
    }
    cache.set(key, { data, timestamp: Date.now() });
}

export function clearCache(): void {
    cache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// FETCH UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

// Multiple CORS proxies for fallback (some get rate-limited)
const CORS_PROXIES = [
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function fetchWithProxy(url: string, timeout = 10000): Promise<Response> {
    let lastError: Error | null = null;

    for (const proxyFn of CORS_PROXIES) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
            const proxyUrl = proxyFn(url);
            const response = await fetch(proxyUrl, {
                signal: controller.signal,
            });
            clearTimeout(timeoutId);

            // If we get a successful response or a client error (4xx), return it
            // Only retry on server errors (5xx) or network issues
            if (response.ok || (response.status >= 400 && response.status < 500)) {
                return response;
            }

            lastError = new Error(`Proxy returned ${response.status}`);
        } catch (error) {
            clearTimeout(timeoutId);
            lastError = error instanceof Error ? error : new Error(String(error));
            // Continue to next proxy
        }
    }

    throw lastError || new Error('All CORS proxies failed');
}

// Alias for backward compatibility
const fetchWithTimeout = fetchWithProxy;

// ═══════════════════════════════════════════════════════════════════════════════
// QUOTE DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current stock quote with basic price data
 */
export async function getQuote(ticker: string): Promise<StockQuote> {
    const cacheKey = `quote:${ticker}`;
    const cached = getCached<StockQuote>(cacheKey);
    if (cached) return cached;

    const url = `${YAHOO_QUOTE_URL}/${ticker.toUpperCase()}?interval=1d&range=1d`;

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Yahoo Finance API error: ${response.status}`);
        }

        const data = await response.json();
        const result = data.chart?.result?.[0];

        if (!result) {
            throw new Error(`No data found for ticker: ${ticker}`);
        }

        const meta = result.meta;
        const quote = result.indicators?.quote?.[0];

        const previousClose = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
        const change = meta.regularMarketPrice - previousClose;
        // Safe division - avoid division by zero
        const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

        const stockQuote: StockQuote = {
            ticker: meta.symbol,
            name: meta.shortName || meta.longName || meta.symbol,
            price: meta.regularMarketPrice,
            previousClose,
            open: quote?.open?.[0] ?? meta.regularMarketPrice,
            dayHigh: meta.regularMarketDayHigh || meta.regularMarketPrice,
            dayLow: meta.regularMarketDayLow || meta.regularMarketPrice,
            volume: meta.regularMarketVolume || 0,
            avgVolume: meta.averageDailyVolume10Day || 0,
            change,
            changePercent,
            marketCap: meta.marketCap || 0,
            timestamp: Date.now()
        };

        setCache(cacheKey, stockQuote);
        return stockQuote;
    } catch (error) {
        logger.error(`Failed to fetch quote for ${ticker}:`, error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL DATA
// ═══════════════════════════════════════════════════════════════════════════════

type Period = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' | 'MAX';

const PERIOD_MAP: Record<Period, { range: string; interval: string }> = {
    '1D': { range: '1d', interval: '5m' },
    '5D': { range: '5d', interval: '15m' },
    '1M': { range: '1mo', interval: '1d' },
    '3M': { range: '3mo', interval: '1d' },
    '6M': { range: '6mo', interval: '1d' },
    '1Y': { range: '1y', interval: '1d' },
    '2Y': { range: '2y', interval: '1wk' },
    '5Y': { range: '5y', interval: '1wk' },
    'MAX': { range: 'max', interval: '1mo' }
};

/**
 * Get historical price data
 */
export async function getHistoricalData(ticker: string, period: Period = '1Y'): Promise<HistoricalData> {
    const cacheKey = `history:${ticker}:${period}`;
    const cached = getCached<HistoricalData>(cacheKey);
    if (cached) return cached;

    const { range, interval } = PERIOD_MAP[period];
    const url = `${YAHOO_QUOTE_URL}/${ticker.toUpperCase()}?interval=${interval}&range=${range}`;

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Yahoo Finance API error: ${response.status}`);
        }

        const data = await response.json();
        const result = data.chart?.result?.[0];

        if (!result) {
            throw new Error(`No historical data found for ticker: ${ticker}`);
        }

        const timestamps = result.timestamp || [];
        const quote = result.indicators?.quote?.[0] || {};
        const adjClose = result.indicators?.adjclose?.[0]?.adjclose || quote.close || [];

        const historicalData: HistoricalDataPoint[] = timestamps.map((ts: number, i: number) => ({
            date: new Date(ts * 1000).toISOString().split('T')[0],
            open: quote.open?.[i] ?? 0,
            high: quote.high?.[i] ?? 0,
            low: quote.low?.[i] ?? 0,
            close: quote.close?.[i] ?? 0,
            volume: quote.volume?.[i] ?? 0,
            adjustedClose: adjClose[i] ?? quote.close?.[i] ?? 0
        })).filter((d: HistoricalDataPoint) => d.close > 0); // Filter out invalid data points

        const result_: HistoricalData = {
            ticker: ticker.toUpperCase(),
            period,
            data: historicalData
        };

        setCache(cacheKey, result_);
        return result_;
    } catch (error) {
        logger.error(`Failed to fetch historical data for ${ticker}:`, error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNDAMENTALS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get fundamental financial data
 */
export async function getFundamentals(ticker: string): Promise<Fundamentals> {
    const cacheKey = `fundamentals:${ticker}`;
    const cached = getCached<Fundamentals>(cacheKey);
    if (cached) return cached;

    const modules = [
        'defaultKeyStatistics',
        'financialData',
        'summaryDetail',
        'incomeStatementHistory',
        'balanceSheetHistory'
    ].join(',');

    const url = `${YAHOO_QUOTESUMMARY_URL}/${ticker.toUpperCase()}?modules=${modules}`;

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Yahoo Finance API error: ${response.status}`);
        }

        const data = await response.json();
        const result = data.quoteSummary?.result?.[0];

        if (!result) {
            throw new Error(`No fundamental data found for ticker: ${ticker}`);
        }

        const stats = result.defaultKeyStatistics || {};
        const financial = result.financialData || {};
        const summary = result.summaryDetail || {};

        // Helper to extract raw value
        const raw = (obj: any) => obj?.raw ?? obj ?? null;

        const fundamentals: Fundamentals = {
            // Valuation
            peRatio: raw(summary.trailingPE),
            forwardPE: raw(summary.forwardPE),
            pegRatio: raw(stats.pegRatio),
            priceToBook: raw(stats.priceToBook),
            priceToSales: raw(summary.priceToSalesTrailing12Months),
            enterpriseValue: raw(stats.enterpriseValue),
            evToRevenue: raw(stats.enterpriseToRevenue),
            evToEbitda: raw(stats.enterpriseToEbitda),

            // Profitability
            profitMargin: raw(financial.profitMargins),
            operatingMargin: raw(financial.operatingMargins),
            grossMargin: raw(financial.grossMargins),
            returnOnEquity: raw(financial.returnOnEquity),
            returnOnAssets: raw(financial.returnOnAssets),

            // Growth
            revenueGrowth: raw(financial.revenueGrowth),
            earningsGrowth: raw(financial.earningsGrowth),
            quarterlyRevenueGrowth: raw(financial.revenueQuarterlyGrowth),
            quarterlyEarningsGrowth: raw(financial.earningsQuarterlyGrowth),

            // Financial Health
            currentRatio: raw(financial.currentRatio),
            quickRatio: raw(financial.quickRatio),
            debtToEquity: raw(financial.debtToEquity),
            totalDebt: raw(financial.totalDebt),
            totalCash: raw(financial.totalCash),
            freeCashFlow: raw(financial.freeCashflow),

            // Per Share
            eps: raw(stats.trailingEps),
            epsForward: raw(stats.forwardEps),
            bookValue: raw(stats.bookValue),
            revenuePerShare: raw(financial.revenuePerShare),

            // Dividends
            dividendYield: raw(summary.dividendYield),
            dividendRate: raw(summary.dividendRate),
            payoutRatio: raw(summary.payoutRatio),
            exDividendDate: stats.exDividendDate?.fmt || null,

            // Shares
            sharesOutstanding: raw(stats.sharesOutstanding),
            floatShares: raw(stats.floatShares),
            shortRatio: raw(stats.shortRatio),
            shortPercentOfFloat: raw(stats.shortPercentOfFloat)
        };

        setCache(cacheKey, fundamentals);
        return fundamentals;
    } catch (error) {
        logger.error(`Failed to fetch fundamentals for ${ticker}:`, error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ANALYST RATINGS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get analyst ratings and price targets
 */
export async function getAnalystRatings(ticker: string): Promise<AnalystRatings> {
    const cacheKey = `ratings:${ticker}`;
    const cached = getCached<AnalystRatings>(cacheKey);
    if (cached) return cached;

    const url = `${YAHOO_QUOTESUMMARY_URL}/${ticker.toUpperCase()}?modules=recommendationTrend,financialData`;

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Yahoo Finance API error: ${response.status}`);
        }

        const data = await response.json();
        const result = data.quoteSummary?.result?.[0];

        if (!result) {
            throw new Error(`No analyst data found for ticker: ${ticker}`);
        }

        const trend = result.recommendationTrend?.trend?.[0] || {};
        const financial = result.financialData || {};

        const raw = (obj: any) => obj?.raw ?? obj ?? null;

        // Calculate consensus
        const strongBuy = trend.strongBuy || 0;
        const buy = trend.buy || 0;
        const hold = trend.hold || 0;
        const sell = trend.sell || 0;
        const strongSell = trend.strongSell || 0;
        const total = strongBuy + buy + hold + sell + strongSell;

        let consensus: AnalystRatings['consensus'] = 'hold';
        if (total > 0) {
            const score = (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1) / total;
            if (score >= 4.5) consensus = 'strong_buy';
            else if (score >= 3.5) consensus = 'buy';
            else if (score >= 2.5) consensus = 'hold';
            else if (score >= 1.5) consensus = 'sell';
            else consensus = 'strong_sell';
        }

        const ratings: AnalystRatings = {
            consensus,
            targetPrice: raw(financial.targetMeanPrice),
            targetHigh: raw(financial.targetHighPrice),
            targetLow: raw(financial.targetLowPrice),
            targetMean: raw(financial.targetMeanPrice),
            numberOfAnalysts: raw(financial.numberOfAnalystOpinions) || total,
            strongBuy,
            buy,
            hold,
            sell,
            strongSell,
            lastUpdated: new Date().toISOString()
        };

        setCache(cacheKey, ratings);
        return ratings;
    } catch (error) {
        logger.error(`Failed to fetch analyst ratings for ${ticker}:`, error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANY PROFILE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get company profile information
 */
export async function getCompanyProfile(ticker: string): Promise<CompanyProfile> {
    const cacheKey = `profile:${ticker}`;
    const cached = getCached<CompanyProfile>(cacheKey);
    if (cached) return cached;

    const url = `${YAHOO_QUOTESUMMARY_URL}/${ticker.toUpperCase()}?modules=assetProfile,quoteType`;

    try {
        const response = await fetchWithTimeout(url);
        if (!response.ok) {
            throw new Error(`Yahoo Finance API error: ${response.status}`);
        }

        const data = await response.json();
        const result = data.quoteSummary?.result?.[0];

        if (!result) {
            throw new Error(`No profile data found for ticker: ${ticker}`);
        }

        const profile = result.assetProfile || {};
        const quoteType = result.quoteType || {};

        const companyProfile: CompanyProfile = {
            ticker: ticker.toUpperCase(),
            name: quoteType.longName || quoteType.shortName || ticker,
            description: profile.longBusinessSummary || '',
            sector: profile.sector || 'Unknown',
            industry: profile.industry || 'Unknown',
            website: profile.website || '',
            employees: profile.fullTimeEmployees || null,
            headquarters: [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
            founded: null, // Not available from Yahoo
            ceo: profile.companyOfficers?.[0]?.name || null,
            exchange: quoteType.exchange || '',
            currency: quoteType.currency || 'USD',
            country: profile.country || 'Unknown'
        };

        setCache(cacheKey, companyProfile);
        return companyProfile;
    } catch (error) {
        logger.error(`Failed to fetch company profile for ${ticker}:`, error);
        throw error;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKER VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate if a ticker exists
 */
export async function validateTicker(ticker: string): Promise<boolean> {
    try {
        await getQuote(ticker);
        return true;
    } catch {
        return false;
    }
}

/**
 * Search for tickers by name/symbol
 */
export async function searchTickers(query: string): Promise<Array<{ symbol: string; name: string; exchange: string }>> {
    const baseUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=10&newsCount=0`;

    try {
        const response = await fetchWithTimeout(baseUrl);
        if (!response.ok) return [];

        const data = await response.json();
        return (data.quotes || [])
            .filter((q: any) => q.quoteType === 'EQUITY')
            .map((q: any) => ({
                symbol: q.symbol,
                name: q.shortname || q.longname || q.symbol,
                exchange: q.exchange || ''
            }));
    } catch {
        return [];
    }
}
