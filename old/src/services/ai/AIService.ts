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
import { GoogleAICacheManager } from '@google/generative-ai/server';
import { createHash } from 'crypto';
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
    provider?: 'gemini' | 'openrouter';
    model?: string;
    topP?: number;
    presencePenalty?: number;
    frequencyPenalty?: number;
    stop?: string[];
    /** Force a fresh API call, bypassing local and remote caches */
    bypassCache?: boolean;
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

function splitPromptSystemUser(prompt: string): { system: string | null; user: string } {
    const normalized = (prompt ?? '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return { system: null, user: '' };

    const separatorRegex = /(?:^|\n)\s*---USER---\s*(?:\n|$)/;
    const match = separatorRegex.exec(normalized);
    if (!match || typeof match.index !== 'number') {
        return { system: null, user: normalized };
    }

    const system = normalized.slice(0, match.index).trim();
    const user = normalized.slice(match.index + match[0].length).trim();
    return {
        system: system.length > 0 ? system : null,
        user,
    };
}

function stripLeadingThinking(text: string): string {
    let out = text;
    // Remove thinking blocks at the start of the string
    // We don't enforce lookahead for { or [ because sometimes there's filler text in between
    out = out.replace(/^\s*```(?:thinking|reasoning)\b[\s\S]*?```/i, '');
    out = out.replace(/^\s*<think>[\s\S]*?<\/think>/i, '');
    out = out.replace(/^\s*<thinking>[\s\S]*?<\/thinking>/i, '');
    out = out.replace(/^\s*<\|think\|>[\s\S]*?<\|\/think\|>/i, '');
    return out.trim();
}

function extractThinking(text: string): string | null {
    const matchFence = text.match(/```(?:thinking|reasoning)\b\s*\n?([\s\S]*?)\n?```/i);
    if (matchFence && matchFence[1]) return matchFence[1].trim();

    const matchThink = text.match(/<think>\s*([\s\S]*?)\s*<\/think>/i);
    if (matchThink && matchThink[1]) return matchThink[1].trim();

    const matchThinking = text.match(/<thinking>\s*([\s\S]*?)\s*<\/thinking>/i);
    if (matchThinking && matchThinking[1]) return matchThinking[1].trim();

    const matchToken = text.match(/<\|think\|>\s*([\s\S]*?)\s*<\|\/think\|>/i);
    if (matchToken && matchToken[1]) return matchToken[1].trim();

    return null;
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

/**
 * Convert Gemini ResponseSchema to OpenRouter JSON Schema format
 * OpenRouter uses standard JSON Schema with strict mode
 */
function convertToOpenRouterSchema(geminiSchema: ResponseSchema): any {
    const convertType = (type: SchemaType | undefined): string => {
        if (!type) return 'string';
        switch (type) {
            case SchemaType.STRING: return 'string';
            case SchemaType.NUMBER: return 'number';
            case SchemaType.INTEGER: return 'integer';
            case SchemaType.BOOLEAN: return 'boolean';
            case SchemaType.ARRAY: return 'array';
            case SchemaType.OBJECT: return 'object';
            default: return 'string';
        }
    };

    const convertSchema = (schema: ResponseSchema): any => {
        const baseResult: any = {
            type: convertType(schema.type),
        };

        if (schema.description) {
            baseResult.description = schema.description;
        }

        if ('enum' in schema && Array.isArray((schema as { enum: string[] }).enum)) {
            baseResult.enum = (schema as { enum: string[] }).enum;
        }

        // Handle object properties
        if (schema.type === SchemaType.OBJECT && schema.properties) {
            baseResult.properties = {};
            for (const [key, value] of Object.entries(schema.properties)) {
                baseResult.properties[key] = convertSchema(value as ResponseSchema);
            }
            if (schema.required) {
                baseResult.required = schema.required;
            }
            baseResult.additionalProperties = false;
        }

        // Handle array items
        if (schema.type === SchemaType.ARRAY && schema.items) {
            baseResult.items = convertSchema(schema.items as ResponseSchema);
        }

        // Handle nullable - wrap in anyOf AFTER building the full schema
        // This preserves description and other properties
        if (schema.nullable) {
            return {
                anyOf: [
                    baseResult,
                    { type: 'null' }
                ],
                // Keep description at top level for better model understanding
                ...(schema.description ? { description: schema.description } : {})
            };
        }

        return baseResult;
    };

    return convertSchema(geminiSchema);
}

// =============================================================================
// AI SERVICE CLASS
// =============================================================================

class AIService {
    private genAI: GoogleGenerativeAI | null = null;
    private geminiModel: GenerativeModel | null = null;
    private cacheManager: GoogleAICacheManager | null = null;
    private remoteCacheMap: Map<string, { name: string; expires: number }> = new Map();
    private openRouterBaseUrl = 'https://openrouter.ai/api/v1';
    private initializingPromise: Promise<void> | null = null;
    private cacheCreationLocks: Map<string, Promise<string | null>> = new Map();
    private pruneIntervalId: NodeJS.Timeout | null = null;
    private statsIntervalId: NodeJS.Timeout | null = null;

    // Local AI cache for performance and cost reduction
    private cache: Map<string, { result: AIGenerateResult; timestamp: number; lastAccessed: number }> = new Map();
    private readonly MAX_CACHE_SIZE = 200;
    private readonly CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    private cacheHits = 0;
    private cacheMisses = 0;
    private labelStats: Map<string, { hits: number; misses: number }> = new Map();

    constructor() {
        // Periodically prune expired cache
        this.pruneIntervalId = setInterval(() => this.pruneCache(), 5 * 60 * 1000);
        if (this.pruneIntervalId.unref) this.pruneIntervalId.unref();

        // Log cache stats every 10 minutes
        this.statsIntervalId = setInterval(() => this.logCacheStats(), 10 * 60 * 1000);
        if (this.statsIntervalId.unref) this.statsIntervalId.unref();
    }

    private logCacheStats(): void {
        const total = this.cacheHits + this.cacheMisses;
        const hitRate = total > 0 ? ((this.cacheHits / total) * 100).toFixed(2) : '0.00';
        logger.info(`📊 AI Cache Overall: Hits=${this.cacheHits}, Misses=${this.cacheMisses}, Rate=${hitRate}%, Size=${this.cache.size}`);

        if (this.labelStats.size > 0) {
            logger.info('📊 AI Cache Breakdown by Label:');
            // Sort labels alphabetically for consistent output
            const sortedLabels = Array.from(this.labelStats.keys()).sort();
            for (const label of sortedLabels) {
                const stats = this.labelStats.get(label)!;
                const labelTotal = stats.hits + stats.misses;
                const labelRate = labelTotal > 0 ? ((stats.hits / labelTotal) * 100).toFixed(2) : '0.00';
                logger.info(`   - ${label.padEnd(20)}: Hits=${stats.hits.toString().padStart(3)}, Misses=${stats.misses.toString().padStart(3)}, Rate=${labelRate}%`);
            }
        }

        // Reset counters after logging to see period-over-period effectiveness
        this.cacheHits = 0;
        this.cacheMisses = 0;
        this.labelStats.clear();
    }

    /**
     * Generate a cache key for an AI request
     * CRITICAL: We normalize the prompt to increase cache hits for high-frequency trading cycles
     */
    private getCacheKey(options: AIGenerateOptions): string {
        const {
            prompt,
            schema,
            temperature,
            maxOutputTokens,
            provider,
            model,
            topP,
            presencePenalty,
            frequencyPenalty,
            stop
        } = options;

        // OPTIMIZATION: Fuzzy normalization to increase cache hits
        // 1. Remove high-entropy timestamps
        // 2. Round large numbers to reduce noise-driven cache misses
        let normalizedPrompt = prompt;

        // Normalize timestamps
        normalizedPrompt = normalizedPrompt.replace(/"current_time":\s*"[^"]*"/g, '"current_time": "NORMALIZED"');
        normalizedPrompt = normalizedPrompt.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, 'TIMESTAMP_NORMALIZED');

        // Normalize invocation count (v5.5.0: Critical for high-frequency cache hits)
        normalizedPrompt = normalizedPrompt.replace(/"count":\s*\d+/g, '"count": 0');

        // Normalize numbers to 4 decimal places for fuzzy matching
        // This regex matches numbers like 123.456789 and rounds them
        normalizedPrompt = normalizedPrompt.replace(/(\d+\.\d{5,})/g, (match) => {
            const num = parseFloat(match);
            return num.toFixed(4);
        });

        const payload = JSON.stringify({
            prompt: normalizedPrompt,
            schema,
            temperature: temperature ?? config.ai.temperature,
            maxOutputTokens: maxOutputTokens ?? config.ai.maxOutputTokens,
            provider: provider ?? config.ai.provider,
            model: model ?? (provider === 'gemini' ? config.ai.model : config.ai.openRouterModel),
            topP,
            presencePenalty,
            frequencyPenalty,
            stop
        });
        return createHash('sha256').update(payload).digest('hex');
    }

    /**
     * Prune expired or excessive cache entries
     */
    private pruneCache(): void {
        const now = Date.now();
        let expiredCount = 0;

        // Remove expired entries from local cache
        for (const [key, entry] of this.cache.entries()) {
            if (now - entry.timestamp > this.CACHE_TTL) {
                this.cache.delete(key);
                expiredCount++;
            }
        }

        // Remove expired entries from remote cache map
        for (const [hash, entry] of this.remoteCacheMap.entries()) {
            if (now > entry.expires) {
                this.remoteCacheMap.delete(hash);
            }
        }

        // If still too large, remove least recently used from local cache
        if (this.cache.size > this.MAX_CACHE_SIZE) {
            const sorted = Array.from(this.cache.entries())
                .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

            const toRemove = sorted.slice(0, this.cache.size - this.MAX_CACHE_SIZE);
            for (const [key] of toRemove) {
                this.cache.delete(key);
            }
        }

        if (expiredCount > 0) {
            logger.debug(`Pruned ${expiredCount} expired entries from AI cache`);
        }
    }

    /**
     * Get or initialize Gemini model with mutex protection
     */
    private async getGeminiModel(): Promise<GenerativeModel> {
        // Return cached model if available
        if (this.geminiModel) {
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
            if (this.geminiModel) {
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
        this.cacheManager = new GoogleAICacheManager(config.geminiApiKey);

        this.geminiModel = this.genAI.getGenerativeModel({
            model: config.ai.model,
        });

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
    }



    /**
     * Internal execution method with caching
     */
    private async executeWithCache(
        options: AIGenerateOptions,
        primaryProvider: 'gemini' | 'openrouter',
        defaultLogLabel: string
    ): Promise<AIGenerateResult> {
        const { prompt, schema, temperature, maxOutputTokens, label } = options;

        // Validate inputs
        if (!prompt || prompt.trim().length === 0) {
            throw new Error('Cannot generate content with empty prompt');
        }
        validateSchema(schema);

        const requestId = generateRequestId();
        const logLabel = label ? `${label}[${requestId}]` : `${defaultLogLabel}[${requestId}]`;
        const statsLabel = label || defaultLogLabel;
        const startTime = Date.now();

        // Track stats by label
        if (!this.labelStats.has(statsLabel)) {
            this.labelStats.set(statsLabel, { hits: 0, misses: 0 });
        }
        const stats = this.labelStats.get(statsLabel)!;

        // Check local cache
        const cacheKey = this.getCacheKey(options);

        if (!options.bypassCache) {
            const cached = this.cache.get(cacheKey);
            if (cached && (Date.now() - cached.timestamp < this.CACHE_TTL)) {
                this.cacheHits++;
                stats.hits++;
                cached.lastAccessed = Date.now();
                const hitRate = ((stats.hits / (stats.hits + stats.misses)) * 100).toFixed(1);
                logger.info(`${logLabel} Local Response Cache HIT - Rate: ${hitRate}% - returning cached result`);
                return {
                    ...cached.result,
                    requestId // Update requestId to current one for logging consistency
                };
            }
        } else {
            logger.info(`${logLabel} Bypassing local cache (forced refresh)`);
        }

        this.cacheMisses++;
        stats.misses++;
        const missRate = ((stats.misses / (stats.hits + stats.misses)) * 100).toFixed(1);
        logger.info(`${logLabel} Local Response Cache MISS - Rate: ${missRate}% - executing fresh request`);

        try {
            let result: AIGenerateResult;
            if (primaryProvider === 'openrouter') {
                result = await this.generateContentOpenRouter(prompt, schema, temperature, maxOutputTokens, requestId);
            } else {
                result = await this.generateContentGemini(prompt, schema, temperature, maxOutputTokens, requestId);
            }

            const elapsed = Date.now() - startTime;

            // Warn on non-STOP finish reasons
            if (result.finishReason !== 'STOP' && result.finishReason !== 'stop') {
                logger.warn(`${logLabel} non-standard finish reason: ${result.finishReason} (expected STOP)`);
            }

            logger.info(`${logLabel} completed via ${primaryProvider} in ${elapsed}ms: ${result.text.length} chars, finish=${result.finishReason}`);

            // Save to local cache
            this.cache.set(cacheKey, {
                result,
                timestamp: Date.now(),
                lastAccessed: Date.now()
            });

            // ENFORCE MAX_CACHE_SIZE IMMEDIATELY (v6.0.0: Prevent memory growth during high throughput)
            if (this.cache.size > this.MAX_CACHE_SIZE) {
                const sorted = Array.from(this.cache.entries())
                    .sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

                const toRemoveCount = this.cache.size - this.MAX_CACHE_SIZE;
                for (let i = 0; i < toRemoveCount; i++) {
                    const [key] = sorted[i];
                    this.cache.delete(key);
                }
                logger.debug(`Evicted ${toRemoveCount} entries to maintain MAX_CACHE_SIZE`);
            }

            return result;
        } catch (error: any) {
            const elapsed = Date.now() - startTime;
            logger.warn(`${logLabel} ${primaryProvider} failed after ${elapsed}ms: ${error.message}`);
            throw error;
        }
    }

    /**
     * Generate content using the configured AI provider
     * 
     * @param options - Generation options including prompt and schema
     * @returns Generated text and metadata
     */
    async generateContent(options: AIGenerateOptions): Promise<AIGenerateResult> {
        return this.executeWithCache(
            options,
            config.ai.provider as 'gemini' | 'openrouter',
            'AI'
        );
    }


    /**
     * Extract JSON string from text that may contain markdown or other fluff
     */
    private extractJSON(text: string): string {
        let out = text.trim();

        // 0. Strip thinking blocks first (critical for reasoning models)
        out = stripLeadingThinking(out);

        // 1. Handle markdown code blocks
        const jsonBlockMatch = out.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
        if (jsonBlockMatch && jsonBlockMatch[1]) {
            out = jsonBlockMatch[1].trim();
        }

        // 2. If it still doesn't look like JSON, try to find the first { or [ and matching } or ]
        if (!out.startsWith('{') && !out.startsWith('[')) {
            const startObj = out.indexOf('{');
            const startArr = out.indexOf('[');
            const startIdx =
                startObj === -1 ? startArr :
                    (startArr === -1 ? startObj : Math.min(startObj, startArr));

            if (startIdx !== -1) {
                const openToClose: Record<string, string> = { '{': '}', '[': ']' };
                const firstCh = out[startIdx];
                const firstClose = openToClose[firstCh];

                if (firstClose) {
                    const stack: string[] = [firstClose];
                    let endIdx = -1;
                    let inString = false;
                    let escapeNext = false;

                    for (let i = startIdx + 1; i < out.length; i++) {
                        const ch = out[i];
                        if (inString) {
                            if (escapeNext) {
                                escapeNext = false;
                                continue;
                            }
                            if (ch === '\\') {
                                escapeNext = true;
                                continue;
                            }
                            if (ch === '"') {
                                inString = false;
                            }
                            continue;
                        }

                        if (ch === '"') {
                            inString = true;
                            continue;
                        }

                        if (ch === '{') {
                            stack.push('}');
                            continue;
                        }
                        if (ch === '[') {
                            stack.push(']');
                            continue;
                        }

                        const expectedClose = stack[stack.length - 1];
                        if ((ch === '}' || ch === ']') && ch === expectedClose) {
                            stack.pop();
                            if (stack.length === 0) {
                                endIdx = i;
                                break;
                            }
                        }
                    }

                    if (endIdx !== -1) {
                        out = out.slice(startIdx, endIdx + 1).trim();
                    }
                }
            }
        }

        // 3. Remove single-line comments (//) that are not inside strings
        // This is a simple heuristic to handle LLMs that output comments in JSON
        if (out.includes('//')) {
            let cleanOut = '';
            let inString = false;
            let escapeNext = false;
            let i = 0;
            while (i < out.length) {
                const ch = out[i];
                if (inString) {
                    cleanOut += ch;
                    if (escapeNext) {
                        escapeNext = false;
                    } else if (ch === '\\') {
                        escapeNext = true;
                    } else if (ch === '"') {
                        inString = false;
                    }
                } else {
                    if (ch === '"') {
                        inString = true;
                        cleanOut += ch;
                    } else if (ch === '/' && out[i + 1] === '/') {
                        // Skip until newline
                        while (i < out.length && out[i] !== '\n') {
                            i++;
                        }
                        continue; // Don't add newline yet, or let the loop handle it
                    } else {
                        cleanOut += ch;
                    }
                }
                i++;
            }
            out = cleanOut.trim();
        }

        return out;
    }

    /**
     * Get or create a Gemini Context Cache for the system prompt
     */
    private async getGeminiCache(systemPrompt: string): Promise<string | null> {
        if (!this.cacheManager) {
            await this._initializeGemini();
        }
        if (!this.cacheManager) return null;

        // Hash the system prompt to use as displayName/key
        const hash = createHash('sha256').update(systemPrompt + config.ai.model).digest('hex');

        // Check in-memory map first
        const local = this.remoteCacheMap.get(hash);
        if (local && local.expires > Date.now()) {
            return local.name;
        }

        // MUTEX: Prevent race conditions for same hash
        // If a creation is already in progress for this hash, wait for it
        if (this.cacheCreationLocks.has(hash)) {
            logger.debug(`Waiting for pending cache creation: ${hash}`);
            return this.cacheCreationLocks.get(hash) || null;
        }

        // Create a placeholder promise and lock IMMEDIATELY to prevent race conditions
        let resolveCreation!: (value: string | null) => void;
        const creationPromise = new Promise<string | null>((resolve) => {
            resolveCreation = resolve;
        });

        this.cacheCreationLocks.set(hash, creationPromise);

        // Start async work
        (async () => {
            try {
                // List existing caches to find a match
                // Note: This might be slow if there are many caches, but we only do it on miss
                let foundCache: any = null;
                // The list method might return a paginated response or just the list depending on version
                // We'll assume standard list behavior
                const listResult = await this.cacheManager!.list();
                // @ts-ignore - cachedContents property might vary by version
                const caches = listResult.cachedContents || listResult;

                if (Array.isArray(caches)) {
                    foundCache = caches.find((c: any) => c.displayName === hash);
                }

                if (foundCache && foundCache.name) {
                    // Update map
                    let expireTime = new Date(foundCache.expireTime).getTime();

                    // REFRESH TTL if less than 1 hour remaining
                    // This implements the "Update a cache" functionality to keep active contexts alive
                    const now = Date.now();
                    const remaining = expireTime - now;
                    // If less than 1 hour remaining, refresh to full 2 hours
                    if (remaining < 60 * 60 * 1000) {
                        try {
                            const ttlSeconds = 7200;
                            // Update structure must match CachedContentUpdateParams
                            await this.cacheManager!.update(foundCache.name, { cachedContent: { ttlSeconds } });
                            expireTime = now + (ttlSeconds * 1000);
                            logger.info(`🔄 Refreshed Gemini Context Cache TTL: ${foundCache.name}`);
                        } catch (err) {
                            logger.warn(`Failed to refresh cache TTL: ${err}`);
                        }
                    }

                    this.remoteCacheMap.set(hash, { name: foundCache.name, expires: expireTime });
                    resolveCreation(foundCache.name);
                    return;
                }

                // Create new cache
                // Note: Explicit caching requires a minimum token count (usually 32k for Flash)
                // If the prompt is too short, this will fail. We'll catch it and return null.
                const ttlSeconds = 7200; // 2 hours

                // Create cache with system instruction
                // Note: We provide an empty contents array as we're caching the system prompt
                const cache = await this.cacheManager!.create({
                    model: config.ai.model,
                    displayName: hash,
                    systemInstruction: systemPrompt,
                    contents: [],
                    ttlSeconds,
                });

                if (!cache.name) {
                    throw new Error('Cache created but returned no name');
                }

                // Calculate expiration (approximate)
                const expireTime = Date.now() + (ttlSeconds * 1000);
                this.remoteCacheMap.set(hash, { name: cache.name, expires: expireTime });
                logger.info(`✨ Created Gemini Context Cache: ${cache.name} (TTL: 2h)`);

                resolveCreation(cache.name);

            } catch (error: any) {
                // Log warning but don't fail - fallback to standard prompt
                if (error.message?.includes('minimum') || error.message?.includes('token count') || error.message?.includes('length')) {
                    logger.debug(`Context caching skipped (likely too short): ${error.message}`);
                } else {
                    logger.warn(`Failed to use Gemini Context Caching: ${error.message}`);
                }
                resolveCreation(null);
            } finally {
                this.cacheCreationLocks.delete(hash);
            }
        })();

        return creationPromise;
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
        const reqId = requestId || generateRequestId();

        // SPLIT PROMPT: Separate system instruction from user message
        // This is CRITICAL for Gemini Context Caching
        const { system, user } = splitPromptSystemUser(prompt);

        let model = this.geminiModel;

        // Explicit Caching Logic
        let cachedContentName: string | null = null;
        if (system) {
            // Try to get/create explicit cache
            cachedContentName = await this.getGeminiCache(system);
        }

        // If explicit cache exists, use it
        if (cachedContentName && this.genAI) {
            try {
                model = this.genAI.getGenerativeModel({
                    model: config.ai.model,
                    cachedContent: { name: cachedContentName } as any // Cast to any to avoid interface mismatch
                });
                logger.info(`Using Explicit Gemini Context Cache: ${cachedContentName}`);
            } catch (e) {
                logger.warn(`Failed to get model from cache, falling back: ${e}`);
                // Fallback to implicit caching (standard model with system instruction)
                if (system && this.genAI) {
                    model = this.genAI.getGenerativeModel({
                        model: config.ai.model,
                        systemInstruction: system
                    });
                } else {
                    model = this.geminiModel;
                }
                cachedContentName = null;
            }
        }

        // If NO explicit cache, but we have system prompt, use standard systemInstruction (Implicit Caching)
        if (!cachedContentName && system) {
            if (!this.genAI) {
                await this._initializeGemini();
            }
            if (this.genAI) {
                model = this.genAI.getGenerativeModel({
                    model: config.ai.model,
                    systemInstruction: system
                });
            }
        }

        // Fallback if initialization failed (shouldn't happen due to _initializeGemini check)
        if (!model) {
            model = await this.getGeminiModel();
        }

        try {
            const result = await model.generateContent({
                contents: [
                    { role: 'user', parts: [{ text: user }] }
                ],
                generationConfig: {
                    responseMimeType: 'application/json',
                    responseSchema: schema,
                    temperature: temperature ?? config.ai.temperature,
                    maxOutputTokens: maxOutputTokens ?? config.ai.maxOutputTokens,
                },
            });

            const text = this.extractJSON(result.response.text());
            const candidates = result.response.candidates;
            const finishReason = (candidates && candidates.length > 0)
                ? (candidates[0].finishReason || 'UNKNOWN')
                : 'UNKNOWN';

            // Validate JSON
            try {
                JSON.parse(text);
            } catch (_parseError) {
                // Log the full text for debugging (truncated to 1000 chars)
                logger.error(`Invalid JSON from Gemini. FinishReason: ${finishReason}. Text length: ${text.length}`);
                logger.debug(`Raw invalid JSON: ${text.slice(0, 1000)}...`);
                throw new Error(`Gemini returned invalid JSON (Reason: ${finishReason}): ${text.slice(0, 200)}...`);
            }

            return { text, finishReason, provider: 'gemini', requestId: reqId };
        } catch (error: any) {
            // If cache invalidation error (404 on cache?), retry without cache?
            if (cachedContentName && (error.message?.includes('not found') || error.message?.includes('cache'))) {
                logger.warn(`Cache error ${cachedContentName}, retrying without cache...`);
                // Clear from map
                for (const [key, val] of this.remoteCacheMap.entries()) {
                    if (val.name === cachedContentName) {
                        this.remoteCacheMap.delete(key);
                        break;
                    }
                }
                // Recursive retry with same args? 
                // Careful with infinite loop. 
                // We'll just throw for now, or fallback manually.
                // Fallback manually is complex because we need to reconstruct the non-cached call.
                // Simpler: Just throw, next retry in CollaborativeFlow will pick it up (and maybe we cleared the map so it works next time).
            }
            throw error;
        }
    }

    /**
     * Generate content using OpenRouter API with strict JSON schema
     * 
     * NOTE: Rate limit handling is delegated to the caller (CollaborativeFlow).
     * This method throws on rate limit errors with isRateLimit=true property,
     * allowing callers to implement appropriate backoff strategies.
     * 
     * Uses json_schema response_format with strict: true for structured output.
     */
    private async generateContentOpenRouter(
        prompt: string,
        geminiSchema: ResponseSchema,
        temperature?: number,
        maxOutputTokens?: number,
        requestId?: string
    ): Promise<AIGenerateResult> {
        this.validateOpenRouterConfig();

        const reqId = requestId || generateRequestId();

        // Convert Gemini schema to OpenRouter JSON Schema format
        const jsonSchema = convertToOpenRouterSchema(geminiSchema);

        const { system, user } = splitPromptSystemUser(prompt);

        const messages: any[] = [];
        const modelId = String(config.ai.openRouterModel || '').toLowerCase();
        const isAnthropic = modelId.startsWith('anthropic/');
        if (system) {
            if (isAnthropic) {
                const cacheTtl = String(process.env.OPENROUTER_ANTHROPIC_CACHE_TTL || '').trim();
                const cacheControl = cacheTtl === '1h'
                    ? { type: 'ephemeral', ttl: '1h' }
                    : { type: 'ephemeral' };

                messages.push({
                    role: 'system',
                    content: [
                        {
                            type: 'text',
                            text: system,
                            cache_control: cacheControl,
                        },
                    ],
                });
            } else {
                messages.push({ role: 'system', content: system });
            }
        }
        if (isAnthropic) {
            messages.push({
                role: 'user',
                content: [
                    {
                        type: 'text',
                        text: user,
                    },
                ],
            });
        } else {
            messages.push({ role: 'user', content: user });
        }

        // DEBUG: Log message structure for cache debugging
        logger.debug(`[CACHE DEBUG ${reqId}] System prompt length: ${system?.length || 0} chars, User prompt length: ${user.length} chars`);
        logger.debug(`[CACHE DEBUG ${reqId}] System prompt hash: ${system ? createHash('md5').update(system).digest('hex').substring(0, 8) : 'none'}`);


        // Build request body with strict json_schema for structured output
        const providerPrefs: any = {
            data_collection: 'deny',
            allow_fallbacks: true,
            require_parameters: true,
        };

        const requestBody: any = {
            model: config.ai.openRouterModel,
            messages,
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'analyst_response',
                    strict: true,
                    schema: jsonSchema
                }
            },
            usage: { include: true },
            temperature: temperature ?? config.ai.temperature,
            max_tokens: maxOutputTokens ?? config.ai.maxOutputTokens,
            provider: providerPrefs,
        };

        // Add thinking parameter if enabled
        if (config.ai.thinking.enabled) {
            const requestMaxTokens = typeof requestBody.max_tokens === 'number' && Number.isFinite(requestBody.max_tokens)
                ? requestBody.max_tokens
                : config.ai.maxOutputTokens;
            const budgetTokens = Math.min(39000, requestMaxTokens);
            requestBody.thinking = {
                type: 'enabled',
                budget_tokens: budgetTokens
            };
            // When thinking is enabled, temperature should often be 1.0 (provider dependent, but 1.0 is standard for reasoning)
            // We'll keep the configured temperature but log a debug message
            logger.debug(`🧠 Thinking enabled with budget ${budgetTokens} tokens`);
        }

        const url = `${this.openRouterBaseUrl}/chat/completions`;
        const headers = {
            'Authorization': `Bearer ${config.openRouterApiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://hypothesis-arena.com',
            'X-Title': 'Hypothesis Arena',
        };

        const fetchOnce = async (body: any): Promise<Response> => {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), config.ai.requestTimeoutMs);
            if ((timeoutId as any).unref) {
                (timeoutId as any).unref();
            }

            try {
                return await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
            } catch (fetchError: any) {
                if (fetchError?.name === 'AbortError') {
                    throw new Error(`OpenRouter request timeout after ${config.ai.requestTimeoutMs}ms`);
                }
                throw new Error(`OpenRouter network error: ${fetchError?.message ?? String(fetchError)}`);
            } finally {
                clearTimeout(timeoutId);
            }
        };

        const safeReadText = async (resp: Response): Promise<string> => {
            try {
                return await resp.text();
            } catch {
                return '';
            }
        };

        const parseErrorDetails = (text: string): string => {
            if (!text) return '';
            try {
                const errorJson = JSON.parse(text);
                return String(errorJson?.error?.message ?? errorJson?.message ?? '').trim() || text.slice(0, 200);
            } catch {
                return text.slice(0, 200);
            }
        };

        const buildApiError = (resp: Response, text: string): Error => {
            const errorDetails = parseErrorDetails(text);
            const error = new Error(`OpenRouter API error (${resp.status}): ${errorDetails}`);
            if (resp.status === 429) {
                (error as any).isRateLimit = true;
                const retryAfter = resp.headers?.get('retry-after');
                if (retryAfter) {
                    const parsed = parseInt(retryAfter, 10);
                    if (Number.isFinite(parsed)) {
                        (error as any).retryAfter = parsed;
                    }
                }
            }
            return error;
        };

        const isNoEndpointsErrorText = (text: string, status: number): boolean => {
            return (
                text.includes('No endpoints found') ||
                text.includes('no endpoints') ||
                (status === 404 && text.includes('endpoint'))
            );
        };

        const isFormatErrorText = (text: string): boolean => {
            return (
                text.includes('response_format') ||
                text.includes('json_object') ||
                text.includes('json_schema') ||
                text.includes('structured output')
            );
        };

        let response = await fetchOnce(requestBody);
        if (!response.ok) {
            let errorText = await safeReadText(response);

            if (isNoEndpointsErrorText(errorText, response.status)) {
                logger.error(`Model ${config.ai.openRouterModel} has no available endpoints`);
                throw new Error(`OpenRouter: Model ${config.ai.openRouterModel} has no available providers. Check OpenRouter dashboard or try a different model.`);
            }

            if (isFormatErrorText(errorText)) {
                logger.warn(`Model may not support json_schema, retrying with json_object fallback`);

                requestBody.response_format = { type: 'json_object' };
                if (requestBody.provider && typeof requestBody.provider === 'object') {
                    delete requestBody.provider.require_parameters;
                }

                response = await fetchOnce(requestBody);
                if (!response.ok) {
                    const retryErrorText = await safeReadText(response);
                    if (isFormatErrorText(retryErrorText)) {
                        logger.warn(`Model doesn't support json_object either, retrying without response_format`);
                        delete requestBody.response_format;

                        response = await fetchOnce(requestBody);
                        if (!response.ok) {
                            const retry2ErrorText = await safeReadText(response);
                            throw buildApiError(response, retry2ErrorText);
                        }
                    } else {
                        throw buildApiError(response, retryErrorText);
                    }
                }
            } else {
                throw buildApiError(response, errorText);
            }
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

        const responseThinking =
            (typeof data?.choices?.[0]?.message?.reasoning === 'string' ? data.choices[0].message.reasoning : null) ??
            (typeof data?.choices?.[0]?.message?.thinking === 'string' ? data.choices[0].message.thinking : null) ??
            extractThinking(text);
        if (config.ai.thinking.enabled && responseThinking) {
            console.log(`[AI THINKING ${reqId}] ${responseThinking}`);
        }

        text = stripLeadingThinking(text);

        const finishReason = data?.choices?.[0]?.finish_reason || 'UNKNOWN';
        const providerName = typeof (data as any)?.provider === 'string' ? (data as any).provider : null;

        const usage = data?.usage;
        if (usage && typeof usage === 'object') {
            const promptTokensRaw = usage.prompt_tokens ?? usage.input_tokens ?? null;
            const completionTokensRaw = usage.completion_tokens ?? usage.output_tokens ?? null;
            const totalTokensRaw = usage.total_tokens ?? null;
            const cachedTokensRaw =
                usage?.prompt_tokens_details?.cached_tokens ??
                usage?.prompt_tokens_details?.cache_read_input_tokens ??
                usage?.cache_read_input_tokens ??
                usage?.cached_tokens ??
                usage?.native_prompt_tokens_cached ??
                null;

            const promptTokens = typeof promptTokensRaw === 'number' && Number.isFinite(promptTokensRaw) ? promptTokensRaw : null;
            const completionTokens = typeof completionTokensRaw === 'number' && Number.isFinite(completionTokensRaw) ? completionTokensRaw : null;
            const totalTokens = typeof totalTokensRaw === 'number' && Number.isFinite(totalTokensRaw) ? totalTokensRaw : null;
            const cachedTokens = typeof cachedTokensRaw === 'number' && Number.isFinite(cachedTokensRaw) ? cachedTokensRaw : null;
            const cacheDiscount = (data as any)?.cache_discount ?? usage?.cache_discount ?? null;

            const maybeRate =
                typeof cachedTokens === 'number' && typeof promptTokens === 'number' && promptTokens > 0
                    ? (cachedTokens / promptTokens)
                    : null;

            const autoCacheThreshold = 1024;
            const belowThreshold = typeof promptTokens === 'number' && promptTokens > 0 && promptTokens < autoCacheThreshold;

            const cacheStatus =
                typeof cachedTokens === 'number'
                    ? (cachedTokens > 0 ? 'HIT' : (belowThreshold ? 'BELOW_THRESHOLD' : 'MISS'))
                    : 'UNKNOWN';

            // Log cache hit with emoji for visibility
            if (maybeRate !== null && maybeRate > 0) {
                logger.info(`💰 Cache hit: ${cachedTokens}/${promptTokens} tokens (${(maybeRate * 100).toFixed(1)}%) [${reqId}]`);
            }

            console.log(
                `[AI CACHE ${reqId}] ${cacheStatus} model=${config.ai.openRouterModel}${providerName ? ` provider=${providerName}` : ''} prompt=${promptTokens ?? '?'} cached=${cachedTokens ?? '?'} completion=${completionTokens ?? '?'} total=${totalTokens ?? '?'}${maybeRate !== null ? ` rate=${(maybeRate * 100).toFixed(1)}%` : ''}${belowThreshold ? ` threshold=${autoCacheThreshold}` : ''}${typeof cacheDiscount === 'number' ? ` discount=${cacheDiscount}` : ''}`
            );

            logger.debug(
                `OpenRouter usage[${reqId}]: prompt=${promptTokens ?? '?'} cached=${cachedTokens ?? '?'} completion=${completionTokens ?? '?'} total=${totalTokens ?? '?'}${maybeRate !== null ? ` cacheRate=${(maybeRate * 100).toFixed(1)}%` : ''}`
            );
        } else {
            console.log(`[AI CACHE ${reqId}] UNKNOWN model=${config.ai.openRouterModel} usage=missing`);
        }

        // Use robust JSON extraction
        text = this.extractJSON(text);

        // Validate JSON
        try {
            JSON.parse(text);
        } catch (_parseError) {
            throw new Error(`OpenRouter returned invalid JSON: ${text.slice(0, 200)}`);
        }

        return { text, finishReason, provider: 'openrouter', requestId: reqId };
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
     */
    cleanup(): void {
        // Clear intervals to prevent memory leaks
        if (this.pruneIntervalId) {
            clearInterval(this.pruneIntervalId);
            this.pruneIntervalId = null;
        }
        if (this.statsIntervalId) {
            clearInterval(this.statsIntervalId);
            this.statsIntervalId = null;
        }

        this.geminiModel = null;
        this.genAI = null;
        this.initializingPromise = null;
        this.cache.clear();
        this.labelStats.clear();
        logger.debug('AIService cleaned up');
    }
}

// Singleton instance
export const aiService = new AIService();

// Re-export schema types for convenience
export { SchemaType, ResponseSchema };

// Export utility for rate limit detection
export { isRateLimitError };
