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

// Configurable concentration threshold for debate score weights
const CONCENTRATION_THRESHOLD_PCT = safeParseInt(process.env.DEBATE_WEIGHT_CONCENTRATION_THRESHOLD_PCT, 70);

// =============================================================================
// SCORE WEIGHT NORMALIZATION
// =============================================================================

interface ScoreWeights {
    data: number;
    logic: number;
    risk: number;
    catalyst: number;
}

/**
 * Normalize score weights to always sum to exactly 100
 * 
 * Handles edge cases:
 * - Negative weights → reset to defaults with error
 * - Zero sum → reset to defaults with error
 * - Non-100 sum → normalize proportionally
 * - Rounding errors → adjust largest weight
 * 
 * @param weights - Input weights (may be invalid)
 * @returns Normalized weights that sum to exactly 100
 * @throws Error if normalization fails (should never happen)
 */
function normalizeScoreWeights(weights: ScoreWeights): ScoreWeights {
    const WEIGHT_KEYS: (keyof ScoreWeights)[] = ['data', 'logic', 'risk', 'catalyst'];
    const TARGET_SUM = 100;
    const DEFAULT_WEIGHT = 25; // Equal distribution

    // Calculate sum
    const sum = weights.data + weights.logic + weights.risk + weights.catalyst;

    // Validate weights are non-negative
    const hasNegative = WEIGHT_KEYS.some(key => weights[key] < 0);
    if (hasNegative) {
        console.error(
            `❌ ERROR: Debate score weights contain negative values. ` +
            `Weights: data=${weights.data}, logic=${weights.logic}, ` +
            `risk=${weights.risk}, catalyst=${weights.catalyst}. ` +
            `Resetting to default ${DEFAULT_WEIGHT}/${DEFAULT_WEIGHT}/${DEFAULT_WEIGHT}/${DEFAULT_WEIGHT}.`
        );
        return {
            data: DEFAULT_WEIGHT,
            logic: DEFAULT_WEIGHT,
            risk: DEFAULT_WEIGHT,
            catalyst: DEFAULT_WEIGHT
        };
    }

    // Handle zero sum
    if (sum === 0) {
        console.error(
            `❌ ERROR: All debate score weights are 0. ` +
            `Resetting to default ${DEFAULT_WEIGHT}/${DEFAULT_WEIGHT}/${DEFAULT_WEIGHT}/${DEFAULT_WEIGHT}.`
        );
        return {
            data: DEFAULT_WEIGHT,
            logic: DEFAULT_WEIGHT,
            risk: DEFAULT_WEIGHT,
            catalyst: DEFAULT_WEIGHT
        };
    }

    // If already 100, return as-is
    if (sum === TARGET_SUM) {
        // Warn on extreme concentration even when sum is already TARGET_SUM
        for (const key of WEIGHT_KEYS) {
            if (weights[key] > CONCENTRATION_THRESHOLD_PCT) {
                console.warn(
                    `⚠️ Extreme concentration detected in debate weights: ${key}=${weights[key]}% (> ${CONCENTRATION_THRESHOLD_PCT}%). ` +
                    `Single-dimension domination may skew judging outcomes.`
                );
            }
        }
        return { ...weights };
    }

    // Normalize to sum to 100
    console.warn(
        `⚠️ Debate score weights sum to ${sum}, not ${TARGET_SUM}. ` +
        `Weights: data=${weights.data}, logic=${weights.logic}, ` +
        `risk=${weights.risk}, catalyst=${weights.catalyst}`
    );

    const normalized: ScoreWeights = {
        data: Math.round((weights.data / sum) * TARGET_SUM),
        logic: Math.round((weights.logic / sum) * TARGET_SUM),
        risk: Math.round((weights.risk / sum) * TARGET_SUM),
        catalyst: Math.round((weights.catalyst / sum) * TARGET_SUM)
    };

    // Handle rounding errors - adjust the largest weight to ensure exact sum of 100
    const normalizedSum = normalized.data + normalized.logic + normalized.risk + normalized.catalyst;

    if (normalizedSum !== TARGET_SUM) {
        const diff = TARGET_SUM - normalizedSum;
        // Find the largest weight and adjust it
        const weightEntries = WEIGHT_KEYS.map(key => ({ key, value: normalized[key] }));
        weightEntries.sort((a, b) => b.value - a.value);
        const largestKey = weightEntries[0].key;
        normalized[largestKey] += diff;
    }

    // Warn on extreme concentration after normalization
    for (const key of WEIGHT_KEYS) {
        if (normalized[key] > CONCENTRATION_THRESHOLD_PCT) {
            console.warn(
                `⚠️ Extreme concentration detected in normalized debate weights: ${key}=${normalized[key]}% (> ${CONCENTRATION_THRESHOLD_PCT}%). ` +
                `Single-dimension domination may skew judging outcomes.`
            );
        }
    }

    console.warn(
        `✓ Normalized weights: data=${normalized.data}, logic=${normalized.logic}, ` +
        `risk=${normalized.risk}, catalyst=${normalized.catalyst} (sum=${TARGET_SUM})`
    );

    return normalized;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

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

    // Gemini / AI
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    ai: {
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        maxOutputTokens: safeParseInt(process.env.AI_MAX_OUTPUT_TOKENS, 8192),
        debateMaxTokens: safeParseInt(process.env.AI_DEBATE_MAX_TOKENS, 8192),
        specialistMaxTokens: safeParseInt(process.env.AI_SPECIALIST_MAX_TOKENS, 8192),
        maxPromptLines: safeParseInt(process.env.AI_MAX_PROMPT_LINES, 250),
        temperature: safeParseFloat(process.env.AI_TEMPERATURE, 0.8),
        requestTimeoutMs: safeParseInt(process.env.AI_REQUEST_TIMEOUT_MS, 60000),
        maxRetries: safeParseInt(process.env.AI_MAX_RETRIES, 3),
    },

    // Debate Configuration
    debate: {
        // Turn counts (4-way debates: 4 analysts × turnsPerAnalyst, championship: 8 analysts × turnsPerAnalyst)
        turnsPerAnalyst: safeParseInt(process.env.DEBATE_TURNS_PER_ANALYST, 2),
        // Derived: 4-way = 4 × 2 = 8 turns, championship = 8 × 2 = 16 turns, total = 8+8+8+16 = 40

        // Scoring weights (must sum to 100)
        scoreWeights: {
            data: safeParseInt(process.env.DEBATE_WEIGHT_DATA, 25),
            logic: safeParseInt(process.env.DEBATE_WEIGHT_LOGIC, 25),
            risk: safeParseInt(process.env.DEBATE_WEIGHT_RISK, 25),
            catalyst: safeParseInt(process.env.DEBATE_WEIGHT_CATALYST, 25),
        },

        // Minimum argument length (chars)
        minArgumentLength: safeParseInt(process.env.DEBATE_MIN_ARGUMENT_LENGTH, 100),

        // Turn delay (ms) between turns to avoid rate limiting
        turnDelayMs: safeParseInt(process.env.DEBATE_TURN_DELAY_MS, 300),
    },

    // Trading - General
    trading: {
        maxPositionSize: safeParseFloat(process.env.MAX_POSITION_SIZE, 0.2),
        maxTotalInvested: safeParseFloat(process.env.MAX_TOTAL_INVESTED, 0.8),
        maxDailyTrades: safeParseInt(process.env.MAX_DAILY_TRADES, 20),
        drawdownPauseThreshold: safeParseFloat(process.env.DRAWDOWN_PAUSE_THRESHOLD, 0.3),
        drawdownLiquidateThreshold: safeParseFloat(process.env.DRAWDOWN_LIQUIDATE_THRESHOLD, 0.5),
    },

    // Autonomous Trading Engine
    autonomous: {
        // Timing
        cycleIntervalMs: safeParseInt(process.env.CYCLE_INTERVAL_MS, 10 * 60 * 1000),          // 10 min between cycles
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
        stopLossRequirements: {
            VALUE: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_VALUE, 10))),
            GROWTH: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_GROWTH, 10))),
            TECHNICAL: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_TECHNICAL, 8))),
            MACRO: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_MACRO, 10))),
            SENTIMENT: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_SENTIMENT, 10))),
            RISK: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_RISK, 8))),
            QUANT: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_QUANT, 10))),
            CONTRARIAN: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_CONTRARIAN, 8)))
        },
        stopLossEnforcementMultiplier: Math.max(1, safeParseFloat(process.env.STOP_LOSS_ENFORCEMENT_MULTIPLIER, 1)),
        maxConcurrentPositions: Math.max(1, safeParseInt(process.env.MAX_CONCURRENT_POSITIONS, 3)),
        weeklyDrawdownLimitPercent: Math.max(0, safeParseFloat(process.env.WEEKLY_DRAWDOWN_LIMIT_PERCENT, 10)),
        maxFundingAgainstPercent: Math.max(0, safeParseFloat(process.env.MAX_FUNDING_AGAINST_PERCENT, 0.05)),
        maxSameDirectionPositions: Math.max(1, safeParseInt(process.env.MAX_SAME_DIRECTION_POSITIONS, 2)),
        maxRiskPerTradePercent: Math.max(0, safeParseFloat(process.env.MAX_RISK_PER_TRADE_PERCENT, 2)),
        maxConcurrentRiskPercent: Math.max(0, safeParseFloat(process.env.MAX_CONCURRENT_RISK_PERCENT, 5)),
        netExposureLimits: {
            LONG: Math.max(0, safeParseFloat(process.env.NET_EXPOSURE_LONG_PERCENT, 60)),
            SHORT: Math.max(0, safeParseFloat(process.env.NET_EXPOSURE_SHORT_PERCENT, 50))
        },
        fundingWarnThresholdPercent: Math.max(0, safeParseFloat(process.env.FUNDING_WARN_THRESHOLD_PERCENT, 0.01)),
        maxSectorPositions: Math.max(1, safeParseInt(process.env.MAX_SECTOR_POSITIONS, 3)),

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

// CRITICAL FIX: Normalize debate score weights to always sum to 100
config.debate.scoreWeights = normalizeScoreWeights(config.debate.scoreWeights);

// CRITICAL: Final validation that weights sum to exactly 100 after normalization
const finalSum = config.debate.scoreWeights.data +
    config.debate.scoreWeights.logic +
    config.debate.scoreWeights.risk +
    config.debate.scoreWeights.catalyst;

if (finalSum !== 100) {
    // This should never happen, but if it does, it's a critical bug in normalizeScoreWeights
    throw new Error(
        `CRITICAL BUG: Score weights normalization failed. Final sum is ${finalSum}, not 100. ` +
        `Weights: data=${config.debate.scoreWeights.data}, logic=${config.debate.scoreWeights.logic}, ` +
        `risk=${config.debate.scoreWeights.risk}, catalyst=${config.debate.scoreWeights.catalyst}`
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

    // Validate WEEX credentials if autonomous trading is enabled
    if (!config.autonomous.dryRun) {
        const weexRequired = ['WEEX_API_KEY', 'WEEX_SECRET_KEY', 'WEEX_PASSPHRASE'];
        const weexMissing = weexRequired.filter(key => !process.env[key]);
        if (weexMissing.length > 0) {
            console.warn(`⚠️ WEEX credentials missing: ${weexMissing.join(', ')}. Autonomous trading will fail.`);
        }
    }

    // Validate Gemini API key
    if (!config.geminiApiKey) {
        console.warn('⚠️ GEMINI_API_KEY not set. AI analysis will fail.');
    }
}
