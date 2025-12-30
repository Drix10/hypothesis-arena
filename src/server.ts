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

process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
});

start();

export { app, server };
