/**
 * Risk Council Veto Triggers (Stage 5 - Karen's Rules from FLOW.md)
 * 
 * These are the HARD RULES that Karen (Risk Council) uses to VETO trades.
 * If ANY of these conditions are true, the trade MUST be vetoed.
 * Used in CollaborativeFlow.ts buildRiskCouncilPrompt()
 */

import { config } from '../../config';
import { GLOBAL_RISK_LIMITS } from './riskLimits';
import { logger } from '../../utils/logger';
import { z } from 'zod';

const AutonomousConfigSchema = z.object({
    maxPositionSizePercent: z.number().min(1).max(100),
    stopLossPercent: z.number().min(0.1).max(100),
    maxLeverage: z.number().min(1).max(GLOBAL_RISK_LIMITS.MAX_SAFE_LEVERAGE),
    maxConcurrentPositions: z.number().min(1).max(100),
    weeklyDrawdownLimitPercent: z.number().min(0).max(100),
    maxFundingAgainstPercent: z.number().min(0).max(100),
    maxSameDirectionPositions: z.number().min(1).max(100),
    maxSectorPositions: z.number().min(1).max(100),
    maxRiskPerTradePercent: z.number().min(0).max(100),
    maxConcurrentRiskPercent: z.number().min(0).max(100),
    netExposureLimits: z.object({
        LONG: z.number().min(0).max(100),
        SHORT: z.number().min(0).max(100)
    })
});

const validated = AutonomousConfigSchema.safeParse(config.autonomous);
if (!validated.success) {
    logger.error('Invalid autonomous config', { issues: validated.error.issues });
}

const safeAuto: z.infer<typeof AutonomousConfigSchema> = validated.success ? validated.data : {
    maxPositionSizePercent: 10,
    stopLossPercent: 10,
    maxLeverage: Math.min(GLOBAL_RISK_LIMITS.MAX_SAFE_LEVERAGE, 5),
    maxConcurrentPositions: 3,
    weeklyDrawdownLimitPercent: 10,
    maxFundingAgainstPercent: 0.05,
    maxSameDirectionPositions: 2,
    maxSectorPositions: 3,
    maxRiskPerTradePercent: 2,
    maxConcurrentRiskPercent: 5,
    netExposureLimits: {
        LONG: 60,
        SHORT: 50
    }
};

export const RISK_COUNCIL_VETO_TRIGGERS = {
    MAX_POSITION_PERCENT: safeAuto.maxPositionSizePercent,
    MAX_STOP_LOSS_DISTANCE: safeAuto.stopLossPercent,
    MAX_LEVERAGE: safeAuto.maxLeverage,
    MAX_CONCURRENT_POSITIONS: safeAuto.maxConcurrentPositions,
    MAX_WEEKLY_DRAWDOWN: safeAuto.weeklyDrawdownLimitPercent,
    MAX_FUNDING_AGAINST: safeAuto.maxFundingAgainstPercent,
    MAX_SAME_DIRECTION_POSITIONS: safeAuto.maxSameDirectionPositions,
    MAX_SECTOR_POSITIONS: safeAuto.maxSectorPositions,
    MAX_RISK_PER_TRADE_PERCENT: safeAuto.maxRiskPerTradePercent,
    MAX_CONCURRENT_RISK_PERCENT: safeAuto.maxConcurrentRiskPercent,
    NET_EXPOSURE_LIMITS: {
        LONG: safeAuto.netExposureLimits.LONG,
        SHORT: safeAuto.netExposureLimits.SHORT
    },
    CHECKLIST: [
        `Position size ≤ ${safeAuto.maxPositionSizePercent}% of account`,
        `Stop loss ≤ ${safeAuto.stopLossPercent}% from entry`,
        `Leverage ≤ ${safeAuto.maxLeverage}x`,
        `Directional concentration: ≤ ${safeAuto.maxSameDirectionPositions} same-direction positions`,
        `Sector concentration: ≤ ${safeAuto.maxSectorPositions} positions in the same sector`,
        `Funding rate acceptable: |rate| ≤ ${safeAuto.maxFundingAgainstPercent}% against us`,
        `Volatility regime: reduce size in high volatility`,
        `Recent drawdown: reduce size if down > ${safeAuto.weeklyDrawdownLimitPercent}% this week`,
        `Portfolio heat: risk/trade ≤ ${safeAuto.maxRiskPerTradePercent}%, concurrent risk ≤ ${safeAuto.maxConcurrentRiskPercent}%`,
        `Net exposure guardrails: net LONG ≤ ${safeAuto.netExposureLimits.LONG}%, net SHORT ≤ ${safeAuto.netExposureLimits.SHORT}%`
    ]
};
