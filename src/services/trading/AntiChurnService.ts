/**
 * Anti-Churn Service for v5.0.0
 * 
 * Implements competitor's anti-churn rules:
 * 1. Cooldown after trades (15 minutes)
 * 2. Longer cooldown before flipping direction (30 minutes)
 * 3. Hysteresis - need stronger evidence to change than to keep
 * 4. Daily trade limit
 * 5. Funding threshold for action
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Cooldown state for a symbol
 * Exported for consumer type safety
 */
export interface CooldownState {
    lastTradeTime: number;
    lastDirection: 'LONG' | 'SHORT';
    cooldownUntil: number;
    flipCooldownUntil: number;
}

export class AntiChurnService {
    private cooldowns: Map<string, CooldownState> = new Map();
    private tradesExecutedToday: number = 0;
    private lastResetDate: string = '';

    // Per-symbol hourly trade tracking
    // Key: symbol, Value: array of trade timestamps (ms)
    private symbolTradeHistory: Map<string, number[]> = new Map();

    // Memory leak prevention: limit cooldown entries
    private readonly MAX_COOLDOWN_ENTRIES = 100;
    private readonly MAX_SYMBOL_HISTORY_ENTRIES = 100;

    // Configuration (from config or defaults)
    private readonly cooldownAfterTradeMs: number;
    private readonly cooldownBeforeFlipMs: number;
    private readonly hysteresisMultiplier: number;
    private readonly maxTradesPerDay: number;
    private readonly maxTradesPerSymbolPerHour: number;
    private readonly fundingThresholdATR: number;
    private readonly fundingPeriodsPerDay: number; // Number of funding periods per day (WEEX: 3)

    constructor() {
        const antiChurn = config.antiChurn || {};

        this.cooldownAfterTradeMs = antiChurn.cooldownAfterTradeMs || 900000;      // 15 minutes
        this.cooldownBeforeFlipMs = antiChurn.cooldownBeforeFlipMs || 1800000;     // 30 minutes

        // Hysteresis multiplier: 20% more confidence needed to close than to open
        // Default is 1.2 (hardcoded), but can be overridden via config.antiChurn.hysteresisMultiplier
        this.hysteresisMultiplier = antiChurn.hysteresisMultiplier ?? 1.2;

        // Daily trade limit: prefer trading.maxDailyTrades, fallback to deprecated antiChurn.maxTradesPerDay
        // MIGRATION: antiChurn.maxTradesPerDay is deprecated, use trading.maxDailyTrades instead
        const deprecatedMaxTrades = (antiChurn as Record<string, unknown>).maxTradesPerDay as number | undefined;
        let rawMaxTradesPerDay: number;
        let configField: string; // Track which config field was actually used

        if (config.trading?.maxDailyTrades !== undefined) {
            rawMaxTradesPerDay = config.trading.maxDailyTrades;
            configField = 'config.trading.maxDailyTrades';
        } else if (deprecatedMaxTrades !== undefined) {
            logger.warn('⚠️ DEPRECATED: antiChurn.maxTradesPerDay is deprecated. Please migrate to trading.maxDailyTrades in your config.');
            rawMaxTradesPerDay = deprecatedMaxTrades;
            configField = 'config.antiChurn.maxTradesPerDay';
        } else {
            rawMaxTradesPerDay = 20; // Default
            configField = 'config.trading.maxDailyTrades (using default)';
        }

        // FIXED: Simplified validation logic - removed redundant checks
        // Validate and sanitize maxTradesPerDay: must be finite, positive, and in range [1, 1000]

        if (!Number.isFinite(rawMaxTradesPerDay) || rawMaxTradesPerDay < 1) {
            // Invalid or too low - use default
            logger.warn(
                `⚠️ Invalid maxDailyTrades value: ${rawMaxTradesPerDay}. ` +
                `Must be a finite number >= 1. Falling back to default (20). ` +
                `Check ${configField}.`
            );
            this.maxTradesPerDay = 20;
        } else if (rawMaxTradesPerDay > 1000) {
            // Too high - clamp to max
            logger.warn(
                `⚠️ maxDailyTrades value too high: ${rawMaxTradesPerDay}. ` +
                `Maximum is 1000. Clamping to 1000. ` +
                `Check ${configField}.`
            );
            this.maxTradesPerDay = 1000;
        } else {
            // Valid range - coerce to integer
            this.maxTradesPerDay = Math.floor(rawMaxTradesPerDay);
            if (this.maxTradesPerDay !== rawMaxTradesPerDay) {
                logger.warn(
                    `⚠️ maxDailyTrades value was non-integer: ${rawMaxTradesPerDay}. ` +
                    `Rounded down to ${this.maxTradesPerDay}. ` +
                    `Check ${configField}.`
                );
            }
        }

        this.fundingThresholdATR = 0.25;  // Only act on funding if > 0.25×ATR

        // Funding periods per day - WEEX uses 8-hour funding periods (3 per day)
        // Other exchanges may differ: Binance/Bybit/OKX: 3, dYdX: 24
        // Intentionally hardcoded for WEEX - change this if targeting other exchanges
        this.fundingPeriodsPerDay = antiChurn.fundingPeriodsPerDay ?? 3;

        // Per-symbol hourly trade limit (default: 3 trades per symbol per hour)
        // This prevents over-trading a single symbol even if daily limit isn't reached
        this.maxTradesPerSymbolPerHour = antiChurn.maxTradesPerSymbolPerHour ?? 3;

        logger.info(`AntiChurnService initialized: cooldown=${this.cooldownAfterTradeMs}ms, flip=${this.cooldownBeforeFlipMs}ms, hysteresis=${this.hysteresisMultiplier}x, maxTrades=${this.maxTradesPerDay}, maxPerSymbol/hr=${this.maxTradesPerSymbolPerHour}, fundingPeriods=${this.fundingPeriodsPerDay}`);
    }

    /**
     * Check if trading is allowed for a symbol
     */
    canTrade(symbol: string): { allowed: boolean; reason?: string; remainingMs?: number } {
        // Check daily limit first
        this.resetDailyCounterIfNeeded();

        if (this.tradesExecutedToday >= this.maxTradesPerDay) {
            return {
                allowed: false,
                reason: `Daily trade limit reached (${this.maxTradesPerDay})`,
            };
        }

        // Check per-symbol hourly limit
        const symbolHourlyCheck = this.canTradeSymbolThisHour(symbol);
        if (!symbolHourlyCheck.allowed) {
            return symbolHourlyCheck;
        }

        // Check symbol-specific cooldown
        const state = this.cooldowns.get(symbol);
        if (!state) {
            return { allowed: true };
        }

        const now = Date.now();

        if (now < state.cooldownUntil) {
            const remainingMs = state.cooldownUntil - now;
            return {
                allowed: false,
                reason: `Cooldown active for ${symbol}`,
                remainingMs,
            };
        }

        return { allowed: true };
    }

    /**
     * Check if a symbol can be traded this hour (per-symbol hourly limit)
     * @returns { allowed: boolean, reason?: string }
     */
    private canTradeSymbolThisHour(symbol: string): { allowed: boolean; reason?: string } {
        const now = Date.now();
        const oneHourAgo = now - 3600000; // 1 hour in ms

        // Get trade history for this symbol
        const history = this.symbolTradeHistory.get(symbol);
        if (!history || history.length === 0) {
            return { allowed: true };
        }

        // Count trades in the last hour
        const tradesInLastHour = history.filter(ts => ts > oneHourAgo).length;

        if (tradesInLastHour >= this.maxTradesPerSymbolPerHour) {
            return {
                allowed: false,
                reason: `Per-symbol hourly limit reached for ${symbol} (${this.maxTradesPerSymbolPerHour} trades/hour)`,
            };
        }

        return { allowed: true };
    }

    /**
     * Check if direction flip is allowed
     */
    canFlipDirection(symbol: string, newDirection: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string; remainingMs?: number } {
        const state = this.cooldowns.get(symbol);
        if (!state) {
            return { allowed: true };
        }

        // If same direction, no flip cooldown needed
        if (state.lastDirection === newDirection) {
            return { allowed: true };
        }

        const now = Date.now();

        if (now < state.flipCooldownUntil) {
            const remainingMs = state.flipCooldownUntil - now;
            return {
                allowed: false,
                reason: `Cannot flip direction on ${symbol} yet (was ${state.lastDirection}, want ${newDirection})`,
                remainingMs,
            };
        }

        return { allowed: true };
    }

    /**
     * Record a trade and set cooldowns
     * 
     * NOTE: This method assumes the trade has already been validated and executed.
     * Call canTrade() and canFlipDirection() BEFORE executing the trade.
     * 
     * IMPORTANT: This method enforces the daily trade limit. If the limit is already
     * reached, the trade will NOT be recorded and false will be returned.
     * 
     * MEMORY LEAK PREVENTION: Prunes expired cooldowns when map exceeds MAX_COOLDOWN_ENTRIES
     * 
     * @returns true if trade was recorded, false if inputs were invalid or limit reached
     */
    recordTrade(symbol: string, direction: 'LONG' | 'SHORT'): boolean {
        // Validate inputs
        if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
            logger.warn(`AntiChurnService.recordTrade: Invalid symbol: ${symbol}`);
            return false;
        }
        if (direction !== 'LONG' && direction !== 'SHORT') {
            logger.warn(`AntiChurnService.recordTrade: Invalid direction: ${direction}`);
            return false;
        }

        // FIXED: Reset daily counter before checking to ensure accurate count
        this.resetDailyCounterIfNeeded();

        // FIXED: Enforce daily limit - refuse to record if limit already reached
        if (this.tradesExecutedToday >= this.maxTradesPerDay) {
            logger.warn(`⚠️ AntiChurnService.recordTrade: Daily limit (${this.maxTradesPerDay}) already reached, refusing to record trade`);
            return false;
        }

        const now = Date.now();

        // Prune expired cooldowns if map is getting large
        // FIXED: Also prune oldest entries if all are still active to prevent unbounded growth
        if (this.cooldowns.size >= this.MAX_COOLDOWN_ENTRIES) {
            const prunedExpired = this.pruneExpiredCooldowns();

            // If no expired entries were pruned and we're still at limit,
            // remove the oldest entry to make room
            if (prunedExpired === 0 && this.cooldowns.size >= this.MAX_COOLDOWN_ENTRIES) {
                let oldestSymbol: string | null = null;
                let oldestTime = Infinity;

                for (const [sym, state] of this.cooldowns.entries()) {
                    if (state.lastTradeTime < oldestTime) {
                        oldestTime = state.lastTradeTime;
                        oldestSymbol = sym;
                    }
                }

                if (oldestSymbol) {
                    this.cooldowns.delete(oldestSymbol);
                    logger.debug(`Evicted oldest cooldown entry: ${oldestSymbol}`);
                }
            }
        }

        this.cooldowns.set(symbol, {
            lastTradeTime: now,
            lastDirection: direction,
            cooldownUntil: now + this.cooldownAfterTradeMs,
            flipCooldownUntil: now + this.cooldownBeforeFlipMs,
        });

        // Record to per-symbol hourly history
        this.recordSymbolTrade(symbol, now);

        this.tradesExecutedToday++;

        logger.info(`📝 Trade recorded: ${symbol} ${direction}, cooldown until ${new Date(now + this.cooldownAfterTradeMs).toISOString()}, flip cooldown until ${new Date(now + this.cooldownBeforeFlipMs).toISOString()}`);
        logger.info(`📊 Trades today: ${this.tradesExecutedToday}/${this.maxTradesPerDay}`);

        return true;
    }

    /**
     * Record a trade timestamp for per-symbol hourly tracking
     * Also prunes old entries (> 1 hour) to prevent memory leak
     * 
     * OPTIMIZED: Mutates array in-place instead of creating new arrays
     */
    private recordSymbolTrade(symbol: string, timestamp: number): void {
        const oneHourAgo = timestamp - 3600000;

        // Get or create history array for this symbol
        let history = this.symbolTradeHistory.get(symbol);
        if (!history) {
            history = [timestamp];
            this.symbolTradeHistory.set(symbol, history);
        } else {
            // OPTIMIZED: Prune in-place by finding first valid index, then splice
            // This avoids creating a new array on every call
            let firstValidIndex = 0;
            while (firstValidIndex < history.length && history[firstValidIndex] <= oneHourAgo) {
                firstValidIndex++;
            }
            if (firstValidIndex > 0) {
                history.splice(0, firstValidIndex);
            }
            history.push(timestamp);
        }

        // Memory leak prevention: limit total symbols tracked
        if (this.symbolTradeHistory.size > this.MAX_SYMBOL_HISTORY_ENTRIES) {
            // Find and remove the symbol with oldest last trade
            let oldestSymbol: string | null = null;
            let oldestTime = Infinity;

            for (const [sym, hist] of this.symbolTradeHistory.entries()) {
                if (hist.length === 0) {
                    // Empty history - remove immediately
                    this.symbolTradeHistory.delete(sym);
                    continue;
                }
                const lastTrade = hist[hist.length - 1];
                if (lastTrade < oldestTime) {
                    oldestTime = lastTrade;
                    oldestSymbol = sym;
                }
            }

            if (oldestSymbol && this.symbolTradeHistory.size > this.MAX_SYMBOL_HISTORY_ENTRIES) {
                this.symbolTradeHistory.delete(oldestSymbol);
                logger.debug(`Evicted oldest symbol history entry: ${oldestSymbol}`);
            }
        }
    }

    /**
     * Prune expired cooldowns to prevent memory leak
     * @returns Number of entries pruned
     */
    private pruneExpiredCooldowns(): number {
        const now = Date.now();
        let prunedCount = 0;

        for (const [symbol, state] of this.cooldowns.entries()) {
            // Remove if both cooldowns have expired
            if (now >= state.cooldownUntil && now >= state.flipCooldownUntil) {
                this.cooldowns.delete(symbol);
                prunedCount++;
            }
        }

        if (prunedCount > 0) {
            logger.debug(`Pruned ${prunedCount} expired cooldowns`);
        }

        return prunedCount;
    }

    /**
     * Check if we've hit daily trade limit
     */
    canTradeToday(): boolean {
        this.resetDailyCounterIfNeeded();
        return this.tradesExecutedToday < this.maxTradesPerDay;
    }

    /**
     * Get remaining trades for today
     */
    getRemainingTradesToday(): number {
        this.resetDailyCounterIfNeeded();
        return Math.max(0, this.maxTradesPerDay - this.tradesExecutedToday);
    }

    /**
     * Apply hysteresis to close decision
     * Returns true if close signal is strong enough to overcome hysteresis
     * 
     * FIXED: Added input validation to prevent NaN propagation
     * FIXED: Use local variables instead of modifying parameters
     */
    shouldClose(
        entryConfidence: number,
        closeConfidence: number
    ): { shouldClose: boolean; requiredConfidence: number } {
        // Validate inputs - use local variables to avoid parameter reassignment
        let validEntryConfidence = entryConfidence;
        let validCloseConfidence = closeConfidence;

        if (!Number.isFinite(validEntryConfidence) || validEntryConfidence < 0) {
            logger.warn(`AntiChurnService.shouldClose: Invalid entryConfidence ${entryConfidence}, using 50`);
            validEntryConfidence = 50;
        }
        if (!Number.isFinite(validCloseConfidence) || validCloseConfidence < 0) {
            logger.warn(`AntiChurnService.shouldClose: Invalid closeConfidence ${closeConfidence}, using 0`);
            validCloseConfidence = 0;
        }

        const requiredConfidence = validEntryConfidence * this.hysteresisMultiplier;

        if (validCloseConfidence < requiredConfidence) {
            logger.debug(`Hysteresis: Close confidence (${validCloseConfidence}%) below threshold (${requiredConfidence.toFixed(1)}%), keeping position`);
            return { shouldClose: false, requiredConfidence };
        }

        return { shouldClose: true, requiredConfidence };
    }

    /**
     * Check if funding rate warrants action
     * Only act if funding > 0.25×ATR (per competitor's rules)
     * 
     * @param fundingRate - Funding rate as a decimal (e.g., 0.0001 = 0.01% per period).
     *                      WEEX returns this directly from their API.
     *                      Positive = longs pay shorts, Negative = shorts pay longs.
     * @param atr - Average True Range in price units (e.g., $500 for BTC)
     * @param currentPrice - Current asset price in USD
     * 
     * NOTE: Funding period assumption - WEEX uses 8-hour funding periods.
     * If targeting other exchanges, verify their funding period:
     * - Binance: 8 hours
     * - Bybit: 8 hours
     * - OKX: 8 hours
     * - dYdX: 1 hour
     * 
     * EDGE CASES HANDLED:
     * - NaN/Infinity inputs
     * - Zero or negative prices/ATR
     * - Extremely high funding rates (capped at 100% daily for sanity)
     */
    shouldActOnFunding(
        fundingRate: number,
        atr: number,
        currentPrice: number
    ): { shouldAct: boolean; fundingImpact: number; threshold: number } {
        // Validate inputs
        if (!Number.isFinite(fundingRate) || !Number.isFinite(atr) || !Number.isFinite(currentPrice)) {
            return { shouldAct: false, fundingImpact: 0, threshold: 0 };
        }
        if (currentPrice <= 0 || atr <= 0) {
            return { shouldAct: false, fundingImpact: 0, threshold: 0 };
        }

        // Convert funding rate to price impact
        // Funding is typically per 8 hours (WEEX), so multiply by fundingPeriodsPerDay for daily
        const dailyFundingPct = Math.abs(fundingRate) * this.fundingPeriodsPerDay * 100;

        // EDGE CASE: Cap at 100% daily to prevent unrealistic values from bad data
        const cappedDailyFundingPct = Math.min(dailyFundingPct, 100);
        if (dailyFundingPct > 100) {
            logger.warn(`Extremely high funding rate detected: ${dailyFundingPct.toFixed(2)}% daily, capping at 100%`);
        }

        // ATR as percentage of price
        const atrPct = (atr / currentPrice) * 100;

        // Threshold is 0.25×ATR
        const threshold = atrPct * this.fundingThresholdATR;

        const shouldAct = cappedDailyFundingPct > threshold;

        if (shouldAct) {
            logger.debug(`Funding warrants action: ${cappedDailyFundingPct.toFixed(3)}% > ${threshold.toFixed(3)}% (0.25×ATR)`);
        }

        return {
            shouldAct,
            fundingImpact: cappedDailyFundingPct,
            threshold,
        };
    }

    /**
     * Get cooldown state for a symbol
     * 
     * NOTE: Returns a COPY of the internal state to prevent external mutation.
     * This is consistent with getAllCooldowns() behavior.
     */
    getCooldownState(symbol: string): CooldownState | null {
        const state = this.cooldowns.get(symbol);
        if (!state) return null;

        // Return a copy to prevent external mutation
        return {
            lastTradeTime: state.lastTradeTime,
            lastDirection: state.lastDirection,
            cooldownUntil: state.cooldownUntil,
            flipCooldownUntil: state.flipCooldownUntil,
        };
    }

    /**
     * Get all cooldown states
     * 
     * NOTE: Returns a DEEP copy of the internal Map to prevent external mutation.
     * Both the Map structure and the CooldownState objects are copied, so callers
     * cannot affect internal state by modifying the returned data.
     * 
     * This is consistent with getCooldownState() which also returns a copy.
     */
    getAllCooldowns(): Map<string, CooldownState> {
        const copy = new Map<string, CooldownState>();
        for (const [symbol, state] of this.cooldowns) {
            // Deep copy each CooldownState to prevent mutation
            copy.set(symbol, {
                lastTradeTime: state.lastTradeTime,
                lastDirection: state.lastDirection,
                cooldownUntil: state.cooldownUntil,
                flipCooldownUntil: state.flipCooldownUntil,
            });
        }
        return copy;
    }

    /**
     * Clear cooldown for a symbol (e.g., after position is closed)
     */
    clearCooldown(symbol: string): void {
        this.cooldowns.delete(symbol);
        logger.debug(`Cleared cooldown for ${symbol}`);
    }

    /**
     * Reset daily counter if it's a new day
     * 
     * NOTE: Uses UTC timezone for consistency across deployments.
     * toISOString() returns UTC date, ensuring consistent daily resets
     * regardless of server timezone.
     */
    private resetDailyCounterIfNeeded(): void {
        // toISOString() returns UTC date (e.g., "2026-01-05T12:00:00.000Z")
        // split('T')[0] extracts "2026-01-05" in UTC
        const today = new Date().toISOString().split('T')[0];

        if (this.lastResetDate !== today) {
            this.tradesExecutedToday = 0;
            this.lastResetDate = today;
            logger.info(`📅 New day (UTC): Reset daily trade counter`);
        }
    }

    /**
     * Get statistics
     */
    getStats(): {
        tradesExecutedToday: number;
        maxTradesPerDay: number;
        remainingTrades: number;
        activeCooldowns: number;
        cooldownSymbols: string[];
    } {
        this.resetDailyCounterIfNeeded();

        const now = Date.now();
        const activeCooldowns: string[] = [];

        for (const [symbol, state] of this.cooldowns) {
            if (now < state.cooldownUntil || now < state.flipCooldownUntil) {
                activeCooldowns.push(symbol);
            }
        }

        // FIXED: Use Math.max(0, ...) for consistency with getRemainingTradesToday()
        // This ensures remainingTrades is never negative even if tradesExecutedToday > maxTradesPerDay
        return {
            tradesExecutedToday: this.tradesExecutedToday,
            maxTradesPerDay: this.maxTradesPerDay,
            remainingTrades: Math.max(0, this.maxTradesPerDay - this.tradesExecutedToday),
            activeCooldowns: activeCooldowns.length,
            cooldownSymbols: activeCooldowns,
        };
    }

    /**
     * Format cooldown info for logging/display
     */
    formatCooldownInfo(symbol: string): string {
        const state = this.cooldowns.get(symbol);
        if (!state) return `${symbol}: No cooldown`;

        const now = Date.now();
        const cooldownRemaining = Math.max(0, state.cooldownUntil - now);
        const flipRemaining = Math.max(0, state.flipCooldownUntil - now);

        if (cooldownRemaining === 0 && flipRemaining === 0) {
            return `${symbol}: Cooldown expired`;
        }

        const parts: string[] = [];
        if (cooldownRemaining > 0) {
            parts.push(`trade: ${Math.ceil(cooldownRemaining / 1000)}s`);
        }
        if (flipRemaining > 0) {
            parts.push(`flip: ${Math.ceil(flipRemaining / 1000)}s`);
        }

        return `${symbol}: ${parts.join(', ')} (last: ${state.lastDirection})`;
    }
}

// Singleton instance
let antiChurnServiceInstance: AntiChurnService | null = null;

export function getAntiChurnService(): AntiChurnService {
    if (!antiChurnServiceInstance) {
        antiChurnServiceInstance = new AntiChurnService();
    }
    return antiChurnServiceInstance;
}

/**
 * Reset singleton (for testing or cleanup)
 * Clears all cooldown state to prevent stale data on restart
 */
export function resetAntiChurnService(): void {
    antiChurnServiceInstance = null;
    logger.info('AntiChurnService singleton reset');
}
