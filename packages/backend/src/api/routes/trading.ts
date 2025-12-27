import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth';
import { getWeexClient } from '../../services/weex/WeexClient';
import { query, queryOne, withTransaction } from '../../config/database';
import { getRedisClient } from '../../config/redis';
import { logger } from '../../utils/logger';
import { TradingError, ValidationError } from '../../utils/errors';
import { v4 as uuid } from 'uuid';
import { isApprovedSymbol, APPROVED_SYMBOLS } from '@hypothesis-arena/shared';

const router = Router();

// Valid trade statuses
const VALID_TRADE_STATUSES = ['PENDING', 'OPEN', 'FILLED', 'CANCELED', 'FAILED'];

// UUID validation helper
const isValidUUID = (id: string): boolean => {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
};

// Per-user rate limiting constants
const TRADES_PER_MINUTE = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60;

/**
 * Check per-user rate limit using Redis for multi-instance support
 * Uses atomic Lua script to prevent race condition where INCR creates key without TTL
 * 
 * FIXED: Race condition where INCR could create key without TTL if EXPIRE failed
 * FIXED: Fail-closed on Redis errors for trading safety
 */
async function checkUserRateLimit(userId: string): Promise<boolean> {
    try {
        const redis = await getRedisClient();
        const key = `rate_limit:trading:${userId}`;

        // Atomic Lua script: INCR and set EXPIRE atomically when count is 1
        // This prevents race condition where key exists without TTL
        const luaScript = `
            local count = redis.call('INCR', KEYS[1])
            if count == 1 then
                redis.call('EXPIRE', KEYS[1], ARGV[1])
            end
            return count
        `;

        const count = await redis.eval(luaScript, {
            keys: [key],
            arguments: [String(RATE_LIMIT_WINDOW_SECONDS)]
        }) as number;

        return count <= TRADES_PER_MINUTE;
    } catch (error) {
        // FAIL-CLOSED: Reject requests on Redis failure for trading safety
        // This prevents potential abuse if Redis is down
        logger.error('CRITICAL: Rate limit check failed, rejecting request for safety:', error);
        return false;
    }
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
router.post('/execute', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    try {
        // Per-user rate limiting (async Redis-based)
        const withinLimit = await checkUserRateLimit(req.userId!);
        if (!withinLimit) {
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

        // Get portfolio (quick check, no lock)
        const portfolio = await queryOne<any>(
            'SELECT * FROM portfolios WHERE id = $1 AND user_id = $2',
            [data.portfolioId, req.userId]
        );

        if (!portfolio) {
            throw new ValidationError('Portfolio not found');
        }

        // Generate client order ID
        const clientOrderId = `${Date.now()}_${uuid().substring(0, 8)}`;
        const tradeId = uuid();

        // PHASE 1: Place order on WEEX OUTSIDE transaction (no DB lock held)
        const weexClient = getWeexClient();
        let orderResponse: { order_id: string };

        try {
            orderResponse = await weexClient.placeOrder({
                symbol,
                client_oid: clientOrderId,
                type: data.side.toLowerCase() === 'buy' ? '1' : '2', // 1=Open long, 2=Open short
                order_type: '0', // Normal order
                match_price: data.type === 'MARKET' ? '1' : '0', // 1=Market, 0=Limit
                size: String(data.size),
                price: data.price ? String(data.price) : '0',
            });

            if (!orderResponse.order_id) {
                throw new TradingError('WEEX did not return an order ID', 'NO_ORDER_ID');
            }
        } catch (error: any) {
            // WEEX order failed - save failed trade record for audit trail
            try {
                await query(
                    `INSERT INTO trades (id, portfolio_id, symbol, side, type, size, price, status, client_order_id, confidence, reason, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'FAILED', $8, $9, $10, NOW())`,
                    [tradeId, data.portfolioId, symbol, data.side, data.type, data.size, data.price || 0, clientOrderId, data.confidence, data.reason]
                );
                logger.info(`Failed trade recorded for audit: ${tradeId}`, { clientOrderId, error: error.message });
            } catch (dbError: any) {
                // CRITICAL: Even audit trail insert failed - log for manual investigation
                logger.error('CRITICAL: Failed to save failed trade audit record', {
                    tradeId,
                    clientOrderId,
                    originalError: error.message,
                    dbError: dbError.message,
                });
            }
            throw new TradingError(error.message || 'Failed to place order on WEEX', error.code || 'WEEX_ORDER_FAILED');
        }

        // PHASE 2: Persist to DB in transaction (short, no network I/O)
        // NOTE: Market orders are assumed FILLED on WEEX success, but this is not guaranteed.
        // For production, implement order status polling or webhook to confirm fill.
        // Limit orders should always be marked PENDING until confirmed.
        const initialStatus = data.type === 'MARKET' ? 'FILLED' : 'PENDING';
        try {
            await withTransaction(async (client) => {
                // Insert trade record
                await client.query(
                    `INSERT INTO trades (id, portfolio_id, symbol, side, type, size, price, status, client_order_id, weex_order_id, confidence, reason, executed_at, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${data.type === 'MARKET' ? 'NOW()' : 'NULL'}, NOW())`,
                    [tradeId, data.portfolioId, symbol, data.side, data.type, data.size, data.price || 0, initialStatus, clientOrderId, orderResponse.order_id, data.confidence, data.reason]
                );

                // Update portfolio total_trades
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
            // CRITICAL: WEEX order succeeded but DB persist failed
            logger.error('CRITICAL: Trade placed on WEEX but DB update failed', {
                clientOrderId,
                weexOrderId: orderResponse.order_id,
                tradeId,
                error: dbError.message,
            });

            // Try to save a failed record for manual reconciliation
            await query(
                `INSERT INTO trades (id, portfolio_id, symbol, side, type, size, price, status, client_order_id, weex_order_id, confidence, reason, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'FAILED', $8, $9, $10, $11, NOW())
                 ON CONFLICT (id) DO NOTHING`,
                [tradeId, data.portfolioId, symbol, data.side, data.type, data.size, data.price || 0, clientOrderId, orderResponse.order_id, data.confidence, data.reason]
            ).catch(e => logger.error('Failed to save failed trade record:', e));

            throw new TradingError(
                `Trade executed on WEEX (${orderResponse.order_id}) but DB update failed. Manual reconciliation required.`,
                'DB_PERSIST_FAILED'
            );
        }
    } catch (error) {
        next(error);
    }
});


// GET /api/trading/orders
router.get('/orders', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { portfolioId, status, limit = 50 } = req.query;

        // Build query with proper parameterized placeholders
        const conditions: string[] = ['p.user_id = $1'];
        const params: any[] = [req.userId];

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

        const sql = `
            SELECT t.* FROM trades t
            JOIN portfolios p ON t.portfolio_id = p.id
            WHERE ${conditions.join(' AND ')}
            ORDER BY t.created_at DESC
            LIMIT $${params.length}
        `;

        const trades = await query(sql, params);
        res.json({ trades });
    } catch (error) {
        next(error);
    }
});

// GET /api/trading/order/:id
router.get('/order/:id', authenticate, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { id } = req.params;

        if (!isValidUUID(id)) {
            res.status(400).json({ error: 'Invalid trade ID format' });
            return;
        }

        const trade = await queryOne<any>(
            `SELECT t.* FROM trades t
             JOIN portfolios p ON t.portfolio_id = p.id
             WHERE t.id = $1 AND p.user_id = $2`,
            [id, req.userId]
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

        if (!tradeId || typeof tradeId !== 'string' || !isValidUUID(tradeId)) {
            res.status(400).json({ error: 'Invalid tradeId format' });
            return;
        }

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

        if (!trade.weex_order_id) {
            throw new TradingError('Trade has no associated exchange order', 'NO_ORDER_ID');
        }

        // Cancel on WEEX
        const weexClient = getWeexClient();
        await weexClient.cancelOrder(trade.weex_order_id);

        // Update status
        await query(
            'UPDATE trades SET status = $1, updated_at = NOW() WHERE id = $2',
            ['CANCELED', tradeId]
        );

        res.json({ message: 'Trade canceled', tradeId });
    } catch (error) {
        next(error);
    }
});

export default router;
