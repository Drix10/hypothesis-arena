import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env from project root using reliable path resolution
// Uses __dirname which is reliable in CommonJS (backend uses CommonJS)
const envPaths = [
    path.resolve(__dirname, '../../../../.env'),  // From packages/backend/dist/config
    path.resolve(__dirname, '../../../.env'),     // From packages/backend/src/config (ts-node)
    path.resolve(__dirname, '../../.env'),        // From packages/backend/dist
    path.resolve(process.cwd(), '.env'),          // From cwd (fallback)
];

let envLoaded = false;
for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        const result = dotenv.config({ path: envPath });
        if (!result.error) {
            envLoaded = true;
            break;
        }
    }
}

// Safe parseInt with fallback
const safeParseInt = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? fallback : parsed;
};

// Safe parseFloat with fallback
const safeParseFloat = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
};

export const config = {
    // Server
    port: safeParseInt(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',

    // CORS
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || ['http://localhost:3000', 'http://localhost:5173'],

    // Database
    databaseUrl: process.env.DATABASE_URL || 'postgresql://localhost:5432/hypothesis_arena',

    // Redis
    redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',

    // JWT
    jwtSecret: process.env.JWT_SECRET || 'change-this-in-production',
    jwtExpiry: process.env.JWT_EXPIRY || '7d',
    jwtRefreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',

    // WEEX
    weex: {
        apiKey: process.env.WEEX_API_KEY || '',
        secretKey: process.env.WEEX_SECRET_KEY || '',
        passphrase: process.env.WEEX_PASSPHRASE || '',
        baseUrl: process.env.WEEX_BASE_URL || 'https://api-contract.weex.com',
        wsUrl: process.env.WEEX_WS_URL || 'wss://ws-contract.weex.com/v2/ws',
    },

    // Gemini
    geminiApiKey: process.env.GEMINI_API_KEY || '',

    // Trading
    trading: {
        maxPositionSize: safeParseFloat(process.env.MAX_POSITION_SIZE, 0.2),
        maxTotalInvested: safeParseFloat(process.env.MAX_TOTAL_INVESTED, 0.8),
        maxDailyTrades: safeParseInt(process.env.MAX_DAILY_TRADES, 20),
        drawdownPauseThreshold: safeParseFloat(process.env.DRAWDOWN_PAUSE_THRESHOLD, 0.3),
        drawdownLiquidateThreshold: safeParseFloat(process.env.DRAWDOWN_LIQUIDATE_THRESHOLD, 0.8),
    },

    // Compliance
    requireAILogs: process.env.REQUIRE_AI_LOGS === 'true',
};

// Validate required config in production
if (config.nodeEnv === 'production') {
    const required = ['JWT_SECRET', 'DATABASE_URL'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    if (config.jwtSecret === 'change-this-in-production') {
        throw new Error('JWT_SECRET must be changed in production');
    }
}
