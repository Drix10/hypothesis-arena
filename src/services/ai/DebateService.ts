import { logger } from '../../utils/logger';
import {
    AnalystId,
    AnalystOutput,
    ParallelAnalysisResult,
    DebateTurn,
    DebateScores,
    StockDebate,
    TournamentResult
} from '../../types/analyst';
import { ANALYST_PROFILES } from '../../constants/analyst/profiles';
import { aiService, SchemaType, ResponseSchema } from './AIService';
import { DEBATE_SYSTEM_PROMPT, DEBATE_TURN_PROMPT } from '../../constants/prompts/debatePrompt';
import { TradingContext } from '../../types/context';

// =============================================================================
// SCHEMAS
// =============================================================================

const DEBATE_TURN_SCHEMA: ResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        argument: {
            type: SchemaType.STRING,
            description: 'The debate argument (100-150 words)'
        },
        dataPointsReferenced: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: 'List of data points/metrics referenced in the argument'
        },
        keyPoint: {
            type: SchemaType.STRING,
            description: 'The single most important point in this argument'
        }
    },
    required: ['argument', 'dataPointsReferenced', 'keyPoint']
};

// =============================================================================
// SERVICE
// =============================================================================

export class DebateService {
    private profileIndex: Map<AnalystId, any> = new Map();

    constructor() {
        // Index profiles for O(1) lookup
        Object.values(ANALYST_PROFILES).forEach(p => {
            this.profileIndex.set(p.id as AnalystId, p);
        });
    }

    private getProfileById(id: AnalystId) {
        return this.profileIndex.get(id);
    }
    /**
     * Determine champion from all debate matches
     */
    private determineChampion(debates: StockDebate[]): AnalystId | null {
        if (debates.length === 0) return null;

        const winCounts: Record<string, number> = {};
        const totalScores: Record<string, number> = {};
        const analystConfidence: Record<string, number[]> = {};

        for (const d of debates) {
            const bullId = d.bullAnalystId;
            const bearId = d.bearAnalystId;

            // Track wins
            if (d.winner) {
                const winnerId = d.winner === 'bull' ? bullId : bearId;
                winCounts[winnerId] = (winCounts[winnerId] || 0) + 1;
            }

            // Track scores
            totalScores[bullId] = (totalScores[bullId] || 0) + d.scores.bullScore;
            totalScores[bearId] = (totalScores[bearId] || 0) + d.scores.bearScore;

            // Track confidence for tie-breaking
            if (!analystConfidence[bullId]) analystConfidence[bullId] = [];
            analystConfidence[bullId].push(d.bullOutput.recommendation.confidence);

            if (!analystConfidence[bearId]) analystConfidence[bearId] = [];
            analystConfidence[bearId].push(d.bearOutput.recommendation.confidence);
        }

        const participants = Object.keys(totalScores) as AnalystId[];
        if (participants.length === 0) return null;

        // Sort participants based on:
        // 1. Win count (desc)
        // 2. Average score (desc)
        // 3. Average confidence (desc)
        return participants.sort((a, b) => {
            const winsA = winCounts[a] || 0;
            const winsB = winCounts[b] || 0;
            if (winsB !== winsA) return winsB - winsA;

            const scoreA = totalScores[a] || 0;
            const scoreB = totalScores[b] || 0;
            if (scoreB !== scoreA) return scoreB - scoreA;

            const avgConfA = (analystConfidence[a] || [0]).reduce((s, c) => s + c, 0) / (analystConfidence[a]?.length || 1);
            const avgConfB = (analystConfidence[b] || [0]).reduce((s, c) => s + c, 0) / (analystConfidence[b]?.length || 1);
            return avgConfB - avgConfA;
        })[0];
    }

    async runTournament(
        symbol: string,
        analysisResult: ParallelAnalysisResult,
        context: TradingContext
    ): Promise<TournamentResult> {
        const tournamentStart = Date.now();
        logger.info(`🏆 Starting debate tournament for ${symbol}`);
        const validAnalystIds: AnalystId[] = ['jim', 'ray', 'karen', 'quant'];
        const outputs: { id: AnalystId; output: AnalystOutput }[] = [];

        for (const id of validAnalystIds) {
            const output = analysisResult[id];
            if (output) {
                outputs.push({ id, output });
            }
        }

        if (outputs.length < 2) {
            logger.warn(`Not enough analysts for a debate (${outputs.length})`);
            return { debates: [], championId: null, summary: 'Insufficient analysts for debate.', durationMs: 0 };
        }

        const pairings = this.createMatchPairings(outputs);

        if (pairings.length === 0) {
            logger.info(`No conflicting views to debate for ${symbol}`);
            return { debates: [], championId: null, summary: 'No conflicting views to debate.', durationMs: 0 };
        }

        // --- PARALLEL EXECUTION ---
        // Run all debate matches in parallel to save time
        const debatePromises = pairings.map(pairing =>
            this.runDebate(symbol, pairing, context)
                .catch(error => {
                    logger.error(`Match failed: ${pairing.bull.id} vs ${pairing.bear.id}`, error);
                    return null;
                })
        );

        const results = await Promise.all(debatePromises);
        const debates = results.filter((d): d is StockDebate => d !== null);

        if (debates.length === 0) {
            return { debates: [], championId: null, summary: 'All debate matches failed.', durationMs: Date.now() - tournamentStart };
        }

        const championId = this.determineChampion(debates);

        const durationMs = Date.now() - tournamentStart;
        logger.info(`🏆 Tournament finished in ${durationMs}ms. Champion: ${championId || 'None'}`);

        return {
            debates,
            championId,
            durationMs,
            summary: `Tournament completed with ${debates.length} matches. Champion: ${championId || 'None'}`
        };
    }

    /**
     * Run a single debate match
     */
    private async runDebate(
        symbol: string,
        pairing: { bull: { id: AnalystId; output: AnalystOutput }; bear: { id: AnalystId; output: AnalystOutput } },
        context: TradingContext
    ): Promise<StockDebate> {
        const bullProfile = this.getProfileById(pairing.bull.id);
        const bearProfile = this.getProfileById(pairing.bear.id);

        if (!bullProfile || !bearProfile) {
            throw new Error(`Missing analyst profiles: ${pairing.bull.id} or ${pairing.bear.id}`);
        }

        const debate: StockDebate = {
            matchId: `debate-${pairing.bull.id}-${pairing.bear.id}-${Date.now()}`,
            symbol,
            round: 'final', // For simplicity in this implementation
            bullAnalystId: pairing.bull.id,
            bearAnalystId: pairing.bear.id,
            bullOutput: pairing.bull.output,
            bearOutput: pairing.bear.output,
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

        // v5.5.0: OPTIMIZATION - Parallelize opening rebuttals to save ~10s
        // Since both analysts can respond to each other's Stage 1 output simultaneously.
        const [bullTurn, bearTurn] = await Promise.all([
            // Bull Turn (responds to Bear's Stage 1 reasoning)
            this.generateTurn(
                pairing.bull.id,
                pairing.bull.output,
                'bull',
                pairing.bear.output.reasoning,
                context,
                1
            ),
            // Bear Turn (responds to Bull's Stage 1 reasoning)
            this.generateTurn(
                pairing.bear.id,
                pairing.bear.output,
                'bear',
                pairing.bull.output.reasoning,
                context,
                1
            )
        ]);

        debate.dialogue.push(bullTurn);
        debate.dialogue.push(bearTurn);

        // Scoring
        debate.scores = this.calculateScores(debate);

        if (debate.scores.bullScore > debate.scores.bearScore) {
            debate.winner = 'bull';
        } else if (debate.scores.bearScore > debate.scores.bullScore) {
            debate.winner = 'bear';
        } else {
            // Tie-breaker based on confidence
            debate.winner = pairing.bull.output.recommendation.confidence >= pairing.bear.output.recommendation.confidence
                ? 'bull'
                : 'bear';
        }

        debate.winningArguments = this.extractWinningArguments(debate);

        return debate;
    }

    /**
     * Generate a single turn in the debate with retry logic
     */
    private async generateTurn(
        analystId: AnalystId,
        output: AnalystOutput,
        position: 'bull' | 'bear',
        previousTurn: string,
        context: TradingContext,
        round: number
    ): Promise<DebateTurn> {
        const profile = this.getProfileById(analystId);
        if (!profile) throw new Error(`Profile not found for ${analystId}`);

        const foundMarket = context.market_data.find(m => m.asset === output.recommendation.symbol);
        const marketDataStr = foundMarket
            ? JSON.stringify(foundMarket, null, 2)
            : `No detailed market data available for ${output.recommendation.symbol}. Use your internal knowledge of this asset if available.`;

        const systemPrompt = `${DEBATE_SYSTEM_PROMPT}

═══ YOUR IDENTITY ═══
You are ${profile.name}, the ${profile.title}.
Methodology: ${profile.methodology.toUpperCase()}
Philosophy: ${profile.description}

═══ YOUR THESIS ═══
Recommendation: ${output.recommendation.action}
Confidence: ${output.recommendation.confidence}%
Reasoning: ${output.reasoning}

═══ CURRENT MARKET DATA ═══
${marketDataStr}
`;

        const userPrompt = DEBATE_TURN_PROMPT(position, previousTurn, round);

        const MAX_ATTEMPTS = 2;
        let lastError: any = null;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            try {
                const result = await aiService.generateContentForAnalyst(analystId, {
                    prompt: `${systemPrompt}\n\n---USER---\n\n${userPrompt}`,
                    schema: DEBATE_TURN_SCHEMA,
                    maxOutputTokens: 2048, // Limit output for faster turns
                    label: `Debate-${analystId}-Attempt${attempt}`
                });

                let parsed: any;
                try {
                    parsed = JSON.parse(result.text);
                } catch (e) {
                    logger.warn(`Failed to parse debate turn for ${analystId} (attempt ${attempt}). Model: ${result.provider}.`);
                    if (attempt === MAX_ATTEMPTS) {
                        parsed = {
                            argument: result.text.length > 50 ? result.text : 'No coherent argument provided.',
                            dataPointsReferenced: [],
                            keyPoint: 'Failed to extract key point'
                        };
                    } else {
                        continue; // Retry
                    }
                }

                return {
                    speakerId: analystId,
                    position,
                    content: parsed.argument || 'No argument provided.',
                    dataPointsReferenced: parsed.dataPointsReferenced || [],
                    argumentStrength: this.calculateArgumentStrength(parsed.argument || '', profile.methodology, parsed.dataPointsReferenced || []),
                    timestamp: Date.now()
                };
            } catch (error: any) {
                lastError = error;
                logger.error(`Turn generation failed for ${analystId} (Attempt ${attempt}/${MAX_ATTEMPTS}):`, {
                    error: lastError.message,
                    recommendation: output.recommendation,
                    round
                });
                if (attempt < MAX_ATTEMPTS) {
                    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 500));
                }
            }
        }

        // Fallback for total failure
        return {
            speakerId: analystId,
            position,
            content: `[Communication Error] My analysis is unavailable due to a technical issue. I stand by my original thesis: ${output.recommendation.action} at ${output.recommendation.confidence}% confidence. Reason: an unexpected error occurred.`,
            dataPointsReferenced: [],
            argumentStrength: 10,
            timestamp: Date.now()
        };
    }

    /**
     * Calculate scores for the debate
     */
    private calculateScores(debate: StockDebate): DebateScores {
        const scores: DebateScores = {
            bullScore: 0,
            bearScore: 0,
            dataQuality: { bull: 0, bear: 0 },
            logicCoherence: { bull: 0, bear: 0 },
            riskAcknowledgment: { bull: 0, bear: 0 },
            catalystIdentification: { bull: 0, bear: 0 }
        };

        const bullTurns = debate.dialogue.filter(t => t.position === 'bull');
        const bearTurns = debate.dialogue.filter(t => t.position === 'bear');

        // 1. Data Quality - Weighted by number of unique data points and their relevance
        scores.dataQuality.bull = Math.min(100, this.calculateDataQualityScore(bullTurns));
        scores.dataQuality.bear = Math.min(100, this.calculateDataQualityScore(bearTurns));

        // 2. Logic Coherence - Average of turn strengths
        scores.logicCoherence.bull = Math.min(100, bullTurns.reduce((sum, t) => sum + t.argumentStrength, 0) / (bullTurns.length || 1));
        scores.logicCoherence.bear = Math.min(100, bearTurns.reduce((sum, t) => sum + t.argumentStrength, 0) / (bearTurns.length || 1));

        // 3. Risk Acknowledgment - Crucial for professional trading
        const riskKeywords = ['risk', 'downside', 'stop loss', 'volatility', 'uncertainty', 'threat', 'concern', 'invalidate', 'invalidation', 'drawdown'];
        scores.riskAcknowledgment.bull = Math.min(100, this.countKeywords(bullTurns, riskKeywords) * 20);
        scores.riskAcknowledgment.bear = Math.min(100, this.countKeywords(bearTurns, riskKeywords) * 20);

        // 4. Catalyst Identification - What actually moves the price?
        const catalystKeywords = ['catalyst', 'trigger', 'event', 'news', 'earnings', 'launch', 'upgrade', 'breakout', 'rejection', 'funding'];
        scores.catalystIdentification.bull = Math.min(100, this.countKeywords(bullTurns, catalystKeywords) * 20);
        scores.catalystIdentification.bear = Math.min(100, this.countKeywords(bearTurns, catalystKeywords) * 20);

        // Final Aggregate Scores (Weighted)
        // Professionals value data and logic most (30% each), then catalysts and risk (20% each)
        let bullFinal = (scores.dataQuality.bull * 0.3) + (scores.logicCoherence.bull * 0.3) + (scores.riskAcknowledgment.bull * 0.2) + (scores.catalystIdentification.bull * 0.2);
        let bearFinal = (scores.dataQuality.bear * 0.3) + (scores.logicCoherence.bear * 0.3) + (scores.riskAcknowledgment.bear * 0.2) + (scores.catalystIdentification.bear * 0.2);

        // Adjust by profile strengths if available
        const bullProfile = this.getProfileById(debate.bullAnalystId);
        const bearProfile = this.getProfileById(debate.bearAnalystId);

        if (bullProfile?.tournamentScores) {
            bullFinal = (bullFinal * 0.7) + (
                (bullProfile.tournamentScores.data * 0.25) +
                (bullProfile.tournamentScores.logic * 0.25) +
                (bullProfile.tournamentScores.rebuttal * 0.25) +
                (bullProfile.tournamentScores.catalysts * 0.25)
            ) * 0.3;
        }

        if (bearProfile?.tournamentScores) {
            bearFinal = (bearFinal * 0.7) + (
                (bearProfile.tournamentScores.data * 0.25) +
                (bearProfile.tournamentScores.logic * 0.25) +
                (bearProfile.tournamentScores.rebuttal * 0.25) +
                (bearProfile.tournamentScores.catalysts * 0.25)
            ) * 0.3;
        }

        scores.bullScore = Math.min(100, bullFinal);
        scores.bearScore = Math.min(100, bearFinal);

        return scores;
    }

    private calculateDataQualityScore(turns: DebateTurn[]): number {
        const uniqueDataPoints = new Set<string>();
        turns.forEach(t => t.dataPointsReferenced.forEach(dp => uniqueDataPoints.add(dp.toLowerCase())));

        let score = uniqueDataPoints.size * 15;
        // Bonus for technical precision (numbers, percentages)
        turns.forEach(t => {
            if (/\d+%/.test(t.content)) score += 5;
            if (/\d+\.\d+/.test(t.content)) score += 5;
        });

        return score;
    }

    private countKeywords(turns: DebateTurn[], keywords: string[]): number {
        let count = 0;
        for (const turn of turns) {
            const content = turn.content.toLowerCase();
            for (const kw of keywords) {
                // Use word boundaries to avoid partial matches (e.g., "vol" in "volatility")
                const regex = new RegExp(`\\b${kw.toLowerCase()}\\b`, 'i');
                if (regex.test(content)) count++;
            }
        }
        return count;
    }

    private calculateArgumentStrength(content: string, methodology: string, dataPoints: string[]): number {
        let score = 40;

        // Quality markers
        if (content.length > 250) score += 10;
        if (content.length > 500) score += 5;
        if (/\d+/.test(content)) score += 10; // Contains numbers
        if (content.includes('because') || content.includes('therefore') || content.includes('consequently')) score += 10;
        if (dataPoints.length > 0) score += 10;
        if (dataPoints.length > 2) score += 10;

        // Methodology alignment (simplified check)
        const methLower = methodology.toLowerCase();
        if (methLower.includes('technical') && (content.includes('rsi') || content.includes('ema') || content.includes('support'))) score += 5;
        if (methLower.includes('sentiment') && (content.includes('funding') || content.includes('social') || content.includes('fear'))) score += 5;

        return Math.min(100, score);
    }

    private extractWinningArguments(debate: StockDebate): string[] {
        const winnerTurns = debate.dialogue.filter(t => t.position === debate.winner);
        return winnerTurns.map(t => t.content).slice(0, 3);
    }

    private createMatchPairings(outputs: { id: AnalystId; output: AnalystOutput }[]): { bull: { id: AnalystId; output: AnalystOutput }; bear: { id: AnalystId; output: AnalystOutput } }[] {
        const pairings: { bull: { id: AnalystId; output: AnalystOutput }; bear: { id: AnalystId; output: AnalystOutput } }[] = [];

        // Categorize based on true market bias
        // BUY is Bullish
        // SELL is Bearish
        // REDUCE/CLOSE are bearish-leaning (exit/reduce exposure)
        // HOLD is neutral
        const bulls = outputs.filter(o => o.output.recommendation.action === 'BUY');
        const bears = outputs.filter(o => ['SELL', 'CLOSE', 'REDUCE'].includes(o.output.recommendation.action));
        const neutral = outputs.filter(o => o.output.recommendation.action === 'HOLD');

        // 1. Direct Conflict Pairing (Bull vs Bear)
        const sortedBulls = [...bulls].sort((a, b) => b.output.recommendation.confidence - a.output.recommendation.confidence);
        const sortedBears = [...bears].sort((a, b) => b.output.recommendation.confidence - a.output.recommendation.confidence);

        const matchCount = Math.min(sortedBulls.length, sortedBears.length);
        for (let i = 0; i < matchCount; i++) {
            pairings.push({ bull: sortedBulls[i], bear: sortedBears[i] });
        }

        // 2. No Direct Conflict - Intra-Bias Debate (Bull vs Bull or Bear vs Bear)
        // If we have 2+ bulls but no bears, they should debate why their targets/rationale differ
        if (pairings.length === 0) {
            if (bulls.length >= 2) {
                // Pair strongest bull vs weakest bull (as devil's advocate)
                const sorted = [...bulls].sort((a, b) => b.output.recommendation.confidence - a.output.recommendation.confidence);
                pairings.push({ bull: sorted[0], bear: sorted[sorted.length - 1] });
            } else if (bears.length >= 2) {
                // Pair strongest bear vs weakest bear
                const sorted = [...bears].sort((a, b) => b.output.recommendation.confidence - a.output.recommendation.confidence);
                pairings.push({ bull: sorted[sorted.length - 1], bear: sorted[0] });
            } else if (bulls.length === 1 && neutral.length >= 1) {
                // Bull vs Neutral
                pairings.push({ bull: bulls[0], bear: neutral[0] });
            } else if (bears.length === 1 && neutral.length >= 1) {
                // Bear vs Neutral
                pairings.push({ bull: neutral[0], bear: bears[0] });
            }
        }

        return pairings;
    }

}

export const debateService = new DebateService();
