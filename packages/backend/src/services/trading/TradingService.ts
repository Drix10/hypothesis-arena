import { v4 as uuid } from 'uuid';
import { pool } from '../../config/database';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import { getWeexClient } from '../weex/WeexClient';
import { TradingError } from '../../utils/errors';
import type {
    Trade,
    TradeDecision,
    Portfolio,
    Position,
    OrderSide,
    OrderStatus,
} from '@hypothesis-arena/shared';

export class TradingService {
    private weexClient = getWeexClient();

    async executeTrade(userId: string, decision: TradeDecision): Promise<Trade> {
        const clientOrderId = `HA_${uuid().replace(/-/g, '').slice(0, 16)}`;

        // Validate decision
        if (decision.action === 'HOLD') {
            throw new TradingError('Cannot execute HOLD action', 'INVALID_ACTION');
        }

        if (!decision.size || decision.size <= 0 || !Number.isFinite(decision.size)) {
            throw new TradingError('Invalid trade size', 'INVALID_SIZE');
        }

        if (!decision.thesisId) {
            throw new TradingError('Missing thesisId (portfolioId)', 'INVALID_THESIS_ID');
        }

        // Get current price from WEEX
        const ticker = await this.weexClient.getTicker(this.toWeexSymbol(decision.symbol));
        const currentPrice = parseFloat(ticker.last);

        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            throw new TradingError('Unable to fetch valid market price', 'INVALID_PRICE');
        }

        // Create trade record
        const trade: Trade = {
            id: uuid(),
            portfolioId: decision.thesisId,
            symbol: decision.symbol,
            side: decision.action as OrderSide,
            type: 'MARKET',
            size: decision.size,
            price: currentPrice,
            status: 'PENDING' as OrderStatus,
            reason: decision.reason,
            confidence: decision.confidence,
            clientOrderId,
            createdAt: Date.now(),
        };

        try {
            // Place order on WEEX
            const response = await this.weexClient.placeOrder({
                symbol: this.toWeexSymbol(decision.symbol),
                client_oid: clientOrderId,
                type: decision.action === 'BUY' ? '1' : '2', // 1=Open long, 2=Open short
                order_type: '0', // Normal order
                match_price: '1', // Market price
                size: String(decision.size),
                price: String(currentPrice),
            });

            // Validate response
            if (!response.order_id) {
                throw new TradingError('WEEX did not return an order ID', 'NO_ORDER_ID');
            }

            trade.weexOrderId = response.order_id;
            trade.status = 'FILLED';
            trade.executedAt = Date.now();

            // Save to database
            await this.saveTrade(userId, trade);

            // Update portfolio
            await this.updatePortfolioAfterTrade(userId, trade);

            logger.info(`Trade executed: ${trade.id}`, { trade });
            return trade;

        } catch (error: any) {
            trade.status = 'FAILED';
            await this.saveTrade(userId, trade);

            logger.error('Trade execution failed:', error);
            throw new TradingError(
                error.message || 'Trade execution failed',
                'EXECUTION_FAILED'
            );
        }
    }

    async getPortfolio(userId: string, agentId: string): Promise<Portfolio | null> {
        const result = await pool.query(
            `SELECT * FROM portfolios WHERE user_id = $1 AND agent_id = $2`,
            [userId, agentId]
        );

        if (result.rows.length === 0) return null;

        const row = result.rows[0];
        const positions = await this.getPositions(userId, agentId);
        const trades = await this.getTrades(userId, agentId, 100);

        return this.mapRowToPortfolio(row, positions, trades);
    }

    async getAllPortfolios(userId: string): Promise<Record<string, Portfolio>> {
        // Get all portfolios with positions and recent trades in fewer queries
        const portfolioResult = await pool.query(
            `SELECT * FROM portfolios WHERE user_id = $1`,
            [userId]
        );

        if (portfolioResult.rows.length === 0) return {};

        const portfolioIds = portfolioResult.rows.map(p => p.id);

        // Batch fetch positions for all portfolios
        const positionsResult = await pool.query(
            `SELECT * FROM positions 
             WHERE portfolio_id = ANY($1) AND is_open = true`,
            [portfolioIds]
        );

        // Batch fetch recent trades for all portfolios (last 50 per portfolio)
        const tradesResult = await pool.query(
            `SELECT DISTINCT ON (portfolio_id, id) * FROM (
                SELECT *, ROW_NUMBER() OVER (PARTITION BY portfolio_id ORDER BY created_at DESC) as rn
                FROM trades WHERE portfolio_id = ANY($1)
            ) t WHERE rn <= 50`,
            [portfolioIds]
        );

        // Group positions and trades by portfolio
        const positionsByPortfolio = new Map<string, Position[]>();
        const tradesByPortfolio = new Map<string, Trade[]>();

        for (const row of positionsResult.rows) {
            const portfolioId = row.portfolio_id;
            if (!positionsByPortfolio.has(portfolioId)) {
                positionsByPortfolio.set(portfolioId, []);
            }
            positionsByPortfolio.get(portfolioId)!.push(this.mapRowToPosition(row));
        }

        for (const row of tradesResult.rows) {
            const portfolioId = row.portfolio_id;
            if (!tradesByPortfolio.has(portfolioId)) {
                tradesByPortfolio.set(portfolioId, []);
            }
            tradesByPortfolio.get(portfolioId)!.push(this.mapRowToTrade(row));
        }

        // Build result
        const portfolios: Record<string, Portfolio> = {};
        for (const row of portfolioResult.rows) {
            const positions = positionsByPortfolio.get(row.id) || [];
            const trades = tradesByPortfolio.get(row.id) || [];
            portfolios[row.agent_name] = this.mapRowToPortfolio(row, positions, trades);
        }

        return portfolios;
    }

    async getPositions(userId: string, agentId: string): Promise<Position[]> {
        // First get the portfolio ID for this user/agent
        const portfolio = await pool.query(
            `SELECT id FROM portfolios WHERE user_id = $1 AND agent_name = $2`,
            [userId, agentId]
        );

        if (portfolio.rows.length === 0) return [];

        const result = await pool.query(
            `SELECT * FROM positions 
             WHERE portfolio_id = $1 AND is_open = true`,
            [portfolio.rows[0].id]
        );

        return result.rows.map(this.mapRowToPosition);
    }

    async getTrades(userId: string, agentId: string, limit: number = 100): Promise<Trade[]> {
        // First get the portfolio ID for this user/agent
        const portfolio = await pool.query(
            `SELECT id FROM portfolios WHERE user_id = $1 AND agent_name = $2`,
            [userId, agentId]
        );

        if (portfolio.rows.length === 0) return [];

        const result = await pool.query(
            `SELECT * FROM trades 
             WHERE portfolio_id = $1 
             ORDER BY created_at DESC LIMIT $2`,
            [portfolio.rows[0].id, limit]
        );

        return result.rows.map(this.mapRowToTrade);
    }

    async getLeaderboard(): Promise<Portfolio[]> {
        const result = await pool.query(
            `SELECT p.*, u.username 
             FROM portfolios p 
             JOIN users u ON p.user_id = u.id
             ORDER BY p.total_return DESC 
             LIMIT 100`
        );

        return result.rows.map(row => this.mapRowToPortfolio(row, [], []));
    }

    private async saveTrade(userId: string, trade: Trade): Promise<void> {
        await pool.query(
            `INSERT INTO trades (
                id, user_id, portfolio_id, symbol, side, type, size, price,
                fee, status, reason, confidence, client_order_id, weex_order_id,
                executed_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
            [
                trade.id, userId, trade.portfolioId, trade.symbol, trade.side,
                trade.type, trade.size, trade.price, trade.fee || 0, trade.status,
                trade.reason, trade.confidence, trade.clientOrderId, trade.weexOrderId,
                trade.executedAt ? new Date(trade.executedAt) : null, new Date(trade.createdAt)
            ]
        );
    }

    private async updatePortfolioAfterTrade(userId: string, trade: Trade): Promise<void> {
        const tradeValue = trade.size * trade.price;

        if (trade.side === 'BUY') {
            await pool.query(
                `UPDATE portfolios 
                 SET current_balance = current_balance - $1,
                     total_trades = total_trades + 1,
                     updated_at = NOW()
                 WHERE user_id = $2 AND agent_id = $3`,
                [tradeValue, userId, trade.portfolioId]
            );
        } else {
            await pool.query(
                `UPDATE portfolios 
                 SET current_balance = current_balance + $1,
                     total_trades = total_trades + 1,
                     updated_at = NOW()
                 WHERE user_id = $2 AND agent_id = $3`,
                [tradeValue, userId, trade.portfolioId]
            );
        }

        // Invalidate cache
        const redis = await getRedisClient();
        await redis.del(`portfolio:${userId}:${trade.portfolioId}`);
    }

    private toWeexSymbol(symbol: string): string {
        return `cmt_${symbol.toLowerCase()}`;
    }

    private mapRowToPortfolio(row: any, positions: Position[], trades: Trade[]): Portfolio {
        return {
            id: row.id,
            agentId: row.agent_id,
            agentName: row.agent_name,
            userId: row.user_id,
            initialBalance: parseFloat(row.initial_balance),
            currentBalance: parseFloat(row.current_balance),
            totalValue: parseFloat(row.total_value || row.current_balance),
            totalReturn: parseFloat(row.total_return || 0),
            totalReturnDollar: parseFloat(row.total_return_dollar || 0),
            winRate: parseFloat(row.win_rate || 0),
            sharpeRatio: row.sharpe_ratio ? parseFloat(row.sharpe_ratio) : null,
            maxDrawdown: parseFloat(row.max_drawdown || 0),
            currentDrawdown: parseFloat(row.current_drawdown || 0),
            totalTrades: parseInt(row.total_trades || 0),
            winningTrades: parseInt(row.winning_trades || 0),
            losingTrades: parseInt(row.losing_trades || 0),
            positions,
            trades,
            createdAt: new Date(row.created_at).getTime(),
            updatedAt: new Date(row.updated_at).getTime(),
            status: row.status || 'active',
        };
    }

    private mapRowToPosition(row: any): Position {
        return {
            id: row.id,
            portfolioId: row.portfolio_id,
            symbol: row.symbol,
            side: row.side,
            size: parseFloat(row.size),
            entryPrice: parseFloat(row.entry_price),
            currentPrice: parseFloat(row.current_price),
            marginMode: row.margin_mode,
            leverage: parseInt(row.leverage),
            unrealizedPnL: parseFloat(row.unrealized_pnl || 0),
            realizedPnL: parseFloat(row.realized_pnl || 0),
            openedAt: new Date(row.opened_at).getTime(),
            closedAt: row.closed_at ? new Date(row.closed_at).getTime() : undefined,
            isOpen: row.is_open,
            weexPositionId: row.weex_position_id,
        };
    }

    private mapRowToTrade(row: any): Trade {
        return {
            id: row.id,
            portfolioId: row.portfolio_id,
            positionId: row.position_id,
            symbol: row.symbol,
            side: row.side,
            type: row.type,
            size: parseFloat(row.size),
            price: parseFloat(row.price),
            fee: parseFloat(row.fee || 0),
            status: row.status,
            reason: row.reason,
            confidence: row.confidence ? parseFloat(row.confidence) : undefined,
            executedAt: row.executed_at ? new Date(row.executed_at).getTime() : undefined,
            createdAt: new Date(row.created_at).getTime(),
            weexOrderId: row.weex_order_id,
            clientOrderId: row.client_order_id,
            realizedPnL: row.realized_pnl ? parseFloat(row.realized_pnl) : undefined,
            realizedPnLPercent: row.realized_pnl_percent ? parseFloat(row.realized_pnl_percent) : undefined,
        };
    }
}

export const tradingService = new TradingService();
