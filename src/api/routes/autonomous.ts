/**
 * Autonomous Trading Engine API Routes
 * Control the 24/7 AI trading system
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getAutonomousTradingEngine } from '../../services/autonomous/AutonomousTradingEngine';
import { logger } from '../../utils/logger';
import { prisma } from '../../config/database';

import { getJournalEntry, getRecentEntries, clearJournal } from '../../services/journal';
import { getTrackedTrade, getAllTrackedTrades, clearTrackedTrades } from '../../services/position';
import { clearSentimentCache, formatSentimentForPrompt, getSentimentContextSafe } from '../../services/sentiment';
import { formatRedditForPrompt, getRedditSentimentContext } from '../../services/sentiment';
import {
    clearQuantCache,
    clearFundingHistory,
    clearRegimeHistory,
    formatRegimeForPrompt,
    formatMonteCarloForPrompt,
    formatAnalysisForPrompt,
    analyzeWithMonteCarlo,
    runMonteCarloSimulation,
    getQuantContext
} from '../../services/quant';

const router = Router();
const engine = getAutonomousTradingEngine();

// =============================================================================
// ADMIN/DEBUG MIDDLEWARE (v5.3.0) - Shared access control
// =============================================================================

// Feature flag check for admin endpoints
const isAdminEnabled = (): boolean => {
    return process.env.AUTONOMOUS_ADMIN_ENABLED === 'true';
};

// Internal-only guard middleware
// In production, ALWAYS requires valid admin token for security
// In development, allows localhost/internal network access without token
const requireInternalAccess = (req: Request, res: Response, next: NextFunction): void => {
    // Check if admin endpoints are enabled
    if (!isAdminEnabled()) {
        logger.warn('Admin endpoint access attempted but AUTONOMOUS_ADMIN_ENABLED is not true');
        res.status(403).json({
            success: false,
            error: 'Admin endpoints are disabled. Set AUTONOMOUS_ADMIN_ENABLED=true to enable.'
        });
        return;
    }

    // Check for admin token (required in production, optional in development)
    const adminToken = process.env.AUTONOMOUS_ADMIN_TOKEN;
    if (adminToken && adminToken.length >= 32) {
        const providedToken = req.headers['x-admin-token'];
        // SECURITY: Use constant-time comparison via SHA-256 hash to prevent timing attacks
        // Hashing normalizes length and prevents length-based information leakage
        if (typeof providedToken === 'string' && providedToken.length > 0) {
            const providedHash = crypto.createHash('sha256').update(providedToken).digest();
            const expectedHash = crypto.createHash('sha256').update(adminToken).digest();
            if (crypto.timingSafeEqual(providedHash, expectedHash)) {
                // Valid admin token - allow access regardless of IP
                next();
                return;
            }
        }
    }

    // SECURITY: In production, ALWAYS require valid admin token
    // RFC1918 IP trust is removed for production - internal networks can still be compromised
    if (process.env.NODE_ENV === 'production') {
        // SECURITY: Prefer socket.remoteAddress over req.ip to avoid X-Forwarded-For spoofing
        let clientIp = req.socket?.remoteAddress || req.ip || '';
        if (clientIp.startsWith('::ffff:')) {
            clientIp = clientIp.slice(7);
        }

        const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1';

        // In production, only localhost is allowed without token
        // All other access (including RFC1918 internal IPs) requires valid admin token
        if (!isLocalhost) {
            logger.warn(`Admin endpoint access denied in production - valid admin token required. IP: ${clientIp}`);
            res.status(403).json({
                success: false,
                error: 'Admin endpoints require valid admin token in production. Set AUTONOMOUS_ADMIN_TOKEN and provide x-admin-token header.'
            });
            return;
        }
    }

    next();
};

const MAX_HISTORY_LIMIT = 50;
const DEFAULT_HISTORY_LIMIT = 10;

router.get('/status', (_req, res) => {
    try {
        const status = engine.getStatus();
        res.json({ success: true, data: status });
    } catch (error: any) {
        logger.error('Failed to get engine status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/events
 * SSE stream for engine events
 * Protected: Internal/Admin access only
 */
router.get('/events', requireInternalAccess, (req: Request, res: Response) => {
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable proxy buffering

    // Send initial heartbeat/connection confirmation
    if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`);
    }

    // Event handlers
    const onStarted = () => {
        if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'started', timestamp: Date.now() })}\n\n`);
            } catch (err) {
                logger.error('SSE onStarted write error:', err);
            }
        }
    };

    const onStopped = () => {
        if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'stopped', timestamp: Date.now() })}\n\n`);
            } catch (err) {
                logger.error('SSE onStopped write error:', err);
            }
        }
    };

    const onCycleStart = (data: any) => {
        if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'cycleStart', data, timestamp: Date.now() })}\n\n`);
            } catch (err) {
                logger.error('SSE onCycleStart write error:', err);
            }
        }
    };

    const onCycleComplete = (data: any) => {
        if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'cycleComplete', data, timestamp: Date.now() })}\n\n`);
            } catch (err) {
                logger.error('SSE onCycleComplete write error:', err);
            }
        }
    };

    const onSnapshotFailure = (data: any) => {
        if (!res.writableEnded) {
            try {
                res.write(`data: ${JSON.stringify({ type: 'snapshotFailure', data, timestamp: Date.now() })}\n\n`);
            } catch (err) {
                logger.error('SSE onSnapshotFailure write error:', err);
            }
        }
    };

    // Subscribe to engine events
    engine.on('started', onStarted);
    engine.on('stopped', onStopped);
    engine.on('cycleStart', onCycleStart);
    engine.on('cycleComplete', onCycleComplete);
    engine.on('snapshotFailure', onSnapshotFailure);

    // Keep-alive heartbeat every 30s to prevent connection timeout
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) {
            res.write(`: heartbeat\n\n`);
        }
    }, 30000);

    // Cleanup on client disconnection
    req.on('close', () => {
        clearInterval(heartbeat);
        engine.removeListener('started', onStarted);
        engine.removeListener('stopped', onStopped);
        engine.removeListener('cycleStart', onCycleStart);
        engine.removeListener('cycleComplete', onCycleComplete);
        engine.removeListener('snapshotFailure', onSnapshotFailure);
        logger.debug('SSE client disconnected from autonomous events');
    });
});

/**
 * POST /api/autonomous/start
 * Start the autonomous trading engine
 */
router.post('/start', async (_req: Request, res: Response) => {
    try {
        await engine.start();
        res.json({ success: true, message: 'Autonomous trading engine started' });
    } catch (error: any) {
        logger.error('Failed to start engine:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/autonomous/stop
 * Stop the autonomous trading engine
 */
router.post('/stop', (_req: Request, res: Response) => {
    try {
        engine.stop();
        res.json({ success: true, message: 'Autonomous trading engine stopped' });
    } catch (error: any) {
        logger.error('Failed to stop engine:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/autonomous/trigger
 * Trigger a manual trading cycle
 */
router.post('/trigger', async (_req: Request, res: Response) => {
    try {
        const status = engine.getStatus();
        if (!status.isRunning) {
            res.status(400).json({ success: false, error: 'Engine is not running. Start the engine first.' });
            return;
        }
        res.json({
            success: true,
            message: 'Engine is running. Next cycle will execute based on configured interval.',
            nextCycleIn: status.nextCycleIn || 'unknown'
        });
    } catch (error: any) {
        logger.error('Failed to get trigger status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});


/**
 * GET /api/autonomous/analysts
 * Get all analyst states
 */
router.get('/analysts', (_req, res) => {
    try {
        const status = engine.getStatus();
        res.json({ success: true, data: status.analysts });
    } catch (error: any) {
        logger.error('Failed to get analysts:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/history
 * Get recent trading history from database
 */
router.get('/history', async (req: Request, res: Response) => {
    try {
        const rawLimit = req.query.limit as string;
        let limit = DEFAULT_HISTORY_LIMIT;

        if (rawLimit) {
            const parsedLimit = parseInt(rawLimit, 10);
            if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
                res.status(400).json({ success: false, error: 'Invalid limit parameter. Must be a positive integer.' });
                return;
            }
            limit = Math.min(parsedLimit, MAX_HISTORY_LIMIT);
        }

        const trades = await prisma.trade.findMany({
            where: {
                executedAt: { not: null }
            },
            orderBy: { executedAt: 'desc' },
            take: limit,
            select: {
                id: true,
                symbol: true,
                side: true,
                type: true,
                size: true,
                price: true,
                status: true,
                reason: true,
                confidence: true,
                executedAt: true,
                weexOrderId: true
            }
        });

        const formattedTrades = trades.map(trade => {
            // FIXED: Add explicit type guard for executedAt even though Prisma filter ensures non-null
            // TypeScript doesn't infer non-null from Prisma filter, so we need explicit check
            if (!trade.executedAt) {
                // This should never happen due to Prisma filter, but TypeScript requires the check
                logger.warn(`Trade ${trade.id} has null executedAt despite filter - skipping`);
                return null;
            }

            return {
                id: trade.id,
                symbol: trade.symbol,
                action: `${trade.side} ${trade.type}`, // Human-readable action
                side: trade.side, // Trade side (BUY/SELL)
                type: trade.type, // Order type (MARKET/LIMIT)
                size: trade.size,
                price: trade.price,
                status: trade.status,
                result: trade.status === 'FILLED' ? 'Executed' : trade.status,
                reason: trade.reason,
                confidence: trade.confidence,
                timestamp: trade.executedAt, // Safe now with explicit type guard
                orderId: trade.weexOrderId
            };
        }).filter((trade): trade is NonNullable<typeof trade> => trade !== null);

        // FIXED: Validate that we have valid trades after filtering
        // If all trades were filtered out (shouldn't happen), log a warning
        if (trades.length > 0 && formattedTrades.length === 0) {
            logger.warn(`All ${trades.length} trades were filtered out due to null executedAt - data integrity issue`);
        }

        res.json({ success: true, data: formattedTrades });
    } catch (error: any) {
        logger.error('Failed to get history:', error);
        // Return error with success: false to properly indicate failure
        res.status(500).json({ success: false, error: 'Failed to retrieve trade history', data: [] });
    }
});

// =============================================================================
// DEBUG ENDPOINTS (v5.2.0) - For runtime inspection and debugging
// Protected by requireInternalAccess middleware
// =============================================================================

/**
 * GET /api/autonomous/debug/journal/:tradeId
 * Get a specific trade journal entry by trade ID
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/journal/:tradeId', requireInternalAccess, (req: Request, res: Response) => {
    try {
        const { tradeId } = req.params;
        if (!tradeId) {
            res.status(400).json({ success: false, error: 'tradeId is required' });
            return;
        }

        const entry = getJournalEntry(tradeId);
        if (!entry) {
            res.status(404).json({ success: false, error: 'Journal entry not found' });
            return;
        }

        res.json({ success: true, data: entry });
    } catch (error: any) {
        logger.error('Failed to get journal entry:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/debug/journal
 * Get recent trade journal entries
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/journal', requireInternalAccess, (req: Request, res: Response) => {
    try {
        const rawLimit = req.query.limit as string;
        let limit = 20; // Default

        if (rawLimit) {
            const parsedLimit = parseInt(rawLimit, 10);
            // Validate parsed limit is a finite positive number
            if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
                limit = Math.min(parsedLimit, 100); // Cap at 100
            }
            // If invalid, silently use default (don't error for optional param)
        }

        const entries = getRecentEntries(limit);
        res.json({ success: true, data: entries, count: entries.length });
    } catch (error: any) {
        logger.error('Failed to get journal entries:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/debug/tracked-trades
 * Get all currently tracked trades (for position sync)
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/tracked-trades', requireInternalAccess, (_req: Request, res: Response) => {
    try {
        const trades = getAllTrackedTrades();
        res.json({ success: true, data: trades, count: trades.length });
    } catch (error: any) {
        logger.error('Failed to get tracked trades:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/debug/tracked-trades/:tradeId
 * Get a specific tracked trade by trade ID
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/tracked-trades/:tradeId', requireInternalAccess, (req: Request, res: Response) => {
    try {
        const { tradeId } = req.params;
        if (!tradeId) {
            res.status(400).json({ success: false, error: 'tradeId is required' });
            return;
        }

        const trade = getTrackedTrade(tradeId);
        if (!trade) {
            res.status(404).json({ success: false, error: 'Tracked trade not found' });
            return;
        }

        res.json({ success: true, data: trade });
    } catch (error: any) {
        logger.error('Failed to get tracked trade:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// ADMIN ENDPOINTS (v5.2.0) - For cache management and maintenance
// Protected by requireInternalAccess middleware (defined above)
// =============================================================================

/**
 * POST /api/autonomous/admin/clear-caches
 * Clear all service caches (sentiment, quant)
 * Use when external data sources have issues or to force fresh data
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.post('/admin/clear-caches', requireInternalAccess, (_req: Request, res: Response) => {
    try {
        clearSentimentCache();
        clearQuantCache();
        clearFundingHistory();  // v5.3.0: Also clear funding history
        clearRegimeHistory();   // v5.3.0: Also clear regime history

        logger.info('All service caches cleared via admin endpoint');
        res.json({
            success: true,
            message: 'All caches cleared',
            cleared: ['sentiment', 'quant', 'fundingHistory', 'regimeHistory']
        });
    } catch (error: any) {
        logger.error('Failed to clear caches:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/autonomous/admin/clear-journal
 * Clear trade journal (for testing only - use with caution)
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.post('/admin/clear-journal', requireInternalAccess, (_req: Request, res: Response) => {
    try {
        clearJournal();
        logger.warn('Trade journal cleared via admin endpoint');
        res.json({ success: true, message: 'Trade journal cleared' });
    } catch (error: any) {
        logger.error('Failed to clear journal:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/autonomous/admin/clear-tracked-trades
 * Clear tracked trades (for testing only - use with caution)
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.post('/admin/clear-tracked-trades', requireInternalAccess, (_req: Request, res: Response) => {
    try {
        clearTrackedTrades();
        logger.warn('Tracked trades cleared via admin endpoint');
        res.json({ success: true, message: 'Tracked trades cleared' });
    } catch (error: any) {
        logger.error('Failed to clear tracked trades:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// ANALYSIS ENDPOINTS (v5.3.0) - For runtime analysis and Monte Carlo
// =============================================================================

/**
 * GET /api/autonomous/debug/regime/:symbol
 * Get current market regime for a symbol
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/regime/:symbol', requireInternalAccess, async (req: Request, res: Response) => {
    try {
        const { symbol } = req.params;
        if (!symbol) {
            res.status(400).json({ success: false, error: 'symbol is required' });
            return;
        }

        // Validate symbol format (alphanumeric with underscores only, max 20 chars)
        const symbolRegex = /^[a-zA-Z0-9_]{1,20}$/;
        if (!symbolRegex.test(symbol)) {
            res.status(400).json({ success: false, error: 'Invalid symbol format' });
            return;
        }

        // Get quant context which includes regime data in regimeAnalysis Map
        const quantContext = await getQuantContext([symbol]);
        if (!quantContext || !quantContext.regimeAnalysis) {
            res.status(404).json({ success: false, error: 'Regime data not available' });
            return;
        }

        // Get regime for the specific symbol
        const regime = quantContext.regimeAnalysis.get(symbol);
        if (!regime) {
            res.status(404).json({ success: false, error: `Regime data not available for ${symbol}` });
            return;
        }

        const formatted = formatRegimeForPrompt(regime);
        res.json({
            success: true,
            data: {
                symbol,
                regime,
                formatted
            }
        });
    } catch (error: any) {
        logger.error('Failed to get regime:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/debug/sentiment
 * Get current sentiment context with formatted output
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/sentiment', requireInternalAccess, async (_req: Request, res: Response) => {
    try {
        const sentimentContext = await getSentimentContextSafe();
        if (!sentimentContext) {
            res.status(404).json({ success: false, error: 'Sentiment data not available' });
            return;
        }

        const formatted = formatSentimentForPrompt(sentimentContext);
        res.json({
            success: true,
            data: {
                sentiment: sentimentContext,
                formatted
            }
        });
    } catch (error: any) {
        logger.error('Failed to get sentiment:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/debug/reddit-sentiment
 * Get Reddit sentiment context with formatted output
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.get('/debug/reddit-sentiment', requireInternalAccess, async (_req: Request, res: Response) => {
    try {
        const redditContext = await getRedditSentimentContext();

        // Check for null/undefined redditContext (same pattern as /debug/sentiment)
        if (!redditContext) {
            res.status(404).json({ success: false, error: 'Reddit sentiment data not available' });
            return;
        }

        const formatted = formatRedditForPrompt(redditContext);
        res.json({
            success: true,
            data: {
                reddit: redditContext,
                formatted
            }
        });
    } catch (error: any) {
        logger.error('Failed to get Reddit sentiment:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/autonomous/debug/monte-carlo
 * Run Monte Carlo analysis for both long and short scenarios
 * Body: { volatility, stopLossPercent, takeProfitPercent, drift?, simulations?, timeHorizon? }
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.post('/debug/monte-carlo', requireInternalAccess, (req: Request, res: Response) => {
    try {
        const { volatility, stopLossPercent, takeProfitPercent, drift, simulations, timeHorizon } = req.body;

        // Validate required parameters
        if (volatility == null || stopLossPercent == null || takeProfitPercent == null) {
            res.status(400).json({
                success: false,
                error: 'Required: volatility, stopLossPercent, takeProfitPercent. Optional: drift, simulations, timeHorizon'
            });
            return;
        }

        // Parse and validate numeric values
        const parsedVolatility = parseFloat(volatility);
        const parsedStopLoss = parseFloat(stopLossPercent);
        const parsedTakeProfit = parseFloat(takeProfitPercent);
        const parsedDrift = drift != null ? parseFloat(drift) : 0;
        const parsedSimulations = simulations ? parseInt(simulations, 10) : 500;
        const parsedTimeHorizon = timeHorizon ? parseInt(timeHorizon, 10) : 24;

        // Validate parsed values are finite numbers with reasonable bounds
        if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0 || parsedVolatility > 100) {
            res.status(400).json({ success: false, error: 'volatility must be between 0 and 100 (percent)' });
            return;
        }
        if (!Number.isFinite(parsedStopLoss) || parsedStopLoss <= 0 || parsedStopLoss > 50) {
            res.status(400).json({ success: false, error: 'stopLossPercent must be between 0 and 50' });
            return;
        }
        if (!Number.isFinite(parsedTakeProfit) || parsedTakeProfit <= 0 || parsedTakeProfit > 100) {
            res.status(400).json({ success: false, error: 'takeProfitPercent must be between 0 and 100' });
            return;
        }
        if (!Number.isFinite(parsedDrift) || Math.abs(parsedDrift) > 10) {
            res.status(400).json({ success: false, error: 'drift must be between -10 and 10' });
            return;
        }
        if (!Number.isFinite(parsedSimulations) || parsedSimulations < 100 || parsedSimulations > 1000) {
            res.status(400).json({ success: false, error: 'simulations must be between 100 and 1000' });
            return;
        }
        if (!Number.isFinite(parsedTimeHorizon) || parsedTimeHorizon < 1 || parsedTimeHorizon > 48) {
            res.status(400).json({ success: false, error: 'timeHorizon must be between 1 and 48 hours' });
            return;
        }

        // Run full analysis (both long and short scenarios)
        const analysis = analyzeWithMonteCarlo(
            parsedVolatility,
            parsedStopLoss,
            parsedTakeProfit,
            parsedDrift,
            parsedSimulations,
            parsedTimeHorizon
        );

        const formatted = formatAnalysisForPrompt(analysis);
        // Get compact format for the recommended direction
        const recommendedResult = analysis.recommendedDirection === 'long'
            ? analysis.longScenario
            : analysis.recommendedDirection === 'short'
                ? analysis.shortScenario
                : analysis.longScenario;
        const compactFormatted = formatMonteCarloForPrompt(recommendedResult);

        res.json({
            success: true,
            data: {
                analysis,
                formatted,
                compactFormatted
            }
        });
    } catch (error: any) {
        logger.error('Failed to run Monte Carlo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/autonomous/debug/monte-carlo/raw
 * Run raw Monte Carlo simulation for a single direction
 * Body: { volatility, stopLossPercent, takeProfitPercent, direction, drift?, simulations?, timeHorizon? }
 * 
 * Protected: Requires AUTONOMOUS_ADMIN_ENABLED=true
 */
router.post('/debug/monte-carlo/raw', requireInternalAccess, (req: Request, res: Response) => {
    try {
        const { volatility, stopLossPercent, takeProfitPercent, direction, drift, simulations, timeHorizon } = req.body;

        // Validate required parameters
        if (volatility == null || stopLossPercent == null || takeProfitPercent == null || !direction) {
            res.status(400).json({
                success: false,
                error: 'Required: volatility, stopLossPercent, takeProfitPercent, direction (long/short)'
            });
            return;
        }

        // Validate direction
        if (direction !== 'long' && direction !== 'short') {
            res.status(400).json({ success: false, error: 'direction must be "long" or "short"' });
            return;
        }

        // Parse and validate numeric values
        const parsedVolatility = parseFloat(volatility);
        const parsedStopLoss = parseFloat(stopLossPercent);
        const parsedTakeProfit = parseFloat(takeProfitPercent);
        const parsedDrift = drift != null ? parseFloat(drift) : 0;
        const parsedSimulations = simulations ? parseInt(simulations, 10) : 500;
        const parsedTimeHorizon = timeHorizon ? parseInt(timeHorizon, 10) : 24;

        // Validate parsed values are finite numbers with reasonable bounds
        if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0 || parsedVolatility > 100) {
            res.status(400).json({ success: false, error: 'volatility must be between 0 and 100 (percent)' });
            return;
        }
        if (!Number.isFinite(parsedStopLoss) || parsedStopLoss <= 0 || parsedStopLoss > 50) {
            res.status(400).json({ success: false, error: 'stopLossPercent must be between 0 and 50' });
            return;
        }
        if (!Number.isFinite(parsedTakeProfit) || parsedTakeProfit <= 0 || parsedTakeProfit > 100) {
            res.status(400).json({ success: false, error: 'takeProfitPercent must be between 0 and 100' });
            return;
        }
        if (!Number.isFinite(parsedDrift) || Math.abs(parsedDrift) > 10) {
            res.status(400).json({ success: false, error: 'drift must be between -10 and 10' });
            return;
        }
        if (!Number.isFinite(parsedSimulations) || parsedSimulations < 100 || parsedSimulations > 1000) {
            res.status(400).json({ success: false, error: 'simulations must be between 100 and 1000' });
            return;
        }
        if (!Number.isFinite(parsedTimeHorizon) || parsedTimeHorizon < 1 || parsedTimeHorizon > 48) {
            res.status(400).json({ success: false, error: 'timeHorizon must be between 1 and 48 hours' });
            return;
        }

        // Run raw simulation for single direction
        const result = runMonteCarloSimulation({
            volatility: parsedVolatility,
            stopLossPercent: parsedStopLoss,
            takeProfitPercent: parsedTakeProfit,
            direction,
            drift: parsedDrift,
            simulations: parsedSimulations,
            timeHorizon: parsedTimeHorizon
        });

        const formatted = formatMonteCarloForPrompt(result);

        res.json({
            success: true,
            data: {
                result,
                formatted
            }
        });
    } catch (error: any) {
        logger.error('Failed to run raw Monte Carlo:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
