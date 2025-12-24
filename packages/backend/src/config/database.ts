import { Pool, PoolConfig, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { config } from './index';

const isNeon = config.databaseUrl.includes('neon.tech');

const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    // Neon free tier: use fewer connections, shorter timeouts
    max: isNeon ? 5 : 20,
    min: 0, // Don't keep idle connections (Neon terminates them)
    idleTimeoutMillis: isNeon ? 10000 : 30000, // Release idle connections faster for Neon
    connectionTimeoutMillis: 10000,
    // SSL configuration - Neon requires SSL
    // Note: rejectUnauthorized: true is more secure but Neon's pooler uses a different cert
    // For production with sensitive data, consider using direct connection with proper CA cert
    ssl: isNeon || config.nodeEnv === 'production'
        ? {
            rejectUnauthorized: config.nodeEnv === 'production' && !isNeon,
            // Neon pooler requires rejectUnauthorized: false due to cert chain
            // Direct Neon connections can use rejectUnauthorized: true
        }
        : undefined,
    // Allow pool to fully drain when idle
    allowExitOnIdle: true,
};

export const pool = new Pool(poolConfig);

pool.on('remove', () => {
    logger.debug('Database connection removed from pool');
});

pool.on('error', (err, client) => {
    // Neon terminates idle connections - this is expected behavior
    if (err.message.includes('Connection terminated unexpectedly')) {
        logger.debug('Database connection terminated (Neon idle timeout)');
    } else {
        logger.error('Unexpected database pool error:', { message: err.message });
    }
});

pool.on('connect', () => {
    logger.debug('New database connection established');
});

export async function checkDatabaseHealth(): Promise<boolean> {
    try {
        const client = await pool.connect();
        await client.query('SELECT 1');
        client.release();
        return true;
    } catch (error) {
        logger.error('Database health check failed:', error);
        return false;
    }
}

export async function closeDatabasePool(): Promise<void> {
    logger.info('Closing database pool...');
    await pool.end();
    logger.info('Database pool closed');
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
    fn: (client: PoolClient) => Promise<T>
): Promise<T> {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
