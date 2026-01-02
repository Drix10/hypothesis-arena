/**
 * Prompt Helper Functions
 * 
 * Utility functions for safe prompt building with proper validation and formatting.
 */

import type { AnalystMethodology } from '../analyst/types';
import { filterPromptByAction } from './contextFilter';
import { config, getActiveTradingStyle } from '../../config';
import { RISK_COUNCIL_VETO_TRIGGERS } from '../analyst/riskCouncil';

/**
 * Get trading configuration values for use in prompts
 * All values come from config/env - NO HARDCODING
 * 
 * This ensures all prompts use consistent, configurable values
 * 
 * @returns Trading configuration object with validated values
 * @throws Error if critical configuration is missing or invalid
 */
export function getTradingConfig() {
    const tradingStyle = getActiveTradingStyle();

    // Validate cycleIntervalMs before division to prevent NaN/Infinity
    const cycleIntervalMs = config.autonomous.cycleIntervalMs;
    if (!Number.isFinite(cycleIntervalMs) || cycleIntervalMs <= 0) {
        throw new Error(
            `Invalid cycleIntervalMs: ${cycleIntervalMs}. ` +
            `Must be a positive finite number. Check CYCLE_INTERVAL_MS in .env`
        );
    }

    return {
        // Position limits
        maxPositionSizePercent: RISK_COUNCIL_VETO_TRIGGERS.MAX_POSITION_PERCENT,
        maxConcurrentPositions: RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_POSITIONS,
        maxSameDirectionPositions: RISK_COUNCIL_VETO_TRIGGERS.MAX_SAME_DIRECTION_POSITIONS,

        // Risk limits
        maxStopLossPercent: RISK_COUNCIL_VETO_TRIGGERS.MAX_STOP_LOSS_DISTANCE,
        maxLeverage: RISK_COUNCIL_VETO_TRIGGERS.MAX_LEVERAGE,
        maxWeeklyDrawdown: RISK_COUNCIL_VETO_TRIGGERS.MAX_WEEKLY_DRAWDOWN,
        maxFundingAgainst: RISK_COUNCIL_VETO_TRIGGERS.MAX_FUNDING_AGAINST,
        maxFundingAgainstPercent: RISK_COUNCIL_VETO_TRIGGERS.MAX_FUNDING_AGAINST * 100, // As percentage

        // Portfolio limits
        netExposureLong: RISK_COUNCIL_VETO_TRIGGERS.NET_EXPOSURE_LIMITS.LONG,
        netExposureShort: RISK_COUNCIL_VETO_TRIGGERS.NET_EXPOSURE_LIMITS.SHORT,
        maxRiskPerTrade: RISK_COUNCIL_VETO_TRIGGERS.MAX_RISK_PER_TRADE_PERCENT,
        maxConcurrentRisk: RISK_COUNCIL_VETO_TRIGGERS.MAX_CONCURRENT_RISK_PERCENT,

        // Timing (validated above)
        cycleIntervalMs: cycleIntervalMs,
        cycleIntervalMinutes: Math.round(cycleIntervalMs / 60000),

        // Mode
        dryRun: config.autonomous.dryRun,

        // Checklist (pre-formatted)
        checklist: RISK_COUNCIL_VETO_TRIGGERS.CHECKLIST,

        // Trading Style (from env)
        tradingStyle: tradingStyle.style,
        isScalping: tradingStyle.isScalping,
        targetProfitPercent: tradingStyle.targetProfitPercent,
        styleStopLossPercent: tradingStyle.stopLossPercent,
        maxHoldHours: tradingStyle.maxHoldHours,
        maxHoldDays: tradingStyle.maxHoldDays,
        takeProfitThresholds: tradingStyle.takeProfitThresholds,
        minRiskRewardRatio: tradingStyle.minRiskRewardRatio,
    };
}

/**
 * Format trading config as a string for inclusion in prompts
 */
export function formatTradingConfigForPrompt(): string {
    const cfg = getTradingConfig();
    return `
SYSTEM CONFIGURATION (from config - DO NOT HARDCODE):
- Max Position Size: ${cfg.maxPositionSizePercent}% of account
- Max Concurrent Positions: ${cfg.maxConcurrentPositions}
- Max Same Direction: ${cfg.maxSameDirectionPositions} positions
- Max Leverage: ${cfg.maxLeverage}x
- Max Stop Loss: ${cfg.maxStopLossPercent}% from entry
- Max Weekly Drawdown: ${cfg.maxWeeklyDrawdown}%
- Max Funding Against: ${cfg.maxFundingAgainstPercent.toFixed(2)}%
- Net Exposure Limits: LONG ≤${cfg.netExposureLong}%, SHORT ≤${cfg.netExposureShort}%
- Cycle Interval: ${cfg.cycleIntervalMinutes} minutes
- Mode: ${cfg.dryRun ? 'DRY RUN (no real trades)' : 'LIVE TRADING'}
`.trim();
}

/**
 * Get cycle context for prompts - explains the autonomous trading cycle
 */
export function getCycleContext(): string {
    const cfg = getTradingConfig();
    return `
AUTONOMOUS TRADING CYCLE CONTEXT:
You are part of an autonomous trading system that runs in cycles every ${cfg.cycleIntervalMinutes} minutes.
Each cycle: Market Scan → Coin Selection (4 analysts) → Championship (8 analysts) → Risk Council → Execution → Position Management

Your decisions directly affect real portfolio positions. The system:
- Manages a shared portfolio with max ${cfg.maxConcurrentPositions} concurrent positions
- Enforces ${cfg.maxLeverage}x max leverage and ${cfg.maxStopLossPercent}% max stop loss
- Runs 24/7 with automated position management between cycles
- Tracks your win rate and P&L attribution for performance ranking

CRITICAL: Position management is equally important as new entries. Always evaluate existing positions first!
`.trim();
}


/**
 * Safely get a system prompt for an analyst methodology
 * Validates that the methodology exists and returns a valid prompt
 * 
 * @param methodology - The analyst methodology to get the prompt for
 * @param promptsMap - Map of methodologies to system prompts
 * @param action - Optional action type for context filtering (LONG, SHORT, or MANAGE)
 * @returns The system prompt string (filtered if action provided)
 * @throws Error if methodology is invalid or prompt is not found
 */
export function getSystemPrompt(
    methodology: string | undefined,
    promptsMap: Record<AnalystMethodology, string>,
    action?: 'LONG' | 'SHORT' | 'MANAGE'
): string {
    // Validate methodology is provided
    if (!methodology || typeof methodology !== 'string') {
        throw new Error(
            `Invalid methodology: ${methodology}. ` +
            `Must be a non-empty string. ` +
            `Valid methodologies: ${Object.keys(promptsMap).join(', ')}`
        );
    }

    // Check if methodology exists in the map
    if (!Object.prototype.hasOwnProperty.call(promptsMap, methodology)) {
        throw new Error(
            `Unknown methodology: "${methodology}". ` +
            `Valid methodologies: ${Object.keys(promptsMap).join(', ')}`
        );
    }

    // Get the prompt (TypeScript now knows it exists)
    const prompt = promptsMap[methodology as AnalystMethodology];

    // Final safety check - ensure prompt is not undefined/empty
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        throw new Error(
            `System prompt for methodology "${methodology}" is empty or invalid. ` +
            `This indicates a configuration error in THESIS_SYSTEM_PROMPTS.`
        );
    }

    // Apply context filtering if action is provided
    if (action) {
        return filterPromptByAction(action, prompt);
    }

    return prompt;
}

/**
 * Safely format a number for display in prompts
 * Handles NaN, Infinity, and undefined values
 */
export function safeNumber(value: number | undefined | null, decimals: number = 2, fallback: string = 'N/A'): string {
    if (value === null || value === undefined) return fallback;
    if (!Number.isFinite(value)) return fallback;
    return value.toFixed(decimals);
}

/**
 * Safely format a price with $ prefix
 */
export function safePrice(value: number | undefined | null, decimals: number = 2): string {
    const formatted = safeNumber(value, decimals, 'N/A');
    return formatted === 'N/A' ? formatted : `$${formatted}`;
}

/**
 * Safely format a percentage
 */
export function safePercent(value: number | undefined | null, decimals: number = 2, includeSign: boolean = false): string {
    if (value === null || value === undefined) return 'N/A';
    if (!Number.isFinite(value)) return 'N/A';

    const sign = includeSign && value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(decimals)}%`;
}

/**
 * Clean WEEX symbol format to display format
 * OPTIMIZED: Single regex pass instead of multiple replace() calls
 * 
 * Examples:
 * - "cmt_btcusdt" → "BTC"
 * - "CMT_ETHUSDT" → "ETH"
 * - "cmt_solusdt" → "SOL"
 * 
 * @param symbol - WEEX symbol format (e.g., "cmt_btcusdt")
 * @returns Clean uppercase symbol (e.g., "BTC")
 */
export function cleanSymbol(symbol: string | undefined | null): string {
    if (!symbol || typeof symbol !== 'string') return 'UNKNOWN';

    // Single regex with capture group: matches "cmt_XXXusdt" and extracts XXX
    const match = symbol.match(/^cmt_(.+?)usdt$/i);
    return match ? match[1].toUpperCase() : symbol.toUpperCase();
}

/**
 * Sanitize string for safe inclusion in prompts
 * Removes control characters and limits length
 * 
 * EDGE CASES HANDLED:
 * - Negative or zero maxLength normalized to 0
 * - maxLength <= 3: truncate without ellipsis
 * - maxLength > 3: truncate with '...' appended
 */
export function sanitizeString(value: string | undefined | null, maxLength: number = 1000): string {
    if (!value) return '';

    // Normalize maxLength to non-negative integer
    maxLength = Math.max(0, Math.floor(maxLength));

    // Remove control characters except newlines and tabs
    let sanitized = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Trim and limit length
    sanitized = sanitized.trim();

    if (sanitized.length > maxLength) {
        // For very small maxLength, truncate without ellipsis
        if (maxLength <= 3) {
            sanitized = sanitized.substring(0, maxLength);
        } else {
            // For larger maxLength, add ellipsis
            sanitized = sanitized.substring(0, maxLength - 3) + '...';
        }
    }

    return sanitized;
}

/**
 * Safely format an array of strings for display
 */
export function safeArrayJoin(
    arr: string[] | undefined | null,
    separator: string = ', ',
    maxItems: number = 10,
    fallback: string = 'N/A'
): string {
    if (!arr || !Array.isArray(arr) || arr.length === 0) return fallback;

    const sanitized = arr
        .filter(item => typeof item === 'string' && item.trim().length > 0)
        .slice(0, maxItems)
        .map(item => sanitizeString(item, 200));

    return sanitized.length > 0 ? sanitized.join(separator) : fallback;
}

/**
 * Validate required string field
 */
export function validateRequired(value: string | undefined | null, fieldName: string): string {
    if (!value || typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`Required field '${fieldName}' is missing or empty`);
    }
    return value.trim();
}

/**
 * Validate required number field
 */
export function validateNumber(value: number | undefined | null, fieldName: string): number {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        throw new Error(`Required numeric field '${fieldName}' is invalid: ${value}`);
    }
    return value;
}

/**
 * Safely access nested object property with fallback
 * Returns fallback if any part of the path is null, undefined, or not an object
 * 
 * EDGE CASES HANDLED:
 * - Null values are treated the same as undefined
 * - Non-object values in the path return fallback
 * - Missing keys return fallback
 * - Empty path returns the object itself (or fallback if null/undefined)
 * - Array indices are supported (e.g., "items.0.name")
 */
export function safeGet<T>(obj: any, path: string, fallback: T): T {
    // Handle empty path - return obj if valid, fallback otherwise
    if (!path || path.length === 0) {
        return obj != null ? obj : fallback;
    }

    const keys = path.split('.');
    let current = obj;

    for (const key of keys) {
        // Check if current is null/undefined or not an object/array
        if (current == null || (typeof current !== 'object' && !Array.isArray(current))) {
            return fallback;
        }

        // Handle array index access
        if (Array.isArray(current)) {
            const index = parseInt(key, 10);
            if (!Number.isFinite(index) || index < 0 || index >= current.length) {
                return fallback;
            }
            current = current[index];
        } else {
            // Object property access
            if (!Object.prototype.hasOwnProperty.call(current, key)) {
                return fallback;
            }
            current = current[key];
        }
    }

    // Return fallback if final value is null or undefined
    return current != null ? current : fallback;
}

/**
 * Format price targets safely
 */
export function formatPriceTargets(
    priceTarget: { bull?: number; base?: number; bear?: number } | undefined | null
): { bull: string; base: string; bear: string } {
    if (!priceTarget) {
        return { bull: 'N/A', base: 'N/A', bear: 'N/A' };
    }

    return {
        bull: safePrice(priceTarget.bull),
        base: safePrice(priceTarget.base),
        bear: safePrice(priceTarget.bear)
    };
}

/**
 * Get canonical price from PromptMarketData
 * Handles backward compatibility between 'currentPrice' (canonical) and 'price' (deprecated)
 * 
 * EDGE CASES HANDLED:
 * - If both currentPrice and price are present, currentPrice takes precedence
 * - If values differ, logs a warning
 * - Returns undefined if neither is present
 */
export function getCanonicalPrice(marketData: { currentPrice?: number; price?: number }): number | undefined {
    const { currentPrice, price } = marketData;

    // If only one is present, use it
    if (currentPrice !== undefined && price === undefined) {
        return currentPrice;
    }
    if (price !== undefined && currentPrice === undefined) {
        // Log deprecation warning
        if (typeof console !== 'undefined' && console.warn) {
            console.warn('PromptMarketData: "price" field is deprecated, use "currentPrice" instead');
        }
        return price;
    }

    // If both are present, prefer currentPrice and warn if they differ
    if (currentPrice !== undefined && price !== undefined) {
        if (Math.abs(currentPrice - price) > 0.0001) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn(
                    `PromptMarketData: Both "currentPrice" (${currentPrice}) and "price" (${price}) are present with different values. Using canonical "currentPrice".`
                );
            }
        }
        return currentPrice;
    }

    // Neither is present
    return undefined;
}
