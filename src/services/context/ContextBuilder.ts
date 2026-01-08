/**
 * Context Builder for v5.0.0
 * 
 * Builds rich context object for AI analysts.
 * Aggregates account state, positions, market data with indicators, trade history,
 * and all trading rules/limits the AI needs to make informed decisions.
 */

import { config } from '../../config';
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
import { RISK_COUNCIL_VETO_TRIGGERS } from '../../constants/analyst/riskCouncil';
import { GLOBAL_RISK_LIMITS } from '../../constants/analyst/riskLimits';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';

const TRADING_SYMBOLS = APPROVED_SYMBOLS;

/**
 * Build risk rules string for AI context - minimal, profit-focused
 * Validates required constants and falls back to safe defaults if missing
 */
function buildRiskRulesString(): string {
    // Validate RISK_COUNCIL_VETO_TRIGGERS
    const maxLeverage = RISK_COUNCIL_VETO_TRIGGERS?.MAX_LEVERAGE ?? 20;
    const maxPositionPct = RISK_COUNCIL_VETO_TRIGGERS?.MAX_POSITION_PERCENT ?? 25;
    const maxConcurrent = RISK_COUNCIL_VETO_TRIGGERS?.MAX_CONCURRENT_POSITIONS ?? 3;

    // Validate STOP_LOSS_BY_LEVERAGE with safe defaults
    const stopLoss = GLOBAL_RISK_LIMITS?.STOP_LOSS_BY_LEVERAGE ?? {};
    const extreme = stopLoss.EXTREME ?? { maxLeverage: 20, maxStopPercent: 1.5 };
    const high = stopLoss.HIGH ?? { maxLeverage: 15, maxStopPercent: 2 };
    const medium = stopLoss.MEDIUM ?? { maxLeverage: 10, maxStopPercent: 3 };
    const low = stopLoss.LOW ?? { maxLeverage: 5, maxStopPercent: 6 };

    const lines = [
        'LIMITS:',
        `- Max leverage: ${maxLeverage}x`,
        `- Max position: ${maxPositionPct}% of account`,
        `- Max concurrent positions: ${maxConcurrent}`,
        `- Stop loss by leverage: ${extreme.maxLeverage}x=${extreme.maxStopPercent}%, ${high.maxLeverage}x=${high.maxStopPercent}%, ${medium.maxLeverage}x=${medium.maxStopPercent}%, ${low.maxLeverage}x=${low.maxStopPercent}%`,
    ];

    return lines.join('\n');
}

export class ContextBuilder {
    private prisma: PrismaClient;
    private invocationCount: number = 0;
    private readonly MAX_INVOCATION_COUNT = Number.MAX_SAFE_INTEGER - 1;
    private lastInvocationTime: number = 0;

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
        if (this.invocationCount >= this.MAX_INVOCATION_COUNT) {
            logger.warn('Invocation count approaching overflow, resetting to 0');
            this.invocationCount = 0;
        }
        this.invocationCount++;

        const now = Date.now();
        const timeSinceLastInvocation = now - this.lastInvocationTime;
        if (this.lastInvocationTime > 0 && timeSinceLastInvocation < 100) {
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
        // NOTE: Use original case for symbol keys to match tradeMap lookup
        const enrichedPriceMap = new Map<string, number>();
        for (const pos of enrichedPositions) {
            enrichedPriceMap.set(pos.symbol, pos.current_price);
        }

        const activeTrades = await this.getActiveTradesWithExitPlans(positions, enrichedPriceMap);

        const accountState: AccountState = {
            balance: accountBalance,
            total_value: accountBalance + positions.reduce((sum, p) => sum + p.unrealizedPnl, 0),
            total_return_pct: metrics.total_return_pct,
            profit_factor: metrics.profit_factor,
            positions: enrichedPositions,
            active_trades: activeTrades,
            // NOTE: open_orders is intentionally empty - WEEX open orders are managed separately
            // via TP/SL orders attached to positions. The system doesn't place standalone limit orders.
            // If standalone order support is added, fetch from WeexClient.getOpenOrders() here.
            open_orders: [],
            recent_diary: recentTrades,
            recent_fills: recentFills,
        };

        const instructions: Instructions = {
            assets: TRADING_SYMBOLS,
            anti_churn_rules: ANTI_CHURN_RULES,
            leverage_policy: LEVERAGE_POLICY,
            risk_limits: buildRiskRulesString(),
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

    private async getIndicatorsForSymbol(symbol: string) {
        try {
            const indicatorService = getTechnicalIndicatorService();
            return await indicatorService.getIndicators(symbol);
        } catch (error) {
            logger.error(`Failed to get indicators for ${symbol}:`, error);
            return null;
        }
    }

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
        const enriched: EnrichedPosition[] = [];

        for (const pos of positions) {
            // Validate symbol - filter out invalid positions instead of using 'UNKNOWN'
            const rawSymbol = pos?.symbol;
            const trimmedSymbol = typeof rawSymbol === 'string' ? rawSymbol.trim() : '';

            if (trimmedSymbol.length === 0) {
                logger.error('Position with empty/invalid symbol filtered out:', {
                    rawSymbol,
                    side: pos?.side,
                    size: pos?.size,
                });
                continue; // Skip this position
            }

            const symbol = trimmedSymbol;
            const side = pos?.side === 'SHORT' ? 'SHORT' : 'LONG';
            const size = Number.isFinite(pos?.size) ? pos.size : 0;
            const entryPrice = Number.isFinite(pos?.entryPrice) ? pos.entryPrice : 0;
            const leverage = Number.isFinite(pos?.leverage) && pos.leverage > 0 ? pos.leverage : 1;
            const unrealizedPnl = Number.isFinite(pos?.unrealizedPnl) ? pos.unrealizedPnl : 0;

            const market = marketData.find((m) => m.asset === symbol);
            const currentPrice = market?.current_price || (Number.isFinite(pos?.currentPrice) ? pos.currentPrice : entryPrice);

            const pnlPct = (entryPrice !== 0)
                ? ((currentPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1)
                : 0;

            const marginUsed = (size * entryPrice) / leverage;

            enriched.push({
                symbol,
                side,
                size,
                entry_price: entryPrice,
                current_price: currentPrice,
                liquidation_price: pos?.liquidationPrice || null,
                unrealized_pnl: unrealizedPnl,
                unrealized_pnl_pct: Number.isFinite(pnlPct) ? pnlPct : 0,
                leverage,
                margin_used: Number.isFinite(marginUsed) ? marginUsed : 0,
            });
        }

        return enriched;
    }

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
        if (positions.length === 0) return [];

        const symbols = positions.map(p => p.symbol);
        const trades = await this.prisma.trade.findMany({
            where: { symbol: { in: symbols }, status: 'OPEN' },
            orderBy: { createdAt: 'desc' },
        });

        const tradeMap = new Map<string, typeof trades[0]>();
        for (const trade of trades) {
            if (!tradeMap.has(trade.symbol)) {
                tradeMap.set(trade.symbol, trade);
            }
        }

        const activeTrades: ActiveTrade[] = [];

        for (const pos of positions) {
            const trade = tradeMap.get(pos.symbol);
            const currentPrice = enrichedPriceMap?.get(pos.symbol) ?? pos.currentPrice;
            const pnlPct = this.calculatePnlPercent(currentPrice, pos.entryPrice, pos.side);
            const openedAt = trade?.createdAt || new Date();
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

    private calculatePnlPercent(currentPrice: number, entryPrice: number, side: 'LONG' | 'SHORT'): number {
        if (!Number.isFinite(entryPrice) || entryPrice === 0) return 0;
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) return 0;
        const pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100 * (side === 'LONG' ? 1 : -1);
        return Number.isFinite(pnlPct) ? pnlPct : 0;
    }

    private async getRecentTrades(limit: number): Promise<DiaryEntry[]> {
        try {
            const trades = await this.prisma.trade.findMany({
                orderBy: { createdAt: 'desc' },
                take: limit,
            });

            return trades.map((trade) => {
                const size = Number.isFinite(trade.size) ? trade.size : 0;
                const entryPrice = Number.isFinite(trade.entryPrice) && trade.entryPrice !== null ? trade.entryPrice : 0;
                const allocationUsd = trade.allocationUsd ?? (size * entryPrice);

                return {
                    timestamp: trade.createdAt.toISOString(),
                    asset: trade.symbol,
                    action: trade.action ?? trade.side,
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

    private mapTradeStatus(status: string, realizedPnl: number | null): 'OPEN' | 'WIN' | 'LOSS' | 'BREAKEVEN' | null {
        switch (status) {
            case 'OPEN':
            case 'PENDING':
                return 'OPEN';
            case 'FILLED':
                if (realizedPnl === null || realizedPnl === undefined) return null;
                if (realizedPnl > 0) return 'WIN';
                if (realizedPnl < 0) return 'LOSS';
                return 'BREAKEVEN';
            case 'CANCELED':
            case 'FAILED':
                return null;
            default:
                return null;
        }
    }

    private async getRecentFills(limit: number): Promise<RecentFill[]> {
        try {
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
                price: Number.isFinite(trade.entryPrice) && trade.entryPrice !== null ? trade.entryPrice : 0,
                fee: trade.fee,
                realized_pnl: trade.realizedPnl,
            }));
        } catch (error) {
            logger.error('Failed to get recent fills:', error);
            return [];
        }
    }

    private async calculatePerformanceMetrics(): Promise<PerformanceMetrics> {
        try {
            const trades = await this.prisma.trade.findMany({
                where: { status: 'FILLED', realizedPnl: { not: null } },
                orderBy: { createdAt: 'asc' },
            });

            if (trades.length === 0) return this.getDefaultMetrics();

            const wins = trades.filter((t) => (t.realizedPnl || 0) > 0);
            const losses = trades.filter((t) => (t.realizedPnl || 0) < 0);

            const totalPnl = trades.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
            const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / wins.length : 0;
            const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + (t.realizedPnl || 0), 0) / losses.length) : 0;

            const startingBalance = config.trading?.startingBalance;
            const totalReturnPct = (Number.isFinite(startingBalance) && startingBalance > 0)
                ? (totalPnl / startingBalance) * 100
                : 0;

            const profitFactor = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);

            const validStartingBalance = (Number.isFinite(startingBalance) && startingBalance > 0)
                ? startingBalance : 1000;
            let peak = validStartingBalance;
            let maxDrawdown = 0;
            let runningBalance = validStartingBalance;

            for (const trade of trades) {
                runningBalance += trade.realizedPnl || 0;
                if (runningBalance > peak) peak = runningBalance;
                const drawdown = peak > 0 ? (peak - runningBalance) / peak : 0;
                if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            }

            const now = new Date();
            const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

            const tradesLast24h = trades.filter((t) => t.createdAt > oneDayAgo).length;
            const tradesLast7d = trades.filter((t) => t.createdAt > sevenDaysAgo).length;

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

    formatContextForPrompt(context: TradingContext): string {
        return JSON.stringify(context, null, 2);
    }

    getInvocationCount(): number {
        return this.invocationCount;
    }

    resetInvocationCount(): void {
        this.invocationCount = 0;
    }
}

// Singleton
let contextBuilderInstance: ContextBuilder | null = null;
let contextBuilderPrismaRef: WeakRef<PrismaClient> | null = null;

export function getContextBuilder(prisma: PrismaClient): ContextBuilder {
    if (!contextBuilderInstance) {
        contextBuilderInstance = new ContextBuilder(prisma);
        contextBuilderPrismaRef = new WeakRef(prisma);
    } else {
        const originalPrisma = contextBuilderPrismaRef?.deref();
        if (originalPrisma && prisma !== originalPrisma) {
            logger.warn('getContextBuilder called with different PrismaClient than original.');
        }
    }
    return contextBuilderInstance;
}

export function resetContextBuilder(): void {
    contextBuilderInstance = null;
    contextBuilderPrismaRef = null;
}
