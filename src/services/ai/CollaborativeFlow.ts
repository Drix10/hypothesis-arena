/**
 * Collaborative Trading Flow - Simplified pipeline with PARALLEL ANALYSIS
 * 1. Market Scan - Fetch data for all coins + indicators
 * 2. Parallel Analysis - 4 analysts analyze independently in parallel
 * 3. Judge Decision - Compare all 4 and pick winner
 * 4. Execution - Place trade on WEEX
 * AI CALLS: 5 (4 analysts + 1 judge), LATENCY: ~25 seconds
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { PrismaClient } from '@prisma/client';
import { GLOBAL_RISK_LIMITS } from '../../constants/analyst/riskLimits';
import {
    AnalystId,
    AnalystOutput,
    ParallelAnalysisResult,
    JudgeDecision,
    TournamentResult,
    validateAnalystOutput,
    normalizeAnalystOutput,
    validateJudgeOutput,
} from '../../types/analyst';
import { TradingContext } from '../../types/context';
import { buildAnalystPrompt, buildAnalystUserMessage, AnalystPromptVars } from '../../constants/prompts/analystPrompt';
import { buildJudgeSystemPrompt, buildJudgeUserMessage } from '../../constants/prompts/judgePrompt';
import { getAntiChurnService } from '../trading/AntiChurnService';
import { getContextBuilder } from '../context/ContextBuilder';
import { aiService, SchemaType, ResponseSchema } from './AIService';
import { getAnalystWeights } from '../journal';
import { debateService } from './DebateService';

// =============================================================================
// TYPES
// =============================================================================

export interface FinalDecision {
    action: 'BUY' | 'SELL' | 'HOLD' | 'CLOSE' | 'REDUCE';
    symbol: string;
    allocation_usd: number;
    leverage: number;
    tp_price: number | null;
    sl_price: number | null;
    exit_plan: string;
    confidence: number;
    rationale: string;
    winner: AnalystId | 'NONE';
    warnings: string[];
    analysisResult: ParallelAnalysisResult;
    debateResult: TournamentResult | null;
    judgeDecision: JudgeDecision;
}

export interface Position {
    symbol: string;
    side: 'LONG' | 'SHORT';
    size: number;
    entryPrice: number;
    currentPrice: number;
    leverage: number;
    unrealizedPnl: number;
    liquidationPrice?: number;
}

export interface MarketDataInput {
    symbol: string;
    currentPrice: number;
    high24h: number;
    low24h: number;
    volume24h: number;
    change24h: number;
    fundingRate: number;
    openInterest: number | null;
}

// =============================================================================
// JSON SCHEMAS FOR STRUCTURED OUTPUT
// =============================================================================

/**
 * Analyst recommendation schema (nested object)
 */
const ANALYST_RECOMMENDATION_SCHEMA: ResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        action: {
            type: SchemaType.STRING,
            enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'],
            description: 'Trading action to take',
        },
        symbol: {
            type: SchemaType.STRING,
            nullable: true,
            description: 'Trading symbol (e.g., cmt_btcusdt). Can be null for HOLD.',
        },
        allocation_usd: {
            type: SchemaType.NUMBER,
            description: 'Notional exposure in USD (MUST be 0 for HOLD)',
        },
        leverage: {
            type: SchemaType.NUMBER,
            description: 'Leverage multiplier (1-20, MUST be 0 for HOLD)',
        },
        tp_price: {
            type: SchemaType.NUMBER,
            nullable: true,
            description: 'Take profit price (MUST be null for HOLD)',
        },
        sl_price: {
            type: SchemaType.NUMBER,
            nullable: true,
            description: 'Stop loss price (MUST be null for HOLD)',
        },
        exit_plan: {
            type: SchemaType.STRING,
            description: 'Exit conditions and invalidation triggers (can be empty for HOLD)',
        },
        confidence: {
            type: SchemaType.NUMBER,
            description: 'Confidence level 0-100',
        },
        rationale: {
            type: SchemaType.STRING,
            description: 'One-line summary of the trade thesis',
        },
    },
    required: ['action', 'symbol', 'allocation_usd', 'leverage', 'tp_price', 'sl_price', 'exit_plan', 'confidence', 'rationale'],
};

/**
 * Full analyst output schema
 */
const ANALYST_OUTPUT_RESPONSE_SCHEMA: ResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        reasoning: {
            type: SchemaType.STRING,
            description: 'Detailed step-by-step analysis',
        },
        recommendation: ANALYST_RECOMMENDATION_SCHEMA,
        rl_validation: {
            type: SchemaType.OBJECT,
            nullable: true,
            properties: {
                q_long: { type: SchemaType.NUMBER, description: 'Q-value for LONG' },
                q_short: { type: SchemaType.NUMBER, description: 'Q-value for SHORT' },
                q_hold: { type: SchemaType.NUMBER, description: 'Q-value for HOLD' },
                regret: { type: SchemaType.NUMBER, description: 'Opportunity cost of NOT trading' },
                expected_value: { type: SchemaType.NUMBER, nullable: true, description: 'Expected value of the trade' },
                sharpe: { type: SchemaType.NUMBER, nullable: true, description: 'Sharpe ratio of the trade' },
            },
            required: ['q_long', 'q_short', 'q_hold', 'regret'],
        },
    },
    required: ['reasoning', 'recommendation'],
};

/**
 * Judge adjustments schema (nullable object)
 */
const JUDGE_ADJUSTMENTS_SCHEMA: ResponseSchema = {
    type: SchemaType.OBJECT,
    nullable: true,
    properties: {
        leverage: {
            type: SchemaType.NUMBER,
            description: 'Adjusted leverage (1-20). Only for BUY/SELL.',
        },
        allocation_usd: {
            type: SchemaType.NUMBER,
            description: 'Adjusted allocation in USD. Only for BUY/SELL.',
        },
        sl_price: {
            type: SchemaType.NUMBER,
            description: 'Adjusted stop loss price. Only for BUY/SELL.',
        },
        tp_price: {
            type: SchemaType.NUMBER,
            description: 'Adjusted take profit price. Only for BUY/SELL.',
        },
    },
};

/**
 * Judge output schema
 */
const JUDGE_OUTPUT_RESPONSE_SCHEMA: ResponseSchema = {
    type: SchemaType.OBJECT,
    properties: {
        winner: {
            type: SchemaType.STRING,
            enum: ['jim', 'ray', 'karen', 'quant', 'NONE'],
            description: 'Winning analyst ID or NONE',
        },
        reasoning: {
            type: SchemaType.STRING,
            description: 'Explanation of the decision',
        },
        adjustments: JUDGE_ADJUSTMENTS_SCHEMA,
        warnings: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: 'List of warnings or concerns',
        },
        final_action: {
            type: SchemaType.STRING,
            enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'],
            description: 'Final trading action',
        },
        final_recommendation: {
            ...ANALYST_RECOMMENDATION_SCHEMA,
            nullable: true,
            description: 'Final recommendation (null if HOLD with no winner)',
        },
    },
    required: ['winner', 'reasoning', 'adjustments', 'warnings', 'final_action', 'final_recommendation'],
};

// =============================================================================
// COLLABORATIVE FLOW SERVICE v5.0.0
// =============================================================================

export class CollaborativeFlowService {
    private prisma: PrismaClient;
    private initialized: boolean = false;

    constructor(prisma: PrismaClient) {
        this.prisma = prisma;
    }

    /**
     * Initialize the service
     * Validates configuration with centralized AIService
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        if (!aiService.isConfigured()) {
            throw new Error(`AI provider ${config.ai.provider} not configured. Check API keys in .env`);
        }

        // Initialize hybrid mode if enabled
        if (config.ai.hybridMode) {
            await aiService.initializeHybridMode();
        }

        this.initialized = true;

        if (aiService.isHybridMode()) {
            logger.info(`CollaborativeFlowService initialized in HYBRID mode`);
        } else {
            logger.info(`CollaborativeFlowService initialized with ${aiService.getProvider()} provider`);
        }
    }

    /**
     * Run the full parallel analysis pipeline
     */
    async runParallelAnalysis(
        accountBalance: number,
        positions: Position[],
        marketDataMap: Map<string, MarketDataInput>
    ): Promise<FinalDecision> {
        await this.initialize();

        if (!Number.isFinite(accountBalance) || accountBalance < 0) {
            logger.error(`CRITICAL: Invalid accountBalance: ${accountBalance}. Cannot determine trading capacity.`);
            return {
                action: 'HOLD',
                symbol: '',
                allocation_usd: 0,
                leverage: 0,
                tp_price: null,
                sl_price: null,
                exit_plan: '',
                confidence: 0,
                rationale: `Invalid account balance: ${accountBalance}. Cannot safely trade.`,
                winner: 'NONE',
                warnings: ['Account balance invalid or unavailable - trading suspended'],
                analysisResult: {
                    jim: null,
                    ray: null,
                    karen: null,
                    quant: null,
                    timestamp: Date.now(),
                    errors: [{ analyst: 'system', error: 'Invalid account balance' }],
                },
                judgeDecision: {
                    winner: 'NONE',
                    reasoning: 'Cannot trade with invalid account balance',
                    adjustments: null,
                    warnings: ['Account balance invalid'],
                    final_action: 'HOLD',
                    final_recommendation: null,
                },
                debateResult: null,
            };
        }
        if (!positions || !Array.isArray(positions)) {
            logger.warn('Invalid positions array, using empty array');
            positions = [];
        }
        if (!marketDataMap || !(marketDataMap instanceof Map) || marketDataMap.size === 0) {
            logger.error('Empty or invalid marketDataMap - cannot run analysis');
            return {
                action: 'HOLD',
                symbol: '',
                allocation_usd: 0,
                leverage: 0,
                tp_price: null,
                sl_price: null,
                exit_plan: '',
                confidence: 0,
                rationale: 'No market data available',
                winner: 'NONE',
                warnings: ['Market data unavailable'],
                analysisResult: {
                    jim: null,
                    ray: null,
                    karen: null,
                    quant: null,
                    timestamp: Date.now(),
                    errors: [{ analyst: 'system', error: 'No market data' }],
                },
                judgeDecision: {
                    winner: 'NONE',
                    reasoning: 'No market data available',
                    adjustments: null,
                    warnings: ['Market data unavailable'],
                    final_action: 'HOLD',
                    final_recommendation: null,
                },
                debateResult: null,
            };
        }

        const startTime = Date.now();
        logger.info('🚀 Starting parallel analysis pipeline...');

        markOperationStart();

        try {
            const contextBuilder = getContextBuilder(this.prisma);
            let context: TradingContext;
            try {
                context = await contextBuilder.buildContext(
                    accountBalance,
                    positions,
                    async (symbol) => {
                        const data = marketDataMap.get(symbol);
                        if (!data) {
                            throw new Error(`No market data for ${symbol}`);
                        }
                        return data;
                    }
                );
            } catch (contextError) {
                logger.error('Context builder failed:', contextError);
                return {
                    action: 'HOLD',
                    symbol: '',
                    allocation_usd: 0,
                    leverage: 0,
                    tp_price: null,
                    sl_price: null,
                    exit_plan: '',
                    confidence: 0,
                    rationale: `Context building failed: ${contextError instanceof Error ? contextError.message : 'Unknown error'}`,
                    winner: 'NONE',
                    warnings: ['Context building failed'],
                    analysisResult: {
                        jim: null,
                        ray: null,
                        karen: null,
                        quant: null,
                        timestamp: Date.now(),
                        errors: [{ analyst: 'system', error: 'Context building failed' }],
                    },
                    judgeDecision: {
                        winner: 'NONE',
                        reasoning: 'Context building failed',
                        adjustments: null,
                        warnings: ['Context building failed'],
                        final_action: 'HOLD',
                        final_recommendation: null,
                    },
                    debateResult: null,
                };
            }

            logger.info(`📊 Context built with ${context.market_data.length} assets, ${context.account.positions.length} positions`);

            const analysisResult = await this.runAllAnalysts(context);
            const analysisTime = Date.now() - startTime;
            logger.info(`📊 Parallel analysis completed in ${analysisTime}ms`);

            for (const analystId of ['jim', 'ray', 'karen', 'quant'] as AnalystId[]) {
                const output = analysisResult[analystId];
                if (output) {
                    logger.info(`  ✓ ${analystId}: ${output.recommendation.action} ${output.recommendation.symbol} (${output.recommendation.confidence}%)`);
                } else {
                    logger.warn(`  ✗ ${analystId}: FAILED`);
                }
            }

            // --- DEBATE PHASE ---
            const debateStart = Date.now();
            let debateResult: TournamentResult | null = null;

            // Hard timeout for debate phase (reduced to align with <25s pipeline target)
            const DEBATE_TIMEOUT_MS = Number(process.env.DEBATE_TIMEOUT_MS) || 15000;

            try {
                // Determine the best symbol to debate (the one with the most conflict or highest conviction)
                const symbolStats = new Map<string, { count: number; maxConf: number; actions: Set<string> }>();

                Object.values(analysisResult).forEach(o => {
                    if (o && o.recommendation && o.recommendation.symbol) {
                        const s = o.recommendation.symbol;
                        const stats = symbolStats.get(s) || { count: 0, maxConf: 0, actions: new Set() };
                        stats.count++;
                        stats.maxConf = Math.max(stats.maxConf, o.recommendation.confidence);
                        stats.actions.add(o.recommendation.action);
                        symbolStats.set(s, stats);
                    }
                });

                // Pick symbol with most actions (divergence) first, then by count, then by max conviction
                let debateSymbol = (context.market_data[0]?.asset || 'UNKNOWN');
                let maxDivergence = -1;

                for (const [s, stats] of symbolStats.entries()) {
                    const divergence = stats.actions.size;
                    if (divergence > maxDivergence) {
                        maxDivergence = divergence;
                        debateSymbol = s;
                    } else if (divergence === maxDivergence) {
                        const currentStats = symbolStats.get(debateSymbol);
                        if (!currentStats || stats.count > currentStats.count) {
                            debateSymbol = s;
                        } else if (stats.count === currentStats.count && stats.maxConf > currentStats.maxConf) {
                            debateSymbol = s;
                        }
                    }
                }

                logger.info(`⚖️ Selected ${debateSymbol} for debate tournament (Divergence: ${maxDivergence})`);

                // Consensus check to skip debate and save time (<25s target)
                const stats = symbolStats.get(debateSymbol);
                const isStrongConsensus = stats && stats.count >= 3 && stats.actions.size === 1;

                if (isStrongConsensus) {
                    logger.info(`🤝 Strong consensus for ${debateSymbol} (${stats.count}/4 analysts). Skipping debate to save time.`);
                } else {
                    // Run tournament with timeout
                    debateResult = await Promise.race([
                        debateService.runTournament(debateSymbol, analysisResult, context),
                        new Promise<null>((_, reject) =>
                            setTimeout(() => reject(new Error('Debate tournament timed out')), DEBATE_TIMEOUT_MS)
                        )
                    ]) as TournamentResult;
                }

                const debateTime = Date.now() - debateStart;
                logger.info(`⚖️ Debate tournament completed in ${debateTime}ms with ${debateResult?.debates.length || 0} matches`);
            } catch (debateError) {
                logger.error('Debate tournament failed or timed out:', debateError);
                // Continue without debate result rather than failing the whole pipeline
            }

            const judgeStart = Date.now();
            const judgeDecision = await this.runJudge(context, analysisResult, debateResult);
            const judgeTime = Date.now() - judgeStart;
            logger.info(`⚖️ Judge decision in ${judgeTime}ms: winner=${judgeDecision.winner}, action=${judgeDecision.final_action}`);

            const finalDecision = this.buildFinalDecision(analysisResult, judgeDecision, debateResult);

            const totalTime = Date.now() - startTime;
            logger.info(`✅ Total pipeline time: ${totalTime}ms (target: <25000ms)`);

            return finalDecision;
        } finally {
            markOperationEnd();
        }
    }

    /**
     * Run all 4 analysts in parallel
     */
    private async runAllAnalysts(context: TradingContext): Promise<ParallelAnalysisResult> {
        const promptVars = context.prompt_vars;
        const cleanContext = { ...context };
        delete (cleanContext as any).prompt_vars;

        const contextJson = JSON.stringify(cleanContext, null, 2);
        logger.info(`📊 Context built: ${context.market_data.length} assets, ${context.account.positions.length} positions, JSON size: ${(contextJson.length / 1024).toFixed(2)} KB`);
        const analysts: AnalystId[] = ['jim', 'ray', 'karen', 'quant'];

        const startTime = Date.now();
        const promises = analysts.map(async (analystId) => {
            const analystStart = Date.now();
            const result = await this.runSingleAnalyst(analystId, contextJson, promptVars);
            const duration = Date.now() - analystStart;
            if (result) {
                logger.info(`⏱️ Analyst ${analystId} completed in ${duration}ms (${result.recommendation.action} ${result.recommendation.symbol})`);
            } else {
                logger.warn(`⏱️ Analyst ${analystId} FAILED in ${duration}ms`);
            }
            return result;
        });

        const results = await Promise.allSettled(promises);
        const totalDuration = Date.now() - startTime;
        logger.info(`⏱️ All analysts completed in ${totalDuration}ms (parallel)`);

        const analysisResult: ParallelAnalysisResult = {
            jim: null,
            ray: null,
            karen: null,
            quant: null,
            timestamp: Date.now(),
            errors: [],
        };

        for (let i = 0; i < analysts.length; i++) {
            const analystId = analysts[i];
            const result = results[i];

            if (result.status === 'fulfilled' && result.value) {
                analysisResult[analystId] = result.value;
            } else {
                const error = result.status === 'rejected'
                    ? result.reason?.message || 'Unknown error'
                    : 'No output';
                analysisResult.errors.push({ analyst: analystId, error });
            }
        }

        return analysisResult;
    }

    /**
     * Run a single analyst using centralized AIService with strict JSON schema
     * Routes to provider based on AI_HYBRID_MODE setting
     */
    private async runSingleAnalyst(analystId: AnalystId, contextJson: string, promptVars: AnalystPromptVars = {}): Promise<AnalystOutput | null> {
        const systemPrompt = buildAnalystPrompt(analystId);
        // CRITICAL: We pass promptVars to buildAnalystUserMessage so it's part of the dynamic user message
        const userMessage = buildAnalystUserMessage(contextJson, promptVars);

        // CRITICAL: Add separator for prompt caching - system prompt will be cached
        // The system prompt is now static (promptVars moved to userMessage), maximizing cache hits
        const fullPrompt = systemPrompt + '\n\n---USER---\n\n' + userMessage;

        for (let attempt = 1; attempt <= config.ai.maxRetries; attempt++) {
            try {
                let resultText: string;
                let modelUsed: string;

                if (config.ai.hybridMode) {
                    // Hybrid mode: route to provider based on analyst assignment
                    const result = await aiService.generateContentForAnalyst(analystId, {
                        prompt: fullPrompt,
                        schema: ANALYST_OUTPUT_RESPONSE_SCHEMA,
                        temperature: config.ai.temperature,
                        maxOutputTokens: 2048, // Reduced from config.ai.maxOutputTokens (65k) for latency
                        label: `Analyst-${analystId}`,
                    });
                    resultText = result.text;
                    modelUsed = result.provider === 'gemini' ? config.ai.model : config.ai.openRouterModel;
                } else {
                    // Single provider mode - all analysts use same provider
                    const result = await aiService.generateContent({
                        prompt: fullPrompt,
                        schema: ANALYST_OUTPUT_RESPONSE_SCHEMA,
                        temperature: config.ai.temperature,
                        maxOutputTokens: 2048, // Reduced from config.ai.maxOutputTokens (65k) for latency
                        label: `Analyst-${analystId}`,
                    });
                    resultText = result.text;
                    modelUsed = config.ai.provider === 'gemini' ? config.ai.model : config.ai.openRouterModel;
                }

                const parsed = this.parseJSON(resultText);
                const normalized = normalizeAnalystOutput(parsed);

                if (validateAnalystOutput(normalized)) {
                    logger.debug(`${analystId} completed with ${modelUsed}`);
                    return normalized;
                } else {
                    logger.warn(`${analystId} output validation failed on attempt ${attempt} (model: ${modelUsed})`);
                    logger.warn(`${analystId} raw response (first 500 chars): ${resultText.slice(0, 500)}`);
                    if (parsed) {
                        const rec = (parsed as any).recommendation;
                        logger.warn(`${analystId} parsed fields: reasoning=${typeof (parsed as any).reasoning}, rec.action=${rec?.action}, rec.symbol=${rec?.symbol}, rec.allocation_usd=${rec?.allocation_usd}, rec.leverage=${rec?.leverage}, rec.confidence=${rec?.confidence}, rec.tp_price=${rec?.tp_price}, rec.sl_price=${rec?.sl_price}, rec.exit_plan=${typeof rec?.exit_plan}, rec.rationale=${typeof rec?.rationale}`);
                    } else {
                        logger.warn(`${analystId} parsed is null/undefined`);
                    }
                    if (attempt < config.ai.maxRetries) {
                        await this.sleep(1000 * attempt);
                    }
                }
            } catch (error) {
                logger.error(`${analystId} attempt ${attempt} failed:`, error);
                if (attempt === config.ai.maxRetries) {
                    throw error;
                }
                await this.sleep(1000 * attempt);
            }
        }

        return null;
    }

    /**
     * Run judge to compare all analyst outputs using centralized AIService with strict JSON schema
     * Uses hybrid mode routing when AI_HYBRID_MODE=true
     */
    private async runJudge(
        context: TradingContext,
        analysisResult: ParallelAnalysisResult,
        debateResult: TournamentResult | null = null
    ): Promise<JudgeDecision> {
        const promptVars = context.prompt_vars;
        // Create a copy of context without prompt_vars to reduce redundant data
        const cleanContext = { ...context };
        delete (cleanContext as any).prompt_vars;

        const contextJson = JSON.stringify(cleanContext, null, 2);

        const jimOutput = analysisResult.jim ? JSON.stringify(analysisResult.jim, null, 2) : null;
        const rayOutput = analysisResult.ray ? JSON.stringify(analysisResult.ray, null, 2) : null;
        const karenOutput = analysisResult.karen ? JSON.stringify(analysisResult.karen, null, 2) : null;
        const quantOutput = analysisResult.quant ? JSON.stringify(analysisResult.quant, null, 2) : null;

        const analystWeights = getAnalystWeights();
        const hasNonDefaultWeights = Array.from(analystWeights.values()).some(w => w !== 1.0);
        const weightsSection = hasNonDefaultWeights
            ? `\n\nANALYST WEIGHT ADJUSTMENTS (from trade journal performance):\n${Array.from(analystWeights.entries())
                .map(([id, weight]) => `  - ${id}: ${weight.toFixed(2)}x ${weight > 1 ? '(outperforming)' : weight < 1 ? '(underperforming)' : '(average)'}`)
                .join('\n')
            }\nUse these weights when evaluating analyst recommendations - prefer analysts with higher weights.`
            : '';

        const userMessage = buildJudgeUserMessage(
            contextJson,
            jimOutput,
            rayOutput,
            karenOutput,
            quantOutput,
            promptVars,
            debateResult || undefined
        ) + weightsSection;
        // CRITICAL: Add separator for prompt caching - system prompt will be cached
        const fullPrompt = buildJudgeSystemPrompt() + '\n\n---USER---\n\n' + userMessage;

        // Determine which mode to use for judge
        const useHybridMode = config.ai.hybridMode;

        for (let attempt = 1; attempt <= config.ai.maxRetries; attempt++) {
            try {
                let result;

                if (useHybridMode) {
                    // Hybrid mode: use judge-specific provider
                    result = await aiService.generateContentForJudge({
                        prompt: fullPrompt,
                        schema: JUDGE_OUTPUT_RESPONSE_SCHEMA,
                        temperature: 0.3,
                        maxOutputTokens: 2048, // Reduced from config.ai.maxOutputTokens for latency
                        label: 'Judge',
                    });
                } else {
                    // Single provider mode
                    result = await aiService.generateContent({
                        prompt: fullPrompt,
                        schema: JUDGE_OUTPUT_RESPONSE_SCHEMA,
                        temperature: 0.3,
                        maxOutputTokens: 2048, // Reduced from config.ai.maxOutputTokens for latency
                        label: 'Judge',
                    });
                }

                const parsed = this.parseJSON(result.text);

                const normalized = this.normalizeJudgeDecision(parsed);

                if (validateJudgeOutput(normalized)) {
                    if (normalized.winner === 'NONE' && normalized.final_action !== 'CLOSE' && normalized.final_action !== 'REDUCE') {
                        normalized.final_action = 'HOLD';
                        normalized.final_recommendation = null;
                    }
                    return normalized as JudgeDecision;
                } else {
                    logger.warn(`Judge output validation failed on attempt ${attempt}`);
                    if (attempt < config.ai.maxRetries) {
                        await this.sleep(1000 * attempt);
                    }
                }
            } catch (error) {
                logger.error(`Judge attempt ${attempt} failed:`, error);
                if (attempt === config.ai.maxRetries) {
                    return {
                        winner: 'NONE',
                        reasoning: 'Judge failed to produce valid output',
                        adjustments: null,
                        warnings: ['Judge analysis failed'],
                        final_action: 'HOLD',
                        final_recommendation: null,
                    };
                }
                await this.sleep(1000 * attempt);
            }
        }

        return {
            winner: 'NONE',
            reasoning: 'Judge failed after all retries',
            adjustments: null,
            warnings: ['Judge analysis failed'],
            final_action: 'HOLD',
            final_recommendation: null,
        };
    }

    private normalizeJudgeDecision(value: unknown): any {
        if (!value || typeof value !== 'object') return value;

        const v = value as any;
        const finalAction = v.final_action;
        if (finalAction === 'CLOSE' || finalAction === 'REDUCE') {
            v.adjustments = null;

            if (v.final_recommendation && typeof v.final_recommendation === 'object') {
                v.final_recommendation.leverage = 0;
            }
        } else if (finalAction === 'HOLD') {
            v.adjustments = null;
        }

        return v;
    }

    /**
     * Build final decision from analysis and judge results
     */
    private buildFinalDecision(
        analysisResult: ParallelAnalysisResult,
        judgeDecision: JudgeDecision,
        debateResult: TournamentResult | null = null
    ): FinalDecision {
        // If no winner, check if it's an emergency CLOSE/REDUCE action
        // FIXED: Handle CLOSE/REDUCE with winner=NONE (emergency position management)
        if (judgeDecision.winner === 'NONE') {
            // Emergency CLOSE/REDUCE: judge decided to close/reduce without picking a winner
            // This happens when all analysts fail but a position needs closing due to risk
            if ((judgeDecision.final_action === 'CLOSE' || judgeDecision.final_action === 'REDUCE')
                && judgeDecision.final_recommendation) {
                const rec = judgeDecision.final_recommendation;
                const MAX_WARNINGS = 20;
                const warnings = judgeDecision.warnings.length > MAX_WARNINGS
                    ? judgeDecision.warnings.slice(0, MAX_WARNINGS)
                    : [...judgeDecision.warnings];

                const originalLeverage = rec.leverage;
                let leverage = 0;
                let allocation = rec.allocation_usd;
                if (originalLeverage !== 0 && warnings.length < MAX_WARNINGS) {
                    warnings.push(`Ignored leverage for ${judgeDecision.final_action}: ${originalLeverage}`);
                }

                if (!Number.isFinite(allocation) || allocation < 0) {
                    warnings.push(`Ignored invalid allocation_usd for ${judgeDecision.final_action}: ${allocation}`);
                    allocation = 0;
                }

                return {
                    action: judgeDecision.final_action,
                    symbol: rec.symbol,
                    allocation_usd: allocation,
                    leverage,
                    tp_price: null,
                    sl_price: null,
                    exit_plan: rec.exit_plan,
                    confidence: rec.confidence,
                    rationale: rec.rationale,
                    winner: 'NONE',
                    warnings,
                    analysisResult,
                    debateResult,
                    judgeDecision,
                };
            }

            // Standard HOLD case
            return {
                action: 'HOLD',
                symbol: '',
                allocation_usd: 0,
                leverage: 0,
                tp_price: null,
                sl_price: null,
                exit_plan: '',
                confidence: 0,
                rationale: judgeDecision.reasoning,
                winner: 'NONE',
                warnings: judgeDecision.warnings,
                analysisResult,
                debateResult,
                judgeDecision,
            };
        }

        // Get winner's recommendation
        const winnerOutput = analysisResult[judgeDecision.winner];
        if (!winnerOutput) {
            logger.error(`Winner ${judgeDecision.winner} has no output!`);
            return {
                action: 'HOLD',
                symbol: '',
                allocation_usd: 0,
                leverage: 0,
                tp_price: null,
                sl_price: null,
                exit_plan: '',
                confidence: 0,
                rationale: 'Winner output not found',
                winner: 'NONE',
                warnings: ['Winner output missing'],
                analysisResult,
                debateResult,
                judgeDecision,
            };
        }

        const rec = winnerOutput.recommendation;

        // Apply judge's adjustments (if any)
        let finalLeverage = rec.leverage;
        let finalAllocation = rec.allocation_usd;
        let finalSlPrice = rec.sl_price;
        let finalTpPrice = rec.tp_price;

        if (judgeDecision.adjustments) {
            if (judgeDecision.adjustments.leverage !== undefined) {
                finalLeverage = judgeDecision.adjustments.leverage;
            }
            if (judgeDecision.adjustments.allocation_usd !== undefined) {
                finalAllocation = judgeDecision.adjustments.allocation_usd;
            }
            if (judgeDecision.adjustments.sl_price !== undefined) {
                finalSlPrice = judgeDecision.adjustments.sl_price;
            }
            if (judgeDecision.adjustments.tp_price !== undefined) {
                finalTpPrice = judgeDecision.adjustments.tp_price;
            }
        }

        const finalAction = judgeDecision.final_action;
        const isExitAction = finalAction === 'CLOSE' || finalAction === 'REDUCE';

        const MAX_WARNINGS = 20;
        const warnings = judgeDecision.warnings.length > MAX_WARNINGS
            ? judgeDecision.warnings.slice(0, MAX_WARNINGS)
            : [...judgeDecision.warnings];

        if (isExitAction) {
            const originalLeverage = finalLeverage;
            finalLeverage = 0;
            if (originalLeverage !== 0 && warnings.length < MAX_WARNINGS) {
                warnings.push(`Ignored leverage for ${finalAction}: ${originalLeverage}`);
            }

            if (!Number.isFinite(finalAllocation) || finalAllocation < 0) {
                warnings.push(`Ignored invalid allocation_usd for ${finalAction}: ${finalAllocation}`);
                finalAllocation = 0;
            }

            finalSlPrice = null;
            finalTpPrice = null;
        } else {
            if (!Number.isFinite(finalLeverage) || finalLeverage <= 0) {
                logger.error(`Invalid leverage from AI: ${finalLeverage} (type: ${typeof finalLeverage}), returning HOLD decision`);
                return {
                    action: 'HOLD',
                    symbol: rec.symbol,
                    allocation_usd: 0,
                    leverage: 0,
                    tp_price: null,
                    sl_price: null,
                    exit_plan: '',
                    confidence: 0,
                    rationale: `Invalid leverage value: ${finalLeverage}`,
                    winner: 'NONE',
                    warnings: [`AI returned invalid leverage: ${finalLeverage}`],
                    analysisResult,
                    debateResult,
                    judgeDecision,
                };
            } else if (finalLeverage > GLOBAL_RISK_LIMITS.ABSOLUTE_MAX_LEVERAGE) {
                logger.warn(`AI leverage ${finalLeverage}x exceeds ${GLOBAL_RISK_LIMITS.ABSOLUTE_MAX_LEVERAGE}x cap, clamping`);
                finalLeverage = GLOBAL_RISK_LIMITS.ABSOLUTE_MAX_LEVERAGE;
            } else if (finalLeverage < 1) {
                logger.warn(`AI leverage ${finalLeverage}x is below minimum 1x, clamping to 1x`);
                finalLeverage = 1;
            }

            if (finalLeverage >= 15 && warnings.length < MAX_WARNINGS) {
                const liquidationDistance = 100 / finalLeverage;
                const maxSafeStopPct = liquidationDistance * 0.8;
                warnings.push(`High leverage (${finalLeverage}x) - ensure stop loss is within ${maxSafeStopPct.toFixed(1)}% of entry to avoid liquidation`);
            }
        }

        return {
            action: finalAction,
            symbol: rec.symbol,
            allocation_usd: finalAllocation,
            leverage: finalLeverage,
            tp_price: finalTpPrice,
            sl_price: finalSlPrice,
            exit_plan: rec.exit_plan,
            confidence: rec.confidence,
            rationale: rec.rationale,
            winner: judgeDecision.winner,
            warnings,
            analysisResult,
            debateResult,
            judgeDecision,
        };
    }

    /**
     * Check if trading is allowed (anti-churn)
     */
    checkAntiChurn(symbol: string, direction: 'LONG' | 'SHORT'): { allowed: boolean; reason?: string } {
        const antiChurn = getAntiChurnService();

        const canTrade = antiChurn.canTrade(symbol);
        if (!canTrade.allowed) {
            return canTrade;
        }

        const canFlip = antiChurn.canFlipDirection(symbol, direction);
        if (!canFlip.allowed) {
            return canFlip;
        }

        if (!antiChurn.canTradeToday()) {
            return { allowed: false, reason: 'Daily trade limit reached' };
        }

        return { allowed: true };
    }

    /**
     * Record trade for anti-churn tracking
     * @returns true if trade was recorded, false if inputs were invalid
     */
    recordTrade(symbol: string, direction: 'LONG' | 'SHORT'): boolean {
        const antiChurn = getAntiChurnService();
        return antiChurn.recordTrade(symbol, direction);
    }

    /**
     * Parse JSON with error handling
     * NOTE: AIService already handles robust extraction and basic validation.
     */
    private parseJSON(text: string): any {
        const MAX_JSON_SIZE = 10 * 1024 * 1024;
        if (text.length > MAX_JSON_SIZE) {
            throw new Error(`JSON response too large: ${text.length} bytes (max: ${MAX_JSON_SIZE})`);
        }

        try {
            return JSON.parse(text.trim());
        } catch (error) {
            logger.error('JSON parse error:', error);
            logger.debug(`Raw text length: ${text.length} chars [content redacted for security]`);
            throw error;
        }
    }

    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timeoutId = setTimeout(resolve, ms);
            if ((timeoutId as any).unref) {
                (timeoutId as any).unref();
            }
        });
    }

    /**
     * Cleanup internal state for reset
     * @internal Called by resetCollaborativeFlow()
     */
    _cleanup(): void {
        this.initialized = false;
        // AIService is a singleton and manages its own cleanup
        aiService.cleanup();
    }
}

// Singleton instance
let collaborativeFlowInstance: CollaborativeFlowService | null = null;

/**
 * Get singleton instance of CollaborativeFlowService
 * 
 * NOTE: The prisma parameter is only used when creating the first instance.
 * Subsequent calls return the existing instance regardless of the prisma parameter.
 * This is intentional - the service should use a consistent database connection.
 * If you need to use a different PrismaClient, call resetCollaborativeFlow() first.
 */
export function getCollaborativeFlow(prisma: PrismaClient): CollaborativeFlowService {
    if (!collaborativeFlowInstance) {
        collaborativeFlowInstance = new CollaborativeFlowService(prisma);
    }
    return collaborativeFlowInstance;
}

// Track if an operation is in progress to prevent unsafe reset
// Using a counter instead of boolean to support concurrent operations
// INTERNAL: These functions are called by CollaborativeFlowService.runParallelAnalysis()
// and should NOT be called directly by external code to avoid double-counting.
let operationInProgressCount = 0;

/**
 * Mark operation start (call before runParallelAnalysis)
 * @internal Used ONLY by CollaborativeFlowService to track operation state.
 * External callers should NOT use this function - it's managed automatically
 * by runParallelAnalysis() to ensure proper pairing of start/end calls.
 */
export function markOperationStart(): void {
    operationInProgressCount++;
}

/**
 * Mark operation end (call after runParallelAnalysis completes)
 * @internal Used ONLY by CollaborativeFlowService to track operation state
 */
export function markOperationEnd(): void {
    if (operationInProgressCount <= 0) {
        logger.warn('markOperationEnd called but no operation in progress - possible mismatched start/end calls');
        operationInProgressCount = 0;  // Ensure we don't go negative
        return;
    }
    operationInProgressCount--;
}

/**
 * Get current operation count (for debugging/monitoring only)
 */
export function getOperationCount(): number {
    return operationInProgressCount;
}

/**
 * Reset singleton (for testing or cleanup)
 * @param force - If true, reset even if operation is in progress (use with caution)
 * @returns true if reset was performed, false if skipped due to operation in progress
 */
export function resetCollaborativeFlow(force: boolean = false): boolean {
    if (operationInProgressCount > 0 && !force) {
        logger.warn(`Cannot reset CollaborativeFlow: ${operationInProgressCount} operation(s) in progress. Use force=true to override.`);
        return false;
    }

    if (collaborativeFlowInstance) {
        collaborativeFlowInstance._cleanup();
    }

    collaborativeFlowInstance = null;
    operationInProgressCount = 0;
    return true;
}
