import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getWeexClient } from '../../services/weex/WeexClient';
import { query, queryOne } from '../../config/database';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/errors';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';
import { isApprovedSymbol } from '../../shared/utils/validation';
import { ANALYST_PROFILES } from '../../constants/analyst';

const router = Router();

// ============================================================================
// RATE LIMITING MIDDLEWARE
// ============================================================================
// Targeted rate limits for external-facing and write-heavy endpoints.
// These supplement the global rate limiter in server.ts (500 req/15min).
// ============================================================================

/**
 * Rate limiter for /candles endpoint - protects external WEEX API calls
 * More restrictive than global limit since each request hits external API
 */
const candlesRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 30, // 30 requests per minute per IP (0.5 req/sec)
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Use Express's proxy-aware req.ip (requires app.set('trust proxy', ...) in server.ts)
        // Do NOT manually parse X-Forwarded-For to prevent IP spoofing
        return req.ip || 'unknown';
    },
    handler: (_req, res) => {
        logger.warn('Candles endpoint rate limit exceeded');
        res.status(429).json({
            error: 'Too many candle requests. Please wait before trying again.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: 60
        });
    },
    skip: (req) => {
        // Skip rate limiting for internal/localhost requests in development
        if (process.env.NODE_ENV === 'development') {
            const ip = req.ip || '';
            return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        }
        return false;
    }
});

/**
 * Rate limiter for /orders endpoint - protects database from excessive queries
 * Moderate limit since it's read-only but can be expensive
 */
const ordersRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute window
    max: 60, // 60 requests per minute per IP (1 req/sec)
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        // Use Express's proxy-aware req.ip (requires app.set('trust proxy', ...) in server.ts)
        // Do NOT manually parse X-Forwarded-For to prevent IP spoofing
        return req.ip || 'unknown';
    },
    handler: (_req, res) => {
        logger.warn('Orders endpoint rate limit exceeded');
        res.status(429).json({
            error: 'Too many order queries. Please wait before trying again.',
            code: 'RATE_LIMIT_EXCEEDED',
            retryAfter: 60
        });
    },
    skip: (req) => {
        if (process.env.NODE_ENV === 'development') {
            const ip = req.ip || '';
            return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        }
        return false;
    }
});

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

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

// Export cleanup function for graceful shutdown (no-op since rate limiting uses express-rate-limit which auto-cleans)
export function cleanupTradingRoutes(): void {
    // No cleanup needed - express-rate-limit handles its own cleanup
}

// ============================================================================
// ROUTES
// ============================================================================

// POST /api/trading/execute
// DISABLED: Manual trading is prohibited per WEEX competition rules.
// All trading must be conducted through the AI-driven autonomous trading engine.
// This endpoint is kept for reference but returns 403 Forbidden.
router.post('/execute', async (_req: Request, res: Response, _next: NextFunction) => {
    logger.warn('Manual trade execution attempted - blocked per competition rules');
    res.status(403).json({
        error: 'Manual trading is prohibited. All trades must be executed through the AI trading engine.',
        code: 'MANUAL_TRADING_PROHIBITED',
        reason: 'WEEX AI Trading Competition rules require all trading to use genuine AI technology. Manual trading is strictly prohibited.'
    });
});

// GET /api/trading/orders
// Rate limited: 60 requests/minute per IP to protect database
router.get('/orders', ordersRateLimiter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
// DISABLED: Manual trading intervention is prohibited per WEEX competition rules.
// Order cancellation must be handled by the AI trading engine if needed.
// This endpoint is kept for reference but returns 403 Forbidden.
router.post('/cancel', async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
    logger.warn('Manual order cancellation attempted - blocked per competition rules');
    res.status(403).json({
        error: 'Manual order cancellation is prohibited. All trading operations must be handled by the AI trading engine.',
        code: 'MANUAL_TRADING_PROHIBITED',
        reason: 'WEEX AI Trading Competition rules require all trading to use genuine AI technology. Manual intervention is strictly prohibited.'
    });
});

// POST /api/trading/manual/close - Manual position close
// DISABLED: Manual trading is prohibited per WEEX competition rules.
// Position management must be handled by the AI trading engine.
// This endpoint is kept for reference but returns 403 Forbidden.
router.post('/manual/close', async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
    logger.warn('Manual position close attempted - blocked per competition rules');
    res.status(403).json({
        error: 'Manual position closing is prohibited. All position management must be handled by the AI trading engine.',
        code: 'MANUAL_TRADING_PROHIBITED',
        reason: 'WEEX AI Trading Competition rules require all trading to use genuine AI technology. Manual trading is strictly prohibited.'
    });
});

// GET /api/trading/candles/:symbol - Get candlestick data
// Rate limited: 30 requests/minute per IP to protect external WEEX API
router.get('/candles/:symbol', candlesRateLimiter, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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
        // Valid analyst IDs are dynamically determined from ANALYST_PROFILES
        const validAnalystIds = Object.values(ANALYST_PROFILES).map(p => p.id);
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
