/**
 * Technical Indicator Calculator
 * 
 * Calculates technical indicators from candlestick data.
 * Uses proven formulas matching TradingView/TAAPI calculations.
 */

import { WeexCandle } from '../../shared/types/weex';

export interface MACDResult {
    macd: number;
    signal: number;
    histogram: number;
}

export interface BollingerBandsResult {
    upper: number;
    middle: number;
    lower: number;
}

export class IndicatorCalculator {
    /**
     * Calculate Exponential Moving Average (EMA)
     * Formula: EMA = Price(t) * k + EMA(y) * (1 - k)
     * where k = 2 / (period + 1)
     * 
     * EDGE CASES HANDLED:
     * - Invalid period (<=0, non-integer, NaN, Infinity)
     * - Insufficient data
     * - NaN/Infinity in price data
     * - Empty array
     */
    calculateEMA(prices: number[], period: number): number[] {
        // Validate inputs
        if (!Array.isArray(prices)) {
            throw new Error('EMA: prices must be an array');
        }
        if (prices.length === 0) {
            throw new Error('EMA: prices array is empty');
        }
        if (!Number.isInteger(period) || period <= 0) {
            throw new Error(`EMA: period must be a positive integer, got ${period}`);
        }
        if (prices.length < period) {
            throw new Error(`Not enough data for EMA(${period}): need ${period}, got ${prices.length}`);
        }

        // Validate all prices are finite numbers
        for (let i = 0; i < prices.length; i++) {
            if (!Number.isFinite(prices[i])) {
                throw new Error(`EMA: Invalid price at index ${i}: ${prices[i]}`);
            }
        }

        const k = 2 / (period + 1);
        const ema: number[] = [];

        // Start with SMA for first value
        const sma = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

        // Validate SMA is finite (shouldn't happen if prices are validated, but defensive)
        if (!Number.isFinite(sma)) {
            throw new Error(`EMA: Calculated SMA is not finite: ${sma}`);
        }

        ema.push(sma);

        // Calculate EMA for remaining values
        for (let i = period; i < prices.length; i++) {
            const newEma = prices[i] * k + ema[ema.length - 1] * (1 - k);

            // Validate each EMA value
            if (!Number.isFinite(newEma)) {
                throw new Error(`EMA: Calculated EMA is not finite at index ${i}: ${newEma}`);
            }

            ema.push(newEma);
        }

        return ema;
    }

    /**
     * Calculate Relative Strength Index (RSI)
     * Formula: RSI = 100 - (100 / (1 + RS))
     * where RS = Average Gain / Average Loss
     * 
     * EDGE CASES HANDLED:
     * - Invalid period
     * - Insufficient data
     * - All gains or all losses (division by zero)
     * - NaN/Infinity in price data
     * - Flat prices (no changes)
     */
    calculateRSI(prices: number[], period: number = 14): number[] {
        // Validate inputs
        if (!Array.isArray(prices)) {
            throw new Error('RSI: prices must be an array');
        }
        if (prices.length === 0) {
            throw new Error('RSI: prices array is empty');
        }
        if (!Number.isInteger(period) || period <= 0) {
            throw new Error(`RSI: period must be a positive integer, got ${period}`);
        }
        if (prices.length < period + 1) {
            throw new Error(`Not enough data for RSI(${period}): need ${period + 1}, got ${prices.length}`);
        }

        // Validate all prices are finite numbers
        for (let i = 0; i < prices.length; i++) {
            if (!Number.isFinite(prices[i])) {
                throw new Error(`RSI: Invalid price at index ${i}: ${prices[i]}`);
            }
        }

        const changes: number[] = [];
        for (let i = 1; i < prices.length; i++) {
            changes.push(prices[i] - prices[i - 1]);
        }

        const gains = changes.map(c => c > 0 ? c : 0);
        const losses = changes.map(c => c < 0 ? -c : 0);

        const rsi: number[] = [];

        // Calculate first RSI using simple average
        let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
        let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;

        // Handle edge case: all losses (avgGain = 0) → RSI = 0
        // Handle edge case: all gains (avgLoss = 0) → RSI = 100
        let rs: number;
        let rsiValue: number;

        if (avgLoss === 0) {
            rsiValue = avgGain === 0 ? 50 : 100; // Flat prices = 50, all gains = 100
        } else {
            rs = avgGain / avgLoss;
            rsiValue = 100 - (100 / (1 + rs));
        }

        // Validate RSI is in valid range [0, 100]
        if (!Number.isFinite(rsiValue) || rsiValue < 0 || rsiValue > 100) {
            throw new Error(`RSI: Calculated RSI out of range [0, 100]: ${rsiValue}`);
        }

        rsi.push(rsiValue);

        // Calculate subsequent RSI using smoothed averages
        for (let i = period; i < changes.length; i++) {
            avgGain = (avgGain * (period - 1) + gains[i]) / period;
            avgLoss = (avgLoss * (period - 1) + losses[i]) / period;

            if (avgLoss === 0) {
                rsiValue = avgGain === 0 ? 50 : 100;
            } else {
                rs = avgGain / avgLoss;
                rsiValue = 100 - (100 / (1 + rs));
            }

            // Validate each RSI value
            if (!Number.isFinite(rsiValue) || rsiValue < 0 || rsiValue > 100) {
                throw new Error(`RSI: Calculated RSI out of range at index ${i}: ${rsiValue}`);
            }

            rsi.push(rsiValue);
        }

        return rsi;
    }

    /**
     * Calculate MACD (Moving Average Convergence Divergence)
     * MACD Line = EMA(12) - EMA(26)
     * Signal Line = EMA(9) of MACD Line
     * Histogram = MACD Line - Signal Line
     * 
     * EDGE CASES HANDLED:
     * - Invalid periods
     * - Insufficient data
     * - Array alignment issues
     */
    calculateMACD(prices: number[], fastPeriod: number = 12, slowPeriod: number = 26, signalPeriod: number = 9): MACDResult {
        // Validate inputs
        if (!Array.isArray(prices)) {
            throw new Error('MACD: prices must be an array');
        }
        if (prices.length === 0) {
            throw new Error('MACD: prices array is empty');
        }
        if (!Number.isInteger(fastPeriod) || fastPeriod <= 0) {
            throw new Error(`MACD: fastPeriod must be a positive integer, got ${fastPeriod}`);
        }
        if (!Number.isInteger(slowPeriod) || slowPeriod <= 0) {
            throw new Error(`MACD: slowPeriod must be a positive integer, got ${slowPeriod}`);
        }
        if (!Number.isInteger(signalPeriod) || signalPeriod <= 0) {
            throw new Error(`MACD: signalPeriod must be a positive integer, got ${signalPeriod}`);
        }
        if (fastPeriod >= slowPeriod) {
            throw new Error(`MACD: fastPeriod (${fastPeriod}) must be less than slowPeriod (${slowPeriod})`);
        }
        if (prices.length < slowPeriod + signalPeriod) {
            throw new Error(`Not enough data for MACD: need ${slowPeriod + signalPeriod}, got ${prices.length}`);
        }

        const emaFast = this.calculateEMA(prices, fastPeriod);
        const emaSlow = this.calculateEMA(prices, slowPeriod);

        // Align arrays (emaSlow is shorter because it needs more data to start)
        const offset = emaFast.length - emaSlow.length;

        // Validate offset is non-negative
        if (offset < 0) {
            throw new Error(`MACD: Array alignment error - offset is negative: ${offset}`);
        }

        const macdLine = emaSlow.map((slow, i) => emaFast[i + offset] - slow);

        // Validate MACD line has enough data for signal line
        if (macdLine.length < signalPeriod) {
            throw new Error(`MACD: Not enough MACD line data for signal line: need ${signalPeriod}, got ${macdLine.length}`);
        }

        const signalLine = this.calculateEMA(macdLine, signalPeriod);

        // Get latest values
        const macd = macdLine[macdLine.length - 1];
        const signal = signalLine[signalLine.length - 1];
        const histogram = macd - signal;

        // Validate all values are finite
        if (!Number.isFinite(macd) || !Number.isFinite(signal) || !Number.isFinite(histogram)) {
            throw new Error(`MACD: Calculated values are not finite - macd: ${macd}, signal: ${signal}, histogram: ${histogram}`);
        }

        return { macd, signal, histogram };
    }

    /**
     * Calculate Average True Range (ATR)
     * Measures volatility
     * 
     * EDGE CASES HANDLED:
     * - Invalid period
     * - Insufficient candles
     * - Invalid candle data (missing fields, NaN values)
     * - Zero/negative prices
     */
    calculateATR(candles: WeexCandle[], period: number = 14): number {
        // Validate inputs
        if (!Array.isArray(candles)) {
            throw new Error('ATR: candles must be an array');
        }
        if (candles.length === 0) {
            throw new Error('ATR: candles array is empty');
        }
        if (!Number.isInteger(period) || period <= 0) {
            throw new Error(`ATR: period must be a positive integer, got ${period}`);
        }
        if (candles.length < period + 1) {
            throw new Error(`Not enough data for ATR(${period}): need ${period + 1}, got ${candles.length}`);
        }

        const trueRanges: number[] = [];

        for (let i = 1; i < candles.length; i++) {
            // Validate candle structure
            if (!candles[i] || !candles[i - 1]) {
                throw new Error(`ATR: Invalid candle at index ${i}`);
            }
            if (typeof candles[i].high !== 'string' || typeof candles[i].low !== 'string' || typeof candles[i - 1].close !== 'string') {
                throw new Error(`ATR: Candle fields must be strings at index ${i}`);
            }

            const high = parseFloat(candles[i].high);
            const low = parseFloat(candles[i].low);
            const prevClose = parseFloat(candles[i - 1].close);

            // Validate parsed values
            if (!Number.isFinite(high) || high <= 0) {
                throw new Error(`ATR: Invalid high at index ${i}: ${candles[i].high}`);
            }
            if (!Number.isFinite(low) || low <= 0) {
                throw new Error(`ATR: Invalid low at index ${i}: ${candles[i].low}`);
            }
            if (!Number.isFinite(prevClose) || prevClose <= 0) {
                throw new Error(`ATR: Invalid previous close at index ${i - 1}: ${candles[i - 1].close}`);
            }

            // Validate high >= low
            if (high < low) {
                throw new Error(`ATR: High (${high}) < Low (${low}) at index ${i}`);
            }

            const tr = Math.max(
                high - low,
                Math.abs(high - prevClose),
                Math.abs(low - prevClose)
            );

            // Validate true range is non-negative and finite
            if (!Number.isFinite(tr) || tr < 0) {
                throw new Error(`ATR: Invalid true range at index ${i}: ${tr}`);
            }

            trueRanges.push(tr);
        }

        // Calculate ATR using RMA (Wilder's smoothing) - the industry standard
        // RMA formula: RMA = (prev_RMA * (period - 1) + current_TR) / period
        // First value uses SMA as seed, then applies RMA smoothing
        // This matches TradingView's default ATR calculation

        // Seed with SMA of first 'period' true ranges
        const seedTR = trueRanges.slice(0, period);
        let atr = seedTR.reduce((a, b) => a + b, 0) / period;

        // Apply RMA smoothing for remaining values
        for (let i = period; i < trueRanges.length; i++) {
            atr = (atr * (period - 1) + trueRanges[i]) / period;
        }

        // Validate ATR is finite and non-negative
        if (!Number.isFinite(atr) || atr < 0) {
            throw new Error(`ATR: Calculated ATR is invalid: ${atr}`);
        }

        return atr;
    }

    /**
     * Calculate Bollinger Bands
     * Middle Band = SMA(period)
     * Upper Band = Middle + (stdDev * multiplier)
     * Lower Band = Middle - (stdDev * multiplier)
     * 
     * EDGE CASES HANDLED:
     * - Invalid period or multiplier
     * - Insufficient data
     * - Zero variance (flat prices)
     * - NaN/Infinity in calculations
     * - Negative lower band (can happen with high multiplier and low prices)
     */
    calculateBollingerBands(prices: number[], period: number = 20, stdDevMultiplier: number = 2): BollingerBandsResult {
        // Validate inputs
        if (!Array.isArray(prices)) {
            throw new Error('Bollinger Bands: prices must be an array');
        }
        if (prices.length === 0) {
            throw new Error('Bollinger Bands: prices array is empty');
        }
        if (!Number.isInteger(period) || period <= 0) {
            throw new Error(`Bollinger Bands: period must be a positive integer, got ${period}`);
        }
        if (!Number.isFinite(stdDevMultiplier) || stdDevMultiplier <= 0) {
            throw new Error(`Bollinger Bands: stdDevMultiplier must be a positive number, got ${stdDevMultiplier}`);
        }
        if (prices.length < period) {
            throw new Error(`Not enough data for Bollinger Bands(${period}): need ${period}, got ${prices.length}`);
        }

        // Validate all prices are finite
        for (let i = 0; i < prices.length; i++) {
            if (!Number.isFinite(prices[i])) {
                throw new Error(`Bollinger Bands: Invalid price at index ${i}: ${prices[i]}`);
            }
        }

        const recentPrices = prices.slice(-period);
        const middle = recentPrices.reduce((a, b) => a + b, 0) / period;

        // Validate middle is finite
        if (!Number.isFinite(middle)) {
            throw new Error(`Bollinger Bands: Calculated middle band is not finite: ${middle}`);
        }

        const variance = recentPrices.reduce((sum, price) => sum + Math.pow(price - middle, 2), 0) / period;

        // Validate variance is non-negative and finite
        if (!Number.isFinite(variance) || variance < 0) {
            throw new Error(`Bollinger Bands: Calculated variance is invalid: ${variance}`);
        }

        const stdDev = Math.sqrt(variance);

        // Validate stdDev is finite
        if (!Number.isFinite(stdDev)) {
            throw new Error(`Bollinger Bands: Calculated standard deviation is not finite: ${stdDev}`);
        }

        const upper = middle + (stdDev * stdDevMultiplier);
        const lower = middle - (stdDev * stdDevMultiplier);

        // Validate bands are finite
        if (!Number.isFinite(upper) || !Number.isFinite(lower)) {
            throw new Error(`Bollinger Bands: Calculated bands are not finite - upper: ${upper}, lower: ${lower}`);
        }

        // Validate band ordering (upper >= middle >= lower)
        if (upper < middle || middle < lower) {
            throw new Error(`Bollinger Bands: Invalid band ordering - upper: ${upper}, middle: ${middle}, lower: ${lower}`);
        }

        // EDGE CASE: Lower band can be negative with high multiplier and low prices
        // This is mathematically valid but may indicate unusual market conditions
        // We don't throw an error but the caller should be aware
        // Note: For price-based indicators, negative lower band is unusual but possible

        return {
            upper,
            middle,
            lower,
        };
    }

    calculateDonchianChannel(candles: WeexCandle[], period: number = 20): { upper: number; middle: number; lower: number } {
        if (!Array.isArray(candles)) {
            throw new Error('Donchian: candles must be an array');
        }
        if (!Number.isInteger(period) || period <= 0) {
            throw new Error(`Donchian: period must be a positive integer, got ${period}`);
        }
        if (candles.length < period) {
            throw new Error(`Not enough data for Donchian(${period}): need ${period}, got ${candles.length}`);
        }

        const window = candles.slice(-period);
        let upper = -Infinity;
        let lower = Infinity;

        for (let i = 0; i < window.length; i++) {
            const high = parseFloat(window[i].high);
            const low = parseFloat(window[i].low);
            if (!Number.isFinite(high) || high <= 0) {
                throw new Error(`Donchian: Invalid high at index ${i}: ${window[i].high}`);
            }
            if (!Number.isFinite(low) || low <= 0) {
                throw new Error(`Donchian: Invalid low at index ${i}: ${window[i].low}`);
            }
            if (high < low) {
                throw new Error(`Donchian: High (${high}) < Low (${low}) at index ${i}`);
            }
            if (high > upper) upper = high;
            if (low < lower) lower = low;
        }

        if (!Number.isFinite(upper) || !Number.isFinite(lower)) {
            throw new Error(`Donchian: Calculated bounds invalid - upper: ${upper}, lower: ${lower}`);
        }

        const middle = (upper + lower) / 2;
        if (!Number.isFinite(middle)) {
            throw new Error(`Donchian: Calculated middle is invalid: ${middle}`);
        }

        return { upper, middle, lower };
    }
}
