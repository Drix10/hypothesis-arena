/**
 * Risk Council Veto Triggers (Stage 4 - Karen's Rules from FLOW.md)
 * 
 * These are the HARD RULES that Karen (Risk Council) uses to VETO trades.
 * If ANY of these conditions are true, the trade MUST be vetoed.
 * Used in CollaborativeFlow.ts buildRiskCouncilPrompt()
 */

import { config } from '../../config';
import { GLOBAL_RISK_LIMITS } from './riskLimits';
import { logger } from '../../utils/logger';

// ============================================================================
// Type-guard validators for config values (reusable for derivation + logging)
// ============================================================================

/**
 * Validates that a value is a positive integer >= 1 (for concurrent position counts)
 */
function isValidPositiveInt(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val) && val >= 1;
}

/**
 * Validates that a value is a positive percentage > 0 (for drawdown limits)
 */
function isValidPositivePercent(val: unknown): val is number {
    return typeof val === 'number' && Number.isFinite(val) && val > 0;
}

// Get values from config where available, use safe defaults as fallback
const rawMaxConcurrentPositions = config.autonomous?.maxConcurrentPositions;
const rawMaxSameDirectionPositions = config.autonomous?.maxSameDirectionPositions;
const rawWeeklyDrawdownLimitPercent = config.autonomous?.weeklyDrawdownLimitPercent;

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
    setTimeout(logConfigWarnings, 0);
}

// Use GLOBAL_RISK_LIMITS for risk values
const maxPositionSizePercent = GLOBAL_RISK_LIMITS.MAX_POSITION_SIZE_PERCENT;
const maxLeverage = GLOBAL_RISK_LIMITS.MAX_SAFE_LEVERAGE;
const maxRiskPerTradePercent = GLOBAL_RISK_LIMITS.MAX_RISK_PER_TRADE_PERCENT;
const maxConcurrentRiskPercent = GLOBAL_RISK_LIMITS.MAX_CONCURRENT_RISK_PERCENT;

// Additional risk limits
// FIXED: Use dynamic stop loss based on leverage tier instead of hardcoded 5%
// This aligns with STOP_LOSS_BY_LEVERAGE which has different values per tier
const stopLossPercent = GLOBAL_RISK_LIMITS.STOP_LOSS_BY_LEVERAGE.MEDIUM.maxStopPercent; // Default for display
const maxFundingAgainstPercent = 0.001; // 0.1% - block extreme funding
const maxSectorPositions = 3;
const netExposureLimits = { LONG: 70, SHORT: 70 };

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
        `Leverage ≤ ${maxLeverage}x (>${GLOBAL_RISK_LIMITS.CONSERVATIVE_LEVERAGE_THRESHOLD}x requires >70% confidence)`,
        `Directional concentration: ≤ ${maxSameDirectionPositions} same-direction positions`,
        `Sector concentration: ≤ ${maxSectorPositions} positions in same sector`,
        `Funding rate: |rate| ≤ ${(maxFundingAgainstPercent * 100).toFixed(1)}% against position`,
        `Risk per trade: ≤ ${maxRiskPerTradePercent}%`,
        `Concurrent risk: ≤ ${maxConcurrentRiskPercent}%`,
        `Weekly drawdown: reduce size if down > ${weeklyDrawdownLimitPercent}%`,
        `Net exposure: LONG ≤ ${netExposureLimits.LONG}%, SHORT ≤ ${netExposureLimits.SHORT}%`
    ]
};
