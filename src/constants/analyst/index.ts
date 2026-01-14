/**
 * Analyst Constants - v5.0.0
 * 
 * Central export for analyst types, profiles, and risk management.
 * 
 * ARCHITECTURE NOTE:
 * - ANALYST_PROFILES (from profiles.ts) contains the full analyst agent definitions
 *   with metadata like avatarEmoji, focusAreas, biases, etc.
 * - This module re-exports ANALYST_PROFILES directly from profiles.ts
 * - The prompt building functions are imported from analystPrompt.ts which also
 *   imports ANALYST_PROFILES from profiles.ts (no circular dependency)
 * 
 * Import graph:
 *   profiles.ts -> ANALYST_PROFILES
 *   analystPrompt.ts -> imports ANALYST_PROFILES from profiles.ts
 *   index.ts (this file) -> imports from both (no cycle)
 */

// Types
export type { AnalystMethodology, AnalystAgent } from './types';

// Profiles - Full analyst definitions with metadata
export { ANALYST_PROFILES } from './profiles';

// Risk Management
export {
    GLOBAL_RISK_LIMITS,
    validateCompetitionMode,
    validateAccountTypeForCompetition,
    guardCompetitionModeTrade,
    isCompetitionModeAllowed,
    isLeverageAutoApproved,
    getMaxLeverageForExposure,
    getRequiredStopLossPercent
} from './riskLimits';
export { RISK_COUNCIL_VETO_TRIGGERS } from './riskCouncil';

// v5.0.0: Export prompt building functions
// NOTE: These are imported from analystPrompt.ts which has its own import of ANALYST_PROFILES
export {
    buildAnalystPrompt,
    buildAnalystUserMessage,
    ANTI_CHURN_RULES,
    LEVERAGE_POLICY,
    OUTPUT_FORMAT
} from '../prompts/analystPrompt';

export {
    buildJudgeSystemPrompt,
    buildJudgeUserMessage
} from '../prompts/judgePrompt';
