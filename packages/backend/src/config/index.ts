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

let loaded = false;
for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
        const result = dotenv.config({ path: envPath });
        if (!result.error) {
            loaded = true;
            break;
        }
    }
}

// Log warning if no .env file was found (only in development)
if (!loaded && process.env.NODE_ENV !== 'production') {
    console.warn('Warning: No .env file found. Using default configuration.');
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
        proxyToken: process.env.WEEX_PROXY_TOKEN || '', // Token for proxy auth if using IP whitelist proxy
    },

    // Gemini
    geminiApiKey: process.env.GEMINI_API_KEY || '',

    // Trading - General
    trading: {
        maxPositionSize: safeParseFloat(process.env.MAX_POSITION_SIZE, 0.2),
        maxTotalInvested: safeParseFloat(process.env.MAX_TOTAL_INVESTED, 0.8),
        maxDailyTrades: safeParseInt(process.env.MAX_DAILY_TRADES, 20),
        drawdownPauseThreshold: safeParseFloat(process.env.DRAWDOWN_PAUSE_THRESHOLD, 0.3),
        drawdownLiquidateThreshold: safeParseFloat(process.env.DRAWDOWN_LIQUIDATE_THRESHOLD, 0.8),
    },

    // Autonomous Trading Engine
    autonomous: {
        // Capital allocation
        numAiAnalysts: safeParseInt(process.env.NUM_AI_ANALYSTS, 8),                // Number of AI analysts
        aiAnalystBudget: safeParseFloat(process.env.AI_ANALYST_BUDGET, 100),        // $100 per AI analyst
        userTradingBudget: safeParseFloat(process.env.USER_TRADING_BUDGET, 200),    // $200 for user
        totalCapital: safeParseFloat(process.env.TOTAL_CAPITAL, 1000),              // $1000 total

        // Timing
        cycleIntervalMs: safeParseInt(process.env.CYCLE_INTERVAL_MS, 5 * 60 * 1000),           // 5 min between cycles
        minTradeIntervalMs: safeParseInt(process.env.MIN_TRADE_INTERVAL_MS, 15 * 60 * 1000),   // 15 min cooldown per analyst
        debateFrequency: safeParseInt(process.env.DEBATE_FREQUENCY, 3),                         // Debates every N cycles

        // Risk management (UPDATED: Match GLOBAL_RISK_LIMITS from prompts)
        // WARNING: High leverage (>5x) significantly increases liquidation risk
        // Prompts mandate 5x max for safety (20% liquidation distance vs 10% at 10x)
        maxPositionSizePercent: Math.min(100, Math.max(1, safeParseFloat(process.env.MAX_POSITION_SIZE_PERCENT, 10))),     // Max 10% per position (matches GLOBAL_RISK_LIMITS)
        minBalanceToTrade: Math.max(0, safeParseFloat(process.env.MIN_BALANCE_TO_TRADE, 10)),                              // Min $10 to trade
        maxLeverage: Math.min(5, Math.max(1, safeParseInt(process.env.MAX_LEVERAGE, 5))),                                  // Max 5x leverage (matches GLOBAL_RISK_LIMITS.MAX_SAFE_LEVERAGE)
        defaultLeverage: 0, // Will be set below to ensure it never exceeds maxLeverage
        stopLossPercent: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_PERCENT, 10))),                  // 10% stop loss (conservative)
        takeProfitPercent: Math.min(1000, Math.max(0.1, safeParseFloat(process.env.TAKE_PROFIT_PERCENT, 15))),             // 15% take profit

        // Circuit breakers (NEW)
        enableCircuitBreakers: process.env.ENABLE_CIRCUIT_BREAKERS !== 'false',                // Enabled by default
        circuitBreakerCheckIntervalMs: safeParseInt(process.env.CIRCUIT_BREAKER_CHECK_INTERVAL_MS, 60000), // Check every minute

        // AI decision thresholds
        minConfidenceToTrade: safeParseInt(process.env.MIN_CONFIDENCE_TO_TRADE, 60),           // Min 60% confidence
        minConsensusToTrade: safeParseInt(process.env.MIN_CONSENSUS_TO_TRADE, 2),              // Min 2 analysts agree

        // Retries
        maxRetries: safeParseInt(process.env.MAX_RETRIES, 3),                                  // Max retries for failed ops

        // Dry run mode (no real trades)
        dryRun: process.env.DRY_RUN === 'true',
    },

    // Compliance
    requireAILogs: process.env.REQUIRE_AI_LOGS === 'true',
};

// CRITICAL FIX: Ensure defaultLeverage never exceeds maxLeverage
const requestedDefaultLeverage = Math.min(5, Math.max(1, safeParseInt(process.env.DEFAULT_LEVERAGE, 3)));
config.autonomous.defaultLeverage = Math.min(config.autonomous.maxLeverage, requestedDefaultLeverage);

// Log warning if defaultLeverage was clamped
if (requestedDefaultLeverage > config.autonomous.maxLeverage) {
    console.warn(
        `⚠️ DEFAULT_LEVERAGE (${requestedDefaultLeverage}x) exceeds MAX_LEVERAGE (${config.autonomous.maxLeverage}x). ` +
        `Clamped to ${config.autonomous.defaultLeverage}x for safety.`
    );
}

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

// Validate capital allocation constraints
const totalAiCapital = config.autonomous.numAiAnalysts * config.autonomous.aiAnalystBudget;
if (totalAiCapital + config.autonomous.userTradingBudget > config.autonomous.totalCapital) {
    throw new Error(
        `Capital allocation exceeds total capital: ${totalAiCapital} (AI) + ${config.autonomous.userTradingBudget} (User) > ${config.autonomous.totalCapital} (Total)`
    );
}
