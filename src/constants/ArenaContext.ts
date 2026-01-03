/**
 * Arena Context Builder
 * 
 * Builds comprehensive context for AI analysts including:
 * - Their own portfolio state
 * - Other analysts' performance
 * - Market conditions
 * - Trading rules and constraints
 * - Recent trades and debates
 */

import { config } from '../config';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { ANALYST_PROFILES } from './analyst';

// Total number of analysts in the system
const TOTAL_ANALYSTS = Object.keys(ANALYST_PROFILES).length;

export interface AnalystPortfolio {
    analystId: string;
    analystName: string;
    balance: number;
    totalValue: number;
    totalReturn: number;
    totalTrades: number;
    winRate: number;
    positions: Array<{
        symbol: string;
        side: 'LONG' | 'SHORT';
        size: number;
        entryPrice: number;
        unrealizedPnl: number;
    }>;
    recentTrades: Array<{
        symbol: string;
        side: string;
        price: number;
        pnl: number;
        timestamp: number;
    }>;
    rank: number;
}

export interface MarketConditions {
    symbol: string;
    price: number;
    change24h: number;
    volume24h: number;
    high24h: number;
    low24h: number;
    fundingRate: number;
    volatility: 'low' | 'medium' | 'high' | 'extreme';
    trend: 'strong_bull' | 'bull' | 'neutral' | 'bear' | 'strong_bear';
}

export interface ArenaState {
    // Overall arena stats
    totalTrades: number;
    activeBattles: number;
    currentChampion: string | null;

    // Leaderboard
    leaderboard: Array<{
        rank: number;
        analystId: string;
        analystName: string;
        totalReturn: number;
        winRate: number;
    }>;

    // Recent activity
    recentTrades: Array<{
        analystId: string;
        symbol: string;
        side: string;
        price: number;
        timestamp: number;
    }>;

    // Market overview
    marketSentiment: 'fear' | 'neutral' | 'greed';
    topPerformingSymbol: string;
    worstPerformingSymbol: string;
}

export interface TradingRules {
    maxPositionSizePercent: number;
    maxLeverage: number;
    defaultLeverage: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    minConfidenceToTrade: number;
    minBalanceToTrade: number;
    approvedSymbols: string[];
}

export interface FullArenaContext {
    // Who am I?
    myPortfolio: AnalystPortfolio;

    // How are others doing?
    arenaState: ArenaState;
    otherAnalysts: AnalystPortfolio[];

    // What's the market doing?
    marketConditions: MarketConditions;

    // What are the rules?
    tradingRules: TradingRules;

    // Formatted context string for AI prompt
    contextString: string;
}

class ArenaContextBuilder {
    /**
     * Build full context for an AI analyst
     */
    async buildContext(
        analystId: string,
        symbol: string,
        marketData: {
            price: number;
            change24h: number;
            volume24h: number;
            high24h: number;
            low24h: number;
            fundingRate?: number;
        }
    ): Promise<FullArenaContext> {
        // Fetch all data in parallel
        const [
            myPortfolio,
            allPortfolios,
            recentTrades,
        ] = await Promise.all([
            this.getAnalystPortfolio(analystId),
            this.getAllPortfolios(),
            this.getRecentTrades(20),
        ]);

        // Build arena state
        const arenaState = this.buildArenaState(allPortfolios, recentTrades);

        // Build market conditions
        const marketConditions = this.buildMarketConditions(symbol, marketData);

        // Get trading rules from config
        const tradingRules = this.getTradingRules();

        // Filter out self from other analysts
        const otherAnalysts = allPortfolios.filter(p => p.analystId !== analystId);

        // Build context string
        const contextString = this.buildContextString(
            myPortfolio,
            arenaState,
            otherAnalysts,
            marketConditions,
            tradingRules
        );

        return {
            myPortfolio,
            arenaState,
            otherAnalysts,
            marketConditions,
            tradingRules,
            contextString,
        };
    }

    /**
     * Get a single analyst's portfolio
     */
    private async getAnalystPortfolio(analystId: string): Promise<AnalystPortfolio> {
        try {
            const portfolio = await prisma.portfolio.findUnique({
                where: { agentId: analystId },
                select: {
                    id: true,
                    agentId: true,
                    agentName: true,
                    currentBalance: true,
                    totalValue: true,
                    totalReturn: true,
                    totalTrades: true,
                    winRate: true
                }
            });

            if (!portfolio) {
                return this.getDefaultPortfolio(analystId);
            }

            // Get rank efficiently using a single query with ordering
            // This avoids the N+1 query problem and is more performant
            const allPortfolios = await prisma.portfolio.findMany({
                select: { id: true, totalReturn: true },
                orderBy: { totalReturn: 'desc' }
            });
            const rankIndex = allPortfolios.findIndex(p => p.id === portfolio.id);
            // CRITICAL: Handle case where portfolio is not found in list (should never happen, but defensive)
            const rank = rankIndex === -1 ? allPortfolios.length + 1 : rankIndex + 1;

            // Get recent trades
            const recentTrades = await prisma.trade.findMany({
                where: { portfolioId: portfolio.id },
                orderBy: { createdAt: 'desc' },
                take: 10,
                select: {
                    symbol: true,
                    side: true,
                    price: true,
                    realizedPnl: true,
                    createdAt: true
                }
            });

            return {
                analystId: portfolio.agentId,
                analystName: portfolio.agentName,
                balance: portfolio.currentBalance,
                totalValue: portfolio.totalValue,
                totalReturn: portfolio.totalReturn,
                totalTrades: portfolio.totalTrades,
                winRate: portfolio.winRate,
                positions: [], // Would fetch from WEEX
                recentTrades: recentTrades.map(t => ({
                    symbol: t.symbol,
                    side: t.side,
                    price: t.price,
                    pnl: t.realizedPnl ?? 0,
                    timestamp: t.createdAt.getTime(),
                })),
                rank: rank,
            };
        } catch (error) {
            logger.warn(`Failed to get portfolio for ${analystId}:`, error);
            return this.getDefaultPortfolio(analystId);
        }
    }

    /**
     * Get all portfolios for leaderboard
     */
    private async getAllPortfolios(): Promise<AnalystPortfolio[]> {
        try {
            const portfolios = await prisma.portfolio.findMany({
                orderBy: { totalReturn: 'desc' },
                select: {
                    id: true,
                    agentId: true,
                    agentName: true,
                    currentBalance: true,
                    totalValue: true,
                    totalReturn: true,
                    totalTrades: true,
                    winRate: true
                }
            });

            if (!portfolios || portfolios.length === 0) {
                return [];
            }

            return portfolios.map((portfolio, index) => ({
                analystId: portfolio.agentId,
                analystName: portfolio.agentName,
                balance: portfolio.currentBalance,
                totalValue: portfolio.totalValue,
                totalReturn: portfolio.totalReturn,
                totalTrades: portfolio.totalTrades,
                winRate: portfolio.winRate,
                positions: [],
                recentTrades: [],
                rank: index + 1, // Rank based on sort order
            }));
        } catch (error) {
            logger.warn('Failed to get all portfolios:', error);
            return [];
        }
    }

    /**
     * Get recent trades across all analysts
     */
    private async getRecentTrades(limit: number): Promise<Array<{
        analystId: string;
        symbol: string;
        side: string;
        price: number;
        timestamp: number;
    }>> {
        try {
            const trades = await prisma.trade.findMany({
                orderBy: { createdAt: 'desc' },
                take: limit,
                select: {
                    symbol: true,
                    side: true,
                    price: true,
                    createdAt: true,
                    portfolio: {
                        select: {
                            agentId: true
                        }
                    }
                }
            });

            return trades.map(trade => ({
                analystId: trade.portfolio.agentId,
                symbol: trade.symbol,
                side: trade.side,
                price: trade.price,
                timestamp: trade.createdAt.getTime(),
            }));
        } catch (error) {
            logger.warn('Failed to get recent trades:', error);
            return [];
        }
    }

    /**
     * Build arena state from portfolios
     */
    private buildArenaState(
        portfolios: AnalystPortfolio[],
        recentTrades: Array<{ analystId: string; symbol: string; side: string; price: number; timestamp: number }>
    ): ArenaState {
        const totalTrades = portfolios.reduce((sum, p) => sum + p.totalTrades, 0);
        const champion = portfolios.length > 0 ? portfolios[0] : null;

        // Calculate market sentiment from recent trades
        // Database stores BUY/SELL, map to LONG/SHORT for sentiment
        const recentLongs = recentTrades.filter(t => t.side === 'BUY').length;
        const recentShorts = recentTrades.filter(t => t.side === 'SELL').length;
        const sentiment = recentLongs > recentShorts * 1.5 ? 'greed'
            : recentShorts > recentLongs * 1.5 ? 'fear'
                : 'neutral';

        return {
            totalTrades,
            activeBattles: 0, // Would track from debate system
            currentChampion: champion?.analystId || null,
            leaderboard: portfolios.slice(0, TOTAL_ANALYSTS).map(p => ({
                rank: p.rank, // Use the rank from the portfolio (already calculated in SQL)
                analystId: p.analystId,
                analystName: p.analystName,
                totalReturn: p.totalReturn,
                winRate: p.winRate,
            })),
            recentTrades: recentTrades.slice(0, 10),
            marketSentiment: sentiment,
            topPerformingSymbol: 'cmt_btcusdt', // Would calculate from data
            worstPerformingSymbol: 'cmt_dogeusdt', // Would calculate from data
        };
    }

    /**
     * Build market conditions from data
     */
    private buildMarketConditions(
        symbol: string,
        data: {
            price: number;
            change24h: number;
            volume24h: number;
            high24h: number;
            low24h: number;
            fundingRate?: number;
        }
    ): MarketConditions {
        // Guard against invalid/non-finite values
        const safePrice = Number.isFinite(data.price) && data.price > 0 ? data.price : 1;
        const safeChange24h = Number.isFinite(data.change24h) ? data.change24h : 0;
        const safeVolume24h = Number.isFinite(data.volume24h) ? data.volume24h : 0;
        const safeHigh24h = Number.isFinite(data.high24h) && data.high24h > 0 ? data.high24h : safePrice;
        const safeLow24h = Number.isFinite(data.low24h) && data.low24h > 0 ? data.low24h : safePrice;
        const safeFundingRate = (Number.isFinite(data.fundingRate) ? data.fundingRate : 0) as number;

        // Calculate volatility from high/low range
        const range = safeHigh24h - safeLow24h;
        const rangePercent = (range / safePrice) * 100;
        const volatility = rangePercent > 10 ? 'extreme'
            : rangePercent > 5 ? 'high'
                : rangePercent > 2 ? 'medium'
                    : 'low';

        // Determine trend from 24h change
        const trend = safeChange24h > 5 ? 'strong_bull'
            : safeChange24h > 2 ? 'bull'
                : safeChange24h < -5 ? 'strong_bear'
                    : safeChange24h < -2 ? 'bear'
                        : 'neutral';

        return {
            symbol,
            price: safePrice,
            change24h: safeChange24h,
            volume24h: safeVolume24h,
            high24h: safeHigh24h,
            low24h: safeLow24h,
            fundingRate: safeFundingRate,
            volatility,
            trend,
        };
    }

    /**
     * Get trading rules from config
     */
    private getTradingRules(): TradingRules {
        return {
            maxPositionSizePercent: config.autonomous.maxPositionSizePercent,
            maxLeverage: config.autonomous.maxLeverage,
            defaultLeverage: config.autonomous.defaultLeverage,
            stopLossPercent: config.autonomous.stopLossPercent,
            takeProfitPercent: config.autonomous.takeProfitPercent,
            minConfidenceToTrade: config.autonomous.minConfidenceToTrade,
            minBalanceToTrade: config.autonomous.minBalanceToTrade,
            approvedSymbols: [
                'cmt_btcusdt', 'cmt_ethusdt', 'cmt_solusdt', 'cmt_dogeusdt',
                'cmt_xrpusdt', 'cmt_adausdt', 'cmt_bnbusdt', 'cmt_ltcusdt'
            ],
        };
    }

    /**
     * Build formatted context string for AI prompt
    /**
     * Build formatted context string for AI prompt
     * FIXED: All .toFixed() calls now have Number.isFinite() guards to prevent NaN display
     */
    private buildContextString(
        myPortfolio: AnalystPortfolio,
        arenaState: ArenaState,
        otherAnalysts: AnalystPortfolio[],
        marketConditions: MarketConditions,
        tradingRules: TradingRules
    ): string {
        const displaySymbol = marketConditions.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();

        // FIXED: Safe formatting helper with Number.isFinite() guards
        const safeFixed = (val: number, decimals: number, fallback: string = '0.00'): string => {
            return Number.isFinite(val) ? val.toFixed(decimals) : fallback;
        };

        // Pre-calculate all safe values
        const safeBalance = safeFixed(myPortfolio.balance, 2);
        const safeTotalValue = safeFixed(myPortfolio.totalValue, 2);
        const safeTotalReturn = safeFixed(myPortfolio.totalReturn, 2);
        const safeWinRate = safeFixed(myPortfolio.winRate * 100, 1, '0.0');

        const safePrice = safeFixed(marketConditions.price, marketConditions.price < 1 ? 6 : 2, 'N/A');
        const safeChange24h = safeFixed(marketConditions.change24h, 2);
        const safeHigh24h = safeFixed(marketConditions.high24h, marketConditions.high24h < 1 ? 6 : 2, 'N/A');
        const safeLow24h = safeFixed(marketConditions.low24h, marketConditions.low24h < 1 ? 6 : 2, 'N/A');
        const safeVolume24h = Number.isFinite(marketConditions.volume24h) ? (marketConditions.volume24h / 1e6).toFixed(2) : '0.00';
        const safeFundingRate = safeFixed(marketConditions.fundingRate * 100, 4, '0.0000');

        const safeMaxPositionSize = Number.isFinite(myPortfolio.balance) && Number.isFinite(tradingRules.maxPositionSizePercent)
            ? (myPortfolio.balance * tradingRules.maxPositionSizePercent / 100).toFixed(2)
            : '0.00';

        return `
🏟️ HYPOTHESIS ARENA - LIVE TRADING CONTEXT

📊 YOUR PORTFOLIO STATUS

Analyst: ${myPortfolio.analystName} (${myPortfolio.analystId})
Current Rank: #${myPortfolio.rank} of ${arenaState.leaderboard.length || TOTAL_ANALYSTS}
Balance: ${safeBalance} USDT
Total Value: ${safeTotalValue} USDT
Total Return: ${myPortfolio.totalReturn >= 0 ? '+' : ''}${safeTotalReturn}%
Win Rate: ${safeWinRate}%
Total Trades: ${myPortfolio.totalTrades}

${myPortfolio.positions.length > 0 ? `
Open Positions:
${myPortfolio.positions.map(p => {
            const entryPrice = safeFixed(p.entryPrice, 2, 'N/A');
            const pnl = safeFixed(p.unrealizedPnl, 2);
            return `  • ${p.symbol} ${p.side} ${p.size} @ ${entryPrice} (P&L: ${p.unrealizedPnl >= 0 ? '+' : ''}${pnl})`;
        }).join('\n')}
` : 'No open positions.'}

${myPortfolio.recentTrades.length > 0 ? `
Recent Trades:
${myPortfolio.recentTrades.slice(0, 5).map(t => {
            const price = safeFixed(t.price, 2, 'N/A');
            const pnl = safeFixed(t.pnl, 2);
            return `  • ${t.symbol} ${t.side} @ ${price} (P&L: ${t.pnl >= 0 ? '+' : ''}${pnl})`;
        }).join('\n')}
` : ''}

🏆 ARENA LEADERBOARD

${arenaState.leaderboard.length > 0 ? arenaState.leaderboard.map(l => {
            const isMe = l.analystId === myPortfolio.analystId;
            const marker = isMe ? '👉' : '  ';
            const crown = l.rank === 1 ? '👑' : `#${l.rank}`;
            const returnStr = safeFixed(l.totalReturn, 2);
            const winRateStr = safeFixed(l.winRate * 100, 0, '0');
            return `${marker} ${crown} ${l.analystName}: ${l.totalReturn >= 0 ? '+' : ''}${returnStr}% (${winRateStr}% win rate)`;
        }).join('\n') : 'No leaderboard data available yet.'}

Current Champion: ${arenaState.leaderboard.length > 0 && arenaState.leaderboard[0] ? arenaState.leaderboard[0].analystName : 'None'}
Total Arena Trades: ${arenaState.totalTrades}
Market Sentiment: ${arenaState.marketSentiment.toUpperCase()}

🎯 COMPETITOR ANALYSIS

${otherAnalysts.slice(0, Math.min(3, otherAnalysts.length)).map(a => {
            const status = a.totalReturn > myPortfolio.totalReturn ? '⬆️ AHEAD' : '⬇️ BEHIND';
            const valueStr = safeFixed(a.totalValue, 2);
            const returnStr = safeFixed(a.totalReturn, 2);
            return `${a.analystName}: ${valueStr} (${a.totalReturn >= 0 ? '+' : ''}${returnStr}%) ${status}`;
        }).join('\n')}

📈 MARKET CONDITIONS: ${displaySymbol}/USDT

Current Price: ${safePrice}
24h Change: ${marketConditions.change24h >= 0 ? '+' : ''}${safeChange24h}%
24h High: ${safeHigh24h}
24h Low: ${safeLow24h}
24h Volume: ${safeVolume24h}M
Funding Rate: ${safeFundingRate}%
Volatility Regime: ${marketConditions.volatility.toUpperCase()}
Trend: ${marketConditions.trend.replace('_', ' ').toUpperCase()}

🎯 REGIME-BASED STRATEGY GUIDANCE
${marketConditions.volatility === 'extreme' ? `
⚠️ EXTREME VOLATILITY - DEFENSIVE MODE
• Reduce position size by 75%
• Use tight stops (2-3%)
• Quick scalps only, no swing trades
• Consider staying flat until volatility normalizes
` : marketConditions.volatility === 'high' ? `
⚠️ HIGH VOLATILITY - CAUTIOUS MODE
• Reduce position size by 50%
• Tighten stops to 2-3%
• Prefer scalps over swings
• Take profits quickly at +3-5%
` : marketConditions.trend === 'strong_bull' || marketConditions.trend === 'strong_bear' ? `
📈 TRENDING MARKET - SWING MODE
• Standard or increased position size
• Trail stops to capture trend
• Extend take profit targets (+8-12%)
• Hold longer (2-5 days)
` : marketConditions.volatility === 'low' ? `
😴 LOW VOLATILITY - BREAKOUT WATCH
• Standard position size
• Wait for breakout confirmation
• Set wider stops for false breakout protection
• Be patient, don't force trades
` : `
📊 NORMAL CONDITIONS - BALANCED MODE
• Standard position size
• Use config parameters as baseline
• Adapt to intraday conditions
• Balance scalp and swing opportunities
`}

⚠️ TRADING RULES & CONSTRAINTS

• Max Position Size: ${tradingRules.maxPositionSizePercent}% of portfolio (${safeMaxPositionSize})
• Max Leverage: ${tradingRules.maxLeverage}x
• Default Leverage: ${tradingRules.defaultLeverage}x
• Stop Loss: ${tradingRules.stopLossPercent}%
• Take Profit: ${tradingRules.takeProfitPercent}%
• Min Confidence to Trade: ${tradingRules.minConfidenceToTrade}%
• Min Balance Required: ${tradingRules.minBalanceToTrade}

🎯 YOUR OBJECTIVE

You are competing against ${otherAnalysts.length} other AI analysts in the Hypothesis Arena.
Your goal is to maximize returns while managing risk.
${myPortfolio.rank === 1 ? '🏆 You are the CHAMPION! Defend your position!' : `You need to beat ${arenaState.leaderboard[0]?.analystName || 'the leader'} to become champion.`}

Consider:
1. Your current rank and how far behind/ahead you are
2. What strategies are working for top performers
3. Market conditions and volatility
4. Your available capital and risk tolerance
5. The trading rules and constraints above

📌 Directive Hints
• Use specific numbers (funding %, OI change, volume vs avg, key levels).
• Reference on-chain OR microstructure metrics; avoid price-only arguments.
• Align timeframe: thesis, targets, and catalysts must match horizon.
• Define invalidation and stop-loss distance; keep leverage ≤5x.
• Watch crowding risk: extreme funding/OI and correlated positions.

✅ Do
• Quantify conviction and risk; show liquidation math for leverage.
• Include near-term catalysts (7–14 days) with expected impact.
• Respect portfolio heat and net exposure guardrails.

❌ Don't
• Hand-wave with vague statements or narrative-only claims.
• Propose trades without stop, size, and risk calculations.
• Stack correlated longs/shorts beyond guardrails.

`;
    }

    /**
     * Get default portfolio for new/missing analysts
     */
    private getDefaultPortfolio(analystId: string): AnalystPortfolio {
        // Get name from ANALYST_PROFILES instead of hardcoding
        const profile = Object.values(ANALYST_PROFILES).find(p => p.id === analystId);
        const name = profile?.name || analystId;

        return {
            analystId,
            analystName: name,
            balance: 0,
            totalValue: 0,
            totalReturn: 0,
            totalTrades: 0,
            winRate: 0,
            positions: [],
            recentTrades: [],
            rank: 1,
        };
    }
}

export const arenaContextBuilder = new ArenaContextBuilder();
