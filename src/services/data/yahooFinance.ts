/**
 * Stock Data Service
 * 
 * Multi-provider stock data fetching with automatic fallback.
 * Primary: Financial Modeling Prep (FMP) - Free, 250 req/day
 * Fallback: Yahoo Finance via CORS proxy
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

// Financial Modeling Prep - Free tier (250 requests/day)
// Get your free key at: https://site.financialmodelingprep.com/developer/docs/
const FMP_API_KEY = 'demo';
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Rate limiting - minimum delay between FMP API calls
const MIN_API_DELAY = 150; // ms
let lastFmpCallTime = 0;
let rateLimitLock: Promise<void> | null = null;

// Cache configuration
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 100;
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

async function fetchWithTimeout(url: string, timeout = 10000): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}

/**
 * Fetch with rate limiting for FMP API calls
 * Uses a lock to prevent race conditions with concurrent calls
 */
async function fetchFmpWithRateLimit(url: string, timeout = 10000): Promise<Response> {
    // Wait for any pending rate limit delay
    if (rateLimitLock) {
        await rateLimitLock;
    }

    const now = Date.now();
    const timeSinceLastCall = now - lastFmpCallTime;

    if (timeSinceLastCall < MIN_API_DELAY) {
        const delay = MIN_API_DELAY - timeSinceLastCall;
        // Create a lock that other calls will wait on
        rateLimitLock = new Promise(resolve => setTimeout(resolve, delay));
        await rateLimitLock;
        rateLimitLock = null;
    }

    lastFmpCallTime = Date.now();
    return fetchWithTimeout(url, timeout);
}

// CORS proxies for Yahoo Finance fallback
const CORS_PROXIES = [
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

async function fetchWithProxy(url: string): Promise<Response | null> {
    for (const proxyFn of CORS_PROXIES) {
        try {
            const response = await fetchWithTimeout(proxyFn(url), 8000);
            if (response.ok) return response;
        } catch {
            continue;
        }
    }
    return null;
}


// ═══════════════════════════════════════════════════════════════════════════════
// QUOTE DATA
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get current stock quote - tries FMP first, then Yahoo
 */
export async function getQuote(ticker: string): Promise<StockQuote> {
    const cacheKey = `quote:${ticker}`;
    const cached = getCached<StockQuote>(cacheKey);
    if (cached) return cached;

    const normalizedTicker = ticker.toUpperCase().trim();

    // Try FMP first (most reliable)
    try {
        const quote = await getQuoteFMP(normalizedTicker);
        setCache(cacheKey, quote);
        return quote;
    } catch (fmpError) {
        logger.warn(`FMP quote failed for ${normalizedTicker}, trying Yahoo...`);
    }

    // Fallback to Yahoo
    try {
        const quote = await getQuoteYahoo(normalizedTicker);
        setCache(cacheKey, quote);
        return quote;
    } catch (yahooError) {
        logger.error(`All quote sources failed for ${normalizedTicker}`);
        throw new Error(`Unable to fetch quote for ${normalizedTicker}`);
    }
}

async function getQuoteFMP(ticker: string): Promise<StockQuote> {
    const url = `${FMP_BASE_URL}/quote/${ticker}?apikey=${FMP_API_KEY}`;
    const response = await fetchFmpWithRateLimit(url);

    if (!response.ok) {
        throw new Error(`FMP API error: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No FMP data for ${ticker}`);
    }

    const q = data[0];
    const previousClose = q.previousClose || q.price;
    const change = q.change || (q.price - previousClose);
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : (q.changesPercentage || 0);

    return {
        ticker: q.symbol,
        name: q.name || q.symbol,
        price: q.price,
        previousClose,
        open: q.open || q.price,
        dayHigh: q.dayHigh || q.price,
        dayLow: q.dayLow || q.price,
        volume: q.volume || 0,
        avgVolume: q.avgVolume || 0,
        change,
        changePercent,
        marketCap: q.marketCap || 0,
        timestamp: Date.now()
    };
}

async function getQuoteYahoo(ticker: string): Promise<StockQuote> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;
    const response = await fetchWithProxy(url);

    if (!response) {
        throw new Error('Yahoo Finance unavailable');
    }

    const data = await response.json();
    const result = data.chart?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo data for ${ticker}`);
    }

    const meta = result.meta;
    const quote = result.indicators?.quote?.[0];
    const previousClose = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
    const change = meta.regularMarketPrice - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

    return {
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
}


// ═══════════════════════════════════════════════════════════════════════════════
// HISTORICAL DATA
// ═══════════════════════════════════════════════════════════════════════════════

type Period = '1D' | '5D' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '5Y' | 'MAX';

/**
 * Get historical price data
 */
export async function getHistoricalData(ticker: string, period: Period = '1Y'): Promise<HistoricalData> {
    const cacheKey = `history:${ticker}:${period}`;
    const cached = getCached<HistoricalData>(cacheKey);
    if (cached) return cached;

    const normalizedTicker = ticker.toUpperCase().trim();

    // Try FMP first
    try {
        const data = await getHistoricalFMP(normalizedTicker, period);
        setCache(cacheKey, data);
        return data;
    } catch {
        logger.warn(`FMP historical failed for ${normalizedTicker}, trying Yahoo...`);
    }

    // Fallback to Yahoo
    try {
        const data = await getHistoricalYahoo(normalizedTicker, period);
        setCache(cacheKey, data);
        return data;
    } catch {
        throw new Error(`Unable to fetch historical data for ${normalizedTicker}`);
    }
}

async function getHistoricalFMP(ticker: string, period: Period): Promise<HistoricalData> {
    // FMP uses date ranges, calculate based on period
    const endDate = new Date();
    const startDate = new Date();

    switch (period) {
        case '1D': startDate.setDate(endDate.getDate() - 1); break;
        case '5D': startDate.setDate(endDate.getDate() - 5); break;
        case '1M': startDate.setMonth(endDate.getMonth() - 1); break;
        case '3M': startDate.setMonth(endDate.getMonth() - 3); break;
        case '6M': startDate.setMonth(endDate.getMonth() - 6); break;
        case '1Y': startDate.setFullYear(endDate.getFullYear() - 1); break;
        case '2Y': startDate.setFullYear(endDate.getFullYear() - 2); break;
        case '5Y': startDate.setFullYear(endDate.getFullYear() - 5); break;
        case 'MAX': startDate.setFullYear(endDate.getFullYear() - 20); break;
    }

    const from = startDate.toISOString().split('T')[0];
    const to = endDate.toISOString().split('T')[0];

    const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&to=${to}&apikey=${FMP_API_KEY}`;
    const response = await fetchFmpWithRateLimit(url);

    if (!response.ok) {
        throw new Error(`FMP historical API error: ${response.status}`);
    }

    const data = await response.json();
    const historical = data.historical || [];

    if (historical.length === 0) {
        throw new Error(`No FMP historical data for ${ticker}`);
    }

    // FMP returns newest first, reverse for chronological order
    const points: HistoricalDataPoint[] = historical.reverse().map((d: any) => ({
        date: d.date,
        open: d.open ?? 0,
        high: d.high ?? 0,
        low: d.low ?? 0,
        close: d.close ?? 0,
        volume: d.volume ?? 0,
        adjustedClose: d.adjClose ?? d.close ?? 0
    })).filter((d: HistoricalDataPoint) => d.close > 0);

    return { ticker, period, data: points };
}

async function getHistoricalYahoo(ticker: string, period: Period): Promise<HistoricalData> {
    const periodMap: Record<Period, { range: string; interval: string }> = {
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

    const { range, interval } = periodMap[period];
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
    const response = await fetchWithProxy(url);

    if (!response) {
        throw new Error('Yahoo Finance unavailable');
    }

    const data = await response.json();
    const result = data.chart?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo historical data for ${ticker}`);
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose || quote.close || [];

    const points: HistoricalDataPoint[] = timestamps.map((ts: number, i: number) => ({
        date: new Date(ts * 1000).toISOString().split('T')[0],
        open: quote.open?.[i] ?? 0,
        high: quote.high?.[i] ?? 0,
        low: quote.low?.[i] ?? 0,
        close: quote.close?.[i] ?? 0,
        volume: quote.volume?.[i] ?? 0,
        adjustedClose: adjClose[i] ?? quote.close?.[i] ?? 0
    })).filter((d: HistoricalDataPoint) => d.close > 0);

    return { ticker, period, data: points };
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

    const normalizedTicker = ticker.toUpperCase().trim();

    // Try FMP first
    try {
        const data = await getFundamentalsFMP(normalizedTicker);
        setCache(cacheKey, data);
        return data;
    } catch {
        logger.warn(`FMP fundamentals failed for ${normalizedTicker}, trying Yahoo...`);
    }

    // Fallback to Yahoo
    try {
        const data = await getFundamentalsYahoo(normalizedTicker);
        setCache(cacheKey, data);
        return data;
    } catch {
        // Return empty fundamentals rather than failing
        return getDefaultFundamentals();
    }
}

async function getFundamentalsFMP(ticker: string): Promise<Fundamentals> {
    // FMP has multiple endpoints - fetch sequentially with rate limiting
    const ratiosRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/ratios-ttm/${ticker}?apikey=${FMP_API_KEY}`);
    const profileRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/profile/${ticker}?apikey=${FMP_API_KEY}`);

    if (!ratiosRes.ok && !profileRes.ok) {
        throw new Error('FMP fundamentals unavailable');
    }

    const ratios = ratiosRes.ok ? (await ratiosRes.json())?.[0] || {} : {};
    const profile = profileRes.ok ? (await profileRes.json())?.[0] || {} : {};

    return {
        peRatio: ratios.peRatioTTM ?? profile.pe ?? null,
        forwardPE: ratios.priceEarningsToGrowthRatioTTM ?? null,
        pegRatio: ratios.pegRatioTTM ?? null,
        priceToBook: ratios.priceToBookRatioTTM ?? null,
        priceToSales: ratios.priceToSalesRatioTTM ?? null,
        enterpriseValue: profile.enterpriseValue ?? null,
        evToRevenue: ratios.enterpriseValueOverRevenueTTM ?? null,
        evToEbitda: ratios.enterpriseValueOverEBITDATTM ?? null,
        profitMargin: ratios.netProfitMarginTTM ?? null,
        operatingMargin: ratios.operatingProfitMarginTTM ?? null,
        grossMargin: ratios.grossProfitMarginTTM ?? null,
        returnOnEquity: ratios.returnOnEquityTTM ?? null,
        returnOnAssets: ratios.returnOnAssetsTTM ?? null,
        revenueGrowth: ratios.revenueGrowthTTM ?? null,
        earningsGrowth: ratios.netIncomeGrowthTTM ?? null,
        quarterlyRevenueGrowth: null,
        quarterlyEarningsGrowth: null,
        currentRatio: ratios.currentRatioTTM ?? null,
        quickRatio: ratios.quickRatioTTM ?? null,
        debtToEquity: ratios.debtEquityRatioTTM ?? null,
        totalDebt: null,
        totalCash: null,
        freeCashFlow: ratios.freeCashFlowPerShareTTM ?? null,
        eps: profile.eps ?? null,
        epsForward: null,
        bookValue: ratios.bookValuePerShareTTM ?? null,
        revenuePerShare: ratios.revenuePerShareTTM ?? null,
        dividendYield: ratios.dividendYieldTTM ?? (profile.lastDiv ? profile.lastDiv / profile.price : null),
        dividendRate: profile.lastDiv ?? null,
        payoutRatio: ratios.payoutRatioTTM ?? null,
        exDividendDate: null,
        sharesOutstanding: profile.sharesOutstanding ?? null,
        floatShares: profile.floatShares ?? null,
        shortRatio: null,
        shortPercentOfFloat: null
    };
}

async function getFundamentalsYahoo(ticker: string): Promise<Fundamentals> {
    const modules = 'defaultKeyStatistics,financialData,summaryDetail';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
    const response = await fetchWithProxy(url);

    if (!response) {
        throw new Error('Yahoo Finance unavailable');
    }

    const data = await response.json();
    const result = data.quoteSummary?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo fundamentals for ${ticker}`);
    }

    const stats = result.defaultKeyStatistics || {};
    const financial = result.financialData || {};
    const summary = result.summaryDetail || {};
    const raw = (obj: any) => obj?.raw ?? obj ?? null;

    return {
        peRatio: raw(summary.trailingPE),
        forwardPE: raw(summary.forwardPE),
        pegRatio: raw(stats.pegRatio),
        priceToBook: raw(stats.priceToBook),
        priceToSales: raw(summary.priceToSalesTrailing12Months),
        enterpriseValue: raw(stats.enterpriseValue),
        evToRevenue: raw(stats.enterpriseToRevenue),
        evToEbitda: raw(stats.enterpriseToEbitda),
        profitMargin: raw(financial.profitMargins),
        operatingMargin: raw(financial.operatingMargins),
        grossMargin: raw(financial.grossMargins),
        returnOnEquity: raw(financial.returnOnEquity),
        returnOnAssets: raw(financial.returnOnAssets),
        revenueGrowth: raw(financial.revenueGrowth),
        earningsGrowth: raw(financial.earningsGrowth),
        quarterlyRevenueGrowth: raw(financial.revenueQuarterlyGrowth),
        quarterlyEarningsGrowth: raw(financial.earningsQuarterlyGrowth),
        currentRatio: raw(financial.currentRatio),
        quickRatio: raw(financial.quickRatio),
        debtToEquity: raw(financial.debtToEquity),
        totalDebt: raw(financial.totalDebt),
        totalCash: raw(financial.totalCash),
        freeCashFlow: raw(financial.freeCashflow),
        eps: raw(stats.trailingEps),
        epsForward: raw(stats.forwardEps),
        bookValue: raw(stats.bookValue),
        revenuePerShare: raw(financial.revenuePerShare),
        dividendYield: raw(summary.dividendYield),
        dividendRate: raw(summary.dividendRate),
        payoutRatio: raw(summary.payoutRatio),
        exDividendDate: stats.exDividendDate?.fmt || null,
        sharesOutstanding: raw(stats.sharesOutstanding),
        floatShares: raw(stats.floatShares),
        shortRatio: raw(stats.shortRatio),
        shortPercentOfFloat: raw(stats.shortPercentOfFloat)
    };
}

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

    const normalizedTicker = ticker.toUpperCase().trim();

    // Try FMP first
    try {
        const data = await getAnalystRatingsFMP(normalizedTicker);
        setCache(cacheKey, data);
        return data;
    } catch {
        logger.warn(`FMP ratings failed for ${normalizedTicker}, trying Yahoo...`);
    }

    // Fallback to Yahoo
    try {
        const data = await getAnalystRatingsYahoo(normalizedTicker);
        setCache(cacheKey, data);
        return data;
    } catch {
        return getDefaultRatings();
    }
}

async function getAnalystRatingsFMP(ticker: string): Promise<AnalystRatings> {
    // Fetch sequentially with rate limiting
    const gradeRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/grade/${ticker}?limit=30&apikey=${FMP_API_KEY}`);
    const targetRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/price-target-consensus/${ticker}?apikey=${FMP_API_KEY}`);

    const grades = gradeRes.ok ? await gradeRes.json() : [];
    const targets = targetRes.ok ? (await targetRes.json())?.[0] : null;

    // Count recent grades (last 30)
    let strongBuy = 0, buy = 0, hold = 0, sell = 0, strongSell = 0;

    for (const g of (grades || []).slice(0, 30)) {
        const grade = (g.newGrade || '').toLowerCase();
        if (grade.includes('strong buy') || grade.includes('outperform')) strongBuy++;
        else if (grade.includes('buy') || grade.includes('overweight')) buy++;
        else if (grade.includes('hold') || grade.includes('neutral') || grade.includes('equal')) hold++;
        else if (grade.includes('sell') || grade.includes('underweight')) sell++;
        else if (grade.includes('strong sell') || grade.includes('underperform')) strongSell++;
    }

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

    return {
        consensus,
        targetPrice: targets?.targetConsensus ?? null,
        targetHigh: targets?.targetHigh ?? null,
        targetLow: targets?.targetLow ?? null,
        targetMean: targets?.targetConsensus ?? null,
        numberOfAnalysts: total || (targets?.numberOfAnalysts ?? 0),
        strongBuy,
        buy,
        hold,
        sell,
        strongSell,
        lastUpdated: new Date().toISOString()
    };
}

async function getAnalystRatingsYahoo(ticker: string): Promise<AnalystRatings> {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=recommendationTrend,financialData`;
    const response = await fetchWithProxy(url);

    if (!response) {
        throw new Error('Yahoo Finance unavailable');
    }

    const data = await response.json();
    const result = data.quoteSummary?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo ratings for ${ticker}`);
    }

    const trend = result.recommendationTrend?.trend?.[0] || {};
    const financial = result.financialData || {};
    const raw = (obj: any) => obj?.raw ?? obj ?? null;

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

    return {
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
}

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

    const normalizedTicker = ticker.toUpperCase().trim();

    // Try FMP first
    try {
        const data = await getCompanyProfileFMP(normalizedTicker);
        setCache(cacheKey, data);
        return data;
    } catch {
        logger.warn(`FMP profile failed for ${normalizedTicker}, trying Yahoo...`);
    }

    // Fallback to Yahoo
    try {
        const data = await getCompanyProfileYahoo(normalizedTicker);
        setCache(cacheKey, data);
        return data;
    } catch {
        return getDefaultProfile(normalizedTicker);
    }
}

async function getCompanyProfileFMP(ticker: string): Promise<CompanyProfile> {
    const url = `${FMP_BASE_URL}/profile/${ticker}?apikey=${FMP_API_KEY}`;
    const response = await fetchFmpWithRateLimit(url);

    if (!response.ok) {
        throw new Error(`FMP profile API error: ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No FMP profile for ${ticker}`);
    }

    const p = data[0];

    return {
        ticker: p.symbol || ticker,
        name: p.companyName || p.symbol || ticker,
        description: p.description || '',
        sector: p.sector || 'Unknown',
        industry: p.industry || 'Unknown',
        website: p.website || '',
        employees: p.fullTimeEmployees || null,
        headquarters: [p.city, p.state, p.country].filter(Boolean).join(', '),
        founded: p.ipoDate || null,
        ceo: p.ceo || null,
        exchange: p.exchangeShortName || p.exchange || '',
        currency: p.currency || 'USD',
        country: p.country || 'Unknown'
    };
}

async function getCompanyProfileYahoo(ticker: string): Promise<CompanyProfile> {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=assetProfile,quoteType`;
    const response = await fetchWithProxy(url);

    if (!response) {
        throw new Error('Yahoo Finance unavailable');
    }

    const data = await response.json();
    const result = data.quoteSummary?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo profile for ${ticker}`);
    }

    const profile = result.assetProfile || {};
    const quoteType = result.quoteType || {};

    return {
        ticker: ticker,
        name: quoteType.longName || quoteType.shortName || ticker,
        description: profile.longBusinessSummary || '',
        sector: profile.sector || 'Unknown',
        industry: profile.industry || 'Unknown',
        website: profile.website || '',
        employees: profile.fullTimeEmployees || null,
        headquarters: [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
        founded: null,
        ceo: profile.companyOfficers?.[0]?.name || null,
        exchange: quoteType.exchange || '',
        currency: quoteType.currency || 'USD',
        country: profile.country || 'Unknown'
    };
}

function getDefaultProfile(ticker: string): CompanyProfile {
    return {
        ticker,
        name: ticker,
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

// ═══════════════════════════════════════════════════════════════════════════════
// TICKER VALIDATION & SEARCH
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
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return [];

    // Try FMP search first
    try {
        const url = `${FMP_BASE_URL}/search?query=${encodeURIComponent(normalizedQuery)}&limit=10&apikey=${FMP_API_KEY}`;
        const response = await fetchFmpWithRateLimit(url, 5000);

        if (response.ok) {
            const data = await response.json();
            return (data || [])
                .filter((item: any) => item.symbol && item.name)
                .map((item: any) => ({
                    symbol: item.symbol,
                    name: item.name,
                    exchange: item.exchangeShortName || item.stockExchange || ''
                }));
        }
    } catch {
        // Fall through to Yahoo
    }

    // Fallback to Yahoo search
    try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(normalizedQuery)}&quotesCount=10&newsCount=0`;
        const response = await fetchWithProxy(url);

        if (response) {
            const data = await response.json();
            return (data.quotes || [])
                .filter((q: any) => q.quoteType === 'EQUITY')
                .map((q: any) => ({
                    symbol: q.symbol,
                    name: q.shortname || q.longname || q.symbol,
                    exchange: q.exchange || ''
                }));
        }
    } catch {
        // Return empty
    }

    return [];
}
