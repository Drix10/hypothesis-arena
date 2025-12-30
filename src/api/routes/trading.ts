import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { getWeexClient } from '../../services/weex/WeexClient';
import { query, queryOne, withTransaction } from '../../config/database';
import { logger } from '../../utils/logger';
import { TradingError, ValidationError } from '../../utils/errors';
import { v4 as uuid } from 'uuid';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';
import { isApprovedSymbol } from '../../shared/utils/validation';

const router = Router();

// Valid trade statuses
const VALID_TRADE_STATUSES = ['PENDING', 'OPEN', 'FILLED', 'CANCELED', 'FAILED'];

// UUID validation helper
const isValidUUID = (id: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
};

// Simple in-memory rate limiting with cleanup
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const TRADES_PER_MINUTE = 10;
const RATE_LIMIT_CLEANUP_INTERVAL = 60000; // Clean up every minute

// Cleanup old rate limit entries to prevent memory leak
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
        if (now > entry.resetTime) {
            rateLimitMap.delete(key);
        }
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

function checkRateLimit(): boolean {
    const key = 'global';
    const now = Date.now();
    const entry = rateLimitMap.get(key);

    if (!entry || now > entry.resetTime) {
        rateLimitMap.set(key, { count: 1, resetTime: now + 60000 });
        return true;
    }

    if (entry.count >= TRADES_PER_MINUTE) {
        return false;
    }

    entry.count++;
    return true;
}

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
router.post('/execute', async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!checkRateLimit()) {
            res.status(429).json({
                error: `Rate limit exceeded. Maximum ${TRADES_PER_MINUTE} trades per minute.`,
                code: 'RATE_LIMIT_EXCEEDED'
            });
            return;
        }

        const data = executeTradeSchema.parse(req.body);

        // Validate symbol
        const symbol = data.symbol.toLowerCase();
        if (!isApprovedSymbol(symbol)) {
            throw new ValidationError(`Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}`);
        }

        // Get portfolio
        const portfolio = await queryOne<any>(
            'SELECT * FROM portfolios WHERE id = $1',
            [data.portfolioId]
        );

        if (!portfolio) {
            throw new ValidationError('Portfolio not found');
        }

        // Generate client order ID
        const clientOrderId = `${Date.now()}_${uuid().substring(0, 8)}`;
        const tradeId = uuid();

        // Place order on WEEX
        const weexClient = getWeexClient();
        let orderResponse: { order_id: string };

        try {
            orderResponse = await weexClient.placeOrder({
                symbol,
                client_oid: clientOrderId,
                type: data.side.toLowerCase() === 'buy' ? '1' : '2',
                order_type: '0',
                match_price: data.type === 'MARKET' ? '1' : '0',
                size: parseFloat(String(data.size)).toFixed(4),
                price: data.price ? parseFloat(String(data.price)).toFixed(2) : '0',
            });

            if (!orderResponse.order_id) {
                throw new TradingError('WEEX did not return an order ID', 'NO_ORDER_ID');
            }
        } catch (error: any) {
            logger.error('WEEX order failed:', { clientOrderId, error: error.message });
            throw new TradingError(error.message || 'Failed to place order on WEEX', error.code || 'WEEX_ORDER_FAILED');
        }

        // Persist to DB
        const initialStatus = data.type === 'MARKET' ? 'FILLED' : 'PENDING';
        try {
            await withTransaction(async (client) => {
                await client.query(
                    `INSERT INTO trades (id, portfolio_id, symbol, side, type, size, price, status, client_order_id, weex_order_id, confidence, reason, executed_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${data.type === 'MARKET' ? 'NOW()' : 'NULL'}, NOW())`,
                    [tradeId, data.portfolioId, symbol, data.side, data.type, data.size, data.price || 0, initialStatus, clientOrderId, orderResponse.order_id, data.confidence, data.reason]
                );

                await client.query(
                    'UPDATE portfolios SET total_trades = total_trades + 1, updated_at = NOW() WHERE id = $1',
                    [data.portfolioId]
                );
            });

            logger.info(`Trade executed: ${tradeId}`, { symbol, side: data.side, size: data.size, status: initialStatus });

            res.json({
                id: tradeId,
                weexOrderId: orderResponse.order_id,
                clientOrderId,
                status: initialStatus,
            });
        } catch (dbError: any) {
            logger.error('DB persist failed after WEEX order:', { clientOrderId, weexOrderId: orderResponse.order_id, error: dbError.message });
            throw new TradingError(`Trade executed on WEEX (${orderResponse.order_id}) but DB update failed.`, 'DB_PERSIST_FAILED');
        }
    } catch (error) {
        next(error);
    }
});

// GET /api/trading/orders
router.get('/orders', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { portfolioId, status, limit = 50 } = req.query;
        const conditions: string[] = [];
        const params: any[] = [];

        if (portfolioId) {
            if (typeof portfolioId !== 'string' || !isValidUUID(portfolioId)) {
                res.status(400).json({ error: 'Invalid portfolioId format' });
                return;
            }
            params.push(portfolioId);
            conditions.push(`t.portfolio_id = $${params.length}`);
        }

        if (status) {
            if (typeof status !== 'string' || !VALID_TRADE_STATUSES.includes(status.toUpperCase())) {
                res.status(400).json({ error: `Invalid status. Valid: ${VALID_TRADE_STATUSES.join(', ')}` });
                return;
            }
            params.push(status.toUpperCase());
            conditions.push(`t.status = $${params.length}`);
        }

        const limitNum = Math.min(Math.max(1, Number(limit) || 50), 500);
        params.push(limitNum);

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const sql = `SELECT t.* FROM trades t ${whereClause} ORDER BY t.created_at DESC LIMIT $${params.length}`;

        const trades = await query(sql, params);
        res.json({ trades });
    } catch (error) {
        next(error);
    }
});

// GET /api/trading/order/:id
router.get('/order/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        if (!isValidUUID(id)) {
            res.status(400).json({ error: 'Invalid trade ID format' });
            return;
        }

        const trade = await queryOne<any>('SELECT * FROM trades WHERE id = $1', [id]);

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
router.post('/cancel', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { tradeId } = req.body;

        if (!tradeId || typeof tradeId !== 'string' || !isValidUUID(tradeId)) {
            res.status(400).json({ error: 'Invalid tradeId format' });
            return;
        }

        const trade = await queryOne<any>('SELECT * FROM trades WHERE id = $1', [tradeId]);

        if (!trade) {
            res.status(404).json({ error: 'Trade not found' });
            return;
        }

        if (trade.status !== 'PENDING' && trade.status !== 'OPEN') {
            throw new TradingError('Cannot cancel trade in current status', 'INVALID_STATUS');
        }

        if (!trade.weex_order_id) {
            throw new TradingError('Trade has no associated exchange order', 'NO_ORDER_ID');
        }

        const weexClient = getWeexClient();
        await weexClient.cancelOrder(trade.weex_order_id);

        await query('UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2', ['CANCELED', tradeId]);

        res.json({ message: 'Trade canceled', tradeId });
    } catch (error) {
        next(error);
    }
});

export default router;
