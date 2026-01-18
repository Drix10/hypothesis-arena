import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

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

const safeParseInt = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseInt(value, 10);
    return (isNaN(parsed) || !Number.isFinite(parsed)) ? fallback : parsed;
};

const safeParseFloat = (value: string | undefined, fallback: number): number => {
    if (!value) return fallback;
    const parsed = parseFloat(value);
    return (isNaN(parsed) || !Number.isFinite(parsed)) ? fallback : parsed;
};

const clampInt = (value: string | undefined, fallback: number, min: number, max: number): number => {
    const parsed = safeParseInt(value, fallback);
    return Math.max(min, Math.min(max, parsed));
};

const PARSED_STARTING_BALANCE = Math.max(1, safeParseFloat(process.env.STARTING_BALANCE, 1000));

export const config = {
    port: safeParseInt(process.env.PORT, 3000),
    nodeEnv: process.env.NODE_ENV || 'development',
    logLevel: process.env.LOG_LEVEL || 'info',
    corsOrigins: process.env.CORS_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) || ['http://localhost:3000', 'http://localhost:25655'],
    databaseUrl: process.env.DATABASE_URL || 'file:./dev.db',
    tursoDatabaseUrl: process.env.TURSO_DATABASE_URL || '',
    tursoAuthToken: process.env.TURSO_AUTH_TOKEN || '',
    weex: {
        apiKey: process.env.WEEX_API_KEY || '',
        secretKey: process.env.WEEX_SECRET_KEY || '',
        passphrase: process.env.WEEX_PASSPHRASE || '',
        baseUrl: process.env.WEEX_BASE_URL || 'https://api-contract.weex.com',
        wsUrl: process.env.WEEX_WS_URL || 'wss://ws-contract.weex.com/v2/ws',
    },
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
        model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
        openRouterModel: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-haiku',
        maxOutputTokens: safeParseInt(process.env.AI_MAX_OUTPUT_TOKENS, 65536),
        temperature: Math.max(0, Math.min(2, safeParseFloat(process.env.AI_TEMPERATURE, 0.7))),
        requestTimeoutMs: Math.max(5000, safeParseInt(process.env.AI_REQUEST_TIMEOUT_MS, 60000)),
        maxRetries: clampInt(process.env.AI_MAX_RETRIES, 3, 1, 10),

        // Thinking/Reasoning configuration (for models that support it like Claude 3.7)
        thinking: {
            enabled: process.env.AI_THINKING_ENABLED === 'true',
            budgetTokens: clampInt(process.env.AI_THINKING_BUDGET, 16000, 1024, 64000),
        },

        // Hybrid AI Mode (v5.5.0) - Use both Gemini and OpenRouter simultaneously
        hybridMode: process.env.AI_HYBRID_MODE === 'true',

        // Per-analyst provider assignment (only used when hybridMode=true)
        analystProviders: {
            jim: (() => {
                const p = process.env.ANALYST_JIM_PROVIDER?.toLowerCase();
                return (p === 'gemini' || p === 'openrouter') ? p : 'openrouter';
            })() as 'gemini' | 'openrouter',
            ray: (() => {
                const p = process.env.ANALYST_RAY_PROVIDER?.toLowerCase();
                return (p === 'gemini' || p === 'openrouter') ? p : 'openrouter';
            })() as 'gemini' | 'openrouter',
            karen: (() => {
                const p = process.env.ANALYST_KAREN_PROVIDER?.toLowerCase();
                return (p === 'gemini' || p === 'openrouter') ? p : 'gemini';
            })() as 'gemini' | 'openrouter',
            quant: (() => {
                const p = process.env.ANALYST_QUANT_PROVIDER?.toLowerCase();
                return (p === 'gemini' || p === 'openrouter') ? p : 'gemini';
            })() as 'gemini' | 'openrouter',
        },

        // Judge provider (only used when hybridMode=true)
        judgeProvider: (() => {
            const p = process.env.JUDGE_PROVIDER?.toLowerCase();
            return (p === 'gemini' || p === 'openrouter') ? p : 'gemini';
        })() as 'gemini' | 'openrouter',
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
        moderateConfidenceThreshold: clampInt(process.env.MODERATE_CONFIDENCE_THRESHOLD, 60, 0, 100),
        highConfidenceThreshold: clampInt(process.env.HIGH_CONFIDENCE_THRESHOLD, 70, 0, 100),
        veryHighConfidenceThreshold: clampInt(process.env.VERY_HIGH_CONFIDENCE_THRESHOLD, 80, 0, 100),

        // Deployment limits (percentage of capital) - validated after config object
        targetDeploymentPercent: clampInt(process.env.TARGET_DEPLOYMENT_PERCENT, 50, 10, 100),
        maxDeploymentPercent: clampInt(process.env.MAX_DEPLOYMENT_PERCENT, 60, 10, 100),

        // Position sizing (percentage of starting balance)
        minPositionPercent: clampInt(process.env.MIN_POSITION_PERCENT, 10, 5, 50),
        targetPositionMinPercent: clampInt(process.env.TARGET_POSITION_MIN_PERCENT, 12, 5, 50),
        targetPositionMaxPercent: clampInt(process.env.TARGET_POSITION_MAX_PERCENT, 15, 5, 50),
        maxPositionPercent: clampInt(process.env.MAX_POSITION_PERCENT, 20, 10, 50),

        // Retry limits - clamped to [1, 10] for safety
        maxRetries: clampInt(process.env.MAX_RETRIES, 3, 1, 10),
        dryRun: process.env.DRY_RUN === 'true',

        // Position urgency thresholds (for pre-Stage-2 optimization)
        // These control when positions are considered urgent enough to trigger AI analysis
        urgencyThresholds: {
            // Target profit % to trigger VERY_URGENT (take profit zone)
            targetProfitPct: (() => {
                const value = safeParseFloat(process.env.TARGET_PROFIT_PCT, 5);
                if (!process.env.TARGET_PROFIT_PCT) {
                    console.warn('⚠️ TARGET_PROFIT_PCT not set, using default: 5%');
                }
                if (value <= 0 || value > 100) {
                    throw new Error(`❌ FATAL: TARGET_PROFIT_PCT must be between 0 and 100, got: ${value}`);
                }
                return value;
            })(),
            // Stop loss % to trigger VERY_URGENT (cut losses)
            stopLossPct: (() => {
                const value = safeParseFloat(process.env.STOP_LOSS_PCT, 2.5);
                if (!process.env.STOP_LOSS_PCT) {
                    console.warn('⚠️ STOP_LOSS_PCT not set, using default: 2.5%');
                }
                if (value <= 0 || value > 100) {
                    throw new Error(`❌ FATAL: STOP_LOSS_PCT must be between 0 and 100, got: ${value}`);
                }
                return value;
            })(),
            // Max hold hours before VERY_URGENT
            maxHoldHours: (() => {
                const value = safeParseFloat(process.env.MAX_HOLD_HOURS, 72);
                if (!process.env.MAX_HOLD_HOURS) {
                    console.warn('⚠️ MAX_HOLD_HOURS not set, using default: 72 hours');
                }
                if (value <= 0 || value > 168) {
                    throw new Error(`❌ FATAL: MAX_HOLD_HOURS must be between 0 and 168 (1 week), got: ${value}`);
                }
                return value;
            })(),
            // Partial take profit threshold for MODERATE urgency
            partialTpPct: safeParseFloat(process.env.PARTIAL_TP_PCT, 3),
            // Hours before position is considered stale (competition mode only)
            stalePositionHours: safeParseFloat(process.env.STALE_POSITION_HOURS, 6),
            // P&L threshold below which position is considered stale
            stalePnlThreshold: safeParseFloat(process.env.STALE_PNL_THRESHOLD, 1.0),
        },

        // Monte Carlo validation thresholds - validated after parsing
        monteCarlo: (() => {
            // Parse raw values
            let minSharpe = safeParseFloat(process.env.MC_MIN_SHARPE_RATIO, 1.5);
            let targetSharpe = safeParseFloat(process.env.MC_TARGET_SHARPE_RATIO, 2.0);
            let excellentSharpe = safeParseFloat(process.env.MC_EXCELLENT_SHARPE_RATIO, 2.5);
            const minWinRate = Math.max(0, Math.min(1, safeParseFloat(process.env.MC_MIN_WIN_RATE, 0.55)));
            const maxDrawdownPercent = Math.max(1, Math.min(100, safeParseFloat(process.env.MC_MAX_DRAWDOWN_PERCENT, 25)));

            // Enforce Sharpe ratio ordering: min <= target <= excellent
            if (minSharpe > targetSharpe || targetSharpe > excellentSharpe) {
                console.warn(
                    `⚠️ WARNING: Monte Carlo Sharpe ratios are not in order. ` +
                    `Got: min=${minSharpe}, target=${targetSharpe}, excellent=${excellentSharpe}. ` +
                    `Adjusting to maintain min <= target <= excellent.`
                );
                // Sort and reassign to maintain order
                const sorted = [minSharpe, targetSharpe, excellentSharpe].sort((a, b) => a - b);
                minSharpe = sorted[0];
                targetSharpe = sorted[1];
                excellentSharpe = sorted[2];
            }

            return {
                minSharpeRatio: minSharpe,
                targetSharpeRatio: targetSharpe,
                excellentSharpeRatio: excellentSharpe,
                minWinRate,
                maxDrawdownPercent,
            };
        })(),

        // Q-value (RL) thresholds - validated for ordering
        qValue: (() => {
            let minimum = safeParseFloat(process.env.Q_VALUE_MINIMUM, 0.5);
            let consensus = safeParseFloat(process.env.Q_VALUE_CONSENSUS, 0.6);
            let highConfidence = safeParseFloat(process.env.Q_VALUE_HIGH_CONFIDENCE, 0.8);

            // Enforce ordering: minimum <= consensus <= highConfidence
            if (minimum > consensus || consensus > highConfidence) {
                console.warn(
                    `⚠️ WARNING: Q-value thresholds are not in order. ` +
                    `Got: minimum=${minimum}, consensus=${consensus}, highConfidence=${highConfidence}. ` +
                    `Sorting to maintain minimum <= consensus <= highConfidence.`
                );
                const sorted = [minimum, consensus, highConfidence].sort((a, b) => a - b);
                minimum = sorted[0];
                consensus = sorted[1];
                highConfidence = sorted[2];
            }

            return { minimum, consensus, highConfidence };
        })(),

        // Leverage scaling by portfolio exposure
        // When exposure exceeds thresholds, max leverage is reduced by these multipliers
        leverageScaling: (() => {
            const scale40 = Math.max(0.1, Math.min(1.0, safeParseFloat(process.env.LEVERAGE_SCALE_40PCT_MULT, 0.82)));
            const scale50 = Math.max(0.1, Math.min(1.0, safeParseFloat(process.env.LEVERAGE_SCALE_50PCT_MULT, 0.70)));

            // Validate: 50% exposure multiplier should be <= 40% exposure multiplier
            // (higher exposure = more conservative = lower multiplier)
            if (scale50 > scale40) {
                console.warn(
                    `⚠️ WARNING: LEVERAGE_SCALE_50PCT_MULT (${scale50}) > LEVERAGE_SCALE_40PCT_MULT (${scale40}). ` +
                    `This is illogical - higher exposure should have lower leverage. ` +
                    `Swapping values to enforce: 50% threshold uses ${scale40}, 40% threshold uses ${scale50}.`
                );
                return {
                    scale40PctMultiplier: scale50,
                    scale50PctMultiplier: scale40,
                };
            }

            return {
                scale40PctMultiplier: scale40,
                scale50PctMultiplier: scale50,
            };
        })(),

        // Risk Council additional limits (used in riskCouncil.ts)
        riskCouncil: {
            // Max funding rate against position (0.001 = 0.1%)
            maxFundingAgainstPercent: Math.max(0, Math.min(1, safeParseFloat(process.env.MAX_FUNDING_AGAINST_PERCENT, 0.001))),
            // Max positions in same sector
            maxSectorPositions: clampInt(process.env.MAX_SECTOR_POSITIONS, 3, 1, 10),
            // Net exposure limits (percentage)
            netExposureLimitLong: clampInt(process.env.NET_EXPOSURE_LIMIT_LONG, 70, 0, 300),
            netExposureLimitShort: clampInt(process.env.NET_EXPOSURE_LIMIT_SHORT, 70, 0, 300),
        },

        // Global risk limits (used in riskLimits.ts) - validated for ordering
        // Production defaults are conservative; competition mode overrides these
        riskLimits: (() => {
            let maxSafeLeverage = clampInt(process.env.MAX_SAFE_LEVERAGE, 10, 1, 50);
            let autoApproveLeverageThreshold = clampInt(process.env.AUTO_APPROVE_LEVERAGE_THRESHOLD, 5, 1, 20);
            let absoluteMaxLeverage = clampInt(process.env.ABSOLUTE_MAX_LEVERAGE, 15, 1, 50);
            const maxPositionSizePercent = clampInt(process.env.MAX_POSITION_SIZE_PERCENT ?? process.env.MAX_POSITION_PERCENT, 25, 5, 100);
            const maxTotalLeveragedCapitalPercent = clampInt(process.env.MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT, 40, 10, 100);
            const maxRiskPerTradePercent = clampInt(process.env.MAX_RISK_PER_TRADE_PERCENT, 5, 1, 50);
            const maxConcurrentRiskPercent = clampInt(process.env.MAX_CONCURRENT_RISK_PERCENT, 15, 5, 100);

            // Validate leverage ordering: autoApprove <= maxSafe <= absoluteMax
            if (autoApproveLeverageThreshold > maxSafeLeverage || maxSafeLeverage > absoluteMaxLeverage) {
                console.warn(
                    `⚠️ WARNING: Leverage limits are not in order. ` +
                    `Got: AUTO_APPROVE=${autoApproveLeverageThreshold}, MAX_SAFE=${maxSafeLeverage}, ABSOLUTE_MAX=${absoluteMaxLeverage}. ` +
                    `Sorting to maintain autoApprove <= maxSafe <= absoluteMax.`
                );
                const sorted = [autoApproveLeverageThreshold, maxSafeLeverage, absoluteMaxLeverage].sort((a, b) => a - b);
                autoApproveLeverageThreshold = sorted[0];
                maxSafeLeverage = sorted[1];
                absoluteMaxLeverage = sorted[2];
            }

            return {
                maxSafeLeverage,
                autoApproveLeverageThreshold,
                absoluteMaxLeverage,
                maxPositionSizePercent,
                maxTotalLeveragedCapitalPercent,
                maxRiskPerTradePercent,
                maxConcurrentRiskPercent,
            };
        })(),

        // Correlation risk thresholds
        correlation: {
            // Enable correlation checks (default: true)
            enabled: process.env.ENABLE_CORRELATION_CHECKS !== 'false',
            // Pairs with correlation above this are considered highly correlated
            highCorrelationThreshold: Math.max(0.5, Math.min(1.0, safeParseFloat(process.env.HIGH_CORRELATION_THRESHOLD, 0.8))),
            // Max positions in highly correlated assets
            maxCorrelatedPositions: clampInt(process.env.MAX_CORRELATED_POSITIONS, 2, 1, 10),
            // Warn if portfolio BTC correlation exceeds this
            btcCorrelationWarning: Math.max(0.5, Math.min(1.0, safeParseFloat(process.env.BTC_CORRELATION_WARNING, 0.85))),
        },

        // Circuit breaker thresholds - validated for yellow < red ordering
        circuitBreakers: (() => {
            let yellowBtcDrop4h = clampInt(process.env.CIRCUIT_YELLOW_BTC_DROP_4H, 12, 5, 30);
            let yellowDrawdown24h = clampInt(process.env.CIRCUIT_YELLOW_DRAWDOWN_24H, 15, 5, 50);
            let redBtcDrop4h = clampInt(process.env.CIRCUIT_RED_BTC_DROP_4H, 20, 10, 50);
            let redDrawdown24h = clampInt(process.env.CIRCUIT_RED_DRAWDOWN_24H, 30, 10, 75);

            // Validate: yellow thresholds should be less than red thresholds
            if (yellowBtcDrop4h >= redBtcDrop4h) {
                console.warn(
                    `⚠️ WARNING: CIRCUIT_YELLOW_BTC_DROP_4H (${yellowBtcDrop4h}) >= CIRCUIT_RED_BTC_DROP_4H (${redBtcDrop4h}). ` +
                    `Yellow alert should trigger before red. Swapping values.`
                );
                [yellowBtcDrop4h, redBtcDrop4h] = [redBtcDrop4h, yellowBtcDrop4h];
            }
            if (yellowDrawdown24h >= redDrawdown24h) {
                console.warn(
                    `⚠️ WARNING: CIRCUIT_YELLOW_DRAWDOWN_24H (${yellowDrawdown24h}) >= CIRCUIT_RED_DRAWDOWN_24H (${redDrawdown24h}). ` +
                    `Yellow alert should trigger before red. Swapping values.`
                );
                [yellowDrawdown24h, redDrawdown24h] = [redDrawdown24h, yellowDrawdown24h];
            }

            return { yellowBtcDrop4h, yellowDrawdown24h, redBtcDrop4h, redDrawdown24h };
        })(),

        // Stop loss requirements by leverage tier - validated for ordering
        stopLoss: (() => {
            // Parse raw values
            let lowMaxLeverage = clampInt(process.env.SL_LOW_MAX_LEVERAGE, 5, 1, 10);
            let mediumMaxLeverage = clampInt(process.env.SL_MEDIUM_MAX_LEVERAGE, 10, 5, 15);
            let highMaxLeverage = clampInt(process.env.SL_HIGH_MAX_LEVERAGE, 15, 10, 20);
            let extremeMaxLeverage = clampInt(process.env.SL_EXTREME_MAX_LEVERAGE, 20, 15, 50);

            const lowMaxStopPercent = Math.max(1, Math.min(20, safeParseFloat(process.env.SL_LOW_MAX_STOP_PERCENT, 6)));
            const mediumMaxStopPercent = Math.max(1, Math.min(10, safeParseFloat(process.env.SL_MEDIUM_MAX_STOP_PERCENT, 3)));
            const highMaxStopPercent = Math.max(0.5, Math.min(6, safeParseFloat(process.env.SL_HIGH_MAX_STOP_PERCENT, 3)));
            const extremeMaxStopPercent = Math.max(0.5, Math.min(5, safeParseFloat(process.env.SL_EXTREME_MAX_STOP_PERCENT, 2.5)));

            // Validate leverage tier ordering: low < medium < high < extreme
            if (lowMaxLeverage >= mediumMaxLeverage || mediumMaxLeverage >= highMaxLeverage || highMaxLeverage >= extremeMaxLeverage) {
                console.warn(
                    `⚠️ WARNING: Stop loss leverage tiers are not in ascending order. ` +
                    `Got: low=${lowMaxLeverage}, medium=${mediumMaxLeverage}, high=${highMaxLeverage}, extreme=${extremeMaxLeverage}. ` +
                    `Sorting to maintain low < medium < high < extreme.`
                );
                const sorted = [lowMaxLeverage, mediumMaxLeverage, highMaxLeverage, extremeMaxLeverage].sort((a, b) => a - b);
                lowMaxLeverage = sorted[0];
                mediumMaxLeverage = sorted[1];
                highMaxLeverage = sorted[2];
                extremeMaxLeverage = sorted[3];
            }

            return {
                lowMaxLeverage,
                lowMaxStopPercent,
                mediumMaxLeverage,
                mediumMaxStopPercent,
                highMaxLeverage,
                highMaxStopPercent,
                extremeMaxLeverage,
                extremeMaxStopPercent,
            };
        })(),
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

    // ═══════════════════════════════════════════════════════════════════════════════
    // PRODUCTION TUNING (v5.4.1)
    // ═══════════════════════════════════════════════════════════════════════════════

    // Monte Carlo Simulation Parameters
    monteCarlo: (() => {
        const tradingCostPct = safeParseFloat(process.env.MC_TRADING_COST_PCT, 0.06);
        const fundingCostPct = safeParseFloat(process.env.MC_FUNDING_COST_PCT, 0.01);
        const studentTDf = clampInt(process.env.MC_STUDENT_T_DF, 3, 2, 10);
        let garchAlpha = Math.max(0.01, Math.min(0.5, safeParseFloat(process.env.MC_GARCH_ALPHA, 0.1)));
        let garchBeta = Math.max(0.5, Math.min(0.99, safeParseFloat(process.env.MC_GARCH_BETA, 0.85)));
        const tradesPerYear = clampInt(process.env.MC_TRADES_PER_YEAR, 750, 100, 2000);

        // Validate GARCH stationarity: α + β < 1 is required for stationarity
        const garchSum = garchAlpha + garchBeta;
        if (garchSum >= 1) {
            const originalAlpha = garchAlpha;
            const originalBeta = garchBeta;
            // Scale both parameters to ensure α + β = 0.95 (safely in stationary region)
            const scaleFactor = 0.95 / garchSum;
            garchAlpha = garchAlpha * scaleFactor;
            garchBeta = garchBeta * scaleFactor;
            console.warn(
                `⚠️ WARNING: GARCH parameters violate stationarity (α + β >= 1). ` +
                `Original: α=${originalAlpha}, β=${originalBeta}, sum=${garchSum.toFixed(4)}. ` +
                `Scaled by ${scaleFactor.toFixed(4)} to: α=${garchAlpha.toFixed(4)}, β=${garchBeta.toFixed(4)}, sum=${(garchAlpha + garchBeta).toFixed(4)}.`
            );
        }

        return {
            tradingCostPct,
            fundingCostPct,
            studentTDf,
            garchAlpha,
            garchBeta,
            tradesPerYear,
        };
    })(),

    // Regime Detection
    regime: {
        historyMax: clampInt(process.env.REGIME_HISTORY_MAX, 20, 5, 100),
        historyMaxSymbols: clampInt(process.env.REGIME_HISTORY_MAX_SYMBOLS, 50, 10, 200),
        cleanupIntervalMs: Math.max(60000, safeParseInt(process.env.REGIME_CLEANUP_INTERVAL_MS, 600000)),
        maxAgeMs: Math.max(3600000, safeParseInt(process.env.REGIME_MAX_AGE_MS, 86400000)),
    },

    // Quant Analysis
    quant: {
        cacheTtlMs: Math.max(60000, safeParseInt(process.env.QUANT_CACHE_TTL_MS, 300000)),
        maxCacheSize: clampInt(process.env.QUANT_MAX_CACHE_SIZE, 100, 10, 500),
        fundingHistoryMaxEntries: clampInt(process.env.FUNDING_HISTORY_MAX_ENTRIES, 21, 7, 100),
        fundingHistoryMaxAgeMs: Math.max(86400000, safeParseInt(process.env.FUNDING_HISTORY_MAX_AGE_MS, 604800000)),
        fundingHistoryMaxSymbols: clampInt(process.env.FUNDING_HISTORY_MAX_SYMBOLS, 50, 10, 200),
    },

    // Sentiment Service
    sentiment: {
        newsCacheTtlMs: Math.max(60000, safeParseInt(process.env.SENTIMENT_NEWS_CACHE_TTL_MS, 1800000)),
        fearGreedCacheTtlMs: Math.max(60000, safeParseInt(process.env.SENTIMENT_FEAR_GREED_CACHE_TTL_MS, 3600000)),
        maxCacheSize: clampInt(process.env.SENTIMENT_MAX_CACHE_SIZE, 100, 10, 500),
        requestTimeoutMs: Math.max(5000, safeParseInt(process.env.SENTIMENT_REQUEST_TIMEOUT_MS, 10000)),
        minFetchIntervalMs: Math.max(60000, safeParseInt(process.env.SENTIMENT_MIN_FETCH_INTERVAL_MS, 300000)),
        btcWeight: Math.max(0, Math.min(1, safeParseFloat(process.env.SENTIMENT_BTC_WEIGHT, 0.6))),
        ethWeight: Math.max(0, Math.min(1, safeParseFloat(process.env.SENTIMENT_ETH_WEIGHT, 0.4))),
    },

    // Reddit Sentiment
    reddit: {
        cacheTtlMs: Math.max(60000, safeParseInt(process.env.REDDIT_CACHE_TTL_MS, 1800000)),
        requestDelayMs: Math.max(1000, safeParseInt(process.env.REDDIT_REQUEST_DELAY_MS, 2500)),
        requestTimeoutMs: Math.max(5000, safeParseInt(process.env.REDDIT_REQUEST_TIMEOUT_MS, 10000)),
        staleThresholdMs: Math.max(60000, safeParseInt(process.env.REDDIT_STALE_THRESHOLD_MS, 1200000)),
        maxPostAgeHours: clampInt(process.env.REDDIT_MAX_POST_AGE_HOURS, 24, 1, 168),
        maxCacheSize: clampInt(process.env.REDDIT_MAX_CACHE_SIZE, 50, 10, 200),
    },

    // Position Sync
    positionSync: {
        maxTrackedTrades: clampInt(process.env.POSITION_MAX_TRACKED_TRADES, 100, 10, 500),
        staleTradeHours: clampInt(process.env.POSITION_STALE_TRADE_HOURS, 72, 12, 168),
        outcomeThresholdPct: Math.max(0.1, Math.min(10, safeParseFloat(process.env.POSITION_OUTCOME_THRESHOLD_PCT, 1.0))),
        missingCycleThreshold: clampInt(process.env.POSITION_MISSING_CYCLE_THRESHOLD, 3, 1, 10),
    },

    // Analyst Portfolio
    portfolio: {
        recentTradesLimit: clampInt(process.env.PORTFOLIO_RECENT_TRADES_LIMIT, 10, 5, 50),
        lockTimeoutMs: Math.max(5000, safeParseInt(process.env.PORTFOLIO_LOCK_TIMEOUT_MS, 30000)),
        maxRetries: clampInt(process.env.PORTFOLIO_MAX_RETRIES, 2, 1, 5),
        retryDelayMs: Math.max(100, safeParseInt(process.env.PORTFOLIO_RETRY_DELAY_MS, 1000)),
    },

    // WEEX Client (extended settings)
    weexClient: {
        requestTimeoutMs: Math.max(30000, safeParseInt(process.env.WEEX_REQUEST_TIMEOUT_MS, 120000)),
        rateLimitMaxAttempts: clampInt(process.env.WEEX_RATE_LIMIT_MAX_ATTEMPTS, 20, 5, 50),
        rateLimitMaxWaitMs: Math.max(10000, safeParseInt(process.env.WEEX_RATE_LIMIT_MAX_WAIT_MS, 60000)),
    },
};

// Validate interdependencies
if (config.autonomous.maxSameDirectionPositions > config.autonomous.maxConcurrentPositions) {
    console.warn(`⚠️ MAX_SAME_DIRECTION_POSITIONS clamped to ${config.autonomous.maxConcurrentPositions}.`);
    config.autonomous.maxSameDirectionPositions = config.autonomous.maxConcurrentPositions;
}

// Validate confidence threshold ordering: min <= moderate <= high <= veryHigh
// IMPORTANT: Store original minConfidenceToTrade BEFORE sorting for safety validation
const originalMinConfidenceToTrade = config.autonomous.minConfidenceToTrade;
{
    const { minConfidenceToTrade, moderateConfidenceThreshold, highConfidenceThreshold, veryHighConfidenceThreshold } = config.autonomous;
    if (minConfidenceToTrade > moderateConfidenceThreshold ||
        moderateConfidenceThreshold > highConfidenceThreshold ||
        highConfidenceThreshold > veryHighConfidenceThreshold) {
        console.warn(
            `⚠️ WARNING: Confidence thresholds are not in non-decreasing order. ` +
            `Got: MIN_CONFIDENCE_TO_TRADE=${minConfidenceToTrade}, MODERATE_CONFIDENCE_THRESHOLD=${moderateConfidenceThreshold}, ` +
            `HIGH_CONFIDENCE_THRESHOLD=${highConfidenceThreshold}, VERY_HIGH_CONFIDENCE_THRESHOLD=${veryHighConfidenceThreshold}. ` +
            `Sorting values to ensure min <= moderate <= high <= veryHigh.`
        );
        // Sort and reassign to maintain order
        const sorted = [minConfidenceToTrade, moderateConfidenceThreshold, highConfidenceThreshold, veryHighConfidenceThreshold].sort((a, b) => a - b);
        config.autonomous.minConfidenceToTrade = sorted[0];
        config.autonomous.moderateConfidenceThreshold = sorted[1];
        config.autonomous.highConfidenceThreshold = sorted[2];
        config.autonomous.veryHighConfidenceThreshold = sorted[3];
    }
}

// Validate deployment limits: target should not exceed max
if (config.autonomous.targetDeploymentPercent > config.autonomous.maxDeploymentPercent) {
    console.warn(
        `⚠️ WARNING: TARGET_DEPLOYMENT_PERCENT (${config.autonomous.targetDeploymentPercent}) > MAX_DEPLOYMENT_PERCENT (${config.autonomous.maxDeploymentPercent}). ` +
        `Clamping TARGET_DEPLOYMENT_PERCENT to ${config.autonomous.maxDeploymentPercent}.`
    );
    config.autonomous.targetDeploymentPercent = config.autonomous.maxDeploymentPercent;
}

// Validate position sizing percentages: min <= targetMin <= targetMax <= max
{
    const { minPositionPercent, targetPositionMinPercent, targetPositionMaxPercent, maxPositionPercent } = config.autonomous;
    if (minPositionPercent > targetPositionMinPercent ||
        targetPositionMinPercent > targetPositionMaxPercent ||
        targetPositionMaxPercent > maxPositionPercent) {
        console.warn(
            `⚠️ WARNING: Position sizing percentages are not in non-decreasing order. ` +
            `Got: MIN_POSITION_PERCENT=${minPositionPercent}, TARGET_POSITION_MIN_PERCENT=${targetPositionMinPercent}, ` +
            `TARGET_POSITION_MAX_PERCENT=${targetPositionMaxPercent}, MAX_POSITION_PERCENT=${maxPositionPercent}. ` +
            `Sorting values to ensure min <= targetMin <= targetMax <= max.`
        );
        // Sort and reassign to maintain order
        const sorted = [minPositionPercent, targetPositionMinPercent, targetPositionMaxPercent, maxPositionPercent].sort((a, b) => a - b);
        config.autonomous.minPositionPercent = sorted[0];
        config.autonomous.targetPositionMinPercent = sorted[1];
        config.autonomous.targetPositionMaxPercent = sorted[2];
        config.autonomous.maxPositionPercent = sorted[3];
    }
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

// Validate hybrid mode API key requirements at startup
if (config.ai.hybridMode) {
    const needsGemini = Object.values(config.ai.analystProviders).includes('gemini') ||
        config.ai.judgeProvider === 'gemini';
    const needsOpenRouter = Object.values(config.ai.analystProviders).includes('openrouter') ||
        config.ai.judgeProvider === 'openrouter';

    const hybridErrors: string[] = [];

    if (needsGemini && !config.geminiApiKey) {
        hybridErrors.push('GEMINI_API_KEY required for assigned analysts/judge');
    }
    if (needsOpenRouter && !config.openRouterApiKey) {
        hybridErrors.push('OPENROUTER_API_KEY required for assigned analysts/judge');
    }
    // Check raw env var since config.ai.openRouterModel has a default value
    if (needsOpenRouter && !process.env.OPENROUTER_MODEL) {
        hybridErrors.push('OPENROUTER_MODEL required for assigned analysts/judge');
    }

    if (hybridErrors.length > 0) {
        const errorMsg = `❌ FATAL: Hybrid AI mode enabled but missing configuration:\n  - ${hybridErrors.join('\n  - ')}\n` +
            `  Analyst assignments: jim→${config.ai.analystProviders.jim}, ray→${config.ai.analystProviders.ray}, ` +
            `karen→${config.ai.analystProviders.karen}, quant→${config.ai.analystProviders.quant}\n` +
            `  Judge: ${config.ai.judgeProvider}`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Log hybrid mode configuration at startup
    console.log(
        `🔀 Hybrid AI mode: jim→${config.ai.analystProviders.jim}, ray→${config.ai.analystProviders.ray}, ` +
        `karen→${config.ai.analystProviders.karen}, quant→${config.ai.analystProviders.quant}, judge→${config.ai.judgeProvider}`
    );
} else if (!config.geminiApiKey && !config.openRouterApiKey) {
    // Non-hybrid mode: warn if no API keys configured
    console.warn('⚠️ WARNING: No AI API keys configured (GEMINI_API_KEY or OPENROUTER_API_KEY). AI features will fail.');
}

// =============================================================================
// CRITICAL SAFETY VALIDATIONS (v5.6.1)
// =============================================================================

// SAFETY: Prevent real trading with low confidence threshold
// When DRY_RUN=false, MIN_CONFIDENCE_TO_TRADE must be >= MODERATE_CONFIDENCE_THRESHOLD
// Use originalMinConfidenceToTrade to check the user's intended value, not the sorted one
if (!config.autonomous.dryRun) {
    const { moderateConfidenceThreshold, highConfidenceThreshold } = config.autonomous;

    if (originalMinConfidenceToTrade < moderateConfidenceThreshold) {
        const errorMsg = `❌ FATAL: DANGEROUS CONFIGURATION DETECTED!\n` +
            `  DRY_RUN=false (real trading enabled) but MIN_CONFIDENCE_TO_TRADE (${originalMinConfidenceToTrade}) ` +
            `is below MODERATE_CONFIDENCE_THRESHOLD (${moderateConfidenceThreshold}).\n` +
            `  This could result in low-confidence trades with real money.\n` +
            `  FIX: Either set DRY_RUN=true for testing, or increase MIN_CONFIDENCE_TO_TRADE to at least ${moderateConfidenceThreshold}.\n` +
            `  RECOMMENDED: Set MIN_CONFIDENCE_TO_TRADE >= HIGH_CONFIDENCE_THRESHOLD (${highConfidenceThreshold}) for real trading.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }

    // Warning if below high confidence threshold
    if (originalMinConfidenceToTrade < highConfidenceThreshold) {
        console.warn(
            `⚠️ WARNING: Real trading enabled (DRY_RUN=false) with MIN_CONFIDENCE_TO_TRADE (${originalMinConfidenceToTrade}) ` +
            `below HIGH_CONFIDENCE_THRESHOLD (${highConfidenceThreshold}). ` +
            `Consider increasing MIN_CONFIDENCE_TO_TRADE for safer real trading.`
        );
    }
}

// SAFETY: Validate STOP_LOSS_PCT does not exceed the most restrictive tier (SL_EXTREME_MAX_STOP_PERCENT)
{
    const globalStopLoss = config.autonomous.urgencyThresholds.stopLossPct;
    const extremeMaxStop = config.autonomous.stopLoss.extremeMaxStopPercent;

    if (globalStopLoss > extremeMaxStop) {
        const errorMsg = `❌ FATAL: STOP_LOSS_PCT (${globalStopLoss}%) exceeds SL_EXTREME_MAX_STOP_PERCENT (${extremeMaxStop}%).\n` +
            `  The global stop loss cannot be wider than the most restrictive leverage tier.\n` +
            `  FIX: Either reduce STOP_LOSS_PCT to <= ${extremeMaxStop}%, or increase SL_EXTREME_MAX_STOP_PERCENT.`;
        console.error(errorMsg);
        throw new Error(errorMsg);
    }
}

// SAFETY: Validate per-trade risk is reasonable
// Risk = position_size × leverage × stop_loss
{
    let maxPositionPct = config.autonomous.riskLimits.maxPositionSizePercent;
    const maxLeverage = config.autonomous.riskLimits.absoluteMaxLeverage;
    const stopLossPct = config.autonomous.urgencyThresholds.stopLossPct;
    const maxRiskPerTrade = config.autonomous.riskLimits.maxRiskPerTradePercent;

    // Calculate worst-case per-trade risk
    let worstCaseRisk = (maxPositionPct / 100) * maxLeverage * stopLossPct;
    const suggestedMaxPositionPctToRespectRisk =
        maxLeverage > 0 && stopLossPct > 0
            ? (maxRiskPerTrade / (maxLeverage * stopLossPct)) * 100
            : NaN;

    if (worstCaseRisk > maxRiskPerTrade) {
        const safeMaxPositionPct =
            Number.isFinite(suggestedMaxPositionPctToRespectRisk)
                ? Math.max(1, Math.min(maxPositionPct, suggestedMaxPositionPctToRespectRisk))
                : maxPositionPct;

        console.warn(
            `⚠️ WARNING: Worst-case per-trade risk (${worstCaseRisk.toFixed(1)}%) exceeds MAX_RISK_PER_TRADE_PERCENT (${maxRiskPerTrade}%).\n` +
            `  Calculation: MAX_POSITION_SIZE_PERCENT (${maxPositionPct}%) × ABSOLUTE_MAX_LEVERAGE (${maxLeverage}x) × STOP_LOSS_PCT (${stopLossPct}%) = ${worstCaseRisk.toFixed(1)}%\n` +
            `  FIX: Reduce MAX_POSITION_SIZE_PERCENT to ≤ ${Number.isFinite(suggestedMaxPositionPctToRespectRisk) ? suggestedMaxPositionPctToRespectRisk.toFixed(1) : '?'}% ` +
            `(or lower ABSOLUTE_MAX_LEVERAGE / STOP_LOSS_PCT, or raise MAX_RISK_PER_TRADE_PERCENT).`
        );

        if (!config.autonomous.dryRun && safeMaxPositionPct < maxPositionPct) {
            console.warn(
                `⚠️ WARNING: Enforcing safer runtime cap: MAX_POSITION_SIZE_PERCENT ${maxPositionPct}% → ${safeMaxPositionPct.toFixed(1)}%`
            );
            maxPositionPct = safeMaxPositionPct;
            config.autonomous.riskLimits.maxPositionSizePercent = safeMaxPositionPct;
            worstCaseRisk = (maxPositionPct / 100) * maxLeverage * stopLossPct;
        }
    }

    // Validate concurrent risk
    let maxConcurrent = config.autonomous.maxConcurrentPositions;
    const maxConcurrentRisk = config.autonomous.riskLimits.maxConcurrentRiskPercent;
    let worstCaseConcurrentRisk = worstCaseRisk * maxConcurrent;
    const suggestedMaxConcurrentPositionsToRespectRisk =
        worstCaseRisk > 0 ? Math.floor(maxConcurrentRisk / worstCaseRisk) : NaN;

    if (worstCaseConcurrentRisk > maxConcurrentRisk) {
        const safeMaxConcurrentPositions =
            Number.isFinite(suggestedMaxConcurrentPositionsToRespectRisk)
                ? Math.max(1, Math.min(maxConcurrent, suggestedMaxConcurrentPositionsToRespectRisk))
                : maxConcurrent;

        console.warn(
            `⚠️ WARNING: Worst-case concurrent risk (${worstCaseConcurrentRisk.toFixed(1)}%) exceeds MAX_CONCURRENT_RISK_PERCENT (${maxConcurrentRisk}%).\n` +
            `  Calculation: Per-trade risk (${worstCaseRisk.toFixed(1)}%) × MAX_CONCURRENT_POSITIONS (${maxConcurrent}) = ${worstCaseConcurrentRisk.toFixed(1)}%\n` +
            `  FIX: Reduce MAX_CONCURRENT_POSITIONS to ≤ ${Number.isFinite(suggestedMaxConcurrentPositionsToRespectRisk) ? Math.max(1, suggestedMaxConcurrentPositionsToRespectRisk) : '?'} ` +
            `(or reduce per-trade risk by lowering MAX_POSITION_SIZE_PERCENT / ABSOLUTE_MAX_LEVERAGE / STOP_LOSS_PCT, or raise MAX_CONCURRENT_RISK_PERCENT).`
        );

        if (!config.autonomous.dryRun && safeMaxConcurrentPositions < maxConcurrent) {
            console.warn(
                `⚠️ WARNING: Enforcing safer runtime cap: MAX_CONCURRENT_POSITIONS ${maxConcurrent} → ${safeMaxConcurrentPositions}`
            );
            maxConcurrent = safeMaxConcurrentPositions;
            config.autonomous.maxConcurrentPositions = safeMaxConcurrentPositions;
            worstCaseConcurrentRisk = worstCaseRisk * maxConcurrent;

            if (config.autonomous.maxSameDirectionPositions > config.autonomous.maxConcurrentPositions) {
                console.warn(`⚠️ WARNING: MAX_SAME_DIRECTION_POSITIONS clamped to ${config.autonomous.maxConcurrentPositions}.`);
                config.autonomous.maxSameDirectionPositions = config.autonomous.maxConcurrentPositions;
            }
        }
    }
}

// Log risk configuration summary
console.log(
    `📊 Risk Config: Max ${config.autonomous.riskLimits.maxPositionSizePercent}% position × ${config.autonomous.riskLimits.absoluteMaxLeverage}x leverage, ` +
    `${config.autonomous.urgencyThresholds.stopLossPct}% stop, ${config.autonomous.maxConcurrentPositions} concurrent positions`
);

