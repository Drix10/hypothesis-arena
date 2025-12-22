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

import { getFmpApiKey } from '../apiKeyManager';

// Financial Modeling Prep - Free tier (250 requests/day)
// Get your free key at: https://site.financialmodelingprep.com/developer/docs/
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';

// Get FMP API key from: in-memory > env variable > demo
// FMP provides a "demo" key that works for basic quotes (limited features)
const getFmpKey = (): string => {
    return getFmpApiKey() || 'demo';
};

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
    // LRU eviction: ensure cache doesn't exceed max size
    // Safety: limit iterations to prevent infinite loop
    let evictionAttempts = 0;
    const maxEvictionAttempts = MAX_CACHE_SIZE;

    while (cache.size >= MAX_CACHE_SIZE && evictionAttempts < maxEvictionAttempts) {
        evictionAttempts++;
        let oldestKey: string | null = null;
        let oldestTime = Infinity;

        for (const [k, v] of cache.entries()) {
            if (v.timestamp < oldestTime) {
                oldestTime = v.timestamp;
                oldestKey = k;
            }
        }

        if (oldestKey) {
            cache.delete(oldestKey);
        } else {
            // No oldest key found - clear entire cache as fallback
            logger.warn('Cache eviction failed to find oldest entry, clearing cache');
            cache.clear();
            break;
        }
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
        return response;
    } catch (error) {
        throw error;
    } finally {
        // Single cleanup point - runs regardless of success/failure
        clearTimeout(timeoutId);
    }
}

/**
 * Safely parse JSON from response with error handling
 */
async function safeJsonParse(response: Response, source: string): Promise<any> {
    try {
        return await response.json();
    } catch (jsonError) {
        // Try to get text preview for debugging
        try {
            const text = await response.text();
            const preview = text.slice(0, 100).replace(/\s+/g, ' ');
            throw new Error(`${source} returned invalid JSON: ${preview}...`);
        } catch {
            throw new Error(`${source} returned invalid JSON`);
        }
    }
}

/**
 * Fetch with rate limiting for FMP API calls
 * Uses a lock to prevent race conditions with concurrent calls
 * FIXED: Proper lock cleanup to prevent race conditions
 */
async function fetchFmpWithRateLimit(url: string, timeout = 10000): Promise<Response> {
    // Wait for any pending rate limit delay
    while (rateLimitLock) {
        await rateLimitLock;
    }

    const now = Date.now();
    const timeSinceLastCall = now - lastFmpCallTime;

    if (timeSinceLastCall < MIN_API_DELAY) {
        const delay = MIN_API_DELAY - timeSinceLastCall;
        // Create a lock that other calls will wait on
        const currentLock = new Promise<void>(resolve => setTimeout(resolve, delay));
        rateLimitLock = currentLock;

        try {
            await currentLock;
        } finally {
            // Only clear if we're still the current lock (prevent race condition)
            if (rateLimitLock === currentLock) {
                rateLimitLock = null;
            }
        }
    }

    lastFmpCallTime = Date.now();
    return fetchWithTimeout(url, timeout);
}

// CORS proxies for Yahoo Finance fallback
// These are free public proxies - availability varies
const CORS_PROXIES = [
    // Most reliable proxies first
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url: string) => `https://proxy.cors.sh/${url}`,
    (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url: string) => `https://thingproxy.freeboard.io/fetch/${url}`,
];

// Cache the last working proxy index to try it first next time
let lastWorkingProxyIndex: number | null = null;
const PROXY_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
let lastProxySuccessTime = 0;

async function fetchWithProxy(url: string, retries = 1): Promise<Response | null> {
    const errors: string[] = [];

    // Build proxy order: try last working proxy first if recent
    const now = Date.now();
    const proxyOrder: number[] = [];

    if (lastWorkingProxyIndex !== null && (now - lastProxySuccessTime) < PROXY_CACHE_TTL) {
        // Start with the last working proxy
        proxyOrder.push(lastWorkingProxyIndex);
        for (let i = 0; i < CORS_PROXIES.length; i++) {
            if (i !== lastWorkingProxyIndex) proxyOrder.push(i);
        }
    } else {
        // No cached proxy, try in default order
        for (let i = 0; i < CORS_PROXIES.length; i++) {
            proxyOrder.push(i);
        }
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
        for (const proxyIndex of proxyOrder) {
            const proxyFn = CORS_PROXIES[proxyIndex];
            try {
                const proxyUrl = proxyFn(url);
                logger.debug(`Trying proxy ${proxyIndex + 1}/${CORS_PROXIES.length} (attempt ${attempt + 1}/${retries + 1})`);

                // Shorter timeout since we're trying multiple proxies
                const timeout = 6000 + (attempt * 2000);
                const response = await fetchWithTimeout(proxyUrl, timeout);
                if (!response.ok) {
                    const errorDetail = `Proxy ${proxyIndex + 1} returned HTTP ${response.status}`;
                    errors.push(errorDetail);
                    logger.debug(errorDetail);
                    continue;
                }

                // Validate response is JSON before returning
                const contentType = response.headers.get('content-type');
                if (contentType && contentType.includes('application/json')) {
                    logger.debug(`Proxy ${proxyIndex + 1} succeeded`);
                    // Cache this working proxy
                    lastWorkingProxyIndex = proxyIndex;
                    lastProxySuccessTime = Date.now();
                    return response;
                }

                // Try to parse as JSON anyway (some proxies don't set content-type)
                // Note: Response body can only be consumed once, so read as text first
                const text = await response.text();
                try {
                    JSON.parse(text);  // Validate JSON
                    // Create new Response with text since original body is consumed
                    logger.debug(`Proxy ${proxyIndex + 1} succeeded (no content-type header)`);
                    // Cache this working proxy
                    lastWorkingProxyIndex = proxyIndex;
                    lastProxySuccessTime = Date.now();
                    return new Response(text, {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                } catch {
                    const errorDetail = `Proxy ${proxyIndex + 1} returned non-JSON response`;
                    errors.push(errorDetail);
                    logger.debug(errorDetail);
                    continue;
                }
            } catch (error) {
                const msg = error instanceof Error ? error.message : 'Unknown error';
                const errorDetail = `Proxy ${proxyIndex + 1} failed: ${msg}`;
                errors.push(errorDetail);
                logger.debug(errorDetail);
                continue;
            }
        }

        // Exponential backoff before retry (only if we have more retries)
        if (attempt < retries) {
            const delay = Math.min(500 * Math.pow(2, attempt), 2000); // Max 2 seconds
            logger.debug(`Waiting ${delay}ms before retry ${attempt + 2}/${retries + 1}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    // Clear cached proxy since all failed
    lastWorkingProxyIndex = null;

    const errorSummary = `All ${CORS_PROXIES.length} CORS proxies failed after ${retries + 1} attempts. Errors: ${errors.slice(0, 3).join('; ')}`;
    logger.warn(errorSummary);
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
    if (cached) {
        logger.debug(`Using cached quote for ${ticker}`);
        return cached;
    }

    const normalizedTicker = ticker.toUpperCase().trim();
    logger.info(`Fetching quote for ${normalizedTicker}...`);

    let fmpError: Error | null = null;
    let yahooError: Error | null = null;

    // Try FMP first (most reliable)
    try {
        const quote = await getQuoteFMP(normalizedTicker);
        logger.info(`Successfully fetched quote for ${normalizedTicker} from FMP`);
        setCache(cacheKey, quote);
        return quote;
    } catch (error) {
        fmpError = error instanceof Error ? error : new Error(String(error));
        const fmpMsg = fmpError.message;
        logger.warn(`FMP quote failed for ${normalizedTicker}: ${fmpMsg}`);
    }

    // Fallback to Yahoo
    logger.info(`Attempting Yahoo Finance fallback for ${normalizedTicker}...`);
    try {
        const quote = await getQuoteYahoo(normalizedTicker);
        logger.info(`Successfully fetched quote for ${normalizedTicker} from Yahoo Finance`);
        setCache(cacheKey, quote);
        return quote;
    } catch (error) {
        yahooError = error instanceof Error ? error : new Error(String(error));
        const yahooMsg = yahooError.message;
        logger.error(`All quote sources failed for ${normalizedTicker}`, { fmpError: fmpError?.message, yahooError: yahooMsg });

        // Build comprehensive error message
        const errorDetails = [
            `FMP: ${fmpError?.message || 'Unknown error'}`,
            `Yahoo: ${yahooMsg}`
        ].join(' | ');

        // Provide actionable error message
        throw new Error(
            `Unable to fetch quote data for ${normalizedTicker}. Both data sources failed.\n\n` +
            `Possible causes:\n` +
            `• Invalid ticker symbol (verify on Yahoo Finance or Google)\n` +
            `• API rate limits exceeded (wait a few minutes)\n` +
            `• Network connectivity issues\n` +
            `• Free CORS proxies are down (temporary)\n` +
            `• FMP demo key limitations (get free key at financialmodelingprep.com)\n\n` +
            `Technical details: ${errorDetails}`
        );
    }
}

async function getQuoteFMP(ticker: string): Promise<StockQuote> {
    const apiKey = getFmpKey();
    const isDemo = apiKey === 'demo';
    const url = `${FMP_BASE_URL}/quote/${ticker}?apikey=${apiKey}`;

    logger.debug(`Fetching FMP quote for ${ticker} (using ${isDemo ? 'demo' : 'custom'} key)`);
    const response = await fetchFmpWithRateLimit(url);

    if (!response.ok) {
        // Try to get error details from response body
        let errorDetail = response.statusText || 'Unknown error';
        try {
            const errorData = await response.json();
            if (errorData && typeof errorData === 'object') {
                errorDetail = errorData.message || errorData.error || errorData['Error Message'] || errorDetail;
            }
        } catch {
            // Ignore JSON parse errors for error responses
        }

        // Provide helpful context for demo key limitations
        const demoHint = isDemo
            ? ' (Note: Demo key has limited features. Consider getting a free API key at https://site.financialmodelingprep.com/developer/docs/ for 250 requests/day)'
            : '';

        throw new Error(`FMP API HTTP ${response.status}: ${errorDetail}${demoHint}`);
    }

    // Safe JSON parsing
    const data = await safeJsonParse(response, 'FMP API');

    // Check for API error response (FMP returns error messages in various formats)
    if (data && typeof data === 'object') {
        if ('Error Message' in data) {
            throw new Error(`FMP API: ${data['Error Message']}`);
        }
        if ('error' in data) {
            throw new Error(`FMP API: ${data.error}`);
        }
        if ('message' in data && typeof data.message === 'string') {
            throw new Error(`FMP API: ${data.message}`);
        }
    }

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(`No FMP data for ${ticker} (empty response)`);
    }

    const q = data[0];

    // Validate required fields exist
    if (!q || typeof q !== 'object') {
        throw new Error(`Invalid FMP response for ${ticker}`);
    }

    // Guard against missing or invalid price data
    if (!q.price || !Number.isFinite(q.price) || q.price <= 0) {
        throw new Error(`Invalid price data for ${q.symbol || ticker}`);
    }

    const previousClose = (q.previousClose && Number.isFinite(q.previousClose)) ? q.previousClose : q.price;
    const change = (q.change && Number.isFinite(q.change)) ? q.change : (q.price - previousClose);
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : (q.changesPercentage || 0);

    return {
        ticker: q.symbol,
        name: q.name || q.symbol,
        price: q.price,
        previousClose,
        open: (q.open && Number.isFinite(q.open)) ? q.open : q.price,
        dayHigh: (q.dayHigh && Number.isFinite(q.dayHigh)) ? q.dayHigh : q.price,
        dayLow: (q.dayLow && Number.isFinite(q.dayLow)) ? q.dayLow : q.price,
        volume: (q.volume && Number.isFinite(q.volume)) ? q.volume : 0,
        avgVolume: (q.avgVolume && Number.isFinite(q.avgVolume)) ? q.avgVolume : 0,
        change,
        changePercent: Number.isFinite(changePercent) ? changePercent : 0,
        marketCap: (q.marketCap && Number.isFinite(q.marketCap)) ? q.marketCap : 0,
        timestamp: Date.now()
    };
}

async function getQuoteYahoo(ticker: string): Promise<StockQuote> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=1d`;

    logger.debug(`Fetching Yahoo quote for ${ticker} via CORS proxies`);

    // Try with proxy first (use default retries for better reliability)
    let response = await fetchWithProxy(url);

    // If proxy fails, try direct fetch (may work in some environments)
    if (!response) {
        logger.debug(`All proxies failed, attempting direct fetch to Yahoo Finance`);
        try {
            response = await fetchWithTimeout(url, 5000);
            if (!response.ok) {
                throw new Error(`Yahoo API returned HTTP ${response.status}`);
            }
            logger.debug(`Direct fetch to Yahoo Finance succeeded`);
        } catch (directError) {
            const msg = directError instanceof Error ? directError.message : 'Unknown error';
            logger.error(`Yahoo Finance completely unavailable for ${ticker}`, msg);
            throw new Error(
                `Yahoo Finance unavailable. All CORS proxies failed and direct access blocked. ` +
                `This is a known browser limitation. Possible causes: ` +
                `(1) All free CORS proxies are down/rate-limited, ` +
                `(2) Network connectivity issues, ` +
                `(3) Yahoo Finance API temporarily unavailable. ` +
                `Consider using a valid FMP API key for more reliable data. ` +
                `Error: ${msg}`
            );
        }
    }

    // Safe JSON parsing with error handling
    const data = await safeJsonParse(response, 'Yahoo Finance');

    // Check for API error response
    if (data && typeof data === 'object' && 'chart' in data && data.chart?.error) {
        throw new Error(`Yahoo API error: ${data.chart.error.description}`);
    }

    const result = data.chart?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo data for ${ticker}`);
    }

    const meta = result.meta;
    const quote = result.indicators?.quote?.[0];

    // Validate meta exists
    if (!meta || typeof meta !== 'object') {
        throw new Error(`Invalid Yahoo response for ${ticker}`);
    }

    // Guard against missing or invalid price data
    if (!meta.regularMarketPrice || !Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0) {
        throw new Error(`Invalid price data for ${meta.symbol || ticker}`);
    }

    const previousClose = (meta.previousClose && Number.isFinite(meta.previousClose))
        ? meta.previousClose
        : (meta.chartPreviousClose && Number.isFinite(meta.chartPreviousClose))
            ? meta.chartPreviousClose
            : meta.regularMarketPrice;

    const change = meta.regularMarketPrice - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

    return {
        ticker: meta.symbol,
        name: meta.shortName || meta.longName || meta.symbol,
        price: meta.regularMarketPrice,
        previousClose,
        open: (quote?.open?.[0] && Number.isFinite(quote.open[0])) ? quote.open[0] : meta.regularMarketPrice,
        dayHigh: (meta.regularMarketDayHigh && Number.isFinite(meta.regularMarketDayHigh)) ? meta.regularMarketDayHigh : meta.regularMarketPrice,
        dayLow: (meta.regularMarketDayLow && Number.isFinite(meta.regularMarketDayLow)) ? meta.regularMarketDayLow : meta.regularMarketPrice,
        volume: (meta.regularMarketVolume && Number.isFinite(meta.regularMarketVolume)) ? meta.regularMarketVolume : 0,
        avgVolume: (meta.averageDailyVolume10Day && Number.isFinite(meta.averageDailyVolume10Day)) ? meta.averageDailyVolume10Day : 0,
        change: Number.isFinite(change) ? change : 0,
        changePercent: Number.isFinite(changePercent) ? changePercent : 0,
        marketCap: (meta.marketCap && Number.isFinite(meta.marketCap)) ? meta.marketCap : 0,
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

    const url = `${FMP_BASE_URL}/historical-price-full/${ticker}?from=${from}&to=${to}&apikey=${getFmpKey()}`;
    const response = await fetchFmpWithRateLimit(url);

    if (!response.ok) {
        throw new Error(`FMP historical API error: ${response.status}`);
    }

    const data = await safeJsonParse(response, 'FMP Historical API');
    const historical = data.historical || [];

    if (historical.length === 0) {
        throw new Error(`No FMP historical data for ${ticker}`);
    }

    // FMP returns newest first, reverse for chronological order
    const points: HistoricalDataPoint[] = historical.reverse().map((d: any) => ({
        date: d.date,
        open: (d.open && Number.isFinite(d.open)) ? d.open : 0,
        high: (d.high && Number.isFinite(d.high)) ? d.high : 0,
        low: (d.low && Number.isFinite(d.low)) ? d.low : 0,
        close: (d.close && Number.isFinite(d.close)) ? d.close : 0,
        volume: (d.volume && Number.isFinite(d.volume)) ? d.volume : 0,
        adjustedClose: (d.adjClose && Number.isFinite(d.adjClose)) ? d.adjClose : ((d.close && Number.isFinite(d.close)) ? d.close : 0)
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

    const data = await safeJsonParse(response, 'Yahoo Historical');
    const result = data.chart?.result?.[0];

    if (!result) {
        throw new Error(`No Yahoo historical data for ${ticker}`);
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose || quote.close || [];

    const points: HistoricalDataPoint[] = timestamps.map((ts: number, i: number) => {
        const open = quote.open?.[i];
        const high = quote.high?.[i];
        const low = quote.low?.[i];
        const close = quote.close?.[i];
        const volume = quote.volume?.[i];
        const adj = adjClose[i];

        return {
            date: new Date(ts * 1000).toISOString().split('T')[0],
            open: (open && Number.isFinite(open)) ? open : 0,
            high: (high && Number.isFinite(high)) ? high : 0,
            low: (low && Number.isFinite(low)) ? low : 0,
            close: (close && Number.isFinite(close)) ? close : 0,
            volume: (volume && Number.isFinite(volume)) ? volume : 0,
            adjustedClose: (adj && Number.isFinite(adj)) ? adj : ((close && Number.isFinite(close)) ? close : 0)
        };
    }).filter((d: HistoricalDataPoint) => d.close > 0);

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
    const ratiosRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/ratios-ttm/${ticker}?apikey=${getFmpKey()}`);
    const profileRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/profile/${ticker}?apikey=${getFmpKey()}`);

    if (!ratiosRes.ok && !profileRes.ok) {
        throw new Error('FMP fundamentals unavailable');
    }

    const ratios = ratiosRes.ok ? (await ratiosRes.json())?.[0] || {} : {};
    const profile = profileRes.ok ? (await profileRes.json())?.[0] || {} : {};

    // Safe dividend yield calculation - guard against division by zero
    const dividendYield = ratios.dividendYieldTTM ??
        (profile.lastDiv && profile.price && profile.price > 0
            ? profile.lastDiv / profile.price
            : null);

    return {
        peRatio: ratios.peRatioTTM ?? profile.pe ?? null,
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
        currentRatio: ratios.currentRatioTTM ?? null,
        quickRatio: ratios.quickRatioTTM ?? null,
        debtToEquity: ratios.debtEquityRatioTTM ?? null,
        freeCashFlow: ratios.freeCashFlowPerShareTTM ?? null,
        eps: profile.eps ?? null,
        bookValue: ratios.bookValuePerShareTTM ?? null,
        revenuePerShare: ratios.revenuePerShareTTM ?? null,
        dividendYield,
        dividendRate: profile.lastDiv ?? null,
        payoutRatio: ratios.payoutRatioTTM ?? null,
        sharesOutstanding: profile.sharesOutstanding ?? null,
        floatShares: profile.floatShares ?? null
    };
}

async function getFundamentalsYahoo(ticker: string): Promise<Fundamentals> {
    const modules = 'defaultKeyStatistics,financialData,summaryDetail';
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=${modules}`;
    const response = await fetchWithProxy(url);

    if (!response) {
        throw new Error('Yahoo Finance unavailable');
    }

    const data = await safeJsonParse(response, 'Yahoo Fundamentals');
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
        currentRatio: raw(financial.currentRatio),
        quickRatio: raw(financial.quickRatio),
        debtToEquity: raw(financial.debtToEquity),
        freeCashFlow: raw(financial.freeCashflow),
        eps: raw(stats.trailingEps),
        bookValue: raw(stats.bookValue),
        revenuePerShare: raw(financial.revenuePerShare),
        dividendYield: raw(summary.dividendYield),
        dividendRate: raw(summary.dividendRate),
        payoutRatio: raw(summary.payoutRatio),
        sharesOutstanding: raw(stats.sharesOutstanding),
        floatShares: raw(stats.floatShares)
    };
}

function getDefaultFundamentals(): Fundamentals {
    return {
        peRatio: null, pegRatio: null, priceToBook: null,
        priceToSales: null, enterpriseValue: null, evToRevenue: null, evToEbitda: null,
        profitMargin: null, operatingMargin: null, grossMargin: null,
        returnOnEquity: null, returnOnAssets: null,
        revenueGrowth: null, earningsGrowth: null,
        currentRatio: null, quickRatio: null, debtToEquity: null,
        freeCashFlow: null,
        eps: null, bookValue: null, revenuePerShare: null,
        dividendYield: null, dividendRate: null, payoutRatio: null,
        sharesOutstanding: null, floatShares: null
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
    const gradeRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/grade/${ticker}?limit=30&apikey=${getFmpKey()}`);
    const targetRes = await fetchFmpWithRateLimit(`${FMP_BASE_URL}/price-target-consensus/${ticker}?apikey=${getFmpKey()}`);

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
    const url = `${FMP_BASE_URL}/profile/${ticker}?apikey=${getFmpKey()}`;
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
        sector: p.sector || '',
        industry: p.industry || '',
        website: p.website || '',
        employees: p.fullTimeEmployees || null,
        headquarters: [p.city, p.state, p.country].filter(Boolean).join(', '),
        founded: p.ipoDate || null,
        ceo: p.ceo || null,
        exchange: p.exchangeShortName || p.exchange || '',
        currency: p.currency || 'USD',
        country: p.country || ''
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
        sector: profile.sector || '',
        industry: profile.industry || '',
        website: profile.website || '',
        employees: profile.fullTimeEmployees || null,
        headquarters: [profile.city, profile.state, profile.country].filter(Boolean).join(', '),
        founded: null,
        ceo: profile.companyOfficers?.[0]?.name || null,
        exchange: quoteType.exchange || '',
        currency: quoteType.currency || 'USD',
        country: profile.country || ''
    };
}

function getDefaultProfile(ticker: string): CompanyProfile {
    return {
        ticker,
        name: ticker,
        description: '',
        sector: '',
        industry: '',
        website: '',
        employees: null,
        headquarters: '',
        founded: null,
        ceo: null,
        exchange: '',
        currency: 'USD',
        country: ''
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTICS & HEALTH CHECK
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Test connectivity to data sources
 * Useful for debugging API issues
 */
export async function testDataSources(): Promise<{
    fmp: { available: boolean; error: string | null; responseTime: number };
    yahoo: { available: boolean; error: string | null; responseTime: number };
    proxies: Array<{ index: number; available: boolean; error: string | null; responseTime: number }>;
}> {
    const results = {
        fmp: { available: false, error: null as string | null, responseTime: 0 },
        yahoo: { available: false, error: null as string | null, responseTime: 0 },
        proxies: [] as Array<{ index: number; available: boolean; error: string | null; responseTime: number }>
    };

    // Test FMP with a known ticker (AAPL)
    const fmpStart = Date.now();
    try {
        const url = `${FMP_BASE_URL}/quote/AAPL?apikey=${getFmpKey()}`;
        const response = await fetchFmpWithRateLimit(url, 5000);
        results.fmp.responseTime = Date.now() - fmpStart;
        if (response.ok) {
            const data = await response.json();
            results.fmp.available = Array.isArray(data) && data.length > 0;
            if (!results.fmp.available) {
                results.fmp.error = 'Empty response from FMP';
            }
        } else {
            results.fmp.error = `HTTP ${response.status}`;
        }
    } catch (error) {
        results.fmp.responseTime = Date.now() - fmpStart;
        results.fmp.error = error instanceof Error ? error.message : 'Unknown error';
    }

    // Test Yahoo Finance direct
    const yahooStart = Date.now();
    try {
        const url = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d';
        const response = await fetchWithTimeout(url, 5000);
        results.yahoo.responseTime = Date.now() - yahooStart;
        if (response.ok) {
            const data = await response.json();
            results.yahoo.available = !!data.chart?.result?.[0];
            if (!results.yahoo.available) {
                results.yahoo.error = 'Invalid response structure';
            }
        } else {
            results.yahoo.error = `HTTP ${response.status}`;
        }
    } catch (error) {
        results.yahoo.responseTime = Date.now() - yahooStart;
        results.yahoo.error = error instanceof Error ? error.message : 'Unknown error';
    }

    // Test each CORS proxy
    const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=1d';
    for (let i = 0; i < CORS_PROXIES.length; i++) {
        const proxyFn = CORS_PROXIES[i];
        const proxyStart = Date.now();
        const proxyResult = {
            index: i + 1,
            available: false,
            error: null as string | null,
            responseTime: 0
        };

        try {
            const response = await fetchWithTimeout(proxyFn(yahooUrl), 5000);
            proxyResult.responseTime = Date.now() - proxyStart;
            if (response.ok) {
                const data = await response.json();
                proxyResult.available = !!data.chart?.result?.[0];
                if (!proxyResult.available) {
                    proxyResult.error = 'Invalid response';
                }
            } else {
                proxyResult.error = `HTTP ${response.status}`;
            }
        } catch (error) {
            proxyResult.responseTime = Date.now() - proxyStart;
            proxyResult.error = error instanceof Error ? error.message : 'Unknown error';
        }

        results.proxies.push(proxyResult);
    }

    return results;
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
        const url = `${FMP_BASE_URL}/search?query=${encodeURIComponent(normalizedQuery)}&limit=10&apikey=${getFmpKey()}`;
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
