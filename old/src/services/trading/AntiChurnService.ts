/**
 * Anti-Churn Service for v5.0.0
 * Implements competitor's anti-churn rules: cooldowns, direction flips, daily limits, funding thresholds
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';

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

        this.cooldownAfterTradeMs = antiChurn.cooldownAfterTradeMs || 900000;
        this.cooldownBeforeFlipMs = antiChurn.cooldownBeforeFlipMs || 1800000;
        this.hysteresisMultiplier = antiChurn.hysteresisMultiplier ?? 1.2;

        let rawMaxTradesPerDay: number;
        let configField: string;

        if (config.trading?.maxDailyTrades !== undefined) {
            rawMaxTradesPerDay = config.trading.maxDailyTrades;
            configField = 'config.trading.maxDailyTrades';
        } else {
            rawMaxTradesPerDay = 20;
            configField = 'config.trading.maxDailyTrades (using default)';
        }

        if (!Number.isFinite(rawMaxTradesPerDay) || rawMaxTradesPerDay < 1) {
            logger.warn(
                `⚠️ Invalid maxDailyTrades value: ${rawMaxTradesPerDay}. ` +
                `Must be a finite number >= 1. Falling back to default (20). ` +
                `Check ${configField}.`
            );
            this.maxTradesPerDay = 20;
        } else if (rawMaxTradesPerDay > 1000) {
            logger.warn(
                `⚠️ maxDailyTrades value too high: ${rawMaxTradesPerDay}. ` +
                `Maximum is 1000. Clamping to 1000. ` +
                `Check ${configField}.`
            );
            this.maxTradesPerDay = 1000;
        } else {
            this.maxTradesPerDay = Math.floor(rawMaxTradesPerDay);
            if (this.maxTradesPerDay !== rawMaxTradesPerDay) {
                logger.warn(
                    `⚠️ maxDailyTrades value was non-integer: ${rawMaxTradesPerDay}. ` +
                    `Rounded down to ${this.maxTradesPerDay}. ` +
                    `Check ${configField}.`
                );
            }
        }

        this.fundingThresholdATR = 0.25;
        this.fundingPeriodsPerDay = antiChurn.fundingPeriodsPerDay ?? 3;
        this.maxTradesPerSymbolPerHour = antiChurn.maxTradesPerSymbolPerHour ?? 3;

        logger.info(`AntiChurnService initialized: cooldown=${this.cooldownAfterTradeMs}ms, flip=${this.cooldownBeforeFlipMs}ms, hysteresis=${this.hysteresisMultiplier}x, maxTrades=${this.maxTradesPerDay}, maxPerSymbol/hr=${this.maxTradesPerSymbolPerHour}, fundingPeriods=${this.fundingPeriodsPerDay}`);
    }

    /**
     * Check if trading is allowed for a symbol
     */
    canTrade(symbol: string): { allowed: boolean; reason?: string; remainingMs?: number } {
        this.resetDailyCounterIfNeeded();

        if (this.tradesExecutedToday >= this.maxTradesPerDay) {
            return {
                allowed: false,
                reason: `Daily trade limit reached (${this.maxTradesPerDay})`,
            };
        }

        const symbolHourlyCheck = this.canTradeSymbolThisHour(symbol);
        if (!symbolHourlyCheck.allowed) {
            return symbolHourlyCheck;
        }

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

        const history = this.symbolTradeHistory.get(symbol);
        if (!history || history.length === 0) {
            return { allowed: true };
        }

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
     * @returns true if trade was recorded, false if inputs were invalid or limit reached
     */
    recordTrade(symbol: string, direction: 'LONG' | 'SHORT'): boolean {
        if (!symbol || typeof symbol !== 'string' || symbol.trim().length === 0) {
            logger.warn(`AntiChurnService.recordTrade: Invalid symbol: ${symbol}`);
            return false;
        }
        if (direction !== 'LONG' && direction !== 'SHORT') {
            logger.warn(`AntiChurnService.recordTrade: Invalid direction: ${direction}`);
            return false;
        }

        this.resetDailyCounterIfNeeded();

        if (this.tradesExecutedToday >= this.maxTradesPerDay) {
            logger.warn(`⚠️ AntiChurnService.recordTrade: Daily limit (${this.maxTradesPerDay}) already reached, refusing to record trade`);
            return false;
        }

        const now = Date.now();

        if (this.cooldowns.size >= this.MAX_COOLDOWN_ENTRIES) {
            const prunedExpired = this.pruneExpiredCooldowns();

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

        this.recordSymbolTrade(symbol, now);
        this.tradesExecutedToday++;

        logger.info(`📝 Trade recorded: ${symbol} ${direction}, cooldown until ${new Date(now + this.cooldownAfterTradeMs).toISOString()}, flip cooldown until ${new Date(now + this.cooldownBeforeFlipMs).toISOString()}`);
        logger.info(`📊 Trades today: ${this.tradesExecutedToday}/${this.maxTradesPerDay}`);

        return true;
    }

    /**
     * Record a trade timestamp for per-symbol hourly tracking
     * Also prunes old entries (> 1 hour) to prevent memory leak
     */
    private recordSymbolTrade(symbol: string, timestamp: number): void {
        const oneHourAgo = timestamp - 3600000;

        let history = this.symbolTradeHistory.get(symbol);
        if (!history) {
            history = [timestamp];
            this.symbolTradeHistory.set(symbol, history);
        } else {
            let firstValidIndex = 0;
            while (firstValidIndex < history.length && history[firstValidIndex] <= oneHourAgo) {
                firstValidIndex++;
            }
            if (firstValidIndex > 0) {
                history.splice(0, firstValidIndex);
            }
            history.push(timestamp);
        }

        if (this.symbolTradeHistory.size > this.MAX_SYMBOL_HISTORY_ENTRIES) {
            let oldestSymbol: string | null = null;
            let oldestTime = Infinity;

            for (const [sym, hist] of this.symbolTradeHistory.entries()) {
                if (hist.length === 0) {
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
     */
    shouldClose(
        entryConfidence: number,
        closeConfidence: number
    ): { shouldClose: boolean; requiredConfidence: number } {
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
     */
    shouldActOnFunding(
        fundingRate: number,
        atr: number,
        currentPrice: number
    ): { shouldAct: boolean; fundingImpact: number; threshold: number } {
        if (!Number.isFinite(fundingRate) || !Number.isFinite(atr) || !Number.isFinite(currentPrice)) {
            return { shouldAct: false, fundingImpact: 0, threshold: 0 };
        }
        if (currentPrice <= 0 || atr <= 0) {
            return { shouldAct: false, fundingImpact: 0, threshold: 0 };
        }

        const dailyFundingPct = Math.abs(fundingRate) * this.fundingPeriodsPerDay * 100;
        const cappedDailyFundingPct = Math.min(dailyFundingPct, 100);
        if (dailyFundingPct > 100) {
            logger.warn(`Extremely high funding rate detected: ${dailyFundingPct.toFixed(2)}% daily, capping at 100%`);
        }

        const atrPct = (atr / currentPrice) * 100;
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
     * Get cooldown state for a symbol (returns a copy to prevent external mutation)
     */
    getCooldownState(symbol: string): CooldownState | null {
        const state = this.cooldowns.get(symbol);
        if (!state) return null;

        return {
            lastTradeTime: state.lastTradeTime,
            lastDirection: state.lastDirection,
            cooldownUntil: state.cooldownUntil,
            flipCooldownUntil: state.flipCooldownUntil,
        };
    }

    /**
     * Get all cooldown states (returns a deep copy to prevent external mutation)
     */
    getAllCooldowns(): Map<string, CooldownState> {
        const copy = new Map<string, CooldownState>();
        for (const [symbol, state] of this.cooldowns) {
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
     * Reset daily counter if it's a new day (uses UTC timezone)
     */
    private resetDailyCounterIfNeeded(): void {
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
 */
export function resetAntiChurnService(): void {
    antiChurnServiceInstance = null;
    logger.info('AntiChurnService singleton reset');
}
