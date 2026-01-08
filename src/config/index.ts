import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env from project root using reliable path resolution
const envPaths = [
    path.resolve(__dirname, '../../.env'),
    path.resolve(process.cwd(), '.env'),
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

if (!loaded && process.env.NODE_ENV !== 'production') {
    console.warn('Warning: No .env file found. Using default configuration.');
}

// Safe parseInt with fallback
const safeParseInt = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseInt(value, 10);
    return (isNaN(parsed) || !Number.isFinite(parsed)) ? fallback : parsed;
};

// Safe parseFloat with fallback
const safeParseFloat = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseFloat(value);
    return (isNaN(parsed) || !Number.isFinite(parsed)) ? fallback : parsed;
};

// Clamp integer to range [min, max]
const clampInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
    const parsed = safeParseInt(value, fallback);
    return Math.max(min, Math.min(max, parsed));
};

// =============================================================================
// SHARED CONSTANTS - Parse once, use everywhere
// =============================================================================

// Parse STARTING_BALANCE once for use in multiple places
// FIXED: Enforce minimum starting balance of 1 to prevent division by zero and invalid thresholds
const PARSED_STARTING_BALANCE = Math.max(1, safeParseFloat(process.env.STARTING_BALANCE, 1000));

// =============================================================================
// CONFIGURATION
// =============================================================================

export const config = {
    // Server
    port: safeParseInt(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',

    // CORS
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || ['http://localhost:3000', 'http://localhost:25655'],

    // Database
    databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
    tursoDatabaseUrl: process.env.TURSO_DATABASE_URL || '',
    tursoAuthToken: process.env.TURSO_AUTH_TOKEN || '',

    // WEEX
    weex: {
        apiKey: process.env.WEEX_API_KEY || '',
        secretKey: process.env.WEEX_SECRET_KEY || '',
        passphrase: process.env.WEEX_PASSPHRASE || '',
        baseUrl: process.env.WEEX_BASE_URL || 'https://api-contract.weex.com',
        wsUrl: process.env.WEEX_WS_URL || 'wss://ws-contract.weex.com/v2/ws',
    },

    // AI Configuration
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
    ai: {
        provider: (() => {
            const provider = process.env.AI_PROVIDER || 'gemini';
            if (provider !== 'gemini' && provider !== 'openrouter') {
                console.warn(`Invalid AI_PROVIDER: ${provider}, defaulting to 'gemini'`);
                return 'gemini';
            }
            return provider;
        })() as 'gemini' | 'openrouter',
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        openRouterModel: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
        maxOutputTokens: safeParseInt(process.env.AI_MAX_OUTPUT_TOKENS, 8192),
        temperature: Math.max(0, Math.min(2, safeParseFloat(process.env.AI_TEMPERATURE, 0.7))),
        requestTimeoutMs: Math.max(5000, safeParseInt(process.env.AI_REQUEST_TIMEOUT_MS, 60000)),
        maxRetries: clampInt(process.env.AI_MAX_RETRIES, 3, 1, 10),
    },

    // Trading - General
    trading: {
        startingBalance: PARSED_STARTING_BALANCE,
        // MAX_DAILY_TRADES: Hard limit on trades per calendar day (canonical variable)
        maxDailyTrades: clampInt(process.env.MAX_DAILY_TRADES, 20, 1, 100),
    },

    // Autonomous Trading Engine
    autonomous: {
        // Timing - minimum 30 seconds to prevent CPU spinning
        cycleIntervalMs: Math.max(30000, safeParseInt(process.env.CYCLE_INTERVAL_MS, 5 * 60 * 1000)),

        // Risk management
        // MIN_BALANCE_TO_TRADE: Minimum balance required to open new trades
        // Recommended: 20-30% of STARTING_BALANCE. Values below 10% trigger a warning.
        // FIXED: Uses PARSED_STARTING_BALANCE instead of re-parsing, and enforces minimum threshold
        minBalanceToTrade: (() => {
            const rawValue = safeParseFloat(process.env.MIN_BALANCE_TO_TRADE, 200);
            const minSafeThreshold = PARSED_STARTING_BALANCE * 0.1; // 10% of starting balance

            if (rawValue < minSafeThreshold) {
                console.warn(
                    `⚠️ WARNING: MIN_BALANCE_TO_TRADE (${rawValue}) is below 10% of STARTING_BALANCE (${PARSED_STARTING_BALANCE}). ` +
                    `This is dangerously low and may result in trading with insufficient capital for recovery. ` +
                    `Enforcing minimum of ${minSafeThreshold.toFixed(0)}. ` +
                    `Recommended: ${Math.round(PARSED_STARTING_BALANCE * 0.2)}-${Math.round(PARSED_STARTING_BALANCE * 0.3)} (20-30% of starting balance).`
                );
            }
            // FIXED: Enforce minimum threshold - never allow 0 or below minSafeThreshold
            return Math.max(minSafeThreshold, rawValue);
        })(),
        maxConcurrentPositions: Math.max(1, safeParseInt(process.env.MAX_CONCURRENT_POSITIONS, 3)),
        maxSameDirectionPositions: Math.max(1, safeParseInt(process.env.MAX_SAME_DIRECTION_POSITIONS, 2)),
        weeklyDrawdownLimitPercent: Math.max(0, safeParseFloat(process.env.WEEKLY_DRAWDOWN_LIMIT_PERCENT, 10)),

        // AI decision thresholds (0-100)
        minConfidenceToTrade: clampInt(process.env.MIN_CONFIDENCE_TO_TRADE, 50, 0, 100),

        // Retry limits - clamped to [1, 10] for safety
        maxRetries: clampInt(process.env.MAX_RETRIES, 3, 1, 10),
        dryRun: process.env.DRY_RUN === 'true',
    },

    // Technical Indicators
    indicators: {
        cacheTTL: safeParseInt(process.env.INDICATOR_CACHE_TTL_MS, 60000),
    },

    // Anti-Churn Configuration
    // NOTE: hysteresisMultiplier and fundingPeriodsPerDay are intentionally hardcoded in AntiChurnService
    // They are included here as optional overrides for advanced users
    antiChurn: {
        cooldownAfterTradeMs: Math.max(0, safeParseInt(process.env.COOLDOWN_AFTER_TRADE_MS, 900000)),
        cooldownBeforeFlipMs: Math.max(0, safeParseInt(process.env.COOLDOWN_BEFORE_FLIP_MS, 1800000)),
        // Per-symbol hourly trade limit (default 3 trades per symbol per hour)
        maxTradesPerSymbolPerHour: clampInt(process.env.MAX_TRADES_PER_SYMBOL_PER_HOUR, 3, 1, 20),
        // Optional: Override hysteresis multiplier (default 1.2 = 20% more confidence to close)
        hysteresisMultiplier: process.env.HYSTERESIS_MULTIPLIER
            ? Math.max(1, Math.min(3, safeParseFloat(process.env.HYSTERESIS_MULTIPLIER, 1.2)))
            : undefined,
        // Optional: Override funding periods per day (default 3 for WEEX 8-hour periods)
        fundingPeriodsPerDay: process.env.FUNDING_PERIODS_PER_DAY
            ? clampInt(process.env.FUNDING_PERIODS_PER_DAY, 3, 1, 24)
            : undefined,
    },
};

// Validate interdependencies
if (config.autonomous.maxSameDirectionPositions > config.autonomous.maxConcurrentPositions) {
    console.warn(`⚠️ MAX_SAME_DIRECTION_POSITIONS clamped to ${config.autonomous.maxConcurrentPositions}.`);
    config.autonomous.maxSameDirectionPositions = config.autonomous.maxConcurrentPositions;
}

// Validate required config in production
if (config.nodeEnv === 'production') {
    const useTurso = Boolean(process.env.TURSO_DATABASE_URL?.startsWith('libsql://'));
    const required = useTurso ? ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] : ['DATABASE_URL'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        const errorMsg = `❌ FATAL: Missing required environment variables: ${missing.join(', ')}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }
}
