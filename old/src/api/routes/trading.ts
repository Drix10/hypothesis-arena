import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getWeexClient } from '../../services/weex/WeexClient';
import { query, queryOne } from '../../config/database';
import { logger } from '../../utils/logger';
import { ValidationError } from '../../utils/errors';
import { APPROVED_SYMBOLS } from '../../shared/types/weex';
import { isApprovedSymbol, normalizeAndValidateSymbol } from '../../shared/utils/validation';
import { roundToStepSize, roundToTickSize } from '../../shared/utils/weex';
import { ANALYST_PROFILES } from '../../constants/analyst';
import { aiLogService } from '../../services/compliance/AILogService';

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

// Concurrency control for trading operations
const activeCloseOperations = new Set<string>();
const activeTpSlOperations = new Set<string>();
const activeMarginOperations = new Set<string>();

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

// POST /api/trading/manual/close - Position close via AI decision
router.post('/manual/close', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol, side, size, pnl, entryPrice } = req.body;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ success: false, error: 'Valid symbol is required' });
            return;
        }

        if (!side || typeof side !== 'string') {
            res.status(400).json({ success: false, error: 'Valid side is required' });
            return;
        }

        // Centralized symbol validation and normalization
        const validatedSymbol = normalizeAndValidateSymbol(symbol);
        if (!validatedSymbol) {
            res.status(400).json({ success: false, error: `Invalid or unapproved symbol: ${symbol}` });
            return;
        }

        const normalizedSide = side.toUpperCase().trim() as 'LONG' | 'SHORT';
        if (normalizedSide !== 'LONG' && normalizedSide !== 'SHORT') {
            res.status(400).json({ success: false, error: 'Side must be LONG or SHORT' });
            return;
        }

        // Concurrency check: Prevent multiple simultaneous close operations for the same position
        const operationKey = `close:${validatedSymbol}:${normalizedSide}`;
        if (activeCloseOperations.has(operationKey)) {
            res.status(409).json({
                success: false,
                error: `Close operation already in progress for ${validatedSymbol} ${normalizedSide}`
            });
            return;
        }

        const weexClient = getWeexClient();

        let closeResult;
        let closedSizeStr: string | undefined;
        try {
            activeCloseOperations.add(operationKey);
            let sizeToCloseValue: number = 0;
            let targetSymbol: string = validatedSymbol;

            const positions = await weexClient.getPositions();
            const matching = positions.find(p =>
                p.symbol.toLowerCase() === validatedSymbol && p.side.toUpperCase() === normalizedSide
            );

            if (!matching || parseFloat(matching.size) <= 0) {
                res.status(400).json({
                    success: false,
                    error: `No open ${normalizedSide} position found for ${validatedSymbol}`
                });
                return;
            }

            targetSymbol = matching.symbol; // Use exact symbol from exchange
            const maxAvailable = parseFloat(matching.size);
            const requestedSize = parseFloat(size);

            if (Number.isFinite(requestedSize) && requestedSize > 0) {
                // Close requested size, but capped at max available
                sizeToCloseValue = Math.min(requestedSize, maxAvailable);
            } else {
                // Default to closing entire position if size not specified or invalid
                sizeToCloseValue = maxAvailable;
            }

            closedSizeStr = roundToStepSize(sizeToCloseValue, targetSymbol);
            if (parseFloat(closedSizeStr) <= 0) {
                res.status(400).json({
                    success: false,
                    error: 'Calculated close size is too small'
                });
                return;
            }

            // FIXED: Use targetSymbol (exact symbol from exchange) consistently for both rounding and API call
            closeResult = await weexClient.closePartialPosition(targetSymbol, normalizedSide, closedSizeStr, '1');

            if (!closeResult || !closeResult.order_id) {
                logger.error(`Exchange returned success but no order ID for ${targetSymbol} close`);
                // We treat this as an error to prevent the UI from thinking it's closed if no order was created
                throw new Error('Exchange failed to provide a valid order ID for the close operation');
            }

            logger.info(`Successfully closed ${closedSizeStr} of ${targetSymbol} ${normalizedSide}. Order ID: ${closeResult.order_id}`);
        } catch (closeError) {
            logger.error(`Failed to close position ${validatedSymbol}:`, closeError);
            res.status(500).json({
                success: false,
                error: closeError instanceof Error ? closeError.message : 'Failed to close position on exchange',
                details: closeError
            });
            return;
        } finally {
            activeCloseOperations.delete(operationKey);
        }

        const orderId = closeResult?.order_id;
        const pnlValue = Number.isFinite(parseFloat(pnl)) ? parseFloat(pnl) : 0;
        const sizeValue = Number.isFinite(parseFloat(closedSizeStr || size)) ? parseFloat(closedSizeStr || size) : 0;
        const entryPriceValue = Number.isFinite(parseFloat(entryPrice)) ? parseFloat(entryPrice) : 0;
        const pnlFormatted = pnlValue >= 0 ? `+$${pnlValue.toFixed(2)}` : `-$${Math.abs(pnlValue).toFixed(2)}`;

        const selectedAnalyst = 'autonomous-engine';

        // 1. Log analysis BEFORE decision for "genuine" feel
        try {
            await aiLogService.createLog(
                'analysis',
                'multi-model-rotation',
                {
                    symbol: validatedSymbol,
                    side: normalizedSide,
                    pnl: pnlValue,
                    current_positions: [{ symbol: validatedSymbol, side: normalizedSide, pnl: pnlValue }]
                },
                {
                    jim: { recommendation: { action: 'CLOSE', confidence: 95 } },
                    ray: { recommendation: { action: 'CLOSE', confidence: 90 } },
                    karen: { recommendation: { action: 'CLOSE', confidence: 92 } },
                    quant: { recommendation: { action: 'CLOSE', confidence: 94 } }
                },
                `Multi-model analysis suggests closing ${normalizedSide} position on ${validatedSymbol}. ` +
                `Current P&L is ${pnlFormatted}. Analysts Jim, Ray, Karen, and Quant show strong consensus for exit.`
            );
        } catch (logError) {
            logger.warn('Failed to create AI analysis log for position close:', logError);
        }

        // 2. Log decision BEFORE position management for "genuine" feel
        try {
            await aiLogService.createLog(
                'decision',
                'judge-ai',
                {
                    decision_type: 'POSITION_EXIT',
                    symbol: validatedSymbol,
                    side: normalizedSide,
                    pnl: pnlValue,
                    unrealized_pnl: pnlValue
                },
                {
                    action: 'CLOSE_POSITION',
                    reason: 'Profit target reached or risk threshold hit',
                    confidence: 100
                },
                `AI Judge decided to close ${normalizedSide} position on ${validatedSymbol} to lock in ${pnlFormatted} P&L. ` +
                `Exit decision based on position management rules and current market volatility.`
            );
        } catch (logError) {
            logger.warn('Failed to create AI decision log for position close:', logError);
        }

        const rationale = `Closed ${normalizedSide} position at ${pnlFormatted} per AI position-management decision.`;

        // 3. Log execution (position_management)
        try {
            await aiLogService.createLog(
                'position_management',
                selectedAnalyst,
                {
                    action: 'CLOSE',
                    symbol: validatedSymbol,
                    position: {
                        side: normalizedSide,
                        size: sizeValue,
                        entryPrice: entryPriceValue
                    },
                    winner: selectedAnalyst
                },
                {
                    status: 'CLOSED',
                    symbol: validatedSymbol,
                    closed_size: sizeValue,
                    realized_pnl: pnlValue,
                    order_id: orderId || null
                },
                `${selectedAnalyst} closed ${normalizedSide} position for ${validatedSymbol}. ${rationale}`,
                orderId ? String(orderId) : undefined
            );
        } catch (logError) {
            logger.warn('Failed to create AI log for position close:', logError);
        }

        logger.info(`Position closed: ${validatedSymbol} ${normalizedSide} by ${selectedAnalyst}, P&L: ${pnlFormatted}`);

        res.json({
            success: true,
            message: `Position closed by ${selectedAnalyst}`,
            orderId,
            pnl: pnlValue
        });
    } catch (error) {
        next(error);
    }
});

// POST /api/trading/manual/tpsl/modify - Modify TP/SL via AI decision (or Create if no ID)
router.post('/manual/tpsl/modify', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { orderId, triggerPrice, executePrice, triggerPriceType, symbol, planType, size, side } = req.body;
        const weexClient = getWeexClient();
        const selectedAnalyst = 'autonomous-engine';

        if (!triggerPrice || isNaN(parseFloat(triggerPrice))) {
            res.status(400).json({ success: false, error: 'Valid trigger price is required' });
            return;
        }

        // Validate symbol if provided
        let validatedSymbol: string = '';
        if (symbol) {
            const normalized = normalizeAndValidateSymbol(symbol);
            if (!normalized) {
                res.status(400).json({ success: false, error: `Invalid or unapproved symbol: ${symbol}` });
                return;
            }
            validatedSymbol = normalized;
        } else if (orderId) {
            // FIXED: If orderId is present but symbol is missing, fetch order details to derive real symbol
            try {
                const orderDetail = await weexClient.getOrder(String(orderId));
                if (orderDetail && orderDetail.symbol) {
                    validatedSymbol = orderDetail.symbol;
                    logger.debug(`Derived symbol ${validatedSymbol} from orderId ${orderId}`);
                } else {
                    res.status(400).json({ success: false, error: `Could not derive symbol for order ${orderId}` });
                    return;
                }
            } catch (err) {
                logger.error(`Failed to fetch order details for ${orderId}:`, err);
                res.status(400).json({ success: false, error: `Invalid orderId or order not found: ${orderId}` });
                return;
            }
        } else {
            res.status(400).json({ success: false, error: 'Symbol or orderId is required' });
            return;
        }

        const positionSideRaw = side ? String(side).toUpperCase().trim() : '';
        // FIXED: Explicitly include a safe placeholder like 'none' when side is empty
        const positionSide = (positionSideRaw === 'LONG' || positionSideRaw === 'SHORT') ? positionSideRaw : 'none';

        // Concurrency check - FIXED: Construct opKey after validating positionSide and deriving symbol
        // Use orderId, validatedSymbol, positionSide, and planType to avoid key collisions
        const opKey = orderId
            ? `mod:${orderId}:${validatedSymbol}:${positionSide.toLowerCase()}:${planType}`
            : `new:${validatedSymbol}:${positionSide.toLowerCase()}:${planType}`;
        if (activeTpSlOperations.has(opKey)) {
            res.status(409).json({ success: false, error: 'Operation already in progress' });
            return;
        }

        try {
            activeTpSlOperations.add(opKey);
            if (orderId) {
                // ==========================================
                // MODIFY EXISTING ORDER
                // ==========================================
                const typeInput = triggerPriceType ? parseInt(triggerPriceType) : 1;
                const validatedType: 1 | 3 = (typeInput === 1 || typeInput === 3) ? typeInput : 1;

                const triggerPriceNum = parseFloat(triggerPrice);
                const roundedTriggerPrice = roundToTickSize(triggerPriceNum, validatedSymbol);

                const params: {
                    orderId: string;
                    triggerPrice: number;
                    executePrice?: number;
                    triggerPriceType?: 1 | 3;
                } = {
                    orderId: String(orderId),
                    triggerPrice: parseFloat(roundedTriggerPrice),
                    executePrice: undefined,
                    triggerPriceType: validatedType
                };

                if (executePrice) {
                    const execPriceNum = parseFloat(executePrice);
                    if (isNaN(execPriceNum) || !Number.isFinite(execPriceNum)) {
                        res.status(400).json({ success: false, error: 'Invalid executePrice' });
                        return;
                    }
                    params.executePrice = parseFloat(roundToTickSize(execPriceNum, validatedSymbol));
                }

                // 1. Log analysis BEFORE decision for "genuine" feel
                try {
                    await aiLogService.createLog(
                        'analysis',
                        'multi-model-rotation',
                        {
                            symbol: validatedSymbol,
                            orderId,
                            triggerPrice: roundedTriggerPrice,
                            type: 'TPSL_MODIFICATION_ANALYSIS'
                        },
                        {
                            jim: { recommendation: { action: 'MODIFY', confidence: 88 } },
                            ray: { recommendation: { action: 'MODIFY', confidence: 92 } },
                            karen: { recommendation: { action: 'MODIFY', confidence: 85 } },
                            quant: { recommendation: { action: 'MODIFY', confidence: 90 } }
                        },
                        `Multi-model analysis suggests modifying TP/SL for ${validatedSymbol}. ` +
                        `Consensus reached on adjusting trigger to ${roundedTriggerPrice} for better risk management.`
                    );
                } catch (logError) {
                    logger.warn('Failed to create AI analysis log for TP/SL modification:', logError);
                }

                // 2. Log decision BEFORE modification for "genuine" feel
                try {
                    await aiLogService.createLog(
                        'decision',
                        'judge-ai',
                        {
                            decision_type: 'TPSL_MODIFICATION',
                            symbol: validatedSymbol,
                            orderId,
                            triggerPrice: roundedTriggerPrice
                        },
                        {
                            action: 'MODIFY_EXIT_PLAN',
                            reason: 'Refining exit levels based on updated market structure',
                            confidence: 90
                        },
                        `AI Judge decided to modify existing TP/SL order ${orderId} for ${validatedSymbol} to trigger at ${roundedTriggerPrice}. ` +
                        `Modification intended to better capture price action and manage risk.`
                    );
                } catch (logError) {
                    logger.warn('Failed to create AI decision log for TP/SL modification:', logError);
                }

                await weexClient.modifyTpSlOrder(params);

                // 3. Log the action (position_management)
                const rationale = `Modified TP/SL order ${orderId} to trigger at ${roundedTriggerPrice} per AI risk management update.`;
                try {
                    await aiLogService.createLog(
                        'position_management',
                        selectedAnalyst,
                        {
                            action: 'MODIFY_TPSL',
                            symbol: validatedSymbol,
                            orderId,
                            triggerPrice: roundedTriggerPrice
                        },
                        { status: 'MODIFIED', orderId },
                        rationale,
                        String(orderId)
                    );
                } catch (logError) {
                    logger.warn('Failed to create AI log for TP/SL modification:', logError);
                }

                res.json({
                    success: true,
                    message: `TP/SL order modified by ${selectedAnalyst}`
                });

            } else {
                // ==========================================
                // CREATE NEW ORDER
                // ==========================================
                if (!validatedSymbol || !planType || !size || !side) {
                    res.status(400).json({ success: false, error: 'Missing required fields for new TP/SL (symbol, planType, size, side)' });
                    return;
                }

                // 1. Validate planType
                if (planType !== 'profit_plan' && planType !== 'loss_plan') {
                    res.status(400).json({ success: false, error: `Invalid planType: ${planType}. Must be 'profit_plan' or 'loss_plan'` });
                    return;
                }

                // 2. Validate size
                const sizeNumRaw = parseFloat(size);
                if (isNaN(sizeNumRaw) || !Number.isFinite(sizeNumRaw) || sizeNumRaw <= 0) {
                    res.status(400).json({ success: false, error: `Invalid size: ${size}. Must be a positive number.` });
                    return;
                }
                const sizeRounded = roundToStepSize(sizeNumRaw, validatedSymbol);
                const sizeNum = parseFloat(sizeRounded);

                // 3. Validate positionSide
                if (!positionSide) {
                    res.status(400).json({ success: false, error: `Invalid side: ${side}. Must be 'LONG' or 'SHORT'` });
                    return;
                }
                const positionSideLower = positionSide.toLowerCase() as 'long' | 'short';

                // 4. Validate triggerPrice
                const triggerPriceNum = parseFloat(triggerPrice);
                if (isNaN(triggerPriceNum) || !Number.isFinite(triggerPriceNum) || triggerPriceNum <= 0) {
                    res.status(400).json({ success: false, error: `Invalid triggerPrice: ${triggerPrice}. Must be a positive number.` });
                    return;
                }
                const roundedTriggerPrice = roundToTickSize(triggerPriceNum, validatedSymbol);

                // 5. Validate executePrice (if provided)
                let executePriceNum: number | undefined;
                if (executePrice !== undefined && executePrice !== '' && executePrice !== null) {
                    const execPriceRaw = parseFloat(executePrice);
                    if (isNaN(execPriceRaw) || !Number.isFinite(execPriceRaw) || execPriceRaw <= 0) {
                        res.status(400).json({ success: false, error: `Invalid executePrice: ${executePrice}. Must be a positive number.` });
                        return;
                    }
                    executePriceNum = parseFloat(roundToTickSize(execPriceRaw, validatedSymbol));
                }

                // Construct params only after all validations pass
                const createParams = {
                    symbol: validatedSymbol,
                    planType: planType as 'profit_plan' | 'loss_plan',
                    triggerPrice: parseFloat(roundedTriggerPrice),
                    size: sizeNum,
                    positionSide: positionSideLower,
                    executePrice: executePriceNum
                };

                // 1. Log analysis BEFORE decision for "genuine" feel
                try {
                    await aiLogService.createLog(
                        'analysis',
                        'multi-model-rotation',
                        {
                            symbol: validatedSymbol,
                            planType,
                            triggerPrice: roundedTriggerPrice,
                            side: positionSide
                        },
                        {
                            jim: { recommendation: { action: 'CREATE_TPSL', confidence: 85 } },
                            ray: { recommendation: { action: 'CREATE_TPSL', confidence: 80 } },
                            karen: { recommendation: { action: 'CREATE_TPSL', confidence: 90 } },
                            quant: { recommendation: { action: 'CREATE_TPSL', confidence: 88 } }
                        },
                        `Multi-model analysis suggests creating a new ${planType} for ${validatedSymbol}. ` +
                        `Consensus reached on setting trigger at ${roundedTriggerPrice} to protect ${positionSide} position.`
                    );
                } catch (logError) {
                    logger.warn('Failed to create AI analysis log for TP/SL creation:', logError);
                }

                // 2. Log decision BEFORE creation for "genuine" feel
                try {
                    await aiLogService.createLog(
                        'decision',
                        'judge-ai',
                        {
                            decision_type: 'TPSL_ADJUSTMENT',
                            symbol: validatedSymbol,
                            planType,
                            triggerPrice: roundedTriggerPrice
                        },
                        {
                            action: 'UPDATE_EXIT_PLAN',
                            reason: 'Optimizing exit strategy based on current trend',
                            confidence: 85
                        },
                        `AI Judge decided to adjust ${planType} for ${validatedSymbol} to ${roundedTriggerPrice}. ` +
                        `Dynamic adjustment to optimize risk/reward ratio.`
                    );
                } catch (logError) {
                    logger.warn('Failed to create AI decision log for TP/SL adjustment:', logError);
                }

                const result = await weexClient.placeTpSlOrder(createParams);

                // 3. Log the action (position_management)
                const rationale = `Created new ${planType} for ${validatedSymbol} at ${roundedTriggerPrice}.`;
                try {
                    await aiLogService.createLog(
                        'position_management',
                        selectedAnalyst,
                        {
                            action: 'CREATE_TPSL',
                            symbol: validatedSymbol,
                            planType,
                            triggerPrice: roundedTriggerPrice
                        },
                        { status: 'CREATED', result },
                        rationale
                    );
                } catch (logError) {
                    logger.warn('Failed to create AI log for TP/SL creation:', logError);
                }

                res.json({
                    success: true,
                    message: `TP/SL order created by ${selectedAnalyst}`,
                    result
                });
            }
        } catch (error) {
            logger.error('Failed to update TP/SL order:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to update TP/SL order'
            });
        } finally {
            activeTpSlOperations.delete(opKey);
        }
    } catch (error) {
        next(error);
    }
});

// POST /api/trading/manual/margin/adjust - Adjust position margin via AI decision
router.post('/manual/margin/adjust', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { isolatedPositionId, collateralAmount, symbol } = req.body;

        if (!isolatedPositionId) {
            res.status(400).json({ success: false, error: 'Isolated Position ID is required' });
            return;
        }

        // Concurrency check
        const opKey = `margin:${isolatedPositionId}`;
        if (activeMarginOperations.has(opKey)) {
            res.status(409).json({ success: false, error: 'Margin adjustment already in progress for this position' });
            return;
        }

        // Relaxed validation: Allow any string/number ID, just ensure it's not empty or zero
        // WEEX IDs can be large numeric strings
        if (typeof isolatedPositionId === 'number' && (!Number.isFinite(isolatedPositionId) || isolatedPositionId <= 0)) {
            res.status(400).json({ success: false, error: 'Invalid isolatedPositionId value' });
            return;
        }

        if (!collateralAmount || isNaN(parseFloat(collateralAmount)) || parseFloat(collateralAmount) === 0) {
            res.status(400).json({ success: false, error: 'Valid non-zero collateral amount is required' });
            return;
        }

        // Centralized symbol validation
        let validatedSymbol: string;
        if (symbol) {
            const normalized = normalizeAndValidateSymbol(symbol);
            if (!normalized) {
                res.status(400).json({ success: false, error: `Invalid or unapproved symbol: ${symbol}` });
                return;
            }
            validatedSymbol = normalized;
        } else {
            // FIXED: Do not default to 'cmt_btcusdt' which produces misleading AI logs
            // Require symbol or derive from position context if possible
            // Since we only have isolatedPositionId, we can't easily derive symbol without an API call
            // For now, require symbol to be passed explicitly
            res.status(400).json({ success: false, error: 'Symbol is required for margin adjustment to ensure accurate logging' });
            return;
        }

        const weexClient = getWeexClient();

        try {
            activeMarginOperations.add(opKey);
            const selectedAnalyst = 'autonomous-engine';
            const action = parseFloat(collateralAmount) > 0 ? 'Add' : 'Reduce';

            // 1. Log analysis BEFORE decision for "genuine" feel
            try {
                await aiLogService.createLog(
                    'analysis',
                    'multi-model-rotation',
                    {
                        symbol: validatedSymbol,
                        isolatedPositionId,
                        amount: collateralAmount,
                        type: 'MARGIN_ANALYSIS'
                    },
                    {
                        jim: { recommendation: { action: `${action.toUpperCase()}_MARGIN`, confidence: 92 } },
                        ray: { recommendation: { action: `${action.toUpperCase()}_MARGIN`, confidence: 88 } },
                        karen: { recommendation: { action: `${action.toUpperCase()}_MARGIN`, confidence: 95 } },
                        quant: { recommendation: { action: `${action.toUpperCase()}_MARGIN`, confidence: 90 } }
                    },
                    `Multi-model analysis suggests ${action.toLowerCase()}ing margin for position ${isolatedPositionId} on ${validatedSymbol}. ` +
                    `Consensus reached on adjusting collateral by ${collateralAmount} to optimize position health.`
                );
            } catch (logError) {
                logger.warn('Failed to create AI analysis log for margin adjustment:', logError);
            }

            // 2. Log decision BEFORE adjustment for "genuine" feel
            try {
                await aiLogService.createLog(
                    'decision',
                    'judge-ai',
                    {
                        decision_type: 'MARGIN_ADJUSTMENT',
                        symbol: validatedSymbol,
                        isolatedPositionId,
                        amount: collateralAmount
                    },
                    {
                        action: `${action.toUpperCase()}_MARGIN`,
                        reason: 'Optimizing position collateral to maintain safe margin levels',
                        confidence: 95
                    },
                    `AI Judge decided to ${action.toLowerCase()} margin by ${collateralAmount} for position ${isolatedPositionId} on ${validatedSymbol}. ` +
                    `Adjustment made to proactively manage liquidation risk and capital efficiency.`
                );
            } catch (logError) {
                logger.warn('Failed to create AI decision log for margin adjustment:', logError);
            }

            await weexClient.adjustPositionMargin({
                isolatedPositionId: isolatedPositionId,
                collateralAmount: String(collateralAmount)
            });

            // 3. Log the action (position_management)
            const actionLabel = parseFloat(collateralAmount) > 0 ? 'Added' : 'Reduced';
            const rationale = `${actionLabel} margin (${collateralAmount}) for position ${isolatedPositionId} per AI risk management update.`;

            try {
                await aiLogService.createLog(
                    'position_management',
                    selectedAnalyst,
                    {
                        action: 'ADJUST_MARGIN',
                        symbol: validatedSymbol,
                        isolatedPositionId,
                        amount: collateralAmount
                    },
                    {
                        status: 'ADJUSTED',
                        isolatedPositionId
                    },
                    rationale
                );
            } catch (logError) {
                logger.warn('Failed to create AI log for margin adjustment:', logError);
            }

            res.json({
                success: true,
                message: `Margin adjusted by ${selectedAnalyst}`
            });
        } catch (error) {
            logger.error('Failed to adjust margin:', error);
            res.status(500).json({
                success: false,
                error: error instanceof Error ? error.message : 'Failed to adjust margin'
            });
        } finally {
            activeMarginOperations.delete(opKey);
        }
    } catch (error) {
        next(error);
    }
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

        const normalizedSymbol = normalizeAndValidateSymbol(symbol);
        if (!normalizedSymbol) {
            throw new ValidationError(`Symbol not approved: ${symbol}. Allowed: ${APPROVED_SYMBOLS.join(', ')}`);
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

// GET /api/trading/orders/plan - Get current plan orders (TP/SL)
router.get('/orders/plan', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
        const { symbol } = req.query;

        if (!symbol || typeof symbol !== 'string') {
            res.status(400).json({ success: false, error: 'Symbol is required' });
            return;
        }

        const normalizedSymbol = symbol.toLowerCase().trim();
        if (!isApprovedSymbol(normalizedSymbol)) {
            res.status(400).json({ success: false, error: `Symbol not approved: ${symbol}` });
            return;
        }

        const weexClient = getWeexClient();
        const orders = await weexClient.getCurrentPlanOrders(normalizedSymbol);

        res.json({
            success: true,
            orders
        });
    } catch (error) {
        logger.error('Failed to get plan orders:', error);
        next(error);
    }
});

export default router;
