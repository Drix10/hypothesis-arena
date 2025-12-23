import { Pool, PoolConfig, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import { config } from './index';

const poolConfig: PoolConfig = {
    connectionString: config.databaseUrl,
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    // Neon requires SSL
    ssl: config.databaseUrl.includes('neon.tech') || config.nodeEnv === 'production'
        ? { rejectUnauthorized: false }
        : undefined,
    // Validate connections before use
    allowExitOnIdle: false,
};

export const pool = new Pool(poolConfig);

// Validate connection on checkout
pool.on('acquire', (client) => {
    // Connection acquired from pool
});

pool.on('remove', () => {
    logger.debug('Database connection removed from pool');
});

pool.on('error', (err) => {
    logger.error('Unexpected database pool error:', err);
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
