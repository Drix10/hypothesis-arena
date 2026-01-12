import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { config } from './config';
import { apiRouter } from './api/routes';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { getAutonomousTradingEngine } from './services/autonomous/AutonomousTradingEngine';
import { closeDatabasePool, checkDatabaseHealth } from './config/database';
import { logger } from './utils/logger';
import { cleanupTradingRoutes } from './api/routes/trading';

const app = express();
const server = createServer(app);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const path = req.path || req.url?.split('?')[0] || '';
        return path === '/health' || path === '/api/autonomous/events';
    },
    message: { success: false, error: 'Too many requests, please try again later' },
});
app.use('/api', limiter);

app.use(compression());
app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 1000 || res.statusCode >= 400) {
            logger.info(`${req.method} ${req.path} ${res.statusCode} - ${duration}ms`);
        }
    });
    next();
});

app.use(express.static('public'));

app.use('/api', apiRouter);

app.get('/health', async (_req, res) => {
    const dbHealthy = await checkDatabaseHealth();
    res.status(dbHealthy ? 200 : 503).json({
        status: dbHealthy ? 'ok' : 'degraded',
        timestamp: Date.now(),
        services: {
            database: dbHealthy ? 'connected' : 'disconnected',
        },
    });
});

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = config.port;

async function start() {
    try {
        const dbOk = await checkDatabaseHealth();
        if (!dbOk) {
            logger.warn('Database connection failed - some features may not work');
        }

        // Initialize sentiment service (pre-warm cache)
        try {
            const { initializeSentimentService } = await import('./services/sentiment');
            await initializeSentimentService();
        } catch (error) {
            logger.warn('Sentiment service initialization failed (will retry on demand):', error);
        }

        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
            logger.info(`Environment: ${config.nodeEnv}`);
            logger.info(`Database: ${dbOk ? 'connected' : 'disconnected'}`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

let isShuttingDown = false;

const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received. Starting graceful shutdown...`);

    server.close(() => {
        logger.info('HTTP server closed');
    });

    try {
        const engine = getAutonomousTradingEngine();
        await engine.cleanup();
        logger.info('Autonomous trading engine stopped');
    } catch (error) {
        logger.warn('Error stopping autonomous engine:', error);
    }

    try {
        const { resetWeexClient } = await import('./services/weex/WeexClient');
        resetWeexClient();
        logger.info('WeexClient cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up WeexClient:', error);
    }

    // FIXED: Cleanup additional singleton services to prevent memory leaks
    // CLEANUP ORDER: Services are cleaned up in dependency order (leaf services first).
    // All reset functions are SYNCHRONOUS - try-catch handles import failures only.
    try {
        const { resetTechnicalIndicatorService } = await import('./services/indicators/TechnicalIndicatorService');
        resetTechnicalIndicatorService(); // Sync: clears cache and stops prune interval
        logger.info('TechnicalIndicatorService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up TechnicalIndicatorService:', error);
    }

    try {
        const { resetAntiChurnService } = await import('./services/trading/AntiChurnService');
        resetAntiChurnService(); // Sync: clears cooldowns and resets counters
        logger.info('AntiChurnService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up AntiChurnService:', error);
    }

    try {
        const { resetCollaborativeFlow } = await import('./services/ai/CollaborativeFlow');
        resetCollaborativeFlow(); // Sync: clears AI model references
        logger.info('CollaborativeFlow cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up CollaborativeFlow:', error);
    }

    try {
        const { resetContextBuilder } = await import('./services/context/ContextBuilder');
        resetContextBuilder(); // Sync: clears singleton instance
        logger.info('ContextBuilder cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up ContextBuilder:', error);
    }

    try {
        const { shutdownSentimentService } = await import('./services/sentiment');
        shutdownSentimentService(); // Sync: clears cache and stops cleanup timer
        logger.info('SentimentService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up SentimentService:', error);
    }

    try {
        const { shutdownQuantService } = await import('./services/quant');
        shutdownQuantService(); // Sync: clears cache and stops cleanup timer
        logger.info('QuantService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up QuantService:', error);
    }

    try {
        const { modelPoolManager } = await import('./services/ai/ModelPoolManager');
        modelPoolManager.shutdown(); // Sync: clears failure counts and stops reset timer
        logger.info('ModelPoolManager cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up ModelPoolManager:', error);
    }

    try {
        const { shutdownRedditService } = await import('./services/sentiment');
        shutdownRedditService(); // Sync: clears cache and stops cleanup timer
        logger.info('RedditSentimentService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up RedditSentimentService:', error);
    }

    try {
        const { shutdownJournalService } = await import('./services/journal');
        shutdownJournalService(); // Sync: clears in-memory journal
        logger.info('JournalService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up JournalService:', error);
    }

    try {
        const { shutdownPositionSyncService } = await import('./services/position');
        shutdownPositionSyncService(); // Sync: clears tracked trades
        logger.info('PositionSyncService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up PositionSyncService:', error);
    }

    try {
        const { shutdownRegimeDetector } = await import('./services/quant');
        shutdownRegimeDetector(); // Sync: clears regime history and stops cleanup timer
        logger.info('RegimeDetector cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up RegimeDetector:', error);
    }

    try {
        const { aiLogService } = await import('./services/compliance/AILogService');
        aiLogService.cleanup(); // Sync: clears failed uploads tracking and retry state
        logger.info('AILogService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up AILogService:', error);
    }

    try {
        const { aiService } = await import('./services/ai/AIService');
        aiService.cleanup(); // Sync: clears Gemini model references
        logger.info('AIService cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up AIService:', error);
    }

    try {
        cleanupTradingRoutes(); // Sync: clears route-level state
        logger.info('Trading routes cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up trading routes:', error);
    }

    try {
        const { stopDatabaseHealthCheck } = await import('./config/database');
        stopDatabaseHealthCheck();
        logger.info('Database health check stopped');
    } catch (error) {
        logger.warn('Error stopping database health check:', error);
    }

    await closeDatabasePool();

    logger.info('Graceful shutdown complete');
    process.exit(0);
};

const forceExit = () => {
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000).unref();
};

process.on('SIGTERM', () => { forceExit(); shutdown('SIGTERM'); });
process.on('SIGINT', () => { forceExit(); shutdown('SIGINT'); });

process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception:', err);
    shutdown('uncaughtException');
});

let rejectionCount = 0;
let rejectionWindowStart = Date.now();
const REJECTION_THRESHOLD = 5;
const REJECTION_WINDOW_MS = 60000;
const REJECTION_DECAY_INTERVAL_MS = 30000;

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);

    const now = Date.now();

    if (now - rejectionWindowStart >= REJECTION_WINDOW_MS) {
        rejectionCount = 0;
        rejectionWindowStart = now;
    }

    const elapsedSinceWindowStart = now - rejectionWindowStart;
    const decayAmount = Math.floor(elapsedSinceWindowStart / REJECTION_DECAY_INTERVAL_MS);
    if (decayAmount > 0) {
        rejectionCount = Math.max(0, rejectionCount - decayAmount);
        rejectionWindowStart = now - (elapsedSinceWindowStart % REJECTION_DECAY_INTERVAL_MS);
    }

    rejectionCount++;

    logger.warn(`Unhandled rejection count: ${rejectionCount}/${REJECTION_THRESHOLD} in current window`);

    if (rejectionCount >= REJECTION_THRESHOLD) {
        logger.error(`CRITICAL: ${REJECTION_THRESHOLD} unhandled rejections in ${REJECTION_WINDOW_MS}ms - triggering shutdown`);
        shutdown('unhandledRejection');
    }
});

start();

export { app, server };
