/**
 * Sentiment Service Exports
 * 
 * Re-exports sentiment analysis functions and types from SentimentService and RedditSentimentService.
 * Note: Re-exports execute their source modules on first import, which may initialize
 * module-level state (cache managers, cleanup timers).
 */

export {
    // Main functions
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

    // Types
    type NewsItem,
    type SentimentAnalysis,
    type FearGreedData,
    type SocialSentiment,
    type CryptoSentimentContext,
} from './SentimentService';

// Reddit Sentiment (v5.2.0)
export {
    getRedditSentimentContext,
    calculateDivergence,
    formatRedditForPrompt,
    clearRedditCache,
    shutdownRedditService,
    type RedditSentimentResult,
    type RedditSentimentContext,
} from './RedditSentimentService';
