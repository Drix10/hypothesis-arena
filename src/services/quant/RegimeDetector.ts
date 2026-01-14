/**
 * RegimeDetector - Market Regime Classification (v5.2.0)
 * Simplified 4-state regime detection: trending, ranging, volatile, quiet
 */

import { logger } from '../../utils/logger';

export interface MarketRegime {
    volatilityRegime: 'low' | 'normal' | 'high' | 'extreme';
    volatilityPercentile: number;
    isVolatilityExpanding: boolean;
    atrRatio: number;

    trendRegime: 'strong_bull' | 'weak_bull' | 'ranging' | 'weak_bear' | 'strong_bear';
    trendStrength: number;
    trendDuration: number;
    adxValue: number;

    emaStructure: 'bullish_stack' | 'bearish_stack' | 'tangled';
    priceVsEma20: 'above' | 'below' | 'at';

    liquidityRegime: 'high' | 'normal' | 'low';
    volumeVsAverage: number;

    overallRegime: 'trending' | 'ranging' | 'volatile' | 'quiet';
    tradingDifficulty: 'easy' | 'moderate' | 'hard' | 'extreme';
    recommendedStrategy: string;
    recommendedLeverage: { min: number; max: number };
    recommendedStopMultiplier: number;

    regimeProbability: number;
    transitionProbability: number;
    transitionWarning: string | null;

    timestamp: number;
    symbol: string;
}

export interface RegimeInput {
    symbol: string;
    currentPrice: number;
    ema9: number;
    ema20: number;
    ema50: number;
    atr14: number;
    atrHistory: number[];
    adx: number;
    plusDI: number;
    minusDI: number;
    bbUpper: number;
    bbMiddle: number;
    bbLower: number;
    bbWidth: number;
    currentVolume: number;
    avgVolume20: number;
    priceHistory: number[];
}

interface RegimeHistoryEntry {
    timestamp: number;
    overallRegime: MarketRegime['overallRegime'];
    trendRegime: MarketRegime['trendRegime'];
}

const regimeHistory = new Map<string, RegimeHistoryEntry[]>();
const REGIME_HISTORY_MAX = 20;
const REGIME_HISTORY_MAX_SYMBOLS = 50;
const REGIME_CLEANUP_INTERVAL = 10 * 60 * 1000;
const REGIME_MAX_AGE_MS = 24 * 60 * 60 * 1000;

let regimeCleanupTimer: ReturnType<typeof setInterval> | null = null;

function startRegimeCleanupTimer(): void {
    if (regimeCleanupTimer) return;
    regimeCleanupTimer = setInterval(() => {
        cleanupStaleRegimeHistory(REGIME_MAX_AGE_MS);
    }, REGIME_CLEANUP_INTERVAL);
    if (regimeCleanupTimer.unref) {
        regimeCleanupTimer.unref();
    }
}

function normalizeSymbol(symbol: string): string {
    if (!symbol || typeof symbol !== 'string') return '';
    return symbol.toLowerCase().trim();
}

function addRegimeToHistory(symbol: string, regime: MarketRegime): void {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) return;

    let history = regimeHistory.get(normalizedSymbol);

    if (!history) {
        if (regimeHistory.size >= REGIME_HISTORY_MAX_SYMBOLS) {
            let oldestSymbol: string | undefined = undefined;
            let oldestTime = Infinity;
            for (const [sym, entries] of regimeHistory.entries()) {
                const lastEntry = entries[entries.length - 1];
                if (lastEntry && lastEntry.timestamp < oldestTime) {
                    oldestTime = lastEntry.timestamp;
                    oldestSymbol = sym;
                }
            }
            if (oldestSymbol !== undefined) {
                regimeHistory.delete(oldestSymbol);
                logger.debug(`Regime history: evicted ${oldestSymbol} to make room for ${normalizedSymbol}`);
            }
        }

        history = [];
        regimeHistory.set(normalizedSymbol, history);
    }

    history.push({
        timestamp: regime.timestamp,
        overallRegime: regime.overallRegime,
        trendRegime: regime.trendRegime,
    });

    if (history.length > REGIME_HISTORY_MAX) {
        history.shift();
    }
}

function getRegimeHistory(symbol: string): RegimeHistoryEntry[] {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) return [];
    return regimeHistory.get(normalizedSymbol) || [];
}

/**
 * Count consecutive periods in current regime
 */
function countRegimeDuration(symbol: string, currentRegime: MarketRegime['overallRegime']): number {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (!normalizedSymbol) return 1;

    const history = getRegimeHistory(normalizedSymbol);
    if (history.length === 0) return 1;

    let count = 1;
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].overallRegime === currentRegime) {
            count++;
        } else {
            break;
        }
    }
    return count;
}

export function detectRegime(input: RegimeInput | undefined): MarketRegime {
    const timestamp = Date.now();

    startRegimeCleanupTimer();

    const safeSymbol = input?.symbol ?? '';

    if (!input || !validateInput(input)) {
        return createDefaultRegime(safeSymbol, timestamp);
    }

    const volatilityAnalysis = analyzeVolatility(input);
    const trendAnalysis = analyzeTrend(input);
    const liquidityAnalysis = analyzeLiquidity(input);

    const overallRegime = determineOverallRegime(
        volatilityAnalysis,
        trendAnalysis,
        liquidityAnalysis,
        input
    );

    const difficulty = assessTradingDifficulty(
        overallRegime,
        volatilityAnalysis,
        trendAnalysis
    );

    const recommendations = getStrategyRecommendations(overallRegime, difficulty);

    const transitionAnalysis = analyzeTransitionProbability(
        input.symbol,
        overallRegime,
        trendAnalysis,
        volatilityAnalysis
    );

    const regime: MarketRegime = {
        // Volatility
        volatilityRegime: volatilityAnalysis.regime,
        volatilityPercentile: volatilityAnalysis.percentile,
        isVolatilityExpanding: volatilityAnalysis.isExpanding,
        atrRatio: volatilityAnalysis.atrRatio,

        // Trend
        trendRegime: trendAnalysis.regime,
        trendStrength: trendAnalysis.strength,
        trendDuration: trendAnalysis.duration,
        adxValue: input.adx,

        // EMA
        emaStructure: trendAnalysis.emaStructure,
        priceVsEma20: trendAnalysis.priceVsEma20,

        // Liquidity
        liquidityRegime: liquidityAnalysis.regime,
        volumeVsAverage: liquidityAnalysis.volumeRatio,

        // Combined
        overallRegime,
        tradingDifficulty: difficulty,
        recommendedStrategy: recommendations.strategy,
        recommendedLeverage: recommendations.leverage,
        recommendedStopMultiplier: recommendations.stopMultiplier,

        // Transition
        regimeProbability: transitionAnalysis.regimeProbability,
        transitionProbability: transitionAnalysis.transitionProbability,
        transitionWarning: transitionAnalysis.warning,

        // Metadata
        timestamp,
        symbol: input.symbol,
    };

    addRegimeToHistory(input.symbol, regime);
    return regime;
}

interface VolatilityAnalysis {
    regime: 'low' | 'normal' | 'high' | 'extreme';
    percentile: number;
    isExpanding: boolean;
    atrRatio: number;
}

function analyzeVolatility(input: RegimeInput): VolatilityAnalysis {
    const { atr14, atrHistory } = input;

    const validHistory = atrHistory.filter(v => Number.isFinite(v) && v > 0);
    let percentile = 50;

    if (validHistory.length >= 5) {
        const sorted = [...validHistory].sort((a, b) => a - b);
        const belowCount = sorted.filter(v => v < atr14).length;
        percentile = (belowCount / sorted.length) * 100;
    }

    const avgAtr = validHistory.length > 0
        ? validHistory.reduce((a, b) => a + b, 0) / validHistory.length
        : atr14;
    const atrRatio = avgAtr > 0 ? atr14 / avgAtr : 1;

    let isExpanding = false;
    if (validHistory.length >= 10) {
        const recent5 = validHistory.slice(-5);
        const older5 = validHistory.slice(-10, -5);
        if (recent5.length >= 3 && older5.length >= 3) {
            const recentSum = recent5.reduce((a, b) => a + b, 0);
            const olderSum = older5.reduce((a, b) => a + b, 0);
            const recentAvg = recentSum / recent5.length;
            const olderAvg = olderSum / older5.length;
            isExpanding = Number.isFinite(recentAvg) && Number.isFinite(olderAvg) &&
                olderAvg > 0 && recentAvg > olderAvg * 1.2;
        }
    }

    let regime: VolatilityAnalysis['regime'];
    if (percentile >= 90 || atrRatio >= 2.0) {
        regime = 'extreme';
    } else if (percentile >= 70 || atrRatio >= 1.5) {
        regime = 'high';
    } else if (percentile <= 20 || atrRatio <= 0.5) {
        regime = 'low';
    } else {
        regime = 'normal';
    }

    return {
        regime,
        percentile: Math.round(percentile),
        isExpanding,
        atrRatio: Number.isFinite(atrRatio) ? atrRatio : 1,
    };
}

interface TrendAnalysis {
    regime: MarketRegime['trendRegime'];
    strength: number;
    duration: number;
    emaStructure: 'bullish_stack' | 'bearish_stack' | 'tangled';
    priceVsEma20: 'above' | 'below' | 'at';
}

function analyzeTrend(input: RegimeInput): TrendAnalysis {
    const { currentPrice, ema9, ema20, ema50, adx, plusDI, minusDI, priceHistory } = input;

    let emaStructure: TrendAnalysis['emaStructure'];
    const bullishStack = ema9 > ema20 && ema20 > ema50;
    const bearishStack = ema9 < ema20 && ema20 < ema50;

    if (bullishStack) {
        emaStructure = 'bullish_stack';
    } else if (bearishStack) {
        emaStructure = 'bearish_stack';
    } else {
        emaStructure = 'tangled';
    }

    const ema20Threshold = ema20 * 0.002;
    let priceVsEma20: TrendAnalysis['priceVsEma20'];
    if (currentPrice > ema20 + ema20Threshold) {
        priceVsEma20 = 'above';
    } else if (currentPrice < ema20 - ema20Threshold) {
        priceVsEma20 = 'below';
    } else {
        priceVsEma20 = 'at';
    }

    let regime: TrendAnalysis['regime'];
    let strength = 0;

    if (adx >= 25) {
        if (plusDI > minusDI) {
            if (adx >= 40 && bullishStack) {
                regime = 'strong_bull';
                strength = Math.min(100, adx + 20);
            } else {
                regime = 'weak_bull';
                strength = Math.min(80, adx);
            }
        } else {
            if (adx >= 40 && bearishStack) {
                regime = 'strong_bear';
                strength = Math.min(100, adx + 20);
            } else {
                regime = 'weak_bear';
                strength = Math.min(80, adx);
            }
        }
    } else {
        regime = 'ranging';
        strength = Math.max(0, 50 - adx);
    }

    let duration = 0;
    if (priceHistory.length >= 3 && regime !== 'ranging') {
        const isBullish = regime.includes('bull');
        const isBearish = regime.includes('bear');

        for (let i = priceHistory.length - 2; i >= 0; i--) {
            const priceChange = priceHistory[i + 1] - priceHistory[i];
            if (isBullish && priceChange > 0) {
                duration++;
            } else if (isBearish && priceChange < 0) {
                duration++;
            } else {
                break;
            }
        }
    }

    return {
        regime,
        strength: Math.round(strength),
        duration,
        emaStructure,
        priceVsEma20,
    };
}

interface LiquidityAnalysis {
    regime: 'high' | 'normal' | 'low';
    volumeRatio: number;
}

function analyzeLiquidity(input: RegimeInput): LiquidityAnalysis {
    const { currentVolume, avgVolume20 } = input;

    const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 1;

    let regime: LiquidityAnalysis['regime'];
    if (volumeRatio >= 1.5) {
        regime = 'high';
    } else if (volumeRatio <= 0.5) {
        regime = 'low';
    } else {
        regime = 'normal';
    }

    return {
        regime,
        volumeRatio: Number.isFinite(volumeRatio) ? volumeRatio : 1,
    };
}

function determineOverallRegime(
    volatility: VolatilityAnalysis,
    trend: TrendAnalysis,
    liquidity: LiquidityAnalysis,
    input: RegimeInput
): MarketRegime['overallRegime'] {
    // Priority: Volatile > Trending > Quiet > Ranging

    // Volatile: High ATR + expanding volatility
    if (volatility.regime === 'extreme' ||
        (volatility.regime === 'high' && volatility.isExpanding)) {
        return 'volatile';
    }

    // Trending: Strong ADX (trend.strength >= 50 implies ADX >= 25 with directional bias)
    // Note: EMA structure is factored into trend.regime (strong_bull/bear require aligned EMAs)
    if (trend.regime !== 'ranging' && trend.strength >= 50) {
        return 'trending';
    }

    // Quiet: Low volatility + low volume
    if (volatility.regime === 'low' && liquidity.regime === 'low') {
        return 'quiet';
    }

    // Check Bollinger Band squeeze for quiet regime
    if (input.bbWidth < 0.02) {  // Very tight bands
        return 'quiet';
    }

    // Default to ranging
    return 'ranging';
}

function assessTradingDifficulty(
    overallRegime: MarketRegime['overallRegime'],
    volatility: VolatilityAnalysis,
    trend: TrendAnalysis
): MarketRegime['tradingDifficulty'] {
    // Easy: Clear trend with normal volatility
    if (overallRegime === 'trending' &&
        volatility.regime === 'normal' &&
        trend.strength >= 60) {
        return 'easy';
    }

    // Extreme: Very high volatility or tangled EMAs with high vol
    if (volatility.regime === 'extreme' ||
        (volatility.regime === 'high' && trend.emaStructure === 'tangled')) {
        return 'extreme';
    }

    // Hard: High volatility or weak trends
    if (volatility.regime === 'high' ||
        (overallRegime === 'ranging' && volatility.isExpanding)) {
        return 'hard';
    }

    // Moderate: Everything else
    return 'moderate';
}

interface StrategyRecommendations {
    strategy: string;
    leverage: { min: number; max: number };
    stopMultiplier: number;
}

function getStrategyRecommendations(
    regime: MarketRegime['overallRegime'],
    difficulty: MarketRegime['tradingDifficulty']
): StrategyRecommendations {
    // Per quant advisor recommendations
    // First check difficulty - extreme/hard difficulty overrides regime recommendations
    if (difficulty === 'extreme') {
        return {
            strategy: 'HOLD recommended - unfavorable regime with extreme difficulty',
            leverage: { min: 15, max: 15 },
            stopMultiplier: 2.0,
        };
    }

    if (difficulty === 'hard') {
        return {
            strategy: 'Reduced position size (0.5x) - challenging conditions',
            leverage: { min: 15, max: 17 },
            stopMultiplier: 1.5,
        };
    }

    // Now apply regime-specific recommendations for easier conditions
    switch (regime) {
        case 'trending':
            return {
                strategy: 'Trend following - buy dips in uptrend, sell rallies in downtrend',
                leverage: { min: 18, max: 20 },
                stopMultiplier: 1.2,  // Wider stops
            };

        case 'ranging':
            return {
                strategy: 'Mean reversion - fade extremes at support/resistance',
                leverage: { min: 16, max: 18 },
                stopMultiplier: 0.8,  // Tighter stops
            };

        case 'volatile':
            return {
                strategy: 'Reduced size, wider stops, or sit out - high uncertainty',
                leverage: { min: 15, max: 17 },
                stopMultiplier: 1.5,  // Much wider stops
            };

        case 'quiet':
            return {
                strategy: 'Wait for breakout or skip - low edge environment',
                leverage: { min: 15, max: 17 },
                stopMultiplier: 1.0,
            };

        default:
            return {
                strategy: 'Standard approach with normal sizing',
                leverage: { min: 16, max: 18 },
                stopMultiplier: 1.0,
            };
    }
}

interface TransitionAnalysis {
    regimeProbability: number;
    transitionProbability: number;
    warning: string | null;
}

function analyzeTransitionProbability(
    symbol: string,
    currentRegime: MarketRegime['overallRegime'],
    trend: TrendAnalysis,
    volatility: VolatilityAnalysis
): TransitionAnalysis {
    const regimeDuration = countRegimeDuration(symbol, currentRegime);

    // Base regime probability from indicator alignment
    let regimeProbability = 70;  // Default confidence

    // Adjust based on indicator alignment
    if (currentRegime === 'trending') {
        // Strong trend indicators = higher confidence
        if (trend.strength >= 70 && trend.emaStructure !== 'tangled') {
            regimeProbability = 85;
        } else if (trend.strength < 50) {
            regimeProbability = 55;
        }
    } else if (currentRegime === 'ranging') {
        // Clear ranging = higher confidence
        if (trend.strength < 30 && volatility.regime === 'normal') {
            regimeProbability = 80;
        }
    } else if (currentRegime === 'volatile') {
        // Volatility regimes are inherently unstable
        regimeProbability = 60;
    }

    // Calculate transition probability
    let transitionProbability = 20;  // Base probability

    // Short regime duration = higher transition probability
    if (regimeDuration < 3) {
        transitionProbability += 20;
    } else if (regimeDuration > 10) {
        // Long duration = watch for exhaustion
        transitionProbability += 15;
    }

    // Volatility expanding in non-volatile regime = transition likely
    if (currentRegime !== 'volatile' && volatility.isExpanding) {
        transitionProbability += 15;
    }

    // Trend weakening = transition likely
    if (currentRegime === 'trending' && trend.strength < 40) {
        transitionProbability += 20;
    }

    // Cap probabilities
    regimeProbability = Math.min(95, Math.max(30, regimeProbability));
    transitionProbability = Math.min(80, Math.max(10, transitionProbability));

    // Generate warning if transition likely
    let warning: string | null = null;
    if (transitionProbability >= 50) {
        warning = `Regime transition likely (${transitionProbability}%) - reduce position size or wait for confirmation`;
    } else if (transitionProbability >= 40 && volatility.isExpanding) {
        warning = `Volatility expanding - potential regime shift, tighten risk management`;
    }

    return {
        regimeProbability,
        transitionProbability,
        warning,
    };
}



function validateInput(input: RegimeInput): boolean {
    if (!input || typeof input !== 'object') return false;
    if (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0) return false;
    if (!Number.isFinite(input.ema9) || input.ema9 <= 0) return false;
    if (!Number.isFinite(input.ema20) || input.ema20 <= 0) return false;
    if (!Number.isFinite(input.ema50) || input.ema50 <= 0) return false;
    if (!Number.isFinite(input.atr14) || input.atr14 <= 0) return false;
    // ADX must be finite and within valid range (0-100)
    if (!Number.isFinite(input.adx) || input.adx < 0 || input.adx > 100) return false;
    if (!Number.isFinite(input.plusDI) || input.plusDI < 0) return false;
    if (!Number.isFinite(input.minusDI) || input.minusDI < 0) return false;
    if (!Number.isFinite(input.bbWidth) || input.bbWidth < 0) return false;
    if (!Number.isFinite(input.bbUpper) || input.bbUpper <= 0) return false;
    if (!Number.isFinite(input.bbMiddle) || input.bbMiddle <= 0) return false;
    if (!Number.isFinite(input.bbLower) || input.bbLower <= 0) return false;
    if (!Number.isFinite(input.currentVolume) || input.currentVolume < 0) return false;
    if (!Number.isFinite(input.avgVolume20) || input.avgVolume20 < 0) return false;
    if (!Array.isArray(input.atrHistory) || input.atrHistory.length === 0) return false;
    if (!Array.isArray(input.priceHistory) || input.priceHistory.length === 0) return false;
    return true;
}

function createDefaultRegime(symbol: string, timestamp: number): MarketRegime {
    return {
        volatilityRegime: 'normal',
        volatilityPercentile: 50,
        isVolatilityExpanding: false,
        atrRatio: 1,
        trendRegime: 'ranging',
        trendStrength: 30,
        trendDuration: 0,
        adxValue: 20,
        emaStructure: 'tangled',
        priceVsEma20: 'at',
        liquidityRegime: 'normal',
        volumeVsAverage: 1,
        overallRegime: 'ranging',
        tradingDifficulty: 'moderate',
        recommendedStrategy: 'Insufficient data - use caution',
        recommendedLeverage: { min: 10, max: 12 },
        recommendedStopMultiplier: 1.0,
        regimeProbability: 50,
        transitionProbability: 30,
        transitionWarning: null,
        timestamp,
        symbol,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export function formatRegimeForPrompt(regime: MarketRegime): string {
    const adxDisplay = Number.isFinite(regime.adxValue) ? regime.adxValue.toFixed(0) : '--';
    const atrRatioDisplay = Number.isFinite(regime.atrRatio) ? regime.atrRatio.toFixed(2) : '--';
    const volPercentile = Number.isFinite(regime.volatilityPercentile) ? regime.volatilityPercentile : '--';
    const trendStr = Number.isFinite(regime.trendStrength) ? regime.trendStrength : '--';
    const leverageMin = regime.recommendedLeverage?.min ?? 15;
    const leverageMax = regime.recommendedLeverage?.max ?? 17;
    const stopMult = Number.isFinite(regime.recommendedStopMultiplier) ? regime.recommendedStopMultiplier : 1;

    const lines: string[] = [
        `REGIME: ${(regime.overallRegime || 'unknown').toUpperCase()} | Difficulty: ${regime.tradingDifficulty || 'unknown'}`,
        `Trend: ${regime.trendRegime || 'unknown'} (ADX=${adxDisplay}, str=${trendStr})`,
        `Volatility: ${regime.volatilityRegime || 'unknown'} (${volPercentile}th pctl, ATR ratio=${atrRatioDisplay})`,
        `EMA: ${regime.emaStructure || 'unknown'} | Price vs EMA20: ${regime.priceVsEma20 || 'unknown'}`,
        `Strategy: ${regime.recommendedStrategy || 'No recommendation'}`,
        `Leverage: ${leverageMin}-${leverageMax}x | Stop mult: ${stopMult}x`,
    ];

    if (regime.transitionWarning) {
        lines.push(`⚠️ WARNING: ${regime.transitionWarning}`);
    }

    return lines.join('\n');
}

export function clearRegimeHistory(): void {
    regimeHistory.clear();
    logger.info('Regime history cleared');
}

export function cleanupStaleRegimeHistory(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    let removedEntries = 0;

    const symbolsToDelete: string[] = [];
    const symbolsToUpdate: Array<{ symbol: string; freshEntries: RegimeHistoryEntry[] }> = [];

    for (const [symbol, entries] of regimeHistory.entries()) {
        const freshEntries = entries.filter(e => now - e.timestamp < maxAgeMs);

        if (freshEntries.length === 0) {
            removedEntries += entries.length;
            symbolsToDelete.push(symbol);
        } else if (freshEntries.length < entries.length) {
            removedEntries += entries.length - freshEntries.length;
            symbolsToUpdate.push({ symbol, freshEntries });
        }
    }

    for (const symbol of symbolsToDelete) {
        regimeHistory.delete(symbol);
    }

    for (const { symbol, freshEntries } of symbolsToUpdate) {
        regimeHistory.set(symbol, freshEntries);
    }

    if (removedEntries > 0 || symbolsToDelete.length > 0) {
        logger.debug(`Regime history cleanup: removed ${removedEntries} entries, ${symbolsToDelete.length} symbols`);
    }
}

export function shutdownRegimeDetector(): void {
    if (regimeCleanupTimer) {
        clearInterval(regimeCleanupTimer);
        regimeCleanupTimer = null;
    }
    regimeHistory.clear();
    logger.info('Regime detector service shutdown complete');
}

export default {
    detectRegime,
    formatRegimeForPrompt,
    clearRegimeHistory,
    cleanupStaleRegimeHistory,
    shutdownRegimeDetector,
};
