/**
 * ModelPoolManager - Multi-Model Distribution for Analysts (v5.3.0)
 * 
 * Manages a pool of AI models and assigns them to analysts using
 * Fisher-Yates shuffle for fair, random distribution each cycle.
 * 
 * Features:
 * - Fair random distribution (each analyst gets different model)
 * - Automatic fallback on model failure
 * - Failure tracking with auto-reset
 * - Configurable timeouts per model
 * - Environment variable override for single-model mode
 * 
 * Models (default pool):
 * - deepseek/deepseek-chat (strong reasoning, reliable - primary fallback)
 * - google/gemini-3-flash-preview (fast, reliable)
 * - x-ai/grok-4.1-fast (fast reasoning)
 * - xiaomi/mimo-v2-flash:free (reliable, fast)
 * 
 * Configuration:
 * - MULTI_MODEL_ENABLED=true (default) - Enable multi-model rotation
 * - MULTI_MODEL_ENABLED=false - Use single model (OPENROUTER_MODEL)
 */

import { logger } from '../../utils/logger';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface ModelConfig {
    id: string;
    name: string;
    provider: 'openrouter';
    timeoutMs: number;
    temperature: number;
    maxTokens: number;
    priority: number;  // Lower = higher priority for fallback (0 = most reliable)
}

export interface CycleAssignment {
    cycleId: string;
    assignments: Map<string, ModelConfig>;
    timestamp: number;
}

export interface ModelCallResult {
    content: string;
    model: string;
    latencyMs: number;
    usedFallback: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL CONFIGURATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const MODEL_POOL: readonly ModelConfig[] = Object.freeze([
    {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek Chat',
        provider: 'openrouter',
        timeoutMs: 60000,
        temperature: 0.7,
        maxTokens: 8192,
        priority: 0,  // Most reliable - primary fallback
    },
    {
        id: 'google/gemini-3-flash-preview',
        name: 'Gemini 3 Flash',
        provider: 'openrouter',
        timeoutMs: 45000,
        temperature: 0.7,
        maxTokens: 8192,
        priority: 1,
    },
    {
        id: 'x-ai/grok-4.1-fast',
        name: 'Grok 4.1 Fast',
        provider: 'openrouter',
        timeoutMs: 30000,
        temperature: 0.7,
        maxTokens: 4096,
        priority: 2,
    },
    {
        id: 'xiaomi/mimo-v2-flash:free',
        name: 'Xiaomi Mimo v2',
        provider: 'openrouter',
        timeoutMs: 45000,
        temperature: 0.7,
        maxTokens: 4096,
        priority: 3,
    },
]);

// Analyst IDs (must match profiles.ts)
export const ANALYST_IDS = ['jim', 'ray', 'karen', 'quant'] as const;
export type AnalystId = typeof ANALYST_IDS[number];

// ═══════════════════════════════════════════════════════════════════════════════
// MODEL POOL MANAGER
// ═══════════════════════════════════════════════════════════════════════════════

class ModelPoolManager {
    private lastAssignment: CycleAssignment | null = null;
    private modelFailures: Map<string, number> = new Map();
    private failureResetTimer: ReturnType<typeof setInterval> | null = null;

    private readonly MAX_FAILURES_BEFORE_SKIP = 3;
    private readonly FAILURE_RESET_INTERVAL = 5 * 60 * 1000; // 5 minutes
    private readonly MAX_TRACKED_MODELS = 20; // Prevent unbounded map growth

    constructor() {
        this.startFailureResetTimer();
    }

    private startFailureResetTimer(): void {
        if (this.failureResetTimer) return;

        this.failureResetTimer = setInterval(() => {
            if (this.modelFailures.size > 0) {
                this.modelFailures.clear();
                logger.debug('[ModelPool] Failure counts auto-reset');
            }
        }, this.FAILURE_RESET_INTERVAL);

        // Don't block process exit
        this.failureResetTimer.unref();
    }

    /**
     * Check if multi-model mode is enabled
     */
    isMultiModelEnabled(): boolean {
        const enabled = process.env.MULTI_MODEL_ENABLED;
        // Default to true if not set
        return enabled !== 'false';
    }

    /**
     * Fisher-Yates shuffle for unbiased random distribution
     * Cryptographically not required - Math.random() is sufficient for load balancing
     */
    private shuffleArray<T>(array: readonly T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
     * Get available models (excluding those with too many recent failures)
     */
    private getAvailableModels(): ModelConfig[] {
        return MODEL_POOL.filter(model => {
            const failures = this.modelFailures.get(model.id) || 0;
            return failures < this.MAX_FAILURES_BEFORE_SKIP;
        });
    }

    /**
     * Assign models to analysts for a new cycle
     * Uses Fisher-Yates shuffle for fair distribution
     * Each analyst gets a different model (when 4+ models available)
     * 
     * @param cycleId - Unique identifier for this cycle (for logging)
     * @returns Map of analystId -> ModelConfig
     */
    assignModelsForCycle(cycleId: string): Map<string, ModelConfig> {
        // If multi-model disabled, use single model for all analysts
        if (!this.isMultiModelEnabled()) {
            const singleModel = this.getSingleModelConfig();
            const assignments = new Map<string, ModelConfig>();
            ANALYST_IDS.forEach(analystId => {
                assignments.set(analystId, singleModel);
            });

            this.lastAssignment = {
                cycleId,
                assignments: new Map(assignments),
                timestamp: Date.now(),
            };

            logger.info(`[ModelPool] Single-model mode: all analysts using ${singleModel.name}`);
            return assignments;
        }

        const available = this.getAvailableModels();

        // If not enough models available, reset failures and use all
        let modelsToUse: readonly ModelConfig[];
        if (available.length < ANALYST_IDS.length) {
            logger.warn(`[ModelPool] Only ${available.length} models available, resetting failures`);
            this.modelFailures.clear();
            modelsToUse = MODEL_POOL;
        } else {
            modelsToUse = available;
        }

        // Shuffle models for random assignment
        const shuffled = this.shuffleArray(modelsToUse);

        // Assign to analysts (1:1 mapping when possible)
        const assignments = new Map<string, ModelConfig>();
        ANALYST_IDS.forEach((analystId, index) => {
            const model = shuffled[index % shuffled.length];
            assignments.set(analystId, model);
        });

        // Store assignment
        this.lastAssignment = {
            cycleId,
            assignments: new Map(assignments), // Clone to prevent mutation
            timestamp: Date.now(),
        };

        // Log assignments
        const assignmentLog = Array.from(assignments.entries())
            .map(([analyst, model]) => `${analyst}→${model.name}`)
            .join(', ');
        logger.info(`[ModelPool] Cycle ${cycleId}: ${assignmentLog}`);

        return assignments;
    }

    /**
     * Get single model config from OPENROUTER_MODEL env var
     * Used when MULTI_MODEL_ENABLED=false
     */
    private getSingleModelConfig(): ModelConfig {
        const modelId = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat';

        // Check if it's in our pool
        const poolModel = MODEL_POOL.find(m => m.id === modelId);
        if (poolModel) {
            return poolModel;
        }

        // Create config for custom model (deprioritize unknown models for fallback)
        return {
            id: modelId,
            name: modelId.split('/').pop() || modelId,
            provider: 'openrouter',
            timeoutMs: 60000,
            temperature: 0.7,
            maxTokens: 8192,
            priority: 99,  // Low priority - prefer known models for fallback
        };
    }

    /**
     * Get model config for a specific analyst in current cycle
     * Always returns a valid model (falls back to default if needed)
     */
    getModelForAnalyst(analystId: string): ModelConfig {
        // Validate input
        if (!analystId || typeof analystId !== 'string') {
            logger.warn(`[ModelPool] Invalid analystId, returning default model`);
            return MODEL_POOL[0];
        }

        if (!this.lastAssignment) {
            logger.warn(`[ModelPool] No cycle assignment, returning default model`);
            return MODEL_POOL[0]; // DeepSeek as default
        }

        const model = this.lastAssignment.assignments.get(analystId);
        if (!model) {
            logger.warn(`[ModelPool] No model for analyst ${analystId}, returning default`);
            return MODEL_POOL[0];
        }

        return model;
    }

    /**
     * Record a model failure and get fallback
     * Returns the most reliable model that isn't the failed one and doesn't have too many failures
     */
    getFallbackModel(failedModelId: string): ModelConfig | null {
        // Validate input
        if (!failedModelId || typeof failedModelId !== 'string') {
            logger.error('[ModelPool] getFallbackModel called with invalid modelId');
            return MODEL_POOL[0]; // Return most reliable as fallback
        }

        // Find best fallback FIRST (before incrementing failure count)
        // This ensures we don't increment counts if there's no valid fallback
        // 1. Exclude the failed model
        // 2. Exclude models with too many recent failures (same threshold as getAvailableModels)
        // 3. Sort by priority (lower = higher priority)
        const fallbacks = [...MODEL_POOL]
            .filter(m => {
                if (m.id === failedModelId) return false;
                const failures = this.modelFailures.get(m.id) || 0;
                return failures < this.MAX_FAILURES_BEFORE_SKIP;
            })
            .sort((a, b) => a.priority - b.priority);

        if (fallbacks.length === 0) {
            logger.error(`[ModelPool] No fallback models available! All models either failed or have too many failures.`);
            // Don't increment failure count if there's no fallback - avoid unnecessary state changes
            return null;
        }

        // Now increment failure count for the failed model (only after confirming we have a fallback)
        const isKnownModel = MODEL_POOL.some(m => m.id === failedModelId);
        if (isKnownModel) {
            const currentFailures = this.modelFailures.get(failedModelId) || 0;
            this.modelFailures.set(failedModelId, currentFailures + 1);
            logger.warn(`[ModelPool] ${failedModelId} failed (count: ${currentFailures + 1})`);
        } else {
            // For unknown models, only track if map isn't too large
            if (this.modelFailures.size < this.MAX_TRACKED_MODELS) {
                const currentFailures = this.modelFailures.get(failedModelId) || 0;
                this.modelFailures.set(failedModelId, currentFailures + 1);
            }
            logger.warn(`[ModelPool] Unknown model ${failedModelId} failed`);
        }

        const fallback = fallbacks[0];
        logger.info(`[ModelPool] Fallback: ${fallback.name} (priority: ${fallback.priority})`);
        return fallback;
    }

    /**
     * Get model config by ID
     */
    getModelById(modelId: string): ModelConfig | null {
        return MODEL_POOL.find(m => m.id === modelId) || null;
    }

    /**
     * Get all models in pool
     */
    getAllModels(): readonly ModelConfig[] {
        return MODEL_POOL;
    }

    /**
     * Get last assignment for debugging/logging
     */
    getLastAssignment(): CycleAssignment | null {
        return this.lastAssignment;
    }

    /**
     * Get current failure counts for debugging
     */
    getFailureCounts(): Map<string, number> {
        return new Map(this.modelFailures);
    }

    /**
     * Reset all failure counts (for admin/testing)
     */
    resetFailures(): void {
        this.modelFailures.clear();
        logger.info('[ModelPool] Failure counts manually reset');
    }

    /**
     * Shutdown - cleanup timer
     */
    shutdown(): void {
        if (this.failureResetTimer) {
            clearInterval(this.failureResetTimer);
            this.failureResetTimer = null;
        }
        this.modelFailures.clear();
        this.lastAssignment = null;
        logger.info('[ModelPool] Shutdown complete');
    }
}

// Singleton instance
export const modelPoolManager = new ModelPoolManager();

export default modelPoolManager;
