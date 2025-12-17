/**
 * Stock Investment Arena - Services Index
 * 
 * Exports all stock analysis and tournament services.
 */

// Data Services
export {
    fetchAllStockData,
    fetchQuickData,
    refreshData,
    validateTicker,
    searchTickers,
    clearYahooCache,
    clearNewsCache
} from '../data/stockDataAggregator';

export {
    getStockNews,
    getSentimentAnalysis,
    analyzeSentiment,
    calculateTextSentiment
} from '../data/newsService';

export {
    calculateSMA,
    calculateEMA,
    calculateRSI,
    calculateMACD,
    calculateBollingerBands,
    calculateATR,
    calculateVolatility,
    identifyTrend,
    findSupportResistance,
    calculateTechnicalIndicators
} from '../data/technicalAnalysis';

// Analyst Services
export {
    generateAllTheses,
    generateThesisForAnalyst,
    categorizeByRecommendation,
    calculateConsensus,
    getAllAnalysts,
    getAnalystById,
    getAnalystByMethodology
} from './analystService';

// Tournament Services
export {
    createMatchPairings,
    createSemifinalPairings,
    createFinalPairing,
    runTournament,
    runSingleDebate
} from './stockTournamentService';

export type {
    TournamentResult,
    TournamentConfig
} from './stockTournamentService';

// Recommendation Services
export {
    generateFinalRecommendation,
    generateQuickRecommendation
} from './recommendationService';

// Constants
export {
    ANALYST_PROFILES,
    THESIS_SYSTEM_PROMPTS,
    ANALYST_DATA_FOCUS
} from '../../constants/analystPrompts';
