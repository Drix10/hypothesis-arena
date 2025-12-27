/**
 * Analyst Type Definitions
 * 
 * Core types for the 8 specialized analyst agents in the Hypothesis Arena.
 */

export type AnalystMethodology =
    | 'value'
    | 'growth'
    | 'technical'
    | 'macro'
    | 'sentiment'
    | 'risk'
    | 'quant'
    | 'contrarian';

export interface AnalystAgent {
    id: string;
    name: string;
    title: string;
    methodology: AnalystMethodology;
    avatarEmoji: string;
    description: string;
    focusAreas: string[];
    biases: string[];
    // New fields for collaborative flow (FLOW.md)
    pipelineRole: 'coin_selector' | 'specialist' | 'risk_council';
    coinTypeSpecialty: ('blue_chip' | 'l1_growth' | 'momentum_meme' | 'utility')[];
    tournamentStrengths: string[];  // What they excel at in debates
}
