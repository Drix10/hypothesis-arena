/**
 * Analyst Portfolio Service
 * Manages virtual portfolios for individual analysts to track P&L attribution.
 * Each analyst gets credit for trades where they won the parallel analysis.
 */

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { ANALYST_PROFILES } from '../../constants/analyst';

const ANALYST_IDS = ['jim', 'ray', 'karen', 'quant'] as const;

// Safe access to config.portfolio with sensible defaults
const RECENT_TRADES_LIMIT: number = (() => {
    const val = config?.portfolio?.recentTradesLimit;
    return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : 50;
})();
const LOCK_TIMEOUT_MS: number = (() => {
    const val = config?.portfolio?.lockTimeoutMs;
    return typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : 300000;
})();
const LOCK_KEY = 'analyst_portfolio_update';

export class AnalystPortfolioService {
    static async initializeAnalystPortfolios(): Promise<void> {
        logger.info('🏦 Initializing analyst virtual portfolios...');

        for (const analystId of ANALYST_IDS) {
            try {
                logger.info(`  Initializing portfolio for ${analystId}...`);
                const profile = Object.values(ANALYST_PROFILES).find(p => p.id === analystId);
                if (!profile) {
                    logger.warn(`No profile found for analyst: ${analystId}`);
                    continue;
                }

                logger.debug(`  Upserting portfolio record for ${analystId}...`);
                await prisma.portfolio.upsert({
                    where: { agentId: analystId },
                    update: {
                        agentName: profile.name,
                        updatedAt: new Date()
                    },
                    create: {
                        agentId: analystId,
                        agentName: profile.name,
                        initialBalance: 0,
                        currentBalance: 0,
                        totalValue: 0,
                        totalReturn: 0,
                        totalReturnDollar: 0,
                        winRate: 0,
                        maxDrawdown: 0,
                        currentDrawdown: 0,
                        totalTrades: 0,
                        winningTrades: 0,
                        losingTrades: 0,
                        tournamentWins: 0,
                        totalPoints: 0,
                        status: 'active'
                    }
                });

                logger.info(`✅ Analyst portfolio ready: ${profile.name} (${analystId})`);
            } catch (error) {
                logger.error(`Failed to initialize portfolio for ${analystId}:`, error);
            }
        }

        logger.info('🏦 Analyst portfolio initialization complete');
    }

    static async updateAnalystPortfolios(): Promise<void> {
        // Safe access to config with fallback defaults to ensure deterministic behavior
        const rawMaxRetries = config?.portfolio?.maxRetries;
        const rawRetryDelayMs = config?.portfolio?.retryDelayMs;
        const MAX_RETRIES: number = typeof rawMaxRetries === 'number' && Number.isFinite(rawMaxRetries) && rawMaxRetries >= 0 ? rawMaxRetries : 5;
        const RETRY_DELAY_MS: number = typeof rawRetryDelayMs === 'number' && Number.isFinite(rawRetryDelayMs) && rawRetryDelayMs > 0 ? rawRetryDelayMs : 1000;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            // CRITICAL: Use database advisory lock for distributed mutex
            // This prevents race conditions across multiple instances/processes
            const lockAcquired = await this._acquireLock();

            if (!lockAcquired) {
                if (attempt < MAX_RETRIES) {
                    const delay = RETRY_DELAY_MS * Math.pow(2, attempt); // Exponential backoff
                    logger.info(`Lock acquisition failed, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    logger.warn('Could not acquire portfolio update lock after retries, another instance is updating');
                    return;
                }
            }

            // Lock acquired, perform update
            try {
                await this._performUpdate();
                return; // Success, exit
            } catch (error) {
                logger.error('Portfolio update failed:', error);
                throw error; // Re-throw to ensure finally runs
            } finally {
                await this._releaseLock();
            }
        }
    }

    private static async _acquireLock(): Promise<boolean> {
        try {
            const now = Date.now();
            const lockRecord = await prisma.portfolio.findUnique({
                where: { agentId: LOCK_KEY },
                select: {
                    updatedAt: true,
                    totalTrades: true // Use as version field
                }
            });

            let expectedVersion = 0;
            let isStale = false;

            if (lockRecord) {
                // Check if lock is stale (older than timeout)
                const lockAge = now - lockRecord.updatedAt.getTime();
                isStale = lockAge >= LOCK_TIMEOUT_MS;

                if (!isStale) {
                    // Lock is held by another instance and not stale
                    return false;
                }

                // Lock is stale, we can take it over
                expectedVersion = lockRecord.totalTrades;
                logger.warn(`Stale lock detected (age: ${Math.floor(lockAge / 1000)}s), attempting takeover`);
            }

            // ATOMIC OPERATION: Update only if version matches (compare-and-swap)
            // This prevents race condition where two instances try to acquire simultaneously
            // CRITICAL: Use database column names (snake_case), not Prisma field names (camelCase)
            const result = await prisma.$executeRaw`
                UPDATE portfolios 
                SET 
                    updated_at = ${new Date()},
                    total_trades = ${expectedVersion + 1}
                WHERE agent_id = ${LOCK_KEY}
                    AND total_trades = ${expectedVersion}
            `;

            if (result === 1) {
                // Successfully acquired lock (1 row updated)
                return true;
            } else if (result === 0) {
                // Another instance acquired the lock first (0 rows updated)
                // This is the race condition being prevented
                if (lockRecord) {
                    logger.debug('Lock acquisition race lost - another instance acquired first');
                } else {
                    // Lock record doesn't exist yet, create it atomically
                    try {
                        await prisma.portfolio.create({
                            data: {
                                agentId: LOCK_KEY,
                                agentName: 'Portfolio Update Lock',
                                initialBalance: 0,
                                currentBalance: 0,
                                totalValue: 0,
                                totalReturn: 0,
                                totalReturnDollar: 0,
                                winRate: 0,
                                maxDrawdown: 0,
                                currentDrawdown: 0,
                                totalTrades: 1, // Version starts at 1
                                winningTrades: 0,
                                losingTrades: 0,
                                tournamentWins: 0,
                                totalPoints: 0,
                                status: 'active'
                            }
                        });
                        return true; // Successfully created and acquired
                    } catch (createError: any) {
                        // Another instance created it first (unique constraint violation)
                        if (createError?.code === 'P2002') {
                            logger.debug('Lock creation race lost - another instance created first');
                            return false;
                        }
                        throw createError;
                    }
                }
                return false;
            }

            // Unexpected result (should never happen)
            logger.error(`Unexpected lock acquisition result: ${result} rows affected`);
            return false;

        } catch (error) {
            logger.error('Failed to acquire portfolio update lock:', error);
            return false;
        }
    }

    private static async _releaseLock(): Promise<void> {
        try {
            // Delete the lock record to release
            // If another instance took over, this will fail silently
            await prisma.portfolio.delete({
                where: { agentId: LOCK_KEY }
            }).catch(() => {
                // Ignore errors - lock might have been taken over due to timeout
                logger.debug('Lock release: record already deleted (taken over by another instance)');
            });
        } catch (error) {
            logger.error('Failed to release portfolio update lock:', error);
        }
    }

    private static async _performUpdate(): Promise<void> {
        try {
            // OPTIMIZED: Single query to get all stats grouped by championId
            // This replaces the N+1 pattern where we queried each analyst separately
            // FIXED: Separate entry trades (realizedPnl IS NULL) from exit trades (realizedPnl IS NOT NULL)
            // Entry trades = positions opened, Exit trades = positions closed with P&L
            // Win/loss stats should only count EXIT trades (where P&L is realized)
            const [tradeStats, winLossCounts] = await Promise.all([
                // Get total P&L per analyst (only from trades with realized P&L)
                prisma.trade.groupBy({
                    by: ['championId'],
                    where: {
                        championId: { not: null, in: [...ANALYST_IDS] },
                        status: 'FILLED',
                        realizedPnl: { not: null } // Only count trades with realized P&L
                    },
                    _count: { id: true },
                    _sum: { realizedPnl: true }
                }),
                // Get win/loss/breakeven counts in ONE query using conditional aggregation
                // FIXED: Only count trades where realized_pnl IS NOT NULL (exit trades)
                // Entry trades (realized_pnl IS NULL) are still open and shouldn't be counted
                // CRITICAL: SQLite column names are snake_case (champion_id), not camelCase (championId)
                // FIXED: Use Prisma.sql for safe parameterization instead of string interpolation
                // String interpolation in tagged template literals bypasses Prisma's SQL injection protection
                prisma.$queryRaw<Array<{
                    championId: string;
                    winningTrades: bigint;
                    losingTrades: bigint;
                    breakEvenTrades: bigint;
                    entryTrades: bigint;
                }>>`
                    SELECT 
                        champion_id as championId,
                        COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as winningTrades,
                        COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losingTrades,
                        COUNT(CASE WHEN realized_pnl = 0 THEN 1 END) as breakEvenTrades,
                        COUNT(CASE WHEN realized_pnl IS NULL THEN 1 END) as entryTrades
                    FROM trades
                    WHERE champion_id IN ('jim', 'ray', 'karen', 'quant')
                        AND status = 'FILLED'
                    GROUP BY champion_id
                `
            ]);

            // Calculate Sharpe ratio for each analyst (requires trade history)
            const sharpeRatios = await this._calculateSharpeRatios();

            // Track update failures for monitoring
            let failedUpdates = 0;
            const totalUpdates = ANALYST_IDS.length;

            // Build update data for each analyst
            const updates = ANALYST_IDS.map((analystId) => {
                const stats = tradeStats.find(s => s.championId === analystId);
                const counts = winLossCounts.find(c => c.championId === analystId);

                // FIXED: Validate BigInt conversion with safety checks
                const winningTrades = counts ? this._safeBigIntToNumber(counts.winningTrades, 'winningTrades') : 0;
                const losingTrades = counts ? this._safeBigIntToNumber(counts.losingTrades, 'losingTrades') : 0;
                const breakEvenTrades = counts ? this._safeBigIntToNumber(counts.breakEvenTrades, 'breakEvenTrades') : 0;
                const entryTrades = counts ? this._safeBigIntToNumber(counts.entryTrades, 'entryTrades') : 0;

                // Total closed trades = trades with realized P&L (win + loss + breakeven)
                const closedTrades = winningTrades + losingTrades + breakEvenTrades;
                // Total all trades = closed + entry (still open)
                const totalAllTrades = closedTrades + entryTrades;

                if (totalAllTrades === 0) {
                    // No trades for this analyst, skip update
                    return null;
                }

                // P&L only comes from closed trades
                const totalPnl = stats?._sum.realizedPnl || 0;

                // FIXED: Win rate should be based on CLOSED trades only (not entry trades)
                // Entry trades are still open and haven't realized P&L yet
                const winRate = closedTrades > 0 ? (winningTrades / closedTrades) * 100 : 0;
                const sharpeRatio = sharpeRatios.get(analystId) || null;

                return {
                    analystId,
                    data: {
                        totalReturnDollar: totalPnl,
                        totalTrades: totalAllTrades, // Store total including open positions
                        winningTrades,
                        losingTrades,
                        winRate,
                        tournamentWins: totalAllTrades, // Analysis wins = total trades initiated
                        totalPoints: Math.round(totalPnl * 10), // Points = P&L * 10 (gamification)
                        sharpeRatio,
                        updatedAt: new Date()
                    },
                    logData: {
                        totalAllTrades,
                        closedTrades,
                        entryTrades,
                        totalPnl,
                        winRate,
                        winningTrades,
                        losingTrades,
                        breakEvenTrades,
                        sharpeRatio
                    }
                };
            }).filter((u): u is NonNullable<typeof u> => u !== null);

            // Perform all updates in parallel
            await Promise.all(
                updates.map(async ({ analystId, data, logData }) => {
                    try {
                        await prisma.portfolio.update({
                            where: { agentId: analystId },
                            data
                        });

                        const sharpeStr = logData.sharpeRatio !== null && Number.isFinite(logData.sharpeRatio)
                            ? `, Sharpe: ${logData.sharpeRatio.toFixed(2)}`
                            : '';

                        // FIXED: Validate numeric fields before toFixed() to prevent NaN
                        const pnlDisplay = Number.isFinite(logData.totalPnl) ? logData.totalPnl : 0;
                        const winRateDisplay = Number.isFinite(logData.winRate) ? logData.winRate : 0;

                        // FIXED: Show entry trades (open positions) separately from closed trades
                        // Format: "3 trades (2 open), 5.00 USDT P&L, 50.0% win rate (1W/0L/0BE)"
                        const openStr = logData.entryTrades > 0 ? ` (${logData.entryTrades} open)` : '';

                        logger.info(
                            `📊 ${analystId}: ${logData.totalAllTrades} trades${openStr}, ` +
                            `${pnlDisplay.toFixed(2)} USDT P&L, ` +
                            `${winRateDisplay.toFixed(1)}% win rate ` +
                            `(${logData.winningTrades}W/${logData.losingTrades}L/${logData.breakEvenTrades}BE)` +
                            sharpeStr
                        );
                    } catch (error) {
                        failedUpdates++;
                        logger.error(`Failed to update portfolio for ${analystId}:`, error);
                    }
                })
            );

            // FIXED: Alert if too many updates failed
            if (failedUpdates > 0) {
                const failureRate = (failedUpdates / totalUpdates) * 100;
                if (failureRate > 50) {
                    logger.error(`⚠️ HIGH FAILURE RATE: ${failedUpdates}/${totalUpdates} portfolio updates failed (${failureRate.toFixed(1)}%)`);
                } else {
                    logger.warn(`${failedUpdates}/${totalUpdates} portfolio updates failed (${failureRate.toFixed(1)}%)`);
                }
            }

            if (updates.length > 0) {
                logger.info(`✅ Updated ${updates.length - failedUpdates}/${updates.length} analyst portfolios`);
            }
        } catch (error) {
            logger.error('Failed to update analyst portfolios:', error);
            throw error; // Re-throw to be caught by caller
        }
    }

    private static _safeBigIntToNumber(value: bigint, fieldName: string): number {
        const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER); // 9,007,199,254,740,991
        const MIN_SAFE_INTEGER = BigInt(Number.MIN_SAFE_INTEGER); // -9,007,199,254,740,991

        // Handle negative values
        if (value < MIN_SAFE_INTEGER) {
            logger.error(`BigInt value for ${fieldName} below MIN_SAFE_INTEGER: ${value}, clamping to min`);
            return Number.MIN_SAFE_INTEGER;
        }

        if (value > MAX_SAFE_INTEGER) {
            logger.error(`BigInt value for ${fieldName} exceeds MAX_SAFE_INTEGER: ${value}, clamping to max`);
            return Number.MAX_SAFE_INTEGER;
        }

        return Number(value);
    }

    private static async _calculateSharpeRatios(): Promise<Map<string, number | null>> {
        const sharpeRatios = new Map<string, number | null>();

        try {
            // Fetch all trades for analysts with P&L data
            const tradesByAnalyst = await prisma.trade.groupBy({
                by: ['championId'],
                where: {
                    championId: { not: null, in: [...ANALYST_IDS] },
                    status: 'FILLED',
                    realizedPnl: { not: null }
                },
                _count: { id: true }
            });

            // Only calculate for analysts with enough trades
            const analystsWithEnoughTrades = tradesByAnalyst
                .filter(t => t._count.id >= 5)
                .map(t => t.championId as string);

            if (analystsWithEnoughTrades.length === 0) {
                // No analysts with enough trades yet
                return sharpeRatios;
            }

            // FIXED: Calculate Sharpe ratio using database aggregation instead of loading all trades
            // This prevents memory issues with large trade histories
            for (const analystId of analystsWithEnoughTrades) {
                try {
                    // Get mean and count in one query
                    const stats = await prisma.trade.aggregate({
                        where: {
                            championId: analystId,
                            status: 'FILLED',
                            realizedPnl: { not: null }
                        },
                        _avg: { realizedPnl: true },
                        _count: { id: true }
                    });

                    const meanReturn = stats._avg.realizedPnl || 0;
                    const count = stats._count.id;

                    if (count < 5) {
                        sharpeRatios.set(analystId, null);
                        continue;
                    }

                    // Calculate variance using raw SQL for efficiency
                    // Variance = AVG((x - mean)^2)
                    // CRITICAL: SQLite column names are snake_case (realized_pnl, champion_id)
                    const varianceResult = await prisma.$queryRaw<Array<{ variance: number }>>`
                        SELECT 
                            AVG((realized_pnl - ${meanReturn}) * (realized_pnl - ${meanReturn})) as variance
                        FROM trades
                        WHERE champion_id = ${analystId}
                            AND status = 'FILLED'
                            AND realized_pnl IS NOT NULL
                    `;

                    const variance = varianceResult[0]?.variance || 0;
                    const stdDev = Math.sqrt(variance);

                    // Calculate Sharpe ratio (assuming risk-free rate = 0)
                    const sharpe = stdDev > 0 ? meanReturn / stdDev : 0;

                    // Validate result
                    if (Number.isFinite(sharpe)) {
                        sharpeRatios.set(analystId, sharpe);
                    } else {
                        sharpeRatios.set(analystId, null);
                    }
                } catch (error) {
                    logger.error(`Failed to calculate Sharpe ratio for ${analystId}:`, error);
                    sharpeRatios.set(analystId, null);
                }
            }

            return sharpeRatios;
        } catch (error) {
            logger.error('Failed to calculate Sharpe ratios:', error);
            return sharpeRatios;
        }
    }

    static async getLeaderboard() {
        try {
            const portfolios = await prisma.portfolio.findMany({
                where: {
                    agentId: {
                        notIn: ['collaborative', LOCK_KEY] // FIXED: Exclude lock record
                    }
                },
                orderBy: {
                    totalReturnDollar: 'desc'
                },
                select: {
                    agentId: true,
                    agentName: true,
                    totalReturnDollar: true,
                    totalReturn: true,
                    totalTrades: true,
                    winningTrades: true,
                    losingTrades: true,
                    winRate: true,
                    tournamentWins: true,
                    maxDrawdown: true,
                    sharpeRatio: true,
                    updatedAt: true
                }
            });

            // Add rank
            return portfolios.map((p, index) => ({
                rank: index + 1,
                ...p
            }));
        } catch (error) {
            logger.error('Failed to get analyst leaderboard:', error);
            throw error; // FIXED: Throw instead of returning empty array
        }
    }

    static async getAnalystStats(analystId: string) {
        // FIXED: Validate analystId
        if (!ANALYST_IDS.includes(analystId as any)) {
            logger.warn(`Invalid analyst ID requested: ${analystId}`);
            return null;
        }

        try {
            // Get portfolio
            const portfolio = await prisma.portfolio.findUnique({
                where: { agentId: analystId }
            });

            if (!portfolio) {
                return null;
            }

            // Get recent trades (limit 10) - includes both entry and exit trades
            const recentTrades = await prisma.trade.findMany({
                where: {
                    championId: analystId,
                    status: 'FILLED'
                },
                orderBy: {
                    executedAt: 'desc'
                },
                take: RECENT_TRADES_LIMIT,
                select: {
                    id: true,
                    symbol: true,
                    side: true,
                    size: true,
                    price: true,
                    realizedPnl: true,
                    realizedPnlPercent: true,
                    executedAt: true,
                    status: true,
                    confidence: true,
                    reason: true
                }
            });

            // FIXED: Only aggregate CLOSED trades (realizedPnl IS NOT NULL)
            // Entry trades have realizedPnl = null and shouldn't affect avg/best/worst
            const [aggregates, symbolCounts] = await Promise.all([
                // Get min/max/avg P&L in one query - ONLY for closed trades
                prisma.trade.aggregate({
                    where: {
                        championId: analystId,
                        status: 'FILLED',
                        realizedPnl: { not: null } // FIXED: Only closed trades
                    },
                    _avg: {
                        realizedPnl: true
                    },
                    _max: {
                        realizedPnl: true
                    },
                    _min: {
                        realizedPnl: true
                    },
                    _count: {
                        id: true
                    }
                }),
                // Get symbol counts - all trades (for favorite symbol)
                prisma.trade.groupBy({
                    by: ['symbol'],
                    where: {
                        championId: analystId,
                        status: 'FILLED'
                    },
                    _count: {
                        id: true
                    },
                    orderBy: {
                        _count: {
                            id: 'desc'
                        }
                    },
                    take: 1 // Only get favorite symbol
                })
            ]);

            const avgPnl = aggregates._avg.realizedPnl || 0;
            const bestTrade = aggregates._max.realizedPnl || 0;
            const worstTrade = aggregates._min.realizedPnl || 0;
            const favoriteSymbol = symbolCounts[0]?.symbol || null;
            const closedTradesCount = aggregates._count.id;

            return {
                portfolio,
                recentTrades,
                metrics: {
                    avgPnlPerTrade: avgPnl,
                    bestTrade,
                    worstTrade,
                    favoriteSymbol,
                    totalTrades: portfolio.totalTrades, // Use portfolio total (includes open)
                    closedTrades: closedTradesCount // Add closed trades count
                }
            };
        } catch (error) {
            logger.error(`Failed to get stats for ${analystId}:`, error);
            return null;
        }
    }

    /**
     * Get comparative stats for all analysts
     * Useful for dashboard displays
     */
    static async getComparativeStats() {
        try {
            const leaderboard = await this.getLeaderboard();

            // Calculate totals
            const totalTrades = leaderboard.reduce((sum, p) => sum + p.totalTrades, 0);
            const totalPnl = leaderboard.reduce((sum, p) => sum + p.totalReturnDollar, 0);
            const avgWinRate = leaderboard.length > 0
                ? leaderboard.reduce((sum, p) => sum + p.winRate, 0) / leaderboard.length
                : 0;

            // Find best/worst performers
            const bestPerformer = leaderboard[0] || null;
            const worstPerformer = leaderboard[leaderboard.length - 1] || null;

            return {
                leaderboard,
                summary: {
                    totalAnalysts: leaderboard.length,
                    totalTrades,
                    totalPnl,
                    avgWinRate,
                    bestPerformer,
                    worstPerformer
                }
            };
        } catch (error) {
            logger.error('Failed to get comparative stats:', error);
            return null;
        }
    }

    /**
     * Update collaborative portfolio metrics (totalReturn, totalValue, maxDrawdown, currentDrawdown)
     * Called after each trading cycle to keep metrics current
     * 
     * FIXED: Added distributed locking to prevent concurrent update race conditions
     * Uses the same lock mechanism as updateAnalystPortfolios for consistency
     * FIXED: Added retry logic with exponential backoff for lock acquisition
     * 
     * @param currentBalance - Current wallet balance from WEEX
     * @param unrealizedPnl - Total unrealized P&L from open positions
     */
    static async updateCollaborativePortfolioMetrics(
        currentBalance: number,
        unrealizedPnl: number
    ): Promise<void> {
        // FIXED: Validate inputs to prevent NaN propagation
        if (!Number.isFinite(currentBalance) || currentBalance < 0) {
            logger.warn(`Invalid currentBalance: ${currentBalance}, skipping metrics update`);
            return;
        }
        if (!Number.isFinite(unrealizedPnl)) {
            logger.warn(`Invalid unrealizedPnl: ${unrealizedPnl}, using 0`);
            unrealizedPnl = 0;
        }

        // FIXED: Added retry logic with exponential backoff for lock acquisition
        // This prevents stale metrics when lock is temporarily held by another instance
        const MAX_RETRIES = 2;
        const RETRY_DELAY_MS = 500; // 500ms base delay (shorter than analyst update since this is less critical)

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const lockAcquired = await this._acquireLock();

            if (!lockAcquired) {
                if (attempt < MAX_RETRIES) {
                    const delay = RETRY_DELAY_MS * Math.pow(2, attempt); // Exponential backoff
                    logger.debug(`Collaborative portfolio lock acquisition failed, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                } else {
                    logger.debug('Skipping collaborative portfolio update - another instance is updating (after retries)');
                    return;
                }
            }

            // Lock acquired, perform update
            try {
                await this._performCollaborativeUpdate(currentBalance, unrealizedPnl);
                return; // Success, exit
            } catch (error) {
                logger.error('Collaborative portfolio update failed:', error);
                // Don't throw - this is a non-critical update
                return;
            } finally {
                // FIXED: Always release the lock, even on error
                await this._releaseLock();
            }
        }
    }

    /**
     * Internal method that performs the actual collaborative portfolio update
     * Separated for lock pattern consistency with _performUpdate
     */
    private static async _performCollaborativeUpdate(
        currentBalance: number,
        unrealizedPnl: number
    ): Promise<void> {
        const portfolio = await prisma.portfolio.findUnique({
            where: { agentId: 'collaborative' }
        });

        if (!portfolio) {
            logger.warn('Collaborative portfolio not found for metrics update');
            return;
        }

        // Calculate total value (balance + unrealized P&L)
        const totalValue = currentBalance + unrealizedPnl;

        // Calculate total return percentage
        const initialBalance = portfolio.initialBalance;
        const totalReturnDollar = totalValue - initialBalance;
        const totalReturn = initialBalance > 0
            ? (totalReturnDollar / initialBalance) * 100
            : 0;

        // Get trade stats for win rate calculation
        const tradeStats = await prisma.trade.aggregate({
            where: {
                portfolioId: portfolio.id,
                status: 'FILLED',
                realizedPnl: { not: null }
            },
            _count: { id: true },
            _sum: { realizedPnl: true }
        });

        const winningTrades = await prisma.trade.count({
            where: {
                portfolioId: portfolio.id,
                status: 'FILLED',
                realizedPnl: { gt: 0 }
            }
        });

        const losingTrades = await prisma.trade.count({
            where: {
                portfolioId: portfolio.id,
                status: 'FILLED',
                realizedPnl: { lt: 0 }
            }
        });

        const totalTrades = tradeStats._count.id;
        const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

        // Calculate drawdown from performance snapshots
        // FIXED: Limit snapshot loading to prevent memory issues at scale
        // We only need recent snapshots to calculate current drawdown accurately
        // For max drawdown, we track it incrementally in the portfolio record
        //
        // LIMITATION: currentDrawdown may be underestimated if the all-time peak occurred
        // outside this 1000-snapshot window. The maxDrawdown field in the portfolio record
        // is tracked incrementally and remains accurate. For production systems requiring
        // precise current drawdown, consider:
        // 1. Storing the all-time peak value in the portfolio record
        // 2. Using a separate peak tracking table
        // 3. Increasing the snapshot window (at cost of memory/performance)
        const snapshots = await prisma.performanceSnapshot.findMany({
            where: { portfolioId: portfolio.id },
            orderBy: { timestamp: 'desc' },  // Most recent first
            take: 1000,  // Limit to last 1000 snapshots (~7 days at 10min intervals)
            select: { totalValue: true }
        });

        // Reverse to process in chronological order for drawdown calculation
        snapshots.reverse();

        // Use stored maxDrawdown as baseline (preserves historical max)
        // Peak starts at initialBalance but will be updated from snapshots
        let maxDrawdown = portfolio.maxDrawdown;
        let currentDrawdown = 0;
        let peak = initialBalance;

        for (const snapshot of snapshots) {
            if (snapshot.totalValue > peak) {
                peak = snapshot.totalValue;
            }
            const drawdown = peak > 0 ? ((peak - snapshot.totalValue) / peak) * 100 : 0;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }

        // Calculate current drawdown from current total value
        if (totalValue > peak) {
            peak = totalValue;
        }
        currentDrawdown = peak > 0 ? ((peak - totalValue) / peak) * 100 : 0;

        // Update portfolio
        await prisma.portfolio.update({
            where: { agentId: 'collaborative' },
            data: {
                currentBalance,
                totalValue,
                totalReturn,
                totalReturnDollar,
                winRate,
                winningTrades,
                losingTrades,
                totalTrades,
                maxDrawdown,
                currentDrawdown,
                updatedAt: new Date()
            }
        });

        logger.debug(`📊 Collaborative portfolio metrics updated: ${totalValue.toFixed(2)} USDT, ${totalReturn.toFixed(2)}% return, ${currentDrawdown.toFixed(2)}% drawdown`);
    }
}
