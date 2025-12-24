/**
 * Gemini AI Service - ENHANCED
 * 
 * Handles all AI-powered analysis using Google's Gemini API.
 * Uses high-quality analyst personas with detailed prompts and debate strategies.
 * 
 * Matches the prompts file format exactly:
 * - 8 analysts: warren, cathie, jim, ray, elon, karen, quant, devil
 * - Recommendations: STRONG_BUY, BUY, HOLD, SELL, STRONG_SELL
 * - Price targets: bull/base/bear structure
 */

import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { aiLogService } from '../compliance/AILogService';
import { ANALYST_PROFILES, THESIS_SYSTEM_PROMPTS, AnalystMethodology } from '../../constants/analystPrompts';

// Constants
const AI_REQUEST_TIMEOUT = 90000; // 90 seconds for detailed analysis
const VALID_RECOMMENDATIONS = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'] as const;
const VALID_RISK_LEVELS = ['low', 'medium', 'high', 'very_high'] as const;
const VALID_WINNERS = ['bull', 'bear', 'draw'] as const;

// WEEX Approved Trading Pairs (from TRADING_RULES.md)
const WEEX_APPROVED_PAIRS = [
    'cmt_btcusdt',
    'cmt_ethusdt',
    'cmt_solusdt',
    'cmt_dogeusdt',
    'cmt_xrpusdt',
    'cmt_adausdt',
    'cmt_bnbusdt',
    'cmt_ltcusdt',
] as const;

export type WeexApprovedPair = typeof WEEX_APPROVED_PAIRS[number];

// Map methodology to analyst for easy lookup - matches prompts file exactly
const METHODOLOGY_ORDER: AnalystMethodology[] = ['value', 'growth', 'technical', 'macro', 'sentiment', 'risk', 'quant', 'contrarian'];

export interface AnalysisRequest {
    symbol: string;
    currentPrice: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    change24h?: number;
    analystId?: string;
}

export interface AnalysisResult {
    analystId: string;
    analystName: string;
    analystEmoji: string;
    analystTitle: string;
    methodology: string;
    recommendation: 'strong_buy' | 'buy' | 'hold' | 'sell' | 'strong_sell';
    confidence: number;
    thesis: string;  // Maps to "summary" from prompts
    reasoning: string[];
    bullCase: string[];
    bearCase: string[];
    priceTarget: {
        bull: number;
        base: number;
        bear: number;
    };
    timeHorizon: string;
    positionSize: number;  // 1-10 scale
    riskLevel: 'low' | 'medium' | 'high' | 'very_high';
    keyMetrics: Record<string, string>;
    catalysts: string[];
    risks: string[];
}

export interface DebateRequest {
    symbol: string;
    bullAnalysis: AnalysisResult;
    bearAnalysis: AnalysisResult;
    round: 'quarterfinal' | 'semifinal' | 'final';
    marketData: {
        price: number;
        change24h: number;
        volume24h?: number;
    };
}

export interface DebateTurn {
    speaker: 'bull' | 'bear';
    analystId: string;
    analystName: string;
    argument: string;
    strength: number;
    dataPointsReferenced: string[];
}

export interface DebateScores {
    bullScore: number;
    bearScore: number;
    dataQuality: { bull: number; bear: number };
    logicCoherence: { bull: number; bear: number };
    riskAcknowledgment: { bull: number; bear: number };
    catalystIdentification: { bull: number; bear: number };
}

export interface DebateResult {
    matchId: string;
    round: 'quarterfinal' | 'semifinal' | 'final';
    turns: DebateTurn[];
    winner: 'bull' | 'bear' | 'draw';
    scores: DebateScores;
    winningArguments: string[];
    summary: string;
}

export interface TournamentBracket {
    quarterfinals: DebateResult[];
    semifinals: DebateResult[];
    final: DebateResult | null;
    champion: AnalysisResult | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEEX TRADING INTERFACES - Matches WEEX API exactly
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extended market data for comprehensive analysis
 * Includes all data available from WEEX market endpoints
 */
export interface ExtendedMarketData {
    symbol: string;
    currentPrice: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    change24h: number;
    // Additional WEEX data
    markPrice?: number;
    indexPrice?: number;
    bestBid?: number;
    bestAsk?: number;
    fundingRate?: number;
    openInterest?: number;
    // Candlestick data (optional)
    candles?: {
        interval: string;
        data: Array<{
            timestamp: number;
            open: number;
            high: number;
            low: number;
            close: number;
            volume: number;
        }>;
    };
}

/**
 * WEEX Order Types
 * 1 = Open long, 2 = Open short, 3 = Close long, 4 = Close short
 */
export type WeexOrderType = '1' | '2' | '3' | '4';

/**
 * WEEX Order Execution Types
 * 0 = Normal (limit), 1 = Post-Only, 2 = FOK, 3 = IOC
 */
export type WeexOrderExecutionType = '0' | '1' | '2' | '3';

/**
 * WEEX Price Types
 * 0 = Limit price, 1 = Market price
 */
export type WeexPriceType = '0' | '1';

/**
 * Trade order ready for WEEX API execution
 * Matches /capi/v2/order/placeOrder parameters
 */
export interface TradeOrder {
    symbol: string;                    // e.g., "cmt_btcusdt"
    client_oid: string;                // Custom order ID (max 40 chars)
    size: string;                      // Order quantity
    type: WeexOrderType;               // 1=Open long, 2=Open short, 3=Close long, 4=Close short
    order_type: WeexOrderExecutionType; // 0=Normal, 1=Post-Only, 2=FOK, 3=IOC
    match_price: WeexPriceType;        // 0=Limit, 1=Market
    price: string;                     // Order price (required for limit orders)
    presetTakeProfitPrice?: string;    // Optional TP price
    presetStopLossPrice?: string;      // Optional SL price
    marginMode?: 1 | 3;                // 1=Cross, 3=Isolated
}

/**
 * AI Log for WEEX compliance
 * Matches /capi/v2/order/uploadAiLog parameters
 */
export interface WeexAILog {
    orderId?: number;
    stage: 'Decision Making' | 'Strategy Generation' | 'Risk Assessment' | 'Market Analysis' | 'Order Execution' | 'Portfolio Management';
    model: string;
    input: Record<string, any>;
    output: Record<string, any>;
    explanation: string;  // Max 500 words
}

/**
 * Complete trading decision with order and AI log
 */
export interface TradingDecision {
    shouldTrade: boolean;
    order?: TradeOrder;
    aiLog: WeexAILog;
    analysis: {
        champion: AnalysisResult | null;
        consensus: { bulls: number; bears: number; neutral: number };
        confidence: number;
    };
    riskManagement: {
        positionSizePercent: number;  // % of portfolio
        leverage: number;
        takeProfitPrice: number;
        stopLossPrice: number;
        riskRewardRatio: number;
    };
}

class GeminiService {
    private model: GenerativeModel | null = null;

    private getModel(): GenerativeModel {
        if (!this.model) {
            if (!config.geminiApiKey) {
                throw new Error('GEMINI_API_KEY not configured');
            }
            const genAI = new GoogleGenerativeAI(config.geminiApiKey);
            this.model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash-exp' });
        }
        return this.model;
    }

    /**
     * Get analyst profile and system prompt by methodology (internal)
     */
    private getAnalystWithPrompt(methodology: AnalystMethodology) {
        const profile = ANALYST_PROFILES[methodology];
        const systemPrompt = THESIS_SYSTEM_PROMPTS[methodology];
        return { profile, systemPrompt };
    }

    /**
     * Generate analysis from a specific analyst persona using enhanced prompts
     * Uses the exact JSON format from the prompts file
     */
    async generateAnalysis(request: AnalysisRequest, _userId?: string): Promise<AnalysisResult> {
        const model = this.getModel();

        // Determine which analyst to use
        let methodology: AnalystMethodology;
        if (request.analystId) {
            methodology = METHODOLOGY_ORDER.find(m => ANALYST_PROFILES[m].id === request.analystId) || 'value';
        } else {
            methodology = METHODOLOGY_ORDER[Math.floor(Math.random() * METHODOLOGY_ORDER.length)];
        }

        const { profile, systemPrompt } = this.getAnalystWithPrompt(methodology);
        const displaySymbol = request.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();

        // Safe calculation of 24h change - avoid division by zero
        let change24h = request.change24h ?? 0;
        if (change24h === 0 && request.low24h > 0) {
            change24h = ((request.currentPrice - request.low24h) / request.low24h) * 100;
        }
        if (!Number.isFinite(change24h)) change24h = 0;

        // Prompt matches the exact format from analystPrompts.ts
        const prompt = `${systemPrompt}

═══════════════════════════════════════════════════════════════════════════════
ANALYZE THIS CRYPTO ASSET: ${displaySymbol}/USDT
═══════════════════════════════════════════════════════════════════════════════

MARKET DATA:
- Current Price: ${request.currentPrice.toFixed(request.currentPrice < 1 ? 6 : 2)}
- 24h High: ${request.high24h.toFixed(request.high24h < 1 ? 6 : 2)}
- 24h Low: ${request.low24h.toFixed(request.low24h < 1 ? 6 : 2)}
- 24h Change: ${change24h >= 0 ? '+' : ''}${change24h.toFixed(2)}%
- 24h Volume: ${request.volume24h.toLocaleString()}

Apply your ${profile.title} methodology rigorously. Consider your focus areas:
${profile.focusAreas.map(f => `- ${f}`).join('\n')}

Acknowledge your biases:
${profile.biases.map(b => `- ${b}`).join('\n')}

Respond with valid JSON in this EXACT structure:
{
    "recommendation": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
    "confidence": 0-100,
    "priceTarget": {
        "bull": number,
        "base": number,
        "bear": number
    },
    "timeHorizon": "string (e.g., '6 months', '12 months')",
    "positionSize": 1-10,
    "bullCase": ["Specific argument 1 with DATA", "Argument 2", "Argument 3"],
    "bearCase": ["Honest risk 1 with quantification", "Risk 2", "Risk 3"],
    "keyMetrics": {"Metric 1": "Value with context", "Metric 2": "Value"},
    "catalysts": ["Event 1 (Date) - Expected impact", "Event 2"],
    "summary": "One sentence thesis that could stand alone"
}

Respond ONLY with valid JSON.`;

        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('AI request timeout')), AI_REQUEST_TIMEOUT);
            });

            const result = await Promise.race([
                model.generateContent(prompt),
                timeoutPromise
            ]);

            const text = result.response.text();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');

            const parsed = JSON.parse(jsonMatch[0]);
            return this.parseAnalysisResponse(parsed, profile, methodology, request.currentPrice);
        } catch (error: any) {
            logger.error('Gemini analysis failed:', { error: error.message, analyst: profile.id });
            throw new Error(`AI analysis failed: ${error.message}`);
        }
    }

    /**
     * Parse and validate analysis response
     * Handles both uppercase (from prompts) and lowercase recommendations
     */
    private parseAnalysisResponse(
        parsed: any,
        profile: typeof ANALYST_PROFILES[AnalystMethodology],
        methodology: AnalystMethodology,
        currentPrice: number
    ): AnalysisResult {
        // Handle both STRONG_BUY and strong_buy formats
        const recommendation = VALID_RECOMMENDATIONS.includes(parsed.recommendation?.toLowerCase())
            ? parsed.recommendation.toLowerCase() : 'hold';

        const confidence = Math.min(100, Math.max(0, Number(parsed.confidence) || 50));
        const positionSize = Math.min(10, Math.max(1, Number(parsed.positionSize) || 5));
        const timeHorizon = typeof parsed.timeHorizon === 'string' ? parsed.timeHorizon : '6 months';

        // Validate price targets - handle both old (targetPrice) and new (priceTarget) formats
        const safePrice = currentPrice > 0 ? currentPrice : 100;
        const sanitizePrice = (price: unknown, fallback: number): number => {
            if (typeof price === 'number' && Number.isFinite(price) && price > 0) return price;
            return fallback;
        };

        // Parse priceTarget object or fall back to defaults
        let priceTarget = {
            bull: safePrice * 1.3,
            base: safePrice * 1.1,
            bear: safePrice * 0.85
        };

        if (parsed.priceTarget && typeof parsed.priceTarget === 'object') {
            priceTarget = {
                bull: sanitizePrice(parsed.priceTarget.bull, safePrice * 1.3),
                base: sanitizePrice(parsed.priceTarget.base, safePrice * 1.1),
                bear: sanitizePrice(parsed.priceTarget.bear, safePrice * 0.85)
            };
        }

        // Determine risk level from position size and confidence
        let riskLevel: AnalysisResult['riskLevel'] = 'medium';
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
            thesis: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : '',
            reasoning: [], // Not in new format, kept for compatibility
            bullCase: Array.isArray(parsed.bullCase) ? parsed.bullCase.filter((r: any) => typeof r === 'string').slice(0, 5) : [],
            bearCase: Array.isArray(parsed.bearCase) ? parsed.bearCase.filter((r: any) => typeof r === 'string').slice(0, 5) : [],
            priceTarget,
            timeHorizon,
            positionSize,
            riskLevel,
            keyMetrics: typeof parsed.keyMetrics === 'object' ? parsed.keyMetrics : {},
            catalysts: Array.isArray(parsed.catalysts) ? parsed.catalysts.filter((c: any) => typeof c === 'string').slice(0, 5) : [],
            risks: Array.isArray(parsed.bearCase) ? parsed.bearCase.filter((r: any) => typeof r === 'string').slice(0, 5) : [], // Use bearCase as risks
        };
    }


    /**
     * Generate analyses from all 8 analysts with high-quality prompts
     */
    async generateAllAnalyses(request: AnalysisRequest, userId?: string): Promise<AnalysisResult[]> {
        const results: AnalysisResult[] = [];

        // Run in batches of 2 for rate limiting (more conservative for detailed prompts)
        for (let i = 0; i < METHODOLOGY_ORDER.length; i += 2) {
            const batch = METHODOLOGY_ORDER.slice(i, i + 2);
            const batchResults = await Promise.all(
                batch.map(async methodology => {
                    const profile = ANALYST_PROFILES[methodology];
                    try {
                        return await this.generateAnalysis({ ...request, analystId: profile.id }, userId);
                    } catch (err: any) {
                        logger.warn(`Analysis failed for ${profile.name}:`, err.message);
                        return null;
                    }
                })
            );
            results.push(...batchResults.filter((r): r is AnalysisResult => r !== null));

            // Delay between batches
            if (i + 2 < METHODOLOGY_ORDER.length) {
                await new Promise(resolve => setTimeout(resolve, 800));
            }
        }

        // Log for compliance
        if (userId && results.length > 0) {
            await aiLogService.createLog(
                userId, 'analysis', 'all-analysts',
                { symbol: request.symbol, count: results.length },
                { summary: `${results.length} analyses generated` },
                `Generated ${results.length} analyst opinions`
            );
        }

        return results;
    }

    /**
     * Generate a high-quality debate between bull and bear analysts
     * Enhanced with scoring breakdown and winning arguments extraction
     */
    async generateDebate(request: DebateRequest, _userId?: string): Promise<DebateResult> {
        const model = this.getModel();
        const displaySymbol = request.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
        const roundLabel = request.round.toUpperCase().replace('FINAL', 'CHAMPIONSHIP');

        const prompt = `You are moderating a ${roundLabel} debate between two elite crypto analysts about ${displaySymbol}/USDT.

═══════════════════════════════════════════════════════════════════════════════
BULL ANALYST: ${request.bullAnalysis.analystName} ${request.bullAnalysis.analystEmoji} (${request.bullAnalysis.analystTitle})
═══════════════════════════════════════════════════════════════════════════════
Recommendation: ${request.bullAnalysis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${request.bullAnalysis.confidence}%
Thesis: ${request.bullAnalysis.thesis}
Bull Case: ${request.bullAnalysis.bullCase?.slice(0, 3).join(' | ') || 'N/A'}
Key Metrics: ${JSON.stringify(request.bullAnalysis.keyMetrics || {})}

═══════════════════════════════════════════════════════════════════════════════
BEAR ANALYST: ${request.bearAnalysis.analystName} ${request.bearAnalysis.analystEmoji} (${request.bearAnalysis.analystTitle})
═══════════════════════════════════════════════════════════════════════════════
Recommendation: ${request.bearAnalysis.recommendation.toUpperCase().replace('_', ' ')}
Confidence: ${request.bearAnalysis.confidence}%
Thesis: ${request.bearAnalysis.thesis}
Bear Case: ${request.bearAnalysis.bearCase?.slice(0, 3).join(' | ') || 'N/A'}
Key Metrics: ${JSON.stringify(request.bearAnalysis.keyMetrics || {})}

═══════════════════════════════════════════════════════════════════════════════
MARKET DATA
═══════════════════════════════════════════════════════════════════════════════
Current Price: ${request.marketData.price.toFixed(request.marketData.price < 1 ? 6 : 2)}
24h Change: ${request.marketData.change24h >= 0 ? '+' : ''}${request.marketData.change24h.toFixed(2)}%
${request.marketData.volume24h ? `24h Volume: ${request.marketData.volume24h.toLocaleString()}` : ''}

═══════════════════════════════════════════════════════════════════════════════
DEBATE INSTRUCTIONS
═══════════════════════════════════════════════════════════════════════════════
Generate a 4-turn debate (2 turns each, alternating). Each turn should:
1. Reference SPECIFIC data points and metrics
2. Counter the opponent's previous argument
3. Stay true to the analyst's methodology
4. Be 80-120 words per turn

Score each analyst on (from prompts judging criteria):
- Data Quality (0-100): How well they use specific numbers and metrics
- Logic Coherence (0-100): How well-structured and reasoned their arguments are
- Risk Acknowledgment (0-100): How well they acknowledge counterarguments
- Catalyst Identification (0-100): How well they identify price catalysts

Respond in JSON format:
{
    "turns": [
        {"speaker": "bull", "analystName": "${request.bullAnalysis.analystName}", "argument": "Opening argument with data", "strength": 1-10, "dataPointsReferenced": ["metric1", "metric2"]},
        {"speaker": "bear", "analystName": "${request.bearAnalysis.analystName}", "argument": "Rebuttal with counter-data", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bull", "analystName": "${request.bullAnalysis.analystName}", "argument": "Counter-argument", "strength": 1-10, "dataPointsReferenced": ["metric1"]},
        {"speaker": "bear", "analystName": "${request.bearAnalysis.analystName}", "argument": "Final point", "strength": 1-10, "dataPointsReferenced": ["metric1"]}
    ],
    "winner": "bull" | "bear" | "draw",
    "scores": {
        "bullScore": 0-100,
        "bearScore": 0-100,
        "dataQuality": {"bull": 0-100, "bear": 0-100},
        "logicCoherence": {"bull": 0-100, "bear": 0-100},
        "riskAcknowledgment": {"bull": 0-100, "bear": 0-100},
        "catalystIdentification": {"bull": 0-100, "bear": 0-100}
    },
    "winningArguments": ["Key winning point 1", "Key winning point 2", "Key winning point 3"],
    "summary": "One paragraph summary of the debate outcome and why the winner prevailed"
}

Respond ONLY with valid JSON.`;

        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('AI request timeout')), AI_REQUEST_TIMEOUT);
            });

            const result = await Promise.race([
                model.generateContent(prompt),
                timeoutPromise
            ]);

            const text = result.response.text();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');

            const parsed = JSON.parse(jsonMatch[0]);
            return this.parseDebateResponse(parsed, request);
        } catch (error: any) {
            logger.error('Gemini debate failed:', { error: error.message });
            throw new Error(`AI debate failed: ${error.message}`);
        }
    }

    /**
     * Parse and validate debate response
     */
    private parseDebateResponse(parsed: any, request: DebateRequest): DebateResult {
        const winner = VALID_WINNERS.includes(parsed.winner) ? parsed.winner : 'draw';

        const turns: DebateTurn[] = Array.isArray(parsed.turns)
            ? parsed.turns.slice(0, 10).map((t: any) => ({
                speaker: t.speaker === 'bull' || t.speaker === 'bear' ? t.speaker : 'bull',
                analystId: t.speaker === 'bull' ? request.bullAnalysis.analystId : request.bearAnalysis.analystId,
                analystName: typeof t.analystName === 'string' ? t.analystName.slice(0, 50) : 'Unknown',
                argument: typeof t.argument === 'string' ? t.argument.slice(0, 1000) : '',
                strength: Math.min(10, Math.max(1, Number(t.strength) || 5)),
                dataPointsReferenced: Array.isArray(t.dataPointsReferenced)
                    ? t.dataPointsReferenced.filter((d: any) => typeof d === 'string').slice(0, 10)
                    : [],
            }))
            : [];

        const scores: DebateScores = {
            bullScore: Math.min(100, Math.max(0, Number(parsed.scores?.bullScore) || 50)),
            bearScore: Math.min(100, Math.max(0, Number(parsed.scores?.bearScore) || 50)),
            dataQuality: {
                bull: Math.min(100, Math.max(0, Number(parsed.scores?.dataQuality?.bull) || 50)),
                bear: Math.min(100, Math.max(0, Number(parsed.scores?.dataQuality?.bear) || 50)),
            },
            logicCoherence: {
                bull: Math.min(100, Math.max(0, Number(parsed.scores?.logicCoherence?.bull) || 50)),
                bear: Math.min(100, Math.max(0, Number(parsed.scores?.logicCoherence?.bear) || 50)),
            },
            riskAcknowledgment: {
                bull: Math.min(100, Math.max(0, Number(parsed.scores?.riskAcknowledgment?.bull) || 50)),
                bear: Math.min(100, Math.max(0, Number(parsed.scores?.riskAcknowledgment?.bear) || 50)),
            },
            catalystIdentification: {
                bull: Math.min(100, Math.max(0, Number(parsed.scores?.catalystIdentification?.bull) || 50)),
                bear: Math.min(100, Math.max(0, Number(parsed.scores?.catalystIdentification?.bear) || 50)),
            },
        };

        return {
            matchId: `${request.round}-${Date.now()}`,
            round: request.round,
            turns,
            winner: winner as DebateResult['winner'],
            scores,
            winningArguments: Array.isArray(parsed.winningArguments)
                ? parsed.winningArguments.filter((a: any) => typeof a === 'string').slice(0, 5)
                : [],
            summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 500) : '',
        };
    }


    /**
     * Run a tournament-style debate system
     * Pairs bulls vs bears and determines a champion
     */
    async runTournament(
        analyses: AnalysisResult[],
        marketData: { price: number; change24h: number; volume24h?: number },
        symbol: string,
        userId?: string
    ): Promise<TournamentBracket> {
        if (analyses.length < 2) {
            return { quarterfinals: [], semifinals: [], final: null, champion: analyses[0] || null };
        }

        // Categorize by recommendation
        const bulls = analyses.filter(a => ['strong_buy', 'buy'].includes(a.recommendation));
        const bears = analyses.filter(a => ['strong_sell', 'sell'].includes(a.recommendation));
        const neutral = analyses.filter(a => a.recommendation === 'hold');

        // Distribute neutrals
        for (const n of neutral) {
            if (bulls.length <= bears.length) bulls.push(n);
            else bears.push(n);
        }

        // Sort by confidence
        bulls.sort((a, b) => b.confidence - a.confidence);
        bears.sort((a, b) => b.confidence - a.confidence);

        const bracket: TournamentBracket = { quarterfinals: [], semifinals: [], final: null, champion: null };

        // Create quarterfinal pairings (up to 4 matches)
        const numQuarters = Math.min(4, Math.min(bulls.length, bears.length));

        for (let i = 0; i < numQuarters; i++) {
            try {
                const debate = await this.generateDebate({
                    symbol,
                    bullAnalysis: bulls[i],
                    bearAnalysis: bears[i],
                    round: 'quarterfinal',
                    marketData,
                }, userId);
                bracket.quarterfinals.push(debate);
                await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit
            } catch (err: any) {
                logger.warn(`Quarterfinal ${i + 1} failed:`, err.message);
            }
        }

        // Get quarterfinal winners for semifinals
        const qfWinners = bracket.quarterfinals
            .filter(d => d.winner !== 'draw')
            .map(d => d.winner === 'bull'
                ? analyses.find(a => a.analystId === d.turns[0]?.analystId)
                : analyses.find(a => a.analystId === d.turns[1]?.analystId))
            .filter((a): a is AnalysisResult => a !== undefined);

        // Semifinals (if we have enough winners)
        if (qfWinners.length >= 2) {
            // Re-categorize winners
            const semiBulls = qfWinners.filter(a => ['strong_buy', 'buy', 'hold'].includes(a.recommendation));
            const semiBears = qfWinners.filter(a => ['strong_sell', 'sell'].includes(a.recommendation));

            // Ensure we have opponents
            if (semiBulls.length === 0) semiBulls.push(...qfWinners.slice(0, 1));
            if (semiBears.length === 0) semiBears.push(...qfWinners.slice(-1));

            const numSemis = Math.min(2, Math.min(semiBulls.length, semiBears.length));

            for (let i = 0; i < numSemis; i++) {
                try {
                    const debate = await this.generateDebate({
                        symbol,
                        bullAnalysis: semiBulls[i],
                        bearAnalysis: semiBears[i],
                        round: 'semifinal',
                        marketData,
                    }, userId);
                    bracket.semifinals.push(debate);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (err: any) {
                    logger.warn(`Semifinal ${i + 1} failed:`, err.message);
                }
            }
        }

        // Final
        const sfWinners = bracket.semifinals
            .filter(d => d.winner !== 'draw')
            .map(d => {
                const bullId = d.turns.find(t => t.speaker === 'bull')?.analystId;
                const bearId = d.turns.find(t => t.speaker === 'bear')?.analystId;
                return d.winner === 'bull'
                    ? analyses.find(a => a.analystId === bullId)
                    : analyses.find(a => a.analystId === bearId);
            })
            .filter((a): a is AnalysisResult => a !== undefined);

        if (sfWinners.length >= 2) {
            try {
                bracket.final = await this.generateDebate({
                    symbol,
                    bullAnalysis: sfWinners[0],
                    bearAnalysis: sfWinners[1],
                    round: 'final',
                    marketData,
                }, userId);

                const finalBullId = bracket.final.turns.find(t => t.speaker === 'bull')?.analystId;
                const finalBearId = bracket.final.turns.find(t => t.speaker === 'bear')?.analystId;
                bracket.champion = bracket.final.winner === 'bull'
                    ? analyses.find(a => a.analystId === finalBullId) || null
                    : analyses.find(a => a.analystId === finalBearId) || null;
            } catch (err: any) {
                logger.warn('Final failed:', err.message);
            }
        } else if (qfWinners.length > 0) {
            // Pick highest confidence winner as champion
            bracket.champion = qfWinners.sort((a, b) => b.confidence - a.confidence)[0];
        }

        // Log tournament result
        if (userId && bracket.champion) {
            await aiLogService.createLog(
                userId, 'decision', 'tournament',
                { symbol, debates: bracket.quarterfinals.length + bracket.semifinals.length + (bracket.final ? 1 : 0) },
                { champion: bracket.champion.analystId, recommendation: bracket.champion.recommendation },
                `Tournament champion: ${bracket.champion.analystName} (${bracket.champion.recommendation})`
            );
        }

        return bracket;
    }

    /**
     * Generate a trading signal based on tournament results
     */
    async generateTradingSignal(
        symbol: string,
        analyses: AnalysisResult[],
        tournament?: TournamentBracket,
        userId?: string
    ): Promise<{
        action: 'buy' | 'sell' | 'hold';
        confidence: number;
        reasoning: string;
        champion?: AnalysisResult;
        consensus: { bulls: number; bears: number; neutral: number };
    }> {
        // Calculate consensus
        const bulls = analyses.filter(a => ['strong_buy', 'buy'].includes(a.recommendation)).length;
        const bears = analyses.filter(a => ['strong_sell', 'sell'].includes(a.recommendation)).length;
        const neutral = analyses.length - bulls - bears;
        const avgConfidence = analyses.length > 0
            ? analyses.reduce((sum, a) => sum + a.confidence, 0) / analyses.length
            : 50;

        // Determine action based on consensus and champion
        let action: 'buy' | 'sell' | 'hold' = 'hold';
        let confidence = avgConfidence;

        if (tournament?.champion) {
            const champRec = tournament.champion.recommendation;
            if (['strong_buy', 'buy'].includes(champRec)) action = 'buy';
            else if (['strong_sell', 'sell'].includes(champRec)) action = 'sell';
            confidence = (avgConfidence + tournament.champion.confidence) / 2;
        } else if (bulls > bears + neutral) {
            action = 'buy';
        } else if (bears > bulls + neutral) {
            action = 'sell';
        }

        // Generate reasoning
        const displaySymbol = symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
        let reasoning = `${displaySymbol}: ${bulls} bullish, ${bears} bearish, ${neutral} neutral analysts. `;

        if (tournament?.champion) {
            reasoning += `Tournament champion ${tournament.champion.analystName} recommends ${tournament.champion.recommendation.replace('_', ' ')}. `;
            reasoning += tournament.champion.thesis;
        } else {
            reasoning += `Consensus leans ${action}.`;
        }

        if (userId) {
            await aiLogService.createLog(
                userId, 'decision', 'signal-generator',
                { symbol, analysisCount: analyses.length },
                { action, confidence },
                `Signal: ${action.toUpperCase()} (${confidence.toFixed(0)}%)`
            );
        }

        return {
            action,
            confidence: Math.round(confidence),
            reasoning,
            champion: tournament?.champion || undefined,
            consensus: { bulls, bears, neutral },
        };
    }

    /**
     * Check if service is configured
     */
    isConfigured(): boolean {
        return !!config.geminiApiKey;
    }

    /**
     * Get all analyst profiles
     */
    getAnalysts() {
        return Object.values(ANALYST_PROFILES);
    }

    /**
     * Get analyst by methodology
     */
    getAnalystByMethodology(methodology: AnalystMethodology) {
        return ANALYST_PROFILES[methodology];
    }

    /**
     * Validate that a symbol is an approved WEEX trading pair
     */
    isApprovedPair(symbol: string): boolean {
        return WEEX_APPROVED_PAIRS.includes(symbol.toLowerCase() as WeexApprovedPair);
    }

    /**
     * Get list of approved trading pairs
     */
    getApprovedPairs(): readonly string[] {
        return WEEX_APPROVED_PAIRS;
    }

    // ═══════════════════════════════════════════════════════════════════════════════
    // TRADING METHODS - Generate executable WEEX orders
    // ═══════════════════════════════════════════════════════════════════════════════

    /**
     * Generate a complete trading decision with executable order
     * This is the main method for live trading integration
     */
    async generateTradingDecision(
        marketData: ExtendedMarketData,
        accountBalance: number,
        existingPosition?: { side: 'LONG' | 'SHORT'; size: number },
        userId?: string
    ): Promise<TradingDecision> {
        // Validate symbol is approved for trading
        if (!this.isApprovedPair(marketData.symbol)) {
            throw new Error(`Symbol ${marketData.symbol} is not an approved WEEX trading pair. Approved pairs: ${WEEX_APPROVED_PAIRS.join(', ')}`);
        }

        // Generate all analyses
        const analyses = await this.generateAllAnalyses({
            symbol: marketData.symbol,
            currentPrice: marketData.currentPrice,
            high24h: marketData.high24h,
            low24h: marketData.low24h,
            volume24h: marketData.volume24h,
            change24h: marketData.change24h,
        }, userId);

        // Run tournament to determine champion
        const tournament = await this.runTournament(
            analyses,
            {
                price: marketData.currentPrice,
                change24h: marketData.change24h,
                volume24h: marketData.volume24h,
            },
            marketData.symbol,
            userId
        );

        // Calculate consensus
        const bulls = analyses.filter(a => ['strong_buy', 'buy'].includes(a.recommendation)).length;
        const bears = analyses.filter(a => ['strong_sell', 'sell'].includes(a.recommendation)).length;
        const neutral = analyses.length - bulls - bears;
        const avgConfidence = analyses.reduce((sum, a) => sum + a.confidence, 0) / (analyses.length || 1);

        // Determine if we should trade
        const champion = tournament.champion;
        const shouldTrade = this.shouldExecuteTrade(champion, bulls, bears, neutral, avgConfidence, existingPosition);

        // Calculate risk management parameters
        const riskManagement = this.calculateRiskManagement(
            marketData,
            champion,
            accountBalance,
            avgConfidence
        );

        // Generate order if we should trade
        let order: TradeOrder | undefined;
        if (shouldTrade && champion) {
            order = this.generateOrder(
                marketData,
                champion,
                riskManagement,
                existingPosition
            );
        }

        // Generate AI log for WEEX compliance
        const aiLog = this.generateAILog(
            marketData,
            analyses,
            tournament,
            champion,
            shouldTrade,
            order
        );

        return {
            shouldTrade,
            order,
            aiLog,
            analysis: {
                champion,
                consensus: { bulls, bears, neutral },
                confidence: Math.round(avgConfidence),
            },
            riskManagement,
        };
    }

    /**
     * Determine if we should execute a trade based on analysis
     */
    private shouldExecuteTrade(
        champion: AnalysisResult | null,
        bulls: number,
        bears: number,
        neutral: number,
        avgConfidence: number,
        existingPosition?: { side: 'LONG' | 'SHORT'; size: number }
    ): boolean {
        // No champion = no trade
        if (!champion) return false;

        // HOLD recommendation = no new trade
        if (champion.recommendation === 'hold') return false;

        // Low confidence = no trade
        if (avgConfidence < 55) return false;

        // Check if champion has sufficient confidence
        if (champion.confidence < 60) return false;

        // Check consensus alignment
        const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);
        const isBearish = ['strong_sell', 'sell'].includes(champion.recommendation);

        // Champion should align with at least some consensus
        if (isBullish && bulls < 2) return false;
        if (isBearish && bears < 2) return false;

        // Don't open opposite position if already positioned
        if (existingPosition) {
            if (existingPosition.side === 'LONG' && isBearish) {
                // Could close long, but don't open short
                return true; // Will generate close order
            }
            if (existingPosition.side === 'SHORT' && isBullish) {
                // Could close short, but don't open long
                return true; // Will generate close order
            }
            // Already positioned in same direction
            return false;
        }

        return true;
    }

    /**
     * Calculate risk management parameters
     */
    private calculateRiskManagement(
        marketData: ExtendedMarketData,
        champion: AnalysisResult | null,
        accountBalance: number,
        avgConfidence: number
    ): TradingDecision['riskManagement'] {
        const price = marketData.currentPrice;

        // Default conservative values
        let positionSizePercent = 2; // 2% of portfolio
        let leverage = 5;
        let takeProfitPrice = price * 1.05;
        let stopLossPrice = price * 0.97;

        if (champion) {
            // Position size based on champion's positionSize (1-10 scale)
            // 1-2 = 1%, 3-4 = 2%, 5-6 = 3%, 7-8 = 4%, 9-10 = 5%
            positionSizePercent = Math.min(5, Math.max(1, Math.ceil(champion.positionSize / 2)));

            // Adjust for confidence
            if (avgConfidence < 60) positionSizePercent = Math.max(1, positionSizePercent - 1);
            if (avgConfidence > 80) positionSizePercent = Math.min(5, positionSizePercent + 1);

            // Leverage based on risk level
            switch (champion.riskLevel) {
                case 'low': leverage = 10; break;
                case 'medium': leverage = 5; break;
                case 'high': leverage = 3; break;
                case 'very_high': leverage = 2; break;
            }

            // TP/SL from champion's price targets
            const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);
            if (isBullish) {
                takeProfitPrice = champion.priceTarget.base;
                stopLossPrice = champion.priceTarget.bear;
            } else {
                // For bearish, invert the targets
                takeProfitPrice = champion.priceTarget.bear;
                stopLossPrice = champion.priceTarget.bull;
            }
        }

        // Calculate risk/reward ratio
        const potentialProfit = Math.abs(takeProfitPrice - price);
        const potentialLoss = Math.abs(price - stopLossPrice);
        const riskRewardRatio = potentialLoss > 0 ? potentialProfit / potentialLoss : 1;

        return {
            positionSizePercent,
            leverage,
            takeProfitPrice,
            stopLossPrice,
            riskRewardRatio,
        };
    }

    /**
     * Generate WEEX-compatible order
     */
    private generateOrder(
        marketData: ExtendedMarketData,
        champion: AnalysisResult,
        riskManagement: TradingDecision['riskManagement'],
        existingPosition?: { side: 'LONG' | 'SHORT'; size: number }
    ): TradeOrder {
        const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);

        // Determine order type
        let orderType: WeexOrderType;
        let size: number;

        if (existingPosition) {
            // Close existing position
            if (existingPosition.side === 'LONG' && !isBullish) {
                orderType = '3'; // Close long
                size = existingPosition.size;
            } else if (existingPosition.side === 'SHORT' && isBullish) {
                orderType = '4'; // Close short
                size = existingPosition.size;
            } else {
                // Shouldn't happen, but default to opening
                orderType = isBullish ? '1' : '2';
                size = 0.01; // Minimum size
            }
        } else {
            // Open new position
            orderType = isBullish ? '1' : '2'; // 1=Open long, 2=Open short
            // Calculate size based on position size percent (simplified)
            size = 0.01; // Will be calculated properly by the trading service
        }

        // Generate unique client order ID
        const clientOid = `ha_${champion.analystId}_${Date.now()}`;

        return {
            symbol: marketData.symbol,
            client_oid: clientOid.slice(0, 40),
            size: size.toString(),
            type: orderType,
            order_type: '0', // Normal limit order
            match_price: '1', // Market price for immediate execution
            price: marketData.currentPrice.toString(),
            presetTakeProfitPrice: riskManagement.takeProfitPrice.toString(),
            presetStopLossPrice: riskManagement.stopLossPrice.toString(),
            marginMode: 1, // Cross mode
        };
    }

    /**
     * Generate AI log for WEEX compliance
     */
    private generateAILog(
        marketData: ExtendedMarketData,
        analyses: AnalysisResult[],
        tournament: TournamentBracket,
        champion: AnalysisResult | null,
        shouldTrade: boolean,
        order?: TradeOrder
    ): WeexAILog {
        const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();

        // Build input data
        const input: Record<string, any> = {
            symbol: displaySymbol,
            marketData: {
                price: marketData.currentPrice,
                high24h: marketData.high24h,
                low24h: marketData.low24h,
                change24h: `${marketData.change24h.toFixed(2)}%`,
                volume24h: marketData.volume24h,
            },
            analystsConsulted: analyses.map(a => ({
                name: a.analystName,
                methodology: a.methodology,
                recommendation: a.recommendation,
                confidence: a.confidence,
            })),
            tournamentResults: {
                quarterfinalsPlayed: tournament.quarterfinals.length,
                semifinalsPlayed: tournament.semifinals.length,
                finalPlayed: tournament.final !== null,
                champion: champion ? champion.analystName : 'None',
            },
        };

        // Build output data
        const output: Record<string, any> = {
            decision: shouldTrade ? 'TRADE' : 'NO_TRADE',
            signal: champion ? champion.recommendation.toUpperCase().replace('_', ' ') : 'HOLD',
            confidence: champion?.confidence || 0,
            champion: champion ? {
                analyst: champion.analystName,
                methodology: champion.methodology,
                thesis: champion.thesis,
                priceTargets: champion.priceTarget,
            } : null,
        };

        if (order) {
            output.order = {
                type: order.type === '1' ? 'OPEN_LONG' : order.type === '2' ? 'OPEN_SHORT' : order.type === '3' ? 'CLOSE_LONG' : 'CLOSE_SHORT',
                size: order.size,
                takeProfit: order.presetTakeProfitPrice,
                stopLoss: order.presetStopLossPrice,
            };
        }

        // Build explanation (max 500 words)
        let explanation = `Hypothesis Arena AI analyzed ${displaySymbol}/USDT using 8 specialized analyst agents. `;

        const bulls = analyses.filter(a => ['strong_buy', 'buy'].includes(a.recommendation)).length;
        const bears = analyses.filter(a => ['strong_sell', 'sell'].includes(a.recommendation)).length;
        const neutral = analyses.length - bulls - bears;

        explanation += `Consensus: ${bulls} bullish, ${bears} bearish, ${neutral} neutral. `;

        if (tournament.quarterfinals.length > 0) {
            explanation += `Tournament conducted with ${tournament.quarterfinals.length} quarterfinal debates. `;
        }

        if (champion) {
            explanation += `Champion: ${champion.analystName} (${champion.analystTitle}) with ${champion.confidence}% confidence. `;
            explanation += `Thesis: ${champion.thesis} `;
            const catalysts = champion.catalysts?.slice(0, 2) || [];
            const risks = champion.risks?.slice(0, 2) || [];
            if (catalysts.length > 0) {
                explanation += `Key catalysts: ${catalysts.join('; ')}. `;
            }
            if (risks.length > 0) {
                explanation += `Risks acknowledged: ${risks.join('; ')}. `;
            }
        }

        if (shouldTrade && order) {
            const orderAction = order.type === '1' ? 'opening long' : order.type === '2' ? 'opening short' : order.type === '3' ? 'closing long' : 'closing short';
            explanation += `Decision: ${orderAction} position with TP at ${order.presetTakeProfitPrice} and SL at ${order.presetStopLossPrice}.`;
        } else {
            explanation += `Decision: No trade executed due to insufficient conviction or unfavorable risk/reward.`;
        }

        return {
            stage: shouldTrade ? 'Order Execution' : 'Decision Making',
            model: 'Gemini-2.0-Flash + Hypothesis Arena Multi-Agent System',
            input,
            output,
            // WEEX requires max 500 words - truncate by words more accurately
            explanation: this.truncateToWordLimit(explanation, 480),
        };
    }

    /**
     * Truncate text to a maximum word count
     */
    private truncateToWordLimit(text: string, maxWords: number): string {
        const words = text.split(/\s+/).filter(w => w.length > 0);
        if (words.length <= maxWords) return text;
        return words.slice(0, maxWords).join(' ') + '...';
    }

    /**
     * Generate analysis with extended market data (includes funding rate, open interest, etc.)
     */
    async generateAnalysisWithExtendedData(
        marketData: ExtendedMarketData,
        analystId?: string,
        userId?: string
    ): Promise<AnalysisResult> {
        const model = this.getModel();

        // Determine which analyst to use
        let methodology: AnalystMethodology;
        if (analystId) {
            methodology = METHODOLOGY_ORDER.find(m => ANALYST_PROFILES[m].id === analystId) || 'value';
        } else {
            methodology = METHODOLOGY_ORDER[Math.floor(Math.random() * METHODOLOGY_ORDER.length)];
        }

        const { profile, systemPrompt } = this.getAnalystWithPrompt(methodology);
        const displaySymbol = marketData.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();

        // Build extended market data section
        let extendedDataSection = '';
        if (marketData.fundingRate !== undefined) {
            extendedDataSection += `- Funding Rate: ${(marketData.fundingRate * 100).toFixed(4)}%\n`;
        }
        if (marketData.openInterest !== undefined) {
            extendedDataSection += `- Open Interest: ${marketData.openInterest.toLocaleString()}\n`;
        }
        if (marketData.markPrice !== undefined) {
            extendedDataSection += `- Mark Price: ${marketData.markPrice.toFixed(marketData.markPrice < 1 ? 6 : 2)}\n`;
        }
        if (marketData.bestBid !== undefined && marketData.bestAsk !== undefined && marketData.bestBid > 0) {
            const spread = ((marketData.bestAsk - marketData.bestBid) / marketData.bestBid * 100).toFixed(4);
            extendedDataSection += `- Bid/Ask Spread: ${spread}%\n`;
        }

        const prompt = `${systemPrompt}

═══════════════════════════════════════════════════════════════════════════════
ANALYZE THIS CRYPTO FUTURES CONTRACT: ${displaySymbol}/USDT (WEEX Perpetual)
═══════════════════════════════════════════════════════════════════════════════

CORE MARKET DATA:
- Current Price: ${marketData.currentPrice.toFixed(marketData.currentPrice < 1 ? 6 : 2)}
- 24h High: ${marketData.high24h.toFixed(marketData.high24h < 1 ? 6 : 2)}
- 24h Low: ${marketData.low24h.toFixed(marketData.low24h < 1 ? 6 : 2)}
- 24h Change: ${marketData.change24h >= 0 ? '+' : ''}${marketData.change24h.toFixed(2)}%
- 24h Volume: ${marketData.volume24h.toLocaleString()}

DERIVATIVES DATA:
${extendedDataSection || '- No additional derivatives data available'}

Apply your ${profile.title} methodology rigorously. Consider your focus areas:
${profile.focusAreas.map(f => `- ${f}`).join('\n')}

Acknowledge your biases:
${profile.biases.map(b => `- ${b}`).join('\n')}

THIS IS FOR LIVE FUTURES TRADING. Your analysis will directly influence trade execution.
Be precise with price targets and risk levels.

Respond with valid JSON in this EXACT structure:
{
    "recommendation": "STRONG_BUY" | "BUY" | "HOLD" | "SELL" | "STRONG_SELL",
    "confidence": 0-100,
    "priceTarget": {
        "bull": number (optimistic target),
        "base": number (expected target),
        "bear": number (pessimistic target / stop loss level)
    },
    "timeHorizon": "string (e.g., '4 hours', '1 day', '1 week')",
    "positionSize": 1-10 (1-2=speculative, 5-6=normal, 9-10=high conviction),
    "bullCase": ["Specific argument 1 with DATA", "Argument 2", "Argument 3"],
    "bearCase": ["Honest risk 1 with quantification", "Risk 2", "Risk 3"],
    "keyMetrics": {"Metric 1": "Value with context", "Metric 2": "Value"},
    "catalysts": ["Event 1 (Timing) - Expected impact", "Event 2"],
    "summary": "One sentence thesis that could stand alone"
}

Respond ONLY with valid JSON.`;

        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('AI request timeout')), AI_REQUEST_TIMEOUT);
            });

            const result = await Promise.race([
                model.generateContent(prompt),
                timeoutPromise
            ]);

            const text = result.response.text();
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');

            const parsed = JSON.parse(jsonMatch[0]);
            return this.parseAnalysisResponse(parsed, profile, methodology, marketData.currentPrice);
        } catch (error: any) {
            logger.error('Gemini extended analysis failed:', { error: error.message, analyst: profile.id });
            throw new Error(`AI analysis failed: ${error.message}`);
        }
    }
}

export const geminiService = new GeminiService();
