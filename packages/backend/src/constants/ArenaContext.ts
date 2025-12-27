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
import { pool } from '../config/database';
import { logger } from '../utils/logger';

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
            const result = await pool.query(
                `SELECT p.*, 
                    RANK() OVER (ORDER BY p.total_return DESC) as rank
                 FROM portfolios p 
                 WHERE p.agent_id = $1
                 LIMIT 1`,
                [analystId]
            );

            if (result.rows.length === 0) {
                return this.getDefaultPortfolio(analystId);
            }

            const row = result.rows[0];

            // Get recent trades
            const tradesResult = await pool.query(
                `SELECT symbol, side, price, realized_pnl, created_at
                 FROM trades 
                 WHERE portfolio_id = $1
                 ORDER BY created_at DESC
                 LIMIT 10`,
                [row.id]
            );

            // Validate rank - could be NaN if no rows or invalid data
            const parsedRank = parseInt(row.rank, 10);
            const safeRank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;

            return {
                analystId: row.agent_id,
                analystName: row.agent_name,
                balance: parseFloat(row.current_balance) || 0,
                totalValue: parseFloat(row.total_value) || 0,
                totalReturn: parseFloat(row.total_return) || 0,
                totalTrades: parseInt(row.total_trades, 10) || 0,
                winRate: parseFloat(row.win_rate) || 0,
                positions: [], // Would fetch from WEEX
                recentTrades: tradesResult.rows.map(t => ({
                    symbol: t.symbol,
                    side: t.side,
                    price: parseFloat(t.price),
                    pnl: parseFloat(t.realized_pnl) || 0,
                    timestamp: new Date(t.created_at).getTime(),
                })),
                rank: safeRank,
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
            const result = await pool.query(
                `SELECT p.*, 
                    RANK() OVER (ORDER BY p.total_return DESC) as rank
                 FROM portfolios p 
                 ORDER BY p.total_return DESC`
            );

            if (!result.rows || result.rows.length === 0) {
                return [];
            }

            return result.rows.map(row => {
                // Validate rank - could be NaN if invalid data
                const parsedRank = parseInt(row.rank, 10);
                const safeRank = Number.isFinite(parsedRank) && parsedRank > 0 ? parsedRank : 1;

                return {
                    analystId: row.agent_id || 'unknown',
                    analystName: row.agent_name || row.agent_id || 'Unknown',
                    balance: parseFloat(row.current_balance) || 0,
                    totalValue: parseFloat(row.total_value) || 0,
                    totalReturn: parseFloat(row.total_return) || 0,
                    totalTrades: parseInt(row.total_trades, 10) || 0,
                    winRate: parseFloat(row.win_rate) || 0,
                    positions: [],
                    recentTrades: [],
                    rank: safeRank,
                };
            });
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
            const result = await pool.query(
                `SELECT t.symbol, t.side, t.price, t.created_at, p.agent_id
                 FROM trades t
                 JOIN portfolios p ON t.portfolio_id = p.id
                 ORDER BY t.created_at DESC
                 LIMIT $1`,
                [limit]
            );

            return result.rows.map(row => ({
                analystId: row.agent_id,
                symbol: row.symbol,
                side: row.side,
                price: parseFloat(row.price),
                timestamp: new Date(row.created_at).getTime(),
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
        const recentLongs = recentTrades.filter(t => t.side === 'LONG').length;
        const recentShorts = recentTrades.filter(t => t.side === 'SHORT').length;
        const sentiment = recentLongs > recentShorts * 1.5 ? 'greed'
            : recentShorts > recentLongs * 1.5 ? 'fear'
                : 'neutral';

        return {
            totalTrades,
            activeBattles: 0, // Would track from debate system
            currentChampion: champion?.analystId || null,
            leaderboard: portfolios.slice(0, 8).map(p => ({
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
     */
    private buildContextString(
        myPortfolio: AnalystPortfolio,
        arenaState: ArenaState,
        otherAnalysts: AnalystPortfolio[],
        marketConditions: MarketConditions,
        tradingRules: TradingRules
    ): string {
        const displaySymbol = marketConditions.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();

        return `
🏟️ HYPOTHESIS ARENA - LIVE TRADING CONTEXT

📊 YOUR PORTFOLIO STATUS

Analyst: ${myPortfolio.analystName} (${myPortfolio.analystId})
Current Rank: #${myPortfolio.rank} of 8
Balance: $${myPortfolio.balance.toFixed(2)} USDT
Total Value: $${myPortfolio.totalValue.toFixed(2)} USDT
Total Return: ${myPortfolio.totalReturn >= 0 ? '+' : ''}${myPortfolio.totalReturn.toFixed(2)}%
Win Rate: ${(myPortfolio.winRate * 100).toFixed(1)}%
Total Trades: ${myPortfolio.totalTrades}

${myPortfolio.positions.length > 0 ? `
Open Positions:
${myPortfolio.positions.map(p => `  • ${p.symbol} ${p.side} ${p.size} @ $${p.entryPrice.toFixed(2)} (P&L: ${p.unrealizedPnl >= 0 ? '+' : ''}$${p.unrealizedPnl.toFixed(2)})`).join('\n')}
` : 'No open positions.'}

${myPortfolio.recentTrades.length > 0 ? `
Recent Trades:
${myPortfolio.recentTrades.slice(0, 5).map(t => `  • ${t.symbol} ${t.side} @ $${t.price.toFixed(2)} (P&L: ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)})`).join('\n')}
` : ''}

🏆 ARENA LEADERBOARD

${arenaState.leaderboard.length > 0 ? arenaState.leaderboard.map(l => {
            const isMe = l.analystId === myPortfolio.analystId;
            const marker = isMe ? '👉' : '  ';
            const crown = l.rank === 1 ? '👑' : `#${l.rank}`;
            return `${marker} ${crown} ${l.analystName}: ${l.totalReturn >= 0 ? '+' : ''}${l.totalReturn.toFixed(2)}% (${(l.winRate * 100).toFixed(0)}% win rate)`;
        }).join('\n') : 'No leaderboard data available yet.'}

Current Champion: ${arenaState.leaderboard.length > 0 && arenaState.leaderboard[0] ? arenaState.leaderboard[0].analystName : 'None'}
Total Arena Trades: ${arenaState.totalTrades}
Market Sentiment: ${arenaState.marketSentiment.toUpperCase()}

🎯 COMPETITOR ANALYSIS

${otherAnalysts.slice(0, 5).map(a => {
            const status = a.totalReturn > myPortfolio.totalReturn ? '⬆️ AHEAD' : '⬇️ BEHIND';
            return `${a.analystName}: $${a.totalValue.toFixed(2)} (${a.totalReturn >= 0 ? '+' : ''}${a.totalReturn.toFixed(2)}%) ${status}`;
        }).join('\n')}

📈 MARKET CONDITIONS: ${displaySymbol}/USDT

Current Price: $${marketConditions.price.toFixed(marketConditions.price < 1 ? 6 : 2)}
24h Change: ${marketConditions.change24h >= 0 ? '+' : ''}${marketConditions.change24h.toFixed(2)}%
24h High: $${marketConditions.high24h.toFixed(marketConditions.high24h < 1 ? 6 : 2)}
24h Low: $${marketConditions.low24h.toFixed(marketConditions.low24h < 1 ? 6 : 2)}
24h Volume: $${(marketConditions.volume24h / 1e6).toFixed(2)}M
Funding Rate: ${(marketConditions.fundingRate * 100).toFixed(4)}%
Volatility: ${marketConditions.volatility.toUpperCase()}
Trend: ${marketConditions.trend.replace('_', ' ').toUpperCase()}

⚠️ TRADING RULES & CONSTRAINTS

• Max Position Size: ${tradingRules.maxPositionSizePercent}% of portfolio ($${(myPortfolio.balance * tradingRules.maxPositionSizePercent / 100).toFixed(2)})
• Max Leverage: ${tradingRules.maxLeverage}x
• Default Leverage: ${tradingRules.defaultLeverage}x
• Stop Loss: ${tradingRules.stopLossPercent}%
• Take Profit: ${tradingRules.takeProfitPercent}%
• Min Confidence to Trade: ${tradingRules.minConfidenceToTrade}%
• Min Balance Required: $${tradingRules.minBalanceToTrade}

🎯 YOUR OBJECTIVE

You are competing against 7 other AI analysts in the Hypothesis Arena.
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

❌ Don’t
• Hand-wave with vague statements or narrative-only claims.
• Propose trades without stop, size, and risk calculations.
• Stack correlated longs/shorts beyond guardrails.

`;
    }

    /**
     * Get default portfolio for new/missing analysts
     */
    private getDefaultPortfolio(analystId: string): AnalystPortfolio {
        const names: Record<string, string> = {
            warren: 'Warren',
            cathie: 'Cathie',
            jim: 'Jim',
            ray: 'Ray',
            elon: 'Elon',
            karen: 'Karen',
            quant: 'Quant',
            devil: "Devil's Advocate",
        };

        return {
            analystId,
            analystName: names[analystId] || analystId,
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
