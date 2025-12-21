/**
 * Stock Tournament Service
 * 
 * Manages the debate tournament between analyst agents.
 * Pairs bulls vs bears and runs multi-turn debates.
 */

import { GoogleGenAI } from '@google/genai';
import {
    AnalystAgent,
    AnalystMethodology,
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

    if (winners.length < 2) return pairings;

    // Categorize winners by recommendation
    const bulls = winners.filter(t =>
        t.recommendation === 'strong_buy' || t.recommendation === 'buy'
    );
    const bears = winners.filter(t =>
        t.recommendation === 'strong_sell' || t.recommendation === 'sell'
    );
    const holds = winners.filter(t => t.recommendation === 'hold');

    // Distribute holds to balance sides
    while (holds.length > 0) {
        const hold = holds.pop();
        if (hold) {
            if (bulls.length <= bears.length) bulls.push(hold);
            else bears.push(hold);
        }
    }

    // If we still don't have enough on each side, pair by confidence instead
    // This handles cases where most/all winners are HOLDs
    if (bulls.length === 0 || bears.length === 0) {
        // Sort all winners by confidence and pair 1v4, 2v3 style
        const sorted = [...winners].sort((a, b) => b.confidence - a.confidence);

        // Create 2 semifinal matches: highest vs lowest confidence pairs
        if (sorted.length >= 4) {
            pairings.push({
                bull: sorted[0], // Highest confidence as "bull"
                bear: sorted[3], // Lowest confidence as "bear"
                round: 'semifinal'
            });
            pairings.push({
                bull: sorted[1],
                bear: sorted[2],
                round: 'semifinal'
            });
        } else if (sorted.length >= 2) {
            pairings.push({
                bull: sorted[0],
                bear: sorted[sorted.length - 1],
                round: 'semifinal'
            });
        }
        return pairings;
    }

    // Normal case: pair bulls vs bears
    const numMatches = Math.min(2, Math.min(bulls.length, bears.length));
    for (let i = 0; i < numMatches; i++) {
        if (bulls[i] && bears[i]) {
            pairings.push({
                bull: bulls[i],
                bear: bears[i],
                round: 'semifinal'
            });
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

    if (validDebates.length === 0) return null;

    const winners = validDebates.map(d => d.winner === 'bull' ? d.bullThesis : d.bearThesis);

    // If only 1 semifinal, get both participants from that debate for the final
    if (validDebates.length === 1 && winners.length === 1) {
        const debate = validDebates[0];
        const winner = winners[0];

        // Validate debate and winner exist
        if (!debate || !winner || !debate.winner) return null;

        const loser = debate.winner === 'bull' ? debate.bearThesis : debate.bullThesis;

        const winnerScore = getRecommendationScore(winner.recommendation);
        const loserScore = getRecommendationScore(loser.recommendation);

        return {
            bull: winnerScore >= loserScore ? winner : loser,
            bear: winnerScore >= loserScore ? loser : winner,
            round: 'final'
        };
    }

    // Normal case: 2 semifinal winners - safe array access
    if (winners.length < 2) return null;

    const first = winners[0];
    const second = winners[1];

    // Validate both winners exist
    if (!first || !second) return null;

    // Determine which is more bullish
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
 * Format key stock data for debate context
 * Provides analysts with real data to reference in arguments
 */
function formatDebateContext(stockData: StockAnalysisData): string {
    const price = stockData.quote?.price ?? 0;
    const pe = stockData.fundamentals?.peRatio;
    const rsi = stockData.technicals?.rsi14 ?? 50;
    const sentiment = stockData.sentiment?.overallScore ?? 0;

    const lines: string[] = [
        `Current Price: $${price.toFixed(2)}`,
    ];

    // Add valuation context
    if (pe !== null && pe !== undefined) {
        const peContext = pe < 15 ? '(below market)' : pe > 25 ? '(premium)' : '(market avg)';
        lines.push(`P/E Ratio: ${pe.toFixed(1)} ${peContext}`);
    }

    // Add technical context
    const rsiContext = rsi < 30 ? 'OVERSOLD' : rsi > 70 ? 'OVERBOUGHT' : 'neutral';
    lines.push(`RSI(14): ${rsi.toFixed(0)} - ${rsiContext}`);

    // Add trend
    if (stockData.technicals?.trend) {
        lines.push(`Trend: ${stockData.technicals.trend.toUpperCase()}`);
    }

    // Add key levels
    const support = stockData.technicals?.supportLevels?.[0];
    const resistance = stockData.technicals?.resistanceLevels?.[0];
    if (support) lines.push(`Key Support: $${support.toFixed(2)}`);
    if (resistance) lines.push(`Key Resistance: $${resistance.toFixed(2)}`);

    // Add sentiment
    const sentimentLabel = sentiment > 0.2 ? 'Bullish' : sentiment < -0.2 ? 'Bearish' : 'Neutral';
    lines.push(`Market Sentiment: ${sentimentLabel} (${sentiment.toFixed(2)})`);

    // Add growth metrics if available
    if (stockData.fundamentals?.revenueGrowth) {
        const growth = stockData.fundamentals.revenueGrowth * 100;
        lines.push(`Revenue Growth: ${growth > 0 ? '+' : ''}${growth.toFixed(1)}%`);
    }

    return lines.join('\n');
}

/**
 * Extract data points referenced in debate content - ENHANCED
 */
function extractDataPointsReferenced(content: string): string[] {
    const dataPoints: string[] = [];

    // Valuation metrics
    if (/P\/E|PE ratio|price.to.earnings/i.test(content)) dataPoints.push('P/E Ratio');
    if (/P\/B|price.to.book/i.test(content)) dataPoints.push('P/B Ratio');
    if (/EV\/EBITDA|enterprise value/i.test(content)) dataPoints.push('EV/EBITDA');
    if (/PEG ratio/i.test(content)) dataPoints.push('PEG Ratio');
    if (/FCF|free cash flow/i.test(content)) dataPoints.push('Free Cash Flow');

    // Growth metrics
    if (/revenue growth|sales growth/i.test(content)) dataPoints.push('Revenue Growth');
    if (/earnings growth|EPS growth/i.test(content)) dataPoints.push('Earnings Growth');
    if (/margin|profitability/i.test(content)) dataPoints.push('Margins');

    // Technical indicators
    if (/RSI|relative strength/i.test(content)) dataPoints.push('RSI');
    if (/MACD/i.test(content)) dataPoints.push('MACD');
    if (/moving average|SMA|EMA|50.day|200.day/i.test(content)) dataPoints.push('Moving Averages');
    if (/support|resistance/i.test(content)) dataPoints.push('Support/Resistance');
    if (/volume/i.test(content)) dataPoints.push('Volume');
    if (/bollinger/i.test(content)) dataPoints.push('Bollinger Bands');

    // Sentiment
    if (/sentiment|news|headlines/i.test(content)) dataPoints.push('Sentiment');
    if (/analyst|rating|upgrade|downgrade/i.test(content)) dataPoints.push('Analyst Ratings');
    if (/short interest|shorts/i.test(content)) dataPoints.push('Short Interest');

    // Financial health
    if (/debt|leverage|D\/E/i.test(content)) dataPoints.push('Debt Levels');
    if (/ROE|return on equity/i.test(content)) dataPoints.push('ROE');
    if (/cash|liquidity/i.test(content)) dataPoints.push('Cash Position');

    return [...new Set(dataPoints)]; // Remove duplicates
}

/**
 * Generate a single debate turn - ENHANCED
 * Now includes stock data context for more informed arguments
 */
async function generateDebateTurn(
    ai: GoogleGenAI,
    model: string,
    analyst: AnalystAgent,
    thesis: InvestmentThesis,
    position: 'bull' | 'bear',
    previousTurn: string,
    stockData: StockAnalysisData,
    round: number
): Promise<DebateTurn> {
    // Build enhanced system prompt with analyst context and data
    const dataContext = formatDebateContext(stockData);
    const keyArguments = position === 'bull'
        ? thesis.bullCase.slice(0, 3).join('; ')
        : thesis.bearCase.slice(0, 3).join('; ');

    const systemPrompt = `${DEBATE_SYSTEM_PROMPT}

═══ YOUR IDENTITY ═══
You are ${analyst.name}, the ${analyst.title}.
Methodology: ${analyst.methodology.toUpperCase()}
Philosophy: ${analyst.description}

═══ YOUR THESIS ═══
Recommendation: ${thesis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${thesis.confidence}%
Summary: ${thesis.summary}
Key Arguments: ${keyArguments}

═══ CURRENT MARKET DATA ═══
${dataContext}

═══ DEBATE INSTRUCTIONS ═══
- Reference SPECIFIC numbers from the data above
- Stay true to your ${analyst.methodology} methodology
- Be persuasive but acknowledge valid counterpoints
- Keep response under 150 words`;

    const userPrompt = DEBATE_TURN_PROMPT(position, previousTurn, round);

    try {
        const response = await ai.models.generateContent({
            model,
            contents: userPrompt,
            config: {
                systemInstruction: systemPrompt,
                temperature: 0.75, // Slightly lower for more focused responses
                maxOutputTokens: 400
            }
        });

        const content = response.text || 'No response generated.';
        const dataPoints = extractDataPointsReferenced(content);

        return {
            speakerId: analyst.id,
            position,
            content,
            dataPointsReferenced: dataPoints,
            argumentStrength: calculateArgumentStrength(content, analyst.methodology),
            timestamp: Date.now()
        };
    } catch (error) {
        logger.error(`Failed to generate debate turn for ${analyst.name}:`, error);

        // Enhanced fallback with thesis content - safe array access
        const bullArg = (thesis.bullCase && thesis.bullCase.length > 0) ? thesis.bullCase[0] : 'The fundamentals support upside potential.';
        const bearArg = (thesis.bearCase && thesis.bearCase.length > 0) ? thesis.bearCase[0] : 'Risk factors warrant caution.';

        const fallbackContent = position === 'bull'
            ? `Based on my ${analyst.methodology} analysis, I maintain my bullish stance. ${bullArg}`
            : `My ${analyst.methodology} framework highlights concerns. ${bearArg}`;

        return {
            speakerId: analyst.id,
            position,
            content: fallbackContent,
            dataPointsReferenced: [],
            argumentStrength: 45,
            timestamp: Date.now()
        };
    }
}

/**
 * Calculate argument strength based on content quality - ENHANCED & METHODOLOGY AWARE
 * Evaluates: data quality, logic, risk acknowledgment, specificity
 */
function calculateArgumentStrength(content: string, methodology: AnalystMethodology = 'value'): number {
    if (!content || typeof content !== 'string') return 50;

    let score = 40; // Base score (slightly below neutral)

    // ═══════════════════════════════════════════════════════════════════════════
    // DATA QUALITY (up to +25 points)
    // ═══════════════════════════════════════════════════════════════════════════

    // Specific numbers
    const percentMatches = content.match(/\d+\.?\d*%/g) || [];
    score += Math.min(10, percentMatches.length * 3); // Up to 10 for percentages

    const dollarMatches = content.match(/\$\d+\.?\d*[BMK]?/gi) || [];
    score += Math.min(8, dollarMatches.length * 2); // Up to 8 for dollar amounts

    // Ratios and multiples
    if (/\d+\.?\d*x/i.test(content)) score += 3;
    if (/P\/E|P\/B|EV\/|ROE|ROA/i.test(content)) score += 4;

    // ═══════════════════════════════════════
    // METHODOLOGY-SPECIFIC BONUSES (+10 points)
    // ═══════════════════════════════════════

    if (methodology === 'quant') {
        if (/factor|statistically|probability|backtest|standard deviation/i.test(content)) score += 10;
    } else if (methodology === 'technical') {
        if (/trend|support|resistance|volume|breakout|MA|RSI/i.test(content)) score += 10;
    } else if (methodology === 'macro') {
        if (/cycle|fed|interest rates|inflation|liquidity|policy/i.test(content)) score += 10;
    } else if (methodology === 'sentiment') {
        if (/narrative|fomo|crowd|social volume|fear|greed/i.test(content)) score += 10;
    } else if (methodology === 'value') {
        if (/intrinsic|moat|safety|undervalued|cash flow/i.test(content)) score += 10;
    } else if (methodology === 'growth') {
        if (/TAM|acceleration|scaling|innovation|recurring/i.test(content)) score += 10;
    } else if (methodology === 'risk') {
        if (/leverage|protection|drawdown|worst-case|limit/i.test(content)) score += 10;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // LOGIC & STRUCTURE (up to +20 points)
    // ═══════════════════════════════════════════════════════════════════════════

    // Causal reasoning
    if (/because|therefore|thus|consequently|as a result/i.test(content)) score += 5;

    // Acknowledges nuance/counterarguments
    if (/however|although|while|despite|nevertheless|on the other hand/i.test(content)) score += 5;

    // Conditional reasoning
    if (/if.*then|assuming|given that|provided that/i.test(content)) score += 3;

    // Comparative analysis
    if (/compared to|relative to|versus|vs\.|higher than|lower than/i.test(content)) score += 4;

    // Structured argument
    if (/first|second|third|finally|moreover|additionally/i.test(content)) score += 3;

    // ═══════════════════════════════════════════════════════════════════════════
    // RISK ACKNOWLEDGMENT (up to +10 points)
    // ═══════════════════════════════════════════════════════════════════════════

    if (/risk|downside|concern|challenge|threat|weakness/i.test(content)) score += 5;
    if (/could fail|might not|uncertain|volatile/i.test(content)) score += 3;
    if (/worst case|bear case|if wrong/i.test(content)) score += 2;

    // ═══════════════════════════════════════════════════════════════════════════
    // CATALYST IDENTIFICATION (up to +10 points)
    // ═══════════════════════════════════════════════════════════════════════════

    if (/catalyst|trigger|upcoming|Q[1-4]|earnings|announcement/i.test(content)) score += 5;
    if (/timeline|within \d+ months|by year end|near term/i.test(content)) score += 3;
    if (/inflection point|turning point|breakout/i.test(content)) score += 2;

    // ═══════════════════════════════════════════════════════════════════════════
    // PENALTIES
    // ═══════════════════════════════════════════════════════════════════════════

    // Too short (lacks substance)
    if (content.length < 50) score -= 10;

    // Too vague
    if (/maybe|perhaps|possibly|might|could be/i.test(content) &&
        !(/\d+%|\$\d+/i.test(content))) score -= 5;

    // Repetitive/filler
    if (/obviously|clearly|everyone knows|it's clear that/i.test(content)) score -= 3;

    // ═══════════════════════════════════════════════════════════════════════════
    // LENGTH BONUS (moderate - quality over quantity)
    // ═══════════════════════════════════════════════════════════════════════════

    if (content.length > 100) score += 2;
    if (content.length > 150) score += 2;
    if (content.length > 200) score += 1;

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
            lastBearStatement, stockData, turn + 1
        );
        debate.dialogue.push(bullTurn);
        lastBullStatement = bullTurn.content;

        if (config.onTurnComplete) {
            try {
                config.onTurnComplete(debate, bullTurn);
            } catch (e) {
                logger.error('Error in onTurnComplete callback (bull):', e);
            }
        }

        // Bear turn
        const bearTurn = await generateDebateTurn(
            ai, config.model, bearAnalyst, pairing.bear, 'bear',
            lastBullStatement, stockData, turn + 1
        );
        debate.dialogue.push(bearTurn);
        lastBearStatement = bearTurn.content;

        if (config.onTurnComplete) {
            try {
                config.onTurnComplete(debate, bearTurn);
            } catch (e) {
                logger.error('Error in onTurnComplete callback (bear):', e);
            }
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    // Calculate final scores
    debate.scores = calculateDebateScores(debate);

    // Determine winner with tie-breaker logic
    if (debate.scores.bullScore > debate.scores.bearScore) {
        debate.winner = 'bull';
    } else if (debate.scores.bearScore > debate.scores.bullScore) {
        debate.winner = 'bear';
    } else {
        // Tie-breaker: use thesis confidence, then data quality
        const bullTieBreaker = debate.bullThesis.confidence + debate.scores.dataQuality.bull;
        const bearTieBreaker = debate.bearThesis.confidence + debate.scores.dataQuality.bear;
        debate.winner = bullTieBreaker >= bearTieBreaker ? 'bull' : 'bear';
    }

    debate.winningArguments = extractWinningArguments(debate);

    return debate;
}

/**
 * Calculate comprehensive debate scores - ENHANCED
 * More nuanced scoring based on debate quality and thesis strength
 */
function calculateDebateScores(debate: StockDebate): DebateScores {
    const bullTurns = debate.dialogue.filter(t => t.position === 'bull');
    const bearTurns = debate.dialogue.filter(t => t.position === 'bear');

    // ═══════════════════════════════════════════════════════════════════════════
    // ARGUMENT STRENGTH (from calculateArgumentStrength)
    // ═══════════════════════════════════════════════════════════════════════════
    const avgBullStrength = bullTurns.length > 0
        ? bullTurns.reduce((sum, t) => sum + t.argumentStrength, 0) / bullTurns.length
        : 50;
    const avgBearStrength = bearTurns.length > 0
        ? bearTurns.reduce((sum, t) => sum + t.argumentStrength, 0) / bearTurns.length
        : 50;

    // ═══════════════════════════════════════════════════════════════════════════
    // DATA QUALITY (unique data points referenced)
    // ═══════════════════════════════════════════════════════════════════════════
    const bullDataPoints = new Set(bullTurns.flatMap(t => t.dataPointsReferenced));
    const bearDataPoints = new Set(bearTurns.flatMap(t => t.dataPointsReferenced));

    // Score: 10 points per unique data type, max 100
    const bullDataQuality = Math.min(100, bullDataPoints.size * 12);
    const bearDataQuality = Math.min(100, bearDataPoints.size * 12);

    // ═══════════════════════════════════════════════════════════════════════════
    // LOGIC COHERENCE (argument strength + consistency bonus)
    // ═══════════════════════════════════════════════════════════════════════════
    // Bonus for consistent argument strength across turns
    const bullStrengthVariance = bullTurns.length > 1
        ? Math.sqrt(bullTurns.reduce((sum, t) => sum + Math.pow(t.argumentStrength - avgBullStrength, 2), 0) / bullTurns.length)
        : 0;
    const bearStrengthVariance = bearTurns.length > 1
        ? Math.sqrt(bearTurns.reduce((sum, t) => sum + Math.pow(t.argumentStrength - avgBearStrength, 2), 0) / bearTurns.length)
        : 0;

    // Lower variance = more consistent = bonus
    const bullConsistencyBonus = Math.max(0, 10 - bullStrengthVariance / 2);
    const bearConsistencyBonus = Math.max(0, 10 - bearStrengthVariance / 2);

    const bullLogic = Math.min(100, Math.round(avgBullStrength + bullConsistencyBonus));
    const bearLogic = Math.min(100, Math.round(avgBearStrength + bearConsistencyBonus));

    // ═══════════════════════════════════════════════════════════════════════════
    // RISK ACKNOWLEDGMENT (from thesis + debate content)
    // ═══════════════════════════════════════════════════════════════════════════
    const bullThesisRisks = (debate.bullThesis.bearCase?.length ?? 0) + (debate.bullThesis.risks?.length ?? 0);
    const bearThesisRisks = (debate.bearThesis.bearCase?.length ?? 0) + (debate.bearThesis.risks?.length ?? 0);

    // Check if debate content acknowledges risks
    const bullAcknowledgesRisk = bullTurns.some(t =>
        /risk|concern|however|although|downside|challenge/i.test(t.content)
    ) ? 15 : 0;
    const bearAcknowledgesRisk = bearTurns.some(t =>
        /risk|concern|however|although|downside|challenge/i.test(t.content)
    ) ? 15 : 0;

    const bullRiskScore = Math.min(100, bullThesisRisks * 15 + bullAcknowledgesRisk);
    const bearRiskScore = Math.min(100, bearThesisRisks * 15 + bearAcknowledgesRisk);

    // ═══════════════════════════════════════════════════════════════════════════
    // CATALYST IDENTIFICATION
    // ═══════════════════════════════════════════════════════════════════════════
    const bullCatalysts = debate.bullThesis.catalysts?.length ?? 0;
    const bearCatalysts = debate.bearThesis.catalysts?.length ?? 0;

    // Check debate content for catalyst mentions
    const bullMentionsCatalyst = bullTurns.some(t =>
        /catalyst|trigger|Q[1-4]|earnings|announcement|upcoming|near.term/i.test(t.content)
    ) ? 20 : 0;
    const bearMentionsCatalyst = bearTurns.some(t =>
        /catalyst|trigger|Q[1-4]|earnings|announcement|upcoming|near.term/i.test(t.content)
    ) ? 20 : 0;

    const bullCatalystScore = Math.min(100, bullCatalysts * 20 + bullMentionsCatalyst);
    const bearCatalystScore = Math.min(100, bearCatalysts * 20 + bearMentionsCatalyst);

    // ═══════════════════════════════════════════════════════════════════════════
    // FINAL SCORE CALCULATION
    // ═══════════════════════════════════════════════════════════════════════════
    // Weighted average: Data 25%, Logic 25%, Risk 25%, Catalyst 25%
    const bullFinalScore = Math.round(
        (bullDataQuality * 0.25) +
        (bullLogic * 0.25) +
        (bullRiskScore * 0.25) +
        (bullCatalystScore * 0.25) +
        (debate.bullThesis.confidence / 20) // Small confidence bonus (0-5 points)
    );

    const bearFinalScore = Math.round(
        (bearDataQuality * 0.25) +
        (bearLogic * 0.25) +
        (bearRiskScore * 0.25) +
        (bearCatalystScore * 0.25) +
        (debate.bearThesis.confidence / 20)
    );

    return {
        bullScore: Math.min(100, bullFinalScore),
        bearScore: Math.min(100, bearFinalScore),
        dataQuality: {
            bull: bullDataQuality,
            bear: bearDataQuality
        },
        logicCoherence: {
            bull: bullLogic,
            bear: bearLogic
        },
        riskAcknowledgment: {
            bull: bullRiskScore,
            bear: bearRiskScore
        },
        catalystIdentification: {
            bull: bullCatalystScore,
            bear: bearCatalystScore
        }
    };
}

/**
 * Extract the strongest arguments from the winning side - ENHANCED
 * Prioritizes arguments with data points and clear reasoning
 */
function extractWinningArguments(debate: StockDebate): string[] {
    const winnerTurns = debate.dialogue.filter(t => t.position === debate.winner);

    if (winnerTurns.length === 0) {
        // Fallback to thesis arguments
        const winnerThesis = debate.winner === 'bull' ? debate.bullThesis : debate.bearThesis;
        return winnerThesis.bullCase.slice(0, 3);
    }

    // Score each turn for extraction priority
    const scoredTurns = winnerTurns.map(turn => {
        let extractionScore = turn.argumentStrength;

        // Bonus for data references
        extractionScore += turn.dataPointsReferenced.length * 5;

        // Bonus for specific numbers in content
        const numberMatches = turn.content.match(/\d+\.?\d*%|\$\d+/g) || [];
        extractionScore += numberMatches.length * 3;

        // Bonus for causal reasoning
        if (/because|therefore|thus|as a result/i.test(turn.content)) {
            extractionScore += 5;
        }

        return { turn, extractionScore };
    });

    // Sort by extraction score and take top 3
    return scoredTurns
        .sort((a, b) => b.extractionScore - a.extractionScore)
        .slice(0, 3)
        .map(({ turn }) => {
            // Clean up the content for display
            let content = turn.content.trim();

            // Truncate intelligently at sentence boundary if too long
            if (content.length > 250) {
                const sentenceEnd = content.slice(0, 250).lastIndexOf('.');
                if (sentenceEnd > 150) {
                    content = content.slice(0, sentenceEnd + 1);
                } else {
                    content = content.slice(0, 247) + '...';
                }
            }

            return content;
        });
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
    // Input validation
    if (!theses || theses.length === 0) {
        logger.warn('runTournament called with empty theses array');
        return {
            quarterfinals: [],
            semifinals: [],
            final: null,
            champion: null,
            allDebates: []
        };
    }

    if (!config.apiKey) {
        throw new Error('API key is required for tournament');
    }

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
        // Safe access with null check
        if (bestDebate && bestDebate.winner) {
            result.champion = bestDebate.winner === 'bull' ? bestDebate.bullThesis : bestDebate.bearThesis;
        }
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
