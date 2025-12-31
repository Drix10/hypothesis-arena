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

// Security - Configure CSP to allow necessary inline scripts while maintaining security
// FIXED: Use specific CSP directives instead of disabling entirely
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // Required for inline event handlers
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
        },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
}));

// Rate limiting - generous limits for dashboard polling
// WEEX rate limits: 1000 requests per 10 seconds for public, 10/second for orders
// Our dashboard polls every 20-30 seconds, so we need ~300 requests per 15 minutes
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // 500 requests per 15 minutes (plenty for dashboard)
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        // Skip rate limiting for health checks and SSE endpoints
        const path = req.path || req.url?.split('?')[0] || '';
        return path === '/health' || path === '/api/autonomous/events';
    },
    message: { success: false, error: 'Too many requests, please try again later' },
});
app.use('/api', limiter);

// Performance
app.use(compression());
app.use(cors({
    origin: config.corsOrigins,
    credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Request logging
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


// Serve static files (frontend)
app.use(express.static('public'));

// API Routes
app.use('/api', apiRouter);

// Health check
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

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// Start server
const PORT = config.port;

async function start() {
    try {
        const dbOk = await checkDatabaseHealth();
        if (!dbOk) {
            logger.warn('Database connection failed - some features may not work');
        }

        server.listen(PORT, () => {
            logger.info(`Server running on port ${PORT}`);
            logger.info(`Environment: ${config.nodeEnv}`);
            logger.info(`Database: ${dbOk ? 'connected' : 'disconnected'}`);
            logger.info(`Frontend: http://localhost:${PORT}`);
        });
    } catch (error) {
        logger.error('Failed to start server:', error);
        process.exit(1);
    }
}

// Graceful shutdown
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

    // Cleanup WeexClient singleton
    try {
        const { getWeexClient } = await import('./services/weex/WeexClient');
        const weexClient = getWeexClient();
        weexClient.cleanup();
        logger.info('WeexClient cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up WeexClient:', error);
    }

    // Cleanup trading routes interval
    try {
        cleanupTradingRoutes();
        logger.info('Trading routes cleanup complete');
    } catch (error) {
        logger.warn('Error cleaning up trading routes:', error);
    }

    // Stop database health check interval
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

// Track unhandled rejections for rate-limited shutdown with decay
let rejectionCount = 0;
let rejectionWindowStart = Date.now();
const REJECTION_THRESHOLD = 5; // Max rejections before shutdown
const REJECTION_WINDOW_MS = 60000; // 60 second window
const REJECTION_DECAY_INTERVAL_MS = 30000; // Decay one rejection every 30 seconds

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);

    const now = Date.now();

    // FIXED: Reset counter if window expired (proper window reset)
    if (now - rejectionWindowStart >= REJECTION_WINDOW_MS) {
        rejectionCount = 0;
        rejectionWindowStart = now;
    }

    // FIXED: Apply decay properly - reduce count by 1 for every 30 seconds elapsed
    const elapsedSinceWindowStart = now - rejectionWindowStart;
    const decayAmount = Math.floor(elapsedSinceWindowStart / REJECTION_DECAY_INTERVAL_MS);
    if (decayAmount > 0) {
        rejectionCount = Math.max(0, rejectionCount - decayAmount);
        // FIXED: Update window start to reflect decay application
        rejectionWindowStart = now - (elapsedSinceWindowStart % REJECTION_DECAY_INTERVAL_MS);
    }

    rejectionCount++;

    // Emit alert/metric before potential shutdown
    logger.warn(`Unhandled rejection count: ${rejectionCount}/${REJECTION_THRESHOLD} in current window`);

    // Only shutdown if threshold exceeded (rate-limited approach)
    if (rejectionCount >= REJECTION_THRESHOLD) {
        logger.error(`CRITICAL: ${REJECTION_THRESHOLD} unhandled rejections in ${REJECTION_WINDOW_MS}ms - triggering shutdown`);
        // Trigger graceful shutdown to clean up resources
        shutdown('unhandledRejection');
    }
    // Otherwise just log and continue - single rejections shouldn't kill the server
});

start();

export { app, server };
