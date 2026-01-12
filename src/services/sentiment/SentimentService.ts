/**
 * Crypto News & Sentiment Service
 * 
 * Fetches crypto-related news and calculates sentiment scores.
 * Uses FREE sources:
 * - NewsData.io (200 credits/day free, has built-in sentiment)
 * - Alternative.me Fear & Greed Index (FREE, no key)
 * 
 * Caching Strategy:
 * - News: 30 minutes (conserve NewsData.io credits - 200/day = ~8/hour)
 * - Fear & Greed: 1 hour (updates daily)
 * 
 * NOT fetched every trading cycle - called on-demand with caching.
 */

import { logger } from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface NewsItem {
    id: string;
    title: string;
    summary: string;
    source: string;
    url: string;
    publishedAt: string;
    sentiment: 'positive' | 'negative' | 'neutral';
    sentimentScore: number; // -1 to 1
    relevance: number; // 0 to 1
    currencies?: string[]; // Related coins (BTC, ETH, etc.)
}

export interface SentimentAnalysis {
    overallScore: number; // -1 to 1
    overallSentiment: 'very_bullish' | 'bullish' | 'neutral' | 'bearish' | 'very_bearish';
    newsCount: number;
    positiveCount: number;
    negativeCount: number;
    neutralCount: number;
    recentNews: NewsItem[];
    fearGreedIndex?: FearGreedData;
    socialSentiment?: SocialSentiment;
    lastUpdated: string;
}

export interface FearGreedData {
    value: number; // 0-100
    classification: 'Extreme Fear' | 'Fear' | 'Neutral' | 'Greed' | 'Extreme Greed';
    timestamp: string;
    previousValue?: number;
    previousClassification?: string;
}

export interface SocialSentiment {
    bullishPercent: number;
    bearishPercent: number;
    tweetVolume24h?: number;
    socialVolume24h?: number;
    socialDominance?: number;
}

export interface CryptoSentimentContext {
    btc: SentimentAnalysis;
    eth: SentimentAnalysis;
    market: {
        fearGreedIndex: FearGreedData | null;
        overallSentiment: number; // -1 to 1
        sentimentTrend: 'improving' | 'declining' | 'stable';
    };
    lastUpdated: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL = {
    NEWS: 30 * 60 * 1000,        // 30 minutes for news (conserve NewsData.io credits)
    FEAR_GREED: 60 * 60 * 1000,  // 1 hour for fear/greed (updates daily)
};

const MAX_CACHE_SIZE = 100;
const REQUEST_TIMEOUT = 10000; // 10 seconds
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Cache with TTL tracking
interface CacheEntry<T> {
    data: T;
    timestamp: number;
    ttl: number;
}

// FIXED: Use class-based cache manager to prevent memory leaks
class CacheManager {
    private cache = new Map<string, CacheEntry<unknown>>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
        // Start periodic cleanup to prevent memory leaks from expired entries
        this.startCleanup();
    }

    private startCleanup(): void {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            this.removeExpiredEntries();
        }, CACHE_CLEANUP_INTERVAL);
        // Don't prevent process exit
        if (this.cleanupTimer.unref) {
            this.cleanupTimer.unref();
        }
    }

    private removeExpiredEntries(): void {
        const now = Date.now();
        // Collect keys to delete first to avoid modifying Map during iteration
        const keysToDelete: string[] = [];
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp >= entry.ttl) {
                keysToDelete.push(key);
            }
        }
        // Delete after iteration completes
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }
        if (keysToDelete.length > 0) {
            logger.debug(`Sentiment cache cleanup: removed ${keysToDelete.length} expired entries`);
        }
    }

    get<T>(key: string): T | null {
        const entry = this.cache.get(key) as CacheEntry<T> | undefined;
        if (entry && Date.now() - entry.timestamp < entry.ttl) {
            return entry.data;
        }
        // Remove expired entry
        if (entry) {
            this.cache.delete(key);
        }
        return null;
    }

    set<T>(key: string, data: T, ttl: number): void {
        // Check if key already exists - if so, just update (no eviction needed)
        if (this.cache.has(key)) {
            this.cache.set(key, { data, timestamp: Date.now(), ttl });
            return;
        }
        // LRU eviction with safety check
        if (this.cache.size >= MAX_CACHE_SIZE) {
            let oldestKey: string | undefined = undefined;
            let oldestTime = Infinity;
            let checked = 0;
            for (const [k, v] of this.cache.entries()) {
                if (v.timestamp < oldestTime) {
                    oldestTime = v.timestamp;
                    oldestKey = k;
                }
                // Safety: limit iterations to prevent infinite loop
                if (++checked >= MAX_CACHE_SIZE) break;
            }
            if (oldestKey !== undefined) this.cache.delete(oldestKey);
        }
        this.cache.set(key, { data, timestamp: Date.now(), ttl });
    }

    clear(): void {
        this.cache.clear();
        logger.info('Sentiment cache cleared');
    }

    shutdown(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}

const cacheManager = new CacheManager();

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIMENT WORD LISTS (CRYPTO-SPECIFIC)
// ═══════════════════════════════════════════════════════════════════════════════

// Strong positive words (weight 2)
const STRONG_POSITIVE = new Map<string, number>([
    ['surge', 2], ['soar', 2], ['skyrocket', 2], ['breakthrough', 2], ['moon', 2],
    ['bullish', 2], ['rally', 2], ['pump', 2], ['ath', 2], ['all-time-high', 2],
    ['adoption', 2], ['institutional', 2], ['etf', 2], ['approval', 2], ['partnership', 2],
    ['accumulation', 2], ['whale', 2], ['breakout', 2], ['parabolic', 2], ['explosive', 2],
]);

// Standard positive words (weight 1)
const STANDARD_POSITIVE = new Map<string, number>([
    ['gain', 1], ['rise', 1], ['up', 1], ['growth', 1], ['profit', 1],
    ['buy', 1], ['long', 1], ['support', 1], ['recovery', 1], ['bounce', 1],
    ['upgrade', 1], ['positive', 1], ['optimistic', 1], ['strong', 1], ['momentum', 1],
    ['accumulate', 1], ['hodl', 1], ['hold', 1], ['dip', 1], ['opportunity', 1],
    ['innovation', 1], ['launch', 1], ['mainnet', 1], ['staking', 1],
]);

// Strong negative words (weight 2)
const STRONG_NEGATIVE = new Map<string, number>([
    ['crash', 2], ['plunge', 2], ['collapse', 2], ['scam', 2], ['fraud', 2],
    ['hack', 2], ['exploit', 2], ['rug', 2], ['rugpull', 2], ['ponzi', 2],
    ['bearish', 2], ['dump', 2], ['capitulation', 2], ['liquidation', 2], ['rekt', 2],
    ['ban', 2], ['regulation', 2], ['sec', 2], ['lawsuit', 2], ['investigation', 2],
    ['bankruptcy', 2], ['insolvency', 2], ['ftx', 2], ['celsius', 2], ['terra', 2],
]);

// Standard negative words (weight 1)
const STANDARD_NEGATIVE = new Map<string, number>([
    ['drop', 1], ['fall', 1], ['decline', 1], ['down', 1], ['loss', 1],
    ['sell', 1], ['short', 1], ['resistance', 1], ['rejection', 1], ['correction', 1],
    ['weak', 1], ['negative', 1], ['concern', 1], ['risk', 1], ['warning', 1],
    ['fear', 1], ['uncertainty', 1], ['doubt', 1], ['fud', 1], ['volatile', 1],
    ['delay', 1], ['postpone', 1], ['cancel', 1], ['suspend', 1], ['halt', 1],
]);

// Negation words that flip sentiment
const NEGATION_WORDS = new Set([
    'not', 'no', 'never', 'neither', 'nobody', 'nothing', 'nowhere',
    'hardly', 'barely', 'scarcely', 'without', 'lack', 'lacking', 'fails',
    'dont', "don't", 'doesnt', "doesn't", 'didnt', "didn't", 'wont', "won't",
]);

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE UTILITIES (using CacheManager)
// ═══════════════════════════════════════════════════════════════════════════════

function getCached<T>(key: string): T | null {
    return cacheManager.get<T>(key);
}

function setCache<T>(key: string, data: T, ttl: number): void {
    cacheManager.set(key, data, ttl);
}

export function clearSentimentCache(): void {
    cacheManager.clear();
}

/**
 * Shutdown the sentiment service (cleanup timers, clear cache)
 * Call this when the application is shutting down
 */
export function shutdownSentimentService(): void {
    cacheManager.shutdown();
    logger.info('Sentiment service shutdown complete');
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIMENT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate sentiment score for text
 * Returns score from -1 (very negative) to 1 (very positive)
 */
export function calculateTextSentiment(text: string): number {
    if (!text || typeof text !== 'string') return 0;

    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 1);
    let positiveScore = 0;
    let negativeScore = 0;
    let negationActive = 0;

    for (const word of words) {
        // Check for negation (affects next 3 words)
        if (NEGATION_WORDS.has(word)) {
            negationActive = 3;
            continue;
        }

        const isNegated = negationActive > 0;

        // Check positive words
        const strongPos = STRONG_POSITIVE.get(word);
        const stdPos = STANDARD_POSITIVE.get(word);
        const posWeight = strongPos || stdPos || 0;

        // Check negative words
        const strongNeg = STRONG_NEGATIVE.get(word);
        const stdNeg = STANDARD_NEGATIVE.get(word);
        const negWeight = strongNeg || stdNeg || 0;

        if (posWeight > 0) {
            if (isNegated) {
                negativeScore += posWeight * 0.5;
            } else {
                positiveScore += posWeight;
            }
        }

        if (negWeight > 0) {
            if (isNegated) {
                positiveScore += negWeight * 0.5;
            } else {
                negativeScore += negWeight;
            }
        }

        if (negationActive > 0) negationActive--;
    }

    const total = positiveScore + negativeScore;
    if (total < 0.001) return 0;

    const normalized = (positiveScore - negativeScore) / total;
    return Number.isFinite(normalized) ? Math.max(-1, Math.min(1, normalized)) : 0;
}

function classifySentiment(score: number): 'positive' | 'negative' | 'neutral' {
    // FIXED: Validate input to catch NaN/Infinity bugs early
    if (!Number.isFinite(score)) return 'neutral';
    if (score > 0.15) return 'positive';
    if (score < -0.15) return 'negative';
    return 'neutral';
}

function getOverallSentiment(score: number): SentimentAnalysis['overallSentiment'] {
    // FIXED: Validate input to catch NaN/Infinity bugs early
    if (!Number.isFinite(score)) return 'neutral';
    if (score >= 0.5) return 'very_bullish';
    if (score >= 0.2) return 'bullish';
    if (score <= -0.5) return 'very_bearish';
    if (score <= -0.2) return 'bearish';
    return 'neutral';
}

// ═══════════════════════════════════════════════════════════════════════════════
// HTTP UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sensitive query parameter names to redact from URLs in error messages
 */
const SENSITIVE_PARAMS = new Set(['apikey', 'api_key', 'key', 'token', 'secret', 'password', 'auth']);

/**
 * Sanitize URL by redacting sensitive query parameters
 * Prevents API keys and tokens from leaking into error messages/logs
 */
function sanitizeUrlForLogging(url: string): string {
    try {
        const parsed = new URL(url);
        // Collect keys first to avoid modifying during iteration
        const keysToRedact: string[] = [];
        for (const param of parsed.searchParams.keys()) {
            if (SENSITIVE_PARAMS.has(param.toLowerCase())) {
                keysToRedact.push(param);
            }
        }
        for (const key of keysToRedact) {
            parsed.searchParams.set(key, '[REDACTED]');
        }
        return parsed.toString();
    } catch {
        // If URL parsing fails, do a simple regex-based redaction
        // Handle both encoded (=value) and unencoded values, stopping at & or end of string
        return url.replace(/([?&])(apikey|api_key|key|token|secret|password|auth)=[^&]*/gi, '$1$2=[REDACTED]');
    }
}

/**
 * Custom error for timeout/abort scenarios
 */
class FetchTimeoutError extends Error {
    constructor(url: string) {
        const sanitizedUrl = sanitizeUrlForLogging(url);
        super(`Request to ${sanitizedUrl} timed out after ${REQUEST_TIMEOUT}ms`);
        this.name = 'FetchTimeoutError';
    }
}

/**
 * Fetch with timeout - properly handles abort errors
 */
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal,
        });
        return response;
    } catch (error) {
        // Distinguish abort errors from other errors
        if (error instanceof Error && error.name === 'AbortError') {
            throw new FetchTimeoutError(url);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// FEAR & GREED INDEX (alternative.me - FREE)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Valid Fear & Greed classification values
 */
const VALID_FEAR_GREED_CLASSIFICATIONS = new Set<FearGreedData['classification']>([
    'Extreme Fear',
    'Fear',
    'Neutral',
    'Greed',
    'Extreme Greed',
]);

/**
 * Validate and map Fear & Greed classification from API
 * Returns a valid classification or derives one from the value
 */
function validateFearGreedClassification(
    apiClassification: string | undefined | null,
    value: number
): FearGreedData['classification'] {
    // Check if API classification is valid
    if (apiClassification && VALID_FEAR_GREED_CLASSIFICATIONS.has(apiClassification as FearGreedData['classification'])) {
        return apiClassification as FearGreedData['classification'];
    }

    // Derive classification from value as fallback
    if (value <= 20) return 'Extreme Fear';
    if (value <= 40) return 'Fear';
    if (value <= 60) return 'Neutral';
    if (value <= 80) return 'Greed';
    return 'Extreme Greed';
}

/**
 * Fetch Bitcoin Fear & Greed Index from alternative.me
 * FREE API, no key required, updates daily
 */
export async function fetchFearGreedIndex(): Promise<FearGreedData | null> {
    const cacheKey = 'fear_greed_index';
    const cached = getCached<FearGreedData>(cacheKey);
    if (cached) return cached;

    try {
        const response = await fetchWithTimeout(
            'https://api.alternative.me/fng/?limit=2&format=json'
        );

        if (!response.ok) {
            logger.warn(`Fear & Greed API returned ${response.status}`);
            return null;
        }

        const data = await response.json() as { data?: Array<{ value: string; value_classification: string; timestamp: string }> };
        if (!data.data || data.data.length === 0) {
            logger.warn('Fear & Greed API returned empty data');
            return null;
        }

        const current = data.data[0];
        const previous = data.data[1];

        // FIXED: Validate parseInt results to prevent NaN
        const currentValue = parseInt(current.value, 10);
        const currentTimestamp = parseInt(current.timestamp, 10);

        if (!Number.isFinite(currentValue) || !Number.isFinite(currentTimestamp)) {
            logger.warn('Fear & Greed API returned invalid numeric data');
            return null;
        }

        // FIXED: Validate previousValue if present
        const previousValue = previous ? parseInt(previous.value, 10) : undefined;
        const validPreviousValue = previousValue !== undefined && Number.isFinite(previousValue)
            ? previousValue
            : undefined;

        // FIXED: Validate classification instead of unsafe cast
        const classification = validateFearGreedClassification(current.value_classification, currentValue);
        const previousClassification = validPreviousValue !== undefined
            ? validateFearGreedClassification(previous?.value_classification, validPreviousValue)
            : undefined;

        const result: FearGreedData = {
            value: currentValue,
            classification,
            timestamp: new Date(currentTimestamp * 1000).toISOString(),
            previousValue: validPreviousValue,
            previousClassification,
        };

        setCache(cacheKey, result, CACHE_TTL.FEAR_GREED);
        logger.debug(`Fear & Greed Index: ${result.value} (${result.classification})`);
        return result;
    } catch (error) {
        // FIXED: Better error logging with type distinction
        if (error instanceof FetchTimeoutError) {
            logger.warn(`Fear & Greed API timeout: ${error.message}`);
        } else {
            logger.warn('Failed to fetch Fear & Greed Index:', error);
        }
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEWSDATA.IO (PRIMARY - 200 credits/day free, built-in sentiment)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * NewsData.io API response types
 */
interface NewsDataArticle {
    article_id: string;
    title: string;
    description: string | null;
    content: string | null;
    pubDate: string;
    source_id: string;
    source_name: string;
    link: string;
    sentiment: 'positive' | 'negative' | 'neutral' | null;
    sentiment_stats: {
        positive: number;
        negative: number;
        neutral: number;
    } | null;
    ai_tag: string[] | null;
    ai_region: string[] | null;
    ai_org: string[] | null;
}

interface NewsDataResponse {
    status: string;
    totalResults: number;
    results: NewsDataArticle[] | null;
    nextPage: string | null;
}

/**
 * Fetch news from NewsData.io
 * FREE tier: 200 credits/day, 30 credits per 15 minutes
 * Has built-in sentiment analysis - no need for custom word-based analysis
 * 
 * @param query - Search query (e.g., "bitcoin", "ethereum", "crypto")
 */
async function fetchNewsDataNews(query: string = 'cryptocurrency'): Promise<NewsItem[]> {
    const apiKey = process.env.NEWSDATA_API_KEY;
    if (!apiKey) {
        logger.debug('NEWSDATA_API_KEY not set, skipping NewsData.io');
        return [];
    }

    // Build URL with crypto category
    // NOTE: sentiment parameter requires paid plan, so we use our own text analysis
    const params = new URLSearchParams({
        apikey: apiKey,
        q: query,
        category: 'business',  // Crypto news often in business category
        language: 'en',
    });

    const url = `https://newsdata.io/api/1/news?${params.toString()}`;

    try {
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            logger.warn(`NewsData.io API returned ${response.status}: ${errorText}`);
            return [];
        }

        const data = await response.json() as NewsDataResponse;

        if (data.status !== 'success' || !data.results || !Array.isArray(data.results)) {
            logger.warn('NewsData.io returned no results or error status');
            return [];
        }

        return data.results.slice(0, 20).map((article, index) => {
            // Use NewsData.io's built-in sentiment if available
            let sentimentScore = 0;
            let sentiment: 'positive' | 'negative' | 'neutral' = 'neutral';

            if (article.sentiment_stats) {
                // Calculate score from sentiment stats (-1 to 1)
                const { positive, negative, neutral } = article.sentiment_stats;
                const total = positive + negative + neutral;
                if (total > 0) {
                    sentimentScore = (positive - negative) / total;
                    // Validate the score
                    if (!Number.isFinite(sentimentScore)) {
                        sentimentScore = 0;
                    }
                }
            } else if (article.sentiment) {
                // Use simple sentiment label
                sentiment = article.sentiment;
                sentimentScore = article.sentiment === 'positive' ? 0.5
                    : article.sentiment === 'negative' ? -0.5
                        : 0;
            } else {
                // Fallback to text analysis if no sentiment provided
                const text = `${article.title || ''} ${article.description || ''}`;
                sentimentScore = calculateTextSentiment(text);
            }

            sentiment = classifySentiment(sentimentScore);

            // FIXED: Safe ai_tag check with type validation
            const hasCryptoTag = Array.isArray(article.ai_tag) && article.ai_tag.some(tag =>
                typeof tag === 'string' &&
                ['bitcoin', 'cryptocurrency', 'ethereum', 'crypto', 'blockchain'].includes(tag.toLowerCase())
            );

            return {
                id: `newsdata-${article.article_id || index}`,
                title: article.title || '',
                summary: article.description || article.title || '',
                source: article.source_name || article.source_id || 'NewsData.io',
                url: article.link || '',
                publishedAt: article.pubDate ?? '',  // Preserve missing date instead of fabricating
                sentiment,
                sentimentScore,
                relevance: hasCryptoTag ? 0.95 : 0.7,
                currencies: extractCurrenciesFromText((article.title || '') + ' ' + (article.description || '')),
            };
        });
    } catch (error) {
        if (error instanceof FetchTimeoutError) {
            logger.warn(`NewsData.io timeout: ${error.message}`);
        } else {
            logger.warn('Failed to fetch NewsData.io news:', error);
        }
        return [];
    }
}

/**
 * Extract cryptocurrency symbols from text
 * Uses word-boundary regex to avoid false positives (e.g., "CANADA" matching "ADA")
 */
function extractCurrenciesFromText(text: string | null | undefined): string[] {
    if (!text || typeof text !== 'string') return [];

    const currencies: string[] = [];
    const upperText = text.toUpperCase();

    // Common crypto symbols to detect
    const cryptoSymbols = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'DOT', 'AVAX', 'MATIC', 'LINK'];
    const cryptoNames: Record<string, string> = {
        'BITCOIN': 'BTC',
        'ETHEREUM': 'ETH',
        'SOLANA': 'SOL',
        'RIPPLE': 'XRP',
        'CARDANO': 'ADA',
        'DOGECOIN': 'DOGE',
        'POLKADOT': 'DOT',
        'AVALANCHE': 'AVAX',
        'POLYGON': 'MATIC',
        'CHAINLINK': 'LINK',
    };

    // Check for symbols using word-boundary regex to avoid false positives
    // Allows: $BTC, (BTC), BTC., BTC, etc. but not CANADA matching ADA
    for (const symbol of cryptoSymbols) {
        // Pattern: word boundary OR common prefix ($, (, [) before symbol,
        // followed by word boundary OR common suffix (., ,, ), ], space, end)
        const pattern = new RegExp(`(?:^|[\\s$([])${symbol}(?=[\\s.,)\\]:]|$)`, 'i');
        if (pattern.test(upperText)) {
            currencies.push(symbol);
        }
    }

    // Check for full names using word-boundary regex
    for (const [name, symbol] of Object.entries(cryptoNames)) {
        const pattern = new RegExp(`\\b${name}\\b`, 'i');
        if (pattern.test(upperText) && !currencies.includes(symbol)) {
            currencies.push(symbol);
        }
    }

    return currencies;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN SENTIMENT FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize cryptocurrency symbol to standard format
 * Handles various input formats: "cmt_btcusdt", "BTC/USDT", "BTCUSDT", "btc", etc.
 * Returns uppercase symbol like "BTC", "ETH"
 */
function normalizeSymbol(symbol: string): string {
    if (!symbol || typeof symbol !== 'string') return '';

    // Convert to lowercase for consistent processing
    let normalized = symbol.toLowerCase();

    // Remove known prefixes (case-insensitive)
    normalized = normalized.replace(/^cmt_/i, '');

    // Remove delimiters
    normalized = normalized.replace(/[\/\-_]/g, '');

    // Remove known quote currencies (case-insensitive)
    // FIXED: Match longer suffixes first to avoid "btcbusd" -> "btcb" issue
    normalized = normalized.replace(/(busd|usdt|usd)$/i, '');

    // Return uppercase
    return normalized.toUpperCase();
}

/**
 * Get news for a specific cryptocurrency
 * Uses NewsData.io for news with built-in sentiment analysis
 */
export async function getCryptoNews(
    symbol: string,
    maxItems: number = 15
): Promise<NewsItem[]> {
    // Validate maxItems
    const safeMaxItems = Number.isFinite(maxItems) && maxItems > 0 ? Math.min(maxItems, 100) : 15;

    // Normalize symbol (handles: cmt_btcusdt, BTC/USDT, BTCUSDT, btc, etc.)
    const currency = normalizeSymbol(symbol);
    if (!currency) {
        logger.warn(`getCryptoNews: invalid symbol: ${symbol}`);
        return [];
    }

    const cacheKey = `news:${currency}`;

    const cached = getCached<NewsItem[]>(cacheKey);
    if (cached) return cached;

    // Map symbol to search query for NewsData.io
    const queryMap: Record<string, string> = {
        'BTC': 'bitcoin',
        'ETH': 'ethereum',
        'SOL': 'solana',
        'XRP': 'ripple',
        'ADA': 'cardano',
    };
    const query = queryMap[currency] || currency.toLowerCase();

    // Fetch from NewsData.io
    const news = await fetchNewsDataNews(query);

    // Filter by currency if we got general crypto news
    const filteredNews = news.filter(item => {
        // Keep if currencies array includes our target
        if (item.currencies && item.currencies.includes(currency)) return true;
        // Keep if title/summary mentions the currency (boundary-aware to avoid false matches)
        // e.g., "ETH" should not match "TOGETHER" or "THE"
        const text = `${item.title} ${item.summary}`.toUpperCase();
        // Use word-boundary regex: allows $ETH, (ETH), ETH., etc. but not TOGETHER
        const currencyPattern = new RegExp(`(?:^|[\\s$([])${currency}(?=[\\s.,)\\]:]|$)`, 'i');
        const queryPattern = new RegExp(`\\b${query.toUpperCase()}\\b`, 'i');
        return currencyPattern.test(text) || queryPattern.test(text);
    });

    // Use filtered if we have enough, otherwise use all
    const finalNews = filteredNews.length >= 3 ? filteredNews : news;

    // FIXED: Safe date sorting with NaN handling
    const sortedNews = finalNews
        .sort((a, b) => {
            const timeA = new Date(a.publishedAt).getTime();
            const timeB = new Date(b.publishedAt).getTime();
            // Handle invalid dates - push them to the end
            if (!Number.isFinite(timeA) && !Number.isFinite(timeB)) return 0;
            if (!Number.isFinite(timeA)) return 1;
            if (!Number.isFinite(timeB)) return -1;
            return timeB - timeA;
        })
        .slice(0, safeMaxItems);

    setCache(cacheKey, sortedNews, CACHE_TTL.NEWS);
    return sortedNews;
}

/**
 * Analyze sentiment from news items
 */
export function analyzeNewsSentiment(news: NewsItem[]): Omit<SentimentAnalysis, 'fearGreedIndex' | 'socialSentiment' | 'lastUpdated'> {
    // Validate input
    if (!Array.isArray(news) || news.length === 0) {
        return {
            overallScore: 0,
            overallSentiment: 'neutral',
            newsCount: 0,
            positiveCount: 0,
            negativeCount: 0,
            neutralCount: 0,
            recentNews: [],
        };
    }

    let totalScore = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;
    let validItemCount = 0;

    for (const item of news) {
        // Skip invalid items
        if (!item || typeof item !== 'object') continue;

        validItemCount++;

        // FIXED: Guard against NaN sentiment scores
        const score = Number.isFinite(item.sentimentScore) ? item.sentimentScore : 0;
        totalScore += score;

        const sentiment = item.sentiment || 'neutral';
        if (sentiment === 'positive') positiveCount++;
        else if (sentiment === 'negative') negativeCount++;
        else neutralCount++;
    }

    // FIXED: Ensure overallScore is always a valid number
    const overallScore = validItemCount > 0 && Number.isFinite(totalScore / validItemCount)
        ? totalScore / validItemCount
        : 0;

    // Filter valid news items for recentNews
    const validNews = news.filter(item => item && typeof item === 'object');

    return {
        overallScore,
        overallSentiment: getOverallSentiment(overallScore),
        newsCount: validItemCount,
        positiveCount,
        negativeCount,
        neutralCount,
        recentNews: validNews.slice(0, 10),
    };
}

/**
 * Get full sentiment analysis for a cryptocurrency
 */
export async function getSentimentAnalysis(symbol: string): Promise<SentimentAnalysis> {
    // Use shared normalizeSymbol for consistent handling
    const currency = normalizeSymbol(symbol);

    // Guard against empty/invalid normalized symbol
    if (!currency) {
        logger.warn(`getSentimentAnalysis: invalid symbol after normalization: ${symbol}`);
        // Return a default empty analysis instead of caching with invalid key
        return {
            overallScore: 0,
            overallSentiment: 'neutral',
            newsCount: 0,
            positiveCount: 0,
            negativeCount: 0,
            neutralCount: 0,
            recentNews: [],
            lastUpdated: new Date().toISOString(),
        };
    }

    const cacheKey = `sentiment:${currency}`;

    const cached = getCached<SentimentAnalysis>(cacheKey);
    if (cached) return cached;

    const [news, fearGreed] = await Promise.all([
        getCryptoNews(currency), // Use normalized currency
        fetchFearGreedIndex(),
    ]);

    const newsAnalysis = analyzeNewsSentiment(news);

    const analysis: SentimentAnalysis = {
        ...newsAnalysis,
        fearGreedIndex: fearGreed || undefined,
        lastUpdated: new Date().toISOString(),
    };

    setCache(cacheKey, analysis, CACHE_TTL.NEWS);
    return analysis;
}

// FIXED: Race condition protection for concurrent fetches
let marketSentimentFetchPromise: Promise<CryptoSentimentContext> | null = null;

/**
 * Get comprehensive market sentiment context
 * This is the main function to call for AI context enrichment
 * 
 * FIXED: Prevents race condition where multiple concurrent calls
 * could trigger parallel API requests before cache is populated.
 * Also handles rejection properly so concurrent waiters don't all fail.
 */
export async function getMarketSentimentContext(): Promise<CryptoSentimentContext> {
    const cacheKey = 'market_sentiment_context';
    const cached = getCached<CryptoSentimentContext>(cacheKey);
    if (cached) return cached;

    // FIXED: If a fetch is already in progress, wait for it instead of starting another
    if (marketSentimentFetchPromise) {
        return marketSentimentFetchPromise;
    }

    // Start the fetch and store the promise
    // FIXED: Wrap in try-catch to handle rejection and clear promise properly
    // FIXED: Don't clear promise in finally - let concurrent waiters complete first
    marketSentimentFetchPromise = (async () => {
        try {
            // Fetch all sentiment data in parallel
            // NOTE: Removed CoinGecko call - was fetched but never used (wasting API calls)
            const [btcSentiment, ethSentiment, fearGreed] = await Promise.all([
                getSentimentAnalysis('BTC'),
                getSentimentAnalysis('ETH'),
                fetchFearGreedIndex(),
            ]);

            // Calculate overall market sentiment
            const btcWeight = 0.6; // BTC dominates sentiment
            const ethWeight = 0.4;

            // FIXED: Validate individual scores before calculation
            const btcScore = Number.isFinite(btcSentiment.overallScore) ? btcSentiment.overallScore : 0;
            const ethScore = Number.isFinite(ethSentiment.overallScore) ? ethSentiment.overallScore : 0;
            const rawOverallSentiment = (btcScore * btcWeight) + (ethScore * ethWeight);

            // FIXED: Validate overall sentiment
            const overallSentiment = Number.isFinite(rawOverallSentiment) ? rawOverallSentiment : 0;

            // Determine sentiment trend from Fear & Greed changes
            let sentimentTrend: 'improving' | 'declining' | 'stable' = 'stable';
            if (fearGreed?.previousValue !== undefined && Number.isFinite(fearGreed.previousValue) && Number.isFinite(fearGreed.value)) {
                const change = fearGreed.value - fearGreed.previousValue;
                if (change > 5) sentimentTrend = 'improving';
                else if (change < -5) sentimentTrend = 'declining';
            }

            const context: CryptoSentimentContext = {
                btc: btcSentiment,
                eth: ethSentiment,
                market: {
                    fearGreedIndex: fearGreed,
                    overallSentiment,
                    sentimentTrend,
                },
                lastUpdated: new Date().toISOString(),
            };

            setCache(cacheKey, context, CACHE_TTL.NEWS);
            logger.info(`Market sentiment updated: F&G=${fearGreed?.value ?? 'N/A'}, Overall=${overallSentiment.toFixed(2)}`);
            return context;
        } finally {
            // FIXED: Clear promise INSIDE the async function, after result is ready
            // This ensures concurrent waiters get the result before promise is cleared
            marketSentimentFetchPromise = null;
        }
    })();

    try {
        return await marketSentimentFetchPromise;
    } catch (error) {
        // Promise is already cleared in the inner finally block
        throw error;
    }
}

/**
 * Convert sentiment context to a string for AI prompts
 * Compact format to minimize token usage
 */
export function formatSentimentForPrompt(context: CryptoSentimentContext): string {
    // Validate context structure
    if (!context || !context.market || !context.btc || !context.eth) {
        return '=== MARKET SENTIMENT ===\nNo sentiment data available.';
    }

    const fg = context.market.fearGreedIndex;
    const fgStr = fg && Number.isFinite(fg.value)
        ? `Fear/Greed: ${fg.value}/100 (${fg.classification})${fg.previousValue !== undefined && Number.isFinite(fg.previousValue) ? ` [prev: ${fg.previousValue}]` : ''}`
        : 'Fear/Greed: N/A';

    // FIXED: Safe toFixed with NaN guard
    const formatScore = (score: number): string =>
        Number.isFinite(score) ? score.toFixed(2) : '0.00';

    // FIXED: Safe array access for recentNews
    const btcRecentNews = Array.isArray(context.btc.recentNews) ? context.btc.recentNews : [];
    const ethRecentNews = Array.isArray(context.eth.recentNews) ? context.eth.recentNews : [];

    const btcNews = btcRecentNews.slice(0, 3);
    const btcHeadlines = btcNews.length > 0
        ? btcNews.map(n => `  - [${n.sentiment || 'neutral'}] ${(n.title || '').slice(0, 80)}`).join('\n')
        : '  - No recent news';

    const ethNews = ethRecentNews.slice(0, 2);
    const ethHeadlines = ethNews.length > 0
        ? ethNews.map(n => `  - [${n.sentiment || 'neutral'}] ${(n.title || '').slice(0, 80)}`).join('\n')
        : '  - No recent news';

    return `
=== MARKET SENTIMENT ===
${fgStr}
Market Sentiment: ${formatScore(context.market.overallSentiment)} (${context.market.sentimentTrend || 'stable'})
Last Updated: ${context.lastUpdated || 'N/A'}

BTC Sentiment: ${context.btc.overallSentiment || 'neutral'} (score: ${formatScore(context.btc.overallScore)})
  News: ${context.btc.positiveCount || 0} positive, ${context.btc.negativeCount || 0} negative, ${context.btc.neutralCount || 0} neutral
${btcHeadlines}

ETH Sentiment: ${context.eth.overallSentiment || 'neutral'} (score: ${formatScore(context.eth.overallScore)})
  News: ${context.eth.positiveCount || 0} positive, ${context.eth.negativeCount || 0} negative, ${context.eth.neutralCount || 0} neutral
${ethHeadlines}
`.trim();
}

/**
 * Get sentiment score for a specific symbol
 * Quick lookup for individual coin sentiment
 */
export async function getSymbolSentimentScore(symbol: string): Promise<{
    score: number;
    sentiment: string;
    newsCount: number;
}> {
    const analysis = await getSentimentAnalysis(symbol);
    return {
        score: analysis.overallScore,
        sentiment: analysis.overallSentiment,
        newsCount: analysis.newsCount,
    };
}

/**
 * Check if sentiment is extreme (contrarian signal)
 * Returns signal strength: -2 to +2
 * Positive = bullish contrarian (extreme fear = buy signal)
 * Negative = bearish contrarian (extreme greed = sell signal)
 */
export function checkContrarianSignal(context: CryptoSentimentContext): {
    signal: number;
    reason: string;
} {
    const fg = context.market.fearGreedIndex;

    if (!fg || !Number.isFinite(fg.value)) {
        return { signal: 0, reason: 'No Fear/Greed data available' };
    }

    // Extreme fear (0-20) = strong buy signal
    if (fg.value <= 20) {
        return {
            signal: 2,
            reason: `Extreme Fear (${fg.value}) - Strong contrarian BUY signal`
        };
    }

    // Fear (21-40) = moderate buy signal
    if (fg.value <= 40) {
        return {
            signal: 1,
            reason: `Fear (${fg.value}) - Moderate contrarian BUY signal`
        };
    }

    // Greed (60-79) = moderate sell signal
    if (fg.value >= 60 && fg.value < 80) {
        return {
            signal: -1,
            reason: `Greed (${fg.value}) - Moderate contrarian SELL signal`
        };
    }

    // Extreme greed (80-100) = strong sell signal
    if (fg.value >= 80) {
        return {
            signal: -2,
            reason: `Extreme Greed (${fg.value}) - Strong contrarian SELL signal`
        };
    }

    return { signal: 0, reason: `Neutral sentiment (${fg.value})` };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SINGLETON & EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

// Service state
let lastFetchTime = 0;
const MIN_FETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes minimum between full fetches

/**
 * Get sentiment context with rate limiting
 * Safe to call frequently - will return cached data if called too often
 */
export async function getSentimentContextSafe(): Promise<CryptoSentimentContext | null> {
    const now = Date.now();

    // Check if we have recent cached data
    const cached = getCached<CryptoSentimentContext>('market_sentiment_context');
    if (cached) return cached;

    // Rate limit full fetches
    if (now - lastFetchTime < MIN_FETCH_INTERVAL) {
        logger.debug('Sentiment fetch rate limited, returning null');
        return null;
    }

    try {
        const result = await getMarketSentimentContext();
        // FIXED: Only update lastFetchTime on successful fetch
        lastFetchTime = Date.now();
        return result;
    } catch (error) {
        logger.error('Failed to fetch sentiment context:', error);
        // Don't update lastFetchTime on failure - allow retry
        return null;
    }
}

/**
 * Initialize sentiment service (pre-warm cache)
 * Call this at startup to have sentiment data ready
 */
export async function initializeSentimentService(): Promise<void> {
    logger.info('Initializing sentiment service...');
    try {
        await getMarketSentimentContext();
        logger.info('Sentiment service initialized successfully');
    } catch (error) {
        logger.warn('Sentiment service initialization failed (will retry on demand):', error);
    }
}

/**
 * Reset service state (for testing or hot reload)
 */
export function resetSentimentServiceState(): void {
    lastFetchTime = 0;
    marketSentimentFetchPromise = null;
    cacheManager.clear();
    logger.info('Sentiment service state reset');
}

export default {
    getCryptoNews,
    getSentimentAnalysis,
    getMarketSentimentContext,
    formatSentimentForPrompt,
    getSymbolSentimentScore,
    checkContrarianSignal,
    getSentimentContextSafe,
    initializeSentimentService,
    shutdownSentimentService,
    resetSentimentServiceState,
    fetchFearGreedIndex,
    calculateTextSentiment,
    clearSentimentCache,
};
