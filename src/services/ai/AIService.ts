/**
 * Centralized AI Service
 * 
 * Handles all AI-powered analysis using Google's Gemini API or OpenRouter.
 * Supports strict JSON schemas for structured output.
 * 
 * Features:
 * - Dual provider support (Gemini / OpenRouter)
 * - Hybrid mode (v5.5.0) - split analysts across providers for diversity
 * - Strict JSON schema enforcement via responseSchema
 * - Schema conversion for OpenRouter compatibility
 * - Cross-provider fallback on failure
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
    private openRouterBaseUrl = 'https://openrouter.ai/api/v1';
    private initializingPromise: Promise<void> | null = null;

    // Hybrid mode: track if both providers are initialized
    private geminiInitialized: boolean = false;
    private openRouterValidated: boolean = false;

    /**
     * Get or initialize Gemini model with mutex protection
     * In hybrid mode, this can be called even if primary provider is openrouter
     */
    private async getGeminiModel(): Promise<GenerativeModel> {
        // In hybrid mode, allow Gemini initialization regardless of primary provider
        if (!config.ai.hybridMode && config.ai.provider !== 'gemini') {
            throw new Error('getGeminiModel() called but provider is not gemini and hybrid mode is disabled');
        }

        // Return cached model if available
        if (this.geminiModel && this.geminiInitialized) {
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
            if (this.geminiModel && this.geminiInitialized) {
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

        this.genAI = new GoogleGenerativeAI(config.geminiApiKey);
        this.geminiModel = this.genAI.getGenerativeModel({
            model: config.ai.model,
        });
        this.geminiInitialized = true;

        logger.info(`🤖 Gemini initialized with model: ${config.ai.model}`);
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
        if (!this.openRouterValidated) {
            logger.info(`🤖 OpenRouter validated with model: ${config.ai.openRouterModel}`);
            this.openRouterValidated = true;
        }
    }

    /**
     * Initialize hybrid mode - validate both providers are available
     * Uses mutex to prevent concurrent initialization
     */
    async initializeHybridMode(): Promise<void> {
        if (!config.ai.hybridMode) {
            return;
        }

        // Check which providers are needed
        const needsGemini = Object.values(config.ai.analystProviders).includes('gemini') ||
            config.ai.judgeProvider === 'gemini';
        const needsOpenRouter = Object.values(config.ai.analystProviders).includes('openrouter') ||
            config.ai.judgeProvider === 'openrouter';

        // Check if already fully initialized
        const geminiReady = !needsGemini || this.geminiInitialized;
        const openRouterReady = !needsOpenRouter || this.openRouterValidated;
        if (geminiReady && openRouterReady) {
            return;
        }

        // Prevent concurrent hybrid mode initialization - wait for existing
        if (this.initializingPromise) {
            try {
                await this.initializingPromise;
            } catch {
                // Previous initialization failed, will retry below
            }
            // Re-check after waiting
            const geminiReadyNow = !needsGemini || this.geminiInitialized;
            const openRouterReadyNow = !needsOpenRouter || this.openRouterValidated;
            if (geminiReadyNow && openRouterReadyNow) {
                return;
            }
            // If still not ready after waiting, fall through to retry
        }

        // Use mutex for the entire hybrid initialization
        this.initializingPromise = this._initializeHybridModeInternal();
        try {
            await this.initializingPromise;
        } finally {
            this.initializingPromise = null;
        }
    }

    /**
     * Internal hybrid mode initialization (called under mutex)
     */
    private async _initializeHybridModeInternal(): Promise<void> {
        const errors: string[] = [];

        // Check which providers are needed based on analyst assignments
        const needsGemini = Object.values(config.ai.analystProviders).includes('gemini') ||
            config.ai.judgeProvider === 'gemini';
        const needsOpenRouter = Object.values(config.ai.analystProviders).includes('openrouter') ||
            config.ai.judgeProvider === 'openrouter';

        if (needsGemini && !this.geminiInitialized) {
            try {
                await this._initializeGemini();
            } catch (error: any) {
                errors.push(`Gemini: ${error.message}`);
            }
        }

        if (needsOpenRouter && !this.openRouterValidated) {
            try {
                this.validateOpenRouterConfig();
            } catch (error: any) {
                errors.push(`OpenRouter: ${error.message}`);
            }
        }

        if (errors.length > 0) {
            throw new Error(`Hybrid mode initialization failed:\n${errors.join('\n')}`);
        }

        // Log hybrid mode configuration
        const analystAssignments = Object.entries(config.ai.analystProviders)
            .map(([analyst, provider]) => `${analyst}→${provider}`)
            .join(', ');
        logger.info(`🔀 Hybrid AI mode enabled: ${analystAssignments}, judge→${config.ai.judgeProvider}`);
    }

    /**
     * Get the provider for a specific analyst in hybrid mode
     */
    private getProviderForAnalyst(analystId: string): 'gemini' | 'openrouter' {
        if (!config.ai.hybridMode) {
            return config.ai.provider;
        }
        const mapping = config.ai.analystProviders as Record<string, 'gemini' | 'openrouter'>;
        const provider = mapping[analystId];
        if (!provider) {
            // Unknown analyst ID - log warning and fall back to default
            const knownAnalysts = Object.keys(config.ai.analystProviders).join(', ');
            logger.warn(`Unknown analyst ID '${analystId}' in getProviderForAnalyst. Known: [${knownAnalysts}]. Using default: ${config.ai.provider}`);
            return config.ai.provider;
        }
        return provider;
    }

    /**
     * Check if fallback provider is available and can be used
     * Also ensures the fallback provider is initialized if needed
     */
    private async canUseFallbackProvider(fallbackProvider: 'gemini' | 'openrouter'): Promise<boolean> {
        if (fallbackProvider === 'gemini') {
            if (!config.geminiApiKey) return false;
            // Ensure Gemini is initialized for fallback
            if (!this.geminiInitialized) {
                try {
                    await this._initializeGemini();
                } catch (error: any) {
                    logger.warn(`Failed to initialize Gemini for fallback: ${error.message}`);
                    return false;
                }
            }
            return true;
        } else {
            if (!config.openRouterApiKey) return false;
            // Ensure OpenRouter is validated for fallback
            if (!this.openRouterValidated) {
                try {
                    this.validateOpenRouterConfig();
                } catch (error: any) {
                    logger.warn(`Failed to validate OpenRouter for fallback: ${error.message}`);
                    return false;
                }
            }
            return true;
        }
    }

    /**
     * Attempt cross-provider fallback after primary provider failure
     * Returns null if fallback is not available or fails
     */
    private async attemptFallback(
        primaryProvider: 'gemini' | 'openrouter',
        prompt: string,
        schema: ResponseSchema,
        temperature: number | undefined,
        maxOutputTokens: number | undefined,
        requestId: string,
        logLabel: string
    ): Promise<AIGenerateResult | null> {
        if (!config.ai.hybridMode) {
            return null;
        }

        const fallbackProvider = primaryProvider === 'gemini' ? 'openrouter' : 'gemini';
        const canFallback = await this.canUseFallbackProvider(fallbackProvider);

        if (!canFallback) {
            logger.debug(`${logLabel} fallback to ${fallbackProvider} not available`);
            return null;
        }

        logger.info(`${logLabel} attempting fallback to ${fallbackProvider}`);
        const fallbackStart = Date.now();

        try {
            let result: AIGenerateResult;

            if (fallbackProvider === 'openrouter') {
                result = await this.generateContentOpenRouter(prompt, schema, temperature, maxOutputTokens, requestId);
            } else {
                result = await this.generateContentGemini(prompt, schema, temperature, maxOutputTokens, requestId);
            }

            const fallbackElapsed = Date.now() - fallbackStart;
            logger.info(`${logLabel} fallback to ${fallbackProvider} succeeded in ${fallbackElapsed}ms`);

            return result;
        } catch (fallbackError: any) {
            logger.error(`${logLabel} fallback to ${fallbackProvider} also failed: ${fallbackError.message}`);
            return null;
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
     * Generate content for a specific analyst (hybrid mode aware)
     * Routes to the correct provider based on analyst assignment
     * Includes cross-provider fallback on failure
     * 
     * @param analystId - The analyst ID (jim, ray, karen, quant)
     * @param options - Generation options
     * @returns Generated text and metadata
     */
    async generateContentForAnalyst(
        analystId: string,
        options: AIGenerateOptions
    ): Promise<AIGenerateResult> {
        const { prompt, schema, temperature, maxOutputTokens, label } = options;

        // Validate inputs
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Cannot generate content with empty prompt');
        }

        validateSchema(schema);

        const requestId = generateRequestId();
        const primaryProvider = this.getProviderForAnalyst(analystId);
        const logLabel = label ? `${label}[${requestId}]` : `${analystId}[${requestId}]`;
        const startTime = Date.now();

        try {
            let result: AIGenerateResult;

            if (primaryProvider === 'openrouter') {
                result = await this.generateContentOpenRouter(prompt, schema, temperature, maxOutputTokens, requestId);
            } else {
                result = await this.generateContentGemini(prompt, schema, temperature, maxOutputTokens, requestId);
            }

            const elapsed = Date.now() - startTime;
            logger.debug(`${logLabel} completed via ${primaryProvider} in ${elapsed}ms`);

            return result;
        } catch (primaryError: any) {
            const elapsed = Date.now() - startTime;
            logger.warn(`${logLabel} ${primaryProvider} failed after ${elapsed}ms: ${primaryError.message}`);

            // Attempt cross-provider fallback
            const fallbackResult = await this.attemptFallback(
                primaryProvider, prompt, schema, temperature, maxOutputTokens, requestId, logLabel
            );

            if (fallbackResult) {
                return fallbackResult;
            }

            throw primaryError;
        }
    }

    /**
     * Generate content for judge (hybrid mode aware)
     * Uses the configured judge provider with cross-provider fallback
     */
    async generateContentForJudge(options: AIGenerateOptions): Promise<AIGenerateResult> {
        const { prompt, schema, temperature, maxOutputTokens, label } = options;

        // Validate inputs
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Cannot generate content with empty prompt');
        }

        validateSchema(schema);

        const requestId = generateRequestId();
        const primaryProvider = config.ai.hybridMode ? config.ai.judgeProvider : config.ai.provider;
        const logLabel = label ? `${label}[${requestId}]` : `Judge[${requestId}]`;
        const startTime = Date.now();

        try {
            let result: AIGenerateResult;

            if (primaryProvider === 'openrouter') {
                result = await this.generateContentOpenRouter(prompt, schema, temperature, maxOutputTokens, requestId);
            } else {
                result = await this.generateContentGemini(prompt, schema, temperature, maxOutputTokens, requestId);
            }

            const elapsed = Date.now() - startTime;
            logger.debug(`${logLabel} completed via ${primaryProvider} in ${elapsed}ms`);

            return result;
        } catch (primaryError: any) {
            const elapsed = Date.now() - startTime;
            logger.warn(`${logLabel} ${primaryProvider} failed after ${elapsed}ms: ${primaryError.message}`);

            // Attempt cross-provider fallback
            const fallbackResult = await this.attemptFallback(
                primaryProvider, prompt, schema, temperature, maxOutputTokens, requestId, logLabel
            );

            if (fallbackResult) {
                return fallbackResult;
            }

            throw primaryError;
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
            let response: Response;

            // First fetch attempt
            try {
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
            } catch (fetchError: any) {
                // Network error or abort - body doesn't exist
                clearTimeout(timeoutId);
                if (fetchError.name === 'AbortError') {
                    throw new Error(`OpenRouter request timeout after ${config.ai.requestTimeoutMs}ms`);
                }
                throw new Error(`OpenRouter network error: ${fetchError.message}`);
            }

            // Handle errors with fallback
            if (!response.ok) {
                let errorText: string;
                try {
                    errorText = await response.text();
                } catch (bodyError: any) {
                    // Body is unusable - likely network issue or stream already consumed
                    clearTimeout(timeoutId);
                    throw new Error(`OpenRouter error (${response.status}): Unable to read response body - ${bodyError.message}`);
                }

                // Check if this is a "no endpoints" error (model not available)
                const isNoEndpointsError =
                    errorText.includes('No endpoints found') ||
                    errorText.includes('no endpoints') ||
                    (response.status === 404 && errorText.includes('endpoint'));

                if (isNoEndpointsError) {
                    clearTimeout(timeoutId);
                    logger.error(`Model ${config.ai.openRouterModel} has no available endpoints`);
                    throw new Error(`OpenRouter: Model ${config.ai.openRouterModel} has no available providers. Check OpenRouter dashboard or try a different model.`);
                }

                // Check if this is a response_format error (model doesn't support json_object)
                const isFormatError =
                    errorText.includes('response_format') ||
                    errorText.includes('json_object') ||
                    errorText.includes('json_schema') ||
                    errorText.includes('structured output');

                if (isFormatError) {
                    logger.warn(`Model may not support json_object, retrying without response_format`);

                    // Fallback: no response_format, rely on prompt to get JSON
                    delete requestBody.response_format;

                    try {
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
                    } catch (retryFetchError: any) {
                        clearTimeout(timeoutId);
                        if (retryFetchError.name === 'AbortError') {
                            throw new Error(`OpenRouter request timeout after ${config.ai.requestTimeoutMs}ms`);
                        }
                        throw new Error(`OpenRouter network error on retry: ${retryFetchError.message}`);
                    }
                } else {
                    // Not a format error - throw with the error details we already have
                    clearTimeout(timeoutId);

                    let errorDetails = '';
                    try {
                        const errorJson = JSON.parse(errorText);
                        errorDetails = errorJson.error?.message || errorJson.message || '';
                    } catch {
                        errorDetails = errorText.slice(0, 200);
                    }

                    const error = new Error(`OpenRouter API error (${response.status}): ${errorDetails}`);

                    if (response.status === 429) {
                        (error as any).isRateLimit = true;
                        const retryAfter = response.headers.get('retry-after');
                        if (retryAfter) {
                            (error as any).retryAfter = parseInt(retryAfter, 10);
                        }
                    }

                    throw error;
                }
            }

            // Clear timeout after successful fetch
            clearTimeout(timeoutId);

            // Check if retry response is also not ok
            if (!response.ok) {
                let errorText: string;
                try {
                    errorText = await response.text();
                } catch {
                    errorText = 'Unable to read error response';
                }

                let errorDetails = '';
                try {
                    const errorJson = JSON.parse(errorText);
                    errorDetails = errorJson.error?.message || errorJson.message || '';
                } catch {
                    errorDetails = errorText.slice(0, 200);
                }

                const error = new Error(`OpenRouter API error (${response.status}): ${errorDetails}`);

                if (response.status === 429) {
                    (error as any).isRateLimit = true;
                    const retryAfter = response.headers.get('retry-after');
                    if (retryAfter) {
                        (error as any).retryAfter = parseInt(retryAfter, 10);
                    }
                }

                throw error;
            }

            // Parse response JSON
            let data: any;
            try {
                data = await response.json();
            } catch (jsonError: any) {
                throw new Error(`OpenRouter returned invalid JSON response: ${jsonError.message}`);
            }

            // Check for parsed field first (structured outputs)
            let text: string;
            if (data?.choices?.[0]?.message?.parsed) {
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
        if (config.ai.hybridMode) {
            // In hybrid mode, check which providers are needed
            const needsGemini = Object.values(config.ai.analystProviders).includes('gemini') ||
                config.ai.judgeProvider === 'gemini';
            const needsOpenRouter = Object.values(config.ai.analystProviders).includes('openrouter') ||
                config.ai.judgeProvider === 'openrouter';

            if (needsGemini && !config.geminiApiKey) return false;
            if (needsOpenRouter && !config.openRouterApiKey) return false;
            return true;
        }

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
     * Check if hybrid mode is enabled
     */
    isHybridMode(): boolean {
        return config.ai.hybridMode;
    }

    /**
     * Cleanup resources
     */
    cleanup(): void {
        this.geminiModel = null;
        this.genAI = null;
        this.initializingPromise = null;
        this.geminiInitialized = false;
        this.openRouterValidated = false;
        logger.debug('AIService cleaned up');
    }
}

// Singleton instance
export const aiService = new AIService();

// Re-export schema types for convenience
export { SchemaType, ResponseSchema };

// Export utility for rate limit detection
export { isRateLimitError };
