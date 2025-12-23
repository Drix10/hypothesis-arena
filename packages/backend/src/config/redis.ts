import { createClient, RedisClientType } from 'redis';
import { logger } from '../utils/logger';
import { config } from './index';

let redisClient: RedisClientType | null = null;
let connectionPromise: Promise<RedisClientType> | null = null;

export async function getRedisClient(): Promise<RedisClientType> {
    // Return existing open client
    if (redisClient?.isOpen) {
        return redisClient;
    }

    // If connection is in progress, wait for it
    if (connectionPromise) {
        return connectionPromise;
    }

    // Start new connection
    connectionPromise = connectRedis();

    try {
        redisClient = await connectionPromise;
        return redisClient;
    } finally {
        connectionPromise = null;
    }
}

async function connectRedis(): Promise<RedisClientType> {
    const client = createClient({
        url: config.redisUrl,
        socket: {
            reconnectStrategy: (retries) => {
                if (retries > 10) {
                    logger.error('Redis max reconnection attempts reached');
                    return new Error('Max reconnection attempts');
                }
                return Math.min(retries * 100, 3000);
            },
        },
    });

    client.on('error', (err) => {
        logger.error('Redis error:', err);
    });

    client.on('reconnecting', () => {
        logger.info('Redis reconnecting...');
    });

    client.on('ready', () => {
        logger.info('Redis connected');
    });

    await client.connect();
    return client as RedisClientType;
}

export async function closeRedis(): Promise<void> {
    if (redisClient?.isOpen) {
        logger.info('Closing Redis connection...');
        await redisClient.quit();
        redisClient = null;
        logger.info('Redis connection closed');
    }
}

export async function cacheGet<T>(key: string): Promise<T | null> {
    try {
        const client = await getRedisClient();
        const value = await client.get(key);
        return value ? JSON.parse(value) : null;
    } catch (error) {
        logger.error('Redis cache get error:', error);
        return null;
    }
}

export async function cacheSet(
    key: string,
    value: any,
    ttlSeconds: number = 300
): Promise<void> {
    try {
        const client = await getRedisClient();
        await client.setEx(key, ttlSeconds, JSON.stringify(value));
    } catch (error) {
        logger.error('Redis cache set error:', error);
    }
}

export async function cacheDelete(key: string): Promise<void> {
    try {
        const client = await getRedisClient();
        await client.del(key);
    } catch (error) {
        logger.error('Redis cache delete error:', error);
    }
}

export async function checkRedisHealth(): Promise<boolean> {
    try {
        const client = await getRedisClient();
        await client.ping();
        return true;
    } catch {
        return false;
    }
}
