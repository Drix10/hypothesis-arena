/**
 * Collaborative Trading Flow
 * 
 * Implements the 7-stage pipeline from FLOW.md:
 * 1. Market Scan - Fetch data for all coins
 * 2. Coin Selection - Ray, Jim, Quant pick best opportunity
 * 3. Specialist Analysis - Deep dive by assigned specialists
 * 4. Tournament - Bracket-style debates
 * 5. Risk Council - Karen approves/vetoes
 * 6. Execution - Place trade on WEEX
 * 7. Position Management - Monitor and adjust
 */

import { GoogleGenerativeAI, GenerativeModel, SchemaType } from '@google/generative-ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { ANALYST_PROFILES, AnalystMethodology } from '../../constants/analystPrompts';
import type { ExtendedMarketData, AnalysisResult, TradeOrder, WeexAILog } from './GeminiService';

// =============================================================================
// TYPES
// =============================================================================

export interface CoinPick {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    conviction: number; // 1-10
    reason: string;
}

export interface CoinSelectionResult {
    analystId: string;
    picks: CoinPick[];
}

export interface AggregatedCoinScore {
    symbol: string;
    totalScore: number;
    direction: 'LONG' | 'SHORT';
    votes: { analystId: string; rank: number; conviction: number }[];
}

export interface SpecialistAssignment {
    symbol: string;
    specialists: string[]; // analyst IDs
    coinType: 'blue_chip' | 'l1_growth' | 'momentum_meme' | 'utility';
}

export interface TournamentMatch {
    matchId: string;
    round: 'semifinal' | 'final';
    analystA: AnalysisResult;
    analystB: AnalysisResult;
    winner: string; // analyst ID
    scores: {
        [analystId: string]: {
            data: number;
            logic: number;
            risk: number;
            catalyst: number;
            total: number;
        };
    };
    reasoning: string;
}

export interface RiskCouncilDecision {
    approved: boolean;
    adjustments?: {
        positionSize?: number;
        leverage?: number;
        stopLoss?: number;
    };
    warnings: string[];
    vetoReason?: string;
}

export interface CollaborativeDecision {
    stage: string;
    selectedCoin: string;
    coinSelectors: CoinSelectionResult[];
    specialists: AnalysisResult[];
    tournament: TournamentMatch[];
    champion: AnalysisResult | null;
    riskDecision: RiskCouncilDecision;
    finalOrder?: TradeOrder;
    aiLog: WeexAILog;
}

// =============================================================================
// SCHEMAS
// =============================================================================

const COIN_SELECTION_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        picks: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    symbol: { type: SchemaType.STRING },
                    direction: { type: SchemaType.STRING, enum: ['LONG', 'SHORT'] },
                    conviction: { type: SchemaType.NUMBER },
                    reason: { type: SchemaType.STRING }
                },
                required: ['symbol', 'direction', 'conviction', 'reason']
            }
        }
    },
    required: ['picks']
};

const TOURNAMENT_JUDGE_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        winner: { type: SchemaType.STRING },
        winnerScore: {
            type: SchemaType.OBJECT,
            properties: {
                data: { type: SchemaType.NUMBER },
                logic: { type: SchemaType.NUMBER },
                risk: { type: SchemaType.NUMBER },
                catalyst: { type: SchemaType.NUMBER },
                total: { type: SchemaType.NUMBER }
            },
            required: ['data', 'logic', 'risk', 'catalyst', 'total']
        },
        loserScore: {
            type: SchemaType.OBJECT,
            properties: {
                data: { type: SchemaType.NUMBER },
                logic: { type: SchemaType.NUMBER },
                risk: { type: SchemaType.NUMBER },
                catalyst: { type: SchemaType.NUMBER },
                total: { type: SchemaType.NUMBER }
            },
            required: ['data', 'logic', 'risk', 'catalyst', 'total']
        },
        reasoning: { type: SchemaType.STRING },
        keyDifferentiator: { type: SchemaType.STRING }
    },
    required: ['winner', 'winnerScore', 'loserScore', 'reasoning']
};

const RISK_COUNCIL_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        approved: { type: SchemaType.BOOLEAN },
        adjustments: {
            type: SchemaType.OBJECT,
            properties: {
                positionSize: { type: SchemaType.NUMBER },
                leverage: { type: SchemaType.NUMBER },
                stopLoss: { type: SchemaType.NUMBER }
            }
        },
        warnings: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING }
        },
        vetoReason: { type: SchemaType.STRING }
    },
    required: ['approved', 'warnings']
};

const SPECIALIST_ANALYSIS_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        recommendation: {
            type: SchemaType.STRING,
            enum: ['STRONG_BUY', 'BUY', 'HOLD', 'SELL', 'STRONG_SELL']
        },
        confidence: { type: SchemaType.NUMBER },
        entry: { type: SchemaType.NUMBER },
        targets: {
            type: SchemaType.OBJECT,
            properties: {
                bull: { type: SchemaType.NUMBER },
                base: { type: SchemaType.NUMBER },
                bear: { type: SchemaType.NUMBER }
            },
            required: ['bull', 'base', 'bear']
        },
        stopLoss: { type: SchemaType.NUMBER },
        leverage: { type: SchemaType.NUMBER },
        positionSize: { type: SchemaType.NUMBER },
        thesis: { type: SchemaType.STRING },
        bullCase: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING }
        },
        bearCase: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING }
        },
        keyMetrics: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: 'Key metrics as string array, e.g. ["RSI: 65", "Volume: 1.2M"]'
        },
        catalyst: { type: SchemaType.STRING },
        timeframe: { type: SchemaType.STRING }
    },
    required: ['recommendation', 'confidence', 'targets', 'thesis', 'positionSize']
};

// =============================================================================
// COIN TYPE MAPPING (from FLOW.md)
// =============================================================================

const COIN_TYPE_MAP: Record<string, { type: SpecialistAssignment['coinType']; specialists: string[] }> = {
    'cmt_btcusdt': { type: 'blue_chip', specialists: ['warren', 'ray', 'karen'] },
    'cmt_ethusdt': { type: 'blue_chip', specialists: ['warren', 'ray', 'karen'] },
    'cmt_solusdt': { type: 'l1_growth', specialists: ['cathie', 'quant', 'jim'] },
    'cmt_adausdt': { type: 'l1_growth', specialists: ['cathie', 'quant', 'jim'] },
    'cmt_dogeusdt': { type: 'momentum_meme', specialists: ['elon', 'devil', 'jim'] },
    'cmt_xrpusdt': { type: 'momentum_meme', specialists: ['elon', 'devil', 'jim'] },
    'cmt_bnbusdt': { type: 'utility', specialists: ['warren', 'quant', 'karen'] },
    'cmt_ltcusdt': { type: 'utility', specialists: ['warren', 'quant', 'karen'] },
};

// Coin selectors (Stage 2)
const COIN_SELECTORS = ['ray', 'jim', 'quant'];

const AI_REQUEST_TIMEOUT = 60000; // 60 seconds

/**
 * Helper to create a timeout promise that can be cancelled
 * Prevents memory leaks from orphaned setTimeout handles
 */
function createTimeoutPromise(ms: number): { promise: Promise<never>; cancel: () => void } {
    let timeoutId: NodeJS.Timeout;
    const promise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('Timeout')), ms);
    });
    return {
        promise,
        cancel: () => clearTimeout(timeoutId)
    };
}

// =============================================================================
// COLLABORATIVE FLOW SERVICE
// =============================================================================

export class CollaborativeFlowService {
    private model: GenerativeModel | null = null;

    private getModel(): GenerativeModel {
        if (!this.model) {
            if (!config.geminiApiKey) {
                throw new Error('GEMINI_API_KEY not configured');
            }
            const genAI = new GoogleGenerativeAI(config.geminiApiKey);
            this.model = genAI.getGenerativeModel({
                model: 'gemini-2.5-flash',
                generationConfig: {
                    responseMimeType: "application/json",
                }
            });
        }
        return this.model;
    }

    /**
     * Stage 2: Coin Selection Debate
     * Ray, Jim, and Quant each pick their top 3 coins
     */
    async runCoinSelection(
        marketDataMap: Map<string, ExtendedMarketData>
    ): Promise<{ results: CoinSelectionResult[]; topCoin: AggregatedCoinScore }> {
        logger.info('Stage 2: Coin Selection Debate starting...');

        const results: CoinSelectionResult[] = [];
        const model = this.getModel();

        // Build market summary for prompt
        const marketSummary = this.buildMarketSummary(marketDataMap);

        // Run coin selection for each selector in parallel
        const selectionPromises = COIN_SELECTORS.map(async (analystId) => {
            const profile = Object.values(ANALYST_PROFILES).find(p => p.id === analystId);
            if (!profile) return null;

            const prompt = this.buildCoinSelectionPrompt(profile, marketSummary);

            try {
                const timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
                try {
                    const result = await Promise.race([
                        model.generateContent({
                            contents: [{ role: 'user', parts: [{ text: prompt }] }],
                            generationConfig: {
                                responseMimeType: "application/json",
                                responseSchema: COIN_SELECTION_SCHEMA
                            }
                        }),
                        timeout.promise
                    ]);
                    timeout.cancel(); // Clean up timeout

                    const responseText = result.response.text();
                    const parsed = JSON.parse(responseText);

                    // LOG LLM OUTPUT: Coin Selection
                    logger.info(`\n${'='.repeat(60)}`);
                    logger.info(`🤖 LLM OUTPUT - Coin Selection (${profile.name})`);
                    logger.info(`${'='.repeat(60)}`);
                    logger.info(`Picks: ${JSON.stringify(parsed.picks, null, 2)}`);
                    logger.info(`${'='.repeat(60)}\n`);

                    // Validate parsed.picks is an array before processing
                    if (!Array.isArray(parsed.picks)) {
                        logger.warn(`Invalid picks response for ${analystId}: not an array`);
                        return null;
                    }

                    return {
                        analystId,
                        picks: parsed.picks.slice(0, 3).map((p: any) => ({
                            symbol: typeof p.symbol === 'string' ? p.symbol : 'cmt_btcusdt',
                            direction: p.direction === 'SHORT' ? 'SHORT' : 'LONG',
                            conviction: Math.min(10, Math.max(1, Number(p.conviction) || 5)),
                            reason: typeof p.reason === 'string' ? p.reason.slice(0, 200) : ''
                        }))
                    };
                } catch (error) {
                    timeout.cancel(); // Clean up timeout on error too
                    throw error;
                }
            } catch (error) {
                logger.warn(`Coin selection failed for ${analystId}:`, error);
                return null;
            }
        });

        const selectionResults = await Promise.all(selectionPromises);
        for (const r of selectionResults) {
            if (r) results.push(r);
        }

        // Aggregate scores
        const topCoin = this.aggregateCoinScores(results);

        logger.info(`Stage 2 complete: Top coin is ${topCoin.symbol} (score: ${topCoin.totalScore})`);
        return { results, topCoin };
    }

    /**
     * Stage 3: Specialist Deep Analysis
     * Assign specialists based on coin type and get detailed analysis
     */
    async runSpecialistAnalysis(
        symbol: string,
        marketData: ExtendedMarketData,
        direction: 'LONG' | 'SHORT'
    ): Promise<AnalysisResult[]> {
        logger.info(`Stage 3: Specialist Analysis for ${symbol}...`);

        const assignment = COIN_TYPE_MAP[symbol.toLowerCase()];
        if (!assignment) {
            logger.warn(`No specialist mapping for ${symbol}, using defaults`);
            return [];
        }

        const model = this.getModel();
        const results: AnalysisResult[] = [];

        // Run specialist analysis in parallel
        const analysisPromises = assignment.specialists.map(async (analystId) => {
            const methodology = Object.keys(ANALYST_PROFILES).find(
                m => ANALYST_PROFILES[m as AnalystMethodology].id === analystId
            ) as AnalystMethodology | undefined;

            if (!methodology) return null;
            const profile = ANALYST_PROFILES[methodology];

            const prompt = this.buildSpecialistPrompt(profile, marketData, direction);

            try {
                const timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
                try {
                    const result = await Promise.race([
                        model.generateContent({
                            contents: [{ role: 'user', parts: [{ text: prompt }] }],
                            generationConfig: {
                                responseMimeType: "application/json",
                                responseSchema: SPECIALIST_ANALYSIS_SCHEMA
                            }
                        }),
                        timeout.promise
                    ]);
                    timeout.cancel();

                    const responseText = result.response.text();
                    const parsed = JSON.parse(responseText);

                    // LOG LLM OUTPUT: Specialist Analysis
                    logger.info(`\n${'='.repeat(60)}`);
                    logger.info(`🔬 LLM OUTPUT - Specialist Analysis (${profile.name})`);
                    logger.info(`${'='.repeat(60)}`);
                    logger.info(`Recommendation: ${parsed.recommendation}`);
                    logger.info(`Confidence: ${parsed.confidence}%`);
                    logger.info(`Thesis: ${parsed.thesis}`);
                    logger.info(`Targets: ${JSON.stringify(parsed.targets)}`);
                    logger.info(`Position Size: ${parsed.positionSize}/10`);
                    logger.info(`${'='.repeat(60)}\n`);

                    return this.parseSpecialistResponse(parsed, profile, methodology, marketData.currentPrice);
                } catch (error) {
                    timeout.cancel();
                    throw error;
                }
            } catch (error) {
                logger.warn(`Specialist analysis failed for ${analystId}:`, error);
                return null;
            }
        });

        const analysisResults = await Promise.all(analysisPromises);
        for (const r of analysisResults) {
            if (r) results.push(r);
        }

        logger.info(`Stage 3 complete: ${results.length} specialist analyses`);
        return results;
    }

    /**
     * Stage 4: Championship Tournament
     * Bracket-style debates between specialists
     * 
     * Tournament structure:
     * - 1 specialist: No debate, auto-champion
     * - 2 specialists: Single final match (#1 vs #2)
     * - 3+ specialists: Semifinal (#1 vs #3), then Final (winner vs #2)
     * 
     * Core philosophy: "Every decision is a debate. Every debate has a winner. Winners trade."
     * If individual debates fail, we fall back to a single-judge comparison of all theses.
     */
    async runTournament(
        specialists: AnalysisResult[],
        marketData: ExtendedMarketData
    ): Promise<{ matches: TournamentMatch[]; champion: AnalysisResult | null }> {
        logger.info('Stage 4: Championship Tournament starting...');

        if (specialists.length < 2) {
            return { matches: [], champion: specialists[0] || null };
        }

        const matches: TournamentMatch[] = [];
        const model = this.getModel();

        // Sort by confidence
        const sorted = [...specialists].sort((a, b) => b.confidence - a.confidence);

        // Handle 2 specialists: single final match (no semifinal needed)
        if (sorted.length === 2) {
            const final = await this.runDebateMatch(
                model, sorted[0], sorted[1], 'final', marketData
            );
            if (final) {
                matches.push(final);
                const champion = specialists.find(s => s.analystId === final.winner) || sorted[0];
                logger.info(`Stage 4 complete: Champion is ${champion?.analystName || 'none'}`);
                return { matches, champion };
            }

            // Debate failed - use single-judge fallback (never skip debate entirely)
            logger.warn('Final debate failed, using single-judge fallback...');
            const fallbackChampion = await this.runSingleJudgeFallback(model, sorted, marketData);
            logger.info(`Stage 4 complete (fallback): Champion is ${fallbackChampion?.analystName || 'none'}`);
            return { matches, champion: fallbackChampion };
        }

        // 3+ specialists: Semifinal (#1 vs #3), then Final (winner vs #2)
        const semifinal = await this.runDebateMatch(
            model, sorted[0], sorted[sorted.length - 1], 'semifinal', marketData
        );
        if (semifinal) matches.push(semifinal);

        // Determine semifinal winner
        let semifinalWinner: AnalysisResult;
        if (semifinal) {
            semifinalWinner = semifinal.winner === sorted[0].analystId
                ? sorted[0]
                : sorted[sorted.length - 1];
        } else {
            // Semifinal failed - use single-judge fallback for entire tournament
            logger.warn('Semifinal debate failed, using single-judge fallback for all specialists...');
            const fallbackChampion = await this.runSingleJudgeFallback(model, sorted, marketData);
            logger.info(`Stage 4 complete (fallback): Champion is ${fallbackChampion?.analystName || 'none'}`);
            return { matches, champion: fallbackChampion };
        }

        // Final: Semifinal winner vs #2
        const final = await this.runDebateMatch(
            model, semifinalWinner, sorted[1], 'final', marketData
        );
        if (final) {
            matches.push(final);
            const champion = specialists.find(s => s.analystId === final.winner) || null;
            logger.info(`Stage 4 complete: Champion is ${champion?.analystName || 'none'}`);
            return { matches, champion };
        }

        // Final failed - use single-judge fallback between finalists
        logger.warn('Final debate failed, using single-judge fallback for finalists...');
        const finalists = [semifinalWinner, sorted[1]];
        const fallbackChampion = await this.runSingleJudgeFallback(model, finalists, marketData);
        logger.info(`Stage 4 complete (fallback): Champion is ${fallbackChampion?.analystName || 'none'}`);
        return { matches, champion: fallbackChampion };
    }

    /**
     * Single-judge fallback when debate matches fail
     * Gemini scores all theses against each other in one prompt
     * Ensures we never skip the debate process entirely
     */
    private async runSingleJudgeFallback(
        model: GenerativeModel,
        specialists: AnalysisResult[],
        marketData: ExtendedMarketData
    ): Promise<AnalysisResult | null> {
        if (specialists.length === 0) return null;
        if (specialists.length === 1) return specialists[0];

        const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();

        // Build comparison prompt for all specialists
        const analystSummaries = specialists.map((s, i) => `
ANALYST ${i + 1}: ${s.analystName} (${s.analystTitle})
- Recommendation: ${s.recommendation.toUpperCase().replace('_', ' ')}
- Confidence: ${s.confidence}%
- Position Size: ${s.positionSize}/10
- Thesis: ${s.thesis}
- Bull Case: ${s.bullCase?.slice(0, 2).join('; ') || 'N/A'}
- Bear Case: ${s.bearCase?.slice(0, 2).join('; ') || 'N/A'}
- Price Targets: Bull ${s.priceTarget.bull.toFixed(2)}, Base ${s.priceTarget.base.toFixed(2)}, Bear ${s.priceTarget.bear.toFixed(2)}
`).join('\n');

        const prompt = `You are a hedge fund CIO making a FINAL DECISION on ${displaySymbol}/USDT.

MARKET CONTEXT:
- Current Price: ${marketData.currentPrice.toFixed(2)}
- 24h Change: ${marketData.change24h >= 0 ? '+' : ''}${marketData.change24h.toFixed(2)}%
${marketData.fundingRate !== undefined ? `- Funding Rate: ${(marketData.fundingRate * 100).toFixed(4)}%` : ''}

COMPETING THESES:
${analystSummaries}

JUDGING CRITERIA (score each 0-25):
1. DATA QUALITY: Uses specific numbers, not vague claims
2. LOGIC: Reasoning follows from data
3. RISK AWARENESS: Acknowledges what could go wrong
4. CATALYST: Clear price driver with timeline

Select the SINGLE BEST thesis. The winner's recommendation will be EXECUTED as a real trade.

Respond with JSON:
{
    "winner": "${specialists[0].analystId}" (analyst ID of winner - must be one of: ${specialists.map(s => `"${s.analystId}"`).join(', ')}),
    "reasoning": "Why this thesis is strongest",
    "scores": {
        "${specialists[0].analystId}": { "data": 0-25, "logic": 0-25, "risk": 0-25, "catalyst": 0-25, "total": 0-100 }
        // ... scores for each analyst
    }
}`;

        const timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
        try {
            const result = await Promise.race([
                model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json"
                    }
                }),
                timeout.promise
            ]);
            timeout.cancel();

            const parsed = JSON.parse(result.response.text());

            // LOG LLM OUTPUT: Single-Judge Fallback
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`[FALLBACK] LLM OUTPUT - Single-Judge Comparison`);
            logger.info(`${'='.repeat(60)}`);
            logger.info(`Winner: ${parsed.winner}`);
            logger.info(`Reasoning: ${parsed.reasoning}`);
            logger.info(`Scores: ${JSON.stringify(parsed.scores, null, 2)}`);
            logger.info(`${'='.repeat(60)}\n`);

            // Find the winning specialist
            const winner = specialists.find(s => s.analystId === parsed.winner);
            if (winner) {
                return winner;
            }

            // If winner ID doesn't match, fall back to highest scored
            logger.warn(`Single-judge winner ID "${parsed.winner}" not found, using highest confidence`);
            return specialists[0]; // Already sorted by confidence
        } catch (error) {
            timeout.cancel();
            logger.error('Single-judge fallback failed:', error instanceof Error ? error.message : String(error));
            // Ultimate fallback: highest confidence (but this should be rare)
            logger.warn('All debate mechanisms failed, using highest confidence as last resort');
            return specialists[0];
        }
    }

    /**
     * Stage 5: Risk Council
     * Karen reviews and approves/vetoes the trade
     */
    async runRiskCouncil(
        champion: AnalysisResult,
        marketData: ExtendedMarketData,
        accountBalance: number,
        currentPositions: Array<{ symbol: string; side: string; size: number }>,
        recentPnL: { day: number; week: number }
    ): Promise<RiskCouncilDecision> {
        logger.info('Stage 5: Risk Council review...');

        const model = this.getModel();
        const karenProfile = ANALYST_PROFILES.risk;

        const prompt = this.buildRiskCouncilPrompt(
            karenProfile, champion, marketData, accountBalance, currentPositions, recentPnL
        );

        try {
            const timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
            try {
                const result = await Promise.race([
                    model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            responseSchema: RISK_COUNCIL_SCHEMA
                        }
                    }),
                    timeout.promise
                ]);
                timeout.cancel();

                const responseText = result.response.text();
                const parsed = JSON.parse(responseText);

                // LOG LLM OUTPUT: Risk Council Decision
                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`🛡️ LLM OUTPUT - Risk Council (Karen)`);
                logger.info(`${'='.repeat(60)}`);
                logger.info(`Approved: ${parsed.approved}`);
                logger.info(`Warnings: ${JSON.stringify(parsed.warnings)}`);
                if (parsed.vetoReason) logger.info(`Veto Reason: ${parsed.vetoReason}`);
                if (parsed.adjustments) logger.info(`Adjustments: ${JSON.stringify(parsed.adjustments)}`);
                logger.info(`${'='.repeat(60)}\n`);

                const decision: RiskCouncilDecision = {
                    approved: parsed.approved === true,
                    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
                    vetoReason: parsed.vetoReason || undefined,
                    adjustments: parsed.adjustments ? {
                        positionSize: parsed.adjustments.positionSize,
                        leverage: parsed.adjustments.leverage,
                        stopLoss: parsed.adjustments.stopLoss
                    } : undefined
                };

                logger.info(`Stage 5 complete: ${decision.approved ? 'APPROVED' : 'VETOED'}`);
                return decision;
            } catch (error) {
                timeout.cancel();
                throw error;
            }
        } catch (error) {
            logger.error('Risk council failed:', error);
            // Default to conservative veto on error
            return {
                approved: false,
                warnings: ['Risk council analysis failed'],
                vetoReason: 'Unable to complete risk assessment'
            };
        }
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    private buildMarketSummary(marketDataMap: Map<string, ExtendedMarketData>): string {
        const lines: string[] = ['CURRENT MARKET DATA FOR 8 TRADEABLE COINS (WEEX Perpetual Futures):'];
        lines.push('');

        for (const [symbol, data] of marketDataMap) {
            const displaySymbol = symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
            const change = Number.isFinite(data.change24h)
                ? (data.change24h >= 0 ? `+${data.change24h.toFixed(2)}%` : `${data.change24h.toFixed(2)}%`)
                : 'N/A';
            const volume = Number.isFinite(data.volume24h) && data.volume24h > 0
                ? `${(data.volume24h / 1e6).toFixed(1)}M`
                : 'N/A';
            const funding = data.fundingRate !== undefined && Number.isFinite(data.fundingRate)
                ? `${(data.fundingRate * 100).toFixed(4)}%`
                : 'N/A';
            const price = Number.isFinite(data.currentPrice)
                ? data.currentPrice.toFixed(data.currentPrice < 1 ? 6 : 2)
                : 'N/A';

            lines.push(`${displaySymbol.padEnd(5)}: $${price.padStart(10)} (${change.padStart(8)}) | Vol: ${volume.padStart(8)} | Funding: ${funding}`);
        }

        lines.push('');
        lines.push('NOTE: Positive funding = longs pay shorts (bearish signal). Negative = shorts pay longs (bullish signal).');

        return lines.join('\n');
    }

    private buildCoinSelectionPrompt(
        profile: typeof ANALYST_PROFILES[AnalystMethodology],
        marketSummary: string
    ): string {
        return `You are ${profile.name}, ${profile.title}.

${profile.description}

YOUR METHODOLOGY & FOCUS AREAS:
${profile.focusAreas.map(f => `• ${f}`).join('\n')}

═══════════════════════════════════════════════════════════════════════════════
${marketSummary}
═══════════════════════════════════════════════════════════════════════════════

TASK: Select your TOP 3 trading opportunities from these 8 coins.

SCORING SYSTEM (your picks compete against other analysts):
• #1 pick = 3 points × conviction
• #2 pick = 2 points × conviction  
• #3 pick = 1 point × conviction

The coin with the highest TOTAL score across all analysts will be selected for deep analysis and potential execution.

SELECTION CRITERIA (apply your ${profile.title} methodology):
1. MOMENTUM: Which coins show the strongest directional moves?
2. VOLUME: Is there conviction behind the price action?
3. FUNDING: Are traders positioned for a squeeze? (positive = crowded longs, negative = crowded shorts)
4. RELATIVE STRENGTH: Which coins are outperforming/underperforming the group?
5. YOUR EDGE: What does YOUR methodology see that others might miss?

OUTPUT REQUIREMENTS:
• symbol: Exact WEEX symbol (e.g., "cmt_btcusdt", "cmt_solusdt")
• direction: "LONG" (expecting price increase) or "SHORT" (expecting price decrease)
• conviction: 1-10 scale (BE HONEST - low conviction picks hurt your score)
  - 1-3: Speculative, weak signal
  - 4-6: Moderate confidence, some supporting data
  - 7-8: High confidence, strong signal alignment
  - 9-10: Exceptional setup, multiple confirming factors
• reason: ONE sentence with SPECIFIC data (e.g., "+5.2% with 2x avg volume" not "looks bullish")

Respond with JSON:
{
    "picks": [
        { "symbol": "cmt_solusdt", "direction": "LONG", "conviction": 8, "reason": "+4.2% outperforming BTC with negative funding suggesting short squeeze potential" },
        { "symbol": "cmt_btcusdt", "direction": "LONG", "conviction": 6, "reason": "Holding above 95k support with declining sell volume" },
        { "symbol": "cmt_dogeusdt", "direction": "SHORT", "conviction": 5, "reason": "Lagging the rally with extreme positive funding (0.08%) indicating crowded longs" }
    ]
}`;
    }


    private buildSpecialistPrompt(
        profile: typeof ANALYST_PROFILES[AnalystMethodology],
        marketData: ExtendedMarketData,
        direction: 'LONG' | 'SHORT'
    ): string {
        const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
        const change = marketData.change24h >= 0 ? `+${marketData.change24h.toFixed(2)}%` : `${marketData.change24h.toFixed(2)}%`;

        // Guard against division by zero in range calculations
        // Validate all numeric values before division
        const low24h = Number.isFinite(marketData.low24h) ? marketData.low24h : 0;
        const high24h = Number.isFinite(marketData.high24h) ? marketData.high24h : 0;
        const currentPrice = Number.isFinite(marketData.currentPrice) ? marketData.currentPrice : 0;

        // For range percentage: use low24h if > 0, else currentPrice if > 0, else fallback to 1
        const rangeDenom = low24h > 0 ? low24h : (currentPrice > 0 ? currentPrice : 1);
        const range24h = ((high24h - low24h) / rangeDenom * 100).toFixed(2);

        // For price position in range: ensure denominator > 0
        const priceRangeDenom = high24h - low24h;
        const priceInRange = (Number.isFinite(priceRangeDenom) && priceRangeDenom > 0 && Number.isFinite(currentPrice))
            ? ((currentPrice - low24h) / priceRangeDenom * 100).toFixed(1)
            : '50.0'; // Default to middle if range is zero or invalid

        const fundingDirection = marketData.fundingRate !== undefined
            ? (marketData.fundingRate > 0 ? 'longs paying shorts' : 'shorts paying longs')
            : 'N/A';

        return `You are ${profile.name}, ${profile.title}.

${profile.description}

YOUR KNOWN BIASES (acknowledge these in your analysis):
${profile.focusAreas.map(f => `- ${f}`).join('\n')}

ANALYZE: ${displaySymbol}/USDT for a potential ${direction} position

MARKET DATA:
- Current Price: $${marketData.currentPrice.toFixed(2)}
- 24h High: $${marketData.high24h.toFixed(2)}
- 24h Low: $${marketData.low24h.toFixed(2)}
- 24h Range: ${range24h}% (price at ${priceInRange}% of range)
- 24h Change: ${change}
- 24h Volume: $${(marketData.volume24h / 1e6).toFixed(1)}M
${marketData.fundingRate !== undefined ? `- Funding Rate: ${(marketData.fundingRate * 100).toFixed(4)}% (${fundingDirection})` : ''}

YOUR THESIS WILL BE JUDGED ON:
1. DATA QUALITY (25%): Use specific numbers, not vague claims
2. LOGIC (25%): Reasoning must follow from the data
3. RISK AWARENESS (25%): Acknowledge what could go wrong
4. CATALYST (25%): Clear price driver with timeline

Apply your ${profile.title} methodology rigorously.

Respond with JSON:
{
    "recommendation": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
    "confidence": 0-100,
    "entry": number (suggested entry price),
    "targets": { "bull": number, "base": number, "bear": number },
    "stopLoss": number,
    "leverage": 1-5,
    "positionSize": 1-10,
    "thesis": "Your main argument in 2-3 sentences with SPECIFIC numbers",
    "bullCase": ["Point 1 with data", "Point 2 with data", "Point 3 with data"],
    "bearCase": ["Risk 1 - what invalidates thesis", "Risk 2", "Risk 3"],
    "keyMetrics": ["RSI: 65", "Volume: 1.2M", "Funding: 0.01%"],
    "catalyst": "What will trigger the move and WHEN",
    "timeframe": "Expected duration (e.g., '2-5 days')"
}`;
    }

    private buildRiskCouncilPrompt(
        profile: typeof ANALYST_PROFILES[AnalystMethodology],
        champion: AnalysisResult,
        marketData: ExtendedMarketData,
        accountBalance: number,
        currentPositions: Array<{ symbol: string; side: string; size: number }>,
        recentPnL: { day: number; week: number }
    ): string {
        const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
        const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);
        const direction = isBullish ? 'LONG' : 'SHORT';

        // Calculate key risk metrics with division by zero guards
        const currentPrice = marketData.currentPrice > 0 ? marketData.currentPrice : 1;
        const stopLossDistance = Math.abs((champion.priceTarget.bear - currentPrice) / currentPrice * 100);
        const takeProfitDistance = Math.abs((champion.priceTarget.base - currentPrice) / currentPrice * 100);
        // Guard against division by zero in risk/reward calculation
        const riskRewardRatio = stopLossDistance > 0 ? takeProfitDistance / stopLossDistance : 0;
        const positionPercent = (champion.positionSize / 10) * 30; // Max 30% at size 10

        // Check for correlation with existing positions
        const sameDirectionPositions = currentPositions.filter(p =>
            (direction === 'LONG' && p.side.toLowerCase().includes('long')) ||
            (direction === 'SHORT' && p.side.toLowerCase().includes('short'))
        );
        const correlationWarning = sameDirectionPositions.length > 0
            ? `WARNING: ${sameDirectionPositions.length} existing ${direction} position(s): ${sameDirectionPositions.map(p => p.symbol).join(', ')}`
            : 'OK - No correlation with existing positions';

        // Funding rate analysis
        const fundingRate = marketData.fundingRate ?? 0;
        const fundingAgainstUs = marketData.fundingRate !== undefined && (
            (direction === 'LONG' && fundingRate > 0) ||
            (direction === 'SHORT' && fundingRate < 0)
        );
        const fundingWarning = fundingAgainstUs && Math.abs(fundingRate) > 0.0005
            ? `WARNING - FUNDING AGAINST US: ${(fundingRate * 100).toFixed(4)}%`
            : marketData.fundingRate !== undefined
                ? `OK - Funding rate acceptable: ${(fundingRate * 100).toFixed(4)}%`
                : '- Funding rate: N/A';

        return `You are ${profile.name}, ${profile.title} - THE RISK MANAGER.

You have VETO POWER over all trades. Your job is to PROTECT THE PORTFOLIO.

PROPOSED TRADE:
- Symbol: ${displaySymbol}/USDT
- Direction: ${direction}
- Champion: ${champion.analystName} (${champion.confidence}% confidence)
- Thesis: ${champion.thesis}

TRADE PARAMETERS:
- Entry: $${marketData.currentPrice.toFixed(2)}
- Take Profit: $${champion.priceTarget.base.toFixed(2)} (+${takeProfitDistance.toFixed(2)}%)
- Stop Loss: $${champion.priceTarget.bear.toFixed(2)} (-${stopLossDistance.toFixed(2)}%)
- Risk/Reward: 1:${riskRewardRatio.toFixed(2)}
- Position Size: ${champion.positionSize}/10 (${positionPercent.toFixed(1)}% of account)

ACCOUNT STATE:
- Balance: $${accountBalance.toFixed(2)}
- Current Positions: ${currentPositions.length > 0 ? currentPositions.map(p => `${p.symbol} ${p.side}`).join(', ') : 'None'}
- 24h P&L: ${recentPnL.day >= 0 ? '+' : ''}${recentPnL.day.toFixed(2)}%
- 7d P&L: ${recentPnL.week >= 0 ? '+' : ''}${recentPnL.week.toFixed(2)}%

MARKET CONDITIONS:
- ${displaySymbol} 24h Change: ${marketData.change24h >= 0 ? '+' : ''}${marketData.change24h.toFixed(2)}%
- ${fundingWarning}
- ${correlationWarning}

YOUR CHECKLIST (from FLOW.md):
[ ] Position size <=30% of account? (Currently: ${positionPercent.toFixed(1)}%)
[ ] Stop loss <=10% from entry? (Currently: ${stopLossDistance.toFixed(2)}%)
[ ] Leverage <=5x? (Max allowed)
[ ] Not overexposed to one direction? (${sameDirectionPositions.length} same-direction positions)
[ ] Funding rate acceptable? (<=0.05% against us)
[ ] Recent drawdown acceptable? (7d: ${recentPnL.week.toFixed(2)}%)

VETO TRIGGERS (MUST veto if ANY are true):
X Stop loss >10% from entry
X Position would exceed 30% of account
X Already have 3+ positions open
X 7d drawdown >10% (reduce risk, no new trades)
X Funding rate >0.05% against position direction

Respond with JSON:
{
    "approved": true/false,
    "adjustments": {
        "positionSize": number (1-10, reduce if needed),
        "leverage": number (1-5, reduce if volatility high),
        "stopLoss": number (tighter stop loss price if needed)
    },
    "warnings": ["Warning 1", "Warning 2"],
    "vetoReason": "Only if approved=false, explain which rule was violated"
}`;
    }


    private async runDebateMatch(
        model: GenerativeModel,
        analystA: AnalysisResult,
        analystB: AnalysisResult,
        round: 'semifinal' | 'final',
        marketData: ExtendedMarketData
    ): Promise<TournamentMatch | null> {
        const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
        const roundLabel = round === 'final' ? 'CHAMPIONSHIP FINAL' : 'SEMIFINAL';

        const prompt = `You are a hedge fund CIO judging a ${roundLabel} debate about ${displaySymbol}/USDT.

===============================================================================
${roundLabel}: ${analystA.analystName} vs ${analystB.analystName}
===============================================================================

MARKET CONTEXT:
- Current Price: $${marketData.currentPrice.toFixed(2)}
- 24h Change: ${marketData.change24h >= 0 ? '+' : ''}${marketData.change24h.toFixed(2)}%
${marketData.fundingRate !== undefined ? `- Funding Rate: ${(marketData.fundingRate * 100).toFixed(4)}%` : ''}

-------------------------------------------------------------------------------
ANALYST A: ${analystA.analystName} ${analystA.analystEmoji} (${analystA.analystTitle})
-------------------------------------------------------------------------------
Recommendation: ${analystA.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${analystA.confidence}%
Position Size: ${analystA.positionSize}/10

THESIS: ${analystA.thesis}

BULL CASE:
${analystA.bullCase?.slice(0, 3).map(b => `- ${b}`).join('\n') || '- N/A'}

BEAR CASE (Risks Acknowledged):
${analystA.bearCase?.slice(0, 3).map(b => `- ${b}`).join('\n') || '- N/A'}

PRICE TARGETS:
- Bull: $${analystA.priceTarget.bull.toFixed(2)}
- Base: $${analystA.priceTarget.base.toFixed(2)}
- Bear: $${analystA.priceTarget.bear.toFixed(2)}

CATALYST: ${analystA.catalysts?.[0] || 'Not specified'}

-------------------------------------------------------------------------------
ANALYST B: ${analystB.analystName} ${analystB.analystEmoji} (${analystB.analystTitle})
-------------------------------------------------------------------------------
Recommendation: ${analystB.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${analystB.confidence}%
Position Size: ${analystB.positionSize}/10

THESIS: ${analystB.thesis}

BULL CASE:
${analystB.bullCase?.slice(0, 3).map(b => `- ${b}`).join('\n') || '- N/A'}

BEAR CASE (Risks Acknowledged):
${analystB.bearCase?.slice(0, 3).map(b => `- ${b}`).join('\n') || '- N/A'}

PRICE TARGETS:
- Bull: $${analystB.priceTarget.bull.toFixed(2)}
- Base: $${analystB.priceTarget.base.toFixed(2)}
- Bear: $${analystB.priceTarget.bear.toFixed(2)}

CATALYST: ${analystB.catalysts?.[0] || 'Not specified'}

===============================================================================
JUDGING CRITERIA (from FLOW.md)
===============================================================================

Score each analyst on these criteria (0-25 points each):

1. DATA QUALITY (25%): 
   - Uses specific numbers, not vague claims
   - References actual market data
   - Quantifies risks and targets

2. LOGIC (25%):
   - Reasoning is sound and follows from data
   - Arguments are internally consistent
   - Conclusions match the evidence

3. RISK AWARENESS (25%):
   - Acknowledges what could go wrong
   - Has realistic bear case
   - Stop loss is reasonable

4. CATALYST (25%):
   - Clear price driver identified
   - Timeline specified
   - Expected impact quantified

The winner's thesis will be EXECUTED as a real trade. Choose wisely.

Respond with JSON containing:
- winner: The analyst ID who won ("${analystA.analystId}" or "${analystB.analystId}")
- winnerScore: Scores for the winner { data, logic, risk, catalyst, total }
- loserScore: Scores for the loser { data, logic, risk, catalyst, total }
- reasoning: Why the winner won
- keyDifferentiator: The single most important factor`;

        const timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
        try {
            const result = await Promise.race([
                model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: TOURNAMENT_JUDGE_SCHEMA
                    }
                }),
                timeout.promise
            ]);
            timeout.cancel();

            const parsed = JSON.parse(result.response.text());

            // LOG LLM OUTPUT: Tournament Battle
            logger.info(`\n${'='.repeat(60)}`);
            logger.info(`⚔️ LLM OUTPUT - Tournament ${roundLabel}`);
            logger.info(`${'='.repeat(60)}`);
            logger.info(`${analystA.analystName} ${analystA.analystEmoji} vs ${analystB.analystName} ${analystB.analystEmoji}`);
            logger.info(`Winner: ${parsed.winner}`);
            logger.info(`Winner Score: ${JSON.stringify(parsed.winnerScore)}`);
            logger.info(`Loser Score: ${JSON.stringify(parsed.loserScore)}`);
            logger.info(`Reasoning: ${parsed.reasoning}`);
            if (parsed.keyDifferentiator) logger.info(`Key Differentiator: ${parsed.keyDifferentiator}`);
            logger.info(`${'='.repeat(60)}\n`);

            // Validate winner is one of the expected analyst IDs
            const validWinner = parsed.winner === analystB.analystId ? analystB.analystId : analystA.analystId;
            const isAWinner = validWinner === analystA.analystId;

            // Convert new schema format to expected scores format
            const scores: Record<string, { data: number; logic: number; risk: number; catalyst: number; total: number }> = {};
            scores[analystA.analystId] = isAWinner ? parsed.winnerScore : parsed.loserScore;
            scores[analystB.analystId] = isAWinner ? parsed.loserScore : parsed.winnerScore;

            return {
                matchId: `${round}_${Date.now()}`,
                round,
                analystA,
                analystB,
                winner: validWinner,
                scores,
                reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : ''
            };
        } catch (error) {
            timeout.cancel();
            logger.warn(`Debate match failed:`, error instanceof Error ? error.message : String(error));
            // Default to higher confidence analyst on failure
            return {
                matchId: `${round}_${Date.now()}`,
                round,
                analystA,
                analystB,
                winner: analystA.confidence >= analystB.confidence ? analystA.analystId : analystB.analystId,
                scores: {},
                reasoning: 'Debate failed, defaulting to higher confidence'
            };
        }
    }

    private aggregateCoinScores(results: CoinSelectionResult[]): AggregatedCoinScore {
        const scores = new Map<string, AggregatedCoinScore>();

        for (const result of results) {
            for (let i = 0; i < result.picks.length; i++) {
                const pick = result.picks[i];
                const rank = i + 1; // 1, 2, 3
                const points = (4 - rank) * pick.conviction; // #1=3x, #2=2x, #3=1x

                if (!scores.has(pick.symbol)) {
                    scores.set(pick.symbol, {
                        symbol: pick.symbol,
                        totalScore: 0,
                        direction: pick.direction,
                        votes: []
                    });
                }

                const score = scores.get(pick.symbol)!;
                score.totalScore += points;
                score.votes.push({
                    analystId: result.analystId,
                    rank,
                    conviction: pick.conviction
                });
            }
        }

        // Determine direction for each coin based on highest conviction vote
        for (const score of scores.values()) {
            if (score.votes.length > 0) {
                // Find the vote with highest conviction to determine direction
                const highestConvictionVote = score.votes.reduce((max, vote) =>
                    vote.conviction > max.conviction ? vote : max
                    , score.votes[0]);

                // Find the original pick to get its direction
                for (const result of results) {
                    const pick = result.picks.find(p =>
                        p.symbol === score.symbol &&
                        result.analystId === highestConvictionVote.analystId
                    );
                    if (pick) {
                        score.direction = pick.direction;
                        break;
                    }
                }
            }
        }

        // Find top coin - handle empty results gracefully
        let topCoin: AggregatedCoinScore | null = null;

        for (const score of scores.values()) {
            if (!topCoin || score.totalScore > topCoin.totalScore) {
                topCoin = score;
            }
        }

        // If no scores at all, return a safe default with zero score
        // This signals to the caller that no valid selection was made
        if (!topCoin) {
            logger.warn('No coin scores aggregated - all selectors may have failed');
            return {
                symbol: 'cmt_btcusdt',
                totalScore: 0, // Zero score indicates no valid selection
                direction: 'LONG',
                votes: []
            };
        }

        return topCoin;
    }

    private parseSpecialistResponse(
        parsed: any,
        profile: typeof ANALYST_PROFILES[AnalystMethodology],
        methodology: AnalystMethodology,
        currentPrice: number
    ): AnalysisResult {
        const validRecs = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'];
        const recommendation = validRecs.includes(parsed.recommendation?.toLowerCase())
            ? parsed.recommendation.toLowerCase()
            : 'hold';

        const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 50));
        const positionSize = Math.min(10, Math.max(1, Number(parsed.positionSize) || 5));

        // Parse price targets with Number.isFinite guards
        const safePrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 100;

        const parseBullTarget = Number(parsed.targets?.bull);
        const parseBaseTarget = Number(parsed.targets?.base);
        const parseBearTarget = Number(parsed.targets?.bear);

        const priceTarget = {
            bull: Number.isFinite(parseBullTarget) && parseBullTarget > 0 ? parseBullTarget : safePrice * 1.15,
            base: Number.isFinite(parseBaseTarget) && parseBaseTarget > 0 ? parseBaseTarget : safePrice * 1.08,
            bear: Number.isFinite(parseBearTarget) && parseBearTarget > 0 ? parseBearTarget : safePrice * 0.92
        };

        // Determine risk level
        let riskLevel: 'low' | 'medium' | 'high' | 'very_high' = 'medium';
        if (positionSize <= 2 || confidence < 40) riskLevel = 'very_high';
        else if (positionSize <= 4 || confidence < 55) riskLevel = 'high';
        else if (positionSize >= 7 && confidence >= 70) riskLevel = 'low';

        return {
            analystId: profile.id,
            analystName: profile.name,
            analystEmoji: profile.avatarEmoji,
            analystTitle: profile.title,
            methodology,
            recommendation: recommendation as AnalysisResult['recommendation'],
            confidence,
            thesis: parsed.thesis?.slice(0, 500) || '',
            reasoning: [],
            bullCase: Array.isArray(parsed.bullCase) ? parsed.bullCase.slice(0, 5) : [],
            bearCase: Array.isArray(parsed.bearCase) ? parsed.bearCase.slice(0, 5) : [],
            priceTarget,
            timeHorizon: parsed.timeframe || '2-5 days',
            positionSize,
            riskLevel,
            keyMetrics: Array.isArray(parsed.keyMetrics) ? parsed.keyMetrics : [],
            catalysts: parsed.catalyst ? [parsed.catalyst] : [],
            risks: Array.isArray(parsed.bearCase) ? parsed.bearCase.slice(0, 3) : []
        };
    }
}

// Singleton export
export const collaborativeFlowService = new CollaborativeFlowService();
