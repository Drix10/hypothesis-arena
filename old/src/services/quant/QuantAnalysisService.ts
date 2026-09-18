/**
 * QuantAnalysisService - HistoBit-Style Quantitative Analysis
 * Provides mathematically-grounded analysis on all trading pairs.
 * Uses historical price data to uncover patterns, statistical edges, and probability-based signals.
 */

import { getWeexClient } from '../weex/WeexClient';
import { WeexCandle } from '../../shared/types/weex';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { detectRegime, clearRegimeHistory, type MarketRegime, type RegimeInput } from './RegimeDetector';
import { getSentimentAnalysis } from '../sentiment/SentimentService';

export interface QuantSignal {
    direction: 'long' | 'short' | 'neutral';
    strength: number;
    confidence: number;
    reason: string;
}

export interface StrategySignal {
    name: string;
    direction: 'long' | 'short' | 'neutral';
    strength: number;
    confidence: number;
    reason: string;
}

export interface StrategySignals {
    ann: StrategySignal;
    naive_bayes: StrategySignal;
    knn: StrategySignal;
    ibs: StrategySignal;
    stat_arb: StrategySignal;
    alpha_combo: StrategySignal;
    ma_crossover: StrategySignal;
    donchian: StrategySignal;
    pivot_points: StrategySignal;
    multi_asset_trend: StrategySignal;
}

export interface StatisticalMetrics {
    mean: number;
    stdDev: number;
    zScore: number;
    percentile: number;
    volatility24h: number;
    volatilityRank: number;
    isVolatilityExpanding: boolean;
    meanReversionSignal: QuantSignal;
    distanceFromMean: number;
}

export interface PatternAnalysis {
    // Support/Resistance
    nearestSupport: number;
    nearestResistance: number;
    supportStrength: number;  // 0-100 based on touches
    resistanceStrength: number;

    // Trend
    trendDirection: 'up' | 'down' | 'sideways';
    trendStrength: number;   // 0-100
    trendDuration: number;   // Candles in current trend

    // Volume
    volumeProfile: 'accumulation' | 'distribution' | 'neutral';
    volumeAnomaly: boolean;  // Unusual volume detected
    relativeVolume: number;  // Current vs average (1.0 = average)

    // Patterns
    patterns: string[];      // Detected patterns: 'double_bottom', 'breakout', etc.
}

export interface ProbabilityMetrics {
    // Historical win rates at current conditions
    longWinRate: number;     // 0-100
    shortWinRate: number;    // 0-100

    // Risk/Reward
    expectedRR: number;      // Expected risk/reward ratio
    optimalStopPercent: number;
    optimalTargetPercent: number;

    // Entry quality
    entryQuality: 'excellent' | 'good' | 'fair' | 'poor';
    entryScore: number;      // 0-100
}

export interface AssetQuantAnalysis {
    symbol: string;
    timestamp: number;
    currentPrice: number;

    statistics: StatisticalMetrics;
    patterns: PatternAnalysis;
    probability: ProbabilityMetrics;

    // Overall signals
    primarySignal: QuantSignal;
    secondarySignals: QuantSignal[];

    // Risk assessment
    riskLevel: 'low' | 'medium' | 'high' | 'extreme';
    riskScore: number;       // 0-100
    strategies: StrategySignals;
}

/**
 * Result from analyzeAsset including both analysis and candle data
 * Used to avoid duplicate candle fetches in getQuantContext
 */
interface AnalyzeAssetResult {
    analysis: AssetQuantAnalysis;
    closes: number[];  // Valid close prices for cross-asset correlation
    highs: number[];   // For regime detection
    lows: number[];    // For regime detection
    volumes: number[]; // For regime detection
}

export interface CrossAssetAnalysis {
    btcDominance: number;    // BTC's influence on market
    correlationMatrix: Map<string, Map<string, number>>;
    marketRegime: 'risk_on' | 'risk_off' | 'neutral';
    sectorRotation: string;  // Which assets are leading
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUNDING RATE PERCENTILE TYPES (v5.1.0 Enhancement)
// ═══════════════════════════════════════════════════════════════════════════════

export interface FundingRateAnalysis {
    currentRate: number;           // Current funding rate (decimal, e.g., 0.0001 = 0.01%)
    percentile: number;            // 0-100, where current rate sits in 7-day history
    isExtreme: boolean;            // True if percentile > 95 or < 5
    extremeDirection: 'long_crowded' | 'short_crowded' | 'neutral';
    persistenceCount: number;      // Consecutive periods at extreme (0 if not extreme)
    isPersistent: boolean;         // True if extreme for ≥2 periods (16+ hours)
    signal: FundingSignal;
    annualizedYield: number;       // Estimated annualized carry yield (%)
    history: FundingRateHistoryEntry[];  // Last 7 days of funding rates
}

export interface FundingSignal {
    direction: 'long' | 'short' | 'neutral';
    strength: number;              // 0-100
    confidence: number;            // 0-100
    reason: string;
    carryExpectedPct: number;      // Expected carry return per cycle (0.05-0.3%)
}

interface FundingRateHistoryEntry {
    timestamp: number;
    rate: number;
    isExtreme: boolean;
}

export interface QuantContext {
    timestamp: string;
    assets: Map<string, AssetQuantAnalysis>;
    crossAsset: CrossAssetAnalysis;
    fundingAnalysis: Map<string, FundingRateAnalysis>;  // v5.1.0: Funding rate percentile analysis
    regimeAnalysis: Map<string, import('./RegimeDetector').MarketRegime>;  // v5.1.0 Phase 2: Regime detection
    marketSummary: string;   // Human-readable summary for AI
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const CACHE_TTL = config.quant.cacheTtlMs;  // 5 minutes
const MAX_CACHE_SIZE = config.quant.maxCacheSize;
const CACHE_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ═══════════════════════════════════════════════════════════════════════════════
// CACHE (with cleanup timer to prevent memory leaks)
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

class QuantCacheManager {
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
            if (now - entry.timestamp >= CACHE_TTL) {
                keysToDelete.push(key);
            }
        }
        // Delete after iteration completes
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }
        if (keysToDelete.length > 0) {
            logger.debug(`Quant cache cleanup: removed ${keysToDelete.length} expired entries`);
        }
    }

    get<T>(key: string): T | null {
        const entry = this.cache.get(key) as CacheEntry<T> | undefined;
        if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
            return entry.data;
        }
        if (entry) {
            this.cache.delete(key);
        }
        return null;
    }

    set<T>(key: string, data: T): void {
        // Check if key already exists - if so, just update (no eviction needed)
        if (this.cache.has(key)) {
            this.cache.set(key, { data, timestamp: Date.now() });
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
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    clear(): void {
        this.cache.clear();
        logger.info('Quant analysis cache cleared');
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

const cacheManager = new QuantCacheManager();

function getCached<T>(key: string): T | null {
    return cacheManager.get<T>(key);
}

function setCache<T>(key: string, data: T): void {
    cacheManager.set(key, data);
}

export function clearQuantCache(): void {
    cacheManager.clear();
}

/**
 * Shutdown the quant service (cleanup timers, clear cache)
 * Call this when the application is shutting down
 */
export function shutdownQuantService(): void {
    cacheManager.shutdown();
    quantContextFetchPromisesByKey.clear();
    fundingHistoryStore.clear();  // v5.1.0: Clear funding history
    clearRegimeHistory();  // v5.1.0 Phase 2: Clear regime history
    logger.info('Quant service shutdown complete');
}

/**
 * Reset quant service state (for testing or hot reload)
 */
export function resetQuantServiceState(): void {
    quantContextFetchPromisesByKey.clear();
    cacheManager.clear();
    fundingHistoryStore.clear();  // v5.1.0: Clear funding history
    clearRegimeHistory();  // v5.1.0 Phase 2: Clear regime history
    logger.info('Quant service state reset');
}

// Map of in-flight promises by normalized symbol set key (moved to module level for shutdown/reset access)
const quantContextFetchPromisesByKey = new Map<string, Promise<QuantContext>>();

// ═══════════════════════════════════════════════════════════════════════════════
// FUNDING RATE HISTORY TRACKING (v5.1.0 Enhancement)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * In-memory funding rate history storage
 * Stores last 7 days (21 funding periods at 8h each) per symbol
 * Persists across cache clears but resets on service restart
 */
const FUNDING_HISTORY_MAX_ENTRIES = config.quant.fundingHistoryMaxEntries;  // 7 days × 3 periods/day
const FUNDING_HISTORY_MAX_AGE_MS = config.quant.fundingHistoryMaxAgeMs;  // 7 days
const FUNDING_HISTORY_MAX_SYMBOLS = config.quant.fundingHistoryMaxSymbols;  // Max symbols to track (memory protection)

interface FundingHistoryStore {
    entries: FundingRateHistoryEntry[];
    lastUpdated: number;
}

const fundingHistoryStore = new Map<string, FundingHistoryStore>();

/**
 * Add a funding rate to history for a symbol
 * Automatically prunes old entries and maintains max size
 */
function addFundingRateToHistory(symbol: string, rate: number): void {
    if (!Number.isFinite(rate)) return;

    const normalizedSymbol = normalizeSymbolForCache(symbol);
    if (!normalizedSymbol) return;

    const now = Date.now();
    let store = fundingHistoryStore.get(normalizedSymbol);

    if (!store) {
        // Memory protection: limit total symbols tracked
        if (fundingHistoryStore.size >= FUNDING_HISTORY_MAX_SYMBOLS) {
            // Remove oldest updated symbol
            let oldestSymbol: string | null = null;
            let oldestTime = Infinity;
            for (const [sym, s] of fundingHistoryStore.entries()) {
                if (s.lastUpdated < oldestTime) {
                    oldestTime = s.lastUpdated;
                    oldestSymbol = sym;
                }
            }
            if (oldestSymbol) {
                fundingHistoryStore.delete(oldestSymbol);
                logger.debug(`Funding history: evicted ${oldestSymbol} to make room for ${normalizedSymbol}`);
            }
        }

        store = { entries: [], lastUpdated: now };
        fundingHistoryStore.set(normalizedSymbol, store);
    }

    // Check if we already have an entry for this period (within 4 hours)
    // to avoid duplicate entries from multiple fetches
    const recentEntry = store.entries.find(e => now - e.timestamp < 4 * 60 * 60 * 1000);
    if (recentEntry) {
        // Update existing entry if rate changed significantly
        if (Math.abs(recentEntry.rate - rate) > 0.00001) {
            recentEntry.rate = rate;
            recentEntry.isExtreme = Math.abs(rate) > 0.0008;  // Preliminary extreme check
        }
        store.lastUpdated = now;
        return;
    }

    // Add new entry
    const entry: FundingRateHistoryEntry = {
        timestamp: now,
        rate,
        isExtreme: false,  // Will be recalculated with percentile
    };

    store.entries.push(entry);
    store.lastUpdated = now;

    // Prune old entries (older than 7 days)
    store.entries = store.entries.filter(e => now - e.timestamp < FUNDING_HISTORY_MAX_AGE_MS);

    // Enforce max size (keep most recent)
    if (store.entries.length > FUNDING_HISTORY_MAX_ENTRIES) {
        store.entries = store.entries
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice(0, FUNDING_HISTORY_MAX_ENTRIES);
    }

    // Recalculate isExtreme for all entries based on percentile
    recalculateFundingExtremes(normalizedSymbol);
}

/**
 * Recalculate which entries are "extreme" based on percentile ranking
 * An entry is extreme if it's in the top 5% or bottom 5% of the distribution
 * 
 * EDGE CASE HANDLING:
 * - With < 20 entries, p5 and p95 indices may overlap
 * - Use min/max as fallback for small datasets
 * - Require at least 3 entries for meaningful percentile calculation
 */
function recalculateFundingExtremes(normalizedSymbol: string): void {
    const store = fundingHistoryStore.get(normalizedSymbol);
    if (!store || store.entries.length < 3) return;

    const rates = store.entries.map(e => e.rate).filter(r => Number.isFinite(r));
    if (rates.length < 3) return;

    const sortedRates = [...rates].sort((a, b) => a - b);
    const n = sortedRates.length;

    // For small datasets, use more conservative thresholds
    // With 21 entries: p5 = index 1, p95 = index 19
    // With 10 entries: p5 = index 0, p95 = index 9 (min/max)
    // With 5 entries: p5 = index 0, p95 = index 4 (min/max)
    const p5Index = Math.max(0, Math.floor(n * 0.05));
    const p95Index = Math.min(n - 1, Math.floor(n * 0.95));

    // Ensure we have distinct thresholds (avoid marking everything as extreme)
    const p5Threshold = sortedRates[p5Index];
    const p95Threshold = sortedRates[p95Index];

    // If thresholds are the same (very small dataset), only mark actual min/max as extreme
    const useMinMax = p5Threshold === p95Threshold;

    for (const entry of store.entries) {
        if (useMinMax) {
            // Only mark actual min/max as extreme
            entry.isExtreme = entry.rate === sortedRates[0] || entry.rate === sortedRates[n - 1];
        } else {
            entry.isExtreme = entry.rate <= p5Threshold || entry.rate >= p95Threshold;
        }
    }
}

/**
 * Get funding rate history for a symbol
 */
function getFundingRateHistory(symbol: string): FundingRateHistoryEntry[] {
    const normalizedSymbol = normalizeSymbolForCache(symbol);
    if (!normalizedSymbol) return [];

    const store = fundingHistoryStore.get(normalizedSymbol);
    if (!store) return [];

    // Return sorted by timestamp (newest first)
    return [...store.entries].sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Calculate funding rate percentile within 7-day history
 */
function calculateFundingPercentile(symbol: string, currentRate: number): number {
    if (!Number.isFinite(currentRate)) return 50;

    const history = getFundingRateHistory(symbol);
    if (history.length < 3) return 50;  // Not enough history, return neutral

    const rates = history.map(e => e.rate).filter(r => Number.isFinite(r));
    if (rates.length < 3) return 50;

    const sortedRates = [...rates].sort((a, b) => a - b);
    return calculatePercentile(currentRate, sortedRates);
}

/**
 * Count consecutive extreme funding periods (for persistence filter)
 * Returns 0 if current rate is not extreme
 * 
 * NOTE: This counts from history entries only (current rate is already added to history
 * before this is called). The count represents how many consecutive periods have been extreme.
 */
function countConsecutiveExtremePeriods(symbol: string, currentRate: number): number {
    const history = getFundingRateHistory(symbol);
    if (history.length === 0) return 0;

    const percentile = calculateFundingPercentile(symbol, currentRate);
    const isCurrentExtreme = percentile >= 95 || percentile <= 5;

    if (!isCurrentExtreme) return 0;

    // Count consecutive extreme periods from history
    // History is sorted newest first, and current rate is already in history[0]
    let count = 0;
    const isPositiveExtreme = percentile >= 95;

    for (const entry of history) {
        // Check if this entry is extreme in the same direction
        const entryPercentile = calculateFundingPercentile(symbol, entry.rate);
        const entryIsExtreme = isPositiveExtreme
            ? entryPercentile >= 95
            : entryPercentile <= 5;

        if (entryIsExtreme) {
            count++;
        } else {
            break;  // Streak broken
        }
    }

    return count;
}

/**
 * Analyze funding rate for a symbol
 * Returns comprehensive funding analysis with percentile ranking and signals
 */
function analyzeFundingRate(symbol: string, currentRate: number): FundingRateAnalysis {
    // Add current rate to history
    addFundingRateToHistory(symbol, currentRate);

    const history = getFundingRateHistory(symbol);
    const percentile = calculateFundingPercentile(symbol, currentRate);
    const persistenceCount = countConsecutiveExtremePeriods(symbol, currentRate);

    // Determine if extreme (top/bottom 5%)
    const isExtreme = percentile >= 95 || percentile <= 5;
    const extremeDirection: 'long_crowded' | 'short_crowded' | 'neutral' =
        percentile >= 95 ? 'long_crowded' :
            percentile <= 5 ? 'short_crowded' :
                'neutral';

    // Persistence filter: require ≥2 consecutive periods (16+ hours)
    const isPersistent = isExtreme && persistenceCount >= 2;

    // Calculate annualized yield (3 periods/day × 365 days)
    const annualizedYield = currentRate * 3 * 365 * 100;

    // Generate signal
    const signal = generateFundingSignal(
        currentRate,
        percentile,
        isExtreme,
        isPersistent,
        extremeDirection
    );

    return {
        currentRate,
        percentile,
        isExtreme,
        extremeDirection,
        persistenceCount,
        isPersistent,
        signal,
        annualizedYield: Number.isFinite(annualizedYield) ? annualizedYield : 0,
        history: history.slice(0, 10),  // Return last 10 entries for context
    };
}

/**
 * Generate funding-based trading signal
 * Per quant advisor: Only signal if persistent, max contribution ±1.5 points
 */
function generateFundingSignal(
    currentRate: number,
    percentile: number,
    isExtreme: boolean,
    isPersistent: boolean,
    extremeDirection: 'long_crowded' | 'short_crowded' | 'neutral'
): FundingSignal {
    // Default neutral signal
    const neutralSignal: FundingSignal = {
        direction: 'neutral',
        strength: 0,
        confidence: 50,
        reason: 'Funding rate within normal range',
        carryExpectedPct: 0,
    };

    // Guard: if not extreme or direction is neutral, return neutral signal
    if (!isExtreme || extremeDirection === 'neutral') {
        return neutralSignal;
    }

    // Calculate expected carry per cycle (realistic: 0.05-0.3%)
    // Guard against invalid currentRate
    const safeRate = Number.isFinite(currentRate) ? currentRate : 0;
    const carryExpectedPct = Math.min(0.3, Math.max(0.05, Math.abs(safeRate) * 100));

    // Non-persistent extreme: weak signal
    if (!isPersistent) {
        return {
            direction: extremeDirection === 'long_crowded' ? 'short' : 'long',
            strength: 30,  // Weak
            confidence: 55,
            reason: `Funding ${extremeDirection} (${safeToFixed(percentile, 0)}th percentile) but not persistent - wait for confirmation`,
            carryExpectedPct,
        };
    }

    // Persistent extreme: strong contrarian signal
    const direction = extremeDirection === 'long_crowded' ? 'short' : 'long';
    const strength = Math.min(70, 40 + (Math.abs(percentile - 50) / 2));  // 40-70 range

    return {
        direction,
        strength,
        confidence: 70,
        reason: `Funding ${extremeDirection} (${safeToFixed(percentile, 0)}th percentile) for 2+ periods - contrarian ${direction.toUpperCase()} signal`,
        carryExpectedPct,
    };
}

/**
 * Clear funding history (for testing or reset)
 */
export function clearFundingHistory(): void {
    fundingHistoryStore.clear();
    logger.info('Funding rate history cleared');
}


// ═══════════════════════════════════════════════════════════════════════════════
// STATISTICAL CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Safely parse a float value, returning 0 for invalid inputs
 */
function safeParseFloat(value: string | number | null | undefined): number {
    if (value === null || value === undefined) return 0;
    const parsed = typeof value === 'number' ? value : parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Safely format a number with toFixed, handling NaN/Infinity
 */
function safeToFixed(value: number, decimals: number): string {
    return Number.isFinite(value) ? value.toFixed(decimals) : '0';
}

/**
 * Calculate mean of an array
 * Returns 0 for empty arrays or arrays with all invalid values
 */
function calculateMean(values: number[]): number {
    if (!Array.isArray(values) || values.length === 0) return 0;

    // Filter out NaN/Infinity values
    const validValues = values.filter(v => Number.isFinite(v));
    if (validValues.length === 0) return 0;

    const sum = validValues.reduce((a, b) => a + b, 0);
    const result = sum / validValues.length;
    return Number.isFinite(result) ? result : 0;
}

/**
 * Calculate standard deviation
 * Returns 0 for arrays with less than 2 valid values
 */
function calculateStdDev(values: number[], mean?: number): number {
    if (!Array.isArray(values) || values.length < 2) return 0;

    // Filter out NaN/Infinity values
    const validValues = values.filter(v => Number.isFinite(v));
    if (validValues.length < 2) return 0;

    const m = mean !== undefined && Number.isFinite(mean) ? mean : calculateMean(validValues);
    const squaredDiffs = validValues.map(v => Math.pow(v - m, 2));
    const variance = squaredDiffs.reduce((a, b) => a + b, 0) / (validValues.length - 1);
    const result = Math.sqrt(variance);
    return Number.isFinite(result) ? result : 0;
}

/**
 * Calculate z-score (how many std devs from mean)
 * Returns 0 if stdDev is 0 or inputs are invalid
 */
function calculateZScore(value: number, mean: number, stdDev: number): number {
    if (!Number.isFinite(value) || !Number.isFinite(mean) || !Number.isFinite(stdDev)) return 0;
    if (stdDev === 0) return 0;
    const result = (value - mean) / stdDev;
    return Number.isFinite(result) ? result : 0;
}

/**
 * Calculate percentile rank of a value in a distribution
 * Returns 50 (median) for empty arrays or invalid inputs
 * 
 * @param value - The value to find the percentile for
 * @param values - Array of values (will be filtered and sorted internally)
 * 
 * NOTE: This function sorts internally after filtering to ensure correctness.
 * Callers do NOT need to pre-sort the input array.
 */
function calculatePercentile(value: number, values: number[]): number {
    if (!Number.isFinite(value)) return 50;
    if (!Array.isArray(values) || values.length === 0) return 50;

    // Filter out invalid values and sort
    const validValues = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b);
    if (validValues.length === 0) return 50;

    // Count all values less than the target (no early break - need full count)
    let count = 0;
    for (const v of validValues) {
        if (v < value) count++;
    }
    const result = (count / validValues.length) * 100;
    return Number.isFinite(result) ? result : 50;
}

/**
 * Calculate annualized volatility from returns
 * Returns 0 for insufficient data or invalid inputs
 */
function calculateVolatility(prices: number[], periodsPerYear: number = 365 * 24): number {
    if (!Array.isArray(prices) || prices.length < 2) return 0;
    if (!Number.isFinite(periodsPerYear) || periodsPerYear <= 0) return 0;

    // Calculate log returns, filtering invalid values
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1];
        const curr = prices[i];
        if (Number.isFinite(prev) && Number.isFinite(curr) && prev > 0 && curr > 0) {
            const logReturn = Math.log(curr / prev);
            if (Number.isFinite(logReturn)) {
                returns.push(logReturn);
            }
        }
    }

    if (returns.length === 0) return 0;

    const stdDev = calculateStdDev(returns);
    if (stdDev === 0) return 0;

    // Annualize: multiply by sqrt of periods per year
    const result = stdDev * Math.sqrt(periodsPerYear) * 100;
    return Number.isFinite(result) ? result : 0;
}

/**
 * Calculate correlation between two price series
 * Returns 0 for insufficient data or invalid inputs
 */
function calculateCorrelation(series1: number[], series2: number[]): number {
    if (!Array.isArray(series1) || !Array.isArray(series2)) return 0;

    const n = Math.min(series1.length, series2.length);
    if (n < 2) return 0;

    const s1 = series1.slice(-n);
    const s2 = series2.slice(-n);

    // Filter out pairs where either value is invalid
    const validPairs: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(s1[i]) && Number.isFinite(s2[i])) {
            validPairs.push([s1[i], s2[i]]);
        }
    }

    if (validPairs.length < 2) return 0;

    const validS1 = validPairs.map(p => p[0]);
    const validS2 = validPairs.map(p => p[1]);

    const mean1 = calculateMean(validS1);
    const mean2 = calculateMean(validS2);
    const stdDev1 = calculateStdDev(validS1, mean1);
    const stdDev2 = calculateStdDev(validS2, mean2);

    if (stdDev1 === 0 || stdDev2 === 0) return 0;

    let covariance = 0;
    for (let i = 0; i < validPairs.length; i++) {
        covariance += (validS1[i] - mean1) * (validS2[i] - mean2);
    }
    covariance /= (validPairs.length - 1);

    const correlation = covariance / (stdDev1 * stdDev2);
    // Clamp to [-1, 1] and validate
    const clamped = Math.max(-1, Math.min(1, correlation));
    return Number.isFinite(clamped) ? clamped : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDICATOR CALCULATIONS FOR REGIME DETECTION (v5.1.0 Phase 2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Exponential Moving Average
 */
function calculateEMA(prices: number[], period: number): number {
    if (!Array.isArray(prices) || prices.length < period) {
        return prices.length > 0 ? prices[prices.length - 1] : 0;
    }

    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;  // SMA for first period

    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
    }

    return Number.isFinite(ema) ? ema : prices[prices.length - 1];
}

function calculateEMASeries(prices: number[], period: number): number[] {
    if (!Array.isArray(prices) || prices.length < period) {
        return prices.length > 0 ? [prices[prices.length - 1]] : [0];
    }
    const multiplier = 2 / (period + 1);
    const series: number[] = [];
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    series.push(ema);
    for (let i = period; i < prices.length; i++) {
        ema = (prices[i] - ema) * multiplier + ema;
        if (Number.isFinite(ema)) series.push(ema);
    }
    return series;
}

function calculateRSI(prices: number[], period: number): number {
    if (!Array.isArray(prices) || prices.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = prices[i] - prices[i - 1];
        if (change >= 0) gains += change;
        else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
        const change = prices[i] - prices[i - 1];
        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? -change : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    const rsi = 100 - (100 / (1 + rs));
    return Number.isFinite(rsi) ? rsi : 50;
}

function calculateReturns(prices: number[]): number[] {
    if (!Array.isArray(prices) || prices.length < 2) return [];
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        const prev = prices[i - 1];
        const curr = prices[i];
        if (prev > 0 && Number.isFinite(prev) && Number.isFinite(curr)) {
            returns.push((curr - prev) / prev);
        }
    }
    return returns;
}

function calculateDonchianBounds(candles: WeexCandle[], period: number): { upper: number; lower: number } {
    if (!Array.isArray(candles) || candles.length < period) {
        return { upper: 0, lower: 0 };
    }
    const window = candles.slice(-period);
    let upper = -Infinity;
    let lower = Infinity;
    for (const candle of window) {
        const high = safeParseFloat(candle.high);
        const low = safeParseFloat(candle.low);
        if (high > 0 && low > 0) {
            if (high > upper) upper = high;
            if (low < lower) lower = low;
        }
    }
    if (!Number.isFinite(upper) || !Number.isFinite(lower)) return { upper: 0, lower: 0 };
    return { upper, lower };
}

function calculatePivotPoints(candles: WeexCandle[]): { pivot: number; resistance: number; support: number } {
    if (!Array.isArray(candles) || candles.length < 25) {
        return { pivot: 0, resistance: 0, support: 0 };
    }
    const window = candles.slice(-25, -1);
    let high = -Infinity;
    let low = Infinity;
    let close = safeParseFloat(window[window.length - 1].close);
    for (const candle of window) {
        const h = safeParseFloat(candle.high);
        const l = safeParseFloat(candle.low);
        if (h > 0) high = Math.max(high, h);
        if (l > 0) low = Math.min(low, l);
    }
    if (!Number.isFinite(high) || !Number.isFinite(low) || high <= 0 || low <= 0 || !Number.isFinite(close) || close <= 0) {
        return { pivot: 0, resistance: 0, support: 0 };
    }
    const pivot = (high + low + close) / 3;
    const resistance = 2 * pivot - low;
    const support = 2 * pivot - high;
    return {
        pivot: Number.isFinite(pivot) ? pivot : 0,
        resistance: Number.isFinite(resistance) ? resistance : 0,
        support: Number.isFinite(support) ? support : 0,
    };
}

function calculateIBS(high: number, low: number, close: number): number {
    if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return 0.5;
    const range = high - low;
    if (range <= 0) return 0.5;
    const ibs = (close - low) / range;
    return Number.isFinite(ibs) ? Math.max(0, Math.min(1, ibs)) : 0.5;
}

function createNeutralStrategySignal(name: string, reason: string): StrategySignal {
    return { name, direction: 'neutral', strength: 0, confidence: 50, reason };
}

async function computeNaiveBayesSignal(symbol: string, trendDirection: 'up' | 'down' | 'sideways'): Promise<StrategySignal> {
    const name = 'naive_bayes';
    try {
        const analysis = await getSentimentAnalysis(symbol);
        const score = Number.isFinite(analysis?.overallScore) ? analysis.overallScore : 0;
        const count = Number.isFinite(analysis?.newsCount) ? analysis.newsCount : 0;
        if (count < 3) {
            return createNeutralStrategySignal(name, 'insufficient sentiment volume');
        }
        const baseStrength = Math.min(100, Math.abs(score) * 120);
        const confidence = Math.min(85, 40 + Math.min(40, count * 5) + Math.abs(score) * 40);
        if (score >= 0.7 && trendDirection === 'down') {
            return { name, direction: 'short', strength: Math.min(100, Math.max(60, baseStrength)), confidence, reason: 'sentiment extreme bullish vs downtrend' };
        }
        if (score <= -0.7 && trendDirection === 'up') {
            return { name, direction: 'long', strength: Math.min(100, Math.max(60, baseStrength)), confidence, reason: 'sentiment extreme bearish vs uptrend' };
        }
        if (score > 0.25) {
            return { name, direction: 'long', strength: baseStrength, confidence, reason: 'sentiment skewed positive' };
        }
        if (score < -0.25) {
            return { name, direction: 'short', strength: baseStrength, confidence, reason: 'sentiment skewed negative' };
        }
        return createNeutralStrategySignal(name, 'sentiment neutral');
    } catch (error) {
        logger.warn(`naive_bayes sentiment unavailable for ${symbol}`, error);
        return createNeutralStrategySignal(name, 'sentiment unavailable');
    }
}

function computeMaCrossoverSignal(closes: number[]): StrategySignal {
    const name = 'ma_crossover';
    if (!Array.isArray(closes) || closes.length < 60) {
        return createNeutralStrategySignal(name, 'insufficient data');
    }
    const ema20Series = calculateEMASeries(closes, 20);
    const ema50Series = calculateEMASeries(closes, 50);
    const ema200 = calculateEMA(closes, 200);
    const ema20 = ema20Series[ema20Series.length - 1] ?? 0;
    const ema50 = ema50Series[ema50Series.length - 1] ?? 0;
    const prevEma20 = ema20Series[ema20Series.length - 2] ?? ema20;
    const prevEma50 = ema50Series[ema50Series.length - 2] ?? ema50;
    const golden = prevEma20 <= prevEma50 && ema20 > ema50;
    const death = prevEma20 >= prevEma50 && ema20 < ema50;
    const trendFilterLong = ema200 > 0 && ema20 > ema200 && ema50 > ema200;
    const trendFilterShort = ema200 > 0 && ema20 < ema200 && ema50 < ema200;
    if (golden && trendFilterLong) {
        return { name, direction: 'long', strength: 80, confidence: 70, reason: 'ema20 crossed above ema50 with ema200 filter' };
    }
    if (death && trendFilterShort) {
        return { name, direction: 'short', strength: 80, confidence: 70, reason: 'ema20 crossed below ema50 with ema200 filter' };
    }
    return createNeutralStrategySignal(name, 'no crossover edge');
}

function computeDonchianSignal(candles: WeexCandle[]): StrategySignal {
    const name = 'donchian';
    if (!Array.isArray(candles) || candles.length < 20) {
        return createNeutralStrategySignal(name, 'insufficient data');
    }
    const bounds = calculateDonchianBounds(candles, 20);
    const last = candles[candles.length - 1];
    const close = safeParseFloat(last.close);
    if (!Number.isFinite(close) || close <= 0 || bounds.upper <= 0 || bounds.lower <= 0) {
        return createNeutralStrategySignal(name, 'invalid price');
    }
    const breakoutLong = close > bounds.upper;
    const breakoutShort = close < bounds.lower;
    if (breakoutLong) {
        return { name, direction: 'long', strength: 85, confidence: 75, reason: 'breakout above donchian upper' };
    }
    if (breakoutShort) {
        return { name, direction: 'short', strength: 85, confidence: 75, reason: 'breakdown below donchian lower' };
    }
    const nearUpper = Math.abs(close - bounds.upper) / bounds.upper < 0.003;
    const nearLower = Math.abs(close - bounds.lower) / bounds.lower < 0.003;
    if (nearUpper) {
        return { name, direction: 'short', strength: 55, confidence: 55, reason: 'mean reversion at upper band' };
    }
    if (nearLower) {
        return { name, direction: 'long', strength: 55, confidence: 55, reason: 'mean reversion at lower band' };
    }
    return createNeutralStrategySignal(name, 'inside channel');
}

function computePivotSignal(candles: WeexCandle[], trendDirection: 'up' | 'down' | 'sideways'): StrategySignal {
    const name = 'pivot_points';
    const pivot = calculatePivotPoints(candles);
    const close = candles.length > 0 ? safeParseFloat(candles[candles.length - 1].close) : 0;
    if (pivot.pivot <= 0 || close <= 0) {
        return createNeutralStrategySignal(name, 'insufficient pivot data');
    }
    if (close > pivot.pivot && trendDirection !== 'down') {
        return { name, direction: 'long', strength: 70, confidence: 65, reason: 'price above pivot with trend support' };
    }
    if (close < pivot.pivot && trendDirection !== 'up') {
        return { name, direction: 'short', strength: 70, confidence: 65, reason: 'price below pivot with trend support' };
    }
    return createNeutralStrategySignal(name, 'pivot neutral');
}

function computeIbsSignal(candles: WeexCandle[]): StrategySignal {
    const name = 'ibs';
    if (!Array.isArray(candles) || candles.length < 30) {
        return createNeutralStrategySignal(name, 'insufficient data');
    }
    const dailySlices: number[] = [];
    for (let i = 24; i < candles.length; i += 24) {
        const window = candles.slice(i - 24, i);
        const high = Math.max(...window.map(c => safeParseFloat(c.high)).filter(v => v > 0));
        const low = Math.min(...window.map(c => safeParseFloat(c.low)).filter(v => v > 0));
        const close = safeParseFloat(window[window.length - 1].close);
        if (high > 0 && low > 0 && close > 0) {
            dailySlices.push(calculateIBS(high, low, close));
        }
    }
    if (dailySlices.length < 3) {
        return createNeutralStrategySignal(name, 'insufficient daily windows');
    }
    const lastWindow = candles.slice(-24);
    const high = Math.max(...lastWindow.map(c => safeParseFloat(c.high)).filter(v => v > 0));
    const low = Math.min(...lastWindow.map(c => safeParseFloat(c.low)).filter(v => v > 0));
    const close = safeParseFloat(lastWindow[lastWindow.length - 1].close);
    const ibs = calculateIBS(high, low, close);
    const sorted = [...dailySlices].sort((a, b) => a - b);
    const percentile = calculatePercentile(ibs, sorted);
    if (percentile <= 10) {
        return { name, direction: 'long', strength: 75, confidence: 70, reason: 'ibs in bottom decile' };
    }
    if (percentile >= 90) {
        return { name, direction: 'short', strength: 75, confidence: 70, reason: 'ibs in top decile' };
    }
    return createNeutralStrategySignal(name, 'ibs mid range');
}

function computeKnnSignal(closes: number[]): StrategySignal {
    const name = 'knn';
    if (!Array.isArray(closes) || closes.length < 60) {
        return createNeutralStrategySignal(name, 'insufficient data');
    }
    const returns = calculateReturns(closes);
    const rsi = calculateRSI(closes, 14);
    const ema20 = calculateEMA(closes, 20);
    const ema50 = calculateEMA(closes, 50);
    const vol = calculateStdDev(returns.slice(-20), calculateMean(returns.slice(-20)));
    const featureVectors: Array<{ vector: number[]; forward: number }> = [];
    for (let i = 5; i < returns.length - 1; i++) {
        const recent = returns.slice(i - 5, i);
        const meanRet = calculateMean(recent);
        const stdRet = calculateStdDev(recent, meanRet);
        const forward = returns[i];
        const vector = [
            meanRet,
            stdRet,
            rsi / 100,
            ema20 > 0 && ema50 > 0 ? ema20 / ema50 : 1,
        ];
        if (vector.every(v => Number.isFinite(v)) && Number.isFinite(forward)) {
            featureVectors.push({ vector, forward });
        }
    }
    if (featureVectors.length < 10) {
        return createNeutralStrategySignal(name, 'insufficient knn history');
    }
    const latestVector = [
        calculateMean(returns.slice(-5)),
        calculateStdDev(returns.slice(-5), calculateMean(returns.slice(-5))),
        rsi / 100,
        ema20 > 0 && ema50 > 0 ? ema20 / ema50 : 1,
    ];
    const distances = featureVectors.map(item => {
        let sum = 0;
        for (let i = 0; i < latestVector.length; i++) {
            const d = latestVector[i] - item.vector[i];
            sum += d * d;
        }
        return { dist: Math.sqrt(sum), forward: item.forward };
    }).filter(d => Number.isFinite(d.dist));
    distances.sort((a, b) => a.dist - b.dist);
    const k = Math.min(7, distances.length);
    const neighbors = distances.slice(0, k);
    const avgReturn = calculateMean(neighbors.map(n => n.forward));
    const threshold = Math.max(0.001, Math.abs(vol) * 0.5);
    if (avgReturn > threshold) {
        return { name, direction: 'long', strength: Math.min(100, (avgReturn / threshold) * 60 + 40), confidence: 60, reason: 'knn predicts positive return' };
    }
    if (avgReturn < -threshold) {
        return { name, direction: 'short', strength: Math.min(100, (Math.abs(avgReturn) / threshold) * 60 + 40), confidence: 60, reason: 'knn predicts negative return' };
    }
    return createNeutralStrategySignal(name, 'knn neutral');
}

type AnnModel = { weights1: number[][]; bias1: number[]; weights2: number[][]; bias2: number[]; lastTrained: number };
const annModels = new Map<string, AnnModel>();

function softmax(values: number[]): number[] {
    const max = Math.max(...values);
    const exps = values.map(v => Math.exp(v - max));
    const sum = exps.reduce((a, b) => a + b, 0);
    return sum > 0 ? exps.map(v => v / sum) : values.map(() => 1 / values.length);
}

function computeAnnSignal(symbol: string, closes: number[]): StrategySignal {
    const name = 'ann';
    const normalized = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '');
    if (normalized !== 'btc') {
        return createNeutralStrategySignal(name, 'ann scoped to btc');
    }
    if (!Array.isArray(closes) || closes.length < 120) {
        return createNeutralStrategySignal(name, 'insufficient data');
    }
    const returns = calculateReturns(closes);
    const features: number[][] = [];
    const labels: number[] = [];
    const maxIndex = returns.length - 2;
    for (let i = 20; i < maxIndex; i++) {
        const window = closes.slice(i - 20, i + 1);
        const rsi = calculateRSI(window, 14) / 100;
        const ema20 = calculateEMA(window, 20);
        const ema50 = calculateEMA(window, 50);
        const vol = calculateStdDev(returns.slice(i - 10, i), calculateMean(returns.slice(i - 10, i)));
        const feat = [
            returns[i],
            calculateMean(returns.slice(i - 5, i)),
            ema20 > 0 && ema50 > 0 ? ema20 / ema50 : 1,
            rsi,
            Number.isFinite(vol) ? vol : 0,
        ];
        if (feat.every(v => Number.isFinite(v))) {
            features.push(feat);
            labels.push(returns[i + 1]);
        }
    }
    if (features.length < 30) {
        return createNeutralStrategySignal(name, 'insufficient feature history');
    }
    const labelSorted = [...labels].sort((a, b) => a - b);
    const q1 = labelSorted[Math.floor(labelSorted.length * 0.33)] ?? 0;
    const q2 = labelSorted[Math.floor(labelSorted.length * 0.66)] ?? 0;
    const classes = labels.map(v => v <= q1 ? 0 : v >= q2 ? 2 : 1);
    const inputSize = features[0].length;
    const hiddenSize = 6;
    const outputSize = 3;
    let model = annModels.get(normalized);
    if (!model || Date.now() - model.lastTrained > 6 * 60 * 60 * 1000) {
        const weights1 = Array.from({ length: inputSize }, (_, i) =>
            Array.from({ length: hiddenSize }, (_, j) => ((i + 1) * (j + 1)) / 1000)
        );
        const bias1 = Array.from({ length: hiddenSize }, () => 0);
        const weights2 = Array.from({ length: hiddenSize }, (_, i) =>
            Array.from({ length: outputSize }, (_, j) => ((i + 1) * (j + 2)) / 1000)
        );
        const bias2 = Array.from({ length: outputSize }, () => 0);
        const lr = 0.05;
        const epochs = 8;
        for (let epoch = 0; epoch < epochs; epoch++) {
            for (let idx = 0; idx < features.length; idx++) {
                const x = features[idx];
                const y = classes[idx];
                const hidden = bias1.map((b, h) => {
                    let sum = b;
                    for (let i = 0; i < inputSize; i++) sum += x[i] * weights1[i][h];
                    return Math.max(0, sum);
                });
                const logits = bias2.map((b, o) => {
                    let sum = b;
                    for (let h = 0; h < hiddenSize; h++) sum += hidden[h] * weights2[h][o];
                    return sum;
                });
                const probs = softmax(logits);
                for (let o = 0; o < outputSize; o++) {
                    const grad = probs[o] - (o === y ? 1 : 0);
                    bias2[o] -= lr * grad;
                    for (let h = 0; h < hiddenSize; h++) {
                        weights2[h][o] -= lr * grad * hidden[h];
                    }
                }
                for (let h = 0; h < hiddenSize; h++) {
                    if (hidden[h] <= 0) continue;
                    let gradHidden = 0;
                    for (let o = 0; o < outputSize; o++) {
                        const grad = probs[o] - (o === y ? 1 : 0);
                        gradHidden += grad * weights2[h][o];
                    }
                    bias1[h] -= lr * gradHidden;
                    for (let i = 0; i < inputSize; i++) {
                        weights1[i][h] -= lr * gradHidden * x[i];
                    }
                }
            }
        }
        model = { weights1, bias1, weights2, bias2, lastTrained: Date.now() };
        annModels.set(normalized, model);
    }
    const latestWindow = closes.slice(-21);
    const latestReturns = calculateReturns(latestWindow);
    const latestFeat = [
        latestReturns[latestReturns.length - 1] ?? 0,
        calculateMean(latestReturns.slice(-5)),
        (() => {
            const e20 = calculateEMA(latestWindow, 20);
            const e50 = calculateEMA(latestWindow, 50);
            return e20 > 0 && e50 > 0 ? e20 / e50 : 1;
        })(),
        calculateRSI(latestWindow, 14) / 100,
        calculateStdDev(latestReturns.slice(-10), calculateMean(latestReturns.slice(-10))),
    ];
    if (!latestFeat.every(v => Number.isFinite(v))) {
        return createNeutralStrategySignal(name, 'invalid ann features');
    }
    const hidden = model.bias1.map((b, h) => {
        let sum = b;
        for (let i = 0; i < inputSize; i++) sum += latestFeat[i] * model.weights1[i][h];
        return Math.max(0, sum);
    });
    const logits = model.bias2.map((b, o) => {
        let sum = b;
        for (let h = 0; h < hiddenSize; h++) sum += hidden[h] * model.weights2[h][o];
        return sum;
    });
    const probs = softmax(logits);
    const maxProb = Math.max(...probs);
    const maxIdx = probs.indexOf(maxProb);
    if (maxIdx === 2) {
        return { name, direction: 'long', strength: Math.round(maxProb * 100), confidence: Math.round(maxProb * 100), reason: 'ann predicts upper quantile' };
    }
    if (maxIdx === 0) {
        return { name, direction: 'short', strength: Math.round(maxProb * 100), confidence: Math.round(maxProb * 100), reason: 'ann predicts lower quantile' };
    }
    return createNeutralStrategySignal(name, 'ann neutral');
}

function computeAlphaComboSignal(closes: number[], volumes: number[]): StrategySignal {
    const name = 'alpha_combo';
    if (!Array.isArray(closes) || closes.length < 60) {
        return createNeutralStrategySignal(name, 'insufficient data');
    }
    const returns = calculateReturns(closes);
    const alphas: number[][] = [];
    const forward: number[] = [];
    const maxIndex = returns.length - 2;
    for (let i = 10; i < maxIndex; i++) {
        const momentum = calculateMean(returns.slice(i - 5, i));
        const mean = calculateMean(closes.slice(i - 20, i));
        const std = calculateStdDev(closes.slice(i - 20, i), mean);
        const z = std > 0 ? (closes[i] - mean) / std : 0;
        const vol = calculateStdDev(returns.slice(i - 10, i), calculateMean(returns.slice(i - 10, i)));
        const volChange = volumes.length > i && volumes[i - 1] > 0 ? (volumes[i] - volumes[i - 1]) / volumes[i - 1] : 0;
        const alpha = [momentum, -z, vol, volChange];
        if (alpha.every(v => Number.isFinite(v)) && Number.isFinite(returns[i + 1])) {
            alphas.push(alpha);
            forward.push(returns[i + 1]);
        }
    }
    if (alphas.length < 20) {
        return createNeutralStrategySignal(name, 'insufficient alpha history');
    }
    const weights = [0, 0, 0, 0];
    for (let j = 0; j < weights.length; j++) {
        const series = alphas.map(a => a[j]);
        const corr = calculateCorrelation(series, forward);
        weights[j] = Number.isFinite(corr) ? corr : 0;
    }
    const latestMomentum = calculateMean(returns.slice(-5));
    const mean = calculateMean(closes.slice(-20));
    const std = calculateStdDev(closes.slice(-20), mean);
    const z = std > 0 ? (closes[closes.length - 1] - mean) / std : 0;
    const vol = calculateStdDev(returns.slice(-10), calculateMean(returns.slice(-10)));
    const volChange = volumes.length > 1 && volumes[volumes.length - 2] > 0 ? (volumes[volumes.length - 1] - volumes[volumes.length - 2]) / volumes[volumes.length - 2] : 0;
    const latest = [latestMomentum, -z, vol, volChange];
    const score = latest.reduce((sum, v, i) => sum + v * weights[i], 0);
    if (score > 0.001) {
        return { name, direction: 'long', strength: Math.min(100, Math.abs(score) * 5000), confidence: 60, reason: 'alpha combo bullish' };
    }
    if (score < -0.001) {
        return { name, direction: 'short', strength: Math.min(100, Math.abs(score) * 5000), confidence: 60, reason: 'alpha combo bearish' };
    }
    return createNeutralStrategySignal(name, 'alpha combo neutral');
}

function computeStatArbSignalFromResidual(residuals: number[]): StrategySignal {
    const name = 'stat_arb';
    if (!Array.isArray(residuals) || residuals.length < 20) {
        return createNeutralStrategySignal(name, 'insufficient residual history');
    }
    const mean = calculateMean(residuals);
    const std = calculateStdDev(residuals, mean);
    const latest = residuals[residuals.length - 1];
    const z = std > 0 ? (latest - mean) / std : 0;
    if (z > 1.5) {
        return { name, direction: 'short', strength: Math.min(100, Math.abs(z) * 30), confidence: 65, reason: 'positive residual mean reversion' };
    }
    if (z < -1.5) {
        return { name, direction: 'long', strength: Math.min(100, Math.abs(z) * 30), confidence: 65, reason: 'negative residual mean reversion' };
    }
    return createNeutralStrategySignal(name, 'stat arb neutral');
}

function computeMultiAssetTrendSignal(momentumRank: number, total: number, momentum: number): StrategySignal {
    const name = 'multi_asset_trend';
    if (total <= 1) {
        return createNeutralStrategySignal(name, 'insufficient cross-asset data');
    }
    const percentile = total > 1 ? (momentumRank / (total - 1)) * 100 : 50;
    if (momentum > 0 && percentile >= 70) {
        return { name, direction: 'long', strength: Math.min(100, percentile), confidence: 70, reason: 'top momentum cohort' };
    }
    if (momentum < 0 && percentile <= 30) {
        return { name, direction: 'short', strength: Math.min(100, 100 - percentile), confidence: 65, reason: 'bottom momentum cohort' };
    }
    return createNeutralStrategySignal(name, 'momentum neutral');
}

function calculateRegressionResiduals(targetReturns: number[], baseReturns: number[]): number[] {
    if (!Array.isArray(targetReturns) || !Array.isArray(baseReturns)) return [];
    const n = Math.min(targetReturns.length, baseReturns.length);
    if (n < 10) return [];
    const t = targetReturns.slice(-n);
    const b = baseReturns.slice(-n);
    const meanT = calculateMean(t);
    const meanB = calculateMean(b);
    let cov = 0;
    let varB = 0;
    for (let i = 0; i < n; i++) {
        const dt = t[i] - meanT;
        const db = b[i] - meanB;
        cov += dt * db;
        varB += db * db;
    }
    if (varB === 0) return [];
    const beta = cov / varB;
    const alpha = meanT - beta * meanB;
    const residuals: number[] = [];
    for (let i = 0; i < n; i++) {
        const predicted = alpha + beta * b[i];
        const residual = t[i] - predicted;
        if (Number.isFinite(residual)) residuals.push(residual);
    }
    return residuals;
}

function calculateMomentum(closes: number[], lookback: number): number {
    if (!Array.isArray(closes) || closes.length < lookback + 1) return 0;
    const end = closes[closes.length - 1];
    const start = closes[closes.length - 1 - lookback];
    if (!Number.isFinite(end) || !Number.isFinite(start) || start <= 0) return 0;
    return (end - start) / start;
}

/**
 * Calculate ATR history for regime detection
 */
function calculateATRHistory(highs: number[], lows: number[], closes: number[], period: number): number[] {
    if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
        return [];
    }

    const trueRanges: number[] = [];

    // Calculate True Range for each period
    for (let i = 1; i < closes.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];

        if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(prevClose)) {
            continue;
        }

        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );

        if (Number.isFinite(tr)) {
            trueRanges.push(tr);
        }
    }

    if (trueRanges.length < period) return [];

    // Calculate ATR using EMA of True Range
    const atrHistory: number[] = [];
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    atrHistory.push(atr);

    const multiplier = 2 / (period + 1);
    for (let i = period; i < trueRanges.length; i++) {
        atr = (trueRanges[i] - atr) * multiplier + atr;
        atrHistory.push(atr);
    }

    return atrHistory;
}

/**
 * Calculate ADX (Average Directional Index) with +DI and -DI
 * Simplified implementation for regime detection
 */
function calculateADX(highs: number[], lows: number[], closes: number[], period: number): { adx: number; plusDI: number; minusDI: number } {
    const defaultResult = { adx: 20, plusDI: 25, minusDI: 25 };

    if (highs.length < period + 1 || lows.length < period + 1 || closes.length < period + 1) {
        return defaultResult;
    }

    const plusDMs: number[] = [];
    const minusDMs: number[] = [];
    const trueRanges: number[] = [];

    for (let i = 1; i < highs.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevHigh = highs[i - 1];
        const prevLow = lows[i - 1];
        const prevClose = closes[i - 1];

        if (!Number.isFinite(high) || !Number.isFinite(low) ||
            !Number.isFinite(prevHigh) || !Number.isFinite(prevLow) || !Number.isFinite(prevClose)) {
            continue;
        }

        // True Range
        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(tr);

        // Directional Movement
        const upMove = high - prevHigh;
        const downMove = prevLow - low;

        const plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
        const minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;

        plusDMs.push(plusDM);
        minusDMs.push(minusDM);
    }

    if (plusDMs.length < period) return defaultResult;

    // Smooth the values using Wilder's smoothing (similar to EMA)
    const smooth = (values: number[], p: number): number => {
        if (values.length < p) return 0;
        let smoothed = values.slice(0, p).reduce((a, b) => a + b, 0);
        for (let i = p; i < values.length; i++) {
            smoothed = smoothed - (smoothed / p) + values[i];
        }
        return smoothed;
    };

    const smoothedPlusDM = smooth(plusDMs, period);
    const smoothedMinusDM = smooth(minusDMs, period);
    const smoothedTR = smooth(trueRanges, period);

    if (smoothedTR === 0) return defaultResult;

    const plusDI = (smoothedPlusDM / smoothedTR) * 100;
    const minusDI = (smoothedMinusDM / smoothedTR) * 100;

    // Calculate DX and ADX
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0;

    // ADX is smoothed DX (simplified - just use DX for now)
    const adx = dx;

    return {
        adx: Number.isFinite(adx) ? adx : 20,
        plusDI: Number.isFinite(plusDI) ? plusDI : 25,
        minusDI: Number.isFinite(minusDI) ? minusDI : 25,
    };
}

/**
 * Calculate Bollinger Bands
 */
function calculateBollingerBands(prices: number[], period: number, stdDevMultiplier: number): { upper: number; middle: number; lower: number; width: number } {
    const defaultResult = { upper: 0, middle: 0, lower: 0, width: 0.02 };

    if (!Array.isArray(prices) || prices.length < period) {
        return defaultResult;
    }

    const recentPrices = prices.slice(-period);
    const middle = calculateMean(recentPrices);
    const stdDev = calculateStdDev(recentPrices, middle);

    if (!Number.isFinite(middle) || middle === 0) return defaultResult;

    const upper = middle + (stdDev * stdDevMultiplier);
    const lower = middle - (stdDev * stdDevMultiplier);
    const width = (upper - lower) / middle;

    return {
        upper: Number.isFinite(upper) ? upper : middle * 1.02,
        middle,
        lower: Number.isFinite(lower) ? lower : middle * 0.98,
        width: Number.isFinite(width) ? width : 0.02,
    };
}

/**
 * Find support and resistance levels using pivot points
 * Returns empty arrays if insufficient data
 */
function findSupportResistance(candles: WeexCandle[]): { supports: number[]; resistances: number[] } {
    const supports: number[] = [];
    const resistances: number[] = [];

    if (!Array.isArray(candles) || candles.length < 5) return { supports, resistances };

    // Look for local minima (supports) and maxima (resistances)
    for (let i = 2; i < candles.length - 2; i++) {
        const low = safeParseFloat(candles[i].low);
        const high = safeParseFloat(candles[i].high);

        // Skip if current candle has invalid data
        if (low === 0 || high === 0) continue;

        const prevLow1 = safeParseFloat(candles[i - 1].low);
        const prevLow2 = safeParseFloat(candles[i - 2].low);
        const nextLow1 = safeParseFloat(candles[i + 1].low);
        const nextLow2 = safeParseFloat(candles[i + 2].low);

        const prevHigh1 = safeParseFloat(candles[i - 1].high);
        const prevHigh2 = safeParseFloat(candles[i - 2].high);
        const nextHigh1 = safeParseFloat(candles[i + 1].high);
        const nextHigh2 = safeParseFloat(candles[i + 2].high);

        // Check if local minimum (support) - only if all values are valid
        if (prevLow1 > 0 && prevLow2 > 0 && nextLow1 > 0 && nextLow2 > 0) {
            const isSupport =
                low < prevLow1 &&
                low < prevLow2 &&
                low < nextLow1 &&
                low < nextLow2;
            if (isSupport) supports.push(low);
        }

        // Check if local maximum (resistance) - only if all values are valid
        if (prevHigh1 > 0 && prevHigh2 > 0 && nextHigh1 > 0 && nextHigh2 > 0) {
            const isResistance =
                high > prevHigh1 &&
                high > prevHigh2 &&
                high > nextHigh1 &&
                high > nextHigh2;
            if (isResistance) resistances.push(high);
        }
    }

    // Cluster nearby levels (within 0.5%)
    const clusterLevels = (levels: number[]): number[] => {
        if (levels.length === 0) return [];
        const sorted = [...levels].sort((a, b) => a - b);
        const clustered: number[] = [];
        let cluster: number[] = [sorted[0]];

        for (let i = 1; i < sorted.length; i++) {
            // Guard against division by zero
            if (sorted[i - 1] === 0) {
                clustered.push(calculateMean(cluster));
                cluster = [sorted[i]];
                continue;
            }
            const diff = (sorted[i] - sorted[i - 1]) / sorted[i - 1];
            if (Number.isFinite(diff) && diff < 0.005) {
                cluster.push(sorted[i]);
            } else {
                const mean = calculateMean(cluster);
                if (mean > 0) clustered.push(mean);
                cluster = [sorted[i]];
            }
        }
        const finalMean = calculateMean(cluster);
        if (finalMean > 0) clustered.push(finalMean);
        return clustered;
    };

    return {
        supports: clusterLevels(supports),
        resistances: clusterLevels(resistances),
    };
}

/**
 * Detect trend direction and strength
 * Returns neutral/sideways for insufficient or invalid data
 */
function analyzeTrend(prices: number[]): { direction: 'up' | 'down' | 'sideways'; strength: number; duration: number } {
    const defaultResult = { direction: 'sideways' as const, strength: 0, duration: 0 };

    if (!Array.isArray(prices) || prices.length < 10) {
        return defaultResult;
    }

    // Filter out invalid values
    const validPrices = prices.filter(p => Number.isFinite(p) && p > 0);
    if (validPrices.length < 10) {
        return defaultResult;
    }

    // Use linear regression to determine trend
    const n = validPrices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;

    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += validPrices[i];
        sumXY += i * validPrices[i];
        sumX2 += i * i;
    }

    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) return defaultResult;

    const slope = (n * sumXY - sumX * sumY) / denominator;
    if (!Number.isFinite(slope)) return defaultResult;

    const avgPrice = sumY / n;
    if (!Number.isFinite(avgPrice) || avgPrice === 0) return defaultResult;

    // Normalize slope as percentage of average price
    const normalizedSlope = (slope / avgPrice) * 100;
    if (!Number.isFinite(normalizedSlope)) return defaultResult;

    // Calculate R-squared for trend strength
    const yMean = sumY / n;
    let ssTotal = 0, ssResidual = 0;
    const intercept = (sumY - slope * sumX) / n;

    for (let i = 0; i < n; i++) {
        const predicted = intercept + slope * i;
        ssTotal += Math.pow(validPrices[i] - yMean, 2);
        ssResidual += Math.pow(validPrices[i] - predicted, 2);
    }

    const rSquared = ssTotal > 0 ? 1 - (ssResidual / ssTotal) : 0;
    const strength = Number.isFinite(rSquared) ? Math.min(100, Math.max(0, rSquared * 100)) : 0;

    // Count consecutive candles in trend direction
    let duration = 0;
    const direction = normalizedSlope > 0.1 ? 'up' : normalizedSlope < -0.1 ? 'down' : 'sideways';

    for (let i = validPrices.length - 2; i >= 0; i--) {
        if (direction === 'up' && validPrices[i] < validPrices[i + 1]) duration++;
        else if (direction === 'down' && validPrices[i] > validPrices[i + 1]) duration++;
        else break;
    }

    return { direction, strength, duration };
}

/**
 * Analyze volume profile
 * Returns neutral defaults for insufficient or invalid data
 */
function analyzeVolume(candles: WeexCandle[]): { profile: 'accumulation' | 'distribution' | 'neutral'; anomaly: boolean; relative: number } {
    const defaultResult = { profile: 'neutral' as const, anomaly: false, relative: 1 };

    if (!Array.isArray(candles) || candles.length < 20) {
        return defaultResult;
    }

    const volumes = candles.map(c => safeParseFloat(c.volume)).filter(v => v > 0);
    if (volumes.length < 20) {
        return defaultResult;
    }

    const avgVolume = calculateMean(volumes.slice(0, -5)); // Exclude last 5 for comparison
    const recentVolume = calculateMean(volumes.slice(-5));

    // Guard against division by zero
    const relative = avgVolume > 0 ? recentVolume / avgVolume : 1;
    const safeRelative = Number.isFinite(relative) ? relative : 1;

    // Check for volume anomaly (>2x average)
    const anomaly = safeRelative > 2;

    // Determine accumulation vs distribution
    // Accumulation: price up on high volume, price down on low volume
    // Distribution: price down on high volume, price up on low volume
    let accumulationScore = 0;

    const startIdx = Math.max(0, candles.length - 10);
    for (let i = startIdx; i < candles.length; i++) {
        const closePrice = safeParseFloat(candles[i].close);
        const openPrice = safeParseFloat(candles[i].open);
        const vol = safeParseFloat(candles[i].volume);

        // Skip invalid candles
        if (closePrice === 0 || openPrice === 0 || vol === 0) continue;

        const priceChange = closePrice - openPrice;

        if (priceChange > 0 && vol > avgVolume) accumulationScore++;
        if (priceChange < 0 && vol < avgVolume) accumulationScore++;
        if (priceChange < 0 && vol > avgVolume) accumulationScore--;
        if (priceChange > 0 && vol < avgVolume) accumulationScore--;
    }

    const profile = accumulationScore > 2 ? 'accumulation' : accumulationScore < -2 ? 'distribution' : 'neutral';

    return { profile, anomaly, relative: safeRelative };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PATTERN DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Detect chart patterns
 * Returns empty array for insufficient or invalid data
 */
function detectPatterns(candles: WeexCandle[], currentPrice: number): string[] {
    const patterns: string[] = [];
    if (!Array.isArray(candles) || candles.length < 20) return patterns;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return patterns;

    const closes = candles.map(c => safeParseFloat(c.close)).filter(v => v > 0);
    const highs = candles.map(c => safeParseFloat(c.high)).filter(v => v > 0);
    const lows = candles.map(c => safeParseFloat(c.low)).filter(v => v > 0);

    // Need sufficient valid data
    if (closes.length < 20 || highs.length < 20 || lows.length < 20) return patterns;

    // Double bottom detection
    const recentLows = lows.slice(-30);
    if (recentLows.length >= 5) {
        const minLow = Math.min(...recentLows);
        if (Number.isFinite(minLow) && minLow > 0) {
            const lowIndices = recentLows.map((l, i) => ({ l, i })).filter(x => x.l < minLow * 1.01);
            if (lowIndices.length >= 2) {
                const gap = lowIndices[lowIndices.length - 1].i - lowIndices[0].i;
                if (gap > 5 && gap < 25) {
                    patterns.push('double_bottom');
                }
            }
        }
    }

    // Double top detection
    const recentHighs = highs.slice(-30);
    if (recentHighs.length >= 5) {
        const maxHigh = Math.max(...recentHighs);
        if (Number.isFinite(maxHigh) && maxHigh > 0) {
            const highIndices = recentHighs.map((h, i) => ({ h, i })).filter(x => x.h > maxHigh * 0.99);
            if (highIndices.length >= 2) {
                const gap = highIndices[highIndices.length - 1].i - highIndices[0].i;
                if (gap > 5 && gap < 25) {
                    patterns.push('double_top');
                }
            }
        }
    }

    // Breakout detection
    const { supports, resistances } = findSupportResistance(candles.slice(-50));
    const nearestResistance = resistances.filter(r => r > currentPrice).sort((a, b) => a - b)[0];
    const nearestSupport = supports.filter(s => s < currentPrice).sort((a, b) => b - a)[0];

    if (nearestResistance && Number.isFinite(nearestResistance) && currentPrice > nearestResistance * 0.995) {
        patterns.push('resistance_test');
    }
    if (nearestSupport && Number.isFinite(nearestSupport) && currentPrice < nearestSupport * 1.005) {
        patterns.push('support_test');
    }

    // Consolidation/squeeze detection
    const recentHighsSlice = highs.slice(-10);
    const recentLowsSlice = lows.slice(-10);
    const olderHighsSlice = highs.slice(-30, -10);
    const olderLowsSlice = lows.slice(-30, -10);

    if (recentHighsSlice.length >= 5 && recentLowsSlice.length >= 5 &&
        olderHighsSlice.length >= 5 && olderLowsSlice.length >= 5) {
        const recentRange = Math.max(...recentHighsSlice) - Math.min(...recentLowsSlice);
        const olderRange = Math.max(...olderHighsSlice) - Math.min(...olderLowsSlice);
        if (Number.isFinite(recentRange) && Number.isFinite(olderRange) && olderRange > 0 && recentRange / olderRange < 0.5) {
            patterns.push('consolidation');
        }
    }

    // Momentum divergence (price up, momentum down or vice versa)
    if (closes.length >= 20) {
        const recentClose = closes[closes.length - 1];
        const olderClose = closes[closes.length - 10];
        if (Number.isFinite(recentClose) && Number.isFinite(olderClose) && olderClose > 0) {
            const priceChange = (recentClose - olderClose) / olderClose;

            // Calculate volume change safely
            const recentVolumeSum = candles.slice(-10).reduce((sum, c) => sum + safeParseFloat(c.volume), 0);
            const olderVolumeSum = candles.slice(-20, -10).reduce((sum, c) => sum + safeParseFloat(c.volume), 0);
            const volumeChange = olderVolumeSum > 0 ? recentVolumeSum / olderVolumeSum : 1;

            if (Number.isFinite(priceChange) && Number.isFinite(volumeChange)) {
                if (priceChange > 0.02 && volumeChange < 0.8) {
                    patterns.push('bearish_divergence');
                }
                if (priceChange < -0.02 && volumeChange < 0.8) {
                    patterns.push('bullish_divergence');
                }
            }
        }
    }

    return patterns;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROBABILITY CALCULATIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate historical win rates based on similar conditions
 * Returns 50/50 for insufficient data
 */
function calculateWinRates(
    candles: WeexCandle[],
    zScore: number,
    _trendDirection: 'up' | 'down' | 'sideways' // Reserved for future trend-filtered win rates
): { longWinRate: number; shortWinRate: number } {
    const defaultResult = { longWinRate: 50, shortWinRate: 50 };

    if (!Array.isArray(candles) || candles.length < 50) {
        return defaultResult;
    }
    if (!Number.isFinite(zScore)) {
        return defaultResult;
    }

    // Simulate historical trades at similar z-score conditions
    let longWins = 0, longTotal = 0;
    let shortWins = 0, shortTotal = 0;

    const closes = candles.map(c => safeParseFloat(c.close)).filter(v => v > 0);
    if (closes.length < 50) return defaultResult;

    const lookback = 20;

    for (let i = lookback; i < closes.length - 10; i++) {
        const historicalMean = calculateMean(closes.slice(i - lookback, i));
        const historicalStdDev = calculateStdDev(closes.slice(i - lookback, i));

        // Skip if we can't calculate valid z-score
        if (historicalStdDev === 0) continue;

        const historicalZScore = calculateZScore(closes[i], historicalMean, historicalStdDev);
        if (!Number.isFinite(historicalZScore)) continue;

        // Only consider similar z-score conditions (within 0.5)
        if (Math.abs(historicalZScore - zScore) > 0.5) continue;

        // Check outcome after 5 candles
        const futurePrice = closes[i + 5];
        const entryPrice = closes[i];

        // Skip if prices are invalid
        if (!Number.isFinite(futurePrice) || !Number.isFinite(entryPrice) || entryPrice === 0) continue;

        // Long trade outcome
        longTotal++;
        if (futurePrice > entryPrice * 1.005) longWins++; // 0.5% profit target

        // Short trade outcome
        shortTotal++;
        if (futurePrice < entryPrice * 0.995) shortWins++;
    }

    return {
        longWinRate: longTotal > 0 ? Math.min(100, Math.max(0, (longWins / longTotal) * 100)) : 50,
        shortWinRate: shortTotal > 0 ? Math.min(100, Math.max(0, (shortWins / shortTotal) * 100)) : 50,
    };
}

/**
 * Calculate optimal stop loss and take profit based on ATR
 * Returns safe defaults for insufficient data
 */
function calculateOptimalLevels(candles: WeexCandle[]): { stopPercent: number; targetPercent: number; rr: number } {
    const defaultResult = { stopPercent: 2, targetPercent: 4, rr: 2 };

    if (!Array.isArray(candles) || candles.length < 14) {
        return defaultResult;
    }

    // Calculate ATR
    let atrSum = 0;
    let validCount = 0;

    const startIdx = Math.max(1, candles.length - 14);
    for (let i = startIdx; i < candles.length; i++) {
        const high = safeParseFloat(candles[i].high);
        const low = safeParseFloat(candles[i].low);
        const prevClose = safeParseFloat(candles[i - 1].close);

        // Skip invalid candles
        if (high === 0 || low === 0 || prevClose === 0) continue;

        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );

        if (Number.isFinite(tr)) {
            atrSum += tr;
            validCount++;
        }
    }
    if (validCount === 0) return defaultResult;

    const atr = atrSum / validCount;
    const currentPrice = safeParseFloat(candles[candles.length - 1].close);

    if (!Number.isFinite(atr) || currentPrice === 0) return defaultResult;

    const atrPercent = (atr / currentPrice) * 100;
    if (!Number.isFinite(atrPercent)) return defaultResult;

    // Stop at 1.5x ATR, target at 3x ATR (2:1 R:R)
    const stopPercent = Math.max(0.5, Math.min(5, atrPercent * 1.5));
    const targetPercent = stopPercent * 2;

    return {
        stopPercent: Number.isFinite(stopPercent) ? stopPercent : 2,
        targetPercent: Number.isFinite(targetPercent) ? targetPercent : 4,
        rr: 2,
    };
}

/**
 * Score entry quality based on multiple factors
 * Returns safe defaults for invalid inputs
 */
function scoreEntryQuality(
    zScore: number,
    trendStrength: number,
    volumeProfile: 'accumulation' | 'distribution' | 'neutral',
    patterns: string[]
): { quality: 'excellent' | 'good' | 'fair' | 'poor'; score: number } {
    let score = 50; // Base score

    // Z-score contribution (mean reversion opportunity)
    const safeZScore = Number.isFinite(zScore) ? zScore : 0;
    if (Math.abs(safeZScore) > 2) score += 15;
    else if (Math.abs(safeZScore) > 1.5) score += 10;
    else if (Math.abs(safeZScore) > 1) score += 5;

    // Trend alignment
    const safeTrendStrength = Number.isFinite(trendStrength) ? Math.max(0, Math.min(100, trendStrength)) : 0;
    score += (safeTrendStrength / 100) * 15;

    // Volume profile
    if (volumeProfile === 'accumulation') score += 10;
    else if (volumeProfile === 'distribution') score -= 5;

    // Pattern bonuses (with array safety check)
    const safePatterns = Array.isArray(patterns) ? patterns : [];
    if (safePatterns.includes('double_bottom') || safePatterns.includes('double_top')) score += 10;
    if (safePatterns.includes('consolidation')) score += 5;
    if (safePatterns.includes('bullish_divergence') || safePatterns.includes('bearish_divergence')) score += 8;

    // Pattern penalties
    if (safePatterns.includes('resistance_test') || safePatterns.includes('support_test')) score -= 5;

    score = Math.max(0, Math.min(100, score));

    // Ensure score is valid
    if (!Number.isFinite(score)) score = 50;

    const quality = score >= 75 ? 'excellent' : score >= 60 ? 'good' : score >= 40 ? 'fair' : 'poor';

    return { quality, score };
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalize symbol to standard format for caching
 * Handles: cmt_btcusdt, BTC/USDT, BTCUSDT, btc, etc.
 */
function normalizeSymbolForCache(symbol: string): string {
    if (!symbol || typeof symbol !== 'string') return '';
    return symbol.toLowerCase().trim();
}

const MAX_CANDLE_AGE_MS = 2 * 60 * 60 * 1000;

function isCandleDataFresh(candles: WeexCandle[], maxAgeMs: number): boolean {
    if (!Array.isArray(candles) || candles.length === 0) return false;
    const last = candles[candles.length - 1];
    const ts = Number(last?.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) {
        logger.warn('Candle timestamp invalid, skipping freshness check');
        return true;
    }
    return Date.now() - ts <= maxAgeMs;
}

/**
 * Internal function to analyze a single asset and return both analysis and closes
 * Used by getQuantContext to avoid duplicate candle fetches
 * 
 * NOTE: This function does NOT check cache - caller (getQuantContext) handles cache
 * to properly manage closes for cross-asset correlation
 */
async function analyzeAssetInternal(symbol: string): Promise<AnalyzeAssetResult | null> {
    // Input validation
    if (!symbol || typeof symbol !== 'string') {
        logger.warn('analyzeAsset called with invalid symbol');
        return null;
    }

    const normalizedSymbol = normalizeSymbolForCache(symbol);
    if (!normalizedSymbol) {
        logger.warn(`analyzeAsset: invalid symbol after normalization: ${symbol}`);
        return null;
    }

    const cacheKey = `quant:${normalizedSymbol}`;

    try {
        const weexClient = getWeexClient();

        // Fetch 1-hour candles for analysis (200 candles = ~8 days)
        const candles = await weexClient.getCandles(symbol, '1h', 200);

        if (!Array.isArray(candles) || candles.length < 50) {
            logger.warn(`Insufficient candle data for ${symbol}: ${candles?.length ?? 0} candles`);
            return null;
        }
        if (!isCandleDataFresh(candles, MAX_CANDLE_AGE_MS)) {
            logger.warn(`Stale candle data for ${symbol}, skipping analysis`);
            return null;
        }

        // CRITICAL: Filter candles ONCE where ALL OHLCV fields are valid to prevent array desync
        // This ensures closes[i], highs[i], lows[i], volumes[i] all refer to the same candle
        const validCandles = candles.filter(c => {
            const close = safeParseFloat(c.close);
            const high = safeParseFloat(c.high);
            const low = safeParseFloat(c.low);
            const volume = safeParseFloat(c.volume);
            return close > 0 && high > 0 && low > 0 && volume > 0;
        });

        if (validCandles.length < 50) {
            logger.warn(`Insufficient valid candle data for ${symbol}: ${validCandles.length} valid candles (need 50)`);
            return null;
        }

        // Now map from pre-filtered valid candles - arrays are guaranteed to be aligned
        const closes = validCandles.map(c => safeParseFloat(c.close));
        const highs = validCandles.map(c => safeParseFloat(c.high));
        const lows = validCandles.map(c => safeParseFloat(c.low));
        const volumes = validCandles.map(c => safeParseFloat(c.volume));

        const currentPrice = closes[closes.length - 1];
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            logger.warn(`Invalid current price for ${symbol}: ${currentPrice}`);
            return null;
        }

        // Statistical analysis
        const mean = calculateMean(closes);
        const stdDev = calculateStdDev(closes, mean);
        const zScore = calculateZScore(currentPrice, mean, stdDev);
        const sortedCloses = [...closes].sort((a, b) => a - b);
        const percentile = calculatePercentile(currentPrice, sortedCloses);

        // Volatility
        const volatility24h = calculateVolatility(closes.slice(-24), 365 * 24);
        const historicalVols: number[] = [];
        for (let i = 24; i < closes.length; i++) {
            const vol = calculateVolatility(closes.slice(i - 24, i), 365 * 24);
            if (Number.isFinite(vol)) {
                historicalVols.push(vol);
            }
        }
        const volatilityRank = historicalVols.length > 0
            ? calculatePercentile(volatility24h, historicalVols.sort((a, b) => a - b))
            : 50;
        const recentVol = calculateVolatility(closes.slice(-12), 365 * 24);
        const olderVol = calculateVolatility(closes.slice(-24, -12), 365 * 24);
        const isVolatilityExpanding = olderVol > 0 && recentVol > olderVol * 1.2;

        // Mean reversion signal
        let meanReversionSignal: QuantSignal;
        if (zScore < -2) {
            meanReversionSignal = {
                direction: 'long',
                strength: Math.min(100, Math.abs(zScore) * 30),
                confidence: 70,
                reason: `Price ${safeToFixed(Math.abs(zScore), 1)} std devs below mean - oversold`,
            };
        } else if (zScore > 2) {
            meanReversionSignal = {
                direction: 'short',
                strength: Math.min(100, Math.abs(zScore) * 30),
                confidence: 70,
                reason: `Price ${safeToFixed(zScore, 1)} std devs above mean - overbought`,
            };
        } else {
            meanReversionSignal = {
                direction: 'neutral',
                strength: 0,
                confidence: 50,
                reason: 'Price within normal range',
            };
        }

        // Calculate distance from mean safely
        const distanceFromMean = mean !== 0 ? ((currentPrice - mean) / mean) * 100 : 0;

        const statistics: StatisticalMetrics = {
            mean,
            stdDev,
            zScore,
            percentile,
            volatility24h,
            volatilityRank,
            isVolatilityExpanding,
            meanReversionSignal,
            distanceFromMean: Number.isFinite(distanceFromMean) ? distanceFromMean : 0,
        };

        // Pattern analysis
        const { supports, resistances } = findSupportResistance(candles);

        // Find nearest support/resistance with safe defaults
        const validSupports = supports.filter(s => Number.isFinite(s) && s < currentPrice);
        const validResistances = resistances.filter(r => Number.isFinite(r) && r > currentPrice);

        const nearestSupport = validSupports.length > 0
            ? validSupports.sort((a, b) => b - a)[0]
            : currentPrice * 0.95;
        const nearestResistance = validResistances.length > 0
            ? validResistances.sort((a, b) => a - b)[0]
            : currentPrice * 1.05;

        // Count touches for strength (with safe filtering)
        const supportTouches = candles.filter(c => {
            const low = safeParseFloat(c.low);
            return low > 0 && nearestSupport > 0 && Math.abs(low - nearestSupport) / nearestSupport < 0.005;
        }).length;
        const resistanceTouches = candles.filter(c => {
            const high = safeParseFloat(c.high);
            return high > 0 && nearestResistance > 0 && Math.abs(high - nearestResistance) / nearestResistance < 0.005;
        }).length;

        const trend = analyzeTrend(closes);
        const volume = analyzeVolume(candles);
        const patterns = detectPatterns(candles, currentPrice);

        const strategies: StrategySignals = {
            ann: computeAnnSignal(symbol, closes),
            naive_bayes: await computeNaiveBayesSignal(symbol, trend.direction),
            knn: computeKnnSignal(closes),
            ibs: computeIbsSignal(candles),
            stat_arb: createNeutralStrategySignal('stat_arb', 'pending cross-asset data'),
            alpha_combo: computeAlphaComboSignal(closes, volumes),
            ma_crossover: computeMaCrossoverSignal(closes),
            donchian: computeDonchianSignal(candles),
            pivot_points: computePivotSignal(candles, trend.direction),
            multi_asset_trend: createNeutralStrategySignal('multi_asset_trend', 'pending cross-asset data'),
        };

        const patternAnalysis: PatternAnalysis = {
            nearestSupport,
            nearestResistance,
            supportStrength: Math.min(100, supportTouches * 25),
            resistanceStrength: Math.min(100, resistanceTouches * 25),
            trendDirection: trend.direction,
            trendStrength: trend.strength,
            trendDuration: trend.duration,
            volumeProfile: volume.profile,
            volumeAnomaly: volume.anomaly,
            relativeVolume: volume.relative,
            patterns,
        };

        // Probability metrics
        const winRates = calculateWinRates(candles, zScore, trend.direction);
        const optimalLevels = calculateOptimalLevels(candles);
        const entryQuality = scoreEntryQuality(zScore, trend.strength, volume.profile, patterns);

        const probability: ProbabilityMetrics = {
            longWinRate: winRates.longWinRate,
            shortWinRate: winRates.shortWinRate,
            expectedRR: optimalLevels.rr,
            optimalStopPercent: optimalLevels.stopPercent,
            optimalTargetPercent: optimalLevels.targetPercent,
            entryQuality: entryQuality.quality,
            entryScore: entryQuality.score,
        };

        // Generate primary signal
        let primarySignal: QuantSignal;
        const secondarySignals: QuantSignal[] = [];

        // Combine signals for primary recommendation
        if (zScore < -1.5 && trend.direction !== 'down' && volume.profile !== 'distribution') {
            const strength = Math.min(100, (Math.abs(zScore) * 20) + (winRates.longWinRate - 50));
            primarySignal = {
                direction: 'long',
                strength: Number.isFinite(strength) ? strength : 50,
                confidence: Math.min(90, 50 + entryQuality.score / 2),
                reason: `Oversold (z=${safeToFixed(zScore, 1)}) with ${volume.profile} volume`,
            };
        } else if (zScore > 1.5 && trend.direction !== 'up' && volume.profile !== 'accumulation') {
            const strength = Math.min(100, (Math.abs(zScore) * 20) + (winRates.shortWinRate - 50));
            primarySignal = {
                direction: 'short',
                strength: Number.isFinite(strength) ? strength : 50,
                confidence: Math.min(90, 50 + entryQuality.score / 2),
                reason: `Overbought (z=${safeToFixed(zScore, 1)}) with ${volume.profile} volume`,
            };
        } else if (trend.strength > 60) {
            primarySignal = {
                direction: trend.direction === 'up' ? 'long' : trend.direction === 'down' ? 'short' : 'neutral',
                strength: trend.strength,
                confidence: Math.min(80, 40 + trend.strength / 2),
                reason: `Strong ${trend.direction} trend (strength: ${safeToFixed(trend.strength, 0)})`,
            };
        } else {
            primarySignal = {
                direction: 'neutral',
                strength: 0,
                confidence: 60,
                reason: 'No clear edge - wait for better setup',
            };
        }

        // Add secondary signals
        if (patterns.includes('double_bottom')) {
            secondarySignals.push({
                direction: 'long',
                strength: 70,
                confidence: 65,
                reason: 'Double bottom pattern detected',
            });
        }
        if (patterns.includes('double_top')) {
            secondarySignals.push({
                direction: 'short',
                strength: 70,
                confidence: 65,
                reason: 'Double top pattern detected',
            });
        }
        if (volume.anomaly) {
            secondarySignals.push({
                direction: volume.profile === 'accumulation' ? 'long' : volume.profile === 'distribution' ? 'short' : 'neutral',
                strength: 60,
                confidence: 55,
                reason: `Volume anomaly (${safeToFixed(volume.relative, 1)}x average) - ${volume.profile}`,
            });
        }

        // Risk assessment
        let riskScore = 50;
        if (isVolatilityExpanding) riskScore += 15;
        if (volatilityRank > 80) riskScore += 20;
        if (Math.abs(zScore) > 2.5) riskScore += 10;
        if (patterns.includes('resistance_test') || patterns.includes('support_test')) riskScore += 10;
        riskScore = Math.min(100, riskScore);

        const riskLevel = riskScore >= 80 ? 'extreme' : riskScore >= 60 ? 'high' : riskScore >= 40 ? 'medium' : 'low';

        const analysis: AssetQuantAnalysis = {
            symbol,
            timestamp: Date.now(),
            currentPrice,
            statistics,
            patterns: patternAnalysis,
            probability,
            primarySignal,
            secondarySignals,
            riskLevel,
            riskScore,
            strategies,
        };

        setCache(cacheKey, analysis);

        // Return both analysis and candle data (use last 100 for cross-asset correlation and regime detection)
        return {
            analysis,
            closes: closes.slice(-100),
            highs: highs.slice(-100),
            lows: lows.slice(-100),
            volumes: volumes.slice(-100),
        };

    } catch (error) {
        logger.error(`Failed to analyze ${symbol}:`, error);
        return null;
    }
}

/**
 * Analyze a single asset (public API - backward compatible)
 * Returns null for invalid symbols or insufficient data
 */
async function analyzeAsset(symbol: string): Promise<AssetQuantAnalysis | null> {
    // Check cache first
    const normalizedSymbol = normalizeSymbolForCache(symbol);
    if (normalizedSymbol) {
        const cacheKey = `quant:${normalizedSymbol}`;
        const cached = getCached<AssetQuantAnalysis>(cacheKey);
        if (cached) return cached;
    }

    const result = await analyzeAssetInternal(symbol);
    return result?.analysis ?? null;
}

/**
 * Analyze cross-asset relationships
 * Returns safe defaults for insufficient data
 */
async function analyzeCrossAsset(
    assets: Map<string, AssetQuantAnalysis>,
    allCandles: Map<string, number[]>
): Promise<CrossAssetAnalysis> {
    // Calculate correlation matrix
    const correlationMatrix = new Map<string, Map<string, number>>();
    const symbols = Array.from(allCandles.keys());

    for (const sym1 of symbols) {
        const row = new Map<string, number>();
        for (const sym2 of symbols) {
            if (sym1 === sym2) {
                row.set(sym2, 1);
            } else {
                const corr = calculateCorrelation(
                    allCandles.get(sym1) || [],
                    allCandles.get(sym2) || []
                );
                row.set(sym2, corr);
            }
        }
        correlationMatrix.set(sym1, row);
    }

    // Calculate BTC dominance (how much BTC moves affect others)
    // Try multiple possible BTC symbol formats using normalized comparison
    let btcPrices: number[] = [];
    for (const [sym, prices] of allCandles.entries()) {
        const normalizedSym = sym.toLowerCase().replace(/^cmt_/, '').replace(/usdt$/, '');
        if (normalizedSym === 'btc' && prices.length > 0) {
            btcPrices = prices;
            break;
        }
    }

    let btcInfluence = 0;
    let count = 0;

    for (const [sym, prices] of allCandles.entries()) {
        const normalizedSym = sym.toLowerCase().replace(/^cmt_/, '').replace(/usdt$/, '');
        if (normalizedSym !== 'btc' && prices.length > 0 && btcPrices.length > 0) {
            const corr = Math.abs(calculateCorrelation(btcPrices, prices));
            if (Number.isFinite(corr)) {
                btcInfluence += corr;
                count++;
            }
        }
    }

    const btcDominance = count > 0 ? (btcInfluence / count) * 100 : 50;
    const safeBtcDominance = Number.isFinite(btcDominance) ? btcDominance : 50;

    // Determine market regime
    let bullishCount = 0;
    let bearishCount = 0;

    for (const [_, analysis] of assets) {
        if (analysis.primarySignal.direction === 'long') bullishCount++;
        if (analysis.primarySignal.direction === 'short') bearishCount++;
    }

    const marketRegime = bullishCount > bearishCount * 1.5 ? 'risk_on'
        : bearishCount > bullishCount * 1.5 ? 'risk_off'
            : 'neutral';

    // Find sector rotation (which assets are leading)
    let leadingAsset = '';
    let maxStrength = 0;

    for (const [sym, analysis] of assets) {
        if (analysis.primarySignal.strength > maxStrength && analysis.primarySignal.direction !== 'neutral') {
            maxStrength = analysis.primarySignal.strength;
            // Normalize symbol for display (case-insensitive)
            leadingAsset = sym.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
        }
    }

    return {
        btcDominance: safeBtcDominance,
        correlationMatrix,
        marketRegime,
        sectorRotation: leadingAsset || 'None',
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Get full quant analysis for all trading symbols
 * This is the main function to call before AI analysts make decisions
 * 
 * FIXED: Prevents race condition where multiple concurrent calls
 * could trigger parallel API requests before cache is populated.
 * OPTIMIZED: Uses analyzeAssetInternal to get both analysis and closes in one fetch,
 * avoiding duplicate candle API calls.
 * FIXED: Uses symbol-set-specific cache keys to prevent cross-call leakage.
 */

export async function getQuantContext(symbols: string[]): Promise<QuantContext> {
    // Validate input
    if (!Array.isArray(symbols) || symbols.length === 0) {
        logger.warn('getQuantContext called with empty or invalid symbols array');
        return createEmptyQuantContext();
    }

    // Create normalized cache key from sorted symbols
    const normalizedKey = [...symbols].sort().join(',').toLowerCase();
    const cacheKey = `quant_context:${normalizedKey}`;

    const cached = getCached<QuantContext>(cacheKey);
    if (cached) return cached;

    // If a fetch is already in progress for this symbol set, wait for it instead of starting another
    const existingPromise = quantContextFetchPromisesByKey.get(normalizedKey);
    if (existingPromise) {
        return existingPromise;
    }

    // Start the fetch and store the promise
    // FIXED: Clear promise inside async function to ensure concurrent waiters complete first
    const fetchPromise = (async () => {
        try {
            logger.info('Running quant analysis on all assets...');

            const assets = new Map<string, AssetQuantAnalysis>();
            const allCandles = new Map<string, number[]>();

            // Analyze all assets in parallel - uses analyzeAssetInternal to get both
            // analysis and candle data in a single fetch (avoids duplicate API calls)
            const analyses = await Promise.all(
                symbols.map(async (symbol) => {
                    if (!symbol || typeof symbol !== 'string') {
                        return { symbol: '', result: null };
                    }

                    // First check cache
                    const normalizedSymbol = normalizeSymbolForCache(symbol);
                    if (normalizedSymbol) {
                        const symbolCacheKey = `quant:${normalizedSymbol}`;
                        const cachedAnalysis = getCached<AssetQuantAnalysis>(symbolCacheKey);
                        if (cachedAnalysis) {
                            // Validate cache freshness - only use if timestamp is within 5 minutes
                            const cacheAge = Date.now() - cachedAnalysis.timestamp;
                            const maxCacheAge = 5 * 60 * 1000; // 5 minutes

                            if (cacheAge > maxCacheAge) {
                                // Cache is stale, skip and fetch fresh data
                                logger.debug(`Cache stale for ${symbol} (age: ${Math.round(cacheAge / 1000)}s), fetching fresh`);
                            } else {
                                // For cached results, we need to fetch candle data separately for cross-asset analysis and regime detection
                                // This is rare (only on cache hit) and acceptable
                                try {
                                    const weexClient = getWeexClient();
                                    const candles = await weexClient.getCandles(symbol, '1h', 100);
                                    if (Array.isArray(candles) && candles.length > 0) {
                                        if (!isCandleDataFresh(candles, MAX_CANDLE_AGE_MS)) {
                                            return {
                                                symbol,
                                                result: {
                                                    analysis: cachedAnalysis,
                                                    closes: null,
                                                    highs: null,
                                                    lows: null,
                                                    volumes: null,
                                                }
                                            };
                                        }
                                        // CRITICAL: Filter candles ONCE where ALL OHLCV fields are valid to prevent array desync
                                        // This ensures closes[i], highs[i], lows[i], volumes[i] all refer to the same candle
                                        const validCandles = candles.filter(c => {
                                            const close = safeParseFloat(c.close);
                                            const high = safeParseFloat(c.high);
                                            const low = safeParseFloat(c.low);
                                            const volume = safeParseFloat(c.volume);
                                            return close > 0 && high > 0 && low > 0 && volume > 0;
                                        });
                                        if (validCandles.length > 0) {
                                            // Now map from pre-filtered valid candles - arrays are guaranteed to be aligned
                                            return {
                                                symbol,
                                                result: {
                                                    analysis: cachedAnalysis,
                                                    closes: validCandles.map(c => safeParseFloat(c.close)),
                                                    highs: validCandles.map(c => safeParseFloat(c.high)),
                                                    lows: validCandles.map(c => safeParseFloat(c.low)),
                                                    volumes: validCandles.map(c => safeParseFloat(c.volume)),
                                                }
                                            };
                                        }
                                    }
                                } catch (candleError) {
                                    // Log the error with context instead of silently swallowing
                                    logger.error(`Failed to fetch candles for cached analysis ${symbol}:`, candleError);
                                    // FIXED: Return cached analysis even if candle refetch fails
                                    // This prevents the asset from being dropped entirely
                                    return {
                                        symbol,
                                        result: {
                                            analysis: cachedAnalysis,
                                            closes: null,
                                            highs: null,
                                            lows: null,
                                            volumes: null,
                                        }
                                    };
                                }
                                // Return cached analysis with null candle data if candles were empty
                                return {
                                    symbol,
                                    result: {
                                        analysis: cachedAnalysis,
                                        closes: null,
                                        highs: null,
                                        lows: null,
                                        volumes: null,
                                    }
                                };
                            }
                        }
                    }

                    // Not cached - use internal function that returns both analysis and candle data
                    const result = await analyzeAssetInternal(symbol);
                    return { symbol, result };
                })
            );

            // Store candle data for regime detection (avoid duplicate fetches)
            const candleDataMap = new Map<string, { closes: number[]; highs: number[]; lows: number[]; volumes: number[] }>();

            for (const { symbol, result } of analyses) {
                // Skip entries with null result or null analysis
                if (!result || !result.analysis || !symbol) {
                    if (symbol) {
                        logger.debug(`Skipping ${symbol} in cross-asset analysis: analysis unavailable`);
                    }
                    continue;
                }

                assets.set(symbol, result.analysis);
                // Use closes from the same fetch for cross-asset correlation
                // Only include if we have valid candle data (closes exists and has length > 0)
                if (result.closes && result.closes.length > 0) {
                    allCandles.set(symbol, result.closes);
                    // Store full candle data for regime detection
                    candleDataMap.set(symbol, {
                        closes: result.closes,
                        highs: result.highs || [],
                        lows: result.lows || [],
                        volumes: result.volumes || [],
                    });
                }
            }

            // Cross-asset analysis
            const crossAsset = await analyzeCrossAsset(assets, allCandles);

            const momentumEntries = Array.from(allCandles.entries()).map(([symbol, closes]) => ({
                symbol,
                momentum: calculateMomentum(closes, 20),
            })).sort((a, b) => b.momentum - a.momentum);

            const momentumRankMap = new Map<string, { rank: number; total: number; momentum: number }>();
            for (let i = 0; i < momentumEntries.length; i++) {
                const entry = momentumEntries[i];
                momentumRankMap.set(entry.symbol, { rank: i, total: momentumEntries.length, momentum: entry.momentum });
            }

            let btcReturns: number[] = [];
            for (const [sym, closes] of allCandles.entries()) {
                const normalized = sym.toLowerCase().replace(/^cmt_/, '').replace(/usdt$/, '');
                if (normalized === 'btc') {
                    btcReturns = calculateReturns(closes);
                    break;
                }
            }

            for (const [symbol, analysis] of assets) {
                const momentumInfo = momentumRankMap.get(symbol);
                const multiAssetTrend = momentumInfo
                    ? computeMultiAssetTrendSignal(momentumInfo.rank, momentumInfo.total, momentumInfo.momentum)
                    : createNeutralStrategySignal('multi_asset_trend', 'insufficient cross-asset data');

                let statArb = createNeutralStrategySignal('stat_arb', 'insufficient cross-asset data');
                const closes = allCandles.get(symbol);
                const normalizedSymbol = symbol.toLowerCase().replace(/^cmt_/, '').replace(/usdt$/, '');
                if (normalizedSymbol === 'btc') {
                    statArb = createNeutralStrategySignal('stat_arb', 'btc baseline');
                } else if (btcReturns.length > 0 && closes && closes.length > 10) {
                    const targetReturns = calculateReturns(closes);
                    const residuals = calculateRegressionResiduals(targetReturns, btcReturns);
                    statArb = residuals.length > 0
                        ? computeStatArbSignalFromResidual(residuals)
                        : createNeutralStrategySignal('stat_arb', 'insufficient residual history');
                }

                const baseStrategies: StrategySignals = analysis.strategies ?? {
                    ann: createNeutralStrategySignal('ann', 'missing'),
                    naive_bayes: createNeutralStrategySignal('naive_bayes', 'missing'),
                    knn: createNeutralStrategySignal('knn', 'missing'),
                    ibs: createNeutralStrategySignal('ibs', 'missing'),
                    stat_arb: createNeutralStrategySignal('stat_arb', 'missing'),
                    alpha_combo: createNeutralStrategySignal('alpha_combo', 'missing'),
                    ma_crossover: createNeutralStrategySignal('ma_crossover', 'missing'),
                    donchian: createNeutralStrategySignal('donchian', 'missing'),
                    pivot_points: createNeutralStrategySignal('pivot_points', 'missing'),
                    multi_asset_trend: createNeutralStrategySignal('multi_asset_trend', 'missing'),
                };

                const updatedAnalysis: AssetQuantAnalysis = {
                    ...analysis,
                    strategies: {
                        ...baseStrategies,
                        stat_arb: statArb,
                        multi_asset_trend: multiAssetTrend,
                    },
                };

                assets.set(symbol, updatedAnalysis);
                if (normalizedSymbol) {
                    setCache(`quant:${normalizedSymbol}`, updatedAnalysis);
                }
            }

            // Funding rate analysis (v5.1.0) - fetch funding rates for all symbols
            const fundingAnalysis = new Map<string, FundingRateAnalysis>();
            try {
                const weexClient = getWeexClient();
                const fundingPromises = symbols.map(async (symbol) => {
                    try {
                        const fundingData = await weexClient.getFundingRate(symbol);
                        const rawRate = fundingData.fundingRate;

                        // Normalize funding rate to decimal format (e.g., 0.0001 for 0.01%)
                        // WEEX returns funding rate as a decimal string (e.g., "0.0001" for 0.01%)
                        let rate: number;

                        if (typeof rawRate === 'string') {
                            // Handle percent suffix (e.g., "0.01%")
                            if (rawRate.endsWith('%')) {
                                rate = parseFloat(rawRate.slice(0, -1)) / 100;
                            } else {
                                rate = parseFloat(rawRate);
                            }
                        } else if (typeof rawRate === 'number') {
                            rate = rawRate;
                        } else {
                            rate = 0;
                        }

                        // Validate the parsed rate
                        if (!Number.isFinite(rate)) {
                            logger.warn(`Invalid funding rate format for ${symbol}: ${JSON.stringify(rawRate)}`);
                            return null;
                        }

                        // Sanity check: funding rates are typically between -1% and +1% per interval
                        // In decimal form, this means -0.01 to +0.01
                        // If |rate| > 0.1 (10%), it's likely in percentage form (e.g., 0.5 meaning 0.5%)
                        // If |rate| > 1, it's definitely in percentage form, convert to decimal
                        if (Math.abs(rate) > 0.1) {
                            logger.warn(`Unexpected funding rate magnitude for ${symbol}: ${rate}, assuming percentage format`);
                            rate = rate / 100;
                        }

                        return { symbol, rate };
                    } catch (error) {
                        // Log the error with symbol context instead of silently swallowing
                        logger.warn(`Failed to fetch funding rate for ${symbol}:`, error);
                        return null;
                    }
                });

                const fundingResults = await Promise.all(fundingPromises);
                for (const result of fundingResults) {
                    if (result) {
                        const analysis = analyzeFundingRate(result.symbol, result.rate);
                        fundingAnalysis.set(result.symbol, analysis);
                    }
                }
            } catch (error) {
                logger.warn('Failed to fetch funding rates for quant context:', error);
            }

            // Regime detection (v5.1.0 Phase 2) - detect market regime for each symbol
            // OPTIMIZED: Uses cached candle data from asset analysis to avoid duplicate API calls
            const regimeAnalysis = new Map<string, MarketRegime>();
            try {
                for (const [symbol] of assets) {
                    try {
                        // Use cached candle data from asset analysis (avoids duplicate fetch)
                        const candleData = candleDataMap.get(symbol);
                        if (!candleData || candleData.closes.length < 20) {
                            logger.debug(`Skipping regime detection for ${symbol}: insufficient cached candle data`);
                            continue;
                        }

                        const { closes, highs, lows, volumes } = candleData;

                        // Validate we have enough data for all arrays
                        if (highs.length < 20 || lows.length < 20) {
                            logger.debug(`Skipping regime detection for ${symbol}: insufficient highs/lows data`);
                            continue;
                        }

                        const currentPrice = closes[closes.length - 1];

                        // Calculate EMAs
                        const ema9 = calculateEMA(closes, 9);
                        const ema20 = calculateEMA(closes, 20);
                        const ema50 = closes.length >= 50 ? calculateEMA(closes, 50) : ema20;

                        // Calculate ATR
                        const atrValues = calculateATRHistory(highs, lows, closes, 14);
                        const atr14 = atrValues.length > 0 ? atrValues[atrValues.length - 1] : 0;

                        // Calculate ADX (simplified)
                        const { adx, plusDI, minusDI } = calculateADX(highs, lows, closes, 14);

                        // Calculate Bollinger Bands
                        const bb = calculateBollingerBands(closes, 20, 2);

                        // Calculate volume average
                        const avgVolume20 = volumes.length >= 20
                            ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20
                            : volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
                        const currentVolume = volumes.length > 0 ? (volumes[volumes.length - 1] || avgVolume20) : avgVolume20;

                        const regimeInput: RegimeInput = {
                            symbol,
                            currentPrice,
                            ema9,
                            ema20,
                            ema50,
                            atr14,
                            atrHistory: atrValues,
                            adx,
                            plusDI,
                            minusDI,
                            bbUpper: bb.upper,
                            bbMiddle: bb.middle,
                            bbLower: bb.lower,
                            bbWidth: bb.width,
                            currentVolume,
                            avgVolume20,
                            priceHistory: closes.slice(-50),
                        };

                        const regime = detectRegime(regimeInput);
                        regimeAnalysis.set(symbol, regime);
                    } catch (err) {
                        logger.debug(`Failed to detect regime for ${symbol}:`, err);
                    }
                }
            } catch (error) {
                logger.warn('Failed to run regime detection:', error);
            }

            // Generate market summary (now includes funding and regime)
            const marketSummary = generateMarketSummary(assets, crossAsset, fundingAnalysis, regimeAnalysis);

            const context: QuantContext = {
                timestamp: new Date().toISOString(),
                assets,
                crossAsset,
                fundingAnalysis,
                regimeAnalysis,
                marketSummary,
            };

            setCache(cacheKey, context);
            logger.info(`Quant analysis complete: ${assets.size} assets analyzed`);

            return context;
        } finally {
            // FIXED: Clear promise INSIDE the async function, after result is ready
            // This ensures concurrent waiters get the result before promise is cleared
            quantContextFetchPromisesByKey.delete(normalizedKey);
        }
    })();

    // Store the promise in the map
    quantContextFetchPromisesByKey.set(normalizedKey, fetchPromise);

    try {
        return await fetchPromise;
    } catch (error) {
        // Promise is already cleared in the inner finally block
        throw error;
    }
}

/**
 * Create an empty quant context for error cases
 */
function createEmptyQuantContext(): QuantContext {
    return {
        timestamp: new Date().toISOString(),
        assets: new Map(),
        crossAsset: {
            btcDominance: 50,
            correlationMatrix: new Map(),
            marketRegime: 'neutral',
            sectorRotation: 'None',
        },
        fundingAnalysis: new Map(),
        regimeAnalysis: new Map(),
        marketSummary: '=== QUANT ANALYSIS SUMMARY ===\n\nNo data available.',
    };
}

/**
 * Generate human-readable market summary for AI
 * Uses safe formatting to handle NaN/Infinity values
 */
function generateMarketSummary(
    assets: Map<string, AssetQuantAnalysis>,
    crossAsset: CrossAssetAnalysis,
    fundingAnalysis?: Map<string, FundingRateAnalysis>,
    regimeAnalysis?: Map<string, MarketRegime>
): string {
    // Validate inputs
    if (!(assets instanceof Map) || !crossAsset) {
        return '=== QUANT ANALYSIS SUMMARY ===\n\nNo data available.';
    }

    const lines: string[] = [
        '=== QUANT ANALYSIS SUMMARY ===',
        '',
        `Market Regime: ${(crossAsset.marketRegime || 'neutral').toUpperCase()}`,
        `BTC Dominance: ${safeToFixed(crossAsset.btcDominance, 0)}%`,
        `Leading Asset: ${crossAsset.sectorRotation || 'None'}`,
        '',
        '--- Asset Signals ---',
    ];

    for (const [symbol, analysis] of assets) {
        const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
        const signal = analysis.primarySignal;
        const stats = analysis.statistics;

        lines.push(
            `${sym}: ${signal.direction.toUpperCase()} (strength: ${safeToFixed(signal.strength, 0)}, conf: ${safeToFixed(signal.confidence, 0)}%)` +
            ` | z-score: ${safeToFixed(stats.zScore, 2)} | vol-rank: ${safeToFixed(stats.volatilityRank, 0)}%` +
            ` | entry: ${analysis.probability.entryQuality} | risk: ${analysis.riskLevel}`
        );

        if (Array.isArray(analysis.patterns.patterns) && analysis.patterns.patterns.length > 0) {
            lines.push(`  Patterns: ${analysis.patterns.patterns.join(', ')}`);
        }
        if (Array.isArray(analysis.secondarySignals) && analysis.secondarySignals.length > 0) {
            lines.push(`  Secondary: ${analysis.secondarySignals.map(s => s.reason).join('; ')}`);
        }
    }

    lines.push('');
    lines.push('--- Optimal Levels ---');

    for (const [symbol, analysis] of assets) {
        const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
        const prob = analysis.probability;
        const pat = analysis.patterns;

        lines.push(
            `${sym}: Support ${safeToFixed(pat.nearestSupport, 2)} | Resistance ${safeToFixed(pat.nearestResistance, 2)}` +
            ` | SL: ${safeToFixed(prob.optimalStopPercent, 1)}% | TP: ${safeToFixed(prob.optimalTargetPercent, 1)}%`
        );
    }

    lines.push('');
    lines.push('--- Win Rate Estimates ---');

    for (const [symbol, analysis] of assets) {
        const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
        const prob = analysis.probability;

        lines.push(
            `${sym}: Long ${safeToFixed(prob.longWinRate, 0)}% | Short ${safeToFixed(prob.shortWinRate, 0)}%`
        );
    }

    // Add funding rate analysis section (v5.1.0)
    if (fundingAnalysis && fundingAnalysis.size > 0) {
        lines.push('');
        lines.push('--- Funding Rate Analysis (v5.1.0) ---');

        for (const [symbol, funding] of fundingAnalysis) {
            const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
            const ratePercent = funding.currentRate * 100;
            const persistenceStr = funding.isPersistent ? ` [PERSISTENT ${funding.persistenceCount}p]` : '';

            lines.push(
                `${sym}: ${safeToFixed(ratePercent, 4)}% (${safeToFixed(funding.percentile, 0)}th pctl)` +
                ` | ${funding.extremeDirection}${persistenceStr}` +
                ` | Signal: ${funding.signal.direction.toUpperCase()} (str: ${safeToFixed(funding.signal.strength, 0)})`
            );

            if (funding.isPersistent && funding.signal.direction !== 'neutral') {
                lines.push(`  → Contrarian ${funding.signal.direction.toUpperCase()}: ${funding.signal.reason}`);
                lines.push(`  → Expected carry: ${safeToFixed(funding.signal.carryExpectedPct, 2)}% per cycle`);
            }
        }
    }

    // Add regime analysis section (v5.1.0 Phase 2)
    if (regimeAnalysis && regimeAnalysis.size > 0) {
        lines.push('');
        lines.push('--- Regime Analysis (v5.1.0 Phase 2) ---');

        for (const [symbol, regime] of regimeAnalysis) {
            const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();

            lines.push(
                `${sym}: ${regime.overallRegime.toUpperCase()} | Difficulty: ${regime.tradingDifficulty}` +
                ` | Trend: ${regime.trendRegime} (ADX=${safeToFixed(regime.adxValue, 0)})` +
                ` | Vol: ${regime.volatilityRegime} (ATR×${safeToFixed(regime.atrRatio, 2)})`
            );
            lines.push(
                `  Strategy: ${regime.recommendedStrategy.slice(0, 80)}` +
                ` | Leverage: ${regime.recommendedLeverage.min}-${regime.recommendedLeverage.max}x`
            );

            if (regime.transitionWarning) {
                lines.push(`  ⚠️ ${regime.transitionWarning}`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Format quant context for AI prompt (compact version)
 * Uses safe formatting to handle NaN/Infinity values
 */
export function formatQuantForPrompt(context: QuantContext): string {
    // Validate context structure
    if (!context || !context.crossAsset || !(context.assets instanceof Map)) {
        return '=== QUANT ANALYSIS ===\nNo quant data available.';
    }

    const lines: string[] = [
        '=== QUANT ANALYSIS ===',
        `Regime: ${context.crossAsset.marketRegime || 'neutral'} | BTC Dominance: ${safeToFixed(context.crossAsset.btcDominance, 0)}%`,
        '',
    ];

    for (const [symbol, analysis] of context.assets) {
        if (!analysis) continue;

        const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
        const s = analysis.primarySignal || { direction: 'neutral', strength: 0 };
        const st = analysis.statistics || { zScore: 0 };
        const p = analysis.probability || { entryQuality: 'fair', longWinRate: 50, shortWinRate: 50 };

        // Get funding info for this symbol
        const funding = context.fundingAnalysis?.get(symbol);
        const fundingStr = funding
            ? ` funding:${safeToFixed(funding.percentile, 0)}pctl${funding.isPersistent ? '*' : ''}`
            : '';
        const corrRow = context.crossAsset?.correlationMatrix?.get(symbol) ||
            context.crossAsset?.correlationMatrix?.get(symbol.toLowerCase()) ||
            context.crossAsset?.correlationMatrix?.get(symbol.toLowerCase().replace(/^cmt_/, ''));
        const corrToBtc = corrRow
            ? (corrRow.get('btc') || corrRow.get('btcusdt') || corrRow.get('cmt_btcusdt') || 0)
            : 0;
        const corrPenalty = Math.max(0, Math.min(1, Math.abs(corrToBtc)));
        const adjustedStrength = Math.max(0, s.strength * (1 - corrPenalty));

        lines.push(
            `${sym}: ${s.direction}(${safeToFixed(adjustedStrength, 0)}) z=${safeToFixed(st.zScore, 1)} ` +
            `entry=${p.entryQuality} risk=${analysis.riskLevel || 'medium'} ` +
            `win:L${safeToFixed(p.longWinRate, 0)}%/S${safeToFixed(p.shortWinRate, 0)}%${fundingStr}`
        );
        if (analysis.strategies) {
            const picks = Object.values(analysis.strategies)
                .filter(sg => sg && sg.direction !== 'neutral' && sg.strength > 0)
                .sort((a, b) => b.strength - a.strength)
                .slice(0, 2)
                .map(sg => `${sg.name}:${sg.direction === 'long' ? 'L' : 'S'}${safeToFixed(sg.strength, 0)}`);
            if (picks.length > 0) {
                lines.push(`  strat:${picks.join(' ')}`);
            }
        }
    }

    // Add funding signals section if any are persistent
    if (context.fundingAnalysis && context.fundingAnalysis.size > 0) {
        const persistentSignals: string[] = [];
        for (const [symbol, funding] of context.fundingAnalysis) {
            if (funding.isPersistent && funding.signal.direction !== 'neutral') {
                const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
                persistentSignals.push(
                    `${sym}: ${funding.signal.direction.toUpperCase()} (${funding.signal.reason.slice(0, 60)})`
                );
            }
        }
        if (persistentSignals.length > 0) {
            lines.push('');
            lines.push('FUNDING SIGNALS (persistent):');
            lines.push(...persistentSignals);
        }
    }

    // Add regime analysis section (v5.1.0 Phase 2)
    if (context.regimeAnalysis && context.regimeAnalysis.size > 0) {
        lines.push('');
        lines.push('REGIME ANALYSIS:');
        for (const [symbol, regime] of context.regimeAnalysis) {
            const sym = symbol.toLowerCase().replace('cmt_', '').replace('usdt', '').toUpperCase();
            const difficultyEmoji = regime.tradingDifficulty === 'easy' ? '✓' :
                regime.tradingDifficulty === 'extreme' ? '⚠️' :
                    regime.tradingDifficulty === 'hard' ? '!' : '';
            lines.push(
                `${sym}: ${regime.overallRegime}${difficultyEmoji} ADX=${safeToFixed(regime.adxValue, 0)} ` +
                `ATR×${safeToFixed(regime.atrRatio, 1)} Lev:${regime.recommendedLeverage.min}-${regime.recommendedLeverage.max}x`
            );
            if (regime.transitionWarning) {
                lines.push(`  ⚠️ ${regime.transitionWarning.slice(0, 70)}`);
            }
        }
    }

    return lines.join('\n');
}

/**
 * Get quant analysis for a single symbol
 */
export async function getAssetQuantAnalysis(symbol: string): Promise<AssetQuantAnalysis | null> {
    return analyzeAsset(symbol);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

export default {
    getQuantContext,
    getAssetQuantAnalysis,
    formatQuantForPrompt,
    clearQuantCache,
    clearFundingHistory,  // v5.1.0
    shutdownQuantService,
    resetQuantServiceState,
};
