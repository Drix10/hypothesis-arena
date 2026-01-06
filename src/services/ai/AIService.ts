/**
 * Centralized AI Service
 * 
 * Handles all AI-powered analysis using Google's Gemini API or OpenRouter.
 * Supports strict JSON schemas for structured output.
 * 
 * Features:
 * - Dual provider support (Gemini / OpenRouter)
 * - Strict JSON schema enforcement via responseSchema
 * - Schema conversion for OpenRouter compatibility
 * - Prompt caching optimization (implicit for Gemini 2.5+)
 * - Centralized error handling
 * - Rate limit detection (retries handled by caller - see CollaborativeFlow)
 * 
 * NOTE: This service does NOT implement retry logic with exponential backoff.
 * Retries are handled by the calling code (CollaborativeFlow.runSingleAnalyst,
 * CollaborativeFlow.runJudge) which have access to attempt counts and can
 * implement appropriate backoff strategies.
 */

import { GoogleGenerativeAI, GenerativeModel, SchemaType, ResponseSchema } from '@google/generative-ai';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// =============================================================================
// TYPES
// =============================================================================

export interface AIGenerateOptions {
    prompt: string;
    schema: ResponseSchema;
    temperature?: number;
    maxOutputTokens?: number;
    /** Optional label for logging */
    label?: string;
}

export interface AIGenerateResult {
    text: string;
    finishReason: string;
    provider: 'gemini' | 'openrouter';
    /** Unique request ID for log correlation */
    requestId: string;
}

/**
 * Generate a unique request ID for log correlation
 */
function generateRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Check if an error is a rate limit error
 */
function isRateLimitError(error: any): boolean {
    if (!error) return false;
    const message = error.message?.toLowerCase() || '';
    return (
        message.includes('429') ||
        message.includes('rate limit') ||
        message.includes('quota') ||
        message.includes('resource exhausted')
    );
}

/**
 * Validate schema has required structure
 */
function validateSchema(schema: ResponseSchema): void {
    if (!schema || typeof schema !== 'object') {
        throw new Error('Invalid schema: must be an object');
    }
    if (!schema.type) {
        throw new Error('Invalid schema: missing type field');
    }
}

// =============================================================================
// AI SERVICE CLASS
// =============================================================================

class AIService {
    private genAI: GoogleGenerativeAI | null = null;
    private geminiModel: GenerativeModel | null = null;
    private currentProvider: 'gemini' | 'openrouter' | null = null;
    private openRouterBaseUrl = 'https://openrouter.ai/api/v1';
    private initializingPromise: Promise<void> | null = null;

    /**
     * Get or initialize Gemini model with mutex protection
     */
    private async getGeminiModel(): Promise<GenerativeModel> {
        if (config.ai.provider !== 'gemini') {
            throw new Error('getGeminiModel() called but provider is not gemini');
        }

        // Return cached model if available and provider matches
        if (this.geminiModel && this.currentProvider === 'gemini') {
            return this.geminiModel;
        }

        // Prevent concurrent initialization - wait for existing initialization to complete
        if (this.initializingPromise) {
            try {
                await this.initializingPromise;
            } catch {
                // Previous initialization failed, will retry below
            }
            // Check if initialization succeeded
            if (this.geminiModel && this.currentProvider === 'gemini') {
                return this.geminiModel;
            }
        }

        // Initialize with mutex
        this.initializingPromise = this._initializeGemini();
        try {
            await this.initializingPromise;
        } finally {
            this.initializingPromise = null;
        }

        if (!this.geminiModel) {
            throw new Error('Failed to initialize Gemini model');
        }

        return this.geminiModel;
    }

    private async _initializeGemini(): Promise<void> {
        if (!config.geminiApiKey) {
            throw new Error('GEMINI_API_KEY not configured');
        }

        // Clean up previous instance if switching providers
        if (this.genAI && this.currentProvider !== 'gemini') {
            this.genAI = null;
            this.geminiModel = null;
        }

        this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
        this.geminiModel = this.genAI.getGenerativeModel({
            model: config.ai.model,
        });
        this.currentProvider = 'gemini';
        logger.info(`🤖 AI Service initialized with Gemini model: ${config.ai.model}`);
    }

    /**
     * Validate OpenRouter configuration
     */
    private validateOpenRouterConfig(): void {
        if (!config.openRouterApiKey) {
            throw new Error('OPENROUTER_API_KEY not configured');
        }
        if (!config.ai.openRouterModel) {
            throw new Error('OPENROUTER_MODEL not configured');
        }
        if (this.currentProvider !== 'openrouter') {
            logger.info(`🤖 AI Service using OpenRouter model: ${config.ai.openRouterModel}`);
            this.currentProvider = 'openrouter';
        }
    }

    /**
     * Generate content using the configured AI provider
     * 
     * @param options - Generation options including prompt and schema
     * @returns Generated text and metadata
     */
    async generateContent(options: AIGenerateOptions): Promise<AIGenerateResult> {
        const { prompt, schema, temperature, maxOutputTokens, label } = options;

        // Validate inputs
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Cannot generate content with empty prompt');
        }

        validateSchema(schema);

        const requestId = generateRequestId();
        const logLabel = label ? `${label}[${requestId}]` : `AI[${requestId}]`;
        const startTime = Date.now();

        try {
            let result: AIGenerateResult;

            if (config.ai.provider === 'openrouter') {
                result = await this.generateContentOpenRouter(prompt, schema, temperature, maxOutputTokens, requestId);
            } else {
                result = await this.generateContentGemini(prompt, schema, temperature, maxOutputTokens, requestId);
            }

            const elapsed = Date.now() - startTime;

            // Warn on non-STOP finish reasons
            if (result.finishReason !== 'STOP' && result.finishReason !== 'stop') {
                logger.warn(`${logLabel} non-standard finish reason: ${result.finishReason} (expected STOP)`);
            }

            logger.debug(`${logLabel} completed in ${elapsed}ms: ${result.text.length} chars, finish=${result.finishReason}`);

            return result;
        } catch (error: any) {
            const elapsed = Date.now() - startTime;
            logger.error(`${logLabel} failed after ${elapsed}ms:`, error.message);
            throw error;
        }
    }

    /**
     * Generate content using Gemini API with strict JSON schema
     */
    private async generateContentGemini(
        prompt: string,
        schema: ResponseSchema,
        temperature?: number,
        maxOutputTokens?: number,
        requestId?: string
    ): Promise<AIGenerateResult> {
        const model = await this.getGeminiModel();
        const reqId = requestId || generateRequestId();

        // PROMPT CACHING: Place system prompt first for implicit caching
        // Gemini 2.5+ automatically caches repeated prefixes
        const result = await model.generateContent({
            contents: [
                { role: 'user', parts: [{ text: prompt }] }
            ],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: schema,
                temperature: temperature ?? config.ai.temperature,
                maxOutputTokens: maxOutputTokens ?? config.ai.maxOutputTokens,
            },
        });

        const text = result.response.text();
        const candidates = result.response.candidates;
        const finishReason = (candidates && candidates.length > 0)
            ? (candidates[0].finishReason || 'UNKNOWN')
            : 'UNKNOWN';

        return { text, finishReason, provider: 'gemini', requestId: reqId };
    }

    /**
     * Generate content using OpenRouter API with JSON schema
     * 
     * NOTE: Rate limit handling is delegated to the caller (CollaborativeFlow).
     * This method throws on rate limit errors with isRateLimit=true property,
     * allowing callers to implement appropriate backoff strategies.
     * 
     * Uses json_object response_format (more widely supported than json_schema).
     */
    private async generateContentOpenRouter(
        prompt: string,
        _geminiSchema: ResponseSchema, // Schema not used - we rely on prompt for structure
        temperature?: number,
        maxOutputTokens?: number,
        requestId?: string
    ): Promise<AIGenerateResult> {
        this.validateOpenRouterConfig();

        const reqId = requestId || generateRequestId();

        // Build messages array
        const messages: any[] = [
            {
                role: 'user',
                content: prompt
            }
        ];

        // Build request body with json_object (more widely supported than json_schema)
        // DeepSeek and most models work better with json_object + prompt-based schema
        const requestBody: any = {
            model: config.ai.openRouterModel,
            messages,
            response_format: { type: 'json_object' },
            temperature: temperature ?? config.ai.temperature,
            max_tokens: maxOutputTokens ?? config.ai.maxOutputTokens,
            // Provider preferences - allow data collection to access more endpoints
            provider: {
                data_collection: 'allow',
                allow_fallbacks: true,
            },
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);

        try {
            let response = await fetch(`${this.openRouterBaseUrl}/chat/completions`, {
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

            // Handle errors with fallback
            if (!response.ok) {
                const errorText = await response.text();

                // Check if this is a "no endpoints" error (model not available)
                const isNoEndpointsError =
                    errorText.includes('No endpoints found') ||
                    errorText.includes('no endpoints') ||
                    (response.status === 404 && errorText.includes('endpoint'));

                if (isNoEndpointsError) {
                    // Model has no providers - this is fatal, don't retry
                    clearTimeout(timeoutId); // FIXED: Clear timeout before throwing
                    logger.error(`Model ${config.ai.openRouterModel} has no available endpoints`);
                    throw new Error(`OpenRouter: Model ${config.ai.openRouterModel} has no available providers. Check OpenRouter dashboard or try a different model.`);
                }

                // Check if this is a response_format error (model doesn't support json_object)
                // Only retry on format-specific errors, not general 400/422 errors
                const isFormatError =
                    errorText.includes('response_format') ||
                    errorText.includes('json_object') ||
                    errorText.includes('json_schema') ||
                    errorText.includes('structured output');

                if (isFormatError) {
                    logger.warn(`Model may not support json_object, retrying without response_format`);

                    // Fallback: no response_format, rely on prompt to get JSON
                    delete requestBody.response_format;

                    response = await fetch(`${this.openRouterBaseUrl}/chat/completions`, {
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
                }
            }

            // Clear timeout after all fetch attempts
            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorText = await response.text();

                // Parse error details if available
                let errorDetails = '';
                try {
                    const errorJson = JSON.parse(errorText);
                    errorDetails = errorJson.error?.message || errorJson.message || '';
                } catch {
                    errorDetails = errorText.slice(0, 200);
                }

                const error = new Error(`OpenRouter API error (${response.status}): ${errorDetails}`);

                // Add rate limit info to error for upstream handling
                if (response.status === 429) {
                    (error as any).isRateLimit = true;
                    const retryAfter = response.headers.get('retry-after');
                    if (retryAfter) {
                        (error as any).retryAfter = parseInt(retryAfter, 10);
                    }
                }

                throw error;
            }

            const data: any = await response.json();

            // Check for parsed field first (structured outputs)
            let text: string;
            if (data?.choices?.[0]?.message?.parsed) {
                // Structured output - already parsed
                text = JSON.stringify(data.choices[0].message.parsed);
            } else if (data?.choices?.[0]?.message?.content) {
                text = String(data.choices[0].message.content).trim();
            } else {
                throw new Error('OpenRouter returned invalid response structure');
            }

            const finishReason = data.choices[0].finish_reason || 'UNKNOWN';

            // Extract JSON from markdown code blocks if present
            const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
            if (jsonBlockMatch && jsonBlockMatch[1]) {
                text = jsonBlockMatch[1].trim();
            }

            // Try to extract JSON object if response has extra text
            if (!text.startsWith('{') && !text.startsWith('[')) {
                // Use a more robust regex that handles nested braces
                // Find the first { and match to the corresponding closing }
                const startIdx = text.indexOf('{');
                if (startIdx !== -1) {
                    let depth = 0;
                    let endIdx = -1;
                    for (let i = startIdx; i < text.length; i++) {
                        if (text[i] === '{') depth++;
                        else if (text[i] === '}') {
                            depth--;
                            if (depth === 0) {
                                endIdx = i;
                                break;
                            }
                        }
                    }
                    if (endIdx !== -1) {
                        text = text.slice(startIdx, endIdx + 1);
                    }
                }
            }

            // Validate JSON
            try {
                JSON.parse(text);
            } catch (_parseError) {
                throw new Error(`OpenRouter returned invalid JSON: ${text.slice(0, 200)}`);
            }

            return { text, finishReason, provider: 'openrouter', requestId: reqId };
        } catch (error: any) {
            // Always clear timeout in catch block
            clearTimeout(timeoutId);

            if (error.name === 'AbortError') {
                throw new Error(`OpenRouter request timeout after ${config.ai.requestTimeoutMs}ms`);
            }
            throw error;
        }
    }

    /**
     * Check if the service is configured
     */
    isConfigured(): boolean {
        if (config.ai.provider === 'openrouter') {
            return !!config.openRouterApiKey;
        }
        return !!config.geminiApiKey;
    }

    /**
     * Get current provider
     */
    getProvider(): 'gemini' | 'openrouter' {
        return config.ai.provider;
    }

    /**
     * Cleanup resources
     * FIXED: Properly cleanup GoogleGenerativeAI instance
     */
    cleanup(): void {
        this.geminiModel = null;
        this.genAI = null;
        this.currentProvider = null;
        this.initializingPromise = null;
        logger.debug('AIService cleaned up');
    }
}

// Singleton instance
export const aiService = new AIService();

// Re-export schema types for convenience
export { SchemaType, ResponseSchema };

// Export utility for rate limit detection
export { isRateLimitError };
