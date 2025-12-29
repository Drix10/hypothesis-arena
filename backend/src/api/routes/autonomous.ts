/**
 * Autonomous Trading Engine API Routes
 * 
 * Control the 24/7 AI trading system
 * 
 * IMPORTANT: This is a singleton engine that manages all AI analysts.
 * In a multi-user system, each user would need their own engine instance
 * or the engine would need to be refactored to support multi-tenancy.
 * 
 * Current implementation: Single engine for all users (suitable for hackathon/demo)
 */

import { Router, Request, Response } from 'express';
import { authenticate, authenticateSSE, generateSSEToken } from '../middleware/auth';
import { getAutonomousTradingEngine } from '../../services/autonomous/AutonomousTradingEngine';
import { logger } from '../../utils/logger';
import { JWTPayload } from '../../shared/types/auth';

const router = Router();
const engine = getAutonomousTradingEngine();

/**
 * Helper to safely extract userId from authenticated request
 * Throws if userId is missing (should never happen after authenticate middleware)
 */
function getUserId(req: Request): string {
    const userId = req.userId || (req.user as JWTPayload | undefined)?.userId;
    if (!userId) {
        throw new Error('User ID not found in authenticated request');
    }
    return userId;
}

/**
 * POST /api/autonomous/sse-token
 * Generate a short-lived, single-use token for SSE connections
 * Requires authentication
 * 
 * This endpoint allows clients to obtain a temporary token that can be
 * safely passed in the URL for EventSource connections, avoiding exposure
 * of long-lived auth tokens in URLs, logs, and referrer headers.
 */
router.post('/sse-token', authenticate, (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const sseToken = generateSSEToken(userId);

        res.json({
            success: true,
            sseToken,
            expiresIn: 60, // seconds
        });
    } catch (error: any) {
        logger.error('Failed to generate SSE token:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/autonomous/status
 * Get current engine status
 * Requires authentication to protect sensitive trading data
 */
router.get('/status', authenticate, (_req, res) => {
    try {
        const status = engine.getStatus();
        res.json({
            success: true,
            data: status,
        });
    } catch (error: any) {
        logger.error('Failed to get engine status:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/autonomous/start
 * Start the autonomous trading engine
 * Requires authentication
 */
router.post('/start', authenticate, async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        await engine.start(userId);

        res.json({
            success: true,
            message: 'Autonomous trading engine started',
        });
    } catch (error: any) {
        logger.error('Failed to start engine:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /api/autonomous/stop
 * Stop the autonomous trading engine
 * Requires authentication
 * 
 * NOTE: Since this is a singleton engine, stopping it affects all users.
 * In production, add admin role check or per-user engine instances.
 */
router.post('/stop', authenticate, (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        // Log who stopped the engine for audit trail
        logger.warn(`Engine stop requested by user: ${userId}`);

        engine.stop();

        res.json({
            success: true,
            message: 'Autonomous trading engine stopped',
        });
    } catch (error: any) {
        logger.error('Failed to stop engine:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/autonomous/analysts
 * Get all analyst states
 * Requires authentication to protect analyst data
 */
router.get('/analysts', authenticate, (_req, res) => {
    try {
        const status = engine.getStatus();
        res.json({
            success: true,
            data: status.analysts,
        });
    } catch (error: any) {
        logger.error('Failed to get analysts:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /api/autonomous/events
 * Server-Sent Events stream for real-time updates
 * Requires authentication to protect real-time trading data
 * 
 * SECURITY: Uses authenticateSSE middleware which accepts token
 * from query parameter since EventSource API doesn't support custom headers.
 * Token is removed from query after validation to prevent logging.
 * 
 * SECURITY MITIGATIONS for query parameter auth:
 * 1. Short-lived tokens recommended (reduce window of exposure)
 * 2. HTTPS required in production (prevents interception)
 * 3. Token removed from req.query after validation
 * 4. Consider implementing token rotation for long-lived SSE connections
 * 5. Rate limit connection attempts per user
 */
router.get('/events', authenticateSSE, (req, res) => {
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

    // Send initial status
    try {
        const status = engine.getStatus();
        res.write(`data: ${JSON.stringify({ type: 'status', data: status })}\n\n`);
    } catch (error) {
        logger.error('Failed to get initial status for SSE:', error);
    }

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
        try {
            res.write(`: keepalive\n\n`);
        } catch {
            // Connection closed
            clearInterval(keepAlive);
        }
    }, 30000);

    // Listen to engine events
    const onCycleStart = (cycleNumber: number) => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'cycleStart', cycleNumber })}\n\n`);
        } catch {
            // Connection closed
        }
    };

    const onCycleComplete = (cycle: any) => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'cycleComplete', data: cycle })}\n\n`);
        } catch {
            // Connection closed
        }
    };

    const onTradeExecuted = (trade: any) => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'tradeExecuted', data: trade })}\n\n`);
        } catch {
            // Connection closed
        }
    };

    const onDebatesComplete = (debates: any) => {
        try {
            res.write(`data: ${JSON.stringify({ type: 'debatesComplete', data: debates })}\n\n`);
        } catch {
            // Connection closed
        }
    };

    engine.on('cycleStart', onCycleStart);
    engine.on('cycleComplete', onCycleComplete);
    engine.on('tradeExecuted', onTradeExecuted);
    engine.on('debatesComplete', onDebatesComplete);

    // Cleanup on disconnect
    const cleanup = () => {
        clearInterval(keepAlive);
        engine.off('cycleStart', onCycleStart);
        engine.off('cycleComplete', onCycleComplete);
        engine.off('tradeExecuted', onTradeExecuted);
        engine.off('debatesComplete', onDebatesComplete);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
});

export default router;
