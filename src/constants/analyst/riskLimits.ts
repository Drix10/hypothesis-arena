/**
 * Global Risk Management Constants
 * 
 * COMPETITION MODE: Aggressive settings for demo money competition.
 * Top 2 profit wins in 3 weeks - we need to trade actively.
 * 
 * IMPORTANT: These aggressive settings are ONLY safe when COMPETITION_MODE is enabled.
 * In production, use conservative defaults to protect capital.
 */

// Competition mode flag - must be explicitly enabled via environment variable
// Default: false (safe production mode)
const COMPETITION_MODE_ENABLED = process.env.COMPETITION_MODE === 'true' || process.env.NODE_ENV === 'competition';

// Competition mode acknowledgment - required when COMPETITION_MODE is enabled
// This prevents accidental activation of aggressive settings
const COMPETITION_MODE_ACK = process.env.COMPETITION_MODE_ACK === 'I_UNDERSTAND_THE_RISKS';

// Validate competition mode configuration
if (COMPETITION_MODE_ENABLED && !COMPETITION_MODE_ACK) {
    console.warn(
        '⚠️ COMPETITION MODE ENABLED but acknowledgment missing!\n' +
        '   To enable competition mode, set BOTH environment variables:\n' +
        '   - COMPETITION_MODE=true\n' +
        '   - COMPETITION_MODE_ACK=I_UNDERSTAND_THE_RISKS\n' +
        '   Falling back to PRODUCTION settings for safety.'
    );
}

// Only use competition settings if BOTH flag and acknowledgment are set
const USE_COMPETITION_SETTINGS = COMPETITION_MODE_ENABLED && COMPETITION_MODE_ACK;

// Log warning if competition mode is fully enabled
if (USE_COMPETITION_SETTINGS) {
    console.warn('⚠️ COMPETITION MODE ENABLED: Using aggressive risk settings. NOT suitable for production!');
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
 * @throws Error if competition mode is enabled but not acknowledged
 * @returns true if settings are valid for trading
 */
export function validateCompetitionMode(): boolean {
    if (COMPETITION_MODE_ENABLED && !COMPETITION_MODE_ACK) {
        throw new Error(
            'COMPETITION_MODE is enabled but COMPETITION_MODE_ACK is missing. ' +
            'Set COMPETITION_MODE_ACK=I_UNDERSTAND_THE_RISKS to acknowledge aggressive settings, ' +
            'or disable COMPETITION_MODE for production-safe defaults.'
        );
    }
    return true;
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
