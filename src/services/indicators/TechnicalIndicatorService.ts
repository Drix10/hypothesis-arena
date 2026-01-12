/**
 * Technical Indicator Service
 * 
 * Fetches candlestick data from WEEX and calculates technical indicators.
 * Implements caching to avoid recalculating on every request.
 */

import { getWeexClient } from '../weex/WeexClient';
import { IndicatorCalculator, MACDResult, BollingerBandsResult } from './IndicatorCalculator';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export interface TechnicalIndicators {
    symbol: string;
    timestamp: number;

    // 5-minute timeframe (intraday/scalping)
    intraday: {
        ema20: number[];      // Last 5 values
        ema50: number;        // Current value
        macd: MACDResult;     // Current MACD values
        rsi7: number[];       // Last 5 RSI(7) values
        rsi14: number[];      // Last 5 RSI(14) values
        atr: number;          // Current ATR
        currentPrice: number;
    };

    // 4-hour timeframe (trend/swing)
    longTerm: {
        ema20: number;        // Current EMA20
        ema50: number;        // Current EMA50
        ema200: number;       // Current EMA200
        atr: number;          // Current ATR
        macd: MACDResult;     // Current MACD
        rsi14: number;        // Current RSI
        bollingerBands: BollingerBandsResult;
        trend: 'bullish' | 'bearish' | 'neutral';
    };

    // Derived signals
    signals: {
        emaCrossover: 'golden' | 'death' | 'none';
        rsiSignal: 'overbought' | 'oversold' | 'neutral';
        macdSignal: 'bullish' | 'bearish' | 'neutral';
        trendStrength: number; // 0-100
        volatility: 'low' | 'medium' | 'high';
    };
}

export class TechnicalIndicatorService {
    private calculator: IndicatorCalculator;
    private cache: Map<string, { data: TechnicalIndicators; timestamp: number; lastAccessed: number }>;
    private cacheTTL: number;
    private readonly MAX_CACHE_SIZE = 100; // Prevent unbounded memory growth
    private pruneIntervalId: NodeJS.Timeout | null = null; // FIXED: Auto-prune interval

    constructor(cacheTTL: number = 60000) {
        // Validate cacheTTL
        if (!Number.isFinite(cacheTTL) || cacheTTL < 0) {
            throw new Error(`TechnicalIndicatorService: cacheTTL must be a non-negative number, got ${cacheTTL}`);
        }

        this.calculator = new IndicatorCalculator();
        this.cache = new Map();
        this.cacheTTL = cacheTTL;

        // FIXED: Start automatic cache pruning every 5 minutes
        this.pruneIntervalId = setInterval(() => {
            this.pruneExpiredCache();
        }, 5 * 60 * 1000);

        // Ensure interval doesn't prevent process exit
        if (this.pruneIntervalId.unref) {
            this.pruneIntervalId.unref();
        }
    }

    /**
     * Get technical indicators for a symbol
     * Uses cache if available and not expired
     * 
     * MEMORY LEAK PREVENTION:
     * - Cache size limited to MAX_CACHE_SIZE entries
     * - True LRU eviction based on lastAccessed timestamp
     * 
     * EDGE CASES HANDLED:
     * - Invalid symbol (empty, null, non-string)
     * - Cache corruption (invalid entry structure)
     * 
     * NOTE ON SYMBOL NORMALIZATION:
     * Symbols are normalized to lowercase internally for cache keys.
     * This means 'CMT_BTCUSDT' and 'cmt_btcusdt' will share the same cache entry.
     * The returned TechnicalIndicators.symbol will be the normalized (lowercase) version.
     * 
     * Both getIndicators() and getIndicatorsForSymbols() use normalized (lowercase) keys
     * in their returned Maps/results for consistency.
     */
    async getIndicators(symbol: string): Promise<TechnicalIndicators> {
        // Validate symbol
        if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
            throw new Error(`TechnicalIndicatorService: Invalid symbol: ${symbol}`);
        }

        // Normalize symbol to prevent cache key collisions
        const normalizedSymbol = symbol.trim().toLowerCase();

        // Check cache
        const cached = this.cache.get(normalizedSymbol);
        if (cached && cached.data && cached.timestamp && Date.now() - cached.timestamp < this.cacheTTL) {
            logger.debug(`Using cached indicators for ${normalizedSymbol}`);
            // Update lastAccessed for LRU tracking
            cached.lastAccessed = Date.now();
            return cached.data;
        }

        // Fetch and calculate
        logger.debug(`Calculating fresh indicators for ${normalizedSymbol}`);
        const indicators = await this.calculateIndicators(normalizedSymbol);

        // Evict least recently used entry if cache is full (true LRU)
        if (this.cache.size >= this.MAX_CACHE_SIZE) {
            let oldestKey: string | null = null;
            let oldestTime = Infinity;
            for (const [key, entry] of this.cache.entries()) {
                if (entry.lastAccessed < oldestTime) {
                    oldestTime = entry.lastAccessed;
                    oldestKey = key;
                }
            }
            if (oldestKey) {
                this.cache.delete(oldestKey);
                logger.debug(`Evicted LRU cache entry: ${oldestKey}`);
            }
        }

        // Update cache with lastAccessed timestamp
        const now = Date.now();
        this.cache.set(normalizedSymbol, { data: indicators, timestamp: now, lastAccessed: now });

        return indicators;
    }

    /**
     * Get indicators for multiple symbols in parallel
     * 
     * EDGE CASES HANDLED:
     * - Empty symbols array
     * - Duplicate symbols (deduplicated before processing)
     * - Invalid symbols (filtered out)
     * - Partial failures (some symbols succeed, others fail)
     * 
     * NOTE ON MAP KEYS: The returned Map is keyed by the NORMALIZED (lowercase) symbol.
     * This is consistent with the internal cache which also uses normalized keys.
     * Example:
     * - Input: ['CMT_BTCUSDT', 'cmt_ethusdt'] 
     * - Output Map keys: ['cmt_btcusdt', 'cmt_ethusdt']
     * 
     * Callers should normalize their lookup keys using symbol.toLowerCase() when
     * accessing the returned Map, or use the exact keys from Map.keys().
     */
    async getIndicatorsForSymbols(symbols: string[]): Promise<Map<string, TechnicalIndicators>> {
        // Validate input
        if (!Array.isArray(symbols)) {
            throw new Error('TechnicalIndicatorService: symbols must be an array');
        }
        if (symbols.length === 0) {
            logger.warn('TechnicalIndicatorService: Empty symbols array provided');
            return new Map();
        }

        // Remove duplicates and invalid symbols, normalize to lowercase
        const uniqueSymbols = [...new Set(
            symbols
                .filter(s => s && typeof s === 'string')
                .map(s => s.trim().toLowerCase())
        )];

        if (uniqueSymbols.length === 0) {
            logger.warn('TechnicalIndicatorService: No valid symbols after filtering');
            return new Map();
        }

        const results = await Promise.all(
            uniqueSymbols.map(async symbol => {
                try {
                    const indicators = await this.getIndicators(symbol);
                    return { symbol, indicators, error: null };
                } catch (error) {
                    logger.error(`Failed to get indicators for ${symbol}:`, error);
                    return { symbol, indicators: null, error };
                }
            })
        );

        const map = new Map<string, TechnicalIndicators>();
        let successCount = 0;
        let failureCount = 0;

        results.forEach(({ symbol, indicators }) => {
            if (indicators) {
                // Use normalized symbol as key for consistency
                map.set(symbol, indicators);
                successCount++;
            } else {
                failureCount++;
            }
        });

        logger.info(`Fetched indicators for ${successCount}/${uniqueSymbols.length} symbols (${failureCount} failures)`);

        return map;
    }

    /**
     * Calculate all technical indicators for a symbol
     * 
     * EDGE CASES HANDLED:
     * - Insufficient candle data
     * - Invalid candle data
     * - Division by zero in calculations
     * - Array index out of bounds
     * - NaN/Infinity propagation
     */
    private async calculateIndicators(symbol: string): Promise<TechnicalIndicators> {
        const weexClient = getWeexClient();

        // Fetch candles in parallel
        // NOTE: Timeout protection is handled at the WeexClient level via request timeouts
        let candles5m: any[];
        let candles4h: any[];

        try {
            [candles5m, candles4h] = await Promise.all([
                weexClient.getCandles(symbol, '5m', 100),
                weexClient.getCandles(symbol, '4h', 200),
            ]);
        } catch (error) {
            throw new Error(`Failed to fetch candles for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Validate candle data
        if (!Array.isArray(candles5m) || !Array.isArray(candles4h)) {
            throw new Error(`Invalid candle data for ${symbol}: expected arrays`);
        }

        // Minimum candle requirements:
        // - 5m: 50 candles needed for EMA(50) calculation (warmup period)
        // - 4h: 200 candles needed for EMA(200) calculation (warmup period)
        // These are hard minimums - calculations will fail with less data.
        // The actual fetch limits (100 for 5m, 200 for 4h) provide buffer for warmup.
        // NOTE: We request exactly 200 4h candles, which is the minimum for EMA(200).
        // If the exchange returns fewer (e.g., new listing), this will fail gracefully.
        if (candles5m.length < 50) {
            throw new Error(`Insufficient 5m candle data for ${symbol}: got ${candles5m.length}, need 50+ for EMA(50)`);
        }
        if (candles4h.length < 200) {
            // FIXED: More descriptive error message explaining the EMA(200) requirement
            throw new Error(`Insufficient 4h candle data for ${symbol}: got ${candles4h.length}, need exactly 200 for EMA(200). ` +
                `This may occur for newly listed assets or if the exchange API returned partial data.`);
        }

        // Extract close prices with validation
        const closes5m: number[] = [];
        const closes4h: number[] = [];

        for (let i = 0; i < candles5m.length; i++) {
            const close = parseFloat(candles5m[i]?.close);
            if (!Number.isFinite(close) || close <= 0) {
                throw new Error(`Invalid 5m close price at index ${i} for ${symbol}: ${candles5m[i]?.close}`);
            }
            closes5m.push(close);
        }

        for (let i = 0; i < candles4h.length; i++) {
            const close = parseFloat(candles4h[i]?.close);
            if (!Number.isFinite(close) || close <= 0) {
                throw new Error(`Invalid 4h close price at index ${i} for ${symbol}: ${candles4h[i]?.close}`);
            }
            closes4h.push(close);
        }

        // Calculate intraday indicators (5m) with error handling
        let ema20_5m: number[], ema50_5m: number[], rsi7_5m: number[], rsi14_5m: number[];
        let macd5m: MACDResult, atr5m: number;

        try {
            ema20_5m = this.calculator.calculateEMA(closes5m, 20);
            ema50_5m = this.calculator.calculateEMA(closes5m, 50);
            rsi7_5m = this.calculator.calculateRSI(closes5m, 7);
            rsi14_5m = this.calculator.calculateRSI(closes5m, 14);
            macd5m = this.calculator.calculateMACD(closes5m);
            atr5m = this.calculator.calculateATR(candles5m, 14);

            // FIXED: Validate MACD result structure
            if (!macd5m || typeof macd5m !== 'object') {
                throw new Error('MACD calculation returned invalid result');
            }
            if (!Number.isFinite(macd5m.macd) || !Number.isFinite(macd5m.signal) || !Number.isFinite(macd5m.histogram)) {
                throw new Error(`MACD values are not finite: macd=${macd5m.macd}, signal=${macd5m.signal}, histogram=${macd5m.histogram}`);
            }
        } catch (error) {
            throw new Error(`Failed to calculate 5m indicators for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Calculate long-term indicators (4h) with error handling
        let ema20_4h: number[], ema50_4h: number[], ema200_4h: number[];
        let rsi14_4h: number[], macd4h: MACDResult, atr4h: number, bb4h: BollingerBandsResult;

        try {
            ema20_4h = this.calculator.calculateEMA(closes4h, 20);
            ema50_4h = this.calculator.calculateEMA(closes4h, 50);
            ema200_4h = this.calculator.calculateEMA(closes4h, 200);
            rsi14_4h = this.calculator.calculateRSI(closes4h, 14);
            macd4h = this.calculator.calculateMACD(closes4h);
            atr4h = this.calculator.calculateATR(candles4h, 14);
            bb4h = this.calculator.calculateBollingerBands(closes4h, 20, 2);

            // FIXED: Validate MACD result structure
            if (!macd4h || typeof macd4h !== 'object') {
                throw new Error('4h MACD calculation returned invalid result');
            }
            if (!Number.isFinite(macd4h.macd) || !Number.isFinite(macd4h.signal) || !Number.isFinite(macd4h.histogram)) {
                throw new Error(`4h MACD values are not finite: macd=${macd4h.macd}, signal=${macd4h.signal}, histogram=${macd4h.histogram}`);
            }

            // FIXED: Validate Bollinger Bands result structure
            if (!bb4h || typeof bb4h !== 'object') {
                throw new Error('Bollinger Bands calculation returned invalid result');
            }
            if (!Number.isFinite(bb4h.upper) || !Number.isFinite(bb4h.middle) || !Number.isFinite(bb4h.lower)) {
                throw new Error(`Bollinger Bands values are not finite: upper=${bb4h.upper}, middle=${bb4h.middle}, lower=${bb4h.lower}`);
            }
            // Validate band ordering (upper >= middle >= lower)
            if (bb4h.upper < bb4h.middle || bb4h.middle < bb4h.lower) {
                throw new Error(`Bollinger Bands ordering invalid: upper=${bb4h.upper}, middle=${bb4h.middle}, lower=${bb4h.lower}`);
            }
        } catch (error) {
            throw new Error(`Failed to calculate 4h indicators for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Safely extract current values with bounds checking
        // FIXED: Validate arrays have at least one element before accessing
        if (ema20_4h.length === 0 || ema50_4h.length === 0 || ema200_4h.length === 0) {
            throw new Error(`Empty EMA arrays for ${symbol}`);
        }
        // FIXED: Validate ema20_5m array
        if (ema20_5m.length === 0) {
            throw new Error(`Empty EMA20 5m array for ${symbol}`);
        }
        // FIXED: Validate rsi7_5m array (was missing validation)
        if (rsi7_5m.length === 0) {
            throw new Error(`Empty RSI7 5m array for ${symbol}`);
        }
        if (rsi14_5m.length === 0) {
            throw new Error(`Empty RSI14 5m array for ${symbol}`);
        }
        if (ema50_5m.length === 0) {
            throw new Error(`Empty EMA50 5m array for ${symbol}`);
        }
        if (rsi14_4h.length === 0) {
            throw new Error(`Empty RSI 4h array for ${symbol}`);
        }

        const currentEma20_4h = ema20_4h[ema20_4h.length - 1];
        const currentEma50_4h = ema50_4h[ema50_4h.length - 1];
        const currentEma200_4h = ema200_4h[ema200_4h.length - 1];

        // Validate extracted values
        if (!Number.isFinite(currentEma20_4h) || !Number.isFinite(currentEma50_4h) || !Number.isFinite(currentEma200_4h)) {
            throw new Error(`Invalid EMA values for ${symbol}`);
        }

        // Determine trend
        let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (currentEma20_4h > currentEma50_4h && currentEma50_4h > currentEma200_4h) {
            trend = 'bullish';
        } else if (currentEma20_4h < currentEma50_4h && currentEma50_4h < currentEma200_4h) {
            trend = 'bearish';
        }

        // Calculate signals with bounds checking
        const currentPrice = closes5m[closes5m.length - 1];

        // Validate we have enough data for previous values
        if (ema20_4h.length < 2 || ema50_4h.length < 2) {
            throw new Error(`Not enough EMA data for crossover detection for ${symbol}`);
        }

        const prevEma20_4h = ema20_4h[ema20_4h.length - 2];
        const prevEma50_4h = ema50_4h[ema50_4h.length - 2];

        let emaCrossover: 'golden' | 'death' | 'none' = 'none';
        if (prevEma20_4h <= prevEma50_4h && currentEma20_4h > currentEma50_4h) {
            emaCrossover = 'golden';
        } else if (prevEma20_4h >= prevEma50_4h && currentEma20_4h < currentEma50_4h) {
            emaCrossover = 'death';
        }

        const currentRsi14_5m = rsi14_5m[rsi14_5m.length - 1];
        let rsiSignal: 'overbought' | 'oversold' | 'neutral' = 'neutral';
        if (currentRsi14_5m > 70) {
            rsiSignal = 'overbought';
        } else if (currentRsi14_5m < 30) {
            rsiSignal = 'oversold';
        }

        let macdSignal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
        if (macd5m.macd > macd5m.signal && macd5m.histogram > 0) {
            macdSignal = 'bullish';
        } else if (macd5m.macd < macd5m.signal && macd5m.histogram < 0) {
            macdSignal = 'bearish';
        }

        // Calculate trend strength (0-100) with division by zero protection
        const emaSpread = Math.abs(currentEma20_4h - currentEma50_4h);
        const trendStrength = currentPrice > 0
            ? Math.min(100, (emaSpread / currentPrice) * 100 * 20)
            : 0;

        // Validate trend strength
        if (!Number.isFinite(trendStrength) || trendStrength < 0 || trendStrength > 100) {
            throw new Error(`Invalid trend strength for ${symbol}: ${trendStrength}`);
        }

        // Determine volatility with division by zero protection
        const atrPercent = currentPrice > 0 ? (atr4h / currentPrice) * 100 : 0;
        let volatility: 'low' | 'medium' | 'high' = 'medium';
        if (atrPercent < 2) {
            volatility = 'low';
        } else if (atrPercent > 5) {
            volatility = 'high';
        }

        // Validate array slicing won't fail
        const ema20_5m_last5 = ema20_5m.length >= 5 ? ema20_5m.slice(-5) : ema20_5m;
        const rsi7_5m_last5 = rsi7_5m.length >= 5 ? rsi7_5m.slice(-5) : rsi7_5m;
        const rsi14_5m_last5 = rsi14_5m.length >= 5 ? rsi14_5m.slice(-5) : rsi14_5m;

        // FIXED: Validate ATR values are finite and non-negative
        if (!Number.isFinite(atr5m) || atr5m < 0) {
            throw new Error(`Invalid ATR 5m value for ${symbol}: ${atr5m}`);
        }
        if (!Number.isFinite(atr4h) || atr4h < 0) {
            throw new Error(`Invalid ATR 4h value for ${symbol}: ${atr4h}`);
        }

        return {
            symbol,
            timestamp: Date.now(),
            intraday: {
                ema20: ema20_5m_last5,
                ema50: ema50_5m[ema50_5m.length - 1],
                macd: macd5m,
                rsi7: rsi7_5m_last5,
                rsi14: rsi14_5m_last5,
                atr: atr5m,
                currentPrice,
            },
            longTerm: {
                ema20: currentEma20_4h,
                ema50: currentEma50_4h,
                ema200: currentEma200_4h,
                atr: atr4h,
                macd: macd4h,
                rsi14: rsi14_4h[rsi14_4h.length - 1],
                bollingerBands: bb4h,
                trend,
            },
            signals: {
                emaCrossover,
                rsiSignal,
                macdSignal,
                trendStrength,
                volatility,
            },
        };
    }

    /**
     * Clear cache for a symbol or all symbols
     * 
     * @param symbol - Optional symbol to clear (normalized internally). If not provided, clears all.
     */
    clearCache(symbol?: string): void {
        if (symbol) {
            // Normalize symbol for consistent cache key lookup
            const normalizedSymbol = symbol.trim().toLowerCase();
            this.cache.delete(normalizedSymbol);
            logger.debug(`Cleared indicator cache for ${normalizedSymbol}`);
        } else {
            this.cache.clear();
            logger.debug('Cleared all indicator cache');
        }
    }

    /**
     * Get cache statistics
     */
    getCacheStats(): { size: number; symbols: string[] } {
        return {
            size: this.cache.size,
            symbols: Array.from(this.cache.keys()),
        };
    }

    /**
     * Cleanup method to prevent memory leaks
     * Should be called when service is no longer needed
     */
    cleanup(): void {
        // FIXED: Clear the auto-prune interval
        if (this.pruneIntervalId) {
            clearInterval(this.pruneIntervalId);
            this.pruneIntervalId = null;
        }
        this.cache.clear();
        logger.info('TechnicalIndicatorService cleaned up');
    }

    /**
     * Prune expired cache entries
     * Call periodically to prevent memory bloat from stale entries
     */
    pruneExpiredCache(): number {
        const now = Date.now();
        // Collect keys to delete first to avoid modifying Map during iteration
        const keysToDelete: string[] = [];

        for (const [symbol, entry] of this.cache.entries()) {
            if (now - entry.timestamp >= this.cacheTTL) {
                keysToDelete.push(symbol);
            }
        }

        // Delete after iteration completes
        for (const key of keysToDelete) {
            this.cache.delete(key);
        }

        if (keysToDelete.length > 0) {
            logger.debug(`Pruned ${keysToDelete.length} expired cache entries`);
        }

        return keysToDelete.length;
    }
}

// Singleton instance
let indicatorServiceInstance: TechnicalIndicatorService | null = null;

/**
 * Get singleton instance of TechnicalIndicatorService
 * 
 * MEMORY LEAK PREVENTION:
 * - Single instance shared across application
 * - Cache size limited to 100 entries
 * - Call pruneExpiredCache() periodically to clean stale entries
 */
export function getTechnicalIndicatorService(): TechnicalIndicatorService {
    if (!indicatorServiceInstance) {
        // Validate config exists
        if (!config.indicators) {
            throw new Error('TechnicalIndicatorService: config.indicators is not defined');
        }

        // FIXED: Use ?? instead of || to allow cacheTTL=0 as valid value
        const cacheTTL = config.indicators.cacheTTL ?? 60000; // Default 60 seconds

        // Validate cacheTTL is reasonable
        // NOTE: cacheTTL=0 means "no caching" - every call fetches fresh data
        // This is valid but expensive, so we warn about it
        if (cacheTTL === 0) {
            logger.warn(`TechnicalIndicatorService: cacheTTL=0 disables caching entirely, every call will fetch fresh data`);
        } else if (cacheTTL < 1000) {
            logger.warn(`TechnicalIndicatorService: cacheTTL (${cacheTTL}ms) is very low, may cause excessive API calls`);
        }
        if (cacheTTL > 300000) {
            logger.warn(`TechnicalIndicatorService: cacheTTL (${cacheTTL}ms) is very high, indicators may be stale`);
        }

        indicatorServiceInstance = new TechnicalIndicatorService(cacheTTL);
        logger.info(`TechnicalIndicatorService initialized with cacheTTL=${cacheTTL}ms`);
    }
    return indicatorServiceInstance;
}

/**
 * Reset singleton instance (for testing or cleanup)
 * WARNING: This will clear all cached data
 */
export function resetTechnicalIndicatorService(): void {
    if (indicatorServiceInstance) {
        indicatorServiceInstance.cleanup();
        indicatorServiceInstance = null;
        logger.info('TechnicalIndicatorService singleton reset');
    }
}
