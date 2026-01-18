/**
 * Global Risk Management Constants
 * COMPETITION MODE: Aggressive settings for demo money competition.
 * IMPORTANT: These aggressive settings are ONLY safe when COMPETITION_MODE is enabled.
 * 
 * All values are configurable via environment variables through config.
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';

// =============================================================================
// COMPETITION MODE VALIDATION
// =============================================================================

const COMPETITION_MODE_ENABLED = process.env.COMPETITION_MODE === 'true' ||
    process.env.NODE_ENV === 'competition' ||
    process.env.ENV_RULES === 'aggressive' ||
    process.env.TRADING_MODE === 'competition';
const COMPETITION_MODE_ACK_STRING = 'I_ACCEPT_DEMO_ONLY_AGGRESSIVE_SETTINGS';
// Deprecated ack values for backward compatibility
const COMPETITION_MODE_ACK = process.env.COMPETITION_MODE_ACK === COMPETITION_MODE_ACK_STRING ||
    process.env.TRADING_MODE_ACK === COMPETITION_MODE_ACK_STRING ||
    process.env.COMPETITION_MODE_ACK === 'I_ACCEPT_DEMO_ONLY_RISK_MANAGED_SETTINGS' ||
    process.env.COMPETITION_MODE_ACK === 'I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS' ||
    process.env.ENV_RULES_ACK === 'I_ACCEPT_DEMO_ONLY_AGGRESSIVE_SETTINGS';
const WEEX_ACCOUNT_TYPE = process.env.WEEX_ACCOUNT_TYPE?.trim()?.toLowerCase();

if (COMPETITION_MODE_ENABLED && !COMPETITION_MODE_ACK) {
    console.warn(
        '⚠️ COMPETITION MODE ENABLED but acknowledgment missing or incorrect!\n' +
        '   To enable competition mode, set BOTH environment variables:\n' +
        '   - COMPETITION_MODE=true\n' +
        `   - COMPETITION_MODE_ACK=${COMPETITION_MODE_ACK_STRING}\n` +
        '   Using PRODUCTION settings (competition settings require acknowledgment).'
    );
}

const ACCOUNT_TYPE_BLOCKS_COMPETITION = WEEX_ACCOUNT_TYPE === 'live';
const VALID_COMPETITION_ACCOUNT_TYPES = ['demo', 'test'];
const ACCOUNT_TYPE_MISSING_FOR_COMPETITION = COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK && !WEEX_ACCOUNT_TYPE;
const ACCOUNT_TYPE_INVALID_FOR_COMPETITION = COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK &&
    WEEX_ACCOUNT_TYPE && !VALID_COMPETITION_ACCOUNT_TYPES.includes(WEEX_ACCOUNT_TYPE) && WEEX_ACCOUNT_TYPE !== 'live';

if (COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK && ACCOUNT_TYPE_BLOCKS_COMPETITION) {
    throw new Error(
        '🚫 STARTUP BLOCKED: COMPETITION_MODE is enabled but WEEX_ACCOUNT_TYPE is set to "live"!\n' +
        '   Competition mode is ONLY for demo/paper trading accounts.\n' +
        '   Either:\n' +
        '   - Set WEEX_ACCOUNT_TYPE=demo if this is a demo account\n' +
        '   - Remove COMPETITION_MODE=true if this is a live account'
    );
}

if (ACCOUNT_TYPE_MISSING_FOR_COMPETITION) {
    throw new Error(
        '🚫 STARTUP BLOCKED: COMPETITION_MODE is enabled but WEEX_ACCOUNT_TYPE is not set!\n' +
        '   Competition mode REQUIRES explicit account type declaration.\n' +
        '   Set WEEX_ACCOUNT_TYPE=demo to confirm this is a demo account.'
    );
}

if (ACCOUNT_TYPE_INVALID_FOR_COMPETITION) {
    throw new Error(
        `🚫 STARTUP BLOCKED: COMPETITION_MODE is enabled but WEEX_ACCOUNT_TYPE="${WEEX_ACCOUNT_TYPE}" is invalid!\n` +
        '   Competition mode requires WEEX_ACCOUNT_TYPE to be "demo" or "test".'
    );
}

const USE_COMPETITION_SETTINGS = COMPETITION_MODE_ENABLED &&
    COMPETITION_MODE_ACK &&
    !ACCOUNT_TYPE_BLOCKS_COMPETITION &&
    VALID_COMPETITION_ACCOUNT_TYPES.includes(WEEX_ACCOUNT_TYPE || '');

if (USE_COMPETITION_SETTINGS) {
    const bannerMaxLeverage = config.autonomous.riskLimits.absoluteMaxLeverage;
    const bannerMaxPositionSizePercent = config.autonomous.riskLimits.maxPositionSizePercent;
    console.warn(
        '\n' +
        '╔══════════════════════════════════════════════════════════════════════════════╗\n' +
        '║  ⚠️  COMPETITION MODE ENABLED - AGGRESSIVE RISK SETTINGS ACTIVE              ║\n' +
        '╠══════════════════════════════════════════════════════════════════════════════╣\n' +
        '║  This mode is for DEMO/PAPER TRADING ONLY!                                   ║\n' +
        `║  Settings: ${String(bannerMaxLeverage).padEnd(2)}x max leverage, ${String(bannerMaxPositionSizePercent).padEnd(3)}% max position size                   ║\n` +
        '║  Account Type: ' + (WEEX_ACCOUNT_TYPE || 'NOT SET').padEnd(46) + '║\n' +
        '║  VERIFY YOUR ACCOUNT IS A DEMO ACCOUNT BEFORE PROCEEDING!                    ║\n' +
        '╚══════════════════════════════════════════════════════════════════════════════╝\n'
    );

    if (typeof logger !== 'undefined' && logger.warn) {
        logger.warn('COMPETITION MODE ENABLED', {
            competitionMode: true,
            acknowledgment: 'ACCEPTED',
            accountType: WEEX_ACCOUNT_TYPE || 'NOT_SET',
            maxLeverage: bannerMaxLeverage,
            maxPositionSizePercent: bannerMaxPositionSizePercent
        });
    }
}

// =============================================================================
// SETTINGS SELECTION (Config-based with competition overrides)
// =============================================================================

// Get base values from config (these are the production defaults)
const configRiskLimits = config.autonomous.riskLimits;
const configCorrelation = config.autonomous.correlation;
const configCircuitBreakers = config.autonomous.circuitBreakers;
const configStopLoss = config.autonomous.stopLoss;
const configLeverageScaling = config.autonomous.leverageScaling;

const ACTIVE_SETTINGS = {
    MAX_SAFE_LEVERAGE: configRiskLimits.maxSafeLeverage,
    AUTO_APPROVE_LEVERAGE_THRESHOLD: configRiskLimits.autoApproveLeverageThreshold,
    ABSOLUTE_MAX_LEVERAGE: configRiskLimits.absoluteMaxLeverage,
    MAX_POSITION_SIZE_PERCENT: configRiskLimits.maxPositionSizePercent,
    MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT: configRiskLimits.maxTotalLeveragedCapitalPercent,
    MAX_RISK_PER_TRADE_PERCENT: configRiskLimits.maxRiskPerTradePercent,
    MAX_CONCURRENT_RISK_PERCENT: configRiskLimits.maxConcurrentRiskPercent,
};

// =============================================================================
// VALIDATION FUNCTIONS
// =============================================================================

/**
 * Runtime guard to validate competition mode is properly configured
 * Call this from trade-executing entry points to prevent trades with misconfigured settings
 * 
 * @throws Error if competition settings are active but configuration is invalid
 * @returns true if settings are valid for trading
 */
export function validateCompetitionMode(): boolean {
    if (USE_COMPETITION_SETTINGS) {
        if (ACCOUNT_TYPE_BLOCKS_COMPETITION) {
            throw new Error(
                'COMPETITION_MODE is blocked because WEEX_ACCOUNT_TYPE is set to "live". ' +
                'Competition mode is ONLY for demo/paper trading accounts. ' +
                'Set WEEX_ACCOUNT_TYPE=demo or disable COMPETITION_MODE.'
            );
        }
    }
    return true;
}

/**
 * Validate account type allows competition mode
 * @returns { valid: boolean, reason: string }
 */
export function validateAccountTypeForCompetition(): { valid: boolean; reason: string } {
    if (!USE_COMPETITION_SETTINGS) {
        return { valid: true, reason: 'Competition mode is not enabled' };
    }

    if (ACCOUNT_TYPE_BLOCKS_COMPETITION) {
        return {
            valid: false,
            reason: 'WEEX_ACCOUNT_TYPE is set to "live" - competition mode blocked for safety'
        };
    }

    if (!WEEX_ACCOUNT_TYPE) {
        return {
            valid: false,
            reason: 'WEEX_ACCOUNT_TYPE is not set - competition mode requires explicit "demo" or "test" account type'
        };
    }

    if (WEEX_ACCOUNT_TYPE === 'demo' || WEEX_ACCOUNT_TYPE === 'test') {
        return { valid: true, reason: 'Account type confirmed as demo/test' };
    }

    return {
        valid: false,
        reason: `Unknown WEEX_ACCOUNT_TYPE: ${WEEX_ACCOUNT_TYPE}. Must be "demo", "test", or "live".`
    };
}

/**
 * Per-trade guard for competition mode
 * @param symbol - Trading symbol
 * @param side - Trade side (BUY/SELL)
 * @param leverage - Requested leverage
 * @returns { allowed: boolean, warning: string | null }
 */
export function guardCompetitionModeTrade(
    symbol: string,
    side: string,
    leverage: number
): { allowed: boolean; warning: string | null } {
    if (!USE_COMPETITION_SETTINGS) {
        return { allowed: true, warning: null };
    }

    const warning = `⚠️ COMPETITION MODE TRADE: ${side} ${symbol} @ ${leverage}x leverage`;
    if (typeof logger !== 'undefined' && logger.warn) {
        logger.warn(warning, {
            competitionMode: true,
            symbol,
            side,
            leverage,
            accountType: WEEX_ACCOUNT_TYPE || 'NOT_SET'
        });
    }

    if (ACCOUNT_TYPE_BLOCKS_COMPETITION) {
        return {
            allowed: false,
            warning: 'Trade blocked: WEEX_ACCOUNT_TYPE is "live" but competition mode is enabled'
        };
    }

    return { allowed: true, warning };
}

/**
 * Check if competition mode is allowed (both flag and ack are set)
 */
export function isCompetitionModeAllowed(): boolean {
    return USE_COMPETITION_SETTINGS;
}

// =============================================================================
// GLOBAL RISK LIMITS (Exported)
// =============================================================================

export const GLOBAL_RISK_LIMITS = {
    // Maximum leverage
    MAX_SAFE_LEVERAGE: ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE,

    // Threshold for auto-approved leverage (no extra confidence required)
    AUTO_APPROVE_LEVERAGE_THRESHOLD: ACTIVE_SETTINGS.AUTO_APPROVE_LEVERAGE_THRESHOLD,

    // Legacy alias for backward compatibility
    // @deprecated Use AUTO_APPROVE_LEVERAGE_THRESHOLD instead
    CONSERVATIVE_LEVERAGE_THRESHOLD: ACTIVE_SETTINGS.AUTO_APPROVE_LEVERAGE_THRESHOLD,

    // Absolute maximum leverage
    ABSOLUTE_MAX_LEVERAGE: ACTIVE_SETTINGS.ABSOLUTE_MAX_LEVERAGE,

    // Max position size as % of portfolio
    MAX_POSITION_SIZE_PERCENT: ACTIVE_SETTINGS.MAX_POSITION_SIZE_PERCENT,

    // Max total capital in leveraged positions
    MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT: ACTIVE_SETTINGS.MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT,

    // Maximum risk per trade
    MAX_RISK_PER_TRADE_PERCENT: ACTIVE_SETTINGS.MAX_RISK_PER_TRADE_PERCENT,

    // Maximum concurrent risk
    MAX_CONCURRENT_RISK_PERCENT: ACTIVE_SETTINGS.MAX_CONCURRENT_RISK_PERCENT,

    // Position leverage scaling - computed from config values
    POSITION_LEVERAGE_SCALING: (() => {
        const mult40 = configLeverageScaling.scale40PctMultiplier;
        const mult50 = configLeverageScaling.scale50PctMultiplier;

        const maxLev40 = Math.max(1, Math.floor(ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE * mult40));
        const maxLev50 = Math.max(1, Math.floor(ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE * mult50));

        return {
            THRESHOLD_40_PERCENT: { maxLeverage: maxLev40 },
            THRESHOLD_50_PERCENT: { maxLeverage: maxLev50 },
        };
    })(),

    // Correlation checks - from config
    ENABLE_CORRELATION_CHECKS: configCorrelation.enabled,

    // Correlation risk thresholds - from config
    CORRELATION_THRESHOLDS: {
        HIGH_CORRELATION: configCorrelation.highCorrelationThreshold,
        MAX_CORRELATED_POSITIONS: configCorrelation.maxCorrelatedPositions,
        BTC_CORRELATION_WARNING: configCorrelation.btcCorrelationWarning,
    },

    // Circuit breakers - from config
    CIRCUIT_BREAKERS: {
        YELLOW_ALERT: {
            BTC_DROP_4H: configCircuitBreakers.yellowBtcDrop4h,
            PORTFOLIO_DRAWDOWN_24H: configCircuitBreakers.yellowDrawdown24h,
            ACTION: `Reduce leverage to ${ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE}x max`
        },
        RED_ALERT: {
            BTC_DROP_4H: configCircuitBreakers.redBtcDrop4h,
            PORTFOLIO_DRAWDOWN_24H: configCircuitBreakers.redDrawdown24h,
            ACTION: 'Review positions'
        }
    },

    // Stop loss requirements - from config
    STOP_LOSS_BY_LEVERAGE: {
        LOW: {
            maxLeverage: configStopLoss.lowMaxLeverage,
            maxStopPercent: configStopLoss.lowMaxStopPercent
        },
        MEDIUM: {
            maxLeverage: configStopLoss.mediumMaxLeverage,
            maxStopPercent: configStopLoss.mediumMaxStopPercent
        },
        HIGH: {
            maxLeverage: configStopLoss.highMaxLeverage,
            maxStopPercent: configStopLoss.highMaxStopPercent
        },
        EXTREME: {
            maxLeverage: configStopLoss.extremeMaxLeverage,
            maxStopPercent: configStopLoss.extremeMaxStopPercent
        },
    },

    // Flag indicating if competition mode is active
    COMPETITION_MODE_ENABLED: USE_COMPETITION_SETTINGS,
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if leverage is auto-approved (uses AUTO_APPROVE_LEVERAGE_THRESHOLD)
 */
export function isLeverageAutoApproved(leverage: number, confidence: number): boolean {
    if (!Number.isFinite(leverage) || leverage <= 0) {
        return false;
    }
    if (!Number.isFinite(confidence)) {
        confidence = 50;
    }
    const requiredConfidence = Number.isFinite(config.autonomous.highConfidenceThreshold)
        ? config.autonomous.highConfidenceThreshold
        : 70;

    if (leverage <= GLOBAL_RISK_LIMITS.AUTO_APPROVE_LEVERAGE_THRESHOLD) {
        return true;
    }
    if (leverage > GLOBAL_RISK_LIMITS.ABSOLUTE_MAX_LEVERAGE) {
        return false;
    }
    return confidence >= requiredConfidence;
}

/**
 * Get maximum allowed leverage based on current portfolio exposure
 */
export function getMaxLeverageForExposure(currentLeveragedCapitalPercent: number): number {
    if (!Number.isFinite(currentLeveragedCapitalPercent) || currentLeveragedCapitalPercent < 0) {
        return GLOBAL_RISK_LIMITS.POSITION_LEVERAGE_SCALING.THRESHOLD_50_PERCENT.maxLeverage;
    }

    if (currentLeveragedCapitalPercent > 50) {
        return GLOBAL_RISK_LIMITS.POSITION_LEVERAGE_SCALING.THRESHOLD_50_PERCENT.maxLeverage;
    }
    if (currentLeveragedCapitalPercent > 40) {
        return GLOBAL_RISK_LIMITS.POSITION_LEVERAGE_SCALING.THRESHOLD_40_PERCENT.maxLeverage;
    }
    return GLOBAL_RISK_LIMITS.MAX_SAFE_LEVERAGE;
}

/**
 * Get required stop loss percentage for given leverage
 */
export function getRequiredStopLossPercent(leverage: number): number {
    if (!Number.isFinite(leverage) || leverage <= 0) {
        return GLOBAL_RISK_LIMITS.STOP_LOSS_BY_LEVERAGE.EXTREME.maxStopPercent;
    }

    const { STOP_LOSS_BY_LEVERAGE } = GLOBAL_RISK_LIMITS;
    if (leverage <= STOP_LOSS_BY_LEVERAGE.LOW.maxLeverage) return STOP_LOSS_BY_LEVERAGE.LOW.maxStopPercent;
    if (leverage <= STOP_LOSS_BY_LEVERAGE.MEDIUM.maxLeverage) return STOP_LOSS_BY_LEVERAGE.MEDIUM.maxStopPercent;
    if (leverage <= STOP_LOSS_BY_LEVERAGE.HIGH.maxLeverage) return STOP_LOSS_BY_LEVERAGE.HIGH.maxStopPercent;
    return STOP_LOSS_BY_LEVERAGE.EXTREME.maxStopPercent;
}

/**
 * Check correlation risk for a new position
 */
export function checkCorrelationRisk(
    newSymbol: string,
    existingPositions: string[],
    correlationMatrix: Map<string, Map<string, number>> | null
): { allowed: boolean; warning: string | null; correlationRisk: number } {
    if (!GLOBAL_RISK_LIMITS.ENABLE_CORRELATION_CHECKS) {
        return { allowed: true, warning: null, correlationRisk: 0 };
    }

    if (!correlationMatrix || correlationMatrix.size === 0) {
        if (!existingPositions || existingPositions.length === 0) {
            return {
                allowed: true,
                warning: 'Correlation data unavailable - first position allowed, subsequent trades will be limited',
                correlationRisk: 0.5
            };
        }

        return {
            allowed: false,
            warning: `Correlation data unavailable - blocking trade to prevent concentrated exposure. ` +
                `Already have ${existingPositions.length} position(s). Wait for correlation data or reduce positions.`,
            correlationRisk: 0.8
        };
    }

    if (!existingPositions || existingPositions.length === 0) {
        return { allowed: true, warning: null, correlationRisk: 0 };
    }

    const { HIGH_CORRELATION, MAX_CORRELATED_POSITIONS } = GLOBAL_RISK_LIMITS.CORRELATION_THRESHOLDS;

    const normalizeSymbol = (sym: string): string => {
        return sym.toLowerCase().replace(/^cmt_/, '');
    };

    const newSymNorm = normalizeSymbol(newSymbol);
    let highlyCorrelatedCount = 0;
    let maxCorrelation = 0;
    const correlatedWith: string[] = [];

    for (const existingSymbol of existingPositions) {
        const existingSymNorm = normalizeSymbol(existingSymbol);
        let correlation = 0;

        const newSymRow = correlationMatrix.get(newSymNorm) ||
            correlationMatrix.get(`${newSymNorm}usdt`) ||
            correlationMatrix.get(`cmt_${newSymNorm}usdt`);
        if (newSymRow) {
            correlation = newSymRow.get(existingSymNorm) ||
                newSymRow.get(`${existingSymNorm}usdt`) ||
                newSymRow.get(`cmt_${existingSymNorm}usdt`) || 0;
        }

        if (correlation === 0) {
            const existingSymRow = correlationMatrix.get(existingSymNorm) ||
                correlationMatrix.get(`${existingSymNorm}usdt`) ||
                correlationMatrix.get(`cmt_${existingSymNorm}usdt`);
            if (existingSymRow) {
                correlation = existingSymRow.get(newSymNorm) ||
                    existingSymRow.get(`${newSymNorm}usdt`) ||
                    existingSymRow.get(`cmt_${newSymNorm}usdt`) || 0;
            }
        }

        if (Math.abs(correlation) > maxCorrelation) {
            maxCorrelation = Math.abs(correlation);
        }

        if (Math.abs(correlation) >= HIGH_CORRELATION) {
            highlyCorrelatedCount++;
            correlatedWith.push(`${existingSymbol} (${(correlation * 100).toFixed(0)}%)`);
        }
    }

    const correlationRisk = Math.min(1, (highlyCorrelatedCount / MAX_CORRELATED_POSITIONS) * maxCorrelation);

    if (highlyCorrelatedCount >= MAX_CORRELATED_POSITIONS) {
        return {
            allowed: false,
            warning: `Correlation limit exceeded: ${newSymbol} is highly correlated with ${correlatedWith.join(', ')}. ` +
                `Max ${MAX_CORRELATED_POSITIONS} highly correlated positions allowed.`,
            correlationRisk
        };
    }

    if (highlyCorrelatedCount > 0) {
        return {
            allowed: true,
            warning: `Correlation warning: ${newSymbol} is correlated with ${correlatedWith.join(', ')}. ` +
                `Consider diversifying.`,
            correlationRisk
        };
    }

    return { allowed: true, warning: null, correlationRisk };
}

/**
 * Calculate portfolio-wide BTC correlation
 */
export function calculatePortfolioBtcCorrelation(
    positions: string[],
    correlationMatrix: Map<string, Map<string, number>> | null
): number {
    if (!positions || positions.length === 0) return 0;
    if (!correlationMatrix || correlationMatrix.size === 0) return 0.7;

    const normalizeSymbol = (sym: string): string => {
        return sym.toLowerCase().replace(/^cmt_/, '').replace(/usdt$/, '');
    };

    let totalCorrelation = 0;
    let count = 0;

    const btcRow = correlationMatrix.get('btcusdt') ||
        correlationMatrix.get('cmt_btcusdt') ||
        correlationMatrix.get('btc');

    for (const symbol of positions) {
        const symNorm = normalizeSymbol(symbol);

        if (symNorm === 'btc') {
            totalCorrelation += 1;
            count++;
            continue;
        }

        let btcCorr = 0;
        if (btcRow) {
            btcCorr = btcRow.get(symNorm) ||
                btcRow.get(`cmt_${symNorm}usdt`) ||
                btcRow.get(`${symNorm}usdt`) || 0;
        }

        if (btcCorr === 0) {
            const symRow = correlationMatrix.get(symNorm) ||
                correlationMatrix.get(`${symNorm}usdt`) ||
                correlationMatrix.get(`cmt_${symNorm}usdt`);
            if (symRow) {
                btcCorr = symRow.get('btcusdt') ||
                    symRow.get('cmt_btcusdt') ||
                    symRow.get('btc') || 0;
            }
        }

        if (btcCorr === 0) btcCorr = 0.7;

        totalCorrelation += Math.abs(btcCorr);
        count++;
    }

    return count > 0 ? totalCorrelation / count : 0;
}
