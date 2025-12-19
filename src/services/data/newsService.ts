/**
 * News & Sentiment Service
 * 
 * Fetches stock-related news and calculates sentiment scores.
 * Uses multiple free sources with graceful fallbacks.
 */

import { NewsItem, SentimentAnalysis } from '../../types/stock';
import { logger } from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes for news
const MAX_CACHE_SIZE = 50; // Prevent unbounded growth
const cache = new Map<string, { data: unknown; timestamp: number }>();

// Enhanced sentiment word lists with weighted scoring
const POSITIVE_WORDS = new Map<string, number>([
    // Strong positive (weight 2)
    ['surge', 2], ['soar', 2], ['skyrocket', 2], ['breakthrough', 2], ['blockbuster', 2],
    ['exceptional', 2], ['outstanding', 2], ['remarkable', 2], ['stellar', 2], ['blowout', 2],
    // Standard positive (weight 1)
    ['jump', 1], ['gain', 1], ['rise', 1], ['rally', 1], ['boom', 1], ['bullish', 1],
    ['upgrade', 1], ['beat', 1], ['exceed', 1], ['outperform', 1], ['growth', 1],
    ['profit', 1], ['record', 1], ['high', 1], ['strong', 1], ['positive', 1],
    ['optimistic', 1], ['success', 1], ['win', 1], ['expand', 1], ['increase', 1],
    ['buy', 1], ['recommend', 1], ['opportunity', 1], ['momentum', 1], ['recovery', 1],
    ['innovation', 1], ['leading', 1], ['upbeat', 1], ['confident', 1], ['robust', 1],
    ['accelerate', 1], ['improve', 1], ['boost', 1], ['advance', 1], ['upturn', 1],
    ['promising', 1], ['favorable', 1], ['attractive', 1], ['undervalued', 1], ['dividend', 1]
]);

const NEGATIVE_WORDS = new Map<string, number>([
    // Strong negative (weight 2)
    ['crash', 2], ['plunge', 2], ['collapse', 2], ['bankruptcy', 2], ['fraud', 2],
    ['scandal', 2], ['disaster', 2], ['catastrophe', 2], ['devastating', 2], ['crisis', 2],
    // Standard negative (weight 1)
    ['drop', 1], ['fall', 1], ['decline', 1], ['bearish', 1], ['downgrade', 1],
    ['miss', 1], ['loss', 1], ['weak', 1], ['negative', 1], ['concern', 1],
    ['risk', 1], ['warning', 1], ['cut', 1], ['layoff', 1], ['sell', 1],
    ['avoid', 1], ['trouble', 1], ['struggle', 1], ['fail', 1], ['lawsuit', 1],
    ['investigation', 1], ['recession', 1], ['inflation', 1], ['debt', 1], ['default', 1],
    ['slump', 1], ['tumble', 1], ['slide', 1], ['plummet', 1], ['sink', 1],
    ['disappointing', 1], ['underperform', 1], ['overvalued', 1], ['volatile', 1], ['uncertainty', 1],
    ['headwind', 1], ['pressure', 1], ['slowdown', 1], ['contraction', 1], ['downturn', 1]
]);

// Negation words that flip sentiment
const NEGATION_WORDS = new Set([
    'not', 'no', 'never', 'neither', 'nobody', 'nothing', 'nowhere',
    'hardly', 'barely', 'scarcely', 'without', 'lack', 'lacking', 'fails'
]);

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

export function clearNewsCache(): void {
    cache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENTIMENT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate sentiment score for a piece of text
 * Returns a score from -1 (very negative) to 1 (very positive)
 * Uses weighted words and negation detection for better accuracy
 */
export function calculateTextSentiment(text: string): number {
    if (!text || typeof text !== 'string') return 0;

    const words = text.toLowerCase().split(/\W+/).filter(w => w.length > 0);
    let positiveScore = 0;
    let negativeScore = 0;
    let negationWordsRemaining = 0; // Track words remaining under negation effect

    for (const word of words) {
        // Check for negation (affects next 3 words)
        if (NEGATION_WORDS.has(word)) {
            negationWordsRemaining = 3;
            continue;
        }

        const isNegated = negationWordsRemaining > 0;
        const posWeight = POSITIVE_WORDS.get(word) || 0;
        const negWeight = NEGATIVE_WORDS.get(word) || 0;

        if (posWeight > 0) {
            if (isNegated) {
                negativeScore += posWeight * 0.5; // Negated positive = weak negative
            } else {
                positiveScore += posWeight;
            }
        }

        if (negWeight > 0) {
            if (isNegated) {
                positiveScore += negWeight * 0.5; // Negated negative = weak positive
            } else {
                negativeScore += negWeight;
            }
        }

        // Decrement negation counter after processing each word
        if (negationWordsRemaining > 0) {
            negationWordsRemaining--;
        }
    }

    const total = positiveScore + negativeScore;
    if (total === 0) return 0;

    // Normalize to [-1, 1] range
    return (positiveScore - negativeScore) / total;
}

/**
 * Classify sentiment based on score
 */
function classifySentiment(score: number): 'positive' | 'negative' | 'neutral' {
    if (score > 0.15) return 'positive';
    if (score < -0.15) return 'negative';
    return 'neutral';
}

/**
 * Get overall sentiment classification
 */
function getOverallSentiment(score: number): SentimentAnalysis['overallSentiment'] {
    if (score >= 0.5) return 'very_bullish';
    if (score >= 0.2) return 'bullish';
    if (score <= -0.5) return 'very_bearish';
    if (score <= -0.2) return 'bearish';
    return 'neutral';
}


// ═══════════════════════════════════════════════════════════════════════════════
// NEWS FETCHING - Yahoo Finance RSS
// ═══════════════════════════════════════════════════════════════════════════════

// Multiple CORS proxies for fallback
const CORS_PROXIES = [
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

async function fetchWithProxy(url: string, timeout = 8000): Promise<Response | null> {
    for (const proxyFn of CORS_PROXIES) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const proxyUrl = proxyFn(url);
            const response = await fetch(proxyUrl, { signal: controller.signal });
            clearTimeout(timeoutId);

            if (response.ok) return response;
        } catch {
            // Continue to next proxy
        }
    }
    return null;
}

/**
 * Fetch news from Yahoo Finance (no API key needed)
 */
async function fetchYahooNews(ticker: string): Promise<NewsItem[]> {
    const baseUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${ticker}&quotesCount=0&newsCount=20`;

    try {
        const response = await fetchWithProxy(baseUrl);

        if (!response) return [];

        const data = await response.json();
        const news = data.news || [];

        return news.map((item: any, index: number) => {
            const title = item.title || '';
            const summary = item.summary || item.title || '';
            const sentimentScore = calculateTextSentiment(title + ' ' + summary);

            return {
                id: `yahoo-${ticker}-${index}-${Date.now()}`,
                title,
                summary,
                source: item.publisher || 'Yahoo Finance',
                url: item.link || '',
                publishedAt: item.providerPublishTime
                    ? new Date(item.providerPublishTime * 1000).toISOString()
                    : new Date().toISOString(),
                sentiment: classifySentiment(sentimentScore),
                sentimentScore,
                relevance: 0.8 // Yahoo news is usually relevant
            };
        });
    } catch (error) {
        logger.warn(`Failed to fetch Yahoo news for ${ticker}:`, error);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// NEWS FETCHING - Finnhub (Free tier available)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Fetch news from Finnhub (requires free API key)
 */
async function fetchFinnhubNews(ticker: string, apiKey?: string): Promise<NewsItem[]> {
    if (!apiKey) return [];

    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const from = weekAgo.toISOString().split('T')[0];
    const to = today.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${apiKey}`;

    try {
        const response = await fetch(url);
        if (!response.ok) return [];

        const news = await response.json();
        if (!Array.isArray(news)) return [];

        return news.slice(0, 20).map((item: any, index: number) => {
            const title = item.headline || '';
            const summary = item.summary || '';
            const sentimentScore = calculateTextSentiment(title + ' ' + summary);

            return {
                id: `finnhub-${ticker}-${index}-${item.id || Date.now()}`,
                title,
                summary,
                source: item.source || 'Finnhub',
                url: item.url || '',
                publishedAt: item.datetime
                    ? new Date(item.datetime * 1000).toISOString()
                    : new Date().toISOString(),
                sentiment: classifySentiment(sentimentScore),
                sentimentScore,
                relevance: 0.9
            };
        });
    } catch (error) {
        logger.warn(`Failed to fetch Finnhub news for ${ticker}:`, error);
        return [];
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN NEWS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

export interface NewsServiceOptions {
    finnhubApiKey?: string;
    maxItems?: number;
}

/**
 * Get stock news from multiple sources
 */
export async function getStockNews(
    ticker: string,
    options: NewsServiceOptions = {}
): Promise<NewsItem[]> {
    const cacheKey = `news:${ticker}`;
    const cached = getCached<NewsItem[]>(cacheKey);
    if (cached) return cached;

    const { finnhubApiKey, maxItems = 15 } = options;

    // Fetch from multiple sources in parallel
    const [yahooNews, finnhubNews] = await Promise.all([
        fetchYahooNews(ticker),
        fetchFinnhubNews(ticker, finnhubApiKey)
    ]);

    // Combine and deduplicate by title similarity
    const allNews = [...finnhubNews, ...yahooNews];
    const seen = new Set<string>();
    const uniqueNews: NewsItem[] = [];

    for (const item of allNews) {
        const titleKey = item.title.toLowerCase().slice(0, 50);
        if (!seen.has(titleKey)) {
            seen.add(titleKey);
            uniqueNews.push(item);
        }
    }

    // Sort by date (newest first) and limit
    const sortedNews = uniqueNews
        .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
        .slice(0, maxItems);

    setCache(cacheKey, sortedNews);
    return sortedNews;
}

/**
 * Analyze sentiment from news items
 */
export function analyzeSentiment(news: NewsItem[]): SentimentAnalysis {
    if (news.length === 0) {
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

    let totalScore = 0;
    let positiveCount = 0;
    let negativeCount = 0;
    let neutralCount = 0;

    for (const item of news) {
        totalScore += item.sentimentScore;
        if (item.sentiment === 'positive') positiveCount++;
        else if (item.sentiment === 'negative') negativeCount++;
        else neutralCount++;
    }

    const overallScore = totalScore / news.length;

    return {
        overallScore,
        overallSentiment: getOverallSentiment(overallScore),
        newsCount: news.length,
        positiveCount,
        negativeCount,
        neutralCount,
        recentNews: news.slice(0, 10)
    };
}

/**
 * Get full sentiment analysis for a stock
 */
export async function getSentimentAnalysis(
    ticker: string,
    options: NewsServiceOptions = {}
): Promise<SentimentAnalysis> {
    const cacheKey = `sentiment:${ticker}`;
    const cached = getCached<SentimentAnalysis>(cacheKey);
    if (cached) return cached;

    const news = await getStockNews(ticker, options);
    const analysis = analyzeSentiment(news);

    setCache(cacheKey, analysis);
    return analysis;
}
