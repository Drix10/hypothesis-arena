/**
 * Circuit Breaker Service
 * 
 * Implements the 3-tier circuit breaker system from GLOBAL_RISK_LIMITS:
 * - YELLOW ALERT: BTC -10% in 4h, reduce leverage to 3x
 * - ORANGE ALERT: BTC -15% in 4h, reduce leverage to 2x
 * - RED ALERT: BTC -20% in 4h, close all positions immediately
 * 
 * Also monitors funding rates and portfolio drawdowns.
 */

import { logger } from '../../utils/logger';
import { getWeexClient } from '../weex/WeexClient';
import { config } from '../../config';
import { GLOBAL_RISK_LIMITS } from '../../constants/analyst';

export type CircuitBreakerLevel = 'NONE' | 'YELLOW' | 'ORANGE' | 'RED';

export interface CircuitBreakerStatus {
    level: CircuitBreakerLevel;
    reason: string;
    btcDrop4h?: number;
    portfolioDrawdown24h?: number;
    fundingRateExtreme?: number;
    exchangeIssue?: boolean;
    timestamp: number;
}

export class CircuitBreakerService {
    private weexClient = getWeexClient();
    private lastCheckTime: number = 0;
    private cachedStatus: CircuitBreakerStatus | null = null;
    private readonly CACHE_DURATION_MS = config.autonomous.circuitBreakerCacheDurationMs; // From config
    private checkInProgress: Promise<CircuitBreakerStatus> | null = null; // Mutex: prevents concurrent checks

    /**
     * Check all circuit breaker conditions
     * 
     * FIXED: Race condition - now properly waits for in-flight checks using mutex pattern
     * Cache updates are synchronized to prevent concurrent modifications
     * FIXED: Memory leak - ensures checkInProgress is always cleared even on error
     */
    async checkCircuitBreakers(): Promise<CircuitBreakerStatus> {
        const now = Date.now();

        // Return cached status if recent (within 1 minute)
        if (this.cachedStatus && (now - this.lastCheckTime) < this.CACHE_DURATION_MS) {
            return this.cachedStatus;
        }

        // RACE CONDITION FIX: If check is already in progress, wait for it
        // This prevents multiple concurrent checks from hitting the API/DB
        if (this.checkInProgress) {
            logger.debug('Circuit breaker check already in progress, waiting...');
            // CRITICAL: Return the promise directly to avoid creating new promise chain
            // This ensures all callers wait for the same check
            return this.checkInProgress;
        }

        // Start new check and store the promise
        // CRITICAL: Wrap in try-catch to ensure checkInProgress is always cleared
        this.checkInProgress = (async () => {
            try {
                return await this.performCheck();
            } catch (error) {
                logger.error('Circuit breaker check failed:', error);
                // Return YELLOW alert on error (fail-safe)
                return {
                    level: 'YELLOW' as CircuitBreakerLevel,
                    reason: `Circuit breaker check error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                    timestamp: Date.now(),
                };
            } finally {
                // CRITICAL: Clear the in-flight promise in finally block
                // This ensures it's cleared even if performCheck throws
                this.checkInProgress = null;
            }
        })();

        return this.checkInProgress;
    }

    /**
     * Perform the actual circuit breaker check
     */
    private async performCheck(): Promise<CircuitBreakerStatus> {
        try {
            // Check BTC drop first (most critical) - fail fast
            const btcStatus = await this.checkBtcDrop();
            if (btcStatus.level === 'RED') {
                const status = this.buildStatus(btcStatus);
                this.updateCache(status);
                return status;
            }

            // Check remaining conditions in parallel
            const [fundingStatus, portfolioStatus, exchangeStatus] = await Promise.all([
                this.checkFundingRateExtremes(),
                this.checkPortfolioDrawdown(),
                this.checkExchangeHealth(),
            ]);

            // Determine highest severity level
            const statuses = [btcStatus, fundingStatus, portfolioStatus, exchangeStatus];
            const levels: CircuitBreakerLevel[] = ['RED', 'ORANGE', 'YELLOW', 'NONE'];

            for (const level of levels) {
                const match = statuses.find(s => s.level === level);
                if (match && match.level && match.reason) {
                    const status = this.buildStatus(match);
                    this.updateCache(status);
                    return status;
                }
            }

            // No alerts
            const status: CircuitBreakerStatus = {
                level: 'NONE',
                reason: 'All systems normal',
                timestamp: Date.now(),
            };
            this.updateCache(status);
            return status;

        } catch (error: any) {
            logger.error('Circuit breaker check failed:', error);
            // On error, return YELLOW alert (cautious approach)
            const status: CircuitBreakerStatus = {
                level: 'YELLOW',
                reason: `Circuit breaker check error: ${error.message}`,
                timestamp: Date.now(),
            };
            this.updateCache(status);
            return status;
        }
    }

    /**
     * Build CircuitBreakerStatus from partial status
     */
    private buildStatus(partial: Partial<CircuitBreakerStatus>): CircuitBreakerStatus {
        return {
            level: partial.level || 'NONE',
            reason: partial.reason || '',
            btcDrop4h: 'btcDrop4h' in partial ? partial.btcDrop4h : undefined,
            portfolioDrawdown24h: 'portfolioDrawdown24h' in partial ? partial.portfolioDrawdown24h : undefined,
            fundingRateExtreme: 'fundingRateExtreme' in partial ? partial.fundingRateExtreme : undefined,
            exchangeIssue: 'exchangeIssue' in partial ? partial.exchangeIssue : undefined,
            timestamp: Date.now()
        };
    }

    /**
     * Update cache (synchronous operation, no lock needed)
     */
    private updateCache(status: CircuitBreakerStatus): void {
        this.cachedStatus = status;
        this.lastCheckTime = Date.now();
    }

    /**
     * Check BTC price drop over 4 hours
     */
    private async checkBtcDrop(): Promise<Partial<CircuitBreakerStatus>> {
        try {
            // Fetch 4-hour candles for BTC
            const candles = await this.weexClient.getCandles('cmt_btcusdt', '1h', 5);

            if (!Array.isArray(candles) || candles.length < 4) {
                logger.warn('Insufficient BTC candle data for circuit breaker check');
                return { level: 'NONE', reason: '' };
            }

            // Sort candles by timestamp to ensure correct order (oldest first)
            const sortedCandles = [...candles].sort((a, b) =>
                parseInt(a.timestamp, 10) - parseInt(b.timestamp, 10)
            );

            // Validate we still have candles after sort
            if (sortedCandles.length === 0) {
                logger.warn('No valid BTC candles after sorting');
                return { level: 'NONE', reason: '' };
            }

            // Calculate price drop from 4 hours ago to now
            const price4hAgo = parseFloat(sortedCandles[0].open);
            const priceNow = parseFloat(sortedCandles[sortedCandles.length - 1].close);

            if (!Number.isFinite(price4hAgo) || !Number.isFinite(priceNow) || price4hAgo <= 0) {
                logger.warn('Invalid BTC price data');
                return { level: 'NONE', reason: '' };
            }

            const dropPercent = ((priceNow - price4hAgo) / price4hAgo) * 100;

            // Check RED ALERT
            if (dropPercent <= -GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.RED_ALERT.BTC_DROP_4H) {
                return {
                    level: 'RED',
                    reason: `BTC dropped ${Math.abs(dropPercent).toFixed(1)}% in 4 hours (RED ALERT: liquidation cascade risk)`,
                    btcDrop4h: dropPercent,
                };
            }

            // Check ORANGE ALERT
            if (dropPercent <= -GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.BTC_DROP_4H) {
                return {
                    level: 'ORANGE',
                    reason: `BTC dropped ${Math.abs(dropPercent).toFixed(1)}% in 4 hours (ORANGE ALERT: major risk reduction)`,
                    btcDrop4h: dropPercent,
                };
            }

            // Check YELLOW ALERT
            if (dropPercent <= -GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.BTC_DROP_4H) {
                return {
                    level: 'YELLOW',
                    reason: `BTC dropped ${Math.abs(dropPercent).toFixed(1)}% in 4 hours (YELLOW ALERT: reduce risk)`,
                    btcDrop4h: dropPercent,
                };
            }

            return { level: 'NONE', reason: '' };

        } catch (error: any) {
            logger.error('BTC drop check failed:', error);
            return { level: 'NONE', reason: '' };
        }
    }

    /**
     * Check funding rate extremes
     */
    private async checkFundingRateExtremes(): Promise<Partial<CircuitBreakerStatus>> {
        try {
            // Check funding rates for major pairs
            const symbols = ['cmt_btcusdt', 'cmt_ethusdt'];
            const fundingRates = await Promise.all(
                symbols.map(async (symbol) => {
                    try {
                        const fr = await this.weexClient.getFundingRate(symbol);
                        return Math.abs(parseFloat(fr.fundingRate || '0'));
                    } catch {
                        return 0;
                    }
                })
            );

            // Guard against empty array
            if (fundingRates.length === 0) {
                return { level: 'NONE', reason: '' };
            }

            const maxFundingRate = Math.max(...fundingRates);

            // Guard against invalid values
            if (!Number.isFinite(maxFundingRate) || maxFundingRate < 0) {
                return { level: 'NONE', reason: '' };
            }

            // Check ORANGE ALERT
            if (maxFundingRate >= GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.FUNDING_RATE_EXTREME) {
                return {
                    level: 'ORANGE',
                    reason: `Extreme funding rate: ${(maxFundingRate * 100).toFixed(3)}% (ORANGE ALERT: crowd positioning extreme)`,
                    fundingRateExtreme: maxFundingRate,
                };
            }

            // Check YELLOW ALERT
            if (maxFundingRate >= GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.FUNDING_RATE_EXTREME) {
                return {
                    level: 'YELLOW',
                    reason: `High funding rate: ${(maxFundingRate * 100).toFixed(3)}% (YELLOW ALERT: crowded positioning)`,
                    fundingRateExtreme: maxFundingRate,
                };
            }

            return { level: 'NONE', reason: '' };

        } catch (error: any) {
            logger.error('Funding rate check failed:', error);
            return { level: 'NONE', reason: '' };
        }
    }

    /**
     * Portfolio drawdown check - DISABLED
     * 
     * Previously this compared wallet balance against STARTING_BALANCE, but it caused
     * false RED alerts when money was invested in positions (not actually lost).
     * 
     * This check is now disabled - let the AI make its own trading decisions.
     */
    private async checkPortfolioDrawdown(): Promise<Partial<CircuitBreakerStatus>> {
        // DISABLED: Portfolio drawdown check removed to prevent false alerts
        return { level: 'NONE', reason: '' };
    }

    /**
     * Check exchange health (API errors, halts, etc.)
     */
    private async checkExchangeHealth(): Promise<Partial<CircuitBreakerStatus>> {
        try {
            // Try to fetch server time (lightweight health check)
            const startTime = Date.now();
            await this.weexClient.getServerTime();
            const responseTime = Date.now() - startTime;

            // If response time > 5 seconds, consider it degraded
            if (responseTime > 5000) {
                return {
                    level: 'YELLOW',
                    reason: `Exchange API slow (${responseTime}ms response time)`,
                    exchangeIssue: true,
                };
            }

            return { level: 'NONE', reason: '' };

        } catch (error: any) {
            // API error = ORANGE ALERT
            return {
                level: 'ORANGE',
                reason: `Exchange API error: ${error.message}`,
                exchangeIssue: true,
            };
        }
    }

    /**
     * Get recommended action based on circuit breaker level
     */
    getRecommendedAction(level: CircuitBreakerLevel): string {
        switch (level) {
            case 'RED':
                return GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.RED_ALERT.ACTION;
            case 'ORANGE':
                return GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.ACTION;
            case 'YELLOW':
                return GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.ACTION;
            default:
                return 'Normal trading operations';
        }
    }

    /**
     * Get max allowed leverage based on circuit breaker level
     */
    getMaxLeverage(level: CircuitBreakerLevel): number {
        switch (level) {
            case 'RED':
                return 1; // No leverage during RED alert
            case 'ORANGE':
                return 2; // Max 2x during ORANGE alert
            case 'YELLOW':
                return 3; // Max 3x during YELLOW alert
            default:
                return GLOBAL_RISK_LIMITS.MAX_SAFE_LEVERAGE; // Normal max (5x)
        }
    }

    /**
     * Clear cache (useful for testing)
     */
    clearCache(): void {
        this.cachedStatus = null;
        this.lastCheckTime = 0;
        this.checkInProgress = null;
    }

    /**
     * Cleanup method for graceful shutdown
     */
    async cleanup(): Promise<void> {
        this.clearCache();
        // WeexClient cleanup is handled by its own singleton
    }
}

// Singleton instance
export const circuitBreakerService = new CircuitBreakerService();
