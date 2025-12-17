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

// Sentiment word lists for basic analysis
const POSITIVE_WORDS = new Set([
    'surge', 'soar', 'jump', 'gain', 'rise', 'rally', 'boom', 'bullish', 'upgrade',
    'beat', 'exceed', 'outperform', 'growth', 'profit', 'record', 'high', 'strong',
    'positive', 'optimistic', 'breakthrough', 'success', 'win', 'expand', 'increase',
    'buy', 'recommend', 'opportunity', 'momentum', 'recovery', 'innovation', 'leading'
]);

const NEGATIVE_WORDS = new Set([
    'drop', 'fall', 'plunge', 'decline', 'crash', 'bearish', 'downgrade', 'miss',
    'loss', 'weak', 'negative', 'concern', 'risk', 'warning', 'cut', 'layoff',
    'sell', 'avoid', 'trouble', 'struggle', 'fail', 'lawsuit', 'investigation',
    'recession', 'inflation', 'debt', 'default', 'bankruptcy', 'fraud', 'scandal'
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
 */
export function calculateTextSentiment(text: string): number {
    const words = text.toLowerCase().split(/\W+/);
    let positiveCount = 0;
    let negativeCount = 0;

    for (const word of words) {
        if (POSITIVE_WORDS.has(word)) positiveCount++;
        if (NEGATIVE_WORDS.has(word)) negativeCount++;
    }

    const total = positiveCount + negativeCount;
    if (total === 0) return 0;

    return (positiveCount - negativeCount) / total;
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

async function fetchWithProxy(url: string): Promise<Response | null> {
    for (const proxyFn of CORS_PROXIES) {
        try {
            const proxyUrl = proxyFn(url);
            const response = await fetch(proxyUrl);
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
