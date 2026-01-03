import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

// Load .env from project root using reliable path resolution
const envPaths = [
    path.resolve(__dirname, '../../.env'),        // From src/config or dist/config → project root
    path.resolve(process.cwd(), '.env'),          // Fallback: current working directory
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

    // Gemini / AI
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
        debateMaxTokens: safeParseInt(process.env.AI_DEBATE_MAX_TOKENS, 8192),
        specialistMaxTokens: safeParseInt(process.env.AI_SPECIALIST_MAX_TOKENS, 8192),
        maxPromptLines: safeParseInt(process.env.AI_MAX_PROMPT_LINES, 250),
        temperature: safeParseFloat(process.env.AI_TEMPERATURE, 0.8),
        requestTimeoutMs: safeParseInt(process.env.AI_REQUEST_TIMEOUT_MS, 60000),
        maxRetries: safeParseInt(process.env.AI_MAX_RETRIES, 3),
        // Analysis-specific timeout (longer for detailed analysis)
        // VALIDATION: Must be <= maxTimeoutMs
        analysisTimeoutMs: Math.min(
            safeParseInt(process.env.AI_ANALYSIS_TIMEOUT_MS, 90000),
            safeParseInt(process.env.AI_MAX_TIMEOUT_MS, 300000)
        ),
        // Maximum timeout cap to prevent indefinite hangs
        maxTimeoutMs: safeParseInt(process.env.AI_MAX_TIMEOUT_MS, 300000),
    },

    // Debate Configuration
    debate: {
        // Turn counts (3-way debates: 3 analysts × turnsPerAnalyst, championship: 4 analysts × turnsPerAnalyst)
        turnsPerAnalyst: safeParseInt(process.env.DEBATE_TURNS_PER_ANALYST, 2),
        // Derived: 3-way = 3 × 2 = 6 turns, championship = 4 × 2 = 8 turns

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
        startingBalance: safeParseFloat(process.env.STARTING_BALANCE, 1000), // Starting balance for P&L tracking
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

        // Risk management
        // WARNING: High leverage significantly increases liquidation risk
        // At 5x leverage, a 20% adverse move = liquidation
        // MAX_SAFE_LEVERAGE (5x) is enforced - config cannot exceed this
        maxPositionSizePercent: Math.min(100, Math.max(1, safeParseFloat(process.env.MAX_POSITION_SIZE_PERCENT, 30))),     // Max 30% per position (default)
        minBalanceToTrade: Math.max(0, safeParseFloat(process.env.MIN_BALANCE_TO_TRADE, 10)),                              // Min $10 to trade
        maxLeverage: (() => {
            const requested = safeParseInt(process.env.MAX_LEVERAGE, 5);
            const clamped = Math.min(5, Math.max(1, requested));
            // CRITICAL: Enforce MAX_SAFE_LEVERAGE - log error if user tries to exceed it
            if (requested > 5) {
                console.error(
                    `❌ ERROR: MAX_LEVERAGE=${requested}x exceeds MAX_SAFE_LEVERAGE (5x). ` +
                    `Clamped to 5x for safety. Increasing leverage requires risk assessment and stakeholder sign-off.`
                );
            }
            return clamped;
        })(),                                  // Max 5x leverage (capped at MAX_SAFE_LEVERAGE)
        defaultLeverage: 0, // Will be set below to ensure it never exceeds maxLeverage
        stopLossPercent: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_PERCENT, 5))),                   // 5% stop loss (safe for 5x leverage)
        takeProfitPercent: Math.min(1000, Math.max(0.1, safeParseFloat(process.env.TAKE_PROFIT_PERCENT, 15))),             // 15% take profit
        stopLossRequirements: {
            VALUE: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_VALUE, 5))),
            GROWTH: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_GROWTH, 5))),
            TECHNICAL: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_TECHNICAL, 4))),
            MACRO: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_MACRO, 5))),
            SENTIMENT: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_SENTIMENT, 5))),
            RISK: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_RISK, 4))),
            QUANT: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_QUANT, 5))),
            CONTRARIAN: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_CONTRARIAN, 4)))
        },
        stopLossEnforcementMultiplier: Math.max(1, safeParseFloat(process.env.STOP_LOSS_ENFORCEMENT_MULTIPLIER, 1)),
        maxConcurrentPositions: Math.max(1, safeParseInt(process.env.MAX_CONCURRENT_POSITIONS, 3)),
        weeklyDrawdownLimitPercent: Math.max(0, safeParseFloat(process.env.WEEKLY_DRAWDOWN_LIMIT_PERCENT, 10)),
        // MAX_FUNDING_AGAINST_BPS: Maximum funding rate against position per 8h period
        // Input: basis points (1 bp = 0.01%, so 5 = 0.05%)
        // Stored as: decimal (e.g., 0.0005 = 0.05% = 5 bps)
        // WEEX funding rates are in decimal form (e.g., 0.0001 = 0.01% = 1 bp)
        // Typical funding rates: 1-10 bps per 8h (0.0001 to 0.001 decimal)
        // Default 5 bps = 0.0005 decimal = 0.05% (conservative)
        maxFundingAgainstPercent: (() => {
            const bps = safeParseInt(process.env.MAX_FUNDING_AGAINST_BPS, 5);
            // Validate BPS is in reasonable range (0-100 bps = 0-1%)
            if (bps < 0 || bps > 100) {
                console.warn(
                    `⚠️ MAX_FUNDING_AGAINST_BPS=${bps} is out of range (0-100 bps). ` +
                    `Clamping to safe range. Typical values: 3-10 bps.`
                );
            }
            const clampedBps = Math.max(0, Math.min(100, bps));
            // Convert basis points to decimal: 5 bps → 0.0005
            // 1 bp = 0.01% = 0.0001 decimal
            return clampedBps / 10000;
        })(),
        maxSameDirectionPositions: Math.max(1, safeParseInt(process.env.MAX_SAME_DIRECTION_POSITIONS, 2)),
        maxRiskPerTradePercent: Math.max(0, safeParseFloat(process.env.MAX_RISK_PER_TRADE_PERCENT, 2)),
        maxConcurrentRiskPercent: Math.max(0, safeParseFloat(process.env.MAX_CONCURRENT_RISK_PERCENT, 5)),
        netExposureLimits: {
            // Net exposure = total margin used (not notional value)
            // With max 10% per position (maxPositionSizePercent) and max 3 concurrent positions, theoretical max is 30%
            // But we allow up to 60% LONG / 50% SHORT for flexibility (allows ~6 positions at 10% each, or ~2 at 30% each)
            LONG: Math.max(0, safeParseFloat(process.env.NET_EXPOSURE_LONG_PERCENT, 60)),
            SHORT: Math.max(0, safeParseFloat(process.env.NET_EXPOSURE_SHORT_PERCENT, 50))
        },
        // Funding rate warning threshold (decimal form, same scale as maxFundingAgainstPercent)
        // Input: basis points (1 bp = 0.01%)
        // Default 1 bp = 0.0001 decimal = 0.01% per 8h
        fundingWarnThresholdPercent: (() => {
            const bps = safeParseInt(process.env.FUNDING_WARN_THRESHOLD_BPS, 1);
            // Validate BPS is in reasonable range (0-100 bps = 0-1%)
            if (bps < 0 || bps > 100) {
                console.warn(
                    `⚠️ FUNDING_WARN_THRESHOLD_BPS=${bps} is out of range (0-100 bps). ` +
                    `Clamping to safe range. Typical values: 1-5 bps.`
                );
            }
            const clampedBps = Math.max(0, Math.min(100, bps));
            // Convert basis points to decimal: 1 bp → 0.0001
            return clampedBps / 10000;
        })(),
        maxSectorPositions: Math.max(1, safeParseInt(process.env.MAX_SECTOR_POSITIONS, 3)),

        // Circuit breakers
        enableCircuitBreakers: process.env.ENABLE_CIRCUIT_BREAKERS !== 'false',                // Enabled by default
        circuitBreakerCheckIntervalMs: safeParseInt(process.env.CIRCUIT_BREAKER_CHECK_INTERVAL_MS, 60000), // Check every minute
        circuitBreakerCacheDurationMs: safeParseInt(process.env.CIRCUIT_BREAKER_CACHE_DURATION_MS, 60000), // Cache for 1 minute

        // AI decision thresholds
        minConfidenceToTrade: safeParseInt(process.env.MIN_CONFIDENCE_TO_TRADE, 60),           // Min 60% confidence
        minConsensusToTrade: safeParseInt(process.env.MIN_CONSENSUS_TO_TRADE, 2),              // Min 2 analysts agree

        // ===========================================
        // Trading Style Configuration (Scalping vs Swing)
        // ===========================================
        // TRADING_STYLE: 'scalp' for high-frequency small profits, 'swing' for larger moves
        tradingStyle: (() => {
            const style = process.env.TRADING_STYLE || 'scalp';
            if (style !== 'scalp' && style !== 'swing') {
                console.warn(
                    `⚠️ Invalid TRADING_STYLE: "${style}". ` +
                    `Valid values are 'scalp' or 'swing'. Defaulting to 'scalp'.`
                );
                return 'scalp' as const;
            }
            return style as 'scalp' | 'swing';
        })(),

        // Scalping parameters (used when TRADING_STYLE=scalp)
        scalp: {
            // Target profit percentage (default 5% for scalping)
            targetProfitPercent: Math.min(50, Math.max(1, safeParseFloat(process.env.SCALP_TARGET_PROFIT_PERCENT, 5))),
            // Stop loss percentage (default 3% for tight risk)
            stopLossPercent: Math.min(20, Math.max(0.5, safeParseFloat(process.env.SCALP_STOP_LOSS_PERCENT, 3))),
            // Max hold time in hours before forcing review (default 12h)
            maxHoldHours: Math.max(1, safeParseInt(process.env.SCALP_MAX_HOLD_HOURS, 12)),
            // Take profit thresholds (when to start taking partial profits)
            takeProfitThreshold1: Math.max(0.5, safeParseFloat(process.env.SCALP_TP_THRESHOLD_1, 2)),  // Move stop to breakeven
            takeProfitThreshold2: Math.max(1, safeParseFloat(process.env.SCALP_TP_THRESHOLD_2, 3)),    // Take 25% profits
            takeProfitThreshold3: Math.max(2, safeParseFloat(process.env.SCALP_TP_THRESHOLD_3, 5)),    // Take 50% profits
            takeProfitThreshold4: Math.max(3, safeParseFloat(process.env.SCALP_TP_THRESHOLD_4, 7)),    // Take 75% profits
            // Minimum R/R ratio acceptable for scalps (can be lower than swing)
            minRiskRewardRatio: Math.max(1, safeParseFloat(process.env.SCALP_MIN_RR_RATIO, 1.5)),
        },

        // Swing trading parameters (used when TRADING_STYLE=swing)
        swing: {
            // Target profit percentage (default 10% for swing)
            targetProfitPercent: Math.min(100, Math.max(5, safeParseFloat(process.env.SWING_TARGET_PROFIT_PERCENT, 10))),
            // Stop loss percentage (default 5% for swing)
            stopLossPercent: Math.min(30, Math.max(2, safeParseFloat(process.env.SWING_STOP_LOSS_PERCENT, 5))),
            // Max hold time in hours before forcing review (default 48h)
            maxHoldHours: Math.max(12, safeParseInt(process.env.SWING_MAX_HOLD_HOURS, 48)),
            // Take profit thresholds
            takeProfitThreshold1: Math.max(2, safeParseFloat(process.env.SWING_TP_THRESHOLD_1, 3)),    // Move stop to breakeven
            takeProfitThreshold2: Math.max(3, safeParseFloat(process.env.SWING_TP_THRESHOLD_2, 5)),    // Take 25% profits
            takeProfitThreshold3: Math.max(5, safeParseFloat(process.env.SWING_TP_THRESHOLD_3, 8)),    // Take 50% profits
            takeProfitThreshold4: Math.max(7, safeParseFloat(process.env.SWING_TP_THRESHOLD_4, 10)),   // Take 75% profits
            // Minimum R/R ratio for swing trades
            minRiskRewardRatio: Math.max(1.5, safeParseFloat(process.env.SWING_MIN_RR_RATIO, 2)),
        },

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

// Validate parameter interdependencies
const interdependencyWarnings: string[] = [];

// MAX_SAME_DIRECTION_POSITIONS must be <= MAX_CONCURRENT_POSITIONS
if (config.autonomous.maxSameDirectionPositions > config.autonomous.maxConcurrentPositions) {
    interdependencyWarnings.push(
        `MAX_SAME_DIRECTION_POSITIONS (${config.autonomous.maxSameDirectionPositions}) > ` +
        `MAX_CONCURRENT_POSITIONS (${config.autonomous.maxConcurrentPositions}). ` +
        `This is logically impossible - clamping to ${config.autonomous.maxConcurrentPositions}.`
    );
    config.autonomous.maxSameDirectionPositions = config.autonomous.maxConcurrentPositions;
}

// MAX_CONCURRENT_RISK_PERCENT should be >= MAX_RISK_PER_TRADE_PERCENT × MAX_CONCURRENT_POSITIONS
const minConcurrentRisk = config.autonomous.maxRiskPerTradePercent * config.autonomous.maxConcurrentPositions;
if (config.autonomous.maxConcurrentRiskPercent < minConcurrentRisk) {
    interdependencyWarnings.push(
        `MAX_CONCURRENT_RISK_PERCENT (${config.autonomous.maxConcurrentRiskPercent}%) < ` +
        `MAX_RISK_PER_TRADE (${config.autonomous.maxRiskPerTradePercent}%) × MAX_CONCURRENT_POSITIONS (${config.autonomous.maxConcurrentPositions}) = ${minConcurrentRisk}%. ` +
        `This may prevent opening max positions. Consider increasing MAX_CONCURRENT_RISK_PERCENT to ${minConcurrentRisk}% or higher.`
    );
}

// WEEKLY_DRAWDOWN_LIMIT_PERCENT should be < DRAWDOWN_LIQUIDATE_THRESHOLD (converted to %)
const liquidateThresholdPercent = config.trading.drawdownLiquidateThreshold * 100;
if (config.autonomous.weeklyDrawdownLimitPercent >= liquidateThresholdPercent) {
    interdependencyWarnings.push(
        `WEEKLY_DRAWDOWN_LIMIT_PERCENT (${config.autonomous.weeklyDrawdownLimitPercent}%) >= ` +
        `DRAWDOWN_LIQUIDATE_THRESHOLD (${liquidateThresholdPercent}%). ` +
        `Weekly limit should trigger before liquidation threshold.`
    );
}

// Log all interdependency warnings
if (interdependencyWarnings.length > 0) {
    console.warn('\n⚠️ Configuration Interdependency Warnings:');
    interdependencyWarnings.forEach((warning, i) => {
        console.warn(`  ${i + 1}. ${warning}`);
    });
    console.warn('');
}

// Validate and ENFORCE trading style take profit thresholds are in ascending order
function validateAndEnforceTakeProfitThresholds(style: 'scalp' | 'swing') {
    const cfg = style === 'scalp' ? config.autonomous.scalp : config.autonomous.swing;
    const thresholds = [
        cfg.takeProfitThreshold1,
        cfg.takeProfitThreshold2,
        cfg.takeProfitThreshold3,
        cfg.takeProfitThreshold4
    ];

    // Define bounds based on style
    const minThreshold = 0.5;
    const maxThreshold = style === 'scalp' ? 50 : 100; // Match the Math.min bounds in config
    const minGap = 0.5; // Minimum gap between thresholds for strict ascending order

    // STEP 1: Pre-clamp all thresholds to valid range BEFORE ascending order correction
    // This ensures the correction logic works with valid values
    for (let i = 0; i < thresholds.length; i++) {
        thresholds[i] = Math.min(maxThreshold, Math.max(minThreshold, thresholds[i]));
    }

    // STEP 2: ENFORCE strict ascending order by adjusting invalid thresholds
    let needsCorrection = false;
    let hitCeiling = false;

    for (let i = 1; i < thresholds.length; i++) {
        if (thresholds[i] <= thresholds[i - 1]) {
            needsCorrection = true;

            // Calculate candidate value: previous + minGap
            const candidate = thresholds[i - 1] + minGap;

            // Check if we can maintain strict ascending order within bounds
            if (candidate <= maxThreshold) {
                thresholds[i] = candidate;
            } else {
                // Cannot maintain strict ascending order - hit ceiling
                // Set to maxThreshold (will be equal to or less than previous)
                thresholds[i] = maxThreshold;
                hitCeiling = true;
            }
        }
    }

    // STEP 3: Apply corrected values back to config
    cfg.takeProfitThreshold1 = thresholds[0];
    cfg.takeProfitThreshold2 = thresholds[1];
    cfg.takeProfitThreshold3 = thresholds[2];
    cfg.takeProfitThreshold4 = thresholds[3];

    // STEP 4: Log appropriate warnings
    if (hitCeiling) {
        // Critical warning: could not maintain strict ascending order due to ceiling
        console.error(
            `❌ ${style.toUpperCase()} take profit thresholds could NOT be corrected to strict ascending order. ` +
            `One or more thresholds hit the maximum (${maxThreshold}%). ` +
            `Final values: TP1=${thresholds[0]}%, TP2=${thresholds[1]}%, TP3=${thresholds[2]}%, TP4=${thresholds[3]}%. ` +
            `This may cause unexpected profit-taking behavior. Please adjust your .env configuration.`
        );
    } else if (needsCorrection) {
        console.warn(
            `⚠️ ${style.toUpperCase()} take profit thresholds were not in ascending order. ` +
            `ENFORCED strict ascending order: TP1=${thresholds[0]}%, TP2=${thresholds[1]}%, ` +
            `TP3=${thresholds[2]}%, TP4=${thresholds[3]}%.`
        );
    }

    // Warn if target profit is less than the highest threshold
    if (cfg.targetProfitPercent < cfg.takeProfitThreshold4) {
        console.warn(
            `⚠️ ${style.toUpperCase()} target profit (${cfg.targetProfitPercent}%) is less than ` +
            `TP threshold 4 (${cfg.takeProfitThreshold4}%). ` +
            `Positions may close before reaching the 75% profit-taking threshold.`
        );
    }
}

validateAndEnforceTakeProfitThresholds('scalp');
validateAndEnforceTakeProfitThresholds('swing');

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
    // Check if Turso is being used (TURSO_DATABASE_URL is set)
    const useTurso = Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_DATABASE_URL.startsWith('libsql://'));

    const required = useTurso
        ? ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN']
        : ['DATABASE_URL'];
    const missing = required.filter(key => !process.env[key]);

    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    // Validate WEEX credentials if autonomous trading is enabled
    if (!config.autonomous.dryRun) {
        const weexRequired = ['WEEX_API_KEY', 'WEEX_SECRET_KEY', 'WEEX_PASSPHRASE'];
        const weexMissing = weexRequired.filter(key => !process.env[key]);
        if (weexMissing.length > 0) {
            console.warn(`⚠️ WEEX credentials missing: ${weexMissing.join(', ')}. Autonomous trading will fail.`);
        }
    }

    // Validate AI provider API keys
    if (config.ai.provider === 'gemini' && !config.geminiApiKey) {
        console.warn('⚠️ GEMINI_API_KEY not set. AI analysis will fail.');
    }
    if (config.ai.provider === 'openrouter' && !config.openRouterApiKey) {
        console.warn('⚠️ OPENROUTER_API_KEY not set. AI analysis will fail.');
    }
}

/**
 * Get the active trading style configuration based on TRADING_STYLE env var
 * Returns either scalp or swing config with all parameters
 */
export function getActiveTradingStyle() {
    const style = config.autonomous.tradingStyle;
    const styleConfig = style === 'scalp' ? config.autonomous.scalp : config.autonomous.swing;

    return {
        style,
        targetProfitPercent: styleConfig.targetProfitPercent,
        stopLossPercent: styleConfig.stopLossPercent,
        maxHoldHours: styleConfig.maxHoldHours,
        takeProfitThresholds: {
            breakeven: styleConfig.takeProfitThreshold1,
            partial25: styleConfig.takeProfitThreshold2,
            partial50: styleConfig.takeProfitThreshold3,
            partial75: styleConfig.takeProfitThreshold4,
        },
        minRiskRewardRatio: styleConfig.minRiskRewardRatio,
        // Derived values
        maxHoldDays: styleConfig.maxHoldHours / 24,
        isScalping: style === 'scalp',
    };
}
