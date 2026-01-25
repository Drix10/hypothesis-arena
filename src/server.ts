import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config';
import { apiRouter } from './api/routes';
import { errorHandler, notFoundHandler } from './api/middleware/errorHandler';
import { getAutonomousTradingEngine } from './services/autonomous/AutonomousTradingEngine';
import { closeDatabasePool, checkDatabaseHealth } from './config/database';
import { logger } from './utils/logger';
import { cleanupTradingRoutes } from './api/routes/trading';
import { weexWebsocketService } from './services/weex/WeexWebsocketService';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Heartbeat to detect stale connections
const interval = setInterval(() => {
    wss.clients.forEach((ws: any) => {
        if (ws.isAlive === false) {
            logger.info('Terminating stale WebSocket connection');
            return ws.terminate();
        }

        ws.isAlive = false;
        try {
            ws.ping();
        } catch (err) {
            logger.error('Error sending ping to client:', err);
            ws.terminate();
        }
    });
}, 30000);

wss.on('close', () => {
    clearInterval(interval);
});

// Handle frontend WebSocket connections
wss.on('connection', (ws: WebSocket & { isAlive: boolean }) => {
    try {
        logger.info('Frontend client connected via WebSocket');

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        // Send initial ping to verify connection
        ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now(), status: 'connected' }));

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.type === 'pong') {
                    ws.isAlive = true;
                }
            } catch (_err) {
                // Ignore non-JSON or invalid messages
            }
        });

        ws.on('error', (err) => {
            logger.error('Frontend WebSocket error:', err);
        });

        ws.on('close', () => {
            logger.info('Frontend client disconnected');
        });
    } catch (err) {
        logger.error('Error handling new WebSocket connection:', err);
        ws.terminate();
    }
});

// Broadcast real-time data to all connected frontend clients
weexWebsocketService.onTickerUpdate((payload) => {
    if (!payload.data || payload.data.length === 0) return;

    const message = JSON.stringify({
        type: 'ticker',
        data: payload.data[0] // WEEX ticker payload data is an array
    });

    let clientsNotified = 0;
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(message);
                clientsNotified++;
            } catch (err) {
                logger.error('Error broadcasting to client:', err);
                client.terminate();
            }
        }
    });

    if (clientsNotified > 0) {
        logger.debug(`Broadcasted ticker ${payload.data[0].symbol} to ${clientsNotified} clients`);
    }
});

// Trust proxy for accurate IP resolution behind reverse proxies (nginx, load balancers, etc.)
// Required for express-rate-limit to use req.ip correctly instead of always seeing proxy IP
// Set to 1 for single proxy, 'loopback' for localhost proxies, or specific IPs for production
// See: https://expressjs.com/en/guide/behind-proxies.html
if (process.env.NODE_ENV === 'production') {
    // In production, trust only the first proxy (adjust based on your infrastructure)
    app.set('trust proxy', 1);
} else {
    // In development, trust loopback addresses
    app.set('trust proxy', 'loopback');
}

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5000, // Increased from 500 to 5000 to accommodate frequent auto-refreshes and multiple users
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
        const path = req.path || req.url?.split('?')[0] || '';
        // Skip rate limiting for critical health checks, autonomous events, and manual trading actions
        return (
            path === '/health' ||
            path === '/api/autonomous/events' ||
            path.includes('/api/trading/manual/') ||
            path.includes('/api/weex/close')
        );
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
        // Validation: Check for required API keys in production/non-dry-run
        if (process.env.NODE_ENV === 'production' && !config.autonomous.dryRun) {
            if (!config.weex.apiKey || !config.weex.secretKey || !config.weex.passphrase) {
                logger.error('CRITICAL: Weex API credentials missing in production mode!');
                process.exit(1);
            }
        }

        // Validation: Check for AI keys
        if (config.ai.provider === 'gemini' && !config.geminiApiKey) {
            logger.warn('WARNING: Gemini API Key missing, AI features will fail');
        }
        if (config.ai.provider === 'openrouter' && !config.openRouterApiKey) {
            logger.warn('WARNING: OpenRouter API Key missing, AI features will fail');
        }

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

        server.listen(PORT, async () => {
            logger.info(`Server running on port ${PORT}`);
            logger.info(`Environment: ${config.nodeEnv}`);
            logger.info(`Database: ${dbOk ? 'connected' : 'disconnected'}`);

            // Start WEEX WebSocket service
            weexWebsocketService.connect();

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

    // Force exit after 10 seconds if graceful shutdown fails
    const forceExitTimeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out, forcing exit');
        process.exit(1);
    }, 10000);
    forceExitTimeout.unref();

    try {
        // 1. Close HTTP server (stops new requests)
        await new Promise<void>((resolve) => {
            server.close(() => {
                logger.info('HTTP server closed');
                resolve();
            });
        });

        // 2. Close all frontend WebSocket clients and the server
        logger.info('Closing frontend WebSocket server...');
        wss.clients.forEach((client) => {
            client.terminate();
        });
        await new Promise<void>((resolve) => {
            wss.close((err) => {
                if (err) logger.error('Error closing WebSocket server:', err);
                else logger.info('WebSocket server closed');
                resolve();
            });
        });

        // 3. Disconnect from WEEX WebSocket
        try {
            logger.info('Disconnecting from WEEX WebSocket...');
            weexWebsocketService.disconnect();
            logger.info('WEEX WebSocket disconnected');
        } catch (error) {
            logger.error('Error disconnecting from WEEX WebSocket:', error);
        }

        // 4. Cleanup trading engine
        try {
            const engine = getAutonomousTradingEngine();
            await engine.cleanup();
            logger.info('Autonomous trading engine stopped');
        } catch (error) {
            logger.warn('Error stopping autonomous engine:', error);
        }

        // 5. Cleanup singletons
        const cleanupTasks = [
            { name: 'WeexClient', import: './services/weex/WeexClient', func: 'resetWeexClient' },
            { name: 'TechnicalIndicatorService', import: './services/indicators/TechnicalIndicatorService', func: 'resetTechnicalIndicatorService' },
            { name: 'AntiChurnService', import: './services/trading/AntiChurnService', func: 'resetAntiChurnService' },
            { name: 'CollaborativeFlow', import: './services/ai/CollaborativeFlow', func: 'resetCollaborativeFlow' },
            { name: 'ContextBuilder', import: './services/context/ContextBuilder', func: 'resetContextBuilder' },
            { name: 'SentimentService', import: './services/sentiment', func: 'shutdownSentimentService' },
            { name: 'QuantService', import: './services/quant', func: 'shutdownQuantService' },
            { name: 'RedditService', import: './services/sentiment', func: 'shutdownRedditService' },
            { name: 'JournalService', import: './services/journal', func: 'shutdownJournalService' },
            { name: 'PositionSyncService', import: './services/position', func: 'shutdownPositionSyncService' },
            { name: 'RegimeDetector', import: './services/quant', func: 'shutdownRegimeDetector' },
            { name: 'AILogService', import: './services/compliance/AILogService', func: 'aiLogService.cleanup' },
            { name: 'AIService', import: './services/ai/AIService', func: 'aiService.cleanup' }
        ];

        for (const task of cleanupTasks) {
            try {
                const module = await import(task.import);
                if (task.func.includes('.')) {
                    const [obj, method] = task.func.split('.');
                    if (module[obj] && module[obj][method]) {
                        module[obj][method]();
                        logger.info(`${task.name} cleanup complete`);
                    }
                } else if (module[task.func]) {
                    module[task.func]();
                    logger.info(`${task.name} cleanup complete`);
                }
            } catch (error) {
                logger.warn(`Error cleaning up ${task.name}:`, error);
            }
        }

        // 6. Stop route-level state and health checks
        try {
            cleanupTradingRoutes();
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

        // 7. Close database pool
        try {
            await closeDatabasePool();
            logger.info('Database connection closed');
        } catch (error) {
            logger.error('Error closing database pool:', error);
        }

        logger.info('Graceful shutdown complete');
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
