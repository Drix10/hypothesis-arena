/**
 * Technical Analysis Service
 * 
 * Calculates technical indicators from historical price data.
 * All calculations done client-side - no external API needed.
 */

import { HistoricalDataPoint, TechnicalIndicators, TechnicalSignal } from '../../types/stock';

// ═══════════════════════════════════════════════════════════════════════════════
// MOVING AVERAGES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Simple Moving Average
 */
export function calculateSMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] || 0;
    const slice = data.slice(-period);
    return slice.reduce((sum, val) => sum + val, 0) / period;
}

/**
 * Calculate Exponential Moving Average
 */
export function calculateEMA(data: number[], period: number): number {
    if (data.length === 0) return 0;
    if (data.length < period) return calculateSMA(data, data.length);

    const multiplier = 2 / (period + 1);
    let ema = calculateSMA(data.slice(0, period), period);

    for (let i = period; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
    }

    return ema;
}

/**
 * Calculate EMA series (for MACD)
 */
function calculateEMASeries(data: number[], period: number): number[] {
    if (data.length === 0) return [];

    const result: number[] = [];
    const multiplier = 2 / (period + 1);

    // Start with SMA for first value
    let ema = data.slice(0, Math.min(period, data.length))
        .reduce((sum, val) => sum + val, 0) / Math.min(period, data.length);
    result.push(ema);

    for (let i = 1; i < data.length; i++) {
        ema = (data[i] - ema) * multiplier + ema;
        result.push(ema);
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOMENTUM INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Relative Strength Index (RSI)
 */
export function calculateRSI(data: number[], period: number = 14): number {
    if (data.length < period + 1) return 50; // Neutral if not enough data

    const changes: number[] = [];
    for (let i = 1; i < data.length; i++) {
        changes.push(data[i] - data[i - 1]);
    }

    const recentChanges = changes.slice(-period);
    let gains = 0;
    let losses = 0;

    for (const change of recentChanges) {
        if (change > 0) gains += change;
        else losses -= change;
    }

    if (losses === 0) return 100;
    if (gains === 0) return 0;

    const rs = gains / losses;
    return 100 - (100 / (1 + rs));
}

/**
 * Calculate MACD (Moving Average Convergence Divergence)
 */
export function calculateMACD(data: number[]): { macdLine: number; signalLine: number; histogram: number } {
    if (data.length < 26) {
        return { macdLine: 0, signalLine: 0, histogram: 0 };
    }

    const ema12Series = calculateEMASeries(data, 12);
    const ema26Series = calculateEMASeries(data, 26);

    // MACD Line = EMA12 - EMA26
    const macdSeries: number[] = [];
    for (let i = 0; i < ema12Series.length; i++) {
        macdSeries.push(ema12Series[i] - ema26Series[i]);
    }

    // Signal Line = 9-day EMA of MACD
    const signalSeries = calculateEMASeries(macdSeries, 9);

    const macdLine = macdSeries[macdSeries.length - 1];
    const signalLine = signalSeries[signalSeries.length - 1];
    const histogram = macdLine - signalLine;

    return { macdLine, signalLine, histogram };
}

/**
 * Calculate Stochastic Oscillator
 */
export function calculateStochastic(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14
): { k: number; d: number } {
    if (closes.length < period || highs.length < period || lows.length < period) {
        return { k: 50, d: 50 };
    }

    const recentHighs = highs.slice(-period);
    const recentLows = lows.slice(-period);
    const currentClose = closes[closes.length - 1];

    // Filter out invalid values before calculating max/min
    const validHighs = recentHighs.filter(h => Number.isFinite(h) && h > 0);
    const validLows = recentLows.filter(l => Number.isFinite(l) && l > 0);

    if (validHighs.length === 0 || validLows.length === 0) {
        return { k: 50, d: 50 };
    }

    const highestHigh = Math.max(...validHighs);
    const lowestLow = Math.min(...validLows);

    const range = highestHigh - lowestLow;
    // Safe division - avoid division by zero
    const k = range > 0 ? ((currentClose - lowestLow) / range) * 100 : 50;

    // Clamp k to valid range [0, 100]
    const clampedK = Math.max(0, Math.min(100, k));

    // %D is 3-period SMA of %K (simplified - just return k for now)
    const d = clampedK; // In production, would calculate 3-period SMA

    return { k: clampedK, d };
}


// ═══════════════════════════════════════════════════════════════════════════════
// VOLATILITY INDICATORS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate Bollinger Bands
 */
export function calculateBollingerBands(
    data: number[],
    period: number = 20,
    stdDev: number = 2
): { upper: number; middle: number; lower: number; width: number } {
    // Filter out invalid values
    const validData = data.filter(d => Number.isFinite(d) && d > 0);

    if (validData.length < period) {
        const price = validData[validData.length - 1] || 0;
        return { upper: price, middle: price, lower: price, width: 0 };
    }

    const slice = validData.slice(-period);
    const middle = slice.reduce((sum, val) => sum + val, 0) / period;

    // Guard against invalid middle value
    if (!Number.isFinite(middle) || middle <= 0) {
        return { upper: 0, middle: 0, lower: 0, width: 0 };
    }

    // Calculate standard deviation
    const squaredDiffs = slice.map(val => Math.pow(val - middle, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / period;

    // Guard against negative variance (shouldn't happen but defensive)
    const sd = variance >= 0 ? Math.sqrt(variance) : 0;

    const upper = middle + (stdDev * sd);
    const lower = middle - (stdDev * sd);
    // Safe division
    const width = middle > 0 ? ((upper - lower) / middle) * 100 : 0;

    return { upper, middle, lower, width };
}

/**
 * Calculate Average True Range (ATR)
 */
export function calculateATR(
    highs: number[],
    lows: number[],
    closes: number[],
    period: number = 14
): number {
    if (highs.length < 2) return 0;

    const trueRanges: number[] = [];

    for (let i = 1; i < highs.length; i++) {
        const high = highs[i];
        const low = lows[i];
        const prevClose = closes[i - 1];

        const tr = Math.max(
            high - low,
            Math.abs(high - prevClose),
            Math.abs(low - prevClose)
        );
        trueRanges.push(tr);
    }

    return calculateSMA(trueRanges.slice(-period), period);
}

/**
 * Calculate Historical Volatility
 */
export function calculateVolatility(data: number[], period: number = 20): number {
    if (data.length < 2) return 0;

    // Calculate daily returns (skip zero/negative values to avoid log errors)
    const returns: number[] = [];
    for (let i = 1; i < data.length; i++) {
        const prev = data[i - 1];
        const curr = data[i];
        // Only calculate return if both values are positive
        if (prev > 0 && curr > 0) {
            returns.push(Math.log(curr / prev));
        }
    }

    // Need at least 2 returns to calculate variance
    if (returns.length < 2) return 0;

    const actualPeriod = Math.min(period, returns.length);
    const recentReturns = returns.slice(-actualPeriod);

    // Safe calculation - check for empty array
    if (recentReturns.length === 0) return 0;

    const mean = recentReturns.reduce((sum, val) => sum + val, 0) / recentReturns.length;
    const squaredDiffs = recentReturns.map(r => Math.pow(r - mean, 2));
    const variance = squaredDiffs.reduce((sum, val) => sum + val, 0) / recentReturns.length;

    // Guard against NaN from sqrt of negative (shouldn't happen but defensive)
    if (variance < 0 || !Number.isFinite(variance)) return 0;

    // Annualized volatility (assuming 252 trading days)
    const volatility = Math.sqrt(variance * 252) * 100;

    // Final NaN check
    return Number.isFinite(volatility) ? volatility : 0;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TREND ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Identify current trend
 */
export function identifyTrend(
    closes: number[],
    sma20: number,
    sma50: number,
    sma200: number
): { trend: TechnicalIndicators['trend']; strength: number } {
    if (closes.length === 0) {
        return { trend: 'sideways', strength: 50 };
    }

    const currentPrice = closes[closes.length - 1];

    // Guard against invalid price data
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return { trend: 'sideways', strength: 50 };
    }

    let bullishSignals = 0;
    let bearishSignals = 0;

    // Price vs moving averages (only compare if MAs are valid)
    if (sma20 > 0) {
        if (currentPrice > sma20) bullishSignals++;
        else bearishSignals++;
    }

    if (sma50 > 0) {
        if (currentPrice > sma50) bullishSignals++;
        else bearishSignals++;
    }

    if (sma200 > 0) {
        if (currentPrice > sma200) bullishSignals++;
        else bearishSignals++;
    }

    // Moving average alignment (only if all MAs are valid)
    if (sma20 > 0 && sma50 > 0 && sma200 > 0) {
        if (sma20 > sma50 && sma50 > sma200) bullishSignals += 2;
        else if (sma20 < sma50 && sma50 < sma200) bearishSignals += 2;
    }

    // Recent momentum (last 10 days)
    if (closes.length >= 10) {
        const recent = closes.slice(-10);
        const oldPrice = recent[0];
        // Safe division
        if (oldPrice > 0) {
            const change = ((currentPrice - oldPrice) / oldPrice) * 100;
            if (change > 5) bullishSignals += 2;
            else if (change > 2) bullishSignals++;
            else if (change < -5) bearishSignals += 2;
            else if (change < -2) bearishSignals++;
        }
    }

    const totalSignals = bullishSignals + bearishSignals;
    const strength = totalSignals > 0
        ? Math.round((Math.max(bullishSignals, bearishSignals) / totalSignals) * 100)
        : 50;

    let trend: TechnicalIndicators['trend'];
    const netSignal = bullishSignals - bearishSignals;

    if (netSignal >= 4) trend = 'strong_uptrend';
    else if (netSignal >= 2) trend = 'uptrend';
    else if (netSignal <= -4) trend = 'strong_downtrend';
    else if (netSignal <= -2) trend = 'downtrend';
    else trend = 'sideways';

    return { trend, strength };
}

/**
 * Find support and resistance levels
 */
export function findSupportResistance(
    highs: number[],
    lows: number[],
    closes: number[]
): { support: number[]; resistance: number[] } {
    if (closes.length < 20) {
        const price = closes[closes.length - 1] || 0;
        return {
            support: [price * 0.95, price * 0.9],
            resistance: [price * 1.05, price * 1.1]
        };
    }

    // Find local minima and maxima
    const support: number[] = [];
    const resistance: number[] = [];

    for (let i = 2; i < lows.length - 2; i++) {
        // Local minimum (support)
        if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] &&
            lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
            support.push(lows[i]);
        }
        // Local maximum (resistance)
        if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] &&
            highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
            resistance.push(highs[i]);
        }
    }

    // Sort and take most recent/relevant levels
    const currentPrice = closes[closes.length - 1];

    const relevantSupport = support
        .filter(s => s < currentPrice)
        .sort((a, b) => b - a)
        .slice(0, 3);

    const relevantResistance = resistance
        .filter(r => r > currentPrice)
        .sort((a, b) => a - b)
        .slice(0, 3);

    // Add fallback levels if not enough found
    if (relevantSupport.length < 2) {
        relevantSupport.push(currentPrice * 0.95, currentPrice * 0.9);
    }
    if (relevantResistance.length < 2) {
        relevantResistance.push(currentPrice * 1.05, currentPrice * 1.1);
    }

    return {
        support: relevantSupport.slice(0, 3),
        resistance: relevantResistance.slice(0, 3)
    };
}


// ═══════════════════════════════════════════════════════════════════════════════
// SIGNAL GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate trading signals from indicators
 */
function generateSignals(
    currentPrice: number,
    rsi: number,
    macd: { macdLine: number; signalLine: number; histogram: number },
    bollinger: { upper: number; middle: number; lower: number },
    _sma20: number,
    sma50: number,
    sma200: number
): TechnicalSignal[] {
    const signals: TechnicalSignal[] = [];

    // RSI signals
    if (rsi < 30) {
        signals.push({
            indicator: 'RSI',
            signal: 'bullish',
            strength: Math.round((30 - rsi) * 3),
            description: `RSI at ${rsi.toFixed(1)} indicates oversold conditions`
        });
    } else if (rsi > 70) {
        signals.push({
            indicator: 'RSI',
            signal: 'bearish',
            strength: Math.round((rsi - 70) * 3),
            description: `RSI at ${rsi.toFixed(1)} indicates overbought conditions`
        });
    }

    // MACD signals
    if (macd.histogram > 0 && macd.macdLine > macd.signalLine) {
        signals.push({
            indicator: 'MACD',
            signal: 'bullish',
            strength: Math.min(80, Math.abs(macd.histogram) * 100),
            description: 'MACD above signal line with positive momentum'
        });
    } else if (macd.histogram < 0 && macd.macdLine < macd.signalLine) {
        signals.push({
            indicator: 'MACD',
            signal: 'bearish',
            strength: Math.min(80, Math.abs(macd.histogram) * 100),
            description: 'MACD below signal line with negative momentum'
        });
    }

    // Bollinger Band signals
    if (currentPrice < bollinger.lower) {
        signals.push({
            indicator: 'Bollinger Bands',
            signal: 'bullish',
            strength: 70,
            description: 'Price below lower Bollinger Band - potential bounce'
        });
    } else if (currentPrice > bollinger.upper) {
        signals.push({
            indicator: 'Bollinger Bands',
            signal: 'bearish',
            strength: 70,
            description: 'Price above upper Bollinger Band - potential pullback'
        });
    }

    // Moving average signals
    if (currentPrice > sma200 && sma50 > sma200) {
        signals.push({
            indicator: 'Moving Averages',
            signal: 'bullish',
            strength: 60,
            description: 'Price above 200 SMA with bullish MA alignment'
        });
    } else if (currentPrice < sma200 && sma50 < sma200) {
        signals.push({
            indicator: 'Moving Averages',
            signal: 'bearish',
            strength: 60,
            description: 'Price below 200 SMA with bearish MA alignment'
        });
    }

    // Golden/Death cross (with safe division)
    if (sma200 > 0) {
        const crossRatio = Math.abs(sma50 - sma200) / sma200;
        if (sma50 > sma200 && crossRatio < 0.02) {
            signals.push({
                indicator: 'Golden Cross',
                signal: 'bullish',
                strength: 75,
                description: '50 SMA recently crossed above 200 SMA'
            });
        } else if (sma50 < sma200 && crossRatio < 0.02) {
            signals.push({
                indicator: 'Death Cross',
                signal: 'bearish',
                strength: 75,
                description: '50 SMA recently crossed below 200 SMA'
            });
        }
    }

    return signals;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN ANALYSIS FUNCTION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate all technical indicators from historical data
 */
export function calculateTechnicalIndicators(
    historicalData: HistoricalDataPoint[]
): TechnicalIndicators {
    if (historicalData.length === 0) {
        return getDefaultIndicators();
    }

    const closes = historicalData.map(d => d.close);
    const highs = historicalData.map(d => d.high);
    const lows = historicalData.map(d => d.low);

    // Moving Averages
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    const sma200 = calculateSMA(closes, 200);
    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);

    // Momentum
    const rsi14 = calculateRSI(closes, 14);
    const macd = calculateMACD(closes);
    const stochastic = calculateStochastic(highs, lows, closes, 14);

    // Volatility
    const bollingerBands = calculateBollingerBands(closes, 20, 2);
    const atr14 = calculateATR(highs, lows, closes, 14);
    const volatility = calculateVolatility(closes, 20);

    // Trend
    const { trend, strength: trendStrength } = identifyTrend(closes, sma20, sma50, sma200);

    // Support & Resistance
    const { support, resistance } = findSupportResistance(highs, lows, closes);

    // Signals
    const currentPrice = closes[closes.length - 1];
    const signals = generateSignals(
        currentPrice, rsi14, macd, bollingerBands, sma20, sma50, sma200
    );

    return {
        sma20,
        sma50,
        sma200,
        ema12,
        ema26,
        rsi14,
        macd,
        stochastic,
        bollingerBands,
        atr14,
        volatility,
        trend,
        trendStrength,
        supportLevels: support,
        resistanceLevels: resistance,
        signals
    };
}

/**
 * Get default indicators when no data available
 */
function getDefaultIndicators(): TechnicalIndicators {
    return {
        sma20: 0,
        sma50: 0,
        sma200: 0,
        ema12: 0,
        ema26: 0,
        rsi14: 50,
        macd: { macdLine: 0, signalLine: 0, histogram: 0 },
        stochastic: { k: 50, d: 50 },
        bollingerBands: { upper: 0, middle: 0, lower: 0, width: 0 },
        atr14: 0,
        volatility: 0,
        trend: 'sideways',
        trendStrength: 50,
        supportLevels: [],
        resistanceLevels: [],
        signals: []
    };
}
