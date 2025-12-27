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
import { riskPrompt } from './quant';
import { quantPrompt } from './risk';
import { contrarianPrompt } from './contrarian';
import {
    buildCoinSelectionPrompt,
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt,
    buildSingleJudgeFallbackPrompt,
    buildTournamentDebatePrompt
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
    buildCoinSelectionPrompt,
    buildSpecialistPrompt,
    buildRiskCouncilPrompt,
    buildDebatePrompt,
    buildSingleJudgeFallbackPrompt,
    buildTournamentDebatePrompt
};

// Export helper functions and types
export * from './promptHelpers';
export * from './promptTypes';
