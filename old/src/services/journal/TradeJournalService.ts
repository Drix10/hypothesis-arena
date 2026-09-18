import { logger } from '../../utils/logger';

export interface TradeJournalEntry {
    id: string;
    tradeId: string;

    // Entry context
    entryRegime: string;              // Market regime at entry
    entryZScore: number;              // Z-score at entry
    entryFunding: number;             // Funding rate at entry
    entrySentiment: number;           // Sentiment score at entry
    entrySignals: Record<string, unknown>;  // All signals that triggered entry

    // Analyst data
    // NOTE: winningAnalyst is used in this in-memory interface.
    // When persisting to database, map this to Trade.championId (the canonical field).
    // The Prisma TradeJournal model does NOT have a winningAnalyst field to avoid duplication.
    winningAnalyst: string;           // Which analyst won (jim, ray, karen, quant)
    analystScores: Record<string, number>;  // All analyst confidence scores
    judgeReasoning: string;           // Why judge picked winner

    // Outcome
    outcome: 'win' | 'loss' | 'breakeven';
    pnlPercent: number;
    holdTimeHours: number;
    exitReason: 'tp_hit' | 'sl_hit' | 'manual' | 'time_exit' | 'invalidated';

    // Learning
    lessonsLearned: string | null;    // AI-generated post-trade analysis

    createdAt: string;
}

export interface PatternPerformance {
    pattern: string;                  // e.g., "z_score_below_-2"
    occurrences: number;
    winRate: number;
    avgPnl: number;
    avgHoldTime: number;
    bestRegime: string;               // Which regime this pattern works best
    worstRegime: string;              // Which regime to avoid
}

export interface AnalystPerformance {
    analystId: string;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgPnl: number;
    avgConfidence: number;
    performanceVsAverage: number;     // Relative to team average
    recentTrend: 'improving' | 'declining' | 'stable';
    weightAdjustment: number;         // Suggested weight multiplier (0.8-1.2)
}

export interface TradingInsights {
    totalTrades: number;
    overallWinRate: number;
    avgPnl: number;
    avgHoldTime: number;
    analystPerformance: Map<string, AnalystPerformance>;
    topPatterns: PatternPerformance[];
    worstPatterns: PatternPerformance[];
    regimePerformance: Map<string, { winRate: number; avgPnl: number; trades: number }>;
    recentLessons: string[];
    recommendations: string[];
    lastUpdated: string;
}

const journalEntries: TradeJournalEntry[] = [];
const MAX_ENTRIES = 500;
const ROLLING_WINDOW = 50;

/**
 * Add a new trade journal entry
 */
export function addJournalEntry(entry: Omit<TradeJournalEntry, 'id' | 'createdAt'>): TradeJournalEntry {
    // Input validation
    if (!entry.tradeId || typeof entry.tradeId !== 'string') {
        throw new Error('Invalid tradeId: must be a non-empty string');
    }
    if (!entry.entryRegime || typeof entry.entryRegime !== 'string') {
        throw new Error('Invalid entryRegime: must be a non-empty string');
    }
    if (!entry.winningAnalyst || typeof entry.winningAnalyst !== 'string') {
        throw new Error('Invalid winningAnalyst: must be a non-empty string');
    }
    if (!['win', 'loss', 'breakeven'].includes(entry.outcome)) {
        throw new Error('Invalid outcome: must be "win", "loss", or "breakeven"');
    }
    if (!Number.isFinite(entry.pnlPercent)) {
        throw new Error('Invalid pnlPercent: must be a finite number');
    }
    if (!Number.isFinite(entry.holdTimeHours) || entry.holdTimeHours < 0) {
        throw new Error('Invalid holdTimeHours: must be a non-negative finite number');
    }
    // Validate exitReason
    const validExitReasons = ['tp_hit', 'sl_hit', 'manual', 'time_exit', 'invalidated'];
    if (!validExitReasons.includes(entry.exitReason)) {
        throw new Error(`Invalid exitReason: must be one of ${validExitReasons.join(', ')}`);
    }

    // Sanitize numeric fields to prevent NaN propagation
    const sanitizedEntry = {
        ...entry,
        entryZScore: Number.isFinite(entry.entryZScore) ? entry.entryZScore : 0,
        entryFunding: Number.isFinite(entry.entryFunding) ? entry.entryFunding : 0,
        entrySentiment: Number.isFinite(entry.entrySentiment) ? entry.entrySentiment : 0,
        pnlPercent: entry.pnlPercent,
        holdTimeHours: entry.holdTimeHours,
    };

    const fullEntry: TradeJournalEntry = {
        ...sanitizedEntry,
        id: `journal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
    };

    journalEntries.push(fullEntry);

    // Enforce max size (FIFO)
    while (journalEntries.length > MAX_ENTRIES) {
        journalEntries.shift();
    }

    logger.info(`Trade journal entry added: ${fullEntry.tradeId} - ${fullEntry.outcome}`);

    return fullEntry;
}

/**
 * Get journal entry by trade ID
 */
export function getJournalEntry(tradeId: string): TradeJournalEntry | null {
    return journalEntries.find(e => e.tradeId === tradeId) || null;
}

/**
 * Get recent journal entries
 * 
 * @param limit - Maximum number of entries to return (default 20)
 * @returns Array of recent journal entries, newest first
 */
export function getRecentEntries(limit: number = 20): TradeJournalEntry[] {
    // Handle non-positive limits (including -0 which equals 0)
    // slice(-0) returns all entries, so we explicitly return empty array for limit <= 0
    if (limit <= 0) {
        return [];
    }
    return journalEntries.slice(-limit).reverse();
}

/**
 * Clear all journal entries (for testing)
 */
export function clearJournal(): void {
    journalEntries.length = 0;
    logger.info('Trade journal cleared');
}

/**
 * Shutdown the journal service (cleanup)
 * Call this when the application is shutting down
 */
export function shutdownJournalService(): void {
    // Note: In-memory storage, no timers to clean up
    // This function exists for consistency with other services
    // and future-proofing if we add persistence
    journalEntries.length = 0;
    logger.info('Trade journal service shutdown complete');
}
/**
 * Generate lesson from a trade outcome
 * Per quant advisor: Auto-generate lessons template
 */
export function generateLesson(entry: TradeJournalEntry): string {
    const { outcome, entryRegime, entryZScore, exitReason, pnlPercent, winningAnalyst } = entry;

    // Normalize entryRegime for case-insensitive matching
    const normalizedRegime = (entryRegime || '').toLowerCase();

    if (outcome === 'win') {
        // Winning trade lessons
        const factors: string[] = [];

        if (Math.abs(entryZScore) > 1.5) {
            factors.push(`z-score extremity (${entryZScore.toFixed(2)})`);
        }
        if (normalizedRegime.includes('trend')) {
            factors.push('trend alignment');
        }
        if (exitReason === 'tp_hit') {
            factors.push('clean TP exit');
        }

        const factorStr = factors.length > 0 ? factors.join(' + ') : 'good timing';
        return `Won ${pnlPercent.toFixed(2)}% because ${factorStr} in ${entryRegime} regime → repeat pattern with ${winningAnalyst}`;
    }

    if (outcome === 'loss') {
        // Losing trade lessons
        const issues: string[] = [];

        if (normalizedRegime.includes('volatile') || normalizedRegime.includes('extreme')) {
            issues.push('unfavorable regime');
        }
        if (exitReason === 'sl_hit') {
            issues.push('stop loss triggered');
        }
        if (exitReason === 'invalidated') {
            issues.push('thesis invalidated');
        }
        if (Math.abs(entryZScore) < 1) {
            issues.push('weak z-score signal');
        }

        const issueStr = issues.length > 0 ? issues.join(' + ') : 'market moved against';
        return `Lost ${Math.abs(pnlPercent).toFixed(2)}% because ${issueStr} → avoid ${entryRegime} regime or use tighter stops`;
    }

    return `Breakeven trade in ${entryRegime} - marginal edge, consider waiting for stronger setup`;
}

/**
 * Update entry with generated lesson
 */
export function addLessonToEntry(tradeId: string): string | null {
    const entry = journalEntries.find(e => e.tradeId === tradeId);
    if (!entry) return null;

    const lesson = generateLesson(entry);
    entry.lessonsLearned = lesson;

    return lesson;
}
/**
 * Calculate analyst performance over rolling window
 * Per quant advisor: Track win rate per analyst over rolling 50 trades
 */
export function calculateAnalystPerformance(): Map<string, AnalystPerformance> {
    const performance = new Map<string, AnalystPerformance>();
    const analysts = ['jim', 'ray', 'karen', 'quant'];

    // Get recent entries for rolling window
    const recentEntries = journalEntries.slice(-ROLLING_WINDOW * 4);  // 4 analysts

    // Calculate team average first
    const teamWins = recentEntries.filter(e => e.outcome === 'win').length;
    const teamTotal = recentEntries.length;
    const teamWinRate = teamTotal > 0 ? (teamWins / teamTotal) * 100 : 50;

    for (const analystId of analysts) {
        const analystEntries = recentEntries
            .filter(e => e.winningAnalyst === analystId)
            .slice(-ROLLING_WINDOW);

        const wins = analystEntries.filter(e => e.outcome === 'win').length;
        const losses = analystEntries.filter(e => e.outcome === 'loss').length;
        const total = analystEntries.length;

        const winRate = total > 0 ? (wins / total) * 100 : 50;

        // Safely calculate avgPnl with NaN protection
        const pnlSum = analystEntries.reduce((sum, e) => {
            const pnl = Number.isFinite(e.pnlPercent) ? e.pnlPercent : 0;
            return sum + pnl;
        }, 0);
        const avgPnl = total > 0 ? pnlSum / total : 0;

        // Safely calculate avgConfidence with NaN protection
        const confSum = analystEntries.reduce((sum, e) => {
            const conf = e.analystScores?.[analystId];
            return sum + (Number.isFinite(conf) ? conf : 0);
        }, 0);
        const avgConfidence = total > 0 ? confSum / total : 0;

        // Calculate performance vs average
        const performanceVsAverage = winRate - teamWinRate;

        // Determine trend (compare first half vs second half)
        let recentTrend: 'improving' | 'declining' | 'stable' = 'stable';
        if (analystEntries.length >= 10) {
            const midpoint = Math.floor(analystEntries.length / 2);
            const firstHalf = analystEntries.slice(0, midpoint);
            const secondHalf = analystEntries.slice(midpoint);

            // Guard against division by zero
            const firstWinRate = firstHalf.length > 0
                ? firstHalf.filter(e => e.outcome === 'win').length / firstHalf.length
                : 0;
            const secondWinRate = secondHalf.length > 0
                ? secondHalf.filter(e => e.outcome === 'win').length / secondHalf.length
                : 0;

            if (secondWinRate > firstWinRate + 0.1) recentTrend = 'improving';
            else if (secondWinRate < firstWinRate - 0.1) recentTrend = 'declining';
        }

        // Calculate weight adjustment
        // Per quant advisor: Penalize underperforming analysts by 20%
        let weightAdjustment = 1.0;
        if (total >= 10) {  // Need enough data
            if (performanceVsAverage < -10) {
                weightAdjustment = 0.8;  // 20% penalty
            } else if (performanceVsAverage < -5) {
                weightAdjustment = 0.9;  // 10% penalty
            } else if (performanceVsAverage > 10) {
                weightAdjustment = 1.2;  // 20% bonus
            } else if (performanceVsAverage > 5) {
                weightAdjustment = 1.1;  // 10% bonus
            }
        }

        performance.set(analystId, {
            analystId,
            totalTrades: total,
            wins,
            losses,
            winRate: Number.isFinite(winRate) ? winRate : 50,
            avgPnl: Number.isFinite(avgPnl) ? avgPnl : 0,
            avgConfidence: Number.isFinite(avgConfidence) ? avgConfidence : 0,
            performanceVsAverage: Number.isFinite(performanceVsAverage) ? performanceVsAverage : 0,
            recentTrend,
            weightAdjustment,
        });
    }

    return performance;
}
/**
 * Identify patterns from entry conditions
 */
function identifyPatterns(entry: TradeJournalEntry): string[] {
    const patterns: string[] = [];

    // Validate numeric fields before pattern identification
    const zScore = Number.isFinite(entry.entryZScore) ? entry.entryZScore : 0;
    const funding = Number.isFinite(entry.entryFunding) ? entry.entryFunding : 0;
    const sentiment = Number.isFinite(entry.entrySentiment) ? entry.entrySentiment : 0;

    // Z-score patterns
    if (zScore < -2) patterns.push('z_score_below_-2');
    else if (zScore < -1.5) patterns.push('z_score_below_-1.5');
    else if (zScore > 2) patterns.push('z_score_above_2');
    else if (zScore > 1.5) patterns.push('z_score_above_1.5');

    // Funding patterns
    if (funding > 0.0005) patterns.push('funding_high_positive');
    else if (funding < -0.0005) patterns.push('funding_high_negative');

    // Sentiment patterns
    if (sentiment > 0.5) patterns.push('sentiment_very_bullish');
    else if (sentiment < -0.5) patterns.push('sentiment_very_bearish');

    // Regime patterns
    if (entry.entryRegime && typeof entry.entryRegime === 'string') {
        patterns.push(`regime_${entry.entryRegime.toLowerCase().replace(/\s+/g, '_')}`);
    }

    return patterns;
}/**
 * Analyze pattern performance across all trades
 */
export function analyzePatternPerformance(): PatternPerformance[] {
    const patternStats = new Map<string, {
        wins: number;
        losses: number;
        breakevens: number;
        totalPnl: number;
        totalHoldTime: number;
        regimeCounts: Map<string, { wins: number; total: number }>;
    }>();

    for (const entry of journalEntries) {
        const patterns = identifyPatterns(entry);

        for (const pattern of patterns) {
            let stats = patternStats.get(pattern);
            if (!stats) {
                stats = {
                    wins: 0,
                    losses: 0,
                    breakevens: 0,
                    totalPnl: 0,
                    totalHoldTime: 0,
                    regimeCounts: new Map(),
                };
                patternStats.set(pattern, stats);
            }

            if (entry.outcome === 'win') stats.wins++;
            else if (entry.outcome === 'loss') stats.losses++;
            else if (entry.outcome === 'breakeven') stats.breakevens++;

            // NaN protection for pnlPercent and holdTimeHours
            const pnl = Number.isFinite(entry.pnlPercent) ? entry.pnlPercent : 0;
            const holdTime = Number.isFinite(entry.holdTimeHours) ? entry.holdTimeHours : 0;
            stats.totalPnl += pnl;
            stats.totalHoldTime += holdTime;

            // Track regime performance
            const regime = entry.entryRegime;
            let regimeStats = stats.regimeCounts.get(regime);
            if (!regimeStats) {
                regimeStats = { wins: 0, total: 0 };
                stats.regimeCounts.set(regime, regimeStats);
            }
            regimeStats.total++;
            if (entry.outcome === 'win') regimeStats.wins++;
        }
    }

    // Convert to PatternPerformance array
    const results: PatternPerformance[] = [];

    for (const [pattern, stats] of patternStats.entries()) {
        // Include all trades (wins + losses + breakevens) for consistent calculations
        const total = stats.wins + stats.losses + stats.breakevens;
        if (total < 5) continue;  // Need minimum sample size

        // Find best and worst regimes
        let bestRegime = 'unknown';
        let worstRegime = 'unknown';
        let bestWinRate = 0;
        let worstWinRate = 100;

        for (const [regime, regimeStats] of stats.regimeCounts.entries()) {
            if (regimeStats.total < 3) continue;
            const regimeWinRate = (regimeStats.wins / regimeStats.total) * 100;

            if (regimeWinRate > bestWinRate) {
                bestWinRate = regimeWinRate;
                bestRegime = regime;
            }
            if (regimeWinRate < worstWinRate) {
                worstWinRate = regimeWinRate;
                worstRegime = regime;
            }
        }

        results.push({
            pattern,
            occurrences: total,
            winRate: (stats.wins / total) * 100,
            avgPnl: stats.totalPnl / total,
            avgHoldTime: stats.totalHoldTime / total,
            bestRegime,
            worstRegime,
        });
    }

    // Sort by win rate
    results.sort((a, b) => b.winRate - a.winRate);

    return results;
}
/**
 * Generate comprehensive trading insights
 */
export function generateTradingInsights(): TradingInsights {
    const totalTrades = journalEntries.length;

    if (totalTrades === 0) {
        return {
            totalTrades: 0,
            overallWinRate: 0,
            avgPnl: 0,
            avgHoldTime: 0,
            analystPerformance: new Map(),
            topPatterns: [],
            worstPatterns: [],
            regimePerformance: new Map(),
            recentLessons: [],
            recommendations: ['Not enough trade data for insights'],
            lastUpdated: new Date().toISOString(),
        };
    }

    // Overall stats with NaN protection
    const wins = journalEntries.filter(e => e.outcome === 'win').length;
    const overallWinRate = (wins / totalTrades) * 100;

    const pnlSum = journalEntries.reduce((sum, e) => {
        const pnl = Number.isFinite(e.pnlPercent) ? e.pnlPercent : 0;
        return sum + pnl;
    }, 0);
    const avgPnl = pnlSum / totalTrades;

    const holdTimeSum = journalEntries.reduce((sum, e) => {
        const holdTime = Number.isFinite(e.holdTimeHours) ? e.holdTimeHours : 0;
        return sum + holdTime;
    }, 0);
    const avgHoldTime = holdTimeSum / totalTrades;

    // Analyst performance
    const analystPerformance = calculateAnalystPerformance();

    // Pattern analysis
    const allPatterns = analyzePatternPerformance();
    const topPatterns = allPatterns.filter(p => p.winRate > 55).slice(0, 5);
    // worstPatterns: filter for low win rate, then sort ascending (worst first) and take first 5
    const worstPatterns = allPatterns
        .filter(p => p.winRate < 45)
        .sort((a, b) => a.winRate - b.winRate)
        .slice(0, 5);

    // Regime performance
    const regimePerformance = new Map<string, { winRate: number; avgPnl: number; trades: number }>();
    const regimeGroups = new Map<string, TradeJournalEntry[]>();

    for (const entry of journalEntries) {
        const regime = entry.entryRegime;
        let group = regimeGroups.get(regime);
        if (!group) {
            group = [];
            regimeGroups.set(regime, group);
        }
        group.push(entry);
    }

    for (const [regime, entries] of regimeGroups.entries()) {
        const regimeWins = entries.filter(e => e.outcome === 'win').length;
        const regimeWinRate = (regimeWins / entries.length) * 100;
        const regimePnlSum = entries.reduce((sum, e) => {
            const pnl = Number.isFinite(e.pnlPercent) ? e.pnlPercent : 0;
            return sum + pnl;
        }, 0);
        const regimeAvgPnl = regimePnlSum / entries.length;

        regimePerformance.set(regime, {
            winRate: Number.isFinite(regimeWinRate) ? regimeWinRate : 50,
            avgPnl: Number.isFinite(regimeAvgPnl) ? regimeAvgPnl : 0,
            trades: entries.length,
        });
    }

    // Recent lessons
    const recentLessons = journalEntries
        .slice(-10)
        .filter(e => e.lessonsLearned)
        .map(e => e.lessonsLearned!)
        .reverse();

    // Generate recommendations
    const recommendations: string[] = [];

    // Analyst recommendations
    for (const [analystId, perf] of analystPerformance.entries()) {
        if (perf.weightAdjustment < 1.0) {
            recommendations.push(
                `${analystId.toUpperCase()} underperforming (${perf.winRate.toFixed(0)}% vs ${overallWinRate.toFixed(0)}% avg) - reduce weight by ${((1 - perf.weightAdjustment) * 100).toFixed(0)}%`
            );
        }
    }

    // Pattern recommendations
    if (topPatterns.length > 0) {
        const best = topPatterns[0];
        recommendations.push(
            `Best pattern: ${best.pattern} (${best.winRate.toFixed(0)}% win rate) - prioritize in ${best.bestRegime} regime`
        );
    }

    if (worstPatterns.length > 0) {
        const worst = worstPatterns[0];
        recommendations.push(
            `Avoid pattern: ${worst.pattern} (${worst.winRate.toFixed(0)}% win rate) - especially in ${worst.worstRegime} regime`
        );
    }

    // Regime recommendations
    for (const [regime, stats] of regimePerformance.entries()) {
        if (stats.trades >= 10 && stats.winRate < 40) {
            recommendations.push(
                `Avoid trading in ${regime} regime (${stats.winRate.toFixed(0)}% win rate over ${stats.trades} trades)`
            );
        }
    }

    return {
        totalTrades,
        overallWinRate,
        avgPnl,
        avgHoldTime,
        analystPerformance,
        topPatterns,
        worstPatterns,
        regimePerformance,
        recentLessons,
        recommendations,
        lastUpdated: new Date().toISOString(),
    };
}
/**
 * Format insights for AI analyst prompt
 */
export function formatInsightsForPrompt(insights: TradingInsights): string {
    const lines: string[] = [
        '=== HISTORICAL PERFORMANCE ===',
        `Total trades: ${insights.totalTrades} | Win rate: ${insights.overallWinRate.toFixed(0)}% | Avg PnL: ${insights.avgPnl.toFixed(2)}%`,
        '',
    ];

    // Analyst performance
    if (insights.analystPerformance.size > 0) {
        lines.push('ANALYST PERFORMANCE (last 50 trades):');
        for (const [id, perf] of insights.analystPerformance.entries()) {
            const trend = perf.recentTrend === 'improving' ? '↑' : perf.recentTrend === 'declining' ? '↓' : '→';
            const weight = perf.weightAdjustment !== 1.0 ? ` (weight: ${perf.weightAdjustment}x)` : '';
            lines.push(
                `  ${id.toUpperCase()}: ${perf.winRate.toFixed(0)}% win (${perf.totalTrades} trades) ${trend}${weight}`
            );
        }
        lines.push('');
    }

    // Top patterns
    if (insights.topPatterns.length > 0) {
        lines.push('BEST PATTERNS:');
        for (const p of insights.topPatterns.slice(0, 3)) {
            lines.push(`  ${p.pattern}: ${p.winRate.toFixed(0)}% win, best in ${p.bestRegime}`);
        }
        lines.push('');
    }

    // Worst patterns
    if (insights.worstPatterns.length > 0) {
        lines.push('AVOID PATTERNS:');
        for (const p of insights.worstPatterns.slice(0, 3)) {
            lines.push(`  ${p.pattern}: ${p.winRate.toFixed(0)}% win, worst in ${p.worstRegime}`);
        }
        lines.push('');
    }

    // Recent lessons
    if (insights.recentLessons.length > 0) {
        lines.push('RECENT LESSONS:');
        for (const lesson of insights.recentLessons.slice(0, 3)) {
            lines.push(`  - ${lesson}`);
        }
        lines.push('');
    }

    // Recommendations
    if (insights.recommendations.length > 0) {
        lines.push('RECOMMENDATIONS:');
        for (const rec of insights.recommendations.slice(0, 3)) {
            lines.push(`  → ${rec}`);
        }
    }

    return lines.join('\n');
}

/**
 * Get analyst weight adjustments for judge
 */
export function getAnalystWeights(): Map<string, number> {
    const performance = calculateAnalystPerformance();
    const weights = new Map<string, number>();

    for (const [analystId, perf] of performance.entries()) {
        weights.set(analystId, perf.weightAdjustment);
    }

    return weights;
}

export default {
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
};
