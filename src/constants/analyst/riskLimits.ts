/**
 * Global Risk Management Constants
 * 
 * COMPETITION MODE: Aggressive settings for demo money competition.
 * Top 2 profit wins in 3 weeks - we need to trade actively.
 * 
 * IMPORTANT: These aggressive settings are ONLY safe when COMPETITION_MODE is enabled.
 * In production, use conservative defaults to protect capital.
 * 
 * RUNTIME PROTECTIONS (v5.3.0):
 * 1. validateCompetitionMode() - Validates config at startup
 * 2. validateAccountTypeForCompetition() - Blocks if WEEX_ACCOUNT_TYPE=live
 * 3. guardCompetitionModeTrade() - Per-trade guard with logging
 */

import { logger } from '../../utils/logger';

// Competition mode flag - must be explicitly enabled via environment variable
// Default: false (safe production mode)
const COMPETITION_MODE_ENABLED = process.env.COMPETITION_MODE === 'true' || process.env.NODE_ENV === 'competition';

// Competition mode acknowledgment - required when COMPETITION_MODE is enabled
// This prevents accidental activation of aggressive settings
// The acknowledgment string must match EXACTLY to enable competition mode
const COMPETITION_MODE_ACK_STRING = 'I_ACCEPT_DEMO_ONLY_HIGH_RISK_AGGRESSIVE_SETTINGS';
const COMPETITION_MODE_ACK = process.env.COMPETITION_MODE_ACK === COMPETITION_MODE_ACK_STRING;

// Account type declaration - explicit safeguard against running on live accounts
// Values: 'demo' | 'test' | 'live' | undefined
const WEEX_ACCOUNT_TYPE = process.env.WEEX_ACCOUNT_TYPE?.trim()?.toLowerCase();

// Validate competition mode configuration
if (COMPETITION_MODE_ENABLED && !COMPETITION_MODE_ACK) {
    console.warn(
        '⚠️ COMPETITION MODE ENABLED but acknowledgment missing or incorrect!\n' +
        '   To enable competition mode, set BOTH environment variables:\n' +
        '   - COMPETITION_MODE=true\n' +
        `   - COMPETITION_MODE_ACK=${COMPETITION_MODE_ACK_STRING}\n` +
        '   Using PRODUCTION settings (competition settings require acknowledgment).'
    );
}

// Block competition mode if account type is explicitly set to 'live'
const ACCOUNT_TYPE_BLOCKS_COMPETITION = WEEX_ACCOUNT_TYPE === 'live';

// Valid account types for competition mode: 'demo' or 'test'
const VALID_COMPETITION_ACCOUNT_TYPES = ['demo', 'test'];

// FAIL FAST: Block competition mode if account type is not explicitly set to 'demo' or 'test'
// This removes the legacy warn-but-allow behavior for safety
const ACCOUNT_TYPE_MISSING_FOR_COMPETITION = COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK && !WEEX_ACCOUNT_TYPE;
const ACCOUNT_TYPE_INVALID_FOR_COMPETITION = COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK &&
    WEEX_ACCOUNT_TYPE && !VALID_COMPETITION_ACCOUNT_TYPES.includes(WEEX_ACCOUNT_TYPE) && WEEX_ACCOUNT_TYPE !== 'live';

if (COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK && ACCOUNT_TYPE_BLOCKS_COMPETITION) {
    // Throw error to fail fast - do not allow startup with live account in competition mode
    throw new Error(
        '🚫 STARTUP BLOCKED: COMPETITION_MODE is enabled but WEEX_ACCOUNT_TYPE is set to "live"!\n' +
        '   Competition mode is ONLY for demo/paper trading accounts.\n' +
        '   Either:\n' +
        '   - Set WEEX_ACCOUNT_TYPE=demo if this is a demo account\n' +
        '   - Remove COMPETITION_MODE=true if this is a live account\n' +
        '   \n' +
        '   Environment variables involved:\n' +
        '   - COMPETITION_MODE=true (currently set)\n' +
        '   - COMPETITION_MODE_ACK=<acknowledged> (currently set)\n' +
        '   - WEEX_ACCOUNT_TYPE=live (BLOCKING - must be "demo" or "test" for competition mode)'
    );
}

if (ACCOUNT_TYPE_MISSING_FOR_COMPETITION) {
    // Throw error to fail fast - WEEX_ACCOUNT_TYPE is REQUIRED for competition mode
    throw new Error(
        '🚫 STARTUP BLOCKED: COMPETITION_MODE is enabled but WEEX_ACCOUNT_TYPE is not set!\n' +
        '   Competition mode REQUIRES explicit account type declaration.\n' +
        '   Set WEEX_ACCOUNT_TYPE=demo to confirm this is a demo account.\n' +
        '   \n' +
        '   Environment variables involved:\n' +
        '   - COMPETITION_MODE=true (currently set)\n' +
        '   - COMPETITION_MODE_ACK=<acknowledged> (currently set)\n' +
        '   - WEEX_ACCOUNT_TYPE=<not set> (REQUIRED - must be "demo" or "test" for competition mode)'
    );
}

if (ACCOUNT_TYPE_INVALID_FOR_COMPETITION) {
    // Throw error to fail fast - WEEX_ACCOUNT_TYPE has invalid value
    // Note: "live" is handled separately above with a specific error message
    throw new Error(
        `🚫 STARTUP BLOCKED: COMPETITION_MODE is enabled but WEEX_ACCOUNT_TYPE="${WEEX_ACCOUNT_TYPE}" is invalid!\n` +
        '   Competition mode requires WEEX_ACCOUNT_TYPE to be "demo" or "test".\n' +
        '   Valid values: "demo", "test" (for competition mode), or "live" (blocks competition mode)\n' +
        '   \n' +
        '   Environment variables involved:\n' +
        '   - COMPETITION_MODE=true (currently set)\n' +
        '   - COMPETITION_MODE_ACK=<acknowledged> (currently set)\n' +
        `   - WEEX_ACCOUNT_TYPE=${WEEX_ACCOUNT_TYPE} (INVALID - must be "demo" or "test" for competition mode)`
    );
}

// Only use competition settings if:
// 1. COMPETITION_MODE=true
// 2. COMPETITION_MODE_ACK matches exactly
// 3. WEEX_ACCOUNT_TYPE is 'demo' or 'test' (not 'live', not missing, not invalid)
// Note: The throws above ensure we never reach here with invalid config,
// but we add explicit check for defense-in-depth
const USE_COMPETITION_SETTINGS = COMPETITION_MODE_ENABLED &&
    COMPETITION_MODE_ACK &&
    !ACCOUNT_TYPE_BLOCKS_COMPETITION &&
    VALID_COMPETITION_ACCOUNT_TYPES.includes(WEEX_ACCOUNT_TYPE || '');

// Log warning if competition mode is fully enabled
if (USE_COMPETITION_SETTINGS) {
    console.warn(
        '\n' +
        '╔══════════════════════════════════════════════════════════════════════════════╗\n' +
        '║  ⚠️  COMPETITION MODE ENABLED - AGGRESSIVE RISK SETTINGS ACTIVE              ║\n' +
        '╠══════════════════════════════════════════════════════════════════════════════╣\n' +
        '║  This mode is for DEMO/PAPER TRADING ONLY!                                   ║\n' +
        '║                                                                              ║\n' +
        '║  Settings: 20x max leverage, 50% max position size                           ║\n' +
        '║  Account Type: ' + (WEEX_ACCOUNT_TYPE || 'NOT SET (please set WEEX_ACCOUNT_TYPE=demo)').padEnd(46) + '║\n' +
        '║                                                                              ║\n' +
        '║  VERIFY YOUR ACCOUNT IS A DEMO ACCOUNT BEFORE PROCEEDING!                    ║\n' +
        '╚══════════════════════════════════════════════════════════════════════════════╝\n'
    );

    // Also log to file logger for audit trail
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

// Production-safe defaults
const PRODUCTION_DEFAULTS = {
    MAX_SAFE_LEVERAGE: 10,
    AUTO_APPROVE_LEVERAGE_THRESHOLD: 5,
    ABSOLUTE_MAX_LEVERAGE: 15,
    MAX_POSITION_SIZE_PERCENT: 25,
    MAX_TOTAL_LEVERAGED_CAPITAL_PERCENT: 40,
    MAX_RISK_PER_TRADE_PERCENT: 5,
    MAX_CONCURRENT_RISK_PERCENT: 15,
};

// Competition-aggressive settings
const COMPETITION_SETTINGS = {
    MAX_SAFE_LEVERAGE: 15,
    AUTO_APPROVE_LEVERAGE_THRESHOLD: 10,
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
    // FIXED: Use Math.max(1, ...) to prevent 0 leverage when MAX_SAFE_LEVERAGE is very low
    POSITION_LEVERAGE_SCALING: {
        // When exposure > 40%: reduce to 2/3 of max safe leverage (minimum 1x)
        THRESHOLD_40_PERCENT: { maxLeverage: Math.max(1, Math.floor(ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE * 0.67)) },
        // When exposure > 50%: reduce to 1/2 of max safe leverage (minimum 1x)
        THRESHOLD_50_PERCENT: { maxLeverage: Math.max(1, Math.floor(ACTIVE_SETTINGS.MAX_SAFE_LEVERAGE * 0.53)) },
    },

    // Correlation checks disabled for speed
    ENABLE_CORRELATION_CHECKS: false,

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
