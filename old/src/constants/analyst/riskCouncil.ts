import { config } from '../../config';
import { GLOBAL_RISK_LIMITS, getRequiredStopLossPercent } from './riskLimits';
import { logger } from '../../utils/logger';

function isValidPositiveInt(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val) && val >= 1;
}

function isValidPositivePercent(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val) && val >= 0;
}

function isValidPercent0to100(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val) && val >= 0 && val <= 100;
}

// Get values from config where available, use safe defaults as fallback
const rawMaxConcurrentPositions = config.autonomous?.maxConcurrentPositions;
const rawMaxSameDirectionPositions = config.autonomous?.maxSameDirectionPositions;
const rawWeeklyDrawdownLimitPercent = config.autonomous?.weeklyDrawdownLimitPercent;
const rawHighConfidenceThreshold = config.autonomous?.highConfidenceThreshold;

let maxConcurrentPositions = isValidPositiveInt(rawMaxConcurrentPositions)
    ? Math.floor(rawMaxConcurrentPositions) : 3;
const derivedMaxSameDirection = isValidPositiveInt(rawMaxSameDirectionPositions)
    ? Math.floor(rawMaxSameDirectionPositions) : 2;
const weeklyDrawdownLimitPercent = isValidPositivePercent(rawWeeklyDrawdownLimitPercent)
    ? rawWeeklyDrawdownLimitPercent : 10;

// Post-derivation consistency check: maxSameDirectionPositions must not exceed maxConcurrentPositions
// Track original derived value BEFORE clamping for accurate logging
let maxSameDirectionPositions = derivedMaxSameDirection;
const wasClampedForConsistency = maxSameDirectionPositions > maxConcurrentPositions;
if (wasClampedForConsistency) {
    maxSameDirectionPositions = maxConcurrentPositions;
}

// FIXED: Deferred logging for all warnings (including consistency check)
// This ensures logger is ready before any log calls
let _loggedWarnings = false;
function logConfigWarnings(): void {
    if (_loggedWarnings) return;
    _loggedWarnings = true;

    try {
        if (!isValidPositiveInt(rawMaxConcurrentPositions)) {
            logger.warn('riskCouncil: maxConcurrentPositions not configured or invalid, using fallback: 3');
        }
        if (!isValidPositiveInt(rawMaxSameDirectionPositions)) {
            logger.warn('riskCouncil: maxSameDirectionPositions not configured or invalid, using fallback: 2');
        }
        if (!isValidPositivePercent(rawWeeklyDrawdownLimitPercent)) {
            logger.warn('riskCouncil: weeklyDrawdownLimitPercent not configured or invalid, using fallback: 10');
        }
        if (!isValidPercent0to100(rawHighConfidenceThreshold)) {
            logger.warn('riskCouncil: highConfidenceThreshold not configured or invalid, using fallback: 70');
        }
        // FIXED: Log consistency check warning when value was clamped
        // Uses wasClampedForConsistency flag set BEFORE the clamp operation
        if (wasClampedForConsistency) {
            logger.warn(
                `riskCouncil: maxSameDirectionPositions was adjusted for consistency. ` +
                `Raw values: maxConcurrentPositions=${rawMaxConcurrentPositions}, maxSameDirectionPositions=${rawMaxSameDirectionPositions}. ` +
                `Derived: maxConcurrentPositions=${maxConcurrentPositions}, maxSameDirectionPositions before clamp=${derivedMaxSameDirection}. ` +
                `Adjusted maxSameDirectionPositions to ${maxSameDirectionPositions} to maintain logical consistency (must not exceed maxConcurrentPositions).`
            );
        }
    } catch {
        // Logger not ready - silently ignore
    }
}

if (typeof setImmediate !== 'undefined') {
    setImmediate(logConfigWarnings);
} else {
    const timeoutId = setTimeout(logConfigWarnings, 0);
    if ((timeoutId as any).unref) {
        (timeoutId as any).unref();
    }
}

// Use GLOBAL_RISK_LIMITS for risk values
const maxPositionSizePercent = GLOBAL_RISK_LIMITS.MAX_POSITION_SIZE_PERCENT;
const maxLeverage = GLOBAL_RISK_LIMITS.ABSOLUTE_MAX_LEVERAGE;
const maxRiskPerTradePercent = GLOBAL_RISK_LIMITS.MAX_RISK_PER_TRADE_PERCENT;
const maxConcurrentRiskPercent = GLOBAL_RISK_LIMITS.MAX_CONCURRENT_RISK_PERCENT;

const stopLossPercent = getRequiredStopLossPercent(maxLeverage);
const requiredConfidenceForHighLeverage = isValidPercent0to100(rawHighConfidenceThreshold)
    ? Math.floor(rawHighConfidenceThreshold)
    : 70;

// Get from config with fallbacks
const riskCouncilConfig = config.autonomous?.riskCouncil;
const maxFundingAgainstPercent = riskCouncilConfig?.maxFundingAgainstPercent ?? 0.001; // 0.1% default
const maxSectorPositions = riskCouncilConfig?.maxSectorPositions ?? 3;
const netExposureLimits = {
    LONG: riskCouncilConfig?.netExposureLimitLong ?? 70,
    SHORT: riskCouncilConfig?.netExposureLimitShort ?? 70
};

export const RISK_COUNCIL_VETO_TRIGGERS = {
    MAX_POSITION_PERCENT: maxPositionSizePercent,
    MAX_STOP_LOSS_DISTANCE: stopLossPercent,
    MAX_LEVERAGE: maxLeverage,
    CONSERVATIVE_LEVERAGE_THRESHOLD: GLOBAL_RISK_LIMITS.CONSERVATIVE_LEVERAGE_THRESHOLD,
    MAX_CONCURRENT_POSITIONS: maxConcurrentPositions,
    MAX_WEEKLY_DRAWDOWN: weeklyDrawdownLimitPercent,
    MAX_FUNDING_AGAINST: maxFundingAgainstPercent,
    MAX_SAME_DIRECTION_POSITIONS: maxSameDirectionPositions,
    MAX_SECTOR_POSITIONS: maxSectorPositions,
    MAX_RISK_PER_TRADE_PERCENT: maxRiskPerTradePercent,
    MAX_CONCURRENT_RISK_PERCENT: maxConcurrentRiskPercent,
    NET_EXPOSURE_LIMITS: netExposureLimits,
    CHECKLIST: [
        `Position size ≤ ${maxPositionSizePercent}% of account`,
        `Stop loss ≤ ${stopLossPercent}% from entry (tighter for high leverage)`,
        `Leverage ≤ ${maxLeverage}x (>${GLOBAL_RISK_LIMITS.CONSERVATIVE_LEVERAGE_THRESHOLD}x requires >${requiredConfidenceForHighLeverage}% confidence)`,
        `Directional concentration: ≤ ${maxSameDirectionPositions} same-direction positions`,
        `Sector concentration: ≤ ${maxSectorPositions} positions in same sector`,
        `Funding rate: |rate| ≤ ${(maxFundingAgainstPercent * 100).toFixed(1)}% against position`,
        `Risk per trade: ≤ ${maxRiskPerTradePercent}%`,
        `Concurrent risk: ≤ ${maxConcurrentRiskPercent}%`,
        `Weekly drawdown: reduce size if down > ${weeklyDrawdownLimitPercent}%`,
        `Net exposure: LONG ≤ ${netExposureLimits.LONG}%, SHORT ≤ ${netExposureLimits.SHORT}%`
    ]
};
