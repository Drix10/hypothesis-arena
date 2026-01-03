/**
 * Analyst System Prompts
 * 
 * Complete system prompts for all 4 specialized analysts.
 * Each analyst has a unique methodology and perspective on crypto trading.
 */

import type { AnalystMethodology } from '../analyst/types';
import { technicalPrompt } from './technical';
import { macroPrompt } from './macro';
import { riskPrompt } from './risk';
import { quantPrompt } from './quant';
import {
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt
} from './builders';

export const THESIS_SYSTEM_PROMPTS: Record<AnalystMethodology, string> = {
    technical: technicalPrompt,
    macro: macroPrompt,
    risk: riskPrompt,
    quant: quantPrompt
};

export { technicalPrompt, macroPrompt, riskPrompt, quantPrompt };
export {
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt
};

// Export manage prompts for position management
export {
    assessPositionHealth,
    buildPositionAnalysis,
    buildManageDecisionPrompt,
    buildPortfolioManagementSummary,
    MANAGE_TRADING_RULES
} from './managePrompts';
export type { ManageActionType, ManageActionSchema, PositionHealthMetrics } from './managePrompts';

// Export helper functions and types
export * from './promptHelpers';
export * from './promptTypes';

// Export debate contexts and helpers
export { DEBATE_CONTEXTS, DEBATE_TURN_INSTRUCTIONS } from './debateContexts';
export {
    buildCoinSelectionContext,
    buildChampionshipContext,
    buildDebateTurnPrompt
} from './debateHelpers';
