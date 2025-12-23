/**
 * Position Sizing Service
 * 
 * Calculates safe position sizes with comprehensive validation for cash availability,
 * position limits, and risk management rules.
 */

import { AgentPortfolio, PositionSizingRules } from '../../types/trading';

export interface PositionSizeResult {
    shares: number;
    value: number;
    warnings: string[];
    isValid: boolean;
}

export class PositionSizingService {
    private defaultRules: PositionSizingRules = {
        maxPositionPercent: 0.2, // 20% max per position
        maxTotalInvested: 0.8, // 80% max invested
        minTradeValue: 100, // $100 minimum
        maxPositionsPerAgent: 10,
        reserveCashPercent: 0.05, // 5% cash reserve
        maxSectorExposure: 0.4 // 40% max in one sector
    };

    calculatePositionSize(
        portfolio: AgentPortfolio,
        ticker: string,
        confidence: number,
        currentPrice: number,
        rules: PositionSizingRules = this.defaultRules
    ): PositionSizeResult {
        const warnings: string[] = [];

        // Input validation
        if (!currentPrice || currentPrice <= 0 || !Number.isFinite(currentPrice)) {
            return {
                shares: 0,
                value: 0,
                warnings: ['Invalid current price'],
                isValid: false
            };
        }

        // Input validation - confidence of 0 is valid (means no trade)
        if (confidence === undefined || confidence === null || confidence < 0 || confidence > 100 || !Number.isFinite(confidence)) {
            return {
                shares: 0,
                value: 0,
                warnings: ['Invalid confidence value (must be 0-100)'],
                isValid: false
            };
        }

        // Confidence of 0 means no trade
        if (confidence === 0) {
            return {
                shares: 0,
                value: 0,
                warnings: ['Confidence is 0 - no trade'],
                isValid: false
            };
        }

        // Check existing position
        const existingPosition = portfolio.positions.find(p => p.ticker === ticker);
        if (existingPosition && portfolio.totalValue > 0) {
            const existingPercent = existingPosition.marketValue / portfolio.totalValue;
            if (existingPercent >= rules.maxPositionPercent) {
                return {
                    shares: 0,
                    value: 0,
                    warnings: [`Already at max position size (${(rules.maxPositionPercent * 100).toFixed(0)}%)`],
                    isValid: false
                };
            }
        }

        // Calculate available cash for trading
        // Reserve is calculated as a percentage of total portfolio value (not just cash)
        // This ensures we always maintain a cash buffer regardless of position sizes
        const reserveAmount = portfolio.totalValue * rules.reserveCashPercent;
        const availableCash = Math.max(0, portfolio.currentCash - portfolio.reservedCash - reserveAmount);
        if (availableCash < rules.minTradeValue) {
            return {
                shares: 0,
                value: 0,
                warnings: [`Insufficient cash (min ${rules.minTradeValue})`],
                isValid: false
            };
        }

        // Calculate target position size based on confidence
        const targetPercent = (confidence / 100) * rules.maxPositionPercent;
        const targetValue = portfolio.totalValue * targetPercent;

        // Calculate max value based on available cash (reserve is already excluded)
        const maxValue = Math.min(targetValue, availableCash);

        // Calculate whole shares (no fractional shares)
        let shares = Math.max(0, Math.floor(maxValue / currentPrice));
        let actualValue = shares * currentPrice;

        // Validate minimum trade size
        if (actualValue < rules.minTradeValue) {
            return {
                shares: 0,
                value: 0,
                warnings: [`Trade size too small (min ${rules.minTradeValue})`],
                isValid: false
            };
        }

        // Check total invested limit - enforce it
        const totalInvested = portfolio.positions.reduce((sum, p) => sum + p.marketValue, 0);
        const newTotalInvested = totalInvested + actualValue;
        if (portfolio.totalValue > 0 && newTotalInvested > portfolio.totalValue * rules.maxTotalInvested) {
            // Calculate how much we can actually invest
            const maxAllowedInvestment = (portfolio.totalValue * rules.maxTotalInvested) - totalInvested;
            if (maxAllowedInvestment < rules.minTradeValue) {
                return {
                    shares: 0,
                    value: 0,
                    warnings: [`Max invested limit reached (${(rules.maxTotalInvested * 100).toFixed(0)}%)`],
                    isValid: false
                };
            }
            // Reduce shares to fit within limit
            shares = Math.floor(maxAllowedInvestment / currentPrice);
            actualValue = shares * currentPrice;
            if (actualValue < rules.minTradeValue) {
                return {
                    shares: 0,
                    value: 0,
                    warnings: [`Max invested limit reached (${(rules.maxTotalInvested * 100).toFixed(0)}%)`],
                    isValid: false
                };
            }
            warnings.push(`Reduced to fit max invested limit (${(rules.maxTotalInvested * 100).toFixed(0)}%)`);
        }

        // Check position count limit
        if (portfolio.positions.length >= rules.maxPositionsPerAgent && !existingPosition) {
            return {
                shares: 0,
                value: 0,
                warnings: [`Max positions reached (${rules.maxPositionsPerAgent})`],
                isValid: false
            };
        }

        return {
            shares,
            value: actualValue,
            warnings,
            isValid: true
        };
    }

    validateSellSize(
        portfolio: AgentPortfolio,
        ticker: string,
        shares: number
    ): PositionSizeResult {
        const warnings: string[] = [];

        // Input validation
        if (!shares || shares <= 0 || !Number.isFinite(shares) || !Number.isInteger(shares)) {
            return {
                shares: 0,
                value: 0,
                warnings: ['Invalid shares: must be positive integer'],
                isValid: false
            };
        }

        const position = portfolio.positions.find(p => p.ticker === ticker);
        if (!position) {
            return {
                shares: 0,
                value: 0,
                warnings: ['No position found to sell'],
                isValid: false
            };
        }

        if (shares > position.shares) {
            return {
                shares: 0,
                value: 0,
                warnings: [`Cannot sell ${shares} shares, only ${position.shares} available`],
                isValid: false
            };
        }

        const value = shares * position.currentPrice;

        return {
            shares,
            value,
            warnings,
            isValid: true
        };
    }
}

export const positionSizingService = new PositionSizingService();
