/**
 * Analyst Types for v5.0.0 Parallel Analysis System
 * Each analyst receives full context and outputs a standardized recommendation.
 * All 4 analyze independently in parallel, then a judge picks the winner.
 */

import { logger } from '../utils/logger';

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
    rl_validation?: {
        q_long: number;
        q_short: number;
        q_hold: number;
        regret: number;
        expected_value?: number;
        sharpe?: number;
    } | null;
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

// =============================================================================
// DEBATE TYPES
// =============================================================================

export interface DebateTurn {
    speakerId: AnalystId;
    position: 'bull' | 'bear';
    content: string;
    dataPointsReferenced: string[];
    argumentStrength: number;
    timestamp: number;
}

export interface DebateScores {
    bullScore: number;
    bearScore: number;
    dataQuality: { bull: number; bear: number };
    logicCoherence: { bull: number; bear: number };
    riskAcknowledgment: { bull: number; bear: number };
    catalystIdentification: { bull: number; bear: number };
}

export interface StockDebate {
    matchId: string;
    symbol: string;
    round: 'quarterfinal' | 'semifinal' | 'final';
    bullAnalystId: AnalystId;
    bearAnalystId: AnalystId;
    bullOutput: AnalystOutput;
    bearOutput: AnalystOutput;
    dialogue: DebateTurn[];
    winner: 'bull' | 'bear' | null;
    winningArguments: string[];
    scores: DebateScores;
}

export interface TournamentResult {
    debates: StockDebate[];
    championId: AnalystId | null;
    summary: string;
    durationMs: number;
}

export interface AnalystProfile {
    id: AnalystId;
    name: string;
    role: string;
    methodology: string;
    focus: string[];
    riskTolerance: 'conservative' | 'moderate' | 'aggressive';
    tournamentStrengths?: {
        data: number;
        logic: number;
        rebuttal: number;
        catalysts: number;
    };
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
        rl_validation: {
            type: ['object', 'null'],
            properties: {
                q_long: { type: 'number' },
                q_short: { type: 'number' },
                q_hold: { type: 'number' },
                regret: { type: 'number' },
                expected_value: { type: 'number' },
                sharpe: { type: 'number' },
            },
            required: ['q_long', 'q_short', 'q_hold', 'regret'],
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
 * Normalize judge decision - converts non-standard fields to expected format
 * Handles edge cases like HOLD actions with leverage, or missing rationale
 */
export function normalizeJudgeDecision(value: unknown): any {
    if (!value || typeof value !== 'object') return value;

    const v = value as Record<string, any>;

    // Ensure warnings is an array
    if (!Array.isArray(v.warnings)) {
        v.warnings = [];
    } else if (v.warnings.length > 10) {
        v.warnings = v.warnings.slice(0, 10);
    }

    // Normalize winner
    if (v.winner === 'null' || v.winner === null) {
        v.winner = 'NONE';
    }

    const finalAction = v.final_action;

    // CRITICAL: Handle winner=NONE consistency
    // If winner is NONE, we expect HOLD action and NO recommendation
    // Exception: Emergency CLOSE/REDUCE actions are allowed with winner=NONE
    if (v.winner === 'NONE') {
        if (finalAction === 'HOLD') {
            v.final_recommendation = null;
            v.adjustments = null;
        } else if (finalAction !== 'CLOSE' && finalAction !== 'REDUCE') {
            // Invalid state: winner=NONE but action is BUY/SELL
            // Force to HOLD
            v.final_action = 'HOLD';
            v.final_recommendation = null;
            v.adjustments = null;
        }
    }

    if (finalAction === 'CLOSE' || finalAction === 'REDUCE') {
        v.adjustments = null;

        if (v.final_recommendation && typeof v.final_recommendation === 'object') {
            v.final_recommendation.leverage = 0;
        }
    } else if (finalAction === 'HOLD') {
        v.adjustments = null;
        // Force winner to NONE for HOLD to satisfy validation logic
        // (Validation: winner!=NONE -> rec!=null; action=HOLD -> rec=null. Contradiction unless winner=NONE)
        v.winner = 'NONE';
        v.final_recommendation = null;
    }

    // Fix recommendation structure if present
    if (v.final_recommendation && typeof v.final_recommendation === 'object') {
        const rec = v.final_recommendation;

        // Inject rationale from reasoning if missing (save tokens in prompt)
        if (!rec.rationale || typeof rec.rationale !== 'string' || rec.rationale.trim() === '') {
            rec.rationale = v.reasoning || 'No rationale provided';
        }

        // Sync action
        if (v.final_action) {
            rec.action = v.final_action;
        }

        // Ensure numeric fields are numbers (handle string numbers from LLM)
        const parseNumeric = (val: unknown, fieldName: string): number | null => {
            if (val === null || val === undefined) return null;
            if (typeof val === 'number') return val;
            if (typeof val === 'string') {
                // Handle percentage strings for confidence
                if (fieldName === 'confidence' && val.trim().endsWith('%')) {
                    const parsed = parseFloat(val.replace('%', ''));
                    return Number.isFinite(parsed) ? parsed : null;
                }
                const parsed = parseFloat(val);
                return Number.isFinite(parsed) ? parsed : null;
            }
            return null;
        };

        if (rec.allocation_usd !== undefined) {
            const parsed = parseNumeric(rec.allocation_usd, 'allocation_usd');
            if (parsed !== null) rec.allocation_usd = parsed;
        }
        if (rec.leverage !== undefined) {
            const parsed = parseNumeric(rec.leverage, 'leverage');
            if (parsed !== null) rec.leverage = parsed;
        }
        if (rec.tp_price !== undefined) {
            const parsed = parseNumeric(rec.tp_price, 'tp_price');
            if (parsed !== null) rec.tp_price = parsed;
        }
        if (rec.sl_price !== undefined) {
            const parsed = parseNumeric(rec.sl_price, 'sl_price');
            if (parsed !== null) rec.sl_price = parsed;
        }

        // Special handling for confidence
        const rawConfidence = rec.confidence;
        const parsedConfidence = parseNumeric(rawConfidence, 'confidence');

        if (parsedConfidence !== null) {
            rec.confidence = parsedConfidence;
            // Only normalize 0-1 range if input didn't have '%' suffix (which was handled in parseNumeric)
            const wasPercentage = typeof rawConfidence === 'string' && rawConfidence.trim().endsWith('%');
            if (!wasPercentage && rec.confidence > 0 && rec.confidence <= 1) {
                rec.confidence = rec.confidence * 100;
            }
        }

        // Normalize confidence (0-1 -> 0-100) if needed - REMOVED redundant block


        // ENHANCED VALIDATION FOR BUY/SELL
        if (rec.action === 'BUY' || rec.action === 'SELL') {
            // Force invalid allocation to HOLD
            if (!rec.allocation_usd || rec.allocation_usd <= 0) {
                v.final_action = 'HOLD';
                v.winner = 'NONE';
                v.final_recommendation = null;
                v.adjustments = null;
                return v; // Early return for forced HOLD
            }

            // Fix leverage
            if (!rec.leverage || rec.leverage < 1) {
                rec.leverage = 1; // Default to 1x
            } else if (rec.leverage > 20) {
                rec.leverage = 20; // Cap at 20x
            }
        }
    }

    // Fix adjustments structure
    if (v.adjustments && typeof v.adjustments === 'object') {
        const adj = v.adjustments;
        // Convert nulls to undefined for validation compatibility
        if (adj.leverage === null) delete adj.leverage;
        if (adj.allocation_usd === null) delete adj.allocation_usd;
        if (adj.sl_price === null) delete adj.sl_price;
        if (adj.tp_price === null) delete adj.tp_price;

        // If adjustments object is empty after cleanup, make it null
        if (Object.keys(adj).length === 0) {
            v.adjustments = null;
        }
    }

    return v;
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
    } else if (rec.action === 'CLOSE' || rec.action === 'REDUCE') {
        if (typeof rec.symbol !== 'string' || rec.symbol.trim().length === 0) return false;
        if (rec.allocation_usd !== null && rec.allocation_usd !== undefined) {
            if (typeof rec.allocation_usd !== 'number' || !Number.isFinite(rec.allocation_usd) || rec.allocation_usd < 0) return false;
        }
        if (rec.leverage !== null && rec.leverage !== undefined) {
            if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage) || rec.leverage < 0 || rec.leverage > 20) return false;
        }
        if (rec.tp_price !== null && (typeof rec.tp_price !== 'number' || !Number.isFinite(rec.tp_price) || rec.tp_price <= 0)) return false;
        if (rec.sl_price !== null && (typeof rec.sl_price !== 'number' || !Number.isFinite(rec.sl_price) || rec.sl_price <= 0)) return false;
        if (rec.exit_plan !== null && typeof rec.exit_plan !== 'string') return false;
    } else {
        // Entry actions require valid symbol, allocation, leverage
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
    if (!output || typeof output !== 'object') {
        const typeInfo = output === null ? 'null' : typeof output;
        logger.warn(`Judge validation failed: Output is not an object (got ${typeInfo})`);
        return false;
    }

    const o = output as Record<string, unknown>;

    const validWinners = ['jim', 'ray', 'karen', 'quant', 'NONE'];
    if (!validWinners.includes(o.winner as string)) {
        logger.warn(`Judge validation failed: Invalid winner "${o.winner}"`);
        return false;
    }

    if (typeof o.reasoning !== 'string' || o.reasoning.trim().length === 0) {
        logger.warn(`Judge validation failed: Missing or empty reasoning`);
        return false;
    }

    if (o.adjustments !== null && typeof o.adjustments !== 'object') {
        logger.warn(`Judge validation failed: adjustments is not null or object`);
        return false;
    }

    // Validate adjustments properties if present
    // Allow leverage=0 in adjustments for HOLD actions
    if (o.adjustments !== null && typeof o.adjustments === 'object') {
        const adj = o.adjustments as Record<string, unknown>;
        if (adj.leverage !== undefined && (typeof adj.leverage !== 'number' || !Number.isFinite(adj.leverage) || adj.leverage < 0 || adj.leverage > 20)) {
            logger.warn(`Judge validation failed: Invalid adjustment leverage`, { leverage: adj.leverage });
            return false;
        }

        // FIXED: Cross-field check - adj.leverage is only allowed for entry actions (BUY/SELL)
        // Exit actions (HOLD/CLOSE/REDUCE) should not have leverage adjustments
        if (adj.leverage !== undefined && (o.final_action === 'HOLD' || o.final_action === 'CLOSE' || o.final_action === 'REDUCE')) {
            // Leverage adjustment with exit actions is invalid
            logger.warn(`Judge validation failed: Leverage adjustment provided for non-entry action ${o.final_action}`);
            return false;
        }

        if (adj.allocation_usd !== undefined && (typeof adj.allocation_usd !== 'number' || !Number.isFinite(adj.allocation_usd) || adj.allocation_usd < 0)) {
            logger.warn(`Judge validation failed: Invalid adjustment allocation_usd`, { allocation_usd: adj.allocation_usd });
            return false;
        }
        if (adj.sl_price !== undefined && (typeof adj.sl_price !== 'number' || !Number.isFinite(adj.sl_price) || adj.sl_price < 0)) {
            logger.warn(`Judge validation failed: Invalid adjustment sl_price`, { sl_price: adj.sl_price });
            return false;
        }
        if (adj.tp_price !== undefined && (typeof adj.tp_price !== 'number' || !Number.isFinite(adj.tp_price) || adj.tp_price < 0)) {
            logger.warn(`Judge validation failed: Invalid adjustment tp_price`, { tp_price: adj.tp_price });
            return false;
        }
    }

    if (!Array.isArray(o.warnings)) {
        logger.warn(`Judge validation failed: warnings is not an array`);
        return false;
    }
    // Validate each warning is a string and limit array size to match JSON schema (maxItems: 10)
    if (o.warnings.length > 10) {
        logger.warn(`Judge validation failed: Too many warnings (${o.warnings.length})`);
        return false; // Must match JUDGE_OUTPUT_SCHEMA.properties.warnings.maxItems
    }
    for (const warning of o.warnings) {
        if (typeof warning !== 'string') {
            logger.warn(`Judge validation failed: Non-string warning found`);
            return false;
        }
    }

    const validActions: AnalystAction[] = ['BUY', 'SELL', 'HOLD', 'CLOSE', 'REDUCE'];
    if (!validActions.includes(o.final_action as AnalystAction)) {
        logger.warn(`Judge validation failed: Invalid final_action "${o.final_action}"`);
        return false;
    }

    // FIXED: Enforce consistency - if winner is NONE, final_action must be HOLD
    // EXCEPTION: winner=NONE can have CLOSE/REDUCE for emergency position management
    // (e.g., when all analysts fail but a position needs closing due to risk)
    if (o.winner === 'NONE') {
        if (o.final_action !== 'HOLD' && o.final_action !== 'CLOSE' && o.final_action !== 'REDUCE') {
            logger.warn(`Judge validation failed: winner=NONE but action is ${o.final_action}`);
            return false;
        }
        // For HOLD with NONE winner, final_recommendation should be null
        if (o.final_action === 'HOLD' && o.final_recommendation !== null) {
            // FIXED: Strict validation - HOLD with NONE winner must have null recommendation
            // A non-null recommendation with HOLD action is inconsistent
            logger.warn(`Judge validation failed: winner=NONE, action=HOLD, but recommendation is not null`);
            return false;
        }
        // For CLOSE/REDUCE with NONE winner, final_recommendation is required
        if ((o.final_action === 'CLOSE' || o.final_action === 'REDUCE') && o.final_recommendation === null) {
            logger.warn(`Judge validation failed: winner=NONE, action=${o.final_action}, but recommendation is null`);
            return false; // CLOSE/REDUCE requires a recommendation
        }
    }

    // FIXED: When winner is an analyst (not NONE), final_recommendation MUST be provided
    // This ensures we have a valid recommendation to execute
    if (o.winner !== 'NONE' && o.final_recommendation === null) {
        logger.warn(`Judge validation failed: winner=${o.winner} but recommendation is null`);
        return false;
    }

    // Validate final_recommendation (can be null or valid recommendation object)
    if (o.final_recommendation !== null) {
        if (typeof o.final_recommendation !== 'object') {
            logger.warn(`Judge validation failed: final_recommendation is not an object`);
            return false;
        }
        const rec = o.final_recommendation as Record<string, unknown>;

        // Validate required fields of final_recommendation
        if (!validActions.includes(rec.action as AnalystAction)) {
            logger.warn(`Judge validation failed: Invalid recommendation action "${rec.action}"`);
            return false;
        }

        // FIXED: Validate final_action matches final_recommendation.action
        // These must be consistent - final_action is the top-level action, and
        // final_recommendation.action is the action in the recommendation object.
        // If they don't match, the judge output is inconsistent and invalid.
        if (o.final_action !== rec.action) {
            logger.warn(`Judge validation failed: Mismatch between final_action (${o.final_action}) and rec.action (${rec.action})`);
            return false;
        }

        if (rec.action === 'HOLD') {
            if (rec.symbol !== null && rec.symbol !== undefined && typeof rec.symbol !== 'string') {
                logger.warn(`Judge validation failed: Invalid symbol for HOLD action`);
                return false;
            }
        } else {
            if (typeof rec.symbol !== 'string' || rec.symbol.trim().length === 0) {
                logger.warn(`Judge validation failed: Missing/empty symbol for non-HOLD action`);
                return false;
            }
        }
        if (typeof rec.allocation_usd !== 'number' || !Number.isFinite(rec.allocation_usd) || rec.allocation_usd < 0) {
            logger.warn(`Judge validation failed: Invalid rec.allocation_usd`, { allocation_usd: rec.allocation_usd });
            return false;
        }
        if ((rec.action === 'BUY' || rec.action === 'SELL') && rec.allocation_usd === 0) {
            logger.warn(`Judge validation failed: Zero allocation for BUY/SELL`);
            return false;
        }
        // Leverage validation (consistent with validateAnalystOutput):
        // - HOLD: must be exactly 0 (not trading, no leverage)
        // - CLOSE/REDUCE: leverage is ignored; allow 0-20
        // - BUY/SELL: must be 1-20
        if (rec.action === 'HOLD') {
            if (rec.leverage !== null && rec.leverage !== undefined) {
                if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage) || rec.leverage !== 0) {
                    logger.warn(`Judge validation failed: Invalid leverage for HOLD (must be 0)`, { leverage: rec.leverage });
                    return false;
                }
            }
        } else if (rec.action === 'CLOSE' || rec.action === 'REDUCE') {
            if (rec.leverage !== null && rec.leverage !== undefined) {
                if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage)) {
                    logger.warn(`Judge validation failed: Non-numeric leverage for CLOSE/REDUCE`);
                    return false;
                }
                if (rec.leverage < 0 || rec.leverage > 20) {
                    logger.warn(`Judge validation failed: Leverage out of range for CLOSE/REDUCE`, { leverage: rec.leverage });
                    return false;
                }
            }
        } else {
            if (typeof rec.leverage !== 'number' || !Number.isFinite(rec.leverage)) {
                logger.warn(`Judge validation failed: Non-numeric leverage for BUY/SELL`);
                return false;
            }
            if (rec.leverage < 1 || rec.leverage > 20) {
                logger.warn(`Judge validation failed: Leverage out of range for BUY/SELL`, { leverage: rec.leverage });
                return false;
            }
        }
        // Validate tp_price: must be null or a positive finite number
        if (rec.tp_price !== null && (typeof rec.tp_price !== 'number' || !Number.isFinite(rec.tp_price) || rec.tp_price <= 0)) {
            logger.warn(`Judge validation failed: Invalid tp_price`, { tp_price: rec.tp_price });
            return false;
        }
        // Validate sl_price: must be null or a positive finite number
        if (rec.sl_price !== null && (typeof rec.sl_price !== 'number' || !Number.isFinite(rec.sl_price) || rec.sl_price <= 0)) {
            logger.warn(`Judge validation failed: Invalid sl_price`, { sl_price: rec.sl_price });
            return false;
        }
        // FIXED: Validate exit_plan is non-empty for entry actions
        if (typeof rec.exit_plan !== 'string') {
            logger.warn(`Judge validation failed: exit_plan is not a string`);
            return false;
        }
        if ((rec.action === 'BUY' || rec.action === 'SELL') && rec.exit_plan.trim().length === 0) {
            logger.warn(`Judge validation failed: Empty exit_plan for BUY/SELL`);
            return false;
        }
        if (typeof rec.confidence !== 'number' || !Number.isFinite(rec.confidence) || rec.confidence < 0 || rec.confidence > 100) {
            logger.warn(`Judge validation failed: Invalid confidence`, { confidence: rec.confidence });
            return false;
        }
        // FIXED: Validate rationale is non-empty
        if (typeof rec.rationale !== 'string' || rec.rationale.trim().length === 0) {
            logger.warn(`Judge validation failed: Empty recommendation rationale`);
            return false;
        }
    }

    return true;
}
