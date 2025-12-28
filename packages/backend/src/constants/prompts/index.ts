/**
 * Analyst System Prompts
 * 
 * Complete system prompts for all 8 specialized analysts.
 * Each analyst has a unique methodology and perspective on crypto trading.
 */

import type { AnalystMethodology } from '../analyst/types';
import { valuePrompt } from './value';
import { growthPrompt } from './growth';
import { technicalPrompt } from './technical';
import { macroPrompt } from './macro';
import { sentimentPrompt } from './sentiment';
import { riskPrompt } from './risk';
import { quantPrompt } from './quant';
import { contrarianPrompt } from './contrarian';
import {
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt
} from './builders';

export const THESIS_SYSTEM_PROMPTS: Record<AnalystMethodology, string> = {
    value: valuePrompt,
    growth: growthPrompt,
    technical: technicalPrompt,
    macro: macroPrompt,
    sentiment: sentimentPrompt,
    risk: riskPrompt,
    quant: quantPrompt,
    contrarian: contrarianPrompt
};

export { valuePrompt, growthPrompt, technicalPrompt, macroPrompt, sentimentPrompt, riskPrompt, quantPrompt, contrarianPrompt };
export {
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt
};

// Export helper functions and types
export * from './promptHelpers';
export * from './promptTypes';

// Export debate contexts and helpers
export { DEBATE_CONTEXTS, DEBATE_TURN_INSTRUCTIONS } from './debateContexts';
export {
    buildCoinSelectionContext,
    buildAnalysisApproachContext,
    buildRiskAssessmentContext,
    buildChampionshipContext,
    buildDebateTurnPrompt
} from './debateHelpers';
