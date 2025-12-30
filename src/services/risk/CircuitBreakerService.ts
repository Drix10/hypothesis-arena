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
     * Check portfolio drawdown using actual WEEX wallet balance
     * Compares current wallet balance against 24h snapshot
     * 
     * FAIL-CLOSED: Returns YELLOW alert if wallet balance unavailable
     * to prevent trading without knowing account state
     */
    private async checkPortfolioDrawdown(userId: string): Promise<Partial<CircuitBreakerStatus>> {
        // Validate userId to prevent SQL injection and invalid queries
        if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
            logger.warn('Invalid userId provided to checkPortfolioDrawdown');
            return { level: 'NONE', reason: '' };
        }

        try {
            // Get ACTUAL wallet balance from WEEX (source of truth)
            let totalCurrent: number;
            try {
                const assets = await this.weexClient.getAccountAssets();
                totalCurrent = parseFloat(assets.available || '0');
                if (!Number.isFinite(totalCurrent) || totalCurrent < 0) {
                    logger.warn('Invalid wallet balance from WEEX for circuit breaker check');
                    // FAIL-CLOSED: Can't verify account state, trigger caution
                    return {
                        level: 'YELLOW',
                        reason: 'Unable to verify wallet balance - trading with caution'
                    };
                }
            } catch (error) {
                logger.error('Failed to fetch wallet balance for circuit breaker:', error);
                // FAIL-CLOSED: Can't verify account state, trigger caution
                return {
                    level: 'YELLOW',
                    reason: 'Wallet balance unavailable - trading with caution'
                };
            }

            // Get portfolio value from 24 hours ago from snapshots
            const dayAgoResult = await pool.query(
                `SELECT total_value
                 FROM performance_snapshots 
                 WHERE user_id = $1 
                   AND timestamp >= NOW() - INTERVAL '24 hours'
                   AND timestamp <= NOW() - INTERVAL '23 hours'
                 ORDER BY timestamp ASC
                 LIMIT 1`,
                [userId]
            );

            // If no 24h snapshot, we can't calculate drawdown
            // This is acceptable for new accounts - log and continue
            if (dayAgoResult.rows.length === 0 || !dayAgoResult.rows[0].total_value) {
                logger.debug('No 24h snapshot available for drawdown calculation - new account or missing data');
                return { level: 'NONE', reason: '' };
            }

            const total24hAgo = parseFloat(dayAgoResult.rows[0].total_value);

            if (!Number.isFinite(total24hAgo) || total24hAgo <= 0) {
                return { level: 'NONE', reason: '' };
            }

            // Calculate 24h drawdown (only if portfolio is down)
            const drawdownPercent = Math.max(0, ((total24hAgo - totalCurrent) / total24hAgo) * 100);

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
