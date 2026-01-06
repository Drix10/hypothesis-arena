/**
 * Leverage Service for v5.0.0
 * 
 * Dynamic leverage calculation (3-10x) based on:
 * - Confidence level
 * - Volatility (ATR)
 * - Funding rate direction
 * - Market conditions
 * 
 * Algorithm inspired by industry best practices for dynamic leverage sizing.
 * Implementation is original and tailored to this trading system's risk parameters.
 */

import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface LeverageParams {
    confidence: number;           // 0-100
    atrPercent: number;           // ATR as % of price
    fundingRate: number;          // Current funding rate (decimal)
    isAgainstFunding: boolean;    // Is position against funding direction?
    volatility?: 'low' | 'medium' | 'high';
    trendStrength?: number;       // 0-100
}

export interface LeverageResult {
    leverage: number;
    reasoning: string[];
    adjustments: { factor: string; change: number }[];
}

export class LeverageService {
    private readonly MIN_LEVERAGE = 3;
    private readonly MAX_LEVERAGE = 10;
    private readonly BASE_LEVERAGE = 5;

    // ATR thresholds for volatility classification
    private readonly ATR_LOW_THRESHOLD = 2;      // < 2% = low volatility
    private readonly ATR_HIGH_THRESHOLD = 5;     // > 5% = high volatility

    // Funding rate thresholds (decimal form)
    // These thresholds determine when adverse funding triggers leverage reduction
    private readonly FUNDING_MODERATE_THRESHOLD = 0.0005;  // 0.05% per 8h (5 bps)
    private readonly FUNDING_HIGH_THRESHOLD = 0.001;       // 0.1% per 8h (10 bps)

    constructor() {
        logger.info(`LeverageService initialized: range=${this.MIN_LEVERAGE}x-${this.MAX_LEVERAGE}x, base=${this.BASE_LEVERAGE}x`);
    }

    /**
     * Calculate optimal leverage based on conditions
     * 
     * FIXED: Added input validation for LeverageParams
     * FIXED: Avoid mutating input parameters - use local copies
     * 
     * @param params - Leverage calculation parameters
     * @returns LeverageResult with final leverage, reasoning, and adjustments
     * 
     * INPUT VALIDATION:
     * - confidence: Must be 0-100, defaults to 50 if invalid
     * - atrPercent: Must be >= 0, defaults to 3 (medium volatility) if invalid
     * - fundingRate: Must be finite, defaults to 0 if invalid
     * - isAgainstFunding: Must be boolean, defaults to false if invalid
     * - trendStrength: Optional, must be 0-100 if provided, ignored if invalid
     * - volatility: Optional, derived from atrPercent if not provided
     */
    calculateLeverage(params: LeverageParams): LeverageResult {
        // Create local copies to avoid mutating input parameters
        let confidence = params.confidence;
        let atrPercent = params.atrPercent;
        let fundingRate = params.fundingRate;
        let isAgainstFunding = params.isAgainstFunding;
        let trendStrength = params.trendStrength;
        let volatility = params.volatility;

        // Validate inputs using local copies
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
            logger.warn(`LeverageService: Invalid confidence ${confidence}, using 50`);
            confidence = 50;
        }
        if (!Number.isFinite(atrPercent) || atrPercent < 0) {
            logger.warn(`LeverageService: Invalid atrPercent ${atrPercent}, using 3`);
            atrPercent = 3;
        }
        if (!Number.isFinite(fundingRate)) {
            logger.warn(`LeverageService: Invalid fundingRate ${fundingRate}, using 0`);
            fundingRate = 0;
        }
        if (typeof isAgainstFunding !== 'boolean') {
            isAgainstFunding = false;
        }
        if (trendStrength !== undefined && (!Number.isFinite(trendStrength) || trendStrength < 0 || trendStrength > 100)) {
            logger.warn(`LeverageService: Invalid trendStrength ${trendStrength}, ignoring`);
            trendStrength = undefined;
        }

        let leverage = this.BASE_LEVERAGE;
        const adjustments: { factor: string; change: number }[] = [];
        const reasoning: string[] = [`Base leverage: ${this.BASE_LEVERAGE}x`];

        // 1. Confidence adjustment (+1 to +2 for high confidence)
        if (confidence >= 95) {
            leverage += 2;
            adjustments.push({ factor: 'Very high confidence (95%+)', change: +2 });
            reasoning.push(`+2x for very high confidence (${confidence}%)`);
        } else if (confidence >= 85) {
            leverage += 1;
            adjustments.push({ factor: 'High confidence (85%+)', change: +1 });
            reasoning.push(`+1x for high confidence (${confidence}%)`);
        } else if (confidence < 60) {
            leverage -= 1;
            adjustments.push({ factor: 'Low confidence (<60%)', change: -1 });
            reasoning.push(`-1x for low confidence (${confidence}%)`);
        }

        // 2. Volatility adjustment (-1 to -2 for high volatility)
        const effectiveVolatility = volatility || this.classifyVolatility(atrPercent);

        if (effectiveVolatility === 'high') {
            leverage -= 2;
            adjustments.push({ factor: 'High volatility', change: -2 });
            reasoning.push(`-2x for high volatility (ATR: ${atrPercent.toFixed(2)}%)`);
        } else if (effectiveVolatility === 'medium') {
            leverage -= 1;
            adjustments.push({ factor: 'Medium volatility', change: -1 });
            reasoning.push(`-1x for medium volatility (ATR: ${atrPercent.toFixed(2)}%)`);
        }

        // 3. ATR-specific adjustment (additional penalty for extreme ATR)
        if (atrPercent > 8) {
            leverage -= 1;
            adjustments.push({ factor: 'Extreme ATR (>8%)', change: -1 });
            reasoning.push(`-1x for extreme ATR (${atrPercent.toFixed(2)}%)`);
        }

        // EDGE CASE: Very extreme ATR (>15%) - additional penalty
        // This can happen during flash crashes or extreme volatility events
        if (atrPercent > 15) {
            leverage -= 1;
            adjustments.push({ factor: 'Very extreme ATR (>15%)', change: -1 });
            reasoning.push(`-1x for very extreme ATR (${atrPercent.toFixed(2)}%)`);
        }

        // 4. Funding rate adjustment (if against funding)
        if (isAgainstFunding) {
            const absFunding = Math.abs(fundingRate);

            if (absFunding > this.FUNDING_HIGH_THRESHOLD) {
                leverage -= 2;
                adjustments.push({ factor: 'High adverse funding (>0.1%)', change: -2 });
                reasoning.push(`-2x for high adverse funding (${(absFunding * 100).toFixed(3)}%)`);
            } else if (absFunding > this.FUNDING_MODERATE_THRESHOLD) {
                leverage -= 1;
                adjustments.push({ factor: 'Moderate adverse funding (>0.05%)', change: -1 });
                reasoning.push(`-1x for moderate adverse funding (${(absFunding * 100).toFixed(3)}%)`);
            }
        }

        // 5. Trend strength bonus (+1 for strong trend alignment)
        if (trendStrength !== undefined && trendStrength > 80) {
            leverage += 1;
            adjustments.push({ factor: 'Strong trend alignment', change: +1 });
            reasoning.push(`+1x for strong trend alignment (${trendStrength}%)`);
        }

        // Clamp to valid range
        const roundedLeverage = Math.round(leverage);
        const finalLeverage = Math.max(this.MIN_LEVERAGE, Math.min(this.MAX_LEVERAGE, roundedLeverage));

        // FIXED: Only show clamping message if actual clamping occurred (not just rounding)
        if (finalLeverage !== roundedLeverage) {
            reasoning.push(`Clamped from ${roundedLeverage}x to ${finalLeverage}x (range: ${this.MIN_LEVERAGE}x-${this.MAX_LEVERAGE}x)`);
        }

        reasoning.push(`Final leverage: ${finalLeverage}x`);

        return {
            leverage: finalLeverage,
            reasoning,
            adjustments,
        };
    }

    /**
     * Classify volatility based on ATR percentage
     */
    classifyVolatility(atrPercent: number): 'low' | 'medium' | 'high' {
        if (atrPercent < this.ATR_LOW_THRESHOLD) return 'low';
        if (atrPercent > this.ATR_HIGH_THRESHOLD) return 'high';
        return 'medium';
    }

    /**
     * Get leverage recommendation for display/logging
     */
    getLeverageRecommendation(params: LeverageParams): string {
        const result = this.calculateLeverage(params);

        const lines = [
            `📊 Leverage Calculation:`,
            ...result.reasoning.map(r => `  • ${r}`),
        ];

        return lines.join('\n');
    }

    /**
     * Validate leverage is within safe bounds
     * 
     * FIXED: Added robust validation for leverage value and config access
     */
    validateLeverage(leverage: number): { valid: boolean; adjusted: number; reason?: string } {
        // Validate input is a valid number
        if (!Number.isFinite(leverage) || leverage <= 0) {
            return {
                valid: false,
                adjusted: this.MIN_LEVERAGE,
                reason: `Invalid leverage value: ${leverage}, using minimum (${this.MIN_LEVERAGE}x)`,
            };
        }

        if (leverage < this.MIN_LEVERAGE) {
            return {
                valid: false,
                adjusted: this.MIN_LEVERAGE,
                reason: `Leverage ${leverage}x below minimum (${this.MIN_LEVERAGE}x)`,
            };
        }

        if (leverage > this.MAX_LEVERAGE) {
            return {
                valid: false,
                adjusted: this.MAX_LEVERAGE,
                reason: `Leverage ${leverage}x above maximum (${this.MAX_LEVERAGE}x)`,
            };
        }

        // Also check against config max (which may be lower)
        // FIXED: Handle edge case where configMax could be less than MIN_LEVERAGE
        const configMax = config.autonomous?.maxLeverage ?? this.MAX_LEVERAGE;

        // If configMax is somehow less than MIN_LEVERAGE, use MIN_LEVERAGE as the effective max
        // This shouldn't happen in practice (config validation prevents it), but handle defensively
        const effectiveMax = Math.max(this.MIN_LEVERAGE, configMax);

        if (leverage > effectiveMax) {
            return {
                valid: false,
                adjusted: effectiveMax,
                reason: `Leverage ${leverage}x exceeds config max (${effectiveMax}x)`,
            };
        }

        return { valid: true, adjusted: leverage };
    }

    /**
     * Calculate margin required for a given notional and leverage
     * 
     * FIXED: Added validation to prevent division by zero
     */
    calculateMarginRequired(notionalUsd: number, leverage: number): number {
        if (!Number.isFinite(leverage) || leverage <= 0) {
            logger.warn(`LeverageService.calculateMarginRequired: Invalid leverage ${leverage}, using MIN_LEVERAGE`);
            leverage = this.MIN_LEVERAGE;
        }
        if (!Number.isFinite(notionalUsd) || notionalUsd < 0) {
            return 0;
        }
        return notionalUsd / leverage;
    }

    /**
     * Calculate notional exposure from margin and leverage
     * 
     * FIXED: Added validation to prevent invalid inputs
     */
    calculateNotionalExposure(marginUsd: number, leverage: number): number {
        if (!Number.isFinite(marginUsd) || marginUsd < 0) {
            return 0;
        }
        if (!Number.isFinite(leverage) || leverage <= 0) {
            logger.warn(`LeverageService.calculateNotionalExposure: Invalid leverage ${leverage}, using MIN_LEVERAGE`);
            leverage = this.MIN_LEVERAGE;
        }
        return marginUsd * leverage;
    }

    /**
     * Get liquidation price estimate
     * Note: This is approximate - actual liquidation depends on exchange rules
     * 
     * FIXED: Added validation to prevent division by zero
     */
    estimateLiquidationPrice(
        entryPrice: number,
        leverage: number,
        isLong: boolean,
        maintenanceMarginRate: number = 0.005  // 0.5% typical
    ): number {
        // Validate inputs
        if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            return 0;
        }
        if (!Number.isFinite(leverage) || leverage <= 0) {
            logger.warn(`LeverageService.estimateLiquidationPrice: Invalid leverage ${leverage}, using MIN_LEVERAGE`);
            leverage = this.MIN_LEVERAGE;
        }
        if (!Number.isFinite(maintenanceMarginRate)) {
            maintenanceMarginRate = 0.005;
        }

        // Liquidation occurs when loss = initial margin - maintenance margin
        // For longs: liq_price = entry * (1 - 1/leverage + maintenance_rate)
        // For shorts: liq_price = entry * (1 + 1/leverage - maintenance_rate)

        if (isLong) {
            return entryPrice * (1 - (1 / leverage) + maintenanceMarginRate);
        } else {
            return entryPrice * (1 + (1 / leverage) - maintenanceMarginRate);
        }
    }

    /**
     * Get safe distance to liquidation as percentage
     * 
     * FIXED: Added validation to prevent division by zero
     */
    getSafeDistancePercent(leverage: number): number {
        // Validate input
        if (!Number.isFinite(leverage) || leverage <= 0) {
            logger.warn(`LeverageService.getSafeDistancePercent: Invalid leverage ${leverage}, using MIN_LEVERAGE`);
            leverage = this.MIN_LEVERAGE;
        }
        // With leverage L, liquidation occurs at ~(100/L)% move against position
        // We want at least 50% buffer before liquidation
        return (100 / leverage) * 0.5;
    }
}

// Singleton instance
let leverageServiceInstance: LeverageService | null = null;

export function getLeverageService(): LeverageService {
    if (!leverageServiceInstance) {
        leverageServiceInstance = new LeverageService();
    }
    return leverageServiceInstance;
}

/**
 * Reset singleton (for testing)
 */
export function resetLeverageService(): void {
    leverageServiceInstance = null;
}
