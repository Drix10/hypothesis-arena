/**
 * RedditSentimentService - FREE Reddit Social Sentiment (v5.2.0)
 * Fetches crypto sentiment from Reddit using FREE JSON endpoints (no API key needed).
 * Monitors: r/cryptocurrency, r/bitcoin, r/ethereum
 */

import { logger } from '../../utils/logger';
import { calculateTextSentiment } from './SentimentService';
import { config } from '../../config';

export interface RedditSentimentResult {
    subreddit: string;
    postCount: number;
    avgScore: number;
    avgUpvoteRatio: number;
    sentimentScore: number;
    sentiment: 'bullish' | 'bearish' | 'neutral';
    topPosts: Array<{
        title: string;
        score: number;
        sentiment: 'positive' | 'negative' | 'neutral';
        permalink: string;
        ageHours: number;             // Post age in hours (from created_utc)
    }>;
    volumeVsAverage: number;          // Post activity vs normal (1.0 = average)
    lastUpdated: string;
}

export interface RedditSentimentContext {
    overall: {
        sentimentScore: number;       // -1 to +1 (weighted average)
        sentiment: 'bullish' | 'bearish' | 'neutral';
        postCount: number;            // Total posts analyzed
        avgPostAge: number;           // Hours - freshness indicator
    };
    btc: RedditSentimentResult | null;
    eth: RedditSentimentResult | null;
    general: RedditSentimentResult | null;

    // Derived signals
    socialVsPriceDivergence: number;  // -2 to +2
    contrarian: {
        signal: number;               // -2 to +2
        reason: string;
    };
    topHeadlines: string[];           // Top 5 post titles (truncated to 100 chars)

    // Metadata
    fetchedAt: string;
    isStale: boolean;                 // True if data > STALE_THRESHOLD_MINUTES old
}

// Reddit JSON response structure
interface RedditPost {
    title: string;
    selftext: string;
    score: number;
    upvote_ratio: number;
    num_comments: number;
    created_utc: number;
    subreddit: string;
    link_flair_text: string | null;
    over_18: boolean;
    stickied: boolean;
    is_self: boolean;
    permalink: string;
}

interface RedditListing {
    kind: 'Listing';
    data: {
        children: Array<{
            kind: 't3';
            data: RedditPost;
        }>;
    };
}



const REDDIT_ENDPOINTS = [
    { url: 'https://www.reddit.com/r/cryptocurrency/hot.json?limit=50', name: 'general', weight: 1.5 },
    { url: 'https://www.reddit.com/r/bitcoin/hot.json?limit=50', name: 'btc', weight: 1.2 },
    { url: 'https://www.reddit.com/r/ethereum/hot.json?limit=50', name: 'eth', weight: 1.0 },
];

// Validate config.reddit exists and provide safe defaults
if (!config.reddit || typeof config.reddit !== 'object') {
    throw new Error('❌ FATAL: config.reddit is missing or invalid. Check src/config/index.ts');
}

// Reddit configuration with validation and safe defaults
const REDDIT_CACHE_TTL = Number.isFinite(config.reddit.cacheTtlMs) && config.reddit.cacheTtlMs > 0
    ? config.reddit.cacheTtlMs
    : 1800000;  // Default: 30 minutes

const REQUEST_DELAY = Math.max(2500, Number.isFinite(config.reddit.requestDelayMs)
    ? config.reddit.requestDelayMs
    : 2500);  // Minimum 2.5 seconds between requests (Reddit rate limit protection)

const REQUEST_TIMEOUT = Number.isFinite(config.reddit.requestTimeoutMs) && config.reddit.requestTimeoutMs > 0
    ? config.reddit.requestTimeoutMs
    : 10000;  // Default: 10 second timeout

const STALE_THRESHOLD = (() => {
    const value = Number.isFinite(config.reddit.staleThresholdMs) && config.reddit.staleThresholdMs > 0
        ? config.reddit.staleThresholdMs
        : 1200000;  // Default: 20 minutes
    // Ensure stale threshold is less than cache TTL (otherwise data is never "fresh")
    // Guard against negative values if cache TTL is very small
    const maxStaleThreshold = Math.max(60000, REDDIT_CACHE_TTL - 60000);  // At least 1 min, and 1 min less than cache TTL
    return Math.min(value, maxStaleThreshold);
})();

const STALE_THRESHOLD_MINUTES = Math.round(STALE_THRESHOLD / 60000);  // Human-readable version

const MAX_POST_AGE_HOURS = Number.isFinite(config.reddit.maxPostAgeHours) && config.reddit.maxPostAgeHours > 0
    ? config.reddit.maxPostAgeHours
    : 24;  // Default: Only analyze posts < 24h old

// Dynamic User-Agent: Use env var if set, otherwise construct from package.json version
// Cache the user agent string to avoid repeated file reads
let cachedUserAgent: string | null = null;

// Single source of truth for fallback version - update this when version changes
const FALLBACK_VERSION = '5.4.0';

function getRedditUserAgent(): string {
    // Return cached value if available
    if (cachedUserAgent) {
        return cachedUserAgent;
    }

    // Check env var first
    if (process.env.REDDIT_USER_AGENT) {
        cachedUserAgent = process.env.REDDIT_USER_AGENT;
        return cachedUserAgent;
    }

    // Read version from package.json at runtime
    try {
        // Use dynamic import path resolution to handle different build scenarios
        const pkg = require('../../../package.json') as { version?: string };
        const version = typeof pkg.version === 'string' && pkg.version.length > 0
            ? pkg.version
            : FALLBACK_VERSION;
        cachedUserAgent = `HypothesisArena/${version} (trading bot, respectful scraping)`;
        return cachedUserAgent;
    } catch {
        // Fallback if package.json can't be read (e.g., bundled builds)
        cachedUserAgent = `HypothesisArena/${FALLBACK_VERSION} (trading bot, respectful scraping)`;
        return cachedUserAgent;
    }
}

const USER_AGENT = getRedditUserAgent();



interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

// Validate MAX_CACHE_SIZE for LRU eviction - must be positive integer
const MAX_CACHE_SIZE = (() => {
    const value = config.reddit.maxCacheSize;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return Math.floor(value);  // Ensure integer
    }
    return 50;  // Safe default
})();
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

class RedditCacheManager {
    private cache = new Map<string, CacheEntry<unknown>>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor() {
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
            if (now - entry.timestamp >= REDDIT_CACHE_TTL) {
                keysToDelete.push(key);
            }
        }
        // Delete after iteration completes
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }
        if (keysToDelete.length > 0) {
            logger.debug(`Reddit cache cleanup: removed ${keysToDelete.length} expired entries`);
        }
    }

    get<T>(key: string): T | null {
        const entry = this.cache.get(key) as CacheEntry<T> | undefined;
        if (entry && Date.now() - entry.timestamp < REDDIT_CACHE_TTL) {
            // LRU: Move to end by deleting and re-adding (Map maintains insertion order)
            this.cache.delete(key);
            this.cache.set(key, entry);
            return entry.data;
        }
        if (entry) {
            this.cache.delete(key);
        }
        return null;
    }

    set<T>(key: string, data: T): void {
        // Check if key already exists - if so, just update position (no eviction needed)
        if (this.cache.has(key)) {
            this.cache.delete(key);
            this.cache.set(key, { data, timestamp: Date.now() });
            return;
        }
        // LRU eviction: remove oldest entry (first in Map) if at capacity
        if (this.cache.size >= MAX_CACHE_SIZE) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey !== undefined) this.cache.delete(oldestKey);
        }
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    clear(): void {
        this.cache.clear();
        logger.info('Reddit sentiment cache cleared');
    }

    shutdown(): void {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        this.cache.clear();
    }
}

const redditCacheManager = new RedditCacheManager();

function getCached<T>(key: string): T | null {
    return redditCacheManager.get<T>(key);
}

function setCache<T>(key: string, data: T): void {
    redditCacheManager.set(key, data);
}

export function clearRedditCache(): void {
    redditCacheManager.clear();
}

// Race condition protection - declared before shutdownRedditService to avoid TDZ
let redditFetchPromise: Promise<RedditSentimentContext | null> | null = null;

/**
 * Shutdown the Reddit sentiment service (cleanup timers, clear cache)
 * Call this when the application is shutting down
 */
export function shutdownRedditService(): void {
    redditCacheManager.shutdown();
    redditFetchPromise = null;
    logger.info('Reddit sentiment service shutdown complete');
}



function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function classifySentiment(score: number): 'positive' | 'negative' | 'neutral' {
    if (!Number.isFinite(score)) return 'neutral';
    if (score > 0.15) return 'positive';
    if (score < -0.15) return 'negative';
    return 'neutral';
}

function classifyOverallSentiment(score: number): 'bullish' | 'bearish' | 'neutral' {
    if (!Number.isFinite(score)) return 'neutral';
    if (score > 0.15) return 'bullish';
    if (score < -0.15) return 'bearish';
    return 'neutral';
}



/**
 * Fetch and analyze sentiment from a single subreddit
 */
async function fetchSubredditSentiment(
    url: string,
    name: string,
    _weight: number  // Reserved for future weighted aggregation
): Promise<RedditSentimentResult | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    if ((timeoutId as any).unref) {
        (timeoutId as any).unref();
    }

    try {
        let response: Response;
        let data: RedditListing;

        try {
            response = await fetch(url, {
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'application/json',
                },
                signal: controller.signal,
            });

            if (!response.ok) {
                logger.warn(`Reddit ${name} returned ${response.status}`);
                return null;
            }

            data = await response.json() as RedditListing;
        } finally {
            // Always clear timeout whether fetch/json succeeds or throws
            clearTimeout(timeoutId);
        }

        // Validate response structure
        if (!data?.data?.children || !Array.isArray(data.data.children)) {
            logger.warn(`Reddit ${name} returned invalid structure`);
            return null;
        }

        const now = Date.now() / 1000;  // Unix timestamp

        // Filter posts
        const posts = data.data.children
            .map(c => c.data)
            .filter((post): post is RedditPost => {
                if (!post || typeof post !== 'object') return false;
                if (post.stickied) return false;           // Skip mod posts
                if (post.over_18) return false;            // Skip NSFW
                // Skip posts older than 24 hours
                const ageHours = (now - post.created_utc) / 3600;
                if (ageHours > MAX_POST_AGE_HOURS) return false;
                return true;
            });

        if (posts.length === 0) {
            logger.warn(`Reddit ${name} returned no valid posts`);
            return null;
        }

        // Analyze sentiment from titles
        let totalScore = 0;
        let weightSum = 0;
        const allPosts: RedditSentimentResult['topPosts'] = [];

        for (const post of posts) {
            const title = typeof post.title === 'string' ? post.title : '';
            const selftext = typeof post.selftext === 'string' ? post.selftext : '';
            const text = title + ' ' + selftext.slice(0, 500);  // Limit selftext

            const textSentiment = calculateTextSentiment(text);

            // Weight by log(score + 2) to handle negative scores
            const rawScore = Number.isFinite(post.score) ? post.score : 0;
            const postWeight = Math.log(Math.max(rawScore + 2, 1));

            // Discount meme/comedy posts
            const flair = (post.link_flair_text || '').toLowerCase();
            const flairMultiplier = (flair.includes('comedy') || flair.includes('meme')) ? 0.3 : 1.0;

            totalScore += textSentiment * postWeight * flairMultiplier;
            weightSum += postWeight * flairMultiplier;

            // Collect ALL posts for sorting later
            const ageHours = (now - post.created_utc) / 3600;
            // Validate ageHours: must be positive and reasonable (< 168h = 1 week)
            // Negative values indicate future timestamps (clock skew), extremely large values indicate bad data
            const validAgeHours = Number.isFinite(ageHours) && ageHours >= 0 && ageHours < 168
                ? ageHours
                : 6;  // Default 6h if invalid
            allPosts.push({
                title: title.slice(0, 100),
                score: rawScore,
                sentiment: classifySentiment(textSentiment),
                permalink: post.permalink || '',
                ageHours: validAgeHours,
            });
        }

        // Sort ALL posts by score descending, then take top 5
        allPosts.sort((a, b) => b.score - a.score);
        const topPosts = allPosts.slice(0, 5);

        const sentimentScore = weightSum > 0 && Number.isFinite(totalScore / weightSum)
            ? Math.max(-1, Math.min(1, totalScore / weightSum))
            : 0;

        const avgScore = posts.reduce((sum, p) => sum + (p.score || 0), 0) / posts.length;
        const avgUpvoteRatio = posts.reduce((sum, p) => sum + (p.upvote_ratio ?? 0.5), 0) / posts.length;

        return {
            subreddit: name,
            postCount: posts.length,
            avgScore: Number.isFinite(avgScore) ? avgScore : 0,
            avgUpvoteRatio: Number.isFinite(avgUpvoteRatio) ? avgUpvoteRatio : 0.5,
            sentimentScore,
            sentiment: classifyOverallSentiment(sentimentScore),
            topPosts,
            volumeVsAverage: 1.0,  // TODO: Track historical average
            lastUpdated: new Date().toISOString(),
        };
    } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
            logger.warn(`Reddit ${name} request timed out`);
        } else {
            logger.warn(`Reddit ${name} fetch failed:`, error);
        }
        return null;
    }
}

/**
 * Fetch sentiment from all monitored subreddits
 */
async function fetchAllRedditSentiment(): Promise<Map<string, RedditSentimentResult>> {
    const results = new Map<string, RedditSentimentResult>();

    for (let i = 0; i < REDDIT_ENDPOINTS.length; i++) {
        const endpoint = REDDIT_ENDPOINTS[i];

        // Skip sleep on first iteration
        if (i > 0) {
            await sleep(REQUEST_DELAY);
        }

        const result = await fetchSubredditSentiment(endpoint.url, endpoint.name, endpoint.weight);
        if (result) {
            results.set(endpoint.name, result);
        }
    }

    return results;
}



/**
 * Calculate social vs price divergence (contrarian signals)
 * 
 * @param redditSentiment - Overall Reddit sentiment (-1 to +1)
 * @param priceChange24h - BTC price change in last 24h (percentage, e.g., -2.5)
 * @param fearGreedValue - Fear & Greed Index (0-100)
 */
export function calculateDivergence(
    redditSentiment: number,
    priceChange24h: number,
    fearGreedValue: number | null
): { signal: number; reason: string } {
    // Validate inputs
    if (!Number.isFinite(redditSentiment)) {
        return { signal: 0, reason: 'Invalid Reddit sentiment data' };
    }
    if (!Number.isFinite(priceChange24h)) {
        return { signal: 0, reason: 'Invalid price change data' };
    }

    let signal = 0;
    let reason = 'No significant divergence detected';

    // BULLISH DIVERGENCE: Reddit bearish but price stable/rising
    if (redditSentiment < -0.3 && priceChange24h > -2) {
        signal = 1.0;
        reason = 'Crowd fearful but price holding - accumulation opportunity';

        // Strengthen if Fear & Greed confirms
        if (fearGreedValue !== null && fearGreedValue < 30) {
            signal = 1.5;
            reason = 'Crowd fearful + F&G < 30 + price stable - strong accumulation signal';
        }
    }

    // BEARISH DIVERGENCE: Reddit bullish but price stable/falling
    if (redditSentiment > 0.3 && priceChange24h < 2) {
        signal = -1.0;
        reason = 'Crowd euphoric but price stalling - distribution warning';

        // Strengthen if Fear & Greed confirms
        if (fearGreedValue !== null && fearGreedValue > 70) {
            signal = -1.5;
            reason = 'Crowd euphoric + F&G > 70 + price weak - strong distribution signal';
        }
    }

    // Cap signal to ±2
    signal = Math.max(-2, Math.min(2, signal));

    return { signal, reason };
}



/**
 * Get comprehensive Reddit sentiment context
 * This is the main function to call for AI context enrichment
 * 
 * @param priceChange24h - Optional BTC 24h price change for divergence calculation
 * @param fearGreedValue - Optional Fear & Greed value for divergence calculation
 */
export async function getRedditSentimentContext(
    priceChange24h: number = 0,
    fearGreedValue: number | null = null
): Promise<RedditSentimentContext | null> {
    // Check if Reddit sentiment is enabled
    const enabled = process.env.REDDIT_SENTIMENT_ENABLED !== 'false';
    if (!enabled) {
        logger.debug('Reddit sentiment disabled via REDDIT_SENTIMENT_ENABLED=false');
        return null;
    }

    const cacheKey = 'reddit_sentiment_context';
    const cached = getCached<RedditSentimentContext>(cacheKey);
    if (cached) {
        // Update staleness flag - return a copy to avoid mutating cached object
        // Validate fetchedAt before parsing to prevent NaN from invalid date strings
        const parsedTime = Date.parse(cached.fetchedAt);
        const fetchedTime = Number.isFinite(parsedTime) ? parsedTime : 0;
        // If fetchedTime is 0 (invalid date), treat as stale
        const isStale = fetchedTime === 0 || (Date.now() - fetchedTime > STALE_THRESHOLD);

        // Recalculate divergence with caller's parameters (not cached values)
        const divergence = calculateDivergence(cached.overall.sentimentScore, priceChange24h, fearGreedValue);

        return {
            ...cached,
            isStale,
            socialVsPriceDivergence: divergence.signal,
            contrarian: divergence,
        };
    }

    // Race condition protection - capture the current promise reference
    const existingPromise = redditFetchPromise;
    if (existingPromise) {
        try {
            const result = await existingPromise;
            if (result) {
                // Recalculate divergence with caller's parameters
                const divergence = calculateDivergence(result.overall.sentimentScore, priceChange24h, fearGreedValue);
                return {
                    ...result,
                    socialVsPriceDivergence: divergence.signal,
                    contrarian: divergence,
                };
            }
            return result;
        } catch {
            // If the existing promise failed, fall through to create a new fetch
            // The finally block in the original promise will have set redditFetchPromise to null
        }
    }

    // Double-check cache after await - another caller may have completed a fetch
    const cachedAfterWait = getCached<RedditSentimentContext>(cacheKey);
    if (cachedAfterWait) {
        // Validate fetchedAt before parsing to prevent NaN from invalid date strings
        const parsedTime = Date.parse(cachedAfterWait.fetchedAt);
        const fetchedTime = Number.isFinite(parsedTime) ? parsedTime : 0;
        // If fetchedTime is 0 (invalid date), treat as stale
        const isStale = fetchedTime === 0 || (Date.now() - fetchedTime > STALE_THRESHOLD);
        const divergence = calculateDivergence(cachedAfterWait.overall.sentimentScore, priceChange24h, fearGreedValue);
        return {
            ...cachedAfterWait,
            isStale,
            socialVsPriceDivergence: divergence.signal,
            contrarian: divergence,
        };
    }

    // Check if another caller started a fetch while we were waiting
    if (redditFetchPromise) {
        try {
            const result = await redditFetchPromise;
            if (result) {
                const divergence = calculateDivergence(result.overall.sentimentScore, priceChange24h, fearGreedValue);
                return {
                    ...result,
                    socialVsPriceDivergence: divergence.signal,
                    contrarian: divergence,
                };
            }
            return result;
        } catch {
            // Fall through to create new fetch
        }
    }

    // Create and assign the fetch promise atomically
    // JavaScript is single-threaded, so between the check above and this assignment,
    // no other code can run (no race condition in synchronous code)
    redditFetchPromise = (async () => {
        try {
            logger.info('Fetching Reddit sentiment...');

            const results = await fetchAllRedditSentiment();

            if (results.size === 0) {
                logger.warn('No Reddit sentiment data available');
                return null;
            }

            // Calculate weighted overall sentiment
            let totalWeightedScore = 0;
            let totalWeight = 0;
            let totalPosts = 0;
            const topHeadlines: string[] = [];

            for (const endpoint of REDDIT_ENDPOINTS) {
                const result = results.get(endpoint.name);
                if (result) {
                    totalWeightedScore += result.sentimentScore * endpoint.weight;
                    totalWeight += endpoint.weight;
                    totalPosts += result.postCount;

                    // Collect top headlines
                    for (const post of result.topPosts.slice(0, 2)) {
                        if (topHeadlines.length < 5) {
                            topHeadlines.push(post.title);
                        }
                    }
                }
            }

            const overallScore = totalWeight > 0 && Number.isFinite(totalWeightedScore / totalWeight)
                ? totalWeightedScore / totalWeight
                : 0;

            // Calculate avgPostAge from real post ages (from created_utc)
            let totalAgeSum = 0;
            let totalAgeCount = 0;
            for (const endpoint of REDDIT_ENDPOINTS) {
                const result = results.get(endpoint.name);
                if (result) {
                    for (const post of result.topPosts) {
                        if (Number.isFinite(post.ageHours)) {
                            totalAgeSum += post.ageHours;
                            totalAgeCount++;
                        }
                    }
                }
            }
            const avgPostAge = totalAgeCount > 0 ? totalAgeSum / totalAgeCount : 12;  // Default 12h

            // Calculate divergence with caller's parameters
            const divergence = calculateDivergence(overallScore, priceChange24h, fearGreedValue);

            const context: RedditSentimentContext = {
                overall: {
                    sentimentScore: Number.isFinite(overallScore) ? overallScore : 0,
                    sentiment: classifyOverallSentiment(overallScore),
                    postCount: totalPosts,
                    avgPostAge,
                },
                btc: results.get('btc') || null,
                eth: results.get('eth') || null,
                general: results.get('general') || null,
                socialVsPriceDivergence: divergence.signal,
                contrarian: divergence,
                topHeadlines,
                fetchedAt: new Date().toISOString(),
                isStale: false,
            };

            // Cache the context (divergence will be recalculated on cache hit with caller's params)
            setCache(cacheKey, context);
            logger.info(`Reddit sentiment fetched: ${totalPosts} posts, score=${overallScore.toFixed(2)}`);

            return context;
        } catch (error) {
            logger.error('Failed to fetch Reddit sentiment:', error);
            return null;
        } finally {
            redditFetchPromise = null;
        }
    })();

    return redditFetchPromise;
}

/**
 * Format Reddit sentiment for AI prompt (compact version)
 */
export function formatRedditForPrompt(context: RedditSentimentContext | null): string {
    if (!context) {
        return 'REDDIT: Data unavailable';
    }

    const lines: string[] = [
        `REDDIT: ${context.overall.sentiment.toUpperCase()} (score=${context.overall.sentimentScore.toFixed(2)}, posts=${context.overall.postCount})`,
    ];

    if (context.isStale) {
        lines.push(`  ⚠️ Data is stale (>${STALE_THRESHOLD_MINUTES} min old) - discount signals`);
    }

    if (context.socialVsPriceDivergence !== 0) {
        lines.push(`  Divergence: ${context.contrarian.signal > 0 ? 'BULLISH' : 'BEARISH'} (${context.contrarian.reason})`);
    }

    if (context.topHeadlines.length > 0) {
        lines.push(`  Headlines: "${context.topHeadlines[0]}"`);
    }

    return lines.join('\n');
}

export default {
    getRedditSentimentContext,
    calculateDivergence,
    formatRedditForPrompt,
    clearRedditCache,
    shutdownRedditService,
};
