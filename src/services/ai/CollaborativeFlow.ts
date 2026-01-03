/**
 * Collaborative Trading Flow v3.1.0
 * 
 * Implements the 6-stage pipeline with TURN-BY-TURN debates:
 * 1. Market Scan - Fetch data for all coins
 * 2. Coin Selection Debate - 3 analysts
 * 3. Championship Debate - 4 analysts
 * 4. Risk Council - Karen approves/vetoes
 * 5. Execution - Place trade on WEEX
 * 6. Position Management - Monitor and adjust
 * 
 * Turn counts configurable via config.debate.turnsPerAnalyst
 * Default: 2 turns/analyst = 14 total turns (6+8)
 */

import { GoogleGenerativeAI, GenerativeModel, SchemaType } from '@google/generative-ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { ANALYST_PROFILES, type AnalystMethodology } from '../../constants/analyst';
import {
    buildSpecialistPrompt,
    buildRiskCouncilPrompt
} from '../../constants/prompts/builders';
import {
    safePrice,
    safePercent,
    cleanSymbol
} from '../../constants/prompts/promptHelpers';
import {
    buildCoinSelectionContext,
    buildChampionshipContext,
    buildDebateTurnPrompt
} from '../../constants/prompts/debateHelpers';
import { buildManagePrompt } from '../../constants/prompts/managePrompts';
import {
    buildJudgePrompt,
    buildCoinSelectionJudgePrompt,
    type JudgeInput,
    type JudgeVerdict
} from '../../constants/prompts/judge';
import type { ExtendedMarketData, AnalysisResult } from './GeminiService';

// =============================================================================
// TYPES
// =============================================================================

export interface CoinPick {
    symbol: string;
    direction: 'LONG' | 'SHORT';
    conviction: number;
    reason: string;
}

export interface CoinSelectionResult {
    analystId: string;
    picks: CoinPick[];
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

export interface DebateTurn {
    speaker: string;
    analystName: string;
    argument: string;
    strength: number;
    dataPointsReferenced?: string[];
}

export interface AnalystScore {
    data: number;
    logic: number;
    risk: number;
    catalyst: number;
    total: number;
}

export interface FourWayDebateResult {
    turns: DebateTurn[];
    winner: string;
    scores: Record<string, AnalystScore>;
    reasoning: string;
    winningArguments: string[];
}

export interface ChampionshipDebateResult {
    turns: DebateTurn[];
    winner: string;
    scores: Record<string, AnalystScore>;
    reasoning: string;
    winningArguments: string[];
    summary: string;
}

// =============================================================================
// SCHEMAS
// =============================================================================

const DEBATE_TURN_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        argument: {
            type: SchemaType.STRING,
            description: 'Your complete debate argument. MUST be 150-200 words minimum.'
        },
        dataPointsReferenced: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: 'List of specific data points referenced'
        },
        strength: {
            type: SchemaType.NUMBER,
            description: 'Self-assessed argument strength (1-10)'
        }
    },
    required: ['argument', 'dataPointsReferenced', 'strength']
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
            },
            required: ['positionSize', 'leverage', 'stopLoss']
        },
        warnings: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING }
        },
        vetoReason: { type: SchemaType.STRING }
    },
    required: ['approved', 'warnings', 'adjustments']
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
            items: { type: SchemaType.STRING }
        },
        catalyst: { type: SchemaType.STRING },
        timeframe: { type: SchemaType.STRING }
    },
    required: ['recommendation', 'confidence', 'entry', 'targets', 'stopLoss', 'leverage', 'positionSize', 'thesis']
};

const AI_REQUEST_TIMEOUT = config.ai.requestTimeoutMs;
const MAX_DEBATE_TURN_RETRIES = config.ai.maxRetries;

// FIXED: Pre-compile regex patterns at module level to avoid repeated compilation
// These patterns are used in coin/action extraction from debate arguments
const MANAGE_PATTERNS = [
    /\baction[:\s]+"?MANAGE"?/i,                    // action: "MANAGE"
    /\brecommend(?:ing)?\s+(?:to\s+)?MANAGE\b/i,    // recommend MANAGE
    /\bshould\s+MANAGE\b/i,                         // should MANAGE
    /\bclose\s+(?:the\s+)?(?:entire\s+)?position\b/i, // close position
    /\bclose\s+(?:the\s+)?(?:existing\s+)?(?:LONG|SHORT)\s+position/i, // close LONG/SHORT position
    /\breduce\s+(?:the\s+)?(?:existing\s+)?position\b/i, // reduce position
    /\bexit\s+(?:the\s+)?(?:existing\s+)?position\b/i,  // exit position
    /\btake\s+(?:partial\s+)?profit(?:s)?\s+(?:on|from)\b/i, // take profits on/from
    /\bcut\s+(?:the\s+)?loss(?:es)?\s+(?:on|now)\b/i,   // cut losses on/now
    /\bmanage\s+(?:the\s+)?(?:existing\s+)?(?:open\s+)?position\b/i, // manage position
    /\bclose\s+(?:out|it)\b/i,                      // close out / close it
];

const RECOMMEND_PATTERNS = [
    /I\s+recommend\s+(LONG|SHORT)\b/i,
    /recommend(?:ing)?\s+(LONG|SHORT)\b/i,
    /position[:\s]+(LONG|SHORT)\b/i,
    /go(?:ing)?\s+(LONG|SHORT)\b/i,
    /action[:\s]+"?(LONG|SHORT|MANAGE)"?/i
];

// Validate config at module load
if (config.debate.turnsPerAnalyst < 1) {
    throw new Error(`Invalid DEBATE_TURNS_PER_ANALYST: ${config.debate.turnsPerAnalyst}. Must be >= 1`);
}

// Validate score weights are positive and sum to 100 (should be normalized by config/index.ts)
const weights = config.debate.scoreWeights;
if (weights.data < 0 || weights.logic < 0 || weights.risk < 0 || weights.catalyst < 0) {
    throw new Error(`Invalid score weights: all must be >= 0. Got data=${weights.data}, logic=${weights.logic}, risk=${weights.risk}, catalyst=${weights.catalyst}`);
}
const scoreWeightSum = weights.data + weights.logic + weights.risk + weights.catalyst;
if (scoreWeightSum !== 100) {
    throw new Error(`Score weights must sum to 100 after normalization. Got ${scoreWeightSum}. This indicates a bug in config normalization.`);
}

// =============================================================================
// DEBATE HELPER FUNCTIONS (Turn-by-Turn Generation)
// =============================================================================

/**
 * Attempt to repair truncated/malformed JSON
 * Handles common issues like unterminated strings, missing brackets
 */
function repairJSON(text: string): string {
    if (!text || typeof text !== 'string') return '{}';

    let repaired = text.trim();

    // Remove any markdown code blocks
    repaired = repaired.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');

    // Remove any trailing commas before closing brackets/braces
    repaired = repaired.replace(/,(\s*[}\]])/g, '$1');

    // Count brackets to check balance
    let openBraces = 0;
    let closeBraces = 0;
    let openBrackets = 0;
    let closeBrackets = 0;
    let inString = false;
    let escapeNext = false;

    for (let i = 0; i < repaired.length; i++) {
        const char = repaired[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\') {
            escapeNext = true;
            continue;
        }

        if (char === '"') {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '{') openBraces++;
            else if (char === '}') closeBraces++;
            else if (char === '[') openBrackets++;
            else if (char === ']') closeBrackets++;
        }
    }

    // If we ended inside a string, close it properly
    if (inString) {
        // Simply append a closing quote to terminate the string
        repaired += '"';
    }

    // Add missing closing brackets
    for (let i = 0; i < openBrackets - closeBrackets; i++) {
        repaired += ']';
    }

    // Add missing closing braces
    for (let i = 0; i < openBraces - closeBraces; i++) {
        repaired += '}';
    }

    return repaired;
}

/**
 * Parse JSON with repair attempt on failure
 */
function parseJSONWithRepair(text: string): any {
    try {
        return JSON.parse(text);
    } catch (firstError) {
        // Try to repair and parse again
        const repaired = repairJSON(text);
        try {
            return JSON.parse(repaired);
        } catch (_secondError) {
            // Log both attempts for debugging
            logger.warn('JSON repair failed. Original error:', firstError);
            logger.warn('Repaired text:', repaired.slice(0, 200));
            throw firstError; // Throw original error
        }
    }
}

/**
 * Generate a single debate turn with retry logic
 * Uses Gemini's JSON schema for reliable, structured responses
 * 
 * IMPORTANT: maxOutputTokens set to 4096 to ensure full 150-200 word arguments
 * are not truncated. The JSON structure adds overhead beyond just the argument text.
 * 
 * ENHANCED: Now passes ALL previous turns for summary generation
 */
async function generateDebateTurn(
    model: GenerativeModel,
    analystId: string,
    analystName: string,
    analystMethodology: string,
    previousTurns: DebateTurn[],
    context: string,
    turnNumber: number,
    totalTurns: number = 12,
    stage: 2 | 3 | 4 | 5
): Promise<DebateTurn> {
    // Validate inputs
    if (!model) {
        throw new Error('Model is required for debate turn generation');
    }
    if (!analystId || !analystName || !analystMethodology) {
        throw new Error('Analyst information is required');
    }
    if (!context || context.length === 0) {
        throw new Error('Context is required for debate turn');
    }
    if (totalTurns <= 0) {
        throw new Error(`Invalid totalTurns: ${totalTurns}. Must be > 0`);
    }
    if (turnNumber <= 0 || turnNumber > totalTurns) {
        throw new Error(`Invalid turnNumber: ${turnNumber}. Must be 1-${totalTurns}`);
    }

    // Include last 3 turns with FULL arguments for better context
    const previousArguments = previousTurns.slice(-3).map(t =>
        `${t.analystName}: ${t.argument || ''}`
    ).join('\n\n');

    // Build structured data from LAST 20 previous turns for summary (prevent unbounded growth)
    // FIXED: Added null checks, negation handling, and better extraction
    const allPreviousTurnsData = previousTurns
        .slice(-20) // Limit to last 20 turns to prevent memory issues
        .filter(t => t && t.argument) // Filter out null/undefined turns
        .map(t => {
            const arg = t.argument || '';

            // Extract direction from argument with negation handling
            let direction: 'LONG' | 'SHORT' | undefined;

            // Check for negations first
            const hasNegatedLong = /(?:NOT|don't|wouldn't|shouldn't|avoid)\s+(?:go\s+)?LONG/i.test(arg);
            const hasNegatedShort = /(?:NOT|don't|wouldn't|shouldn't|avoid)\s+(?:go\s+)?SHORT/i.test(arg);

            // Look for explicit recommendations
            const recommendMatch = arg.match(/I\s+recommend\s+(LONG|SHORT)/i) ||
                arg.match(/recommend(?:ing)?\s+(LONG|SHORT)/i) ||
                arg.match(/position[:\s]+(LONG|SHORT)/i);

            if (recommendMatch) {
                const extracted = recommendMatch[1].toUpperCase() as 'LONG' | 'SHORT';
                // Only use if not negated
                if ((extracted === 'LONG' && !hasNegatedLong) ||
                    (extracted === 'SHORT' && !hasNegatedShort)) {
                    direction = extracted;
                }
            }

            // Fallback: count occurrences minus negations
            if (!direction) {
                const longCount = (arg.match(/\bLONG\b/gi) || []).length - (hasNegatedLong ? 1 : 0);
                const shortCount = (arg.match(/\bSHORT\b/gi) || []).length - (hasNegatedShort ? 1 : 0);
                if (longCount > shortCount && longCount > 0) direction = 'LONG';
                else if (shortCount > longCount && shortCount > 0) direction = 'SHORT';
            }

            // Extract stop-loss from argument with multiple patterns
            let stopLoss: number | undefined;
            const slPatterns = [
                /stop[- ]?loss[:\s]+\$?([\d,.]+)/i,
                /\bSL[:\s]+\$?([\d,.]+)/i,
                /\bSL\s+at\s+\$?([\d,.]+)/i,
                /stop\s+at\s+\$?([\d,.]+)/i
            ];
            for (const pattern of slPatterns) {
                const slMatch = arg.match(pattern);
                if (slMatch) {
                    const parsed = parseFloat(slMatch[1].replace(/,/g, ''));
                    if (Number.isFinite(parsed) && parsed > 0) {
                        stopLoss = parsed;
                        break;
                    }
                }
            }

            // Get key point - prefer keyPoint from dataPointsReferenced, but extract from argument if missing
            let keyPoint = t.dataPointsReferenced?.[0];
            if (!keyPoint && arg.length > 50) {
                // Extract first sentence as key point if no data points
                const firstSentence = arg.match(/^[^.!?]+[.!?]/);
                if (firstSentence) {
                    keyPoint = firstSentence[0].slice(0, 100);
                }
            }

            return {
                analystName: t.analystName,
                argument: arg,
                direction,
                stopLoss,
                keyPoint
            };
        });

    const prompt = `${context}

${buildDebateTurnPrompt(analystName, analystMethodology, previousArguments, turnNumber, totalTurns, stage, allPreviousTurnsData)}`;

    // Log prompt length for debugging
    logger.info(`[Turn ${turnNumber}] Prompt length: ${prompt.length} chars (~${Math.ceil(prompt.length / 4)} tokens)`);

    let lastError: Error | null = null;
    let timeout: ReturnType<typeof createTimeoutPromise> | null = null;

    for (let attempt = 0; attempt <= MAX_DEBATE_TURN_RETRIES; attempt++) {
        try {
            timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
            const result = await Promise.race([
                model.generateContent({
                    contents: [{ role: 'user', parts: [{ text: prompt }] }],
                    generationConfig: {
                        responseMimeType: "application/json",
                        responseSchema: DEBATE_TURN_SCHEMA,
                        temperature: config.ai.temperature,
                        maxOutputTokens: config.ai.debateMaxTokens
                    }
                }),
                timeout.promise
            ]);

            const responseText = result.response.text().trim();

            // Check finish reason
            const candidates = result.response.candidates;
            if (candidates && candidates.length > 0) {
                const finishReason = candidates[0].finishReason || 'UNKNOWN';
                if (finishReason !== 'STOP') {
                    logger.warn(`⚠️ AI finish reason: ${finishReason} (expected STOP)`);
                }
            }

            // Parse JSON response
            const parsed = parseJSONWithRepair(responseText);

            // Validate and extract argument with strict checks
            if (!parsed.argument || typeof parsed.argument !== 'string' || parsed.argument.trim().length === 0) {
                throw new Error(`Invalid or missing argument in response. Got: ${typeof parsed.argument}`);
            }
            const argument = parsed.argument.trim();

            // Validate and extract strength
            const strength = typeof parsed.strength === 'number' && Number.isFinite(parsed.strength)
                ? Math.min(10, Math.max(1, parsed.strength))
                : 7;

            // Validate and extract dataPointsReferenced
            const dataPointsReferenced = Array.isArray(parsed.dataPointsReferenced)
                ? parsed.dataPointsReferenced.filter((dp: any) => dp && typeof dp === 'string' && dp.trim().length > 0)
                : [];

            // Validate argument length
            if (argument.length < config.debate.minArgumentLength) {
                throw new Error(`Generated argument too short: ${argument.length} chars (expected ${config.debate.minArgumentLength}+)`);
            }

            return {
                speaker: analystId,
                analystName,
                argument,
                strength,
                dataPointsReferenced
            };
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
            logger.warn(`Debate turn attempt ${attempt + 1} failed for ${analystName}: ${lastError.message}`);
            if (attempt < MAX_DEBATE_TURN_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1))); // Longer backoff
            }
        } finally {
            // CRITICAL: Always cancel timeout to prevent memory leak
            if (timeout) {
                try {
                    timeout.cancel();
                } catch (cancelError) {
                    logger.warn('Failed to cancel timeout:', cancelError);
                } finally {
                    timeout = null;
                }
            }
        }
    }

    // All retries failed - generate a methodology-specific fallback
    logger.error(`All ${MAX_DEBATE_TURN_RETRIES + 1} attempts failed for ${analystName}:`, lastError);

    // Create meaningful fallback arguments that meet the 150-200 word requirement
    const fallbackArguments: Record<string, string> = {
        'macro': `From a macro perspective, current market conditions require careful analysis of cross-asset correlations and global liquidity flows. Interest rate expectations remain a key driver, with central bank policy decisions creating significant volatility across risk assets including crypto. The correlation between Bitcoin and traditional risk assets like the S&P 500 has been elevated, suggesting that macro factors are dominating price action. Global M2 money supply trends indicate potential headwinds for speculative assets in the near term. However, the relative strength of the US dollar index and Treasury yields will be critical factors to monitor. My recommendation is to maintain a cautious stance with reduced position sizing until clearer directional signals emerge from the macro environment. Risk management should be prioritized with tight stop-losses given the elevated uncertainty.`,
        'technical': `Technical analysis reveals a complex picture with multiple timeframes showing conflicting signals. On the daily chart, price action is consolidating near key support and resistance levels that have been tested multiple times. Volume patterns suggest accumulation may be occurring, but confirmation is needed before taking a directional position. The RSI indicator is hovering in neutral territory around 50, neither overbought nor oversold, which limits conviction for aggressive entries. MACD histogram shows diminishing momentum, suggesting the current trend may be losing steam. Key Fibonacci retracement levels align with horizontal support zones, creating potential confluence areas for entries. My technical framework suggests waiting for a clear breakout with volume confirmation before committing capital. Stop-loss placement should be below the recent swing low for longs or above swing high for shorts, with position sizing adjusted for current volatility.`,
        'quant': `Quantitative analysis of current market conditions reveals elevated volatility metrics across multiple timeframes. Statistical models indicate mean reversion potential based on z-score analysis showing price deviation from the 20-day moving average. Factor exposures suggest maintaining disciplined position sizing given the current risk environment. Sharpe ratio calculations for recent trades indicate suboptimal risk-adjusted returns, warranting a more conservative approach. Correlation matrices show increased co-movement among major crypto assets, reducing diversification benefits. My models incorporate funding rate data, open interest changes, and liquidation levels to identify potential inflection points. The current setup shows mixed signals with some indicators suggesting bullish momentum while others point to exhaustion. Position sizing algorithms recommend reducing exposure until clearer statistical edges emerge. Risk management protocols dictate strict adherence to predetermined stop-loss levels.`,
        'sentiment': `Social sentiment analysis reveals divergence between price action and community engagement metrics. Twitter mention volume and sentiment scores show mixed signals, with bullish narratives competing against cautionary voices. Reddit activity in crypto-focused communities indicates elevated interest but also increased skepticism about near-term price targets. Fear and Greed Index readings suggest the market is transitioning between emotional states, creating potential for sharp reversals. Influencer sentiment has shifted recently, with several prominent voices adjusting their outlooks. On-chain metrics related to holder behavior show some accumulation patterns among long-term holders, while short-term speculators appear to be reducing exposure. My sentiment methodology suggests that narrative momentum is a key driver, and current narratives lack the conviction needed for sustained directional moves. Caution is warranted until clearer sentiment trends emerge.`,
        'value': `Fundamental valuation analysis suggests patience is required in the current market environment. Network value metrics relative to transaction volume and active addresses indicate potential overvaluation in some assets while others show reasonable value. Long-term value creation potential exists for projects with strong fundamentals, but entry timing remains critical for optimizing risk-adjusted returns. Margin of safety calculations suggest waiting for better entry points rather than chasing current prices. Token economics and supply dynamics vary significantly across assets, requiring careful analysis of inflation schedules and unlock events. Revenue-generating protocols offer more tangible valuation frameworks, though most crypto assets lack traditional cash flow metrics. My value methodology emphasizes capital preservation and avoiding permanent loss of capital. Current market conditions warrant a defensive posture with selective exposure to highest-conviction opportunities only.`,
        'growth': `Growth trajectory analysis shows potential but execution risk remains elevated across the crypto ecosystem. Adoption metrics including active addresses, transaction counts, and developer activity show mixed trends depending on the specific asset and blockchain. Ecosystem development continues with new protocols and applications launching, though user retention and sustainable growth remain challenges. Innovation catalysts including Layer 2 scaling solutions and cross-chain interoperability could drive significant upside for well-positioned projects. Total addressable market expansion continues as institutional adoption gradually increases, though regulatory uncertainty creates headwinds. My growth methodology focuses on identifying assets with sustainable competitive advantages and network effects. Position sizing should reflect the inherent uncertainty in growth projections, with smaller positions allowing for averaging into winners over time. Risk management remains critical given the volatility inherent in growth-oriented investments.`,
        'risk': `Risk assessment indicates elevated uncertainty across multiple dimensions requiring conservative positioning. Position sizing should be reduced from normal levels given current market conditions and volatility metrics. Stop-loss discipline must be maintained without exception, as capital preservation is the primary objective during uncertain periods. Portfolio correlation effects need careful consideration, as concentrated positions in correlated assets amplify drawdown risk. Funding rate analysis shows potential costs for maintaining leveraged positions that could erode returns over time. Liquidation cascade risk remains present given elevated open interest and leverage in the system. My risk methodology prioritizes survival over returns, recognizing that avoiding large losses is more important than capturing every opportunity. Current conditions warrant maximum caution with minimal new position initiation until risk metrics improve. Existing positions should be reviewed for appropriate sizing and stop-loss placement.`,
        'contrarian': `Contrarian analysis suggests consensus positioning may be creating opportunities for those willing to take the other side. Crowded trades identified through funding rates, positioning data, and sentiment indicators often reverse sharply when the narrative shifts. The market appears to be overlooking several key risks that could materialize and catch the majority off-guard. Alternative scenarios deserve serious consideration, as the crowd is historically wrong at emotional extremes. Current positioning data shows elevated concentration in popular trades, creating potential for violent unwinds. My contrarian methodology seeks opportunities where the risk-reward is skewed by excessive consensus. However, being contrarian for its own sake is not a strategy - there must be a fundamental or technical catalyst to trigger the reversal. Current conditions show some contrarian setups developing, but patience is required to wait for optimal entry points with defined risk parameters.`
    };

    const fallbackArg = fallbackArguments[analystMethodology] ||
        `Analysis using ${analystMethodology} methodology suggests careful evaluation of current market conditions is warranted before taking significant positions. Multiple factors including price action, volume patterns, and broader market sentiment need to align before high-conviction trades can be identified. Risk management and position sizing remain critical factors in any trading decision, particularly during periods of elevated uncertainty. My methodology emphasizes waiting for clear setups with favorable risk-reward ratios rather than forcing trades in ambiguous conditions. Current market structure shows mixed signals that require patience and discipline to navigate successfully. Capital preservation should be prioritized until clearer opportunities emerge with defined entry, target, and stop-loss levels.`;

    return {
        speaker: analystId,
        analystName,
        argument: fallbackArg,
        strength: 4, // Lower strength for fallback
        dataPointsReferenced: ['market conditions', 'risk management', 'position sizing', 'volatility']
    };
}

/**
 * SCORING METHODOLOGY (Documented for Transparency)
 * ================================================
 * 
 * Each analyst is scored on 4 equally-weighted dimensions (25 points each, 100 total):
 * 
 * 1. DATA QUALITY (0-25 points)
 *    - Formula: min(25, uniqueDataPoints * 3)
 *    - Measures: Number of unique data points referenced across all turns
 *    - Examples: "BTC $94,500", "funding rate -0.02%", "24h volume $2.1B"
 *    - Rationale: More specific data = more rigorous analysis
 * 
 * 2. LOGIC/ARGUMENT STRENGTH (0-25 points)
 *    - Formula: min(25, round(avgSelfAssessedStrength * 2.5))
 *    - Measures: Average of self-assessed strength scores (1-10) across turns
 *    - Rationale: Self-assessment calibrated by prompt instructions
 * 
 * 3. RISK AWARENESS (0-25 points)
 *    - Formula: min(25, turnsWithRiskKeywords * 8)
 *    - Keywords: risk, concern, downside, challenge, worst-case, invalidation, stop-loss, drawdown
 *    - Rationale: Good analysts acknowledge risks, not just upside
 * 
 * 4. CATALYST IDENTIFICATION (0-25 points)
 *    - Formula: min(25, turnsWithCatalystKeywords * 8)
 *    - Keywords: catalyst, trigger, timeline, Q1-Q4, earnings, announcement, near-term, upcoming, event
 *    - Rationale: Actionable trades need timing catalysts
 * 
 * TIE-BREAKER ORDER (when total scores are equal):
 *    1. Most unique data points referenced
 *    2. Highest average argument strength
 *    3. First in analyst order (deterministic fallback)
 */

/**
 * Calculate debate scores from turns
 * Handles edge cases: empty turns, missing data, invalid values
 * 
 * IMPORTANT: This function logs detailed scoring breakdown for transparency
 * 
 * CRITICAL FIXES:
 * - Validates turns array is not null/undefined before filtering
 * - Validates analystIds array elements are valid strings
 * - Handles empty/null dataPointsReferenced arrays safely
 */
function calculateDebateScores(
    turns: DebateTurn[],
    analystIds: string[],
    logDetails: boolean = true
): Record<string, AnalystScore> {
    const scores: Record<string, AnalystScore> = {};
    const scoringDetails: Array<{
        analystId: string;
        turnCount: number;
        uniqueDataPoints: number;
        dataPointsList: string[];
        avgStrength: number;
        strengthValues: number[];
        riskTurns: number;
        catalystTurns: number;
        breakdown: { data: number; logic: number; risk: number; catalyst: number; total: number };
    }> = [];

    // Validate analystIds array
    if (!analystIds || !Array.isArray(analystIds) || analystIds.length === 0) {
        logger.warn('calculateDebateScores called with invalid or empty analystIds');
        return scores;
    }

    // Validate turns array
    if (!turns || !Array.isArray(turns) || turns.length === 0) {
        logger.warn('calculateDebateScores called with invalid or empty turns');
        for (const analystId of analystIds) {
            if (analystId && typeof analystId === 'string') {
                scores[analystId] = { data: 0, logic: 0, risk: 0, catalyst: 0, total: 0 };
            }
        }
        return scores;
    }

    for (const analystId of analystIds) {
        // Validate analystId is a non-empty string
        if (!analystId || typeof analystId !== 'string' || analystId.trim().length === 0) {
            logger.warn(`Skipping invalid analystId: ${analystId}`);
            continue;
        }

        // Filter turns with null safety
        const analystTurns = turns.filter(t => t && typeof t === 'object' && t.speaker === analystId);

        if (analystTurns.length === 0) {
            scores[analystId] = { data: 0, logic: 0, risk: 0, catalyst: 0, total: 0 };
            scoringDetails.push({
                analystId,
                turnCount: 0,
                uniqueDataPoints: 0,
                dataPointsList: [],
                avgStrength: 0,
                strengthValues: [],
                riskTurns: 0,
                catalystTurns: 0,
                breakdown: { data: 0, logic: 0, risk: 0, catalyst: 0, total: 0 }
            });
            continue;
        }

        // Get weights from config
        const weights = config.debate.scoreWeights;

        // Data Quality: unique data points referenced
        const dataPoints = new Set<string>();
        for (const t of analystTurns) {
            // Validate dataPointsReferenced exists and is an array
            if (t.dataPointsReferenced && Array.isArray(t.dataPointsReferenced)) {
                for (const dp of t.dataPointsReferenced) {
                    // Filter out empty strings, null, undefined, and non-string values
                    if (dp && typeof dp === 'string' && dp.trim().length > 0) {
                        dataPoints.add(dp.trim());
                    }
                }
            }
        }
        const dataPointsList = Array.from(dataPoints);
        const numericTokenPattern = /(?:\$?\d+(?:\.\d+)?%?)/g;
        let numericTokenCount = 0;
        for (const t of analystTurns) {
            if (t.argument && typeof t.argument === 'string') {
                const matches = t.argument.match(numericTokenPattern);
                if (matches) numericTokenCount += matches.length;
            }
        }
        const uniqueDataScore = Math.min(weights.data, Math.round(dataPoints.size * (weights.data / 8)));
        const numericDensityScore = Math.min(weights.data, Math.round(Math.min(numericTokenCount, 12) * (weights.data / 12)));
        const dataScore = Math.min(weights.data, Math.round((uniqueDataScore * 0.6) + (numericDensityScore * 0.4)));

        // Logic: average argument strength (with safe division)
        const validStrengths = analystTurns
            .map(t => Number(t.strength))
            .filter(s => Number.isFinite(s) && s >= 1 && s <= 10);
        const avgStrength = validStrengths.length > 0
            ? validStrengths.reduce((sum, s) => sum + s, 0) / validStrengths.length
            : 5;
        const baseLogicScore = Math.min(weights.logic, Math.round(avgStrength * (weights.logic / 10)));
        let avgArgLen = 0;
        for (const t of analystTurns) {
            if (t.argument && typeof t.argument === 'string') {
                avgArgLen += t.argument.length;
            }
        }
        avgArgLen = analystTurns.length > 0 ? avgArgLen / analystTurns.length : 0;
        const minLen = config.debate.minArgumentLength;
        const lengthFactor = avgArgLen >= minLen ? 1 : 0.8;
        const names = new Set((turns || []).map(tr => tr.analystName).filter(n => typeof n === 'string'));
        let engagementCount = 0;
        for (const t of analystTurns) {
            if (t.argument && typeof t.argument === 'string') {
                for (const n of names) {
                    if (n && t.analystName !== n && t.argument.includes(n)) {
                        engagementCount++;
                        break;
                    }
                }
            }
        }
        const engagementFactor = engagementCount >= Math.max(1, Math.floor(analystTurns.length / 2)) ? 1.05 : 1;
        const logicScore = Math.min(weights.logic, Math.round(baseLogicScore * lengthFactor * engagementFactor));

        // Risk Awareness: risk-related keywords with numeric specificity
        const riskPattern = /risk|concern|downside|challenge|worst.?case|invalidation|stop.?loss|drawdown/i;
        const hasNumberPattern = /(?:\$?\d+(?:\.\d+)?%?)/;
        let strongRiskTurns = 0;
        let weakRiskTurns = 0;
        for (const t of analystTurns) {
            const arg = t && t.argument && typeof t.argument === 'string' ? t.argument.trim() : '';
            if (arg && riskPattern.test(arg)) {
                if (hasNumberPattern.test(arg)) strongRiskTurns++;
                else weakRiskTurns++;
            }
        }
        const riskScore = Math.min(
            weights.risk,
            Math.round(Math.min(strongRiskTurns, 2) * (weights.risk / 2) + Math.min(weakRiskTurns, 2) * (weights.risk / 6))
        );

        // Catalyst: event + timeline specificity
        const catalystPattern = /catalyst|trigger|timeline|earnings|announcement|upgrade|listing|ETF|mainnet|testnet|event/i;
        const timelinePattern = /\bQ[1-4]\b|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|today|tomorrow|week|month|by\s+\w+|on\s+\w+/i;
        let strongCatalystTurns = 0;
        let weakCatalystTurns = 0;
        for (const t of analystTurns) {
            const arg = t && t.argument && typeof t.argument === 'string' ? t.argument.trim() : '';
            if (arg && catalystPattern.test(arg)) {
                if (timelinePattern.test(arg)) strongCatalystTurns++;
                else weakCatalystTurns++;
            }
        }
        const catalystScore = Math.min(
            weights.catalyst,
            Math.round(Math.min(strongCatalystTurns, 2) * (weights.catalyst / 2) + Math.min(weakCatalystTurns, 2) * (weights.catalyst / 6))
        );

        const total = dataScore + logicScore + riskScore + catalystScore;

        scores[analystId] = { data: dataScore, logic: logicScore, risk: riskScore, catalyst: catalystScore, total };

        scoringDetails.push({
            analystId,
            turnCount: analystTurns.length,
            uniqueDataPoints: dataPoints.size,
            dataPointsList: dataPointsList.slice(0, 5), // First 5 for logging
            avgStrength: Math.round(avgStrength * 100) / 100,
            strengthValues: validStrengths,
            riskTurns: strongRiskTurns + weakRiskTurns,
            catalystTurns: strongCatalystTurns + weakCatalystTurns,
            breakdown: { data: dataScore, logic: logicScore, risk: riskScore, catalyst: catalystScore, total }
        });
    }

    // Log detailed scoring breakdown for transparency
    if (logDetails && scoringDetails.length > 0) {
        const weights = config.debate.scoreWeights;
        logger.info(`\n${'═'.repeat(80)}`);
        logger.info(`📊 SCORING BREAKDOWN (Weights: Data ${weights.data} + Logic ${weights.logic} + Risk ${weights.risk} + Catalyst ${weights.catalyst} = ${weights.data + weights.logic + weights.risk + weights.catalyst})`);
        logger.info(`${'═'.repeat(80)}`);

        // Sort by total score for display
        scoringDetails.sort((a, b) => b.breakdown.total - a.breakdown.total);

        for (const detail of scoringDetails) {
            const maxScore = weights.data + weights.logic + weights.risk + weights.catalyst;
            logger.info(`\n${detail.analystId.toUpperCase()} - Total: ${detail.breakdown.total}/${maxScore}`);
            logger.info(`  ├─ Data Quality:    ${detail.breakdown.data}/${weights.data} (${detail.uniqueDataPoints} data points, 8+ = max)`);
            if (detail.dataPointsList.length > 0) {
                logger.info(`  │    └─ Examples: ${detail.dataPointsList.slice(0, 3).join(', ')}${detail.dataPointsList.length > 3 ? '...' : ''}`);
            }
            logger.info(`  ├─ Logic/Strength:  ${detail.breakdown.logic}/${weights.logic} (avg strength ${detail.avgStrength}/10)`);
            logger.info(`  │    └─ Turn strengths: [${detail.strengthValues.join(', ')}]`);
            logger.info(`  ├─ Risk Awareness:  ${detail.breakdown.risk}/${weights.risk} (${detail.riskTurns} turns with risk keywords, 3+ = max)`);
            logger.info(`  └─ Catalyst ID:     ${detail.breakdown.catalyst}/${weights.catalyst} (${detail.catalystTurns} turns with catalyst keywords, 3+ = max)`);
        }
        logger.info(`${'═'.repeat(80)}\n`);
    }

    return scores;
}

/**
 * Determine debate winner from scores with tie-breaker logic
 * Handles edge cases: empty scores, ties, missing data
 * 
 * TIE-BREAKER ORDER:
 * 1. Highest total score
 * 2. Most unique data points referenced
 * 3. Highest average argument strength
 * 4. First in analyst order (deterministic fallback)
 * 
 * IMPORTANT: Logs tie-breaker decisions for transparency
 * 
 * CRITICAL FIXES:
 * - Validates scores object is not null/undefined
 * - Validates turns array before accessing
 * - Returns empty string if no valid winner can be determined (caller must handle)
 */
function determineDebateWinner(
    scores: Record<string, AnalystScore>,
    turns: DebateTurn[],
    previousWinnerIds: string[] = []
): string {
    // Validate scores object
    if (!scores || typeof scores !== 'object') {
        logger.error('Invalid scores object provided to determineDebateWinner');
        if (turns && Array.isArray(turns) && turns.length > 0 && turns[0] && turns[0].speaker) {
            logger.warn('Using first speaker as fallback winner');
            return turns[0].speaker;
        }
        return '';
    }

    const entries = Object.entries(scores);

    if (entries.length === 0) {
        logger.error('No scores calculated');
        if (turns && Array.isArray(turns) && turns.length > 0 && turns[0] && turns[0].speaker) {
            logger.warn('Using first speaker as fallback winner');
            return turns[0].speaker;
        }
        logger.error('No scores and no valid turns - cannot determine winner');
        return '';
    }

    // Sort by total score descending
    entries.sort((a, b) => b[1].total - a[1].total);

    const topScore = entries[0][1].total;
    const winners = entries.filter(e => e[1].total === topScore);

    if (winners.length === 1) {
        logger.info(`🏆 Winner determined by score: ${winners[0][0]} (${topScore}/100) - no tie-breaker needed`);
        return winners[0][0];
    }

    // TIE DETECTED - Log and apply tie-breakers
    logger.info(`\n${'─'.repeat(60)}`);
    logger.info(`⚖️ TIE DETECTED: ${winners.length} analysts with score ${topScore}/100`);
    logger.info(`   Tied analysts: ${winners.map(w => w[0]).join(', ')}`);

    // Prefer analysts not in previous winners first
    if (Array.isArray(previousWinnerIds) && previousWinnerIds.length > 0) {
        const nonPrev = winners.filter(([id]) => !previousWinnerIds.includes(id));
        if (nonPrev.length === 1) {
            logger.info(`🏆 Winner by anti-dominance preference: ${nonPrev[0][0]}`);
            logger.info(`${'─'.repeat(60)}\n`);
            return nonPrev[0][0];
        } else if (nonPrev.length > 1) {
            logger.info(`   Anti-dominance filtered candidates: ${nonPrev.map(w => w[0]).join(', ')}`);
        }
    }

    // Tie-breaker 1: most unique data points
    const dataPointCounts = winners.map(([id]) => {
        // Validate turns array before filtering
        const analystTurns = turns && Array.isArray(turns)
            ? turns.filter(t => t && typeof t === 'object' && t.speaker === id)
            : [];
        const dataPoints = new Set<string>();
        for (const t of analystTurns) {
            // Validate dataPointsReferenced exists and is an array
            if (t.dataPointsReferenced && Array.isArray(t.dataPointsReferenced)) {
                for (const dp of t.dataPointsReferenced) {
                    // Filter out empty strings and non-string values
                    if (dp && typeof dp === 'string' && dp.trim().length > 0) {
                        dataPoints.add(dp.trim());
                    }
                }
            }
        }
        return { id, count: dataPoints.size };
    });
    dataPointCounts.sort((a, b) => b.count - a.count);

    logger.info(`   Tie-breaker #1 (data points): ${dataPointCounts.map(d => `${d.id}=${d.count}`).join(', ')}`);

    const topDataPoints = dataPointCounts[0].count;
    const dataPointWinners = dataPointCounts.filter(d => d.count === topDataPoints);

    if (dataPointWinners.length === 1) {
        logger.info(`🏆 Winner by tie-breaker #1 (most data points): ${dataPointWinners[0].id} (${topDataPoints} data points)`);
        logger.info(`${'─'.repeat(60)}\n`);
        return dataPointWinners[0].id;
    }

    // Tie-breaker 2: highest average argument strength
    const strengthScores = dataPointWinners.map(({ id }) => {
        // Validate turns array before filtering
        const analystTurns = turns && Array.isArray(turns)
            ? turns.filter(t => t && typeof t === 'object' && t.speaker === id)
            : [];
        if (analystTurns.length === 0) return { id, avgStrength: 0 };
        const validStrengths = analystTurns
            .map(t => t && t.strength !== undefined ? Number(t.strength) : NaN)
            .filter(s => Number.isFinite(s) && s >= 1 && s <= 10);
        const avgStrength = validStrengths.length > 0
            ? validStrengths.reduce((sum, s) => sum + s, 0) / validStrengths.length
            : 0;
        return { id, avgStrength: Math.round(avgStrength * 100) / 100 };
    });
    strengthScores.sort((a, b) => b.avgStrength - a.avgStrength);

    logger.info(`   Tie-breaker #2 (avg strength): ${strengthScores.map(s => `${s.id}=${s.avgStrength}`).join(', ')}`);

    const topStrength = strengthScores[0].avgStrength;
    const strengthWinners = strengthScores.filter(s => s.avgStrength === topStrength);

    if (strengthWinners.length === 1) {
        logger.info(`🏆 Winner by tie-breaker #2 (highest avg strength): ${strengthWinners[0].id} (${topStrength}/10)`);
        logger.info(`${'─'.repeat(60)}\n`);
        return strengthWinners[0].id;
    }

    // Tie-breaker 3: highest numeric token count across arguments
    const numericTokenPattern = /(?:\$?\d+(?:\.\d+)?%?)/g;
    const numericCounts = strengthWinners.map(({ id }) => {
        const analystTurns = turns && Array.isArray(turns)
            ? turns.filter(t => t && typeof t === 'object' && t.speaker === id)
            : [];
        let count = 0;
        for (const t of analystTurns) {
            if (t.argument && typeof t.argument === 'string') {
                const matches = t.argument.match(numericTokenPattern);
                if (matches) count += matches.length;
            }
        }
        return { id, count };
    });
    numericCounts.sort((a, b) => b.count - a.count);
    logger.info(`   Tie-breaker #3 (numeric density): ${numericCounts.map(n => `${n.id}=${n.count}`).join(', ')}`);
    if (numericCounts.length > 0 && numericCounts[0].count > 0) {
        const topNum = numericCounts[0].count;
        const numericWinners = numericCounts.filter(n => n.count === topNum);
        if (numericWinners.length === 1) {
            logger.info(`🏆 Winner by tie-breaker #3 (numeric density): ${numericWinners[0].id}`);
            logger.info(`${'─'.repeat(60)}\n`);
            return numericWinners[0].id;
        }
    }

    // Tie-breaker 4: highest average argument length
    const avgLengths = strengthWinners.map(({ id }) => {
        const analystTurns = turns && Array.isArray(turns)
            ? turns.filter(t => t && typeof t === 'object' && t.speaker === id)
            : [];
        let totalLen = 0;
        for (const t of analystTurns) {
            if (t.argument && typeof t.argument === 'string') {
                totalLen += t.argument.length;
            }
        }
        const avgLen = analystTurns.length > 0 ? Math.round((totalLen / analystTurns.length) * 100) / 100 : 0;
        return { id, avgLen };
    });
    avgLengths.sort((a, b) => b.avgLen - a.avgLen);
    logger.info(`   Tie-breaker #4 (avg length): ${avgLengths.map(a => `${a.id}=${a.avgLen}`).join(', ')}`);
    if (avgLengths.length > 0 && avgLengths[0].avgLen > 0) {
        const topLen = avgLengths[0].avgLen;
        const lengthWinners = avgLengths.filter(a => a.avgLen === topLen);
        if (lengthWinners.length === 1) {
            logger.info(`🏆 Winner by tie-breaker #4 (avg length): ${lengthWinners[0].id}`);
            logger.info(`${'─'.repeat(60)}\n`);
            return lengthWinners[0].id;
        }
    }

    // Final fallback: strongest last turn
    const lastTurnStrengths = strengthWinners.map(({ id }) => {
        const analystTurns = turns && Array.isArray(turns)
            ? turns.filter(t => t && typeof t === 'object' && t.speaker === id)
            : [];
        const last = analystTurns[analystTurns.length - 1];
        const s = last && Number.isFinite(last.strength) ? Number(last.strength) : 0;
        return { id, s };
    });
    lastTurnStrengths.sort((a, b) => b.s - a.s);
    logger.info(`   Final fallback (closing strength): ${lastTurnStrengths.map(l => `${l.id}=${l.s}`).join(', ')}`);
    logger.info(`🏆 Winner by final fallback: ${lastTurnStrengths[0].id}`);
    logger.info(`${'─'.repeat(60)}\n`);
    return lastTurnStrengths[0].id;
}

/**
 * Extract winning arguments from debate turns
 * Returns top 3 arguments by strength, with safe truncation
 * 
 * Better handling of empty/missing arguments:
 * - Returns fallback arguments if winner has no strong arguments
 * - Validates argument content before including
 */
function extractWinningArguments(winnerId: string, turns: DebateTurn[]): string[] {
    if (!winnerId || typeof winnerId !== 'string') {
        logger.warn('extractWinningArguments called with invalid winnerId');
        return ['No winning arguments available'];
    }
    if (!turns || !Array.isArray(turns) || turns.length === 0) {
        logger.warn('extractWinningArguments called with empty turns');
        return ['No debate turns available'];
    }

    const winnerTurns = turns.filter(t => t && t.speaker === winnerId);
    if (winnerTurns.length === 0) {
        logger.warn(`No turns found for winner ${winnerId}`);
        // Fallback: return strongest arguments from any speaker
        const sortedTurns = [...turns]
            .filter(t => t && t.argument && t.argument.trim().length > 50)
            .sort((a, b) => {
                const strengthA = Number.isFinite(a.strength) ? a.strength : 0;
                const strengthB = Number.isFinite(b.strength) ? b.strength : 0;
                return strengthB - strengthA;
            });
        if (sortedTurns.length > 0) {
            return [sortedTurns[0].argument.slice(0, 250)];
        }
        return ['Winner arguments not available'];
    }

    const validTurns = winnerTurns.filter(t =>
        t.argument &&
        typeof t.argument === 'string' &&
        t.argument.trim().length > 50
    );

    if (validTurns.length === 0) {
        logger.warn(`Winner ${winnerId} has no valid arguments (all too short or empty)`);
        return ['Winner provided no substantive arguments'];
    }

    return validTurns
        .sort((a, b) => {
            const strengthA = Number.isFinite(a.strength) ? a.strength : 0;
            const strengthB = Number.isFinite(b.strength) ? b.strength : 0;
            return strengthB - strengthA;
        })
        .slice(0, 3)
        .map(t => {
            const arg = (t.argument || '').trim();
            if (!arg) return '';
            if (arg.length > 250) {
                // Try to truncate at sentence boundary
                const sentenceEnd = arg.slice(0, 250).lastIndexOf('.');
                if (sentenceEnd > 150) {
                    return arg.slice(0, sentenceEnd + 1);
                }
                // Fall back to word boundary
                const wordEnd = arg.slice(0, 247).lastIndexOf(' ');
                if (wordEnd > 150) {
                    return arg.slice(0, wordEnd) + '...';
                }
                return arg.slice(0, 247) + '...';
            }
            return arg;
        })
        .filter(Boolean);
}

/**
 * Helper to create a cancellable timeout promise
 * IMPORTANT: Always call cancel() after Promise.race resolves to prevent memory leaks
 * 
 * CRITICAL FIXES:
 * - Validates ms is a positive finite number
 * - Ensures timeout is always cleared to prevent memory leaks
 * - Thread-safe cancellation with isResolved flag
 * - Uses config for max timeout cap
 */
function createTimeoutPromise(ms: number): { promise: Promise<never>; cancel: () => void } {
    // Validate timeout value
    if (!Number.isFinite(ms) || ms <= 0) {
        logger.warn(`Invalid timeout value: ${ms}, using default ${AI_REQUEST_TIMEOUT}ms`);
        ms = AI_REQUEST_TIMEOUT;
    }

    // Cap maximum timeout to prevent indefinite hangs (from config)
    const MAX_TIMEOUT = config.ai.maxTimeoutMs; // 5 minutes default
    if (ms > MAX_TIMEOUT) {
        logger.warn(`Timeout ${ms}ms exceeds maximum ${MAX_TIMEOUT}ms, capping`);
        ms = MAX_TIMEOUT;
    }

    let timeoutId: NodeJS.Timeout | null = null;
    let isResolved = false;

    const promise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                reject(new Error(`AI request timeout after ${ms}ms`));
            }
        }, ms);
    });

    return {
        promise,
        cancel: () => {
            isResolved = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        }
    };
}


// =============================================================================
// AI JUDGE - DEBATE ADJUDICATOR
// =============================================================================

/** Judge request timeout in milliseconds */
const JUDGE_TIMEOUT_MS = 60000; // 60 seconds

/**
 * Validate a single analyst score object has all required fields
 * Returns a sanitized score object with defaults for missing/invalid fields
 */
function validateAnalystScore(score: unknown): { total: number; dataQuality: number; logicCoherence: number; riskAwareness: number; catalystClarity: number } {
    const defaultScore = { total: 0, dataQuality: 0, logicCoherence: 0, riskAwareness: 0, catalystClarity: 0 };

    if (!score || typeof score !== 'object') {
        return defaultScore;
    }

    const s = score as Record<string, unknown>;
    return {
        total: Number.isFinite(s.total) ? Math.min(100, Math.max(0, Number(s.total))) : 0,
        dataQuality: Number.isFinite(s.dataQuality) ? Math.min(100, Math.max(0, Number(s.dataQuality))) : 0,
        logicCoherence: Number.isFinite(s.logicCoherence) ? Math.min(100, Math.max(0, Number(s.logicCoherence))) : 0,
        riskAwareness: Number.isFinite(s.riskAwareness) ? Math.min(100, Math.max(0, Number(s.riskAwareness))) : 0,
        catalystClarity: Number.isFinite(s.catalystClarity) ? Math.min(100, Math.max(0, Number(s.catalystClarity))) : 0
    };
}

/**
 * Call the AI Judge to evaluate a debate and determine the winner
 * 
 * This replaces the weak `determineDebateWinner()` function that relied on
 * superficial metrics like data point counts and argument lengths.
 * 
 * The Judge:
 * 1. Reads the FULL debate transcript
 * 2. Evaluates each argument's actual quality (not just length/count)
 * 3. Applies a rigorous scoring rubric
 * 4. Provides detailed reasoning for the verdict
 * 
 * @param model - Gemini model for AI call
 * @param input - Full debate context and transcript
 * @param isLightweight - Use lightweight prompt for coin selection (saves tokens)
 * @returns JudgeVerdict with winner, scores, and reasoning
 */
async function callJudge(
    model: GenerativeModel,
    input: JudgeInput,
    isLightweight: boolean = false
): Promise<JudgeVerdict> {
    const prompt = isLightweight
        ? buildCoinSelectionJudgePrompt(input)
        : buildJudgePrompt(input);

    logger.info(`⚖️ Calling AI Judge to evaluate ${input.debateType} debate...`);

    // Create timeout for judge call
    const timeout = createTimeoutPromise(JUDGE_TIMEOUT_MS);

    try {
        const resultPromise = model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                maxOutputTokens: 2048 // Judge responses are concise
            }
        });

        // Race between result and timeout
        const result = await Promise.race([resultPromise, timeout.promise]);
        timeout.cancel(); // CRITICAL: Always cancel timeout to prevent memory leak

        const text = result.response.text();

        // CRITICAL: Validate JSON parsing
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch (parseError) {
            throw new Error(`Judge returned invalid JSON: ${text.slice(0, 200)}...`);
        }

        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Judge response is not an object');
        }

        const response = parsed as Record<string, unknown>;

        // Validate required fields
        if (!response.winner || typeof response.winner !== 'string') {
            throw new Error('Judge response missing winner field');
        }
        if (!response.scores || typeof response.scores !== 'object') {
            throw new Error('Judge response missing scores field');
        }

        // Validate winner is one of the analysts
        const validAnalystIds = input.analysts.map(a => a.id);
        let winner = response.winner as string;

        if (!validAnalystIds.includes(winner)) {
            logger.warn(`Judge returned invalid winner "${winner}", expected one of: ${validAnalystIds.join(', ')}`);
            // Try to find closest match
            const closestMatch = validAnalystIds.find(id =>
                winner.toLowerCase().includes(id.toLowerCase()) ||
                id.toLowerCase().includes(winner.toLowerCase())
            );
            if (closestMatch) {
                logger.info(`Using closest match: ${closestMatch}`);
                winner = closestMatch;
            } else {
                throw new Error(`Invalid winner: ${winner}`);
            }
        }

        // Validate and sanitize scores for each analyst
        const rawScores = response.scores as Record<string, unknown>;
        const validatedScores: Record<string, { total: number; dataQuality: number; logicCoherence: number; riskAwareness: number; catalystClarity: number }> = {};

        for (const analystId of validAnalystIds) {
            validatedScores[analystId] = validateAnalystScore(rawScores[analystId]);
        }

        const verdict: JudgeVerdict = {
            winner,
            winnerName: (typeof response.winnerName === 'string' ? response.winnerName : null)
                || input.analysts.find(a => a.id === winner)?.name
                || winner,
            confidence: Math.min(100, Math.max(0, Number(response.confidence) || 70)),
            scores: validatedScores,
            reasoning: typeof response.reasoning === 'string' ? response.reasoning : 'No reasoning provided',
            keyFactors: Array.isArray(response.keyFactors)
                ? response.keyFactors.filter((f): f is string => typeof f === 'string').slice(0, 5)
                : [],
            flags: response.flags && typeof response.flags === 'object' ? response.flags as JudgeVerdict['flags'] : {}
        };

        // Log the verdict
        logger.info(`\n${'═'.repeat(60)}`);
        logger.info(`⚖️ JUDGE VERDICT`);
        logger.info(`${'═'.repeat(60)}`);
        logger.info(`Winner: ${verdict.winnerName} (${verdict.winner})`);
        logger.info(`Confidence: ${verdict.confidence}%`);
        logger.info(`Reasoning: ${verdict.reasoning}`);
        if (verdict.keyFactors.length > 0) {
            logger.info(`Key Factors:`);
            verdict.keyFactors.forEach((f, i) => logger.info(`  ${i + 1}. ${f}`));
        }
        if (verdict.flags?.closeTie) {
            logger.info(`⚠️ FLAG: Close tie detected`);
        }
        if (verdict.flags?.dominancePattern) {
            logger.info(`⚠️ FLAG: Dominance pattern detected`);
        }
        if (verdict.flags?.lowQualityDebate) {
            logger.info(`⚠️ FLAG: Low quality debate detected`);
        }
        logger.info(`${'═'.repeat(60)}\n`);

        // Log detailed scores
        logger.info(`Detailed Scores:`);
        for (const [analystId, score] of Object.entries(verdict.scores)) {
            logger.info(`  ${analystId}: Total=${score.total}/100 (Data=${score.dataQuality}, Logic=${score.logicCoherence}, Risk=${score.riskAwareness}, Catalyst=${score.catalystClarity})`);
        }

        return verdict;
    } catch (error: any) {
        timeout.cancel(); // CRITICAL: Cancel timeout on error too
        logger.error(`Judge evaluation failed: ${error.message}`);
        throw error;
    }
}

/**
 * Determine debate winner using AI Judge
 * Falls back to heuristic method if judge fails
 * 
 * @param model - Gemini model
 * @param turns - Debate turns
 * @param analysts - Participating analysts
 * @param marketData - Market data at time of debate
 * @param debateType - Type of debate
 * @param direction - Trade direction
 * @param previousWinners - Previous stage winners (for dominance detection)
 * @param portfolio - Current portfolio state (optional)
 * @returns Winner analyst ID and full verdict
 */
async function determineWinnerWithJudge(
    model: GenerativeModel,
    turns: DebateTurn[],
    analysts: Array<{ id: string; name: string; methodology: string }>,
    marketData: ExtendedMarketData,
    debateType: 'coin_selection' | 'championship',
    direction: 'LONG' | 'SHORT' | 'MANAGE',
    previousWinners: string[] = [],
    portfolio?: { balance: number; openPositions: number; unrealizedPnl: number; recentPnL: { day: number; week: number } }
): Promise<{ winner: string; verdict: JudgeVerdict | null; usedFallback: boolean }> {

    // Validate inputs
    if (!turns || turns.length === 0) {
        throw new Error('determineWinnerWithJudge: turns array is empty');
    }
    if (!analysts || analysts.length === 0) {
        throw new Error('determineWinnerWithJudge: analysts array is empty');
    }
    if (!marketData) {
        throw new Error('determineWinnerWithJudge: marketData is required');
    }

    // Build judge input
    const judgeInput: JudgeInput = {
        debateType,
        symbol: marketData.symbol || 'Unknown',
        direction,
        marketData: {
            currentPrice: Number.isFinite(marketData.currentPrice) ? marketData.currentPrice : 0,
            change24h: Number.isFinite(marketData.change24h) ? marketData.change24h : 0,
            high24h: Number.isFinite(marketData.high24h) ? marketData.high24h : 0,
            low24h: Number.isFinite(marketData.low24h) ? marketData.low24h : 0,
            volume24h: Number.isFinite(marketData.volume24h) ? marketData.volume24h : 0,
            fundingRate: marketData.fundingRate
        },
        turns: turns.map(t => ({
            speaker: t.speaker || 'unknown',
            analystName: t.analystName || t.speaker || 'Unknown',
            argument: t.argument || '',
            strength: Number.isFinite(t.strength) ? t.strength : 5,
            dataPointsReferenced: Array.isArray(t.dataPointsReferenced) ? t.dataPointsReferenced : []
        })),
        analysts,
        portfolio,
        previousWinners
    };

    try {
        const isLightweight = debateType === 'coin_selection';
        const verdict = await callJudge(model, judgeInput, isLightweight);
        return { winner: verdict.winner, verdict, usedFallback: false };
    } catch (error: any) {
        logger.warn(`Judge failed, falling back to heuristic method: ${error.message}`);

        // Fall back to the original heuristic method
        const analystIds = analysts.map(a => a.id);
        const scores = calculateDebateScores(turns, analystIds);
        const winner = determineDebateWinner(scores, turns, previousWinners);

        if (!winner) {
            throw new Error('Both judge and fallback failed to determine winner');
        }

        return { winner, verdict: null, usedFallback: true };
    }
}

/**
 * Convert JudgeVerdict scores to AnalystScore format
 * Safely handles missing/invalid score fields
 */
function convertJudgeScoresToAnalystScores(
    verdictScores: JudgeVerdict['scores'],
    analystIds: string[]
): Record<string, AnalystScore> {
    const result: Record<string, AnalystScore> = {};

    for (const id of analystIds) {
        const judgeScore = verdictScores[id];
        if (judgeScore) {
            result[id] = {
                data: Number.isFinite(judgeScore.dataQuality) ? judgeScore.dataQuality : 0,
                logic: Number.isFinite(judgeScore.logicCoherence) ? judgeScore.logicCoherence : 0,
                risk: Number.isFinite(judgeScore.riskAwareness) ? judgeScore.riskAwareness : 0,
                catalyst: Number.isFinite(judgeScore.catalystClarity) ? judgeScore.catalystClarity : 0,
                total: Number.isFinite(judgeScore.total) ? judgeScore.total : 0
            };
        } else {
            // Default score if analyst not in verdict
            result[id] = { data: 0, logic: 0, risk: 0, catalyst: 0, total: 0 };
        }
    }

    return result;
}


// =============================================================================
// COLLABORATIVE FLOW SERVICE
// =============================================================================

export class CollaborativeFlowService {
    private jsonModel: GenerativeModel | null = null;  // For all structured JSON outputs

    /**
     * Get model configured for JSON structured output
     * Used for: ALL AI calls (debates, specialist analysis, risk council)
     */
    private getJsonModel(): GenerativeModel {
        if (!this.jsonModel) {
            if (!config.geminiApiKey) {
                throw new Error('GEMINI_API_KEY not configured');
            }
            const genAI = new GoogleGenerativeAI(config.geminiApiKey);
            this.jsonModel = genAI.getGenerativeModel({
                model: config.ai.model,
                generationConfig: {
                    responseMimeType: "application/json",
                    maxOutputTokens: config.ai.maxOutputTokens
                }
            });
        }
        return this.jsonModel;
    }

    // =========================================================================
    // HELPER METHODS
    // =========================================================================

    private buildMarketSummary(marketDataMap: Map<string, ExtendedMarketData>): string {
        const lines: string[] = ['CURRENT MARKET DATA FOR 8 TRADEABLE COINS (WEEX Perpetual Futures):'];
        lines.push('');

        for (const [symbol, data] of marketDataMap) {
            const displaySymbol = cleanSymbol(symbol);
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

            lines.push(`${displaySymbol.padEnd(5)}: ${price.padStart(10)} (${change.padStart(8)}) | Vol: ${volume.padStart(8)} | Funding: ${funding}`);
        }

        lines.push('');
        lines.push('NOTE: Positive funding = longs pay shorts (bearish signal). Negative = shorts pay longs (bullish signal).');

        return lines.join('\n');
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

        const safePriceVal = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : 100;

        const parseBullTarget = Number(parsed.targets?.bull);
        const parseBaseTarget = Number(parsed.targets?.base);
        const parseBearTarget = Number(parsed.targets?.bear);

        const priceTarget = {
            bull: Number.isFinite(parseBullTarget) && parseBullTarget > 0 ? parseBullTarget : safePriceVal * 1.15,
            base: Number.isFinite(parseBaseTarget) && parseBaseTarget > 0 ? parseBaseTarget : safePriceVal * 1.08,
            bear: Number.isFinite(parseBearTarget) && parseBearTarget > 0 ? parseBearTarget : safePriceVal * 0.92
        };

        // Validate entry price field
        // Log validation for debugging - entry price is validated but execution uses current market price
        const parseEntry = Number(parsed.entry);
        const validatedEntry = Number.isFinite(parseEntry) && parseEntry > 0 ? parseEntry : safePriceVal;
        if (parseEntry !== validatedEntry) {
            logger.debug(`Specialist entry price validated: ${parseEntry} → ${validatedEntry}`);
        }

        // Validate stopLoss field
        // Log validation for debugging - stopLoss is validated but priceTarget.bear is used in execution
        const parseStopLoss = Number(parsed.stopLoss);
        const validatedStopLoss = Number.isFinite(parseStopLoss) && parseStopLoss > 0 ? parseStopLoss : priceTarget.bear;
        if (parseStopLoss !== validatedStopLoss) {
            logger.debug(`Specialist stopLoss validated: ${parseStopLoss} → ${validatedStopLoss}`);
        }

        // Validate leverage field (max 5x per FLOW.md)
        // Log validation for debugging - leverage is validated but handled separately in execution
        const parseLeverage = Number(parsed.leverage);
        const validatedLeverage = Number.isFinite(parseLeverage) && parseLeverage >= 1 && parseLeverage <= 5
            ? parseLeverage : 3;
        if (parseLeverage !== validatedLeverage) {
            logger.debug(`Specialist leverage validated: ${parseLeverage} → ${validatedLeverage}`);
        }

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

    /**
     * Generate a specialist analysis for a specific analyst
     * Includes retry logic for resilience
     */
    private async generateSpecialistAnalysis(
        analystId: string,
        marketData: ExtendedMarketData,
        direction: 'LONG' | 'SHORT'
    ): Promise<AnalysisResult | null> {
        // Validate inputs
        if (!analystId) {
            throw new Error('Analyst ID is required');
        }
        if (!marketData || !Number.isFinite(marketData.currentPrice) || marketData.currentPrice <= 0) {
            throw new Error(`Invalid market data: currentPrice=${marketData?.currentPrice}`);
        }
        if (direction !== 'LONG' && direction !== 'SHORT') {
            throw new Error(`Invalid direction: ${direction}`);
        }

        const methodology = Object.keys(ANALYST_PROFILES).find(
            m => ANALYST_PROFILES[m as AnalystMethodology].id === analystId
        ) as AnalystMethodology | undefined;

        if (!methodology) {
            logger.warn(`No methodology found for analyst ${analystId}`);
            return null;
        }

        const profile = ANALYST_PROFILES[methodology];
        const model = this.getJsonModel(); // Use JSON model for structured output
        const prompt = buildSpecialistPrompt(profile, marketData, direction);

        let lastError: Error | null = null;
        let timeout: ReturnType<typeof createTimeoutPromise> | null = null;

        // Retry up to config.ai.maxRetries times
        for (let attempt = 0; attempt <= config.ai.maxRetries; attempt++) {
            try {
                timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
                const result = await Promise.race([
                    model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            responseSchema: SPECIALIST_ANALYSIS_SCHEMA,
                            maxOutputTokens: config.ai.specialistMaxTokens
                        }
                    }),
                    timeout.promise
                ]);

                const responseText = result.response.text();

                // Check finish reason
                const candidates = result.response.candidates;
                if (candidates && candidates.length > 0) {
                    const finishReason = candidates[0].finishReason || 'UNKNOWN';
                    if (finishReason !== 'STOP') {
                        logger.warn(`⚠️ Specialist ${analystId} finish reason: ${finishReason}`);
                    }
                }

                // Check if response appears truncated
                if (!responseText.trim().endsWith('}')) {
                    throw new Error(`Specialist response truncated - does not end with }. Last 100 chars: "${responseText.slice(-100)}"`);
                }

                const parsed = parseJSONWithRepair(responseText);

                // Validate thesis is not truncated
                if (parsed.thesis && typeof parsed.thesis === 'string' && parsed.thesis.length < 20) {
                    logger.warn(`⚠️ Specialist thesis appears truncated: "${parsed.thesis}"`);
                }

                return this.parseSpecialistResponse(parsed, profile, methodology, marketData.currentPrice);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < config.ai.maxRetries) {
                    logger.warn(`Specialist analysis attempt ${attempt + 1} failed for ${analystId}, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                }
            } finally {
                // CRITICAL: Always cancel timeout to prevent memory leak
                if (timeout) {
                    timeout.cancel();
                    timeout = null;
                }
            }
        }

        logger.warn(`Failed to generate specialist analysis for ${analystId} after ${config.ai.maxRetries + 1} attempts:`, lastError);
        return null;
    }

    // =========================================================================
    // STAGE 2: COIN SELECTION DEBATE
    // =========================================================================

    /**
     * Stage 2: Opportunity Selection Debate
     * 3 analysts (Ray, Jim, Quant) debate the best action:
     * - NEW TRADE: Open LONG or SHORT on a coin
     * - MANAGE: Close/reduce/adjust an existing position
     * 
     * TURN-BY-TURN generation, 8 total turns
     */
    async runCoinSelectionDebate(
        marketDataMap: Map<string, ExtendedMarketData>,
        currentPositions?: Array<{
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            unrealizedPnl: number;
            unrealizedPnlPercent: number;
            holdTimeHours: number;
            fundingPaid?: number;
        }>
    ): Promise<{ winner: string; coinSymbol: string; action: 'LONG' | 'SHORT' | 'MANAGE'; debate: FourWayDebateResult }> {
        logger.info(`Stage 2: Opportunity Selection Debate starting (${4 * config.debate.turnsPerAnalyst} turns)...`);
        if (currentPositions && currentPositions.length > 0) {
            logger.info(`  Portfolio: ${currentPositions.length} open position(s)`);
        }

        if (!marketDataMap || marketDataMap.size === 0) {
            throw new Error('Market data map is empty or invalid');
        }

        // FIXED: Validate at least one entry has valid data
        let validEntries = 0;
        for (const [_symbol, data] of marketDataMap) {
            if (Number.isFinite(data.currentPrice) && data.currentPrice > 0) {
                validEntries++;
            }
        }

        if (validEntries === 0) {
            throw new Error(`Market data map has ${marketDataMap.size} entries but none have valid prices`);
        }

        const model = this.getJsonModel(); // Use JSON model with structured outputs
        const marketSummary = this.buildMarketSummary(marketDataMap);

        // Build funding analysis for each coin
        const fundingAnalysis: Array<{
            symbol: string;
            fundingRate: number;
            fundingDirection: 'bullish' | 'bearish' | 'neutral';
        }> = [];
        for (const [_symbol, data] of marketDataMap) {
            if (data.fundingRate !== undefined && Number.isFinite(data.fundingRate)) {
                const displaySymbol = cleanSymbol(_symbol);
                let fundingDirection: 'bullish' | 'bearish' | 'neutral' = 'neutral';
                if (data.fundingRate < -0.0001) fundingDirection = 'bullish';
                else if (data.fundingRate > 0.0001) fundingDirection = 'bearish';
                fundingAnalysis.push({
                    symbol: displaySymbol,
                    fundingRate: data.fundingRate,
                    fundingDirection
                });
            }
        }

        const context = buildCoinSelectionContext(marketSummary, fundingAnalysis, currentPositions);

        // 3 analysts for coin selection (jim, ray, quant - karen is risk council only)
        const analystIds = ['ray', 'jim', 'quant'];
        const analysts = analystIds.map(id => {
            const methodology = Object.keys(ANALYST_PROFILES).find(
                m => ANALYST_PROFILES[m as AnalystMethodology].id === id
            ) as AnalystMethodology | undefined;
            return methodology ? ANALYST_PROFILES[methodology] : null;
        }).filter((a): a is typeof ANALYST_PROFILES[AnalystMethodology] => a !== null);

        if (analysts.length !== 3) {
            throw new Error(`Failed to load all 3 coin selection analysts. Got ${analysts.length}`);
        }

        const turns: DebateTurn[] = [];
        const turnsPerAnalyst = config.debate.turnsPerAnalyst;
        const totalTurns = analysts.length * turnsPerAnalyst;

        // Generate turns round-robin style
        for (let round = 0; round < turnsPerAnalyst; round++) {
            for (const analyst of analysts) {
                const turnNumber = turns.length + 1;
                logger.info(`[Turn ${turnNumber}/${totalTurns}] ${analyst.name} speaking...`);

                const turn = await generateDebateTurn(
                    model, analyst.id, analyst.name, analyst.methodology,
                    turns, context, turnNumber, totalTurns, 2
                );

                // FIXED: Validate turn before adding to prevent crashes
                if (!turn) {
                    logger.error(`Failed to generate turn ${turnNumber} for ${analyst.name}`);
                    throw new Error(`Debate turn generation failed for ${analyst.name}`);
                }

                if (!turn.argument || typeof turn.argument !== 'string' || turn.argument.trim().length < 50) {
                    logger.error(`Invalid argument in turn ${turnNumber}: "${turn.argument}"`);
                    throw new Error(`Debate turn has invalid argument (too short or empty)`);
                }

                if (!Number.isFinite(turn.strength) || turn.strength < 1 || turn.strength > 10) {
                    logger.warn(`Invalid strength ${turn.strength} in turn ${turnNumber}, defaulting to 5`);
                    turn.strength = 5;
                }

                if (turn.speaker !== analyst.id) {
                    logger.warn(`Speaker mismatch: expected ${analyst.id}, got ${turn.speaker}`);
                    turn.speaker = analyst.id;
                }

                turns.push(turn);
                // Log full argument - no truncation
                logger.info(`[Turn ${turnNumber}/${totalTurns}] ${analyst.name} (strength: ${turn.strength}/10):`);
                logger.info(`  ${turn.argument}`);

                await new Promise(resolve => setTimeout(resolve, config.debate.turnDelayMs));
            }
        }

        // Calculate scores and determine winner using AI Judge
        // Get first coin's market data for judge context (we'll extract actual coin later)
        const firstCoinDataRaw = marketDataMap.values().next().value;
        if (!firstCoinDataRaw) {
            throw new Error('No market data available for judge evaluation');
        }
        const firstCoinData: ExtendedMarketData = firstCoinDataRaw;

        const judgeAnalysts = analysts.map(a => ({
            id: a.id,
            name: a.name,
            methodology: a.methodology
        }));

        // Use AI Judge to determine winner
        const { winner, verdict, usedFallback } = await determineWinnerWithJudge(
            model,
            turns,
            judgeAnalysts,
            firstCoinData,
            'coin_selection',
            'LONG', // Direction will be extracted from winner's arguments
            [] // No previous winners for coin selection
        );

        // Use judge scores if available, otherwise fall back to heuristic scores
        const scores = verdict?.scores
            ? convertJudgeScoresToAnalystScores(verdict.scores, analystIds)
            : calculateDebateScores(turns, analystIds);

        // Validate winner was determined
        if (!winner) {
            logger.error('Failed to determine coin selection debate winner');
            throw new Error('Could not determine debate winner');
        }

        const winningArguments = extractWinningArguments(winner, turns);

        const winnerScore = scores[winner];
        const winnerAnalyst = analysts.find(a => a.id === winner);
        const reasoning = verdict?.reasoning || `${winnerAnalyst?.name || winner} won with total score ${winnerScore?.total || 0}/100`;

        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🎯 OPPORTUNITY SELECTION DEBATE COMPLETE`);
        logger.info(`Winner: ${winner} | Score: ${winnerScore?.total || 0}/100${usedFallback ? ' (fallback)' : ' (AI Judge)'}`);
        logger.info(`${'='.repeat(60)}\n`);

        // Extract coin and action from winner's arguments
        const winnerTurns = turns.filter(t => t.speaker === winner);
        let coinSymbol = '';
        let action: 'LONG' | 'SHORT' | 'MANAGE' = 'LONG';
        let actionFound = false;

        const availableCoins = Array.from(marketDataMap.keys());
        const coinNames = availableCoins.map(c => c.replace('cmt_', '').replace('usdt', '').toUpperCase());

        // Also include position symbols if we have positions
        const positionSymbols = currentPositions?.map(p => p.symbol) || [];

        // Validate we have coins to search for
        if (availableCoins.length === 0) {
            logger.error('No available coins in market data map');
            throw new Error('No available coins for coin extraction');
        }

        for (const turn of winnerTurns) {
            const arg = turn.argument || '';

            // First check for MANAGE action - look for explicit management intent
            // Use strict patterns to avoid false positives from general discussion
            if (!actionFound) {
                for (const pattern of MANAGE_PATTERNS) {
                    if (pattern.test(arg)) {
                        // Additional validation: ensure it's not just mentioning management in passing
                        // Check for action verbs: close, reduce, exit, cut, take profit, adjust, tighten
                        const hasActionVerb = /\b(close|reduce|exit|cut|take\s+profit|adjust|tighten|manage|trim)\b/i.test(arg);
                        if (hasActionVerb) {
                            action = 'MANAGE';
                            actionFound = true;
                            logger.info(`MANAGE action detected via pattern: ${pattern.source} with action verb`);
                            break;
                        }
                    }
                }
            }

            // Extract coin symbol
            if (!coinSymbol) {
                // First try exact cmt_xxxusdt format
                const cmt_match = arg.match(/cmt_(\w+)usdt/i);
                if (cmt_match) {
                    const extractedSymbol = `cmt_${cmt_match[1].toLowerCase()}usdt`;
                    // Validate extracted coin is in available coins OR position symbols
                    if (availableCoins.includes(extractedSymbol) || positionSymbols.includes(extractedSymbol)) {
                        coinSymbol = extractedSymbol;
                    }
                }

                // If no exact match, try coin name matching with word boundaries
                if (!coinSymbol) {
                    for (let i = 0; i < coinNames.length; i++) {
                        // Use word boundary to avoid partial matches (e.g., "BTC" in "BTCUSDT")
                        const coinRegex = new RegExp(`\\b${coinNames[i]}\\b`, 'i');
                        if (coinRegex.test(arg.toUpperCase())) {
                            coinSymbol = availableCoins[i];
                            break;
                        }
                    }
                }

            }

            // FIXED: Extract action FIRST before attempting coin extraction for MANAGE
            // This ensures action is set before we try to use it in conditional logic
            if (!actionFound) {
                for (const pattern of RECOMMEND_PATTERNS) {
                    const match = arg.match(pattern);
                    if (match) {
                        const extracted = match[1].toUpperCase();
                        if (extracted === 'MANAGE') {
                            action = 'MANAGE';
                        } else {
                            action = extracted as 'LONG' | 'SHORT';
                        }
                        actionFound = true;
                        break;
                    }
                }
            }

            // For MANAGE action, also try to extract from position symbols
            // Only if we haven't found a coin yet and we have positions
            // FIXED: This now runs AFTER action extraction, ensuring action is set
            if (!coinSymbol && action === 'MANAGE' && positionSymbols.length > 0) {
                // Sort by symbol length descending to match longer symbols first
                // (e.g., "DOGE" before "DOG" if both existed)
                const sortedPositions = [...positionSymbols].sort((a, b) => b.length - a.length);
                for (const posSymbol of sortedPositions) {
                    const posName = cleanSymbol(posSymbol);
                    // Use word boundary for more precise matching
                    const posRegex = new RegExp(`\\b${posName}\\b`, 'i');
                    if (posRegex.test(arg)) {
                        coinSymbol = posSymbol;
                        logger.info(`Extracted position symbol for MANAGE: ${coinSymbol}`);
                        break;
                    }
                }
            }

            // FIXED: Fallback direction keyword logic moved INSIDE the loop
            // This ensures 'arg' variable is in scope
            if (!actionFound) {
                const directionMatch = arg.match(/\b(LONG|SHORT|BUY|SELL|BULLISH|BEARISH)\b/i);
                if (directionMatch) {
                    const dirWord = directionMatch[1].toUpperCase();
                    action = (dirWord === 'SHORT' || dirWord === 'SELL' || dirWord === 'BEARISH') ? 'SHORT' : 'LONG';
                    actionFound = true;
                }
            }

            // Break if we found both coin and action
            if (coinSymbol && actionFound) break;
        }

        // CRITICAL FIX: Validate MANAGE action - coin must have an open position
        // If MANAGE is selected for a coin without a position, fall back to LONG
        if (action === 'MANAGE' && coinSymbol) {
            const hasPosition = positionSymbols.some(ps => ps.toLowerCase() === coinSymbol.toLowerCase());
            if (!hasPosition) {
                logger.warn(`⚠️ MANAGE action selected for ${coinSymbol} but no position exists`);
                logger.info(`Available positions: ${positionSymbols.join(', ') || 'none'}`);

                // Try to find a position that was mentioned in the winner's arguments
                let foundPositionCoin = '';
                for (const turn of winnerTurns) {
                    const arg = turn.argument || '';
                    for (const posSymbol of positionSymbols) {
                        const posName = cleanSymbol(posSymbol);
                        const posRegex = new RegExp(`\\b${posName}\\b`, 'i');
                        if (posRegex.test(arg)) {
                            foundPositionCoin = posSymbol;
                            logger.info(`Found position ${posSymbol} mentioned in arguments, switching to it`);
                            break;
                        }
                    }
                    if (foundPositionCoin) break;
                }

                if (foundPositionCoin) {
                    // Switch to the position that was actually mentioned
                    coinSymbol = foundPositionCoin;
                    logger.info(`Switched MANAGE target to ${coinSymbol} (has open position)`);
                } else {
                    // No position mentioned - fall back to LONG for the selected coin
                    action = 'LONG';
                    logger.warn(`No valid position for MANAGE, falling back to ${action} ${coinSymbol}`);
                }
            }
        }

        if (!coinSymbol) {
            logger.warn('Could not extract coin from winner arguments, using BTC as fallback');
            // Verify BTC is in available coins before using as fallback
            if (availableCoins.includes('cmt_btcusdt')) {
                coinSymbol = 'cmt_btcusdt';
            } else if (availableCoins.length > 0) {
                // Use first available coin as last resort
                coinSymbol = availableCoins[0];
                logger.warn(`BTC not available, using ${coinSymbol} as fallback`);
            } else {
                throw new Error('No coins available for fallback');
            }
        }

        logger.info(`Stage 2 complete: ${winner} won → ${coinSymbol} ${action}`);

        return {
            winner,
            coinSymbol,
            action,
            debate: { turns, winner, scores, reasoning, winningArguments }
        };
    }


    // =========================================================================
    // STAGE 3: CHAMPIONSHIP DEBATE
    // =========================================================================

    /**
     * Stage 3: Championship Debate
     * ALL 4 analysts compete in a championship debate
     * TURN-BY-TURN generation, 8 total turns (4 analysts × 2 turns)
     * Winner's thesis gets executed as a real trade
     */
    async runChampionshipDebate(
        coinSymbol: string,
        marketData: ExtendedMarketData,
        previousWinners: {
            coinSelector: string;
            coinSelectorArgument?: string;
        }
    ): Promise<{ champion: AnalysisResult; debate: ChampionshipDebateResult }> {
        logger.info(`Stage 3: Championship Debate for ${coinSymbol} (${4 * config.debate.turnsPerAnalyst} turns - ALL 4 analysts)...`);

        // Validate inputs
        if (!coinSymbol || typeof coinSymbol !== 'string') {
            throw new Error('Invalid coin symbol provided to championship debate');
        }
        if (!marketData || !Number.isFinite(marketData.currentPrice) || marketData.currentPrice <= 0) {
            throw new Error('Invalid market data provided to championship debate');
        }
        if (!previousWinners) {
            throw new Error('Previous winners object is required for championship debate');
        }

        // Provide defaults for missing previous winners
        const safeWinners = {
            coinSelector: previousWinners.coinSelector || 'Unknown',
            coinSelectorArgument: previousWinners.coinSelectorArgument
        };

        const model = this.getJsonModel(); // Use JSON model with structured outputs

        // Get ALL 4 analysts
        const allAnalysts = Object.values(ANALYST_PROFILES);
        if (allAnalysts.length !== 4) {
            throw new Error(`Expected 4 analysts, got ${allAnalysts.length}`);
        }

        const displaySymbol = cleanSymbol(coinSymbol);
        const priceStr = safePrice(marketData.currentPrice);
        const changeStr = safePercent(marketData.change24h, 2, true);

        // Pass full market data to championship context
        const context = buildChampionshipContext(
            displaySymbol,
            priceStr,
            changeStr,
            safeWinners,
            {
                volume24h: marketData.volume24h,
                fundingRate: marketData.fundingRate,
                high24h: marketData.high24h,
                low24h: marketData.low24h,
                openInterest: marketData.openInterest
            }
        );
        const turns: DebateTurn[] = [];
        const turnsPerAnalyst = config.debate.turnsPerAnalyst;
        const totalTurns = allAnalysts.length * turnsPerAnalyst;
        const analystIds = allAnalysts.map(a => a.id);

        for (let round = 0; round < turnsPerAnalyst; round++) {
            for (const analyst of allAnalysts) {
                const turnNumber = turns.length + 1;
                logger.info(`[Turn ${turnNumber}/${totalTurns}] ${analyst.name} speaking...`);

                const turn = await generateDebateTurn(
                    model, analyst.id, analyst.name, analyst.methodology,
                    turns, context, turnNumber, totalTurns, 5
                );

                turns.push(turn);
                // Log full argument - no truncation
                logger.info(`[Turn ${turnNumber}/${totalTurns}] ${analyst.name} (strength: ${turn.strength}/10):`);
                logger.info(`  ${turn.argument}`);

                await new Promise(resolve => setTimeout(resolve, config.debate.turnDelayMs));
            }
        }

        // Use AI Judge to determine winner
        const judgeAnalysts = allAnalysts.map(a => ({
            id: a.id,
            name: a.name,
            methodology: a.methodology
        }));

        const { winner, verdict, usedFallback } = await determineWinnerWithJudge(
            model,
            turns,
            judgeAnalysts,
            marketData,
            'championship',
            'LONG', // Direction will be extracted from winner's arguments
            [safeWinners.coinSelector].filter(Boolean) as string[]
        );

        // Use judge scores if available, otherwise fall back to heuristic scores
        const scores = verdict?.scores
            ? convertJudgeScoresToAnalystScores(verdict.scores, analystIds)
            : calculateDebateScores(turns, analystIds);

        // Validate winner was determined
        if (!winner) {
            logger.error('Failed to determine championship debate winner');
            throw new Error('Could not determine debate winner');
        }

        const winningArguments = extractWinningArguments(winner, turns);

        const winnerScore = scores[winner];
        const winnerAnalyst = allAnalysts.find(a => a.id === winner);
        const reasoning = verdict?.reasoning || `${winnerAnalyst?.name || winner} won with total score ${winnerScore?.total || 0}/100`;
        const summary = verdict
            ? `Championship debate completed with ${turns.length} turns. ${winnerAnalyst?.name || winner} emerged as champion. ${verdict.reasoning}`
            : `Championship debate completed with ${turns.length} turns. ${winnerAnalyst?.name || winner} emerged as champion.`;


        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🏆🏆🏆 CHAMPIONSHIP DEBATE COMPLETE 🏆🏆🏆`);
        logger.info(`CHAMPION: ${winner} | Score: ${winnerScore?.total || 0}/100${usedFallback ? ' (fallback)' : ' (AI Judge)'}`);
        logger.info(`${'='.repeat(60)}\n`);

        // Extract direction from winner's arguments using robust patterns
        // Avoid false positives from negations like "I would NOT go LONG"
        const winnerTurns = turns.filter(t => t.speaker === winner);
        let direction: 'LONG' | 'SHORT' = 'LONG';
        let directionFound = false;

        // Priority 1: Look for explicit "I recommend LONG/SHORT" patterns
        const recommendPatterns = [
            /I\s+recommend\s+(LONG|SHORT)/i,
            /recommend(?:ing)?\s+(LONG|SHORT)/i,
            /my\s+recommendation\s+is\s+(LONG|SHORT)/i,
            /position[:\s]+(LONG|SHORT)/i,
            /go(?:ing)?\s+(LONG|SHORT)/i,
            /open(?:ing)?\s+(?:a\s+)?(LONG|SHORT)/i
        ];

        // Priority 2: Avoid negation patterns
        const negationPatterns = [
            /(?:NOT|don't|wouldn't|shouldn't|avoid)\s+(?:go\s+)?(LONG|SHORT)/i,
            /(?:against|oppose)\s+(?:a\s+)?(LONG|SHORT)/i
        ];

        for (const turn of winnerTurns) {
            if (directionFound) break;

            const arg = turn.argument || '';

            // First check for negations to exclude them
            let hasNegation = false;
            for (const negPattern of negationPatterns) {
                if (negPattern.test(arg)) {
                    hasNegation = true;
                    break;
                }
            }

            // Look for positive recommendation patterns
            for (const pattern of recommendPatterns) {
                const match = arg.match(pattern);
                if (match && !hasNegation) {
                    direction = match[1].toUpperCase() as 'LONG' | 'SHORT';
                    directionFound = true;
                    break;
                }
            }

            // Fallback: simple LONG/SHORT detection if no explicit recommendation found
            if (!directionFound) {
                // Count occurrences, excluding negated ones
                const longMatches = (arg.match(/\bLONG\b/gi) || []).length;
                const shortMatches = (arg.match(/\bSHORT\b/gi) || []).length;
                const negatedLong = (arg.match(/(?:NOT|don't|wouldn't)\s+(?:go\s+)?LONG/gi) || []).length;
                const negatedShort = (arg.match(/(?:NOT|don't|wouldn't)\s+(?:go\s+)?SHORT/gi) || []).length;

                const effectiveLong = longMatches - negatedLong;
                const effectiveShort = shortMatches - negatedShort;

                if (effectiveLong > effectiveShort && effectiveLong > 0) {
                    direction = 'LONG';
                    directionFound = true;
                } else if (effectiveShort > effectiveLong && effectiveShort > 0) {
                    direction = 'SHORT';
                    directionFound = true;
                }
            }
        }

        if (!directionFound) {
            logger.warn(`Could not extract direction from ${winner}'s arguments, defaulting to LONG`);
        }

        // Generate champion's full analysis
        const championAnalysis = await this.generateSpecialistAnalysis(winner, marketData, direction);

        if (!championAnalysis) {
            throw new Error(`Could not generate analysis for champion ${winner}`);
        }

        logger.info(`Stage 3 complete: ${winner} is the CHAMPION! 🏆`);

        return {
            champion: championAnalysis,
            debate: { turns, winner, scores, reasoning, winningArguments, summary }
        };
    }

    // =========================================================================
    // STAGE 4: RISK COUNCIL (Karen's Final Review)
    // =========================================================================

    /**
     * Stage 4: Risk Council
     * Karen reviews and approves/vetoes the trade
     * 
     * Updated signature to accept entryPrice and unrealizedPnl for positions
     */
    async runRiskCouncil(
        champion: AnalysisResult,
        marketData: ExtendedMarketData,
        accountBalance: number,
        currentPositions: Array<{ symbol: string; side: string; size: number; entryPrice?: number; unrealizedPnl?: number }>,
        recentPnL: { day: number; week: number }
    ): Promise<RiskCouncilDecision> {
        logger.info('Stage 4: Risk Council review...');

        // Validate inputs
        if (!champion) {
            throw new Error('Champion analysis is required for risk council');
        }
        if (!marketData || !Number.isFinite(marketData.currentPrice) || marketData.currentPrice <= 0) {
            throw new Error(`Invalid market data: currentPrice=${marketData?.currentPrice}`);
        }
        if (!Number.isFinite(accountBalance) || accountBalance < 0) {
            throw new Error(`Invalid account balance: ${accountBalance}`);
        }

        const model = this.getJsonModel(); // Use JSON model for structured output
        const karenProfile = ANALYST_PROFILES.risk;

        const prompt = buildRiskCouncilPrompt(
            karenProfile, champion, marketData, accountBalance, currentPositions, recentPnL
        );

        let lastError: Error | null = null;
        let timeout: ReturnType<typeof createTimeoutPromise> | null = null;

        // Retry up to config.ai.maxRetries times
        for (let attempt = 0; attempt <= config.ai.maxRetries; attempt++) {
            try {
                timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
                const result = await Promise.race([
                    model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            responseSchema: RISK_COUNCIL_SCHEMA,
                            maxOutputTokens: config.ai.specialistMaxTokens
                        }
                    }),
                    timeout.promise
                ]);

                const responseText = result.response.text();

                // Check finish reason
                const candidates = result.response.candidates;
                if (candidates && candidates.length > 0) {
                    const finishReason = candidates[0].finishReason || 'UNKNOWN';
                    if (finishReason !== 'STOP') {
                        logger.warn(`⚠️ Risk Council finish reason: ${finishReason}`);
                    }
                }

                // Check if response appears truncated
                if (!responseText.trim().endsWith('}')) {
                    throw new Error(`Risk Council response truncated - does not end with }. Last 100 chars: "${responseText.slice(-100)}"`);
                }

                const parsed = parseJSONWithRepair(responseText);

                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`🛡️ RISK COUNCIL DECISION (Karen)`);
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

                logger.info(`Stage 4 complete: ${decision.approved ? 'APPROVED ✅' : 'VETOED ❌'}`);
                return decision;
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < config.ai.maxRetries) {
                    logger.warn(`Risk council attempt ${attempt + 1} failed, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                }
            } finally {
                // CRITICAL: Always cancel timeout to prevent memory leak
                if (timeout) {
                    timeout.cancel();
                    timeout = null;
                }
            }
        }

        logger.error('Risk council failed after 3 attempts:', lastError);
        return {
            approved: false,
            warnings: ['Risk council analysis failed after multiple attempts'],
            vetoReason: 'Unable to complete risk assessment'
        };
    }

    /**
     * Position Management Decision (MANAGE Action from Stage 2)
     * Karen (Risk Manager) decides how to manage an existing position
     * 
     * This is called when Stage 2 selects MANAGE action instead of LONG/SHORT.
     * It bypasses stages 3-4 and goes directly to position management.
     * @param position - Current position to manage
     * @param marketDataMap - Current market data for all symbols
     * @returns Management decision with action type and parameters
     */
    async runPositionManagement(
        position: {
            symbol: string;
            side: 'LONG' | 'SHORT';
            size: number;
            entryPrice: number;
            currentPrice: number;
            unrealizedPnl: number;
            unrealizedPnlPercent: number;
            holdTimeHours: number;
            fundingPaid?: number;
        },
        marketDataMap: Map<string, ExtendedMarketData>
    ): Promise<{
        manageType: 'CLOSE_FULL' | 'CLOSE_PARTIAL' | 'TIGHTEN_STOP' | 'TAKE_PARTIAL' | 'ADJUST_TP' | 'ADD_MARGIN';
        conviction: number;
        reason: string;
        closePercent?: number;
        newStopLoss?: number;
        newTakeProfit?: number;
        marginAmount?: number;
    }> {
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🛡️ POSITION MANAGEMENT DECISION (MANAGE Action)`);
        logger.info(`${'='.repeat(60)}\n`);

        // Get Karen's profile (Risk Manager)
        const karenProfile = ANALYST_PROFILES.risk;

        // Get market data for the position's symbol
        const marketData = marketDataMap.get(position.symbol);
        if (!marketData) {
            throw new Error(`Market data not found for ${position.symbol}`);
        }

        // FIXED: Import moved to module level for better performance
        // Build the management prompt
        const prompt = buildManagePrompt(karenProfile, position, marketData);

        // Define schema for management response
        const MANAGE_RESPONSE_SCHEMA = {
            type: SchemaType.OBJECT,
            properties: {
                manageType: {
                    type: SchemaType.STRING,
                    enum: ['CLOSE_FULL', 'CLOSE_PARTIAL', 'TIGHTEN_STOP', 'TAKE_PARTIAL', 'ADJUST_TP', 'ADD_MARGIN'],
                    description: 'Type of management action to take'
                },
                conviction: {
                    type: SchemaType.NUMBER,
                    description: 'Conviction level 1-10'
                },
                reason: {
                    type: SchemaType.STRING,
                    description: 'One sentence reason with specific numbers'
                },
                closePercent: {
                    type: SchemaType.NUMBER,
                    description: 'Percentage to close (for CLOSE_PARTIAL or TAKE_PARTIAL)'
                },
                newStopLoss: {
                    type: SchemaType.NUMBER,
                    description: 'New stop loss price (for TIGHTEN_STOP)'
                },
                newTakeProfit: {
                    type: SchemaType.NUMBER,
                    description: 'New take profit price (for ADJUST_TP)'
                },
                marginAmount: {
                    type: SchemaType.NUMBER,
                    description: 'Amount of margin to add in USDT (for ADD_MARGIN)'
                }
            },
            required: ['manageType', 'conviction', 'reason']
        };

        const model = this.getJsonModel();
        let lastError: Error = new Error('Unknown error');
        let timeout: { promise: Promise<never>; cancel: () => void } | null = null;

        for (let attempt = 0; attempt <= config.ai.maxRetries; attempt++) {
            try {
                timeout = createTimeoutPromise(AI_REQUEST_TIMEOUT);
                const result = await Promise.race([
                    model.generateContent({
                        contents: [{ role: 'user', parts: [{ text: prompt }] }],
                        generationConfig: {
                            responseMimeType: "application/json",
                            responseSchema: MANAGE_RESPONSE_SCHEMA,
                            maxOutputTokens: config.ai.specialistMaxTokens
                        }
                    }),
                    timeout.promise
                ]);

                const responseText = result.response.text();

                // Check finish reason
                const candidates = result.response.candidates;
                if (candidates && candidates.length > 0) {
                    const finishReason = candidates[0].finishReason || 'UNKNOWN';
                    if (finishReason !== 'STOP') {
                        logger.warn(`⚠️ Position Management finish reason: ${finishReason}`);
                    }
                }

                const parsed = parseJSONWithRepair(responseText);

                // Validate required fields
                if (!parsed.manageType || !parsed.conviction || !parsed.reason) {
                    throw new Error('Missing required fields in management response');
                }

                // Validate manageType
                const validTypes = ['CLOSE_FULL', 'CLOSE_PARTIAL', 'TIGHTEN_STOP', 'TAKE_PARTIAL', 'ADJUST_TP', 'ADD_MARGIN'];
                if (!validTypes.includes(parsed.manageType)) {
                    throw new Error(`Invalid manageType: ${parsed.manageType}`);
                }

                // Validate type-specific parameters
                if ((parsed.manageType === 'CLOSE_PARTIAL' || parsed.manageType === 'TAKE_PARTIAL') && !parsed.closePercent) {
                    throw new Error(`${parsed.manageType} requires closePercent`);
                }
                if (parsed.manageType === 'TIGHTEN_STOP' && !parsed.newStopLoss) {
                    throw new Error('TIGHTEN_STOP requires newStopLoss');
                }
                if (parsed.manageType === 'ADJUST_TP' && !parsed.newTakeProfit) {
                    throw new Error('ADJUST_TP requires newTakeProfit');
                }
                if (parsed.manageType === 'ADD_MARGIN' && !parsed.marginAmount) {
                    throw new Error('ADD_MARGIN requires marginAmount');
                }

                // CRITICAL: Validate closePercent range
                if (parsed.closePercent !== undefined) {
                    const pct = Number(parsed.closePercent);
                    if (!Number.isFinite(pct) || pct < 1 || pct > 99) {
                        throw new Error(`closePercent must be between 1 and 99, got: ${parsed.closePercent}`);
                    }
                }

                // CRITICAL: Validate price values are positive
                if (parsed.newStopLoss !== undefined) {
                    const sl = Number(parsed.newStopLoss);
                    if (!Number.isFinite(sl) || sl <= 0) {
                        throw new Error(`newStopLoss must be positive, got: ${parsed.newStopLoss}`);
                    }
                }
                if (parsed.newTakeProfit !== undefined) {
                    const tp = Number(parsed.newTakeProfit);
                    if (!Number.isFinite(tp) || tp <= 0) {
                        throw new Error(`newTakeProfit must be positive, got: ${parsed.newTakeProfit}`);
                    }
                }

                // CRITICAL: Validate marginAmount is positive and reasonable
                if (parsed.marginAmount !== undefined) {
                    const margin = Number(parsed.marginAmount);
                    if (!Number.isFinite(margin) || margin <= 0) {
                        throw new Error(`marginAmount must be positive, got: ${parsed.marginAmount}`);
                    }
                    // Sanity check: margin shouldn't exceed $10,000 in a single add
                    if (margin > 10000) {
                        throw new Error(`marginAmount ${margin} exceeds safety limit of $10,000`);
                    }
                }

                // CRITICAL: Validate conviction is in range - throw error for consistency with other validations
                const conviction = Number(parsed.conviction);
                if (!Number.isFinite(conviction) || conviction < 1 || conviction > 10) {
                    throw new Error(`conviction must be between 1 and 10, got: ${parsed.conviction}`);
                }

                logger.info(`\n${'='.repeat(60)}`);
                logger.info(`📋 POSITION MANAGEMENT DECISION (Karen)`);
                logger.info(`${'='.repeat(60)}`);
                logger.info(`Action: ${parsed.manageType}`);
                logger.info(`Conviction: ${parsed.conviction}/10`);
                logger.info(`Reason: ${parsed.reason}`);
                if (parsed.closePercent) logger.info(`Close Percent: ${parsed.closePercent}%`);
                if (parsed.newStopLoss) logger.info(`New Stop Loss: ${parsed.newStopLoss}`);
                if (parsed.newTakeProfit) logger.info(`New Take Profit: ${parsed.newTakeProfit}`);
                if (parsed.marginAmount) logger.info(`Margin Amount: ${parsed.marginAmount} USDT`);
                logger.info(`${'='.repeat(60)}\n`);

                return {
                    manageType: parsed.manageType,
                    conviction: conviction, // Already validated above, no clamping needed
                    reason: String(parsed.reason || 'No reason provided'),
                    closePercent: parsed.closePercent ? Number(parsed.closePercent) : undefined,
                    newStopLoss: parsed.newStopLoss ? Number(parsed.newStopLoss) : undefined,
                    newTakeProfit: parsed.newTakeProfit ? Number(parsed.newTakeProfit) : undefined,
                    marginAmount: parsed.marginAmount ? Number(parsed.marginAmount) : undefined
                };
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
                if (attempt < config.ai.maxRetries) {
                    logger.warn(`Position management attempt ${attempt + 1} failed, retrying...`);
                    await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
                }
            } finally {
                // CRITICAL: Always cancel timeout to prevent memory leak
                if (timeout) {
                    timeout.cancel();
                    timeout = null;
                }
            }
        }

        logger.error('Position management failed after 3 attempts:', lastError);
        // Default to closing the position if decision fails
        return {
            manageType: 'CLOSE_FULL',
            conviction: 5,
            reason: 'Failed to get management decision - closing position as safety measure'
        };
    }

    /**
     * Cleanup method for graceful shutdown
     * Clears model instance to free resources
     */
    cleanup(): void {
        this.jsonModel = null;
        logger.debug('CollaborativeFlowService cleaned up');
    }
}

// Singleton export
export const collaborativeFlowService = new CollaborativeFlowService();
