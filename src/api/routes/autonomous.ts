/**
 * Autonomous Trading Engine API Routes
 * Control the 24/7 AI trading system
 */

import { Router, Request, Response } from 'express';
import { getAutonomousTradingEngine } from '../../services/autonomous/AutonomousTradingEngine';
import { logger } from '../../utils/logger';
import { prisma } from '../../config/database';

const router = Router();
const engine = getAutonomousTradingEngine();

// FIXED: Extract magic numbers to named constants for better maintainability
const MAX_HISTORY_LIMIT = 50; // Maximum trades to return
const DEFAULT_HISTORY_LIMIT = 10; // Default trades to return

/**
 * GET /api/autonomous/status
 * Get current engine status
 */
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
 * Note: The engine runs on a loop, so this just signals intent.
 * The actual cycle will run on the next iteration.
 */
router.post('/trigger', async (_req: Request, res: Response) => {
    try {
        const status = engine.getStatus();
        if (!status.isRunning) {
            res.status(400).json({ success: false, error: 'Engine is not running. Start the engine first.' });
            return;
        }
        // The engine runs on a loop - we can't directly trigger a cycle
        // But we can acknowledge the request
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
        // FIXED: Validate and sanitize limit parameter with NaN check
        const rawLimit = req.query.limit as string;
        let limit = DEFAULT_HISTORY_LIMIT; // Use named constant instead of magic number

        if (rawLimit) {
            const parsedLimit = parseInt(rawLimit, 10);
            // FIXED: Add Number.isFinite check to prevent NaN values
            if (!Number.isFinite(parsedLimit) || parsedLimit < 1) {
                res.status(400).json({ success: false, error: 'Invalid limit parameter. Must be a positive integer.' });
                return;
            }
            limit = Math.min(parsedLimit, MAX_HISTORY_LIMIT); // Cap at configured max
        }

        // Use Prisma to fetch trade history
        const trades = await prisma.trade.findMany({
            where: {
                executedAt: { not: null } // CRITICAL: Filter out trades without execution time
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

export default router;
