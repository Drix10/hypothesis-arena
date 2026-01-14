/**
 * Analyst Types for v5.0.0 Parallel Analysis System
 * Each analyst receives full context and outputs a standardized recommendation.
 * All 4 analyze independently in parallel, then a judge picks the winner.
 */

export type AnalystAction = 'BUY' | 'SELL' | 'HOLD' | 'CLOSE' | 'REDUCE';
export type AnalystId = 'jim' | 'ray' | 'karen' | 'quant';

export interface AnalystRecommendation {
    action: AnalystAction;
    symbol: string;
    allocation_usd: number;
    leverage: number;
    tp_price: number | null;
    sl_price: number | null;
    exit_plan: string;
    confidence: number;
    rationale: string;
}

export interface AnalystOutput {
    reasoning: string;
    recommendation: AnalystRecommendation;
}

export type ErrorSource = AnalystId | 'system';

export interface ParallelAnalysisResult {
    jim: AnalystOutput | null;
    ray: AnalystOutput | null;
    karen: AnalystOutput | null;
    quant: AnalystOutput | null;
    timestamp: number;
    errors: { analyst: ErrorSource; error: string }[];
}

export interface RiskAdjustments {
    leverage?: number;
    allocation_usd?: number;
    sl_price?: number;
    tp_price?: number;
}

export interface JudgeDecision {
    winner: AnalystId | 'NONE';
    reasoning: string;
    adjustments: RiskAdjustments | null;
    warnings: string[];
    final_action: AnalystAction;
    final_recommendation: AnalystRecommendation | null;
}

export interface AnalystProfile {
    id: AnalystId;
    name: string;
    role: string;
    methodology: string;
    focus: string[];
    riskTolerance: 'conservative' | 'moderate' | 'aggressive';
}
export const ANALYST_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        reasoning: { type: 'string' },
        recommendation: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'] },
                symbol: { type: 'string' },
                allocation_usd: { type: 'number', minimum: 0 },
                leverage: { type: 'number', minimum: 0, maximum: 20 },
                tp_price: { type: ['number', 'null'], exclusiveMinimum: 0 },
                sl_price: { type: ['number', 'null'], exclusiveMinimum: 0 },
                exit_plan: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 100 },
                rationale: { type: 'string' },
            },
            required: ['action', 'symbol', 'allocation_usd', 'leverage', 'tp_price', 'sl_price', 'exit_plan', 'confidence', 'rationale'],
            additionalProperties: false,
        },
    },
    required: ['reasoning', 'recommendation'],
    additionalProperties: false,
};

/**
 * JSON Schema for judge output
 */
export const JUDGE_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        winner: { type: 'string', enum: ['jim', 'ray', 'karen', 'quant', 'NONE'] },
        reasoning: { type: 'string' },
        adjustments: {
            type: ['object', 'null'],
            properties: {
                leverage: { type: 'number', minimum: 0, maximum: 20 },
                allocation_usd: { type: 'number', minimum: 0 },
                sl_price: { type: 'number', minimum: 0 },
                tp_price: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
        },
        warnings: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10
        },
        final_action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'] },
        final_recommendation: {
            type: ['object', 'null'],
            properties: {
                action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'] },
                symbol: { type: 'string' },
                allocation_usd: { type: 'number', minimum: 0 },
                leverage: { type: 'number', minimum: 0, maximum: 20 },
                tp_price: { type: ['number', 'null'], exclusiveMinimum: 0 },
                sl_price: { type: ['number', 'null'], exclusiveMinimum: 0 },
                exit_plan: { type: 'string' },
                confidence: { type: 'number', minimum: 0, maximum: 100 },
                rationale: { type: 'string' },
            },
            required: ['action', 'symbol', 'allocation_usd', 'leverage', 'tp_price', 'sl_price', 'exit_plan', 'confidence', 'rationale'],
            additionalProperties: false,
        },
    },
    required: ['winner', 'reasoning', 'adjustments', 'warnings', 'final_action', 'final_recommendation'],
    additionalProperties: false,
};

/**
 * Normalize analyst output - converts non-standard fields to expected format
 */
export function normalizeAnalystOutput(output: unknown): unknown {
    if (!output || typeof output !== 'object') return output;
    if (Array.isArray(output)) return output;

    const o = output as Record<string, unknown>;
    if (!o.recommendation || typeof o.recommendation !== 'object') return output;
    if (Array.isArray(o.recommendation)) return output;

    const rec = o.recommendation as Record<string, unknown>;

    if (
        rec.exit_plan !== null &&
        typeof rec.exit_plan === 'object' &&
        !Array.isArray(rec.exit_plan)
    ) {
        return {
            ...o,
            recommendation: {
                ...rec,
                exit_plan: JSON.stringify(rec.exit_plan),
            },
        };
    }

    return output;
}

/**
 * Validate analyst output structure
 */
export function validateAnalystOutput(output: unknown): output is AnalystOutput {
    if (!output || typeof output !== 'object') return false;

    const o = output as Record<string, unknown>;

    if (typeof o.reasoning !== 'string' || o.reasoning.trim().length === 0) return false;
    if (!o.recommendation || typeof o.recommendation !== 'object') return false;

    const rec = o.recommendation as Record<string, unknown>;

    const validActions: AnalystAction[] = ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'];
    if (!validActions.includes(rec.action as AnalystAction)) return false;

    // For HOLD actions, symbol/allocation/leverage can be null/0
    // For non-HOLD actions, they must be valid
    if (rec.action === 'HOLD') {
        // HOLD: symbol can be null or empty string
        if (rec.symbol !== null && rec.symbol !== undefined && typeof rec.symbol !== 'string') return false;
        // HOLD: allocation_usd must be exactly 0 or null (no other values allowed)
        // FIXED: Explicitly check for undefined to prevent it from passing validation
        if (rec.allocation_usd !== null && rec.allocation_usd !== undefined && rec.allocation_usd !== 0) return false;
        // HOLD: leverage must be exactly 0 or null (no other values allowed)
        // FIXED: Explicitly check for undefined to prevent it from passing validation
        if (rec.leverage !== null && rec.leverage !== undefined && rec.leverage !== 0) return false;
        // HOLD: tp_price and sl_price should be null
        if (rec.tp_price !== null && (typeof rec.tp_price !== 'number' || !Number.isFinite(rec.tp_price) || rec.tp_price <= 0)) return false;
        if (rec.sl_price !== null && (typeof rec.sl_price !== 'number' || !Number.isFinite(rec.sl_price) || rec.sl_price <= 0)) return false;
        // HOLD: exit_plan can be null or empty
        if (rec.exit_plan !== null && typeof rec.exit_plan !== 'string') return false;
    } else {
        // Non-HOLD actions require valid symbol, allocation, leverage
        if (typeof rec.symbol !== 'string' || rec.symbol.trim().length === 0) return false;
        if (typeof rec.allocation_usd !== 'number' || !Number.isFinite(rec.allocation_usd) || rec.allocation_usd <= 0) return false;
        if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage) || rec.leverage < 1 || rec.leverage > 20) return false;
        // Validate tp_price: must be null or a positive finite number
        if (rec.tp_price !== null && (typeof rec.tp_price !== 'number' || !Number.isFinite(rec.tp_price) || rec.tp_price <= 0)) return false;
        // Validate sl_price: must be null or a positive finite number
        if (rec.sl_price !== null && (typeof rec.sl_price !== 'number' || !Number.isFinite(rec.sl_price) || rec.sl_price <= 0)) return false;
        // Validate exit_plan is a non-empty string for non-HOLD actions
        if (typeof rec.exit_plan !== 'string' || rec.exit_plan.trim().length === 0) return false;
    }

    // Confidence is required for all actions
    if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence) || rec.confidence < 0 || rec.confidence > 100) return false;
    // Rationale is required for all actions
    if (typeof rec.rationale !== 'string' || rec.rationale.trim().length === 0) return false;

    return true;
}

/**
 * Validate judge output structure
 * 
 * FIXED: Added validation for final_recommendation field
 * FIXED: Added Number.isFinite checks to prevent NaN/Infinity propagation
 * FIXED: Enforce allocation_usd > 0 for non-HOLD actions (prevents nonsensical trades)
 */
export function validateJudgeOutput(output: unknown): output is JudgeDecision {
    if (!output || typeof output !== 'object') return false;

    const o = output as Record<string, unknown>;

    const validWinners = ['jim', 'ray', 'karen', 'quant', 'NONE'];
    if (!validWinners.includes(o.winner as string)) return false;

    if (typeof o.reasoning !== 'string' || o.reasoning.trim().length === 0) return false;

    if (o.adjustments !== null && typeof o.adjustments !== 'object') return false;

    // Validate adjustments properties if present
    // Allow leverage=0 in adjustments for HOLD actions
    if (o.adjustments !== null && typeof o.adjustments === 'object') {
        const adj = o.adjustments as Record<string, unknown>;
        if (adj.leverage !== undefined && (typeof adj.leverage !== 'number' || !Number.isFinite(adj.leverage) || adj.leverage < 0 || adj.leverage > 20)) return false;

        // FIXED: Cross-field check - adj.leverage is only allowed for entry actions (BUY/SELL)
        // Exit actions (HOLD/CLOSE/REDUCE) should not have leverage adjustments
        if (adj.leverage !== undefined && (o.final_action === 'HOLD' || o.final_action === 'CLOSE' || o.final_action === 'REDUCE')) {
            // Leverage adjustment with exit actions is invalid
            return false;
        }

        if (adj.allocation_usd !== undefined && (typeof adj.allocation_usd !== 'number' || !Number.isFinite(adj.allocation_usd) || adj.allocation_usd < 0)) return false;
        if (adj.sl_price !== undefined && (typeof adj.sl_price !== 'number' || !Number.isFinite(adj.sl_price) || adj.sl_price < 0)) return false;
        if (adj.tp_price !== undefined && (typeof adj.tp_price !== 'number' || !Number.isFinite(adj.tp_price) || adj.tp_price < 0)) return false;
    }

    if (!Array.isArray(o.warnings)) return false;
    // Validate each warning is a string and limit array size to match JSON schema (maxItems: 10)
    if (o.warnings.length > 10) return false; // Must match JUDGE_OUTPUT_SCHEMA.properties.warnings.maxItems
    for (const warning of o.warnings) {
        if (typeof warning !== 'string') return false;
    }

    const validActions: AnalystAction[] = ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'];
    if (!validActions.includes(o.final_action as AnalystAction)) return false;

    // FIXED: Enforce consistency - if winner is NONE, final_action must be HOLD
    // EXCEPTION: winner=NONE can have CLOSE/REDUCE for emergency position management
    // (e.g., when all analysts fail but a position needs closing due to risk)
    if (o.winner === 'NONE') {
        if (o.final_action !== 'HOLD' && o.final_action !== 'CLOSE' && o.final_action !== 'REDUCE') return false;
        // For HOLD with NONE winner, final_recommendation should be null
        if (o.final_action === 'HOLD' && o.final_recommendation !== null) {
            // FIXED: Strict validation - HOLD with NONE winner must have null recommendation
            // A non-null recommendation with HOLD action is inconsistent
            return false;
        }
        // For CLOSE/REDUCE with NONE winner, final_recommendation is required
        if ((o.final_action === 'CLOSE' || o.final_action === 'REDUCE') && o.final_recommendation === null) {
            return false; // CLOSE/REDUCE requires a recommendation
        }
    }

    // FIXED: When winner is an analyst (not NONE), final_recommendation MUST be provided
    // This ensures we have a valid recommendation to execute
    if (o.winner !== 'NONE' && o.final_recommendation === null) {
        return false;
    }

    // Validate final_recommendation (can be null or valid recommendation object)
    if (o.final_recommendation !== null) {
        if (typeof o.final_recommendation !== 'object') return false;
        const rec = o.final_recommendation as Record<string, unknown>;

        // Validate required fields of final_recommendation
        if (!validActions.includes(rec.action as AnalystAction)) return false;

        // FIXED: Validate final_action matches final_recommendation.action
        // These must be consistent - final_action is the top-level action, and
        // final_recommendation.action is the action in the recommendation object.
        // If they don't match, the judge output is inconsistent and invalid.
        if (o.final_action !== rec.action) return false;

        // FIXED: Validate symbol is non-empty
        if (typeof rec.symbol !== 'string' || rec.symbol.trim().length === 0) return false;
        if (typeof rec.allocation_usd !== 'number' || !Number.isFinite(rec.allocation_usd) || rec.allocation_usd < 0) return false;
        // FIXED: For non-HOLD actions, allocation_usd must be > 0 (can't trade with zero allocation)
        if (rec.action !== 'HOLD' && rec.allocation_usd === 0) return false;
        // Leverage validation (consistent with validateAnalystOutput):
        // - HOLD: must be exactly 0 (not trading, no leverage)
        // - Non-HOLD: must be 1-20
        if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage)) return false;
        if (rec.action === 'HOLD') {
            if (rec.leverage !== 0) return false; // HOLD requires exactly 0 leverage
        } else {
            if (rec.leverage < 1 || rec.leverage > 20) return false;
        }
        // Validate tp_price: must be null or a positive finite number
        if (rec.tp_price !== null && (typeof rec.tp_price !== 'number' || !Number.isFinite(rec.tp_price) || rec.tp_price <= 0)) return false;
        // Validate sl_price: must be null or a positive finite number
        if (rec.sl_price !== null && (typeof rec.sl_price !== 'number' || !Number.isFinite(rec.sl_price) || rec.sl_price <= 0)) return false;
        // FIXED: Validate exit_plan is non-empty for non-HOLD actions
        if (typeof rec.exit_plan !== 'string') return false;
        if (rec.action !== 'HOLD' && rec.exit_plan.trim().length === 0) return false;
        if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence) || rec.confidence < 0 || rec.confidence > 100) return false;
        // FIXED: Validate rationale is non-empty
        if (typeof rec.rationale !== 'string' || rec.rationale.trim().length === 0) return false;
    }

    return true;
}
