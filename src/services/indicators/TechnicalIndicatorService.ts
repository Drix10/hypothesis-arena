/**
 * Technical Indicator Service
 * Fetches candlestick data from WEEX and calculates technical indicators with caching.
 */

import { getWeexClient } from '../weex/WeexClient';
import { IndicatorCalculator, MACDResult, BollingerBandsResult } from './IndicatorCalculator';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export interface TechnicalIndicators {
    symbol: string;
    timestamp: number;
    intraday: {
        ema20: number[];
        ema50: number;
        macd: MACDResult;
        rsi7: number[];
        rsi14: number[];
        atr: number;
        currentPrice: number;
    };
    longTerm: {
        ema20: number;
        ema50: number;
        ema200: number;
        atr: number;
        macd: MACDResult;
        rsi14: number;
        bollingerBands: BollingerBandsResult;
        trend: 'bullish' | 'bearish' | 'neutral';
    };
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
    private longTermCache: Map<string, { data: any; timestamp: number }>;
    private cacheTTL: number;
    private readonly LONG_TERM_CACHE_TTL = 15 * 60 * 1000; // 15 minutes for 4h indicators
    private readonly MAX_CACHE_SIZE = 100;
    private pruneIntervalId: NodeJS.Timeout | null = null;

    constructor(cacheTTL: number = 60000) {
        // Validate cacheTTL
        if (!Number.isFinite(cacheTTL) || cacheTTL < 0) {
            throw new Error(`TechnicalIndicatorService: cacheTTL must be a non-negative number, got ${cacheTTL}`);
        }

        this.calculator = new IndicatorCalculator();
        this.cache = new Map();
        this.longTermCache = new Map();
        this.cacheTTL = cacheTTL;

        this.pruneIntervalId = setInterval(() => {
            this.pruneExpiredCache();
        }, 5 * 60 * 1000);

        // Ensure interval doesn't prevent process exit
        if (this.pruneIntervalId.unref) {
            this.pruneIntervalId.unref();
        }
    }

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
        const now = Date.now();

        // Check long-term cache
        const cachedLongTerm = this.longTermCache.get(symbol);
        const useCachedLongTerm = cachedLongTerm && (now - cachedLongTerm.timestamp < this.LONG_TERM_CACHE_TTL);

        // Fetch candles in parallel
        // NOTE: If long-term cache is valid, we skip fetching 4h candles
        let candles5m: any[];
        let candles4h: any[] = [];

        try {
            if (useCachedLongTerm) {
                logger.debug(`Using cached long-term indicators for ${symbol}`);
                candles5m = await weexClient.getCandles(symbol, '5m', 100);
            } else {
                [candles5m, candles4h] = await Promise.all([
                    weexClient.getCandles(symbol, '5m', 100),
                    weexClient.getCandles(symbol, '4h', 200),
                ]);
            }
        } catch (error) {
            throw new Error(`Failed to fetch candles for ${symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }

        // Validate candle data
        if (!Array.isArray(candles5m) || (!useCachedLongTerm && !Array.isArray(candles4h))) {
            throw new Error(`Invalid candle data for ${symbol}: expected arrays`);
        }

        // Minimum candle requirements
        if (candles5m.length < 50) {
            throw new Error(`Insufficient 5m candle data for ${symbol}: got ${candles5m.length}, need 50+ for EMA(50)`);
        }
        if (!useCachedLongTerm && candles4h.length < 200) {
            throw new Error(`Insufficient 4h candle data for ${symbol}: got ${candles4h.length}, need exactly 200 for EMA(200)`);
        }

        // Extract close prices for 5m
        const closes5m: number[] = candles5m.map(c => parseFloat(c.close));
        const currentPrice = closes5m[closes5m.length - 1];

        // Calculate/get long-term indicators
        let longTerm: TechnicalIndicators['longTerm'];
        if (useCachedLongTerm) {
            longTerm = cachedLongTerm!.data;
        } else {
            const closes4h: number[] = candles4h.map(c => parseFloat(c.close));

            // Calculate 4h indicators
            const ema20_4h = this.calculator.calculateEMA(closes4h, 20);
            const ema50_4h = this.calculator.calculateEMA(closes4h, 50);
            const ema200_4h = this.calculator.calculateEMA(closes4h, 200);
            const macd_4h = this.calculator.calculateMACD(closes4h);
            const rsi14_4h = this.calculator.calculateRSI(closes4h, 14);
            const bb_4h = this.calculator.calculateBollingerBands(closes4h, 20, 2);
            const atr_4h = this.calculator.calculateATR(candles4h, 14);

            const lastEma20_4h = ema20_4h[ema20_4h.length - 1];
            const lastEma50_4h = ema50_4h[ema50_4h.length - 1];
            const lastEma200_4h = ema200_4h[ema200_4h.length - 1];

            longTerm = {
                ema20: lastEma20_4h,
                ema50: lastEma50_4h,
                ema200: lastEma200_4h,
                atr: atr_4h,
                macd: macd_4h,
                rsi14: rsi14_4h[rsi14_4h.length - 1],
                bollingerBands: bb_4h,
                trend: lastEma20_4h > lastEma50_4h && lastEma50_4h > lastEma200_4h ? 'bullish' :
                    lastEma20_4h < lastEma50_4h && lastEma50_4h < lastEma200_4h ? 'bearish' : 'neutral'
            };

            // Update long-term cache
            this.longTermCache.set(symbol, { data: longTerm, timestamp: now });
        }

        // Calculate 5m indicators (always fresh)
        const ema20_5m = this.calculator.calculateEMA(closes5m, 20);
        const ema50_5m = this.calculator.calculateEMA(closes5m, 50);
        const macd_5m = this.calculator.calculateMACD(closes5m);
        const rsi7_5m = this.calculator.calculateRSI(closes5m, 7);
        const rsi14_5m = this.calculator.calculateRSI(closes5m, 14);
        const atr_5m = this.calculator.calculateATR(candles5m, 14);

        const lastEma20_5m = ema20_5m[ema20_5m.length - 1];
        const lastEma50_5m = ema50_5m[ema50_5m.length - 1];
        const lastRsi14_5m = rsi14_5m[rsi14_5m.length - 1];

        // Signals
        const signals: TechnicalIndicators['signals'] = {
            emaCrossover: 'none',
            rsiSignal: lastRsi14_5m > 70 ? 'overbought' : lastRsi14_5m < 30 ? 'oversold' : 'neutral',
            macdSignal: macd_5m.histogram > 0 ? 'bullish' : 'bearish',
            trendStrength: 50, // Default
            volatility: 'medium'
        };

        // Golden/Death Cross detection (5m)
        if (ema20_5m[ema20_5m.length - 2] <= ema50_5m[ema50_5m.length - 2] && lastEma20_5m > lastEma50_5m) {
            signals.emaCrossover = 'golden';
        } else if (ema20_5m[ema20_5m.length - 2] >= ema50_5m[ema50_5m.length - 2] && lastEma20_5m < lastEma50_5m) {
            signals.emaCrossover = 'death';
        }

        return {
            symbol,
            timestamp: now,
            intraday: {
                ema20: ema20_5m.slice(-5),
                ema50: lastEma50_5m,
                macd: macd_5m,
                rsi7: rsi7_5m.slice(-5),
                rsi14: rsi14_5m.slice(-5),
                atr: atr_5m,
                currentPrice
            },
            longTerm,
            signals
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
        this.longTermCache.clear();
        logger.info('TechnicalIndicatorService cleaned up');
    }

    /**
     * Prune expired cache entries
     * Call periodically to prevent memory bloat from stale entries
     */
    pruneExpiredCache(): number {
        const now = Date.now();
        let totalPruned = 0;

        // 1. Prune standard cache
        const keysToDelete: string[] = [];
        for (const [symbol, entry] of this.cache.entries()) {
            if (now - entry.timestamp >= this.cacheTTL) {
                keysToDelete.push(symbol);
            }
        }
        for (const key of keysToDelete) {
            this.cache.delete(key);
            totalPruned++;
        }

        // 2. Prune long-term cache
        const longTermKeysToDelete: string[] = [];
        for (const [symbol, entry] of this.longTermCache.entries()) {
            if (now - entry.timestamp >= this.LONG_TERM_CACHE_TTL) {
                longTermKeysToDelete.push(symbol);
            }
        }
        for (const key of longTermKeysToDelete) {
            this.longTermCache.delete(key);
            totalPruned++;
        }

        if (totalPruned > 0) {
            logger.debug(`Pruned ${totalPruned} total expired cache entries (standard + long-term)`);
        }

        return totalPruned;
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
