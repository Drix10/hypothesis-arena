/**
 * Analyst Types for v5.0.0 Parallel Analysis System
 * 
 * Each analyst receives full context and outputs a standardized recommendation.
 * No more turn-by-turn debates - all 4 analyze independently in parallel.
 */

/**
 * Actions an analyst can recommend
 */
export type AnalystAction = 'BUY' | 'SELL' | 'HOLD' | 'CLOSE' | 'REDUCE';

/**
 * Analyst IDs
 */
export type AnalystId = 'jim' | 'ray' | 'karen' | 'quant';

/**
 * The recommendation output from each analyst
 * 
 * NOTE: leverage range is 3-10x in practice (per LeverageService),
 * but validation allows 1-10x for edge cases where lower leverage is needed.
 */
export interface AnalystRecommendation {
    action: AnalystAction;
    symbol: string;              // e.g., "cmt_btcusdt"
    allocation_usd: number;      // Notional exposure in USD (not margin)
    leverage: number;            // 1-10x (typically 3-10x based on conditions)
    tp_price: number | null;     // Take profit price
    sl_price: number | null;     // Stop loss price
    exit_plan: string;           // Invalidation condition (CRITICAL)
    confidence: number;          // 0-100
    rationale: string;           // One-line summary
}

/**
 * Full output from an analyst (reasoning + recommendation)
 */
export interface AnalystOutput {
    reasoning: string;           // Detailed step-by-step analysis
    recommendation: AnalystRecommendation;
}

/**
 * Error source identifier - includes analysts and system-level errors
 */
export type ErrorSource = AnalystId | 'system';

/**
 * Result from parallel analysis (all 4 analysts)
 */
export interface ParallelAnalysisResult {
    jim: AnalystOutput | null;
    ray: AnalystOutput | null;
    karen: AnalystOutput | null;
    quant: AnalystOutput | null;
    timestamp: number;
    errors: { analyst: ErrorSource; error: string }[];
}

/**
 * Risk adjustments the judge can apply to winner's recommendation
 */
export interface RiskAdjustments {
    leverage?: number;           // Reduce if too risky
    allocation_usd?: number;     // Reduce if too large
    sl_price?: number;           // Tighten if too wide
    tp_price?: number;           // Adjust take profit
}

/**
 * Judge's decision after comparing 4 analyses
 */
export interface JudgeDecision {
    winner: AnalystId | 'NONE';
    reasoning: string;
    adjustments: RiskAdjustments | null;
    warnings: string[];
    final_action: AnalystAction;
    final_recommendation: AnalystRecommendation | null;
}

/**
 * Analyst profile for prompt generation
 */
export interface AnalystProfile {
    id: AnalystId;
    name: string;
    role: string;
    methodology: string;
    focus: string[];
    riskTolerance: 'conservative' | 'moderate' | 'aggressive';
}

/**
 * JSON Schema for analyst output (used for structured output)
 * 
 * NOTE on allocation_usd minimum: 0 is allowed for HOLD actions where no trade is executed.
 * For BUY/SELL/CLOSE/REDUCE actions, the validation function enforces allocation_usd > 0.
 */
export const ANALYST_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        reasoning: { type: 'string' },
        recommendation: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'] },
                symbol: { type: 'string' },
                // NOTE: Schema allows 0 for HOLD actions; validation function enforces > 0 for trades
                allocation_usd: { type: 'number', minimum: 0 },
                // FIXED: Allow leverage=0 for HOLD actions (consistent with validator)
                leverage: { type: 'number', minimum: 0, maximum: 10 },
                // tp_price and sl_price: null for HOLD, or positive number for trades
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
 * JSON Schema for judge output (used for structured output)
 * 
 * NOTE on allocation_usd minimum: 0 is allowed for HOLD actions where no trade is executed.
 * For BUY/SELL/CLOSE/REDUCE actions, the validation function enforces allocation_usd > 0.
 */
export const JUDGE_OUTPUT_SCHEMA = {
    type: 'object',
    properties: {
        winner: { type: 'string', enum: ['jim', 'ray', 'karen', 'quant', 'NONE'] },
        reasoning: { type: 'string' },
        adjustments: {
            type: ['object', 'null'],
            properties: {
                // FIXED: Allow leverage=0 for HOLD actions (consistent with validator)
                leverage: { type: 'number', minimum: 0, maximum: 10 },
                // NOTE: Schema allows 0 for adjustments; validation function enforces > 0 for trades
                allocation_usd: { type: 'number', minimum: 0 },
                // sl_price and tp_price in adjustments: 0 means "remove", positive means "set to this value"
                sl_price: { type: 'number', minimum: 0 },
                tp_price: { type: 'number', minimum: 0 },
            },
            additionalProperties: false,
        },
        warnings: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 10  // Prevent unbounded arrays
        },
        final_action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'] },
        final_recommendation: {
            type: ['object', 'null'],
            properties: {
                action: { type: 'string', enum: ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'] },
                symbol: { type: 'string' },
                // NOTE: Schema allows 0 for HOLD actions; validation function enforces > 0 for trades
                allocation_usd: { type: 'number', minimum: 0 },
                // FIXED: Allow leverage=0 for HOLD actions (consistent with validator)
                leverage: { type: 'number', minimum: 0, maximum: 10 },
                // tp_price and sl_price: null for HOLD, or positive number for trades
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
 * Validate analyst output structure
 * 
 * FIXED: Added Number.isFinite checks to prevent NaN/Infinity propagation
 * FIXED: Added empty string validation for critical fields
 * FIXED: Enforce allocation_usd > 0 for non-HOLD actions (prevents nonsensical trades)
 * FIXED: Allow leverage=0 for HOLD actions (AI often returns 0 when not trading)
 */
export function validateAnalystOutput(output: unknown): output is AnalystOutput {
    if (!output || typeof output !== 'object') return false;

    const o = output as Record<string, unknown>;

    if (typeof o.reasoning !== 'string' || o.reasoning.trim().length === 0) return false;
    if (!o.recommendation || typeof o.recommendation !== 'object') return false;

    const rec = o.recommendation as Record<string, unknown>;

    const validActions: AnalystAction[] = ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'];
    if (!validActions.includes(rec.action as AnalystAction)) return false;

    // FIXED: Validate symbol is non-empty string
    if (typeof rec.symbol !== 'string' || rec.symbol.trim().length === 0) return false;
    // FIXED: Check for NaN/Infinity
    if (typeof rec.allocation_usd !== 'number' || !Number.isFinite(rec.allocation_usd) || rec.allocation_usd < 0) return false;
    // FIXED: For non-HOLD actions, allocation_usd must be > 0 (can't trade with zero allocation)
    if (rec.action !== 'HOLD' && rec.allocation_usd === 0) return false;
    // FIXED: Allow leverage=0 for HOLD actions (AI returns 0 when not trading)
    // For non-HOLD actions, leverage must be 1-10
    if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage)) return false;
    if (rec.action === 'HOLD') {
        if (rec.leverage < 0 || rec.leverage > 10) return false;
    } else {
        if (rec.leverage < 1 || rec.leverage > 10) return false;
    }
    // Validate tp_price: must be null or a positive finite number
    if (rec.tp_price !== null && (typeof rec.tp_price !== 'number' || !Number.isFinite(rec.tp_price) || rec.tp_price <= 0)) return false;
    // Validate sl_price: must be null or a positive finite number
    if (rec.sl_price !== null && (typeof rec.sl_price !== 'number' || !Number.isFinite(rec.sl_price) || rec.sl_price <= 0)) return false;
    // FIXED: Validate exit_plan is non-empty for non-HOLD actions
    // Also handle case where AI returns object instead of string
    let exitPlanStr: string;
    if (rec.exit_plan !== null && typeof rec.exit_plan === 'object') {
        // AI returned object, convert to string for validation
        exitPlanStr = JSON.stringify(rec.exit_plan);
    } else if (typeof rec.exit_plan === 'string') {
        exitPlanStr = rec.exit_plan;
    } else {
        return false;
    }
    if (rec.action !== 'HOLD' && exitPlanStr.trim().length === 0) return false;
    if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence) || rec.confidence < 0 || rec.confidence > 100) return false;
    // FIXED: Validate rationale is non-empty
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
    // FIXED: Allow leverage=0 in adjustments for HOLD actions (consistent with schema)
    if (o.adjustments !== null && typeof o.adjustments === 'object') {
        const adj = o.adjustments as Record<string, unknown>;
        if (adj.leverage !== undefined && (typeof adj.leverage !== 'number' || !Number.isFinite(adj.leverage) || adj.leverage < 0 || adj.leverage > 10)) return false;
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
        // FIXED: Allow leverage=0 for HOLD actions (consistent with validateAnalystOutput)
        // For non-HOLD actions, leverage must be 1-10
        if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage)) return false;
        if (rec.action === 'HOLD') {
            if (rec.leverage < 0 || rec.leverage > 10) return false;
        } else {
            if (rec.leverage < 1 || rec.leverage > 10) return false;
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
