/**
 * Stock Tournament Service
 * 
 * Manages the debate tournament between analyst agents.
 * Pairs bulls vs bears and runs multi-turn debates.
 */

import { GoogleGenAI } from '@google/genai';
import {
    AnalystAgent,
    InvestmentThesis,
    StockDebate,
    DebateTurn,
    DebateScores,
    StockAnalysisData
} from '../../types/stock';
import {
    DEBATE_SYSTEM_PROMPT,
    DEBATE_TURN_PROMPT,
    getAnalystById
} from '../../constants/analystPrompts';
import { categorizeByRecommendation } from './analystService';
import { logger } from '../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface MatchPairing {
    bull: InvestmentThesis;
    bear: InvestmentThesis;
    round: 'quarterfinal' | 'semifinal' | 'final';
}

interface DebateConfig {
    turnsPerDebate: number;
    model: string;
    onTurnComplete?: (debate: StockDebate, turn: DebateTurn) => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MATCHUP GENERATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create debate pairings from theses
 * Pairs bulls against bears for maximum conflict
 */
export function createMatchPairings(theses: InvestmentThesis[]): MatchPairing[] {
    const { bulls, bears, neutral } = categorizeByRecommendation(theses);
    const pairings: MatchPairing[] = [];

    // Sort by confidence (strongest convictions first)
    const sortedBulls = [...bulls].sort((a, b) => b.confidence - a.confidence);
    const sortedBears = [...bears].sort((a, b) => b.confidence - a.confidence);

    // Add neutrals to whichever side is smaller
    for (const n of neutral) {
        if (sortedBulls.length <= sortedBears.length) {
            sortedBulls.push(n);
        } else {
            sortedBears.push(n);
        }
    }

    // Create quarterfinal pairings (up to 4 matches)
    const numMatches = Math.min(4, Math.min(sortedBulls.length, sortedBears.length));
    for (let i = 0; i < numMatches; i++) {
        pairings.push({
            bull: sortedBulls[i],
            bear: sortedBears[i],
            round: 'quarterfinal'
        });
    }

    return pairings;
}

/**
 * Create semifinal pairings from quarterfinal winners
 */
export function createSemifinalPairings(
    quarterResults: StockDebate[]
): MatchPairing[] {
    // Filter out debates without a winner
    const validDebates = quarterResults.filter(d => d.winner !== null);
    const winners = validDebates.map(d => d.winner === 'bull' ? d.bullThesis : d.bearThesis);
    const pairings: MatchPairing[] = [];

    // Pair winners: 1v4, 2v3 style
    if (winners.length >= 2) {
        const bulls = winners.filter(t =>
            t.recommendation === 'strong_buy' || t.recommendation === 'buy'
        );
        const bears = winners.filter(t =>
            t.recommendation === 'strong_sell' || t.recommendation === 'sell'
        );
        const holds = winners.filter(t => t.recommendation === 'hold');

        // Distribute holds safely
        while (holds.length > 0) {
            const hold = holds.pop();
            if (hold) {
                if (bulls.length <= bears.length) bulls.push(hold);
                else bears.push(hold);
            }
        }

        const numMatches = Math.min(2, Math.min(bulls.length, bears.length));
        for (let i = 0; i < numMatches; i++) {
            // Extra safety check for array bounds
            if (bulls[i] && bears[i]) {
                pairings.push({
                    bull: bulls[i],
                    bear: bears[i],
                    round: 'semifinal'
                });
            }
        }
    }

    return pairings;
}

/**
 * Create final pairing from semifinal winners
 */
export function createFinalPairing(
    semiResults: StockDebate[]
): MatchPairing | null {
    // Filter out debates without a winner
    const validDebates = semiResults.filter(d => d.winner !== null);
    if (validDebates.length < 2) return null;

    const winners = validDebates.map(d => d.winner === 'bull' ? d.bullThesis : d.bearThesis);

    // Safety check
    if (winners.length < 2 || !winners[0] || !winners[1]) return null;

    // Determine which is more bullish
    const [first, second] = winners;
    const firstScore = getRecommendationScore(first.recommendation);
    const secondScore = getRecommendationScore(second.recommendation);

    return {
        bull: firstScore >= secondScore ? first : second,
        bear: firstScore >= secondScore ? second : first,
        round: 'final'
    };
}

function getRecommendationScore(rec: InvestmentThesis['recommendation']): number {
    const scores = { strong_buy: 5, buy: 4, hold: 3, sell: 2, strong_sell: 1 };
    return scores[rec];
}


// ═══════════════════════════════════════════════════════════════════════════════
// DEBATE SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a single debate turn
 */
async function generateDebateTurn(
    ai: GoogleGenAI,
    model: string,
    analyst: AnalystAgent,
    thesis: InvestmentThesis,
    position: 'bull' | 'bear',
    previousTurn: string,
    // stockData reserved for future use (e.g., injecting real-time data into debates)
    _stockData: StockAnalysisData
): Promise<DebateTurn> {
    const systemPrompt = `${DEBATE_SYSTEM_PROMPT}

You are ${analyst.name}, the ${analyst.title}.
Your methodology: ${analyst.description}
Your thesis: ${thesis.summary}
Key arguments: ${thesis.bullCase.join('; ')}`;

    const userPrompt = DEBATE_TURN_PROMPT(position, previousTurn);

    try {
        const response = await ai.models.generateContent({
            model,
            contents: userPrompt,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.8,
                maxOutputTokens: 500
            }
        });

        const content = response.text || 'No response generated.';

        // Extract data points mentioned (simple heuristic)
        const dataPoints: string[] = [];
        if (content.includes('P/E') || content.includes('PE ratio')) dataPoints.push('P/E Ratio');
        if (content.includes('revenue')) dataPoints.push('Revenue');
        if (content.includes('growth')) dataPoints.push('Growth');
        if (content.includes('RSI')) dataPoints.push('RSI');
        if (content.includes('support') || content.includes('resistance')) dataPoints.push('Technical Levels');
        if (content.includes('sentiment')) dataPoints.push('Sentiment');

        return {
            speakerId: analyst.id,
            position,
            content,
            dataPointsReferenced: dataPoints,
            argumentStrength: calculateArgumentStrength(content),
            timestamp: Date.now()
        };
    } catch (error) {
        logger.error(`Failed to generate debate turn for ${analyst.name}:`, error);
        return {
            speakerId: analyst.id,
            position,
            content: `${analyst.name} maintains their ${position} position based on their ${analyst.methodology} analysis.`,
            dataPointsReferenced: [],
            argumentStrength: 50,
            timestamp: Date.now()
        };
    }
}

/**
 * Calculate argument strength based on content quality
 */
function calculateArgumentStrength(content: string): number {
    let score = 50; // Base score

    // Reward specific data references
    if (/\d+%/.test(content)) score += 10; // Percentages
    if (/\$\d+/.test(content)) score += 10; // Dollar amounts
    if (/\d+x/.test(content)) score += 5; // Multiples
    if (content.length > 100) score += 5; // Substantive response
    if (content.length > 200) score += 5; // Detailed response

    // Reward logical structure
    if (content.includes('because') || content.includes('therefore')) score += 5;
    if (content.includes('however') || content.includes('but')) score += 5; // Acknowledges nuance

    return Math.min(100, Math.max(0, score));
}

/**
 * Run a complete debate between two analysts
 */
async function runDebate(
    ai: GoogleGenAI,
    pairing: MatchPairing,
    stockData: StockAnalysisData,
    config: DebateConfig
): Promise<StockDebate> {
    const bullAnalyst = getAnalystById(pairing.bull.agentId);
    const bearAnalyst = getAnalystById(pairing.bear.agentId);

    if (!bullAnalyst || !bearAnalyst) {
        throw new Error('Could not find analyst profiles');
    }

    const debate: StockDebate = {
        matchId: `${pairing.round}-${Date.now()}`,
        ticker: stockData.ticker,
        round: pairing.round,
        bullAnalyst,
        bearAnalyst,
        bullThesis: pairing.bull,
        bearThesis: pairing.bear,
        dialogue: [],
        winner: null,
        winningArguments: [],
        scores: {
            bullScore: 0,
            bearScore: 0,
            dataQuality: { bull: 0, bear: 0 },
            logicCoherence: { bull: 0, bear: 0 },
            riskAcknowledgment: { bull: 0, bear: 0 },
            catalystIdentification: { bull: 0, bear: 0 }
        }
    };

    // Opening statements
    let lastBullStatement = pairing.bull.summary;
    let lastBearStatement = pairing.bear.summary;

    // Run debate turns
    for (let turn = 0; turn < config.turnsPerDebate; turn++) {
        // Bull turn
        const bullTurn = await generateDebateTurn(
            ai, config.model, bullAnalyst, pairing.bull, 'bull',
            lastBearStatement, stockData
        );
        debate.dialogue.push(bullTurn);
        lastBullStatement = bullTurn.content;

        if (config.onTurnComplete) {
            config.onTurnComplete(debate, bullTurn);
        }

        // Bear turn
        const bearTurn = await generateDebateTurn(
            ai, config.model, bearAnalyst, pairing.bear, 'bear',
            lastBullStatement, stockData
        );
        debate.dialogue.push(bearTurn);
        lastBearStatement = bearTurn.content;

        if (config.onTurnComplete) {
            config.onTurnComplete(debate, bearTurn);
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Calculate final scores
    debate.scores = calculateDebateScores(debate);
    debate.winner = debate.scores.bullScore > debate.scores.bearScore ? 'bull' : 'bear';
    debate.winningArguments = extractWinningArguments(debate);

    return debate;
}

/**
 * Calculate comprehensive debate scores
 */
function calculateDebateScores(debate: StockDebate): DebateScores {
    const bullTurns = debate.dialogue.filter(t => t.position === 'bull');
    const bearTurns = debate.dialogue.filter(t => t.position === 'bear');

    const avgBullStrength = bullTurns.length > 0
        ? bullTurns.reduce((sum, t) => sum + t.argumentStrength, 0) / bullTurns.length
        : 50;
    const avgBearStrength = bearTurns.length > 0
        ? bearTurns.reduce((sum, t) => sum + t.argumentStrength, 0) / bearTurns.length
        : 50;

    // Data quality based on references
    const bullDataRefs = bullTurns.reduce((sum, t) => sum + t.dataPointsReferenced.length, 0);
    const bearDataRefs = bearTurns.reduce((sum, t) => sum + t.dataPointsReferenced.length, 0);

    // Include thesis confidence as a factor
    const bullConfidenceBonus = debate.bullThesis.confidence / 10;
    const bearConfidenceBonus = debate.bearThesis.confidence / 10;

    return {
        bullScore: Math.round(avgBullStrength + bullConfidenceBonus + (bullDataRefs * 2)),
        bearScore: Math.round(avgBearStrength + bearConfidenceBonus + (bearDataRefs * 2)),
        dataQuality: {
            bull: Math.min(100, bullDataRefs * 15),
            bear: Math.min(100, bearDataRefs * 15)
        },
        logicCoherence: {
            bull: Math.round(avgBullStrength),
            bear: Math.round(avgBearStrength)
        },
        riskAcknowledgment: {
            bull: debate.bullThesis.bearCase.length * 20,
            bear: debate.bearThesis.bearCase.length * 20
        },
        catalystIdentification: {
            bull: debate.bullThesis.catalysts.length * 25,
            bear: debate.bearThesis.catalysts.length * 25
        }
    };
}

/**
 * Extract the strongest arguments from the winning side
 */
function extractWinningArguments(debate: StockDebate): string[] {
    const winnerTurns = debate.dialogue.filter(t => t.position === debate.winner);
    return winnerTurns
        .sort((a, b) => b.argumentStrength - a.argumentStrength)
        .slice(0, 3)
        .map(t => t.content.slice(0, 200) + (t.content.length > 200 ? '...' : ''));
}


// ═══════════════════════════════════════════════════════════════════════════════
// TOURNAMENT RUNNER
// ═══════════════════════════════════════════════════════════════════════════════

export interface TournamentResult {
    quarterfinals: StockDebate[];
    semifinals: StockDebate[];
    final: StockDebate | null;
    champion: InvestmentThesis | null;
    allDebates: StockDebate[];
}

export interface TournamentConfig {
    apiKey: string;
    model?: string;
    turnsPerDebate?: number;
    onDebateStart?: (round: string, matchNum: number) => void;
    onDebateComplete?: (debate: StockDebate) => void;
    onTurnComplete?: (debate: StockDebate, turn: DebateTurn) => void;
}

/**
 * Run the complete tournament
 */
export async function runTournament(
    theses: InvestmentThesis[],
    stockData: StockAnalysisData,
    config: TournamentConfig
): Promise<TournamentResult> {
    const {
        apiKey,
        model = 'gemini-2.0-flash',
        turnsPerDebate = 2,
        onDebateStart,
        onDebateComplete,
        onTurnComplete
    } = config;

    const ai = new GoogleGenAI({ apiKey });
    const debateConfig: DebateConfig = { turnsPerDebate, model, onTurnComplete };

    const result: TournamentResult = {
        quarterfinals: [],
        semifinals: [],
        final: null,
        champion: null,
        allDebates: []
    };

    // Quarterfinals
    const quarterPairings = createMatchPairings(theses);
    logger.info(`Running ${quarterPairings.length} quarterfinal matches`);

    for (let i = 0; i < quarterPairings.length; i++) {
        if (onDebateStart) onDebateStart('quarterfinal', i + 1);

        const debate = await runDebate(ai, quarterPairings[i], stockData, debateConfig);
        result.quarterfinals.push(debate);
        result.allDebates.push(debate);

        if (onDebateComplete) onDebateComplete(debate);
    }

    // Semifinals (if we have enough winners)
    if (result.quarterfinals.length >= 2) {
        const semiPairings = createSemifinalPairings(result.quarterfinals);
        logger.info(`Running ${semiPairings.length} semifinal matches`);

        for (let i = 0; i < semiPairings.length; i++) {
            if (onDebateStart) onDebateStart('semifinal', i + 1);

            const debate = await runDebate(ai, semiPairings[i], stockData, debateConfig);
            result.semifinals.push(debate);
            result.allDebates.push(debate);

            if (onDebateComplete) onDebateComplete(debate);
        }
    }

    // Final (if we have 2 semifinal winners)
    if (result.semifinals.length >= 2) {
        const finalPairing = createFinalPairing(result.semifinals);

        if (finalPairing) {
            logger.info('Running final match');
            if (onDebateStart) onDebateStart('final', 1);

            // Final gets more turns
            const finalConfig = { ...debateConfig, turnsPerDebate: turnsPerDebate + 1 };
            const debate = await runDebate(ai, finalPairing, stockData, finalConfig);
            result.final = debate;
            result.allDebates.push(debate);

            if (onDebateComplete) onDebateComplete(debate);

            // Determine champion
            result.champion = debate.winner === 'bull' ? debate.bullThesis : debate.bearThesis;
        }
    } else if (result.quarterfinals.length > 0) {
        // If not enough for full tournament, pick best from quarterfinals
        const bestDebate = result.quarterfinals.reduce((best, d) =>
            Math.max(d.scores.bullScore, d.scores.bearScore) >
                Math.max(best.scores.bullScore, best.scores.bearScore) ? d : best
        );
        result.champion = bestDebate.winner === 'bull' ? bestDebate.bullThesis : bestDebate.bearThesis;
    }

    logger.info(`Tournament complete. Champion: ${result.champion?.agentId || 'None'}`);
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUICK DEBATE (Single match for testing)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Run a single debate between two specific theses
 */
export async function runSingleDebate(
    bullThesis: InvestmentThesis,
    bearThesis: InvestmentThesis,
    stockData: StockAnalysisData,
    config: TournamentConfig
): Promise<StockDebate> {
    const ai = new GoogleGenAI({ apiKey: config.apiKey });
    const debateConfig: DebateConfig = {
        turnsPerDebate: config.turnsPerDebate || 2,
        model: config.model || 'gemini-2.0-flash',
        onTurnComplete: config.onTurnComplete
    };

    const pairing: MatchPairing = {
        bull: bullThesis,
        bear: bearThesis,
        round: 'final'
    };

    return runDebate(ai, pairing, stockData, debateConfig);
}
