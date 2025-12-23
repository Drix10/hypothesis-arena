import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { getWeexClient } from '../../services/weex/WeexClient';
import { query, queryOne, withTransaction } from '../../config/database';
import { logger } from '../../utils/logger';
import { TradingError, ValidationError } from '../../utils/errors';
import { v4 as uuid } from 'uuid';
import { isApprovedSymbol, APPROVED_SYMBOLS } from '@hypothesis-arena/shared';

const router = Router();

const executeTradeSchema = z.object({
    symbol: z.string(),
    side: z.enum(['BUY', 'SELL']),
    type: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
    size: z.number().positive(),
    price: z.number().positive().optional(),
    portfolioId: z.string().uuid(),
    confidence: z.number().min(0).max(100).optional(),
    reason: z.string().optional(),
});

// POST /api/trading/execute
router.post('/execute', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const data = executeTradeSchema.parse(req.body);

        // Validate symbol
        const symbol = data.symbol.toLowerCase();
        if (!isApprovedSymbol(symbol)) {
            throw new ValidationError(`Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}`);
        }

        // Get portfolio
        const portfolio = await queryOne<any>(
            'SELECT * FROM portfolios WHERE id = $1 AND user_id = $2',
            [data.portfolioId, req.userId]
        );

        if (!portfolio) {
            throw new ValidationError('Portfolio not found');
        }

        if (portfolio.trading_mode !== 'live') {
            throw new TradingError('Portfolio is not in live trading mode', 'NOT_LIVE_MODE');
        }

        // Generate client order ID
        const clientOrderId = `${Date.now()}_${uuid().substring(0, 8)}`;

        // Execute trade
        const result = await withTransaction(async (client) => {
            // Create trade record
            const tradeId = uuid();

            await client.query(
                `INSERT INTO trades (id, portfolio_id, symbol, side, type, size, price, status, client_order_id, confidence, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
                [
                    tradeId,
                    data.portfolioId,
                    symbol,
                    data.side,
                    data.type,
                    data.size,
                    data.price || 0,
                    'PENDING',
                    clientOrderId,
                    data.confidence,
                    data.reason,
                ]
            );

            // Place order on WEEX
            const weexClient = getWeexClient();
            const orderResponse = await weexClient.placeOrder({
                symbol,
                side: data.side.toLowerCase() as 'buy' | 'sell',
                type: data.type === 'MARKET' ? '2' : '1',
                orderType: '0',
                size: String(data.size),
                price: data.price ? String(data.price) : undefined,
                clientOrderId,
            });

            // Update trade with WEEX order ID
            await client.query(
                `UPDATE trades SET weex_order_id = $1, status = $2 WHERE id = $3`,
                [orderResponse.data.orderId, 'FILLED', tradeId]
            );

            logger.info(`Trade executed: ${tradeId}`, { symbol, side: data.side, size: data.size });

            return {
                id: tradeId,
                weexOrderId: orderResponse.data.orderId,
                clientOrderId,
                status: 'FILLED',
            };
        });

        res.json(result);
    } catch (error) {
        next(error);
    }
});

// GET /api/trading/orders
router.get('/orders', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { portfolioId, status, limit = 50 } = req.query;

        let sql = `
      SELECT t.* FROM trades t
      JOIN portfolios p ON t.portfolio_id = p.id
      WHERE p.user_id = $1
    `;
        const params: any[] = [req.userId];

        if (portfolioId) {
            params.push(portfolioId);
            sql += ` AND t.portfolio_id = $${params.length}`;
        }

        if (status) {
            params.push(status);
            sql += ` AND t.status = $${params.length}`;
        }

        params.push(Number(limit));
        sql += ` ORDER BY t.created_at DESC LIMIT $${params.length}`;

        const trades = await query(sql, params);
        res.json({ trades });
    } catch (error) {
        next(error);
    }
});

// GET /api/trading/order/:id
router.get('/order/:id', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const trade = await queryOne<any>(
            `SELECT t.* FROM trades t
       JOIN portfolios p ON t.portfolio_id = p.id
       WHERE t.id = $1 AND p.user_id = $2`,
            [req.params.id, req.userId]
        );

        if (!trade) {
            res.status(404).json({ error: 'Trade not found' });
            return;
        }

        res.json({ trade });
    } catch (error) {
        next(error);
    }
});

// POST /api/trading/cancel
router.post('/cancel', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { tradeId } = req.body;

        const trade = await queryOne<any>(
            `SELECT t.* FROM trades t
       JOIN portfolios p ON t.portfolio_id = p.id
       WHERE t.id = $1 AND p.user_id = $2`,
            [tradeId, req.userId]
        );

        if (!trade) {
            res.status(404).json({ error: 'Trade not found' });
            return;
        }

        if (trade.status !== 'PENDING' && trade.status !== 'OPEN') {
            throw new TradingError('Cannot cancel trade in current status', 'INVALID_STATUS');
        }

        // Cancel on WEEX
        const weexClient = getWeexClient();
        await weexClient.cancelOrder(trade.symbol, trade.weex_order_id);

        // Update status
        await query(
            'UPDATE trades SET status = $1 WHERE id = $2',
            ['CANCELED', tradeId]
        );

        res.json({ message: 'Trade canceled', tradeId });
    } catch (error) {
        next(error);
    }
});

export default router;
