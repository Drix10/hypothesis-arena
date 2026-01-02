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

// PERFORMANCE FIX: Cache AnalystPortfolioService import to avoid repeated dynamic imports
// Dynamic imports on every request are inefficient - cache the module after first load
let AnalystPortfolioServiceCache: typeof import('../../services/portfolio/AnalystPortfolioService').AnalystPortfolioService | null = null;

async function getAnalystPortfolioService() {
    if (!AnalystPortfolioServiceCache) {
        const module = await import('../../services/portfolio/AnalystPortfolioService');
        AnalystPortfolioServiceCache = module.AnalystPortfolioService;
    }
    return AnalystPortfolioServiceCache;
}

// Valid trade statuses
const VALID_TRADE_STATUSES = ['PENDING', 'OPEN', 'FILLED', 'CANCELED', 'FAILED'];

// UUID validation helper - optimized regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isValidUUID = (id: string): boolean => {
    // FIXED: Add length check before regex for performance
    if (!id || id.length !== 36) return false;
    return UUID_REGEX.test(id);
};

// Simple in-memory rate limiting with cleanup
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const TRADES_PER_MINUTE = 10;
const RATE_LIMIT_CLEANUP_INTERVAL = 60000; // Clean up every minute
const MAX_RATE_LIMIT_ENTRIES = 1000; // Prevent unbounded growth

// Cleanup old rate limit entries to prevent memory leak
// Store interval ID for cleanup on shutdown
let rateLimitCleanupInterval: NodeJS.Timeout | null = setInterval(() => {
    const now = Date.now();

    // FIXED: Emergency clear with grace period to prevent rate limit bypass
    // Only clear entries older than 2x the window to maintain rate limiting
    if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
        logger.warn(`Rate limit map exceeded ${MAX_RATE_LIMIT_ENTRIES} entries, clearing old entries`);
        const cutoffTime = now - (60000 * 2); // 2x the rate limit window
        for (const [key, entry] of rateLimitMap.entries()) {
            if (entry.resetTime < cutoffTime) {
                rateLimitMap.delete(key);
            }
        }
        // If still too large after cleanup, clear oldest 50%
        if (rateLimitMap.size > MAX_RATE_LIMIT_ENTRIES) {
            const entries = Array.from(rateLimitMap.entries())
                .sort((a, b) => a[1].resetTime - b[1].resetTime);
            const toDelete = entries.slice(0, Math.floor(entries.length / 2));
            toDelete.forEach(([key]) => rateLimitMap.delete(key));
            logger.warn(`Cleared ${toDelete.length} oldest rate limit entries`);
        }
        return;
    }

    for (const [key, entry] of rateLimitMap.entries()) {
        if (now > entry.resetTime) {
            rateLimitMap.delete(key);
        }
    }
}, RATE_LIMIT_CLEANUP_INTERVAL);

// Export cleanup function for graceful shutdown
// FIXED: Idempotent cleanup - safe to call multiple times
export function cleanupTradingRoutes(): void {
    try {
        // CRITICAL: Check if interval exists before clearing
        // This makes cleanup idempotent (safe to call multiple times)
        if (rateLimitCleanupInterval !== null) {
            clearInterval(rateLimitCleanupInterval);
            rateLimitCleanupInterval = null;
        }

        // CRITICAL: Only clear map if it has entries
        // Prevents unnecessary operations on repeated cleanup calls
        if (rateLimitMap.size > 0) {
            rateLimitMap.clear();
        }
    } catch (error) {
        // Log but don't throw - cleanup should never fail the shutdown process
        logger.warn('Error during trading routes cleanup:', error);
    }
}

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
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${data.type === 'MARKET' ? 'CURRENT_TIMESTAMP' : 'NULL'}, CURRENT_TIMESTAMP)`,
                    [tradeId, data.portfolioId, symbol, data.side, data.type, data.size, data.price || 0, initialStatus, clientOrderId, orderResponse.order_id, data.confidence, data.reason]
                );

                await client.query(
                    'UPDATE portfolios SET total_trades = total_trades + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
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

        await query('UPDATE trades SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', ['CANCELED', tradeId]);

        res.json({ message: 'Trade canceled', tradeId });
    } catch (error) {
        next(error);
    }
});

// POST /api/trading/manual/close - Manual position close
router.post('/manual/close', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        // SECURITY FIX: Add rate limiting for manual operations
        if (!checkRateLimit()) {
            res.status(429).json({
                error: `Rate limit exceeded. Maximum ${TRADES_PER_MINUTE} operations per minute.`,
                code: 'RATE_LIMIT_EXCEEDED'
            });
            return;
        }

        const { symbol, side, size } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ error: 'Symbol is required', code: 'INVALID_SYMBOL' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isApprovedSymbol(normalizedSymbol)) {
            throw new ValidationError(`Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}`);
        }

        const weexClient = getWeexClient();

        // FIXED: Verify position exists and is valid before attempting close
        const positions = await weexClient.getPositions();
        const position = positions.find((p: any) => p.symbol === normalizedSymbol);

        if (!position || parseFloat(position.size) === 0) {
            res.status(404).json({
                error: 'No open position for this symbol',
                code: 'POSITION_NOT_FOUND',
                symbol: normalizedSymbol
            });
            return;
        }

        // FIXED: Use closePartialPosition for targeted close (closes only the specific position)
        // This prevents accidentally closing multiple positions for the same symbol
        const positionSide = (side || position.side || '').toUpperCase() as 'LONG' | 'SHORT';
        const positionSize = size || position.size;

        if (positionSide !== 'LONG' && positionSide !== 'SHORT') {
            res.status(400).json({
                error: 'Invalid position side. Must be LONG or SHORT',
                code: 'INVALID_SIDE',
                side: positionSide
            });
            return;
        }

        // Validate size
        const sizeNum = parseFloat(positionSize);
        if (!Number.isFinite(sizeNum) || sizeNum <= 0) {
            res.status(400).json({
                error: 'Invalid position size',
                code: 'INVALID_SIZE',
                size: positionSize
            });
            return;
        }

        // Use closePartialPosition with full size to close the specific position
        const closeResponse = await weexClient.closePartialPosition(
            normalizedSymbol,
            positionSide,
            String(positionSize),
            '1' // Market order
        );

        if (!closeResponse || !closeResponse.order_id) {
            throw new Error('Invalid response from WEEX closePartialPosition endpoint');
        }

        const tradeId = uuid();
        const orderId = closeResponse.order_id;

        // FIXED: Log to database with proper error handling
        try {
            const portfolio = await queryOne<any>(
                'SELECT * FROM portfolios WHERE agent_id = $1',
                ['collaborative']
            );

            if (portfolio) {
                // CRITICAL FIX: Map WEEX position side to Prisma enum for CLOSE operations
                // When CLOSING a position, use the OPPOSITE side:
                // - Closing LONG → SELL (you sell to close a long)
                // - Closing SHORT → BUY (you buy to close a short)
                // WEEX uses: LONG/SHORT for position direction
                // Prisma enum: BUY/SELL for trade action
                const prismaSide = positionSide === 'LONG' ? 'SELL' : 'BUY';

                await withTransaction(async (client) => {
                    await client.query(
                        `INSERT INTO trades (id, portfolio_id, symbol, side, type, size, price, status, client_order_id, weex_order_id, reason, executed_at, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
                        [
                            tradeId,
                            portfolio.id,
                            normalizedSymbol,
                            prismaSide,
                            'MARKET',
                            sizeNum,
                            0, // Market close
                            'FILLED',
                            `manual_close_${Date.now()}`,
                            orderId,
                            'Manual close via UI'
                        ]
                    );

                    await client.query(
                        'UPDATE portfolios SET total_trades = total_trades + 1, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
                        [portfolio.id]
                    );
                });

                // FIXED: Create AI log for WEEX compliance
                try {
                    const { aiLogService } = await import('../../services/compliance/AILogService');
                    await aiLogService.createLog(
                        'manual_close', // FIXED: Use correct stage for manual closes
                        'manual',
                        {
                            symbol: normalizedSymbol,
                            action: 'close_position',
                            side: positionSide,
                            size: sizeNum,
                            source: 'ui'
                        },
                        {
                            orderId,
                            success: true
                        },
                        'Manual position close via UI',
                        orderId
                    );
                    logger.info(`📝 AI log created for manual close: ${orderId}`);
                } catch (logError) {
                    logger.error('Failed to create AI log for manual close:', logError);
                    // Don't fail the request - position is already closed
                }
            }
        } catch (dbError: any) {
            logger.error('Failed to persist manual close to database:', {
                orderId,
                symbol: normalizedSymbol,
                error: dbError.message
            });
            // Don't fail the request if DB logging fails - position is already closed
        }

        logger.info(`Manual position closed: ${normalizedSymbol}`, {
            side: positionSide,
            size: positionSize,
            orderId,
            tradeId
        });

        res.json({
            success: true,
            message: 'Position closed successfully',
            symbol: normalizedSymbol,
            side: positionSide,
            size: positionSize,
            orderId,
            tradeId
        });

    } catch (error: any) {
        next(error);
    }
});

// GET /api/trading/candles/:symbol - Get candlestick data
router.get('/candles/:symbol', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol } = req.params;
        const { interval = '1h', limit = 100 } = req.query;

        if (!symbol) {
            res.status(400).json({ error: 'Symbol is required' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase();
        if (!isApprovedSymbol(normalizedSymbol)) {
            throw new ValidationError(`Symbol not approved. Allowed: ${APPROVED_SYMBOLS.join(', ')}`);
        }

        // SECURITY FIX: Validate interval parameter
        const validIntervals = ['1m', '5m', '15m', '30m', '1h', '4h', '12h', '1d', '1w'];
        const intervalStr = String(interval);
        if (!validIntervals.includes(intervalStr)) {
            res.status(400).json({
                error: 'Invalid interval',
                validIntervals
            });
            return;
        }

        // SECURITY FIX: Validate and sanitize limit parameter
        const limitNum = parseInt(String(limit), 10);
        if (isNaN(limitNum) || limitNum < 1 || limitNum > 1000) {
            res.status(400).json({
                error: 'Invalid limit. Must be between 1 and 1000'
            });
            return;
        }

        const weexClient = getWeexClient();
        const candles = await weexClient.getCandles(normalizedSymbol, intervalStr, limitNum);

        res.json({ candles });
    } catch (error) {
        next(error);
    }
});

// GET /api/analysts/:analystId/stats - Get analyst performance statistics
// FIXED: Now uses AnalystPortfolioService for accurate portfolio data
router.get('/analysts/:analystId/stats', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { analystId } = req.params;

        if (!analystId) {
            res.status(400).json({ success: false, error: 'Analyst ID is required' });
            return;
        }

        // FIXED: Validate analystId format (must be valid analyst ID, not UUID)
        // Valid analyst IDs: warren, cathie, jim, ray, elon, karen, quant, devil
        const validAnalystIds = ['warren', 'cathie', 'jim', 'ray', 'elon', 'karen', 'quant', 'devil'];
        if (!validAnalystIds.includes(analystId)) {
            res.status(400).json({
                success: false,
                error: 'Invalid analyst ID format. Must be one of: ' + validAnalystIds.join(', ')
            });
            return;
        }

        // Use the cached AnalystPortfolioService
        const AnalystPortfolioService = await getAnalystPortfolioService();
        const result = await AnalystPortfolioService.getAnalystStats(analystId);

        if (!result) {
            res.status(404).json({
                success: false,
                error: 'Analyst not found or invalid analyst ID'
            });
            return;
        }

        // Format response to match frontend expectations
        // FIXED: Removed openTrades and avgConfidence (not used by frontend, always 0)
        res.json({
            success: true,
            analystId,
            portfolio: {
                agentId: result.portfolio.agentId,
                agentName: result.portfolio.agentName,
                totalReturnDollar: result.portfolio.totalReturnDollar,
                totalReturn: result.portfolio.totalReturn,
                winRate: result.portfolio.winRate,
                sharpeRatio: result.portfolio.sharpeRatio,
                maxDrawdown: result.portfolio.maxDrawdown,
                tournamentWins: result.portfolio.tournamentWins,
                updatedAt: result.portfolio.updatedAt
            },
            stats: {
                totalTrades: result.portfolio.totalTrades,
                winningTrades: result.portfolio.winningTrades,
                losingTrades: result.portfolio.losingTrades,
                winRate: result.portfolio.winRate.toFixed(2),
                avgPnl: result.metrics.avgPnlPerTrade,
                totalPnl: result.portfolio.totalReturnDollar,
                bestTrade: result.metrics.bestTrade,
                worstTrade: result.metrics.worstTrade,
                favoriteSymbol: result.metrics.favoriteSymbol
            },
            recentTrades: result.recentTrades.map(trade => ({
                symbol: trade.symbol,
                side: trade.side,
                size: trade.size,
                price: trade.price,
                realized_pnl: trade.realizedPnl,
                realized_pnl_percent: trade.realizedPnlPercent,
                executed_at: trade.executedAt,
                status: trade.status,
                confidence: trade.confidence,
                reason: trade.reason
            }))
        });
    } catch (error) {
        logger.error('Failed to get analyst stats:', error);
        next(error);
    }
});

// ============================================================================
// ANALYST LEADERBOARD & PORTFOLIO ENDPOINTS
// ============================================================================

/**
 * GET /api/trading/leaderboard
 * Get analyst leaderboard ranked by P&L
 */
router.get('/leaderboard', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const AnalystPortfolioService = await getAnalystPortfolioService();
        const leaderboard = await AnalystPortfolioService.getLeaderboard();

        res.json({
            success: true,
            data: leaderboard
        });
    } catch (error) {
        logger.error('Failed to get analyst leaderboard:', error);
        next(error);
    }
});

/**
 * GET /api/trading/comparative-stats
 * Get comparative stats for all analysts
 */
router.get('/comparative-stats', async (_req: Request, res: Response, next: NextFunction) => {
    try {
        const AnalystPortfolioService = await getAnalystPortfolioService();
        const stats = await AnalystPortfolioService.getComparativeStats();

        res.json({
            success: true,
            data: stats
        });
    } catch (error) {
        logger.error('Failed to get comparative stats:', error);
        next(error);
    }
});

export default router;
