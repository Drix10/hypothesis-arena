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
import { pool } from '../../config/database';
import { GLOBAL_RISK_LIMITS } from '../../constants/analystPrompts';

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
    private readonly CACHE_DURATION_MS = 60000; // Cache for 1 minute
    private checkInProgress: Promise<CircuitBreakerStatus> | null = null; // Prevent concurrent checks

    /**
     * Check all circuit breaker conditions
     * 
     * FIXED: Race condition - now properly waits for in-flight checks
     */
    async checkCircuitBreakers(userId?: string): Promise<CircuitBreakerStatus> {
        const now = Date.now();

        // Return cached status if recent (within 1 minute)
        if (this.cachedStatus && (now - this.lastCheckTime) < this.CACHE_DURATION_MS) {
            return this.cachedStatus;
        }

        // RACE CONDITION FIX: If check is already in progress, wait for it
        // This prevents multiple concurrent checks from hitting the API/DB
        if (this.checkInProgress) {
            logger.debug('Circuit breaker check already in progress, waiting...');
            return this.checkInProgress;
        }

        // Start new check and store the promise
        this.checkInProgress = this.performCheck(userId);

        try {
            const result = await this.checkInProgress;
            return result;
        } catch (error) {
            logger.error('Circuit breaker check failed:', error);
            throw error;
        } finally {
            // Clear the in-flight promise
            this.checkInProgress = null;
        }
    }

    /**
     * Perform the actual circuit breaker check
     */
    private async performCheck(userId?: string): Promise<CircuitBreakerStatus> {
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
                userId ? this.checkPortfolioDrawdown(userId) : Promise.resolve({ level: 'NONE' as CircuitBreakerLevel, reason: '' }),
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
     * Update cache atomically
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

            if (candles.length < 4) {
                logger.warn('Insufficient BTC candle data for circuit breaker check');
                return { level: 'NONE', reason: '' };
            }

            // Calculate price drop from 4 hours ago to now
            const price4hAgo = parseFloat(candles[0].open);
            const priceNow = parseFloat(candles[candles.length - 1].close);

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
     * Check portfolio drawdown (FIXED: SQL query logic - now properly gets 24h snapshot)
     */
    private async checkPortfolioDrawdown(userId: string): Promise<Partial<CircuitBreakerStatus>> {
        try {
            // Get current portfolio values
            const currentResult = await pool.query(
                `SELECT 
                    SUM(total_value) as total_current
                 FROM portfolios 
                 WHERE user_id = $1`,
                [userId]
            );

            if (currentResult.rows.length === 0 || !currentResult.rows[0].total_current) {
                return { level: 'NONE', reason: '' };
            }

            const totalCurrent = parseFloat(currentResult.rows[0].total_current);

            // FIXED SQL LOGIC: Get portfolio value from 24 hours ago
            // Previous query had LIMIT 1 with aggregation which is incorrect
            // Now we get the earliest snapshot within the 23-24h window
            const dayAgoResult = await pool.query(
                `WITH snapshots_24h AS (
                    SELECT 
                        user_id,
                        total_value,
                        timestamp,
                        ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY timestamp ASC) as rn
                    FROM performance_snapshots 
                    WHERE user_id = $1 
                      AND timestamp >= NOW() - INTERVAL '24 hours'
                      AND timestamp <= NOW() - INTERVAL '23 hours'
                )
                SELECT 
                    SUM(total_value) as total_24h_ago
                FROM snapshots_24h
                WHERE rn = 1`,
                [userId]
            );

            // If no 24h data, use initial balance as fallback
            let total24hAgo: number;
            if (dayAgoResult.rows.length === 0 || !dayAgoResult.rows[0].total_24h_ago) {
                const initialResult = await pool.query(
                    `SELECT SUM(initial_balance) as total_initial FROM portfolios WHERE user_id = $1`,
                    [userId]
                );
                total24hAgo = parseFloat(initialResult.rows[0]?.total_initial || '0');
            } else {
                total24hAgo = parseFloat(dayAgoResult.rows[0].total_24h_ago);
            }

            if (total24hAgo <= 0) {
                return { level: 'NONE', reason: '' };
            }

            // Calculate 24h drawdown (only if portfolio is down)
            const drawdownPercent = Math.max(0, ((total24hAgo - totalCurrent) / total24hAgo) * 100);

            // Guard against invalid values
            if (!Number.isFinite(drawdownPercent)) {
                return { level: 'NONE', reason: '' };
            }

            // Check RED ALERT
            if (drawdownPercent >= GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.RED_ALERT.PORTFOLIO_DRAWDOWN_24H) {
                return {
                    level: 'RED',
                    reason: `Portfolio down ${drawdownPercent.toFixed(1)}% in 24h (RED ALERT: emergency exit)`,
                    portfolioDrawdown24h: drawdownPercent,
                };
            }

            // Check ORANGE ALERT
            if (drawdownPercent >= GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.ORANGE_ALERT.PORTFOLIO_DRAWDOWN_24H) {
                return {
                    level: 'ORANGE',
                    reason: `Portfolio down ${drawdownPercent.toFixed(1)}% in 24h (ORANGE ALERT: major risk reduction)`,
                    portfolioDrawdown24h: drawdownPercent,
                };
            }

            // Check YELLOW ALERT
            if (drawdownPercent >= GLOBAL_RISK_LIMITS.CIRCUIT_BREAKERS.YELLOW_ALERT.PORTFOLIO_DRAWDOWN_24H) {
                return {
                    level: 'YELLOW',
                    reason: `Portfolio down ${drawdownPercent.toFixed(1)}% in 24h (YELLOW ALERT: reduce risk)`,
                    portfolioDrawdown24h: drawdownPercent,
                };
            }

            return { level: 'NONE', reason: '' };

        } catch (error: any) {
            logger.error('Portfolio drawdown check failed:', error);
            return { level: 'NONE', reason: '' };
        }
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
