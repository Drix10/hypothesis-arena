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
export { GLOBAL_RISK_LIMITS } from './riskLimits';
export { RISK_COUNCIL_VETO_TRIGGERS } from './riskCouncil';

// Prompts
export {
    THESIS_SYSTEM_PROMPTS,
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt
} from '../prompts';
