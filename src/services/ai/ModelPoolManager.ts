/**
 * ModelPoolManager - Multi-Model Distribution for Analysts (v5.4.0)
 * Manages a pool of AI models and assigns them to analysts using Fisher-Yates shuffle.
 * Features: Fair random distribution, automatic fallback on failure, failure tracking
 */

import { logger } from '../../utils/logger';

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
        id: 'x-ai/grok-4.1-fast',
        name: 'Grok 4.1 Fast',
        provider: 'openrouter',
        timeoutMs: 45000,
        temperature: 0.7,
        maxTokens: 8192,
        priority: 1,
    },
]);

// Analyst IDs (must match profiles.ts)
export const ANALYST_IDS = ['jim', 'ray', 'karen', 'quant'] as const;
export type AnalystId = typeof ANALYST_IDS[number];

class ModelPoolManager {
    private lastAssignment: CycleAssignment | null = null;
    private modelFailures: Map<string, number> = new Map();
    private failureResetTimer: ReturnType<typeof setInterval> | null = null;

    // Configurable via environment variables
    private readonly MAX_FAILURES_BEFORE_SKIP: number;
    private readonly FAILURE_RESET_INTERVAL: number;
    private readonly MAX_TRACKED_MODELS = 20; // Prevent unbounded map growth

    constructor() {
        const maxFailures = parseInt(process.env.MODEL_MAX_FAILURES_BEFORE_SKIP || '3', 10);
        this.MAX_FAILURES_BEFORE_SKIP = Number.isFinite(maxFailures) && maxFailures >= 1 ? maxFailures : 3;

        const resetMinutes = parseInt(process.env.MODEL_FAILURE_RESET_MINUTES || '5', 10);
        this.FAILURE_RESET_INTERVAL = Number.isFinite(resetMinutes) && resetMinutes >= 1
            ? resetMinutes * 60 * 1000
            : 5 * 60 * 1000;

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

        // CRITICAL: Use .unref() to prevent blocking process exit
        if (this.failureResetTimer.unref) {
            this.failureResetTimer.unref();
        }
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
     * Assign models to analysts for a new cycle using Fisher-Yates shuffle
     * With 2 models and 4 analysts, each model is used twice
     */
    assignModelsForCycle(cycleId: string): Map<string, ModelConfig> {
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

        let modelsToUse: readonly ModelConfig[];
        if (available.length === 0) {
            logger.warn(`[ModelPool] No models available, resetting failures`);
            this.modelFailures.clear();
            modelsToUse = MODEL_POOL;
        } else {
            modelsToUse = available;
        }

        const shuffled = this.shuffleArray(modelsToUse);
        const assignments = new Map<string, ModelConfig>();
        ANALYST_IDS.forEach((analystId, index) => {
            const model = shuffled[index % shuffled.length];
            assignments.set(analystId, model);
        });

        this.lastAssignment = {
            cycleId,
            assignments: new Map(assignments),
            timestamp: Date.now(),
        };

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

        const poolModel = MODEL_POOL.find(m => m.id === modelId);
        if (poolModel) {
            return poolModel;
        }

        return {
            id: modelId,
            name: modelId.split('/').pop() || modelId,
            provider: 'openrouter',
            timeoutMs: 60000,
            temperature: 0.7,
            maxTokens: 8192,
            priority: 99,
        };
    }

    /**
     * Get model config for a specific analyst in current cycle
     * Always returns a valid model (falls back to default if needed)
     */
    getModelForAnalyst(analystId: string): ModelConfig {
        if (!analystId || typeof analystId !== 'string') {
            logger.warn(`[ModelPool] Invalid analystId, returning default model`);
            return MODEL_POOL[0];
        }

        if (!this.lastAssignment) {
            logger.warn(`[ModelPool] No cycle assignment, returning default model`);
            return MODEL_POOL[0];
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
     * Returns the most reliable model that isn't the failed one
     */
    getFallbackModel(failedModelId: string): ModelConfig | null {
        if (!failedModelId || typeof failedModelId !== 'string') {
            logger.error('[ModelPool] getFallbackModel called with invalid modelId');
            return MODEL_POOL[0];
        }

        // Record the failure BEFORE checking for fallbacks
        const isKnownModel = MODEL_POOL.some(m => m.id === failedModelId);
        if (isKnownModel) {
            const currentFailures = this.modelFailures.get(failedModelId) || 0;
            this.modelFailures.set(failedModelId, currentFailures + 1);
            logger.warn(`[ModelPool] ${failedModelId} failed (count: ${currentFailures + 1})`);
        } else {
            if (this.modelFailures.size < this.MAX_TRACKED_MODELS) {
                const currentFailures = this.modelFailures.get(failedModelId) || 0;
                this.modelFailures.set(failedModelId, currentFailures + 1);
            }
            logger.warn(`[ModelPool] Unknown model ${failedModelId} failed`);
        }

        const fallbacks = [...MODEL_POOL]
            .filter(m => {
                if (m.id === failedModelId) return false;
                const failures = this.modelFailures.get(m.id) || 0;
                return failures < this.MAX_FAILURES_BEFORE_SKIP;
            })
            .sort((a, b) => a.priority - b.priority);

        if (fallbacks.length === 0) {
            logger.warn(`[ModelPool] No fallback models available! Resetting failure counts.`);
            this.modelFailures.clear();

            // Re-record the current failure after clearing
            this.modelFailures.set(failedModelId, 1);

            const otherModel = MODEL_POOL.find(m => m.id !== failedModelId);
            if (otherModel) {
                logger.info(`[ModelPool] After reset, using ${otherModel.name} as fallback`);
                return otherModel;
            }

            logger.error(`[ModelPool] Critical: returning primary model as last resort`);
            return MODEL_POOL[0];
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

export const modelPoolManager = new ModelPoolManager();
export default modelPoolManager;
