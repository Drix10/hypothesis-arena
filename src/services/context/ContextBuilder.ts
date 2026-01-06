/**
 * Context Builder for v5.0.0
 * 
 * Builds rich context object like competitor's approach.
 * Aggregates account state, positions, market data with indicators, and trade history.
 */

import { config, getActiveTradingStyle } from '../../config';
import { logger } from '../../utils/logger';
import { PrismaClient } from '@prisma/client';
import {
    TradingContext,
    AccountState,
    EnrichedPosition,
    ActiveTrade,
    DiaryEntry,
    RecentFill,
    MarketDataWithIndicators,
    PerformanceMetrics,
    Instructions,
    convertIndicatorsToMarketData,
} from '../../types/context';
import { getTechnicalIndicatorService } from '../indicators/TechnicalIndicatorService';
import { ANTI_CHURN_RULES, LEVERAGE_POLICY } from '../../constants/prompts/analystPrompt';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';

// Use canonical APPROVED_SYMBOLS from shared types (single source of truth)
const TRADING_SYMBOLS = APPROVED_SYMBOLS;

export class ContextBuilder {
    private prisma: PrismaClient;
    private invocationCount: number = 0;
    private readonly MAX_INVOCATION_COUNT = Number.MAX_SAFE_INTEGER - 1; // Prevent overflow
    private lastInvocationTime: number = 0; // Track for rate limiting detection

    constructor(prisma: PrismaClient) {
        if (!prisma) {
            throw new Error('ContextBuilder: PrismaClient is required');
        }
        this.prisma = prisma;
        logger.info('ContextBuilder initialized');
    }

    /**
     * Build full context object for analysts
     */
    async buildContext(
        accountBalance: number,
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            leverage: number;
            unrealizedPnl: number;
            liquidationPrice?: number;
        }>,
        marketDataFetcher: (symbol: string) => Promise<{
            currentPrice: number;
            high24h: number;
            low24h: number;
            volume24h: number;
            change24h: number;
            fundingRate: number;
            openInterest: number | null;
        }>
    ): Promise<TradingContext> {
        // FIXED: Prevent invocationCount overflow
        if (this.invocationCount >= this.MAX_INVOCATION_COUNT) {
            logger.warn('Invocation count approaching overflow, resetting to 0');
            this.invocationCount = 0;
        }
        this.invocationCount++;

        // FIXED: Track invocation time for rate limiting detection
        const now = Date.now();
        const timeSinceLastInvocation = now - this.lastInvocationTime;
        if (this.lastInvocationTime > 0 && timeSinceLastInvocation < 100) {
            // Less than 100ms between invocations - possible tight loop
            logger.warn(`Rapid context building detected: ${timeSinceLastInvocation}ms since last invocation`);
        }
        this.lastInvocationTime = now;

        const currentTime = new Date().toISOString();

        // Fetch all market data and indicators in parallel
        const marketDataPromises = TRADING_SYMBOLS.map(async (symbol) => {
            try {
                const [ticker, indicators] = await Promise.all([
                    marketDataFetcher(symbol),
                    this.getIndicatorsForSymbol(symbol),
                ]);

                if (!indicators) {
                    logger.warn(`No indicators available for ${symbol}`);
                    return null;
                }

                return convertIndicatorsToMarketData(
                    symbol,
                    ticker,
                    indicators,
                    ticker.fundingRate,
                    ticker.openInterest
                );
            } catch (error) {
                logger.error(`Failed to fetch market data for ${symbol}:`, error);
                return null;
            }
        });

        const marketDataResults = await Promise.all(marketDataPromises);
        const marketData = marketDataResults.filter((m): m is MarketDataWithIndicators => m !== null);

        // FIXED: Warn if no market data available (all symbols failed)
        // This helps diagnose connectivity issues with WEEX API
        if (marketData.length === 0) {
            logger.warn('No market data available for any symbol - all fetches failed');
        } else if (marketData.length < TRADING_SYMBOLS.length) {
            logger.warn(`Partial market data: ${marketData.length}/${TRADING_SYMBOLS.length} symbols available`);
        }

        // Get account state
        const [recentTrades, recentFills, metrics] = await Promise.all([
            this.getRecentTrades(10),
            this.getRecentFills(20),
            this.calculatePerformanceMetrics(),
        ]);

        // Enrich positions with current data from market data
        const enrichedPositions = this.enrichPositions(positions, marketData);

        // Create a map of enriched prices for consistency
        const enrichedPriceMap = new Map<string, number>();
        for (const pos of enrichedPositions) {
            enrichedPriceMap.set(pos.symbol.toLowerCase(), pos.current_price);
        }

        // Pass enriched prices to ensure consistency between positions and active_trades
        const activeTrades = await this.getActiveTradesWithExitPlans(positions, enrichedPriceMap);

        const accountState: AccountState = {
            balance: accountBalance,
            total_value: accountBalance + positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
            total_return_pct: metrics.total_return_pct,
            profit_factor: metrics.profit_factor,
            positions: enrichedPositions,
            active_trades: activeTrades,
            open_orders: [], // Open orders not currently tracked - positions are managed via SL/TP
            recent_diary: recentTrades,
            recent_fills: recentFills,
        };

        const tradingStyle = getActiveTradingStyle();

        const instructions: Instructions = {
            assets: TRADING_SYMBOLS,
            anti_churn_rules: ANTI_CHURN_RULES,
            leverage_policy: LEVERAGE_POLICY,
            trading_style: tradingStyle.style,
        };

        return {
            invocation: {
                count: this.invocationCount,
                current_time: currentTime,
            },
            account: accountState,
            market_data: marketData,
            instructions,
        };
    }

    /**
     * Get technical indicators for a symbol
     */
    private async getIndicatorsForSymbol(symbol: string) {
        try {
            const indicatorService = getTechnicalIndicatorService();
            return await indicatorService.getIndicators(symbol);
        } catch (error) {
            logger.error(`Failed to get indicators for ${symbol}:`, error);
            return null;
        }
    }

    /**
     * Enrich positions with current market data
     */
    private enrichPositions(
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            leverage: number;
            unrealizedPnl: number;
            liquidationPrice?: number;
        }>,
        marketData: MarketDataWithIndicators[]
    ): EnrichedPosition[] {
        return positions.map((pos) => {
            const market = marketData.find((m) => m.asset === pos.symbol);
            const currentPrice = market?.current_price || pos.currentPrice;

            // FIXED: Division by zero protection for pnlPct calculation
            const pnlPct = (Number.isFinite(pos.entryPrice) && pos.entryPrice !== 0)
                ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100 * (pos.side === 'LONG' ? 1 : -1)
                : 0;

            // FIXED: Division by zero protection for margin_used calculation
            const marginUsed = (Number.isFinite(pos.leverage) && pos.leverage > 0)
                ? (pos.size * pos.entryPrice) / pos.leverage
                : 0;

            return {
                symbol: pos.symbol,
                side: pos.side,
                size: pos.size,
                entry_price: pos.entryPrice,
                current_price: currentPrice,
                liquidation_price: pos.liquidationPrice || null,
                unrealized_pnl: pos.unrealizedPnl,
                unrealized_pnl_pct: Number.isFinite(pnlPct) ? pnlPct : 0,
                leverage: pos.leverage,
                margin_used: Number.isFinite(marginUsed) ? marginUsed : 0,
            };
        });
    }

    /**
     * Get active trades with exit plans from database
     * FIXED: Batch query to avoid N+1 problem
     * FIXED: Use enriched prices for consistency with enrichedPositions
     */
    private async getActiveTradesWithExitPlans(
        positions: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            leverage: number;
            unrealizedPnl: number;
        }>,
        enrichedPriceMap?: Map<string, number>
    ): Promise<ActiveTrade[]> {
        if (positions.length === 0) {
            return [];
        }

        // Batch fetch all open trades for the position symbols in a single query
        const symbols = positions.map(p => p.symbol);
        const trades = await this.prisma.trade.findMany({
            where: {
                symbol: { in: symbols },
                status: 'OPEN',
            },
            orderBy: {
                createdAt: 'desc',
            },
        });

        // Create a map for O(1) lookup: symbol -> most recent trade
        const tradeMap = new Map<string, typeof trades[0]>();
        for (const trade of trades) {
            // Only keep the most recent trade per symbol (already ordered by createdAt desc)
            if (!tradeMap.has(trade.symbol)) {
                tradeMap.set(trade.symbol, trade);
            }
        }

        const activeTrades: ActiveTrade[] = [];

        for (const pos of positions) {
            const trade = tradeMap.get(pos.symbol);

            // FIXED: Use enriched price if available for consistency with enrichedPositions
            const currentPrice = enrichedPriceMap?.get(pos.symbol.toLowerCase()) ?? pos.currentPrice;

            const pnlPct = this.calculatePnlPercent(currentPrice, pos.entryPrice, pos.side);
            // NOTE: If no trade record found, we use current time as fallback.
            // This means hold_time_hours will be 0 for positions without DB records.
            // This is acceptable as it's a conservative estimate (won't trigger time-based exits).
            const openedAt = trade?.createdAt || new Date();
            // FIXED: Ensure holdTimeHours is never negative (clock skew protection)
            const holdTimeHours = Math.max(0, (Date.now() - openedAt.getTime()) / (1000 * 60 * 60));

            activeTrades.push({
                asset: pos.symbol,
                is_long: pos.side === 'LONG',
                amount: pos.size,
                entry_price: pos.entryPrice,
                current_price: currentPrice,
                unrealized_pnl: pos.unrealizedPnl,
                unrealized_pnl_pct: pnlPct,
                exit_plan: trade?.exitPlan || 'No exit plan recorded',
                entry_thesis: trade?.entryThesis || 'No thesis recorded',
                opened_at: openedAt.toISOString(),
                hold_time_hours: holdTimeHours,
                entry_confidence: trade?.entryConfidence || 50,
                tp_price: trade?.takeProfit || null,
                sl_price: trade?.stopLoss || null,
            });
        }

        return activeTrades;
    }

    /**
     * Calculate P&L percentage with division by zero protection
     * FIXED: Also validate currentPrice to prevent NaN propagation
     */
    private calculatePnlPercent(currentPrice: number, entryPrice: number, side: 'LONG' | 'SHORT'): number {
        if (!Number.isFinite(entryPrice) || entryPrice === 0) {
            return 0;
        }
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            return 0;
        }
        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1);
        return Number.isFinite(pnlPct) ? pnlPct : 0;
    }

    /**
     * Get recent trade decisions (diary entries)
     */
    private async getRecentTrades(limit: number): Promise<DiaryEntry[]> {
        try {
            const trades = await this.prisma.trade.findMany({
                orderBy: { createdAt: 'desc' },
                take: limit,
            });

            return trades.map((trade) => {
                // FIXED: Validate numeric values before calculations
                const size = Number.isFinite(trade.size) ? trade.size : 0;
                const entryPrice = Number.isFinite(trade.entryPrice) ? trade.entryPrice : 0;

                // FIXED: Use nullish coalescing to handle zero values correctly
                // allocationUsd of 0 is valid (e.g., HOLD actions), don't fallback to calculation
                const allocationUsd = trade.allocationUsd ?? (size * entryPrice);

                return {
                    timestamp: trade.createdAt.toISOString(),
                    asset: trade.symbol,
                    action: trade.action || trade.side, // Use action if available, fallback to side
                    allocation_usd: Number.isFinite(allocationUsd) ? allocationUsd : 0,
                    entry_price: entryPrice,
                    tp_price: trade.takeProfit,
                    sl_price: trade.stopLoss,
                    exit_plan: trade.exitPlan || '',
                    rationale: trade.rationale || '',
                    champion: trade.championId || 'unknown',
                    result: this.mapTradeStatus(trade.status, trade.realizedPnl),
                    realized_pnl: trade.realizedPnl,
                };
            });
        } catch (error) {
            logger.error('Failed to get recent trades:', error);
            return [];
        }
    }

    /**
     * Map trade status to result
     * 
     * FIXED: CANCELED and FAILED trades should not use PnL logic - they never executed
     */
    private mapTradeStatus(status: string, realizedPnl: number | null): 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN' | null {
        switch (status) {
            case 'OPEN':
            case 'PENDING':
                return 'OPEN';
            case 'FILLED':
                // Only FILLED trades have meaningful P&L
                if (realizedPnl === null || realizedPnl === undefined) return null;
                if (realizedPnl > 0) return 'WIN';
                if (realizedPnl < 0) return 'LOSS';
                return 'BREAKEVEN';
            case 'CANCELED':
            case 'FAILED':
                // FIXED: These trades never executed, so no P&L result
                return null;
            default:
                return null;
        }
    }

    /**
     * Get recent fills from database
     * 
     * NOTE: This returns FILLED trades only, excluding CANCELED and FAILED trades.
     * CANCELED/FAILED trades never executed on the exchange, so they don't represent
     * actual fills and shouldn't be included in fill history.
     */
    private async getRecentFills(limit: number): Promise<RecentFill[]> {
        try {
            // Only include FILLED trades - CANCELED/FAILED never executed
            const trades = await this.prisma.trade.findMany({
                where: { status: 'FILLED' },
                orderBy: { createdAt: 'desc' },
                take: limit,
            });

            return trades.map((trade) => ({
                timestamp: trade.createdAt.toISOString(),
                symbol: trade.symbol,
                side: trade.side,
                size: trade.size,
                price: trade.entryPrice,
                fee: trade.fee,
                realized_pnl: trade.realizedPnl,
            }));
        } catch (error) {
            logger.error('Failed to get recent fills:', error);
            return [];
        }
    }

    /**
     * Calculate performance metrics
     * 
     * NOTE: Drawdown calculation requires trades to be processed in chronological order.
     * The query orders by createdAt ASC for proper drawdown calculation.
     */
    private async calculatePerformanceMetrics(): Promise<PerformanceMetrics> {
        try {
            // Get all filled trades to calculate metrics - ordered by createdAt ASC for drawdown
            const trades = await this.prisma.trade.findMany({
                where: {
                    status: 'FILLED',
                    realizedPnl: { not: null }
                },
                orderBy: { createdAt: 'asc' }, // FIXED: Order chronologically for drawdown calculation
            });

            if (trades.length === 0) {
                return this.getDefaultMetrics();
            }

            const wins = trades.filter((t) => (t.realizedPnl || 0) > 0);
            const losses = trades.filter((t) => (t.realizedPnl || 0) < 0);

            const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
            const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / wins.length : 0;
            const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / losses.length) : 0;

            // FIXED: Validate startingBalance to prevent division by zero
            const startingBalance = config.trading?.startingBalance;
            if (!Number.isFinite(startingBalance) || startingBalance <= 0) {
                logger.warn(`Invalid startingBalance in config: ${startingBalance}, using 0 for total_return_pct`);
            }
            const totalReturnPct = (Number.isFinite(startingBalance) && startingBalance > 0)
                ? (totalPnl / startingBalance) * 100
                : 0;

            // NOTE: This is profit_factor, not true Sharpe ratio
            // True Sharpe = (mean return - risk-free rate) / std dev of returns
            // FIXED: When avgLoss is 0 (no losing trades), profit factor is infinite
            // We cap it at a high value to indicate excellent performance without breaking calculations
            const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);

            // Calculate drawdown (trades are now in chronological order)
            // FIXED: Use validated startingBalance for drawdown calculation
            const validStartingBalance = (Number.isFinite(startingBalance) && startingBalance > 0)
                ? startingBalance
                : 1000; // Fallback to prevent division by zero in drawdown calc
            let peak = validStartingBalance;
            let maxDrawdown = 0;
            let runningBalance = validStartingBalance;

            for (const trade of trades) {
                runningBalance += trade.realizedPnl || 0;
                if (runningBalance > peak) peak = runningBalance;
                // FIXED: Division by zero protection for drawdown
                const drawdown = peak > 0 ? (peak - runningBalance) / peak : 0;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            }

            // Recent trade counts
            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const tradesLast24h = trades.filter((t) => t.createdAt > oneDayAgo).length;
            const tradesLast7d = trades.filter((t) => t.createdAt > sevenDaysAgo).length;

            // FIXED: Division by zero protection for current drawdown
            const currentDrawdown = peak > 0 ? ((peak - runningBalance) / peak) * 100 : 0;

            return {
                total_return_pct: totalReturnPct,
                profit_factor: profitFactor,
                win_rate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
                avg_win: avgWin,
                avg_loss: avgLoss,
                max_drawdown: maxDrawdown * 100,
                current_drawdown: currentDrawdown,
                trades_last_24h: tradesLast24h,
                trades_last_7d: tradesLast7d,
                total_trades: trades.length,
            };
        } catch (error) {
            logger.error('Failed to calculate performance metrics:', error);
            return this.getDefaultMetrics();
        }
    }

    /**
     * Get default metrics when no data available
     */
    private getDefaultMetrics(): PerformanceMetrics {
        return {
            total_return_pct: 0,
            profit_factor: 0,
            win_rate: 0,
            avg_win: 0,
            avg_loss: 0,
            max_drawdown: 0,
            current_drawdown: 0,
            trades_last_24h: 0,
            trades_last_7d: 0,
            total_trades: 0,
        };
    }

    /**
     * Format context as JSON string for prompts
     */
    formatContextForPrompt(context: TradingContext): string {
        return JSON.stringify(context, null, 2);
    }

    /**
     * Get invocation count
     */
    getInvocationCount(): number {
        return this.invocationCount;
    }

    /**
     * Reset invocation count (for testing)
     */
    resetInvocationCount(): void {
        this.invocationCount = 0;
    }
}

// Singleton instance
let contextBuilderInstance: ContextBuilder | null = null;
// Track the PrismaClient used to create the singleton for misuse detection
let contextBuilderPrismaRef: WeakRef<PrismaClient> | null = null;

/**
 * Get singleton instance of ContextBuilder
 * 
 * WARNING: Singleton pattern with PrismaClient parameter
 * The prisma parameter is only used when creating the first instance.
 * Subsequent calls return the existing instance regardless of the prisma parameter.
 * This is intentional - the service should use a consistent database connection.
 * 
 * If you need to use a different PrismaClient (e.g., in tests), you MUST:
 * 1. Call resetContextBuilder() first to clear the existing instance
 * 2. Then call getContextBuilder(newPrismaClient) to create a new instance
 * 
 * MISUSE DETECTION: If a different PrismaClient is passed after the singleton
 * is created, a warning will be logged. This helps catch bugs where callers
 * expect their PrismaClient to be used but it's silently ignored.
 */
export function getContextBuilder(prisma: PrismaClient): ContextBuilder {
    if (!contextBuilderInstance) {
        contextBuilderInstance = new ContextBuilder(prisma);
        contextBuilderPrismaRef = new WeakRef(prisma);
    } else {
        // FIXED: Detect misuse - warn if a different PrismaClient is passed
        const originalPrisma = contextBuilderPrismaRef?.deref();
        if (originalPrisma && prisma !== originalPrisma) {
            logger.warn('getContextBuilder called with different PrismaClient than original. ' +
                'The new client will be IGNORED. Call resetContextBuilder() first if you need to change clients.');
        }
    }
    return contextBuilderInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetContextBuilder(): void {
    contextBuilderInstance = null;
    contextBuilderPrismaRef = null;
}
