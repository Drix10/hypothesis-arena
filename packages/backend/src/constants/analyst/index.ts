/**
 * Analyst Constants & Prompts
 * 
 * Central export for all analyst-related types, profiles, and prompts.
 * Modular structure for better organization and maintainability.
 */

// Types
export type { AnalystMethodology, AnalystAgent } from './types';

// Profiles
export { ANALYST_PROFILES } from './profiles';

// Risk Management
export { GLOBAL_RISK_LIMITS, MAX_POSITION_SIZE, MAX_TOTAL_LEVERAGE_EXPOSURE } from './riskLimits';
export { RISK_COUNCIL_VETO_TRIGGERS } from './riskCouncil';

// Tournament & Coin Selection
export { TOURNAMENT_JUDGING_CRITERIA } from './tournament';
export { COIN_SELECTION_SCORING, COIN_TYPE_SPECIALISTS } from './coinSelection';

// Prompts
export {
    THESIS_SYSTEM_PROMPTS,
    buildCoinSelectionPrompt,
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt,
    buildSingleJudgeFallbackPrompt,
    buildTournamentDebatePrompt
} from '../prompts';

// Utilities
export { buildThesisPrompt } from './utils';
