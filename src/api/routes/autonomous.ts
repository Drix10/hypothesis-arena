/**
 * Autonomous Trading Engine API Routes
 * Control the 24/7 AI trading system
 */

import { Router, Request, Response } from 'express';
import { getAutonomousTradingEngine } from '../../services/autonomous/AutonomousTradingEngine';
import { logger } from '../../utils/logger';

const router = Router();
const engine = getAutonomousTradingEngine();

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
        await engine.start('system');
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
 * Get recent trading history
 */
router.get('/history', async (_req: Request, res: Response) => {
    try {
        // Return empty for now - can be implemented with DB query
        res.json({ success: true, data: [] });
    } catch (error: any) {
        logger.error('Failed to get history:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/autonomous/events
 * Server-Sent Events stream for real-time updates
 */
router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Track if connection is still open
    let isConnected = true;

    // Send initial status
    try {
        const status = engine.getStatus();
        res.write(`data: ${JSON.stringify({ type: 'status', data: status })}\n\n`);
    } catch (error) {
        logger.error('Failed to get initial status for SSE:', error);
    }

    // Keep-alive ping every 30 seconds
    const keepAlive = setInterval(() => {
        if (!isConnected) {
            clearInterval(keepAlive);
            return;
        }
        try {
            res.write(`: keepalive\n\n`);
        } catch {
            isConnected = false;
            clearInterval(keepAlive);
        }
    }, 30000);

    // Listen to engine events with connection check
    const onCycleStart = (cycleNumber: number) => {
        if (!isConnected) return;
        try { res.write(`data: ${JSON.stringify({ type: 'cycleStart', cycleNumber })}\n\n`); }
        catch { isConnected = false; }
    };

    const onCycleComplete = (cycle: any) => {
        if (!isConnected) return;
        try { res.write(`data: ${JSON.stringify({ type: 'cycleComplete', data: cycle })}\n\n`); }
        catch { isConnected = false; }
    };

    const onTradeExecuted = (trade: any) => {
        if (!isConnected) return;
        try { res.write(`data: ${JSON.stringify({ type: 'tradeExecuted', data: trade })}\n\n`); }
        catch { isConnected = false; }
    };

    engine.on('cycleStart', onCycleStart);
    engine.on('cycleComplete', onCycleComplete);
    engine.on('tradeExecuted', onTradeExecuted);

    const cleanup = () => {
        isConnected = false;
        clearInterval(keepAlive);
        engine.off('cycleStart', onCycleStart);
        engine.off('cycleComplete', onCycleComplete);
        engine.off('tradeExecuted', onTradeExecuted);
    };

    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
});

export default router;
