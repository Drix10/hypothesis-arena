/**
 * Gemini AI Service - ENHANCED with OpenRouter Support
 * 
 * Handles all AI-powered analysis using Google's Gemini API or OpenRouter.
 * Uses high-quality analyst personas with detailed prompts and debate strategies.
 * 
 * Supports two AI providers:
 * - Gemini: Google's Gemini 2.5 Flash with native JSON Schema support
 * - OpenRouter: Unified API for multiple models (Qwen, Claude, etc.) with JSON Schema
 * 
 * Matches the prompts file format exactly:
 * - 4 analysts: jim, ray, karen, quant
 * - Recommendations: STRONG_BUY, BUY, HOLD, SELL, STRONG_SELL
 * - Price targets: bull/base/bear structure
 */

import { GoogleGenerativeAI, GenerativeModel, SchemaType } from '@google/generative-ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { roundToStepSize, roundToTickSize } from '../../shared/utils/weex';
import { aiLogService } from '../compliance/AILogService';
import { ANALYST_PROFILES, THESIS_SYSTEM_PROMPTS, type AnalystMethodology, buildDebatePrompt } from '../../constants/analyst';
import { getSystemPrompt } from '../../constants/prompts/promptHelpers';
import { arenaContextBuilder, FullArenaContext } from '../../constants/ArenaContext';

// Use config values instead of hardcoded constants
const AI_REQUEST_TIMEOUT = config.ai.analysisTimeoutMs; // 90 seconds for detailed analysis
const VALID_RECOMMENDATIONS = ['strong_buy', 'buy', 'hold', 'sell', 'strong_sell'] as const;
const VALID_WINNERS = ['bull', 'bear', 'draw'] as const;
const JUDGE_MAX_TOKENS = 2048; // Judge responses are concise - avoid truncation while not wasting tokens

// ═══════════════════════════════════════════════════════════════════════════════
// STRUCTURED OUTPUT SCHEMAS - Gemini 2.0 JSON Schema Support
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert Gemini SchemaType to OpenRouter JSON Schema type
 * CRITICAL: Handles invalid/unknown types gracefully
 */
function geminiToOpenRouterType(schemaType: SchemaType): string {
    // CRITICAL: Validate schemaType exists
    if (schemaType === null || schemaType === undefined) {
        logger.warn('geminiToOpenRouterType called with null/undefined, defaulting to string');
        return 'string';
    }

    switch (schemaType) {
        case SchemaType.STRING: return 'string';
        case SchemaType.NUMBER: return 'number';
        case SchemaType.INTEGER: return 'integer';
        case SchemaType.BOOLEAN: return 'boolean';
        case SchemaType.ARRAY: return 'array';
        case SchemaType.OBJECT: return 'object';
        default:
            logger.warn(`Unknown SchemaType: ${schemaType}, defaulting to string`);
            return 'string';
    }
}

/**
 * Convert Gemini schema to OpenRouter JSON Schema format
 * Handles nested objects, arrays, and all schema properties
 * 
 * CRITICAL FIXES:
 * - Validates schema is an object before processing
 * - Handles circular references (max depth 10)
 * - Validates enum arrays are non-empty
 * - Validates required arrays contain valid strings
 * - Prevents infinite recursion
 */
function convertGeminiSchemaToOpenRouter(geminiSchema: any, depth: number = 0): any {
    // CRITICAL: Prevent infinite recursion
    const MAX_DEPTH = 10;
    if (depth > MAX_DEPTH) {
        logger.error(`Schema conversion exceeded max depth ${MAX_DEPTH}, possible circular reference`);
        return { type: 'string' };
    }

    // CRITICAL: Handle null/undefined schema
    if (!geminiSchema || typeof geminiSchema !== 'object') {
        return { type: 'string' };
    }

    // CRITICAL: Validate type field exists
    if (!geminiSchema.type) {
        logger.warn('Schema missing type field, defaulting to string');
        return { type: 'string' };
    }

    const converted: any = {
        type: geminiToOpenRouterType(geminiSchema.type),
    };

    // CRITICAL: Validate description is a string
    if (geminiSchema.description && typeof geminiSchema.description === 'string') {
        converted.description = geminiSchema.description;
    }

    // CRITICAL: Validate enum is a non-empty array
    if (geminiSchema.enum) {
        if (Array.isArray(geminiSchema.enum) && geminiSchema.enum.length > 0) {
            converted.enum = geminiSchema.enum;
        } else {
            logger.warn('Schema enum is not a valid non-empty array, ignoring');
        }
    }

    // Handle nested properties (objects)
    if (geminiSchema.properties && typeof geminiSchema.properties === 'object') {
        converted.properties = {};
        for (const [key, value] of Object.entries(geminiSchema.properties)) {
            // CRITICAL: Validate key is a non-empty string
            if (!key || typeof key !== 'string' || key.trim().length === 0) {
                logger.warn(`Invalid property key: ${key}, skipping`);
                continue;
            }
            // CRITICAL: Recursively convert with depth tracking
            converted.properties[key] = convertGeminiSchemaToOpenRouter(value, depth + 1);
        }
        // CRITICAL: Disable additionalProperties for strict schema validation
        converted.additionalProperties = false;
    }

    // Handle array items
    if (geminiSchema.items) {
        // CRITICAL: Recursively convert with depth tracking
        converted.items = convertGeminiSchemaToOpenRouter(geminiSchema.items, depth + 1);
    }

    // CRITICAL: Validate required is an array of non-empty strings
    if (geminiSchema.required) {
        if (Array.isArray(geminiSchema.required)) {
            const validRequired = geminiSchema.required.filter(
                (field: any) => field && typeof field === 'string' && field.trim().length > 0
            );
            if (validRequired.length > 0) {
                converted.required = validRequired;
            }
        } else {
            logger.warn('Schema required field is not an array, ignoring');
        }
    }

    return converted;
}

/**
 * Schema for analysis response - ensures structured, validated output from Gemini
 */
const ANALYSIS_RESPONSE_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        recommendation: {
            type: SchemaType.STRING,
            description: "Trading recommendation",
            enum: ["STRONG_BUY", "BUY", "HOLD", "SELL", "STRONG_SELL"]
        },
        confidence: {
            type: SchemaType.NUMBER,
            description: "Confidence level 0-100",
        },
        priceTarget: {
            type: SchemaType.OBJECT,
            properties: {
                bull: { type: SchemaType.NUMBER, description: "Bull case price target" },
                base: { type: SchemaType.NUMBER, description: "Base case price target" },
                bear: { type: SchemaType.NUMBER, description: "Bear case price target" }
            },
            required: ["bull", "base", "bear"]
        },
        timeHorizon: {
            type: SchemaType.STRING,
            description: "Time horizon for analysis (e.g., '6 months', '12 months')"
        },
        positionSize: {
            type: SchemaType.NUMBER,
            description: "Position size recommendation 1-10 scale"
        },
        bullCase: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: "Bull case arguments with data"
        },
        bearCase: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: "Bear case arguments and risks"
        },
        catalysts: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING },
            description: "Catalysts with dates and expected impact"
        },
        summary: {
            type: SchemaType.STRING,
            description: "One sentence thesis summary"
        }
    },
    required: ["recommendation", "confidence", "priceTarget", "timeHorizon", "positionSize", "bullCase", "bearCase", "catalysts", "summary"]
};

/**
 * Schema for debate response
 */
const DEBATE_RESPONSE_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        turns: {
            type: SchemaType.ARRAY,
            items: {
                type: SchemaType.OBJECT,
                properties: {
                    speaker: {
                        type: SchemaType.STRING,
                        enum: ["bull", "bear"]
                    },
                    analystName: {
                        type: SchemaType.STRING,
                        description: "Name of the analyst speaking"
                    },
                    argument: { type: SchemaType.STRING },
                    strength: { type: SchemaType.NUMBER },
                    dataPointsReferenced: {
                        type: SchemaType.ARRAY,
                        items: { type: SchemaType.STRING }
                    }
                },
                required: ["speaker", "analystName", "argument", "strength", "dataPointsReferenced"]
            }
        },
        winner: {
            type: SchemaType.STRING,
            enum: ["bull", "bear", "draw"]
        },
        scores: {
            type: SchemaType.OBJECT,
            properties: {
                bullScore: { type: SchemaType.NUMBER },
                bearScore: { type: SchemaType.NUMBER },
                dataQuality: {
                    type: SchemaType.OBJECT,
                    properties: {
                        bull: { type: SchemaType.NUMBER },
                        bear: { type: SchemaType.NUMBER }
                    },
                    required: ["bull", "bear"]
                },
                logicCoherence: {
                    type: SchemaType.OBJECT,
                    properties: {
                        bull: { type: SchemaType.NUMBER },
                        bear: { type: SchemaType.NUMBER }
                    },
                    required: ["bull", "bear"]
                },
                riskAcknowledgment: {
                    type: SchemaType.OBJECT,
                    properties: {
                        bull: { type: SchemaType.NUMBER },
                        bear: { type: SchemaType.NUMBER }
                    },
                    required: ["bull", "bear"]
                },
                catalystIdentification: {
                    type: SchemaType.OBJECT,
                    properties: {
                        bull: { type: SchemaType.NUMBER },
                        bear: { type: SchemaType.NUMBER }
                    },
                    required: ["bull", "bear"]
                }
            },
            required: ["bullScore", "bearScore", "dataQuality", "logicCoherence", "riskAcknowledgment", "catalystIdentification"]
        },
        winningArguments: {
            type: SchemaType.ARRAY,
            items: { type: SchemaType.STRING }
        },
        summary: { type: SchemaType.STRING }
    },
    required: ["turns", "winner", "scores", "winningArguments", "summary"]
};

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
const METHODOLOGY_ORDER: AnalystMethodology[] = ['technical', 'macro', 'risk', 'quant'];

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
    keyMetrics: Record<string, string>;  // Object of key metrics like {"RSI": "65", "Volume": "1.2M"}
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
    fetchTimestamp?: number; // Unix timestamp (ms) when data was fetched
    // Additional WEEX data
    markPrice?: number;
    indexPrice?: number;
    bestBid?: number;
    bestAsk?: number;
    fundingRate?: number; // Optional: undefined means unavailable, 0 means zero funding
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
    stage: 'DECISION_MAKING' | 'STRATEGY_GENERATION' | 'RISK_ASSESSMENT' | 'COLLABORATIVE_TRADE' | 'POSITION_MANAGEMENT' | 'MANUAL_CLOSE'; // FIXED: Use enum values
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
    private geminiModel: GenerativeModel | null = null;
    private openRouterBaseUrl = 'https://openrouter.ai/api/v1';
    private currentProvider: 'gemini' | 'openrouter' | null = null;

    /**
     * Get or initialize Gemini model (only for Gemini provider)
     * FIXED: Separate model caching from provider logic
     */
    private getGeminiModel(): GenerativeModel {
        // GUARD: Only initialize if using Gemini
        if (config.ai.provider !== 'gemini') {
            throw new Error('getGeminiModel() called but provider is not gemini');
        }

        if (!this.geminiModel || this.currentProvider !== 'gemini') {
            if (!config.geminiApiKey) {
                throw new Error('GEMINI_API_KEY not configured');
            }
            const genAI = new GoogleGenerativeAI(config.geminiApiKey);
            this.geminiModel = genAI.getGenerativeModel({
                model: config.ai.model,
                generationConfig: {
                    responseMimeType: "application/json",
                    maxOutputTokens: config.ai.maxOutputTokens
                }
            });
            this.currentProvider = 'gemini';
            logger.info(`🔄 Initialized Gemini with model: ${config.ai.model}`);
        }
        return this.geminiModel;
    }

    /**
     * Validate OpenRouter configuration
     * FIXED: Fail fast with clear error messages
     */
    private validateOpenRouterConfig(): void {
        if (!config.openRouterApiKey) {
            throw new Error('OPENROUTER_API_KEY not configured. Set OPENROUTER_API_KEY in .env file.');
        }
        if (!config.ai.openRouterModel) {
            throw new Error('OPENROUTER_MODEL not configured. Set OPENROUTER_MODEL in .env file.');
        }
        // Log once per provider switch
        if (this.currentProvider !== 'openrouter') {
            logger.info(`🔄 Using OpenRouter with model: ${config.ai.openRouterModel}`);
            this.currentProvider = 'openrouter';
        }
    }

    /**
     * Split prompt into cacheable prefix and dynamic suffix for optimal caching
     * 
     * CACHING STRATEGY:
     * - Cacheable: System prompts, trading rules, analyst methodologies (static, ~40k tokens)
     * - Dynamic: Market data, prices, positions, timestamps (changes every cycle)
     * 
     * OpenRouter/DeepSeek caching:
     * - Minimum: 1024 tokens to activate caching
     * - TTL: 5-10 minutes (automatic)
     * - Cost: 90% savings on cached tokens
     * 
     * CRITICAL FIXES:
     * - Validates prompt is non-empty string
     * - Handles empty/whitespace-only prompts
     * - Prevents negative token counts
     * - Guards against malformed marker strings
     * 
     * @param prompt - Full prompt to split
     * @returns Object with cacheablePrefix and dynamicSuffix
     */
    private splitPromptForCaching(prompt: string): { cacheablePrefix: string; dynamicSuffix: string } {
        // CRITICAL: Validate input is a non-empty string
        if (!prompt || typeof prompt !== 'string') {
            logger.warn('splitPromptForCaching called with invalid prompt, returning empty split');
            return {
                cacheablePrefix: '',
                dynamicSuffix: ''
            };
        }

        // CRITICAL: Handle empty or whitespace-only prompts
        const trimmedPrompt = prompt.trim();
        if (trimmedPrompt.length === 0) {
            logger.warn('splitPromptForCaching called with empty prompt');
            return {
                cacheablePrefix: '',
                dynamicSuffix: ''
            };
        }

        // Markers that indicate start of dynamic content
        // CRITICAL: These must match actual prompt formats exactly
        const dynamicMarkers = [
            'MARKET DATA:',
            'CURRENT MARKET DATA',
            'ANALYZE THIS CRYPTO ASSET:',
            'PROPOSED TRADE:',
            'ACCOUNT STATE:',
            'CURRENT PORTFOLIO',
            'Previous Winners:',
            'Coin: ',
            'Current Price:',
            '24h Change:',
            'PREVIOUS ARGUMENTS IN THIS DEBATE'
        ];

        // Find the earliest dynamic marker
        let splitIndex = -1;
        let foundMarker = '';

        for (const marker of dynamicMarkers) {
            // CRITICAL: Validate marker is a string before indexOf
            if (!marker || typeof marker !== 'string') {
                continue;
            }
            const index = trimmedPrompt.indexOf(marker);
            if (index !== -1 && (splitIndex === -1 || index < splitIndex)) {
                splitIndex = index;
                foundMarker = marker;
            }
        }

        // If no marker found, cache the entire prompt (conservative approach)
        if (splitIndex === -1) {
            logger.debug('No dynamic marker found in prompt, caching entire prompt');
            return {
                cacheablePrefix: trimmedPrompt,
                dynamicSuffix: ''
            };
        }

        // CRITICAL: Validate splitIndex is within bounds
        if (splitIndex < 0 || splitIndex > trimmedPrompt.length) {
            logger.error(`Invalid splitIndex ${splitIndex} for prompt length ${trimmedPrompt.length}`);
            return {
                cacheablePrefix: trimmedPrompt,
                dynamicSuffix: ''
            };
        }

        // Split at the marker
        const cacheablePrefix = trimmedPrompt.substring(0, splitIndex).trim();
        const dynamicSuffix = trimmedPrompt.substring(splitIndex).trim();

        // CRITICAL: Estimate token counts with bounds checking
        // Token estimation: 1 token ≈ 4 chars is a rough approximation
        // Actual token counts vary by model and content (code, special chars, etc.)
        // This is used for cache threshold decisions, not billing - conservative is fine
        const prefixTokens = cacheablePrefix.length > 0 ? Math.ceil(cacheablePrefix.length / 4) : 0;
        const suffixTokens = dynamicSuffix.length > 0 ? Math.ceil(dynamicSuffix.length / 4) : 0;

        // CRITICAL: Validate token counts are non-negative
        if (prefixTokens < 0 || suffixTokens < 0 || !Number.isFinite(prefixTokens) || !Number.isFinite(suffixTokens)) {
            logger.error(`Invalid token counts: prefix=${prefixTokens}, suffix=${suffixTokens}`);
            return {
                cacheablePrefix: '',
                dynamicSuffix: trimmedPrompt
            };
        }

        logger.debug(
            `Prompt split for caching: ` +
            `prefix=${prefixTokens} tokens (cacheable), ` +
            `suffix=${suffixTokens} tokens (dynamic), ` +
            `marker="${foundMarker}"`
        );

        // Only cache if prefix is large enough (1024+ tokens)
        // CRITICAL: This prevents wasting cache on small prompts
        if (prefixTokens < 1024) {
            logger.debug(`Prefix too small (${prefixTokens} < 1024 tokens), not caching`);
            return {
                cacheablePrefix: '',
                dynamicSuffix: trimmedPrompt
            };
        }

        // CRITICAL: Final validation before returning
        // Ensure we're not returning undefined or null
        return {
            cacheablePrefix: cacheablePrefix || '',
            dynamicSuffix: dynamicSuffix || trimmedPrompt
        };
    }

    /**
     * Unified content generation that works with both Gemini and OpenRouter
     * @param prompt - The prompt to send
     * @param schema - The response schema
     * @param maxOutputTokens - Optional max tokens (defaults to config value)
     */
    private async generateContent(prompt: string, schema: any, maxOutputTokens?: number): Promise<{ text: string; finishReason: string }> {
        if (config.ai.provider === 'openrouter') {
            return await this.generateContentOpenRouter(prompt, schema, maxOutputTokens);
        } else {
            return await this.generateContentGemini(prompt, schema, maxOutputTokens);
        }
    }

    /**
     * Generate content using Gemini API
     * @param prompt - The prompt to send
     * @param schema - The response schema
     * @param maxOutputTokens - Optional max tokens (defaults to config value)
     */
    private async generateContentGemini(prompt: string, schema: any, maxOutputTokens?: number): Promise<{ text: string; finishReason: string }> {
        const model = this.getGeminiModel();

        const result = await model.generateContent({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: schema,
                maxOutputTokens: maxOutputTokens ?? config.ai.maxOutputTokens
            }
        });

        const text = result.response.text();
        const candidates = result.response.candidates;
        const finishReason = (candidates && candidates.length > 0)
            ? (candidates[0].finishReason || 'UNKNOWN')
            : 'UNKNOWN';

        return { text, finishReason };
    }

    /**
     * Generate content using OpenRouter API
     * FIXED: Added timeout, retry logic, better error handling
     * @param prompt - The prompt to send
     * @param geminiSchema - The response schema (Gemini format)
     * @param maxOutputTokens - Optional max tokens (defaults to config value)
     */
    private async generateContentOpenRouter(prompt: string, geminiSchema: any, maxOutputTokens?: number): Promise<{ text: string; finishReason: string }> {
        this.validateOpenRouterConfig();

        // Convert Gemini schema to OpenRouter JSON Schema format
        const openRouterSchema = convertGeminiSchemaToOpenRouter(geminiSchema);

        // PROMPT CACHING OPTIMIZATION for DeepSeek
        // Split prompt into cacheable prefix (system instructions, trading rules) and dynamic suffix (market data)
        // OpenRouter/DeepSeek automatically caches messages with cache_control
        // Minimum: 1024 tokens for caching to activate
        const { cacheablePrefix, dynamicSuffix } = this.splitPromptForCaching(prompt);

        const messages: any[] = [];

        // CRITICAL: Add cacheable prefix as system message if it exists AND is non-empty
        // Empty strings should not be added as messages
        if (cacheablePrefix && cacheablePrefix.trim().length > 0) {
            messages.push({
                role: 'system',
                content: cacheablePrefix,
                // Mark for caching - OpenRouter will cache this across requests
                cache_control: { type: 'ephemeral' }
            });
        }

        // CRITICAL: Add dynamic content as user message
        // Must have at least one message, so use full prompt as fallback
        const userContent = (dynamicSuffix && dynamicSuffix.trim().length > 0)
            ? dynamicSuffix
            : prompt;

        // CRITICAL: Validate userContent is not empty
        if (!userContent || userContent.trim().length === 0) {
            throw new Error('Cannot generate content with empty prompt');
        }

        messages.push({
            role: 'user',
            content: userContent
        });

        // CRITICAL: Validate we have at least one message
        if (messages.length === 0) {
            throw new Error('No messages to send to OpenRouter - prompt split failed');
        }

        const requestBody = {
            model: config.ai.openRouterModel,
            messages,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'analysis_response',
                    strict: true,
                    schema: openRouterSchema
                }
            },
            temperature: config.ai.temperature,
            max_tokens: maxOutputTokens ?? config.ai.maxOutputTokens,
        };

        // CRITICAL: Add timeout using AbortController
        // Must be cleaned up in finally block to prevent memory leaks
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

        try {
            const response = await fetch(`${this.openRouterBaseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${config.openRouterApiKey}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://hypothesis-arena.com',
                    'X-Title': 'Hypothesis Arena',
                },
                body: JSON.stringify(requestBody),
                signal: controller.signal,
            });

            // CRITICAL: Clear timeout immediately on success to prevent memory leak
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(
                    `OpenRouter API error (${response.status}) for model ${config.ai.openRouterModel}: ${errorText}`
                );
            }

            // CRITICAL: Validate response is JSON before parsing
            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                const text = await response.text();
                throw new Error(
                    `OpenRouter returned non-JSON response (${contentType}): ${text.slice(0, 200)}`
                );
            }

            const data: any = await response.json();

            // CRITICAL: Validate response structure before accessing
            if (!data || typeof data !== 'object') {
                throw new Error('OpenRouter returned invalid response structure');
            }

            if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
                throw new Error(
                    `OpenRouter returned no choices. Response: ${JSON.stringify(data).slice(0, 200)}`
                );
            }

            const choice = data.choices[0];
            if (!choice || !choice.message) {
                throw new Error('OpenRouter choice missing message field');
            }

            // CRITICAL: Validate message content exists
            const text = choice.message.content;
            if (text === null || text === undefined) {
                throw new Error('OpenRouter message content is null or undefined');
            }

            // Convert to string and handle empty responses
            const textStr = String(text).trim();
            if (textStr.length === 0) {
                throw new Error('OpenRouter returned empty message content');
            }

            const finishReason = choice.finish_reason || 'UNKNOWN';

            // CRITICAL: Extract JSON from markdown code blocks if present
            // Some models (like DeepSeek) wrap JSON in ```json ... ```
            let cleanedText = textStr;
            const jsonBlockMatch = cleanedText.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
            if (jsonBlockMatch && jsonBlockMatch[1]) {
                cleanedText = jsonBlockMatch[1].trim();
            }

            // CRITICAL: Validate JSON before returning
            try {
                JSON.parse(cleanedText);
            } catch (parseError) {
                throw new Error(
                    `OpenRouter returned invalid JSON: ${cleanedText.slice(0, 200)}. Parse error: ${parseError}`
                );
            }

            return { text: cleanedText, finishReason };
        } catch (error: any) {
            // CRITICAL: Better error messages for different error types
            if (error.name === 'AbortError') {
                throw new Error(
                    `OpenRouter request timeout after ${config.ai.requestTimeoutMs}ms for model ${config.ai.openRouterModel}`
                );
            }

            // CRITICAL: Handle rate limiting specifically
            if (error.message?.includes('429') || error.message?.toLowerCase().includes('rate limit')) {
                throw new Error(
                    `OpenRouter rate limit exceeded for model ${config.ai.openRouterModel}. ${error.message}`
                );
            }

            // Re-throw with context
            throw new Error(`OpenRouter request failed: ${error.message}`);
        } finally {
            // CRITICAL: Always clear timeout in finally block to prevent memory leak
            // This runs whether the request succeeds, fails, or is aborted
            clearTimeout(timeoutId);
        }
    }

    /**
     * Get analyst profile and system prompt by methodology (internal)
     */
    private getAnalystWithPrompt(methodology: AnalystMethodology) {
        const profile = ANALYST_PROFILES[methodology];
        const systemPrompt = getSystemPrompt(methodology, THESIS_SYSTEM_PROMPTS);
        return { profile, systemPrompt };
    }

    /**
     * Generate analysis from a specific analyst persona using enhanced prompts
     * Uses the exact JSON format from the prompts file
     * 
     * @param request - Analysis request with market data
     * @param arenaContext - Optional full arena context for autonomous trading
     */
    async generateAnalysis(request: AnalysisRequest, arenaContext?: FullArenaContext): Promise<AnalysisResult> {
        // Determine which analyst to use
        let methodology: AnalystMethodology;
        if (request.analystId) {
            methodology = METHODOLOGY_ORDER.find(m => ANALYST_PROFILES[m].id === request.analystId) || 'technical';
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

        // Build arena context section if provided
        const arenaContextSection = arenaContext ? `
${arenaContext.contextString}
` : '';

        // Prompt matches the exact format from analystPrompts.ts
        const prompt = `${systemPrompt}
${arenaContextSection}
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
${arenaContext ? `
IMPORTANT: You are competing in the Hypothesis Arena. Consider:
- Your current rank (#${arenaContext.myPortfolio.rank}) and performance (${arenaContext.myPortfolio.totalReturn >= 0 ? '+' : ''}${arenaContext.myPortfolio.totalReturn.toFixed(2)}%)
- Your available balance: $${arenaContext.myPortfolio.balance.toFixed(2)}
- The trading rules: Max ${arenaContext.tradingRules.maxPositionSizePercent}% position, ${arenaContext.tradingRules.maxLeverage}x max leverage
- Your competitors' performance and strategies
- Risk management: ${arenaContext.tradingRules.stopLossPercent}% stop loss, ${arenaContext.tradingRules.takeProfitPercent}% take profit
` : ''}
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

Respond ONLY with valid JSON matching this exact structure.`;

        let timeoutId: NodeJS.Timeout | null = null;
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('AI request timeout')), AI_REQUEST_TIMEOUT);
            });

            // Use unified content generation (works with both Gemini and OpenRouter)
            const { text, finishReason } = await Promise.race([
                this.generateContent(prompt, ANALYSIS_RESPONSE_SCHEMA),
                timeoutPromise
            ]);

            if (finishReason !== 'STOP' && finishReason !== 'stop') {
                logger.warn(`⚠️ Analysis finish reason: ${finishReason} (expected STOP)`);
            }

            // LOG FULL RAW AI RESPONSE with metadata
            logger.info(`\n${'─'.repeat(60)}`);
            logger.info(`📡 RAW AI RESPONSE for ${profile.name} Analysis (${config.ai.provider}):`);
            logger.info(`📊 Response length: ${text.length} chars | Finish reason: ${finishReason}`);
            // Log in chunks to avoid terminal buffer issues
            const chunkSize = 2000;
            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.slice(i, i + chunkSize);
                const chunkNum = Math.floor(i / chunkSize) + 1;
                const totalChunks = Math.ceil(text.length / chunkSize);
                if (totalChunks > 1) {
                    logger.info(`[Chunk ${chunkNum}/${totalChunks}] ${chunk}`);
                } else {
                    logger.info(chunk);
                }
            }
            logger.info(`${'─'.repeat(60)}\n`);

            const parsed = JSON.parse(text); // Both providers guarantee valid JSON with schema

            return this.parseAnalysisResponse(parsed, profile, methodology, request.currentPrice);
        } catch (error: any) {
            logger.error(`${config.ai.provider} analysis failed:`, { error: error.message, analyst: profile.id });
            throw new Error(`AI analysis failed: ${error.message}`);
        } finally {
            // Clear timeout to prevent memory leak
            if (timeoutId) clearTimeout(timeoutId);
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
     * Generate analyses from all 4 analysts with high-quality prompts
     * 
     * PERFORMANCE FIX: Process in parallel batches instead of sequentially.
     * Gemini 2.5 Flash has 1000 RPM limit, so we can safely run 4 concurrent requests.
     * This reduces latency from ~8x to ~2x compared to sequential processing.
     * 
     * @param request - Analysis request with market data
     * @param arenaContexts - Optional map of analyst ID to their arena context
     */
    async generateAllAnalyses(
        request: AnalysisRequest,
        arenaContexts?: Map<string, FullArenaContext>
    ): Promise<AnalysisResult[]> {
        const results: AnalysisResult[] = [];
        const BATCH_SIZE = 4; // Process 4 analysts concurrently

        // Process in batches of 4 for controlled parallelism
        for (let i = 0; i < METHODOLOGY_ORDER.length; i += BATCH_SIZE) {
            const batch = METHODOLOGY_ORDER.slice(i, i + BATCH_SIZE);

            const batchPromises = batch.map(async (methodology) => {
                const profile = ANALYST_PROFILES[methodology];
                try {
                    const arenaContext = arenaContexts?.get(profile.id);
                    return await this.generateAnalysisWithRetry(
                        { ...request, analystId: profile.id },
                        arenaContext
                    );
                } catch (err: any) {
                    logger.warn(`Analysis failed for ${profile.name}:`, err.message);
                    return null;
                }
            });

            const batchResults = await Promise.all(batchPromises);
            for (const result of batchResults) {
                if (result) results.push(result);
            }

            // Small delay between batches to avoid rate limit bursts
            if (i + BATCH_SIZE < METHODOLOGY_ORDER.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // Log for compliance
        if (results.length > 0) {
            await aiLogService.createLog(
                'analysis', 'all-analysts',
                { symbol: request.symbol, count: results.length },
                { summary: `${results.length} analyses generated` },
                `Generated ${results.length} analyst opinions`
            );
        }

        return results;
    }

    /**
     * Generate analysis with retry logic for rate limiting
     */
    private async generateAnalysisWithRetry(
        request: AnalysisRequest,
        arenaContext?: FullArenaContext,
        maxRetries: number = 3
    ): Promise<AnalysisResult | null> {
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                return await this.generateAnalysis(request, arenaContext);
            } catch (err: any) {
                const isRateLimit = err.message?.includes('429') || err.message?.includes('quota');

                if (isRateLimit && attempt < maxRetries - 1) {
                    // Extract retry delay from error or use exponential backoff
                    const retryMatch = err.message?.match(/retryDelay.*?(\d+)s/);
                    const retryDelay = retryMatch ? parseInt(retryMatch[1], 10) * 1000 : (attempt + 1) * 15000;

                    logger.warn(`Rate limited, waiting ${retryDelay / 1000}s before retry ${attempt + 2}/${maxRetries}`);
                    await new Promise(resolve => setTimeout(resolve, retryDelay));
                } else {
                    throw err;
                }
            }
        }
        return null;
    }

    /**
     * Generate a high-quality debate between bull and bear analysts
     * Enhanced with scoring breakdown and winning arguments extraction
     */
    async generateDebate(request: DebateRequest): Promise<DebateResult> {
        const displaySymbol = request.symbol.replace('cmt_', '').replace('usdt', '').toUpperCase();
        const roundLabel = request.round.toUpperCase().replace('FINAL', 'CHAMPIONSHIP');

        const prompt = buildDebatePrompt(
            roundLabel,
            displaySymbol,
            request.bullAnalysis,
            request.bearAnalysis,
            request.marketData
        );

        let timeoutId: NodeJS.Timeout | null = null;
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('AI request timeout')), AI_REQUEST_TIMEOUT);
            });

            // Use unified content generation (works with both Gemini and OpenRouter)
            const { text, finishReason } = await Promise.race([
                this.generateContent(prompt, DEBATE_RESPONSE_SCHEMA),
                timeoutPromise
            ]);

            if (finishReason !== 'STOP' && finishReason !== 'stop') {
                logger.warn(`⚠️ Debate finish reason: ${finishReason} (expected STOP)`);
            }

            // LOG FULL RAW AI RESPONSE with metadata
            logger.info(`\n${'─'.repeat(60)}`);
            logger.info(`📡 RAW AI RESPONSE for Debate (${request.round}, ${config.ai.provider}):`);
            logger.info(`📊 Response length: ${text.length} chars | Finish reason: ${finishReason}`);
            // Log in chunks to avoid terminal buffer issues
            const chunkSize = 2000;
            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.slice(i, i + chunkSize);
                const chunkNum = Math.floor(i / chunkSize) + 1;
                const totalChunks = Math.ceil(text.length / chunkSize);
                if (totalChunks > 1) {
                    logger.info(`[Chunk ${chunkNum}/${totalChunks}] ${chunk}`);
                } else {
                    logger.info(chunk);
                }
            }
            logger.info(`${'─'.repeat(60)}\n`);

            const parsed = JSON.parse(text); // Both providers guarantee valid JSON with schema

            return this.parseDebateResponse(parsed, request);
        } catch (error: any) {
            logger.error(`${config.ai.provider} debate failed:`, { error: error.message });
            throw new Error(`AI debate failed: ${error.message}`);
        } finally {
            // Clear timeout to prevent memory leak
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

    /**
     * Parse and validate debate response
     */
    private parseDebateResponse(parsed: any, request: DebateRequest): DebateResult {
        const winner = VALID_WINNERS.includes(parsed.winner) ? parsed.winner : 'draw';

        const turns: DebateTurn[] = Array.isArray(parsed.turns)
            ? parsed.turns.slice(0, 12).map((t: any) => ({
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
        symbol: string
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
                });
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
                    });
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
                });

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
        if (bracket.champion) {
            // Destructure to avoid null access issues
            const { analystId, analystName, recommendation } = bracket.champion;
            await aiLogService.createLog(
                'decision', 'tournament',
                { symbol, debates: bracket.quarterfinals.length + bracket.semifinals.length + (bracket.final ? 1 : 0) },
                { champion: analystId, recommendation },
                `Tournament champion: ${analystName} (${recommendation})`
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
        tournament?: TournamentBracket
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

        await aiLogService.createLog(
            'decision', 'signal-generator',
            { symbol, analysisCount: analyses.length },
            { action, confidence },
            `Signal: ${action.toUpperCase()} (${confidence.toFixed(0)}%)`
        );

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
        if (config.ai.provider === 'openrouter') {
            return !!config.openRouterApiKey;
        }
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
     * 
     * Enhanced: Now builds full arena context for each analyst and checks circuit breakers
     */
    async generateTradingDecision(
        marketData: ExtendedMarketData,
        accountBalance: number,
        existingPosition?: { side: 'LONG' | 'SHORT'; size: number },
        analystId?: string // Optional: generate decision for specific analyst
    ): Promise<TradingDecision> {
        // Validate symbol is approved for trading
        if (!this.isApprovedPair(marketData.symbol)) {
            throw new Error(`Symbol ${marketData.symbol} is not an approved WEEX trading pair. Approved pairs: ${WEEX_APPROVED_PAIRS.join(', ')}`);
        }

        // Build arena contexts for all analysts (or just one if specified)
        const arenaContexts = new Map<string, FullArenaContext>();
        const analystIds = analystId
            ? [analystId]
            : METHODOLOGY_ORDER.map(m => ANALYST_PROFILES[m].id);

        // Build context for each analyst in parallel
        const contextPromises = analystIds.map(async (id) => {
            try {
                const context = await arenaContextBuilder.buildContext(id, marketData.symbol, {
                    price: marketData.currentPrice,
                    change24h: marketData.change24h,
                    volume24h: marketData.volume24h,
                    high24h: marketData.high24h,
                    low24h: marketData.low24h,
                    fundingRate: marketData.fundingRate ?? 0, // Default to 0 if unavailable for context building
                });
                return { id, context };
            } catch (err: any) {
                logger.warn(`Failed to build arena context for ${id}:`, err.message);
                return null;
            }
        });

        const contextResults = await Promise.all(contextPromises);
        for (const result of contextResults) {
            if (result) {
                arenaContexts.set(result.id, result.context);
            }
        }

        // Generate all analyses with arena context
        const analyses = await this.generateAllAnalyses({
            symbol: marketData.symbol,
            currentPrice: marketData.currentPrice,
            high24h: marketData.high24h,
            low24h: marketData.low24h,
            volume24h: marketData.volume24h,
            change24h: marketData.change24h,
        }, arenaContexts);

        // GUARD: If no analyses generated, fail fast
        if (analyses.length === 0) {
            logger.error('No analyses generated - all analysts failed');
            return {
                shouldTrade: false,
                aiLog: {
                    stage: 'DECISION_MAKING', // FIXED: Use enum value
                    model: 'Gemini-2.0-Flash + Hypothesis Arena Multi-Agent System',
                    input: { symbol: marketData.symbol, error: 'No analyses generated' },
                    output: { decision: 'NO_TRADE', reason: 'All analysts failed to generate analysis' },
                    explanation: 'Unable to generate trading decision: all analyst analyses failed. This could indicate API issues or invalid market data.',
                },
                analysis: {
                    champion: null,
                    consensus: { bulls: 0, bears: 0, neutral: 0 },
                    confidence: 0,
                },
                riskManagement: {
                    positionSizePercent: 0,
                    leverage: 1,
                    takeProfitPrice: marketData.currentPrice,
                    stopLossPrice: marketData.currentPrice,
                    riskRewardRatio: 0,
                },
            };
        }

        // Run tournament to determine champion
        const tournament = await this.runTournament(
            analyses,
            {
                price: marketData.currentPrice,
                change24h: marketData.change24h,
                volume24h: marketData.volume24h,
            },
            marketData.symbol
        );

        // Calculate consensus
        const bulls = analyses.filter(a => ['strong_buy', 'buy'].includes(a.recommendation)).length;
        const bears = analyses.filter(a => ['strong_sell', 'sell'].includes(a.recommendation)).length;
        const neutral = analyses.length - bulls - bears;
        const avgConfidence = analyses.reduce((sum, a) => sum + a.confidence, 0) / (analyses.length || 1);

        // Determine if we should trade
        const champion = tournament.champion;
        const shouldTrade = this.shouldExecuteTrade(champion, bulls, bears, neutral, avgConfidence, existingPosition);

        // Calculate risk management parameters using config values
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
                existingPosition,
                accountBalance // Pass account balance for size calculation
            );
        }

        // Generate AI log for WEEX compliance (include arena context summary)
        const aiLog = this.generateAILog(
            marketData,
            analyses,
            tournament,
            champion,
            shouldTrade,
            order,
            arenaContexts.get(champion?.analystId || '')
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
     * Uses config values for thresholds
     */
    private shouldExecuteTrade(
        champion: AnalysisResult | null,
        bulls: number,
        bears: number,
        _neutral: number,
        avgConfidence: number,
        existingPosition?: { side: 'LONG' | 'SHORT'; size: number }
    ): boolean {
        // No champion = no trade
        if (!champion) return false;

        // HOLD recommendation = no new trade
        if (champion.recommendation === 'hold') return false;

        // Low confidence = no trade (use config threshold)
        if (avgConfidence < config.autonomous.minConfidenceToTrade) return false;

        // Check if champion has sufficient confidence
        if (champion.confidence < config.autonomous.minConfidenceToTrade) return false;

        // Check consensus alignment (use config threshold)
        const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);
        const isBearish = ['strong_sell', 'sell'].includes(champion.recommendation);

        // Champion should align with at least minConsensusToTrade analysts
        if (isBullish && bulls < config.autonomous.minConsensusToTrade) return false;
        if (isBearish && bears < config.autonomous.minConsensusToTrade) return false;

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
     * Calculate risk management parameters using config values
     */
    private calculateRiskManagement(
        marketData: ExtendedMarketData,
        champion: AnalysisResult | null,
        _accountBalance: number,
        avgConfidence: number
    ): TradingDecision['riskManagement'] {
        const price = marketData.currentPrice;

        // GUARD: Validate price
        if (!Number.isFinite(price) || price <= 0) {
            throw new Error(`Invalid market price: ${price}`);
        }

        // Default values from config
        let positionSizePercent = config.autonomous.maxPositionSizePercent / 3; // Start conservative
        let leverage = config.autonomous.defaultLeverage;
        let takeProfitPrice = price * (1 + config.autonomous.takeProfitPercent / 100);
        let stopLossPrice = price * (1 - config.autonomous.stopLossPercent / 100);

        if (champion) {
            // Position size based on champion's positionSize (1-10 scale)
            const sizeMultiplier = champion.positionSize / 10;
            let calculatedSize = config.autonomous.maxPositionSizePercent * sizeMultiplier;

            // Adjust for confidence BEFORE applying min
            if (avgConfidence < config.autonomous.minConfidenceToTrade + 10) {
                calculatedSize = calculatedSize * 0.7;
            }
            if (avgConfidence > 80) {
                calculatedSize = calculatedSize * 1.2;
            }

            // Apply min/max AFTER all multipliers
            positionSizePercent = Math.min(
                config.autonomous.maxPositionSizePercent,
                Math.max(5, calculatedSize)
            );

            // ENFORCE ABSOLUTE MAX LEVERAGE FROM CONFIG
            const ABSOLUTE_MAX_LEVERAGE = config.autonomous.maxLeverage;

            // Leverage based on risk level (capped by config max leverage)
            switch (champion.riskLevel) {
                case 'low':
                    leverage = Math.min(ABSOLUTE_MAX_LEVERAGE, 5);
                    break;
                case 'medium':
                    leverage = Math.min(ABSOLUTE_MAX_LEVERAGE, 4);
                    break;
                case 'high':
                    leverage = Math.min(ABSOLUTE_MAX_LEVERAGE, 3);
                    break;
                case 'very_high':
                    leverage = Math.min(ABSOLUTE_MAX_LEVERAGE, 2);
                    break;
            }

            // Note: leverage is already capped by ABSOLUTE_MAX_LEVERAGE above
            // which equals config.autonomous.maxLeverage, so no additional cap needed

            // TP/SL from champion's price targets
            const isBullish = ['strong_buy', 'buy'].includes(champion.recommendation);

            // FIXED: Correct logic for both LONG and SHORT positions
            if (isBullish) {
                // LONG position: TP above, SL below
                takeProfitPrice = champion.priceTarget.base;
                stopLossPrice = champion.priceTarget.bear;
            } else {
                // SHORT position: TP below, SL above
                takeProfitPrice = champion.priceTarget.bear;
                stopLossPrice = champion.priceTarget.bull;
            }

            // Validate TP/SL are sensible
            if (isBullish) {
                // For LONG: TP must be > price, SL must be < price
                if (takeProfitPrice <= price) takeProfitPrice = price * 1.15;
                if (stopLossPrice >= price) stopLossPrice = price * 0.90;
            } else {
                // For SHORT: TP must be < price, SL must be > price
                if (takeProfitPrice >= price) takeProfitPrice = price * 0.85;
                if (stopLossPrice <= price) stopLossPrice = price * 1.10;
            }

            // Ensure TP/SL are within config bounds
            const maxTpDistance = price * (config.autonomous.takeProfitPercent / 100);
            const maxSlDistance = price * (config.autonomous.stopLossPercent / 100);

            if (Math.abs(takeProfitPrice - price) > maxTpDistance * 2) {
                takeProfitPrice = isBullish
                    ? price + maxTpDistance
                    : price - maxTpDistance;
            }
            const rawSlMult = (config.autonomous.stopLossEnforcementMultiplier as any);
            let slMultiplier = Number(rawSlMult);
            if (!Number.isFinite(slMultiplier) || slMultiplier <= 0) {
                slMultiplier = 1;
            }
            if (Math.abs(stopLossPrice - price) > maxSlDistance * slMultiplier) {
                stopLossPrice = isBullish
                    ? price - (maxSlDistance * slMultiplier)
                    : price + (maxSlDistance * slMultiplier);
            }

            // VALIDATE STOP LOSS AGAINST METHODOLOGY REQUIREMENTS
            const METHOD_MAP: Record<string, keyof typeof config.autonomous.stopLossRequirements> = {
                value: 'VALUE',
                growth: 'GROWTH',
                technical: 'TECHNICAL',
                macro: 'MACRO',
                sentiment: 'SENTIMENT',
                risk: 'RISK',
                quant: 'QUANT',
                contrarian: 'CONTRARIAN',
            };
            const methodologyKey = METHOD_MAP[champion.methodology];
            let candidateRequired: any = methodologyKey
                ? config.autonomous.stopLossRequirements?.[methodologyKey]
                : undefined;
            let requiredStopLoss = Number(candidateRequired);
            if (!Number.isFinite(requiredStopLoss) || requiredStopLoss <= 0) {
                logger.warn(`Missing or invalid stop-loss requirement for methodology "${champion.methodology}". Using default ${config.autonomous.stopLossPercent}%.`);
                requiredStopLoss = config.autonomous.stopLossPercent;
            }
            const actualStopLossPercent = Math.abs((stopLossPrice - price) / price * 100);

            const maxAllowedStopLossPercent = Math.min(config.autonomous.stopLossPercent, requiredStopLoss);
            if (actualStopLossPercent > maxAllowedStopLossPercent) {
                logger.warn(`Stop loss ${actualStopLossPercent.toFixed(1)}% exceeds maximum allowed ${maxAllowedStopLossPercent}% (${champion.methodology})`);
                stopLossPrice = isBullish
                    ? price * (1 - maxAllowedStopLossPercent / 100)
                    : price * (1 + maxAllowedStopLossPercent / 100);
            }
        }

        // Calculate risk/reward ratio (guard against division by zero)
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
     * 
     * @param marketData - Market data including current price
     * @param champion - Winning analyst's analysis
     * @param riskManagement - Risk management parameters including position size
     * @param existingPosition - Optional existing position to close
     * @param accountBalance - Account balance for size calculation (REQUIRED for new positions)
     */
    private generateOrder(
        marketData: ExtendedMarketData,
        champion: AnalysisResult,
        riskManagement: TradingDecision['riskManagement'],
        existingPosition?: { side: 'LONG' | 'SHORT'; size: number },
        accountBalance?: number
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
            // Open new position - REQUIRE accountBalance for proper sizing
            orderType = isBullish ? '1' : '2'; // 1=Open long, 2=Open short

            // CRITICAL: Fail fast if accountBalance is missing for new positions
            if (!accountBalance || accountBalance <= 0) {
                throw new Error(
                    `Cannot create new position without valid account balance. ` +
                    `Analyst: ${champion.analystId}, Symbol: ${marketData.symbol}, ` +
                    `Position Size: ${riskManagement.positionSizePercent}%, ` +
                    `Leverage: ${riskManagement.leverage}x, ` +
                    `Balance provided: ${accountBalance}`
                );
            }

            // Validate market price before division
            if (!marketData.currentPrice || !Number.isFinite(marketData.currentPrice) || marketData.currentPrice <= 0) {
                throw new Error(
                    `Cannot create new position without valid market price. ` +
                    `Symbol: ${marketData.symbol}, Price: ${marketData.currentPrice}`
                );
            }

            // Calculate actual size from position size percent and account balance
            const positionValue = accountBalance * (riskManagement.positionSizePercent / 100);
            const rawSize = positionValue / marketData.currentPrice;

            // Validate calculated size
            if (!Number.isFinite(rawSize) || rawSize <= 0 || isNaN(rawSize)) {
                throw new Error(
                    `Invalid size calculated: ${rawSize}. ` +
                    `Balance: ${accountBalance}, Position %: ${riskManagement.positionSizePercent}%, ` +
                    `Price: ${marketData.currentPrice}`
                );
            }

            size = rawSize;

            // Ensure minimum size (0.001 for most pairs)
            if (size < 0.001) {
                logger.warn(
                    `Calculated size ${size} is below minimum for ${marketData.symbol}, using 0.001. ` +
                    `Balance: ${accountBalance}, Position %: ${riskManagement.positionSizePercent}%, ` +
                    `Price: ${marketData.currentPrice}`
                );
                size = 0.001;
            }
        }

        // Generate unique client order ID (max 40 chars per WEEX spec)
        const timestamp = Date.now();
        const clientOid = `ha_${champion.analystId}_${timestamp}`.slice(0, 40);

        // Validate client order ID length
        if (clientOid.length > 40) {
            logger.warn(`Client order ID truncated from ${`ha_${champion.analystId}_${timestamp}`.length} to 40 chars`);
        }

        // Determine position direction for TP/SL fallback logic
        const isLongPosition = isBullish;

        // Validate TP/SL prices before converting to string, with direction-aware fallbacks
        let validTpPrice: number;
        let validSlPrice: number;

        if (Number.isFinite(riskManagement.takeProfitPrice) && riskManagement.takeProfitPrice > 0) {
            validTpPrice = riskManagement.takeProfitPrice;
        } else {
            // Fallback: For LONG, TP is above current; for SHORT, TP is below current
            validTpPrice = isLongPosition
                ? marketData.currentPrice * 1.15  // LONG: 15% above
                : marketData.currentPrice * 0.85; // SHORT: 15% below
        }

        if (Number.isFinite(riskManagement.stopLossPrice) && riskManagement.stopLossPrice > 0) {
            validSlPrice = riskManagement.stopLossPrice;
        } else {
            // Fallback: For LONG, SL is below current; for SHORT, SL is above current
            validSlPrice = isLongPosition
                ? marketData.currentPrice * 0.90  // LONG: 10% below
                : marketData.currentPrice * 1.10; // SHORT: 10% above
        }

        // Log if we had to use fallback prices
        if (validTpPrice !== riskManagement.takeProfitPrice || validSlPrice !== riskManagement.stopLossPrice) {
            const direction = isLongPosition ? 'LONG' : 'SHORT';
            logger.warn(
                `Invalid TP/SL prices detected for ${direction} position, using direction-aware fallbacks: ` +
                `TP=${validTpPrice.toFixed(2)}, SL=${validSlPrice.toFixed(2)}, Current=${marketData.currentPrice.toFixed(2)}`
            );
        }

        return {
            symbol: marketData.symbol,
            client_oid: clientOid, // Already validated to be <= 40 chars
            size: roundToStepSize(size, marketData.symbol), // WEEX stepSize with contract specs
            type: orderType,
            order_type: '0', // Normal limit order
            match_price: '1', // Market price for immediate execution
            price: roundToTickSize(marketData.currentPrice, marketData.symbol), // WEEX tick_size with contract specs
            presetTakeProfitPrice: roundToTickSize(validTpPrice, marketData.symbol),
            presetStopLossPrice: roundToTickSize(validSlPrice, marketData.symbol),
            marginMode: 1, // Cross mode
        };
    }

    /**
     * Generate AI log for WEEX compliance
     * Enhanced: Includes arena context summary
     */
    private generateAILog(
        marketData: ExtendedMarketData,
        analyses: AnalysisResult[],
        tournament: TournamentBracket,
        champion: AnalysisResult | null,
        shouldTrade: boolean,
        order?: TradeOrder,
        arenaContext?: FullArenaContext
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
            tradingRules: {
                maxPositionSizePercent: config.autonomous.maxPositionSizePercent,
                maxLeverage: config.autonomous.maxLeverage,
                stopLossPercent: config.autonomous.stopLossPercent,
                takeProfitPercent: config.autonomous.takeProfitPercent,
                minConfidenceToTrade: config.autonomous.minConfidenceToTrade,
            },
        };

        // Add arena context if available
        if (arenaContext) {
            input.arenaState = {
                analystRank: arenaContext.myPortfolio.rank,
                analystBalance: arenaContext.myPortfolio.balance,
                analystReturn: arenaContext.myPortfolio.totalReturn,
                leaderboardTop3: arenaContext.arenaState.leaderboard.slice(0, 3).map(l => ({
                    name: l.analystName,
                    return: l.totalReturn,
                })),
                marketSentiment: arenaContext.arenaState.marketSentiment,
            };
        }

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

        // Add arena context to explanation
        if (arenaContext) {
            explanation += `Arena context: Analyst ranked #${arenaContext.myPortfolio.rank} with ${arenaContext.myPortfolio.totalReturn >= 0 ? '+' : ''}${arenaContext.myPortfolio.totalReturn.toFixed(2)}% return. `;
            explanation += `Market sentiment: ${arenaContext.arenaState.marketSentiment}. `;
        }

        if (shouldTrade && order) {
            const orderAction = order.type === '1' ? 'opening long' : order.type === '2' ? 'opening short' : order.type === '3' ? 'closing long' : 'closing short';
            explanation += `Decision: ${orderAction} position with TP at ${order.presetTakeProfitPrice} and SL at ${order.presetStopLossPrice}.`;
        } else {
            explanation += `Decision: No trade executed due to insufficient conviction or unfavorable risk/reward.`;
        }

        return {
            stage: shouldTrade ? 'COLLABORATIVE_TRADE' : 'DECISION_MAKING', // FIXED: Use enum values
            model: config.ai.provider === 'openrouter'
                ? `${config.ai.openRouterModel} (via OpenRouter) + Hypothesis Arena Multi-Agent System`
                : `${config.ai.model} + Hypothesis Arena Multi-Agent System`,
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
        analystId?: string
    ): Promise<AnalysisResult> {
        // Determine which analyst to use
        let methodology: AnalystMethodology;
        if (analystId) {
            methodology = METHODOLOGY_ORDER.find(m => ANALYST_PROFILES[m].id === analystId) || 'technical';
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

        let timeoutId: NodeJS.Timeout | null = null;
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error('AI request timeout')), AI_REQUEST_TIMEOUT);
            });

            // Use unified content generation (works with both Gemini and OpenRouter)
            const { text, finishReason } = await Promise.race([
                this.generateContent(prompt, ANALYSIS_RESPONSE_SCHEMA),
                timeoutPromise
            ]);

            if (finishReason !== 'STOP' && finishReason !== 'stop') {
                logger.warn(`⚠️ Extended Analysis finish reason: ${finishReason} (expected STOP)`);
            }

            // LOG FULL RAW AI RESPONSE with metadata
            logger.info(`\n${'─'.repeat(60)}`);
            logger.info(`📡 RAW AI RESPONSE for Extended Analysis (${profile.name}, ${config.ai.provider}):`);
            logger.info(`📊 Response length: ${text.length} chars | Finish reason: ${finishReason}`);
            // Log in chunks to avoid terminal buffer issues
            const chunkSize = 2000;
            for (let i = 0; i < text.length; i += chunkSize) {
                const chunk = text.slice(i, i + chunkSize);
                const chunkNum = Math.floor(i / chunkSize) + 1;
                const totalChunks = Math.ceil(text.length / chunkSize);
                if (totalChunks > 1) {
                    logger.info(`[Chunk ${chunkNum}/${totalChunks}] ${chunk}`);
                } else {
                    logger.info(chunk);
                }
            }
            logger.info(`${'─'.repeat(60)}\n`);

            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');

            const parsed = JSON.parse(jsonMatch[0]);
            return this.parseAnalysisResponse(parsed, profile, methodology, marketData.currentPrice);
        } catch (error: any) {
            logger.error(`${config.ai.provider} extended analysis failed:`, { error: error.message, analyst: profile.id });
            throw new Error(`AI analysis failed: ${error.message}`);
        } finally {
            // Clear timeout to prevent memory leak
            if (timeoutId) clearTimeout(timeoutId);
        }
    }

    /**
     * Generate content for Judge evaluation
     * Uses unified content generation that respects AI_PROVIDER config
     * 
     * @param prompt - The judge prompt
     * @param schema - The response schema (Gemini format, will be converted for OpenRouter)
     * @returns Parsed JSON response and finish reason
     */
    async generateJudgeContent(prompt: string, schema: any): Promise<{ text: string; finishReason: string }> {
        // Validate inputs
        if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
            throw new Error('generateJudgeContent: prompt is required');
        }
        if (!schema || typeof schema !== 'object') {
            throw new Error('generateJudgeContent: schema is required');
        }

        logger.info(`⚖️ Judge using ${config.ai.provider} provider`);

        // Use the unified content generation that routes to correct provider
        return await this.generateContent(prompt, schema, JUDGE_MAX_TOKENS);
    }

    /**
     * Cleanup method for graceful shutdown
     * Clears model instance to free resources
     * FIXED: Handle both providers
     */
    cleanup(): void {
        this.geminiModel = null;
        this.currentProvider = null;
        logger.debug('GeminiService cleaned up');
    }
}

export const geminiService = new GeminiService();
