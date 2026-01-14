export type AnalystMethodology =
    | 'technical'
    | 'macro'
    | 'ml'
    | 'risk'
    | 'quant';

export interface AnalystAgent {
    id: string;
    name: string;
    title: string;
    methodology: AnalystMethodology;
    avatarEmoji: string;
    /** Concise summary of the analyst’s methodology and perspective */
    description: string;
    /** Topics and metrics the analyst prioritizes (e.g., funding %, TVL) */
    focusAreas: string[];
    /** Known blind spots or tendencies to watch for in analysis */
    biases: string[];
    /** Collaborative pipeline role as defined in FLOW.md */
    pipelineRole: 'coin_selector' | 'specialist' | 'risk_council';
    /** Coin categories where the analyst is most effective */
    coinTypeSpecialty: ('blue_chip' | 'l1_growth' | 'momentum_meme' | 'utility')[];
    /** Strengths aligned to judging criteria (DATA, LOGIC, RISK, CATALYST) */
    tournamentStrengths: string[];
}
