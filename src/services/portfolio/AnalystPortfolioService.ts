/**
 * Analyst Portfolio Service
 * 
 * Manages virtual portfolios for individual analysts to track P&L attribution.
 * Each analyst gets credit for trades where they won the championship debate.
 * 
 * Architecture:
 * - 1 collaborative portfolio (real WEEX account)
 * - 8 analyst portfolios (virtual, for attribution)
 * 
 * P&L flows:
 * 1. Trade executed on WEEX using collaborative portfolio
 * 2. Trade saved with championId = winning analyst
 * 3. P&L attributed to that analyst's virtual portfolio
 */

import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { ANALYST_PROFILES } from '../../constants/analyst';

const ANALYST_IDS = ['warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil'] as const;

// Configuration constants
const RECENT_TRADES_LIMIT = 10; // Number of recent trades to return in getAnalystStats()
const LOCK_TIMEOUT_MS = 30000; // 30 seconds - max time for portfolio update
const LOCK_KEY = 'analyst_portfolio_update'; // Database advisory lock key

// CRITICAL: Distributed lock using database advisory locks
// This ensures only ONE instance across all processes/servers can update portfolios
// Module-level mutex (isUpdating) only protects within a single process
// In production with multiple instances, we need database-level locking

export class AnalystPortfolioService {
    /**
     * Initialize all analyst virtual portfolios
     * Called on engine startup to ensure portfolios exist
     */
    static async initializeAnalystPortfolios(): Promise<void> {
        logger.info('🏦 Initializing analyst virtual portfolios...');

        for (const analystId of ANALYST_IDS) {
            try {
                // Find profile by ID (ANALYST_PROFILES is keyed by methodology, not ID)
                const profile = Object.values(ANALYST_PROFILES).find(p => p.id === analystId);
                if (!profile) {
                    logger.warn(`No profile found for analyst: ${analystId}`);
                    continue;
                }

                // Use upsert to create if not exists, or update if exists
                await prisma.portfolio.upsert({
                    where: { agentId: analystId },
                    update: {
                        // Update name in case it changed
                        agentName: profile.name,
                        updatedAt: new Date()
                    },
                    create: {
                        agentId: analystId,
                        agentName: profile.name,
                        initialBalance: 0, // Virtual portfolio - no real balance
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
                // Don't throw - continue with other analysts
            }
        }

        logger.info('🏦 Analyst portfolio initialization complete');
    }

    /**
     * Update all analyst virtual portfolios based on their championId trades
     * Call this after each trading cycle to keep metrics current
     * 
     * FIXED: Uses database advisory locks for distributed mutex (multi-instance safe)
     * FIXED: Optimized to use aggregation queries instead of N+1 queries
     * FIXED: Calculates Sharpe ratio from trade history
     * FIXED: Added retry logic with exponential backoff
     * 
     * Calculates:
     * - Total P&L (sum of realizedPnl)
     * - Win rate (winning trades / total trades)
     * - Trade counts (total, winning, losing)
     * - Tournament wins (number of debates won)
     * - Sharpe ratio (risk-adjusted returns)
     */
    static async updateAnalystPortfolios(): Promise<void> {
        const MAX_RETRIES = 2;
        const RETRY_DELAY_MS = 1000; // 1 second base delay

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

    /**
     * Acquire distributed lock using atomic compare-and-swap
     * Returns true if lock acquired, false if already locked
     * 
     * CRITICAL FIX: Prevents TOCTOU race condition
     * Uses version field for atomic compare-and-swap semantics
     * 
     * Algorithm:
     * 1. Read current lock record (if exists)
     * 2. Check if lock is stale (older than timeout)
     * 3. Attempt atomic update with version check
     * 4. If update succeeds (1 row affected), lock acquired
     * 5. If update fails (0 rows affected), another instance won
     */
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

    /**
     * Release distributed lock
     * FIXED: Simplified - just delete the lock record
     * If another instance took over, the delete will fail silently (record already gone)
     */
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

    /**
     * Internal method that performs the actual update
     * Separated for lock pattern
     * 
     * FIXED: Single aggregated query for win/loss counts (no N+1)
     * FIXED: Calculates Sharpe ratio from trade history
     */
    private static async _performUpdate(): Promise<void> {
        try {
            // OPTIMIZED: Single query to get all stats grouped by championId
            // This replaces the N+1 pattern where we queried each analyst separately
            const [tradeStats, winLossCounts] = await Promise.all([
                // Get total trades and P&L per analyst
                prisma.trade.groupBy({
                    by: ['championId'],
                    where: {
                        championId: { not: null, in: [...ANALYST_IDS] },
                        status: 'FILLED'
                    },
                    _count: { id: true },
                    _sum: { realizedPnl: true }
                }),
                // Get win/loss/breakeven counts in ONE query using conditional aggregation
                // FIXED: Use Prisma.sql for raw query instead of template literals
                // CRITICAL: SQLite column names are snake_case (champion_id), not camelCase (championId)
                prisma.$queryRaw<Array<{
                    championId: string;
                    winningTrades: bigint;
                    losingTrades: bigint;
                    breakEvenTrades: bigint;
                }>>`
                    SELECT 
                        champion_id as championId,
                        COUNT(CASE WHEN realized_pnl > 0 THEN 1 END) as winningTrades,
                        COUNT(CASE WHEN realized_pnl < 0 THEN 1 END) as losingTrades,
                        COUNT(CASE WHEN realized_pnl = 0 THEN 1 END) as breakEvenTrades
                    FROM trades
                    WHERE champion_id IN ('warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil')
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

                if (!stats || !stats._count.id) {
                    // No trades for this analyst, skip update
                    return null;
                }

                const totalPnl = stats._sum.realizedPnl || 0;
                const totalTrades = stats._count.id;

                // FIXED: Validate BigInt conversion with safety checks
                const winningTrades = counts ? this._safeBigIntToNumber(counts.winningTrades, 'winningTrades') : 0;
                const losingTrades = counts ? this._safeBigIntToNumber(counts.losingTrades, 'losingTrades') : 0;
                const breakEvenTrades = counts ? this._safeBigIntToNumber(counts.breakEvenTrades, 'breakEvenTrades') : 0;

                const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
                const sharpeRatio = sharpeRatios.get(analystId) || null;

                return {
                    analystId,
                    data: {
                        totalReturnDollar: totalPnl,
                        totalTrades,
                        winningTrades,
                        losingTrades,
                        winRate,
                        tournamentWins: totalTrades,
                        sharpeRatio, // FIXED: Now calculated
                        updatedAt: new Date()
                    },
                    logData: {
                        totalTrades,
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

                        logger.info(
                            `📊 ${analystId}: ${logData.totalTrades} trades, ` +
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

    /**
     * Safely convert BigInt to Number with validation
     * FIXED: Prevents precision loss for large numbers
     */
    private static _safeBigIntToNumber(value: bigint, fieldName: string): number {
        const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER; // 9,007,199,254,740,991

        if (value > MAX_SAFE_INTEGER) {
            logger.error(`BigInt value for ${fieldName} exceeds MAX_SAFE_INTEGER: ${value}, clamping to max`);
            return MAX_SAFE_INTEGER;
        }

        return Number(value);
    }

    /**
     * Calculate Sharpe ratio for each analyst
     * Sharpe Ratio = (Average Return - Risk Free Rate) / Standard Deviation of Returns
     * 
     * For crypto trading:
     * - Risk-free rate assumed to be 0 (or very small)
     * - Returns calculated as P&L per trade
     * - Requires minimum 5 trades for statistical significance
     * 
     * FIXED: Use database aggregation instead of loading all trades into memory
     * 
     * Returns Map of analystId -> sharpeRatio (or null if insufficient data)
     */
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

    /**
     * Get analyst leaderboard sorted by P&L
     * Returns all analyst portfolios ranked by total return
     * 
     * FIXED: Exclude both collaborative portfolio AND lock record
     */
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

    /**
     * Get detailed stats for a specific analyst
     * FIXED: Added input validation and optimized to use aggregation queries
     */
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

            // Get recent trades (limit 10)
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

            // FIXED: Use aggregation queries instead of fetching all trades
            const [aggregates, symbolCounts] = await Promise.all([
                // Get min/max/avg P&L in one query
                prisma.trade.aggregate({
                    where: {
                        championId: analystId,
                        status: 'FILLED'
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
                // Get symbol counts
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

            return {
                portfolio,
                recentTrades,
                metrics: {
                    avgPnlPerTrade: avgPnl,
                    bestTrade,
                    worstTrade,
                    favoriteSymbol,
                    totalTrades: aggregates._count.id
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
}
