import { PrismaClient } from '@prisma/client';
import { PrismaLibSQL } from '@prisma/adapter-libsql';
import { logger } from '../utils/logger';
import { config } from './index';

declare global {
    var __prisma: PrismaClient | undefined;
}

// Use TURSO_DATABASE_URL for runtime connection (production)
// DATABASE_URL is used by Prisma CLI for local schema management
const tursoUrl = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
const isProduction = config.nodeEnv === 'production';

// Decide adapter - use Turso if credentials are provided
const shouldUseTurso = Boolean(tursoUrl && authToken);

// Configuration for database connections
const DB_CONFIG = {
    logSlowQueries: !isProduction,
    slowQueryThreshold: 1000, // 1 second
    // PRAGMA settings for optimal performance (local SQLite only)
    pragmas: {
        // WAL mode for better concurrency (Turso uses WAL by default)
        journalMode: 'WAL',
        // NORMAL synchronous mode for balance of safety and performance
        synchronous: 'NORMAL',
        // Foreign key enforcement
        foreignKeys: 'ON',
        // Cache size (negative = KB, positive = pages). -64000 = 64MB
        cacheSize: -64000,
        // Store temp tables in memory for better performance
        tempStore: 'MEMORY',
        // Busy timeout in milliseconds (5 seconds)
        busyTimeout: 5000,
        // Memory-mapped I/O size (0 = disabled for Turso compatibility)
        mmapSize: 0,
    }
};

function buildClient(): PrismaClient {
    let client: PrismaClient;

    if (shouldUseTurso) {
        // Turso / libSQL adapter with embedded replica sync
        const adapter = new PrismaLibSQL({
            url: tursoUrl!, // validated by shouldUseTurso
            authToken: authToken!,
            // Embedded replica sync configuration
            syncUrl: tursoUrl!, // Use the same URL for sync
            syncInterval: 60, // Sync every 60 seconds (reduced from 5s to minimize connection churn)
        });

        client = new PrismaClient({
            adapter,
        });
        logger.info('Prisma initialized with Turso/libSQL adapter (embedded replica sync enabled)');
    } else {
        // Local SQLite (datasource url from schema/env)
        client = new PrismaClient({
            log: isProduction ? ['error'] : ['warn', 'error'],
        });
        logger.info('Prisma initialized with local SQLite');
    }

    // Add slow query logging using Prisma extensions if enabled
    if (DB_CONFIG.logSlowQueries) {
        const extendedClient = client.$extends({
            query: {
                $allModels: {
                    async $allOperations({ model, operation, args, query }) {
                        const start = Date.now();
                        const result = await query(args);
                        const duration = Date.now() - start;

                        if (duration > DB_CONFIG.slowQueryThreshold) {
                            logger.warn(`🐌 Slow query detected (${duration}ms):`, {
                                model,
                                action: operation,
                                duration: `${duration}ms`,
                                threshold: `${DB_CONFIG.slowQueryThreshold}ms`,
                                args: args ? Object.keys(args) : undefined
                            });
                        }

                        return result;
                    }
                }
            }
        });

        // FIXED: Return the extended client cast to PrismaClient
        // The extension maintains compatibility and doesn't create memory issues
        // because it's still a singleton in the global scope
        return extendedClient as unknown as PrismaClient;
    }

    return client;
}

let prisma: PrismaClient;

// Dev singleton to avoid exhausting connections during HMR
if (isProduction) {
    prisma = buildClient();
} else {
    if (!global.__prisma) {
        global.__prisma = buildClient();
    }
    prisma = global.__prisma;
}

export { prisma, DB_CONFIG };

// Compatibility layer for existing pool.query() calls
export const pool = {
    async query(text: string, params?: any[]): Promise<{ rows: any[] }> {
        try {
            const maxRetries = 3;
            let lastError: any;

            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    let result: any;

                    if (params && params.length > 0) {
                        // Use $queryRawUnsafe with parameters
                        // SECURITY NOTE: SQL injection safety verified - all query sources are controlled
                        // within the codebase. No user input is directly interpolated into SQL strings.
                        // All dynamic values are passed as parameterized arguments.
                        result = await prisma.$queryRawUnsafe(text, ...params);
                    } else {
                        // No parameters
                        // SECURITY NOTE: Safe because query text is from controlled sources only
                        result = await prisma.$queryRawUnsafe(text);
                    }

                    // Prisma returns array directly for SELECT queries
                    if (Array.isArray(result)) {
                        return { rows: result };
                    }

                    // For INSERT/UPDATE/DELETE, return empty rows
                    return { rows: [] };
                } catch (error: any) {
                    lastError = error;

                    // Retry on SQLite BUSY errors
                    if (error?.code === 'SQLITE_BUSY' || error?.message?.includes('SQLITE_BUSY')) {
                        const delay = Math.min(100 * Math.pow(2, attempt), 1000);
                        logger.warn(`SQLite BUSY error, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }

                    // Don't retry other errors
                    throw error;
                }
            }

            throw lastError;
        } catch (error) {
            logger.error('Database query error:', error);
            throw error;
        }
    },

    async connect() {
        // Return a client-like object for transaction support
        return {
            query: pool.query.bind(pool),
            release: () => Promise.resolve(),
        };
    },

    async end() {
        await prisma.$disconnect();
    },

    on(_event: string, _handler: (...args: any[]) => void) {
        // No-op for compatibility
    }
};

/**
 * Apply per-connection PRAGMAs that are safe on Turso/libSQL and SQLite.
 * Call after $connect() to ensure they attach to the active session.
 * 
 * IMPORTANT: PRAGMAs are per-connection settings in SQLite. When using Prisma's
 * connection pool, these settings may need to be reapplied for each connection.
 * Consider using Prisma middleware or connection lifecycle hooks for consistent
 * PRAGMA application across all pooled connections.
 * 
 * Note: Turso doesn't support PRAGMA statements, so we skip them when using Turso.
 * Turso manages these settings automatically at the infrastructure level.
 */
async function applySessionPragmas() {
    // Skip PRAGMA application for Turso - it manages these settings automatically
    if (shouldUseTurso) {
        if (!isProduction) {
            logger.info('ℹ️  Skipping PRAGMA application (Turso manages settings automatically)');
        }
        return;
    }

    try {
        // Apply all PRAGMA settings for local SQLite
        const pragmas = [
            `PRAGMA journal_mode = ${DB_CONFIG.pragmas.journalMode};`,
            `PRAGMA foreign_keys = ${DB_CONFIG.pragmas.foreignKeys};`,
            `PRAGMA synchronous = ${DB_CONFIG.pragmas.synchronous};`,
            `PRAGMA cache_size = ${DB_CONFIG.pragmas.cacheSize};`,
            `PRAGMA temp_store = ${DB_CONFIG.pragmas.tempStore};`,
            `PRAGMA busy_timeout = ${DB_CONFIG.pragmas.busyTimeout};`,
            `PRAGMA mmap_size = ${DB_CONFIG.pragmas.mmapSize};`,
        ];

        // Apply PRAGMAs sequentially
        for (const pragma of pragmas) {
            try {
                await prisma.$executeRawUnsafe(pragma);
            } catch (err) {
                if (!isProduction) {
                    logger.warn(`Failed to apply PRAGMA: ${pragma}`, err);
                }
            }
        }

        // Log applied configuration in development
        if (!isProduction) {
            logger.info('✅ Database PRAGMAs applied:', {
                journalMode: DB_CONFIG.pragmas.journalMode,
                foreignKeys: DB_CONFIG.pragmas.foreignKeys,
                synchronous: DB_CONFIG.pragmas.synchronous,
                cacheSize: `${Math.abs(DB_CONFIG.pragmas.cacheSize) / 1000}MB`,
                tempStore: DB_CONFIG.pragmas.tempStore,
                busyTimeout: `${DB_CONFIG.pragmas.busyTimeout}ms`,
                mmapSize: `${DB_CONFIG.pragmas.mmapSize} bytes`
            });
        }
    } catch (error) {
        logger.warn('Failed to apply session PRAGMAs:', error);
    }
}

/**
 * Light retry helper for initial connect — handles brief network hiccups
 * on cold starts or during Turso region warmups.
 */
async function connectWithRetry(retries = 3): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await prisma.$connect();
            await applySessionPragmas();

            // Quick health check using actual schema
            // Use Portfolio model since it's guaranteed to exist in your schema
            await prisma.portfolio.findFirst({ select: { id: true }, take: 1 });
            return;
        } catch (err) {
            lastErr = err;
            // Exponential backoff: attempt 1=150ms, attempt 2=250ms, attempt 3=450ms
            const delay = Math.floor(100 * Math.pow(2, attempt - 1)) + 50;
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    throw lastErr instanceof Error
        ? lastErr
        : new Error('Unknown error during DB connect');
}

export async function checkDatabaseHealth(): Promise<boolean> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    } catch (error) {
        logger.error('Database health check failed:', error);
        return false;
    }
}

export async function closeDatabasePool(): Promise<void> {
    logger.info('Closing database connection...');
    await prisma.$disconnect();
    logger.info('Database connection closed');
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
    const start = Date.now();
    const result = await pool.query(text, params);
    const duration = Date.now() - start;

    if (duration > 1000) {
        logger.warn(`Slow query (${duration}ms): ${text.substring(0, 100)}`);
    }

    return result.rows;
}

export async function queryOne<T = any>(text: string, params?: any[]): Promise<T | null> {
    const rows = await query<T>(text, params);
    return rows[0] || null;
}

export async function withTransaction<T>(
    fn: (client: any) => Promise<T>
): Promise<T> {
    // FIXED: Reduced retry attempts in transactions to prevent timeout issues
    // Transaction timeout is 30s, but queries can retry up to 3 times with 1s backoff each
    // Multiple queries could exceed timeout, so we reduce retries to 2 in transactions
    return await prisma.$transaction(async (tx) => {
        const txClient = {
            query: async (text: string, params?: any[]) => {
                // FIXED: Reduced maxRetries from 3 to 2 for transaction queries
                const maxRetries = 2;
                let lastError: any;

                for (let attempt = 0; attempt < maxRetries; attempt++) {
                    try {
                        const result = await tx.$queryRawUnsafe(text, ...(params || []));
                        return { rows: Array.isArray(result) ? result : [] };
                    } catch (error: any) {
                        lastError = error;

                        // Retry on SQLite BUSY errors
                        if (error?.code === 'SQLITE_BUSY' || error?.message?.includes('SQLITE_BUSY')) {
                            const delay = Math.min(100 * Math.pow(2, attempt), 500); // Reduced max delay to 500ms
                            logger.warn(`SQLite BUSY in transaction, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
                            await new Promise(resolve => setTimeout(resolve, delay));
                            continue;
                        }

                        // Don't retry other errors
                        throw error;
                    }
                }

                throw lastError;
            },
            release: () => Promise.resolve(),
        };
        return await fn(txClient);
    }, {
        maxWait: 5000, // Maximum time to wait for transaction to start (5s)
        timeout: 30000, // Maximum time for transaction to complete (30s)
    });
}

export const connectDB = async () => {
    try {
        await connectWithRetry(3);
        const dbType = shouldUseTurso ? 'Turso/libSQL' : 'SQLite';
        logger.info(`🚀 Database connected successfully with ${dbType}`);
        logger.info('✅ Database query test successful');
    } catch (error) {
        logger.error('❌ Database connection failed:', error);
        try {
            await prisma.$disconnect();
        } catch { }
        throw new Error(
            `Database connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
    }
};

export const disconnectDB = async () => {
    try {
        await prisma.$disconnect();
        logger.info('📦 Database disconnected');
    } catch (error) {
        logger.error('Error disconnecting from database:', error);
    }
};

/**
 * Database health check with automatic reconnection
 */
let dbHealthCheckInterval: NodeJS.Timeout | null = null;
let consecutiveDbFailures = 0;
const MAX_DB_FAILURES = 3;
let isHealthCheckRunning = false;
let lastHealthCheckTime = 0;

export const startDatabaseHealthCheck = () => {
    if (dbHealthCheckInterval) {
        logger.warn('Database health check already running');
        return;
    }

    logger.info('🏥 Starting database health check monitor...');

    dbHealthCheckInterval = setInterval(async () => {
        // Prevent overlapping health checks with time-based guard
        const now = Date.now();
        if (isHealthCheckRunning) {
            const elapsed = now - lastHealthCheckTime;
            if (elapsed < 30000) { // Skip if last check was less than 30s ago
                logger.warn('⚠️ Health check already in progress, skipping...');
                return;
            }
            // If stuck for >30s, force reset
            logger.warn('⚠️ Health check appears stuck, forcing reset...');
        }

        isHealthCheckRunning = true;
        lastHealthCheckTime = now;

        let healthCheckTimeoutId: NodeJS.Timeout | null = null;
        try {
            // Use a lightweight Prisma query that validates schema and connection
            // Use Portfolio model since it's guaranteed to exist in your schema
            await Promise.race([
                prisma.portfolio.findFirst({ select: { id: true }, take: 1 }),
                new Promise((_, reject) => {
                    healthCheckTimeoutId = setTimeout(() => reject(new Error('Health check timeout')), 15000); // 15s timeout - balance between responsiveness and Turso latency
                })
            ]);

            // Reset failure counter on success
            if (consecutiveDbFailures > 0) {
                logger.info('✅ Database connection restored');
                consecutiveDbFailures = 0;
            }
        } catch (error) {
            consecutiveDbFailures++;
            logger.error(`❌ Database health check failed (${consecutiveDbFailures}/${MAX_DB_FAILURES}):`, error);

            // Attempt reconnection if multiple failures
            if (consecutiveDbFailures >= MAX_DB_FAILURES) {
                logger.warn('🔄 Attempting database reconnection...');
                try {
                    await prisma.$disconnect();
                    await connectWithRetry(3);
                    consecutiveDbFailures = 0;
                    logger.info('✅ Database reconnected successfully');
                } catch (reconnectError) {
                    logger.error('❌ Database reconnection failed:', reconnectError);
                    // Don't throw - allow service to continue with degraded functionality
                }
            }
        } finally {
            // FIXED: Clear timeout to prevent memory leak
            if (healthCheckTimeoutId) {
                clearTimeout(healthCheckTimeoutId);
                healthCheckTimeoutId = null;
            }
            isHealthCheckRunning = false;
        }
    }, 180000); // Check every 3 minutes
};

export const stopDatabaseHealthCheck = () => {
    if (dbHealthCheckInterval) {
        clearInterval(dbHealthCheckInterval);
        dbHealthCheckInterval = null;
        // Reset state variables when stopping
        consecutiveDbFailures = 0;
        isHealthCheckRunning = false;
        logger.info('🏥 Database health check monitor stopped');
    }
};

// FIXED: Add process exit handlers to ensure health check interval is cleared
// This prevents memory leaks in testing/development with frequent restarts
const cleanupHealthCheck = () => {
    stopDatabaseHealthCheck();
};

// Register cleanup handlers for various exit scenarios
if (typeof process !== 'undefined') {
    process.once('SIGINT', cleanupHealthCheck);  // Ctrl+C
    process.once('SIGTERM', cleanupHealthCheck); // Kill signal
    process.once('beforeExit', cleanupHealthCheck); // Normal exit
}
