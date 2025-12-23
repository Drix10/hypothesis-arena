import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Load .env from project root - handle both ESM and CJS
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try multiple paths to find .env
const envPaths = [
    path.resolve(__dirname, '../../../../.env'),  // From dist
    path.resolve(__dirname, '../../../.env'),     // From src
    path.resolve(process.cwd(), '.env'),          // From project root
];

for (const envPath of envPaths) {
    const result = dotenv.config({ path: envPath });
    if (!result.error) {
        break;
    }
}

export const config = {
    // Server
    port: parseInt(process.env.PORT || '3000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',

    // CORS
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000', 'http://localhost:5173'],

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
        maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '0.2'),
        maxTotalInvested: parseFloat(process.env.MAX_TOTAL_INVESTED || '0.8'),
        maxDailyTrades: parseInt(process.env.MAX_DAILY_TRADES || '20', 10),
        drawdownPauseThreshold: parseFloat(process.env.DRAWDOWN_PAUSE_THRESHOLD || '0.3'),
        drawdownLiquidateThreshold: parseFloat(process.env.DRAWDOWN_LIQUIDATE_THRESHOLD || '0.8'),
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
