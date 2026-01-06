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
    return isNaN(parsed) ? fallback : parsed;
};

// Safe parseFloat with fallback
const safeParseFloat = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
};

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
        // Recommended: deepseek/deepseek-chat (DeepSeek V3)
        // Other options: deepseek/deepseek-r1, qwen/qwen-2.5-72b-instruct
        openRouterModel: process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat',
        maxOutputTokens: safeParseInt(process.env.AI_MAX_OUTPUT_TOKENS, 8192),
        temperature: safeParseFloat(process.env.AI_TEMPERATURE, 0.8),
        requestTimeoutMs: safeParseInt(process.env.AI_REQUEST_TIMEOUT_MS, 60000),
        maxRetries: safeParseInt(process.env.AI_MAX_RETRIES, 3),
        analysisTimeoutMs: Math.min(
            safeParseInt(process.env.AI_ANALYSIS_TIMEOUT_MS, 90000),
            safeParseInt(process.env.AI_MAX_TIMEOUT_MS, 300000)
        ),
        maxTimeoutMs: safeParseInt(process.env.AI_MAX_TIMEOUT_MS, 300000),
    },

    // Trading - General
    trading: {
        startingBalance: safeParseFloat(process.env.STARTING_BALANCE, 1000),
        maxDailyTrades: safeParseInt(process.env.MAX_DAILY_TRADES, 20),
    },

    // Autonomous Trading Engine
    autonomous: {
        // Timing
        cycleIntervalMs: safeParseInt(process.env.CYCLE_INTERVAL_MS, 10 * 60 * 1000),
        minTradeIntervalMs: safeParseInt(process.env.MIN_TRADE_INTERVAL_MS, 15 * 60 * 1000),

        // Risk management
        maxPositionSizePercent: Math.min(100, Math.max(1, safeParseFloat(process.env.MAX_POSITION_SIZE_PERCENT, 30))),
        minBalanceToTrade: Math.max(0, safeParseFloat(process.env.MIN_BALANCE_TO_TRADE, 10)),
        maxLeverage: (() => {
            const requested = safeParseInt(process.env.MAX_LEVERAGE, 5);
            const clamped = Math.min(10, Math.max(1, requested));
            if (requested > 10) {
                console.error(`❌ ERROR: MAX_LEVERAGE=${requested}x exceeds MAX_SAFE_LEVERAGE (10x). Clamped to 10x.`);
            }
            return clamped;
        })(),
        defaultLeverage: (() => {
            // Initialize with a valid default, will be validated against maxLeverage below
            const requested = safeParseInt(process.env.DEFAULT_LEVERAGE, 5);
            return Math.min(10, Math.max(1, requested));
        })(),
        stopLossPercent: Math.min(100, Math.max(0.1, safeParseFloat(process.env.STOP_LOSS_PERCENT, 5))),
        takeProfitPercent: Math.min(1000, Math.max(0.1, safeParseFloat(process.env.TAKE_PROFIT_PERCENT, 15))),
        maxConcurrentPositions: Math.max(1, safeParseInt(process.env.MAX_CONCURRENT_POSITIONS, 3)),
        weeklyDrawdownLimitPercent: Math.max(0, safeParseFloat(process.env.WEEKLY_DRAWDOWN_LIMIT_PERCENT, 10)),
        maxFundingAgainstPercent: (() => {
            const bps = safeParseInt(process.env.MAX_FUNDING_AGAINST_BPS, 5);
            const clampedBps = Math.max(0, Math.min(100, bps));
            return clampedBps / 10000;
        })(),
        maxSameDirectionPositions: Math.max(1, safeParseInt(process.env.MAX_SAME_DIRECTION_POSITIONS, 2)),
        maxRiskPerTradePercent: Math.max(0, safeParseFloat(process.env.MAX_RISK_PER_TRADE_PERCENT, 2)),
        maxConcurrentRiskPercent: Math.max(0, safeParseFloat(process.env.MAX_CONCURRENT_RISK_PERCENT, 5)),
        netExposureLimits: {
            LONG: Math.max(0, safeParseFloat(process.env.NET_EXPOSURE_LONG_PERCENT, 60)),
            SHORT: Math.max(0, safeParseFloat(process.env.NET_EXPOSURE_SHORT_PERCENT, 50))
        },
        maxSectorPositions: Math.max(1, safeParseInt(process.env.MAX_SECTOR_POSITIONS, 3)),

        // AI decision thresholds
        // Confidence must be 0-100 (percentage)
        minConfidenceToTrade: (() => {
            const value = safeParseInt(process.env.MIN_CONFIDENCE_TO_TRADE, 50);
            if (value < 0 || value > 100) {
                console.warn(`⚠️ MIN_CONFIDENCE_TO_TRADE (${value}) out of valid range [0-100]. Using default 50.`);
                return 50;
            }
            return value;
        })(),

        // Trading Style
        tradingStyle: (() => {
            const style = process.env.TRADING_STYLE || 'scalp';
            if (style !== 'scalp' && style !== 'swing') {
                console.warn(`⚠️ Invalid TRADING_STYLE: "${style}". Defaulting to 'scalp'.`);
                return 'scalp' as const;
            }
            return style as 'scalp' | 'swing';
        })(),

        // Scalping parameters
        scalp: {
            targetProfitPercent: Math.min(50, Math.max(1, safeParseFloat(process.env.SCALP_TARGET_PROFIT_PERCENT, 5))),
            stopLossPercent: Math.min(20, Math.max(0.5, safeParseFloat(process.env.SCALP_STOP_LOSS_PERCENT, 3))),
            maxHoldHours: Math.max(1, safeParseInt(process.env.SCALP_MAX_HOLD_HOURS, 12)),
            takeProfitThreshold1: Math.max(0.5, safeParseFloat(process.env.SCALP_TP_THRESHOLD_1, 2)),
            takeProfitThreshold2: Math.max(1, safeParseFloat(process.env.SCALP_TP_THRESHOLD_2, 3)),
            takeProfitThreshold3: Math.max(2, safeParseFloat(process.env.SCALP_TP_THRESHOLD_3, 5)),
            takeProfitThreshold4: Math.max(3, safeParseFloat(process.env.SCALP_TP_THRESHOLD_4, 7)),
            minRiskRewardRatio: Math.max(1, safeParseFloat(process.env.SCALP_MIN_RR_RATIO, 1.5)),
        },

        // Swing trading parameters
        swing: {
            targetProfitPercent: Math.min(100, Math.max(5, safeParseFloat(process.env.SWING_TARGET_PROFIT_PERCENT, 10))),
            stopLossPercent: Math.min(30, Math.max(2, safeParseFloat(process.env.SWING_STOP_LOSS_PERCENT, 5))),
            maxHoldHours: Math.max(12, safeParseInt(process.env.SWING_MAX_HOLD_HOURS, 48)),
            takeProfitThreshold1: Math.max(2, safeParseFloat(process.env.SWING_TP_THRESHOLD_1, 3)),
            takeProfitThreshold2: Math.max(3, safeParseFloat(process.env.SWING_TP_THRESHOLD_2, 5)),
            takeProfitThreshold3: Math.max(5, safeParseFloat(process.env.SWING_TP_THRESHOLD_3, 8)),
            takeProfitThreshold4: Math.max(7, safeParseFloat(process.env.SWING_TP_THRESHOLD_4, 10)),
            minRiskRewardRatio: Math.max(1.5, safeParseFloat(process.env.SWING_MIN_RR_RATIO, 2)),
        },

        maxRetries: safeParseInt(process.env.MAX_RETRIES, 3),
        dryRun: process.env.DRY_RUN === 'true',
    },

    // Compliance
    requireAILogs: process.env.REQUIRE_AI_LOGS === 'true',

    // Technical Indicators
    indicators: {
        // Cache TTL must be positive (minimum 1000ms to avoid excessive API calls)
        cacheTTL: (() => {
            const value = safeParseInt(process.env.INDICATOR_CACHE_TTL_MS, 60000);
            if (value < 1000) {
                console.warn(`⚠️ INDICATOR_CACHE_TTL_MS (${value}ms) is too low, using minimum 1000ms`);
                return 1000;
            }
            if (value > 300000) {
                console.warn(`⚠️ INDICATOR_CACHE_TTL_MS (${value}ms) is very high, indicators may be stale`);
            }
            return value;
        })(),
        // Candle limits must be positive and reasonable
        candleLimit5m: (() => {
            const value = safeParseInt(process.env.INDICATOR_CANDLE_LIMIT_5M, 100);
            if (value < 50) {
                console.warn(`⚠️ INDICATOR_CANDLE_LIMIT_5M (${value}) is too low for accurate indicators, using minimum 50`);
                return 50;
            }
            if (value > 1000) {
                console.warn(`⚠️ INDICATOR_CANDLE_LIMIT_5M (${value}) is very high, may impact performance`);
            }
            return value;
        })(),
        candleLimit4h: (() => {
            const value = safeParseInt(process.env.INDICATOR_CANDLE_LIMIT_4H, 200);
            if (value < 200) {
                console.warn(`⚠️ INDICATOR_CANDLE_LIMIT_4H (${value}) is too low for EMA200, using minimum 200`);
                return 200;
            }
            if (value > 2000) {
                console.warn(`⚠️ INDICATOR_CANDLE_LIMIT_4H (${value}) is very high, may impact performance`);
            }
            return value;
        })(),
    },

    // Anti-Churn Configuration
    antiChurn: {
        // Cooldown times must be non-negative
        cooldownAfterTradeMs: Math.max(0, safeParseInt(process.env.COOLDOWN_AFTER_TRADE_MS, 900000)),
        cooldownBeforeFlipMs: Math.max(0, safeParseInt(process.env.COOLDOWN_BEFORE_FLIP_MS, 1800000)),
        // Max trades per day must be at least 1
        maxTradesPerDay: Math.max(1, safeParseInt(process.env.MAX_TRADES_PER_DAY, 10)),
        // Hysteresis multiplier must be >= 1.0 (1.0 = no hysteresis)
        hysteresisMultiplier: (() => {
            const value = safeParseFloat(process.env.HYSTERESIS_MULTIPLIER, 1.2);
            if (value < 1.0) {
                console.warn(`⚠️ HYSTERESIS_MULTIPLIER (${value}) must be >= 1.0, using 1.0`);
                return 1.0;
            }
            if (value > 3.0) {
                console.warn(`⚠️ HYSTERESIS_MULTIPLIER (${value}) is very high, may prevent closing positions`);
            }
            return value;
        })(),
        // Funding periods per day: WEEX/Binance/Bybit/OKX = 3 (8-hour), dYdX = 24 (1-hour)
        // Valid range: 1-24 (1 = daily funding, 24 = hourly funding)
        fundingPeriodsPerDay: (() => {
            const value = safeParseInt(process.env.FUNDING_PERIODS_PER_DAY, 3);
            if (value < 1 || value > 24) {
                console.warn(`⚠️ FUNDING_PERIODS_PER_DAY (${value}) out of valid range [1-24]. Using default 3.`);
                return 3;
            }
            return value;
        })(),
    },
};

// Validate defaultLeverage never exceeds maxLeverage
if (config.autonomous.defaultLeverage > config.autonomous.maxLeverage) {
    console.warn(`⚠️ DEFAULT_LEVERAGE (${config.autonomous.defaultLeverage}x) exceeds MAX_LEVERAGE (${config.autonomous.maxLeverage}x). Clamping to ${config.autonomous.maxLeverage}x.`);
    config.autonomous.defaultLeverage = config.autonomous.maxLeverage;
}

// Validate interdependencies
if (config.autonomous.maxSameDirectionPositions > config.autonomous.maxConcurrentPositions) {
    console.warn(`⚠️ MAX_SAME_DIRECTION_POSITIONS clamped to ${config.autonomous.maxConcurrentPositions}.`);
    config.autonomous.maxSameDirectionPositions = config.autonomous.maxConcurrentPositions;
}

// Validate take profit thresholds
function validateTakeProfitThresholds(style: 'scalp' | 'swing'): boolean {
    const cfg = style === 'scalp' ? config.autonomous.scalp : config.autonomous.swing;
    const thresholds = [cfg.takeProfitThreshold1, cfg.takeProfitThreshold2, cfg.takeProfitThreshold3, cfg.takeProfitThreshold4];
    const maxThreshold = style === 'scalp' ? 50 : 100;
    const minGap = 0.5;
    let hasErrors = false;

    // First pass: clamp all values to valid range
    for (let i = 0; i < thresholds.length; i++) {
        thresholds[i] = Math.min(maxThreshold, Math.max(0.5, thresholds[i]));
    }

    // Second pass: enforce strictly ascending order while respecting maxThreshold
    for (let i = 1; i < thresholds.length; i++) {
        // Ensure strictly greater than previous (not equal)
        const minRequired = thresholds[i - 1] + minGap;
        if (thresholds[i] <= thresholds[i - 1]) {
            const newValue = minRequired;
            // Clamp to maxThreshold to prevent exceeding bounds
            thresholds[i] = Math.min(maxThreshold, newValue);
            // If we hit the ceiling, warn and keep the clamped value
            if (newValue > maxThreshold) {
                console.warn(`⚠️ ${style} takeProfitThreshold${i + 1} clamped to ${maxThreshold} (would exceed max)`);
            }
        }
    }

    // Final validation: check for duplicates caused by ceiling clamping
    // FIXED: Duplicates indicate invalid configuration that cannot be auto-corrected
    const uniqueThresholds = new Set(thresholds);
    if (uniqueThresholds.size !== thresholds.length) {
        console.error(`❌ ERROR: ${style} take profit thresholds contain duplicates after validation: [${thresholds.join(', ')}]. This occurs when input values are too close to the maximum (${maxThreshold}). Consider using smaller threshold values to maintain distinct levels.`);
        hasErrors = true;
    }

    cfg.takeProfitThreshold1 = thresholds[0];
    cfg.takeProfitThreshold2 = thresholds[1];
    cfg.takeProfitThreshold3 = thresholds[2];
    cfg.takeProfitThreshold4 = thresholds[3];

    return !hasErrors;
}

const scalpThresholdsValid = validateTakeProfitThresholds('scalp');
const swingThresholdsValid = validateTakeProfitThresholds('swing');

// Validate required config in production
if (config.nodeEnv === 'production') {
    const useTurso = Boolean(process.env.TURSO_DATABASE_URL?.startsWith('libsql://'));
    const required = useTurso ? ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] : ['DATABASE_URL'];
    const missing = required.filter(key => !process.env[key]);

    // FIXED: Fail startup in production if required env vars are missing
    if (missing.length > 0) {
        const errorMsg = `❌ FATAL: Missing required environment variables: ${missing.join(', ')}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Also fail if take profit thresholds are invalid (duplicates)
    if (!scalpThresholdsValid || !swingThresholdsValid) {
        const errorMsg = '❌ FATAL: Invalid take profit threshold configuration (duplicates detected)';
        console.error(errorMsg);
        throw new Error(errorMsg);
    }
}


/**
 * Get active trading style configuration
 */
export function getActiveTradingStyle() {
    const style = config.autonomous.tradingStyle;
    const styleConfig = style === 'scalp' ? config.autonomous.scalp : config.autonomous.swing;

    return {
        style,
        targetProfitPercent: styleConfig.targetProfitPercent,
        stopLossPercent: styleConfig.stopLossPercent,
        maxHoldHours: styleConfig.maxHoldHours,
        minRiskRewardRatio: styleConfig.minRiskRewardRatio,
        takeProfitThresholds: {
            breakeven: styleConfig.takeProfitThreshold1,
            partial25: styleConfig.takeProfitThreshold2,
            partial50: styleConfig.takeProfitThreshold3,
            partial75: styleConfig.takeProfitThreshold4,
        },
    };
}

/**
 * Get adaptive trading style based on market regime
 * 
 * Returns trading style parameters adjusted for the given market regime,
 * including takeProfitThresholds scaled appropriately for each regime.
 * 
 * @param regime - Market regime: 'trending', 'ranging', 'volatile', or 'calm'
 * @returns Trading style configuration with all parameters including takeProfitThresholds
 */
export function getAdaptiveTradingStyle(regime: 'trending' | 'ranging' | 'volatile' | 'calm') {
    const scalp = config.autonomous.scalp;
    const swing = config.autonomous.swing;

    switch (regime) {
        case 'trending':
            return {
                style: 'swing' as const,
                targetProfitPercent: swing.targetProfitPercent,
                stopLossPercent: swing.stopLossPercent,
                maxHoldHours: swing.maxHoldHours,
                minRiskRewardRatio: swing.minRiskRewardRatio,
                takeProfitThresholds: {
                    breakeven: swing.takeProfitThreshold1,
                    partial25: swing.takeProfitThreshold2,
                    partial50: swing.takeProfitThreshold3,
                    partial75: swing.takeProfitThreshold4,
                },
            };
        case 'volatile':
            return {
                style: 'scalp' as const,
                targetProfitPercent: scalp.targetProfitPercent * 0.8,
                stopLossPercent: scalp.stopLossPercent * 0.8,
                maxHoldHours: Math.max(1, scalp.maxHoldHours / 2),
                minRiskRewardRatio: scalp.minRiskRewardRatio,
                takeProfitThresholds: {
                    breakeven: scalp.takeProfitThreshold1 * 0.8,
                    partial25: scalp.takeProfitThreshold2 * 0.8,
                    partial50: scalp.takeProfitThreshold3 * 0.8,
                    partial75: scalp.takeProfitThreshold4 * 0.8,
                },
            };
        case 'calm':
            // Calm markets: reduced targets and stops proportionally to maintain R:R
            // Both target and stop are reduced by 30% for low volatility conditions
            // Use swing style with adjusted parameters for low volatility
            // FIXED: Cap maxHoldHours to prevent unreasonably long hold times
            const calmMaxHoldHours = Math.min(168, swing.maxHoldHours * 1.5); // Cap at 1 week (168 hours)
            return {
                style: 'swing' as const,
                targetProfitPercent: swing.targetProfitPercent * 0.7,
                stopLossPercent: swing.stopLossPercent * 0.7, // Proportionally tighter to maintain R:R
                maxHoldHours: calmMaxHoldHours,
                minRiskRewardRatio: swing.minRiskRewardRatio, // Keep original R:R requirement
                takeProfitThresholds: {
                    breakeven: swing.takeProfitThreshold1 * 0.7,
                    partial25: swing.takeProfitThreshold2 * 0.7,
                    partial50: swing.takeProfitThreshold3 * 0.7,
                    partial75: swing.takeProfitThreshold4 * 0.7,
                },
            };
        case 'ranging':
        default:
            return {
                style: 'scalp' as const,
                targetProfitPercent: scalp.targetProfitPercent,
                stopLossPercent: scalp.stopLossPercent,
                maxHoldHours: scalp.maxHoldHours,
                minRiskRewardRatio: scalp.minRiskRewardRatio,
                takeProfitThresholds: {
                    breakeven: scalp.takeProfitThreshold1,
                    partial25: scalp.takeProfitThreshold2,
                    partial50: scalp.takeProfitThreshold3,
                    partial75: scalp.takeProfitThreshold4,
                },
            };
    }
}
