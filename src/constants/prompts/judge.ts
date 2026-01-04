/**
 * Judge Prompt - Dedicated Debate Adjudicator
 * 
 * The Judge is a specialized AI role that evaluates debate outcomes.
 * Unlike the current system that counts words/metrics, the Judge:
 * 1. Reads the FULL debate transcript
 * 2. Evaluates each argument's actual quality (not just length/count)
 * 3. Applies a rigorous scoring rubric
 * 4. Provides detailed reasoning for the verdict
 * 
 * This replaces the weak `determineDebateWinner()` function that relied on
 * superficial metrics like data point counts and argument lengths.
 */

import { config } from '../../config';
import { SchemaType } from '@google/generative-ai';

/**
 * Get the debate score weights from config
 * These are normalized to sum to 100
 */
function getScoreWeights() {
    return config.debate.scoreWeights;
}

/**
 * Safe number formatting with NaN/undefined protection
 * @param value - Number to format
 * @param decimals - Decimal places
 * @param fallback - Fallback string if invalid
 */
function safeFixed(value: number | undefined | null, decimals: number, fallback: string = 'N/A'): string {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return fallback;
    }
    return value.toFixed(decimals);
}

/**
 * Safe percent formatting with sign
 */
function safePercentWithSign(value: number | undefined | null, decimals: number): string {
    if (value === undefined || value === null || !Number.isFinite(value)) {
        return 'N/A';
    }
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Judge input data structure
 * Contains everything the judge needs to make a fair decision
 */
export interface JudgeInput {
    // Debate context
    debateType: 'coin_selection' | 'championship';
    symbol: string;
    direction: 'LONG' | 'SHORT' | 'MANAGE';

    // Market data at time of debate
    marketData: {
        currentPrice: number;
        change24h: number;
        high24h: number;
        low24h: number;
        volume24h: number;
        fundingRate?: number;
    };

    // Full debate transcript
    turns: Array<{
        speaker: string;        // Analyst ID (jim, ray, karen, quant)
        analystName: string;    // Display name
        argument: string;       // Full argument text
        strength: number;       // Self-reported strength 1-10
        dataPointsReferenced: string[];
    }>;

    // Participating analysts
    analysts: Array<{
        id: string;
        name: string;
        methodology: string;    // technical, macro, risk, quant
    }>;

    // Current portfolio state (for context)
    portfolio?: {
        balance: number;
        openPositions: number;
        unrealizedPnl: number;
        recentPnL: { day: number; week: number };
    };

    // Previous stage winners (to detect dominance patterns)
    previousWinners?: string[];
}

/**
 * Raw judge response structure (matches prompt output format)
 * This is what the AI returns directly - flat winner-only scores
 */
export interface RawJudgeResponse {
    winner: string;             // Analyst ID of the winner
    winnerName: string;         // Display name
    confidence: number;         // 0-100 confidence in verdict
    reasoning: string;          // 2-3 sentence summary
    keyFactors: string[];       // Top 3 factors that decided the outcome

    // Flat winner scores (matches prompt output)
    winnerScore: number;        // 0-100 total score
    winnerDataQuality: number;  // 0-{weights.data} based on config
    winnerLogicCoherence: number; // 0-{weights.logic} based on config
    winnerRiskAwareness: number;  // 0-{weights.risk} based on config
    winnerCatalystClarity: number; // 0-{weights.catalyst} based on config

    // Flags (flat, not nested)
    closeTie: boolean;          // True if score margin is within 3 points
    dominancePattern: boolean;  // True if winner dominated all categories
    lowQualityDebate: boolean;  // True if overall quality was poor
}

/**
 * Individual analyst score breakdown
 */
export interface AnalystScoreBreakdown {
    total: number;          // 0-100 total score
    dataQuality: number;    // 0-{weights.data} based on config
    logicCoherence: number; // 0-{weights.logic} based on config
    riskAwareness: number;  // 0-{weights.risk} based on config
    catalystClarity: number;// 0-{weights.catalyst} based on config
}

/**
 * Judge output structure (normalized for internal use)
 * Contains winner's actual scores and estimated scores for other analysts
 * 
 * NOTE: Only the winner's scores come from the AI. Non-winner scores are
 * estimated based on the winner's score minus a confidence-based margin.
 */
export interface JudgeVerdict {
    winner: string;             // Analyst ID of the winner
    winnerName: string;         // Display name
    confidence: number;         // 0-100 confidence in verdict

    // Scores per analyst (winner = actual from AI, others = estimated)
    // Key is analyst ID (e.g., "technical", "macro", "risk", "quant")
    scores: Record<string, AnalystScoreBreakdown>;

    // Reasoning
    reasoning: string;          // 2-3 sentence summary
    keyFactors: string[];       // Top 3 factors that decided the outcome

    // Warnings/flags
    flags: {
        closeTie: boolean;      // Scores within 3 points (triggers tie-breaker rules)
        dominancePattern: boolean; // Same analyst winning repeatedly
        lowQualityDebate: boolean; // All scores below 50
    };
}

/**
 * Extract winner scores from raw judge response
 * Used when building JudgeVerdict in callJudge()
 * 
 * @param raw - Raw response from AI (or parsed JSON with same shape)
 * @param weights - Score weights from config
 * @returns Winner's score breakdown with validated/clamped values
 */
export function extractWinnerScores(
    raw: Record<string, unknown>,
    weights: { data: number; logic: number; risk: number; catalyst: number }
): AnalystScoreBreakdown {
    // Validate weights with safe defaults (standard 25/25/25/25 split)
    const safeWeights = {
        data: Number.isFinite(weights?.data) && weights.data > 0 ? weights.data : 25,
        logic: Number.isFinite(weights?.logic) && weights.logic > 0 ? weights.logic : 25,
        risk: Number.isFinite(weights?.risk) && weights.risk > 0 ? weights.risk : 25,
        catalyst: Number.isFinite(weights?.catalyst) && weights.catalyst > 0 ? weights.catalyst : 25,
    };

    const safeScore = (value: unknown, defaultVal: number, max: number): number => {
        const num = Number(value);
        if (!Number.isFinite(num)) return defaultVal;
        return Math.min(max, Math.max(0, num));
    };

    // Handle null/undefined raw object
    const safeRaw = raw && typeof raw === 'object' ? raw : {};

    // Default to 60% of max for each component (consistent with estimateNonWinnerScores baseline)
    const defaultDataQuality = Math.round(safeWeights.data * 0.6);
    const defaultLogicCoherence = Math.round(safeWeights.logic * 0.6);
    const defaultRiskAwareness = Math.round(safeWeights.risk * 0.6);
    const defaultCatalystClarity = Math.round(safeWeights.catalyst * 0.6);
    const defaultTotal = defaultDataQuality + defaultLogicCoherence + defaultRiskAwareness + defaultCatalystClarity;

    return {
        total: safeScore(safeRaw.winnerScore, defaultTotal, 100),
        dataQuality: safeScore(safeRaw.winnerDataQuality, defaultDataQuality, safeWeights.data),
        logicCoherence: safeScore(safeRaw.winnerLogicCoherence, defaultLogicCoherence, safeWeights.logic),
        riskAwareness: safeScore(safeRaw.winnerRiskAwareness, defaultRiskAwareness, safeWeights.risk),
        catalystClarity: safeScore(safeRaw.winnerCatalystClarity, defaultCatalystClarity, safeWeights.catalyst),
    };
}

/**
 * Estimate non-winner scores based on winner's score and confidence
 * Higher confidence = larger margin between winner and others
 * 
 * @param winnerScore - Winner's actual scores
 * @param confidence - Judge's confidence (0-100)
 * @param analystIndex - Index of this analyst (for deterministic variation)
 * @returns Estimated score breakdown for non-winner
 */
export function estimateNonWinnerScores(
    winnerScore: AnalystScoreBreakdown,
    confidence: number,
    analystIndex: number
): AnalystScoreBreakdown {
    // Validate inputs - use safe defaults if invalid
    const safeConfidence = Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 70;
    const safeIndex = Number.isFinite(analystIndex) && analystIndex >= 0 ? analystIndex : 0;

    // Safely extract winner scores with fallbacks
    const safeWinnerData = Number.isFinite(winnerScore?.dataQuality) ? winnerScore.dataQuality : 15;
    const safeWinnerLogic = Number.isFinite(winnerScore?.logicCoherence) ? winnerScore.logicCoherence : 15;
    const safeWinnerRisk = Number.isFinite(winnerScore?.riskAwareness) ? winnerScore.riskAwareness : 15;
    const safeWinnerCatalyst = Number.isFinite(winnerScore?.catalystClarity) ? winnerScore.catalystClarity : 15;

    // Calculate margin based on confidence (higher confidence = larger margin)
    const baseMargin = Math.max(5, Math.round((safeConfidence / 100) * 15)); // 5-15 points
    // Cap indexOffset to prevent excessive reduction for later analysts
    // With 4 analysts (indices 0-3), max offset is (3+1)*2 = 8
    const cappedIndex = Math.min(safeIndex, 3);
    const indexOffset = (cappedIndex + 1) * 2; // 2, 4, 6, 8 (capped at 8)
    const componentReduction = Math.ceil((baseMargin + indexOffset) / 4);

    const dataQuality = Math.max(0, safeWinnerData - componentReduction);
    const logicCoherence = Math.max(0, safeWinnerLogic - componentReduction);
    const riskAwareness = Math.max(0, safeWinnerRisk - componentReduction);
    const catalystClarity = Math.max(0, safeWinnerCatalyst - componentReduction);

    return {
        dataQuality,
        logicCoherence,
        riskAwareness,
        catalystClarity,
        total: dataQuality + logicCoherence + riskAwareness + catalystClarity
    };
}

/**
 * Build the judge prompt for evaluating a debate
 * 
 * @param input - Full debate context and transcript
 * @returns Prompt string for the judge AI
 * @throws Error if input is invalid (empty turns or analysts)
 */
export function buildJudgePrompt(input: JudgeInput): string {
    // CRITICAL: Validate input
    if (!input) {
        throw new Error('buildJudgePrompt: input is required');
    }
    if (!input.turns || !Array.isArray(input.turns) || input.turns.length === 0) {
        throw new Error('buildJudgePrompt: turns array is empty or invalid');
    }
    if (!input.analysts || !Array.isArray(input.analysts) || input.analysts.length === 0) {
        throw new Error('buildJudgePrompt: analysts array is empty or invalid');
    }
    if (!input.marketData) {
        throw new Error('buildJudgePrompt: marketData is required');
    }

    const weights = getScoreWeights();

    // Format the debate transcript with safe string handling
    const transcriptLines = input.turns.map((turn, i) => {
        const analystName = turn.analystName || turn.speaker || 'Unknown';
        const speaker = turn.speaker || 'unknown';
        const argument = turn.argument || '[No argument provided]';
        const strength = Number.isFinite(turn.strength) ? turn.strength : 5;
        const dataPoints = Array.isArray(turn.dataPointsReferenced) && turn.dataPointsReferenced.length > 0
            ? `\n   Data cited: ${turn.dataPointsReferenced.filter(Boolean).join(', ')}`
            : '';
        return `[Turn ${i + 1}] ${analystName} (${speaker}):\n   "${argument}"\n   Self-reported strength: ${strength}/10${dataPoints}`;
    }).join('\n\n');

    // Format analyst list with safe string handling
    const analystList = input.analysts.map(a => {
        const name = a.name || a.id || 'Unknown';
        const id = a.id || 'unknown';
        const methodology = a.methodology || 'unknown';
        return `- ${name} (${id}): ${methodology} methodology`;
    }).join('\n');

    // Format market data with safe number handling
    const currentPrice = safeFixed(input.marketData.currentPrice, 2, '0.00');
    const change24h = safePercentWithSign(input.marketData.change24h, 2);
    const low24h = safeFixed(input.marketData.low24h, 2, '0.00');
    const high24h = safeFixed(input.marketData.high24h, 2, '0.00');
    const volume24hVal = input.marketData.volume24h ? input.marketData.volume24h / 1e6 : 0;
    const volume24h = safeFixed(volume24hVal, 1, '0.0');
    const fundingRateStr = input.marketData.fundingRate !== undefined && Number.isFinite(input.marketData.fundingRate)
        ? `\n- Funding Rate: ${(input.marketData.fundingRate * 100).toFixed(4)}%`
        : '';

    const marketInfo = `
- Symbol: ${input.symbol || 'Unknown'}
- Direction: ${input.direction || 'Unknown'}
- Current Price: $${currentPrice}
- 24h Change: ${change24h}
- 24h Range: $${low24h} - $${high24h}
- 24h Volume: $${volume24h}M${fundingRateStr}`;

    // Format portfolio context if available with safe number handling
    let portfolioInfo = '';
    if (input.portfolio) {
        const balance = safeFixed(input.portfolio.balance, 2, '0.00');
        const unrealizedPnl = safeFixed(input.portfolio.unrealizedPnl, 2, '0.00');
        const dayPnl = input.portfolio.recentPnL ? safePercentWithSign(input.portfolio.recentPnL.day, 2) : 'N/A';
        const weekPnl = input.portfolio.recentPnL ? safePercentWithSign(input.portfolio.recentPnL.week, 2) : 'N/A';
        portfolioInfo = `
PORTFOLIO CONTEXT:
- Balance: $${balance}
- Open Positions: ${input.portfolio.openPositions || 0}
- Unrealized P&L: $${unrealizedPnl}
- 24h P&L: ${dayPnl}
- 7d P&L: ${weekPnl}`;
    }

    // Previous winners warning
    let dominanceWarning = '';
    if (input.previousWinners && input.previousWinners.length > 0) {
        const winCounts = input.previousWinners.reduce((acc, id) => {
            acc[id] = (acc[id] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);
        const dominant = Object.entries(winCounts).find(([_, count]) => count >= 2);
        if (dominant) {
            dominanceWarning = `
WARNING - DOMINANCE ALERT: ${dominant[0]} has won ${dominant[1]} recent debates.
Consider if their arguments are genuinely stronger or if there's methodology bias.
Apply extra scrutiny to their claims.`;
        }
    }

    return `DEBATE JUDGE - IMPARTIAL ADJUDICATOR

You are the JUDGE - an impartial adjudicator who determines debate winners.
Your role is to evaluate argument QUALITY, not quantity.

CRITICAL: You must be OBJECTIVE. Do not favor any methodology or analyst.
Judge arguments on their merits, evidence, and logical coherence.

DEBATE TYPE: ${input.debateType.toUpperCase()}

MARKET DATA:${marketInfo}
${portfolioInfo}
${dominanceWarning}

PARTICIPATING ANALYSTS:
${analystList}

SCORING RUBRIC (weights from config)

Score each analyst on these criteria (0-${weights.data} for data, etc.):

1. DATA QUALITY (${weights.data} points max)
   - Uses SPECIFIC numbers, not vague claims ("RSI at 72" vs "RSI is high")
   - References actual market data provided above
   - Quantifies risks and targets with precise figures
   - Cites relevant metrics for their methodology
   
   Scoring guide:
   - ${weights.data} pts: Multiple specific data points, all accurate
   - ${Math.round(weights.data * 0.75)} pts: Good data usage with minor gaps
   - ${Math.round(weights.data * 0.5)} pts: Some specific data, some vague claims
   - ${Math.round(weights.data * 0.25)} pts: Mostly vague, few specifics
   - 0 pts: No specific data, all generic claims

2. LOGIC COHERENCE (${weights.logic} points max)
   - Arguments follow logically from the data
   - Conclusions match the evidence presented
   - No contradictions or logical fallacies
   - Cause-effect relationships are clear
   
   Scoring guide:
   - ${weights.logic} pts: Flawless logic, conclusions fully supported
   - ${Math.round(weights.logic * 0.75)} pts: Strong logic with minor leaps
   - ${Math.round(weights.logic * 0.5)} pts: Reasonable but some unsupported claims
   - ${Math.round(weights.logic * 0.25)} pts: Weak logic, conclusions don't follow
   - 0 pts: Contradictory or illogical arguments

3. RISK AWARENESS (${weights.risk} points max)
   - Acknowledges what could go wrong
   - Has realistic bear case with specific scenarios
   - Identifies thesis invalidation triggers
   - Stop loss reasoning is sound
   
   Scoring guide:
   - ${weights.risk} pts: Comprehensive risk analysis, clear invalidation
   - ${Math.round(weights.risk * 0.75)} pts: Good risk awareness, minor gaps
   - ${Math.round(weights.risk * 0.5)} pts: Some risk mention, not thorough
   - ${Math.round(weights.risk * 0.25)} pts: Minimal risk consideration
   - 0 pts: No risk awareness, overconfident

4. CATALYST CLARITY (${weights.catalyst} points max)
   - Identifies specific price driver
   - Provides timeline (when will catalyst occur)
   - Quantifies expected impact
   - Explains mechanism (why catalyst moves price)
   
   Scoring guide:
   - ${weights.catalyst} pts: Clear catalyst with timeline and impact
   - ${Math.round(weights.catalyst * 0.75)} pts: Good catalyst, minor details missing
   - ${Math.round(weights.catalyst * 0.5)} pts: Vague catalyst or no timeline
   - ${Math.round(weights.catalyst * 0.25)} pts: Generic "will go up/down"
   - 0 pts: No catalyst identified

TOTAL: 100 points (${weights.data} + ${weights.logic} + ${weights.risk} + ${weights.catalyst})

DEBATE TRANSCRIPT:

${transcriptLines}

JUDGING INSTRUCTIONS:

1. Read ALL arguments carefully - don't just count words or data points
2. Evaluate the QUALITY of reasoning, not just presence of keywords
3. Check if data points are ACCURATE against the market data provided
4. Consider if arguments RESPOND to each other (engagement quality)
5. Penalize self-reported strength that doesn't match actual argument quality
6. Be skeptical of confident claims without supporting evidence

TIE-BREAKER RULES (if scores are within 3 points):
1. Prefer the analyst who better addressed counterarguments
2. Prefer the analyst with more actionable recommendations
3. Prefer the analyst who acknowledged their methodology's blind spots

ANTI-BIAS CHECKS:
- Don't favor technical over fundamental or vice versa
- Don't favor bullish over bearish arguments
- Don't favor longer arguments over concise ones
- Judge the SUBSTANCE, not the style

OUTPUT FORMAT - Respond with JSON (ALL fields required):
{
    "winner": "analyst_id",
    "winnerName": "Analyst Display Name",
    "confidence": 0-100,
    "reasoning": "2-3 sentence summary of why the winner prevailed",
    "keyFactors": ["Factor 1", "Factor 2", "Factor 3"],
    "winnerScore": 0-100,
    "winnerDataQuality": 0-${weights.data},
    "winnerLogicCoherence": 0-${weights.logic},
    "winnerRiskAwareness": 0-${weights.risk},
    "winnerCatalystClarity": 0-${weights.catalyst},
    "closeTie": true/false,
    "dominancePattern": true/false,
    "lowQualityDebate": true/false
}

Respond ONLY with valid JSON. No markdown or extra prose.`;
}


/**
 * Build a lightweight judge prompt for coin selection debates
 * Uses less tokens since coin selection is a simpler decision
 * 
 * @throws Error if input is invalid
 */
export function buildCoinSelectionJudgePrompt(input: JudgeInput): string {
    // CRITICAL: Validate input
    if (!input) {
        throw new Error('buildCoinSelectionJudgePrompt: input is required');
    }
    if (!input.turns || !Array.isArray(input.turns) || input.turns.length === 0) {
        throw new Error('buildCoinSelectionJudgePrompt: turns array is empty or invalid');
    }
    if (!input.analysts || !Array.isArray(input.analysts) || input.analysts.length === 0) {
        throw new Error('buildCoinSelectionJudgePrompt: analysts array is empty or invalid');
    }
    if (!input.marketData) {
        throw new Error('buildCoinSelectionJudgePrompt: marketData is required');
    }

    const weights = getScoreWeights();

    // Simplified transcript format with safe handling
    const transcriptLines = input.turns.map((turn, i) => {
        const analystName = turn.analystName || turn.speaker || 'Unknown';
        const argument = turn.argument || '[No argument]';
        const strength = Number.isFinite(turn.strength) ? turn.strength : 5;
        return `[${i + 1}] ${analystName}: "${argument}" (strength: ${strength}/10)`;
    }).join('\n');

    const analystIds = input.analysts.map(a => a.id || 'unknown').join(', ');
    const currentPrice = safeFixed(input.marketData.currentPrice, 2, '0.00');
    const change24h = safePercentWithSign(input.marketData.change24h, 2);

    return `COIN SELECTION JUDGE - Quick Evaluation

Evaluate which analyst made the best case for their coin selection.

MARKET: ${input.symbol || 'Unknown'} ${input.direction || 'Unknown'} | Price: $${currentPrice} | 24h: ${change24h}

ANALYSTS: ${analystIds}

TRANSCRIPT:
${transcriptLines}

SCORING (total 100):
- Data Quality: /${weights.data} (specific numbers vs vague claims)
- Logic: /${weights.logic} (conclusions follow from evidence)
- Risk: /${weights.risk} (acknowledges what could go wrong)
- Catalyst: /${weights.catalyst} (clear price driver with timeline)

OUTPUT JSON (ALL fields required):
{
    "winner": "analyst_id",
    "winnerName": "Name",
    "confidence": 0-100,
    "reasoning": "One sentence why winner prevailed",
    "keyFactors": ["Factor 1", "Factor 2", "Factor 3"],
    "winnerScore": 0-100,
    "winnerDataQuality": 0-${weights.data},
    "winnerLogicCoherence": 0-${weights.logic},
    "winnerRiskAwareness": 0-${weights.risk},
    "winnerCatalystClarity": 0-${weights.catalyst},
    "closeTie": false,
    "dominancePattern": false,
    "lowQualityDebate": false
}`;
}

/**
 * Build the judge response schema with dynamic weight descriptions
 * Used with Gemini structured output - ALL FIELDS REQUIRED to prevent truncation
 * NOTE: Gemini doesn't support additionalProperties, so we define explicit analyst score fields
 * 
 * @returns Schema object with descriptions reflecting current config weights
 */
function buildJudgeResponseSchema() {
    const weights = getScoreWeights();

    return {
        type: SchemaType.OBJECT,
        properties: {
            winner: {
                type: SchemaType.STRING,
                description: 'Analyst ID of the winner (e.g., "technical", "macro", "risk", "quant")'
            },
            winnerName: {
                type: SchemaType.STRING,
                description: 'Display name of the winner (e.g., "Jim", "Ray", "Karen", "Quant")'
            },
            confidence: {
                type: SchemaType.NUMBER,
                description: 'Confidence in verdict 0-100'
            },
            reasoning: {
                type: SchemaType.STRING,
                description: 'Summary of why winner prevailed (2-3 sentences)'
            },
            keyFactors: {
                type: SchemaType.ARRAY,
                items: { type: SchemaType.STRING },
                description: 'Top 3 factors that decided outcome'
            },
            winnerScore: {
                type: SchemaType.NUMBER,
                description: 'Winner total score 0-100'
            },
            winnerDataQuality: {
                type: SchemaType.NUMBER,
                description: `Winner data quality score 0-${weights.data}`
            },
            winnerLogicCoherence: {
                type: SchemaType.NUMBER,
                description: `Winner logic coherence score 0-${weights.logic}`
            },
            winnerRiskAwareness: {
                type: SchemaType.NUMBER,
                description: `Winner risk awareness score 0-${weights.risk}`
            },
            winnerCatalystClarity: {
                type: SchemaType.NUMBER,
                description: `Winner catalyst clarity score 0-${weights.catalyst}`
            },
            closeTie: {
                type: SchemaType.BOOLEAN,
                description: 'True if score margin is within 3 points (triggers tie-breaker rules)'
            },
            dominancePattern: {
                type: SchemaType.BOOLEAN,
                description: 'True if winner dominated all categories'
            },
            lowQualityDebate: {
                type: SchemaType.BOOLEAN,
                description: 'True if overall quality was poor'
            }
        },
        required: ['winner', 'winnerName', 'confidence', 'reasoning', 'keyFactors', 'winnerScore',
            'winnerDataQuality', 'winnerLogicCoherence', 'winnerRiskAwareness', 'winnerCatalystClarity',
            'closeTie', 'dominancePattern', 'lowQualityDebate']
    };
}

/**
 * Schema for judge response validation
 * Built dynamically to reflect current config weights
 */
export const JUDGE_RESPONSE_SCHEMA = buildJudgeResponseSchema();

export default {
    buildJudgePrompt,
    buildCoinSelectionJudgePrompt,
    extractWinnerScores,
    estimateNonWinnerScores,
    JUDGE_RESPONSE_SCHEMA
};
