/**
 * Trade Journal Services Index
 * 
 * Exports all trade journal and learning loop services.
 */

export {
    addJournalEntry,
    getJournalEntry,
    getRecentEntries,
    clearJournal,
    generateLesson,
    addLessonToEntry,
    calculateAnalystPerformance,
    analyzePatternPerformance,
    generateTradingInsights,
    formatInsightsForPrompt,
    getAnalystWeights,
    shutdownJournalService,
    type TradeJournalEntry,
    type PatternPerformance,
    type AnalystPerformance,
    type TradingInsights,
} from './TradeJournalService';
