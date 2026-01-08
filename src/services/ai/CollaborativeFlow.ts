/**
 * Collaborative Trading Flow
 * 
 * Simplified pipeline with PARALLEL ANALYSIS:
 * 1. Market Scan - Fetch data for all coins + indicators
 * 2. Parallel Analysis - 4 analysts analyze independently in parallel
 * 3. Judge Decision - Compare all 4 and pick winner
 * 4. Execution - Place trade on WEEX
 * 
 * AI CALLS: 5 (4 analysts + 1 judge)
 * LATENCY: ~25 seconds
 * 
 * FEATURES:
 * - Strict JSON schemas via responseSchema (prevents parse errors)
 * - Dual provider support (Gemini / OpenRouter) via centralized AIService
 * - Prompt caching optimization (implicit for Gemini 2.5+, explicit for OpenRouter)
 * - Schema conversion for cross-provider compatibility
 * 
 * See: https://ai.google.dev/gemini-api/docs/json-mode
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';
import { PrismaClient } from '@prisma/client';
import {
    AnalystId,
    AnalystOutput,
    ParallelAnalysisResult,
    JudgeDecision,
    validateAnalystOutput,
    normalizeAnalystOutput,
    validateJudgeOutput,
} from '../../types/analyst';
import { TradingContext } from '../../types/context';
import { buildAnalystPrompt, buildAnalystUserMessage } from '../../constants/prompts/analystPrompt';
import { JUDGE_SYSTEM_PROMPT, buildJudgeUserMessage } from '../../constants/prompts/judgePrompt';
import { getAntiChurnService } from '../trading/AntiChurnService';
import { getContextBuilder } from '../context/ContextBuilder';
import { aiService, SchemaType, ResponseSchema } from './AIService';

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
// These schemas enforce strict JSON output from the LLM, preventing parse errors
// and ensuring consistent response structure. The model will ONLY output valid JSON
// matching these schemas.
//
// IMPORTANT: Gemini's responseSchema uses a subset of JSON Schema:
// - Supported types: STRING, NUMBER, INTEGER, BOOLEAN, ARRAY, OBJECT
// - Use 'enum' for string enums
// - Use 'nullable: true' instead of 'type: ["string", "null"]'
// - 'required' array specifies mandatory properties
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
            description: 'Trading symbol (e.g., cmt_btcusdt)',
        },
        allocation_usd: {
            type: SchemaType.NUMBER,
            description: 'Notional exposure in USD (0 for HOLD)',
        },
        leverage: {
            type: SchemaType.NUMBER,
            description: 'Leverage multiplier (1-20)',
        },
        tp_price: {
            type: SchemaType.NUMBER,
            nullable: true,
            description: 'Take profit price (null for HOLD)',
        },
        sl_price: {
            type: SchemaType.NUMBER,
            nullable: true,
            description: 'Stop loss price (null for HOLD)',
        },
        exit_plan: {
            type: SchemaType.STRING,
            description: 'Exit conditions and invalidation triggers',
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
            description: 'Adjusted leverage (1-20)',
        },
        allocation_usd: {
            type: SchemaType.NUMBER,
            description: 'Adjusted allocation in USD',
        },
        sl_price: {
            type: SchemaType.NUMBER,
            description: 'Adjusted stop loss price',
        },
        tp_price: {
            type: SchemaType.NUMBER,
            description: 'Adjusted take profit price',
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
     * Now uses centralized AIService - just validates configuration
     */
    async initialize(): Promise<void> {
        if (this.initialized) return;

        if (!aiService.isConfigured()) {
            throw new Error(`AI provider ${config.ai.provider} not configured. Check API keys in .env`);
        }

        this.initialized = true;
        logger.info(`CollaborativeFlowService initialized with ${aiService.getProvider()} provider`);
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

        // FIXED: Validate inputs before proceeding
        // CRITICAL: Invalid balance is a serious error - we should not trade with unknown balance
        // Using 0 as fallback prevents new trades but allows position management
        if (!Number.isFinite(accountBalance) || accountBalance < 0) {
            logger.error(`CRITICAL: Invalid accountBalance: ${accountBalance}. Cannot determine trading capacity.`);
            // Return HOLD with warning instead of silently using 0
            // This prevents opening new positions when balance is unknown
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
            };
        }

        const startTime = Date.now();
        logger.info('🚀 Starting parallel analysis pipeline...');

        // FIXED: Mark operation start for safe reset handling
        markOperationStart();

        try {
            // Stage 1: Build rich context
            // FIXED: Wrap context builder callback in try-catch to prevent pipeline crash
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
                };
            }

            logger.info(`📊 Context built with ${context.market_data.length} assets, ${context.account.positions.length} positions`);

            // Stage 2: Run 4 analysts in parallel
            const analysisResult = await this.runAllAnalysts(context);
            const analysisTime = Date.now() - startTime;
            logger.info(`📊 Parallel analysis completed in ${analysisTime}ms`);

            // Log results
            for (const analystId of ['jim', 'ray', 'karen', 'quant'] as AnalystId[]) {
                const output = analysisResult[analystId];
                if (output) {
                    logger.info(`  ✓ ${analystId}: ${output.recommendation.action} ${output.recommendation.symbol} (${output.recommendation.confidence}%)`);
                } else {
                    logger.warn(`  ✗ ${analystId}: FAILED`);
                }
            }

            // Stage 3: Judge compares all outputs
            const judgeStart = Date.now();
            const judgeDecision = await this.runJudge(context, analysisResult);
            const judgeTime = Date.now() - judgeStart;
            logger.info(`⚖️ Judge decision in ${judgeTime}ms: winner=${judgeDecision.winner}, action=${judgeDecision.final_action}`);

            // Stage 4: Build final decision
            const finalDecision = this.buildFinalDecision(analysisResult, judgeDecision);

            const totalTime = Date.now() - startTime;
            logger.info(`✅ Total pipeline time: ${totalTime}ms (target: <25000ms)`);

            return finalDecision;
        } finally {
            // FIXED: Always mark operation end, even on error
            markOperationEnd();
        }
    }

    /**
     * Run all 4 analysts in parallel
     */
    private async runAllAnalysts(context: TradingContext): Promise<ParallelAnalysisResult> {
        const contextJson = JSON.stringify(context, null, 2);
        const analysts: AnalystId[] = ['jim', 'ray', 'karen', 'quant'];

        const promises = analysts.map((analystId) =>
            this.runSingleAnalyst(analystId, contextJson)
        );

        const results = await Promise.allSettled(promises);

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
     */
    private async runSingleAnalyst(analystId: AnalystId, contextJson: string): Promise<AnalystOutput | null> {
        const systemPrompt = buildAnalystPrompt(analystId);
        const userMessage = buildAnalystUserMessage(contextJson);

        // Combine prompts - system prompt first for caching optimization
        const fullPrompt = systemPrompt + '\n\n' + userMessage;

        for (let attempt = 1; attempt <= config.ai.maxRetries; attempt++) {
            try {
                const result = await aiService.generateContent({
                    prompt: fullPrompt,
                    schema: ANALYST_OUTPUT_RESPONSE_SCHEMA,
                    temperature: config.ai.temperature,
                    maxOutputTokens: config.ai.maxOutputTokens,
                    label: `Analyst-${analystId}`,
                });

                const parsed = this.parseJSON(result.text);

                // Normalize before validation (handles exit_plan as object, etc.)
                const normalized = normalizeAnalystOutput(parsed);

                if (validateAnalystOutput(normalized)) {
                    return normalized;
                } else {
                    // Debug: log what we received vs what we expected
                    logger.warn(`${analystId} output validation failed on attempt ${attempt}`);
                    logger.warn(`${analystId} raw response (first 500 chars): ${result.text.slice(0, 500)}`);
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

        // This return is reached when all retries complete but validation keeps failing
        // (i.e., the AI returns parseable JSON that doesn't match our schema)
        return null;
    }

    /**
     * Run judge to compare all analyst outputs using centralized AIService with strict JSON schema
     */
    private async runJudge(context: TradingContext, analysisResult: ParallelAnalysisResult): Promise<JudgeDecision> {
        const contextJson = JSON.stringify(context, null, 2);

        const jimOutput = analysisResult.jim ? JSON.stringify(analysisResult.jim, null, 2) : null;
        const rayOutput = analysisResult.ray ? JSON.stringify(analysisResult.ray, null, 2) : null;
        const karenOutput = analysisResult.karen ? JSON.stringify(analysisResult.karen, null, 2) : null;
        const quantOutput = analysisResult.quant ? JSON.stringify(analysisResult.quant, null, 2) : null;

        const userMessage = buildJudgeUserMessage(contextJson, jimOutput, rayOutput, karenOutput, quantOutput);

        // Combine prompts - system prompt first for caching optimization
        const fullPrompt = JUDGE_SYSTEM_PROMPT + '\n\n' + userMessage;

        for (let attempt = 1; attempt <= config.ai.maxRetries; attempt++) {
            try {
                const result = await aiService.generateContent({
                    prompt: fullPrompt,
                    schema: JUDGE_OUTPUT_RESPONSE_SCHEMA,
                    temperature: 0.3, // Lower temperature for judge (more deterministic)
                    maxOutputTokens: config.ai.maxOutputTokens,
                    label: 'Judge',
                });

                const parsed = this.parseJSON(result.text);

                if (validateJudgeOutput(parsed)) {
                    // Ensure consistency: winner=NONE means HOLD with no recommendation
                    // EXCEPTION: winner=NONE can have CLOSE action for emergency position management
                    // (e.g., when all analysts fail but a position needs closing)
                    if (parsed.winner === 'NONE' && parsed.final_action !== 'CLOSE' && parsed.final_action !== 'REDUCE') {
                        parsed.final_action = 'HOLD';
                        parsed.final_recommendation = null;
                    }
                    return parsed as JudgeDecision;
                } else {
                    logger.warn(`Judge output validation failed on attempt ${attempt}`);
                    if (attempt < config.ai.maxRetries) {
                        await this.sleep(1000 * attempt);
                    }
                }
            } catch (error) {
                logger.error(`Judge attempt ${attempt} failed:`, error);
                if (attempt === config.ai.maxRetries) {
                    // Return safe default
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

    /**
     * Build final decision from analysis and judge results
     */
    private buildFinalDecision(
        analysisResult: ParallelAnalysisResult,
        judgeDecision: JudgeDecision
    ): FinalDecision {
        // If no winner, check if it's an emergency CLOSE/REDUCE action
        // FIXED: Handle CLOSE/REDUCE with winner=NONE (emergency position management)
        if (judgeDecision.winner === 'NONE') {
            // Emergency CLOSE/REDUCE: judge decided to close/reduce without picking a winner
            // This happens when all analysts fail but a position needs closing due to risk
            if ((judgeDecision.final_action === 'CLOSE' || judgeDecision.final_action === 'REDUCE')
                && judgeDecision.final_recommendation) {
                const rec = judgeDecision.final_recommendation;
                return {
                    action: judgeDecision.final_action,
                    symbol: rec.symbol,
                    allocation_usd: rec.allocation_usd,
                    leverage: rec.leverage,
                    tp_price: rec.tp_price,
                    sl_price: rec.sl_price,
                    exit_plan: rec.exit_plan,
                    confidence: rec.confidence,
                    rationale: rec.rationale,
                    winner: 'NONE',
                    warnings: judgeDecision.warnings,
                    analysisResult,
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

        // CHANGED: Trust AI's leverage decision - only apply hard safety limits
        // The AI is instructed to use 3-20x leverage based on conditions
        // We only clamp to exchange limits, not our own conservative limits
        if (!Number.isFinite(finalLeverage) || finalLeverage <= 0) {
            // FIXED: Invalid leverage - return HOLD instead of using arbitrary default
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
                judgeDecision,
            };
        } else if (finalLeverage > 20) {
            // Hard cap at 20x as per prompt instructions
            logger.warn(`AI leverage ${finalLeverage}x exceeds 20x cap, clamping to 20x`);
            finalLeverage = 20;
        } else if (finalLeverage < 1) {
            // FIXED: Log warning when clamping up to minimum
            logger.warn(`AI leverage ${finalLeverage}x is below minimum 1x, clamping to 1x`);
            finalLeverage = 1;
        }

        // Collect warnings for the final decision
        // FIXED: Limit warnings array size to prevent memory issues
        const MAX_WARNINGS = 20;
        const warnings = judgeDecision.warnings.length > MAX_WARNINGS
            ? judgeDecision.warnings.slice(0, MAX_WARNINGS)
            : [...judgeDecision.warnings];

        // ADDED: Validate stop loss is appropriate for leverage level
        // At high leverage, stop loss must be tighter than liquidation distance
        // Liquidation distance = 100% / leverage (e.g., 5% at 20x)
        // We warn if stop loss is > 80% of liquidation distance (too close to liquidation)
        // FIXED: Removed dead branch and unused maxSafeStopPct calculation
        // Note: We don't have current price here, so we can only warn about high leverage
        if (finalLeverage >= 15 && warnings.length < MAX_WARNINGS) {
            const liquidationDistance = 100 / finalLeverage; // e.g., 6.67% at 15x, 5% at 20x
            const maxSafeStopPct = liquidationDistance * 0.8; // 80% of liquidation distance
            warnings.push(`High leverage (${finalLeverage}x) - ensure stop loss is within ${maxSafeStopPct.toFixed(1)}% of entry to avoid liquidation`);
        }

        return {
            action: judgeDecision.final_action,
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
     * 
     * FIXED: Added size limit to prevent memory exhaustion from malicious responses
     */
    private parseJSON(text: string): any {
        // FIXED: Limit input size to prevent memory exhaustion (10MB max)
        const MAX_JSON_SIZE = 10 * 1024 * 1024;
        if (text.length > MAX_JSON_SIZE) {
            throw new Error(`JSON response too large: ${text.length} bytes (max: ${MAX_JSON_SIZE})`);
        }

        try {
            // Remove markdown code blocks if present
            let cleaned = text.trim();
            if (cleaned.startsWith('```json')) {
                cleaned = cleaned.slice(7);
            } else if (cleaned.startsWith('```')) {
                cleaned = cleaned.slice(3);
            }
            if (cleaned.endsWith('```')) {
                cleaned = cleaned.slice(0, -3);
            }
            return JSON.parse(cleaned.trim());
        } catch (error) {
            logger.error('JSON parse error:', error);
            // SECURITY: Only log metadata to avoid exposing sensitive data
            // Full response may contain API keys, account info, or other sensitive context
            logger.debug(`Raw text length: ${text.length} chars [content redacted for security]`);
            throw error;
        }
    }

    /**
     * Sleep helper
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
 * @internal Used ONLY by CollaborativeFlowService to track operation state.
 * External callers should NOT use this function - it's managed automatically
 * by runParallelAnalysis() to ensure proper pairing of start/end calls.
 * 
 * NOTE: Uses Math.max(0, ...) to prevent negative counts from mismatched calls.
 * If this happens, it indicates a bug in the calling code.
 */
export function markOperationEnd(): void {
    if (operationInProgressCount <= 0) {
        logger.warn('markOperationEnd called but no operation in progress - possible mismatched start/end calls');
    }
    operationInProgressCount = Math.max(0, operationInProgressCount - 1);
}

/**
 * Get current operation count (for debugging/monitoring only)
 * @returns Number of operations currently in progress
 */
export function getOperationCount(): number {
    return operationInProgressCount;
}

/**
 * Reset singleton (for testing or cleanup)
 * FIXED: Properly cleanup model resources to prevent memory leaks
 * FIXED: Clear initializingPromise to prevent race conditions during reset
 * FIXED: Check if operation is in progress before resetting
 * FIXED: Use public _cleanup() method instead of accessing private fields
 * 
 * @param force - If true, reset even if operation is in progress (use with caution)
 * @returns true if reset was performed, false if skipped due to operation in progress
 */
export function resetCollaborativeFlow(force: boolean = false): boolean {
    if (operationInProgressCount > 0 && !force) {
        logger.warn(`Cannot reset CollaborativeFlow: ${operationInProgressCount} operation(s) in progress. Use force=true to override.`);
        return false;
    }

    if (collaborativeFlowInstance) {
        // Use public cleanup method to clear internal state
        collaborativeFlowInstance._cleanup();
    }
    collaborativeFlowInstance = null;
    operationInProgressCount = 0;
    return true;
}
