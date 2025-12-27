import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config';
import { apiRouter } from './api/routes';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { WebSocketManager } from './services/weex/WebSocketManager';
import { getAutonomousTradingEngine } from './services/autonomous/AutonomousTradingEngine';
import { closeDatabasePool, checkDatabaseHealth } from './config/database';
import { closeRedis, getRedisClient, checkRedisHealth } from './config/redis';
import { logger } from './utils/logger';

const app = express();
const server = createServer(app);

// Security
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
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

// API Routes
app.use('/api', apiRouter);

// Health check
app.get('/health', async (_req, res) => {
    const dbHealthy = await checkDatabaseHealth();
    const redisHealthy = await checkRedisHealth();

    const status = dbHealthy && redisHealthy ? 'ok' : 'degraded';

    res.status(status === 'ok' ? 200 : 503).json({
        status,
        timestamp: Date.now(),
        services: {
            database: dbHealthy ? 'connected' : 'disconnected',
            redis: redisHealthy ? 'connected' : 'disconnected',
            websockets: wsManager.getClientCount(),
        },
    });
});

// Serve frontend in production
if (config.nodeEnv === 'production') {
    const frontendPath = path.join(__dirname, '../../frontend/dist');
    app.use(express.static(frontendPath, { maxAge: '1d' }));

    // SPA fallback
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
            next();
            return;
        }
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

// Error handlers
app.use(notFoundHandler);
app.use(errorHandler);

// WebSocket
const wss = new WebSocketServer({ server, path: '/ws' });
const wsManager = new WebSocketManager(wss);

// Start server
const PORT = config.port;

async function start() {
    try {
        // Test database connection
        const dbOk = await checkDatabaseHealth();
        if (!dbOk) {
            logger.warn('Database connection failed - some features may not work');
        }

        // Initialize Redis (optional)
        try {
            await getRedisClient();
        } catch (error) {
            logger.warn('Redis connection failed - caching disabled');
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

// Graceful shutdown
let isShuttingDown = false;

const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`${signal} received. Starting graceful shutdown...`);

    // Stop accepting new connections
    server.close(() => {
        logger.info('HTTP server closed');
    });

    // Stop autonomous trading engine
    try {
        const engine = getAutonomousTradingEngine();
        await engine.cleanup();
        logger.info('Autonomous trading engine stopped');
    } catch (error) {
        logger.warn('Error stopping autonomous engine:', error);
    }

    // Close WebSocket connections
    wsManager.closeAll();
    wss.close();

    // Close database pool
    await closeDatabasePool();

    // Close Redis
    await closeRedis();

    logger.info('Graceful shutdown complete');
    process.exit(0);
};

// Force exit after 30s
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

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
});

// Start
start();

export { app, server, wsManager };
