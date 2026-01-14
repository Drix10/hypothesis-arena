/**
 * Global Risk Management Constants
 * COMPETITION MODE: Aggressive settings for demo money competition.
 * IMPORTANT: These aggressive settings are ONLY safe when COMPETITION_MODE is enabled.
 */

import { logger } from '../../utils/logger';

const COMPETITION_MODE_ENABLED = process.env.COMPETITION_MODE === 'true' || process.env.NODE_ENV === 'competition';
const COMPETITION_MODE_ACK_STRING = 'I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS';
const COMPETITION_MODE_ACK = process.env.COMPETITION_MODE_ACK === COMPETITION_MODE_ACK_STRING;
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
    console.warn(
        '\n' +
        '╔══════════════════════════════════════════════════════════════════════════════╗\n' +
        '║  ⚠️  COMPETITION MODE ENABLED - AGGRESSIVE RISK SETTINGS ACTIVE              ║\n' +
        '╠══════════════════════════════════════════════════════════════════════════════╣\n' +
        '║  This mode is for DEMO/PAPER TRADING ONLY!                                   ║\n' +
        '║  Settings: 20x max leverage, 50% max position size                           ║\n' +
        '║  Account Type: ' + (WEEX_ACCOUNT_TYPE || 'NOT SET').padEnd(46) + '║\n' +
        '║  VERIFY YOUR ACCOUNT IS A DEMO ACCOUNT BEFORE PROCEEDING!                    ║\n' +
        '╚══════════════════════════════════════════════════════════════════════════════╝\n'
    );

    if (typeof logger !== 'undefined' && logger.warn) {
        logger.warn('COMPETITION MODE ENABLED', {
            competitionMode: true,
            acknowledgment: 'ACCEPTED',
            accountType: WEEX_ACCOUNT_TYPE || 'NOT_SET',
            maxLeverage: 20,
            maxPositionSizePercent: 50
        });
    }
}

const PRODUCTION_DEFAULTS = {
    MAX_SAFE_LEVERAGE: 10,
    AUTO_APPROVE_LEVERAGE_THRESHOLD: 5,
    ABSOLUTE_MAX_LEVERAGE: 15,
    MAX_POSITION_SIZE_PERCENT: 25,
    MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT: 40,
    MAX_RISK_PER_TRADE_PERCENT: 5,
    MAX_CONCURRENT_RISK_PERCENT: 15,
};

const COMPETITION_SETTINGS = {
    MAX_SAFE_LEVERAGE: 20,
    AUTO_APPROVE_LEVERAGE_THRESHOLD: 15,
    ABSOLUTE_MAX_LEVERAGE: 20,
    MAX_POSITION_SIZE_PERCENT: 50,
    MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT: 60,
    MAX_RISK_PER_TRADE_PERCENT: 10,
    MAX_CONCURRENT_RISK_PERCENT: 25,
};

// Select settings based on mode
const ACTIVE_SETTINGS = USE_COMPETITION_SETTINGS ? COMPETITION_SETTINGS : PRODUCTION_DEFAULTS;

/**
 * Runtime guard to validate competition mode is properly configured
 * Call this from trade-executing entry points to prevent trades with misconfigured settings
 * 
 * NOTE: This validates USE_COMPETITION_SETTINGS (not just COMPETITION_MODE_ENABLED) so the
 * check only throws when competition settings are actually being used. The startup-time
 * throws above handle the fail-fast for misconfigured COMPETITION_MODE_ENABLED cases.
 * 
 * @throws Error if competition settings are active but configuration is invalid
 * @returns true if settings are valid for trading
 */
export function validateCompetitionMode(): boolean {
    // Only validate when competition settings are actually in use
    if (USE_COMPETITION_SETTINGS) {
        // Block if account type is explicitly live (defense-in-depth, should be caught at startup)
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
 * Call this at startup to block the engine from running in competition mode on live accounts
 * 
 * NOTE: This function is now mostly redundant since we fail fast at module load time,
 * but kept for explicit validation calls and clearer error messages in specific contexts.
 * 
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
        // FAIL FAST: No longer allow missing account type (removed legacy warn-but-allow behavior)
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
 * Call this before executing each trade to log warnings and optionally block
 * 
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

    // Log warning for every trade in competition mode
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

    // Block if account type is live (should have been caught earlier, but defense in depth)
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

export const GLOBAL_RISK_LIMITS = {
    // Maximum leverage - allow full range for competition
    MAX_SAFE_LEVERAGE: ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE,

    // Threshold for auto-approved leverage (no extra confidence required)
    // Renamed from CONSERVATIVE_LEVERAGE_THRESHOLD for clarity
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

    // Position leverage scaling - computed from ACTIVE_SETTINGS for mode-awareness
    // Keys reflect actual thresholds used in getMaxLeverageForExposure()
    // WINNER EDITION v5.4.0: More permissive scaling for competition
    // At 40% exposure: Math.floor(17 * 0.82) = Math.floor(13.94) = 13x
    // At 50% exposure: Math.floor(17 * 0.70) = Math.floor(11.9) = 11x
    POSITION_LEVERAGE_SCALING: {
        // When exposure > 40%: reduce to 82% of max safe leverage (minimum 1x)
        THRESHOLD_40_PERCENT: { maxLeverage: Math.max(1, Math.floor(ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE * 0.82)) },
        // When exposure > 50%: reduce to 70% of max safe leverage (minimum 1x)
        THRESHOLD_50_PERCENT: { maxLeverage: Math.max(1, Math.floor(ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE * 0.70)) },
    },

    // Correlation checks - ENABLED for proper risk management
    // All 8 crypto pairs are correlated to BTC, so we need to track this
    ENABLE_CORRELATION_CHECKS: true,

    // Correlation risk thresholds
    CORRELATION_THRESHOLDS: {
        HIGH_CORRELATION: 0.8,      // Pairs with >0.8 correlation are considered highly correlated
        MAX_CORRELATED_POSITIONS: 2, // Max positions in highly correlated assets
        BTC_CORRELATION_WARNING: 0.85, // Warn if portfolio is >85% correlated to BTC
    },

    // Circuit breakers - higher thresholds for competition
    CIRCUIT_BREAKERS: {
        YELLOW_ALERT: {
            BTC_DROP_4H: 12,
            PORTFOLIO_DRAWDOWN_24H: 15,
            ACTION: 'Reduce leverage to 10x max'
        },
        RED_ALERT: {
            BTC_DROP_4H: 20,
            PORTFOLIO_DRAWDOWN_24H: 30,
            ACTION: 'Review positions'
        }
    },

    // Stop loss requirements - FIXED: inversely proportional to leverage
    // Higher leverage = tighter stop loss to keep max capital loss ~30%
    // Formula: maxStopPercent ≈ 30% / maxLeverage (with some buffer)
    STOP_LOSS_BY_LEVERAGE: {
        LOW: { maxLeverage: 5, maxStopPercent: 6 },      // 5x * 6% = 30% max loss
        MEDIUM: { maxLeverage: 10, maxStopPercent: 3 },  // 10x * 3% = 30% max loss
        HIGH: { maxLeverage: 15, maxStopPercent: 2 },    // 15x * 2% = 30% max loss
        EXTREME: { maxLeverage: 20, maxStopPercent: 1.5 }, // 20x * 1.5% = 30% max loss
    },

    // Flag indicating if competition mode is active (with proper acknowledgment)
    COMPETITION_MODE_ENABLED: USE_COMPETITION_SETTINGS,
};

/**
 * Check if leverage is auto-approved (uses AUTO_APPROVE_LEVERAGE_THRESHOLD)
 */
export function isLeverageAutoApproved(leverage: number, confidence: number): boolean {
    // Validate inputs
    if (!Number.isFinite(leverage) || leverage <= 0) {
        return false;
    }
    if (!Number.isFinite(confidence)) {
        confidence = 50; // Default to moderate confidence
    }

    // Up to AUTO_APPROVE_LEVERAGE_THRESHOLD always approved
    if (leverage <= GLOBAL_RISK_LIMITS.AUTO_APPROVE_LEVERAGE_THRESHOLD) {
        return true;
    }
    // Above threshold up to max requires confidence >= 70%
    if (leverage > GLOBAL_RISK_LIMITS.ABSOLUTE_MAX_LEVERAGE) {
        return false;
    }
    return confidence >= 70;
}

/**
 * Get maximum allowed leverage based on current portfolio exposure (COMPETITION MODE)
 */
export function getMaxLeverageForExposure(currentLeveragedCapitalPercent: number): number {
    // For invalid/unknown exposure, return most conservative leverage (assume high exposure)
    if (!Number.isFinite(currentLeveragedCapitalPercent) || currentLeveragedCapitalPercent < 0) {
        return GLOBAL_RISK_LIMITS.POSITION_LEVERAGE_SCALING.THRESHOLD_50_PERCENT.maxLeverage;
    }

    // More permissive scaling for competition
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
    // Validate input - return most conservative stop for invalid leverage
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
 * 
 * In crypto, all assets are highly correlated to BTC. This function checks:
 * 1. How many highly correlated positions are already open
 * 2. Whether adding this position would exceed correlation limits
 * 
 * @param newSymbol - Symbol to potentially add
 * @param existingPositions - Array of existing position symbols
 * @param correlationMatrix - Correlation matrix from QuantAnalysisService
 * @returns { allowed: boolean, warning: string | null, correlationRisk: number }
 */
export function checkCorrelationRisk(
    newSymbol: string,
    existingPositions: string[],
    correlationMatrix: Map<string, Map<string, number>> | null
): { allowed: boolean; warning: string | null; correlationRisk: number } {
    // If correlation checks are disabled, always allow
    if (!GLOBAL_RISK_LIMITS.ENABLE_CORRELATION_CHECKS) {
        return { allowed: true, warning: null, correlationRisk: 0 };
    }

    // If no correlation data available, enforce conservative default
    // Block if already have positions (can't assess correlation risk)
    if (!correlationMatrix || correlationMatrix.size === 0) {
        // If no existing positions, allow the first trade
        if (!existingPositions || existingPositions.length === 0) {
            return {
                allowed: true,
                warning: 'Correlation data unavailable - first position allowed, subsequent trades will be limited',
                correlationRisk: 0.5 // Assume moderate risk when unknown
            };
        }

        // Conservative default: max 1 position per asset when correlation data unavailable
        // This prevents concentrated BTC exposure during cold-start or data outage
        return {
            allowed: false,
            warning: `Correlation data unavailable - blocking trade to prevent concentrated exposure. ` +
                `Already have ${existingPositions.length} position(s). Wait for correlation data or reduce positions.`,
            correlationRisk: 0.8 // Assume high risk when unknown with existing positions
        };
    }

    // If no existing positions, no correlation risk
    if (!existingPositions || existingPositions.length === 0) {
        return { allowed: true, warning: null, correlationRisk: 0 };
    }

    const { HIGH_CORRELATION, MAX_CORRELATED_POSITIONS } = GLOBAL_RISK_LIMITS.CORRELATION_THRESHOLDS;

    // Normalize symbol for lookup (handle cmt_ prefix variations)
    const normalizeSymbol = (sym: string): string => {
        return sym.toLowerCase().replace(/^cmt_/, '');
    };

    const newSymNorm = normalizeSymbol(newSymbol);
    let highlyCorrelatedCount = 0;
    let maxCorrelation = 0;
    const correlatedWith: string[] = [];

    // Check correlation with each existing position
    for (const existingSymbol of existingPositions) {
        const existingSymNorm = normalizeSymbol(existingSymbol);

        // Try to find correlation in matrix (check both directions)
        let correlation = 0;

        // Try newSymbol -> existingSymbol
        // Check all key variations: symNorm, ${symNorm}usdt, cmt_${symNorm}usdt
        const newSymRow = correlationMatrix.get(newSymNorm) || correlationMatrix.get(`${newSymNorm}usdt`) || correlationMatrix.get(`cmt_${newSymNorm}usdt`);
        if (newSymRow) {
            correlation = newSymRow.get(existingSymNorm) || newSymRow.get(`${existingSymNorm}usdt`) || newSymRow.get(`cmt_${existingSymNorm}usdt`) || 0;
        }

        // If not found, try existingSymbol -> newSymbol
        // Check all key variations: symNorm, ${symNorm}usdt, cmt_${symNorm}usdt
        if (correlation === 0) {
            const existingSymRow = correlationMatrix.get(existingSymNorm) || correlationMatrix.get(`${existingSymNorm}usdt`) || correlationMatrix.get(`cmt_${existingSymNorm}usdt`);
            if (existingSymRow) {
                correlation = existingSymRow.get(newSymNorm) || existingSymRow.get(`${newSymNorm}usdt`) || existingSymRow.get(`cmt_${newSymNorm}usdt`) || 0;
            }
        }

        // Track max correlation
        if (Math.abs(correlation) > maxCorrelation) {
            maxCorrelation = Math.abs(correlation);
        }

        // Count highly correlated positions
        if (Math.abs(correlation) >= HIGH_CORRELATION) {
            highlyCorrelatedCount++;
            correlatedWith.push(`${existingSymbol} (${(correlation * 100).toFixed(0)}%)`);
        }
    }

    // Calculate overall correlation risk (0-1 scale)
    const correlationRisk = Math.min(1, (highlyCorrelatedCount / MAX_CORRELATED_POSITIONS) * maxCorrelation);

    // Check if we exceed the limit
    if (highlyCorrelatedCount >= MAX_CORRELATED_POSITIONS) {
        return {
            allowed: false,
            warning: `Correlation limit exceeded: ${newSymbol} is highly correlated with ${correlatedWith.join(', ')}. ` +
                `Max ${MAX_CORRELATED_POSITIONS} highly correlated positions allowed.`,
            correlationRisk
        };
    }

    // Allow but warn if approaching limit
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
 * 
 * Since all crypto assets are correlated to BTC, this measures how
 * concentrated the portfolio's BTC exposure is.
 * 
 * @param positions - Array of position symbols
 * @param correlationMatrix - Correlation matrix from QuantAnalysisService
 * @returns Average BTC correlation of the portfolio (0-1)
 */
export function calculatePortfolioBtcCorrelation(
    positions: string[],
    correlationMatrix: Map<string, Map<string, number>> | null
): number {
    if (!positions || positions.length === 0) return 0;
    if (!correlationMatrix || correlationMatrix.size === 0) return 0.7; // Assume high correlation when unknown

    const normalizeSymbol = (sym: string): string => {
        return sym.toLowerCase().replace(/^cmt_/, '').replace(/usdt$/, '');
    };

    let totalCorrelation = 0;
    let count = 0;

    // Get BTC row from correlation matrix
    const btcRow = correlationMatrix.get('btcusdt') || correlationMatrix.get('cmt_btcusdt') || correlationMatrix.get('btc');

    for (const symbol of positions) {
        const symNorm = normalizeSymbol(symbol);

        // BTC is perfectly correlated with itself
        if (symNorm === 'btc') {
            totalCorrelation += 1;
            count++;
            continue;
        }

        // Try to find BTC correlation
        let btcCorr = 0;
        if (btcRow) {
            btcCorr = btcRow.get(symNorm) || btcRow.get(`cmt_${symNorm}usdt`) || btcRow.get(`${symNorm}usdt`) || 0;
        }

        // If not found in BTC row, try the symbol's row
        // Check all key variations: symNorm, ${symNorm}usdt, cmt_${symNorm}usdt
        if (btcCorr === 0) {
            const symRow = correlationMatrix.get(symNorm) || correlationMatrix.get(`${symNorm}usdt`) || correlationMatrix.get(`cmt_${symNorm}usdt`);
            if (symRow) {
                btcCorr = symRow.get('btcusdt') || symRow.get('cmt_btcusdt') || symRow.get('btc') || 0;
            }
        }

        // Default to high correlation if not found (crypto is generally correlated)
        if (btcCorr === 0) btcCorr = 0.7;

        totalCorrelation += Math.abs(btcCorr);
        count++;
    }

    return count > 0 ? totalCorrelation / count : 0;
}
