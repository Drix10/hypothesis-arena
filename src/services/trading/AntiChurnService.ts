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

    // Memory leak prevention: limit cooldown entries
    private readonly MAX_COOLDOWN_ENTRIES = 100;

    // Configuration (from config or defaults)
    private readonly cooldownAfterTradeMs: number;
    private readonly cooldownBeforeFlipMs: number;
    private readonly hysteresisMultiplier: number;
    private readonly maxTradesPerDay: number;
    private readonly fundingThresholdATR: number;
    private readonly fundingPeriodsPerDay: number; // Number of funding periods per day (WEEX: 3)

    constructor() {
        const antiChurn = config.antiChurn || {};

        this.cooldownAfterTradeMs = antiChurn.cooldownAfterTradeMs || 900000;      // 15 minutes
        this.cooldownBeforeFlipMs = antiChurn.cooldownBeforeFlipMs || 1800000;     // 30 minutes
        this.hysteresisMultiplier = antiChurn.hysteresisMultiplier || 1.2;         // 20% more confidence
        this.maxTradesPerDay = antiChurn.maxTradesPerDay || 10;
        this.fundingThresholdATR = 0.25;  // Only act on funding if > 0.25×ATR
        // WEEX uses 8-hour funding periods (3 per day). Other exchanges may differ:
        // - Binance/Bybit/OKX: 8 hours (3 per day)
        // - dYdX: 1 hour (24 per day)
        this.fundingPeriodsPerDay = antiChurn.fundingPeriodsPerDay || 3;

        logger.info(`AntiChurnService initialized: cooldown=${this.cooldownAfterTradeMs}ms, flip=${this.cooldownBeforeFlipMs}ms, hysteresis=${this.hysteresisMultiplier}x, maxTrades=${this.maxTradesPerDay}`);
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

        this.tradesExecutedToday++;

        logger.info(`📝 Trade recorded: ${symbol} ${direction}, cooldown until ${new Date(now + this.cooldownAfterTradeMs).toISOString()}, flip cooldown until ${new Date(now + this.cooldownBeforeFlipMs).toISOString()}`);
        logger.info(`📊 Trades today: ${this.tradesExecutedToday}/${this.maxTradesPerDay}`);

        return true;
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
     */
    getCooldownState(symbol: string): CooldownState | null {
        return this.cooldowns.get(symbol) || null;
    }

    /**
     * Get all cooldown states
     * 
     * NOTE: Returns a DEEP copy of the internal Map to prevent external mutation.
     * Both the Map structure and the CooldownState objects are copied, so callers
     * cannot affect internal state by modifying the returned data.
     * 
     * PERFORMANCE: This creates new objects for each entry. For read-only access
     * to a single symbol, prefer getCooldownState() which returns the reference directly.
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
 * FIXED: Clears all cooldown state to prevent stale data on restart
 * FIXED: Uses public methods where possible to avoid fragile bracket notation
 */
export function resetAntiChurnService(): void {
    if (antiChurnServiceInstance) {
        // Use getAllCooldowns to get a copy, then clear each entry
        const allCooldowns = antiChurnServiceInstance.getAllCooldowns();
        for (const symbol of allCooldowns.keys()) {
            antiChurnServiceInstance.clearCooldown(symbol);
        }
        // Reset internal state via bracket notation (unavoidable for private fields)
        (antiChurnServiceInstance as any).tradesExecutedToday = 0;
        (antiChurnServiceInstance as any).lastResetDate = '';
    }
    antiChurnServiceInstance = null;
    logger.info('AntiChurnService singleton reset');
}
